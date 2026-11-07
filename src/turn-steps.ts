/**
 * The ordered steps of a turn, recorded on the host from its stream events.
 *
 * The Web builds the same list live (web/src/stores/chat.ts: applyStreamEvent,
 * applyTaskToSteps and the thinking helpers around them, over the reducer in
 * shared/stream-steps.ts) and drops it when the reply settles. The host keeps
 * it, so a settled reply can show the timeline it streamed (turn_traces
 * .steps_json). The recorder is a port of that event-to-step mapping: it holds
 * the few fields of the Web's streaming state the mapping reads (the open
 * reasoning burst, the model's request phase, the reply text so far, the
 * running tools and tasks) and calls the same reducer functions in the same
 * order. tests/turn-steps-web-parity.test.ts feeds one event sequence to both
 * and compares; if the Web's mapping changes, change it here as well.
 *
 * Not ThinkingClock (stream-trace.ts): that one times the whole turn's
 * reasoning for "已思考 Xs" and decides a few things differently from the Web,
 * which move where a burst starts (the Web restarts the model's request phase
 * at the end of a tool only while that tool is still running; the clock does
 * at every tool_use_end and tool_result). A step has to start where the Web
 * puts it.
 *
 * Not recorded, by design: the narration a proactive Workspace gets before a
 * tool call (`commentary`) is model text that the host broadcasts and never
 * stores, so a proactive turn has no text steps (the Web shows them live).
 */

import type { StreamEvent } from './stream-event.types.js';
import {
  MAX_STEPS,
  addCommentaryStep,
  appendThinkingText,
  closeOpenSteps,
  closeThinkingStep,
  endToolStep,
  ensureTaskStep,
  failToolStep,
  finishSteps,
  hasTaskStep,
  isUnderTask,
  openTextStep,
  openThinkingStep,
  progressToolStep,
  QUESTION_TOOL_NAME,
  readStepQuestions,
  setTaskStepStatus,
  startToolStep,
  type StepKind,
  type StepList,
  type StepStatus,
  type StreamingStep,
  type ToolResultFacts,
} from './stream-steps.js';
import { capTailByBytes, isSubagentEvent } from './stream-trace.js';
import { THINKING_OMITTED_MARKER } from './thinking-text.js';
import {
  isMemoryWriteTool,
  isMessageDeliveryTool,
} from './workspace-interaction-runtime.js';

/**
 * Reply text kept to cut the commentary of a text step from. The Web bounds its
 * partial text the same way; a step only ever reads the text since it began.
 */
const MAX_REPLY_TEXT = 200_000;

/** Tools whose end comes from their own lifecycle, not their tool_result. */
const TOOLS_ENDED_BY_LIFECYCLE: ReadonlySet<string> = new Set([
  'Task',
  'Agent',
  'Skill',
]);

/** SDK task types that are not sub-agents (e.g. backgrounded Bash, monitors). */
const NON_AGENT_TASK_TYPES: ReadonlySet<string> = new Set([
  'local_bash',
  'monitor',
  'mcp_task',
]);

type TaskRuntimeStatus =
  | 'running'
  | 'completed'
  | 'error'
  | 'stopped'
  | 'backgrounded';

/** What the Web's StreamingTaskRuntimeState contributes to a task's step. */
interface TaskRuntime {
  title: string;
  status: TaskRuntimeStatus;
  taskType?: string;
  latestSummary?: string;
}

interface ActiveTool {
  toolName: string;
  isNested?: boolean;
}

export interface TurnStepRecorderOptions {
  /**
   * A proactive Workspace speaks through one tool: calling it is the reply
   * itself, not work to watch, so it is no step (the Web leaves it out too).
   * Its start still ends the reasoning before it.
   */
  proactive?: boolean;
}

function taskIdFromEvent(event: StreamEvent): string | null {
  return (
    event.parentToolUseId ||
    event.taskId ||
    (event.eventType === 'task_start' ||
    event.eventType === 'task_progress' ||
    event.eventType === 'task_updated' ||
    event.eventType === 'task_notification'
      ? event.toolUseId || null
      : null)
  );
}

/** A task_notification's status: done, stopped (killed by a stop), or failed. */
function taskStatusOfNotification(
  status: string | undefined,
): TaskRuntimeStatus {
  if (status === 'completed') return 'completed';
  return status === 'stopped' || status === 'killed' ? 'stopped' : 'error';
}

function stepStatusOfTask(status: TaskRuntimeStatus): StepStatus {
  if (status === 'completed') return 'done';
  return status === 'error' || status === 'stopped' ? 'error' : 'running';
}

/** Keep the end of an over-long reply, off a surrogate pair. */
function capReplyText(text: string): string {
  if (text.length <= MAX_REPLY_TEXT) return text;
  let start = text.length - Math.floor(MAX_REPLY_TEXT * 0.9);
  const code = text.charCodeAt(start);
  if (code >= 0xdc00 && code <= 0xdfff) start += 1;
  return text.slice(start);
}

/** A text step that holds no commentary: the answer, or whitespace. */
function isBlankTextStep(step: StreamingStep): boolean {
  return step.kind === 'text' && !step.text?.trim();
}

// The reducer bounds reasoning text, commentary and result previews; what a
// call or a sub-agent is described with comes from events and is bounded here,
// so the size of a stored turn does not depend on the size of its events.
const MAX_TITLE_CHARS = 200;
const MAX_SUMMARY_CHARS = 400;
const MAX_NAME_CHARS = 120;
const MAX_ID_CHARS = 200;

const BOUNDED_TEXT = [
  ['title', MAX_TITLE_CHARS],
  ['summary', MAX_SUMMARY_CHARS],
  ['toolName', MAX_NAME_CHARS],
  ['skillName', MAX_NAME_CHARS],
  ['resultPreview', MAX_SUMMARY_CHARS],
] as const;
const BOUNDED_IDS = ['id', 'toolUseId', 'taskId'] as const;

/** `text` cut to `max` characters, off a surrogate pair. */
function cutText(text: string, max: number): string {
  let end = max;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

/** The step with its words and ids bounded; the step itself if they are. */
function boundStep(step: StreamingStep): StreamingStep {
  const patch: Partial<StreamingStep> = {};
  for (const [key, max] of BOUNDED_TEXT) {
    const value = step[key];
    if (value !== undefined && value.length > max) {
      patch[key] = `${cutText(value, max - 1)}…`;
    }
  }
  for (const key of BOUNDED_IDS) {
    const value = step[key];
    if (value !== undefined && value.length > MAX_ID_CHARS) {
      patch[key] = cutText(value, MAX_ID_CHARS);
    }
  }
  return Object.keys(patch).length > 0 ? { ...step, ...patch } : step;
}

/** `id` if no step has it yet, else `id~1`, `id~2`…; the result is taken. */
function takeUniqueId(taken: Set<string>, id: string): string {
  let next = id;
  for (let n = 1; taken.has(next); n += 1) next = `${id}~${n}`;
  taken.add(next);
  return next;
}

function withUniqueIds(steps: StreamingStep[]): StreamingStep[] {
  const taken = new Set<string>();
  return steps.map((step) => {
    const id = takeUniqueId(taken, step.id);
    return id === step.id ? step : { ...step, id };
  });
}

/** The latest task step that is the same sub-agent as `step`, or -1. */
function findSameTask(steps: readonly StreamingStep[], step: StreamingStep) {
  const ids = [step.taskId, step.toolUseId].filter((id): id is string => !!id);
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const known = steps[index];
    if (
      known.kind === 'task' &&
      ids.some((id) => known.taskId === id || known.toolUseId === id)
    ) {
      return index;
    }
  }
  return -1;
}

/** The title the reducer gives a sub-agent it knows nothing about. */
const PLACEHOLDER_TASK_TITLE = 'Task';

/**
 * A sub-agent started in an earlier part of a held reply sequence and heard
 * from in a later one: one step, which keeps its place and start, and takes
 * from the later part how it ended and what it reported.
 */
function mergeTaskStep(
  earlier: StreamingStep,
  later: StreamingStep,
): StreamingStep {
  const real = (title?: string) =>
    title && title !== PLACEHOLDER_TASK_TITLE ? title : undefined;
  // How it ended is the later part's, as its status is.
  const { outcome: _outcome, ...before } = earlier;
  return {
    ...before,
    status: later.status,
    endedAt: later.endedAt ?? earlier.endedAt,
    title: real(earlier.title) ?? real(later.title) ?? earlier.title,
    summary: later.summary ?? earlier.summary,
    resultPreview: later.resultPreview ?? earlier.resultPreview,
    resultFacts: later.resultFacts ?? earlier.resultFacts,
    ...(later.outcome ? { outcome: later.outcome } : {}),
  };
}

/** Records the steps of one turn (or of one part of a held reply sequence). */
export class TurnStepRecorder {
  private list: StepList = { steps: [], dropped: 0 };
  // The part of the Web's StreamingState that the event-to-step mapping reads.
  private isThinking = false;
  private thinkingStartedAt?: number;
  private thinkingDurationMs?: number;
  private phaseStartedAt?: number;
  private partialText = '';
  private partialBase = 0;
  private readonly activeTools = new Map<string, ActiveTool>();
  private readonly tasks = new Map<string, TaskRuntime>();
  private readonly speechCalls = new Set<string>();
  private lastEventAt?: number;

  /**
   * `runStartedAt` is when the model was first asked: reasoning that arrives
   * before anything else began then, not when its first text did.
   */
  constructor(
    private readonly runStartedAt?: number,
    private readonly options: TurnStepRecorderOptions = {},
  ) {}

  /** Whether anything but the reply's own text has been recorded. */
  get isEmpty(): boolean {
    return (
      this.list.dropped === 0 &&
      this.list.steps.every((s) => isBlankTextStep(s))
    );
  }

  /** A progress statement the Agent sent is among the steps. */
  get hasProgress(): boolean {
    return this.list.steps.some(isProgressStep);
  }

  /** The progress statements among the steps, in order. */
  progressSteps(): Array<{ at: number; text: string }> {
    return this.list.steps
      .filter(isProgressStep)
      .map((step) => ({ at: step.at, text: step.text ?? '' }));
  }

  observe(event: StreamEvent, now: number): void {
    this.lastEventAt = now;
    if (this.options.proactive && this.observeSpeechTool(event, now)) {
      return;
    }
    switch (event.eventType) {
      case 'status':
        this.observeStatus(event, now);
        break;
      case 'text_delta':
        this.observeText(event, now);
        break;
      case 'commentary':
        if (isSubagentEvent(event) || !event.text) break;
        this.endThinkingBurst(now);
        this.list = addCommentaryStep(
          this.list,
          now,
          event.text,
          !!event.progress,
        );
        break;
      case 'thinking_delta':
        if (event.parentToolUseId) {
          this.updateTask(event);
          break;
        }
        // The Web applies deltas in frames and skips an empty one.
        if (!event.text) break;
        this.beginThinkingBurst(now);
        this.list = appendThinkingText(this.list, event.text, now);
        break;
      case 'thinking_start':
        // Sub-agents do not send these; their reasoning is their task's tail.
        if (isSubagentEvent(event)) break;
        this.beginThinkingBurst(now);
        break;
      case 'thinking_end':
        if (isSubagentEvent(event)) break;
        this.endThinkingBurst(now, event.thinkingDurationMs);
        break;
      case 'tool_use_start':
        this.observeToolStart(event, now);
        break;
      case 'tool_use_end':
        this.observeToolEnd(event, now);
        break;
      case 'tool_result':
        this.observeToolResult(event, now);
        break;
      case 'tool_progress':
        this.observeToolProgress(event, now);
        break;
      case 'task_start':
      case 'task_progress':
      case 'task_updated':
      case 'task_notification':
        this.updateTask(event);
        this.applyTaskToSteps(event, now);
        break;
      case 'permission_denied': {
        const denied = event.permissionDenied;
        if (!denied?.toolUseId) break;
        const why =
          denied.reason ||
          denied.message ||
          event.summary ||
          event.detail ||
          '权限被拒绝';
        this.list = failToolStep(this.list, denied.toolUseId, now, why);
        break;
      }
      default:
        break;
    }
  }

  /**
   * The steps as a settled reply shows them: nothing is running any more, and
   * the reply's own text (the answer, which is the message itself) is no step.
   * A copy; the recorder goes on as it was.
   */
  settled(at: number): StepList {
    const finished = finishSteps(this.list, at, false);
    const kept = finished.steps.filter((step) => !isBlankTextStep(step));
    // The reducer drops finished steps only, so a list of calls that never
    // reported back can still be over the cap; what is stored never is.
    const overflow = Math.max(0, kept.length - MAX_STEPS);
    const newest = overflow > 0 ? kept.slice(overflow) : kept;
    const bounded = newest.map(boundStep);
    return {
      // Cutting an id can make two the same.
      steps: bounded.some((step, index) => step !== newest[index])
        ? withUniqueIds(bounded)
        : newest,
      dropped: finished.dropped + overflow,
    };
  }

  /**
   * Append the steps of a later part of the same held reply sequence. Both
   * parts are over by now, so both settle first: the earlier one where its last
   * event was, the later one now.
   */
  absorb(other: TurnStepRecorder, now: number): void {
    if (other.list.steps.length === 0 && other.list.dropped === 0) return;
    const before = this.settled(this.lastEventAt ?? now);
    const after = other.settled(now);
    const taken = new Set(before.steps.map((step) => step.id));
    const steps = [...before.steps];
    for (const step of after.steps) {
      // A background sub-agent can start in one part and end in a later one,
      // which only hears of it by its notification: still the same step.
      const same = step.kind === 'task' ? findSameTask(steps, step) : -1;
      if (same >= 0) {
        steps[same] = mergeTaskStep(steps[same], step);
        continue;
      }
      const id = takeUniqueId(taken, step.id);
      steps.push(id === step.id ? step : { ...step, id });
    }
    const overflow = Math.max(0, steps.length - MAX_STEPS);
    this.list = {
      steps: overflow > 0 ? steps.slice(overflow) : steps,
      dropped: before.dropped + after.dropped + overflow,
    };
    // Whatever was open belongs to the earlier part, which is now settled.
    this.isThinking = false;
    this.thinkingStartedAt = undefined;
    this.activeTools.clear();
  }

  // ── the Web's reasoning burst and request phase ──────────────────────

  /**
   * Reasoning began (`thinking_start`, or the first delta of a burst when the
   * runner sends none). The burst, and its step, start when the model's request
   * did (`phaseStartedAt`, or the run's start for the first one) rather than
   * when its first text arrived. Web: markThinkingStarted, beginThinkingBurst.
   */
  private beginThinkingBurst(at: number): void {
    if (!this.isThinking || this.thinkingStartedAt === undefined) {
      const requestStart =
        this.phaseStartedAt ??
        (this.thinkingDurationMs === undefined && !this.partialText
          ? this.runStartedAt
          : undefined);
      this.thinkingStartedAt =
        requestStart !== undefined && requestStart <= at ? requestStart : at;
    }
    this.phaseStartedAt = undefined;
    if (!this.isThinking) {
      this.list = openThinkingStep(this.list, this.thinkingStartedAt ?? at);
    }
    this.isThinking = true;
  }

  /** A burst of reasoning ended; `reportedMs` is the model's own timing. */
  private endThinkingBurst(at: number, reportedMs?: number): void {
    const reported =
      reportedMs != null && Number.isFinite(reportedMs) && reportedMs >= 0
        ? reportedMs
        : undefined;
    if (this.isThinking && this.thinkingStartedAt !== undefined) {
      this.thinkingDurationMs =
        (this.thinkingDurationMs ?? 0) +
        Math.max(reported ?? 0, Math.max(0, at - this.thinkingStartedAt));
      this.thinkingStartedAt = undefined;
    } else if (this.isThinking && reported !== undefined) {
      this.thinkingDurationMs = (this.thinkingDurationMs ?? 0) + reported;
    }
    this.isThinking = false;
    this.list = closeThinkingStep(this.list, at, reported);
  }

  // ── events ───────────────────────────────────────────────────────────

  private observeStatus(event: StreamEvent, now: number): void {
    if (event.statusText === 'interrupted') {
      this.stop(now);
      return;
    }
    // A new model request: reasoning that follows is a new burst, and it
    // started here.
    if (event.statusText === 'requesting' && !event.parentToolUseId) {
      this.endThinkingBurst(now);
      this.phaseStartedAt = now;
    }
  }

  /**
   * The run was stopped. What had not reported back is marked failed so the
   * timeline does not look like it is still working. Web: freezeStreamingState.
   */
  private stop(now: number): void {
    if (this.isThinking && this.thinkingStartedAt !== undefined) {
      this.thinkingDurationMs =
        (this.thinkingDurationMs ?? 0) +
        Math.max(0, now - this.thinkingStartedAt);
    }
    this.list = finishSteps(this.list, now, true);
    this.isThinking = false;
    this.thinkingStartedAt = undefined;
    this.activeTools.clear();
  }

  private observeText(event: StreamEvent, now: number): void {
    if (event.parentToolUseId) {
      this.updateTask(event);
      return;
    }
    if (!event.text) return;
    this.endThinkingBurst(now);
    const base = this.partialBase;
    const before = this.partialText.length;
    const combined = this.partialText + event.text;
    this.partialText = capReplyText(combined);
    this.partialBase =
      base + Math.max(0, combined.length - this.partialText.length);
    this.list = openTextStep(this.list, now, base + before);
    this.phaseStartedAt = undefined;
  }

  /** What was open when a tool or a sub-agent started is now over. */
  private closeOpen(now: number): StepList {
    return closeOpenSteps(this.list, now, this.partialText, this.partialBase);
  }

  private observeToolStart(event: StreamEvent, now: number): void {
    // A sub-agent's tool is not the main agent's: its own reasoning goes on.
    if (!isSubagentEvent(event)) this.endThinkingBurst(now);
    if (!event.parentToolUseId) this.phaseStartedAt = undefined;
    const toolUseId = event.toolUseId || '';
    if (toolUseId && !isUnderTask(this.list, event.parentToolUseId)) {
      // Text before a tool was commentary; the tool is the next step.
      this.list = startToolStep(
        this.closeOpen(now),
        {
          toolUseId,
          toolName: event.toolName || 'unknown',
          skillName: event.skillName,
          summary: event.toolInputSummary,
          questions: readStepQuestions(event.toolInput),
        },
        now,
      );
    }
    if (toolUseId) {
      this.activeTools.set(toolUseId, {
        toolName: event.toolName || 'unknown',
        isNested: event.isNested,
      });
    }
    if (event.parentToolUseId) this.updateTask(event);
  }

  private observeToolEnd(event: StreamEvent, now: number): void {
    if (event.toolUseId) {
      const ended = this.activeTools.get(event.toolUseId);
      this.activeTools.delete(event.toolUseId);
      if (!isUnderTask(this.list, event.parentToolUseId)) {
        this.list = endToolStep(this.list, event.toolUseId, now);
      }
      // The model takes over again: the next burst starts here.
      if (ended && !event.parentToolUseId && !ended.isNested) {
        this.phaseStartedAt = now;
      }
    }
    if (event.parentToolUseId) this.updateTask(event);
  }

  private observeToolResult(event: StreamEvent, now: number): void {
    if (!event.toolUseId || event.parentToolUseId) return;
    this.list = endToolStep(this.list, event.toolUseId, now, event.toolResult, {
      isError: event.toolIsError,
      facts: event.toolResultFacts,
    });
    const ended = this.activeTools.get(event.toolUseId);
    if (!ended || TOOLS_ENDED_BY_LIFECYCLE.has(ended.toolName)) return;
    this.activeTools.delete(event.toolUseId);
    if (!ended.isNested) this.phaseStartedAt = now;
  }

  private observeToolProgress(event: StreamEvent, now: number): void {
    if (event.toolUseId && !this.activeTools.has(event.toolUseId)) {
      this.activeTools.set(event.toolUseId, {
        toolName: event.toolName || 'unknown',
        isNested: event.isNested,
      });
    }
    if (event.toolUseId && !isUnderTask(this.list, event.parentToolUseId)) {
      this.list = progressToolStep(
        this.list,
        {
          toolUseId: event.toolUseId,
          toolName: event.toolName,
          skillName: event.skillName,
          summary: event.toolInputSummary,
          questions: readStepQuestions(event.toolInput),
        },
        now,
      );
    }
    if (event.parentToolUseId) this.updateTask(event);
  }

  /** The speech tool's events; true when the event was one of them. */
  private observeSpeechTool(event: StreamEvent, now: number): boolean {
    if (!event.eventType.startsWith('tool_')) return false;
    const known = !!event.toolUseId && this.speechCalls.has(event.toolUseId);
    if (!isMessageDeliveryTool(event.toolName) && !known) return false;
    if (event.eventType === 'tool_use_start' && event.toolUseId) {
      this.speechCalls.add(event.toolUseId);
      // The reasoning before it is over; it is not itself a step.
      this.endThinkingBurst(now);
      this.phaseStartedAt = undefined;
    }
    return true;
  }

  // ── sub-agents ───────────────────────────────────────────────────────

  /** Web: updateTaskRuntime, for the fields a task's step reads. */
  private updateTask(event: StreamEvent): void {
    const taskId = taskIdFromEvent(event);
    if (!taskId) return;
    const task: TaskRuntime = {
      ...(this.tasks.get(taskId) ?? {
        title:
          event.taskDescription ||
          event.toolInputSummary ||
          event.summary ||
          'Task',
        status: 'running' as const,
      }),
    };
    if (event.taskDescription && (!task.title || task.title === 'Task')) {
      task.title = event.taskDescription;
    }
    if (event.taskType) {
      task.taskType = event.taskType;
    }
    if (event.eventType === 'task_progress') {
      task.status = 'running';
      task.latestSummary =
        event.summary ||
        event.taskSummary ||
        event.taskDescription ||
        task.latestSummary;
    } else if (event.eventType === 'task_updated') {
      const patch = event.taskPatch;
      if (patch?.status === 'completed') task.status = 'completed';
      // A stop (the CLI's interrupt kills running sub-agents) is no failure.
      else if (patch?.status === 'killed' || patch?.status === 'stopped')
        task.status = 'stopped';
      else if (patch?.status === 'failed' || patch?.status === 'aborted')
        task.status = 'error';
      else if (patch?.is_backgrounded) task.status = 'backgrounded';
      else if (patch?.status === 'running' || patch?.status === 'pending')
        task.status = 'running';
      task.latestSummary =
        event.summary ||
        patch?.description ||
        patch?.error ||
        task.latestSummary;
    } else if (event.eventType === 'task_notification') {
      task.status = taskStatusOfNotification(event.taskStatus);
      task.latestSummary =
        event.taskSummary || event.summary || task.latestSummary;
    }
    this.tasks.set(taskId, task);
  }

  /**
   * Mirror a task event into the step list: the step holds the task's place in
   * the order, its title and its summary. Runs after `updateTask`, so the
   * status is the task's own.
   */
  private applyTaskToSteps(event: StreamEvent, now: number): void {
    // A task event with a parent belongs to a task nested in another.
    if (event.parentToolUseId) return;
    const taskId = taskIdFromEvent(event);
    if (!taskId) return;
    const task = this.tasks.get(taskId);
    const effectiveTaskType = event.taskType ?? task?.taskType;
    const id = event.toolUseId ?? taskId;
    let list = this.list;
    if (
      (effectiveTaskType && NON_AGENT_TASK_TYPES.has(effectiveTaskType)) ||
      list.steps.some(
        (s) =>
          s.kind === 'tool' &&
          s.toolUseId === id &&
          s.toolName !== 'Task' &&
          s.toolName !== 'Agent',
      )
    ) {
      return;
    }
    if (!hasTaskStep(list, taskId)) list = this.closeOpen(now);
    list = ensureTaskStep(
      list,
      {
        taskId,
        toolUseId: event.toolUseId,
        title: event.taskDescription || event.toolInputSummary || task?.title,
        summary: task?.latestSummary,
      },
      now,
    );
    if (task) {
      list = setTaskStepStatus(
        list,
        taskId,
        stepStatusOfTask(task.status),
        now,
        task.latestSummary,
        task.status === 'stopped' ? 'stopped' : undefined,
      );
    }
    this.list = list;
  }
}

// ── What a reader may see, and what is kept ─────────────────────────────

export interface StepsView {
  /**
   * The reasoning text and titles (`full` in a proactive Workspace). Without
   * it a thinking step keeps its status and times only.
   */
  includeThinking: boolean;
  /**
   * A proactive Workspace: its speech tool is no step, no step holds model
   * text but the reasoning, and none holds what a tool returned. A turn can
   * hold all of that and still be read here: it ran under an Assistant contract
   * (the Workspace was an Assistant one then, or a channel mount overrides its
   * mode) and the Workspace's *current* mode decides what is shown.
   */
  proactive?: boolean;
  /**
   * Only the progress statements the Agent sent the user (a proactive
   * Workspace at `hidden`): nothing else of the process is shown.
   */
  progressOnly?: boolean;
}

/** A progress statement the Agent sent the user: every level shows it. */
export function isProgressStep(step: StreamingStep): boolean {
  return step.kind === 'text' && !!step.progress;
}

/**
 * The steps cut down to what `view` shows. Used when a turn is stored (what
 * the Workspace shows then is the most a later reader can get) and again when
 * it is read (the Workspace's *current* contract wins).
 */
export function viewSteps(
  steps: readonly StreamingStep[],
  view: StepsView,
): StreamingStep[] {
  const out: StreamingStep[] = [];
  for (const step of steps) {
    let shown = step;
    const progress = isProgressStep(step);
    if (view.progressOnly && !progress) continue;
    if (view.proactive) {
      if (shown.kind === 'text' && !shown.commentary) continue;
      if (shown.kind === 'tool' && isMessageDeliveryTool(shown.toolName)) {
        continue;
      }
      const keepMemoryReceipt =
        shown.kind === 'tool' &&
        shown.status === 'done' &&
        isMemoryWriteTool(shown.toolName);
      // What a tool or a sub-agent returned, and the numbers read from it, are
      // model-facing text: a proactive Workspace never sends them (the status of
      // the call, which says whether it failed, and workspace memory write
      // receipts stay).
      if (
        (!keepMemoryReceipt && shown.resultPreview !== undefined) ||
        shown.resultFacts !== undefined
      ) {
        const { resultPreview: _preview, resultFacts: _facts, ...rest } = shown;
        shown =
          keepMemoryReceipt && shown.resultPreview !== undefined
            ? { ...rest, resultPreview: shown.resultPreview }
            : rest;
      }
      // Nor the questions a call would put to the reader: its Web events
      // never carry a tool's input.
      if (shown.questions !== undefined) {
        const { questions: _questions, ...rest } = shown;
        shown = rest;
      }
    }
    if (!view.includeThinking) {
      if (shown.kind === 'text' && !progress) continue;
      if (shown.kind === 'thinking') {
        const { text: _text, title: _title, ...rest } = shown;
        shown = rest;
      }
    }
    out.push(shown);
  }
  return out;
}

/** A cut thinking text that would keep less than this is the marker alone. */
const MIN_KEPT_THINKING_BYTES = 256;
/** The head of a reasoning text that had its oldest part dropped. */
const OMITTED_PREFIX = `${THINKING_OMITTED_MARKER}\n\n`;
const OMITTED_MARKER_BYTES = Buffer.byteLength(THINKING_OMITTED_MARKER, 'utf8');

/**
 * Bound the reasoning text of all thinking steps to `maxBytes` of UTF-8: the
 * oldest text goes first and the step keeps its title and times. What is cut
 * is said so with the marker the reasoning text itself carries when its start
 * is dropped, so the step does not read as a burst that had nothing to show.
 * Returns `steps` itself when it already fits.
 */
export function capStepsThinkingBytes(
  steps: StreamingStep[],
  maxBytes: number,
): StreamingStep[] {
  const sizes = steps.map((step) =>
    step.kind === 'thinking' && step.text
      ? Buffer.byteLength(step.text, 'utf8')
      : 0,
  );
  let excess = sizes.reduce((sum, size) => sum + size, 0) - maxBytes;
  if (excess <= 0) return steps;
  const out = steps.slice();
  for (let index = 0; index < out.length && excess > 0; index += 1) {
    const size = sizes[index];
    // A text no longer than the marker gains nothing from being replaced by it.
    if (size <= OMITTED_MARKER_BYTES) continue;
    const step = out[index];
    const text = step.text!;
    const kept = size - excess;
    if (kept < MIN_KEPT_THINKING_BYTES) {
      // Not worth a stump.
      out[index] = { ...step, text: THINKING_OMITTED_MARKER };
      excess -= size - OMITTED_MARKER_BYTES;
    } else {
      // The tail of this one fits what is left. One that already starts with
      // the marker (cut when it was a single burst) loses it with its head:
      // the cut is longer than the marker.
      // (`text` is longer than `kept`, so capTailByBytes always cuts it.)
      out[index] = {
        ...step,
        text: capTailByBytes(text, kept, OMITTED_PREFIX),
      };
      excess = 0;
    }
  }
  return out;
}

// ── Reading what was stored ──────────────────────────────────────────────

const STEP_KINDS: ReadonlySet<string> = new Set<StepKind>([
  'thinking',
  'tool',
  'task',
  'text',
]);
const STEP_STATUSES: ReadonlySet<string> = new Set<StepStatus>([
  'running',
  'done',
  'error',
]);

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

const FACT_COUNTS = [
  'added',
  'removed',
  'lines',
  'totalLines',
  'files',
  'matches',
  'exitCode',
  'httpCode',
  'bytes',
  'searches',
  'durationMs',
] as const;
const AGENT_FACT_COUNTS = [
  'toolUses',
  'reads',
  'searches',
  'edits',
  'commands',
  'added',
  'removed',
  'tokens',
  'durationMs',
] as const;

function readCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

/**
 * The facts of a stored tool step: whole non-negative numbers under the keys
 * of the contract and the one boolean, nothing else. Stored JSON is not
 * trusted to be what the recorder wrote.
 */
function readResultFacts(raw: unknown): ToolResultFacts | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return undefined;
  }
  const row = raw as Record<string, unknown>;
  const facts: ToolResultFacts = {};
  for (const key of FACT_COUNTS) {
    const count = readCount(row[key]);
    if (count !== undefined) facts[key] = count;
  }
  if (typeof row.created === 'boolean') facts.created = row.created;
  if (
    typeof row.agent === 'object' &&
    row.agent !== null &&
    !Array.isArray(row.agent)
  ) {
    const agentRow = row.agent as Record<string, unknown>;
    const agent: NonNullable<ToolResultFacts['agent']> = {};
    for (const key of AGENT_FACT_COUNTS) {
      const count = readCount(agentRow[key]);
      if (count !== undefined) agent[key] = count;
    }
    if (Object.keys(agent).length > 0) facts.agent = agent;
  }
  return Object.keys(facts).length > 0 ? facts : undefined;
}

/** A stored step with only the fields of the contract, or null if unusable. */
function readStep(raw: unknown): StreamingStep | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const row = raw as Record<string, unknown>;
  if (
    typeof row.id !== 'string' ||
    typeof row.kind !== 'string' ||
    !STEP_KINDS.has(row.kind) ||
    typeof row.status !== 'string' ||
    !STEP_STATUSES.has(row.status) ||
    !isFiniteNumber(row.at)
  ) {
    return null;
  }
  const step: StreamingStep = {
    id: row.id,
    kind: row.kind as StepKind,
    at: row.at,
    status: row.status as StepStatus,
  };
  if (isFiniteNumber(row.endedAt)) step.endedAt = row.endedAt;
  if (isFiniteNumber(row.durationMs)) step.durationMs = row.durationMs;
  if (isFiniteNumber(row.from)) step.from = row.from;
  if (row.commentary === true) step.commentary = true;
  if (row.progress === true) step.progress = true;
  if (row.outcome === 'stopped' || row.outcome === 'denied') {
    step.outcome = row.outcome;
  }
  for (const key of [
    'text',
    'title',
    'toolUseId',
    'toolName',
    'skillName',
    'summary',
    'resultPreview',
    'taskId',
  ] as const) {
    if (typeof row[key] === 'string') step[key] = row[key] as string;
  }
  const facts = readResultFacts(row.resultFacts);
  if (facts) step.resultFacts = facts;
  // Stored questions are re-read with the same bounds as live input.
  const questions =
    step.toolName === QUESTION_TOOL_NAME
      ? readStepQuestions({ questions: row.questions })
      : undefined;
  if (questions) step.questions = questions;
  return boundStep(step);
}

/** The steps of a stored row; damaged JSON or rows read as no steps. */
export function parseStoredSteps(json: string): StreamingStep[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const steps: StreamingStep[] = [];
  for (const raw of parsed) {
    const step = readStep(raw);
    if (step) steps.push(step);
  }
  // The Web keys steps by id: bounding a long one must not make two the same.
  return withUniqueIds(steps);
}
