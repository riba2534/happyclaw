import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  TOOL_STATE,
  ToolStateIcon,
  countToolStates,
  describeProblems,
  stepToolState,
  taskStatusState,
  taskToolState,
  worstProblem,
} from '../src/components/chat/tool-status';
import type { StreamingStep } from '../src/lib/stream-steps';
import type { StreamingTaskRuntimeState } from '../src/stores/chat';

const tool = (over: Partial<StreamingStep> = {}): StreamingStep => ({
  id: 'tool-a',
  kind: 'tool',
  at: 0,
  status: 'done',
  toolName: 'Bash',
  ...over,
});

describe('stepToolState', () => {
  it('reads a step as one state', () => {
    expect(stepToolState(tool())).toBe('done');
    expect(stepToolState(tool({ status: 'running' }))).toBe('running');
    // Its card is no longer the live one: the run never closed it.
    expect(stepToolState(tool({ status: 'running' }), false)).toBe(
      'unfinished',
    );
    expect(stepToolState(tool({ status: 'error' }))).toBe('error');
    expect(stepToolState(tool({ status: 'error', outcome: 'denied' }))).toBe(
      'denied',
    );
    expect(stepToolState(tool({ status: 'error', outcome: 'stopped' }))).toBe(
      'stopped',
    );
    // Stored before the outcome was kept.
    expect(
      stepToolState(tool({ status: 'error', resultPreview: '已停止' })),
    ).toBe('stopped');
  });

  it('reads a sub-agent from its lifecycle unless it was cut short', () => {
    const step = tool({ kind: 'task', toolName: 'Task' });
    const task = { status: 'backgrounded' } as StreamingTaskRuntimeState;
    expect(taskToolState(step, task, true)).toBe('background');
    expect(taskToolState(step, task, false)).toBe('unfinished');
    expect(
      taskToolState(
        { ...step, status: 'error', outcome: 'stopped' },
        task,
        false,
      ),
    ).toBe('stopped');
    expect(taskToolState(step, undefined, true)).toBe('done');
    // A stop killed it: its lifecycle says so even where the step does not.
    const stopped = { status: 'stopped' } as StreamingTaskRuntimeState;
    expect(taskStatusState(stopped.status)).toBe('stopped');
    expect(taskToolState(step, stopped, false)).toBe('stopped');
  });
});

describe('problems', () => {
  it('counts calls only, and names what went wrong worst first', () => {
    const counts = countToolStates(
      [
        tool({ status: 'error', outcome: 'stopped' }),
        tool({ status: 'error' }),
        tool({ status: 'error' }),
        tool(),
        { id: 't', kind: 'thinking', at: 0, status: 'done' },
      ],
      false,
    );
    expect(counts.done).toBe(1);
    expect(describeProblems(counts)).toEqual(['2 个失败', '1 个已停止']);
    expect(worstProblem(counts)).toBe('error');
    expect(describeProblems(countToolStates([tool()]))).toEqual([]);
    expect(worstProblem(countToolStates([tool()]))).toBeUndefined();
  });
});

describe('ToolStateIcon', () => {
  it('gives each state one mark in a semantic colour', () => {
    for (const [state, look] of Object.entries(TOOL_STATE)) {
      expect(look.tone).toMatch(
        /^text-(success|warning|error|muted-foreground|faint-foreground)$/,
      );
      expect(look.label).not.toBe('');
      expect(state).toBeTruthy();
    }
  });

  it('spins while running, and not for a reader who asked for less motion', () => {
    const running = renderToStaticMarkup(<ToolStateIcon state="running" />);
    expect(running).toContain('animate-spin');
    expect(running).toContain('motion-reduce:animate-none');
    const failed = renderToStaticMarkup(<ToolStateIcon state="error" />);
    expect(failed).not.toContain('animate-spin');
    expect(failed).toContain('text-error');
  });
});
