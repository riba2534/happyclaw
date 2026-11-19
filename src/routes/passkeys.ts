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
import { ipBucketKey } from '../auth.js';
import { GUEST_READ_ONLY_ERROR } from '../guest-access.js';
import { onPasswordHashBusy } from '../password-hash-busy.js';
import { PasskeyReauthSchema } from '../schemas.js';
import {
  countPasskeys,
  deletePasskey,
  isTotpEnabled,
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
import {
  checkCurrentPassword,
  issueLoginSession,
  reauthenticate,
} from './auth.js';

const passkeyRoutes = new Hono<{ Variables: Variables }>();
passkeyRoutes.onError(onPasswordHashBusy);

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
  ip_host: 'Passkeys do not work on an IP address; use localhost or a domain',
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
  return c.json(await passkeyLoginOptions(where, ipBucketKey(getClientIp(c))));
});

passkeyRoutes.post('/passkey/login', jsonBodyLimit, async (c) => {
  const where = originOf(c);
  if (where instanceof Response) return where;
  const body = (await c.req.json().catch(() => ({}))) as { response?: unknown };
  const parsed = CredentialSchema.safeParse(body.response);
  const ip = getClientIp(c);
  const ua = c.req.header('user-agent') || null;
  const result = parsed.success
    ? await verifyPasskeyLogin(where, parsed.data as never)
    : ({ problem: 'invalid' } as const);
  if ('problem' in result && result.problem === 'expired') {
    return c.json(
      { error: 'Passkey sign-in expired, try again', code: 'PASSKEY_EXPIRED' },
      400,
    );
  }
  const user = 'userId' in result ? getUserById(result.userId) : undefined;
  // Guests get no passkeys; refuse one even if it somehow exists.
  const reason = !user
    ? 'passkey_invalid'
    : user.status !== 'active'
      ? 'account_inactive'
      : user.role === 'guest'
        ? 'guest'
        : null;
  if (!user || reason) {
    logAuthEvent({
      event_type: 'login_failed',
      username: user?.username ?? '',
      ip_address: ip,
      user_agent: ua,
      details: { reason, method: 'passkey' },
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
// The guard already answers 403; the handlers refuse guests too.

async function refuseGuests(
  c: Context<{ Variables: Variables }>,
  next: () => Promise<void>,
) {
  if ((c.get('user') as AuthUser).role === 'guest') {
    return c.json({ error: GUEST_READ_ONLY_ERROR }, 403);
  }
  await next();
}

const TOO_MANY_PASSKEYS = {
  error: 'Too many passkeys',
  code: 'PASSKEY_LIMIT_REACHED',
};

passkeyRoutes.get('/passkeys', authMiddleware, refuseGuests, (c) => {
  const user = c.get('user') as AuthUser;
  const where = resolvePasskeyOrigin(
    c.req.header('origin') ?? originFromReferer(c),
    c.req.header('host'),
  );
  return c.json({
    passkeys: listPasskeys(user.id).map(publicPasskey),
    rp_id: 'problem' in where ? null : where.rpId,
    unavailable_reason: 'problem' in where ? where.problem : null,
    // Adding one then also takes a code (see /passkeys/options).
    two_factor_enabled: isTotpEnabled(user.id),
  });
});

/**
 * Registration options, after re-authentication: a passkey stands in for the
 * password and the second factor at login, so adding one takes the password
 * and, with two-factor on, a code. A stolen session alone must not be able
 * to leave itself a way back in that a password change does not close.
 * Failures count against the login rate limit.
 */
passkeyRoutes.post(
  '/passkeys/options',
  authMiddleware,
  refuseGuests,
  jsonBodyLimit,
  async (c) => {
    const where = originOf(c);
    if (where instanceof Response) return where;
    const user = c.get('user') as AuthUser;
    const body = PasskeyReauthSchema.safeParse(
      await c.req.json().catch(() => ({})),
    );
    if (!body.success) {
      return c.json({ error: 'Invalid request', code: 'INVALID_REQUEST' }, 400);
    }
    if (countPasskeys(user.id) >= MAX_PASSKEYS_PER_USER) {
      return c.json(TOO_MANY_PASSKEYS, 409);
    }
    const denied = await reauthenticate(
      c,
      user,
      body.data.password,
      body.data.code,
    );
    if (denied) return denied;
    return c.json(await passkeyRegistrationOptions(user, where));
  },
);

passkeyRoutes.post(
  '/passkeys',
  authMiddleware,
  refuseGuests,
  jsonBodyLimit,
  async (c) => {
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
      return c.json({ error: 'Invalid request', code: 'INVALID_REQUEST' }, 400);
    }
    // Checked again: options issued before the last slot filled are still live.
    if (countPasskeys(user.id) >= MAX_PASSKEYS_PER_USER) {
      return c.json(TOO_MANY_PASSKEYS, 409);
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
  },
);

passkeyRoutes.patch(
  '/passkeys/:id',
  authMiddleware,
  refuseGuests,
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
 * Removing a passkey takes the password (counted like a login attempt): a
 * session that was taken over must not be able to strip the owner's way back
 * in. POST, as the client's DELETE carries no body.
 */
passkeyRoutes.post(
  '/passkeys/:id/delete',
  authMiddleware,
  refuseGuests,
  jsonBodyLimit,
  async (c) => {
    const user = c.get('user') as AuthUser;
    const body = (await c.req.json().catch(() => ({}))) as {
      password?: unknown;
    };
    const password = typeof body.password === 'string' ? body.password : '';
    if (!password || password.length > 256) {
      return c.json(
        { error: '当前密码不正确', code: 'CURRENT_PASSWORD_INCORRECT' },
        400,
      );
    }
    const denied = await checkCurrentPassword(c, user, password);
    if (denied) return denied;
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
