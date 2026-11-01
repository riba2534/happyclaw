import type { AvailableImGroup } from '../types';
import { getImChannelCapabilities } from '../constants/im-capabilities';

/** Binding destination is independent of audience and mention activation. */
export function resolveBindingTargetType(
  group: AvailableImGroup,
): 'workspace' | 'session' | null {
  const capabilities = getImChannelCapabilities(group.channel_type);
  if (group.conversation_kind === 'topic') {
    return capabilities?.can_bind_workspace ? 'workspace' : null;
  }
  if (
    group.conversation_kind === 'direct' ||
    group.conversation_kind === 'group'
  ) {
    return capabilities?.can_bind_session ? 'session' : null;
  }
  return null;
}

/** Keep invalid historical mounts visible without treating ordinary groups as invalid. */
export function hasBindingPolicyMismatch(group: AvailableImGroup): boolean {
  const hasSession = Boolean(group.bound_session_id ?? group.bound_agent_id);
  const hasWorkspace = Boolean(
    group.bound_workspace_jid ?? group.bound_main_jid,
  );
  if (!hasSession && !hasWorkspace) return false;
  const target = resolveBindingTargetType(group);
  if (!target) return true;
  if (target === 'workspace') return hasSession;
  // Private chats and ordinary groups bind to a session: a mount of one on a
  // workspace alone, or a thread-map mount, is left from before.
  return (
    !hasSession ||
    group.routing_mode === 'thread_map' ||
    group.binding_mode === 'thread_map'
  );
}

export interface ImBindingDestination {
  type: 'workspace' | 'session';
  groupJid: string;
  sessionId?: string;
}

export function isBoundToImDestination(
  group: AvailableImGroup,
  destination: ImBindingDestination,
): boolean {
  const sessionId = group.bound_session_id ?? group.bound_agent_id;
  if (sessionId) {
    return (
      destination.type === 'session' && sessionId === destination.sessionId
    );
  }
  if (
    (group.bound_workspace_jid ?? group.bound_main_jid) !== destination.groupJid
  ) {
    return false;
  }
  const workspaceMount =
    group.conversation_kind === 'topic' ||
    group.routing_mode === 'thread_map' ||
    group.binding_mode === 'thread_map';
  return destination.type === 'workspace' && workspaceMount;
}

export function buildImBindingRequest(
  group: AvailableImGroup,
  destination: ImBindingDestination,
  options: {
    force?: boolean;
    activationMode?: string | null;
    audienceMode?: string | null;
  } = {},
) {
  if (resolveBindingTargetType(group) !== destination.type) {
    throw new Error('渠道类型与绑定目标不符，请同步聊天后重试');
  }
  if (destination.type === 'session' && !destination.sessionId) {
    throw new Error('请选择会话');
  }
  const workspacePath = `/api/groups/${encodeURIComponent(destination.groupJid)}`;
  return {
    url:
      destination.type === 'session'
        ? `${workspacePath}/sessions/${encodeURIComponent(destination.sessionId!)}/im-binding`
        : `${workspacePath}/im-binding`,
    body: {
      im_jid: group.jid,
      force: options.force === true,
      reply_policy: 'source_only' as const,
      activation_mode: resolveBindingActivationMode(
        group,
        options.activationMode,
      ),
      audience_mode: resolveBindingAudienceMode(group, options.audienceMode),
    },
  };
}

export type BindingActivationMode = NonNullable<
  AvailableImGroup['activation_mode']
>;
export type BindingAudienceMode = NonNullable<
  AvailableImGroup['audience_mode']
>;

const ACTIVATION_MODES = new Set<BindingActivationMode>([
  'auto',
  'always',
  'when_mentioned',
  'owner_mentioned',
  'disabled',
]);

/**
 * Resolve the value submitted by the binding dialog without losing the
 * durable policy of a chat that appeared during live discovery. Form state
 * wins only when it contains a valid, explicit user selection.
 */
export function resolveBindingActivationMode(
  group: AvailableImGroup,
  selected?: string | null,
): BindingActivationMode {
  const candidate =
    selected && ACTIVATION_MODES.has(selected as BindingActivationMode)
      ? (selected as BindingActivationMode)
      : group.activation_mode && ACTIVATION_MODES.has(group.activation_mode)
        ? group.activation_mode
        : 'auto';
  if (
    group.channel_type === 'feishu' &&
    group.conversation_kind === 'direct' &&
    (candidate === 'when_mentioned' || candidate === 'owner_mentioned')
  ) {
    return 'auto';
  }
  return group.channel_type === 'feishu' && candidate === 'owner_mentioned'
    ? 'when_mentioned'
    : candidate;
}

/** Keep audience independent from activation while preserving legacy data. */
export function resolveBindingAudienceMode(
  group: AvailableImGroup,
  selected?: string | null,
): BindingAudienceMode {
  if (selected === 'everyone' || selected === 'owner_only') return selected;
  if (group.activation_mode === 'owner_mentioned') return 'owner_only';
  return group.audience_mode === 'owner_only' ? 'owner_only' : 'everyone';
}
