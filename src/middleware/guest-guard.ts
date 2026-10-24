/**
 * Default-deny guard for read-only guest accounts.
 *
 * Mounted on `/api/*` before every route module. For requests that carry a
 * valid *guest* session it allows only the explicit (method, path) pairs in
 * GUEST_ROUTE_ALLOWLIST; every other route — including routes added later —
 * answers 403. Non-guest and unauthenticated requests pass straight through
 * to the route's own authentication.
 *
 * The allowlist only decides which handlers a guest may reach. Each allowed
 * handler still authorizes the specific workspace with `canViewGroup`
 * (src/guest-access.ts) and answers 404 for anything not granted.
 */
import type { Context, Next } from 'hono';

import { isSessionExpired } from '../auth.js';
import {
  SESSION_COOKIE_NAME_PLAIN,
  SESSION_COOKIE_NAME_SECURE,
} from '../config.js';
import {
  GUEST_READ_ONLY_ERROR,
  getGuestAccountState,
} from '../guest-access.js';
import { getCachedSessionWithUser } from '../web-context.js';
import { getAllCookieValues, tryVerifyAny } from './auth.js';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

const SEG = '[^/]+';

/**
 * Every route a guest session may call. Keep this minimal: anything absent is
 * denied. GET entries also admit HEAD.
 */
export const GUEST_ROUTE_ALLOWLIST: ReadonlyArray<{
  method: Method;
  pattern: RegExp;
  note: string;
}> = [
  // Public, session-agnostic endpoints (login page, branding, health).
  { method: 'GET', pattern: /^\/api\/auth\/status$/, note: 'init status' },
  {
    method: 'GET',
    pattern: /^\/api\/auth\/register\/status$/,
    note: 'registration status',
  },
  { method: 'POST', pattern: /^\/api\/auth\/login$/, note: 'log in again' },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/auth/avatars/${SEG}$`),
    note: 'avatar images',
  },
  {
    method: 'GET',
    pattern: /^\/api\/config\/appearance\/public$/,
    note: 'branding',
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/config/brand-assets/${SEG}$`),
    note: 'brand assets',
  },
  { method: 'GET', pattern: /^\/api\/health$/, note: 'health probe' },

  // Own account.
  { method: 'GET', pattern: /^\/api\/auth\/me$/, note: 'current user' },
  { method: 'POST', pattern: /^\/api\/auth\/logout$/, note: 'log out' },
  { method: 'PUT', pattern: /^\/api\/auth\/password$/, note: 'own password' },
  { method: 'GET', pattern: /^\/api\/auth\/sessions$/, note: 'own sessions' },
  {
    method: 'DELETE',
    pattern: new RegExp(`^/api/auth/sessions/${SEG}$`),
    note: 'revoke own session',
  },

  // Granted workspaces: list, conversation history, sessions, traces.
  { method: 'GET', pattern: /^\/api\/groups\/?$/, note: 'workspace list' },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/groups/${SEG}/messages$`),
    note: 'message history',
  },
  {
    method: 'GET',
    pattern: new RegExp(
      `^/api/groups/${SEG}/messages/${SEG}/attachments/\\d+/original$`,
    ),
    note: 'attachment original',
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/groups/${SEG}/(agents|sessions)$`),
    note: 'session list',
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/groups/${SEG}/turn-traces/${SEG}$`),
    note: 'stored turn trace',
  },
  { method: 'GET', pattern: /^\/api\/follow-ups$/, note: 'visible queue' },
  { method: 'GET', pattern: /^\/api\/workspaces\/?$/, note: 'workspaces' },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/workspaces/${SEG}$`),
    note: 'workspace detail',
  },

  // Files (system directories are filtered inside the handlers).
  {
    method: 'GET',
    pattern: new RegExp(`^/api/groups/${SEG}/files$`),
    note: 'file list',
  },
  {
    method: 'GET',
    pattern: new RegExp(
      `^/api/groups/${SEG}/files/(download|preview|content)/${SEG}$`,
    ),
    note: 'file read',
  },

  // Workspace memory (read only).
  {
    method: 'GET',
    pattern: new RegExp(`^/api/memory/workspaces/${SEG}/items$`),
    note: 'memory list',
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/memory/workspaces/${SEG}/items/search$`),
    note: 'memory search',
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/memory/workspaces/${SEG}/items/${SEG}$`),
    note: 'memory item',
  },
  {
    method: 'GET',
    pattern: new RegExp(
      `^/api/memory/workspaces/${SEG}/items/${SEG}/versions$`,
    ),
    note: 'memory versions',
  },

  // Scheduled tasks (read only).
  { method: 'GET', pattern: /^\/api\/tasks\/?$/, note: 'task list' },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/tasks/${SEG}/runs$`),
    note: 'task runs',
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/tasks/runs/${SEG}$`),
    note: 'task run detail',
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/tasks/${SEG}/logs$`),
    note: 'task logs',
  },
];

export function isGuestRouteAllowed(method: string, path: string): boolean {
  const normalized =
    method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  return GUEST_ROUTE_ALLOWLIST.some(
    (entry) => entry.method === normalized && entry.pattern.test(path),
  );
}

/** Session behind the request's cookie, or null when there is none. */
function resolveCookieSession(cookieHeader: string | undefined) {
  for (const name of [SESSION_COOKIE_NAME_SECURE, SESSION_COOKIE_NAME_PLAIN]) {
    const values = getAllCookieValues(cookieHeader, name);
    if (values.length === 0) continue;
    const verified = tryVerifyAny(values);
    if (!verified) continue;
    const session = getCachedSessionWithUser(verified.token);
    if (session && !isSessionExpired(session.expires_at)) return session;
  }
  return null;
}

export const guestGuardMiddleware = async (c: Context, next: Next) => {
  const session = resolveCookieSession(c.req.header('cookie'));
  if (!session || session.role !== 'guest') return next();

  // Owner state is re-read on every guest request (never cached), so
  // disabling or deleting the owner cuts the guest off immediately.
  const denial = guestRequestDenial(session.user_id, c.req.method, c.req.path);
  if (denial) return c.json({ error: denial }, 403);
  return next();
};

/**
 * Why a guest request must be refused, or null when it may proceed. Shared by
 * the global guard and authMiddleware (defense in depth for routes that a
 * future refactor might mount outside `/api/*`).
 */
export function guestRequestDenial(
  guestUserId: string,
  method: string,
  path: string,
): string | null {
  // Logging out must always work, even for an account that was just cut off.
  if (method.toUpperCase() === 'POST' && path === '/api/auth/logout') {
    return null;
  }
  // Owner state is re-read on every guest request (never cached), so
  // disabling or deleting the owner cuts the guest off immediately.
  const state = getGuestAccountState(guestUserId);
  if (!state.valid) return 'Account disabled';
  if (!isGuestRouteAllowed(method, path)) return GUEST_READ_ONLY_ERROR;
  return null;
}
