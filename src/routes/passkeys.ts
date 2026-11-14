/**
 * Passkey routes, mounted under /api/auth next to the password routes:
 * username-less login (public) and the signed-in user's own passkeys.
 */
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';

import { authMiddleware } from '../middleware/auth.js';
import type { Variables } from '../web-context.js';
import { getClientIp } from '../utils.js';
import { getUserById, logAuthEvent } from '../db.js';
import { verifyPassword } from '../auth.js';
import { getGuestAccountState } from '../guest-accounts.js';
import {
  deletePasskey,
  listPasskeys,
  renamePasskey,
  type PasskeyRow,
} from '../auth-factor-store.js';
import {
  MAX_PASSKEYS_PER_USER,
  passkeyLoginOptions,
  passkeyRegistrationOptions,
  registerPasskey,
  resolvePasskeyOrigin,
  verifyPasskeyLogin,
  type PasskeyOrigin,
} from '../passkeys.js';
import type { AuthUser } from '../types.js';
import { issueLoginSession } from './auth.js';

const passkeyRoutes = new Hono<{ Variables: Variables }>();

const jsonBodyLimit = bodyLimit({
  maxSize: 64 * 1024,
  onError: (c) => c.json({ error: 'Payload too large' }, 413),
});

const NameSchema = z.string().trim().min(1).max(64);
// The browser's JSON as @simplewebauthn/browser returns it; the library
// validates the inside.
const CredentialSchema = z
  .object({
    id: z.string().min(1).max(1024),
    response: z.object({}).passthrough(),
  })
  .passthrough();

const ORIGIN_ERRORS = {
  no_origin: 'This request has no page origin',
  insecure: 'Passkeys need HTTPS (or localhost)',
  not_allowed:
    'This address is not allowed for passkeys; add it to CORS_ALLOWED_ORIGINS',
} as const;

/** The ceremony's origin, or an error response explaining why there is none. */
function originOf(
  c: Context<{ Variables: Variables }>,
): PasskeyOrigin | Response {
  const where = resolvePasskeyOrigin(
    c.req.header('origin'),
    c.req.header('host'),
  );
  if ('problem' in where) {
    return c.json(
      {
        error: ORIGIN_ERRORS[where.problem],
        code: `PASSKEY_${where.problem.toUpperCase()}`,
      },
      400,
    );
  }
  return where;
}

function publicPasskey(row: PasskeyRow) {
  return {
    id: row.id,
    name: row.name,
    rp_id: row.rp_id,
    created_at: row.created_at,
    last_used_at: row.last_used_at,
  };
}

// --- Login (public) ---

passkeyRoutes.post('/passkey/login/options', async (c) => {
  const where = originOf(c);
  if (where instanceof Response) return where;
  return c.json(await passkeyLoginOptions(where));
});

passkeyRoutes.post('/passkey/login', jsonBodyLimit, async (c) => {
  const where = originOf(c);
  if (where instanceof Response) return where;
  const body = (await c.req.json().catch(() => ({}))) as { response?: unknown };
  const parsed = CredentialSchema.safeParse(body.response);
  const ip = getClientIp(c);
  const ua = c.req.header('user-agent') || null;
  const userId = parsed.success
    ? await verifyPasskeyLogin(where, parsed.data as never)
    : null;
  const user = userId ? getUserById(userId) : undefined;
  const usable =
    !!user &&
    user.status === 'active' &&
    (user.role !== 'guest' || getGuestAccountState(user.id).valid);
  if (!user || !usable) {
    logAuthEvent({
      event_type: 'login_failed',
      username: user?.username ?? '',
      ip_address: ip,
      user_agent: ua,
      details: { reason: user ? 'account_inactive' : 'passkey_invalid' },
    });
    return c.json(
      { error: 'Passkey not recognised', code: 'PASSKEY_INVALID' },
      400,
    );
  }
  // A passkey is phishing-resistant and proves possession: it stands in for
  // the password and the second factor both.
  return issueLoginSession(c, user, user.username, ip, ua, {
    method: 'passkey',
  });
});

// --- The signed-in user's passkeys ---
// Not on the guest allowlist: guests get no passkeys, as no second factor.

passkeyRoutes.get('/passkeys', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const where = resolvePasskeyOrigin(
    c.req.header('origin') ?? originFromReferer(c),
    c.req.header('host'),
  );
  return c.json({
    passkeys: listPasskeys(user.id).map(publicPasskey),
    rp_id: 'problem' in where ? null : where.rpId,
    unavailable_reason: 'problem' in where ? where.problem : null,
  });
});

passkeyRoutes.post('/passkeys/options', authMiddleware, async (c) => {
  const where = originOf(c);
  if (where instanceof Response) return where;
  const user = c.get('user') as AuthUser;
  if (listPasskeys(user.id).length >= MAX_PASSKEYS_PER_USER) {
    return c.json({ error: 'Too many passkeys' }, 409);
  }
  return c.json(await passkeyRegistrationOptions(user, where));
});

passkeyRoutes.post('/passkeys', authMiddleware, jsonBodyLimit, async (c) => {
  const where = originOf(c);
  if (where instanceof Response) return where;
  const user = c.get('user') as AuthUser;
  const body = (await c.req.json().catch(() => ({}))) as {
    response?: unknown;
    name?: unknown;
  };
  const parsed = CredentialSchema.safeParse(body.response);
  const name = NameSchema.safeParse(body.name ?? '通行密钥');
  if (!parsed.success || !name.success) {
    return c.json({ error: 'Invalid request' }, 400);
  }
  const row = await registerPasskey(
    user.id,
    where,
    parsed.data as never,
    name.data,
  );
  if (!row) {
    return c.json(
      { error: 'Passkey could not be verified', code: 'PASSKEY_INVALID' },
      400,
    );
  }
  logAuthEvent({
    event_type: 'passkey_added',
    username: user.username,
    ip_address: getClientIp(c),
    user_agent: c.req.header('user-agent') || null,
    details: { rp_id: row.rp_id },
  });
  return c.json({ success: true, passkey: publicPasskey(row) });
});

passkeyRoutes.patch(
  '/passkeys/:id',
  authMiddleware,
  jsonBodyLimit,
  async (c) => {
    const user = c.get('user') as AuthUser;
    const body = (await c.req.json().catch(() => ({}))) as { name?: unknown };
    const name = NameSchema.safeParse(body.name);
    if (!name.success) return c.json({ error: 'Invalid name' }, 400);
    if (!renamePasskey(user.id, c.req.param('id'), name.data)) {
      return c.json({ error: 'Passkey not found' }, 404);
    }
    return c.json({ success: true });
  },
);

/**
 * Removing a passkey takes the password: a session that was taken over must
 * not be able to strip the owner's way back in. POST, as the client's
 * DELETE carries no body.
 */
passkeyRoutes.post(
  '/passkeys/:id/delete',
  authMiddleware,
  jsonBodyLimit,
  async (c) => {
    const user = c.get('user') as AuthUser;
    const body = (await c.req.json().catch(() => ({}))) as {
      password?: unknown;
    };
    const fullUser = getUserById(user.id);
    if (!fullUser) return c.json({ error: 'User not found' }, 404);
    const password = typeof body.password === 'string' ? body.password : '';
    // 400, not 401: the Web client treats any 401 as a signed-out session.
    if (
      !password ||
      !(await verifyPassword(password, fullUser.password_hash))
    ) {
      return c.json({ error: 'Current password is incorrect' }, 400);
    }
    if (!deletePasskey(user.id, c.req.param('id'))) {
      return c.json({ error: 'Passkey not found' }, 404);
    }
    logAuthEvent({
      event_type: 'passkey_removed',
      username: user.username,
      ip_address: getClientIp(c),
      user_agent: c.req.header('user-agent') || null,
    });
    return c.json({ success: true });
  },
);

/** A GET carries no Origin header; the Referer names the same page. */
function originFromReferer(
  c: Context<{ Variables: Variables }>,
): string | undefined {
  const referer = c.req.header('referer');
  if (!referer) return undefined;
  try {
    return new URL(referer).origin;
  } catch {
    return undefined;
  }
}

export default passkeyRoutes;
