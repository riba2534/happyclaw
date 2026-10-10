import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Loader2,
  Sparkles,
} from 'lucide-react';
import {
  shouldRecoverStaleWaiting,
  useChatStore,
  type StreamingState,
} from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';
import { resolveAgentDisplayIdentity } from '../../utils/agent-identity';
import type { AgentInfo, InteractionMode } from '../../types';
import { EmojiAvatar } from '../common/EmojiAvatar';
import { MarkdownRenderer } from './MarkdownRenderer';
import { StreamingMarkdown } from './StreamingMarkdown';
import { markdownTail } from '../../lib/markdown-blocks';
import { TodoProgressPanel } from './TodoProgressPanel';
import { describeToolActivity, ToolActivityCard } from './ToolActivityCard';
import { useDisplayMode } from '../../hooks/useDisplayMode';
import { useConnectionStatus } from '../../hooks/useConnectionStatus';
import { useShellStore } from '../../stores/shell';
import { formatThinkingDuration } from '../../utils/thinking-duration';
import { WorkflowRunCard } from './WorkflowRunCard';
import { PermissionAlert, TracePanel } from './ExecutionTrace';
import { shouldShowStreamingPartialText } from '../../lib/interaction-mode';
import { useThrottledValue } from '../../hooks/useThrottledValue';
import { cn } from '@/lib/utils';

/**
 * Streamed Markdown re-parses its open block on every update, so show it at
 * ~10 Hz instead of at frame rate. Status, tools and thinking stay live.
 */
const STREAMING_MARKDOWN_INTERVAL_MS = 100;

/** Sub-agent progress panels preview only the end of their streamed text. */
const PROGRESS_TAIL_CHARS = 2000;

/**
 * AskUserQuestion options. The runner has no interactive answer channel, so
 * the reply is the user's next message: an option click fills the composer.
 */
function AskUserQuestionCard({
  toolInput,
}: {
  toolInput: Record<string, unknown>;
}) {
  // Support both "question" (string) and "questions" (array) formats
  const questions: Array<{
    question: string;
    options?: Array<{ value: string; label?: string }>;
  }> = [];
  if (Array.isArray(toolInput.questions)) {
    for (const q of toolInput.questions) {
      if (q && typeof q === 'object' && 'question' in q) {
        questions.push(
          q as {
            question: string;
            options?: Array<{ value: string; label?: string }>;
          },
        );
      }
    }
  } else if (typeof toolInput.question === 'string') {
    questions.push({
      question: toolInput.question,
      options: Array.isArray(toolInput.options) ? toolInput.options : undefined,
    });
  }

  if (questions.length === 0) return null;

  return (
    <div className="mt-2 mb-2 space-y-2">
      {questions.map((q, qi) => (
        <div
          key={qi}
          className="rounded-lg bg-surface-raised p-3 font-sans ring-1 ring-surface-border"
        >
          <div className="mb-2 text-body font-medium text-foreground">
            {q.question}
          </div>
          {q.options && q.options.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {q.options.map((opt, oi) => {
                const label = opt.label || opt.value || '';
                return (
                  <button
                    key={oi}
                    type="button"
                    disabled={!label}
                    onClick={() =>
                      useShellStore.getState().requestComposerDraft(label)
                    }
                    className="inline-flex h-7 cursor-pointer items-center rounded-md bg-muted px-2.5 text-caption font-medium text-foreground ring-1 ring-surface-border transition-colors outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-default pointer-coarse:h-10"
                  >
                    {label || '—'}
                  </button>
                );
              })}
            </div>
          )}
          <div className="mt-2 text-caption text-muted-foreground">
            点选项填入输入框，或直接输入回复后发送
          </div>
        </div>
      ))}
    </div>
  );
}

const TASK_STATUS_LABELS: Record<string, string> = {
  running: '执行中',
  completed: '已完成',
  error: '出错',
  stopped: '已停止',
  aborted: '已停止',
};

function isCompactingStatus(status: string | null | undefined): boolean {
  return status === 'compacting' || !!status?.startsWith('正在整理上下文');
}

/** The runner's heartbeat while the model reasons without visible thinking. */
const DEEP_THINKING_STATUS = '正在深入分析…';

/** Statuses the run status line already shows as its phase. */
function isPhaseSystemStatus(status: string): boolean {
  return (
    status === 'requesting' ||
    status === DEEP_THINKING_STATUS ||
    isCompactingStatus(status)
  );
}

/** Collapsible block for a single Task Agent — visually consistent with the Thinking block. */
/** Present-tense phase for the run status next to the agent name. */
function describeRunPhase(
  streaming: StreamingState | null | undefined,
  stopping: boolean,
) {
  if (stopping) return '正在停止…';
  if (!streaming || streaming.settling) return '正在准备回复';
  const tools = streaming.activeTools;
  const tool =
    [...tools].reverse().find((t) => !t.isNested) ?? tools[tools.length - 1];
  if (tool) return describeToolActivity(tool.toolName);
  if (isCompactingStatus(streaming.systemStatus)) return '正在整理上下文';
  // A tool just returned: the model is working out its next step.
  if (streaming.isThinking || streaming.awaitingModel) return '正在思考';
  if (streaming.systemStatus === DEEP_THINKING_STATUS) return '正在深入分析';
  if (streaming.partialText) return '正在回复';
  return '正在处理';
}

/** Thinking shorter than a second reads as noise ("已思考 0.2 秒"). */
function thinkingLabel(durationMs: number | undefined): string {
  return durationMs != null && durationMs >= 1000
    ? formatThinkingDuration(durationMs)
    : '思考过程';
}

/** Initial reasoning-block state: open only while thinking is live. */
function initialThinkingExpanded(
  streaming: StreamingState | null | undefined,
): boolean {
  return !streaming?.thinkingText || streaming.isThinking;
}

/**
 * Milliseconds between Markdown renders of the open (last) block. An open
 * table or long block re-parses in full on every render (85ms for a 60-row
 * table at 4x CPU), so large open blocks render less often.
 */
function streamingMarkdownInterval(text: string): number {
  const openTail = text.length - text.lastIndexOf('\n\n');
  if (openTail > 4000) return 300;
  if (openTail > 1500) return 200;
  return STREAMING_MARKDOWN_INTERVAL_MS;
}

function formatRunElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/** Codex-style run status: current phase plus time since the run started. */
const RunStatus = memo(function RunStatus({
  runtimeJid,
  phase,
  stopHint = false,
}: {
  runtimeJid: string;
  phase: string;
  /** This view's composer stops the run on Esc. */
  stopHint?: boolean;
}) {
  const startedAt = useChatStore((s) => s.activeRuns[runtimeJid]?.startedAt);
  // A requested stop freezes the timer at the click: the run is ending.
  const stoppedAt = useChatStore((s) => s.stopRequests[runtimeJid]);
  // Offline, the run may have moved on; don't pretend the phase is live. A
  // dropped WebSocket alone isn't enough: HTTP polling keeps state fresh.
  const offline = useConnectionStatus() === 'offline';
  const shownPhase = offline ? '网络已断开，恢复后同步' : phase;
  const announced = useThrottledValue(shownPhase, 3000);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt || stoppedAt) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [startedAt, stoppedAt]);
  const start = startedAt ? Date.parse(startedAt) : Number.NaN;
  const elapsed = Number.isFinite(start)
    ? Math.max(0, Math.floor(((stoppedAt ?? now) - start) / 1000))
    : null;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-caption text-muted-foreground">
      <span
        className={cn(
          'truncate',
          offline ? 'text-warning' : !stoppedAt && 'shimmer',
        )}
      >
        {shownPhase}
      </span>
      <span role="status" aria-live="polite" className="sr-only">
        {announced}
      </span>
      {elapsed != null && !offline && (
        <span className="shrink-0 text-faint-foreground tabular-nums">
          {formatRunElapsed(elapsed)}
        </span>
      )}
      {stopHint && !stoppedAt && !offline && (
        <span
          aria-hidden="true"
          className="shrink-0 text-faint-foreground max-sm:hidden pointer-coarse:hidden"
        >
          · Esc 停止
        </span>
      )}
    </span>
  );
});

function TaskAgentBlock({
  agent,
  groupJid,
}: {
  agent: AgentInfo;
  groupJid: string;
}) {
  const streaming = useChatStore((s) => s.agentStreaming[agent.id]);
  const isRunning = agent.status === 'running';
  const partialMarkdown = useThrottledValue(
    markdownTail(streaming?.partialText ?? '', PROGRESS_TAIL_CHARS),
    STREAMING_MARKDOWN_INTERVAL_MS,
  );
  const [expanded, setExpanded] = useState(isRunning);
  const [localElapsed, setLocalElapsed] = useState<Record<string, number>>({});

  // Auto-expand when agent starts running
  useEffect(() => {
    if (isRunning) setExpanded(true);
  }, [isRunning]);

  // Local elapsed timer for tools. Depend on the joined tool-id signature
  // (membership) rather than the array reference — every tool_progress event
  // produces a fresh array but the same members, and re-creating the interval
  // each time would prevent it from ever ticking.
  const activeToolIdSignature =
    streaming?.activeTools.map((t) => t.toolUseId).join('|') ?? '';
  useEffect(() => {
    if (!activeToolIdSignature) {
      setLocalElapsed({});
      return;
    }
    const interval = setInterval(() => {
      const now = Date.now();
      const tools =
        useChatStore.getState().agentStreaming[agent.id]?.activeTools ?? [];
      const next: Record<string, number> = {};
      for (const tool of tools) {
        next[tool.toolUseId] = (now - tool.startTime) / 1000;
      }
      setLocalElapsed(next);
    }, 1000);
    return () => clearInterval(interval);
  }, [activeToolIdSignature, agent.id]);

  // Neutral card; only the status dot carries color.
  const borderColor = 'border-surface-border';
  const bgColor = 'bg-surface-raised';
  const hoverBg = 'hover:bg-surface-hover';
  const dotColor = isRunning
    ? 'bg-primary animate-pulse'
    : agent.status === 'error'
      ? 'bg-error'
      : 'bg-success';
  const textColor = 'text-foreground';
  const chevronColor = 'text-faint-foreground';
  const contentBorderColor = 'border-surface-border';

  return (
    <div
      className={`mb-3 overflow-hidden rounded-lg border font-sans ${borderColor} ${bgColor}`}
    >
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className={`flex h-9 w-full cursor-pointer items-center gap-2 px-3 text-left transition-colors ${hoverBg}`}
      >
        <span className={`size-2 shrink-0 rounded-full ${dotColor}`} />
        <span className={`truncate text-label font-medium ${textColor}`}>
          子 Agent: {agent.name}
        </span>
        <span className="shrink-0 text-caption text-muted-foreground">
          {TASK_STATUS_LABELS[agent.status] || agent.status}
        </span>
        <span className="flex-1" />
        {expanded ? (
          <ChevronUp className={`w-3.5 h-3.5 ${chevronColor}`} />
        ) : (
          <ChevronDown className={`w-3.5 h-3.5 ${chevronColor}`} />
        )}
      </button>
      {expanded && (
        <div className={`px-3 pb-3 border-t ${contentBorderColor} space-y-2`}>
          {/* Agent prompt */}
          <p className="mt-2 line-clamp-2 text-caption text-muted-foreground">
            {agent.prompt}
          </p>

          {/* Live streaming state (running) */}
          {isRunning && streaming && (
            <>
              {streaming.isThinking && (
                <p className="flex items-center gap-1 text-label text-muted-foreground">
                  思考中
                  <span className="flex gap-0.5 ml-0.5">
                    <span className="size-1 animate-bounce rounded-full bg-faint-foreground [animation-delay:-0.3s]" />
                    <span className="size-1 animate-bounce rounded-full bg-faint-foreground [animation-delay:-0.15s]" />
                    <span className="size-1 animate-bounce rounded-full bg-faint-foreground" />
                  </span>
                </p>
              )}
              {streaming.activeTools.length > 0 && (
                <div className="space-y-1.5">
                  {streaming.activeTools
                    .filter((t) => t.toolName !== 'AskUserQuestion')
                    .map((tool) => (
                      <ToolActivityCard
                        key={tool.toolUseId}
                        tool={tool}
                        localElapsed={localElapsed[tool.toolUseId]}
                      />
                    ))}
                </div>
              )}
              {streaming.partialText && (
                <div className="max-w-none overflow-hidden [&>div>*:first-child]:!mt-0">
                  <MarkdownRenderer
                    content={partialMarkdown}
                    groupJid={groupJid}
                    variant="docs"
                    streaming
                  />
                </div>
              )}
            </>
          )}

          {/* Result summary (completed/error) */}
          {!isRunning && agent.result_summary && (
            <p className="text-label text-foreground/80">
              {agent.result_summary}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

const SdkTaskRuntimeBlock = memo(function SdkTaskRuntimeBlock({
  task,
  groupJid,
}: {
  task: import('../../stores/chat').StreamingTaskRuntimeState;
  groupJid: string;
}) {
  const [expanded, setExpanded] = useState(task.status === 'running');
  const isRunning = task.status === 'running' || task.status === 'backgrounded';
  const textTailMarkdown = useThrottledValue(
    markdownTail(task.textTail, PROGRESS_TAIL_CHARS),
    STREAMING_MARKDOWN_INTERVAL_MS,
  );
  const statusLabel =
    task.status === 'completed'
      ? '已完成'
      : task.status === 'error'
        ? '出错'
        : task.status === 'backgrounded'
          ? '后台执行'
          : '执行中';

  return (
    <div className="overflow-hidden rounded-lg bg-surface-raised font-sans ring-1 ring-surface-border">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="flex h-9 w-full cursor-pointer items-center gap-2 px-3 text-left transition-colors hover:bg-surface-hover"
      >
        <span
          className={`size-2 rounded-full ${isRunning ? 'animate-pulse bg-primary' : task.status === 'error' ? 'bg-error' : 'bg-success'}`}
        />
        <span className="truncate text-label font-medium text-foreground">
          {task.title}
        </span>
        {task.subagentType && (
          <span className="shrink-0 text-caption text-faint-foreground">
            {task.subagentType}
          </span>
        )}
        <span className="shrink-0 text-caption text-muted-foreground">
          {statusLabel}
        </span>
        <span className="flex-1" />
        {expanded ? (
          <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" />
        ) : (
          <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
        )}
      </button>
      {expanded && (
        <div className="space-y-2 border-t border-surface-border px-3 py-2">
          {task.latestSummary && (
            <div className="text-label break-words whitespace-pre-wrap text-foreground/80">
              {task.lastToolName && (
                <span className="text-muted-foreground">
                  [{task.lastToolName}]{' '}
                </span>
              )}
              {task.latestSummary}
            </div>
          )}
          {task.activeTools.length > 0 && (
            <div className="space-y-1.5">
              {task.activeTools.map((tool) => (
                <ToolActivityCard
                  key={tool.toolUseId}
                  tool={tool}
                  localElapsed={undefined}
                />
              ))}
            </div>
          )}
          {task.recentTools.length > 0 && (
            <div className="space-y-0.5 text-caption text-muted-foreground">
              {task.recentTools.slice(-5).map((item) => (
                <div key={item.id}>{item.text}</div>
              ))}
            </div>
          )}
          {task.thinkingTail && (
            <div className="max-h-28 overflow-y-auto rounded-md border-l-2 border-surface-border bg-muted/40 px-2 py-1.5 text-label break-words whitespace-pre-wrap text-muted-foreground">
              {task.thinkingTail}
            </div>
          )}
          {task.textTail && (
            <div className="max-w-none overflow-hidden [&>div>*:first-child]:!mt-0">
              <MarkdownRenderer
                content={textTailMarkdown}
                groupJid={groupJid}
                variant="docs"
                streaming
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
});

/** Shared streaming content — used by both compact and chat modes to eliminate duplication. */
function StreamingContent({
  streaming,
  localElapsed,
  groupJid,
  thinkingExpanded,
  setThinkingExpanded,
  thinkingRef,
  handleThinkingScroll,
  showPartialText,
  live,
}: {
  streaming: import('../../stores/chat').StreamingState;
  localElapsed: Record<string, number>;
  groupJid: string;
  thinkingExpanded: boolean;
  setThinkingExpanded: (v: boolean) => void;
  thinkingRef: React.RefObject<HTMLDivElement | null>;
  handleThinkingScroll: () => void;
  showPartialText: boolean;
  /** The run is producing this card right now (not stopped or settled). */
  live: boolean;
}) {
  const partialMarkdown = useThrottledValue(
    streaming.partialText,
    streamingMarkdownInterval(streaming.partialText),
  );
  // Text is arriving: a quiet trailing dot marks where it continues.
  const writing =
    live &&
    !streaming.isThinking &&
    !streaming.awaitingModel &&
    streaming.activeTools.length === 0 &&
    !!streaming.partialText;
  // Classify active tools
  const cardTools = streaming.activeTools.filter(
    (t) => t.toolName !== 'AskUserQuestion',
  );
  const askUserTools = streaming.activeTools.filter(
    (t) => t.toolName === 'AskUserQuestion' && t.toolInput,
  );
  const hasWorkflowTasks = Object.values(streaming.taskStates).some(
    (task) => task.workflowRun || task.taskType === 'local_workflow',
  );
  const showSystemStatus =
    streaming.systemStatus &&
    !isPhaseSystemStatus(streaming.systemStatus) &&
    !(
      hasWorkflowTasks &&
      /后台任务运行中|完成后将继续汇总/u.test(streaming.systemStatus)
    )
      ? streaming.systemStatus
      : null;

  return (
    <>
      {/* System status */}
      {showSystemStatus && (
        <div className="mb-2 flex h-7 items-center gap-2 font-sans text-label text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          <span>{showSystemStatus}</span>
        </div>
      )}

      {/* Reasoning block */}
      {streaming.thinkingText && (
        <div className="mb-2 font-sans">
          <button
            type="button"
            onClick={() => setThinkingExpanded(!thinkingExpanded)}
            aria-expanded={thinkingExpanded}
            className="-ml-1.5 inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-caption text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
          >
            <Sparkles className="size-3.5" />
            <span className={streaming.isThinking ? 'shimmer' : undefined}>
              {streaming.isThinking
                ? '思考中…'
                : thinkingLabel(streaming.thinkingDurationMs)}
            </span>
            <ChevronRight
              className={`size-3.5 transition-transform duration-150 ${thinkingExpanded ? 'rotate-90' : ''}`}
            />
          </button>
          {thinkingExpanded && (
            <div
              ref={thinkingRef}
              onScroll={handleThinkingScroll}
              className="mt-1 mb-3 max-h-64 overflow-y-auto border-l-2 border-surface-border pl-3 text-label leading-6 break-words whitespace-pre-wrap text-muted-foreground"
            >
              {streaming.thinkingText}
            </div>
          )}
        </div>
      )}

      {/* Active tools */}
      {streaming.activeTools.length > 0 && (
        <div className="mb-2 space-y-1.5">
          {cardTools.length > 0 && (
            <div className="space-y-1.5">
              {cardTools.map((tool) => (
                <ToolActivityCard
                  key={tool.toolUseId}
                  tool={tool}
                  localElapsed={localElapsed[tool.toolUseId]}
                />
              ))}
            </div>
          )}
          {askUserTools.map((tool) => (
            <AskUserQuestionCard
              key={tool.toolUseId}
              toolInput={tool.toolInput ?? {}}
            />
          ))}
        </div>
      )}

      {/* Todo progress */}
      {streaming.todos && streaming.todos.length > 0 && (
        <TodoProgressPanel todos={streaming.todos} />
      )}

      {/* SDK Task / sub-agent runtime state */}
      {Object.keys(streaming.taskStates).length > 0 && (
        <div className="mb-2 space-y-1.5">
          {Object.values(streaming.taskStates)
            .sort((a, b) => a.updatedAt - b.updatedAt)
            .map((task) =>
              task.workflowRun || task.taskType === 'local_workflow' ? (
                <WorkflowRunCard
                  key={task.id}
                  run={
                    task.workflowRun ?? {
                      taskId: task.id,
                      workflowName: task.workflowName,
                      summary: task.title,
                      status:
                        task.status === 'completed'
                          ? 'completed'
                          : task.status === 'error'
                            ? 'failed'
                            : 'running',
                      durationMs: task.usage?.durationMs,
                      totalTokens: task.usage?.totalTokens,
                      totalToolCalls: task.usage?.toolUses,
                      phases: [],
                      agents: [],
                    }
                  }
                />
              ) : (
                <SdkTaskRuntimeBlock
                  key={task.id}
                  task={task}
                  groupJid={groupJid}
                />
              ),
            )}
        </div>
      )}

      {/* Permission denials — surfaced prominently in red, not buried in trace */}
      <PermissionAlert traceEvents={streaming.traceEvents} />

      {/* Full trace */}
      <TracePanel
        traceEvents={streaming.traceEvents}
        taskCount={Object.keys(streaming.taskStates).length}
      />

      {/* Hook */}
      {streaming.activeHook && (
        <div className="mb-2 flex h-7 items-center gap-2 font-sans text-label text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          <span>Hook: {streaming.activeHook.hookName}</span>
        </div>
      )}

      {/* Partial text */}
      {showPartialText && streaming.partialText && (
        <div className="max-w-none overflow-hidden">
          <StreamingMarkdown
            content={partialMarkdown}
            groupJid={groupJid}
            variant="chat"
            caret={writing}
          />
        </div>
      )}
    </>
  );
}

interface StreamingDisplayProps {
  groupJid: string;
  isWaiting: boolean;
  senderName?: string;
  agentId?: string;
  agentAvatarUrl?: string | null;
  agentAvatarEmoji?: string | null;
  agentAvatarColor?: string | null;
  interactionMode?: InteractionMode;
  /** The status line mentions Esc: this view's composer stops the run. */
  stopHint?: boolean;
  /**
   * Show the finished run's settled card (frozen until its final message
   * replaces it) instead of the live projection.
   */
  settled?: boolean;
}

const EMPTY_AGENTS: AgentInfo[] = [];

export function StreamingDisplay({
  groupJid,
  isWaiting: isWaitingProp,
  senderName: senderNameProp = 'AI',
  agentId,
  agentAvatarUrl,
  agentAvatarEmoji,
  agentAvatarColor,
  interactionMode = 'assistant',
  stopHint = false,
  settled = false,
}: StreamingDisplayProps) {
  // A settled card belongs to a finished run: nothing about it is waiting.
  const isWaiting = settled ? false : isWaitingProp;
  const mainStreaming = useChatStore((s) =>
    settled ? undefined : s.streaming[groupJid],
  );
  const agentStreamingState = useChatStore((s) =>
    agentId && !settled ? s.agentStreaming[agentId] : undefined,
  );
  const settledState = useChatStore((s) =>
    settled
      ? s.settledStreaming[agentId ? `${groupJid}#agent:${agentId}` : groupJid]
      : undefined,
  );
  const runtimeAgentKind = useChatStore((s) =>
    agentId
      ? s.agents[groupJid]?.find((agent) => agent.id === agentId)?.kind
      : undefined,
  );
  const runtimeJid = agentId ? `${groupJid}#agent:${agentId}` : groupJid;
  const streaming = settled
    ? settledState
    : agentId
      ? agentStreamingState
      : mainStreaming;
  const stopping = useChatStore(
    (s) => !settled && !!s.stopRequests[runtimeJid],
  );
  // Task agents — only shown in main conversation (not inside agent tabs)
  const allAgents = useChatStore((s) =>
    !agentId && !settled ? (s.agents[groupJid] ?? EMPTY_AGENTS) : EMPTY_AGENTS,
  );
  const taskAgents = useMemo(
    () => allAgents.filter((a) => a.kind === 'task' && a.status === 'running'),
    [allAgents],
  );
  const hasTaskAgents = taskAgents.length > 0;
  // Fire-and-forget spawn Agents retain Assistant streaming semantics even in
  // a proactive Workspace. The Workspace contract applies to main and
  // conversation Agent loops.
  const effectiveInteractionMode =
    runtimeAgentKind === 'spawn' ? 'assistant' : interactionMode;
  const showPartialText = shouldShowStreamingPartialText(
    effectiveInteractionMode,
  );
  const appearance = useAuthStore((state) => state.appearance);
  const agentIdentity = resolveAgentDisplayIdentity({
    agentName: senderNameProp,
    avatarUrl: agentAvatarUrl,
    avatarEmoji: agentAvatarEmoji,
    avatarColor: agentAvatarColor,
    mainAvatarUrl: appearance?.aiAvatarUrl,
    mainAvatarEmoji:
      appearance?.aiAvatarMode === 'emoji'
        ? appearance.aiAvatarEmoji
        : undefined,
    mainAvatarColor:
      appearance?.aiAvatarMode === 'emoji'
        ? appearance.aiAvatarColor
        : undefined,
  });
  const senderName = agentIdentity.name;
  const { mode: displayMode } = useDisplayMode();
  const isCompact = displayMode === 'compact';
  // After a remount (switching conversations, a reload) a reply that has
  // moved on from thinking keeps its reasoning collapsed.
  const [thinkingExpanded, setThinkingExpanded] = useState(() =>
    initialThinkingExpanded(streaming),
  );
  const thinkingRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);
  const userToggledThinkingRef = useRef(false);
  const [localElapsed, setLocalElapsed] = useState<Record<string, number>>({});

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
      const hasStreamData = agentId
        ? !!state.agentStreaming[agentId]
        : !!state.streaming[groupJid];
      if (
        !shouldRecoverStaleWaiting({
          elapsedMs: Date.now() - lastStreamActivityRef.current,
          hasStreamData,
          hasActiveRun,
        })
      ) {
        return;
      }

      if (agentId) {
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
      } else {
        // clearStreaming also preserves any useful completed thinking state.
        if (!useChatStore.getState().activeRuns[runtimeJid]) {
          useChatStore.getState().clearStreaming(groupJid);
        }
      }
    }, 10_000);

    return () => window.clearInterval(interval);
  }, [agentId, groupJid, isWaiting, runtimeJid]);

  // Auto-scroll thinking content (unless user scrolled up)
  useEffect(() => {
    if (!thinkingExpanded || !thinkingRef.current || userScrolledRef.current)
      return;
    const el = thinkingRef.current;
    el.scrollTop = el.scrollHeight;
  }, [streaming?.thinkingText, thinkingExpanded]);

  // Reset on group change (not on mount: the initial state already did).
  const resetGroupRef = useRef(groupJid);
  useEffect(() => {
    if (resetGroupRef.current === groupJid) return;
    resetGroupRef.current = groupJid;
    const current = agentId
      ? useChatStore.getState().agentStreaming[agentId]
      : useChatStore.getState().streaming[groupJid];
    setThinkingExpanded(initialThinkingExpanded(current));
    userScrolledRef.current = false;
    userToggledThinkingRef.current = false;
  }, [agentId, groupJid]);

  useEffect(() => {
    if (!streaming) {
      setThinkingExpanded(true);
      userScrolledRef.current = false;
      userToggledThinkingRef.current = false;
    }
  }, [streaming]);

  // Collapse the reasoning block once thinking is over so the streaming card
  // height matches the post-streaming MessageBubble's collapsed
  // ReasoningBlock — eliminates the layout jump described in #493. Not only
  // on an observed true → false transition: a burst that starts and ends
  // within one frame (or before a remount) was never seen thinking. We
  // respect an explicit user toggle during this turn.
  useEffect(() => {
    const isThinking = streaming?.isThinking ?? false;
    const hasThinking = !!streaming?.thinkingText;
    if (!isThinking && hasThinking && !userToggledThinkingRef.current) {
      setThinkingExpanded(false);
    }
  }, [streaming?.isThinking, streaming?.thinkingText]);

  // Local elapsed time for tools. Depend on the joined tool-id signature
  // (membership) rather than the array reference; tool_progress events bump
  // the array reference every ~200ms and would otherwise reset the timer
  // before it ever ticks.
  const mainActiveToolIdSignature =
    streaming?.activeTools.map((t) => t.toolUseId).join('|') ?? '';
  useEffect(() => {
    if (!mainActiveToolIdSignature) {
      setLocalElapsed({});
      return;
    }

    const interval = setInterval(() => {
      const now = Date.now();
      const state = useChatStore.getState();
      const tools =
        (agentId
          ? state.agentStreaming[agentId]?.activeTools
          : state.streaming[groupJid]?.activeTools) ?? [];
      const next: Record<string, number> = {};
      for (const tool of tools) {
        next[tool.toolUseId] = (now - tool.startTime) / 1000;
      }
      setLocalElapsed(next);
    }, 1000);

    return () => clearInterval(interval);
  }, [mainActiveToolIdSignature, agentId, groupJid]);

  const handleThinkingScroll = () => {
    if (!thinkingRef.current) return;
    const el = thinkingRef.current;
    const isAtBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
    userScrolledRef.current = !isAtBottom;
  };

  const runStatus =
    isWaiting && !streaming?.interrupted ? (
      <RunStatus
        runtimeJid={runtimeJid}
        phase={describeRunPhase(streaming, stopping)}
        stopHint={stopHint}
      />
    ) : null;
  // Only a card the run is still writing gets live affordances (the caret).
  const live =
    isWaiting &&
    !stopping &&
    !!streaming &&
    !streaming.interrupted &&
    !streaming.settling;
  // Sticky: a long run pushes the row above the viewport, and it carries the
  // phase and elapsed time. Same height as MessageBubble's row so the
  // streaming → final swap doesn't move content.
  const identityRow = (
    <div className="sticky top-0 z-10 mb-1.5 flex h-6 items-center gap-2 bg-background">
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
      {runStatus}
    </div>
  );

  // Proactive mode exposes only committed native messages plus an explicit run
  // lifecycle. Keep its activity signal visually separate from message content:
  // it is not an unfinished Assistant reply and must not look like another card.
  if (effectiveInteractionMode === 'proactive') {
    if (!isWaiting) return null;
    return (
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        aria-label={`${senderName}正在处理`}
        className={
          isCompact
            ? 'mb-2 flex min-h-10 items-center gap-2 border-b border-surface-border pb-2 text-body text-muted-foreground'
            : 'flex min-h-10 w-full items-center gap-2 py-2 text-body text-muted-foreground'
        }
      >
        <Loader2
          aria-hidden="true"
          className="h-4 w-4 shrink-0 animate-spin text-muted-foreground motion-reduce:animate-none"
        />
        <span>正在处理…</span>
      </div>
    );
  }

  // 计算是否有流式数据（含中断后冻结的 partialText）
  const hasStreamData =
    (streaming &&
      ((showPartialText && streaming.partialText) ||
        streaming.thinkingText ||
        streaming.activeTools.length > 0 ||
        streaming.activeHook ||
        streaming.systemStatus ||
        streaming.traceEvents.length > 0 ||
        Object.keys(streaming.taskStates).length > 0 ||
        (streaming.todos && streaming.todos.length > 0))) ||
    hasTaskAgents;
  const hasWorkflowCards = Boolean(
    streaming &&
    Object.values(streaming.taskStates).some(
      (task) => task.workflowRun || task.taskType === 'local_workflow',
    ),
  );

  // 仅在既不等待也无冻结数据时才隐藏
  if (!isWaiting && !hasStreamData) return null;

  // Waiting but no stream data: the identity row carries the visible status;
  // keep a one-shot live region for assistive tech (the timer is not live).
  if (isWaiting && !hasStreamData) {
    const status = (
      <span role="status" aria-live="polite" className="sr-only">
        正在准备回复…
      </span>
    );
    if (isCompact) {
      return (
        <div className="mb-2 border-b border-surface-border pb-2">
          <div className="flex h-6 items-center gap-1.5">
            <span className="text-caption font-medium text-foreground">
              {senderName}
            </span>
            {runStatus}
          </div>
          {status}
        </div>
      );
    }
    return (
      <div className="w-full pb-6">
        {identityRow}
        {status}
      </div>
    );
  }

  if (!streaming && !hasTaskAgents) return null;

  // ── Compact mode streaming ──
  if (isCompact) {
    return (
      <div className="mb-2 border-b border-surface-border pb-2">
        {/* Sender line */}
        <div className="sticky top-0 z-10 mb-1 flex h-6 items-center gap-1.5 bg-background">
          <span className="text-caption font-medium text-foreground">
            {senderName}
          </span>
          {runStatus}
        </div>

        {/* Content — flat, no card wrapper */}
        <div className="min-w-0 overflow-hidden">
          {/* Shared streaming content */}
          {streaming && (
            <StreamingContent
              streaming={streaming}
              localElapsed={localElapsed}
              groupJid={groupJid}
              thinkingExpanded={thinkingExpanded}
              setThinkingExpanded={(v) => {
                setThinkingExpanded(v);
                userToggledThinkingRef.current = true;
                if (v) userScrolledRef.current = false;
              }}
              thinkingRef={thinkingRef}
              handleThinkingScroll={handleThinkingScroll}
              showPartialText={showPartialText}
              live={live}
            />
          )}

          {/* Task agent blocks */}
          {taskAgents.map((agent) => (
            <TaskAgentBlock key={agent.id} agent={agent} groupJid={groupJid} />
          ))}
        </div>
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
            {streaming && (
              <StreamingContent
                streaming={streaming}
                localElapsed={localElapsed}
                groupJid={groupJid}
                thinkingExpanded={thinkingExpanded}
                setThinkingExpanded={(v) => {
                  setThinkingExpanded(v);
                  userToggledThinkingRef.current = true;
                  if (v) userScrolledRef.current = false;
                }}
                thinkingRef={thinkingRef}
                handleThinkingScroll={handleThinkingScroll}
                showPartialText={showPartialText}
                live={live}
              />
            )}

            {/* Task agent blocks */}
            {taskAgents.map((agent) => (
              <TaskAgentBlock
                key={agent.id}
                agent={agent}
                groupJid={groupJid}
              />
            ))}
          </div>
        </div>
      </div>
      {/* Holds the place of the final reply's action row (MessageBubble), so
          the card and the reply that replaces it are the same height. */}
      <div aria-hidden="true" className="mt-1.5 h-7 pointer-coarse:h-10" />
    </div>
  );
}
