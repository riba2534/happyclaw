import type {
  ChannelMount,
  ChannelRoutingMode,
  RegisteredGroup,
  SubAgent,
} from './types.js';
import { getChannelType } from './im-channel.js';
import { applyChannelAccountRegistrationFallback } from './channel-account-routing.js';
import { resolveChannelConversationKind } from './channel-conversation-kind.js';
import { isThreadMapCapableChat } from './im-channel-capabilities.js';
import {
  getAllRegisteredGroups,
  getGroupsByTargetAgent,
  getJidsByFolder,
  getRegisteredGroup,
  listAgentChannelMountsByWorkspace,
  listChannelMountsBySession,
  runImmediateTransaction,
  setRegisteredGroup,
} from './db.js';

export interface ChannelMountRuntimePort {
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  clearImFailCounts?: (jid: string) => void;
}

let channelMountRuntimePort: ChannelMountRuntimePort | null = null;

export function injectChannelMountRuntimePort(
  port: ChannelMountRuntimePort | null,
): void {
  channelMountRuntimePort = port;
}

export interface ChannelMountResolutionDeps {
  getAgent: (
    sessionId: string,
  ) => Pick<SubAgent, 'id' | 'chat_jid'> | undefined;
  getRegisteredGroup: (jid: string) => RegisteredGroup | undefined;
  getJidsByFolder?: (folder: string) => string[];
}

export interface ChannelMountUpdateOptions {
  replyPolicy?: 'source_only' | 'mirror';
  activationMode?: ChannelMount['activation_mode'];
  audienceMode?: ChannelMount['audience_mode'];
  ownerImId?: string | null;
}

export interface NativeContextMetadata {
  chat_mode?: string | null;
  group_message_type?: string | null;
  native_context_type?: string | null;
  thread_capable?: boolean | null;
  activation_mode?: RegisteredGroup['activation_mode'] | null;
}

export interface ThreadMapMountLookupDeps {
  getAllGroups: () => Record<string, RegisteredGroup>;
  getGroup: (jid: string) => RegisteredGroup | undefined;
  getJidsByFolder?: (folder: string) => string[];
}

export type NativeContextMountUpgradeResult =
  | { status: 'upgraded' | 'unchanged'; updated: RegisteredGroup }
  | {
      status: 'conflict';
      reason: 'bound_to_session' | 'missing_workspace';
    };

/**
 * Where a channel mount sends a message: one session (direct chats and
 * ordinary groups), or a workspace whose native topics each get their own
 * session (thread_map). A single-session mount always names its session.
 */
export type ChannelMountTargetResolution =
  | {
      status: 'session';
      effectiveJid: string;
      workspaceJid: string;
      workspace: RegisteredGroup;
      agentId: string;
      workspaceMismatch?: {
        storedWorkspaceJid: string;
        actualWorkspaceJid: string;
      };
    }
  | {
      status: 'thread_map';
      workspaceJid: string;
      workspace: RegisteredGroup;
    }
  | {
      status: 'stale';
      reason: 'missing_session' | 'missing_workspace';
      sessionId?: string;
      workspaceJid: string;
    };

/**
 * A native-context container owns many platform conversations (for example a
 * Feishu topic group or Telegram Forum). It must route through thread_map;
 * ordinary chats route to one explicitly selected session.
 */
export function isNativeContextContainer(
  channelJid: string,
  group: RegisteredGroup,
  liveInfo: NativeContextMetadata = {},
): boolean {
  const persisted = group as RegisteredGroup & NativeContextMetadata;
  const channelType = getChannelType(channelJid);
  const chatMode =
    liveInfo.chat_mode ?? persisted.chat_mode ?? group.feishu_chat_mode;
  const groupMessageType =
    liveInfo.group_message_type ??
    persisted.group_message_type ??
    group.feishu_group_message_type;
  if (channelType === 'feishu') {
    return (
      resolveChannelConversationKind(channelJid, {
        chat_mode: chatMode,
        group_message_type: groupMessageType,
      }) === 'topic'
    );
  }
  return isThreadMapCapableChat({
    channel_type: channelType,
    chat_mode: chatMode,
    group_message_type: groupMessageType,
    native_context_type:
      liveInfo.native_context_type ?? persisted.native_context_type,
    thread_capable: liveInfo.thread_capable ?? persisted.thread_capable,
  });
}

/** Record the discovering Bot account without selecting a conversation target. */
export function attachDefaultChannelAccountMount(params: {
  sourceJid: string;
  group: RegisteredGroup;
  accountId?: string;
  fallbackWorkspaceJid: string;
  userId: string;
  onCreated?: (agent: SubAgent, workspaceJid: string) => void;
}): RegisteredGroup {
  // Discovery/pairing proves which user and Bot own the channel. It does not
  // authorize an Agent or select a workspace/session on the user's behalf.
  return params.accountId
    ? applyChannelAccountRegistrationFallback(
        params.group,
        params.accountId,
        params.fallbackWorkspaceJid,
      )
    : params.group;
}

/**
 * Upgrade a newly detected native-context container before its first message
 * is routed. A container bound to one fixed session is an invalid state and is
 * rejected. Multiple native-context containers may share one workspace;
 * context identities remain isolated by their account-scoped source JID.
 */
export function upgradeNativeContextChannelMount(
  channelJid: string,
  group: RegisteredGroup,
): NativeContextMountUpgradeResult {
  if (group.target_agent_id) {
    return { status: 'conflict', reason: 'bound_to_session' };
  }
  if (!group.target_main_jid) {
    return { status: 'conflict', reason: 'missing_workspace' };
  }
  if (group.binding_mode === 'thread_map') {
    return { status: 'unchanged', updated: group };
  }

  const workspaceJid = resolveWorkspaceJid(group.target_main_jid, {
    getRegisteredGroup,
    getJidsByFolder,
  });
  if (!workspaceJid) {
    return { status: 'conflict', reason: 'missing_workspace' };
  }
  if (!getRegisteredGroup(workspaceJid)) {
    return { status: 'conflict', reason: 'missing_workspace' };
  }

  const updated = buildWorkspaceMountUpdate(group, workspaceJid, 'thread_map');
  commitChannelMountUpdate(channelJid, updated);
  return { status: 'upgraded', updated };
}

export function resolveWorkspaceJid(
  workspaceJid: string | undefined,
  deps: Pick<
    ChannelMountResolutionDeps,
    'getRegisteredGroup' | 'getJidsByFolder'
  >,
): string | null {
  if (!workspaceJid) return null;
  if (deps.getRegisteredGroup(workspaceJid)) return workspaceJid;

  // Legacy compatibility: old records sometimes stored web:{folder} instead
  // of the actual registered web:{uuid} workspace JID.
  if (!workspaceJid.startsWith('web:')) return null;
  const folder = workspaceJid.slice(4);
  const candidates = deps.getJidsByFolder?.(folder) ?? [];
  for (const jid of candidates) {
    if (jid.startsWith('web:') && deps.getRegisteredGroup(jid)) return jid;
  }
  return null;
}

export function resolveChannelMountTarget(
  mount: Pick<ChannelMount, 'session_id' | 'workspace_jid' | 'routing_mode'>,
  deps: Pick<ChannelMountResolutionDeps, 'getAgent' | 'getRegisteredGroup'>,
): ChannelMountTargetResolution {
  if (mount.session_id) {
    const session = deps.getAgent(mount.session_id);
    if (!session?.chat_jid) {
      return {
        status: 'stale',
        reason: 'missing_session',
        sessionId: mount.session_id,
        workspaceJid: mount.workspace_jid,
      };
    }
    const workspace = deps.getRegisteredGroup(session.chat_jid);
    if (!workspace) {
      return {
        status: 'stale',
        reason: 'missing_workspace',
        sessionId: mount.session_id,
        workspaceJid: session.chat_jid,
      };
    }
    return {
      status: 'session',
      effectiveJid: `${session.chat_jid}#agent:${mount.session_id}`,
      workspaceJid: session.chat_jid,
      workspace,
      agentId: mount.session_id,
      ...(mount.workspace_jid !== session.chat_jid
        ? {
            workspaceMismatch: {
              storedWorkspaceJid: mount.workspace_jid,
              actualWorkspaceJid: session.chat_jid,
            },
          }
        : {}),
    };
  }

  // A workspace is a target only for a topic container's thread map; a
  // single-session mount without its session reaches nothing.
  if (mount.routing_mode !== 'thread_map') {
    return {
      status: 'stale',
      reason: 'missing_session',
      workspaceJid: mount.workspace_jid,
    };
  }
  const workspace = deps.getRegisteredGroup(mount.workspace_jid);
  if (!workspace) {
    return {
      status: 'stale',
      reason: 'missing_workspace',
      workspaceJid: mount.workspace_jid,
    };
  }
  return { status: 'thread_map', workspaceJid: mount.workspace_jid, workspace };
}

const UNBINDABLE_SESSION_SOURCES: ReadonlySet<
  NonNullable<SubAgent['source_kind']>
> = new Set([
  'team_router',
  'work_item',
  'automation',
  'native_thread',
  'feishu_thread',
]);

/**
 * Sessions a direct chat or ordinary group may be bound to: a conversation
 * someone talks in, not a team lane, an automation run or a native topic's
 * own session. Every bind path and the rebind of a deleted session use it.
 */
export function isBindableSession(
  session: Pick<SubAgent, 'kind' | 'source_kind'> | undefined,
): boolean {
  return (
    session?.kind === 'conversation' &&
    !(
      session.source_kind && UNBINDABLE_SESSION_SOURCES.has(session.source_kind)
    )
  );
}

/** The 400 body of a bind to a session that is not bindable. */
export const SESSION_NOT_BINDABLE = {
  error: 'This session cannot be bound to a chat',
  code: 'session_not_bindable',
} as const;

export function buildSessionMountUpdate(
  group: RegisteredGroup,
  sessionId: string,
  options: ChannelMountUpdateOptions = {},
): RegisteredGroup {
  return {
    ...group,
    target_agent_id: sessionId,
    target_main_jid: undefined,
    binding_mode: 'single_context',
    reply_policy: options.replyPolicy ?? 'source_only',
    ...(options.activationMode !== undefined
      ? { activation_mode: options.activationMode }
      : {}),
    ...(options.audienceMode !== undefined
      ? { audience_mode: options.audienceMode }
      : {}),
    ...(options.ownerImId !== undefined
      ? { owner_im_id: options.ownerImId ?? undefined }
      : {}),
  };
}

export function buildWorkspaceMountUpdate(
  group: RegisteredGroup,
  workspaceJid: string,
  routingMode: ChannelRoutingMode,
  options: ChannelMountUpdateOptions = {},
): RegisteredGroup {
  return {
    ...group,
    target_agent_id: undefined,
    target_main_jid: workspaceJid,
    binding_mode:
      routingMode === 'thread_map' ? 'thread_map' : 'single_context',
    reply_policy: 'source_only',
    ...(options.activationMode !== undefined
      ? { activation_mode: options.activationMode }
      : {}),
    ...(options.audienceMode !== undefined
      ? { audience_mode: options.audienceMode }
      : {}),
    ...(options.ownerImId !== undefined
      ? { owner_im_id: options.ownerImId ?? undefined }
      : {}),
  };
}

/** Reconcile legacy routing flags without changing a selected target or history. */
export function normalizeChannelBindingPolicy(
  channelJid: string,
  group: RegisteredGroup,
): RegisteredGroup {
  const kind = resolveChannelConversationKind(channelJid, {
    feishu_chat_mode: group.feishu_chat_mode,
    feishu_group_message_type: group.feishu_group_message_type,
    native_context_type: group.native_context_type,
  });
  const ordinary = kind === 'direct' || kind === 'group';
  const bindingMode =
    ordinary || (!group.target_main_jid && !group.target_agent_id)
      ? 'single_context'
      : kind === 'topic' && group.target_main_jid && !group.target_agent_id
        ? 'thread_map'
        : group.binding_mode;
  const nativeContextType =
    getChannelType(channelJid) === 'feishu' && ordinary
      ? 'none'
      : group.native_context_type;
  if (
    group.reply_policy === 'source_only' &&
    group.binding_mode === bindingMode &&
    group.native_context_type === nativeContextType
  )
    return group;
  return {
    ...group,
    reply_policy: 'source_only',
    binding_mode: bindingMode,
    native_context_type: nativeContextType,
  };
}

export function buildUnmountUpdate(
  group: RegisteredGroup,
  options: { resetActivation?: boolean } = {},
): RegisteredGroup {
  return {
    ...group,
    target_agent_id: undefined,
    target_main_jid: undefined,
    binding_mode: 'single_context',
    reply_policy: 'source_only',
    ...(options.resetActivation ? { activation_mode: 'auto' as const } : {}),
  };
}

/** Clear the selected target without discovering or creating another binding. */
export function unbindChannelMount(
  channelJid: string,
  group: RegisteredGroup,
): RegisteredGroup {
  const updated = buildUnmountUpdate(group);
  commitChannelMountUpdate(channelJid, updated);
  return updated;
}

/**
 * Canonical write path for IM channel bindings. `setRegisteredGroup` updates
 * both the legacy routing columns and the normalized channel-mount mirrors in
 * one DB transaction; this function also keeps the live router cache aligned.
 */
export function commitChannelMountUpdate(
  channelJid: string,
  updated: RegisteredGroup,
): void {
  commitChannelMountUpdates([[channelJid, updated]]);
}

/** Several binding changes in one transaction: all of them land, or none. */
export function commitChannelMountUpdates(
  updates: ReadonlyArray<readonly [string, RegisteredGroup]>,
): void {
  writeChannelMountUpdates(updates)();
}

/**
 * The database half of `commitChannelMountUpdates`, for a caller that runs
 * it inside its own transaction. Returns the live router cache update, to
 * apply once that transaction has committed.
 */
export function writeChannelMountUpdates(
  updates: ReadonlyArray<readonly [string, RegisteredGroup]>,
): () => void {
  runImmediateTransaction(() => {
    for (const [channelJid, updated] of updates) {
      setRegisteredGroup(channelJid, updated);
    }
  });
  return () => {
    if (!channelMountRuntimePort) return;
    const groups = channelMountRuntimePort.getRegisteredGroups();
    for (const [channelJid, updated] of updates) {
      if (groups[channelJid]) groups[channelJid] = updated;
      channelMountRuntimePort.clearImFailCounts?.(channelJid);
    }
  };
}

/**
 * The chats a session is bound to: by their row or by a mount projection
 * (the router reads the mount first), as JIDs.
 */
export function listSessionBoundChatJids(
  workspaceJid: string,
  sessionId: string,
): string[] {
  return [
    ...new Set([
      ...getGroupsByTargetAgent(sessionId).map(({ jid }) => jid),
      ...listChannelMountsBySession(sessionId).map((m) => m.channel_jid),
      ...listAgentChannelMountsByWorkspace(workspaceJid)
        .filter((m) => m.session_id === sessionId)
        .map((m) => m.channel_jid),
    ]),
  ];
}

export function hasSessionMountConflict(
  group: RegisteredGroup,
  sessionId: string,
): boolean {
  return (
    (group.target_agent_id !== undefined &&
      group.target_agent_id !== sessionId) ||
    !!group.target_main_jid
  );
}

export function matchesWorkspaceMount(
  group: RegisteredGroup,
  workspaceJid: string,
  legacyWorkspaceJid: string,
): boolean {
  return (
    group.target_main_jid === workspaceJid ||
    group.target_main_jid === legacyWorkspaceJid
  );
}

export function hasWorkspaceMountConflict(
  group: RegisteredGroup,
  workspaceJid: string,
  legacyWorkspaceJid: string,
): boolean {
  return (
    !!group.target_agent_id ||
    (!!group.target_main_jid &&
      !matchesWorkspaceMount(group, workspaceJid, legacyWorkspaceJid))
  );
}

/**
 * Whether another native-context source still maps threads into a workspace.
 *
 * A workspace may be shared by many Feishu topic groups and Telegram forums.
 * Callers use this after moving/removing one source so the workspace only
 * returns to horizontal/manual navigation when the final thread-map source
 * leaves. Both canonical `web:{uuid}` and historical `web:{folder}` targets
 * are normalized before comparison.
 */
export function hasRemainingThreadMapMount(
  workspaceJid: string,
  excludingImJid?: string,
  deps: ThreadMapMountLookupDeps = {
    getAllGroups: getAllRegisteredGroups,
    getGroup: getRegisteredGroup,
    getJidsByFolder,
  },
): boolean {
  const canonicalWorkspaceJid =
    resolveWorkspaceJid(workspaceJid, {
      getRegisteredGroup: deps.getGroup,
      getJidsByFolder: deps.getJidsByFolder,
    }) ?? workspaceJid;
  const workspace = deps.getGroup(canonicalWorkspaceJid);
  const legacyWorkspaceJid = workspace
    ? `web:${workspace.folder}`
    : workspaceJid;

  return Object.entries(deps.getAllGroups()).some(([jid, group]) => {
    if (jid === excludingImJid || group.binding_mode !== 'thread_map') {
      return false;
    }
    const mountedWorkspaceJid = resolveWorkspaceJid(group.target_main_jid, {
      getRegisteredGroup: deps.getGroup,
      getJidsByFolder: deps.getJidsByFolder,
    });
    return mountedWorkspaceJid
      ? mountedWorkspaceJid === canonicalWorkspaceJid
      : matchesWorkspaceMount(group, canonicalWorkspaceJid, legacyWorkspaceJid);
  });
}

/**
 * Stop treating a workspace as a live topic-map target without deleting any
 * sessions or context mappings created while it was bound. Rebinding the same
 * topic channel can therefore resume the existing history.
 */
export function buildDetachedWorkspaceUpdate(
  workspace: RegisteredGroup,
): RegisteredGroup {
  return {
    ...workspace,
    conversation_source: 'manual',
    conversation_nav_mode: 'horizontal',
  };
}

/** Keep workspace navigation aligned with an active native thread-map mount. */
export function buildNativeThreadWorkspaceUpdate(
  workspace: RegisteredGroup,
): RegisteredGroup {
  return {
    ...workspace,
    // Preserve the historical Feishu marker when it already exists; all new
    // providers use the provider-neutral native_thread value.
    conversation_source:
      workspace.conversation_source === 'feishu_thread'
        ? 'feishu_thread'
        : 'native_thread',
    conversation_nav_mode: 'vertical_threads',
  };
}
