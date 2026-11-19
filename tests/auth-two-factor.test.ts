/**
 * Two-factor login (TOTP): enrolment, the two-step login, replay and
 * recovery codes, turning it off, and the admin reset path.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { Hono } from 'hono';
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
  process.env.WEB_SESSION_SECRET = 'two-factor-test-secret';
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'two-factor-'));
const dataDir = path.join(tmp, 'install', 'data');

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    DATA_DIR: dataDir,
    STORE_DIR: path.join(dataDir, 'db'),
    GROUPS_DIR: path.join(dataDir, 'groups'),
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/middleware/auth.js', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../src/middleware/auth.js')>();
  const asUser = async (c: any, next: any) => {
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
  };
  return { ...real, authMiddleware: asUser };
});

const db = await import('../src/db.js');
const { resetLoginAttemptsForTest } = await import('../src/auth.js');
const { totpCode, totpStep } = await import('../src/totp.js');
const { resetMfaChallengesForTest } = await import('../src/auth-mfa.js');
const authRoutes = (await import('../src/routes/auth.js')).default;
const adminRoutes = (await import('../src/routes/admin.js')).default;

const Database = (await import('better-sqlite3')).default;

const app = new Hono()
  .route('/api/auth', authRoutes)
  .route('/api/admin', adminRoutes);

const PASSWORD = 'owner-password-1';

function post(url: string, body: unknown) {
  return app.request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function createUser(id: string, role: 'admin' | 'member'): void {
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

function createSession(id: string, userId: string): void {
  const now = new Date().toISOString();
  db.createUserSession({
    id,
    user_id: userId,
    ip_address: null,
    user_agent: null,
    created_at: now,
    expires_at: '2099-01-01T00:00:00.000Z',
    last_active_at: now,
  });
}

function as(id: string) {
  process.env.HAPPYCLAW_TEST_USER_ID = id;
}

/** Enrol `id` and return its secret and recovery codes. */
async function enrol(id: string, nowStep = totpStep()) {
  as(id);
  const setup = await (await post('/api/auth/2fa/setup', {})).json();
  const enable = await post('/api/auth/2fa/enable', {
    password: PASSWORD,
    code: totpCode(setup.secret, nowStep),
  });
  expect(enable.status).toBe(200);
  const { recovery_codes } = await enable.json();
  return {
    secret: setup.secret as string,
    recovery: recovery_codes as string[],
  };
}

async function challengeFor(username: string): Promise<string> {
  const login = await post('/api/auth/login', { username, password: PASSWORD });
  expect(login.status).toBe(200);
  return (await login.json()).challenge;
}

beforeAll(() => {
  fs.mkdirSync(path.join(dataDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'groups'), { recursive: true });
  db.initDatabase();
  createUser('owner', 'admin');
  createUser('alice', 'member');
  createUser('bob', 'member');
  createUser('carol', 'member');
  createUser('dave', 'member');
  createUser('erin', 'member');
  for (const id of ['frank', 'gina', 'hank', 'ivan', 'judy', 'kate', 'liam']) {
    createUser(id, 'member');
  }
  createUser('mona', 'admin');
});

beforeEach(() => {
  resetLoginAttemptsForTest();
  resetMfaChallengesForTest();
});

afterAll(() => {
  delete process.env.HAPPYCLAW_TEST_USER_ID;
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('two-factor login', () => {
  test('enrolment returns a QR code and turns on only after a valid code', async () => {
    as('alice');
    const setup = await (await post('/api/auth/2fa/setup', {})).json();
    expect(setup.otpauth_uri).toMatch(/^otpauth:\/\/totp\/HappyClaw%3Aalice\?/);
    expect(setup.qr_data_url).toMatch(/^data:image\/png;base64,/);

    const wrong = await post('/api/auth/2fa/enable', {
      password: PASSWORD,
      code: '000000',
    });
    expect(wrong.status).toBe(400);
    expect((await wrong.json()).code).toBe('MFA_INVALID');
    expect((await (await app.request('/api/auth/2fa')).json()).enabled).toBe(
      false,
    );

    const ok = await post('/api/auth/2fa/enable', {
      password: PASSWORD,
      code: totpCode(setup.secret, totpStep()),
    });
    const body = await ok.json();
    expect(body.recovery_codes).toHaveLength(10);
    expect(body.recovery_codes[0]).toMatch(/^[a-z2-7]{5}-[a-z2-7]{5}$/);
    expect(await (await app.request('/api/auth/2fa')).json()).toEqual({
      enabled: true,
      recovery_codes_remaining: 10,
    });
    // A second setup while on is refused.
    const again = await post('/api/auth/2fa/setup', {});
    expect(again.status).toBe(409);
    expect((await again.json()).code).toBe('MFA_ALREADY_ENABLED');
  });

  test('turning it on takes the password and ends the other sessions', async () => {
    as('carol');
    createSession('test-session', 'carol');
    createSession('carol-phone', 'carol');
    const setup = await (await post('/api/auth/2fa/setup', {})).json();
    const code = totpCode(setup.secret, totpStep());

    const noPassword = await post('/api/auth/2fa/enable', { code });
    expect(noPassword.status).toBe(400);
    expect((await noPassword.json()).code).toBe('INVALID_REQUEST');
    const wrongPassword = await post('/api/auth/2fa/enable', {
      password: 'not-the-password',
      code,
    });
    expect(wrongPassword.status).toBe(400);
    expect((await wrongPassword.json()).code).toBe(
      'CURRENT_PASSWORD_INCORRECT',
    );
    expect((await (await app.request('/api/auth/2fa')).json()).enabled).toBe(
      false,
    );
    expect(db.getUserSessions('carol')).toHaveLength(2);

    const ok = await post('/api/auth/2fa/enable', {
      password: PASSWORD,
      code,
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).sessions_revoked).toBe(1);
    expect(db.getUserSessions('carol').map((s) => s.id)).toEqual([
      'test-session',
    ]);
    expect(
      db.queryAuthAuditLogs({ event_type: 'mfa_enabled', username: 'carol' })
        .logs[0]?.details,
    ).toMatchObject({ sessions_revoked: 1 });
  });

  test('a correct password earns a challenge, not a session', async () => {
    const { secret } = await enrol('bob', totpStep() - 1);
    const login = await post('/api/auth/login', {
      username: 'bob',
      password: PASSWORD,
    });
    expect(login.status).toBe(200);
    expect(login.headers.get('set-cookie')).toBeNull();
    const { mfa_required, challenge } = await login.json();
    expect(mfa_required).toBe(true);

    const wrong = await post('/api/auth/login/2fa', {
      challenge,
      code: '123456',
    });
    expect(wrong.status).toBe(400);

    const ok = await post('/api/auth/login/2fa', {
      challenge,
      code: totpCode(secret, totpStep()),
    });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('set-cookie')).toContain('=');
    expect((await ok.json()).user.username).toBe('bob');

    // The challenge is spent, and the same code cannot log in again.
    expect(
      (await post('/api/auth/login/2fa', { challenge, code: '000000' })).status,
    ).toBe(400);
    const replay = await post('/api/auth/login/2fa', {
      challenge: await challengeFor('bob'),
      code: totpCode(secret, totpStep()),
    });
    expect(replay.status).toBe(400);
  });

  test('a recovery code logs in once', async () => {
    db.deleteUser('bob');
    db.restoreUser('bob');
    db.updateUserFields('bob', { status: 'active' });
    const { recovery } = await enrol('bob');

    const first = await post('/api/auth/login/2fa', {
      challenge: await challengeFor('bob'),
      code: recovery[0].toUpperCase(),
    });
    expect(first.status).toBe(200);
    const second = await post('/api/auth/login/2fa', {
      challenge: await challengeFor('bob'),
      code: recovery[0],
    });
    expect(second.status).toBe(400);
    as('bob');
    expect(
      (await (await app.request('/api/auth/2fa')).json())
        .recovery_codes_remaining,
    ).toBe(9);
  });

  test('recovery codes are stored with a salt of their own', async () => {
    const conn = new Database(path.join(dataDir, 'db', 'messages.db'), {
      readonly: true,
    });
    try {
      const rows = conn
        .prepare(
          'SELECT salt, code_hash FROM user_recovery_codes WHERE user_id = ?',
        )
        .all('bob') as Array<{ salt: string; code_hash: string }>;
      expect(rows).toHaveLength(10);
      expect(new Set(rows.map((row) => row.salt)).size).toBe(10);
      for (const row of rows) expect(row.salt).toMatch(/^[0-9a-f]{32}$/);
    } finally {
      conn.close();
    }
  });

  test('a challenge allows five wrong codes, and they count as failed logins', async () => {
    const challenge = await challengeFor('alice');
    for (let i = 0; i < 5; i += 1) {
      const wrong = await post('/api/auth/login/2fa', {
        challenge,
        code: '000000',
      });
      expect(wrong.status).toBe(400);
    }
    const after = await post('/api/auth/login/2fa', {
      challenge,
      code: '000000',
    });
    expect((await after.json()).code).toBe('MFA_EXPIRED');
    // Five wrong codes lock the password step too.
    const login = await post('/api/auth/login', {
      username: 'alice',
      password: PASSWORD,
    });
    expect(login.status).toBe(429);
  });

  test('a limited second step answers with a code and Retry-After', async () => {
    const first = await challengeFor('alice');
    const second = await challengeFor('alice');
    for (let i = 0; i < 5; i += 1) {
      await post('/api/auth/login/2fa', { challenge: first, code: '000000' });
    }
    for (const limited of [
      await post('/api/auth/login/2fa', { challenge: second, code: '000000' }),
      await post('/api/auth/login', { username: 'alice', password: PASSWORD }),
    ]) {
      expect(limited.status).toBe(429);
      const body = await limited.json();
      expect(body).toMatchObject({ code: 'TOO_MANY_ATTEMPTS' });
      expect(body.retry_after_seconds).toBeGreaterThan(0);
      expect(limited.headers.get('retry-after')).toBe(
        String(body.retry_after_seconds),
      );
    }
  });

  test('knowing the password does not reset the code guesses', async () => {
    const first = await challengeFor('alice');
    for (let i = 0; i < 4; i += 1) {
      await post('/api/auth/login/2fa', { challenge: first, code: '000000' });
    }
    // A fresh challenge must not wipe the four failures.
    const second = await challengeFor('alice');
    expect(
      (await post('/api/auth/login/2fa', { challenge: second, code: '000000' }))
        .status,
    ).toBe(400);
    expect(
      (await post('/api/auth/login', { username: 'alice', password: PASSWORD }))
        .status,
    ).toBe(429);
  });

  test('a right second step clears the failures', async () => {
    const { secret } = await enrol('dave', totpStep() - 1);
    const challenge = await challengeFor('dave');
    for (let i = 0; i < 3; i += 1) {
      await post('/api/auth/login/2fa', { challenge, code: '000000' });
    }
    const ok = await post('/api/auth/login/2fa', {
      challenge,
      code: totpCode(secret, totpStep()),
    });
    expect(ok.status).toBe(200);
    for (let i = 0; i < 4; i += 1) {
      await post('/api/auth/login', {
        username: 'dave',
        password: 'nope-1234',
      });
    }
    expect(
      (await post('/api/auth/login', { username: 'dave', password: PASSWORD }))
        .status,
    ).toBe(200);
  });

  test('turning it off needs the password and a current code', async () => {
    as('alice');
    const noPassword = await post('/api/auth/2fa/disable', {
      password: 'wrong-password',
      code: '000000',
    });
    expect(noPassword.status).toBe(400);
    expect((await noPassword.json()).code).toBe('CURRENT_PASSWORD_INCORRECT');
    const noCode = await post('/api/auth/2fa/disable', {
      password: PASSWORD,
      code: '000000',
    });
    expect(noCode.status).toBe(400);
    expect((await noCode.json()).code).toBe('MFA_INVALID');
    expect((await (await app.request('/api/auth/2fa')).json()).enabled).toBe(
      true,
    );
    as('erin');
    const off = await post('/api/auth/2fa/disable', {
      password: PASSWORD,
      code: '000000',
    });
    expect(off.status).toBe(409);
    expect((await off.json()).code).toBe('MFA_NOT_ENABLED');
  });

  test('wrong passwords to turn it off count as failed logins', async () => {
    as('alice');
    for (let i = 0; i < 5; i += 1) {
      const wrong = await post('/api/auth/2fa/disable', {
        password: `wrong-password-${i}`,
        code: '000000',
      });
      expect((await wrong.json()).code).toBe('CURRENT_PASSWORD_INCORRECT');
    }
    const limited = await post('/api/auth/2fa/disable', {
      password: PASSWORD,
      code: '000000',
    });
    expect(limited.status).toBe(429);
    expect((await limited.json()).code).toBe('TOO_MANY_ATTEMPTS');
  });

  test('a lost sealing key is an explicit error, and recovery codes still work', async () => {
    const { recovery } = await enrol('erin', totpStep() - 1);
    // Sealed under some other key: what a replaced claude-provider.key reads.
    const conn = new Database(path.join(dataDir, 'db', 'messages.db'));
    try {
      conn
        .prepare("UPDATE user_totp SET secret_enc = ? WHERE user_id = 'erin'")
        .run('v1:AAAAAAAAAAAAAAAA:AAAAAAAAAAAAAAAAAAAAAA==:AAAAAAAA');
    } finally {
      conn.close();
    }
    const challenge = await challengeFor('erin');
    const totp = await post('/api/auth/login/2fa', {
      challenge,
      code: '123456',
    });
    expect(totp.status).toBe(500);
    expect((await totp.json()).code).toBe('MFA_SECRET_UNREADABLE');
    // The challenge survives, and a recovery code needs no key.
    const ok = await post('/api/auth/login/2fa', {
      challenge,
      code: recovery[0],
    });
    expect(ok.status).toBe(200);

    as('erin');
    const regenerate = await post('/api/auth/2fa/recovery-codes', {
      code: '123456',
    });
    expect(regenerate.status).toBe(500);
    expect((await regenerate.json()).code).toBe('MFA_SECRET_UNREADABLE');
  });

  test('an admin resets a member, not their own', async () => {
    as('owner');
    const self = await app.request('/api/admin/users/owner/2fa', {
      method: 'DELETE',
    });
    expect(self.status).toBe(400);
    const reset = await app.request('/api/admin/users/alice/2fa', {
      method: 'DELETE',
    });
    expect(await reset.json()).toEqual({ success: true, removed: true });
    const login = await post('/api/auth/login', {
      username: 'alice',
      password: PASSWORD,
    });
    expect(login.headers.get('set-cookie')).toContain('=');
    const audit = db.queryAuthAuditLogs({ event_type: 'mfa_reset' });
    expect(audit.logs.map((log) => log.username)).toEqual(['alice']);
  });

  test('deleting a user removes their factors', async () => {
    await enrol('alice');
    db.deleteUser('alice');
    as('alice');
    expect((await (await app.request('/api/auth/2fa')).json()).enabled).toBe(
      false,
    );
  });
});

describe('follow-up hardening', () => {
  test('wrong first codes when turning it on count as failed logins', async () => {
    as('frank');
    await post('/api/auth/2fa/setup', {});
    for (let i = 0; i < 5; i += 1) {
      const wrong = await post('/api/auth/2fa/enable', {
        password: PASSWORD,
        code: '000000',
      });
      expect((await wrong.json()).code).toBe('MFA_INVALID');
    }
    const limited = await post('/api/auth/2fa/enable', {
      password: PASSWORD,
      code: '000000',
    });
    expect(limited.status).toBe(429);
    expect((await limited.json()).code).toBe('TOO_MANY_ATTEMPTS');
  });

  test("a signed-in user's right code does not clear earlier failed logins", async () => {
    const { secret } = await enrol('gina', totpStep() - 1);
    for (let i = 0; i < 4; i += 1) {
      await post('/api/auth/login', { username: 'gina', password: 'nope-123' });
    }
    as('gina');
    const regenerated = await post('/api/auth/2fa/recovery-codes', {
      code: totpCode(secret, totpStep()),
    });
    expect(regenerated.status).toBe(200);
    await post('/api/auth/login', { username: 'gina', password: 'nope-123' });
    expect(
      (await post('/api/auth/login', { username: 'gina', password: PASSWORD }))
        .status,
    ).toBe(429);
  });

  describe('a pending login challenge goes stale', () => {
    const expectStale = async (challenge: string, code = '123456') => {
      const response = await post('/api/auth/login/2fa', { challenge, code });
      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe('MFA_EXPIRED');
    };

    test('when the password changes (an admin, or the reset script)', async () => {
      const { secret } = await enrol('hank', totpStep() - 1);
      const byAdmin = await challengeFor('hank');
      const byScript = await challengeFor('hank');
      as('owner');
      const reset = await app.request('/api/admin/users/hank', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'hank-new-password-1' }),
      });
      expect(reset.status).toBe(200);
      await expectStale(byAdmin, totpCode(secret, totpStep()));
      // Out of process, as `npm run reset:admin` writes it.
      db.updateUserFields('hank', {
        password_hash: bcrypt.hashSync(PASSWORD, 4),
      });
      await expectStale(byScript, totpCode(secret, totpStep()));
    });

    test('when the user changes their own password', async () => {
      const { secret } = await enrol('ivan', totpStep() - 1);
      const challenge = await challengeFor('ivan');
      as('ivan');
      const changed = await app.request('/api/auth/password', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          current_password: PASSWORD,
          new_password: 'ivan-new-password-1',
        }),
      });
      expect(changed.status).toBe(200);
      await expectStale(challenge, totpCode(secret, totpStep()));
    });

    test('when 2FA is turned off, or reset and set up again', async () => {
      const { secret } = await enrol('judy', totpStep() - 1);
      const beforeOff = await challengeFor('judy');
      as('judy');
      const off = await post('/api/auth/2fa/disable', {
        password: PASSWORD,
        code: totpCode(secret, totpStep()),
      });
      expect(off.status).toBe(200);
      await expectStale(beforeOff);

      const again = await enrol('judy', totpStep() - 1);
      const beforeReset = await challengeFor('judy');
      as('owner');
      await app.request('/api/admin/users/judy/2fa', { method: 'DELETE' });
      const renewed = await enrol('judy', totpStep() - 1);
      await expectStale(beforeReset, totpCode(renewed.secret, totpStep()));
      expect(again.secret).not.toBe(renewed.secret);
    });

    test('when the account is disabled, even if enabled again', async () => {
      const { secret } = await enrol('kate', totpStep() - 1);
      const challenge = await challengeFor('kate');
      as('owner');
      for (const status of ['disabled', 'active']) {
        const res = await app.request('/api/admin/users/kate', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ status }),
        });
        expect(res.status).toBe(200);
      }
      await expectStale(challenge, totpCode(secret, totpStep()));
    });

    test('when the account is deleted', async () => {
      const { secret } = await enrol('liam', totpStep() - 1);
      const challenge = await challengeFor('liam');
      as('owner');
      const res = await app.request('/api/admin/users/liam', {
        method: 'DELETE',
      });
      expect(res.status).toBe(200);
      await expectStale(challenge, totpCode(secret, totpStep()));
    });
  });

  test('an admin changing their own password in user management gives the current one', async () => {
    as('mona');
    const change = (body: Record<string, string>) =>
      app.request('/api/admin/users/mona', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'mona-new-password-1', ...body }),
      });
    const missing = await change({});
    expect(missing.status).toBe(400);
    expect((await missing.json()).code).toBe('CURRENT_PASSWORD_INCORRECT');
    for (let i = 0; i < 4; i += 1) {
      const wrong = await change({ current_password: `wrong-${i}` });
      expect((await wrong.json()).code).toBe('CURRENT_PASSWORD_INCORRECT');
    }
    const limited = await change({ current_password: PASSWORD });
    expect(limited.status).toBe(429);
    resetLoginAttemptsForTest();
    const ok = await change({ current_password: PASSWORD });
    expect(ok.status).toBe(200);
    expect(
      (
        await post('/api/auth/login', {
          username: 'mona',
          password: 'mona-new-password-1',
        })
      ).status,
    ).toBe(200);
  });
});
