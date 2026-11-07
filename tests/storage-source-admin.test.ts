import fs from 'node:fs';
import path from 'node:path';

import { beforeEach, describe, expect, test, vi } from 'vitest';

const TEST_ROOT = await vi.hoisted(async () => {
  const nodeFs = await import('node:fs');
  const nodeOs = await import('node:os');
  const nodePath = await import('node:path');
  return nodeFs.mkdtempSync(
    nodePath.join(nodeOs.tmpdir(), 'happyclaw-storage-admin-'),
  );
});
// The project's tracked config/ and its runtime data/ side by side.
const configDir = path.join(TEST_ROOT, 'config');
const dataDir = path.join(TEST_ROOT, 'data');
const allowlistPath = path.join(configDir, 'mount-allowlist.json');
const managedPath = path.join(dataDir, 'config', 'storage-sources.json');
const secretDir = path.join(dataDir, 'config', 'secrets');

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    DATA_DIR: `${TEST_ROOT}/data`,
    MOUNT_ALLOWLIST_PATH: `${TEST_ROOT}/config/mount-allowlist.json`,
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));
const groups = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('../src/db.js', () => ({
  getAllRegisteredGroups: () => groups.value,
}));

import {
  loadMountAllowlist,
  validateAdditionalMountsStrict,
} from '../src/mount-security.js';
import {
  deleteStorageSource,
  listStorageSources,
  listStorageSourceUsers,
  planStorageSourceSave,
  saveStorageSource,
  STORAGE_SECRET_DIR,
  withStorageSourceWriteLock,
} from '../src/storage-source-admin.js';
import { readPasswordFile } from '../src/storage-sources.js';

const smb = {
  type: 'cifs' as const,
  server: 'nas.lan',
  share: 'team',
  username: 'agent',
  allowReadWrite: false,
};
const nfs = {
  type: 'nfs' as const,
  server: 'nas.lan',
  exportPath: '/volume1/shared',
  allowReadWrite: true,
};
const fileSource = {
  id: 'nas-file',
  type: 'nfs',
  server: 'files.lan',
  exportPath: '/export',
  allowReadWrite: false,
};

function writeAllowlist(extra: Record<string, unknown> = {}): string {
  const content = `${JSON.stringify(
    {
      allowedRoots: [{ path: '/srv/data', allowReadWrite: false }],
      blockedPatterns: ['secret'],
      nonMainReadOnly: false,
      ...extra,
    },
    null,
    2,
  )}\n`;
  fs.writeFileSync(allowlistPath, content);
  return content;
}

function readManaged(): { storageSources: Array<Record<string, unknown>> } {
  return JSON.parse(fs.readFileSync(managedPath, 'utf8'));
}

function plan(
  id: string,
  input: Parameters<typeof planStorageSourceSave>[1],
  creating = false,
) {
  return withStorageSourceWriteLock(() =>
    planStorageSourceSave(id, input, creating),
  );
}

beforeEach(() => {
  fs.rmSync(configDir, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true });
  writeAllowlist();
  groups.value = {};
});

describe('storage source administration', () => {
  test('a Web save keeps the git worktree untouched and the password under data/', async () => {
    const before = writeAllowlist({ storageSources: [fileSource] });
    await saveStorageSource('nas-nfs', nfs, true);
    await saveStorageSource('nas-smb', { ...smb, password: 'hunter2' }, true);
    await saveStorageSource('nas-smb', { ...smb, description: 'x' }, false);

    expect(fs.readFileSync(allowlistPath, 'utf8')).toBe(before);
    expect(fs.readdirSync(configDir)).toEqual(['mount-allowlist.json']);
    expect(STORAGE_SECRET_DIR).toBe(secretDir);
    const secret = path.join(secretDir, 'storage-nas-smb');
    expect(fs.statSync(secret).mode & 0o777).toBe(0o600);
    expect(fs.statSync(secretDir).mode & 0o777).toBe(0o700);
    expect(readPasswordFile(secret)).toBe('hunter2');
    expect(fs.readFileSync(managedPath, 'utf8')).not.toContain('hunter2');
    expect(readManaged().storageSources.map((source) => source.id)).toEqual([
      'nas-nfs',
      'nas-smb',
    ]);
  });

  test('validation sees the allowlist file and Web sources merged', async () => {
    writeAllowlist({ storageSources: [fileSource] });
    await saveStorageSource('nas-nfs', nfs, true);
    expect(
      loadMountAllowlist()?.storageSources.map((source) => source.id),
    ).toEqual(['nas-file', 'nas-nfs']);
    const validated = validateAdditionalMountsStrict(
      [
        { source: 'nas-file', containerPath: 'file' },
        { source: 'nas-nfs', containerPath: 'web', readonly: false },
      ],
      'test',
      false,
    );
    expect(validated.map((mount) => mount.hostPath)).toEqual([
      'nfs://files.lan/export',
      'nfs://nas.lan/volume1/shared',
    ]);
    expect(
      listStorageSources().sources.map(({ id, origin }) => ({ id, origin })),
    ).toEqual([
      { id: 'nas-file', origin: 'allowlist' },
      { id: 'nas-nfs', origin: 'web' },
    ]);
  });

  test('Web sources apply without an allowlist file, read-only outside main', async () => {
    fs.rmSync(allowlistPath);
    expect(loadMountAllowlist()).toBeNull();
    await saveStorageSource('nas-nfs', nfs, true);
    const allowlist = loadMountAllowlist();
    expect(allowlist).toMatchObject({
      allowedRoots: [],
      nonMainReadOnly: true,
    });
    expect(allowlist?.blockedPatterns).toContain('.ssh');
    expect(() =>
      validateAdditionalMountsStrict(
        [{ source: 'nas-nfs', containerPath: 'web', readonly: false }],
        'test',
        false,
      ),
    ).toThrow('disabled for non-main');
    expect(fs.existsSync(allowlistPath)).toBe(false);
  });

  test('an id the allowlist file declares is read-only and cannot be shadowed', async () => {
    const before = writeAllowlist({ storageSources: [fileSource] });
    for (const creating of [true, false]) {
      await expect(
        saveStorageSource('nas-file', nfs, creating),
      ).rejects.toMatchObject({
        status: 409,
        code: 'STORAGE_SOURCE_READ_ONLY',
      });
    }
    await expect(deleteStorageSource('nas-file')).rejects.toMatchObject({
      status: 409,
      code: 'STORAGE_SOURCE_READ_ONLY',
    });
    expect(fs.existsSync(managedPath)).toBe(false);

    // A Web source that the file later declares too: the file wins.
    await saveStorageSource('nas-nfs', nfs, true);
    writeAllowlist({
      storageSources: [{ ...fileSource, id: 'nas-nfs', server: 'files.lan' }],
    });
    expect(loadMountAllowlist()?.storageSources).toEqual([
      expect.objectContaining({ id: 'nas-nfs', server: 'files.lan' }),
    ]);
    expect(fs.readFileSync(allowlistPath, 'utf8')).not.toBe(before);
  });

  test('refuses to write while the allowlist file is broken', async () => {
    fs.writeFileSync(allowlistPath, '{ not json');
    await expect(saveStorageSource('nas-nfs', nfs, true)).rejects.toMatchObject(
      { status: 409 },
    );
    expect(fs.existsSync(managedPath)).toBe(false);
    expect(listStorageSources()).toMatchObject({
      sources: [],
      allowlistError: expect.any(String),
    });
  });

  test('keeps an SMB password write-only and reports what happened to it', async () => {
    const view = await saveStorageSource(
      'nas-smb',
      { ...smb, password: 's3cret' },
      true,
    );
    expect(view.hasPassword).toBe(true);
    expect(JSON.stringify(view)).not.toContain('s3cret');
    expect(JSON.stringify(listStorageSources())).not.toContain('s3cret');

    expect(
      (await plan('nas-smb', { ...smb, description: 'x' })).passwordAction,
    ).toBe('kept');
    expect(
      (await plan('nas-smb', { ...smb, password: 'next' })).passwordAction,
    ).toBe('set');
    // An NFS request carrying a password stores nothing.
    expect(
      (await plan('nas-nfs', { ...nfs, password: 'x' } as never, true))
        .passwordAction,
    ).toBe('none');

    const secret = path.join(secretDir, 'storage-nas-smb');
    const cleared = await withStorageSourceWriteLock(() => {
      const next = planStorageSourceSave(
        'nas-smb',
        { ...smb, password: '' },
        false,
      );
      return { action: next.passwordAction, view: next.commit() };
    });
    expect(cleared).toMatchObject({
      action: 'removed',
      view: { hasPassword: false },
    });
    expect(fs.existsSync(secret)).toBe(false);
  });

  test('switching SMB to NFS removes the managed password file', async () => {
    await saveStorageSource('nas', { ...smb, password: 'pw' }, true);
    const secret = path.join(secretDir, 'storage-nas');
    expect(fs.existsSync(secret)).toBe(true);
    const next = await plan('nas', { ...nfs, allowReadWrite: false });
    expect(next.passwordAction).toBe('removed');
    await withStorageSourceWriteLock(() => next.commit());
    expect(fs.existsSync(secret)).toBe(false);
    expect(readManaged().storageSources[0]).not.toHaveProperty('passwordFile');
  });

  test('clearing the username turns it into a guest share without a password', async () => {
    await saveStorageSource('nas', { ...smb, password: 'pw' }, true);
    const next = await plan('nas', { ...smb, username: undefined });
    expect(next.passwordAction).toBe('removed');
    await withStorageSourceWriteLock(() => next.commit());
    expect(fs.existsSync(path.join(secretDir, 'storage-nas'))).toBe(false);
    expect(listStorageSources().sources[0]).toMatchObject({
      hasPassword: false,
    });
  });

  test('a hand-written passwordFile elsewhere is never deleted', async () => {
    const custom = path.join(TEST_ROOT, 'custom-secret');
    fs.writeFileSync(custom, 'pw\n', { mode: 0o600 });
    fs.writeFileSync(
      managedPath,
      JSON.stringify({
        storageSources: [
          {
            id: 'nas',
            ...smb,
            passwordFile: custom,
          },
        ],
      }),
    );
    // Kept while the source still has a username and no new password.
    await saveStorageSource('nas', { ...smb, description: 'x' }, false);
    expect(readManaged().storageSources[0].passwordFile).toBe(custom);

    const next = await plan('nas', { ...nfs, allowReadWrite: false });
    expect(next.passwordAction).toBe('removed');
    await withStorageSourceWriteLock(() => next.commit());
    expect(fs.readFileSync(custom, 'utf8')).toBe('pw\n');
  });

  test('rejects invalid input without touching anything', async () => {
    await expect(
      saveStorageSource('bad', { ...smb, share: 'a/b' }, true),
    ).rejects.toThrow();
    await expect(
      saveStorageSource('bad', { ...smb, password: 'a,b' }, true),
    ).rejects.toThrow('逗号');
    await expect(
      saveStorageSource(
        'bad',
        { ...smb, username: undefined, password: 'x' },
        true,
      ),
    ).rejects.toThrow('用户名');
    await expect(saveStorageSource('gone', smb, false)).rejects.toMatchObject({
      status: 404,
    });
    expect(fs.existsSync(managedPath)).toBe(false);
    expect(fs.existsSync(secretDir)).toBe(false);

    await saveStorageSource('dup', smb, true);
    await expect(saveStorageSource('dup', smb, true)).rejects.toMatchObject({
      status: 409,
    });
  });

  test('counts read-write and read-only users per workspace and deletes with the secret', async () => {
    await saveStorageSource('nas-smb', { ...smb, password: 'pw' }, true);
    groups.value = {
      'web:a': {
        folder: 'a',
        containerConfig: {
          additionalMounts: [
            { source: 'nas-smb', containerPath: 'a', readonly: true },
            {
              source: 'nas-smb',
              subPath: 'x',
              containerPath: 'b',
              readonly: false,
            },
          ],
        },
      },
      'web:b': {
        folder: 'b',
        containerConfig: {
          additionalMounts: [{ source: 'nas-smb', containerPath: 'a' }],
        },
      },
      'web:c': { folder: 'c', containerConfig: { additionalMounts: [] } },
    };
    expect(listStorageSources().sources[0]).toMatchObject({
      usedBy: 2,
      readWriteUsedBy: 1,
    });
    expect(listStorageSourceUsers('nas-smb')).toEqual([
      { jid: 'web:a', folder: 'a', readWrite: true },
      { jid: 'web:b', folder: 'b', readWrite: false },
    ]);

    const deleted = await deleteStorageSource('nas-smb');
    expect(deleted.type).toBe('cifs');
    expect(readManaged().storageSources).toEqual([]);
    expect(fs.existsSync(path.join(secretDir, 'storage-nas-smb'))).toBe(false);
    await expect(deleteStorageSource('nas-smb')).rejects.toMatchObject({
      status: 404,
    });
  });

  test('tells mount-affecting changes from description edits', async () => {
    await saveStorageSource('nas', nfs, true);
    groups.value = {
      'web:a': {
        folder: 'a',
        containerConfig: {
          additionalMounts: [
            { source: 'nas', containerPath: 'a', readonly: false },
          ],
        },
      },
    };
    expect(await plan('nas', { ...nfs, description: 'x' })).toMatchObject({
      changesMounts: false,
      revokedReadWriteUsers: 0,
    });
    expect(await plan('nas', { ...nfs, server: 'other.lan' })).toMatchObject({
      changesMounts: true,
      revokedReadWriteUsers: 0,
    });
    expect(await plan('nas', { ...nfs, allowReadWrite: false })).toMatchObject({
      changesMounts: true,
      revokedReadWriteUsers: 1,
    });
    await saveStorageSource('nas', { ...nfs, allowReadWrite: false }, false);
    // Allowing writes again leaves running read-only mounts as they are.
    expect(await plan('nas', nfs)).toMatchObject({ changesMounts: false });
  });
});
