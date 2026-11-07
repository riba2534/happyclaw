import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, test, vi } from 'vitest';

const repoRoot = path.resolve(import.meta.dirname, '..');
const testRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-container-permissions-'),
);

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    DATA_DIR: path.join(testRoot, 'data'),
    GROUPS_DIR: path.join(testRoot, 'data', 'groups'),
    STORE_DIR: path.join(testRoot, 'data', 'db'),
    CONTAINER_IMAGE: 'happyclaw-agent:test',
    TIMEZONE: 'UTC',
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

const {
  applyContainerProxyEnvLines,
  buildContainerArgs,
  withHostNfsSources,
  withNamedStorageVolumes,
  detectContainerHostIdentity,
  resolveContainerProxyConfig,
  resolveContainerHostIdentity,
} = await import('../src/container-runner.js');
const { readContainerProxyConfig } = await import('../src/config.js');

const mounts = [
  {
    hostPath: '/host/session',
    containerPath: '/home/node/.claude',
    readonly: false,
  },
];

function envArgs(args: string[]): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === '-e') values.push(args[index + 1]);
  }
  return values;
}

describe('container host identity resolution', () => {
  test('uses direct ids only for rootful Linux without a user namespace', () => {
    expect(
      resolveContainerHostIdentity({
        platform: 'linux',
        uid: 1002,
        gid: 1234,
        securityOptions: ['name=seccomp,profile=builtin'],
      }),
    ).toEqual({ mode: 'direct', uid: 1002, gid: 1234 });
  });

  test('distinguishes rootless from rootful userns-remap', () => {
    expect(
      resolveContainerHostIdentity({
        platform: 'linux',
        uid: 1002,
        gid: 1002,
        securityOptions: ['name=rootless'],
      }),
    ).toEqual({ mode: 'rootless' });
    expect(
      resolveContainerHostIdentity({
        platform: 'linux',
        uid: 1002,
        gid: 1002,
        securityOptions: ['name=userns'],
      }),
    ).toEqual({ mode: 'userns' });
  });

  test('does not hide a rootless daemon behind a host-root client uid', () => {
    expect(
      resolveContainerHostIdentity({
        platform: 'linux',
        uid: 0,
        gid: 0,
        securityOptions: ['name=rootless'],
      }),
    ).toEqual({ mode: 'rootless' });
  });

  test('keeps host-root non-root inside the container', () => {
    expect(
      resolveContainerHostIdentity({
        platform: 'linux',
        uid: 0,
        gid: 0,
        securityOptions: [],
      }),
    ).toEqual({ mode: 'host-root' });
  });

  test.each(['darwin', 'win32'] as const)(
    'preserves Docker Desktop virtualized semantics on %s',
    (platform) => {
      expect(
        resolveContainerHostIdentity({
          platform,
          uid: 501,
          gid: 20,
          securityOptions: [],
        }),
      ).toEqual({ mode: 'virtualized' });
    },
  );

  test('fails closed when daemon security options cannot be detected', () => {
    expect(
      resolveContainerHostIdentity({
        platform: 'linux',
        uid: 1002,
        gid: 1002,
        securityOptions: null,
      }),
    ).toEqual({ mode: 'unknown' });
  });

  test('re-probes daemon security options for every launch', () => {
    if (process.platform !== 'linux' || process.getuid?.() === 0) return;
    expect(detectContainerHostIdentity(() => [])).toMatchObject({
      mode: 'direct',
    });
    expect(detectContainerHostIdentity(() => ['name=userns'])).toEqual({
      mode: 'userns',
    });
    expect(detectContainerHostIdentity(() => ['name=rootless'])).toEqual({
      mode: 'rootless',
    });
    expect(detectContainerHostIdentity(() => null)).toEqual({
      mode: 'unknown',
    });
    expect(detectContainerHostIdentity(() => [])).toMatchObject({
      mode: 'direct',
    });
  });
});

describe('buildContainerArgs identity contract', () => {
  test('passes independently validated non-root uid and gid in direct mode', () => {
    const args = buildContainerArgs(mounts, 'identity-test', 'UTC', {
      mode: 'direct',
      uid: 1002,
      gid: 1234,
    });
    expect(envArgs(args)).toEqual(
      expect.arrayContaining([
        'HAPPYCLAW_HOST_IDENTITY_MODE=direct',
        'HAPPYCLAW_HOST_UID=1002',
        'HAPPYCLAW_HOST_GID=1234',
      ]),
    );
  });

  test.each([
    'rootless',
    'userns',
    'virtualized',
    'host-root',
    'unknown',
  ] as const)('never forwards numeric host ids in %s mode', (mode) => {
    const args = buildContainerArgs(mounts, 'identity-test', 'UTC', {
      mode,
      uid: 1002,
      gid: 1002,
    });
    expect(envArgs(args)).toContain(`HAPPYCLAW_HOST_IDENTITY_MODE=${mode}`);
    expect(
      envArgs(args).some((arg) => arg.startsWith('HAPPYCLAW_HOST_UID=')),
    ).toBe(false);
    expect(
      envArgs(args).some((arg) => arg.startsWith('HAPPYCLAW_HOST_GID=')),
    ).toBe(false);
  });
});

describe('buildContainerArgs storage mounts', () => {
  test('binds host paths and mounts storage as volumes', () => {
    const args = buildContainerArgs(
      [
        {
          hostPath: '/srv/data',
          containerPath: '/workspace/extra/data',
          readonly: true,
        },
        {
          hostPath: 'nfs://nas.lan/export/a',
          containerPath: '/workspace/extra/nas',
          readonly: false,
          storage: {
            type: 'nfs',
            server: 'nas.lan',
            device: '/export/a',
            options: 'nfsvers=3,proto=tcp,hard,nolock',
          },
        },
        {
          hostPath: 'smb://192.0.2.5/team',
          containerPath: '/workspace/extra/team',
          readonly: true,
          storage: { type: 'named', name: 'happyclaw-storage-team-0123' },
        },
      ],
      'storage-test',
      'UTC',
      { mode: 'unknown' },
    );
    expect(args).toContain('/srv/data:/workspace/extra/data:ro');
    expect(args).toContain(
      'type=volume,dst=/workspace/extra/nas,volume-driver=local,volume-opt=type=nfs,volume-opt=device=:/export/a,"volume-opt=o=addr=nas.lan,nfsvers=3,proto=tcp,hard,nolock"',
    );
    expect(args).toContain(
      'type=volume,src=happyclaw-storage-team-0123,dst=/workspace/extra/team,readonly',
    );
    expect(args.join(' ')).not.toContain('nfs://');
  });
});

describe('withHostNfsSources', () => {
  const plain = {
    hostPath: '/mnt/nas/plain',
    containerPath: '/workspace/extra/plain',
    readonly: true,
  };
  const optedIn = {
    hostPath: '/mnt/nas/proj',
    containerPath: '/workspace/extra/proj',
    readonly: false,
    nfsDirectMountRoot: '/mnt/nas',
  };

  test('is off unless the allowed root opts in', () => {
    const resolve = vi.fn(() => {
      throw new Error('must not read the mount table');
    });
    const mounts = [plain];
    expect(withHostNfsSources(mounts, resolve)).toBe(mounts);
    expect(resolve).not.toHaveBeenCalled();
  });

  test('mounts an opted-in NFS directory from its export and binds the rest', () => {
    const resolve = vi.fn((hostPaths: string[]) =>
      hostPaths.map(() => ({
        kind: 'nfs' as const,
        source: {
          server: 'nas',
          device: '/export/proj',
          options: 'nfsvers=4.2,proto=tcp,hard',
        },
      })),
    );
    const [first, second] = withHostNfsSources([plain, optedIn], resolve);
    expect(resolve).toHaveBeenCalledWith(['/mnt/nas/proj']);
    expect(first).toBe(plain);
    expect(second.storage).toEqual({
      type: 'nfs',
      server: 'nas',
      device: '/export/proj',
      options: 'nfsvers=4.2,proto=tcp,hard',
    });
    const local = { ...optedIn, hostPath: '/mnt/local/proj' };
    expect(withHostNfsSources([local], () => [{ kind: 'bind' }])).toEqual([
      local,
    ]);
  });

  test('fails the launch with the way back to a bind when it cannot mount directly', () => {
    expect(() =>
      withHostNfsSources([optedIn], () => [
        { kind: 'error', reason: '/mnt/nas uses sec=krb5' },
      ]),
    ).toThrow(
      /mnt\/nas\/proj cannot be mounted directly from NFS: \/mnt\/nas uses sec=krb5\. Set nfsDirectMount to false on allowed root "\/mnt\/nas"/,
    );
  });
});

describe('withNamedStorageVolumes', () => {
  const cifs = {
    hostPath: 'smb://192.0.2.5/team',
    containerPath: '/workspace/extra/team',
    readonly: true,
    storage: {
      type: 'cifs' as const,
      sourceId: 'team',
      server: '192.0.2.5',
      device: '//192.0.2.5/team',
      smbVersion: '3.0',
    },
  };
  const key = 'team\u0000//192.0.2.5/team';

  test('points an SMB mount at its prepared volume', () => {
    expect(
      withNamedStorageVolumes([cifs], new Map([[key, 'vol-1']]))[0].storage,
    ).toEqual({ type: 'named', name: 'vol-1' });
  });

  test('fails the launch with the preparation error or a missing volume', () => {
    expect(() =>
      withNamedStorageVolumes([cifs], new Map([[key, new Error('denied')]])),
    ).toThrow('denied');
    expect(() => withNamedStorageVolumes([cifs], new Map())).toThrow(
      'not prepared',
    );
  });
});

describe('container proxy boundary', () => {
  const identity = { mode: 'unknown' } as const;

  test('reads lower-case proxy aliases independently', () => {
    expect(
      readContainerProxyConfig({
        https_proxy: 'http://https.example:8443',
        http_proxy: 'http://http.example:8080',
        no_proxy: 'localhost,.internal',
      }),
    ).toEqual({
      httpsProxy: 'http://https.example:8443',
      httpProxy: 'http://http.example:8080',
      noProxy: 'localhost,.internal',
    });
  });

  test.each([
    [
      'HTTP only',
      { httpsProxy: '', httpProxy: 'http://proxy.example:8080', noProxy: '' },
      ['HTTP_PROXY=http://proxy.example:8080'],
    ],
    [
      'HTTPS only',
      { httpsProxy: 'http://proxy.example:8443', httpProxy: '', noProxy: '' },
      ['HTTPS_PROXY=http://proxy.example:8443'],
    ],
    [
      'NO_PROXY only',
      { httpsProxy: '', httpProxy: '', noProxy: 'localhost,.internal' },
      ['NO_PROXY=localhost,.internal'],
    ],
  ] as const)(
    'resolves %s without coupling variables',
    (_label, config, envLines) => {
      expect(resolveContainerProxyConfig(config, 'linux')).toEqual({
        envLines,
        addHostGateway: false,
      });
    },
  );

  test.each(['darwin', 'win32'] as const)(
    'rewrites loopback to the Docker Desktop host on %s',
    (platform) => {
      expect(
        resolveContainerProxyConfig(
          {
            httpsProxy: 'http://alice:secret@127.0.0.1:20174',
            httpProxy: '',
            noProxy: '',
          },
          platform,
        ),
      ).toEqual({
        envLines: [
          'HTTPS_PROXY=http://alice:secret@host.docker.internal:20174/',
        ],
        addHostGateway: false,
      });
    },
  );

  test.each(['localhost', '127.0.0.1', '[::1]'])(
    'fails fast for Linux loopback proxy host %s',
    (hostname) => {
      expect(() =>
        resolveContainerProxyConfig(
          {
            httpsProxy: `http://${hostname}:8080`,
            httpProxy: '',
            noProxy: '',
          },
          'linux',
        ),
      ).toThrow(/Linux bridge containers cannot reach.*Docker bridge/i);
    },
  );

  test('passes non-loopback URLs through unchanged', () => {
    expect(
      resolveContainerProxyConfig(
        {
          httpsProxy: 'http://user:secret@192.0.2.5:8443',
          httpProxy: 'http://192.0.2.5:8080',
          noProxy: '',
        },
        'linux',
      ),
    ).toEqual({
      envLines: [
        'HTTPS_PROXY=http://user:secret@192.0.2.5:8443',
        'HTTP_PROXY=http://192.0.2.5:8080',
      ],
      addHostGateway: false,
    });
  });

  test('proxy env overrides matching provider env without affecting siblings', () => {
    const envLines = [
      'https_proxy=http://provider.example:8443',
      'PROVIDER_FLAG=1',
    ];
    applyContainerProxyEnvLines(envLines, [
      'HTTPS_PROXY=http://host.example:8443',
    ]);
    expect(envLines).toEqual([
      'PROVIDER_FLAG=1',
      'HTTPS_PROXY=http://host.example:8443',
    ]);
  });

  test('docker argv contains only non-sensitive proxy networking options', () => {
    const secret = 'proxy-password-must-not-appear';
    const resolved = resolveContainerProxyConfig(
      {
        httpsProxy: `http://alice:${secret}@proxy.example:8443`,
        httpProxy: '',
        noProxy: '',
      },
      'linux',
    );
    const args = buildContainerArgs(mounts, 'proxy-test', 'UTC', identity, {
      addHostGateway: resolved.addHostGateway,
    });
    expect(
      envArgs(args).some(
        (arg) =>
          arg.startsWith('HTTPS_PROXY=') ||
          arg.startsWith('HTTP_PROXY=') ||
          arg.startsWith('NO_PROXY='),
      ),
    ).toBe(false);
    expect(args.join(' ')).not.toContain(secret);
    expect(args).not.toContain('--add-host');
  });

  test('adds host-gateway only when requested by resolved network config', () => {
    const args = buildContainerArgs(mounts, 'proxy-test', 'UTC', identity, {
      addHostGateway: true,
    });
    const addHostIndex = args.indexOf('--add-host');
    expect(addHostIndex).toBeGreaterThan(-1);
    expect(args[addHostIndex + 1]).toBe('host.docker.internal:host-gateway');
  });
});

describe('entrypoint permission contract', () => {
  const dockerfile = fs.readFileSync(
    path.join(repoRoot, 'container', 'Dockerfile'),
    'utf8',
  );
  const entrypoint = fs.readFileSync(
    path.join(repoRoot, 'container', 'entrypoint.sh'),
    'utf8',
  );
  const helper = fs.readFileSync(
    path.join(repoRoot, 'container', 'session-permissions.sh'),
    'utf8',
  );
  const watcher = fs.readFileSync(
    path.join(repoRoot, 'container', 'session-permissions-watcher.mjs'),
    'utf8',
  );
  const rescanQueue = fs.readFileSync(
    path.join(repoRoot, 'container', 'session-permissions-rescan-queue.mjs'),
    'utf8',
  );
  const mountBoundaryPath = path.join(
    repoRoot,
    'container',
    'session-permissions-mount.mjs',
  );
  const mountBoundary = fs.readFileSync(mountBoundaryPath, 'utf8');
  const fileManager = fs.readFileSync(
    path.join(repoRoot, 'src', 'file-manager.ts'),
    'utf8',
  );
  const groupQueue = fs.readFileSync(
    path.join(repoRoot, 'src', 'group-queue.ts'),
    'utf8',
  );

  test('uses fixed root-owned helpers and shadows stale malicious env values', () => {
    expect(entrypoint).toContain('source /app/session-permissions.sh');
    expect(entrypoint).toContain('happyclaw_source_runtime_env');
    expect(helper).toContain(
      '/usr/local/bin/node /app/session-permissions-watcher.mjs',
    );
    expect(helper).not.toContain('HAPPYCLAW_SESSION_PERMISSION_HELPER:-');
    expect(helper).not.toContain('groupmod --non-unique');
    expect(helper).toContain('local HAPPYCLAW_SESSION_ROOT=');
    expect(helper).toContain('local HAPPYCLAW_INTERNAL_WATCHER_PID=');
    expect(entrypoint).toContain(
      'npx tsc --outDir /tmp/dist --incremental false',
    );
    expect(
      entrypoint.indexOf('happyclaw_prepare_generated_path dist'),
    ).toBeLessThan(
      entrypoint.indexOf('ln -s /app/node_modules /tmp/dist/node_modules'),
    );
    expect(entrypoint).toContain('/app/session-prompts-copy.mjs');
    expect(entrypoint).not.toContain('ln -s /app/prompts /tmp/prompts');
    expect(entrypoint).toContain(
      'runuser -u node -- env HOME=/home/node /usr/bin/git',
    );
    expect(dockerfile).toContain('session-permissions-rescan-queue.mjs');
    expect(dockerfile).toContain('chown -R root:root dist prompts');
    expect(dockerfile).toContain('find dist prompts -type d -exec chmod 0555');
    expect(dockerfile).toContain('find dist prompts -type f -exec chmod 0444');
  });

  test('contains no world-permission fallback', () => {
    expect(entrypoint).not.toMatch(/umask\s+0000/);
    expect(entrypoint).not.toMatch(/chmod[^\n]*a\+(?:rw|rwx|rwX)/);
    expect(helper).not.toMatch(/chmod[^\n]*a\+(?:rw|rwx|rwX)/);
    expect(helper).not.toMatch(/0?666|0?777/);
    expect(watcher).toContain('0o660');
    expect(watcher).toContain('0o2770');
    expect(watcher).not.toMatch(/fchmodSync\([^,\n]+,\s*0o(?:666|777)\b/);
    expect(fileManager).not.toContain('0o777');
    expect(groupQueue).not.toContain('0o777');
    expect(entrypoint).not.toMatch(/(?:chown|chmod)\s+-R/);
    expect(helper).not.toMatch(/(?:chown|chmod)\s+-R/);
  });

  test('watcher has fixed roots, descriptor-safe paths and bounded rescans', () => {
    expect(watcher).toContain("path: '/home/node/.claude'");
    expect(watcher).toContain("path: '/home/node/.feishu-cli'");
    expect(watcher).toContain("encoding: 'buffer'");
    expect(watcher).toContain('fs.constants.O_NOFOLLOW');
    expect(watcher).toContain('/proc/self/fd/');
    expect(watcher).toContain('readDescriptorMountId(root.fd)');
    expect(watcher).toContain('mountId !== root.mountId');
    expect(watcher).toContain('stat.nlink > 1');
    expect(watcher).toContain('fs.fchownSync(fd');
    expect(watcher).toContain('fs.fchmodSync(fd');
    expect(watcher).not.toMatch(/fs\.(?:chown|chmod)Sync\(/);
    expect(watcher).not.toContain('lstatSync');
    expect(watcher).toContain('RESCAN_INTERVAL_MS = 30_000');
    expect(watcher).not.toContain('RESCAN_INTERVAL_MS = 500');
    expect(watcher).toContain('fs.opendirSync');
    expect(watcher).not.toContain('fs.readdirSync');
    expect(watcher).toContain('createBoundedRescanScheduler');
    expect(rescanQueue).toContain('MAX_PENDING_RESCAN_TARGETS = 256');
    expect(rescanQueue).toContain('pendingTargets.clear()');
    expect(mountBoundary).not.toMatch(/catch\s*\{/);
  });

  test('mount metadata parser fails closed without a unique valid mnt_id', () => {
    const moduleUrl = pathToFileURL(mountBoundaryPath).href;
    execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      `
        import assert from 'node:assert/strict';
        import {
          parseDescriptorMountId,
          readDescriptorMountId,
        } from ${JSON.stringify(moduleUrl)};
        assert.equal(parseDescriptorMountId('pos:\\t0\\nmnt_id:\\t1725\\n'), 1725);
        assert.throws(() => parseDescriptorMountId('pos:\\t0\\n'));
        assert.throws(() => parseDescriptorMountId('mnt_id:\\t1\\nmnt_id:\\t2\\n'));
        assert.throws(() => parseDescriptorMountId('mnt_id:\\tinvalid\\n'));
        assert.throws(() => readDescriptorMountId(99, () => {
          throw new Error('fdinfo unavailable');
        }));
      `,
    ]);
  });
});

const integrationImage =
  process.env.HAPPYCLAW_CONTAINER_PERMISSION_TEST_IMAGE ??
  'riba2534/happyclaw-agent:latest';
let integrationImageAvailable = false;
try {
  execFileSync('docker', ['image', 'inspect', integrationImage], {
    stdio: 'ignore',
  });
  integrationImageAvailable = true;
} catch {
  // Unit and contract tests remain hermetic when Docker is unavailable.
}

describe.skipIf(!integrationImageAvailable)(
  'permission helper behavior in the branch image',
  {
    // Every test below starts one or more real Docker containers. Hosted
    // runner scheduling and cold-overlay setup have exceeded Vitest's generic
    // 5s unit-test budget on both amd64 and arm64 even though the command then
    // completed successfully. Keep a per-test bound, but size it for an image
    // integration contract rather than an in-process unit test.
    timeout: 30_000,
  },
  () => {
    const helperPath = path.join(
      repoRoot,
      'container',
      'session-permissions.sh',
    );
    const watcherPath = path.join(
      repoRoot,
      'container',
      'session-permissions-watcher.mjs',
    );
    const rescanQueuePath = path.join(
      repoRoot,
      'container',
      'session-permissions-rescan-queue.mjs',
    );
    const mountBoundaryPath = path.join(
      repoRoot,
      'container',
      'session-permissions-mount.mjs',
    );

    function runImageScript(script: string, extraArgs: string[] = []): string {
      return execFileSync(
        'docker',
        [
          'run',
          '--rm',
          '--entrypoint',
          '/bin/bash',
          ...extraArgs,
          integrationImage,
          '-ceu',
          script,
        ],
        { encoding: 'utf8' },
      ).trim();
    }

    function runHelper(script: string, extraArgs: string[] = []): string {
      return execFileSync(
        'docker',
        [
          'run',
          '--rm',
          '--entrypoint',
          '/bin/bash',
          '-v',
          `${helperPath}:/tmp/session-permissions.sh:ro`,
          '-v',
          `${watcherPath}:/app/session-permissions-watcher.mjs:ro`,
          '-v',
          `${rescanQueuePath}:/app/session-permissions-rescan-queue.mjs:ro`,
          '-v',
          `${mountBoundaryPath}:/app/session-permissions-mount.mjs:ro`,
          ...extraArgs,
          integrationImage,
          '-ceu',
          `source /tmp/session-permissions.sh\n${script}`,
        ],
        { encoding: 'utf8' },
      ).trim();
    }

    function fileSnapshot(filePath: string) {
      const stat = fs.statSync(filePath);
      return {
        uid: stat.uid,
        gid: stat.gid,
        mode: stat.mode & 0o7777,
        nlink: stat.nlink,
        content: fs.readFileSync(filePath, 'utf8'),
      };
    }

    test('direct mode safely falls back from an image group gid collision', () => {
      expect(
        runHelper(`
          shadow_gid=$(getent group shadow | cut -d: -f3)
          original_gid=$(id -g node)
          test -n "$shadow_gid"
          HAPPYCLAW_HOST_IDENTITY_MODE=direct
          HAPPYCLAW_HOST_UID=12346
          HAPPYCLAW_HOST_GID="$shadow_gid"
          happyclaw_configure_node_identity
          install -o 12346 -g "$shadow_gid" -m 0600 /dev/null /tmp/host-owned
          setpriv --reuid=12346 --regid="$original_gid" --clear-groups -- \
            test -r /tmp/host-owned
          setpriv --reuid=12346 --regid="$original_gid" --clear-groups -- \
            test ! -r /etc/shadow
          test "$(id -u node)" = 12346
          test "$(id -g node)" = "$original_gid"
          printf uid-aligned
        `),
      ).toBe('uid-aligned');
    });

    test('exact image aligns uid without granting the shadow group', () => {
      expect(
        runImageScript(`
          source /app/session-permissions.sh
          shadow_gid=$(getent group shadow | cut -d: -f3)
          original_gid=$(id -g node)
          HAPPYCLAW_HOST_IDENTITY_MODE=direct
          HAPPYCLAW_HOST_UID=12346
          HAPPYCLAW_HOST_GID="$shadow_gid"
          happyclaw_configure_node_identity
          test "$(id -u node)" = 12346
          test "$(id -g node)" = "$original_gid"
          install -o 12346 -g "$shadow_gid" -m 0600 /dev/null /tmp/host-owned
          setpriv --reuid=12346 --regid="$original_gid" \
            --clear-groups -- test -r /tmp/host-owned
          setpriv --reuid=12346 --regid="$original_gid" \
            --clear-groups -- test ! -r /etc/shadow
          printf 'uid-aligned:shadow-unreadable'
        `),
      ).toBe('uid-aligned:shadow-unreadable');
    });

    test('fails closed for rootful userns-remap and unknown probes', () => {
      for (const mode of ['userns', 'unknown']) {
        expect(() =>
          runHelper(`
            HAPPYCLAW_HOST_IDENTITY_MODE=${mode}
            happyclaw_configure_node_identity
          `),
        ).toThrow();
      }
    });

    test('rootless watcher upgrades legacy node-owned roots before readiness', () => {
      expect(
        runImageScript(`
          source /app/session-permissions.sh
          mkdir -p /home/node/.claude /home/node/.feishu-cli \
            /workspace/{group,ipc,extra}
          for root in /home/node/.claude /home/node/.feishu-cli \
            /workspace/group /workspace/ipc /workspace/extra; do
            touch "$root/legacy-file"
            chown -R 1000:1000 "$root"
            chmod 0700 "$root"
            chmod 0600 "$root/legacy-file"
          done
          HAPPYCLAW_HOST_IDENTITY_MODE=rootless
          happyclaw_configure_node_identity
          happyclaw_start_session_permission_watcher
          for root in /home/node/.claude /home/node/.feishu-cli \
            /workspace/group /workspace/ipc /workspace/extra; do
            test "$(stat -c '%u:%g:%a' "$root")" = '0:1000:2770'
            test "$(stat -c '%u:%g:%a' "$root/legacy-file")" = \
              '0:1000:660'
          done
          happyclaw_stop_session_permission_watcher
          printf upgraded-before-ready
        `),
      ).toBe('upgraded-before-ready');
    });

    test('rootless watcher accepts mixed mapped and legacy roots including Feishu state', () => {
      expect(
        runImageScript(`
          source /app/session-permissions.sh
          mkdir -p /home/node/.claude /home/node/.feishu-cli \
            /workspace/{group,ipc,extra}
          chown 0:1000 /home/node/.claude /workspace/ipc
          chown 1000:1000 /home/node/.feishu-cli /workspace/group /workspace/extra
          chmod 0700 /home/node/.claude /home/node/.feishu-cli \
            /workspace/group /workspace/ipc /workspace/extra
          HAPPYCLAW_HOST_IDENTITY_MODE=rootless
          happyclaw_configure_node_identity
          happyclaw_start_session_permission_watcher
          for root in /home/node/.claude /home/node/.feishu-cli \
            /workspace/group /workspace/ipc /workspace/extra; do
            test "$(stat -c '%u:%g:%a' "$root")" = '0:1000:2770'
          done
          happyclaw_stop_session_permission_watcher
          printf mixed-upgraded
        `),
      ).toBe('mixed-upgraded');
    });

    test('rootless verifier still rejects arbitrary bind-root ownership', () => {
      expect(() =>
        runImageScript(`
          source /app/session-permissions.sh
          mkdir -p /home/node/.claude /workspace/{group,ipc,extra}
          chown 1234:1234 /workspace/group
          HAPPYCLAW_HOST_IDENTITY_MODE=rootless
          happyclaw_configure_node_identity
          happyclaw_start_session_permission_watcher
        `),
      ).toThrow();
    });

    test('direct migration changes only legacy uid 1000 in fixed managed roots', () => {
      expect(
        runHelper(`
          mkdir -p /home/node/.claude /workspace/{group,ipc,extra}
          touch /home/node/.claude/token.json /workspace/group/canary
          chown -R 1000:1000 /home/node/.claude /workspace/group
          chmod 0777 /home/node/.claude
          chmod 0666 /home/node/.claude/token.json
          HAPPYCLAW_HOST_IDENTITY_MODE=direct
          HAPPYCLAW_HOST_UID=12346
          HAPPYCLAW_HOST_GID=12347
          happyclaw_configure_node_identity
          happyclaw_migrate_direct_managed_paths
          printf '%s|%s|%s' \
            "$(stat -c '%u:%g:%a' /home/node/.claude/token.json)" \
            "$(stat -c '%u:%g' /workspace/group/canary)" \
            "$(find /home/node/.claude -maxdepth 1 -name '.happyclaw-owner-v2-*' | wc -l)"
        `),
      ).toBe('12346:12347:600|1000:1000|0');
    });

    test('fake legacy migration marker cannot preserve unsafe credentials', () => {
      expect(
        runImageScript(`
          source /app/session-permissions.sh
          mkdir -p /home/node/.claude /workspace/{group,ipc,extra}
          touch /home/node/.claude/.happyclaw-owner-v2-12346-12347
          touch /home/node/.claude/credential
          chown -R 1000:1000 /home/node/.claude
          chmod 0600 /home/node/.claude/.happyclaw-owner-v2-12346-12347
          chmod 0666 /home/node/.claude/credential
          HAPPYCLAW_HOST_IDENTITY_MODE=direct
          HAPPYCLAW_HOST_UID=12346
          HAPPYCLAW_HOST_GID=12347
          happyclaw_configure_node_identity
          happyclaw_migrate_direct_managed_paths
          stat -c '%u:%g:%a' /home/node/.claude/credential
        `),
      ).toBe('12346:12347:600');
    });

    test('concurrent direct migrations are idempotent without markers', () => {
      expect(
        runImageScript(`
          source /app/session-permissions.sh
          mkdir -p /home/node/.claude /home/node/.feishu-cli \
            /workspace/{group,ipc,extra}
          node -e "const fs=require('fs'); for(let i=0;i<2000;i++) fs.writeFileSync('/home/node/.feishu-cli/f'+i,'',{mode:0o666})"
          chown -R 1000:1000 /home/node/.claude /home/node/.feishu-cli
          HAPPYCLAW_HOST_IDENTITY_MODE=direct
          HAPPYCLAW_HOST_UID=12346
          HAPPYCLAW_HOST_GID=12347
          happyclaw_configure_node_identity
          for round in $(seq 1 5); do
            node /app/session-permissions-watcher.mjs --migrate-direct &
            first=$!
            node /app/session-permissions-watcher.mjs --migrate-direct &
            second=$!
            wait "$first"
            wait "$second"
          done
          test "$(find /home/node/.feishu-cli -name '.happyclaw-owner-v2-*' | wc -l)" = 0
          stat -c '%u:%g:%a' /home/node/.feishu-cli/f1
        `),
      ).toBe('12346:12347:600');
    }, 30_000);

    test('direct cleanup tightens files changed during the container run', () => {
      expect(
        runImageScript(`
          source /app/session-permissions.sh
          mkdir -p /home/node/.claude /workspace/{group,ipc,extra}
          HAPPYCLAW_HOST_IDENTITY_MODE=direct
          HAPPYCLAW_HOST_UID=12346
          HAPPYCLAW_HOST_GID=12347
          happyclaw_configure_node_identity
          happyclaw_migrate_direct_managed_paths
          install -o 12346 -g 12347 -m 0666 /dev/null \
            /home/node/.claude/runtime-created
          happyclaw_stop_session_permission_watcher
          stat -c '%u:%g:%a' /home/node/.claude/runtime-created
        `),
      ).toBe('12346:12347:600');
    });

    test.each(['rw', 'ro'] as const)(
      'exact image skips a same-filesystem %s nested bind',
      (access) => {
        const outer = fs.mkdtempSync(path.join(testRoot, 'nested-outer-'));
        const outside = fs.mkdtempSync(path.join(testRoot, 'nested-outside-'));
        fs.mkdirSync(path.join(outer, 'nested'));
        const canary = path.join(outside, 'canary');
        fs.writeFileSync(canary, 'nested-bind-canary', { mode: 0o640 });
        fs.chmodSync(canary, 0o640);
        expect(fs.statSync(outer).dev).toBe(fs.statSync(outside).dev);
        const before = fileSnapshot(canary);

        expect(
          runImageScript(
            `
              mkdir -p /workspace/{group,ipc,extra}
              node /app/session-permissions-watcher.mjs \
                --normalize-node-owned-mounts
              printf safe
            `,
            [
              '-v',
              `${outer}:/home/node/.claude`,
              '-v',
              `${outside}:/home/node/.claude/nested${
                access === 'ro' ? ':ro' : ''
              }`,
            ],
          ),
        ).toBe('safe');
        expect(fileSnapshot(canary)).toEqual(before);
      },
    );

    test('managed hardlinks fail closed without changing the outside inode', () => {
      const session = fs.mkdtempSync(path.join(testRoot, 'hardlink-session-'));
      const outside = fs.mkdtempSync(path.join(testRoot, 'hardlink-outside-'));
      const canary = path.join(outside, 'canary');
      const inside = path.join(session, 'inside-link');
      fs.writeFileSync(canary, 'hardlink-canary', { mode: 0o640 });
      fs.chmodSync(canary, 0o640);
      fs.linkSync(canary, inside);
      const before = fileSnapshot(canary);

      expect(() =>
        runImageScript(
          `
            mkdir -p /workspace/{group,ipc,extra}
            node /app/session-permissions-watcher.mjs --once
          `,
          ['-v', `${session}:/home/node/.claude`],
        ),
      ).toThrow();
      expect(fileSnapshot(canary)).toEqual(before);
    });

    test('mirror-root hardlinks are logged and skipped without mutation', () => {
      const group = fs.mkdtempSync(path.join(testRoot, 'hardlink-group-'));
      const outside = fs.mkdtempSync(path.join(testRoot, 'hardlink-mirror-'));
      const canary = path.join(outside, 'canary');
      fs.writeFileSync(canary, 'mirror-hardlink-canary', { mode: 0o640 });
      fs.chmodSync(canary, 0o640);
      fs.linkSync(canary, path.join(group, 'inside-link'));
      const before = fileSnapshot(canary);

      expect(
        runImageScript(
          `
            mkdir -p /home/node/.claude /workspace/{ipc,extra}
            message=$(node /app/session-permissions-watcher.mjs --once 2>&1)
            printf '%s' "$message"
          `,
          ['-v', `${group}:/workspace/group`],
        ),
      ).toContain('skipping multiply-linked inode');
      expect(fileSnapshot(canary)).toEqual(before);
    });

    test('host-root live watcher repairs new root-owned entries privately', () => {
      expect(
        runImageScript(`
          source /app/session-permissions.sh
          mkdir -p /home/node/.claude /workspace/{group,ipc,extra}
          HAPPYCLAW_HOST_IDENTITY_MODE=host-root
          happyclaw_configure_node_identity
          happyclaw_prepare_mounted_paths
          happyclaw_start_session_permission_watcher
          install -d -o 0 -g 0 -m 0700 /workspace/group/live
          install -o 0 -g 0 -m 0600 /dev/null /workspace/group/live/file
          for attempt in $(seq 1 200); do
            [ "$(stat -c '%u:%g:%a' /workspace/group/live/file)" = \
              "$(id -u node):$(id -g node):600" ] && break
            sleep 0.02
          done
          setpriv --reuid="$(id -u node)" --regid="$(id -g node)" \
            --clear-groups -- test -r /workspace/group/live/file
          test "$(stat -c %a /workspace/group/live)" = 700
          test "$(stat -c %a /workspace/group/live/file)" = 600
          happyclaw_stop_session_permission_watcher
          printf repaired
        `),
      ).toBe('repaired');
    });

    test('fixed generated roots reject persistent symlink traversal', () => {
      const extra = fs.mkdtempSync(path.join(testRoot, 'generated-extra-'));
      const session = fs.mkdtempSync(path.join(testRoot, 'generated-session-'));
      const outside = fs.mkdtempSync(path.join(testRoot, 'generated-outside-'));
      const canary = path.join(outside, 'canary');
      fs.writeFileSync(canary, 'generated-path-canary', { mode: 0o640 });
      fs.symlinkSync('/tmp/generated-outside', path.join(extra, '.npm-global'));
      fs.symlinkSync('/tmp/generated-outside', path.join(session, 'skills'));
      const before = fileSnapshot(canary);

      for (const operation of ['--ensure-npm-global', '--reset-skills']) {
        expect(() =>
          runImageScript(`node /app/session-generated-paths.mjs ${operation}`, [
            '-v',
            `${extra}:/workspace/extra`,
            '-v',
            `${session}:/home/node/.claude`,
            '-v',
            `${outside}:/tmp/generated-outside`,
          ]),
        ).toThrow();
        expect(fileSnapshot(canary)).toEqual(before);
        expect(fs.existsSync(path.join(outside, 'bin'))).toBe(false);
        expect(fs.existsSync(path.join(outside, 'lib'))).toBe(false);
      }
    });

    test('restrictive prompt bind is copied read-only without touching source', () => {
      const prompts = fs.mkdtempSync(path.join(testRoot, 'runtime-prompts-'));
      const prompt = path.join(prompts, 'identity.happyclaw.md');
      fs.writeFileSync(prompt, 'runtime prompt', { mode: 0o600 });
      fs.chmodSync(prompts, 0o700);
      fs.chmodSync(prompt, 0o600);
      const before = fileSnapshot(prompt);

      expect(
        runImageScript(
          `
            node /app/session-prompts-copy.mjs
            test "$(stat -c '%u:%g:%a' /tmp/prompts)" = '0:0:555'
            test "$(stat -c '%u:%g:%a' /tmp/prompts/identity.happyclaw.md)" = \
              '0:0:444'
            setpriv --reuid="$(id -u node)" --regid="$(id -g node)" \
              --clear-groups -- sh -ceu '
                test "$(cat /tmp/prompts/identity.happyclaw.md)" = "runtime prompt"
                test ! -w /tmp/prompts/identity.happyclaw.md
                test ! -w /app/prompts/identity.happyclaw.md
              '
            printf copied
          `,
          ['-v', `${prompts}:/app/prompts:ro`],
        ),
      ).toBe('copied');
      expect(fileSnapshot(prompt)).toEqual(before);
    });

    test('node git config permits a root-owned group-readable repository', () => {
      expect(
        runImageScript(`
          repository=$(mktemp -d)
          git -C "$repository" init -q
          touch "$repository/tracked"
          chown -R 0:"$(id -g node)" "$repository"
          find "$repository" -type d -exec chmod 2770 {} +
          find "$repository" -type f -exec chmod 0660 {} +
          runuser -u node -- env HOME=/home/node /usr/bin/git \
            config --global --add safe.directory '*'
          runuser -u node -- env HOME=/home/node /usr/bin/git \
            -C "$repository" status --short >/dev/null
          test -f /home/node/.gitconfig
          printf trusted
        `),
      ).toBe('trusted');
    });

    test('runtime env cannot override root-control variables', () => {
      const envDir = fs.mkdtempSync(path.join(testRoot, 'malicious-env-'));
      fs.writeFileSync(
        path.join(envDir, 'env'),
        [
          "HAPPYCLAW_HOST_IDENTITY_MODE='unknown'",
          "HAPPYCLAW_INTERNAL_IDENTITY_MODE='pwned'",
          "HAPPYCLAW_INTERNAL_WATCHER_PID='1'",
          "HAPPYCLAW_SESSION_ROOT='/'",
          "HAPPYCLAW_SESSION_PERMISSION_HELPER='/workspace/group/evil.sh'",
          "PROJECT_ENV='kept'",
        ].join('\n'),
        { mode: 0o600 },
      );
      expect(
        runHelper(
          `
            HAPPYCLAW_HOST_IDENTITY_MODE=direct
            HAPPYCLAW_INTERNAL_IDENTITY_MODE=direct
            HAPPYCLAW_INTERNAL_WATCHER_PID=4242
            happyclaw_source_runtime_env
            printf '%s:%s:%s:%s' \
              "$HAPPYCLAW_HOST_IDENTITY_MODE" \
              "$HAPPYCLAW_INTERNAL_IDENTITY_MODE" \
              "$HAPPYCLAW_INTERNAL_WATCHER_PID" \
              "$PROJECT_ENV"
          `,
          ['-v', `${envDir}:/workspace/env-dir:ro`],
        ),
      ).toBe('direct:direct:4242:kept');
    });

    test('one-shot bridge removes other bits without following symlinks', () => {
      expect(
        runHelper(`
          mkdir -p /home/node/.claude /workspace/{group,ipc,extra}
          credential=/home/node/.claude/.credentials.json
          outside=$(mktemp)
          touch "$credential"
          chmod 0600 "$credential" "$outside"
          ln -s "$outside" /home/node/.claude/outside-link
          mkdir -p $'/home/node/.claude/newline\n..'/nested
          touch $'/home/node/.claude/newline\n..'/nested/transcript.jsonl
          chmod 0600 $'/home/node/.claude/newline\n..'/nested/transcript.jsonl
          node /app/session-permissions-watcher.mjs --once
          printf '%s|%s|%s|%s' \
            "$(stat -c '%u:%g:%a' "$credential")" \
            "$(stat -c '%a' /home/node/.claude)" \
            "$(stat -c '%a' $'/home/node/.claude/newline\n..'/nested/transcript.jsonl)" \
            "$(stat -c '%a' "$outside")"
          setpriv --reuid=12345 --regid=12345 --clear-groups -- \
            test ! -r "$credential"
        `),
      ).toBe('0:1000:660|2770|660|600');
    });

    test('descriptor bridge resists file-to-symlink swaps', () => {
      expect(
        runHelper(`
            mkdir -p /home/node/.claude /workspace/{group,ipc,extra}
            outside=$(mktemp)
            printf 'outside-canary' > "$outside"
            chown 12345:12345 "$outside"
            chmod 0640 "$outside"
            node /app/session-permissions-watcher.mjs &
            watcher_pid=$!
            for attempt in $(seq 1 200); do
              [ -e /run/happyclaw-session-watcher.ready ] && break
              kill -0 "$watcher_pid"
              sleep 0.02
            done
            for attempt in $(seq 1 2000); do
              rm -f /home/node/.claude/race
              install -m 0600 /dev/null /home/node/.claude/race
              rm -f /home/node/.claude/race
              ln -s "$outside" /home/node/.claude/race
            done
            rm -f /home/node/.claude/race
            sleep 0.1
            kill "$watcher_pid"
            wait "$watcher_pid"
            printf '%s:%s:%s' \
              "$(stat -c '%u:%g:%a' "$outside")" \
              "$(cat "$outside")" \
              "$([ -e /run/happyclaw-session-watcher.failed ] && echo failed || echo safe)"
          `),
      ).toBe('12345:12345:640:outside-canary:safe');
    }, 30_000);

    test('live watcher repairs restrictive files and moved-in subtrees', () => {
      expect(
        runHelper(`
            mkdir -p /home/node/.claude /workspace/{group,ipc,extra}
            node /app/session-permissions-watcher.mjs &
            watcher_pid=$!
            for attempt in $(seq 1 200); do
              [ -e /run/happyclaw-session-watcher.ready ] && break
              kill -0 "$watcher_pid"
              sleep 0.02
            done
            install -m 0600 /dev/null /home/node/.claude/live.jsonl
            incoming=$(mktemp -d)
            mkdir -p "$incoming/deep"
            install -m 0600 /dev/null "$incoming/deep/moved.jsonl"
            mv "$incoming" /home/node/.claude/moved
            for attempt in $(seq 1 200); do
              [ "$(stat -c %a /home/node/.claude/live.jsonl)" = 660 ] && \
                [ "$(stat -c %a /home/node/.claude/moved/deep/moved.jsonl)" = 660 ] && break
              sleep 0.02
            done
            modes="$(stat -c %a /home/node/.claude/live.jsonl):$(stat -c %a /home/node/.claude/moved/deep/moved.jsonl)"
            kill "$watcher_pid"
            wait "$watcher_pid"
            printf '%s:%s' "$modes" "$(kill -0 "$watcher_pid" 2>/dev/null && echo live || echo stopped)"
          `),
      ).toBe('660:660:stopped');
    }, 20_000);

    test('normalizes a 10000-file session in bounded startup time', () => {
      const elapsed = Number(
        runHelper(`
            mkdir -p /home/node/.claude /workspace/{group,ipc,extra}
            start=$(date +%s%N)
            node -e "const fs=require('fs'); for(let i=0;i<10000;i++) fs.writeFileSync('/home/node/.claude/f'+i,'',{mode:0o600})"
            node /app/session-permissions-watcher.mjs --once
            end=$(date +%s%N)
            printf '%s' $(((end-start)/1000000))
          `),
      );
      expect(elapsed).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(10_000);
    }, 30_000);
  },
);
