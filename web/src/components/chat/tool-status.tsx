import {
  Check,
  CircleDashed,
  CircleStop,
  Loader2,
  ShieldX,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { StreamingTaskRuntimeState } from '../../stores/chat';
import type { StreamingStep } from '../../lib/stream-steps';

/**
 * The states a tool call or a sub-agent is drawn in, each with one mark, one
 * colour and one word, wherever it is drawn (a timeline row, a classic tool
 * row, a sub-agent card).
 */
export type ToolState =
  | 'running'
  | 'background'
  | 'done'
  | 'error'
  | 'stopped'
  | 'denied'
  | 'unfinished';

interface ToolStateLook {
  icon: LucideIcon;
  /** A semantic colour token. */
  tone: string;
  /** Spoken after the row, and the sub-agent card's status word. */
  label: string;
  /** The mark moves (and stops for a reader who asked for less motion). */
  spin?: boolean;
  /**
   * Nothing to look at: a row with a mark of its own (the kind of tool) keeps
   * it rather than this one.
   */
  quiet?: boolean;
}

export const TOOL_STATE: Record<ToolState, ToolStateLook> = {
  running: {
    icon: Loader2,
    tone: 'text-muted-foreground',
    label: '运行中',
    spin: true,
  },
  background: {
    icon: Loader2,
    tone: 'text-muted-foreground',
    label: '后台执行',
    spin: true,
  },
  done: { icon: Check, tone: 'text-success', label: '已完成', quiet: true },
  error: { icon: X, tone: 'text-error', label: '失败' },
  stopped: { icon: CircleStop, tone: 'text-warning', label: '已中断' },
  denied: { icon: ShieldX, tone: 'text-error', label: '已拒绝' },
  unfinished: {
    icon: CircleDashed,
    tone: 'text-faint-foreground',
    label: '未完成',
    quiet: true,
  },
};

/** The states that say something went wrong: a folded process names them. */
export const PROBLEM_STATES = ['error', 'denied', 'stopped'] as const;

/** How a failed step ended: by itself, by a stop, or by a denial. */
function failureState(step: StreamingStep): ToolState {
  if (step.outcome) return step.outcome;
  // Steps stored before the outcome was kept: a stop left only its word.
  return step.resultPreview === '已停止' ? 'stopped' : 'error';
}

/**
 * A step's state. `live`: the run is producing its card now, so what is
 * running is running; otherwise a running step is one the run never closed.
 */
export function stepToolState(step: StreamingStep, live = true): ToolState {
  if (step.status === 'running') return live ? 'running' : 'unfinished';
  return step.status === 'error' ? failureState(step) : 'done';
}

/** A sub-agent's state from its own lifecycle. */
export function taskStatusState(
  status: StreamingTaskRuntimeState['status'],
  live = true,
): ToolState {
  switch (status) {
    case 'running':
      return live ? 'running' : 'unfinished';
    case 'backgrounded':
      return live ? 'background' : 'unfinished';
    case 'error':
      return 'error';
    case 'stopped':
      return 'stopped';
    case 'completed':
      return 'done';
  }
}

/** A sub-agent's step's state: its lifecycle's, when there is one, unless it was cut short. */
export function taskToolState(
  step: StreamingStep,
  task: StreamingTaskRuntimeState | undefined,
  live: boolean,
): ToolState {
  if (step.status === 'error') return failureState(step);
  return task ? taskStatusState(task.status, live) : stepToolState(step, live);
}

/** The state's mark, in its colour. */
export function ToolStateIcon({
  state,
  className,
}: {
  state: ToolState;
  className?: string;
}) {
  const { icon: Icon, tone, spin } = TOOL_STATE[state];
  return (
    <Icon
      aria-hidden="true"
      data-tool-state={state}
      className={cn(
        'size-3.5 shrink-0',
        tone,
        spin && 'animate-spin motion-reduce:animate-none',
        className,
      )}
    />
  );
}

/** How many of the tool calls and sub-agents among the steps are in each state. */
export function countToolStates(
  steps: readonly StreamingStep[],
  live = true,
): Record<ToolState, number> {
  const counts: Record<ToolState, number> = {
    running: 0,
    background: 0,
    done: 0,
    error: 0,
    stopped: 0,
    denied: 0,
    unfinished: 0,
  };
  for (const step of steps) {
    if (step.kind === 'tool' || step.kind === 'task') {
      counts[stepToolState(step, live)] += 1;
    }
  }
  return counts;
}

const PROBLEM_WORDS: Record<(typeof PROBLEM_STATES)[number], string> = {
  error: '个失败',
  denied: '个被拒绝',
  stopped: '个已中断',
};

/** "2 个失败 · 1 个已中断": what went wrong, worst first; empty when nothing did. */
export function describeProblems(
  counts: Readonly<Record<ToolState, number>>,
): string[] {
  return PROBLEM_STATES.filter((state) => counts[state] > 0).map(
    (state) => `${counts[state]} ${PROBLEM_WORDS[state]}`,
  );
}

/** The worst thing that happened to the steps, if anything went wrong. */
export function worstProblem(
  counts: Readonly<Record<ToolState, number>>,
): (typeof PROBLEM_STATES)[number] | undefined {
  return PROBLEM_STATES.find((state) => counts[state] > 0);
}
