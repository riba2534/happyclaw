export type TaskExecutionMode = 'host' | 'container';
export type TaskExecutionRole = 'admin' | 'member' | 'guest';

export function getAllowedTaskExecutionModes(
  role: TaskExecutionRole,
): TaskExecutionMode[] {
  if (role === 'guest') return [];
  return role === 'admin' ? ['host', 'container'] : ['container'];
}

export function canSelectTaskExecutionMode(
  role: TaskExecutionRole,
  mode: TaskExecutionMode,
): boolean {
  return getAllowedTaskExecutionModes(role).includes(mode);
}

export function buildTaskWorkspacePatch(input: {
  currentChatJid: string;
  currentExecutionMode?: TaskExecutionMode | null;
  targetChatJid: string;
  targetExecutionMode?: TaskExecutionMode | null;
}): Record<string, TaskExecutionMode | string> {
  const fields: Record<string, TaskExecutionMode | string> = {};
  if (input.targetChatJid !== input.currentChatJid) {
    fields.chat_jid = input.targetChatJid;
  }
  if (
    input.targetExecutionMode &&
    input.targetExecutionMode !== input.currentExecutionMode
  ) {
    fields.execution_mode = input.targetExecutionMode;
  }
  return fields;
}
