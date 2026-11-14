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

function as(id: string) {
  process.env.HAPPYCLAW_TEST_USER_ID = id;
}

/** Enrol `id` and return its secret and recovery codes. */
async function enrol(id: string, nowStep = totpStep()) {
  as(id);
  const setup = await (await post('/api/auth/2fa/setup', {})).json();
  const enable = await post('/api/auth/2fa/enable', {
    code: totpCode(setup.secret, nowStep),
  });
  expect(enable.status).toBe(200);
  const { recovery_codes } = await enable.json();
  return {
    secret: setup.secret as string,
    recovery: recovery_codes as string[],
  };
}

beforeAll(() => {
  fs.mkdirSync(path.join(dataDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'groups'), { recursive: true });
  db.initDatabase();
  createUser('owner', 'admin');
  createUser('alice', 'member');
  createUser('bob', 'member');
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

    const wrong = await post('/api/auth/2fa/enable', { code: '000000' });
    expect(wrong.status).toBe(400);
    expect((await (await app.request('/api/auth/2fa')).json()).enabled).toBe(
      false,
    );

    const ok = await post('/api/auth/2fa/enable', {
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
    expect((await post('/api/auth/2fa/setup', {})).status).toBe(409);
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
    const again = await (
      await post('/api/auth/login', { username: 'bob', password: PASSWORD })
    ).json();
    const replay = await post('/api/auth/login/2fa', {
      challenge: again.challenge,
      code: totpCode(secret, totpStep()),
    });
    expect(replay.status).toBe(400);
  });

  test('a recovery code logs in once', async () => {
    db.deleteUser('bob');
    db.restoreUser('bob');
    db.updateUserFields('bob', { status: 'active' });
    const { recovery } = await enrol('bob');
    const login = async () =>
      (
        await (
          await post('/api/auth/login', { username: 'bob', password: PASSWORD })
        ).json()
      ).challenge as string;

    const first = await post('/api/auth/login/2fa', {
      challenge: await login(),
      code: recovery[0].toUpperCase(),
    });
    expect(first.status).toBe(200);
    const second = await post('/api/auth/login/2fa', {
      challenge: await login(),
      code: recovery[0],
    });
    expect(second.status).toBe(400);
    as('bob');
    expect(
      (await (await app.request('/api/auth/2fa')).json())
        .recovery_codes_remaining,
    ).toBe(9);
  });

  test('a challenge allows five wrong codes', async () => {
    const challenge = (
      await (
        await post('/api/auth/login', { username: 'alice', password: PASSWORD })
      ).json()
    ).challenge;
    for (let i = 0; i < 4; i += 1) {
      resetLoginAttemptsForTest();
      await post('/api/auth/login/2fa', { challenge, code: '000000' });
    }
    resetLoginAttemptsForTest();
    expect(
      (await post('/api/auth/login/2fa', { challenge, code: '000000' })).status,
    ).toBe(400);
    const after = await post('/api/auth/login/2fa', {
      challenge,
      code: '000000',
    });
    expect((await after.json()).code).toBe('MFA_EXPIRED');
  });

  test('turning it off needs the password and a current code', async () => {
    as('alice');
    const noPassword = await post('/api/auth/2fa/disable', {
      password: 'wrong-password',
      code: '000000',
    });
    expect(noPassword.status).toBe(400);
    const noCode = await post('/api/auth/2fa/disable', {
      password: PASSWORD,
      code: '000000',
    });
    expect(noCode.status).toBe(400);
    expect((await (await app.request('/api/auth/2fa')).json()).enabled).toBe(
      true,
    );
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
