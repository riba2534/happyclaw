import { memo, useId, useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { StreamingTaskRuntimeState } from '../../stores/chat';
import { markdownTail } from '../../lib/markdown-blocks';
import { useThrottledValue } from '../../hooks/useThrottledValue';
import { STREAMING_MARKDOWN_INTERVAL_MS } from '../../lib/streaming-interval';
import { MarkdownRenderer } from './MarkdownRenderer';
import { ThinkingBody } from './ThinkingBlock';
import { ToolRow } from './ToolActivityCard';
import { TOOL_STATE, ToolStateIcon, taskStatusState } from './tool-status';

/** Sub-agent progress panels preview only the end of their streamed text. */
const PROGRESS_TAIL_CHARS = 2000;

/** A sub-agent with nothing to show under its title has nothing to open. */
export function subAgentHasBody(task: StreamingTaskRuntimeState): boolean {
  return (
    task.activeTools.length > 0 ||
    task.recentTools.length > 0 ||
    !!task.thinkingTail ||
    !!task.textTail
  );
}

/** What a sub-agent shows when opened: its tools, and the tail of its words. */
export function SubAgentBody({
  task,
  groupJid,
  inline = false,
}: {
  task: StreamingTaskRuntimeState;
  groupJid: string;
  /** Inside a row of the process timeline, which has the line on its left. */
  inline?: boolean;
}) {
  const isRunning = task.status === 'running' || task.status === 'backgrounded';
  const textTailMarkdown = useThrottledValue(
    markdownTail(task.textTail, PROGRESS_TAIL_CHARS),
    STREAMING_MARKDOWN_INTERVAL_MS,
  );
  return (
    <>
      {task.activeTools.length > 0 && (
        <div className="space-y-1.5">
          {task.activeTools.map((tool) => (
            <ToolRow
              key={tool.toolUseId}
              toolName={tool.toolName}
              skillName={tool.skillName}
              summary={tool.toolInputSummary}
              elapsedSeconds={tool.elapsedSeconds}
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
        <ThinkingBody
          text={task.thinkingTail}
          live={isRunning}
          groupJid={groupJid}
          variant={inline ? 'row' : 'block'}
          maxHeightClass="max-h-32"
          className="mt-0 mb-0"
        />
      )}
      {task.textTail && (
        <div className="max-w-none overflow-hidden [&>div>*:first-child]:!mt-0">
          {/* Only the tail of the sub-agent's words, always streaming: a
              table here may be cut off, and its tools would never become
              usable. */}
          <MarkdownRenderer
            content={textTailMarkdown}
            groupJid={groupJid}
            variant="docs"
            streaming
            tableTools={false}
          />
        </div>
      )}
    </>
  );
}

/**
 * One sub-agent (an SDK Task) as a collapsible card. Its title row carries what
 * it is doing now, the latest progress summary, so a collapsed card still says
 * how it is going; the body has its own tools and the tail of its text.
 */
export const SubAgentCard = memo(function SubAgentCard({
  task,
  groupJid,
  defaultExpanded,
}: {
  task: StreamingTaskRuntimeState;
  groupJid: string;
  /** Start open (a running one does by default). */
  defaultExpanded?: boolean;
}) {
  const [expanded, setExpanded] = useState(
    defaultExpanded ?? task.status === 'running',
  );
  const bodyId = useId();
  const state = taskStatusState(task.status);

  // A card with nothing under its title (no tool yet, none of its text shown)
  // has nothing to open: its title row is a plain row, not a button.
  const hasBody = subAgentHasBody(task);
  const titleRow = (
    <>
      <ToolStateIcon state={state} />
      <span className="min-w-0 max-w-full truncate text-label font-medium text-foreground sm:max-w-[45%]">
        <span className="sr-only">子 Agent：</span>
        {task.title}
      </span>
      {task.subagentType && (
        <span className="shrink-0 text-caption text-faint-foreground">
          {task.subagentType}
        </span>
      )}
      {task.latestSummary && (
        <span className="order-last min-w-0 basis-full truncate text-caption text-muted-foreground sm:order-none sm:basis-auto sm:flex-1">
          {task.lastToolName && (
            <span className="text-faint-foreground">
              {task.lastToolName} ·{' '}
            </span>
          )}
          {task.latestSummary}
        </span>
      )}
      <span className="ml-auto shrink-0 text-caption text-muted-foreground">
        {TOOL_STATE[state].label}
      </span>
      {hasBody &&
        (expanded ? (
          <ChevronUp
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        ) : (
          <ChevronDown
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
        ))}
    </>
  );
  const titleRowClass =
    'flex min-h-9 w-full flex-wrap items-center gap-x-2 gap-y-0.5 px-3 py-1.5 text-left pointer-coarse:min-h-11';

  return (
    <div className="overflow-hidden rounded-lg bg-surface-raised font-sans ring-1 ring-surface-border [--md-table-bg:var(--surface-raised)]">
      {hasBody ? (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          aria-expanded={expanded}
          aria-controls={expanded ? bodyId : undefined}
          className={`${titleRowClass} cursor-pointer transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none focus-visible:ring-inset`}
        >
          {titleRow}
        </button>
      ) : (
        <div className={titleRowClass}>{titleRow}</div>
      )}
      {hasBody && expanded && (
        <div
          id={bodyId}
          className="space-y-2 border-t border-surface-border px-3 py-2"
        >
          <SubAgentBody task={task} groupJid={groupJid} />
        </div>
      )}
    </div>
  );
});
