import { Loader2 } from 'lucide-react';

/**
 * ToolActivityCard — structured mini-card for active tool calls.
 * Replaces the tiny pill rendering in StreamingDisplay for better readability.
 */

interface ToolInfo {
  toolName: string;
  toolUseId: string;
  startTime: number;
  elapsedSeconds?: number;
  parentToolUseId?: string | null;
  isNested?: boolean;
  skillName?: string;
  toolInputSummary?: string;
  toolInput?: Record<string, unknown>;
}

interface ToolActivityCardProps {
  tool: ToolInfo;
  localElapsed?: number;
}

/** Extract the most relevant param from toolInputSummary for structured display. */
function parseToolParam(
  toolName: string,
  summary?: string,
): { label: string; value: string } | null {
  if (!summary) return null;

  switch (toolName) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'Glob':
      return { label: 'path', value: summary };
    case 'Bash':
      return { label: 'cmd', value: summary };
    case 'Grep':
      return { label: 'pattern', value: summary };
    case 'Agent':
      return { label: 'task', value: summary };
    default:
      return summary.length > 0 ? { label: 'input', value: summary } : null;
  }
}

export function ToolActivityCard({
  tool,
  localElapsed,
}: ToolActivityCardProps) {
  const elapsed = tool.elapsedSeconds ?? localElapsed;
  const isNested = tool.isNested === true;
  const displayName =
    tool.toolName === 'Skill' ? tool.skillName || 'unknown' : tool.toolName;

  const param = parseToolParam(tool.toolName, tool.toolInputSummary);
  const isBash = tool.toolName === 'Bash';

  // Codex-style activity row: spinner · tool name · parameter · elapsed.
  return (
    <div
      className={isNested ? 'ml-3 border-l border-surface-border pl-2.5' : ''}
    >
      <div className="flex min-h-7 items-center gap-2 rounded-md px-1 py-1 font-sans text-label">
        <Loader2
          aria-hidden="true"
          className="size-3.5 shrink-0 animate-spin text-muted-foreground"
        />
        <span className="shrink-0 font-medium text-foreground">
          {displayName}
        </span>
        {param && (
          <span
            className={`min-w-0 flex-1 truncate text-muted-foreground ${isBash ? 'font-mono text-caption leading-5' : ''}`}
            title={`${param.label}: ${param.value}`}
          >
            {param.value}
          </span>
        )}
        {!param && <span className="flex-1" />}
        {elapsed != null && (
          <span className="shrink-0 text-caption text-faint-foreground tabular-nums">
            {Math.round(elapsed)}s
          </span>
        )}
      </div>
    </div>
  );
}
