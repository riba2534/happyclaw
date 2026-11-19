import { describe, expect, test } from 'vitest';

import { StreamEventProcessor } from '../src/stream-processor.js';
import {
  BACKGROUND_AGENT_FINISH,
  BACKGROUND_AGENT_LAUNCH,
  BACKGROUND_BASH_FINISH,
  BACKGROUND_BASH_LAUNCH,
  FOREGROUND_AGENT,
  FOREGROUND_BASH,
  INTERRUPTED_FOREGROUND_AGENT,
  INTERRUPTED_FOREGROUND_BASH,
  replay,
} from './cli-task-frames.js';

function notices(setup: (p: StreamEventProcessor) => void) {
  const events: any[] = [];
  const processor = new StreamEventProcessor(
    (output: any) => {
      if (output?.streamEvent?.eventType === 'task_notification') {
        events.push(output.streamEvent);
      }
    },
    () => {},
  );
  setup(processor);
  return events;
}

/** The per-task background state the processor still remembers. */
const remembered = (p: StreamEventProcessor) =>
  (p as unknown as { taskRanInBackground: Map<string, boolean> })
    .taskRanInBackground;

const started = (extra: Record<string, unknown> = {}) => ({
  type: 'system',
  subtype: 'task_started',
  task_id: 'task-a',
  tool_use_id: 'toolu_a',
  task_type: 'local_bash',
  description: 'git fetch',
  ...extra,
});

const notification = {
  type: 'system',
  subtype: 'task_notification',
  task_id: 'task-a',
  tool_use_id: 'toolu_a',
  status: 'completed',
  summary: 'done',
  output_file: '/tmp/out',
};

const agentCall = (input: Record<string, unknown>) => ({
  type: 'assistant',
  parent_tool_use_id: null,
  message: {
    id: 'msg_agent',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_a',
        name: 'Agent',
        input: { description: 'Look around', prompt: 'look', ...input },
      },
    ],
  },
});

describe('task_notification isBackground', () => {
  test('a foreground Bash task completion is not a background notice', () => {
    const [event] = notices((p) => {
      p.processSystemMessage(started({ is_backgrounded: false }));
      p.processSystemMessage(notification);
    });
    expect(event.isBackground).toBe(false);
  });

  test('a foreground task whose terminal task_updated comes first is not a background notice', () => {
    const [event] = notices((p) => {
      p.processSystemMessage(
        started({ task_type: 'local_agent', is_backgrounded: false }),
      );
      p.processSystemMessage({
        type: 'system',
        subtype: 'task_updated',
        task_id: 'task-a',
        patch: { status: 'completed', end_time: 1 },
      });
      p.processSystemMessage(notification);
    });
    expect(event.isBackground).toBe(false);
  });

  test('a task started in the background is a background notice', () => {
    const [event] = notices((p) => {
      p.processSystemMessage(started({ is_backgrounded: true }));
      p.processSystemMessage({
        type: 'system',
        subtype: 'task_updated',
        task_id: 'task-a',
        patch: { status: 'completed' },
      });
      p.processSystemMessage(notification);
    });
    expect(event.isBackground).toBe(true);
  });

  test('a foreground task moved to the background is a background notice', () => {
    const [event] = notices((p) => {
      p.processSystemMessage(started({ is_backgrounded: false }));
      p.processSystemMessage({
        type: 'system',
        subtype: 'task_updated',
        task_id: 'task-a',
        patch: { is_backgrounded: true },
      });
      p.processSystemMessage({
        type: 'system',
        subtype: 'task_updated',
        task_id: 'task-a',
        patch: { status: 'completed' },
      });
      p.processSystemMessage(notification);
    });
    expect(event.isBackground).toBe(true);
  });

  test('a foreground task that joins the background level is a background notice', () => {
    const [event] = notices((p) => {
      p.processSystemMessage(
        started({ task_type: 'local_agent', is_backgrounded: false }),
      );
      p.processSystemMessage({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ task_id: 'task-a', task_type: 'local_agent' }],
      });
      p.processSystemMessage({
        type: 'system',
        subtype: 'task_updated',
        task_id: 'task-a',
        patch: { status: 'completed' },
      });
      p.processSystemMessage(notification);
    });
    expect(event.isBackground).toBe(true);
  });

  test('a task already in the background level when it starts is a background notice', () => {
    const [event] = notices((p) => {
      p.processSystemMessage({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ task_id: 'task-a', task_type: 'local_workflow' }],
      });
      p.processSystemMessage(
        started({ task_type: 'local_workflow', is_backgrounded: false }),
      );
      p.processSystemMessage(notification);
    });
    expect(event.isBackground).toBe(true);
  });

  test('an Agent call that asked for run_in_background is a background notice', () => {
    const [event] = notices((p) => {
      p.processAssistantMessage(agentCall({ run_in_background: true }));
      p.processSystemMessage(
        started({ task_type: 'local_agent', is_backgrounded: false }),
      );
      p.processSystemMessage(notification);
    });
    expect(event.isBackground).toBe(true);
  });

  test('an Agent call that asked to run in the foreground is not a background notice', () => {
    const [event] = notices((p) => {
      p.processAssistantMessage(agentCall({ run_in_background: false }));
      p.processSystemMessage(
        started({ task_type: 'local_agent', is_backgrounded: false }),
      );
      p.processSystemMessage({
        type: 'system',
        subtype: 'task_updated',
        task_id: 'task-a',
        patch: { status: 'completed' },
      });
      p.processSystemMessage(notification);
    });
    expect(event.isBackground).toBe(false);
  });

  test('a housekeeping (skip_transcript) task is not a background notice', () => {
    const [event] = notices((p) => {
      p.processSystemMessage(
        started({ is_backgrounded: true, skip_transcript: true }),
      );
      p.processSystemMessage({ ...notification, skip_transcript: true });
    });
    expect(event.isBackground).toBe(false);
  });

  test('an ambient task (a live-update watcher) is not a background notice', () => {
    const [event] = notices((p) => {
      p.processSystemMessage({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ task_id: 'task-a', task_type: 'monitor_mcp', ambient: true }],
      });
      p.processSystemMessage(
        started({ task_type: 'monitor_mcp', ambient: true }),
      );
      p.processSystemMessage({ ...notification, ambient: true });
    });
    expect(event.isBackground).toBe(false);
  });

  test('an unregistered task (e.g. from before a restart) stays a background notice', () => {
    const [event] = notices((p) => {
      p.processSystemMessage(notification);
    });
    expect(event.isBackground).toBe(true);
  });

  test('a task whose start states no is_backgrounded stays a background notice', () => {
    const [event] = notices((p) => {
      p.processSystemMessage(started({ task_type: 'local_workflow' }));
      p.processSystemMessage({
        type: 'system',
        subtype: 'task_updated',
        task_id: 'task-a',
        patch: { status: 'completed' },
      });
      p.processSystemMessage(notification);
    });
    expect(event.isBackground).toBe(true);
  });

  test('remembers a bounded number of tasks, forgetting the oldest first', () => {
    let processor!: StreamEventProcessor;
    const events = notices((p) => {
      processor = p;
      p.processSystemMessage(started({ is_backgrounded: false }));
      // Foreground tasks that never notify, e.g. nested sub-agents that
      // ended with their parent.
      for (let i = 0; i < 300; i++) {
        p.processSystemMessage(
          started({
            task_id: `quiet-${i}`,
            tool_use_id: `toolu_quiet_${i}`,
            is_backgrounded: false,
          }),
        );
      }
      p.processSystemMessage(notification);
      p.processSystemMessage({
        ...notification,
        task_id: 'quiet-299',
        tool_use_id: 'toolu_quiet_299',
      });
    });
    expect(events.map((event) => event.isBackground)).toEqual([true, false]);
    expect(remembered(processor).size).toBeLessThanOrEqual(256);
    expect(remembered(processor).has('quiet-299')).toBe(false);
  });
});

describe('task_notification isBackground on measured Claude Code 2.1.328 frames', () => {
  test.each([
    ['a foreground Bash', FOREGROUND_BASH, [false]],
    ['an interrupted foreground Bash', INTERRUPTED_FOREGROUND_BASH, [false]],
    ['a foreground sub-agent running a Bash', FOREGROUND_AGENT, [false, false]],
    [
      'an interrupted foreground sub-agent',
      INTERRUPTED_FOREGROUND_AGENT,
      [false, false],
    ],
  ])(
    '%s announces no background completion and still settles',
    (_name, frames, expected) => {
      let processor!: StreamEventProcessor;
      const events = notices((p) => {
        processor = p;
        replay(p, frames);
      });
      expect(events.map((event) => event.isBackground)).toEqual(expected);
      expect(processor.getPendingSdkTaskCount()).toBe(0);
      expect(remembered(processor).size).toBe(0);
    },
  );

  test('a background sub-agent announces its completion, its own foreground Bash does not', () => {
    let processor!: StreamEventProcessor;
    let pendingAfterLaunch = -1;
    const events = notices((p) => {
      processor = p;
      replay(p, BACKGROUND_AGENT_LAUNCH);
      pendingAfterLaunch = p.getPendingSdkTaskCount();
      replay(p, BACKGROUND_AGENT_FINISH);
    });
    expect(events.map((event) => [event.taskId, event.isBackground])).toEqual([
      ['toolu_sub_bud4g0orz', false],
      ['toolu_main_agent_1', true],
    ]);
    expect(pendingAfterLaunch).toBe(1);
    expect(processor.getPendingSdkTaskCount()).toBe(0);
    expect(remembered(processor).size).toBe(0);
  });

  test('a background Bash announces its completion', () => {
    let processor!: StreamEventProcessor;
    let pendingAfterLaunch = -1;
    const events = notices((p) => {
      processor = p;
      replay(p, BACKGROUND_BASH_LAUNCH);
      pendingAfterLaunch = p.getPendingSdkTaskCount();
      replay(p, BACKGROUND_BASH_FINISH);
    });
    expect(events.map((event) => event.isBackground)).toEqual([true]);
    expect(pendingAfterLaunch).toBe(1);
    expect(processor.getPendingSdkTaskCount()).toBe(0);
    expect(remembered(processor).size).toBe(0);
  });
});
