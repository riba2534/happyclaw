import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

vi.hoisted(() => {
  process.env.WEB_SESSION_SECRET = 'session-cookie-route-test-secret';
  process.env.ALLOW_LEGACY_UNSIGNED_COOKIE = 'true';
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cookie-routes-'));
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
const { generateSessionToken, sessionExpiresAt } =
  await import('../src/auth.js');
const authRoutes = (await import('../src/routes/auth.js')).default;
const adminRoutes = (await import('../src/routes/admin.js')).default;
const { SESSION_COOKIE_NAME_SECURE, SESSION_COOKIE_NAME_PLAIN } =
  await import('../src/config.js');

const app = new Hono()
  .route('/api/auth', authRoutes)
  .route('/api/admin', adminRoutes);

type Scheme = 'http' | 'https';

function resetDatabase(): void {
  db.closeDatabase();
  fs.rmSync(storeDir, { recursive: true, force: true });
  fs.mkdirSync(storeDir, { recursive: true });
  db.initDatabase();
}

beforeAll(() => {
  fs.mkdirSync(path.join(tmp, 'groups'), { recursive: true });
  resetDatabase();
  saveRegistrationConfig({ allowRegistration: true, requireInviteCode: false });
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

function send(
  scheme: Scheme,
  method: string,
  url: string,
  options: { cookie?: string; body?: unknown; clientIp?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {
    'x-forwarded-for': options.clientIp ?? '198.51.100.10',
  };
  if (scheme === 'https') headers['x-forwarded-proto'] = 'https';
  if (options.cookie) headers.cookie = options.cookie;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  return app.request(`http://happyclaw.test${url}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

interface ParsedSetCookie {
  name: string;
  value: string;
  attributes: Map<string, string | true>;
}

function parseSetCookie(line: string): ParsedSetCookie {
  const [pair, ...rawAttributes] = line.split(';').map((part) => part.trim());
  const separator = pair.indexOf('=');
  const attributes = new Map<string, string | true>();
  for (const attribute of rawAttributes) {
    const index = attribute.indexOf('=');
    if (index === -1) attributes.set(attribute.toLowerCase(), true);
    else {
      attributes.set(
        attribute.slice(0, index).toLowerCase(),
        attribute.slice(index + 1),
      );
    }
  }
  return {
    name: pair.slice(0, separator),
    value: pair.slice(separator + 1),
    attributes,
  };
}

/**
 * Assert the response carries one Set-Cookie line per session cookie name
 * with the attributes each name requires, and return the Cookie request header
 * for the session it stores (or undefined when both are expired).
 */
function expectSessionCookies(
  response: Response,
  scheme: Scheme,
  mode: 'set' | 'clear',
): string | undefined {
  const lines = response.headers.getSetCookie();
  expect(lines).toHaveLength(2);
  const cookies = lines.map(parseSetCookie);
  const secure = cookies.find((c) => c.name === SESSION_COOKIE_NAME_SECURE);
  const plain = cookies.find((c) => c.name === SESSION_COOKIE_NAME_PLAIN);
  expect(secure).toBeDefined();
  expect(plain).toBeDefined();

  for (const cookie of [secure!, plain!]) {
    expect(cookie.attributes.get('path')).toBe('/');
    expect(cookie.attributes.get('httponly')).toBe(true);
    expect(cookie.attributes.get('samesite')).toBe('Strict');
    expect(cookie.attributes.has('domain')).toBe(false);
  }
  expect(secure!.attributes.get('secure')).toBe(true);
  expect(plain!.attributes.has('secure')).toBe(false);

  if (mode === 'clear') {
    for (const cookie of [secure!, plain!]) {
      expect(cookie.value).toBe('');
      expect(cookie.attributes.get('max-age')).toBe('0');
    }
    return undefined;
  }

  const [active, expired] =
    scheme === 'https' ? [secure!, plain!] : [plain!, secure!];
  expect(active.value).toMatch(/^[0-9a-f]{64}\.[0-9a-f]{64}$/);
  expect(active.attributes.get('max-age')).toBe(String(30 * 24 * 60 * 60));
  expect(expired.value).toBe('');
  expect(expired.attributes.get('max-age')).toBe('0');
  return `${active.name}=${active.value}`;
}

async function meStatus(scheme: Scheme, cookie: string): Promise<number> {
  return (await send(scheme, 'GET', '/api/auth/me', { cookie })).status;
}

describe.each<Scheme>(['http', 'https'])(
  'session cookies over %s',
  (scheme) => {
    const adminPassword = 'admin-password-1';
    const memberPassword = 'member-password-1';
    let adminId = '';
    let adminCookie = '';
    let memberCookie = '';

    beforeAll(() => {
      resetDatabase();
    });

    test('POST /api/auth/setup signs in the first admin', async () => {
      const response = await send(scheme, 'POST', '/api/auth/setup', {
        body: { username: 'admin', password: adminPassword },
      });

      expect(response.status).toBe(201);
      adminId = ((await response.json()) as { user: { id: string } }).user.id;
      adminCookie = expectSessionCookies(response, scheme, 'set')!;
      expect(await meStatus(scheme, adminCookie)).toBe(200);
    });

    test('POST /api/auth/login', async () => {
      const response = await send(scheme, 'POST', '/api/auth/login', {
        body: { username: 'admin', password: adminPassword },
      });

      expect(response.status).toBe(200);
      adminCookie = expectSessionCookies(response, scheme, 'set')!;
      expect(await meStatus(scheme, adminCookie)).toBe(200);
    });

    test('POST /api/auth/register', async () => {
      const response = await send(scheme, 'POST', '/api/auth/register', {
        body: { username: `member_${scheme}`, password: memberPassword },
        clientIp: scheme === 'https' ? '198.51.100.21' : '198.51.100.20',
      });

      expect(response.status).toBe(201);
      memberCookie = expectSessionCookies(response, scheme, 'set')!;
      expect(await meStatus(scheme, memberCookie)).toBe(200);
    });

    test('PUT /api/auth/password replaces the session', async () => {
      const response = await send(scheme, 'PUT', '/api/auth/password', {
        cookie: memberCookie,
        body: {
          current_password: memberPassword,
          new_password: 'member-password-2',
        },
      });

      expect(response.status).toBe(200);
      const nextCookie = expectSessionCookies(response, scheme, 'set')!;
      expect(await meStatus(scheme, memberCookie)).toBe(401);
      expect(await meStatus(scheme, nextCookie)).toBe(200);
      memberCookie = nextCookie;
    });

    test('PATCH /api/admin/users/:id keeps an admin who resets their own password signed in', async () => {
      const response = await send(
        scheme,
        'PATCH',
        `/api/admin/users/${adminId}`,
        {
          cookie: adminCookie,
          body: { password: 'admin-password-2' },
        },
      );

      expect(response.status).toBe(200);
      const nextCookie = expectSessionCookies(response, scheme, 'set')!;
      expect(await meStatus(scheme, adminCookie)).toBe(401);
      expect(await meStatus(scheme, nextCookie)).toBe(200);
      adminCookie = nextCookie;
    });

    test('auth middleware upgrades a legacy unsigned cookie', async () => {
      const legacyToken = generateSessionToken();
      const now = new Date().toISOString();
      db.createUserSession({
        id: legacyToken,
        user_id: adminId,
        ip_address: null,
        user_agent: null,
        created_at: now,
        expires_at: sessionExpiresAt(),
        last_active_at: now,
      });
      const name =
        scheme === 'https'
          ? SESSION_COOKIE_NAME_SECURE
          : SESSION_COOKIE_NAME_PLAIN;

      const response = await send(scheme, 'GET', '/api/auth/me', {
        cookie: `${name}=${legacyToken}`,
      });

      expect(response.status).toBe(200);
      const upgradedCookie = expectSessionCookies(response, scheme, 'set')!;
      expect(upgradedCookie).toMatch(new RegExp(`^${name}=${legacyToken}\\.`));
      expect(await meStatus(scheme, upgradedCookie)).toBe(200);
    });

    test('POST /api/auth/logout expires both cookie names', async () => {
      const response = await send(scheme, 'POST', '/api/auth/logout', {
        cookie: adminCookie,
      });

      expect(response.status).toBe(200);
      expectSessionCookies(response, scheme, 'clear');
      expect(await meStatus(scheme, adminCookie)).toBe(401);
    });
  },
);

describe('POST /api/auth/logout with sessions under both cookie names', () => {
  const password = 'admin-password-1';

  async function login(scheme: Scheme, username: string): Promise<string> {
    const response = await send(scheme, 'POST', '/api/auth/login', {
      body: { username, password },
    });
    expect(response.status).toBe(200);
    return expectSessionCookies(response, scheme, 'set')!;
  }

  beforeAll(async () => {
    resetDatabase();
    const setup = await send('http', 'POST', '/api/auth/setup', {
      body: { username: 'admin', password },
    });
    expect(setup.status).toBe(201);
    const register = await send('http', 'POST', '/api/auth/register', {
      body: { username: 'other_user', password },
      clientIp: '198.51.100.30',
    });
    expect(register.status).toBe(201);
  });

  test('ends every session this browser presents for the user, and nothing else', async () => {
    const plainSession = await login('http', 'admin');
    const secureSession = await login('https', 'admin');
    const otherDevice = await login('http', 'admin');
    const otherUser = await login('http', 'other_user');

    const response = await send('https', 'POST', '/api/auth/logout', {
      cookie: [secureSession, plainSession, otherUser].join('; '),
    });

    expect(response.status).toBe(200);
    expectSessionCookies(response, 'https', 'clear');
    expect(await meStatus('https', secureSession)).toBe(401);
    expect(await meStatus('http', plainSession)).toBe(401);
    expect(await meStatus('http', otherDevice)).toBe(200);
    expect(await meStatus('http', otherUser)).toBe(200);
  });
});
