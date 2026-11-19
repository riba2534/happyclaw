/**
 * Passkeys end to end against a software authenticator (P-256, "none"
 * attestation): register, log in without a username, origin rules, replay,
 * a credential bound to another host, and removal.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
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
      return next();
    },
  };
});

const db = await import('../src/db.js');
const { resetPasskeyChallengesForTest, resolvePasskeyOrigin } =
  await import('../src/passkeys.js');
const passkeyRoutes = (await import('../src/routes/passkeys.js')).default;
const app = new Hono().route('/api/auth', passkeyRoutes);

const PASSWORD = 'owner-password-1';
const ORIGIN = 'https://claw.example.com';
const HOST = 'claw.example.com';

const b64url = (bytes: Uint8Array | Buffer) =>
  Buffer.from(bytes).toString('base64url');
const sha256 = (data: Buffer | string) =>
  crypto.createHash('sha256').update(data).digest();

/** A minimal platform authenticator holding one P-256 key. */
class SoftAuthenticator {
  readonly id = crypto.randomBytes(16);
  private readonly keys = crypto.generateKeyPairSync('ec', {
    namedCurve: 'P-256',
  });
  private counter = 0;

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

  get(options: { challenge: string; rpId?: string }, origin = ORIGIN) {
    this.counter += 1;
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const authData = Buffer.concat([
      sha256(options.rpId ?? HOST),
      Buffer.from([0x05]), // UP | UV
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
        userHandle: b64url(Buffer.from('alice')),
      },
    };
  }
}

function request(
  url: string,
  body: unknown,
  { origin = ORIGIN, host = HOST, method = 'POST' } = {},
) {
  return app.request(url, {
    method,
    headers: { 'content-type': 'application/json', origin, host },
    body: JSON.stringify(body ?? {}),
  });
}

async function register(authenticator: SoftAuthenticator) {
  const options = await (
    await request('/api/auth/passkeys/options', {})
  ).json();
  return request('/api/auth/passkeys', {
    response: authenticator.create(options),
    name: '这台 Mac',
  });
}

async function login(authenticator: SoftAuthenticator, origin = ORIGIN) {
  const options = await (
    await request('/api/auth/passkey/login/options', {})
  ).json();
  return request(
    '/api/auth/passkey/login',
    { response: authenticator.get(options, origin) },
    { origin },
  );
}

beforeAll(() => {
  fs.mkdirSync(path.join(dataDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'groups'), { recursive: true });
  db.initDatabase();
  const now = new Date().toISOString();
  db.createUser({
    id: 'alice',
    username: 'alice',
    password_hash: bcrypt.hashSync(PASSWORD, 4),
    display_name: 'Alice',
    role: 'member',
    status: 'active',
    created_at: now,
    updated_at: now,
    must_change_password: false,
  });
  process.env.HAPPYCLAW_TEST_USER_ID = 'alice';
});

beforeEach(() => resetPasskeyChallengesForTest());

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
      resolvePasskeyOrigin('http://203.0.113.2:3000', '203.0.113.2:3000'),
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
});

describe('passkeys', () => {
  const authenticator = new SoftAuthenticator();

  test('register, then log in without a username', async () => {
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
    expect(list.passkeys[0].last_used_at).not.toBeNull();
  });

  test('a challenge is single use', async () => {
    const options = await (
      await request('/api/auth/passkey/login/options', {})
    ).json();
    const first = await request('/api/auth/passkey/login', {
      response: authenticator.get(options),
    });
    expect(first.status).toBe(200);
    const replay = await request('/api/auth/passkey/login', {
      response: authenticator.get(options),
    });
    expect(replay.status).toBe(400);
  });

  test('a response signed for another origin is refused', async () => {
    const options = await (
      await request('/api/auth/passkey/login/options', {})
    ).json();
    const response = await request('/api/auth/passkey/login', {
      response: authenticator.get(options, 'https://phish.example'),
    });
    expect(response.status).toBe(400);
  });

  test('a credential made for one host is not accepted on another', async () => {
    const other = await login(authenticator, 'http://localhost:5173');
    expect(other.status).toBe(400);
  });

  test('an insecure page gets an explanation', async () => {
    const response = await request(
      '/api/auth/passkey/login/options',
      {},
      { origin: 'http://203.0.113.2:3000', host: '203.0.113.2:3000' },
    );
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('PASSKEY_INSECURE');
  });

  test('removing one takes the password', async () => {
    const { passkeys } = await (
      await app.request('/api/auth/passkeys', { headers: { host: HOST } })
    ).json();
    const id = encodeURIComponent(passkeys[0].id);
    const wrong = await request(`/api/auth/passkeys/${id}/delete`, {
      password: 'nope',
    });
    expect(wrong.status).toBe(400);
    const right = await request(`/api/auth/passkeys/${id}/delete`, {
      password: PASSWORD,
    });
    expect(right.status).toBe(200);
    expect((await login(authenticator)).status).toBe(400);
  });
});
