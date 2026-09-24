// Authentication and authorization middleware

import {
  lastActiveCache,
  LAST_ACTIVE_DEBOUNCE_MS,
  getCachedSessionWithUser,
  invalidateSessionCache,
} from '../web-context.js';
import { updateSessionLastActive, deleteUserSession } from '../db.js';
import {
  appendSessionCookies,
  isSessionExpired,
  verifySessionToken,
} from '../auth.js';
import type { AuthUser, Permission } from '../types.js';
import { hasPermission } from '../permissions.js';
import {
  SESSION_COOKIE_NAME_SECURE,
  SESSION_COOKIE_NAME_PLAIN,
} from '../config.js';
import { logger } from '../logger.js';

/**
 * Extract ALL values for a given cookie name from the raw Cookie header.
 * Browsers may send duplicate cookies (same name, different attributes)
 * when old and new cookies coexist. parseCookie() only keeps one value,
 * but we need to try all of them to handle migration scenarios.
 */
export function getAllCookieValues(
  cookieHeader: string | undefined,
  name: string,
): string[] {
  if (!cookieHeader) return [];
  const values: string[] = [];
  const prefix = name + '=';
  for (const part of cookieHeader.split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(prefix)) {
      values.push(trimmed.slice(prefix.length));
    }
  }
  return values;
}

/**
 * Try to verify a session token from a list of cookie values.
 * Returns { token, legacy } where `legacy` is true when an unsigned
 * legacy cookie was accepted (caller should re-issue the cookie).
 */
export function tryVerifyAny(
  values: string[],
): { token: string; legacy: boolean } | null {
  for (const v of values) {
    const verified = verifySessionToken(v);
    if (verified) return verified;
  }
  return null;
}

/** Every verified session token the Cookie header carries, under either cookie name. */
export function getVerifiedSessionTokens(
  cookieHeader: string | undefined,
): string[] {
  const tokens = new Set<string>();
  for (const name of [SESSION_COOKIE_NAME_SECURE, SESSION_COOKIE_NAME_PLAIN]) {
    for (const value of getAllCookieValues(cookieHeader, name)) {
      const verified = verifySessionToken(value);
      if (verified) tokens.add(verified.token);
    }
  }
  return [...tokens];
}

export const authMiddleware = async (c: any, next: any) => {
  const cookieHeader: string | undefined = c.req.header('cookie');
  // Try both cookie names, preferring the secure variant
  let allValues = getAllCookieValues(cookieHeader, SESSION_COOKIE_NAME_SECURE);
  if (allValues.length === 0) {
    allValues = getAllCookieValues(cookieHeader, SESSION_COOKIE_NAME_PLAIN);
  }

  if (allValues.length === 0) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const result = tryVerifyAny(allValues);
  if (!result) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const { token, legacy } = result;

  const session = getCachedSessionWithUser(token);
  if (!session) {
    invalidateSessionCache(token);
    return c.json({ error: 'Unauthorized' }, 401);
  }

  if (isSessionExpired(session.expires_at)) {
    deleteUserSession(token);
    invalidateSessionCache(token);
    return c.json({ error: 'Session expired' }, 401);
  }

  if (session.status === 'disabled') {
    return c.json({ error: 'Account disabled' }, 403);
  }
  if (session.status === 'deleted') {
    return c.json({ error: 'Account deleted' }, 403);
  }

  c.set('user', {
    id: session.user_id,
    username: session.username,
    role: session.role,
    status: session.status,
    display_name: session.display_name,
    permissions: session.permissions,
    must_change_password: session.must_change_password,
  } as AuthUser);
  c.set('sessionId', token);

  // Transparently upgrade unsigned legacy cookie to HMAC-signed
  if (legacy) {
    appendSessionCookies(c, token);
    logger.info(
      'Upgraded unsigned session cookie to HMAC-signed for user %s',
      session.username,
    );
  }

  const requestPath = c.req.path;
  const canBypassForcedChange =
    requestPath === '/api/auth/me' ||
    requestPath === '/api/auth/password' ||
    requestPath === '/api/auth/logout' ||
    requestPath === '/api/auth/profile' ||
    requestPath.startsWith('/api/auth/sessions');
  if (session.must_change_password && !canBypassForcedChange) {
    return c.json(
      { error: 'Password change required', code: 'PASSWORD_CHANGE_REQUIRED' },
      403,
    );
  }

  // Low-frequency last_active_at update (every 5 min)
  const now = Date.now();
  const lastUpdate = lastActiveCache.get(token) || 0;
  if (now - lastUpdate > LAST_ACTIVE_DEBOUNCE_MS) {
    lastActiveCache.set(token, now);
    try {
      updateSessionLastActive(token);
    } catch {
      /* best effort */
    }
  }

  await next();
};

export const requirePermission =
  (permission: Permission) => async (c: any, next: any) => {
    const user = c.get('user') as AuthUser;
    if (!hasPermission(user, permission)) {
      return c.json({ error: `Forbidden: ${permission} required` }, 403);
    }
    await next();
  };

export const systemConfigMiddleware = requirePermission('manage_system_config');
export const adminRoleMiddleware = async (c: any, next: any) => {
  const user = c.get('user') as AuthUser;
  if (user.role !== 'admin') {
    return c.json({ error: 'Forbidden: admin role required' }, 403);
  }
  await next();
};
export const usersManageMiddleware = requirePermission('manage_users');
export const inviteManageMiddleware = requirePermission('manage_invites');
export const auditViewMiddleware = requirePermission('view_audit_log');
