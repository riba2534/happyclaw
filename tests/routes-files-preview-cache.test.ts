import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

const tmpDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-preview-cache-'),
);
const groupsDir = path.join(tmpDir, 'groups');
const workspaceDir = path.join(groupsDir, 'preview-workspace');

const dbMocks = vi.hoisted(() => ({ getRegisteredGroup: vi.fn() }));

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
      id: 'member-user',
      username: 'member-user',
      role: 'member',
      status: 'active',
      permissions: [],
    });
    return next();
  },
}));

vi.mock('../src/db.js', () => ({
  getRegisteredGroup: dbMocks.getRegisteredGroup,
}));

vi.mock('../src/web-context.js', () => ({
  canAccessGroup: () => true,
  isHostExecutionGroup: () => false,
  hasHostExecutionPermission: () => true,
}));

const routes = (await import('../src/routes/files.js')).default;

const encoded = Buffer.from('pic.png').toString('base64url');
const URL = `http://localhost/web%3Apreview/files/preview/${encoded}`;

beforeEach(() => {
  fs.rmSync(workspaceDir, { recursive: true, force: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, 'pic.png'), Buffer.alloc(2048, 1));
  dbMocks.getRegisteredGroup.mockReset();
  dbMocks.getRegisteredGroup.mockImplementation((jid: string) =>
    jid === 'web:preview'
      ? {
          jid,
          name: 'Preview workspace',
          folder: 'preview-workspace',
          added_at: '2026-10-28T00:00:00.000Z',
          executionMode: 'container',
          created_by: 'member-user',
          is_home: false,
        }
      : undefined,
  );
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('GET /:jid/files/preview/:path caching', () => {
  test('returns cache validators and serves 304 for a matching ETag', async () => {
    const first = await routes.request(URL);
    expect(first.status).toBe(200);
    expect(first.headers.get('Cache-Control')).toBe('private, max-age=300');
    const etag = first.headers.get('ETag');
    expect(etag).toMatch(/^W\/"/);
    expect(first.headers.get('Last-Modified')).toBeTruthy();
    expect((await first.arrayBuffer()).byteLength).toBe(2048);

    const again = await routes.request(URL, {
      headers: { 'If-None-Match': etag! },
    });
    expect(again.status).toBe(304);
    expect(await again.text()).toBe('');
    expect(again.headers.get('ETag')).toBe(etag);
  });

  test('a changed file gets a new ETag and a full response', async () => {
    const etag = (await routes.request(URL)).headers.get('ETag')!;
    const file = path.join(workspaceDir, 'pic.png');
    fs.writeFileSync(file, Buffer.alloc(4096, 2));
    fs.utimesSync(file, new Date(), new Date(Date.now() + 5000));

    const res = await routes.request(URL, {
      headers: { 'If-None-Match': etag },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('ETag')).not.toBe(etag);
    expect((await res.arrayBuffer()).byteLength).toBe(4096);
  });
});
