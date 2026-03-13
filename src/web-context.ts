// Shared state and utilities for web server

import { WebSocket } from 'ws';
import { RegisteredGroup, UserRole } from './types.js';
import { GroupQueue } from './group-queue.js';
import type { AuthUser, NewMessage, MessageCursor } from './types.js';
import {
  getJidsByFolder,
  getRegisteredGroup,
  getGroupMemberRole,
} from './db.js';

export interface WsClientInfo {
  sessionId: string;
  userId: string;
  role: UserRole;
}

export interface WebDeps {
  queue: GroupQueue;
  getRegisteredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  processGroupMessages: (chatJid: string) => Promise<boolean>;
  ensureTerminalContainerStarted: (chatJid: string) => boolean;
  formatMessages: (messages: NewMessage[], isShared?: boolean) => string;
  getLastAgentTimestamp: () => Record<string, MessageCursor>;
  setLastAgentTimestamp: (jid: string, cursor: MessageCursor) => void;
  advanceGlobalCursor: (cursor: MessageCursor) => void;
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
    channel: 'feishu' | 'telegram' | 'qq',
  ) => Promise<boolean>;
  isFeishuConnected?: () => boolean;
  isTelegramConnected?: () => boolean;
  isUserFeishuConnected?: (userId: string) => boolean;
  isUserTelegramConnected?: (userId: string) => boolean;
  isUserQQConnected?: (userId: string) => boolean;
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
  } | null>;
  clearImFailCounts?: (jid: string) => void;
  updateReplyRoute?: (folder: string, sourceJid: string | null) => void;
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
