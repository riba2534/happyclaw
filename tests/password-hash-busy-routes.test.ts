import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

vi.hoisted(() => {
  process.env.WEB_SESSION_SECRET = 'password-hash-busy-routes-secret';
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'password-hash-busy-'));
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
const { saveRegistrationConfig, getSystemSettings } =
  await import('../src/runtime-config.js');
const { loginAttemptStats, resetLoginAttemptsForTest } =
  await import('../src/auth.js');
const { passwordHashPoolForTest } =
  await import('../src/password-hash-worker.js');
const { onPasswordHashBusy, PASSWORD_HASH_BUSY_MESSAGE } =
  await import('../src/password-hash-busy.js');
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

async function expectBusy(response: Response): Promise<void> {
  expect(response.status).toBe(503);
  expect(response.headers.get('retry-after')).toBe('1');
  expect(await response.json()).toEqual({ error: PASSWORD_HASH_BUSY_MESSAGE });
}

/** Every hash/compare is refused, as when the bounded queue is full. */
const saturate = () => passwordHashPoolForTest.reset({ maxPendingTasks: 0 });
const restore = () => passwordHashPoolForTest.reset();

let adminCookie: string | null = null;
/** Run the initial setup once and return the admin's session cookie. */
async function ensureAdmin(): Promise<string> {
  if (adminCookie) return adminCookie;
  const setup = await send('POST', '/api/auth/setup', {
    body: { username: 'admin', password: ADMIN_PASSWORD },
  });
  expect(setup.status).toBe(201);
  adminCookie = cookieFrom(setup);
  return adminCookie;
}

beforeAll(() => {
  fs.mkdirSync(path.join(tmp, 'groups'), { recursive: true });
  fs.mkdirSync(storeDir, { recursive: true });
  db.initDatabase();
  saveRegistrationConfig({ allowRegistration: true, requireInviteCode: false });
});

afterAll(async () => {
  await restore();
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('password routes under a full hashing queue', () => {
  test('setup answers 503 and creates nothing', async () => {
    await saturate();
    try {
      await expectBusy(
        await send('POST', '/api/auth/setup', {
          body: { username: 'admin', password: ADMIN_PASSWORD },
        }),
      );
      expect(db.getUserCount(true)).toBe(0);
    } finally {
      await restore();
    }
  });

  test('register, login, change password and admin user writes answer 503', async () => {
    const cookie = await ensureAdmin();
    const member = await send('POST', '/api/admin/users', {
      cookie,
      body: { username: 'member1', password: 'member-password-1' },
    });
    expect(member.status).toBe(201);
    const memberId = ((await member.json()) as { user: { id: string } }).user
      .id;

    resetLoginAttemptsForTest();
    await saturate();
    try {
      await expectBusy(
        await send('POST', '/api/auth/register', {
          body: { username: 'newcomer', password: 'newcomer-password' },
        }),
      );
      await expectBusy(
        await send('POST', '/api/auth/login', {
          body: { username: 'admin', password: ADMIN_PASSWORD },
        }),
      );
      // Neither refused attempt stays counted.
      expect(loginAttemptStats().entries).toBe(0);
      await expectBusy(
        await send('PUT', '/api/auth/password', {
          cookie,
          body: {
            current_password: ADMIN_PASSWORD,
            new_password: 'admin-password-2',
          },
        }),
      );
      await expectBusy(
        await send('POST', '/api/admin/users', {
          cookie,
          body: { username: 'member2', password: 'member-password-2' },
        }),
      );
      await expectBusy(
        await send('PATCH', `/api/admin/users/${memberId}`, {
          cookie,
          body: { password: 'member-password-3' },
        }),
      );
    } finally {
      await restore();
    }

    // Nothing was written while refused.
    expect(db.getUserByUsername('newcomer')).toBeUndefined();
    expect(db.getUserByUsername('member2')).toBeUndefined();
    const login = await send('POST', '/api/auth/login', {
      body: { username: 'admin', password: ADMIN_PASSWORD },
    });
    expect(login.status).toBe(200);
  });

  test('concurrent registrations from one IP are counted before bcrypt runs', async () => {
    await ensureAdmin();
    resetLoginAttemptsForTest();
    const limit = getSystemSettings().maxLoginAttempts;
    const statuses = await Promise.all(
      Array.from({ length: limit + 10 }, (_, i) =>
        send('POST', '/api/auth/register', {
          ip: '203.0.113.30',
          body: { username: `burst_${i}`, password: 'burst-password-1' },
        }).then((res) => res.status),
      ),
    );
    expect(statuses.filter((status) => status === 201)).toHaveLength(limit);
    expect(statuses.filter((status) => status === 429)).toHaveLength(10);
  });
});

describe('onPasswordHashBusy', () => {
  test('leaves other errors to the default treatment', async () => {
    const probe = new Hono();
    probe.onError(onPasswordHashBusy);
    probe.get('/boom', () => {
      throw new Error('boom');
    });
    probe.get('/teapot', () => {
      throw new HTTPException(418, { message: 'teapot' });
    });
    const boom = await probe.request('/boom');
    expect(boom.status).toBe(500);
    expect(await boom.text()).toBe('Internal Server Error');
    const teapot = await probe.request('/teapot');
    expect(teapot.status).toBe(418);
    expect(await teapot.text()).toBe('teapot');
  });
});
