/**
 * Web Push subscriptions follow login sessions. A password change made on a
 * device replaces every session, the device's own included: that device
 * keeps its subscription under its new session, every other device loses
 * its own.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

vi.hoisted(() => {
  process.env.WEB_SESSION_SECRET = 'push-session-rotation-test-secret';
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'push-session-rotation-'));
const storeDir = path.join(tmp, 'db');

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: tmp,
  STORE_DIR: storeDir,
  GROUPS_DIR: path.join(tmp, 'groups'),
  TRUST_PROXY: true,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const store = await import('../src/web-push-store.js');
const { saveRegistrationConfig } = await import('../src/runtime-config.js');
const authRoutes = (await import('../src/routes/auth.js')).default;
const adminRoutes = (await import('../src/routes/admin.js')).default;
const pushRoutes = (await import('../src/routes/push.js')).default;

const app = new Hono()
  .route('/api/auth', authRoutes)
  .route('/api/admin', adminRoutes)
  .route('/api/push', pushRoutes);

const KEYS = {
  p256dh:
    'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
  auth: 'tBHItJI5svbpez7KI4CCXg',
};
const endpoint = (name: string) =>
  `https://fcm.googleapis.com/fcm/send/${name}`;

async function send(
  method: string,
  url: string,
  options: { cookie?: string; body?: unknown; clientIp?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    'x-forwarded-for': options.clientIp ?? '198.51.100.40',
  };
  if (options.cookie) headers.cookie = options.cookie;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  return app.request(`http://happyclaw.test${url}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

/** The Cookie header for the session a response sets. */
function sessionCookie(response: Response): string {
  const line = response.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .find((pair) => !pair.endsWith('='));
  expect(line).toBeDefined();
  return line!;
}

async function signIn(
  username: string,
  password: string,
  clientIp: string,
): Promise<string> {
  const response = await send('POST', '/api/auth/login', {
    body: { username, password },
    clientIp,
  });
  expect(response.status).toBe(200);
  return sessionCookie(response);
}

async function subscribe(cookie: string, name: string): Promise<void> {
  const response = await send('POST', '/api/push/subscribe', {
    cookie,
    body: { endpoint: endpoint(name), keys: KEYS },
  });
  expect(response.status).toBe(200);
}

function onlySessionOf(userId: string): string {
  const sessions = db.getUserSessions(userId);
  expect(sessions).toHaveLength(1);
  return sessions[0].id;
}

let adminId = '';
let memberId = '';

beforeAll(async () => {
  fs.mkdirSync(path.join(tmp, 'groups'), { recursive: true });
  fs.mkdirSync(storeDir, { recursive: true });
  process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
  db.initDatabase();
  saveRegistrationConfig({ allowRegistration: true, requireInviteCode: false });
  const setup = await send('POST', '/api/auth/setup', {
    body: { username: 'admin', password: 'admin-password-1' },
  });
  expect(setup.status).toBe(201);
  adminId = ((await setup.json()) as { user: { id: string } }).user.id;
  const register = await send('POST', '/api/auth/register', {
    body: { username: 'member', password: 'member-password-1' },
    clientIp: '198.51.100.41',
  });
  expect(register.status).toBe(201);
  memberId = ((await register.json()) as { user: { id: string } }).user.id;
});

afterAll(() => {
  db.closeDatabase();
  delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('a password change keeps push on the device that made it', () => {
  test('PUT /api/auth/password', async () => {
    const phone = await signIn('member', 'member-password-1', '198.51.100.42');
    const laptop = await signIn('member', 'member-password-1', '198.51.100.43');
    await subscribe(phone, 'member-phone');
    await subscribe(laptop, 'member-laptop');

    const response = await send('PUT', '/api/auth/password', {
      cookie: phone,
      body: {
        current_password: 'member-password-1',
        new_password: 'member-password-2',
      },
    });
    expect(response.status).toBe(200);
    const next = sessionCookie(response);

    const kept = store.getWebPushSubscription(endpoint('member-phone'));
    expect(kept?.session_id).toBe(onlySessionOf(memberId));
    expect(store.getWebPushSubscription(endpoint('member-laptop'))).toBe(
      undefined,
    );

    // The moved row still ends with its (new) session.
    expect(
      (await send('POST', '/api/auth/logout', { cookie: next })).status,
    ).toBe(200);
    expect(store.getWebPushSubscription(endpoint('member-phone'))).toBe(
      undefined,
    );
  });

  test('PATCH /api/admin/users/:id by an admin on their own account', async () => {
    const desk = await signIn('admin', 'admin-password-1', '198.51.100.44');
    const tablet = await signIn('admin', 'admin-password-1', '198.51.100.45');
    await subscribe(desk, 'admin-desk');
    await subscribe(tablet, 'admin-tablet');

    const response = await send('PATCH', `/api/admin/users/${adminId}`, {
      cookie: desk,
      body: { password: 'admin-password-2' },
    });
    expect(response.status).toBe(200);
    sessionCookie(response);

    expect(
      store.getWebPushSubscription(endpoint('admin-desk'))?.session_id,
    ).toBe(onlySessionOf(adminId));
    expect(store.getWebPushSubscription(endpoint('admin-tablet'))).toBe(
      undefined,
    );
  });
});
