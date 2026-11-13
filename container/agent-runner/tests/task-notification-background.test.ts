import { describe, expect, test } from 'vitest';

import { StreamEventProcessor } from '../src/stream-processor.js';

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

describe('task_notification isBackground', () => {
  test('a foreground Bash task completion is not a background notice', () => {
    const [event] = notices((p) => {
      p.processSystemMessage(started({ is_backgrounded: false }));
      p.processSystemMessage(notification);
    });
    expect(event.isBackground).toBe(false);
  });

  test('a task started in the background is a background notice', () => {
    const [event] = notices((p) => {
      p.processSystemMessage(started({ is_backgrounded: true }));
      p.processSystemMessage(notification);
    });
    expect(event.isBackground).toBe(true);
  });

  test('a foreground task moved to the background is a background notice', () => {
    const [event] = notices((p) => {
      p.processSystemMessage(started());
      p.processSystemMessage({
        type: 'system',
        subtype: 'task_updated',
        task_id: 'task-a',
        patch: { is_backgrounded: true },
      });
      p.processSystemMessage(notification);
    });
    expect(event.isBackground).toBe(true);
  });

  test('a task listed in background_tasks_changed is a background notice', () => {
    const [event] = notices((p) => {
      p.processSystemMessage(started({ task_type: 'local_workflow' }));
      p.processSystemMessage({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ task_id: 'task-a', task_type: 'local_workflow' }],
      });
      p.processSystemMessage(notification);
    });
    expect(event.isBackground).toBe(true);
  });

  test('an unregistered task (e.g. from before a restart) stays a background notice', () => {
    const [event] = notices((p) => {
      p.processSystemMessage(notification);
    });
    expect(event.isBackground).toBe(true);
  });
});
