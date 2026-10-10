import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

vi.hoisted(() => {
  process.env.WEB_SESSION_SECRET = 'avatar-resize-route-test-secret';
});

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'avatar-resize-routes-'));
const storeDir = path.join(tmp, 'db');
const avatarsDir = path.join(tmp, 'avatars');

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
const authRoutes = (await import('../src/routes/auth.js')).default;
const {
  AVATAR_MAX_EDGE,
  AVATAR_MAX_ANIMATED_BYTES,
  normalizeAvatarImage,
  sniffAvatarFormat,
} = await import('../src/avatar-image.js');

const app = new Hono().route('/api/auth', authRoutes);
const BASE = 'http://happyclaw.test';
const IMMUTABLE = 'public, max-age=31536000, immutable';

let cookie = '';
let userId = '';

beforeAll(async () => {
  fs.mkdirSync(path.join(tmp, 'groups'), { recursive: true });
  fs.mkdirSync(storeDir, { recursive: true });
  db.initDatabase();
  const res = await app.request(`${BASE}/api/auth/setup`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '198.51.100.40',
    },
    body: JSON.stringify({ username: 'admin', password: 'admin-password-1' }),
  });
  expect(res.status).toBe(201);
  const pair = res.headers
    .getSetCookie()
    .map((l) => l.split(';')[0])
    .find((p) => p.slice(p.indexOf('=') + 1) !== '');
  cookie = pair!;
  userId = ((await res.json()) as { user: { id: string } }).user.id;
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** 2000x2000 gradient with light noise: ~3 MB PNG, just under the 3 MB cap. */
async function largePng(): Promise<Buffer> {
  const W = 2000;
  const H = 2000;
  const raw = Buffer.alloc(W * H * 3);
  let seed = 7;
  const rnd = () =>
    (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const n = (rnd() * 2) | 0;
      raw[i] = ((x * 255) / W + n) & 255;
      raw[i + 1] = ((y * 255) / H + n) & 255;
      raw[i + 2] = (((x + y) * 128) / W + n) & 255;
    }
  }
  return sharp(raw, { raw: { width: W, height: H, channels: 3 } })
    .png()
    .toBuffer();
}

async function animatedGif(frames: number, side: number): Promise<Buffer> {
  const raw = Buffer.alloc(side * side * frames * 4);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < side * side; i++) {
      const o = (f * side * side + i) * 4;
      raw[o] = (f * 40) & 255;
      raw[o + 1] = i & 255;
      raw[o + 3] = 255;
    }
  }
  return sharp(raw, {
    raw: { width: side, height: side * frames, channels: 4, pageHeight: side },
  })
    .gif({ delay: 80, loop: 0 })
    .toBuffer();
}

async function upload(
  bytes: Uint8Array,
  type: string,
  target: 'user' | 'ai' = 'user',
): Promise<Response> {
  const form = new FormData();
  form.append(
    'avatar',
    new File([new Uint8Array(bytes)], 'avatar.bin', { type }),
  );
  const query = target === 'user' ? '?target=user' : '';
  return app.request(`${BASE}/api/auth/avatar${query}`, {
    method: 'POST',
    headers: { cookie, 'x-forwarded-for': '198.51.100.40' },
    body: form,
  });
}

async function uploadOk(
  bytes: Uint8Array,
  type: string,
  target: 'user' | 'ai' = 'user',
): Promise<string> {
  const res = await upload(bytes, type, target);
  expect(res.status).toBe(200);
  const payload = (await res.json()) as { avatarUrl: string };
  return payload.avatarUrl;
}

function filenameOf(url: string): string {
  return url.replace(/^\/api\/auth\/avatars\//, '');
}

describe('avatar upload resizing', () => {
  test('a large PNG is stored as a ≤256 px WebP under a new filename', async () => {
    const png = await largePng();
    expect(png.length).toBeGreaterThan(2 * 1024 * 1024);

    const firstUrl = await uploadOk(png, 'image/png');
    const first = filenameOf(firstUrl);
    expect(first).toMatch(new RegExp(`^${userId}-user-[0-9a-f]{8}\\.webp$`));

    const stored = fs.readFileSync(path.join(avatarsDir, first));
    const meta = await sharp(stored).metadata();
    expect(meta.format).toBe('webp');
    expect(Math.max(meta.width!, meta.height!)).toBeLessThanOrEqual(
      AVATAR_MAX_EDGE,
    );
    // A ~3 MB upload must not come back as anything close to its input size.
    expect(stored.length).toBeLessThan(64 * 1024);
    expect(db.getUserById(userId)!.avatar_url).toBe(firstUrl);

    // Re-uploading (even identical bytes) mints a different URL and reaps the
    // previous one, so an `immutable` cached copy can never go stale.
    const secondUrl = await uploadOk(png, 'image/png');
    expect(secondUrl).not.toBe(firstUrl);
    expect(fs.existsSync(path.join(avatarsDir, first))).toBe(false);
    expect(fs.existsSync(path.join(avatarsDir, filenameOf(secondUrl)))).toBe(
      true,
    );

    const served = await app.request(`${BASE}${secondUrl}`);
    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toBe('image/webp');
    expect(served.headers.get('cache-control')).toBe(IMMUTABLE);
    expect(Buffer.from(await served.arrayBuffer()).length).toBe(
      fs.statSync(path.join(avatarsDir, filenameOf(secondUrl))).size,
    );
  });

  test('JPEG is auto-rotated per EXIF and stripped of metadata', async () => {
    // 400x300 landscape pixels tagged "rotate 90° CW" → displays as portrait.
    const jpeg = await sharp({
      create: {
        width: 400,
        height: 300,
        channels: 3,
        background: { r: 200, g: 40, b: 40 },
      },
    })
      .jpeg()
      .withMetadata({
        orientation: 6,
        exif: { IFD0: { Copyright: 'leak-me', Artist: 'leak-me' } },
      })
      .toBuffer();
    const src = await sharp(jpeg).metadata();
    expect(src.orientation).toBe(6);
    expect(src.exif).toBeDefined();

    const url = await uploadOk(jpeg, 'image/jpeg', 'ai');
    expect(filenameOf(url)).toMatch(new RegExp(`^${userId}-ai-.*\\.webp$`));
    const stored = fs.readFileSync(path.join(avatarsDir, filenameOf(url)));
    const meta = await sharp(stored).metadata();
    expect([meta.width, meta.height]).toEqual([192, 256]);
    expect(meta.orientation).toBeUndefined();
    expect(meta.exif).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(stored.includes(Buffer.from('leak-me'))).toBe(false);
    expect(db.getUserById(userId)!.ai_avatar_url).toBe(url);
  });

  test('small images are not enlarged and keep their alpha channel', async () => {
    const png = await sharp({
      create: {
        width: 64,
        height: 48,
        channels: 4,
        background: { r: 0, g: 128, b: 255, alpha: 0.5 },
      },
    })
      .png()
      .toBuffer();
    const out = await normalizeAvatarImage(png);
    expect([out.width, out.height]).toEqual([64, 48]);
    const meta = await sharp(out.data).metadata();
    expect([meta.width, meta.height]).toEqual([64, 48]);
    expect(meta.hasAlpha).toBe(true);
  });

  test('animated GIF stays animated, each frame bounded to 256 px', async () => {
    const gif = await animatedGif(6, 400);
    const out = await normalizeAvatarImage(gif);
    expect(out.animated).toBe(true);
    expect([out.width, out.height]).toEqual([256, 256]);
    const meta = await sharp(out.data, { animated: true }).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.pages).toBe(6);
    expect(meta.pageHeight).toBe(256);
  });

  test('an animation too large after resizing falls back to its first frame', async () => {
    // Pure noise defeats WebP compression: 16 frames × 256² ≈ 700 KB ≫ the
    // cap. (Built as animated WebP: GIF-quantising noise is slow to encode.)
    const frames = 16;
    const side = 256;
    const raw = crypto.randomBytes(side * side * frames * 4);
    for (let o = 3; o < raw.length; o += 4) raw[o] = 255;
    const anim = await sharp(raw, {
      raw: {
        width: side,
        height: side * frames,
        channels: 4,
        pageHeight: side,
      },
    })
      .webp({ quality: 82, loop: 0, delay: 80 })
      .toBuffer();
    expect((await sharp(anim).metadata()).pages).toBe(frames);
    expect(anim.length).toBeGreaterThan(AVATAR_MAX_ANIMATED_BYTES);
    const out = await normalizeAvatarImage(anim);
    expect(out.animated).toBe(false);
    expect(out.data.length).toBeLessThanOrEqual(AVATAR_MAX_ANIMATED_BYTES);
    const meta = await sharp(out.data, { animated: true }).metadata();
    expect(meta.pages ?? 1).toBe(1);
  });

  test('a declared type that does not match the bytes is re-encoded from the real format', async () => {
    const jpeg = await sharp({
      create: { width: 300, height: 300, channels: 3, background: '#0a0' },
    })
      .jpeg()
      .toBuffer();
    const url = await uploadOk(jpeg, 'image/png');
    const meta = await sharp(
      fs.readFileSync(path.join(avatarsDir, filenameOf(url))),
    ).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(256);
  });
});

describe('avatar upload validation', () => {
  test('undecodable, non-allowlisted or oversized input is rejected without touching the current avatar', async () => {
    const goodUrl = await uploadOk(
      await sharp({
        create: { width: 80, height: 80, channels: 3, background: '#123' },
      })
        .png()
        .toBuffer(),
      'image/png',
    );
    const goodPath = path.join(avatarsDir, filenameOf(goodUrl));
    const invalid = {
      error: 'Invalid image file. Use a valid jpg, png, gif or webp image',
    };

    // Zero bytes declared as PNG.
    let res = await upload(new Uint8Array(4096), 'image/png');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(invalid);

    // PNG signature followed by garbage.
    const truncated = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      crypto.randomBytes(2048),
    ]);
    res = await upload(truncated, 'image/png');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(invalid);

    // SVG smuggled under an allowed MIME type never reaches the decoder.
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>',
    );
    expect(sniffAvatarFormat(svg)).toBeNull();
    res = await upload(svg, 'image/png');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual(invalid);

    // Declared type outside the allowlist keeps the original message.
    res = await upload(svg, 'image/svg+xml');
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'Unsupported image type. Use jpg, png, gif or webp',
    });

    // Decompression bomb: tiny file, 100 megapixels.
    const bomb = await sharp({
      create: { width: 10000, height: 10000, channels: 3, background: '#fff' },
    })
      .png()
      .toBuffer();
    expect(bomb.length).toBeLessThan(3 * 1024 * 1024);
    res = await upload(bomb, 'image/png');
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(
      /dimensions too large/,
    );

    // Size limit is unchanged.
    res = await upload(new Uint8Array(3 * 1024 * 1024 + 1), 'image/png');
    expect(res.status).toBe(413);

    expect(db.getUserById(userId)!.avatar_url).toBe(goodUrl);
    expect(fs.existsSync(goodPath)).toBe(true);
  });
});

describe('avatar serving', () => {
  test('avatars stored before resizing still serve byte-for-byte with the same headers', async () => {
    fs.mkdirSync(avatarsDir, { recursive: true });
    const legacy = `${crypto.randomUUID()}-user-deadbeef.png`;
    const bytes = await sharp({
      create: { width: 1200, height: 1200, channels: 3, background: '#abc' },
    })
      .png()
      .toBuffer();
    fs.writeFileSync(path.join(avatarsDir, legacy), bytes);

    const res = await app.request(`${BASE}/api/auth/avatars/${legacy}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toBe(IMMUTABLE);
    expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
    // No lazy variant is written next to it.
    expect(
      fs.readdirSync(avatarsDir).filter((f) => f.includes('deadbeef')),
    ).toEqual([legacy]);
  });

  test('path traversal and missing files are still refused', async () => {
    let res = await app.request(`${BASE}/api/auth/avatars/..%2Fdb`);
    expect(res.status).toBe(400);
    res = await app.request(`${BASE}/api/auth/avatars/..secret.png`);
    expect(res.status).toBe(400);
    res = await app.request(`${BASE}/api/auth/avatars/nope.webp`);
    expect(res.status).toBe(404);
  });
});
