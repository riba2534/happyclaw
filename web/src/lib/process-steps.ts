/**
 * What the process card says about the steps of a reply, as pure functions
 * over `StreamingStep[]`: which steps it lists, which tool calls it merges into
 * one row, how long it all took and the one-line summary of a finished run.
 * The shared reducer (`stream-steps`) owns the steps themselves.
 */
import { describeToolCall } from '../components/chat/ToolActivityCard';
import {
  countToolStates,
  describeProblems,
} from '../components/chat/tool-status';
import { SPEECH_TOOL_NAME, isProgressStep } from './process-visibility';
import { formatRunElapsed } from './run-phase';
import {
  TIMELINE_ROWS,
  railSteps,
  summarizeSteps,
  type StreamingStep,
} from './stream-steps';

// ── tools ───────────────────────────────────────────────────────────────

export type ToolCategory = 'terminal' | 'file' | 'search' | 'web' | 'generic';

const TERMINAL_TOOLS: ReadonlySet<string> = new Set([
  'Bash',
  'BashOutput',
  'KillShell',
  'KillBash',
]);
const FILE_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'NotebookRead',
  'LS',
]);
const SEARCH_TOOLS: ReadonlySet<string> = new Set(['Grep', 'Glob']);
const WEB_TOOLS: ReadonlySet<string> = new Set(['WebSearch', 'WebFetch']);

/** What kind of thing a tool works on, for the icon of its row. */
export function toolCategory(toolName: string | undefined): ToolCategory {
  if (!toolName) return 'generic';
  if (TERMINAL_TOOLS.has(toolName)) return 'terminal';
  if (FILE_TOOLS.has(toolName)) return 'file';
  if (SEARCH_TOOLS.has(toolName)) return 'search';
  if (WEB_TOOLS.has(toolName)) return 'web';
  return 'generic';
}

/**
 * Local read-only tools: a run of them in a row is one line in the timeline
 * ("browsed 5 files, searched twice"). Anything that can change a file or run
 * a command, and any tool this list does not know, keeps its own row.
 */
const BROWSE_TOOLS: ReadonlySet<string> = new Set([
  'Read',
  'LS',
  'NotebookRead',
]);
const LOOKUP_TOOLS: ReadonlySet<string> = new Set(['Grep', 'Glob']);

export function isReadOnlyStep(step: StreamingStep): boolean {
  const name = step.toolName;
  return (
    step.kind === 'tool' &&
    !!name &&
    (BROWSE_TOOLS.has(name) || LOOKUP_TOOLS.has(name))
  );
}

/** The step is a question put to the reader: the card shows it, not a row. */
export function isQuestionStep(step: StreamingStep): boolean {
  return step.kind === 'tool' && step.toolName === 'AskUserQuestion';
}

/**
 * What a finished call returned, if there is something to read: the start of
 * its output. A call still running has none, and neither has the speech tool
 * (calling it is the reply, not work) or a workspace that withholds results.
 */
export function toolOutput(step: StreamingStep): string | undefined {
  if (step.kind !== 'tool' || step.status === 'running') return undefined;
  if (step.toolName === SPEECH_TOOL_NAME || isQuestionStep(step)) {
    return undefined;
  }
  const output = withoutExitCodeLine(step, step.resultPreview?.trimEnd());
  return output?.trim() ? output : undefined;
}

const EXIT_CODE_LINE = /^\s*exit code:?\s*(\d+)\s*$/i;

/**
 * The Bash tool starts the output of a failed command with "Exit code 3". When
 * the facts already carry that code the row says it ("退出码 3"), and the same
 * line in the output would only repeat it. Only a line that says the same code.
 */
function withoutExitCodeLine(
  step: StreamingStep,
  output: string | undefined,
): string | undefined {
  const code = step.resultFacts?.exitCode;
  if (!output || typeof code !== 'number') return output;
  const lines = output.split('\n');
  const first = lines.findIndex((line) => line.trim() !== '');
  if (first < 0) return output;
  const match = EXIT_CODE_LINE.exec(lines[first]);
  if (!match || Number(match[1]) !== Math.round(code)) return output;
  return lines.slice(first + 1).join('\n');
}

/** A failed call shows why it failed without being asked to; a good one does not. */
export function toolOpensByDefault(step: StreamingStep): boolean {
  return step.status === 'error' && toolOutput(step) !== undefined;
}

/** The first line of an output that has any text: what the row can say of it. */
export function firstOutputLine(output: string): string {
  return (
    output
      .split('\n')
      .find((line) => line.trim() !== '')
      ?.trim() ?? ''
  );
}

export type ProcessItem =
  | { type: 'step'; step: StreamingStep }
  | { type: 'group'; id: string; steps: StreamingStep[] };

/**
 * The steps as rows: two or more read-only calls in a row become one group.
 * A single one stays a row of its own, and anything else between two of them
 * (reasoning, a command, a note) ends the run.
 */
export function groupProcessSteps(
  steps: readonly StreamingStep[],
): ProcessItem[] {
  const items: ProcessItem[] = [];
  let run: StreamingStep[] = [];
  const flush = () => {
    if (run.length === 1) items.push({ type: 'step', step: run[0] });
    else if (run.length > 1) {
      // Named by its first call, so a group keeps its identity as it grows.
      items.push({ type: 'group', id: `group-${run[0].id}`, steps: run });
    }
    run = [];
  };
  for (const step of steps) {
    if (isReadOnlyStep(step)) {
      run.push(step);
      continue;
    }
    flush();
    items.push({ type: 'step', step });
  }
  flush();
  return items;
}

/** Rows a settled card lists before the older ones fold into one line. */
export const SETTLED_TIMELINE_ROWS = 30;

/** Rows a process card at work lists, after cindy: the latest five. */
export const LIVE_TIMELINE_ROWS = 5;

export interface ProcessView {
  /** Items folded out of sight, oldest first. */
  folded: ProcessItem[];
  /** The latest items, oldest first. */
  rows: ProcessItem[];
}

/**
 * The rows of the timeline: the steps are grouped as a whole and only then cut
 * to the latest `maxRows`, so a group keeps its identity (its first call's) and
 * its place however many calls join it, and what has been opened stays open.
 */
export function buildProcessView(
  steps: readonly StreamingStep[],
  maxRows: number = TIMELINE_ROWS,
): ProcessView {
  const items = groupProcessSteps(summarizedSteps(steps));
  const cut = Math.max(0, items.length - maxRows);
  return { folded: items.slice(0, cut), rows: items.slice(cut) };
}

/** The steps of some items, in order. */
export function itemSteps(items: readonly ProcessItem[]): StreamingStep[] {
  return items.flatMap((item) =>
    item.type === 'group' ? item.steps : [item.step],
  );
}

export interface GroupSummary {
  /** Files and folders looked at. */
  files: number;
  /** Searches made (by content or by name). */
  searches: number;
  running: number;
  failed: number;
}

export function summarizeGroup(steps: readonly StreamingStep[]): GroupSummary {
  const summary: GroupSummary = {
    files: 0,
    searches: 0,
    running: 0,
    failed: 0,
  };
  for (const step of steps) {
    if (step.toolName && BROWSE_TOOLS.has(step.toolName)) summary.files += 1;
    else summary.searches += 1;
    if (step.status === 'running') summary.running += 1;
    if (step.status === 'error') summary.failed += 1;
  }
  return summary;
}

/** "已浏览 4 个文件 · 搜索 2 次": what a group of read-only calls did. */
export function describeGroup(summary: GroupSummary): string {
  const lead = summary.running > 0 ? '正在' : '已';
  const parts: string[] = [];
  if (summary.files > 0) parts.push(`${lead}浏览 ${summary.files} 个文件`);
  if (summary.searches > 0) {
    parts.push(
      summary.files > 0
        ? `搜索 ${summary.searches} 次`
        : `${lead}搜索 ${summary.searches} 次`,
    );
  }
  return parts.join(' · ');
}

// ── time ────────────────────────────────────────────────────────────────

/** How long a step took, if it says. */
export function stepDurationMs(step: StreamingStep): number | undefined {
  if (step.durationMs != null) return step.durationMs;
  return step.endedAt != null ? Math.max(0, step.endedAt - step.at) : undefined;
}

/**
 * The wall-clock span of the steps: from the first one's start to the last
 * one's end. `undefined` while one is still running or when they carry no
 * times; the caller then falls back on a total it knows from elsewhere.
 */
export function processSpanMs(
  steps: readonly StreamingStep[],
  fallbackMs?: number,
): number | undefined {
  const fallback =
    fallbackMs != null && Number.isFinite(fallbackMs) && fallbackMs > 0
      ? fallbackMs
      : undefined;
  if (steps.length === 0) return fallback;
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const step of steps) {
    if (step.status === 'running') return fallback;
    start = Math.min(start, step.at);
    end = Math.max(end, step.endedAt ?? step.at + (step.durationMs ?? 0));
  }
  const span = end - start;
  return Number.isFinite(span) && span > 0 ? span : fallback;
}

/**
 * "3.2 秒", "14 秒", "1 分 12 秒"; nothing for under a second. From ten seconds
 * on the span is rounded to the whole second before it is cut into minutes, so
 * 59.6 seconds is "1 分", never "60 秒".
 */
export function formatSpanZh(ms: number | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 1000) return '';
  const seconds = ms / 1000;
  if (seconds < 10) return `${Math.round(seconds * 10) / 10} 秒`;
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole} 秒`;
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return rest === 0 ? `${minutes} 分` : `${minutes} 分 ${rest} 秒`;
}

// ── what the card lists ─────────────────────────────────────────────────

/**
 * The steps the reader is meant to see: the commentary only when asked for,
 * the progress statements the Agent sent always.
 */
export function visibleSteps(
  steps: readonly StreamingStep[],
  commentary: boolean,
): StreamingStep[] {
  return commentary
    ? [...steps]
    : steps.filter((step) => step.kind !== 'text' || isProgressStep(step));
}

/** The steps the timeline lists, and a finished run is summed up from. */
export function summarizedSteps(
  steps: readonly StreamingStep[],
): StreamingStep[] {
  return railSteps(steps).filter((step) => !isQuestionStep(step));
}

/**
 * There is something to list of these steps. A question put to the reader is
 * a card of its own, not a row: steps of nothing else have no timeline.
 */
export function hasListedSteps(steps: readonly StreamingStep[]): boolean {
  return summarizedSteps(steps).length > 0;
}

// ── the summary of a reply's process ────────────────────────────────────

/**
 * "已工作 14s": the one line a folded process card says, the live card's once
 * its answer is being written and the finished reply's alike (cindy's "Worked
 * for"). The span of the listed steps, or the total given when they carry no
 * times; "已工作" when neither says.
 */
export function describeWork(
  steps: readonly StreamingStep[],
  durationMs?: number,
): string {
  const span = processSpanMs(summarizedSteps(steps), durationMs);
  return span == null
    ? '已工作'
    : `已工作 ${formatRunElapsed(Math.max(1, Math.round(span / 1000)))}`;
}

/**
 * "2 个工具 · 2 段思考 · 1 个失败": what an opened process holds, said at its
 * head now that its header only says how long it took. A sub-agent counts as a
 * tool; the steps dropped at the cap are not counted, and said to be.
 */
export function describeWorkCounts(
  steps: readonly StreamingStep[],
  dropped = 0,
): string {
  const listed = summarizedSteps(steps);
  const counts = summarizeSteps(listed);
  const tools = counts.tools + counts.tasks;
  const parts: string[] = [];
  if (tools > 0) parts.push(`${tools} 个工具`);
  if (counts.thinking > 0) parts.push(`${counts.thinking} 段思考`);
  if (parts.length === 0 && counts.commentary > 0) {
    const progress = listed.filter(isProgressStep).length;
    if (progress > 0) parts.push(`${progress} 条进展`);
    if (counts.commentary > progress) {
      parts.push(`${counts.commentary - progress} 条过程说明`);
    }
  }
  parts.push(...describeProblems(countToolStates(listed, false)));
  if (dropped > 0) parts.push(`另有较早 ${dropped} 步`);
  return parts.join(' · ');
}

// ── what a call was given ───────────────────────────────────────────────

const SUMMARY_KEYS =
  'command|query|path|file_path|notebook_path|pattern|prompt|url|name';
const KEYED_SUMMARY = new RegExp(`^(?:${SUMMARY_KEYS}): ([\\s\\S]+)$`);
const JSON_SUMMARY = new RegExp(
  `^\\{\\s*"(?:${SUMMARY_KEYS})"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`,
);

/**
 * What a call was given, without the label the runner put in front of it:
 * "command: npm test" is `npm test`, `{"file_path":"/a/b.ts"}` is `/a/b.ts`.
 */
export function cleanToolSummary(
  summary: string | undefined,
): string | undefined {
  const text = summary?.trim();
  if (!text) return undefined;
  const keyed = KEYED_SUMMARY.exec(text);
  if (keyed) return keyed[1];
  const json = JSON_SUMMARY.exec(text);
  if (json) {
    try {
      return JSON.parse(`"${json[1]}"`) as string;
    } catch {
      // A summary cut short in the middle of an escape.
      return json[1];
    }
  }
  return text;
}

/** A call in a few words: its verb and, if it was given one, its object. */
export function describeStepCall(step: StreamingStep): {
  verb: string;
  param?: string;
} {
  return describeToolCall(
    step.toolName ?? 'unknown',
    cleanToolSummary(step.summary),
    step.skillName,
  );
}
