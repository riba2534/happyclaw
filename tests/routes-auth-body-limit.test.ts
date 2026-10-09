import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import sharp from 'sharp';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

vi.hoisted(() => {
  process.env.WEB_SESSION_SECRET = 'auth-body-limit-route-test-secret';
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-body-limit-routes-'));
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
const { LoginSchema } = await import('../src/schemas.js');
const authRoutes = (await import('../src/routes/auth.js')).default;

const app = new Hono().route('/api/auth', authRoutes);

const ADMIN_PASSWORD = 'admin-password-1';
// Comfortably above the 64KB auth JSON cap, far below the 3MB avatar cap.
const OVERSIZE_BYTES = 128 * 1024;

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

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A well-formed JSON body padded past the cap with an extra ignored field. */
function paddedJson(fields: Record<string, string>): string {
  const base = JSON.stringify({ ...fields, pad: '' });
  const pad = 'A'.repeat(OVERSIZE_BYTES - base.length + 1);
  const json = JSON.stringify({ ...fields, pad });
  expect(Buffer.byteLength(json)).toBeGreaterThan(OVERSIZE_BYTES);
  return json;
}

function baseHeaders(clientIp: string): Record<string, string> {
  return {
    'content-type': 'application/json',
    'x-forwarded-for': clientIp,
  };
}

function postJson(
  url: string,
  json: string,
  clientIp = '198.51.100.10',
): Promise<Response> {
  return app.request(`http://happyclaw.test${url}`, {
    method: 'POST',
    headers: {
      ...baseHeaders(clientIp),
      'content-length': String(Buffer.byteLength(json)),
    },
    body: json,
  });
}

/** Stream the body in chunks with no Content-Length (chunked upload). */
function postChunked(
  url: string,
  json: string,
  clientIp = '198.51.100.10',
): Promise<Response> {
  const bytes = new TextEncoder().encode(json);
  const chunkSize = 16 * 1024;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += chunkSize) {
        controller.enqueue(bytes.subarray(i, i + chunkSize));
      }
      controller.close();
    },
  });
  const request = new Request(`http://happyclaw.test${url}`, {
    method: 'POST',
    headers: baseHeaders(clientIp),
    body,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  expect(request.headers.has('content-length')).toBe(false);
  return app.request(request);
}

function sessionCookie(response: Response): string {
  const line = response.headers
    .getSetCookie()
    .map((l) => l.split(';')[0])
    .find((pair) => pair.slice(pair.indexOf('=') + 1) !== '');
  expect(line).toBeDefined();
  return line!;
}

describe('auth JSON body limit', () => {
  test('POST /setup rejects an oversize body before creating the admin', async () => {
    const response = await postJson(
      '/api/auth/setup',
      paddedJson({ username: 'admin', password: ADMIN_PASSWORD }),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'Payload too large' });
    expect(response.headers.getSetCookie()).toHaveLength(0);
    expect(db.getUserCount(true)).toBe(0);
  });

  test('POST /setup still accepts a normal body', async () => {
    // Independent of the oversize case above, which creates the admin when
    // no limit is in place.
    resetDatabase();
    saveRegistrationConfig({
      allowRegistration: true,
      requireInviteCode: false,
    });

    const response = await postJson(
      '/api/auth/setup',
      JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }),
    );

    expect(response.status).toBe(201);
    expect(db.getUserCount(true)).toBe(1);
  });

  test('POST /login rejects a chunked oversize body without reaching the handler', async () => {
    const safeParse = vi.spyOn(LoginSchema, 'safeParse');

    const response = await postChunked(
      '/api/auth/login',
      paddedJson({ username: 'admin', password: ADMIN_PASSWORD }),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'Payload too large' });
    expect(response.headers.getSetCookie()).toHaveLength(0);
    expect(safeParse).not.toHaveBeenCalled();
  });

  test('POST /login rejects an oversize declared Content-Length without reaching the handler', async () => {
    const safeParse = vi.spyOn(LoginSchema, 'safeParse');

    const response = await postJson(
      '/api/auth/login',
      paddedJson({ username: 'admin', password: ADMIN_PASSWORD }),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'Payload too large' });
    expect(response.headers.getSetCookie()).toHaveLength(0);
    expect(safeParse).not.toHaveBeenCalled();
  });

  test('POST /login still handles a normal body', async () => {
    const safeParse = vi.spyOn(LoginSchema, 'safeParse');

    const ok = await postJson(
      '/api/auth/login',
      JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }),
    );
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { success: boolean }).success).toBe(true);
    sessionCookie(ok);

    const wrong = await postJson(
      '/api/auth/login',
      JSON.stringify({ username: 'admin', password: 'wrong-password-1' }),
      '198.51.100.11',
    );
    expect(wrong.status).toBe(401);
    expect(safeParse).toHaveBeenCalledTimes(2);
  });

  test('POST /register rejects an oversize body before creating the user', async () => {
    const response = await postJson(
      '/api/auth/register',
      paddedJson({ username: 'member_big', password: 'member-password-1' }),
      '198.51.100.20',
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: 'Payload too large' });
    expect(db.getUserByUsername('member_big')).toBeUndefined();
  });

  test('POST /avatar keeps its own larger limit', async () => {
    const login = await postJson(
      '/api/auth/login',
      JSON.stringify({ username: 'admin', password: ADMIN_PASSWORD }),
    );
    expect(login.status).toBe(200);
    const cookie = sessionCookie(login);

    // A real, decodable PNG above the 64KB JSON cap (noise keeps it large).
    // The route re-encodes avatars, so the stored file is a small WebP; what
    // this pins is that the upload is not cut off at the auth JSON budget.
    const side = 220;
    const png = await sharp(crypto.randomBytes(side * side * 3), {
      raw: { width: side, height: side, channels: 3 },
    })
      .png()
      .toBuffer();
    expect(png.length).toBeGreaterThan(OVERSIZE_BYTES);

    const form = new FormData();
    form.append(
      'avatar',
      new File([new Uint8Array(png)], 'avatar.png', { type: 'image/png' }),
    );
    const response = await app.request(
      'http://happyclaw.test/api/auth/avatar?target=user',
      {
        method: 'POST',
        headers: { cookie, 'x-forwarded-for': '198.51.100.10' },
        body: form,
      },
    );

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      success: boolean;
      avatarUrl: string;
    };
    expect(payload.success).toBe(true);
    const filename = payload.avatarUrl.replace(/^\/api\/auth\/avatars\//, '');
    expect(filename).toMatch(/\.webp$/);
    expect(fs.existsSync(path.join(tmp, 'avatars', filename))).toBe(true);

    // Same body budget, but bytes that are not an image are now refused.
    const junk = new FormData();
    junk.append(
      'avatar',
      new File([new Uint8Array(OVERSIZE_BYTES)], 'avatar.png', {
        type: 'image/png',
      }),
    );
    const rejected = await app.request(
      'http://happyclaw.test/api/auth/avatar?target=user',
      {
        method: 'POST',
        headers: { cookie, 'x-forwarded-for': '198.51.100.10' },
        body: junk,
      },
    );
    expect(rejected.status).toBe(400);
    expect(await rejected.json()).toEqual({
      error: 'Invalid image file. Use a valid jpg, png, gif or webp image',
    });
  });
});
