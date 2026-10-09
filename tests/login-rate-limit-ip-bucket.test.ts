import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

vi.hoisted(() => {
  process.env.WEB_SESSION_SECRET = 'login-rate-limit-ip-bucket-secret';
  // Route tests only: per-IP threshold becomes 1 × 6 = 6 failures.
  process.env.MAX_LOGIN_ATTEMPTS = '1';
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'login-rate-limit-ip-'));
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

const auth = await import('../src/auth.js');
const db = await import('../src/db.js');
const authRoutes = (await import('../src/routes/auth.js')).default;
const {
  checkLoginRateLimit,
  clearLoginAttempts,
  recordLoginAttempt,
  loginAttemptStats,
  resetLoginAttemptsForTest,
  LOGIN_ATTEMPTS_MAX_ENTRIES,
} = auth;

// Production defaults: 5 attempts / 15 minutes.
const MAX = 5;
const LOCKOUT_MIN = 15;
const IP_LIMIT = MAX * 6;

function check(username: string, ip: string) {
  return checkLoginRateLimit(username, ip, MAX, LOCKOUT_MIN);
}

/** Spray `n` failures from `ip`, each with a username never used before. */
function spray(ip: string, n: number, tag = ip): void {
  for (let i = 0; i < n; i++) {
    const username = `spray_${tag}_${i}`;
    expect(check(username, ip).allowed).toBe(true);
    recordLoginAttempt(username, ip);
  }
}

beforeEach(() => {
  resetLoginAttemptsForTest();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('per-IP login bucket', () => {
  test('rotating usernames from one IP is blocked; other IPs are not', () => {
    spray('203.0.113.7', IP_LIMIT);

    const blocked = check('brand_new_user', '203.0.113.7');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(LOCKOUT_MIN * 60 - 5);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(LOCKOUT_MIN * 60);

    expect(check('brand_new_user', '203.0.113.8').allowed).toBe(true);
    // A sprayed username is not locked anywhere else (1 failure each).
    expect(check('spray_203.0.113.7_0', '198.51.100.1').allowed).toBe(true);
  });

  test('one failure short of the limit still lets the IP through', () => {
    spray('203.0.113.9', IP_LIMIT - 1);
    expect(check('someone', '203.0.113.9').allowed).toBe(true);
  });

  test('the bucket expires with the lockout window and is not reset by a success', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-10T00:00:00Z'));
    spray('203.0.113.10', IP_LIMIT);

    clearLoginAttempts('real_user', '203.0.113.10'); // a successful login
    expect(check('real_user', '203.0.113.10').allowed).toBe(false);

    vi.setSystemTime(new Date(Date.now() + LOCKOUT_MIN * 60 * 1000 + 1000));
    expect(check('real_user', '203.0.113.10').allowed).toBe(true);
  });

  test('IPv6 clients are bucketed per /64; IPv4-mapped addresses join their IPv4 bucket', () => {
    for (let i = 0; i < IP_LIMIT; i++) {
      const ip = `2001:db8:1:2::${(i + 1).toString(16)}`;
      expect(check(`v6_${i}`, ip).allowed).toBe(true);
      recordLoginAttempt(`v6_${i}`, ip);
    }
    expect(check('fresh', '2001:0db8:0001:0002:ffff:0:0:9').allowed).toBe(
      false,
    );
    expect(check('fresh', '2001:db8:1:3::1').allowed).toBe(true);

    spray('::ffff:192.0.2.44', IP_LIMIT / 2, 'mapped');
    spray('192.0.2.44', IP_LIMIT / 2, 'plain');
    expect(check('fresh', '192.0.2.44').allowed).toBe(false);
    expect(check('fresh', '::ffff:192.0.2.44').allowed).toBe(false);
  });

  test('loopback and unknown addresses are not bucketed (proxy without TRUST_PROXY)', () => {
    for (const ip of ['127.0.0.1', '::1', '::ffff:127.0.0.1', 'unknown']) {
      spray(ip, IP_LIMIT + 5);
      expect(check('fresh', ip).allowed).toBe(true);
    }
  });

  test('registration opts out and does not drain the login budget', () => {
    const ip = '203.0.113.20';
    for (let i = 0; i < IP_LIMIT + 5; i++) {
      recordLoginAttempt(`register:${ip}`, ip, { perIp: false });
    }
    expect(check('someone', ip).allowed).toBe(true);
    // The register bucket itself still locks as before.
    expect(
      checkLoginRateLimit(`register:${ip}`, ip, MAX, LOCKOUT_MIN, {
        perIp: false,
      }).allowed,
    ).toBe(false);
  });
});

describe('existing username buckets are unchanged', () => {
  test('username:ip locks after maxAttempts and clears on success', () => {
    for (let i = 0; i < MAX; i++) {
      expect(check('alice', '198.51.100.5').allowed).toBe(true);
      recordLoginAttempt('alice', '198.51.100.5');
    }
    expect(check('alice', '198.51.100.5').allowed).toBe(false);
    expect(check('alice', '198.51.100.6').allowed).toBe(true);
    expect(check('bob', '198.51.100.5').allowed).toBe(true);

    clearLoginAttempts('alice', '198.51.100.5');
    expect(check('alice', '198.51.100.5').allowed).toBe(true);
  });

  test('per-username global limit (4× over 1h) still holds across IPs', () => {
    for (let i = 0; i < MAX * 4; i++) {
      recordLoginAttempt('carol', `198.51.100.${100 + i}`);
    }
    const blocked = check('carol', '198.51.100.250');
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(3600 - 5);
    expect(check('dave', '198.51.100.250').allowed).toBe(true);
  });
});

describe('limiter memory bounds', () => {
  test('the map is capped with oldest-first eviction', () => {
    const extra = 2_000;
    for (let i = 0; i < LOGIN_ATTEMPTS_MAX_ENTRIES + extra; i++) {
      recordLoginAttempt(
        `flood_${i}`,
        `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`,
      );
    }
    expect(loginAttemptStats().entries).toBe(LOGIN_ATTEMPTS_MAX_ENTRIES);

    // Fresh records are kept and still enforce lockouts at the cap.
    for (let i = 0; i < MAX; i++) recordLoginAttempt('victim', '192.0.2.200');
    expect(check('victim', '192.0.2.200').allowed).toBe(false);
    expect(loginAttemptStats().entries).toBe(LOGIN_ATTEMPTS_MAX_ENTRIES);
  });

  test('oversized usernames or forwarded IPs cannot create oversized keys', () => {
    const hugeIp = 'x'.repeat(16_000);
    for (let i = 0; i < IP_LIMIT; i++) recordLoginAttempt(`u${i}`, hugeIp);
    recordLoginAttempt('y'.repeat(16_000), '203.0.113.30');
    expect(loginAttemptStats().maxKeyLength).toBeLessThan(160);
    // Digesting is stable, so the same oversized value keeps hitting one bucket.
    expect(check('fresh', hugeIp).allowed).toBe(false);
    expect(check('fresh', 'x'.repeat(15_999)).allowed).toBe(true);
  });
});

describe('login route', () => {
  const app = new Hono().route('/api/auth', authRoutes);
  const PASSWORD = 'admin-password-1';

  function login(username: string, password: string, ip: string) {
    return app.request('http://happyclaw.test/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ username, password }),
    });
  }

  beforeAll(async () => {
    fs.mkdirSync(path.join(tmp, 'groups'), { recursive: true });
    fs.mkdirSync(storeDir, { recursive: true });
    db.initDatabase();
    const res = await app.request('http://happyclaw.test/api/auth/setup', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '198.51.100.1',
      },
      body: JSON.stringify({ username: 'admin', password: PASSWORD }),
    });
    expect(res.status).toBe(201);
  });

  afterAll(() => {
    db.closeDatabase();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('username spraying from one IP gets the usual 429; another IP still logs in', async () => {
    const attacker = '203.0.113.50';
    const sprayed = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        login(`ghost_${i}`, 'not-the-password', attacker),
      ),
    );
    for (const res of sprayed) {
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Invalid credentials' });
    }

    const locked = await login('admin', PASSWORD, attacker);
    expect(locked.status).toBe(429);
    expect(((await locked.json()) as { error: string }).error).toMatch(
      /^Too many login attempts\. Try again in \d+s$/,
    );

    const ok = await login('admin', PASSWORD, '203.0.113.51');
    expect(ok.status).toBe(200);
  });

  test('spoofed leading X-Forwarded-For hops do not escape the IP bucket', async () => {
    // Behind one trusted proxy the client address is the rightmost hop; the
    // attacker controls everything to its left.
    const proxied = (spoof: string) => `${spoof}, 203.0.113.70`;
    const sprayed = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        login(`spoof_${i}`, 'not-the-password', proxied(`10.0.0.${i + 1}`)),
      ),
    );
    for (const res of sprayed) expect(res.status).toBe(401);

    const locked = await login('admin', PASSWORD, proxied('192.0.2.200'));
    expect(locked.status).toBe(429);
    const ok = await login('admin', PASSWORD, '192.0.2.200, 203.0.113.71');
    expect(ok.status).toBe(200);
  });

  test('over-long usernames are rejected like other invalid input and leave no limiter state', async () => {
    const before = loginAttemptStats().entries;
    const tooLong = await login(
      'a'.repeat(65),
      'whatever-password',
      '203.0.113.60',
    );
    expect(tooLong.status).toBe(401);
    expect(await tooLong.json()).toEqual({ error: 'Invalid credentials' });
    expect(loginAttemptStats().entries).toBe(before);

    // At the bound the request is processed (and counted) as a normal failure.
    const atBound = await login(
      'a'.repeat(64),
      'whatever-password',
      '203.0.113.60',
    );
    expect(atBound.status).toBe(401);
    expect(await atBound.json()).toEqual({ error: 'Invalid credentials' });
    expect(loginAttemptStats().entries).toBe(before + 3);
  });
});
