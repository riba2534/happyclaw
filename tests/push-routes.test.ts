import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'push-routes-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
for (const dir of [storeDir, groupsDir]) fs.mkdirSync(dir, { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: root,
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/middleware/auth.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/middleware/auth.js')>();
  return {
    ...actual,
    authMiddleware: async (c: any, next: any) => {
      const id = process.env.HAPPYCLAW_TEST_USER_ID ?? 'alice';
      c.set('user', {
        id,
        username: 'u',
        role: process.env.HAPPYCLAW_TEST_ROLE ?? 'member',
        status: 'active',
        permissions: [],
      });
      c.set('sessionId', process.env.HAPPYCLAW_TEST_SESSION_ID ?? `s-${id}`);
      return next();
    },
  };
});
const postPushMessage = vi.fn();
vi.mock('../src/web-push-transport.js', () => ({
  postPushMessage: (...args: unknown[]) => postPushMessage(...args),
}));
const generateRequestDetails = vi.fn();
vi.mock('web-push', async (importOriginal) => {
  const actual = await importOriginal<{ default: Record<string, any> }>();
  return {
    default: {
      ...actual.default,
      generateRequestDetails: (...args: unknown[]) => {
        generateRequestDetails(...args);
        return actual.default.generateRequestDetails(...args);
      },
    },
  };
});

const db = await import('../src/db.js');
const routes = (await import('../src/routes/push.js')).default;
const store = await import('../src/web-push-store.js');
const push = await import('../src/web-push.js');
const {
  MAX_PUSH_SUBSCRIPTIONS_PER_USER,
  PUSH_TEST_LIMIT,
  resetPushTestLimitForTests,
} = await import('../src/routes/push.js');

const app = new Hono();
app.route('/api/push', routes);

const KEYS = {
  p256dh:
    'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
  auth: 'tBHItJI5svbpez7KI4CCXg',
};

function as(user: string, role = 'member', session = `s-${user}`) {
  process.env.HAPPYCLAW_TEST_USER_ID = user;
  process.env.HAPPYCLAW_TEST_ROLE = role;
  process.env.HAPPYCLAW_TEST_SESSION_ID = session;
}

async function call(method: string, url: string, body?: unknown) {
  const res = await app.request(url, {
    method,
    headers: { 'content-type': 'application/json', 'user-agent': 'TestUA/1' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json().catch(() => null)) as any,
  };
}

const endpoint = (n: number) =>
  `https://fcm.googleapis.com/fcm/send/device-${n}`;

beforeAll(() => {
  process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
  db.initDatabase();
});

beforeEach(() => {
  as('alice');
  postPushMessage.mockReset();
  postPushMessage.mockResolvedValue({ statusCode: 201, body: '' });
  generateRequestDetails.mockReset();
  resetPushTestLimitForTests();
});

afterAll(() => {
  db.closeDatabase();
  delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
  delete process.env.HAPPYCLAW_TEST_USER_ID;
  delete process.env.HAPPYCLAW_TEST_ROLE;
  delete process.env.HAPPYCLAW_TEST_SESSION_ID;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('/api/push', () => {
  test('guests have no push at all', async () => {
    as('guest-1', 'guest');
    for (const [method, url] of [
      ['GET', '/api/push/vapid-public-key'],
      ['GET', '/api/push/status'],
      ['POST', '/api/push/subscribe'],
      ['POST', '/api/push/unsubscribe'],
      ['POST', '/api/push/test'],
    ]) {
      expect(
        (await call(method, url, method === 'GET' ? undefined : {})).status,
        `${method} ${url}`,
      ).toBe(403);
    }
  });

  test('serves the VAPID public key and keeps the private key in a 0600 file', async () => {
    const res = await call('GET', '/api/push/vapid-public-key');
    expect(res.status).toBe(200);
    expect(res.body.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
    const file = path.join(root, 'config', 'web-push-vapid.json');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    // The private key is never part of a response.
    const privateKey = JSON.parse(fs.readFileSync(file, 'utf-8')).privateKey;
    expect(JSON.stringify(res.body)).not.toContain(privateKey);
  });

  test('subscribe stores the subscription for the caller and refreshes it', async () => {
    expect(
      (
        await call('POST', '/api/push/subscribe', {
          endpoint: endpoint(1),
          keys: KEYS,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call('POST', '/api/push/subscribe', {
          endpoint: endpoint(1),
          keys: KEYS,
        })
      ).status,
    ).toBe(200);
    const status = await call('GET', '/api/push/status');
    expect(status.body.available).toBe(true);
    expect(status.body.subscription_count).toBe(1);
    expect(status.body.subscriptions[0]).toMatchObject({
      user_agent: 'TestUA/1',
      last_success_at: null,
    });
    // The endpoint itself is a capability URL: only a short id is shown.
    expect(JSON.stringify(status.body)).not.toContain('device-1');
    expect(store.listWebPushSubscriptions('alice')[0]).toMatchObject({
      endpoint: endpoint(1),
      p256dh: KEYS.p256dh,
      auth: KEYS.auth,
    });
  });

  test.each([
    [
      'an endpoint outside the push services',
      { endpoint: 'https://internal.example/x', keys: KEYS },
    ],
    [
      'a plain http endpoint',
      { endpoint: 'http://fcm.googleapis.com/x', keys: KEYS },
    ],
    ['a loopback endpoint', { endpoint: 'https://127.0.0.1/x', keys: KEYS }],
    [
      'a host url.parse reads as loopback',
      { endpoint: 'https://127.0.0.1;.fcm.googleapis.com/x', keys: KEYS },
    ],
    [
      'a host url.parse reads as a private address',
      { endpoint: 'https://10.0.0.5;.fcm.googleapis.com/admin', keys: KEYS },
    ],
    [
      'a host url.parse reads as another site',
      {
        endpoint: 'https://attacker.example{.web.push.apple.com/y',
        keys: KEYS,
      },
    ],
    [
      'a backtick host',
      { endpoint: 'https://localhost`.notify.windows.com/z', keys: KEYS },
    ],
    [
      'any Google API host',
      { endpoint: 'https://storage.googleapis.com/x', keys: KEYS },
    ],
    ['missing keys', { endpoint: endpoint(2) }],
    [
      'malformed keys',
      {
        endpoint: endpoint(2),
        keys: { p256dh: 'not base64 !!', auth: KEYS.auth },
      },
    ],
    ['a non-object body', 'nope'],
  ])('subscribe rejects %s', async (_name, body) => {
    const res = await call('POST', '/api/push/subscribe', body);
    expect(res.status).toBe(400);
    expect(store.getWebPushSubscription(endpoint(2))).toBeUndefined();
  });

  test('stores the endpoint in its normalized form', async () => {
    as('frank');
    expect(
      (
        await call('POST', '/api/push/subscribe', {
          endpoint: 'https://FCM.googleapis.com:443/fcm/send/device-norm',
          keys: KEYS,
        })
      ).status,
    ).toBe(200);
    expect(
      store.listWebPushSubscriptions('frank').map((r) => r.endpoint),
    ).toEqual(['https://fcm.googleapis.com/fcm/send/device-norm']);
    // Unsubscribing with the browser's spelling finds the same row.
    await call('POST', '/api/push/unsubscribe', {
      endpoint: 'https://FCM.googleapis.com:443/fcm/send/device-norm',
    });
    expect(store.listWebPushSubscriptions('frank')).toEqual([]);
  });

  test("another account registering the device is refused and the device's row dropped", async () => {
    await call('POST', '/api/push/subscribe', {
      endpoint: endpoint(1),
      keys: KEYS,
    });
    expect(store.getWebPushSubscription(endpoint(1))?.user_id).toBe('alice');
    as('bob');
    const res = await call('POST', '/api/push/subscribe', {
      endpoint: endpoint(1),
      keys: KEYS,
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('push_subscription_conflict');
    // Neither account receives this browser's pushes any more.
    expect(store.getWebPushSubscription(endpoint(1))).toBeUndefined();
    expect(store.listWebPushSubscriptions('alice')).toEqual([]);
    expect(store.listWebPushSubscriptions('bob')).toEqual([]);
  });

  test('a subscription belongs to the login session that registered it', async () => {
    as('grace', 'member', 's-grace-1');
    await call('POST', '/api/push/subscribe', {
      endpoint: endpoint(400),
      keys: KEYS,
    });
    expect(store.getWebPushSubscription(endpoint(400))?.session_id).toBe(
      's-grace-1',
    );
    // Signing in again on the same browser moves it to the new session.
    as('grace', 'member', 's-grace-2');
    await call('POST', '/api/push/subscribe', {
      endpoint: endpoint(400),
      keys: KEYS,
    });
    expect(store.getWebPushSubscription(endpoint(400))?.session_id).toBe(
      's-grace-2',
    );
    store.deleteWebPushSubscriptionByEndpoint(endpoint(400));
  });

  test("unsubscribe removes only the caller's own subscription and is idempotent", async () => {
    await call('POST', '/api/push/subscribe', {
      endpoint: endpoint(3),
      keys: KEYS,
    });
    as('bob');
    expect(
      (await call('POST', '/api/push/unsubscribe', { endpoint: endpoint(3) }))
        .status,
    ).toBe(200);
    expect(store.getWebPushSubscription(endpoint(3))).toBeDefined();
    as('alice');
    expect(
      (await call('POST', '/api/push/unsubscribe', { endpoint: endpoint(3) }))
        .status,
    ).toBe(200);
    expect(
      (await call('POST', '/api/push/unsubscribe', { endpoint: endpoint(3) }))
        .status,
    ).toBe(200);
    expect(store.getWebPushSubscription(endpoint(3))).toBeUndefined();
    expect((await call('POST', '/api/push/unsubscribe', {})).status).toBe(400);
  });

  test('an account keeps the subscriptions refreshed most recently', async () => {
    as('carol');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      let now = Date.parse('2026-11-01T00:00:00.000Z');
      const subscribeAt = async (n: number) => {
        vi.setSystemTime((now += 1000));
        await call('POST', '/api/push/subscribe', {
          endpoint: endpoint(n),
          keys: KEYS,
        });
      };
      for (let n = 100; n < 100 + MAX_PUSH_SUBSCRIPTIONS_PER_USER; n += 1) {
        await subscribeAt(n);
      }
      // The oldest device is still in use: it re-registers itself.
      await subscribeAt(100);
      await subscribeAt(500);
      await subscribeAt(501);
    } finally {
      vi.useRealTimers();
    }
    const kept = store
      .listWebPushSubscriptions('carol')
      .map((row) => row.endpoint);
    expect(kept).toHaveLength(MAX_PUSH_SUBSCRIPTIONS_PER_USER);
    expect(kept).toContain(endpoint(100));
    expect(kept).not.toContain(endpoint(101));
    expect(kept).not.toContain(endpoint(102));
    expect(kept).toContain(endpoint(501));
  });

  test("test push goes to the caller's devices and reports the outcome", async () => {
    as('dave');
    expect((await call('POST', '/api/push/test')).body).toMatchObject({
      success: false,
      attempted: 0,
    });
    await call('POST', '/api/push/subscribe', {
      endpoint: endpoint(200),
      keys: KEYS,
    });
    as('dave-other');
    await call('POST', '/api/push/subscribe', {
      endpoint: endpoint(201),
      keys: KEYS,
    });
    as('dave');
    const res = await call('POST', '/api/push/test');
    expect(res.body).toMatchObject({
      success: true,
      attempted: 1,
      delivered: 1,
    });
    expect(postPushMessage).toHaveBeenCalledTimes(1);
    const [request] = postPushMessage.mock.calls[0];
    expect(request.endpoint).toBe(endpoint(200));
    expect(request.headers.Authorization).toMatch(/^vapid t=/);
    expect(Buffer.isBuffer(request.body)).toBe(true);
    const [target, payload, options] = generateRequestDetails.mock.calls[0];
    expect(target.endpoint).toBe(endpoint(200));
    expect(JSON.parse(payload)).toMatchObject({
      kind: 'test',
      path: '/settings',
    });
    expect(options.vapidDetails.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
  });

  test('test pushes are limited per account', async () => {
    as('heidi');
    for (let i = 0; i < PUSH_TEST_LIMIT; i += 1) {
      expect((await call('POST', '/api/push/test')).status).toBe(200);
    }
    const limited = await call('POST', '/api/push/test');
    expect(limited.status).toBe(429);
    // Another account has its own budget.
    as('ivan');
    expect((await call('POST', '/api/push/test')).status).toBe(200);
  });

  test('a 410 from the push service removes the subscription', async () => {
    as('erin');
    await call('POST', '/api/push/subscribe', {
      endpoint: endpoint(300),
      keys: KEYS,
    });
    postPushMessage.mockResolvedValueOnce({ statusCode: 410, body: '' });
    const res = await call('POST', '/api/push/test');
    expect(res.body).toMatchObject({ success: false, removed: 1 });
    expect(store.getWebPushSubscription(endpoint(300))).toBeUndefined();
  });
});

describe('sendWebPush', () => {
  const row = (endpointValue: string) => ({
    endpoint: endpointValue,
    user_id: 'judy',
    session_id: 's-judy',
    p256dh: KEYS.p256dh,
    auth: KEYS.auth,
    user_agent: null,
    created_at: '2026-11-05T00:00:00.000Z',
    updated_at: '2026-11-05T00:00:00.000Z',
    last_success_at: null,
  });
  const payload = {
    title: 't',
    body: 'b',
    tag: 'conv:x',
    path: '/chat',
    kind: 'reply' as const,
  };

  test('posts to the normalized endpoint and reads the status', async () => {
    expect(await push.sendWebPush(row(endpoint(600)), payload)).toEqual({
      ok: true,
    });
    expect(postPushMessage.mock.calls[0][0].endpoint).toBe(endpoint(600));
    postPushMessage.mockResolvedValueOnce({ statusCode: 404, body: '' });
    expect(await push.sendWebPush(row(endpoint(600)), payload)).toMatchObject({
      ok: false,
      gone: true,
      statusCode: 404,
    });
    postPushMessage.mockResolvedValueOnce({ statusCode: 429, body: '' });
    expect(await push.sendWebPush(row(endpoint(600)), payload)).toMatchObject({
      ok: false,
      gone: false,
      statusCode: 429,
    });
  });

  test('a stored endpoint outside the push services is never contacted', async () => {
    expect(
      await push.sendWebPush(
        row('https://127.0.0.1;.fcm.googleapis.com/x'),
        payload,
      ),
    ).toMatchObject({ ok: false, gone: true });
    expect(postPushMessage).not.toHaveBeenCalled();
  });

  test('a failed or oversized response is a failure, not an exception', async () => {
    postPushMessage.mockRejectedValueOnce(
      new Error('push service response exceeded 16384 bytes'),
    );
    expect(await push.sendWebPush(row(endpoint(601)), payload)).toEqual({
      ok: false,
      gone: false,
      error: 'push service response exceeded 16384 bytes',
    });
  });
});
