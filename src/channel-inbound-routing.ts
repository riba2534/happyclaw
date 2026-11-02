import { getChannelType } from './im-channel.js';
import {
  isNativeContextContainer,
  resolveChannelMountTarget,
} from './channel-mount-service.js';
import {
  resolveNativeThreadContext,
  type NativeThreadContext,
} from './channel-native-context.js';
import { logger } from './logger.js';
import type {
  RegisteredGroup,
  SubAgent,
  ChannelMount,
  ChannelMessageMeta,
} from './types.js';

export interface ChannelInboundRoutingDeps {
  getRegisteredGroup: (jid: string) => RegisteredGroup | undefined;
  getAgent: (id: string) => SubAgent | undefined;
  getChannelMount: (jid: string) => ChannelMount | undefined;
  resolveWorkspaceJid: (jid: string) => string | null;
  ensureNativeContextChannelMount: (
    jid: string,
    group: RegisteredGroup,
  ) => RegisteredGroup | null;
  /** The topic's Session; a lookup-only router returns null for a new one. */
  resolveOrCreateNativeThreadAgent: (
    jid: string,
    workspaceJid: string,
    workspace: RegisteredGroup,
    group: RegisteredGroup,
    thread: NativeThreadContext,
  ) => { effectiveJid: string; agentId: string; sourceJid: string } | null;
  /**
   * Team mode (团队模式): the lane the gate chose for this message of a
   * team-mode group mount (a work item's worker or the group's router),
   * `reject` when no lane takes it (never the bound session), or null when
   * the group is not in team mode.
   */
  resolveTeamRoute?: (
    chatJid: string,
    messageMeta: ChannelMessageMeta | undefined,
  ) => { effectiveJid: string; agentId: string } | 'reject' | null;
}

/**
 * Whether a chat has a binding that can route: a direct chat or ordinary
 * group bound to one of the owner's sessions, or a topic container bound to
 * one of the owner's workspaces.
 */
export function hasExplicitChannelBinding(
  chatJid: string,
  deps: ChannelInboundRoutingDeps,
): boolean {
  const { getRegisteredGroup, getAgent, resolveWorkspaceJid } = deps;
  const group = getRegisteredGroup(chatJid);
  if (!group || !group.created_by) return false;
  const topicContainer = isNativeContextContainer(chatJid, group);
  let workspaceJid: string | null | undefined;
  if (group.target_agent_id) {
    const session = getAgent(group.target_agent_id);
    if (!session || session.kind !== 'conversation' || topicContainer) {
      return false;
    }
    workspaceJid = session.chat_jid;
  } else if (group.target_main_jid && topicContainer) {
    workspaceJid = resolveWorkspaceJid(group.target_main_jid);
  } else {
    return false;
  }
  if (!workspaceJid?.startsWith('web:')) return false;
  const workspace = getRegisteredGroup(workspaceJid);
  return !!workspace && workspace.created_by === group.created_by;
}

export function createChannelInboundRouter(deps: ChannelInboundRoutingDeps): (
  chatJid: string,
  messageMeta?: ChannelMessageMeta,
) => {
  effectiveJid: string;
  agentId: string;
  sourceJid?: string;
} | null {
  const {
    getRegisteredGroup,
    getAgent,
    resolveWorkspaceJid,
    getChannelMount,
    ensureNativeContextChannelMount,
    resolveOrCreateNativeThreadAgent,
  } = deps;
  return (chatJid: string, messageMeta) => {
    let group = getRegisteredGroup(chatJid);
    if (!group) {
      logger.debug({ chatJid }, 'resolveEffectiveChatJid: group not found');
      return null;
    }

    const topicContainer = isNativeContextContainer(chatJid, group);
    if (!hasExplicitChannelBinding(chatJid, deps)) {
      if (group.target_main_jid && !group.target_agent_id && !topicContainer) {
        logger.warn(
          { chatJid, targetMainJid: group.target_main_jid },
          'resolveEffectiveChatJid: workspace binding on a chat that is not a topic container, message will not route',
        );
      }
      return null;
    }
    const channelType = getChannelType(chatJid);
    const nativeThread =
      channelType === 'feishu' && messageMeta?.nativeContextType !== 'thread'
        ? null
        : resolveNativeThreadContext(messageMeta);
    if (topicContainer && !nativeThread) return null;
    const nativeThreadDetected =
      !!nativeThread &&
      (messageMeta?.nativeContextType === 'thread' ||
        (channelType === 'telegram' && !!messageMeta?.threadId));
    if (nativeThreadDetected && topicContainer) {
      const upgraded = ensureNativeContextChannelMount(chatJid, group);
      if (!upgraded) return null;
      group = upgraded;
    }

    const mount = getChannelMount(chatJid);
    if (mount) {
      const mountedTarget = resolveChannelMountTarget(mount, {
        getAgent,
        getRegisteredGroup: (jid) => getRegisteredGroup(jid),
      });
      if (mountedTarget.status === 'stale') {
        logger.warn(
          {
            chatJid,
            reason: mountedTarget.reason,
            sessionId: mountedTarget.sessionId,
            workspaceJid: mountedTarget.workspaceJid,
          },
          'resolveEffectiveChatJid: stale channel_mounts row, message will not route',
        );
        return null;
      }
      if (mountedTarget.workspace.created_by !== group.created_by) return null;
      if (
        mountedTarget.status === 'session' &&
        mountedTarget.workspaceMismatch
      ) {
        logger.warn(
          { chatJid, ...mountedTarget.workspaceMismatch },
          'resolveEffectiveChatJid: channel_mounts workspace differs from session owner, using session owner workspace',
        );
      }
      const teamRoute = deps.resolveTeamRoute?.(chatJid, messageMeta);
      if (teamRoute === 'reject') return null;
      if (teamRoute) return teamRoute;
      if (mountedTarget.status === 'session') {
        return {
          effectiveJid: mountedTarget.effectiveJid,
          agentId: mountedTarget.agentId,
        };
      }
      // A thread map reaches a session only through a native topic.
      if (!topicContainer || !nativeThread) return null;
      return resolveOrCreateNativeThreadAgent(
        chatJid,
        mountedTarget.workspaceJid,
        mountedTarget.workspace,
        group,
        nativeThread,
      );
    }

    // Agent binding takes priority
    if (group.target_agent_id) {
      const agent = getAgent(group.target_agent_id);
      if (!agent) {
        logger.warn(
          { chatJid, targetAgentId: group.target_agent_id },
          'resolveEffectiveChatJid: agent not found for target_agent_id',
        );
        return null;
      }
      // The session's chat_jid is its workspace's registered JID, the base of
      // the session address.
      const effectiveJid = `${agent.chat_jid}#agent:${group.target_agent_id}`;
      return { effectiveJid, agentId: group.target_agent_id };
    }

    if (
      group.binding_mode === 'thread_map' &&
      group.target_main_jid &&
      nativeThread
    ) {
      const workspaceJid = resolveWorkspaceJid(group.target_main_jid);
      if (!workspaceJid) {
        logger.warn(
          { chatJid, targetMainJid: group.target_main_jid },
          'thread_map resolveWorkspaceJid returned null — stale target_main_jid',
        );
        return null;
      }
      const workspace = getRegisteredGroup(workspaceJid);
      if (!workspace) return null;

      return resolveOrCreateNativeThreadAgent(
        chatJid,
        workspaceJid,
        workspace,
        group,
        nativeThread,
      );
    }

    logger.debug(
      {
        chatJid,
        targetAgentId: group.target_agent_id,
        targetMainJid: group.target_main_jid,
      },
      'resolveEffectiveChatJid: no binding found',
    );
    return null;
  };
}
