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
function parseToolParam(toolName: string, summary?: string): { label: string; value: string } | null {
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

export function ToolActivityCard({ tool, localElapsed }: ToolActivityCardProps) {
  const elapsed = tool.elapsedSeconds ?? localElapsed;
  const isNested = tool.isNested === true;
  const displayName = tool.toolName === 'Skill'
    ? (tool.skillName || 'unknown')
    : tool.toolName;

  const param = parseToolParam(tool.toolName, tool.toolInputSummary);
  const isBash = tool.toolName === 'Bash';

  return (
    <div className={`${isNested ? 'ml-4 border-l-2 border-brand-200 pl-2' : ''}`}>
      <div className="rounded-lg border border-brand-200 bg-brand-50/50 px-2.5 py-1.5 text-xs">
        {/* Header: tool name + elapsed */}
        <div className="flex items-center gap-1.5">
          <svg className="w-3 h-3 animate-spin text-primary flex-shrink-0" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span className="font-medium text-primary">{displayName}</span>
          <span className="flex-1" />
          {elapsed != null && (
            <span className="text-muted-foreground tabular-nums">{Math.round(elapsed)}s</span>
          )}
        </div>
        {/* Param line */}
        {param && (
          <div className={`mt-1 text-muted-foreground break-all max-h-16 overflow-y-auto ${isBash ? 'font-mono' : ''}`}>
            <span className="text-slate-400">{param.label}: </span>
            {param.value}
          </div>
        )}
      </div>
    </div>
  );
}
