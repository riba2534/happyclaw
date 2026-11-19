import { describe, expect, test } from 'vitest';

import { StreamEventProcessor } from '../src/stream-processor.js';
import {
  BACKGROUND_AGENT_FINISH,
  BACKGROUND_AGENT_LAUNCH,
  BACKGROUND_BASH_FINISH,
  BACKGROUND_BASH_LAUNCH,
  FOREGROUND_AGENT,
  FOREGROUND_BASH,
  replay,
} from './cli-task-frames.js';

function makeProcessor() {
  const events: any[] = [];
  const processor = new StreamEventProcessor(
    (output: any) => {
      if (output?.streamEvent) events.push(output.streamEvent);
    },
    () => {},
  );
  return { processor, events };
}

function holds(p: StreamEventProcessor) {
  return {
    pendingBgTasks: p.getBlockingPendingSdkTaskCount(),
    protocol: p.getBlockingBackgroundProtocolCount(),
  };
}

const synthesizedCompletions = (events: any[]) =>
  events
    .filter(
      (event) => event.eventType === 'task_notification' && event.isSynthetic,
    )
    .map((event) => event.toolUseId);

describe('what holds the result on measured Claude Code 2.1.328 frames', () => {
  test('a run_in_background Bash holds the result until the main Agent sums it up', () => {
    const { processor } = makeProcessor();
    replay(processor, BACKGROUND_BASH_LAUNCH);
    expect(holds(processor)).toEqual({ pendingBgTasks: 1, protocol: 1 });
    replay(processor, BACKGROUND_BASH_FINISH);
    expect(processor.getPendingSdkTaskCount()).toBe(0);
    expect(processor.getBlockingBackgroundCompletionDebtCount()).toBe(1);
    expect(holds(processor)).toEqual({ pendingBgTasks: 0, protocol: 1 });
  });

  test('a foreground Bash moved to the background later is detached and owes nothing', () => {
    const { processor } = makeProcessor();
    const [call, started] = FOREGROUND_BASH;
    replay(processor, [call, started]);
    expect(holds(processor)).toEqual({ pendingBgTasks: 1, protocol: 1 });
    const taskId = started.task_id;
    processor.processSystemMessage({
      type: 'system',
      subtype: 'task_updated',
      task_id: taskId,
      patch: { is_backgrounded: true },
    });
    expect(processor.getPendingSdkTaskCount()).toBe(1);
    expect(holds(processor)).toEqual({ pendingBgTasks: 0, protocol: 0 });
    processor.processSystemMessage({
      type: 'system',
      subtype: 'task_updated',
      task_id: taskId,
      patch: { status: 'completed' },
    });
    processor.processSystemMessage({
      type: 'system',
      subtype: 'task_notification',
      task_id: taskId,
      tool_use_id: started.tool_use_id,
      status: 'completed',
      summary: 'done',
      output_file: '',
    });
    expect(holds(processor)).toEqual({ pendingBgTasks: 0, protocol: 0 });
  });

  test('a background sub-agent still holds the result until the main Agent sums it up', () => {
    const { processor } = makeProcessor();
    replay(processor, BACKGROUND_AGENT_LAUNCH);
    expect(holds(processor)).toEqual({ pendingBgTasks: 1, protocol: 1 });
    replay(processor, BACKGROUND_AGENT_FINISH);
    expect(processor.getBlockingBackgroundCompletionDebtCount()).toBe(1);
    expect(holds(processor)).toEqual({ pendingBgTasks: 0, protocol: 1 });
  });

  test.each([
    ['Bash', FOREGROUND_BASH, 2],
    ['sub-agent', FOREGROUND_AGENT, 3],
  ])(
    'a running foreground %s still counts as live work',
    (_kind, frames, launched) => {
      const { processor } = makeProcessor();
      replay(processor, frames.slice(0, launched));
      expect(holds(processor).pendingBgTasks).toBe(1);
      replay(processor, frames.slice(launched));
      expect(holds(processor).pendingBgTasks).toBe(0);
    },
  );
});

describe('safety net on measured Claude Code 2.1.328 frames', () => {
  test.each([
    ['a sub-agent launched without run_in_background', BACKGROUND_AGENT_LAUNCH],
    ['a background Bash', BACKGROUND_BASH_LAUNCH],
  ])(
    'does not report %s as completed when the query ends early',
    (_name, launch) => {
      const { processor, events } = makeProcessor();
      replay(processor, launch);
      processor.cleanup();
      expect(synthesizedCompletions(events)).toEqual([]);
    },
  );

  test('still closes out a foreground sub-agent whose completion never came', () => {
    const { processor, events } = makeProcessor();
    replay(processor, FOREGROUND_AGENT.slice(0, 3));
    processor.cleanup();
    expect(synthesizedCompletions(events)).toEqual(['toolu_main_agent_1']);
  });

  test('a tool_use_summary does not complete a sub-agent running in the background', () => {
    const { processor, events } = makeProcessor();
    replay(processor, BACKGROUND_AGENT_LAUNCH);
    processor.processToolUseSummary({
      type: 'tool_use_summary',
      summary: 'Launched a sub-agent',
      preceding_tool_use_ids: ['toolu_main_agent_1'],
    });
    expect(synthesizedCompletions(events)).toEqual([]);
  });
});
