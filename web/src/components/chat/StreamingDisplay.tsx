import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2 } from 'lucide-react';
import {
  proactiveTurnQuiet,
  runTurnAnswered,
  shouldRecoverStaleWaiting,
  useChatStore,
  type StreamingState,
} from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';
import { resolveAgentDisplayIdentity } from '../../utils/agent-identity';
import type { InteractionMode } from '../../types';
import { EmojiAvatar } from '../common/EmojiAvatar';
import { StreamingMarkdown } from './StreamingMarkdown';
import { REPLY_BODY_CLASS } from './MessageBubble';
import { TodoProgressPanel } from './TodoProgressPanel';
import { ToolActivityCard, ToolRow } from './ToolActivityCard';
import { stepToolState } from './tool-status';
import { AskUserQuestionCard } from './AskUserQuestionCard';
import { ModelWaitRow } from './ModelWaitRow';
import { ProcessCard, hasProcess } from './ProcessCard';
import { SubAgentCard } from './SubAgentCard';
import { ThinkingBlock } from './ThinkingBlock';
import { WorkflowRunCard } from './WorkflowRunCard';
import { isWorkflowTask, workflowRunOf } from './workflow-run';
import { PermissionAlert, TracePanel } from './ExecutionTrace';
import { ProcessPanel } from './ProcessPanel';
import { useDisplayMode } from '../../hooks/useDisplayMode';
import {
  useStreamLayout,
  type StreamLayout,
} from '../../hooks/useStreamLayout';
import { useThrottledValue } from '../../hooks/useThrottledValue';
import { useAfterDelay, useTick } from '../../hooks/useTick';
import { shouldShowStreamingPartialText } from '../../lib/interaction-mode';
import {
  isProgressStep,
  normalizeProcessVisibility,
} from '../../lib/process-visibility';
import { DEEP_THINKING_STATUS, isCompactingStatus } from '../../lib/run-phase';
import {
  answerStart,
  readStepQuestions,
  type StreamingStep,
} from '../../lib/stream-steps';
import { streamingMarkdownInterval } from '../../lib/streaming-interval';
import { cn } from '@/lib/utils';
import { sessionJidOf } from '../../lib/session-jid';

/**
 * The narration before a tool call streams like an answer: the process folds
 * only once the answer has gone on this long, so a card does not fold and open
 * again around each such line.
 */
const ANSWER_FOLD_DELAY_MS = 800;

/** Statuses the run status bar already shows as its phase. */
function isPhaseSystemStatus(status: string): boolean {
  return (
    status === 'requesting' ||
    status === DEEP_THINKING_STATUS ||
    isCompactingStatus(status)
  );
}

/** Initial reasoning-block state: open only while thinking is live. */
function initialThinkingExpanded(
  streaming: StreamingState | null | undefined,
): boolean {
  return !streaming?.thinkingText || streaming.isThinking;
}

const NO_STEPS: StreamingStep[] = [];

/** Finished tools the classic layout keeps listed under the running ones. */
const CLASSIC_FINISHED_TOOLS = 4;

/** Tool rows of the classic layout: the running ones and the latest finished. */
function classicToolSteps(
  steps: StreamingStep[] | undefined,
): StreamingStep[] | null {
  if (!steps) return null;
  const tools = steps.filter(
    (step) => step.kind === 'tool' && step.toolName !== 'AskUserQuestion',
  );
  const finished = tools.filter((step) => step.status !== 'running');
  const hidden = new Set(
    finished.slice(0, Math.max(0, finished.length - CLASSIC_FINISHED_TOOLS)),
  );
  return tools.filter((step) => !hidden.has(step));
}

/** Shared streaming content — used by both compact and chat modes to eliminate duplication. */
function StreamingContent({
  streaming,
  groupJid,
  thinkingExpanded,
  setThinkingExpanded,
  showPartialText,
  live,
  layout,
}: {
  streaming: import('../../stores/chat').StreamingState;
  groupJid: string;
  thinkingExpanded: boolean;
  setThinkingExpanded: (v: boolean) => void;
  showPartialText: boolean;
  /** The run is producing this card right now (not stopped or settled). */
  live: boolean;
  layout: StreamLayout;
}) {
  // The step timeline's answer is the text after the last tool, which is what
  // the host delivers as the final message; the classic layout shows all text.
  const timeline = layout === 'timeline';
  const answerFrom = timeline
    ? answerStart(streaming.steps, streaming.partialBase ?? 0)
    : undefined;
  const answerText =
    answerFrom === undefined
      ? streaming.partialText
      : streaming.partialText.slice(answerFrom);
  const partialMarkdown = useThrottledValue(
    answerText,
    streamingMarkdownInterval(answerText),
  );
  // The answer is being written: the process folds to its summary above it.
  const answering =
    live &&
    !streaming.isThinking &&
    !streaming.awaitingModel &&
    streaming.activeTools.length === 0 &&
    !!answerText;
  const answerFolds = useAfterDelay(answering, ANSWER_FOLD_DELAY_MS);
  // The model's request is out and nothing is running meanwhile.
  const waitingForModel =
    live &&
    !!streaming.awaitingModel &&
    !streaming.isThinking &&
    !streaming.activeTools.some((tool) => !tool.isNested);
  const hasContent = !!(
    streaming.steps?.length ||
    streaming.partialText ||
    streaming.thinkingText
  );
  const askUserTools = streaming.activeTools.filter(
    (t) => t.toolName === 'AskUserQuestion' && t.toolInput,
  );
  const tasks = Object.values(streaming.taskStates).sort(
    (a, b) => a.updatedAt - b.updatedAt,
  );
  const hasWorkflowTasks = tasks.some(isWorkflowTask);
  const showSystemStatus =
    streaming.systemStatus &&
    !isPhaseSystemStatus(streaming.systemStatus) &&
    !(
      hasWorkflowTasks &&
      /后台任务运行中|完成后将继续汇总/u.test(streaming.systemStatus)
    )
      ? streaming.systemStatus
      : null;
  const hasThinkingRow =
    !!streaming.thinkingText ||
    streaming.isThinking ||
    (streaming.thinkingDurationMs ?? 0) >= 1000;
  const toolSteps = classicToolSteps(streaming.steps);
  const now = useTick(
    live && !timeline && !!toolSteps?.some((step) => step.status === 'running'),
  );

  const systemStatus = showSystemStatus && (
    <div className="mb-2 flex h-7 items-center gap-2 font-sans text-label text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
      <span>{showSystemStatus}</span>
    </div>
  );
  const hook = streaming.activeHook && (
    <div className="mb-2 flex h-7 items-center gap-2 font-sans text-label text-muted-foreground">
      <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
      <span>Hook: {streaming.activeHook.hookName}</span>
    </div>
  );
  const todos = streaming.todos && streaming.todos.length > 0 && (
    <TodoProgressPanel todos={streaming.todos} />
  );
  const answer = showPartialText && streaming.partialText && answerText && (
    <div className={REPLY_BODY_CLASS}>
      <StreamingMarkdown
        content={partialMarkdown}
        groupJid={groupJid}
        variant="chat"
      />
    </div>
  );
  const reasoning = hasThinkingRow && (
    <ThinkingBlock
      text={streaming.thinkingText}
      title={streaming.thinkingTitle}
      durationMs={streaming.thinkingDurationMs}
      running={streaming.isThinking}
      live={live && streaming.isThinking}
      groupJid={groupJid}
      expanded={thinkingExpanded}
      onExpandedChange={setThinkingExpanded}
    />
  );

  // A timeline card that is not live (settled for its final, or stopped) is
  // shaped like the finished message: the process folded to one summary row,
  // the answer below, so the swap between them keeps its height. A frozen card
  // that has no steps (an older mirror, a snapshot) keeps the two rows the
  // reasoning and the execution details fold to. Every layout and state fills
  // the same slots in the same order (an unused one is `false`), so the answer
  // keeps its element, and its rendered Markdown, when the card settles.
  const folded = timeline && !live;
  const legacyFolded = folded && !hasProcess(streaming.steps ?? []);
  const toolRows =
    !timeline &&
    (toolSteps ? toolSteps.length > 0 : streaming.activeTools.length > 0) ? (
      <div className="mb-2 space-y-1.5">
        {toolSteps
          ? toolSteps.map((step) => {
              const running = step.status === 'running';
              return (
                <ToolRow
                  key={step.id}
                  toolName={step.toolName ?? 'unknown'}
                  skillName={step.skillName}
                  summary={step.summary}
                  status={stepToolState(step)}
                  elapsedSeconds={
                    running ? Math.max(0, (now - step.at) / 1000) : undefined
                  }
                  durationMs={
                    running
                      ? undefined
                      : Math.max(0, (step.endedAt ?? step.at) - step.at)
                  }
                  resultPreview={step.resultPreview}
                />
              );
            })
          : streaming.activeTools
              .filter((t) => t.toolName !== 'AskUserQuestion')
              .map((tool) => (
                <ToolActivityCard key={tool.toolUseId} tool={tool} />
              ))}
        {askUserTools.map((tool) => (
          <AskUserQuestionCard
            key={tool.toolUseId}
            toolUseId={tool.toolUseId}
            questions={readStepQuestions(tool.toolInput) ?? []}
          />
        ))}
      </div>
    ) : null;
  const tasksCards = !timeline && tasks.length > 0 && (
    <div className="mb-2 space-y-1.5">
      {tasks.map((task) =>
        isWorkflowTask(task) ? (
          <WorkflowRunCard key={task.id} run={workflowRunOf(task)} />
        ) : (
          <SubAgentCard key={task.id} task={task} groupJid={groupJid} />
        ),
      )}
    </div>
  );
  // A finished message keeps its Workflow cards, below its execution details.
  const workflowCards = folded && tasks.some(isWorkflowTask) && (
    <div className="mb-2 space-y-1.5">
      {tasks.filter(isWorkflowTask).map((task) => (
        <WorkflowRunCard key={task.id} run={workflowRunOf(task)} />
      ))}
    </div>
  );
  // A folded card shows the Workflow cards itself, below it: its steps list
  // them as a line, and the rest of the sub-agents as rows to open.
  const cardTasks = useMemo(
    () =>
      folded
        ? Object.fromEntries(
            Object.entries(streaming.taskStates).filter(
              ([, task]) => !isWorkflowTask(task),
            ),
          )
        : streaming.taskStates,
    [folded, streaming.taskStates],
  );

  return (
    <>
      {/* System status */}
      {!folded && systemStatus}

      {/* Reasoning block: live in the classic layout; folded once over only
          for a frozen card that has no steps to be summed up */}
      {folded
        ? legacyFolded &&
          hasThinkingRow && (
            <ThinkingBlock
              text={streaming.thinkingText}
              title={streaming.thinkingTitle}
              durationMs={streaming.thinkingDurationMs}
              groupJid={groupJid}
            />
          )
        : timeline
          ? false
          : reasoning}

      {/* The process (timeline): live headline over its steps, or one summary
          row once settled; or the tools: running and latest done (classic) */}
      {timeline ? (
        <>
          <PermissionAlert traceEvents={streaming.traceEvents} />
          <ProcessCard
            mode={live ? 'live' : 'settled'}
            steps={streaming.steps ?? NO_STEPS}
            stepsDropped={streaming.stepsDropped}
            taskStates={cardTasks}
            activeTools={streaming.activeTools}
            waiting={waitingForModel}
            waitingSince={streaming.phaseStartedAt}
            hasContent={hasContent}
            groupJid={groupJid}
            answering={answerFolds}
            memoryKey={streaming.inputTurnId ?? streaming.turnId}
          />
        </>
      ) : (
        toolRows
      )}

      {/* Todo progress */}
      {!folded && todos}

      {/* Sub-agent / workflow runtime state, one card each */}
      {tasksCards}

      {/* Permission denials — surfaced prominently in red, not buried in trace */}
      {!timeline && <PermissionAlert traceEvents={streaming.traceEvents} />}

      {/* Full trace */}
      {(!timeline || legacyFolded) && (
        <TracePanel
          traceEvents={streaming.traceEvents}
          taskCount={tasks.length}
        />
      )}

      {workflowCards}

      {/* Hook */}
      {!folded && hook}

      {/* The model is at work and nothing has come back yet */}
      {!timeline && (
        <ModelWaitRow
          active={waitingForModel}
          since={streaming.phaseStartedAt}
          delayMs={hasContent ? 800 : 0}
        />
      )}

      {/* Partial text */}
      {answer}
    </>
  );
}

interface StreamingDisplayProps {
  groupJid: string;
  isWaiting: boolean;
  senderName?: string;
  /** The session (or /spawn agent) whose reply this is. */
  agentId: string;
  agentAvatarUrl?: string | null;
  agentAvatarEmoji?: string | null;
  agentAvatarColor?: string | null;
  interactionMode?: InteractionMode;
  /**
   * Show the finished run's settled card (frozen until its final message
   * replaces it) instead of the live projection.
   */
  settled?: boolean;
}

export function StreamingDisplay({
  groupJid,
  isWaiting: isWaitingProp,
  senderName: senderNameProp = 'AI',
  agentId,
  agentAvatarUrl,
  agentAvatarEmoji,
  agentAvatarColor,
  interactionMode = 'assistant',
  settled = false,
}: StreamingDisplayProps) {
  // A settled card belongs to a finished run: nothing about it is waiting.
  const isWaiting = settled ? false : isWaitingProp;
  const runtimeJid = sessionJidOf(groupJid, agentId);
  const streaming = useChatStore((s) =>
    settled ? s.settledStreaming[runtimeJid] : s.agentStreaming[agentId],
  );
  const runtimeAgentKind = useChatStore(
    (s) => s.agents[groupJid]?.find((agent) => agent.id === agentId)?.kind,
  );
  const stopping = useChatStore(
    (s) => !settled && !!s.stopRequests[runtimeJid],
  );
  // The run's turn ended in place (its reply is in the list) and the run is
  // only closing: there is nothing to show until another input of it streams.
  const answered = useChatStore((s) =>
    settled ? undefined : s.activeRuns[runtimeJid]?.answered,
  );
  const turnAnswered = runTurnAnswered(answered, streaming);
  // Fire-and-forget spawn Agents retain Assistant streaming semantics even in
  // a proactive Workspace. The Workspace contract applies to session loops.
  const effectiveInteractionMode =
    runtimeAgentKind === 'spawn' ? 'assistant' : interactionMode;
  const showPartialText = shouldShowStreamingPartialText(
    effectiveInteractionMode,
  );
  // A proactive turn that has replied and since only reasons shows no panel;
  // the run status bar says it is busy.
  const quiet = useChatStore(
    (s) => !settled && proactiveTurnQuiet(s, runtimeJid),
  );
  // How much of a proactive turn's process its owner chose to show.
  const processVisibility = useChatStore((s) =>
    normalizeProcessVisibility(s.groups[groupJid]?.process_visibility),
  );
  const { layout } = useStreamLayout();
  const appearance = useAuthStore((state) => state.appearance);
  const agentIdentity = resolveAgentDisplayIdentity({
    agentName: senderNameProp,
    avatarUrl: agentAvatarUrl,
    avatarEmoji: agentAvatarEmoji,
    avatarColor: agentAvatarColor,
    appearance,
  });
  const senderName = agentIdentity.name;
  const { mode: displayMode } = useDisplayMode();
  const isCompact = displayMode === 'compact';
  // After a remount (switching conversations, a reload) a reply that has
  // moved on from thinking keeps its reasoning collapsed.
  const [thinkingExpanded, setThinkingExpanded] = useState(() =>
    initialThinkingExpanded(streaming),
  );
  const userToggledThinkingRef = useRef(false);

  // Exact run_started/run_finished events own the public waiting lifecycle.
  // This timer only recovers orphaned UI state after the authoritative run has
  // disappeared; long but healthy runs may remain quiet indefinitely.
  const lastStreamActivityRef = useRef(Date.now());
  useEffect(() => {
    if (streaming) lastStreamActivityRef.current = Date.now();
  }, [streaming]);

  useEffect(() => {
    if (isWaiting) lastStreamActivityRef.current = Date.now();
  }, [isWaiting, runtimeJid]);

  useEffect(() => {
    if (!isWaiting) return;

    const interval = window.setInterval(() => {
      const state = useChatStore.getState();
      const hasActiveRun = !!state.activeRuns[runtimeJid];
      const hasStreamData = !!state.agentStreaming[agentId];
      if (
        !shouldRecoverStaleWaiting({
          elapsedMs: Date.now() - lastStreamActivityRef.current,
          hasStreamData,
          hasActiveRun,
        })
      ) {
        return;
      }

      useChatStore.setState((current) => {
        // Re-check under the state mutation so a concurrent run_started
        // cannot be cleared by this stale interval tick.
        if (current.activeRuns[runtimeJid]) return current;
        const nextStreaming = { ...current.agentStreaming };
        delete nextStreaming[agentId];
        return {
          agentWaiting: { ...current.agentWaiting, [agentId]: false },
          agentStreaming: nextStreaming,
        };
      });
    }, 10_000);

    return () => window.clearInterval(interval);
  }, [agentId, groupJid, isWaiting, runtimeJid]);

  // Reset on group change (not on mount: the initial state already did).
  const resetGroupRef = useRef(groupJid);
  useEffect(() => {
    if (resetGroupRef.current === groupJid) return;
    resetGroupRef.current = groupJid;
    const current = useChatStore.getState().agentStreaming[agentId];
    setThinkingExpanded(initialThinkingExpanded(current));
    userToggledThinkingRef.current = false;
  }, [agentId, groupJid]);

  useEffect(() => {
    if (!streaming) {
      setThinkingExpanded(true);
      userToggledThinkingRef.current = false;
    }
  }, [streaming]);

  // The reasoning block follows the reasoning: open while the model thinks,
  // folded once it is over, so the streaming card's height matches the
  // finished message's collapsed block (the layout jump of #493). Each new
  // burst opens it again. Not only on an observed true → false transition: a
  // burst that starts and ends within one frame (or before a remount) was
  // never seen thinking. An explicit user toggle in this turn wins.
  const isThinking = streaming?.isThinking ?? false;
  const hasThinking = !!streaming?.thinkingText;
  useEffect(() => {
    if (userToggledThinkingRef.current) return;
    if (isThinking) setThinkingExpanded(true);
    else if (hasThinking) setThinkingExpanded(false);
  }, [isThinking, hasThinking]);

  // Only a card the run is still writing gets live affordances.
  const live =
    isWaiting &&
    !stopping &&
    !!streaming &&
    !streaming.interrupted &&
    !streaming.settling;
  // Same height as MessageBubble's row so the streaming → final swap doesn't
  // move content. The run's state is the status bar's (RunStatusBar). On a
  // phone the conversation's own Assistant reply has no row (its header names
  // the agent); a spawned agent working beside it keeps its name. Sticky, as
  // the follow glide expects of this row.
  const identityRow = (
    <div
      data-follow-sticky
      className={cn(
        'sticky top-0 z-10 mb-1.5 flex h-6 items-center gap-2 bg-background',
        effectiveInteractionMode === 'assistant' &&
          runtimeAgentKind !== 'spawn' &&
          'phone:hidden',
      )}
    >
      <EmojiAvatar
        imageUrl={agentIdentity.imageUrl}
        emoji={agentIdentity.emoji}
        color={agentIdentity.color}
        fallbackChar={agentIdentity.fallbackChar}
        size="sm"
        className="size-6"
      />
      <span className="text-label font-medium text-foreground">
        {senderName}
      </span>
    </div>
  );

  // Proactive mode exposes only committed native messages plus an explicit run
  // lifecycle, which the run status bar shows. The list keeps the process at
  // the level its owner chose, and none once the turn has replied and only
  // reasons.
  if (effectiveInteractionMode === 'proactive') {
    if (
      !isWaiting ||
      quiet ||
      !streaming ||
      streaming.interrupted ||
      // `hidden` shows a panel only for the progress the Agent sent.
      (processVisibility === 'hidden' && !streaming.steps?.some(isProgressStep))
    ) {
      return null;
    }
    return (
      <div
        className={
          isCompact ? 'mb-2 border-b border-surface-border pb-2' : 'w-full pb-2'
        }
      >
        <ProcessPanel
          streaming={streaming}
          groupJid={groupJid}
          runtimeJid={runtimeJid}
          visibility={processVisibility}
        />
      </div>
    );
  }

  // 计算是否有流式数据（含中断后冻结的 partialText）
  const hasStreamData =
    streaming &&
    ((showPartialText && streaming.partialText) ||
      streaming.thinkingText ||
      streaming.isThinking ||
      (streaming.thinkingDurationMs ?? 0) >= 1000 ||
      streaming.awaitingModel ||
      streaming.activeTools.length > 0 ||
      streaming.activeHook ||
      streaming.systemStatus ||
      streaming.traceEvents.length > 0 ||
      Object.keys(streaming.taskStates).length > 0 ||
      (streaming.todos && streaming.todos.length > 0));
  const hasWorkflowCards = Boolean(
    streaming && Object.values(streaming.taskStates).some(isWorkflowTask),
  );

  // 仅在既不等待也无冻结数据时才隐藏
  if (!isWaiting && !hasStreamData) return null;

  // Waiting but no stream data: the row marks where the reply will appear,
  // and the run status bar says what the run is doing.
  if (isWaiting && !hasStreamData) {
    if (turnAnswered) return null;
    if (isCompact) {
      return (
        <div className="mb-2 border-b border-surface-border pb-2">
          <div className="flex h-6 items-center gap-1.5">
            <span className="text-caption font-medium text-foreground">
              {senderName}
            </span>
          </div>
        </div>
      );
    }
    return <div className="w-full pb-6">{identityRow}</div>;
  }

  if (!streaming) return null;

  const content = (
    <StreamingContent
      streaming={streaming}
      groupJid={groupJid}
      thinkingExpanded={thinkingExpanded}
      setThinkingExpanded={(v) => {
        setThinkingExpanded(v);
        userToggledThinkingRef.current = true;
      }}
      showPartialText={showPartialText}
      live={live}
      layout={layout}
    />
  );

  // ── Compact mode streaming ──
  if (isCompact) {
    return (
      <div className="mb-2 border-b border-surface-border pb-2">
        {/* Sender line */}
        <div
          data-follow-sticky
          className="sticky top-0 z-10 mb-1 flex h-6 items-center gap-1.5 bg-background"
        >
          <span className="text-caption font-medium text-foreground">
            {senderName}
          </span>
        </div>

        {/* Content — flat, no card wrapper */}
        <div className="min-w-0 overflow-hidden">{content}</div>
      </div>
    );
  }

  // ── Chat mode streaming (default) ──
  // Same identity row and flat body as a finished MessageBubble, so the
  // streaming → final swap keeps every line where it was.
  return (
    <div className="w-full pb-6">
      {identityRow}
      <div>
        <div>
          {/* Workflow already provides the primary card surface. Keep the
              streaming shell flat so the UI never nests one card in another. */}
          <div
            className={
              hasWorkflowCards
                ? 'overflow-hidden font-serif'
                : 'overflow-hidden font-serif'
            }
          >
            {content}
          </div>
        </div>
      </div>
      {/* Holds the place of the final reply's action row (MessageBubble), so
          the card and the reply that replaces it are the same height. */}
      <div
        aria-hidden="true"
        className="mt-1.5 h-7 pointer-coarse:h-10 phone:h-11"
      />
    </div>
  );
}
