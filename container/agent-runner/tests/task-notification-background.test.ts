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

// Frames the bundled Claude Code 2.1.328 (Agent SDK 0.3.328) sent against a
// local stub upstream, trimmed to the system frames and the main Agent's tool
// calls. A Bash under ~3s registers no task at all; a longer foreground one
// sends task_started then task_notification with no task_updated; a
// foreground sub-agent (and any background task) sends its terminal
// task_updated before its task_notification; background tasks join the level
// before task_started and leave it after task_notification. Agents run in the
// background unless the call says run_in_background: false.
type Frame = Record<string, unknown>;

const mainCall = (
  id: string,
  name: string,
  input: Record<string, unknown>,
): Frame => ({
  type: 'assistant',
  parent_tool_use_id: null,
  message: {
    id: `msg_${id}`,
    content: [{ type: 'tool_use', id, name, input }],
  },
});
const sys = (subtype: string, fields: Frame): Frame => ({
  type: 'system',
  subtype,
  ...fields,
});

const FOREGROUND_BASH: Frame[] = [
  mainCall('toolu_main_bash_1', 'Bash', {
    command: 'sleep 3 && echo slept',
    description: 'Sleep three seconds',
  }),
  sys('task_started', {
    task_id: 'bd9jawq4i',
    tool_use_id: 'toolu_main_bash_1',
    task_type: 'local_bash',
    is_backgrounded: false,
    description: 'Sleep three seconds',
  }),
  sys('task_notification', {
    task_id: 'bd9jawq4i',
    tool_use_id: 'toolu_main_bash_1',
    status: 'completed',
    summary: 'Sleep three seconds',
    output_file: '',
  }),
];

const INTERRUPTED_FOREGROUND_BASH: Frame[] = [
  mainCall('toolu_main_bash_1', 'Bash', {
    command: 'sleep 20 && echo slept',
    description: 'Sleep three seconds',
  }),
  sys('task_started', {
    task_id: 'bwmg0stzf',
    tool_use_id: 'toolu_main_bash_1',
    task_type: 'local_bash',
    is_backgrounded: false,
    description: 'Sleep three seconds',
  }),
  sys('task_notification', {
    task_id: 'bwmg0stzf',
    tool_use_id: 'toolu_main_bash_1',
    status: 'stopped',
    summary: 'Sleep three seconds',
    output_file: '',
  }),
];

const subAgentBash = (taskId: string, parentTaskId: string): Frame[] => [
  sys('task_started', {
    task_id: taskId,
    tool_use_id: `toolu_sub_${taskId}`,
    task_type: 'local_bash',
    is_backgrounded: false,
    parent_task_id: parentTaskId,
    owned_by_subagent: true,
    description: 'Sub sleep three seconds',
  }),
  sys('task_notification', {
    task_id: taskId,
    tool_use_id: `toolu_sub_${taskId}`,
    status: 'completed',
    summary: 'Sub sleep three seconds',
    output_file: '',
  }),
];

const agentStart = (taskId: string, isBackgrounded: boolean): Frame =>
  sys('task_started', {
    task_id: taskId,
    tool_use_id: 'toolu_main_agent_1',
    task_type: 'local_agent',
    is_backgrounded: isBackgrounded,
    spawn_depth: 1,
    description: 'Probe sub-agent',
  });
const agentEnd = (
  taskId: string,
  updated: string,
  notified: string,
): Frame[] => [
  sys('task_updated', {
    task_id: taskId,
    patch: { status: updated, end_time: 1795117566570 },
  }),
  sys('task_notification', {
    task_id: taskId,
    tool_use_id: 'toolu_main_agent_1',
    status: notified,
    summary: 'PROBE_DONE',
    output_file: `/nonexistent/tasks/${taskId}.output`,
  }),
];
const agentProgress = (taskId: string): Frame =>
  sys('task_progress', {
    task_id: taskId,
    tool_use_id: 'toolu_main_agent_1',
    description: 'Running Sub sleep three seconds',
  });

const FOREGROUND_AGENT: Frame[] = [
  mainCall('toolu_main_agent_1', 'Agent', {
    description: 'Probe sub-agent',
    prompt: 'PROBE_SUB: run the sleep and report',
    subagent_type: 'general-purpose',
    run_in_background: false,
  }),
  agentStart('a77d073083acbc31e', false),
  agentProgress('a77d073083acbc31e'),
  ...subAgentBash('b8zis0frc', 'a77d073083acbc31e'),
  ...agentEnd('a77d073083acbc31e', 'completed', 'completed'),
];

const INTERRUPTED_FOREGROUND_AGENT: Frame[] = [
  mainCall('toolu_main_agent_1', 'Agent', {
    description: 'Probe sub-agent',
    prompt: 'PROBE_SUB: run the sleep and report',
    subagent_type: 'general-purpose',
    run_in_background: false,
  }),
  agentStart('aa09405e122d52d89', false),
  agentProgress('aa09405e122d52d89'),
  sys('task_started', {
    task_id: 'bd61okdd3',
    tool_use_id: 'toolu_sub_bd61okdd3',
    task_type: 'local_bash',
    is_backgrounded: false,
    parent_task_id: 'aa09405e122d52d89',
    owned_by_subagent: true,
    description: 'Sub sleep three seconds',
  }),
  sys('task_notification', {
    task_id: 'bd61okdd3',
    tool_use_id: 'toolu_sub_bd61okdd3',
    status: 'stopped',
    summary: 'Sub sleep three seconds',
    output_file: '',
  }),
  ...agentEnd('aa09405e122d52d89', 'killed', 'stopped'),
];

const level = (tasks: Frame[]): Frame =>
  sys('background_tasks_changed', { tasks });

const BACKGROUND_AGENT_LAUNCH: Frame[] = [
  mainCall('toolu_main_agent_1', 'Agent', {
    description: 'Probe sub-agent',
    prompt: 'PROBE_SUB: run the sleep and report',
    subagent_type: 'general-purpose',
  }),
  level([
    {
      task_id: 'aeee6d2a81ea2184c',
      task_type: 'local_agent',
      subagent_type: 'general-purpose',
      description: 'Probe sub-agent',
    },
  ]),
  agentStart('aeee6d2a81ea2184c', true),
  agentProgress('aeee6d2a81ea2184c'),
];
const BACKGROUND_AGENT_FINISH: Frame[] = [
  ...subAgentBash('bud4g0orz', 'aeee6d2a81ea2184c'),
  ...agentEnd('aeee6d2a81ea2184c', 'completed', 'completed'),
  level([]),
];

const BACKGROUND_BASH_LAUNCH: Frame[] = [
  mainCall('toolu_main_bgbash_1', 'Bash', {
    command: 'sleep 3 && echo bg-slept',
    description: 'Background sleep',
    run_in_background: true,
  }),
  level([
    {
      task_id: 'bo79ncb51',
      task_type: 'local_bash',
      description: 'Background sleep',
    },
  ]),
  sys('task_started', {
    task_id: 'bo79ncb51',
    tool_use_id: 'toolu_main_bgbash_1',
    task_type: 'local_bash',
    is_backgrounded: true,
    description: 'Background sleep',
  }),
];
const BACKGROUND_BASH_FINISH: Frame[] = [
  sys('task_updated', {
    task_id: 'bo79ncb51',
    patch: { status: 'completed', end_time: 1795117578123 },
  }),
  sys('task_notification', {
    task_id: 'bo79ncb51',
    tool_use_id: 'toolu_main_bgbash_1',
    status: 'completed',
    summary: 'Background command "Background sleep" completed (exit code 0)',
    output_file: '/nonexistent/tasks/bo79ncb51.output',
  }),
  level([]),
];

function replay(p: StreamEventProcessor, frames: Frame[]): void {
  for (const frame of frames) {
    if (frame.type === 'system') p.processSystemMessage(frame);
    else p.processAssistantMessage(frame);
  }
}

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
