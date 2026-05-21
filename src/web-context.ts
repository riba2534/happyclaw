// Shared state and utilities for web server

import { WebSocket } from 'ws';
import { RegisteredGroup, UserRole } from './types.js';
import { GroupQueue } from './group-queue.js';
import type {
  AuthUser,
  NewMessage,
  MessageCursor,
  UserSessionWithUser,
} from './types.js';
import type { RuntimeOwnerCandidateUser } from './runtime-owner.js';
import {
  getJidsByFolder,
  getRegisteredGroup,
  getGroupMemberRole,
  getSessionWithUser,
} from './db.js';
import type { WhatsAppConnectionState } from './whatsapp.js';

export interface WsClientInfo {
  sessionId: string;
  userId: string;
  role: UserRole;
}

export interface WebDeps {
  queue: GroupQueue;
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  sessions: Record<string, string>;
  getSessions: () => Record<string, string>;
  processGroupMessages: (chatJid: string) => Promise<boolean>;
  ensureTerminalContainerStarted: (chatJid: string) => boolean;
  formatMessages: (messages: NewMessage[], isShared?: boolean) => string;
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
  advanceGlobalCursor: (cursor: MessageCursor) => void;
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
  hasEarlierPendingMessages: (
    jid: string,
    candidate: MessageCursor,
  ) => boolean;
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
  isFeishuConnected?: () => boolean;
  isTelegramConnected?: () => boolean;
  isUserFeishuConnected?: (userId: string) => boolean;
  isUserTelegramConnected?: (userId: string) => boolean;
  isUserQQConnected?: (userId: string) => boolean;
  isUserWeChatConnected?: (userId: string) => boolean;
  isUserDingTalkConnected?: (userId: string) => boolean;
  isUserDiscordConnected?: (userId: string) => boolean;
  isUserWhatsAppConnected?: (userId: string) => boolean;
  getUserWhatsAppState?: (userId: string) => WhatsAppConnectionState;
  /** Hard logout: clears WhatsApp auth state on disk so next enable starts fresh. */
  logoutUserWhatsApp?: (userId: string, accountId?: string) => Promise<void>;
  processAgentConversation?: (
    chatJid: string,
    agentId: string,
  ) => Promise<void>;
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
  clearImFailCounts?: (jid: string) => void;
  /**
   * Fully remove an IM group's registered_groups entry (plus jid-scoped data
   * and fail counters). Used by DELETE /api/groups/:jid for IM-prefixed JIDs
   * — shared with the auto-cleanup paths (bot removed / health check / send
   * fail) so the manual delete path also resets imSendFailCounts /
   * imHealthCheckFailCounts.
   */
  removeImGroupRecord?: (jid: string, reason: string) => void;
  updateReplyRoute?: (folder: string, sourceJid: string | null) => void;
  triggerTaskRun?: (taskId: string) => { success: boolean; error?: string };
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
  /**
   * User-by-id lookup used by plugin-runtime owner resolution. Web eager-expand
   * delegates to `resolvePerMessageRuntimeOwner` (#24 round-16 P2-1) so the
   * web fast-path applies the same admin-gating as the cold-start path —
   * non-admin / disabled / unknown senders on `web:main + isHome` fall back
   * to `created_by` instead of being treated as the runtime owner.
   */
  getUserById?: (id: string) => RuntimeOwnerCandidateUser | null | undefined;
}

export type Variables = {
  user: AuthUser;
  sessionId: string;
};

let deps: WebDeps | null = null;
export const wsClients = new Map<WebSocket, WsClientInfo>();
export const MAX_GROUP_NAME_LEN = 40;

export function setWebDeps(d: WebDeps): void {
  deps = d;
}
export function getWebDeps(): WebDeps | null {
  return deps;
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

/**
 * Check if a user can access (view messages, send messages to) a group.
 * All users (including admin) follow the same visibility rules:
 * - is_home groups → only the owner (created_by) can access
 * - IM groups (jid does not start with 'web:') → owner or group_members
 * - folder === 'main' → only the admin who owns it
 * - Web groups → created_by matches user.id, or user is in group_members
 */
export function canAccessGroup(
  user: { id: string; role: UserRole },
  group: RegisteredGroup & { jid: string },
): boolean {
  if (group.is_home) return group.created_by === user.id;
  // IM groups: check ownership if created_by is set.
  // For legacy rows without created_by, resolve owner from sibling home group.
  if (!group.jid.startsWith('web:')) {
    if (group.created_by === user.id) return true;
    // Check membership for IM groups sharing a non-home folder
    if (getGroupMemberRole(group.folder, user.id) !== null) return true;
    if (group.created_by) return false;
    const siblingJids = getJidsByFolder(group.folder);
    for (const jid of siblingJids) {
      if (jid === group.jid) continue;
      const sibling = getRegisteredGroup(jid);
      if (sibling?.is_home && sibling.created_by) {
        return sibling.created_by === user.id;
      }
    }
    // Ownership cannot be resolved for this IM group → deny by default.
    return false;
  }
  // folder === 'main': only accessible by the admin who owns it (via created_by or group_members)
  if (group.folder === 'main') {
    if (group.created_by === user.id) return true;
    return getGroupMemberRole(group.folder, user.id) !== null;
  }
  if (group.created_by === user.id) return true;
  // Check group_members table for shared workspaces
  return getGroupMemberRole(group.folder, user.id) !== null;
}

/**
 * Check if a user can modify (rename, reset) a group.
 * - Users can modify their own home group.
 * - Users can modify web groups they created.
 * - IM groups can be modified by their owner (created_by).
 */
export function canModifyGroup(
  user: { id: string; role: UserRole },
  group: RegisteredGroup & { jid: string },
): boolean {
  if (group.is_home) return group.created_by === user.id;
  if (!group.jid.startsWith('web:')) return group.created_by === user.id;
  return group.created_by === user.id;
}

/**
 * Check if a user can manage members (add/remove) of a group.
 * - Home groups cannot have members managed.
 * - Only the group creator (owner) can manage members.
 */
export function canManageGroupMembers(
  user: { id: string; role: UserRole },
  group: RegisteredGroup & { jid: string },
): boolean {
  if (group.is_home) return false;
  return group.created_by === user.id;
}

/**
 * Check if a user can delete a group.
 * - is_home groups cannot be deleted by anyone.
 */
export function canDeleteGroup(
  user: { id: string; role: UserRole },
  group: RegisteredGroup & { jid: string },
): boolean {
  if (group.is_home) return false;
  return canModifyGroup(user, group);
}
