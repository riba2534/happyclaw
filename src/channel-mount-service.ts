import crypto from 'crypto';
import type {
  ChannelAccount,
  ChannelProvider,
  ChannelMount,
  ChannelRoutingMode,
  RegisteredGroup,
  SubAgent,
} from './types.js';
import { getChannelType } from './im-channel.js';
import {
  channelConversationJid,
  parseChannelAddress,
} from './channel-address.js';
import { applyChannelAccountRegistrationFallback } from './channel-account-routing.js';
import { resolveChannelConversationKind } from './channel-conversation-kind.js';
import { canonicalizeWhatsAppConversationJid } from './whatsapp-jid.js';
import { isThreadMapCapableChat } from './im-channel-capabilities.js';
import {
  createAgent,
  ensureChatExists,
  getChannelAccount,
  getChannelMount,
  getAllRegisteredGroups,
  getDefaultChannelAccount,
  getJidsByFolder,
  getLegacyChannelAccount,
  getRegisteredGroup,
  getUserHomeGroup,
  listAgentsByJid,
  setRegisteredGroupAndClearMatchingMainOwner,
  setRegisteredGroup,
  updateAgentLastImJid,
  updateChatName,
} from './db.js';
import { logger } from './logger.js';
import { ensureAgentDirectories } from './utils.js';

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

export interface RestoreDefaultChannelMountDeps {
  getAccount: (id: string) => ChannelAccount | undefined;
  getDefaultAccount: (
    ownerUserId: string,
    provider: ChannelProvider,
  ) => ChannelAccount | undefined;
  getLegacyAccount?: (
    ownerUserId: string,
    provider: ChannelProvider,
  ) => ChannelAccount | undefined;
  getGroup: (jid: string) => RegisteredGroup | undefined;
  getHome: (
    ownerUserId: string,
  ) => (RegisteredGroup & { jid: string }) | undefined;
  getJidsByFolder?: (folder: string) => string[];
  /** Workspaces that are in the process of being deleted and cannot be targets. */
  excludedWorkspaceJids?: ReadonlySet<string>;
}

export interface ThreadMapMountLookupDeps {
  getAllGroups: () => Record<string, RegisteredGroup>;
  getGroup: (jid: string) => RegisteredGroup | undefined;
  getJidsByFolder?: (folder: string) => string[];
}

export type RestoreDefaultChannelMountResult =
  | {
      status: 'resolved';
      workspaceJid: string;
      routingMode: ChannelRoutingMode;
      accountId: string | null;
      updated: RegisteredGroup;
    }
  | {
      status: 'unavailable';
      reason:
        | 'missing_owner'
        | 'account_mismatch'
        | 'missing_default_workspace';
    };

export type NativeContextMountUpgradeResult =
  | { status: 'upgraded' | 'unchanged'; updated: RegisteredGroup }
  | {
      status: 'conflict';
      reason: 'bound_to_session' | 'missing_workspace';
    };

export type ChannelMountTargetResolution =
  | {
      status: 'resolved';
      effectiveJid: string;
      workspaceJid: string;
      workspace: RegisteredGroup;
      agentId: string | null;
      workspaceMismatch?: {
        storedWorkspaceJid: string;
        actualWorkspaceJid: string;
      };
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
 * ordinary chats can route either to a workspace main conversation or one
 * explicitly selected session.
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

/**
 * Resolve the account-owned default workspace before mutating a mount. This
 * lets REST endpoints perform a single committed update: a failed restore can
 * never leave a channel temporarily unbound.
 */
export function buildRestoreDefaultChannelMountUpdate(
  channelJid: string,
  group: RegisteredGroup,
  ownerUserId: string | undefined,
  deps: RestoreDefaultChannelMountDeps,
  liveInfo: NativeContextMetadata = {},
): RestoreDefaultChannelMountResult {
  const provider = getChannelType(channelJid) as ChannelProvider | null;
  const encodedAccountId = parseChannelAddress(channelJid)?.channelAccountId;
  const storedAccountId = group.channel_account_id;
  if (
    storedAccountId &&
    encodedAccountId &&
    storedAccountId !== encodedAccountId
  ) {
    return { status: 'unavailable', reason: 'account_mismatch' };
  }
  const accountId = storedAccountId ?? encodedAccountId ?? null;

  let account = accountId ? deps.getAccount(accountId) : undefined;
  if (account && ownerUserId && account.owner_user_id !== ownerUserId) {
    return { status: 'unavailable', reason: 'account_mismatch' };
  }
  const effectiveOwner =
    account?.owner_user_id ?? ownerUserId ?? group.created_by;
  if (!effectiveOwner || !provider) {
    return { status: 'unavailable', reason: 'missing_owner' };
  }

  // Historical unscoped JIDs belong to the legacy default account, even if
  // the user later selected another account as the UI default.
  if (!account && !encodedAccountId && !storedAccountId) {
    account =
      deps.getLegacyAccount?.(effectiveOwner, provider) ??
      deps.getDefaultAccount(effectiveOwner, provider);
  }

  let workspaceJid: string | null = null;
  if (account?.default_workspace_jid) {
    const resolved = resolveWorkspaceJid(account.default_workspace_jid, {
      getRegisteredGroup: deps.getGroup,
      getJidsByFolder: deps.getJidsByFolder,
    });
    const workspace = resolved ? deps.getGroup(resolved) : undefined;
    if (
      resolved &&
      !deps.excludedWorkspaceJids?.has(resolved) &&
      workspace?.created_by === effectiveOwner
    ) {
      workspaceJid = resolved;
    }
  }

  if (!workspaceJid) {
    const homeJid = deps.getHome(effectiveOwner)?.jid ?? null;
    workspaceJid =
      homeJid && !deps.excludedWorkspaceJids?.has(homeJid) ? homeJid : null;
  }
  if (!workspaceJid) {
    return { status: 'unavailable', reason: 'missing_default_workspace' };
  }

  const routingMode: ChannelRoutingMode = isNativeContextContainer(
    channelJid,
    group,
    liveInfo,
  )
    ? 'thread_map'
    : 'single_session';
  return {
    status: 'resolved',
    workspaceJid,
    routingMode,
    accountId: account?.id ?? accountId,
    updated: {
      ...buildWorkspaceMountUpdate(group, workspaceJid, routingMode, {
        replyPolicy: 'source_only',
      }),
      ...((account?.id ?? accountId)
        ? { channel_account_id: account?.id ?? accountId ?? undefined }
        : {}),
    },
  };
}

/** Resolve and commit the default target in one write. */
export function restoreDefaultChannelMount(
  channelJid: string,
  group: RegisteredGroup,
  ownerUserId: string | undefined,
  liveInfo: NativeContextMetadata = {},
): RestoreDefaultChannelMountResult {
  const resolved = buildRestoreDefaultChannelMountUpdate(
    channelJid,
    group,
    ownerUserId,
    {
      getAccount: getChannelAccount,
      getDefaultAccount: getDefaultChannelAccount,
      getLegacyAccount: getLegacyChannelAccount,
      getGroup: getRegisteredGroup,
      getHome: getUserHomeGroup,
      getJidsByFolder,
    },
    liveInfo,
  );
  if (resolved.status !== 'resolved') return resolved;

  // Infer kind from the JID only. Feishu P2P metadata must not opt Feishu
  // into a channel_direct session; that path stays auto_im.
  if (resolveChannelConversationKind(channelJid) === 'direct') {
    const previousWorkspaceJid = resolveWorkspaceJid(group.target_main_jid, {
      getRegisteredGroup,
      getJidsByFolder,
    });
    const previousWorkspaceFolder = previousWorkspaceJid
      ? getRegisteredGroup(previousWorkspaceJid)?.folder
      : undefined;
    const mounted = ensureDirectChannelSessionMount({
      sourceJid: channelJid,
      group: {
        ...group,
        ...((resolved.accountId ?? group.channel_account_id)
          ? {
              channel_account_id:
                resolved.accountId ?? group.channel_account_id,
            }
          : {}),
      },
      workspaceJid: resolved.workspaceJid,
      userId: ownerUserId ?? group.created_by ?? '',
      force: true,
      mountOptions: { replyPolicy: 'source_only' },
    });
    commitChannelMountUpdate(channelJid, mounted, {
      clearMatchingMainOwnerFolder: previousWorkspaceFolder,
    });
    return { ...resolved, updated: mounted };
  }

  commitChannelMountUpdate(channelJid, resolved.updated);
  return resolved;
}

export interface EnsureDirectChannelSessionMountParams {
  sourceJid: string;
  group: RegisteredGroup;
  workspaceJid: string;
  userId: string;
  /** Remount even when the chat already has a workspace or session bind. */
  force?: boolean;
  mountOptions?: ChannelMountUpdateOptions;
  /** Called before a newly allocated Agent is persisted or creates directories. */
  onCreating?: (agent: SubAgent, workspaceJid: string) => void;
  onCreated?: (agent: SubAgent, workspaceJid: string) => void;
}

function matchesDirectConversationJid(
  lastImJid: string | null,
  conversationJid: string,
): boolean {
  if (!lastImJid) return false;
  const canonicalConversation = canonicalizeWhatsAppConversationJid(
    channelConversationJid(conversationJid),
  );
  return (
    canonicalizeWhatsAppConversationJid(channelConversationJid(lastImJid)) ===
    canonicalConversation
  );
}

/**
 * Mount an unbound (or force-restored) direct chat onto a dedicated
 * conversation session in the fallback workspace. Reuses an existing
 * `channel_direct` session for the same conversation JID when one exists.
 */
export function ensureDirectChannelSessionMount(
  params: EnsureDirectChannelSessionMountParams,
): RegisteredGroup {
  if (
    !params.force &&
    (params.group.target_agent_id || params.group.target_main_jid)
  ) {
    return params.group;
  }

  const workspace = getRegisteredGroup(params.workspaceJid);
  if (!workspace) return params.group;

  const conversationJid = channelConversationJid(params.sourceJid);
  const reusable = listAgentsByJid(params.workspaceJid).find(
    (agent) =>
      agent.source_kind === 'channel_direct' &&
      matchesDirectConversationJid(agent.last_im_jid, conversationJid),
  );

  if (
    reusable &&
    params.group.target_agent_id === reusable.id &&
    !params.group.target_main_jid
  ) {
    return params.group;
  }

  const now = new Date().toISOString();
  const agent =
    reusable ??
    (() => {
      const created: SubAgent = {
        id: crypto.randomUUID(),
        group_folder: workspace.folder,
        chat_jid: params.workspaceJid,
        name: params.group.name || conversationJid,
        prompt: '',
        status: 'idle',
        kind: 'conversation',
        created_by: params.userId || workspace.created_by || null,
        created_at: now,
        completed_at: null,
        result_summary: null,
        last_im_jid: conversationJid,
        spawned_from_jid: null,
        source_kind: 'channel_direct',
        last_active_at: now,
      };
      params.onCreating?.(created, params.workspaceJid);
      createAgent(created);
      ensureAgentDirectories(workspace.folder, created.id);
      const virtualChatJid = `${params.workspaceJid}#agent:${created.id}`;
      ensureChatExists(virtualChatJid);
      updateChatName(virtualChatJid, created.name);
      params.onCreated?.(created, params.workspaceJid);
      logger.info(
        {
          sourceJid: params.sourceJid,
          agentId: created.id,
          workspaceJid: params.workspaceJid,
        },
        'Created channel_direct session mount for direct chat',
      );
      return created;
    })();

  if (reusable) {
    updateAgentLastImJid(reusable.id, conversationJid);
  }

  return buildSessionMountUpdate(params.group, agent.id, params.mountOptions);
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
 * Resolve the channel-account default without committing it.
 *
 * Workspace deletion uses this to prepare every channel reroute first, then
 * persist those updates in the same database transaction as the workspace
 * deletion. Excluding the disappearing workspace is important when a Bot
 * account itself names that workspace as its default.
 */
export function resolveDefaultChannelMountForWorkspaceDeletion(
  channelJid: string,
  group: RegisteredGroup,
  ownerUserId: string | undefined,
  excludedWorkspaceJids: ReadonlySet<string>,
): RestoreDefaultChannelMountResult {
  return buildRestoreDefaultChannelMountUpdate(channelJid, group, ownerUserId, {
    getAccount: getChannelAccount,
    getDefaultAccount: getDefaultChannelAccount,
    getLegacyAccount: getLegacyChannelAccount,
    getGroup: getRegisteredGroup,
    getHome: getUserHomeGroup,
    getJidsByFolder,
    excludedWorkspaceJids,
  });
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
  mount: Pick<ChannelMount, 'session_id' | 'workspace_jid'>,
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
      status: 'resolved',
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

  const workspace = deps.getRegisteredGroup(mount.workspace_jid);
  if (!workspace) {
    return {
      status: 'stale',
      reason: 'missing_workspace',
      workspaceJid: mount.workspace_jid,
    };
  }
  return {
    status: 'resolved',
    effectiveJid: mount.workspace_jid,
    workspaceJid: mount.workspace_jid,
    workspace,
    agentId: null,
  };
}

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
  options: { clearMatchingMainOwnerFolder?: string } = {},
): void {
  if (options.clearMatchingMainOwnerFolder) {
    setRegisteredGroupAndClearMatchingMainOwner(
      channelJid,
      updated,
      options.clearMatchingMainOwnerFolder,
    );
  } else {
    setRegisteredGroup(channelJid, updated);
  }
  if (!channelMountRuntimePort) return;
  const groups = channelMountRuntimePort.getRegisteredGroups();
  if (groups[channelJid]) groups[channelJid] = updated;
  channelMountRuntimePort.clearImFailCounts?.(channelJid);
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

// --- Domain Commands for Channel Mount Management ---

export interface BindChannelToWorkspaceCommand {
  channelJid: string;
  workspaceJid: string;
  routingMode?: ChannelRoutingMode;
  replyPolicy?: 'source_only' | 'mirror';
  activationMode?: RegisteredGroup['activation_mode'];
  audienceMode?: string;
  ownerImId?: string | null;
  ownerClaimSource?: RegisteredGroup['owner_claim_source'];
  liveInfo?: NativeContextMetadata;
}

export interface BindChannelToSessionCommand {
  channelJid: string;
  sessionId: string;
  replyPolicy?: 'source_only' | 'mirror';
  activationMode?: RegisteredGroup['activation_mode'];
  audienceMode?: string;
  ownerImId?: string | null;
  ownerClaimSource?: RegisteredGroup['owner_claim_source'];
  liveInfo?: NativeContextMetadata;
}

/**
 * Domain command to bind an IM channel to a workspace.
 * Atomically persists the channel mount in normalized tables and synchronizes
 * the legacy registered_groups compatibility mirror within the repository boundary.
 */
export function executeBindChannelToWorkspace(
  command: BindChannelToWorkspaceCommand,
): ChannelMount {
  const current = getRegisteredGroup(command.channelJid) ?? {
    jid: command.channelJid,
    name: command.channelJid,
    folder: command.channelJid.replace(/:/g, '_'),
    added_at: new Date().toISOString(),
  };
  const updated: RegisteredGroup = {
    ...buildWorkspaceMountUpdate(
      current,
      command.workspaceJid,
      command.routingMode ?? 'single_session',
      {
        replyPolicy: command.replyPolicy,
        activationMode: command.activationMode,
        audienceMode: command.audienceMode as any,
        ownerImId: command.ownerImId,
      },
    ),
    ...(command.ownerClaimSource
      ? { owner_claim_source: command.ownerClaimSource }
      : {}),
    ...(command.liveInfo?.chat_mode
      ? { feishu_chat_mode: command.liveInfo.chat_mode }
      : {}),
    ...(command.liveInfo?.group_message_type
      ? { feishu_group_message_type: command.liveInfo.group_message_type }
      : {}),
  };
  commitChannelMountUpdate(command.channelJid, updated);
  const mount = getChannelMount(command.channelJid);
  if (!mount) {
    throw new Error(`Failed to commit channel mount for ${command.channelJid}`);
  }
  return mount;
}

/**
 * Domain command to bind an IM direct chat to an agent session.
 * Atomically persists normalized agent mounts and legacy compatibility mirror.
 */
export function executeBindChannelToSession(
  command: BindChannelToSessionCommand,
): ChannelMount {
  const current = getRegisteredGroup(command.channelJid) ?? {
    jid: command.channelJid,
    name: command.channelJid,
    folder: command.channelJid.replace(/:/g, '_'),
    added_at: new Date().toISOString(),
  };
  const updated: RegisteredGroup = {
    ...buildSessionMountUpdate(current, command.sessionId, {
      replyPolicy: command.replyPolicy,
      activationMode: command.activationMode,
      audienceMode: command.audienceMode as any,
      ownerImId: command.ownerImId,
    }),
    ...(command.ownerClaimSource
      ? { owner_claim_source: command.ownerClaimSource }
      : {}),
    ...(command.liveInfo?.chat_mode
      ? { feishu_chat_mode: command.liveInfo.chat_mode }
      : {}),
    ...(command.liveInfo?.group_message_type
      ? { feishu_group_message_type: command.liveInfo.group_message_type }
      : {}),
  };
  commitChannelMountUpdate(command.channelJid, updated);
  const mount = getChannelMount(command.channelJid);
  if (!mount) {
    throw new Error(`Failed to commit channel mount for ${command.channelJid}`);
  }
  return mount;
}

/**
 * Domain command to unbind an IM channel from all targets.
 */
export function executeUnbindChannel(
  channelJid: string,
  options: {
    clearMatchingMainOwnerFolder?: string;
    resetActivation?: boolean;
  } = {},
): void {
  const current = getRegisteredGroup(channelJid);
  if (!current) return;
  const updated = buildUnmountUpdate(current, options);
  commitChannelMountUpdate(channelJid, updated, options);
}

export interface RepairLeftoverDirectMountCommand {
  channelJid: string;
  group: RegisteredGroup;
  workspaceJid: string;
  workspaceFolder: string;
  userId: string;
  onCreating?: (agent: SubAgent, workspaceJid: string) => void;
}

/**
 * Dedicated domain command to repair leftover classifiable direct mounts
 * into isolated channel_direct sessions with matching owner folder clearing.
 */
export function executeRepairLeftoverDirectMount(
  command: RepairLeftoverDirectMountCommand,
): ChannelMount {
  const mounted = ensureDirectChannelSessionMount({
    sourceJid: command.channelJid,
    group: command.group,
    workspaceJid: command.workspaceJid,
    userId: command.userId,
    force: true,
    mountOptions: { replyPolicy: 'source_only' },
    onCreating: command.onCreating,
  });
  if (!mounted.target_agent_id || mounted.target_main_jid) {
    throw new Error(
      `Failed to remount leftover DM onto channel_direct: ${command.channelJid}`,
    );
  }
  commitChannelMountUpdate(command.channelJid, mounted, {
    clearMatchingMainOwnerFolder: command.workspaceFolder,
  });
  const mount = getChannelMount(command.channelJid);
  if (!mount) {
    throw new Error(
      `Failed to commit repaired channel mount for ${command.channelJid}`,
    );
  }
  return mount;
}
