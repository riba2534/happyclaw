import fs from 'node:fs';
import os from 'node:os';
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
const allowlistPath = path.join(TEST_ROOT, 'config', 'mount-allowlist.json');

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
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
  deleteStorageSource,
  listStorageSources,
  saveStorageSource,
  STORAGE_SECRET_DIR,
} from '../src/storage-source-admin.js';
import { readPasswordFile } from '../src/storage-sources.js';

const smb = {
  type: 'cifs' as const,
  server: 'nas.lan',
  share: 'team',
  username: 'agent',
  allowReadWrite: false,
};

function readDocument(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(allowlistPath, 'utf8'));
}

beforeEach(() => {
  fs.rmSync(path.join(TEST_ROOT, 'config'), { recursive: true, force: true });
  fs.mkdirSync(path.dirname(allowlistPath), { recursive: true });
  fs.writeFileSync(
    allowlistPath,
    JSON.stringify({
      allowedRoots: [{ path: '/srv/data', allowReadWrite: false }],
      blockedPatterns: ['secret'],
      nonMainReadOnly: true,
    }),
  );
  groups.value = {};
});

describe('storage source administration', () => {
  test('adds a source and keeps the rest of the allowlist', async () => {
    const view = await saveStorageSource(
      'nas-nfs',
      {
        type: 'nfs',
        server: 'nas.lan',
        exportPath: '/volume1/shared/',
        allowReadWrite: true,
      },
      true,
    );
    expect(view).toMatchObject({
      id: 'nas-nfs',
      exportPath: '/volume1/shared',
      hasPassword: false,
      usedBy: 0,
    });
    const document = readDocument();
    expect(document.allowedRoots).toEqual([
      { path: '/srv/data', allowReadWrite: false },
    ]);
    expect(document.blockedPatterns).toEqual(['secret']);
    expect(listStorageSources().sources.map((source) => source.id)).toEqual([
      'nas-nfs',
    ]);
  });

  test('keeps an SMB password write-only in a 0600 file', async () => {
    const view = await saveStorageSource(
      'nas-smb',
      { ...smb, password: 's3cret' },
      true,
    );
    expect(view.hasPassword).toBe(true);
    expect(JSON.stringify(view)).not.toContain('s3cret');
    expect(JSON.stringify(readDocument())).not.toContain('s3cret');
    expect(JSON.stringify(listStorageSources())).not.toContain('s3cret');

    const secret = path.join(STORAGE_SECRET_DIR, 'storage-nas-smb');
    expect(fs.statSync(secret).mode & 0o777).toBe(0o600);
    expect(readPasswordFile(secret)).toBe('s3cret');

    // Omitting the password keeps it; '' removes it.
    expect(
      (await saveStorageSource('nas-smb', { ...smb, description: 'x' }, false))
        .hasPassword,
    ).toBe(true);
    expect(
      (await saveStorageSource('nas-smb', { ...smb, password: '' }, false))
        .hasPassword,
    ).toBe(false);
    expect(fs.existsSync(secret)).toBe(false);
  });

  test('rejects invalid input without touching the file', async () => {
    const before = fs.readFileSync(allowlistPath, 'utf8');
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
    expect(fs.readFileSync(allowlistPath, 'utf8')).toBe(before);
    expect(fs.existsSync(STORAGE_SECRET_DIR)).toBe(false);

    await saveStorageSource('dup', smb, true);
    await expect(saveStorageSource('dup', smb, true)).rejects.toMatchObject({
      status: 409,
    });
  });

  test('counts workspaces using a source and deletes it with its secret', async () => {
    await saveStorageSource('nas-smb', { ...smb, password: 'pw' }, true);
    groups.value = {
      a: {
        containerConfig: {
          additionalMounts: [
            { source: 'nas-smb', containerPath: 'a' },
            { source: 'nas-smb', subPath: 'x', containerPath: 'b' },
          ],
        },
      },
      b: { containerConfig: { additionalMounts: [] } },
    };
    expect(listStorageSources().sources[0].usedBy).toBe(1);

    await deleteStorageSource('nas-smb');
    expect(readDocument().storageSources).toEqual([]);
    expect(
      fs.existsSync(path.join(STORAGE_SECRET_DIR, 'storage-nas-smb')),
    ).toBe(false);
    await expect(deleteStorageSource('nas-smb')).rejects.toMatchObject({
      status: 404,
    });
  });
});
