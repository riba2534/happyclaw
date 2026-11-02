import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
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

const tmpDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-office-preview-'),
);
const groupsDir = path.join(tmpDir, 'groups');
const workspaceDir = path.join(groupsDir, 'ws-a');
const worktreeDir = path.join(tmpDir, 'worktrees', 'ws-a', 'wt-1');
const keyFile = path.join(tmpDir, 'stirling.key');
const PDF_BYTES = Buffer.from('%PDF-1.7\nfake converted output\n');

const mocks = vi.hoisted(() => ({
  getRegisteredGroup: vi.fn(),
  currentUserId: 'owner',
  currentRole: 'member' as 'member' | 'guest',
  guestGrant: false,
  debugLog: vi.fn(),
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
  logger: {
    debug: mocks.debugLog,
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}));

vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: mocks.currentUserId,
      username: mocks.currentUserId,
      role: mocks.currentRole,
      status: 'active',
      permissions: [],
    });
    return next();
  },
}));

vi.mock('../src/db.js', () => ({
  getRegisteredGroup: mocks.getRegisteredGroup,
  getJidsByFolder: () => [],
  // `wt-1` is a session of web:a that runs in its own worktree.
  getAgent: (id: string) =>
    id === 'wt-1' ? { id, chat_jid: 'web:a' } : undefined,
  hasActiveGuestWorkspaceGrant: () => mocks.guestGrant,
}));

vi.mock('../src/session-worktree-store.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    getSessionWorktree: (id: string | null | undefined) =>
      id === 'wt-1'
        ? {
            agent_id: id,
            group_folder: 'ws-a',
            chat_jid: 'web:a',
            repo_path: workspaceDir,
            cwd_subpath: '',
            worktree_path: worktreeDir,
            branch: 'happyclaw/wt',
            base_commit: 'abc',
            status: 'active',
          }
        : undefined,
  };
});

vi.mock('../src/billing.js', () => ({
  isBillingEnabled: () => false,
  checkStorageLimit: () => ({ allowed: true }),
}));

const routes = (await import('../src/routes/files.js')).default;
const {
  getOfficePreviewCacheDir,
  OFFICE_PREVIEW_MAX_ACTIVE,
  OFFICE_PREVIEW_MAX_QUEUED,
  pruneOfficePreviewCache,
} = await import('../src/office-preview.js');
const { isGuestRouteAllowed } =
  await import('../src/middleware/guest-guard.js');

const b64 = (p: string) => Buffer.from(p).toString('base64url');
/** Files this process holds open under `dir` (Linux /proc). */
const openFilesUnder = (dir: string) =>
  fs.readdirSync('/proc/self/fd').flatMap((fd) => {
    try {
      const target = fs.readlinkSync(`/proc/self/fd/${fd}`);
      return target.startsWith(dir) ? [target] : [];
    } catch {
      return [];
    }
  });
/** Every handle under these directories gets closed (handles close async). */
const expectNoOpenFilesUnder = (...dirs: string[]) =>
  vi.waitFor(() =>
    expect(dirs.flatMap((dir) => openFilesUnder(dir))).toEqual([]),
  );
/** Long enough for a request to pass its checks and start waiting. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 200));
const sha256 = (data: string) =>
  crypto.createHash('sha256').update(data).digest('hex');
const get = (
  rel: string,
  options: { jid?: string; query?: string; init?: RequestInit } = {},
) =>
  routes.request(
    `http://localhost/${encodeURIComponent(options.jid ?? 'web:a')}/files/office-preview/${b64(rel)}${options.query ?? ''}`,
    options.init,
  );

type Upstream = 'pdf' | 'error' | 'not-pdf' | 'big-declared' | 'big-chunked';

let server: http.Server;
let requests: { key: string | undefined; body: Buffer }[] = [];
let upstream: Upstream = 'pdf';
let upstreamDelayMs = 0;
let holdResponses = false;
let held: Array<() => void> = [];
let inProgress = 0;
let maxInProgress = 0;
const BIG_OUTPUT = 4 * 1024 * 1024 + 1; // past the 4 × 1 MB output limit

function respond(res: http.ServerResponse): void {
  res.on('error', () => {});
  res.on('close', () => inProgress--);
  if (upstream === 'error') {
    res.statusCode = 500;
    res.end('boom');
    return;
  }
  res.setHeader('content-type', 'application/pdf');
  if (upstream === 'not-pdf') {
    res.end('<html>login</html>');
  } else if (upstream === 'big-declared') {
    const body = Buffer.alloc(BIG_OUTPUT, 0x20);
    body.write('%PDF-');
    res.end(body);
  } else if (upstream === 'big-chunked') {
    // No Content-Length: only counting the streamed bytes can catch it.
    res.write('%PDF-');
    const chunk = Buffer.alloc(1024 * 1024, 0x20);
    for (let i = 0; i < 5; i++) res.write(chunk);
    res.end();
  } else {
    res.end(PDF_BYTES);
  }
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    inProgress++;
    maxInProgress = Math.max(maxInProgress, inProgress);
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      requests.push({
        key: req.headers['x-api-key'] as string | undefined,
        body: Buffer.concat(chunks),
      });
      const send = () => setTimeout(() => respond(res), upstreamDelayMs);
      if (holdResponses) held.push(send);
      else send();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.rmSync(worktreeDir, { recursive: true, force: true });
  fs.rmSync(getOfficePreviewCacheDir(), { recursive: true, force: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(keyFile, 'secret-key-123\n');
  requests = [];
  upstream = 'pdf';
  upstreamDelayMs = 0;
  holdResponses = false;
  held = [];
  maxInProgress = 0;
  mocks.currentUserId = 'owner';
  mocks.currentRole = 'member';
  mocks.guestGrant = false;
  mocks.debugLog.mockReset();
  vi.stubEnv(
    'OFFICE_PREVIEW_STIRLING_URL',
    `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/convert/file/pdf`,
  );
  vi.stubEnv('OFFICE_PREVIEW_STIRLING_KEY_FILE', keyFile);
  vi.stubEnv('OFFICE_PREVIEW_MAX_MB', undefined);
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
    expect(first.headers.get('content-security-policy')).toBe(
      "default-src 'none'; sandbox",
    );
    // No hit/miss header: it would reveal that someone previewed this content.
    expect(first.headers.get('x-office-preview-cache')).toBeNull();
    expect(Buffer.from(await first.arrayBuffer())).toEqual(PDF_BYTES);

    const second = await get('测试文档.docx');
    expect(second.status).toBe(200);
    expect(second.headers.get('x-office-preview-cache')).toBeNull();
    expect(Buffer.from(await second.arrayBuffer())).toEqual(PDF_BYTES);

    expect(requests).toHaveLength(1);
    expect(requests[0].key).toBe('secret-key-123');
    expect(fs.readdirSync(getOfficePreviewCacheDir())).toHaveLength(1);
  });

  test('the ETag is the content hash; a match revalidates to 304 without converting', async () => {
    const file = path.join(workspaceDir, 'a.docx');
    fs.writeFileSync(file, 'docx-v1');

    const first = await get('a.docx');
    expect(first.status).toBe(200);
    const etag = first.headers.get('etag')!;
    expect(etag).toBe(`"${sha256('docx-v1')}"`);
    expect(first.headers.get('cache-control')).toBe('private, no-cache');
    await first.arrayBuffer();

    // Even with the cached PDF evicted, the browser's copy is still valid.
    fs.rmSync(getOfficePreviewCacheDir(), { recursive: true, force: true });
    const again = await get('a.docx', {
      init: { headers: { 'If-None-Match': etag } },
    });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
    expect(again.headers.get('etag')).toBe(etag);
    expect(requests).toHaveLength(1);

    fs.writeFileSync(file, 'docx-v2');
    const changed = await get('a.docx', {
      init: { headers: { 'If-None-Match': etag } },
    });
    expect(changed.status).toBe(200);
    expect(changed.headers.get('etag')).toBe(`"${sha256('docx-v2')}"`);
    await changed.arrayBuffer();
  });

  test('HEAD converts without sending the PDF; the GET after it uses the cache', async () => {
    // Within the default limits, and larger than the stream buffers.
    upstream = 'big-declared';
    fs.writeFileSync(path.join(workspaceDir, 'a.docx'), 'docx');

    const head = await get('a.docx', { init: { method: 'HEAD' } });
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(BIG_OUTPUT));
    expect(await head.text()).toBe('');
    if (process.platform === 'linux') {
      // The cached PDF opened for the dropped body is closed again.
      await expectNoOpenFilesUnder(getOfficePreviewCacheDir());
    }

    const body = await get('a.docx');
    expect((await body.arrayBuffer()).byteLength).toBe(BIG_OUTPUT);
    expect(requests).toHaveLength(1);
  });

  test('without a converter: 501 before the file is opened, even past the size cap', async () => {
    vi.stubEnv('OFFICE_PREVIEW_STIRLING_URL', undefined);
    vi.stubEnv('OFFICE_PREVIEW_MAX_MB', '1');
    fs.writeFileSync(
      path.join(workspaceDir, 'big.docx'),
      Buffer.alloc(1024 * 1024 + 1),
    );
    const open = vi.spyOn(fs.promises, 'open');
    try {
      const res = await get('big.docx');
      expect(res.status).toBe(501);
      expect((await res.json()).code).toBe('NOT_CONFIGURED');
      expect(open).not.toHaveBeenCalled();
    } finally {
      open.mockRestore();
    }
  });

  test('a file swapped for a symlink while it waits for a slot is read as checked', async () => {
    const secret = path.join(tmpDir, 'host-secret.txt');
    fs.writeFileSync(secret, 'HOST-SECRET-OUTSIDE-ROOT');
    holdResponses = true;
    const blockers = [0, 1].map((i) => {
      fs.writeFileSync(path.join(workspaceDir, `busy-${i}.docx`), `busy ${i}`);
      return get(`busy-${i}.docx`).then((res) => res.arrayBuffer());
    });
    await vi.waitFor(() =>
      expect(held).toHaveLength(OFFICE_PREVIEW_MAX_ACTIVE),
    );
    const file = path.join(workspaceDir, 'a.docx');
    fs.writeFileSync(file, 'ORIGINAL-BYTES');
    const pending = get('a.docx');
    await settle();
    fs.rmSync(file);
    fs.symlinkSync(secret, file);
    holdResponses = false;
    for (const send of held.splice(0)) send();

    const res = await pending;
    expect(res.status).toBe(200);
    await res.arrayBuffer();
    await Promise.all(blockers);
    const uploaded = Buffer.concat(requests.map((r) => r.body)).toString(
      'latin1',
    );
    expect(uploaded).toContain('ORIGINAL-BYTES');
    expect(uploaded).not.toContain('HOST-SECRET-OUTSIDE-ROOT');
  });

  test.skipIf(process.platform === 'win32')(
    'a FIFO named like an Office file is refused instead of blocking',
    async () => {
      execFileSync('mkfifo', [path.join(workspaceDir, 'pipe.docx')]);
      const res = await get('pipe.docx');
      expect(res.status).toBe(404);
      expect(requests).toHaveLength(0);
    },
  );

  test.skipIf(process.platform !== 'linux')(
    'a cached PDF whose handle fails is treated as a miss and that handle closed',
    async () => {
      fs.writeFileSync(path.join(workspaceDir, 'a.docx'), 'docx');
      await (await get('a.docx')).arrayBuffer();
      const cacheDir = getOfficePreviewCacheDir();

      // The first handle opened on the cache fails its stat().
      const realOpen = fs.promises.open;
      let failed = false;
      const open = vi
        .spyOn(fs.promises, 'open')
        .mockImplementation(async (...args: any[]) => {
          const handle = await (realOpen as any)(...args);
          if (!failed && String(args[0]).startsWith(cacheDir)) {
            failed = true;
            handle.stat = () => Promise.reject(new Error('EIO'));
          }
          return handle;
        });
      try {
        const res = await get('a.docx');
        expect(res.status).toBe(200);
        expect(Buffer.from(await res.arrayBuffer())).toEqual(PDF_BYTES);
      } finally {
        open.mockRestore();
      }
      expect(failed).toBe(true);
      await expectNoOpenFilesUnder(cacheDir);
    },
  );

  test.skipIf(process.platform !== 'linux')(
    'a failure after the PDF is opened still closes it and the source',
    async () => {
      fs.writeFileSync(path.join(workspaceDir, 'a.docx'), 'docx');
      mocks.debugLog.mockImplementationOnce(() => {
        throw new Error('log sink down');
      });
      expect((await get('a.docx')).status).toBe(500);
      await expectNoOpenFilesUnder(getOfficePreviewCacheDir(), workspaceDir);
    },
  );

  describe('the file is opened as it was checked', () => {
    /** Runs `swap` just before the route opens `rel`. */
    async function getSwappingBeforeOpen(rel: string, swap: () => void) {
      const target = path.join(workspaceDir, rel);
      const realOpen = fs.promises.open;
      const open = vi
        .spyOn(fs.promises, 'open')
        .mockImplementation(async (...args: any[]) => {
          if (args[0] === target) swap();
          return (realOpen as any)(...args);
        });
      try {
        return await get(rel);
      } finally {
        open.mockRestore();
      }
    }

    test('a symlink to a file inside the root previews like download does', async () => {
      fs.writeFileSync(path.join(workspaceDir, 'real.docx'), 'real');
      fs.symlinkSync(
        path.join(workspaceDir, 'real.docx'),
        path.join(workspaceDir, 'link.docx'),
      );
      const res = await get('link.docx');
      expect(res.status).toBe(200);
      expect(Buffer.from(await res.arrayBuffer())).toEqual(PDF_BYTES);
      expect(requests).toHaveLength(1);
    });

    test('a symlink out of the root is refused', async () => {
      const outside = path.join(tmpDir, 'outside.docx');
      fs.writeFileSync(outside, 'host secret');
      fs.symlinkSync(outside, path.join(workspaceDir, 'escape.docx'));
      expect((await get('escape.docx')).status).not.toBe(200);
      expect(requests).toHaveLength(0);
    });

    test('a file replaced between the checks and the open is refused', async () => {
      const file = path.join(workspaceDir, 'a.docx');
      fs.writeFileSync(file, 'checked');
      fs.writeFileSync(path.join(workspaceDir, 'other.docx'), 'swapped in');
      const res = await getSwappingBeforeOpen('a.docx', () =>
        fs.renameSync(path.join(workspaceDir, 'other.docx'), file),
      );
      expect(res.status).toBe(404);
      expect(requests).toHaveLength(0);
    });

    test('a directory swapped for a link out of the root is refused', async () => {
      // Same inode outside the root (a hard link), reached through a
      // directory that became a symlink after the checks.
      const sub = path.join(workspaceDir, 'sub');
      const outside = path.join(tmpDir, 'outside-dir');
      fs.rmSync(outside, { recursive: true, force: true });
      fs.mkdirSync(sub);
      fs.mkdirSync(outside);
      fs.writeFileSync(path.join(sub, 'a.docx'), 'inside');
      fs.linkSync(path.join(sub, 'a.docx'), path.join(outside, 'a.docx'));
      const res = await getSwappingBeforeOpen('sub/a.docx', () => {
        fs.renameSync(sub, path.join(workspaceDir, 'sub-old'));
        fs.symlinkSync(outside, sub);
      });
      expect(res.status).toBe(404);
      expect(requests).toHaveLength(0);
    });
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

  test(`at most ${OFFICE_PREVIEW_MAX_ACTIVE} conversions run, ${OFFICE_PREVIEW_MAX_QUEUED} wait, the next gets 503 BUSY`, async () => {
    holdResponses = true;
    const total = OFFICE_PREVIEW_MAX_ACTIVE + OFFICE_PREVIEW_MAX_QUEUED + 1;
    for (let i = 0; i < total; i++) {
      fs.writeFileSync(path.join(workspaceDir, `f${i}.docx`), `content-${i}`);
    }
    const settled: (Response | undefined)[] = [];
    const pending = Array.from({ length: total }, (_, i) =>
      get(`f${i}.docx`).then((res) => (settled[i] = res)),
    );

    await vi.waitFor(() => {
      expect(settled.filter(Boolean)).toHaveLength(1);
      expect(held).toHaveLength(OFFICE_PREVIEW_MAX_ACTIVE);
    });
    const busy = settled.find(Boolean)!;
    expect(busy.status).toBe(503);
    expect((await busy.json()).code).toBe('BUSY');

    holdResponses = false;
    for (const send of held.splice(0)) send();
    const results = await Promise.all(pending);
    expect(results.filter((r) => r.status === 200)).toHaveLength(total - 1);
    expect(requests).toHaveLength(total - 1);
    expect(maxInProgress).toBe(OFFICE_PREVIEW_MAX_ACTIVE);
  });

  test("another member cannot preview someone else's workspace", async () => {
    fs.writeFileSync(path.join(workspaceDir, 'secret.docx'), 'private');
    mocks.currentUserId = 'wj01';

    const res = await get('secret.docx');
    expect(res.status).toBe(404);
    expect(requests).toHaveLength(0);
    expect(fs.existsSync(getOfficePreviewCacheDir())).toBe(false);
  });

  test('a granted guest may preview, but not hidden paths; the guest guard admits the route', async () => {
    fs.writeFileSync(path.join(workspaceDir, 'report.docx'), 'report');
    fs.mkdirSync(path.join(workspaceDir, 'logs'));
    fs.writeFileSync(path.join(workspaceDir, 'logs', 'run.docx'), 'log');
    fs.writeFileSync(path.join(workspaceDir, '.draft.docx'), 'draft');
    fs.symlinkSync(
      path.join(workspaceDir, '.draft.docx'),
      path.join(workspaceDir, 'innocent.docx'),
    );
    mocks.currentUserId = 'guest-1';
    mocks.currentRole = 'guest';

    expect((await get('report.docx')).status).toBe(404); // no grant yet
    mocks.guestGrant = true;
    const ok = await get('report.docx');
    expect(ok.status).toBe(200);
    expect(Buffer.from(await ok.arrayBuffer())).toEqual(PDF_BYTES);
    for (const hidden of ['logs/run.docx', '.draft.docx', 'innocent.docx']) {
      const res = await get(hidden);
      expect([hidden, res.status]).toEqual([hidden, 404]);
    }
    expect(requests).toHaveLength(1);

    const route = `/api/groups/web%3Aa/files/office-preview/${b64('report.docx')}`;
    expect(isGuestRouteAllowed('GET', route)).toBe(true);
    expect(isGuestRouteAllowed('HEAD', route)).toBe(true);
    expect(isGuestRouteAllowed('POST', route)).toBe(false);
  });

  test('?agentId= previews the file in that session’s worktree', async () => {
    fs.writeFileSync(path.join(workspaceDir, 'plan.docx'), 'main checkout');
    fs.mkdirSync(worktreeDir, { recursive: true });
    fs.writeFileSync(path.join(worktreeDir, 'plan.docx'), 'worktree copy');

    const session = await get('plan.docx', { query: '?agentId=wt-1' });
    expect(session.status).toBe(200);
    expect(session.headers.get('etag')).toBe(`"${sha256('worktree copy')}"`);
    await session.arrayBuffer();

    const workspace = await get('plan.docx');
    expect(workspace.headers.get('etag')).toBe(`"${sha256('main checkout')}"`);
    await workspace.arrayBuffer();

    expect(
      (await get('plan.docx', { query: '?agentId=not-a-session' })).status,
    ).toBe(404);
  });

  test('path traversal is rejected', async () => {
    fs.writeFileSync(path.join(tmpDir, 'outside.docx'), 'x');
    const res = await get('../outside.docx');
    expect(res.status).toBe(500);
    expect(requests).toHaveLength(0);
  });

  test('no converter configured -> 501 NOT_CONFIGURED', async () => {
    vi.stubEnv('OFFICE_PREVIEW_STIRLING_URL', undefined);
    vi.stubEnv('OFFICE_PREVIEW_SOFFICE_BIN', '/nonexistent/soffice');
    fs.writeFileSync(path.join(workspaceDir, 'x.docx'), 'x');

    const res = await get('x.docx');
    expect(res.status).toBe(501);
    expect((await res.json()).code).toBe('NOT_CONFIGURED');
  });

  test('source over the size cap -> 413 without calling the converter', async () => {
    vi.stubEnv('OFFICE_PREVIEW_MAX_MB', '1');
    fs.writeFileSync(
      path.join(workspaceDir, 'big.docx'),
      Buffer.alloc(1024 * 1024 + 1),
    );

    const res = await get('big.docx');
    expect(res.status).toBe(413);
    expect(requests).toHaveLength(0);
  });

  test.each(['big-declared', 'big-chunked'] as const)(
    'converter output past 4 × the source cap (%s) -> 413, nothing cached',
    async (mode) => {
      vi.stubEnv('OFFICE_PREVIEW_MAX_MB', '1');
      upstream = mode;
      fs.writeFileSync(path.join(workspaceDir, 'a.docx'), 'small');

      const res = await get('a.docx');
      expect(res.status).toBe(413);
      expect((await res.json()).code).toBe('FILE_TOO_LARGE');
      expect(fs.existsSync(getOfficePreviewCacheDir())).toBe(false);
    },
  );

  test('non-Office extension -> 400, missing file -> 404', async () => {
    fs.writeFileSync(path.join(workspaceDir, 'a.txt'), 'x');
    expect((await get('a.txt')).status).toBe(400);
    expect((await get('missing.docx')).status).toBe(404);
  });

  test.each(['error', 'not-pdf'] as const)(
    'converter failure (%s) -> 502 and nothing is cached',
    async (mode) => {
      upstream = mode;
      fs.writeFileSync(path.join(workspaceDir, 'bad.docx'), 'x');

      const res = await get('bad.docx');
      expect(res.status).toBe(502);
      expect((await res.json()).code).toBe('CONVERT_FAILED');
      expect(fs.existsSync(getOfficePreviewCacheDir())).toBe(false);
    },
  );
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
