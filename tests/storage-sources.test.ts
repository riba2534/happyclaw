import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, test, vi } from 'vitest';

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

import {
  parseBsdMountTable,
  parseDarwinNfsStat,
  parseLinuxMountInfo,
  parseNfsSource,
  resolveNfsDirectMount,
  resolveNfsDirectMounts,
} from '../src/host-nfs-mounts.js';
import {
  cifsDriverOptions,
  nfsMountOptions,
  normalizeStorageSubPath,
  parseStorageSources,
  readPasswordFile,
  resolveStorageSourceMount,
  type ResolvedStorage,
} from '../src/storage-sources.js';
import {
  cifsVolumeName,
  createEngineRequest,
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

describe('NFS storage source options', () => {
  test('locks locally on NFSv3 only; NFSv4 locks through the protocol', () => {
    expect(nfsMountOptions(undefined)).toBe('nfsvers=3,proto=tcp,hard,nolock');
    expect(nfsMountOptions('3')).toBe('nfsvers=3,proto=tcp,hard,nolock');
    expect(nfsMountOptions('4.1')).toBe('nfsvers=4.1,proto=tcp,hard');
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

function mountInfo(...lines: string[]) {
  return { mounts: parseLinuxMountInfo(lines.join('\n')) };
}

const NFS3_OPTIONS =
  'rw,vers=3,rsize=1048576,wsize=1048576,hard,proto=tcp,sec=sys,mountaddr=192.0.2.10,mountvers=3,local_lock=none,addr=192.0.2.10';

describe('host NFS mount detection', () => {
  test('parses every entry of the macOS and Linux mount tables', () => {
    expect(
      parseBsdMountTable(
        [
          '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
          'nas.lan:/volume1/shared on /Users/me/nas ssd (nfs, nodev, nosuid, mounted by me)',
          '//me@nas.lan/team on /Volumes/team (smbfs, nodev, nosuid, mounted by me)',
          'map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)',
        ].join('\n'),
      ),
    ).toEqual([
      {
        fstype: 'apfs',
        source: '/dev/disk3s1s1',
        mountPoint: '/',
        root: '/',
        options: null,
      },
      {
        fstype: 'nfs',
        source: 'nas.lan:/volume1/shared',
        mountPoint: '/Users/me/nas ssd',
        root: '/',
        options: null,
      },
      {
        fstype: 'smbfs',
        source: '//me@nas.lan/team',
        mountPoint: '/Volumes/team',
        root: '/',
        options: null,
      },
      {
        fstype: 'autofs',
        source: 'map auto_home',
        mountPoint: '/System/Volumes/Data/home',
        root: '/',
        options: null,
      },
    ]);
    expect(
      parseLinuxMountInfo(
        [
          '29 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw',
          '40 29 0:50 / /mnt/nas\\040data rw,relatime shared:20 - nfs4 [2001:db8::5]:/export rw,vers=4.2,sec=sys',
          '41 29 0:50 /team /srv/team rw,relatime - nfs nas:/export rw,vers=3',
        ].join('\n'),
      ),
    ).toEqual([
      {
        fstype: 'ext4',
        source: '/dev/sda1',
        mountPoint: '/',
        root: '/',
        options: ['rw'],
      },
      {
        fstype: 'nfs4',
        source: '[2001:db8::5]:/export',
        mountPoint: '/mnt/nas data',
        root: '/',
        options: ['rw', 'vers=4.2', 'sec=sys'],
      },
      {
        fstype: 'nfs',
        source: 'nas:/export',
        mountPoint: '/srv/team',
        root: '/team',
        options: ['rw', 'vers=3'],
      },
    ]);
    expect(parseNfsSource('no-export')).toBeNull();
  });

  test('reads negotiated parameters from macOS nfsstat -m', () => {
    const parameters = parseDarwinNfsStat(
      [
        '/Users/me/nas ssd from nas.lan:/volume1/shared',
        '  -- Original mount options:',
        '     General mount flags: 0x0',
        '     NFS parameters: vers=4,soft',
        '     File system locations:',
        '       /volume1/shared @ nas.lan (192.0.2.10)',
        '  -- Current mount parameters:',
        '     General mount flags: 0x4000018 nodev,nosuid,multilabel',
        '     NFS parameters: vers=4.0,tcp,port=2049,hard,sec=sys',
        '     File system locations:',
        '       /volume1/shared @ nas.lan (192.0.2.10)',
        '     Status flags: 0x0',
        '/Volumes/v3 from nas.lan:/volume1/v3',
        '  -- Original mount options:',
        '     NFS parameters: vers=3,tcp',
      ].join('\n'),
    );
    expect(parameters.get('/Users/me/nas ssd')).toEqual([
      'vers=4.0',
      'tcp',
      'port=2049',
      'hard',
      'sec=sys',
    ]);
    expect(parameters.get('/Volumes/v3')).toEqual(['vers=3', 'tcp']);
  });

  test('keeps an NFSv3 mount on v3 and locks the way the host mount does', () => {
    const line = (options: string) =>
      `40 29 0:50 / /mnt/nas rw,relatime - nfs nas:/export ${options}`;
    expect(
      resolveNfsDirectMount(
        '/mnt/nas/team/proj',
        mountInfo(line(NFS3_OPTIONS)),
        'linux',
      ),
    ).toEqual({
      kind: 'nfs',
      source: {
        server: 'nas',
        device: '/export/team/proj',
        options: 'nfsvers=3,proto=tcp,hard',
      },
    });
    expect(
      resolveNfsDirectMount(
        '/mnt/nas/proj',
        mountInfo(
          line(
            `${NFS3_OPTIONS.replace('local_lock=none', 'nolock,local_lock=all')}`,
          ),
        ),
        'linux',
      ),
    ).toMatchObject({
      source: { options: 'nfsvers=3,proto=tcp,hard,nolock' },
    });
    // The daemon's VM on macOS runs no rpc.statd.
    expect(
      resolveNfsDirectMount(
        '/Volumes/nas/proj',
        {
          mounts: parseBsdMountTable(
            'nas.lan:/volume1 on /Volumes/nas (nfs, nodev, nosuid, mounted by me)',
          ),
          nfsParameters: () => ['vers=3', 'tcp', 'hard'],
        },
        'darwin',
      ),
    ).toEqual({
      kind: 'nfs',
      source: {
        server: 'nas.lan',
        device: '/volume1/proj',
        options: 'nfsvers=3,proto=tcp,hard,nolock',
      },
    });
  });

  test('keeps an NFSv4 mount on v4 with its own (pseudo-root) path', () => {
    expect(
      resolveNfsDirectMount(
        '/mnt/v4/proj',
        mountInfo(
          '40 29 0:50 / /mnt/v4 rw,relatime - nfs4 srv:/data rw,vers=4.2,hard,proto=tcp,sec=sys,clientaddr=192.0.2.2,local_lock=none,addr=192.0.2.10',
        ),
        'linux',
      ),
    ).toEqual({
      kind: 'nfs',
      source: {
        server: 'srv',
        device: '/data/proj',
        options: 'nfsvers=4.2,proto=tcp,hard',
      },
    });
    expect(
      resolveNfsDirectMount(
        '/Volumes/nas/proj',
        {
          mounts: parseBsdMountTable(
            'nas.lan:/shared on /Volumes/nas (nfs, nodev, nosuid, mounted by me)',
          ),
          nfsParameters: () => ['vers=4.0', 'tcp'],
        },
        'darwin',
      ),
    ).toMatchObject({ source: { options: 'nfsvers=4.0,proto=tcp,hard' } });
  });

  test.each([
    [
      'Kerberos',
      '40 29 0:50 / /mnt/nas rw - nfs4 nas:/export rw,vers=4.1,sec=krb5p',
      'sec=krb5p',
    ],
    [
      'NFSv2',
      '40 29 0:50 / /mnt/nas rw - nfs nas:/export rw,vers=2',
      'version 2',
    ],
    [
      'no version',
      '40 29 0:50 / /mnt/nas rw - nfs nas:/export rw,hard',
      'not listed',
    ],
    ['no server', '40 29 0:50 / /mnt/nas rw - nfs /dev/x rw,vers=3', 'source'],
  ])(
    'refuses a direct mount it cannot reproduce: %s',
    (_label, line, message) => {
      const result = resolveNfsDirectMount(
        '/mnt/nas/p',
        mountInfo(line),
        'linux',
      );
      expect(result.kind).toBe('error');
      expect(result.kind === 'error' && result.reason).toContain(message);
    },
  );

  test('a mount nested inside NFS holds the path, not the NFS share below it', () => {
    const nfs = `40 29 0:50 / /mnt/nas rw - nfs nas:/export ${NFS3_OPTIONS}`;
    for (const nested of [
      '41 40 8:17 / /mnt/nas/local rw - ext4 /dev/sdb1 rw',
      '41 40 0:60 / /mnt/nas/local rw - tmpfs tmpfs rw',
      '41 40 0:61 / /mnt/nas/local rw - cifs //nas/share rw,vers=3.0',
    ]) {
      expect(
        resolveNfsDirectMount(
          '/mnt/nas/local/proj',
          mountInfo(nfs, nested),
          'linux',
        ),
      ).toEqual({ kind: 'bind' });
    }
    expect(
      resolveNfsDirectMount(
        '/Volumes/nas/inner/p',
        {
          mounts: parseBsdMountTable(
            [
              'nas:/volume1/share on /Volumes/nas (nfs, nodev, nosuid, mounted by me)',
              '//me@nas/inner on /Volumes/nas/inner (smbfs, nodev, nosuid, mounted by me)',
            ].join('\n'),
          ),
          nfsParameters: () => ['vers=3'],
        },
        'darwin',
      ),
    ).toEqual({ kind: 'bind' });
    // NFS mounted below a local directory is still found.
    expect(
      resolveNfsDirectMount(
        '/mnt/nas/deep/x',
        mountInfo(
          '29 1 8:1 / / rw - ext4 /dev/sda1 rw',
          nfs,
          `42 40 0:52 / /mnt/nas/deep rw - nfs other:/inner ${NFS3_OPTIONS}`,
        ),
        'linux',
      ),
    ).toMatchObject({ source: { server: 'other', device: '/inner/x' } });
    // The mount point itself is the export.
    expect(
      resolveNfsDirectMount('/mnt/nas', mountInfo(nfs), 'linux'),
    ).toMatchObject({ source: { device: '/export' } });
    expect(
      resolveNfsDirectMount(
        '/mnt/nasx',
        mountInfo('29 1 8:1 / / rw - ext4 /dev/sda1 rw', nfs),
        'linux',
      ),
    ).toEqual({ kind: 'bind' });
  });

  test('the last mount on a mount point covers the ones before it', () => {
    expect(
      resolveNfsDirectMount(
        '/mnt/nas/x',
        mountInfo(
          `40 29 0:50 / /mnt/nas rw - nfs old:/exportA ${NFS3_OPTIONS}`,
          `41 40 0:51 / /mnt/nas rw - nfs new:/exportB ${NFS3_OPTIONS}`,
        ),
        'linux',
      ),
    ).toMatchObject({ source: { server: 'new', device: '/exportB/x' } });
    expect(
      resolveNfsDirectMount(
        '/mnt/nas/x',
        mountInfo(
          `40 29 0:50 / /mnt/nas rw - nfs old:/exportA ${NFS3_OPTIONS}`,
          '41 40 0:60 / /mnt/nas rw - tmpfs tmpfs rw',
        ),
        'linux',
      ),
    ).toEqual({ kind: 'bind' });
  });

  test('a bind of an NFS subdirectory maps to that subdirectory', () => {
    // mountinfo field 4 carries the directory of the filesystem a bind shows.
    expect(
      resolveNfsDirectMount(
        '/srv/team/proj',
        mountInfo(
          `41 29 0:50 /team /srv/team rw - nfs nas:/export ${NFS3_OPTIONS}`,
        ),
        'linux',
      ),
    ).toMatchObject({ source: { device: '/export/team/proj' } });
    // Linux's NFS client reports root "/" and folds the directory into the
    // source instead; both forms resolve to the same export directory.
    expect(
      resolveNfsDirectMount(
        '/srv/team/proj',
        mountInfo(
          `41 29 0:50 / /srv/team rw - nfs nas:/export/team ${NFS3_OPTIONS}`,
        ),
        'linux',
      ),
    ).toMatchObject({ source: { device: '/export/team/proj' } });
  });

  test('matches macOS mount points through firmlink and /private aliases', () => {
    const table = {
      mounts: parseBsdMountTable(
        [
          'nas:/a on /System/Volumes/Data/Users/me/NAS (nfs, nodev, mounted by me)',
          'nas:/b on /private/tmp/share (nfs, nodev, mounted by me)',
        ].join('\n'),
      ),
      nfsParameters: () => ['vers=3'],
    };
    expect(
      resolveNfsDirectMount('/Users/me/nas/Proj', table, 'darwin'),
    ).toMatchObject({ source: { device: '/a/Proj' } });
    expect(
      resolveNfsDirectMount('/private/tmp/share/x', table, 'darwin'),
    ).toMatchObject({ source: { device: '/b/x' } });
    expect(resolveNfsDirectMount('/Users/me/nas/Proj', table, 'linux')).toEqual(
      { kind: 'bind' },
    );
  });

  test('never looks up a mount point on the filesystem', () => {
    // A hard NFS mount whose server is gone blocks any stat of it in the
    // kernel; the mount table must be matched against the path literally.
    const spies = (
      [
        'realpathSync',
        'statSync',
        'lstatSync',
        'existsSync',
        'accessSync',
      ] as const
    ).map((name) => vi.spyOn(fs, name));
    const realpathNative = vi.spyOn(fs.realpathSync, 'native');
    try {
      const results = resolveNfsDirectMounts(
        ['/home/u/work/proj', '/mnt/nas/proj'],
        () =>
          mountInfo(
            '29 1 8:1 / / rw - ext4 /dev/sda1 rw',
            `40 29 0:50 / /mnt/backup rw - nfs backup-nas:/backup ${NFS3_OPTIONS}`,
            `41 29 0:51 / /srv/other rw - nfs4 other:/x rw,vers=4.2`,
            `42 29 0:52 / /mnt/nas rw - nfs nas:/export ${NFS3_OPTIONS}`,
          ),
        'linux',
      );
      expect(results.map((result) => result.kind)).toEqual(['bind', 'nfs']);
      for (const spy of [...spies, realpathNative]) {
        expect(spy).not.toHaveBeenCalled();
      }
    } finally {
      for (const spy of [...spies, realpathNative]) spy.mockRestore();
    }
  });

  test('fails every path when the mount table cannot be read', () => {
    expect(
      resolveNfsDirectMounts(['/a', '/b'], () => {
        throw new Error('no mount table');
      }),
    ).toEqual([
      {
        kind: 'error',
        reason: 'could not read the host mount table: no mount table',
      },
      {
        kind: 'error',
        reason: 'could not read the host mount table: no mount table',
      },
    ]);
    expect(
      resolveNfsDirectMounts([], () => {
        throw new Error('never read');
      }),
    ).toEqual([]);
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

  const key = 'server-secret';
  const deps = (request: EngineRequest, password = 'pw') => ({
    request,
    readPassword: () => password,
    credentialKey: key,
  });

  test('creates the SMB volume through the Engine API with the password in the body only', async () => {
    const { calls, request } = fakeEngine({ status: 404 });
    const name = await ensureCifsVolume(cifsStorage(), deps(request));
    expect(name).toMatch(
      /^happyclaw-storage-nas-smb-[0-9a-f]{16}-[0-9a-f]{8}$/,
    );
    expect(name).not.toContain('pw');
    expect(calls.map((call) => call.method)).toEqual(['GET', 'POST']);
    expect(calls[1].body).toEqual({
      Name: name,
      Driver: 'local',
      DriverOpts: cifsDriverOptions(cifsStorage(), 'pw'),
      Labels: { [STORAGE_VOLUME_LABEL]: 'nas-smb' },
    });
  });

  test('reuses a matching volume', async () => {
    const same = fakeEngine({
      status: 200,
      options: cifsDriverOptions(cifsStorage(), 'pw'),
    });
    await ensureCifsVolume(cifsStorage(), deps(same.request));
    expect(same.calls.map((call) => call.method)).toEqual(['GET']);
  });

  test('a new password gets a new volume instead of replacing the one in use', async () => {
    const before = cifsVolumeName(cifsStorage(), 'old', key);
    const after = cifsVolumeName(cifsStorage(), 'new', key);
    expect(after).not.toBe(before);
    // Same share and options up to the credential version.
    expect(after.slice(0, -9)).toBe(before.slice(0, -9));
    expect(cifsVolumeName(cifsStorage(), 'new', 'other-secret')).not.toBe(
      after,
    );

    const { calls, request } = fakeEngine({ status: 404 });
    expect(await ensureCifsVolume(cifsStorage(), deps(request, 'new'))).toBe(
      after,
    );
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `GET /volumes/${after}`,
      'POST /volumes/create',
    ]);
  });

  test('replaces a free volume whose options are not the share', async () => {
    // What Docker leaves when `docker run` found the volume missing.
    const empty = fakeEngine({ status: 200, options: null });
    await ensureCifsVolume(cifsStorage(), deps(empty.request));
    expect(empty.calls.map((call) => call.method)).toEqual([
      'GET',
      'DELETE',
      'POST',
    ]);
  });

  test('refuses an in-use volume whose options are not the share', async () => {
    const empty = fakeEngine({ status: 200, options: null });
    const request: EngineRequest = async (method, requestPath, body) =>
      method === 'DELETE'
        ? { status: 409, body: '{"message":"volume is in use"}' }
        : empty.request(method, requestPath, body);
    await expect(
      ensureCifsVolume(cifsStorage(), deps(request)),
    ).rejects.toThrow(/is in use, so it is not the share/);
    expect(empty.calls.map((call) => call.method)).toEqual(['GET']);
  });

  test('serializes concurrent launches for the same volume', async () => {
    let options: unknown = null;
    const methods: string[] = [];
    const request: EngineRequest = async (method, _requestPath, body) => {
      methods.push(method);
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (method === 'GET') {
        return { status: 200, body: JSON.stringify({ Options: options }) };
      }
      if (method === 'DELETE') {
        options = undefined;
        return { status: 204, body: '' };
      }
      options = (body as { DriverOpts: unknown }).DriverOpts;
      return { status: 201, body: '{}' };
    };
    const [left, right] = await Promise.all([
      ensureCifsVolume(cifsStorage(), deps(request)),
      ensureCifsVolume(cifsStorage(), deps(request)),
    ]);
    expect(left).toBe(right);
    // The second launch sees the volume the first one made.
    expect(methods).toEqual(['GET', 'DELETE', 'POST', 'GET']);
  });
});

describe('Docker Engine API transport', () => {
  function engineServer(
    handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
  ) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-engine-'));
    const socketPath = path.join(dir, 'docker.sock');
    const requests: string[] = [];
    const server = http.createServer((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      handler(req, res);
    });
    return new Promise<{
      socketPath: string;
      requests: string[];
      close: () => Promise<void>;
    }>((resolve) => {
      server.listen(socketPath, () =>
        resolve({
          socketPath,
          requests,
          close: () =>
            new Promise((done) => {
              server.closeAllConnections();
              server.close(() => done());
            }),
        }),
      );
    });
  }

  test('creates each volume on the daemon of the context current at that time', async () => {
    const handler = (req: http.IncomingMessage, res: http.ServerResponse) => {
      req.resume();
      req.on('end', () => {
        if (req.method === 'GET') {
          res.writeHead(404).end('{"message":"no such volume"}');
        } else {
          res.writeHead(201).end('{}');
        }
      });
    };
    const first = await engineServer(handler);
    const second = await engineServer(handler);
    let socket = first.socketPath;
    try {
      const options = {
        resolveSocket: async () => socket,
        readPassword: () => 'pw',
        credentialKey: 'k',
      };
      await ensureCifsVolume(cifsStorage(), options);
      // `docker context use` while HappyClaw runs.
      socket = second.socketPath;
      await ensureCifsVolume(
        cifsStorage({ device: '//192.0.2.5/team/other' }),
        options,
      );
      expect(first.requests).toHaveLength(2);
      expect(second.requests).toHaveLength(2);
      expect(second.requests[1]).toBe('POST /volumes/create');
    } finally {
      await first.close();
      await second.close();
    }
  });

  test('rejects when the daemon hangs up in the middle of a response', async () => {
    const server = await engineServer((req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': '1000',
      });
      res.write('{"Name":');
      setTimeout(() => req.socket.destroy(), 10);
    });
    try {
      await expect(
        createEngineRequest(server.socketPath)('GET', '/volumes/x'),
      ).rejects.toThrow();
    } finally {
      await server.close();
    }
  });

  test('rejects when the daemon stops answering', async () => {
    const server = await engineServer(() => {});
    try {
      await expect(
        createEngineRequest(server.socketPath, 50)('GET', '/volumes/x'),
      ).rejects.toThrow('timed out');
    } finally {
      await server.close();
    }
  });
});
