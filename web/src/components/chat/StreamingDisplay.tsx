import { memo, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ListTree,
  Loader2,
  ShieldAlert,
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
import { TodoProgressPanel } from './TodoProgressPanel';
import { describeToolActivity, ToolActivityCard } from './ToolActivityCard';
import { useDisplayMode } from '../../hooks/useDisplayMode';
import { formatThinkingDuration } from '../../utils/thinking-duration';
import { WorkflowRunCard } from './WorkflowRunCard';
import { shouldShowStreamingPartialText } from '../../lib/interaction-mode';
import { useThrottledValue } from '../../hooks/useThrottledValue';

/**
 * Streamed Markdown is re-parsed and re-rendered whole on every update, so
 * show it at ~10 Hz instead of at frame rate. Status, tools and thinking stay
 * live.
 */
const STREAMING_MARKDOWN_INTERVAL_MS = 100;

/** Tail of a long streamed text: only the end is rendered while it streams. */
function streamingTail(text: string, max: number, keep: number): string {
  return text.length > max ? '...' + text.slice(-keep) : text;
}

/** Render AskUserQuestion options as a visual card (read-only). */
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
              {q.options.map((opt, oi) => (
                <span
                  key={oi}
                  className="inline-flex h-7 items-center rounded-md bg-muted px-2.5 text-caption font-medium text-foreground ring-1 ring-surface-border"
                >
                  {opt.label || opt.value || '—'}
                </span>
              ))}
            </div>
          )}
          <div className="mt-2 text-caption text-muted-foreground">
            请在智能体终端中回复
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

function formatSystemStatus(status: string): string {
  if (status === 'requesting') return '正在处理…';
  if (status === 'compacting') return '正在整理上下文…';
  return status;
}

/** Collapsible block for a single Task Agent — visually consistent with the Thinking block. */
/** Present-tense phase for the run status next to the agent name. */
function describeRunPhase(streaming: StreamingState | null | undefined) {
  if (!streaming) return '正在准备回复';
  const tools = streaming.activeTools;
  const tool =
    [...tools].reverse().find((t) => !t.isNested) ?? tools[tools.length - 1];
  if (tool) return describeToolActivity(tool.toolName);
  if (streaming.isThinking) return '正在思考';
  if (streaming.partialText) return '正在回复';
  return '正在处理';
}

function formatRunElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/** Codex-style run status: current phase plus time since the run started. */
const RunStatus = memo(function RunStatus({
  runtimeJid,
  phase,
}: {
  runtimeJid: string;
  phase: string;
}) {
  const startedAt = useChatStore((s) => s.activeRuns[runtimeJid]?.startedAt);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(interval);
  }, [startedAt]);
  const start = startedAt ? Date.parse(startedAt) : Number.NaN;
  const elapsed = Number.isFinite(start)
    ? Math.max(0, Math.floor((now - start) / 1000))
    : null;
  return (
    <span className="flex min-w-0 items-center gap-1.5 text-caption text-muted-foreground">
      <span className="shimmer truncate">{phase}</span>
      {elapsed != null && (
        <span className="shrink-0 text-faint-foreground tabular-nums">
          {formatRunElapsed(elapsed)}
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
    streamingTail(streaming?.partialText ?? '', 2000, 1500),
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
    streamingTail(task.textTail, 2000, 1500),
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

// The trace and permission panels take the event list rather than the whole
// streaming state, so they skip the re-renders caused by streamed text.
const TracePanel = memo(function TracePanel({
  traceEvents,
  taskCount,
}: {
  traceEvents: import('../../stores/chat').StreamingState['traceEvents'];
  taskCount: number;
}) {
  const [expanded, setExpanded] = useState(false);
  const seenTrace = new Set<string>();
  const visibleTrace = traceEvents
    .filter((e) => e.displayLevel !== 'debug' && e.kind !== 'context')
    .filter((event) => {
      const key = `${event.kind}\u0000${event.taskId ?? ''}\u0000${event.title}\u0000${event.summary ?? ''}\u0000${event.detail ?? ''}`;
      if (seenTrace.has(key)) return false;
      seenTrace.add(key);
      return true;
    });
  if (visibleTrace.length === 0 && taskCount === 0) return null;

  const groups = [
    {
      key: 'permission',
      label: '权限拒绝',
      items: visibleTrace.filter((e) => e.kind === 'permission'),
    },
    {
      key: 'task',
      label: '子任务',
      items: visibleTrace.filter((e) => e.kind === 'task'),
    },
    {
      key: 'tool',
      label: '工具',
      items: visibleTrace.filter(
        (e) => e.kind === 'tool' || e.kind === 'skill',
      ),
    },
    {
      key: 'hook',
      label: 'Hooks',
      items: visibleTrace.filter((e) => e.kind === 'hook'),
    },
    {
      key: 'memory',
      label: '记忆与压缩',
      items: visibleTrace.filter((e) => e.kind === 'memory'),
    },
    {
      key: 'system',
      label: '系统',
      items: visibleTrace.filter((e) => e.kind === 'status'),
    },
  ].filter((g) => g.items.length > 0);

  return (
    <div className="mb-2 font-sans">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        className="-ml-1.5 inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-caption text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
      >
        <ListTree className="size-3.5" />
        <span>执行详情</span>
        <span className="tabular-nums text-faint-foreground">
          {visibleTrace.length} 条
        </span>
        <ChevronRight
          className={`size-3.5 transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`}
        />
      </button>
      {expanded && (
        <div className="mt-1 max-h-72 space-y-3 overflow-y-auto border-l-2 border-surface-border py-1 pl-3">
          {groups.map((group) => (
            <div key={group.key}>
              <div className="mb-1 text-micro font-medium text-faint-foreground">
                {group.label}
              </div>
              <div className="space-y-1">
                {group.items.slice(-20).map((item) => (
                  <TraceRow
                    key={item.id}
                    item={item}
                    danger={group.key === 'permission'}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

/** A single trace row. Rows carrying a `detail` (e.g. recalled memory, compaction
 *  summary) become click-to-expand so the trace stays scannable but the full
 *  context is one click away. Permission rows render in red. */
function TraceRow({
  item,
  danger,
}: {
  item: import('../../stores/chat').StreamingTraceEvent;
  danger?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const hasDetail = !!item.detail && item.detail !== item.summary;
  const base = danger ? 'text-error' : 'text-foreground/80';
  return (
    <div className={`text-label ${base} break-words`}>
      <div
        className={`flex items-start gap-1${hasDetail ? ' cursor-pointer' : ''}`}
        onClick={hasDetail ? () => setOpen((o) => !o) : undefined}
      >
        {hasDetail &&
          (open ? (
            <ChevronUp className="w-3 h-3 mt-0.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown className="w-3 h-3 mt-0.5 shrink-0 text-muted-foreground" />
          ))}
        <span>
          <span className="font-medium">{item.title}</span>
          {item.summary && (
            <span className="text-muted-foreground"> — {item.summary}</span>
          )}
        </span>
      </div>
      {hasDetail && open && (
        <div className="mt-0.5 ml-4 border-l-2 border-surface-border pl-2 text-caption break-all whitespace-pre-wrap text-muted-foreground">
          {item.detail}
        </div>
      )}
    </div>
  );
}

/** Prominent red banner listing denied tool calls — a denied permission is a
 *  real signal the user should see at a glance, not something buried in the
 *  collapsed trace panel. */
const PermissionAlert = memo(function PermissionAlert({
  traceEvents,
}: {
  traceEvents: import('../../stores/chat').StreamingState['traceEvents'];
}) {
  const denied = traceEvents.filter((e) => e.kind === 'permission');
  if (denied.length === 0) return null;
  return (
    <div className="mb-2 rounded-lg bg-error/5 p-2.5 font-sans ring-1 ring-error/20">
      <div className="mb-1 flex items-center gap-1.5 text-caption font-medium text-error">
        <ShieldAlert className="size-3.5" />
        权限被拒绝 ({denied.length})
      </div>
      <div className="space-y-0.5 max-h-28 overflow-y-auto">
        {denied.slice(-10).map((item) => (
          <div
            key={item.id}
            className="text-label break-words text-foreground/80"
          >
            <span className="font-medium">{item.title}</span>
            {(item.detail || item.summary) && (
              <span className="opacity-75">
                {' '}
                — {item.detail || item.summary}
              </span>
            )}
          </div>
        ))}
      </div>
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
}: {
  streaming: import('../../stores/chat').StreamingState;
  localElapsed: Record<string, number>;
  groupJid: string;
  thinkingExpanded: boolean;
  setThinkingExpanded: (v: boolean) => void;
  thinkingRef: React.RefObject<HTMLDivElement | null>;
  handleThinkingScroll: () => void;
  showPartialText: boolean;
}) {
  const partialMarkdown = useThrottledValue(
    streamingTail(streaming.partialText, 3000, 2000),
    STREAMING_MARKDOWN_INTERVAL_MS,
  );
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
          <span>{formatSystemStatus(showSystemStatus)}</span>
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
                : streaming.thinkingDurationMs != null &&
                    streaming.thinkingDurationMs > 0
                  ? formatThinkingDuration(streaming.thinkingDurationMs)
                  : '思考过程'}
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
        <div className="max-w-none overflow-hidden [&>div>*:first-child]:!mt-0">
          <MarkdownRenderer
            content={partialMarkdown}
            groupJid={groupJid}
            variant="chat"
            streaming
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
}

const EMPTY_AGENTS: AgentInfo[] = [];

export function StreamingDisplay({
  groupJid,
  isWaiting,
  senderName: senderNameProp = 'AI',
  agentId,
  agentAvatarUrl,
  agentAvatarEmoji,
  agentAvatarColor,
  interactionMode = 'assistant',
}: StreamingDisplayProps) {
  const mainStreaming = useChatStore((s) => s.streaming[groupJid]);
  const agentStreamingState = useChatStore((s) =>
    agentId ? s.agentStreaming[agentId] : undefined,
  );
  const runtimeAgentKind = useChatStore((s) =>
    agentId
      ? s.agents[groupJid]?.find((agent) => agent.id === agentId)?.kind
      : undefined,
  );
  const runtimeJid = agentId ? `${groupJid}#agent:${agentId}` : groupJid;
  const streaming = agentId ? agentStreamingState : mainStreaming;
  // Task agents — only shown in main conversation (not inside agent tabs)
  const allAgents = useChatStore((s) =>
    !agentId ? (s.agents[groupJid] ?? EMPTY_AGENTS) : EMPTY_AGENTS,
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
  const [thinkingExpanded, setThinkingExpanded] = useState(true);
  const thinkingRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);
  const prevIsThinkingRef = useRef(false);
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

  // Reset on group change
  useEffect(() => {
    setThinkingExpanded(true);
    userScrolledRef.current = false;
    userToggledThinkingRef.current = false;
    prevIsThinkingRef.current = false;
  }, [groupJid]);

  useEffect(() => {
    if (!streaming) {
      setThinkingExpanded(true);
      userScrolledRef.current = false;
      userToggledThinkingRef.current = false;
      prevIsThinkingRef.current = false;
    }
  }, [streaming]);

  // Auto-collapse the reasoning block on isThinking: true → false transition
  // so the streaming card height matches the post-streaming MessageBubble's
  // collapsed ReasoningBlock — eliminates the layout jump described in #493.
  // We respect an explicit user toggle: if the user manually expanded/collapsed
  // during this turn we don't override.
  useEffect(() => {
    const isThinking = streaming?.isThinking ?? false;
    const hasThinking = !!streaming?.thinkingText;
    if (
      prevIsThinkingRef.current &&
      !isThinking &&
      hasThinking &&
      !userToggledThinkingRef.current
    ) {
      setThinkingExpanded(false);
    }
    prevIsThinkingRef.current = isThinking;
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
      <RunStatus runtimeJid={runtimeJid} phase={describeRunPhase(streaming)} />
    ) : null;
  const identityRow = (
    <div className="mb-1.5 flex h-6 items-center gap-2">
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
        <div className="mb-1 flex h-6 items-center gap-1.5">
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
    </div>
  );
}
