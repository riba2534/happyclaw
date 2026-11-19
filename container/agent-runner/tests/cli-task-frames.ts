import type { StreamEventProcessor } from '../src/stream-processor.js';

// Frames the bundled Claude Code 2.1.328 (Agent SDK 0.3.328) sent against a
// local stub upstream, trimmed to the system frames and the main Agent's tool
// calls. A Bash under ~3s registers no task at all; a longer foreground one
// sends task_started then task_notification with no task_updated; a
// foreground sub-agent (and any background task) sends its terminal
// task_updated before its task_notification; background tasks join the level
// before task_started and leave it after task_notification. Agents run in the
// background unless the call says run_in_background: false.
export type Frame = Record<string, unknown>;

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

export const FOREGROUND_BASH: Frame[] = [
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

export const INTERRUPTED_FOREGROUND_BASH: Frame[] = [
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

export const FOREGROUND_AGENT: Frame[] = [
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

export const INTERRUPTED_FOREGROUND_AGENT: Frame[] = [
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

export const BACKGROUND_AGENT_LAUNCH: Frame[] = [
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
export const BACKGROUND_AGENT_FINISH: Frame[] = [
  ...subAgentBash('bud4g0orz', 'aeee6d2a81ea2184c'),
  ...agentEnd('aeee6d2a81ea2184c', 'completed', 'completed'),
  level([]),
];

export const BACKGROUND_BASH_LAUNCH: Frame[] = [
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
export const BACKGROUND_BASH_FINISH: Frame[] = [
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

/** Feed frames the way the runner dispatches them. */
export function replay(p: StreamEventProcessor, frames: Frame[]): void {
  for (const frame of frames) {
    if (frame.type === 'system') p.processSystemMessage(frame);
    else p.processAssistantMessage(frame);
  }
}
