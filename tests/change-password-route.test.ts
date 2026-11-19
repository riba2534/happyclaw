import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

vi.hoisted(() => {
  process.env.WEB_SESSION_SECRET = 'change-password-route-secret';
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'change-password-route-'));
const storeDir = path.join(tmp, 'db');

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    DATA_DIR: tmp,
    STORE_DIR: storeDir,
    GROUPS_DIR: path.join(tmp, 'groups'),
    TRUST_PROXY: true,
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const { saveRegistrationConfig } = await import('../src/runtime-config.js');
const authRoutes = (await import('../src/routes/auth.js')).default;
const adminRoutes = (await import('../src/routes/admin.js')).default;

const app = new Hono()
  .route('/api/auth', authRoutes)
  .route('/api/admin', adminRoutes);
const ADMIN_PASSWORD = 'admin-password-1';

function send(
  method: string,
  url: string,
  options: { cookie?: string; body?: unknown; ip?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-forwarded-for': options.ip ?? '198.51.100.20',
  };
  if (options.cookie) headers.cookie = options.cookie;
  return app.request(`http://happyclaw.test${url}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

/** The session cookie a response sets (the other name is cleared). */
function cookieFrom(response: Response): string {
  return response.headers
    .getSetCookie()
    .map((line) => line.split(';')[0])
    .filter((pair) => !pair.endsWith('='))
    .join('; ');
}

beforeAll(() => {
  fs.mkdirSync(path.join(tmp, 'groups'), { recursive: true });
  fs.mkdirSync(storeDir, { recursive: true });
  db.initDatabase();
  saveRegistrationConfig({ allowRegistration: true, requireInviteCode: false });
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const login = (password: string) =>
  send('POST', '/api/auth/login', { body: { username: 'admin', password } });

describe('PUT /api/auth/password', () => {
  test('a wrong current password is a 400 that keeps the session', async () => {
    const setup = await send('POST', '/api/auth/setup', {
      body: { username: 'admin', password: ADMIN_PASSWORD },
    });
    expect(setup.status).toBe(201);
    const cookie = cookieFrom(setup);

    const wrong = await send('PUT', '/api/auth/password', {
      cookie,
      body: {
        current_password: 'not-it-123',
        new_password: 'admin-password-2',
      },
    });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({
      error: '当前密码不正确',
      code: 'CURRENT_PASSWORD_INCORRECT',
    });
    expect((await send('GET', '/api/auth/me', { cookie })).status).toBe(200);

    const same = await send('PUT', '/api/auth/password', {
      cookie,
      body: { current_password: ADMIN_PASSWORD, new_password: ADMIN_PASSWORD },
    });
    expect(same.status).toBe(400);
    expect(await same.json()).toMatchObject({ code: 'PASSWORD_UNCHANGED' });

    // Neither attempt changed anything.
    expect((await login(ADMIN_PASSWORD)).status).toBe(200);
  });

  test('a change takes effect at once: the new password logs in, the old does not', async () => {
    const cookie = cookieFrom(await login(ADMIN_PASSWORD));
    const changed = await send('PUT', '/api/auth/password', {
      cookie,
      body: {
        current_password: ADMIN_PASSWORD,
        new_password: 'admin-password-2',
      },
    });
    expect(changed.status).toBe(200);
    expect((await login(ADMIN_PASSWORD)).status).toBe(401);
    expect((await login('admin-password-2')).status).toBe(200);
  });
});
