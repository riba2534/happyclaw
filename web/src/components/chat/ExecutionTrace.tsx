import { memo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  ChevronUp,
  ListTree,
  ShieldAlert,
} from 'lucide-react';
import type { StreamingTraceEvent } from '../../stores/chat';

/**
 * Distinct top-level tool calls in a trace, for the collapsed
 * "已使用 N 个工具" summary.
 */
export function countTraceTools(traceEvents: StreamingTraceEvent[]): number {
  const ids = new Set<string>();
  for (const event of traceEvents) {
    if (
      (event.kind === 'tool' || event.kind === 'skill') &&
      !event.parentToolUseId &&
      event.toolUseId &&
      /^(?:工具|技能) /.test(event.title)
    ) {
      ids.add(event.toolUseId);
    }
  }
  return ids.size;
}

// The trace and permission panels take the event list rather than the whole
// streaming state, so they skip the re-renders caused by streamed text.
export const TracePanel = memo(function TracePanel({
  traceEvents,
  taskCount,
}: {
  traceEvents: StreamingTraceEvent[];
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
  const toolCount = countTraceTools(visibleTrace);

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
          {toolCount > 0 && `已使用 ${toolCount} 个工具 · `}
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
  item: StreamingTraceEvent;
  danger?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const hasDetail = !!item.detail && item.detail !== item.summary;
  const base = danger ? 'text-error' : 'text-foreground/80';
  return (
    <div className={`text-label ${base} break-words`}>
      {hasDetail ? (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex w-full cursor-pointer items-start gap-1 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          {open ? (
            <ChevronUp className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
          )}
          <TraceRowText item={item} />
        </button>
      ) : (
        <div className="flex items-start gap-1">
          <TraceRowText item={item} />
        </div>
      )}
      {hasDetail && open && (
        <div className="mt-0.5 ml-4 border-l-2 border-surface-border pl-2 text-caption break-all whitespace-pre-wrap text-muted-foreground">
          {item.detail}
        </div>
      )}
    </div>
  );
}

function TraceRowText({ item }: { item: StreamingTraceEvent }) {
  return (
    <span>
      <span className="font-medium">{item.title}</span>
      {item.summary && (
        <span className="text-muted-foreground"> — {item.summary}</span>
      )}
    </span>
  );
}

/** Prominent red banner listing denied tool calls — a denied permission is a
 *  real signal the user should see at a glance, not something buried in the
 *  collapsed trace panel. */
export const PermissionAlert = memo(function PermissionAlert({
  traceEvents,
}: {
  traceEvents: StreamingTraceEvent[];
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
