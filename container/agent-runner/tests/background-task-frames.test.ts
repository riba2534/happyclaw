import { describe, expect, test } from 'vitest';

import { StreamEventProcessor } from '../src/stream-processor.js';
import {
  BACKGROUND_AGENT_FINISH,
  BACKGROUND_AGENT_LAUNCH,
  BACKGROUND_BASH_FINISH,
  BACKGROUND_BASH_LAUNCH,
  FOREGROUND_AGENT,
  FOREGROUND_BASH,
  type Frame,
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

// The level and task_started of a background Bash, in the other order.
const BACKGROUND_BASH_STARTED_FIRST: Frame[] = [
  BACKGROUND_BASH_LAUNCH[0],
  BACKGROUND_BASH_LAUNCH[2],
  BACKGROUND_BASH_LAUNCH[1],
];

describe('what holds the result on measured Claude Code 2.1.328 frames', () => {
  test.each([
    ['level first', BACKGROUND_BASH_LAUNCH],
    ['task_started first', BACKGROUND_BASH_STARTED_FIRST],
  ])(
    'a background Bash (%s) holds nothing and owes nothing',
    (_order, launch) => {
      const { processor } = makeProcessor();
      replay(processor, launch);
      expect(processor.getPendingSdkTaskCount()).toBe(1);
      expect(holds(processor)).toEqual({ pendingBgTasks: 0, protocol: 0 });
      replay(processor, BACKGROUND_BASH_FINISH);
      expect(processor.getPendingSdkTaskCount()).toBe(0);
      expect(holds(processor)).toEqual({ pendingBgTasks: 0, protocol: 0 });
    },
  );

  test('a Bash already in the background level stays detached when task_started does not say', () => {
    const { processor } = makeProcessor();
    const [call, joined, started] = BACKGROUND_BASH_LAUNCH;
    const { is_backgrounded: _stated, ...unstated } = started;
    replay(processor, [call, joined, unstated]);
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
