import { memo } from 'react';
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

export const ToolActivityCard = memo(function ToolActivityCard({
  tool,
  localElapsed,
}: ToolActivityCardProps) {
  const elapsed = tool.elapsedSeconds ?? localElapsed;
  const isNested = tool.isNested === true;
  const { verb, hint } = describeToolName(tool.toolName, tool.skillName);

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
        <span className="shrink-0 font-medium text-foreground" title={hint}>
          {verb}
        </span>
        {param && (
          <span
            className={`min-w-0 flex-1 truncate text-muted-foreground ${isBash ? 'font-mono text-caption leading-5' : ''}`}
            title={tool.toolInputSummary}
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
});
