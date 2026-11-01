// Shared state and utilities for web server

import { WebSocket } from 'ws';
import { FollowUpActionResult, RegisteredGroup, UserRole } from './types.js';
import {
  GroupQueue,
  type IpcDeliveryReceipt,
  type IpcPrePublishAdmission,
} from './group-queue.js';
import type {
  AuthUser,
  AgentKind,
  AgentStatus,
  NewMessage,
  MessageCursor,
  UserSessionWithUser,
} from './types.js';
import { getSessionWithUser } from './db.js';
import type { WhatsAppConnectionState } from './whatsapp.js';
import type { ChannelAccount } from './types.js';
import type { ChannelAccountSecret } from './channel-account-secrets.js';

export interface WsClientInfo {
  sessionId: string;
  userId: string;
  role: UserRole;
}

export interface WebDeps {
  queue: GroupQueue;
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  /** Start a container for a session's terminal (`<workspaceJid>#agent:<id>`). */
  ensureTerminalContainerStarted: (sessionJid: string) => boolean;
  formatMessages: (messages: NewMessage[]) => string;
  getLastAgentTimestamp: () => Record<string, MessageCursor>;
  setLastAgentTimestamp: (jid: string, cursor: MessageCursor) => void;
  /**
   * Lex-max-merge advance for BOTH cursors (lastAgentTimestamp +
   * lastCommittedCursor). Comparison uses lexicographic (timestamp, id) so a
   * later candidate never regresses the cursor below the current value.
   *
   * Use for plugin-expander reply fast-paths that fully commit when no
   * earlier pending exists — direct overwrite (`setLastAgentTimestamp`) on
   * same-millisecond batches with a smaller-UUID candidate would regress
   * the cursor and re-fire the reply on the next poll (#27 round-17 P2-2).
   */
  advanceCursors: (jid: string, cursor: MessageCursor) => void;
  /**
   * Advance only the next-pull cursor (lastAgentTimestamp). lastCommittedCursor
   * stays put so a crash before earlier same-batch messages reach the agent
   * still surfaces them on recovery.
   *
   * Use for plugin-expander system replies that are delivered out-of-band
   * (no agent involvement) — the user message itself has not been processed
   * yet, so the recovery cursor must not advance past it.
   */
  advanceNextPullCursorOnly: (jid: string, cursor: MessageCursor) => void;
  /** Production single chokepoint for direct replies/drops. It advances only
   * next-pull when an earlier unreceipted message exists. Optional solely for
   * compatibility with focused route-test fixtures. */
  completeOutOfBandMessage?: (jid: string, cursor: MessageCursor) => void;
  /**
   * Returns true iff there exists at least one unprocessed (`is_from_me=0`)
   * message strictly **before** `candidate` in the lexicographic
   * (timestamp, id) ordering, relative to `lastCommittedCursor[chatJid]`.
   *
   * Used by the web plugin-expander reply fast-path (P2 round-14) to mirror
   * the cold-start cursor logic: when the reply is the only outstanding
   * work, fully commit; when an earlier user message is still queued, hold
   * the recovery cursor and only advance the next-pull cursor.
   *
   * Without this gate the fast-path always held the recovery cursor —
   * which means a clean restart after a no-earlier-pending reply would
   * replay the reply on recovery (the same DB row is still <= the cursor).
   */
  hasEarlierPendingMessages: (jid: string, candidate: MessageCursor) => boolean;
  reloadFeishuConnection?: (config: {
    appId: string;
    appSecret: string;
    enabled?: boolean;
  }) => Promise<boolean>;
  reloadTelegramConnection?: (config: {
    botToken: string;
    enabled?: boolean;
  }) => Promise<boolean>;
  reloadUserIMConfig?: (
    userId: string,
    channel:
      | 'feishu'
      | 'telegram'
      | 'qq'
      | 'wechat'
      | 'dingtalk'
      | 'discord'
      | 'whatsapp',
  ) => Promise<boolean>;
  reloadChannelAccount?: (accountId: string) => Promise<boolean>;
  disconnectChannelAccount?: (accountId: string) => Promise<void>;
  testChannelAccount?: (
    account: ChannelAccount,
    secret: ChannelAccountSecret,
  ) => Promise<{ success: boolean; unsupported?: boolean; error?: string }>;
  isChannelAccountConnected?: (accountId: string) => boolean;
  /**
   * Reconnect all of a user's IM channels from their persisted config.
   * Symmetric counterpart to `imManager.disconnectAllUserChannels` — called
   * when admin re-enables (or restores) a previously disabled/deleted user so
   * their bots come back without a service restart. Only enabled channels
   * with valid credentials actually connect.
   */
  reconnectUserIMChannels?: (userId: string) => Promise<void>;
  isFeishuConnected?: () => boolean;
  isTelegramConnected?: () => boolean;
  isUserFeishuConnected?: (userId: string) => boolean;
  isUserTelegramConnected?: (userId: string) => boolean;
  isUserQQConnected?: (userId: string) => boolean;
  isUserWeChatConnected?: (userId: string) => boolean;
  isUserDingTalkConnected?: (userId: string) => boolean;
  isUserDiscordConnected?: (userId: string) => boolean;
  isUserWhatsAppConnected?: (userId: string) => boolean;
  getUserWhatsAppState?: (
    userId: string,
    accountId?: string,
  ) => WhatsAppConnectionState;
  /** Hard logout: clears WhatsApp auth state on disk so next enable starts fresh. */
  logoutUserWhatsApp?: (userId: string, accountId?: string) => Promise<void>;
  processAgentConversation?: (
    chatJid: string,
    agentId: string,
  ) => Promise<void | boolean>;
  getFeishuChatInfo?: (
    userId: string,
    chatId: string,
  ) => Promise<{
    avatar?: string;
    name?: string;
    user_count?: string;
    chat_type?: string;
    chat_mode?: string;
    group_message_type?: string;
  } | null>;
  getChannelChatInfo?: (jid: string) => Promise<
    | {
        avatar?: string;
        name?: string;
        user_count?: string;
        chat_type?: string;
        chat_mode?: string;
        group_message_type?: string;
      }
    | null
    | undefined
  >;
  /** Refresh the current user's discoverable IM chats from connected bots. */
  syncUserImGroups?: (userId: string) => Promise<{ feishuAccounts: number }>;
  clearImFailCounts?: (jid: string) => void;
  /**
   * Fully remove an IM group's registered_groups entry (plus jid-scoped data
   * and fail counters). Used by DELETE /api/groups/:jid for IM-prefixed JIDs
   * — shared with the auto-cleanup paths (bot removed / health check / send
   * fail) so the manual delete path also resets imSendFailCounts /
   * imHealthCheckFailCounts.
   */
  removeImGroupRecord?: (jid: string, reason: string) => void;
  /** A Web input joined a session's warm runner: bind its turn and rotate
   * the session's held streaming card. */
  updateReplyRoute?: (
    folder: string,
    runtimeAgentId: string,
    sourceJid: string | null,
    receipt?: IpcDeliveryReceipt,
  ) => void;
  /** Acquire the immutable Turn/Card/Outbox fence before an IPC file becomes
   * visible to the SDK runner. Returning false rejects the warm injection. */
  preAdmitReplyRoute?: (
    folder: string,
    runtimeAgentId: string,
    sourceJid: string | null,
    receipt: IpcDeliveryReceipt | undefined,
  ) => IpcPrePublishAdmission | false;
  /** 用户消息注入运行中的会话时，先把该会话挂起中的流式卡片定稿轮换。
   * key 为会话 JID（`<workspaceJid>#agent:<id>`）。 */
  finalizeHeldCard?: (key: string) => void;
  handleSpawnCommand?: (
    chatJid: string,
    message: string,
    sourceImJid?: string,
  ) => Promise<string>;
  applyAutoIsolateContext?: (userId: string, enable: boolean) => number;
  /**
   * Resolve a registered group to its effective sibling-aware form. For non-home
   * groups bound (or auto-mapped) to a home sibling, returns the merged group
   * with executionMode/customCwd/created_by inherited from the home — without
   * this, web.ts plugin expansion on sibling JIDs (e.g. an IM group bound to a
   * home workspace) would build an ExpandContext from incomplete fields and
   * either return null (no plugins resolved) or pipe the literal `/foo` to the
   * active runner instead of the expanded prompt (#21 round-13 P2-3).
   */
  resolveEffectiveGroup?: (group: RegisteredGroup) => {
    effectiveGroup: RegisteredGroup;
    isHome: boolean;
  };
  promoteFollowUp?: (
    chatJid: string,
    messageId: string,
    expectedRunId: string,
  ) => Promise<FollowUpActionResult> | FollowUpActionResult;
  /** Start the next durable follow-up batch of an idle lane (no-op if busy). */
  dispatchQueuedFollowUps?: (chatJid: string) => void;
  cancelFollowUp?: (chatJid: string, messageId: string) => FollowUpActionResult;
  editFollowUp?: (
    chatJid: string,
    messageId: string,
    content: string,
  ) => FollowUpActionResult;
  reorderFollowUp?: (
    chatJid: string,
    messageId: string,
    direction: 'up' | 'down',
  ) => FollowUpActionResult;
  interruptAndRunFollowUp?: (
    chatJid: string,
    messageId: string,
    expectedRunId: string,
  ) => FollowUpActionResult;
  /** Web projection is injected so route modules do not import the Web gateway. */
  broadcastNewMessage?: (
    chatJid: string,
    message: NewMessage & { is_from_me?: boolean },
    agentId?: string,
    source?: string,
  ) => void;
  broadcastMessageDeleted?: (chatJid: string, messageId: string) => void;
  broadcastAgentStatus?: (
    chatJid: string,
    agentId: string,
    status: AgentStatus,
    name: string,
    prompt: string,
    resultSummary?: string,
    kind?: AgentKind,
    titleGenerating?: boolean,
  ) => void;
  broadcastAgentRemoved?: (
    chatJid: string,
    agentId: string,
    name: string,
  ) => void;
}

export type Variables = {
  user: AuthUser;
  sessionId: string;
};

let deps: WebDeps | null = null;
export const wsClients = new Map<WebSocket, WsClientInfo>();
export function setWebDeps(d: WebDeps): void {
  deps = d;
}
export function getWebDeps(): WebDeps | null {
  return deps;
}

function missingProjection(name: string): never {
  throw new Error(`Web projection is not initialized: ${name}`);
}

export function projectWebNewMessage(
  chatJid: string,
  message: NewMessage & { is_from_me?: boolean },
  agentId?: string,
  source?: string,
): void {
  const project = deps?.broadcastNewMessage;
  if (!project) missingProjection('broadcastNewMessage');
  project(chatJid, message, agentId, source);
}

export function projectWebMessageDeleted(
  chatJid: string,
  messageId: string,
): void {
  const project = deps?.broadcastMessageDeleted;
  if (!project) missingProjection('broadcastMessageDeleted');
  project(chatJid, messageId);
}

export function projectWebAgentStatus(
  chatJid: string,
  agentId: string,
  status: AgentStatus,
  name: string,
  prompt: string,
  resultSummary?: string,
  kind?: AgentKind,
  titleGenerating?: boolean,
): void {
  const project = deps?.broadcastAgentStatus;
  if (!project) missingProjection('broadcastAgentStatus');
  project(
    chatJid,
    agentId,
    status,
    name,
    prompt,
    resultSummary,
    kind,
    titleGenerating,
  );
}

export function projectWebAgentRemoved(
  chatJid: string,
  agentId: string,
  name: string,
): void {
  const project = deps?.broadcastAgentRemoved;
  if (!project) missingProjection('broadcastAgentRemoved');
  project(chatJid, agentId, name);
}

// lastActiveCache - 5 min debounce for session activity tracking
export const lastActiveCache = new Map<string, number>();
export const LAST_ACTIVE_DEBOUNCE_MS = 5 * 60 * 1000;
const LAST_ACTIVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const lastActiveCleanupTimer = setInterval(
  () => {
    const cutoff = Date.now() - LAST_ACTIVE_CACHE_TTL_MS;
    for (const [sessionId, touchedAt] of lastActiveCache.entries()) {
      if (touchedAt < cutoff) lastActiveCache.delete(sessionId);
    }
  },
  60 * 60 * 1000,
);
lastActiveCleanupTimer.unref?.();

// Session data cache — 30s TTL, avoids DB query on every request
const SESSION_CACHE_TTL_MS = 30 * 1000;
const sessionCache = new Map<
  string,
  { data: UserSessionWithUser; expiry: number }
>();

export function getCachedSessionWithUser(
  sessionId: string,
): UserSessionWithUser | undefined {
  const cached = sessionCache.get(sessionId);
  if (cached && cached.expiry > Date.now()) {
    return cached.data;
  }
  sessionCache.delete(sessionId);
  const data = getSessionWithUser(sessionId);
  if (data) {
    sessionCache.set(sessionId, {
      data,
      expiry: Date.now() + SESSION_CACHE_TTL_MS,
    });
  }
  return data;
}

export function invalidateSessionCache(sessionId: string): void {
  sessionCache.delete(sessionId);
  lastActiveCache.delete(sessionId);
}

export function invalidateUserSessions(userId: string): void {
  for (const [sid, entry] of sessionCache.entries()) {
    if (entry.data.user_id === userId) {
      sessionCache.delete(sid);
      lastActiveCache.delete(sid);
    }
  }
}

const sessionCacheCleanupTimer = setInterval(
  () => {
    const now = Date.now();
    for (const [sid, entry] of sessionCache.entries()) {
      if (entry.expiry < now) sessionCache.delete(sid);
    }
  },
  5 * 60 * 1000,
);
sessionCacheCleanupTimer.unref?.();

// Cookie parser - used by middleware and WebSocket
export function parseCookie(
  cookieHeader: string | undefined,
): Record<string, string> {
  if (!cookieHeader) return {};
  const cookies: Record<string, string> = {};
  for (const cookie of cookieHeader.split(';')) {
    const pair = cookie.trim();
    const eqIndex = pair.indexOf('=');
    if (eqIndex === -1) continue;
    const key = pair.slice(0, eqIndex).trim();
    const value = pair.slice(eqIndex + 1).trim();
    if (key) cookies[key] = value;
  }
  return cookies;
}

// Host execution helpers
export function isHostExecutionGroup(group: RegisteredGroup): boolean {
  return (group.executionMode || 'container') === 'host';
}

export function hasHostExecutionPermission(user: AuthUser): boolean {
  return user.role === 'admin';
}
