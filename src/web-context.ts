// Shared state and utilities for web server

import { WebSocket } from 'ws';
import { RegisteredGroup, UserRole } from './types.js';
import { GroupQueue } from './group-queue.js';
import type { AuthUser, NewMessage, MessageCursor } from './types.js';
import { getJidsByFolder, getRegisteredGroup } from './db.js';

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
  formatMessages: (messages: NewMessage[]) => string;
  getLastAgentTimestamp: () => Record<string, MessageCursor>;
  setLastAgentTimestamp: (jid: string, cursor: MessageCursor) => void;
  advanceGlobalCursor: (cursor: MessageCursor) => void;
  reloadFeishuConnection?: (config: { appId: string; appSecret: string; enabled?: boolean }) => Promise<boolean>;
  reloadTelegramConnection?: (config: { botToken: string; enabled?: boolean }) => Promise<boolean>;
  reloadUserIMConfig?: (userId: string, channel: 'feishu' | 'telegram') => Promise<boolean>;
  isFeishuConnected?: () => boolean;
  isTelegramConnected?: () => boolean;
  isUserFeishuConnected?: (userId: string) => boolean;
  isUserTelegramConnected?: (userId: string) => boolean;
  isDockerAvailable?: () => boolean;
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
const lastActiveCleanupTimer = setInterval(() => {
  const cutoff = Date.now() - LAST_ACTIVE_CACHE_TTL_MS;
  for (const [sessionId, touchedAt] of lastActiveCache.entries()) {
    if (touchedAt < cutoff) lastActiveCache.delete(sessionId);
  }
}, 60 * 60 * 1000);
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
export function isDockerAvailable(): boolean {
  return deps?.isDockerAvailable?.() ?? false;
}

export function isHostExecutionGroup(group: RegisteredGroup): boolean {
  return (group.executionMode || 'container') === 'host';
}

export function hasHostExecutionPermission(user: AuthUser): boolean {
  return user.role === 'admin';
}

/**
 * Check if a user can access (view messages, send messages to) a group.
 * - admin → always true
 * - is_home groups → only the owner (created_by) can access
 * - IM groups (jid does not start with 'web:') → owner-only if owner can be resolved
 * - folder === 'main' → false for non-admin
 * - Web groups → only if created_by matches user.id (null created_by = admin-only)
 */
export function canAccessGroup(
  user: { id: string; role: UserRole },
  group: RegisteredGroup & { jid: string },
): boolean {
  if (user.role === 'admin') return true;
  if (group.is_home) return group.created_by === user.id;
  // IM groups: check ownership if created_by is set.
  // For legacy rows without created_by, resolve owner from sibling home group.
  if (!group.jid.startsWith('web:')) {
    if (group.created_by) return group.created_by === user.id;
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
  if (group.folder === 'main') return false;
  return group.created_by === user.id;
}

/**
 * Check if a user can modify (rename, reset) a group.
 * - Admin can rename any group (including is_home).
 * - Members can rename their own web groups (not Feishu/Telegram groups).
 * - Feishu groups are NOT modifiable by non-admin.
 */
export function canModifyGroup(
  user: { id: string; role: UserRole },
  group: RegisteredGroup & { jid: string },
): boolean {
  if (user.role === 'admin') return true;
  if (group.is_home) return group.created_by === user.id;
  if (!group.jid.startsWith('web:')) return false;
  if (group.folder === 'main') return false;
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
