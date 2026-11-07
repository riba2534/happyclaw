/**
 * Canonical source. Build step copies this file to:
 *   - src/stream-steps.ts
 *   - web/src/lib/stream-steps.ts
 *
 * DO NOT edit the copies directly -- edit this file and run `make sync-types`.
 */

/**
 * The steps of one streamed reply in the order they happened: the reasoning
 * bursts, the tool calls, the sub-agents and the model's own commentary. The
 * streaming state keeps its older fields (one reasoning text, the active
 * tools, the task map) for the classic layout; the step timeline reads this
 * list. Everything here is a pure function over a `StepList`, so the reducer
 * stays a thin shell around it and the rules are testable on their own.
 */
import {
  MAX_STEP_THINKING_TEXT,
  capThinkingText,
  extractThinkingTitle,
} from './thinking-text.js';

/**
 * What a tool did, as numbers and flags, read by the Runner from the SDK's
 * structured `tool_use_result`. Never a path, file content or model text, so a
 * UI can show "+12 −3" or "读取 120 行" without carrying the result itself.
 * Every field is optional: a tool fills what it knows. Declared identically in
 * shared/stream-event.ts and shared/stream-steps.ts (tests keep them equal).
 */
export interface ToolResultFacts {
  /** Lines an edit or write added / removed. */
  added?: number;
  removed?: number;
  /** A Write created the file (rather than updating it). */
  created?: boolean;
  /** Read: lines returned, and the file's total. */
  lines?: number;
  totalLines?: number;
  /** Glob / Grep: files and matches found. */
  files?: number;
  matches?: number;
  /** A failed command's exit code (parsed from `Exit code N`). */
  exitCode?: number;
  /** WebFetch: HTTP status and bytes received. */
  httpCode?: number;
  bytes?: number;
  /** WebSearch: searches made. */
  searches?: number;
  /** Duration the tool itself reported. */
  durationMs?: number;
  /** A sub-agent's totals, from the Task / Agent tool's result. */
  agent?: {
    toolUses?: number;
    reads?: number;
    searches?: number;
    edits?: number;
    commands?: number;
    added?: number;
    removed?: number;
    tokens?: number;
    durationMs?: number;
  };
}

export type StepKind = 'thinking' | 'tool' | 'task' | 'text';
export type StepStatus = 'running' | 'done' | 'error';

export interface StreamingStep {
  id: string;
  kind: StepKind;
  /** Wall-clock ms the step began. */
  at: number;
  endedAt?: number;
  status: StepStatus;
  /** thinking: this burst's text. text: the commentary, once it is closed. */
  text?: string;
  /** thinking: the summary title found in the text. task: what it was asked. */
  title?: string;
  /** thinking: the model's own timing (else `endedAt - at`). */
  durationMs?: number;
  toolUseId?: string;
  toolName?: string;
  skillName?: string;
  /** tool: what the call was given. task: the latest progress summary. */
  summary?: string;
  /** tool: the start of what it returned (newlines kept, bounded). */
  resultPreview?: string;
  /** tool: what it did, as numbers; absent when the Runner did not send any. */
  resultFacts?: ToolResultFacts;
  /** task: key into the streaming state's `taskStates`. */
  taskId?: string;
  /** text: where it starts in the reply's whole text (see `partialBase`). */
  from?: number;
  /**
   * text: narration the host handed over whole, because a tool call followed
   * it (a proactive workspace). It is never the answer, whatever follows.
   */
  commentary?: boolean;
  /**
   * text (commentary): a progress statement the Agent sent the user
   * (send_message with delivery_role=progress). Shown at every process
   * visibility, unlike narration.
   */
  progress?: boolean;
  /**
   * tool (AskUserQuestion): the questions it put to the reader. The call
   * returns at once (the answer is the reader's next message), so they are
   * kept on the step for the reader to answer after the turn.
   */
  questions?: StepQuestion[];
  /**
   * tool, task (status `error`): why it ended without a result of its own. A
   * stop caught it in flight, or a permission denial refused it; absent for a
   * call that failed by itself (and in steps stored before it was kept).
   */
  outcome?: StepOutcome;
}

export type StepOutcome = 'stopped' | 'denied';

/**
 * What a call a stop caught in flight says it returned, and the word every
 * view uses for a stopped call. Steps stored before `outcome` was kept are
 * recognised by it.
 */
export const STOPPED_PREVIEW = '已停止';

/** One question of an AskUserQuestion call, as the reader answers it. */
export interface StepQuestion {
  question: string;
  multiSelect?: boolean;
  /** The option labels, in order. */
  options: string[];
  /**
   * What each option means, by the index of its label; absent when no option
   * has one (and in steps stored before it was kept).
   */
  descriptions?: string[];
}

/** The tool whose call is a question for the reader. */
export const QUESTION_TOOL_NAME = 'AskUserQuestion';
/**
 * The start of the Runner's answer to every AskUserQuestion call: the reader
 * answers in their next message. A question answered with any other failure
 * (input that failed validation) asked nothing.
 */
export const QUESTION_DEFERRED_MARK =
  'The question was not answered inside this turn.';
/** AskUserQuestion allows four questions; streamed input is not yet checked. */
const MAX_STEP_QUESTIONS = 4;
const MAX_QUESTION_OPTIONS = 10;
const MAX_QUESTION_CHARS = 300;
const MAX_OPTION_CHARS = 120;
const MAX_OPTION_DESCRIPTION_CHARS = 200;

function boundedText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  const points = Array.from(text);
  return points.length > max ? `${points.slice(0, max - 1).join('')}…` : text;
}

/**
 * The questions in an AskUserQuestion input (`{questions: [...]}`, or the
 * older single `{question, options}`), bounded; undefined when it has none.
 * Options are `{label, description?}` or `{value}` objects, or plain strings
 * (a stored step's, with `descriptions` beside them).
 */
export function readStepQuestions(input: unknown): StepQuestion[] | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const record = input as Record<string, unknown>;
  const raw = Array.isArray(record.questions)
    ? record.questions
    : typeof record.question === 'string'
      ? [record]
      : [];
  const questions: StepQuestion[] = [];
  for (const item of raw.slice(0, MAX_STEP_QUESTIONS)) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const question = boundedText(entry.question, MAX_QUESTION_CHARS);
    if (!question) continue;
    const options: string[] = [];
    const descriptions: string[] = [];
    // A stored step keeps the descriptions beside the labels, by index.
    const stored = Array.isArray(entry.descriptions) ? entry.descriptions : [];
    const rawOptions = Array.isArray(entry.options) ? entry.options : [];
    rawOptions.forEach((option, index) => {
      if (options.length >= MAX_QUESTION_OPTIONS) return;
      const fields: Record<string, unknown> =
        option && typeof option === 'object'
          ? (option as Record<string, unknown>)
          : { label: option, description: stored[index] };
      const label =
        boundedText(fields.label, MAX_OPTION_CHARS) ||
        boundedText(fields.value, MAX_OPTION_CHARS);
      if (!label) return;
      options.push(label);
      descriptions.push(
        boundedText(fields.description, MAX_OPTION_DESCRIPTION_CHARS),
      );
    });
    questions.push({
      question,
      ...(entry.multiSelect === true ? { multiSelect: true } : {}),
      options,
      ...(descriptions.some(Boolean) ? { descriptions } : {}),
    });
  }
  return questions.length > 0 ? questions : undefined;
}

function sameQuestions(
  a: readonly StepQuestion[] | undefined,
  b: readonly StepQuestion[],
): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b);
}

export interface StepList {
  steps: StreamingStep[];
  /** Steps dropped from the front once the cap was reached. */
  dropped: number;
}

/** A reply keeps this many steps; the oldest finished ones go first. */
export const MAX_STEPS = 100;
/** The commentary kept for a closed text step. */
const MAX_TEXT_STEP_CHARS = 2000;
const MAX_RESULT_PREVIEW_CHARS = 400;

/** Tools that run as a sub-agent: shown as a task, not as a tool row. */
export const TASK_TOOL_NAMES: ReadonlySet<string> = new Set(['Task', 'Agent']);

export function stepList(
  steps: StreamingStep[] | undefined,
  dropped: number | undefined,
): StepList {
  return { steps: steps ?? [], dropped: dropped ?? 0 };
}

/**
 * An id for the next step of its kind. Steps can leave the list other than from
 * the front (narration is filtered out when the level is lowered), so the
 * length alone can name a step that is still there.
 */
function nextId(list: StepList, prefix: string): string {
  let n = list.dropped + list.steps.length;
  while (list.steps.some((step) => step.id === `${prefix}-${n}`)) n += 1;
  return `${prefix}-${n}`;
}

function append(list: StepList, step: StreamingStep): StepList {
  const steps = [...list.steps, step];
  let dropped = list.dropped;
  while (steps.length > MAX_STEPS) {
    const index = steps.findIndex((item) => item.status !== 'running');
    if (index < 0) break;
    steps.splice(index, 1);
    dropped += 1;
  }
  return { steps, dropped };
}

function replaceAt(
  list: StepList,
  index: number,
  patch: Partial<StreamingStep>,
): StepList {
  const steps = list.steps.slice();
  steps[index] = { ...steps[index], ...patch };
  return { steps, dropped: list.dropped };
}

function last(list: StepList): StreamingStep | undefined {
  return list.steps[list.steps.length - 1];
}

function findIndexBy(
  list: StepList,
  match: (step: StreamingStep) => boolean,
): number {
  for (let index = list.steps.length - 1; index >= 0; index -= 1) {
    if (match(list.steps[index])) return index;
  }
  return -1;
}

function tail(text: string, max: number): string {
  return text.length > max ? `…${text.slice(-(max - 1))}` : text;
}

function head(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A tool's output as a preview: its start, newlines kept, runs of space folded. */
function previewOf(text: string): string {
  return head(
    text
      .replace(/[ \t]+/g, ' ')
      .replace(/ ?\n ?/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    MAX_RESULT_PREVIEW_CHARS,
  );
}

// ── thinking ────────────────────────────────────────────────────────────

/** The reasoning began: a thinking step is running at the end of the list. */
export function openThinkingStep(list: StepList, at: number): StepList {
  const current = last(list);
  if (current?.kind === 'thinking' && current.status === 'running') return list;
  return append(list, {
    id: nextId(list, 'thinking'),
    kind: 'thinking',
    at,
    status: 'running',
    text: '',
  });
}

/** Add reasoning text to the running thinking step (opening one if needed). */
export function appendThinkingText(
  list: StepList,
  delta: string,
  at: number,
): StepList {
  const opened = openThinkingStep(list, at);
  const index = opened.steps.length - 1;
  const step = opened.steps[index];
  const text = capThinkingText(
    (step.text ?? '') + delta,
    MAX_STEP_THINKING_TEXT,
  );
  return replaceAt(opened, index, {
    text,
    title: extractThinkingTitle(text) ?? step.title,
  });
}

/**
 * The reasoning ended. `durationMs` is the model's own timing, when it gave
 * one; the step lasted at least as long as the clock says, because it starts
 * with the request, and reasoning that returns no text arrives whole after the
 * wait with a timing of a few milliseconds.
 */
export function closeThinkingStep(
  list: StepList,
  at: number,
  durationMs?: number,
): StepList {
  const index = findIndexBy(
    list,
    (step) => step.kind === 'thinking' && step.status === 'running',
  );
  if (index < 0) return list;
  const step = list.steps[index];
  return replaceAt(list, index, {
    status: 'done',
    endedAt: at,
    durationMs: Math.max(
      durationMs != null && Number.isFinite(durationMs) && durationMs >= 0
        ? durationMs
        : 0,
      Math.max(0, at - step.at),
    ),
    title: extractThinkingTitle(step.text ?? '', { final: true }) ?? step.title,
  });
}

// ── commentary and answer ───────────────────────────────────────────────

/** Reply text began (or goes on): a text step is running at the end. */
export function openTextStep(
  list: StepList,
  at: number,
  from: number,
): StepList {
  const current = last(list);
  if (current?.kind === 'text' && current.status === 'running') return list;
  return append(list, {
    id: nextId(list, 'text'),
    kind: 'text',
    at,
    status: 'running',
    from,
  });
}

/**
 * A tool or sub-agent started after this text: it was commentary, not the
 * answer. Keep its text (the end of it, bounded) on the step. Text can reopen
 * after a reasoning burst without the earlier text step having closed, so
 * every running text step closes here, each with the part of the text between
 * its own start and the start of the next one.
 */
export function closeTextStep(
  list: StepList,
  at: number,
  wholeText: string,
  base: number,
): StepList {
  const open: number[] = [];
  list.steps.forEach((step, index) => {
    if (step.kind === 'text' && step.status === 'running') open.push(index);
  });
  if (open.length === 0) return list;
  const steps = list.steps.slice();
  open.forEach((index, n) => {
    const step = steps[index];
    const start = Math.max(0, (step.from ?? 0) - base);
    const nextFrom = n + 1 < open.length ? steps[open[n + 1]].from : undefined;
    const end =
      nextFrom === undefined ? undefined : Math.max(start, nextFrom - base);
    steps[index] = {
      ...step,
      status: 'done',
      endedAt: at,
      text: tail(wholeText.slice(start, end).trim(), MAX_TEXT_STEP_CHARS),
    };
  });
  return { steps, dropped: list.dropped };
}

/**
 * The model's narration before a tool call, delivered whole (a proactive
 * workspace never streams its text; the host sends the passage that a tool
 * call followed). Closes the reasoning burst it came after.
 */
export function addCommentaryStep(
  list: StepList,
  at: number,
  text: string,
  progress = false,
): StepList {
  const own = text.trim();
  if (!own) return list;
  return append(closeThinkingStep(list, at), {
    id: nextId(list, 'note'),
    kind: 'text',
    at,
    endedAt: at,
    status: 'done',
    text: tail(own, MAX_TEXT_STEP_CHARS),
    commentary: true,
    ...(progress ? { progress: true } : {}),
  });
}

/** Whatever was running when a tool or sub-agent started is now over. */
export function closeOpenSteps(
  list: StepList,
  at: number,
  wholeText: string,
  base: number,
): StepList {
  return closeTextStep(closeThinkingStep(list, at), at, wholeText, base);
}

// ── tools ───────────────────────────────────────────────────────────────

export interface ToolStepInput {
  toolUseId: string;
  toolName: string;
  skillName?: string;
  summary?: string;
  /** Read from the call's input; kept only on an AskUserQuestion step. */
  questions?: StepQuestion[];
}

function toolIndex(list: StepList, toolUseId: string): number {
  return findIndexBy(
    list,
    (step) =>
      (step.kind === 'tool' || step.kind === 'task') &&
      step.toolUseId === toolUseId,
  );
}

/** A top-level tool call began (a sub-agent tool becomes a task step). */
export function startToolStep(
  list: StepList,
  tool: ToolStepInput,
  at: number,
): StepList {
  const index = toolIndex(list, tool.toolUseId);
  if (index >= 0) {
    const toolName = tool.toolName || list.steps[index].toolName;
    return replaceAt(list, index, {
      toolName,
      skillName: tool.skillName ?? list.steps[index].skillName,
      summary: tool.summary ?? list.steps[index].summary,
      ...(toolName === QUESTION_TOOL_NAME && tool.questions
        ? { questions: tool.questions }
        : {}),
    });
  }
  const isTask = TASK_TOOL_NAMES.has(tool.toolName);
  return append(list, {
    id: isTask
      ? `task-${tool.toolUseId}`
      : nextId(list, `tool-${tool.toolUseId}`),
    kind: isTask ? 'task' : 'tool',
    at,
    status: 'running',
    toolUseId: tool.toolUseId,
    toolName: tool.toolName,
    skillName: tool.skillName,
    summary: tool.summary,
    taskId: isTask ? tool.toolUseId : undefined,
    ...(tool.toolName === QUESTION_TOOL_NAME && tool.questions
      ? { questions: tool.questions }
      : {}),
  });
}

/** The call's input became known or its progress moved: update in place. */
export function patchToolStep(
  list: StepList,
  toolUseId: string,
  patch: { skillName?: string; summary?: string; questions?: StepQuestion[] },
): StepList {
  const index = toolIndex(list, toolUseId);
  if (index < 0) return list;
  const step = list.steps[index];
  const next: Partial<StreamingStep> = {};
  if (patch.skillName && patch.skillName !== step.skillName) {
    next.skillName = patch.skillName;
  }
  if (patch.summary && patch.summary !== step.summary) {
    next.summary = patch.summary;
  }
  if (
    patch.questions &&
    step.toolName === QUESTION_TOOL_NAME &&
    !sameQuestions(step.questions, patch.questions)
  ) {
    next.questions = patch.questions;
  }
  return Object.keys(next).length > 0 ? replaceAt(list, index, next) : list;
}

export interface ToolProgressInput {
  toolUseId: string;
  toolName?: string;
  skillName?: string;
  summary?: string;
  questions?: StepQuestion[];
}

/** Progress of a call: update its step, or start one if it was not seen. */
export function progressToolStep(
  list: StepList,
  tool: ToolProgressInput,
  at: number,
): StepList {
  if (toolIndex(list, tool.toolUseId) >= 0) {
    return patchToolStep(list, tool.toolUseId, {
      skillName: tool.skillName,
      summary: tool.summary,
      questions: tool.questions,
    });
  }
  return startToolStep(
    list,
    {
      toolUseId: tool.toolUseId,
      toolName: tool.toolName || 'unknown',
      skillName: tool.skillName,
      summary: tool.summary,
      questions: tool.questions,
    },
    at,
  );
}

/** Failed tool results are marked by the runner with this prefix. */
const FAILURE_PREFIX = '⚠️';

/** What the SDK reported about how a call ended, beside its text. */
export interface ToolEndExtra {
  /** The SDK's own `is_error`; wins over the text's failure prefix. */
  isError?: boolean;
  facts?: ToolResultFacts;
}

/** The call returned (`result` is its text, if any) or ended. */
export function endToolStep(
  list: StepList,
  toolUseId: string,
  at: number,
  result?: string,
  extra: ToolEndExtra = {},
): StepList {
  const index = toolIndex(list, toolUseId);
  if (index < 0) return list;
  const step = list.steps[index];
  const failed =
    extra.isError ?? (!!result && result.startsWith(FAILURE_PREFIX));
  // The Runner prefixes a failed result's text with the failure mark; a call
  // the SDK reports as successful keeps its text exactly as it came.
  const text = result
    ? previewOf(failed ? result.replace(/^⚠️\s*/, '') : result)
    : '';
  // A sub-agent ends on its own lifecycle (a background one outlives the call
  // that started it), not when its tool returns. What the call reported about
  // the sub-agent's work (its totals) still lands on the step.
  if (step.kind === 'task' && !failed) {
    return extra.facts
      ? replaceAt(list, index, { resultFacts: extra.facts })
      : list;
  }
  // The Runner answers every question with the same refusal (the reader
  // answers in their next message): that question was asked, nothing failed.
  if (step.toolName === QUESTION_TOOL_NAME) {
    if (!failed || result?.includes(QUESTION_DEFERRED_MARK)) {
      return replaceAt(list, index, {
        status: 'done',
        endedAt: step.endedAt ?? at,
      });
    }
    // Refused for another reason: there is no question for the reader.
    const { questions: _questions, ...asked } = step;
    const steps = list.steps.slice();
    steps[index] = {
      ...asked,
      status: 'error',
      endedAt: step.endedAt ?? at,
      resultPreview: text || step.resultPreview,
    };
    return { steps, dropped: list.dropped };
  }
  return replaceAt(list, index, {
    status: failed ? 'error' : step.status === 'error' ? 'error' : 'done',
    endedAt: step.endedAt ?? at,
    resultPreview: text || step.resultPreview,
    ...(extra.facts ? { resultFacts: extra.facts } : {}),
  });
}

/** A permission denial marks the call it denied. */
export function failToolStep(
  list: StepList,
  toolUseId: string,
  at: number,
  reason: string,
): StepList {
  const index = toolIndex(list, toolUseId);
  if (index < 0) return list;
  return replaceAt(list, index, {
    status: 'error',
    endedAt: list.steps[index].endedAt ?? at,
    resultPreview: head(reason, MAX_RESULT_PREVIEW_CHARS),
    outcome: 'denied',
  });
}

// ── sub-agents ──────────────────────────────────────────────────────────

/**
 * Whether `parentToolUseId` is a sub-agent: its tools belong to its card. A
 * tool nested under anything else (a skill) is the model's own call.
 */
export function isUnderTask(
  list: StepList,
  parentToolUseId: string | null | undefined,
): boolean {
  if (!parentToolUseId) return false;
  return list.steps.some(
    (step) =>
      step.kind === 'task' &&
      (step.taskId === parentToolUseId || step.toolUseId === parentToolUseId),
  );
}

export function hasTaskStep(list: StepList, taskId: string): boolean {
  return list.steps.some(
    (step) =>
      step.kind === 'task' &&
      (step.taskId === taskId || step.toolUseId === taskId),
  );
}

export interface TaskStepInput {
  taskId: string;
  toolUseId?: string;
  title?: string;
  summary?: string;
}

function taskIndex(list: StepList, taskId: string): number {
  return findIndexBy(
    list,
    (step) =>
      step.kind === 'task' &&
      (step.taskId === taskId || step.toolUseId === taskId),
  );
}

/** A sub-agent or workflow is running (created once, then updated). */
export function ensureTaskStep(
  list: StepList,
  input: TaskStepInput,
  at: number,
): StepList {
  const index = taskIndex(list, input.taskId);
  if (index >= 0) {
    const step = list.steps[index];
    const patch: Partial<StreamingStep> = {};
    if (input.summary && input.summary !== step.summary) {
      patch.summary = input.summary;
    }
    if (input.title && input.title !== step.title) patch.title = input.title;
    return Object.keys(patch).length > 0 ? replaceAt(list, index, patch) : list;
  }
  return append(list, {
    id: `task-${input.taskId}`,
    kind: 'task',
    at,
    status: 'running',
    taskId: input.taskId,
    toolUseId: input.toolUseId ?? input.taskId,
    toolName: 'Task',
    summary: input.summary,
    title: input.title,
  });
}

/**
 * The sub-agent's own lifecycle moved. `outcome` says why an `error` ended it
 * (a stop killed it); running again or done clears it.
 */
export function setTaskStepStatus(
  list: StepList,
  taskId: string,
  status: StepStatus,
  at: number,
  summary?: string,
  outcome?: StepOutcome,
): StepList {
  const index = taskIndex(list, taskId);
  if (index < 0) return list;
  const step = list.steps[index];
  const patch: Partial<StreamingStep> = {};
  if (step.status !== status) {
    patch.status = status;
    if (status !== 'running') patch.endedAt = step.endedAt ?? at;
  }
  if (summary && summary !== step.summary) patch.summary = summary;
  if (status === 'error' && outcome && outcome !== step.outcome) {
    patch.outcome = outcome;
  }
  const clearOutcome = status !== 'error' && step.outcome !== undefined;
  if (Object.keys(patch).length === 0 && !clearOutcome) return list;
  if (!clearOutcome) return replaceAt(list, index, patch);
  const { outcome: _outcome, ...rest } = step;
  const steps = list.steps.slice();
  steps[index] = { ...rest, ...patch };
  return { steps, dropped: list.dropped };
}

// ── the end of a reply ──────────────────────────────────────────────────

/**
 * The run ended (or was stopped): nothing is running any more. A tool that
 * never reported back after a stop is marked as failed so the card does not
 * look like it is still working.
 */
export function finishSteps(
  list: StepList,
  at: number,
  stopped: boolean,
): StepList {
  if (!list.steps.some((step) => step.status === 'running')) return list;
  return {
    dropped: list.dropped,
    steps: list.steps.map((step) => {
      if (step.status !== 'running') return step;
      const cut = stopped && (step.kind === 'tool' || step.kind === 'task');
      return cut
        ? {
            ...step,
            endedAt: at,
            status: 'error',
            resultPreview: step.resultPreview ?? STOPPED_PREVIEW,
            outcome: 'stopped',
          }
        : { ...step, endedAt: at, status: 'done' };
    }),
  };
}

// ── reading the list ────────────────────────────────────────────────────

/** Index of the step holding the reply's answer, if text came last. */
export function answerStepIndex(steps: readonly StreamingStep[]): number {
  let textIndex = -1;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const kind = steps[index].kind;
    if (kind === 'text') {
      // Narration handed over whole is followed by its tool call: not an answer.
      if (steps[index].commentary) continue;
      textIndex = index;
      break;
    }
    if (kind === 'tool' || kind === 'task') return -1;
  }
  return textIndex;
}

/**
 * Where the answer starts in the reply's whole text: text after the last
 * tool or sub-agent, which is what the host delivers as the final message.
 * `undefined` when the list has no steps (an older mirror, a snapshot).
 */
export function answerStart(
  steps: readonly StreamingStep[] | undefined,
  base: number,
): number | undefined {
  if (!steps || steps.length === 0) return undefined;
  const index = answerStepIndex(steps);
  if (index < 0) return Number.POSITIVE_INFINITY;
  return Math.max(0, (steps[index].from ?? 0) - base);
}

export interface StepSummary {
  tools: number;
  tasks: number;
  thinking: number;
  commentary: number;
  failed: number;
}

export function summarizeSteps(steps: readonly StreamingStep[]): StepSummary {
  const summary: StepSummary = {
    tools: 0,
    tasks: 0,
    thinking: 0,
    commentary: 0,
    failed: 0,
  };
  for (const step of steps) {
    if (step.kind === 'tool') summary.tools += 1;
    else if (step.kind === 'task') summary.tasks += 1;
    else if (step.kind === 'thinking') summary.thinking += 1;
    else if (step.text?.trim()) summary.commentary += 1;
    if (step.status === 'error') summary.failed += 1;
  }
  return summary;
}

/** Rows the live timeline keeps visible; older steps fold into one line. */
export const TIMELINE_ROWS = 6;

/** Steps the timeline lists: everything but the answer and empty commentary. */
export function railSteps(steps: readonly StreamingStep[]): StreamingStep[] {
  const answer = answerStepIndex(steps);
  return steps.filter(
    (step, index) =>
      index !== answer && !(step.kind === 'text' && !step.text?.trim()),
  );
}

// ── rebuilding after a reconnect ────────────────────────────────────────

export interface SnapshotSteps {
  thinkingText: string;
  thinkingDurationMs?: number;
  isThinking: boolean;
  partialText: string;
  activeTools: ReadonlyArray<{
    toolName: string;
    toolUseId: string;
    startTime: number;
    toolInputSummary?: string;
    skillName?: string;
    parentToolUseId?: string | null;
    isNested?: boolean;
  }>;
  tasks: ReadonlyArray<{ id: string; status: string; title: string }>;
  /** Top-level tool rows of the trace, oldest first. */
  tracedTools: ReadonlyArray<{
    toolUseId: string;
    timestamp: number;
    summary?: string;
    skillName?: string;
    toolName?: string;
  }>;
  now: number;
}

/**
 * A reconnect snapshot carries the pieces but not their order. Rebuild a
 * plausible one: the reasoning first, then the tools and sub-agents by the
 * time they were traced, then the text. Only used when this tab has no steps
 * of its own for the turn.
 */
export function rebuildSteps(input: SnapshotSteps): StepList {
  let list: StepList = { steps: [], dropped: 0 };
  const firstAt = input.tracedTools[0]?.timestamp ?? input.now;
  if (input.thinkingText || input.thinkingDurationMs) {
    list = append(list, {
      id: 'thinking-restored',
      kind: 'thinking',
      at: Math.max(0, firstAt - 1),
      endedAt: input.isThinking ? undefined : firstAt,
      status: input.isThinking && !input.partialText ? 'running' : 'done',
      text: capThinkingText(input.thinkingText, MAX_STEP_THINKING_TEXT),
      title: extractThinkingTitle(input.thinkingText, { final: true }),
      durationMs: input.thinkingDurationMs,
    });
  }
  const active = new Set(input.activeTools.map((tool) => tool.toolUseId));
  const tasks = new Map(input.tasks.map((task) => [task.id, task]));
  for (const tool of input.tracedTools) {
    if (tasks.has(tool.toolUseId)) continue;
    const running = active.has(tool.toolUseId);
    list = append(list, {
      id: `tool-${tool.toolUseId}-restored`,
      kind: 'tool',
      at: tool.timestamp,
      status: running ? 'running' : 'done',
      toolUseId: tool.toolUseId,
      toolName: tool.toolName,
      skillName: tool.skillName,
      summary: tool.summary,
    });
  }
  for (const tool of input.activeTools) {
    if (tool.isNested || tool.parentToolUseId) continue;
    if (tasks.has(tool.toolUseId)) continue;
    if (list.steps.some((step) => step.toolUseId === tool.toolUseId)) continue;
    list = append(list, {
      id: `tool-${tool.toolUseId}-restored`,
      kind: 'tool',
      at: tool.startTime,
      status: 'running',
      toolUseId: tool.toolUseId,
      toolName: tool.toolName,
      skillName: tool.skillName,
      summary: tool.toolInputSummary,
    });
  }
  for (const task of input.tasks) {
    list = append(list, {
      id: `task-${task.id}`,
      kind: 'task',
      at: firstAt,
      status:
        task.status === 'completed'
          ? 'done'
          : task.status === 'error' || task.status === 'stopped'
            ? 'error'
            : 'running',
      ...(task.status === 'stopped' ? { outcome: 'stopped' as const } : {}),
      taskId: task.id,
      toolUseId: task.id,
      toolName: 'Task',
      title: task.title,
    });
  }
  if (input.partialText) {
    list = append(list, {
      id: 'text-restored',
      kind: 'text',
      at: input.now,
      status: 'running',
      from: 0,
    });
  }
  return list;
}
