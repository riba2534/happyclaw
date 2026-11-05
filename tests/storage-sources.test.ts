import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test, vi } from 'vitest';

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

import {
  parseBsdMountTable,
  parseLinuxMountInfo,
  parseNfsSource,
  resolveNfsVolumeSource,
  resolveNfsVolumeSources,
} from '../src/host-nfs-mounts.js';
import {
  cifsDriverOptions,
  normalizeStorageSubPath,
  parseStorageSources,
  readPasswordFile,
  resolveStorageSourceMount,
  type ResolvedStorage,
} from '../src/storage-sources.js';
import {
  ensureCifsVolume,
  STORAGE_VOLUME_LABEL,
  storageMountArg,
  type EngineRequest,
} from '../src/storage-volumes.js';
import type { MountAllowlist } from '../src/types.js';

const nfsSource = {
  id: 'nas-nfs',
  type: 'nfs',
  server: 'nas.lan',
  exportPath: '/volume1/shared/',
  allowReadWrite: true,
};
const smbSource = {
  id: 'nas-smb',
  type: 'cifs',
  server: '192.0.2.5',
  share: 'team',
  username: 'agent',
  passwordFile: '/run/secret',
  allowReadWrite: false,
};

function allowlist(nonMainReadOnly = false): MountAllowlist {
  return {
    allowedRoots: [],
    blockedPatterns: [],
    nonMainReadOnly,
    storageSources: parseStorageSources([nfsSource, smbSource]),
  };
}

type CifsStorage = Extract<ResolvedStorage, { type: 'cifs' }>;

function cifsStorage(overrides: Partial<CifsStorage> = {}): CifsStorage {
  return {
    type: 'cifs',
    sourceId: 'nas-smb',
    server: '192.0.2.5',
    device: '//192.0.2.5/team/sub',
    username: 'agent',
    passwordFile: '/run/secret',
    smbVersion: '3.0',
    ...overrides,
  };
}

describe('storage source allowlist', () => {
  test('normalizes NFS and SMB sources', () => {
    expect(parseStorageSources(undefined)).toEqual([]);
    expect(parseStorageSources([nfsSource, smbSource])).toEqual([
      { ...nfsSource, exportPath: '/volume1/shared', description: undefined },
      { ...smbSource, description: undefined },
    ]);
  });

  test.each([
    ['not an array', {}],
    ['unknown type', [{ ...nfsSource, type: 'webdav' }]],
    ['unknown field', [{ ...nfsSource, share: 'x' }]],
    ['bad id', [{ ...nfsSource, id: 'Nas NFS' }]],
    ['option injection in server', [{ ...nfsSource, server: 'nas,ro' }]],
    ['relative export', [{ ...nfsSource, exportPath: 'volume1' }]],
    ['traversal export', [{ ...nfsSource, exportPath: '/a/../etc' }]],
    ['bad NFS version', [{ ...nfsSource, nfsVersion: '2' }]],
    ['share with a slash', [{ ...smbSource, share: 'a/b' }]],
    ['username with a comma', [{ ...smbSource, username: 'a,password=x' }]],
    ['password file without user', [{ ...smbSource, username: undefined }]],
    ['bad SMB version', [{ ...smbSource, smbVersion: '1.0' }]],
    ['duplicate id', [nfsSource, { ...smbSource, id: 'nas-nfs' }]],
    ['missing allowReadWrite', [{ ...nfsSource, allowReadWrite: undefined }]],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseStorageSources(raw)).toThrow();
  });

  test('sub paths stay inside the source', () => {
    expect(normalizeStorageSubPath(undefined)).toBe('');
    expect(normalizeStorageSubPath('a/b/')).toBe('a/b');
    for (const bad of ['/a', 'a/../b', '..', 'a//b', ' a', 'a\\b', 'a\nb']) {
      expect(() => normalizeStorageSubPath(bad)).toThrow();
    }
  });
});

describe('resolveStorageSourceMount', () => {
  test('maps a sub path onto the export or share', () => {
    expect(
      resolveStorageSourceMount(
        {
          source: 'nas-nfs',
          subPath: 'p/alpha',
          containerPath: 'a',
          readonly: false,
        },
        allowlist(),
        false,
      ),
    ).toMatchObject({
      allowed: true,
      effectiveReadonly: false,
      storage: {
        type: 'nfs',
        server: 'nas.lan',
        device: '/volume1/shared/p/alpha',
        options: 'nfsvers=3,proto=tcp,hard,nolock',
      },
    });
    expect(
      resolveStorageSourceMount(
        { source: 'nas-smb', containerPath: 'team', readonly: true },
        allowlist(),
        false,
      ).storage,
    ).toEqual({
      type: 'cifs',
      sourceId: 'nas-smb',
      server: '192.0.2.5',
      device: '//192.0.2.5/team',
      username: 'agent',
      passwordFile: '/run/secret',
      smbVersion: '3.0',
    });
  });

  test('refuses unknown sources and write access the policy withholds', () => {
    const list = allowlist(true);
    expect(
      resolveStorageSourceMount(
        { source: 'gone', containerPath: 'x' },
        list,
        true,
      ).allowed,
    ).toBe(false);
    expect(
      resolveStorageSourceMount(
        { source: 'nas-smb', containerPath: 'x', readonly: false },
        list,
        true,
      ).reason,
    ).toContain('does not permit read-write');
    expect(
      resolveStorageSourceMount(
        { source: 'nas-nfs', containerPath: 'x', readonly: false },
        list,
        false,
      ).reason,
    ).toContain('non-main');
    expect(
      resolveStorageSourceMount(
        { source: 'nas-nfs', subPath: '../etc', containerPath: 'x' },
        list,
        true,
      ).allowed,
    ).toBe(false);
  });
});

describe('SMB credentials', () => {
  function secretFile(content: string, mode: number): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-smb-'));
    const file = path.join(dir, 'secret');
    fs.writeFileSync(file, content, { mode });
    fs.chmodSync(file, mode);
    return file;
  }

  test('reads a single-line 0600 password file', () => {
    expect(readPasswordFile(secretFile('s3cret=!\n', 0o600))).toBe('s3cret=!');
  });

  test.each([
    ['readable by others', 's3cret\n', 0o644, 'chmod 600'],
    ['several lines', 'a\nb\n', 0o600, 'single line'],
    ['a comma', 'a,b\n', 0o600, 'comma'],
  ])('rejects a file %s', (_label, content, mode, message) => {
    expect(() => readPasswordFile(secretFile(content, mode))).toThrow(message);
  });

  test('does not follow a symlinked password file', () => {
    const target = secretFile('s3cret\n', 0o600);
    const link = `${target}-link`;
    fs.symlinkSync(target, link);
    expect(() => readPasswordFile(link)).toThrow();
  });

  test('builds driver options for an account or a guest', () => {
    expect(cifsDriverOptions(cifsStorage({ domain: 'CORP' }), 'pw')).toEqual({
      type: 'cifs',
      device: '//192.0.2.5/team/sub',
      o: 'addr=192.0.2.5,username=agent,password=pw,domain=CORP,vers=3.0,file_mode=0777,dir_mode=0777',
    });
    expect(
      cifsDriverOptions(
        cifsStorage({ username: undefined, passwordFile: undefined }),
        undefined,
      ).o,
    ).toBe('addr=192.0.2.5,guest,vers=3.0,file_mode=0777,dir_mode=0777');
  });
});

describe('host NFS mount detection', () => {
  test('parses macOS and Linux mount tables', () => {
    expect(
      parseBsdMountTable(
        [
          '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
          'nas.lan:/volume1/shared on /Users/me/nas ssd (nfs, nodev, nosuid, mounted by me)',
          'OrbStack:/OrbStack on /Users/me/OrbStack (nfs, nodev, nosuid, noatime, mounted by me)',
          '//me@nas.lan/team on /Volumes/team (smbfs, nodev, nosuid, mounted by me)',
        ].join('\n'),
      ),
    ).toEqual([
      {
        server: 'nas.lan',
        exportPath: '/volume1/shared',
        mountPoint: '/Users/me/nas ssd',
      },
      {
        server: 'OrbStack',
        exportPath: '/OrbStack',
        mountPoint: '/Users/me/OrbStack',
      },
    ]);
    expect(
      parseLinuxMountInfo(
        [
          '29 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw',
          '40 29 0:50 / /mnt/nas\\040data rw,relatime shared:20 - nfs4 [2001:db8::5]:/export rw,vers=4.2',
        ].join('\n'),
      ),
    ).toEqual([
      {
        server: '2001:db8::5',
        exportPath: '/export',
        mountPoint: '/mnt/nas data',
      },
    ]);
    expect(parseNfsSource('no-export')).toBeNull();
  });

  test('picks the innermost mount and appends the path below it', () => {
    const mounts = [
      { server: 'a', exportPath: '/outer', mountPoint: '/mnt' },
      { server: 'b', exportPath: '/inner', mountPoint: '/mnt/deep' },
    ];
    expect(resolveNfsVolumeSource('/mnt/deep/x/y', mounts)).toEqual({
      server: 'b',
      device: '/inner/x/y',
    });
    expect(resolveNfsVolumeSource('/mnt', mounts)).toEqual({
      server: 'a',
      device: '/outer',
    });
    expect(resolveNfsVolumeSource('/mntx', mounts)).toBeNull();
  });

  test('keeps every path a bind when the mount table cannot be read', () => {
    expect(
      resolveNfsVolumeSources(['/a', '/b'], () => {
        throw new Error('no mount table');
      }),
    ).toEqual([null, null]);
  });
});

describe('docker storage mounts', () => {
  test('spells an NFS volume out in --mount with CSV quoting', () => {
    expect(
      storageMountArg(
        {
          type: 'nfs',
          server: 'nas.lan',
          device: '/export/a,b',
          options: 'nfsvers=3,proto=tcp,hard,nolock',
        },
        '/workspace/extra/nas',
        true,
      ),
    ).toBe(
      'type=volume,dst=/workspace/extra/nas,readonly,volume-driver=local,volume-opt=type=nfs,"volume-opt=device=:/export/a,b","volume-opt=o=addr=nas.lan,nfsvers=3,proto=tcp,hard,nolock"',
    );
    expect(
      storageMountArg(
        { type: 'named', name: 'v1' },
        '/workspace/extra/s',
        false,
      ),
    ).toBe('type=volume,src=v1,dst=/workspace/extra/s');
    expect(() =>
      storageMountArg(cifsStorage(), '/workspace/extra/s', false),
    ).toThrow('named volume');
  });

  function fakeEngine(existing: { status: number; options?: unknown }) {
    const calls: Array<{ method: string; path: string; body?: unknown }> = [];
    const request: EngineRequest = async (method, requestPath, body) => {
      calls.push({ method, path: requestPath, body });
      if (method === 'GET') {
        return {
          status: existing.status,
          body: JSON.stringify({ Options: existing.options }),
        };
      }
      if (method === 'DELETE')
        return { status: existing.status === 409 ? 409 : 204, body: '' };
      return { status: 201, body: '{}' };
    };
    return { calls, request };
  }

  test('creates the SMB volume through the Engine API with the password in the body only', async () => {
    const { calls, request } = fakeEngine({ status: 404 });
    const name = await ensureCifsVolume(cifsStorage(), request, () => 'pw');
    expect(name).toMatch(/^happyclaw-storage-nas-smb-[0-9a-f]{16}$/);
    expect(name).not.toContain('pw');
    expect(calls.map((call) => call.method)).toEqual(['GET', 'POST']);
    expect(calls[1].body).toEqual({
      Name: name,
      Driver: 'local',
      DriverOpts: cifsDriverOptions(cifsStorage(), 'pw'),
      Labels: { [STORAGE_VOLUME_LABEL]: 'nas-smb' },
    });
  });

  test('reuses a matching volume and replaces one with an old password', async () => {
    const current = cifsDriverOptions(cifsStorage(), 'pw');
    const same = fakeEngine({ status: 200, options: current });
    await ensureCifsVolume(cifsStorage(), same.request, () => 'pw');
    expect(same.calls.map((call) => call.method)).toEqual(['GET']);

    const stale = fakeEngine({
      status: 200,
      options: cifsDriverOptions(cifsStorage(), 'old'),
    });
    const name = await ensureCifsVolume(
      cifsStorage(),
      stale.request,
      () => 'pw',
    );
    expect(stale.calls.map((call) => call.method)).toEqual([
      'GET',
      'DELETE',
      'POST',
    ]);
    expect(name).toBe(
      await ensureCifsVolume(
        cifsStorage(),
        fakeEngine({ status: 404 }).request,
        () => 'pw',
      ),
    );
  });

  test('keeps an in-use volume until its container exits', async () => {
    const inUse = fakeEngine({
      status: 200,
      options: cifsDriverOptions(cifsStorage(), 'old'),
    });
    // The fake answers DELETE with 409 only when GET did; emulate in-use.
    const request: EngineRequest = async (method, requestPath, body) =>
      method === 'DELETE'
        ? { status: 409, body: '{"message":"volume is in use"}' }
        : inUse.request(method, requestPath, body);
    await ensureCifsVolume(cifsStorage(), request, () => 'pw');
    expect(inUse.calls.map((call) => call.method)).toEqual(['GET']);
  });
});
