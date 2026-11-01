import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const tmpDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-office-preview-'),
);
const groupsDir = path.join(tmpDir, 'groups');
const workspaceDir = path.join(groupsDir, 'ws-a');
const keyFile = path.join(tmpDir, 'stirling.key');
const PDF_BYTES = Buffer.from('%PDF-1.7\nfake converted output\n');

const mocks = vi.hoisted(() => ({
  getRegisteredGroup: vi.fn(),
  currentUserId: 'owner',
}));

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    DATA_DIR: tmpDir,
    GROUPS_DIR: groupsDir,
    STORE_DIR: path.join(tmpDir, 'db'),
  };
});

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: mocks.currentUserId,
      username: mocks.currentUserId,
      role: 'member',
      status: 'active',
      permissions: [],
    });
    return next();
  },
}));

vi.mock('../src/db.js', () => ({
  getRegisteredGroup: mocks.getRegisteredGroup,
  getJidsByFolder: () => [],
}));

vi.mock('../src/billing.js', () => ({
  isBillingEnabled: () => false,
  checkStorageLimit: () => ({ allowed: true }),
}));

const routes = (await import('../src/routes/files.js')).default;
const { getOfficePreviewCacheDir, pruneOfficePreviewCache } =
  await import('../src/office-preview.js');

const b64 = (p: string) => Buffer.from(p).toString('base64url');
const get = (rel: string, jid = 'web:a') =>
  routes.request(
    `http://localhost/${encodeURIComponent(jid)}/files/office-preview/${b64(rel)}`,
  );

let server: http.Server;
let requests: { key: string | undefined; bytes: number }[] = [];
let upstreamStatus = 200;
let upstreamDelayMs = 0;
const ENV_KEYS = [
  'OFFICE_PREVIEW_STIRLING_URL',
  'OFFICE_PREVIEW_STIRLING_KEY_FILE',
  'OFFICE_PREVIEW_SOFFICE_BIN',
  'OFFICE_PREVIEW_MAX_MB',
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      requests.push({
        key: req.headers['x-api-key'] as string | undefined,
        bytes: Buffer.concat(chunks).length,
      });
      setTimeout(() => {
        res.statusCode = upstreamStatus;
        res.setHeader('content-type', 'application/pdf');
        res.end(upstreamStatus === 200 ? PDF_BYTES : 'boom');
      }, upstreamDelayMs);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
});

afterAll(async () => {
  await new Promise((r) => server.close(r));
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.rmSync(getOfficePreviewCacheDir(), { recursive: true, force: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(keyFile, 'secret-key-123\n');
  requests = [];
  upstreamStatus = 200;
  upstreamDelayMs = 0;
  mocks.currentUserId = 'owner';
  process.env.OFFICE_PREVIEW_STIRLING_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/convert/file/pdf`;
  process.env.OFFICE_PREVIEW_STIRLING_KEY_FILE = keyFile;
  delete process.env.OFFICE_PREVIEW_MAX_MB;
  mocks.getRegisteredGroup.mockImplementation((jid: string) =>
    jid === 'web:a'
      ? {
          jid,
          name: 'A',
          folder: 'ws-a',
          added_at: '2026-10-05T00:00:00.000Z',
          executionMode: 'container',
          created_by: 'owner',
          is_home: false,
        }
      : undefined,
  );
});

describe('GET /:jid/files/office-preview/:path', () => {
  test('converts, sends the key from file, then serves the second open from cache', async () => {
    fs.writeFileSync(path.join(workspaceDir, '测试文档.docx'), 'docx-bytes');

    const first = await get('测试文档.docx');
    expect(first.status).toBe(200);
    expect(first.headers.get('content-type')).toBe('application/pdf');
    expect(first.headers.get('x-office-preview-cache')).toBe('miss');
    expect(Buffer.from(await first.arrayBuffer())).toEqual(PDF_BYTES);

    const second = await get('测试文档.docx');
    expect(second.status).toBe(200);
    expect(second.headers.get('x-office-preview-cache')).toBe('hit');

    expect(requests).toHaveLength(1);
    expect(requests[0].key).toBe('secret-key-123');
    expect(fs.readdirSync(getOfficePreviewCacheDir())).toHaveLength(1);
  });

  test('a cache hit survives the converter being removed', async () => {
    fs.writeFileSync(path.join(workspaceDir, 'a.xlsx'), 'xlsx-bytes');
    expect((await get('a.xlsx')).status).toBe(200);

    delete process.env.OFFICE_PREVIEW_STIRLING_URL;
    process.env.OFFICE_PREVIEW_SOFFICE_BIN = '/nonexistent/soffice';
    const again = await get('a.xlsx');
    expect(again.status).toBe(200);
    expect(again.headers.get('x-office-preview-cache')).toBe('hit');
  });

  test('concurrent requests for identical content convert once', async () => {
    upstreamDelayMs = 150;
    fs.writeFileSync(path.join(workspaceDir, 'one.pptx'), 'same');
    fs.writeFileSync(path.join(workspaceDir, 'two.pptx'), 'same');

    const results = await Promise.all([
      get('one.pptx'),
      get('one.pptx'),
      get('two.pptx'),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(requests).toHaveLength(1);
  });

  test("another member cannot preview someone else's workspace", async () => {
    fs.writeFileSync(path.join(workspaceDir, 'secret.docx'), 'private');
    mocks.currentUserId = 'wj01';

    const res = await get('secret.docx');
    expect(res.status).toBe(404);
    expect(requests).toHaveLength(0);
    expect(fs.existsSync(getOfficePreviewCacheDir())).toBe(false);
  });

  test('path traversal is rejected', async () => {
    fs.writeFileSync(path.join(tmpDir, 'outside.docx'), 'x');
    const res = await get('../outside.docx');
    expect(res.status).toBe(500);
    expect(requests).toHaveLength(0);
  });

  test('no converter configured -> 501 NOT_CONFIGURED', async () => {
    delete process.env.OFFICE_PREVIEW_STIRLING_URL;
    process.env.OFFICE_PREVIEW_SOFFICE_BIN = '/nonexistent/soffice';
    fs.writeFileSync(path.join(workspaceDir, 'x.docx'), 'x');

    const res = await get('x.docx');
    expect(res.status).toBe(501);
    expect((await res.json()).code).toBe('NOT_CONFIGURED');
  });

  test('source over the size cap -> 413 without calling the converter', async () => {
    process.env.OFFICE_PREVIEW_MAX_MB = '1';
    fs.writeFileSync(
      path.join(workspaceDir, 'big.docx'),
      Buffer.alloc(1024 * 1024 + 1),
    );

    const res = await get('big.docx');
    expect(res.status).toBe(413);
    expect(requests).toHaveLength(0);
  });

  test('non-Office extension -> 400, missing file -> 404', async () => {
    fs.writeFileSync(path.join(workspaceDir, 'a.txt'), 'x');
    expect((await get('a.txt')).status).toBe(400);
    expect((await get('missing.docx')).status).toBe(404);
  });

  test('converter failure -> 502 and nothing is cached', async () => {
    upstreamStatus = 500;
    fs.writeFileSync(path.join(workspaceDir, 'bad.docx'), 'x');

    const res = await get('bad.docx');
    expect(res.status).toBe(502);
    expect((await res.json()).code).toBe('CONVERT_FAILED');
    expect(fs.existsSync(getOfficePreviewCacheDir())).toBe(false);
  });
});

describe('pruneOfficePreviewCache', () => {
  test('evicts least recently used files first and keeps the protected one', () => {
    const dir = getOfficePreviewCacheDir();
    fs.mkdirSync(dir, { recursive: true });
    const names = ['old', 'mid', 'new'];
    names.forEach((n, i) => {
      const f = path.join(dir, `${n}.pdf`);
      fs.writeFileSync(f, Buffer.alloc(100));
      const t = new Date(Date.now() - (names.length - i) * 10_000);
      fs.utimesSync(f, t, t);
    });

    pruneOfficePreviewCache(150, path.join(dir, 'old.pdf'));
    expect(fs.readdirSync(dir).sort()).toEqual(['old.pdf']);
  });
});
