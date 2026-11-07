import fs from 'node:fs';
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
  path.join(os.tmpdir(), 'happyclaw-routes-storage-sources-'),
);
const dataDir = path.join(tmpDir, 'data');
const allowlistPath = path.join(tmpDir, 'config', 'mount-allowlist.json');
const managedPath = path.join(dataDir, 'config', 'storage-sources.json');

vi.mock('../src/config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...real,
    DATA_DIR: dataDir,
    STORE_DIR: path.join(dataDir, 'db'),
    GROUPS_DIR: path.join(dataDir, 'groups'),
    MOUNT_ALLOWLIST_PATH: allowlistPath,
  };
});

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/middleware/auth.ts', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../src/middleware/auth.ts')>();
  return {
    ...real,
    authMiddleware: async (c: any, next: any) => {
      c.set('user', {
        id: 'storage-admin',
        username: 'storage-admin',
        display_name: 'Storage Admin',
        role: 'admin',
        status: 'active',
        permissions: [],
        must_change_password: false,
      });
      return next();
    },
  };
});

const web = await import('../src/web.js');
const db = await import('../src/db.js');
const stopGroup = vi.fn(async (_jid: string, _options?: unknown) => {});
const blockGroupsForRuntimeSafety = vi.fn();
const unblockGroupsForRuntimeSafety = vi.fn();
const app = web.createAppForTest({
  queue: {
    stopGroup,
    listDescendantJids: () => [],
    pauseGroupsForMutation: () => ({ id: 'test-pause' }),
    resumeGroupsAfterMutation: vi.fn(),
    blockGroupsForRuntimeSafety,
    unblockGroupsForRuntimeSafety,
    isGroupRuntimeSafetyBlocked: () => false,
  },
  getRegisteredGroups: () => ({}),
  sessions: {},
  ensureTerminalContainerStarted: vi.fn(() => true),
  reconnectUserIMChannels: vi.fn(async () => {}),
} as any);

const nfs = {
  type: 'nfs',
  server: 'nas.lan',
  exportPath: '/volume1/shared',
  allowReadWrite: true,
};
const smb = {
  type: 'cifs',
  server: 'smb.lan',
  share: 'team',
  username: 'agent',
  allowReadWrite: false,
};

function request(
  method: string,
  id: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  return Promise.resolve(
    app.request(`/api/config/storage-sources/${id}`, {
      method,
      headers: { 'content-type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }),
  );
}

function auditLogs(
  eventType: 'storage_source_saved' | 'storage_source_deleted',
) {
  return db.queryAuthAuditLogs({ event_type: eventType }).logs;
}

/** A Container workspace that mounts `source`. */
function mountWorkspace(folder: string, source: string, readonly: boolean) {
  db.setRegisteredGroup(`web:${folder}`, {
    name: folder,
    folder,
    added_at: new Date().toISOString(),
    executionMode: 'container',
    created_by: 'storage-admin',
    containerConfig: {
      additionalMounts: [{ source, containerPath: 'nas', readonly }],
    },
  });
}

const allowlist = `${JSON.stringify({
  allowedRoots: [],
  blockedPatterns: [],
  nonMainReadOnly: false,
  storageSources: [
    {
      id: 'from-file',
      type: 'nfs',
      server: 'files.lan',
      exportPath: '/export',
      allowReadWrite: false,
    },
  ],
})}\n`;

beforeAll(() => {
  fs.mkdirSync(path.join(dataDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'groups'), { recursive: true });
  fs.mkdirSync(path.dirname(allowlistPath), { recursive: true });
  fs.writeFileSync(allowlistPath, allowlist);
  db.initDatabase();
  const now = new Date().toISOString();
  db.createUser({
    id: 'storage-admin',
    username: 'storage-admin',
    password_hash: 'hash',
    display_name: 'Storage Admin',
    role: 'admin',
    status: 'active',
    created_at: now,
    updated_at: now,
    must_change_password: false,
  });
});

beforeEach(() => {
  stopGroup.mockReset();
  stopGroup.mockImplementation(async () => {});
  blockGroupsForRuntimeSafety.mockClear();
  unblockGroupsForRuntimeSafety.mockClear();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('storage source routes', () => {
  test('lists, creates and audits without server details or touching the allowlist', async () => {
    const created = await request('POST', 'nas-smb', {
      ...smb,
      password: 'hunter2',
    });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      source: { id: 'nas-smb', hasPassword: true, origin: 'web' },
    });

    const listed = await app.request('/api/config/storage-sources');
    expect(listed.status).toBe(200);
    const body = await listed.json();
    expect(
      body.sources.map((source: { id: string; origin: string }) => [
        source.id,
        source.origin,
      ]),
    ).toEqual([
      ['from-file', 'allowlist'],
      ['nas-smb', 'web'],
    ]);
    expect(JSON.stringify(body)).not.toContain('hunter2');
    expect(fs.readFileSync(allowlistPath, 'utf8')).toBe(allowlist);
    expect(fs.readdirSync(path.dirname(allowlistPath))).toEqual([
      'mount-allowlist.json',
    ]);
    expect(fs.existsSync(managedPath)).toBe(true);

    const [log] = auditLogs('storage_source_saved');
    expect(log.details).toEqual({
      source_id: 'nas-smb',
      type: 'cifs',
      created: true,
      password_changed: true,
    });
    expect(JSON.stringify(log.details)).not.toMatch(/smb\.lan|team/);
  });

  test('the password audit follows what was stored or removed', async () => {
    expect(
      (await request('POST', 'audit-nfs', { ...nfs, password: 'x' })).status,
    ).toBe(201);
    expect(
      (await request('POST', 'audit-smb', { ...smb, password: 'pw' })).status,
    ).toBe(201);
    expect((await request('PUT', 'audit-smb', { ...nfs })).status).toBe(200);
    const details = auditLogs('storage_source_saved')
      .map((log) => log.details as Record<string, unknown>)
      .filter((entry) => String(entry.source_id).startsWith('audit-'))
      .reverse();
    expect(details).toEqual([
      expect.objectContaining({
        source_id: 'audit-nfs',
        password_changed: false,
      }),
      expect.objectContaining({
        source_id: 'audit-smb',
        password_changed: true,
      }),
      expect.objectContaining({
        source_id: 'audit-smb',
        type: 'nfs',
        password_changed: true,
      }),
    ]);
  });

  test('single-user host mode refuses every write: it runs no Docker', async () => {
    const managedBefore = fs.existsSync(managedPath)
      ? fs.readFileSync(managedPath, 'utf8')
      : null;
    process.env.HAPPYCLAW_DEPLOYMENT_MODE = 'single_user_host';
    try {
      for (const method of ['POST', 'PUT', 'DELETE']) {
        const response = await request(
          method,
          'nas-single',
          method === 'DELETE' ? undefined : nfs,
        );
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({
          code: 'SINGLE_USER_HOST',
        });
      }
      expect(
        fs.existsSync(managedPath)
          ? fs.readFileSync(managedPath, 'utf8')
          : null,
      ).toBe(managedBefore);
    } finally {
      delete process.env.HAPPYCLAW_DEPLOYMENT_MODE;
    }
  });

  test('allowlist file sources are read-only through the API', async () => {
    for (const method of ['POST', 'PUT']) {
      const response = await request(method, 'from-file', nfs);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: 'STORAGE_SOURCE_READ_ONLY',
      });
    }
    expect((await request('DELETE', 'from-file')).status).toBe(409);
    expect(fs.readFileSync(allowlistPath, 'utf8')).toBe(allowlist);
  });

  test('a description edit leaves runners alone; a mount change stops them first', async () => {
    expect((await request('POST', 'quiesce-nfs', nfs)).status).toBe(201);
    mountWorkspace('ws-quiesce', 'quiesce-nfs', true);

    expect(
      (await request('PUT', 'quiesce-nfs', { ...nfs, description: 'shared' }))
        .status,
    ).toBe(200);
    expect(stopGroup).not.toHaveBeenCalled();

    expect(
      (await request('PUT', 'quiesce-nfs', { ...nfs, server: 'nas2.lan' }))
        .status,
    ).toBe(200);
    expect(stopGroup).toHaveBeenCalledWith(
      'web:ws-quiesce',
      expect.objectContaining({ force: true, preserveQueuedWork: true }),
    );

    stopGroup.mockClear();
    expect((await request('DELETE', 'quiesce-nfs')).status).toBe(200);
    expect(stopGroup).toHaveBeenCalledWith(
      'web:ws-quiesce',
      expect.objectContaining({ force: true }),
    );
    expect(auditLogs('storage_source_deleted')[0].details).toEqual({
      source_id: 'quiesce-nfs',
      type: 'nfs',
    });
  });

  test('revoking read-write from read-write users needs force', async () => {
    expect((await request('POST', 'rw-nfs', nfs)).status).toBe(201);
    mountWorkspace('ws-rw', 'rw-nfs', false);
    expect(
      (
        await app.request('/api/config/storage-sources').then((r) => r.json())
      ).sources.find((source: { id: string }) => source.id === 'rw-nfs'),
    ).toMatchObject({ usedBy: 1, readWriteUsedBy: 1 });

    const refused = await request('PUT', 'rw-nfs', {
      ...nfs,
      allowReadWrite: false,
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      code: 'STORAGE_SOURCE_READ_WRITE_IN_USE',
      readWriteUsedBy: 1,
    });
    expect(stopGroup).not.toHaveBeenCalled();

    const forced = await request('PUT', 'rw-nfs', {
      ...nfs,
      allowReadWrite: false,
      force: true,
    });
    expect(forced.status).toBe(200);
    expect(stopGroup).toHaveBeenCalledWith('web:ws-rw', expect.anything());
  });

  test('a runner that will not stop answers 503 and the retry finishes the job', async () => {
    expect((await request('POST', 'stuck-nfs', nfs)).status).toBe(201);
    mountWorkspace('ws-stuck', 'stuck-nfs', true);

    // Before the commit: nothing changes.
    stopGroup.mockRejectedValueOnce(new Error('busy'));
    const before = await request('DELETE', 'stuck-nfs');
    expect(before.status).toBe(503);
    expect(await before.json()).toMatchObject({
      persisted: false,
      retryable: true,
    });
    expect(
      (
        await app.request('/api/config/storage-sources').then((r) => r.json())
      ).sources.some((source: { id: string }) => source.id === 'stuck-nfs'),
    ).toBe(true);

    // After the commit: the source is gone and the workspace stays blocked.
    stopGroup
      .mockImplementationOnce(async () => {})
      .mockRejectedValueOnce(new Error('busy'));
    const after = await request('DELETE', 'stuck-nfs');
    expect(after.status).toBe(503);
    expect(await after.json()).toMatchObject({
      error: expect.stringContaining('改动已生效'),
      persisted: true,
      retryable: true,
    });
    expect(blockGroupsForRuntimeSafety).toHaveBeenCalledWith(
      ['web:ws-stuck'],
      expect.any(String),
      'storage_source:stuck-nfs',
    );

    const retry = await request('DELETE', 'stuck-nfs');
    expect(retry.status).toBe(200);
    expect(unblockGroupsForRuntimeSafety).toHaveBeenCalledWith(
      ['web:ws-stuck'],
      'storage_source:stuck-nfs',
    );
    // Once repaired, the id is simply gone.
    expect((await request('DELETE', 'stuck-nfs')).status).toBe(404);
  });
});
