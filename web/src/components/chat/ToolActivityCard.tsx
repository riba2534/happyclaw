import { memo } from 'react';
import { cn } from '@/lib/utils';
import { formatElapsedMs } from '../../utils/format-elapsed';
import { TOOL_STATE, ToolStateIcon, type ToolState } from './tool-status';

/**
 * ToolActivityCard — structured mini-card for tool calls: a running one
 * spins, a finished one keeps its row with a mark and how long it took.
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

export type ToolRowStatus = ToolState;

interface ToolActivityCardProps {
  tool: ToolInfo;
  localElapsed?: number;
}

/** `…/parent/leaf` for long paths so the interesting end stays visible. */
export function shortenPath(value: string): string {
  if (value.length <= 48 || !value.includes('/')) return value;
  const parts = value.split('/').filter(Boolean);
  return parts.length <= 2 ? value : `…/${parts.slice(-2).join('/')}`;
}

/** `bash -lc 'npm test'` → `npm test`. */
export function stripShellWrapper(value: string): string {
  const match =
    /^(?:\/(?:usr\/)?bin\/)?(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(
      value.trim(),
    );
  return match ? match[2] : value;
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
    case 'MultiEdit':
    case 'NotebookEdit':
    case 'Glob':
      return { label: 'path', value: shortenPath(summary) };
    case 'Bash':
      return { label: 'cmd', value: stripShellWrapper(summary) };
    case 'Grep':
      return { label: 'pattern', value: summary };
    case 'Agent':
      return { label: 'task', value: summary };
    default:
      return summary.length > 0 ? { label: 'input', value: summary } : null;
  }
}

/** Short verb for well-known tools; MCP tools read as `server.tool`. */
export function describeToolName(
  toolName: string,
  skillName?: string,
): { verb: string; hint?: string } {
  switch (toolName) {
    case 'Bash':
      return { verb: '运行', hint: 'Bash' };
    case 'Read':
      return { verb: '读取', hint: 'Read' };
    case 'Write':
      return { verb: '写入', hint: 'Write' };
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { verb: '编辑', hint: toolName };
    case 'Glob':
      return { verb: '查找文件', hint: 'Glob' };
    case 'Grep':
      return { verb: '搜索', hint: 'Grep' };
    case 'WebSearch':
      return { verb: '搜索网页', hint: 'WebSearch' };
    case 'WebFetch':
      return { verb: '读取网页', hint: 'WebFetch' };
    case 'TodoWrite':
      return { verb: '更新计划', hint: 'TodoWrite' };
    case 'Task':
    case 'Agent':
      return { verb: '子 Agent', hint: toolName };
    case 'Skill':
      return { verb: skillName || 'unknown', hint: 'Skill' };
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
      if (mcp) return { verb: `${mcp[1]}.${mcp[2]}`, hint: toolName };
      return { verb: toolName };
    }
  }
}

/** A call in a few words: its verb and, if it was given one, its parameter. */
export function describeToolCall(
  toolName: string,
  summary?: string,
  skillName?: string,
): { verb: string; param?: string } {
  const { verb } = describeToolName(toolName, skillName);
  return { verb, param: parseToolParam(toolName, summary)?.value };
}

/** Phrase for the status line while a tool of this kind is running. */
export function describeToolActivity(toolName: string): string {
  switch (toolName) {
    case 'Bash':
      return '正在运行命令';
    case 'Read':
      return '正在读取文件';
    case 'Glob':
      return '正在查找文件';
    case 'Grep':
      return '正在搜索代码';
    case 'WebSearch':
    case 'WebFetch':
      return '正在查阅网页';
    case 'Write':
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return '正在修改文件';
    case 'Task':
    case 'Agent':
      return '正在等待子 Agent';
    case 'Skill':
      return '正在使用技能';
    case 'TodoWrite':
      return '正在更新计划';
    case 'AskUserQuestion':
      return '等待你的回答';
    default:
      return '正在调用工具';
  }
}

export interface ToolRowProps {
  toolName: string;
  skillName?: string;
  /** What the call was given: a path, a command, a pattern. */
  summary?: string;
  status?: ToolRowStatus;
  nested?: boolean;
  /** A running call's time so far. */
  elapsedSeconds?: number;
  /** A finished call's time. */
  durationMs?: number;
  /** The start of what the call returned; a failed call always shows it. */
  resultPreview?: string;
  /** Show the result of a call that did not fail too. */
  showResult?: boolean;
}

/** One tool call as a row: mark · tool · parameter · time. */
export const ToolRow = memo(function ToolRow({
  toolName,
  skillName,
  summary,
  status = 'running',
  nested = false,
  elapsedSeconds,
  durationMs,
  resultPreview,
  showResult = false,
}: ToolRowProps) {
  const { verb, hint } = describeToolName(toolName, skillName);
  const param = parseToolParam(toolName, summary);
  const isBash = toolName === 'Bash';
  const running = status === 'running' || status === 'background';
  const failed = !running && !TOOL_STATE[status].quiet;
  const time = running
    ? elapsedSeconds != null
      ? `${Math.round(elapsedSeconds)}s`
      : undefined
    : durationMs != null
      ? formatElapsedMs(durationMs)
      : undefined;
  const result = resultPreview && (failed || showResult) ? resultPreview : '';

  // Codex-style activity row: mark · tool name · parameter · time.
  return (
    <div className={nested ? 'ml-3 border-l border-surface-border pl-2.5' : ''}>
      <div className="flex min-h-7 items-center gap-2 rounded-md px-1 py-1 font-sans text-label">
        <ToolStateIcon state={status} />
        <span
          className={cn(
            'shrink-0 font-medium',
            running || failed ? 'text-foreground' : 'text-muted-foreground',
          )}
          title={hint}
        >
          {verb}
        </span>
        {param && (
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-muted-foreground',
              isBash && 'font-mono text-caption leading-5',
              !running && !failed && 'text-faint-foreground',
            )}
            title={summary}
          >
            {param.value}
          </span>
        )}
        {!param && <span className="flex-1" />}
        {time && (
          <span className="shrink-0 text-caption text-faint-foreground tabular-nums">
            {time}
          </span>
        )}
        <span className="sr-only">，{TOOL_STATE[status].label}</span>
      </div>
      {result && (
        <p
          className={cn(
            'mb-1 ml-6 line-clamp-2 text-caption break-words',
            failed ? TOOL_STATE[status].tone : 'text-muted-foreground',
          )}
        >
          {result}
        </p>
      )}
    </div>
  );
});

export const ToolActivityCard = memo(function ToolActivityCard({
  tool,
  localElapsed,
}: ToolActivityCardProps) {
  return (
    <ToolRow
      toolName={tool.toolName}
      skillName={tool.skillName}
      summary={tool.toolInputSummary}
      nested={tool.isNested === true}
      elapsedSeconds={tool.elapsedSeconds ?? localElapsed}
    />
  );
});
