import type { RegisteredGroup, SubAgent } from './types.js';

export interface ContextIsolationConfig {
  enabled: boolean;
  sourceKind: 'auto_im';
}

export interface ContextIsolationConfigDeps {
  getUserFeishuConfig: (
    userId: string,
  ) => { autoIsolateContext?: boolean } | null;
}

export function getUserContextIsolationConfig(
  userId: string,
  channelType: string | null,
  deps: ContextIsolationConfigDeps,
): ContextIsolationConfig {
  if (channelType === 'feishu') {
    return {
      enabled: deps.getUserFeishuConfig(userId)?.autoIsolateContext === true,
      sourceKind: 'auto_im',
    };
  }

  return { enabled: false, sourceKind: 'auto_im' };
}

export interface ApplyAutoIsolateContextDeps {
  groups: Record<string, RegisteredGroup>;
  channelType: string;
  getChannelType: (jid: string) => string | null;
  getAgent: (agentId: string) => SubAgent | undefined;
  ensureBinding: (
    jid: string,
    group: RegisteredGroup,
    userId: string,
    name: string,
  ) => boolean;
  setGroup: (jid: string, group: RegisteredGroup) => void;
  deleteAgent: (agentId: string) => void;
  broadcastAgentRemoved: (
    chatJid: string,
    agentId: string,
    name: string,
  ) => void;
}

export function applyAutoIsolateContextForGroups(
  userId: string,
  enable: boolean,
  deps: ApplyAutoIsolateContextDeps,
): number {
  let count = 0;

  for (const [jid, group] of Object.entries(deps.groups)) {
    if (deps.getChannelType(jid) !== deps.channelType) continue;
    if (group.created_by !== userId) continue;

    if (enable) {
      if (group.target_agent_id || group.target_main_jid) continue;
      if (deps.ensureBinding(jid, group, userId, group.name || jid)) count++;
      continue;
    }

    if (!group.target_agent_id) continue;
    const agentToRemove = deps.getAgent(group.target_agent_id);
    if (agentToRemove?.source_kind !== 'auto_im') continue;

    deps.broadcastAgentRemoved(
      agentToRemove.chat_jid,
      group.target_agent_id,
      agentToRemove.name,
    );
    deps.deleteAgent(group.target_agent_id);

    const updated: RegisteredGroup = { ...group, target_agent_id: undefined };
    deps.setGroup(jid, updated);
    count++;
  }

  return count;
}

export function clearTargetAgentBindingsForDeletedAgents(
  groups: Record<string, RegisteredGroup>,
  deletedAgentIds: ReadonlySet<string>,
  setGroup: (jid: string, group: RegisteredGroup) => void,
): number {
  let count = 0;
  if (deletedAgentIds.size === 0) return count;

  for (const [jid, group] of Object.entries(groups)) {
    if (!group.target_agent_id) continue;
    if (!deletedAgentIds.has(group.target_agent_id)) continue;

    setGroup(jid, { ...group, target_agent_id: undefined });
    count++;
  }

  return count;
}
