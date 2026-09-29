import type { RegisteredGroup, ScheduledTask } from './types.js';

export const SCRIPT_TASK_HOST_REQUIRED_ERROR =
  '脚本任务只能在管理员宿主机工作区中以 host 模式执行。';

/**
 * The execution boundary a task targeting `target` actually runs in.
 *
 * An IM chat routed into a home workspace keeps its own registered_groups row,
 * whose executionMode is whatever default it was created with. Messages from
 * that chat already run with the home sibling's mode (resolveEffectiveGroup),
 * so task validation must use the same answer; otherwise a task scheduled from
 * the chat silently lands in a different boundary than the chat itself.
 */
export function resolveWorkspaceExecutionMode(
  target: RegisteredGroup,
  groups: Record<string, RegisteredGroup>,
): 'host' | 'container' {
  if (!target.is_home) {
    const home = Object.values(groups).find(
      (group) => group.is_home && group.folder === target.folder,
    );
    if (home) return home.executionMode === 'host' ? 'host' : 'container';
  }
  return target.executionMode === 'host' ? 'host' : 'container';
}

export function getScriptTaskHostExecutionError(
  task: Pick<
    ScheduledTask,
    'execution_type' | 'execution_mode' | 'chat_jid' | 'group_folder'
  >,
  groups: Record<string, RegisteredGroup>,
): string | null {
  if (task.execution_type !== 'script') return null;
  if (task.execution_mode !== 'host') {
    return SCRIPT_TASK_HOST_REQUIRED_ERROR;
  }
  const target = groups[task.chat_jid];
  if (
    !target ||
    target.folder !== task.group_folder ||
    resolveWorkspaceExecutionMode(target, groups) !== 'host'
  ) {
    return SCRIPT_TASK_HOST_REQUIRED_ERROR;
  }
  return null;
}

export function resolveTaskExecutionModeForTarget(
  targetMode: 'host' | 'container' | undefined,
  requestedMode: 'host' | 'container' | undefined,
): 'host' | 'container' {
  const normalizedTarget = targetMode === 'host' ? 'host' : 'container';
  if (requestedMode === 'host' && normalizedTarget !== 'host') {
    throw new Error(
      'Target workspace runs in container mode; host execution is not allowed.',
    );
  }
  return requestedMode ?? normalizedTarget;
}
