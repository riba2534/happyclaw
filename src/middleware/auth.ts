// Authentication and authorization middleware

import {
  lastActiveCache,
  LAST_ACTIVE_DEBOUNCE_MS,
  parseCookie,
  getCachedSessionWithUser,
  invalidateSessionCache,
  type Variables,
} from '../web-context.js';
import {
  updateSessionLastActive,
  deleteUserSession,
} from '../db.js';
import { isSessionExpired, verifySessionToken } from '../auth.js';
import type { AuthUser, Permission } from '../types.js';
import { hasPermission } from '../permissions.js';
import {
  SESSION_COOKIE_NAME_SECURE,
  SESSION_COOKIE_NAME_PLAIN,
} from '../config.js';

export const authMiddleware = async (c: any, next: any) => {
  const cookies = parseCookie(c.req.header('cookie'));
  // Accept either cookie name — the browser will send whichever was set
  const rawCookie =
    cookies[SESSION_COOKIE_NAME_SECURE] || cookies[SESSION_COOKIE_NAME_PLAIN];
  if (!rawCookie) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // Verify HMAC signature (also accepts legacy unsigned tokens for migration)
  const token = verifySessionToken(rawCookie);
  if (!token) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

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

export const requireAnyPermission =
  (permissions: Permission[]) => async (c: any, next: any) => {
    const user = c.get('user') as AuthUser;
    const ok = permissions.some((permission) =>
      hasPermission(user, permission),
    );
    if (!ok) {
      return c.json(
        { error: `Forbidden: one of [${permissions.join(', ')}] required` },
        403,
      );
    }
    await next();
  };

export const systemConfigMiddleware = requirePermission('manage_system_config');
export const groupEnvMiddleware = requireAnyPermission([
  'manage_group_env',
  'manage_system_config',
]);
export const usersManageMiddleware = requirePermission('manage_users');
export const inviteManageMiddleware = requirePermission('manage_invites');
export const auditViewMiddleware = requirePermission('view_audit_log');
