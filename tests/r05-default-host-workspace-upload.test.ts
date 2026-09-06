import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const TEST_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-r05-test-'));
const DATA_DIR = path.join(TEST_DIR, 'data');
const GROUPS_DIR = path.join(DATA_DIR, 'groups');
const DB_DIR = path.join(DATA_DIR, 'db');

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    DATA_DIR,
    GROUPS_DIR,
    STORE_DIR: DB_DIR,
  };
});

vi.mock('../src/logger.js', () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  },
}));

vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: 'admin-user',
      username: 'admin-user',
      role: 'admin',
      status: 'active',
      permissions: [],
    });
    return next();
  },
}));

vi.mock('../src/web.js', () => ({
  broadcastNewMessage: () => {},
  invalidateAllowedUserCache: () => {},
}));

const groupRoutes = (await import('../src/routes/groups.js')).default;
const fileRoutes = (await import('../src/routes/files.js')).default;
const db = await import('../src/db.js');
const webContext = await import('../src/web-context.js');

const registeredGroupsCache: Record<string, any> = {};

beforeAll(() => {
  fs.mkdirSync(DB_DIR, { recursive: true });
  fs.mkdirSync(GROUPS_DIR, { recursive: true });
  db.initDatabase();
  webContext.setWebDeps({
    getRegisteredGroups: () => registeredGroupsCache,
    ensureTerminalContainerStarted: () => true,
  } as unknown as Parameters<typeof webContext.setWebDeps>[0]);
});

afterAll(() => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('R05: Default Host workspace directory pre-creation and zero-message upload', () => {
  test('creates default host workspace with directory ready before any messages, allowing immediate upload, list and read', async () => {
    // 1. Create a default host workspace without customCwd
    const wsName = 'Default Host Zero-Message Test';
    const createRes = await groupRoutes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: wsName,
        execution_mode: 'host',
      }),
    });

    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as any;
    expect(created.jid).toBeDefined();
    expect(created.group).toBeDefined();
    expect(created.group.folder).toBeDefined();

    // Verify directory exists on disk immediately after creation
    const expectedDir = path.join(GROUPS_DIR, created.group.folder);
    expect(fs.existsSync(expectedDir)).toBe(true);

    // Sync to cache so getRegisteredGroup / getWebDeps can find it
    registeredGroupsCache[created.jid] = db.getRegisteredGroup(created.jid);

    // 2. Zero-message direct upload without starting runner
    const formData = new FormData();
    const testContent = 'Hello HappyClaw R05 Host Upload!';
    const testFile = new File([testContent], 'readme.txt', {
      type: 'text/plain',
    });
    formData.append('files', testFile);
    formData.append('path', '');

    const uploadRes = await fileRoutes.request(
      `/${encodeURIComponent(created.jid)}/files`,
      {
        method: 'POST',
        body: formData,
      },
    );
    expect(uploadRes.status).toBe(200);
    const uploadJson = (await uploadRes.json()) as any;
    expect(uploadJson.success).toBe(true);

    // Verify file exists on disk in the pre-created group directory
    const uploadedFilePath = path.join(expectedDir, 'readme.txt');
    expect(fs.existsSync(uploadedFilePath)).toBe(true);
    expect(fs.readFileSync(uploadedFilePath, 'utf8')).toBe(testContent);

    // 3. Zero-message list files
    const listRes = await fileRoutes.request(
      `/${encodeURIComponent(created.jid)}/files`,
    );
    expect(listRes.status).toBe(200);
    const listJson = (await listRes.json()) as any;
    expect(listJson.files).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'readme.txt',
          path: 'readme.txt',
          type: 'file',
        }),
      ]),
    );

    // 4. Read / download uploaded file (path parameter is base64url encoded)
    const encodedPath = Buffer.from('readme.txt').toString('base64url');
    const downloadRes = await fileRoutes.request(
      `/${encodeURIComponent(created.jid)}/files/download/${encodedPath}`,
    );
    expect(downloadRes.status).toBe(200);
    const downloadedText = await downloadRes.text();
    expect(downloadedText).toBe(testContent);
  });

  test('does not invent customCwd if non-existent custom_cwd is passed', async () => {
    const nonExistentPath = path.join(TEST_DIR, 'does-not-exist-dir');
    const createRes = await groupRoutes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Bad Custom Cwd Workspace',
        execution_mode: 'host',
        custom_cwd: nonExistentPath,
      }),
    });

    expect(createRes.status).toBe(400);
    // Ensure custom_cwd was not created
    expect(fs.existsSync(nonExistentPath)).toBe(false);
  });
});
