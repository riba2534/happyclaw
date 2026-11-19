/**
 * Passkeys end to end against a software authenticator (P-256, "none"
 * attestation): register after re-authentication, log in without a
 * username, origin rules, replay and expiry, a credential bound to another
 * host or presented under another user's handle, removal, and the admin's
 * revocation.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

vi.hoisted(() => {
  process.env.WEB_SESSION_SECRET = 'passkey-test-secret';
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'passkeys-'));
const dataDir = path.join(tmp, 'install', 'data');

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    DATA_DIR: dataDir,
    STORE_DIR: path.join(dataDir, 'db'),
    GROUPS_DIR: path.join(dataDir, 'groups'),
    TRUST_PROXY: true,
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/middleware/auth.js', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../src/middleware/auth.js')>();
  return {
    ...real,
    authMiddleware: async (c: any, next: any) => {
      const id = process.env.HAPPYCLAW_TEST_USER_ID!;
      const user = db.getUserById(id)!;
      c.set('user', {
        id,
        username: user.username,
        display_name: user.display_name,
        role: user.role,
        status: user.status,
        permissions: user.permissions,
        must_change_password: false,
      });
      c.set('sessionId', 'test-session');
      return next();
    },
  };
});

const db = await import('../src/db.js');
const { resetLoginAttemptsForTest } = await import('../src/auth.js');
const { resetMfaChallengesForTest } = await import('../src/auth-mfa.js');
const { insertPasskey, listPasskeys } =
  await import('../src/auth-factor-store.js');
const { totpCode, totpStep } = await import('../src/totp.js');
const {
  LOGIN_CHALLENGES_PER_CLIENT,
  MAX_PASSKEYS_PER_USER,
  resetPasskeyChallengesForTest,
  resolvePasskeyOrigin,
} = await import('../src/passkeys.js');
const passkeyRoutes = (await import('../src/routes/passkeys.js')).default;
const authRoutes = (await import('../src/routes/auth.js')).default;
const adminRoutes = (await import('../src/routes/admin.js')).default;
const app = new Hono()
  .route('/api/auth', authRoutes)
  .route('/api/auth', passkeyRoutes)
  .route('/api/admin', adminRoutes);

const PASSWORD = 'owner-password-1';
const ORIGIN = 'https://claw.example.com';
const HOST = 'claw.example.com';

const b64url = (bytes: Uint8Array | Buffer) =>
  Buffer.from(bytes).toString('base64url');
const sha256 = (data: Buffer | string) =>
  crypto.createHash('sha256').update(data).digest();

/** A minimal platform authenticator holding one P-256 key for one user. */
class SoftAuthenticator {
  readonly id = crypto.randomBytes(16);
  private readonly keys = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  private counter = 0;

  constructor(readonly userId = 'alice') {}

  private clientData(type: string, challenge: string, origin: string) {
    return Buffer.from(JSON.stringify({ type, challenge, origin }));
  }

  create(options: { challenge: string; rp: { id: string } }, origin = ORIGIN) {
    const jwk = this.keys.publicKey.export({ format: 'jwk' });
    const cose = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x!, 'base64url')],
        [-3, Buffer.from(jwk.y!, 'base64url')],
      ]),
    );
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.id.length);
    const authData = Buffer.concat([
      sha256(options.rp.id),
      Buffer.from([0x45]), // UP | UV | AT
      Buffer.alloc(4),
      Buffer.alloc(16),
      idLength,
      this.id,
      Buffer.from(cose),
    ]);
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]) as never,
    );
    return {
      id: b64url(this.id),
      rawId: b64url(this.id),
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(
          this.clientData('webauthn.create', options.challenge, origin),
        ),
        attestationObject: b64url(attestationObject),
        transports: ['internal'],
      },
    };
  }

  get(
    options: { challenge: string; rpId?: string },
    origin = ORIGIN,
    {
      flags = 0x05, // UP | UV
      userHandle = this.userId,
    }: { flags?: number; userHandle?: string | null } = {},
  ) {
    this.counter += 1;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const authData = Buffer.concat([
      sha256(options.rpId ?? HOST),
      Buffer.from([flags]),
      counter,
    ]);
    const clientDataJSON = this.clientData(
      'webauthn.get',
      options.challenge,
      origin,
    );
    const signature = crypto.sign(
      'sha256',
      Buffer.concat([authData, sha256(clientDataJSON)]),
      this.keys.privateKey,
    );
    return {
      id: b64url(this.id),
      rawId: b64url(this.id),
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        ...(userHandle === null
          ? {}
          : { userHandle: b64url(Buffer.from(userHandle)) }),
      },
    };
  }
}

function request(
  url: string,
  body: unknown,
  { origin = ORIGIN, host = HOST, method = 'POST', ip = '198.51.100.10' } = {},
) {
  return app.request(url, {
    method,
    headers: {
      'content-type': 'application/json',
      origin,
      host,
      'x-forwarded-for': ip,
    },
    body: JSON.stringify(body ?? {}),
  });
}

function as(id: string) {
  process.env.HAPPYCLAW_TEST_USER_ID = id;
}

function createUser(id: string, role: 'member' | 'admin' = 'member') {
  const now = new Date().toISOString();
  db.createUser({
    id,
    username: id,
    password_hash: bcrypt.hashSync(PASSWORD, 4),
    display_name: id,
    role,
    status: 'active',
    created_at: now,
    updated_at: now,
    must_change_password: false,
  });
}

async function register(
  authenticator: SoftAuthenticator,
  reauth: { password: string; code?: string } = { password: PASSWORD },
) {
  as(authenticator.userId);
  const options = await request('/api/auth/passkeys/options', reauth);
  expect(options.status).toBe(200);
  return request('/api/auth/passkeys', {
    response: authenticator.create(await options.json()),
    name: '这台 Mac',
  });
}

async function loginOptions(ip?: string) {
  return (
    await request('/api/auth/passkey/login/options', {}, ip ? { ip } : {})
  ).json();
}

async function login(
  authenticator: SoftAuthenticator,
  origin = ORIGIN,
  extra: Parameters<SoftAuthenticator['get']>[2] = {},
) {
  const options = await loginOptions();
  return request(
    '/api/auth/passkey/login',
    { response: authenticator.get(options, origin, extra) },
    { origin },
  );
}

beforeAll(() => {
  fs.mkdirSync(path.join(dataDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'groups'), { recursive: true });
  db.initDatabase();
  createUser('alice');
  createUser('bob');
  createUser('carol');
  createUser('dave');
  createUser('owner', 'admin');
  as('alice');
});

beforeEach(() => {
  resetPasskeyChallengesForTest();
  resetLoginAttemptsForTest();
  resetMfaChallengesForTest();
});

afterAll(() => {
  delete process.env.HAPPYCLAW_TEST_USER_ID;
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('passkey origin', () => {
  test('same origin, localhost or a listed origin; HTTPS only elsewhere', () => {
    expect(resolvePasskeyOrigin(ORIGIN, HOST)).toEqual({
      origin: ORIGIN,
      rpId: HOST,
    });
    expect(
      resolvePasskeyOrigin('http://localhost:5173', '127.0.0.1:3000'),
    ).toEqual({ origin: 'http://localhost:5173', rpId: 'localhost' });
    expect(
      resolvePasskeyOrigin('http://claw.lan:3000', 'claw.lan:3000'),
    ).toEqual({ problem: 'insecure' });
    expect(resolvePasskeyOrigin('https://evil.example', HOST)).toEqual({
      problem: 'not_allowed',
    });
    process.env.CORS_ALLOWED_ORIGINS = 'https://evil.example';
    try {
      expect(
        resolvePasskeyOrigin('https://evil.example', '127.0.0.1:3000'),
      ).toEqual({ origin: 'https://evil.example', rpId: 'evil.example' });
    } finally {
      delete process.env.CORS_ALLOWED_ORIGINS;
    }
    expect(resolvePasskeyOrigin(undefined, HOST)).toEqual({
      problem: 'no_origin',
    });
  });

  test.each([
    ['http://127.0.0.1:3000', '127.0.0.1:3000'],
    ['http://203.0.113.2:3000', '203.0.113.2:3000'],
    ['https://203.0.113.2', '203.0.113.2'],
    ['http://[::1]:3000', '[::1]:3000'],
    ['https://[2001:db8::1]', '[2001:db8::1]'],
  ])('an IP address is no RP ID: %s', (origin, host) => {
    expect(resolvePasskeyOrigin(origin, host)).toEqual({ problem: 'ip_host' });
  });
});

describe('passkeys', () => {
  const authenticator = new SoftAuthenticator();

  test('adding one takes the password, counted like a login', async () => {
    as('alice');
    const missing = await request('/api/auth/passkeys/options', {});
    expect(missing.status).toBe(400);
    expect((await missing.json()).code).toBe('INVALID_REQUEST');
    for (let i = 0; i < 5; i += 1) {
      const wrong = await request('/api/auth/passkeys/options', {
        password: `wrong-${i}`,
      });
      expect(wrong.status).toBe(400);
      expect((await wrong.json()).code).toBe('CURRENT_PASSWORD_INCORRECT');
    }
    const limited = await request('/api/auth/passkeys/options', {
      password: PASSWORD,
    });
    expect(limited.status).toBe(429);
    expect((await limited.json()).code).toBe('TOO_MANY_ATTEMPTS');
    expect(listPasskeys('alice')).toEqual([]);
  });

  test('register, then log in without a username', async () => {
    const options = await (
      await request('/api/auth/passkeys/options', { password: PASSWORD })
    ).json();
    // No experimental ML-DSA probe: the algorithms are named.
    expect(
      options.pubKeyCredParams.map((param: { alg: number }) => param.alg),
    ).toEqual([-8, -7, -257]);

    const added = await register(authenticator);
    expect(added.status).toBe(200);
    const { passkey } = await added.json();
    expect(passkey).toMatchObject({ name: '这台 Mac', rp_id: HOST });

    const ok = await login(authenticator);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('set-cookie')).toContain('=');
    expect((await ok.json()).user.username).toBe('alice');

    const list = await (
      await app.request('/api/auth/passkeys', {
        headers: { referer: `${ORIGIN}/settings`, host: HOST },
      })
    ).json();
    expect(list.rp_id).toBe(HOST);
    expect(list.two_factor_enabled).toBe(false);
    expect(list.passkeys[0].last_used_at).not.toBeNull();
  });

  test('a challenge is single use', async () => {
    const options = await loginOptions();
    const first = await request('/api/auth/passkey/login', {
      response: authenticator.get(options),
    });
    expect(first.status).toBe(200);
    const replay = await request('/api/auth/passkey/login', {
      response: authenticator.get(options),
    });
    expect(replay.status).toBe(400);
    expect((await replay.json()).code).toBe('PASSKEY_EXPIRED');
  });

  test('an expired challenge and an unknown credential answer differently', async () => {
    vi.useFakeTimers({ now: Date.now(), toFake: ['Date'] });
    try {
      const options = await loginOptions();
      vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
      const expired = await request('/api/auth/passkey/login', {
        response: authenticator.get(options),
      });
      expect((await expired.json()).code).toBe('PASSKEY_EXPIRED');
    } finally {
      vi.useRealTimers();
    }
    const unknown = await login(new SoftAuthenticator());
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).code).toBe('PASSKEY_INVALID');
  });

  test('user verification is required', async () => {
    const response = await login(authenticator, ORIGIN, { flags: 0x01 });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('PASSKEY_INVALID');
  });

  test("the user handle must be the credential's own user", async () => {
    const other = await login(authenticator, ORIGIN, { userHandle: 'bob' });
    expect(other.status).toBe(400);
    expect((await other.json()).code).toBe('PASSKEY_INVALID');
    const none = await login(authenticator, ORIGIN, { userHandle: null });
    expect(none.status).toBe(400);
  });

  test('a response signed for another origin is refused', async () => {
    const options = await loginOptions();
    const response = await request('/api/auth/passkey/login', {
      response: authenticator.get(options, 'https://phish.example'),
    });
    expect(response.status).toBe(400);
  });

  test('a credential made for one host is not accepted on another', async () => {
    const other = await login(authenticator, 'http://localhost:5173');
    expect(other.status).toBe(400);
  });

  test('a disabled user cannot log in with a passkey', async () => {
    db.updateUserFields('alice', { status: 'disabled' });
    try {
      const response = await login(authenticator);
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe('PASSKEY_INVALID');
    } finally {
      db.updateUserFields('alice', { status: 'active' });
    }
  });

  test('an IP address or an insecure page gets an explanation', async () => {
    const ip = await request(
      '/api/auth/passkey/login/options',
      {},
      { origin: 'http://203.0.113.2:3000', host: '203.0.113.2:3000' },
    );
    expect(ip.status).toBe(400);
    expect((await ip.json()).code).toBe('PASSKEY_IP_HOST');
    const insecure = await request(
      '/api/auth/passkey/login/options',
      {},
      { origin: 'http://claw.lan:3000', host: 'claw.lan:3000' },
    );
    expect((await insecure.json()).code).toBe('PASSKEY_INSECURE');
  });

  test('one client cannot push out the login challenges of others', async () => {
    const mine = await loginOptions('203.0.113.50');
    const flooded = await loginOptions('198.51.100.66');
    for (let i = 0; i < LOGIN_CHALLENGES_PER_CLIENT; i += 1) {
      await loginOptions('198.51.100.66');
    }
    const lost = await request('/api/auth/passkey/login', {
      response: authenticator.get(flooded),
    });
    expect((await lost.json()).code).toBe('PASSKEY_EXPIRED');
    const kept = await request('/api/auth/passkey/login', {
      response: authenticator.get(mine),
    });
    expect(kept.status).toBe(200);
  });

  test('renaming is limited to your own passkeys', async () => {
    const id = encodeURIComponent(listPasskeys('alice')[0].id);
    as('bob');
    const foreign = await request(
      `/api/auth/passkeys/${id}`,
      { name: 'mine now' },
      { method: 'PATCH' },
    );
    expect(foreign.status).toBe(404);
    as('alice');
    const own = await request(
      `/api/auth/passkeys/${id}`,
      { name: 'MacBook' },
      { method: 'PATCH' },
    );
    expect(own.status).toBe(200);
    expect(listPasskeys('alice')[0].name).toBe('MacBook');
  });

  test('removing one takes the password', async () => {
    as('alice');
    const { passkeys } = await (
      await app.request('/api/auth/passkeys', { headers: { host: HOST } })
    ).json();
    const id = encodeURIComponent(passkeys[0].id);
    const wrong = await request(`/api/auth/passkeys/${id}/delete`, {
      password: 'nope',
    });
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).code).toBe('CURRENT_PASSWORD_INCORRECT');
    const right = await request(`/api/auth/passkeys/${id}/delete`, {
      password: PASSWORD,
    });
    expect(right.status).toBe(200);
    expect((await login(authenticator)).status).toBe(400);
  });

  test('the per-user limit is checked again when the passkey is saved', async () => {
    const carol = new SoftAuthenticator('carol');
    as('carol');
    for (let i = 0; i < MAX_PASSKEYS_PER_USER - 1; i += 1) {
      insertPasskey({
        id: `carol-${i}`,
        user_id: 'carol',
        rp_id: HOST,
        public_key: 'AA',
        counter: 0,
        transports: null,
        name: `key ${i}`,
        created_at: new Date().toISOString(),
      });
    }
    const options = await (
      await request('/api/auth/passkeys/options', { password: PASSWORD })
    ).json();
    insertPasskey({
      id: 'carol-last',
      user_id: 'carol',
      rp_id: HOST,
      public_key: 'AA',
      counter: 0,
      transports: null,
      name: 'last',
      created_at: new Date().toISOString(),
    });
    const saved = await request('/api/auth/passkeys', {
      response: carol.create(options),
    });
    expect(saved.status).toBe(409);
    expect((await saved.json()).code).toBe('PASSKEY_LIMIT_REACHED');
    expect(listPasskeys('carol')).toHaveLength(MAX_PASSKEYS_PER_USER);
  });
});

describe('passkeys and two-factor authentication', () => {
  const bobKey = new SoftAuthenticator('bob');
  let secret = '';

  test('with two-factor on, adding one also takes a code', async () => {
    as('bob');
    const setup = await (
      await request('/api/auth/2fa/setup', {}, { ip: '198.51.100.20' })
    ).json();
    secret = setup.secret;
    const enabled = await request('/api/auth/2fa/enable', {
      password: PASSWORD,
      code: totpCode(secret, totpStep() - 1),
    });
    expect(enabled.status).toBe(200);

    const noCode = await request('/api/auth/passkeys/options', {
      password: PASSWORD,
    });
    expect(noCode.status).toBe(400);
    expect((await noCode.json()).code).toBe('MFA_REQUIRED');
    const wrongCode = await request('/api/auth/passkeys/options', {
      password: PASSWORD,
      code: '000000',
    });
    expect(wrongCode.status).toBe(400);
    expect((await wrongCode.json()).code).toBe('MFA_INVALID');

    const added = await register(bobKey, {
      password: PASSWORD,
      code: totpCode(secret, totpStep()),
    });
    expect(added.status).toBe(200);
  });

  test('a passkey login needs no second code', async () => {
    const ok = await login(bobKey);
    expect(ok.status).toBe(200);
    expect(ok.headers.get('set-cookie')).toContain('=');
    expect((await ok.json()).user.username).toBe('bob');
  });

  test('an admin 2FA reset keeps passkeys; revoking them removes all', async () => {
    as('owner');
    const reset = await app.request('/api/admin/users/bob/2fa', {
      method: 'DELETE',
    });
    expect(await reset.json()).toEqual({ success: true, removed: true });
    expect(listPasskeys('bob')).toHaveLength(1);

    const users = await (await app.request('/api/admin/users')).json();
    expect(
      users.users.find((user: { id: string }) => user.id === 'bob'),
    ).toMatchObject({ two_factor_enabled: false, passkey_count: 1 });

    const self = await app.request('/api/admin/users/owner/passkeys', {
      method: 'DELETE',
    });
    expect(self.status).toBe(400);
    const revoked = await app.request('/api/admin/users/bob/passkeys', {
      method: 'DELETE',
    });
    expect(await revoked.json()).toEqual({ success: true, removed: 1 });
    expect(listPasskeys('bob')).toEqual([]);
    expect((await login(bobKey)).status).toBe(400);
    const audit = db.queryAuthAuditLogs({ event_type: 'passkeys_revoked' });
    expect(audit.logs.map((log) => [log.username, log.actor_username])).toEqual(
      [['bob', 'owner']],
    );
  });

  test('a member cannot revoke the passkeys of an admin', async () => {
    db.updateUserFields('dave', { permissions: ['manage_users'] });
    as('dave');
    const denied = await app.request('/api/admin/users/owner/passkeys', {
      method: 'DELETE',
    });
    expect(denied.status).toBe(403);
  });

  test('deleting a user removes their passkeys', async () => {
    const daveKey = new SoftAuthenticator('dave');
    expect((await register(daveKey)).status).toBe(200);
    db.deleteUser('dave');
    expect(listPasskeys('dave')).toEqual([]);
  });
});

describe('guests', () => {
  beforeAll(() => {
    const now = new Date().toISOString();
    db.createUser({
      id: 'guest-1',
      username: 'guest-1',
      password_hash: bcrypt.hashSync(PASSWORD, 4),
      display_name: 'Guest',
      role: 'guest',
      status: 'active',
      created_at: now,
      updated_at: now,
      must_change_password: false,
      guest_owner_id: 'owner',
    });
  });

  test('get no passkeys, and cannot log in with one', async () => {
    as('guest-1');
    expect(
      (await app.request('/api/auth/passkeys', { headers: { host: HOST } }))
        .status,
    ).toBe(403);
    expect(
      (await request('/api/auth/passkeys/options', { password: PASSWORD }))
        .status,
    ).toBe(403);

    const guestKey = new SoftAuthenticator('guest-1');
    // A credential that should never exist for a guest.
    as('alice');
    const options = await (
      await request('/api/auth/passkeys/options', { password: PASSWORD })
    ).json();
    const made = guestKey.create(options);
    const stored = await request('/api/auth/passkeys', { response: made });
    expect(stored.status).toBe(200);
    const raw = new Database(path.join(dataDir, 'db', 'messages.db'));
    try {
      raw
        .prepare(
          "UPDATE webauthn_credentials SET user_id = 'guest-1' WHERE id = ?",
        )
        .run(made.id);
    } finally {
      raw.close();
    }
    const response = await login(guestKey);
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('PASSKEY_INVALID');
  });
});
