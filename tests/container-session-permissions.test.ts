import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

const { buildContainerArgs, resolveContainerHostIdentity } =
  await import('../src/container-runner.js');

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
  test('uses direct ids only for rootful Linux without user namespaces', () => {
    expect(
      resolveContainerHostIdentity({
        platform: 'linux',
        uid: 1002,
        gid: 1234,
        securityOptions: ['name=seccomp,profile=builtin'],
      }),
    ).toEqual({ mode: 'direct', uid: 1002, gid: 1234 });
  });

  test.each([
    [['name=rootless'], 'namespaced'],
    [['name=userns'], 'namespaced'],
  ] as const)('does not reuse numeric ids for %s', (securityOptions, mode) => {
    expect(
      resolveContainerHostIdentity({
        platform: 'linux',
        uid: 1002,
        gid: 1002,
        securityOptions,
      }),
    ).toEqual({ mode });
  });

  test('keeps a host-root deployment non-root inside the container', () => {
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
    'uses virtualized mount semantics on %s',
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
        'TZ=UTC',
        'HAPPYCLAW_HOST_IDENTITY_MODE=direct',
        'HAPPYCLAW_HOST_UID=1002',
        'HAPPYCLAW_HOST_GID=1234',
      ]),
    );
  });

  test('never forwards uid or gid zero even for a malformed direct identity', () => {
    const args = buildContainerArgs(mounts, 'identity-test', 'UTC', {
      mode: 'direct',
      uid: 0,
      gid: 0,
    });

    expect(envArgs(args)).toContain('HAPPYCLAW_HOST_IDENTITY_MODE=direct');
    expect(envArgs(args)).not.toContain('HAPPYCLAW_HOST_UID=0');
    expect(envArgs(args)).not.toContain('HAPPYCLAW_HOST_GID=0');
  });

  test.each(['namespaced', 'virtualized', 'host-root', 'unknown'] as const)(
    'does not pass numeric host ids in %s mode',
    (mode) => {
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
    },
  );
});

describe('entrypoint session permission contract', () => {
  const entrypoint = fs.readFileSync(
    path.join(repoRoot, 'container', 'entrypoint.sh'),
    'utf8',
  );
  const helper = fs.readFileSync(
    path.join(repoRoot, 'container', 'session-permissions.sh'),
    'utf8',
  );

  test('sources identity handling before dropping privileges', () => {
    expect(entrypoint).toContain('source /app/session-permissions.sh');
    expect(
      entrypoint.indexOf('happyclaw_configure_node_identity'),
    ).toBeLessThan(entrypoint.indexOf('runuser -u node'));
  });

  test('does not recursively chown the image home', () => {
    expect(entrypoint).not.toMatch(/chown\s+-R\s+[^\n]*\/home\/node(?:\s|$)/);
    expect(helper).not.toMatch(/chown\s+-R\s+[^\n]*\/home\/\$runtime_user/);
  });

  test('rejects id zero and scopes fallback reconciliation to the session root', () => {
    expect(helper).toContain('[ "$value" -gt 0 ]');
    expect(helper).toContain('refusing unsafe host uid');
    expect(helper).toContain('refusing unsafe host gid');
    expect(helper).toContain('HAPPYCLAW_SESSION_ROOT:-/home/node/.claude');
    expect(helper).toContain('find "$session_root" -xdev');
  });

  test('uses event-scoped reconciliation with a low-frequency fallback', () => {
    expect(helper).toContain('inotifywait --monitor --recursive');
    expect(helper).toContain('happyclaw_relax_session_path "$changed_path"');
    expect(helper).toContain('while sleep 30');
    expect(helper).not.toContain('HAPPYCLAW_SESSION_PERMISSION_INTERVAL');
    expect(helper).not.toContain(
      'sleep "${HAPPYCLAW_SESSION_PERMISSION_INTERVAL:-0.5}"',
    );
  });

  test('widens modes only for identity modes that cannot be mapped', () => {
    expect(entrypoint).toContain(
      'if [ "$HAPPYCLAW_RECONCILE_SESSION_PERMISSIONS" = 1 ]',
    );
    expect(helper).toContain('HAPPYCLAW_MOUNT_PREPARE_MODE=shared');
    expect(helper).toContain('HAPPYCLAW_MOUNT_PREPARE_MODE=root');
    expect(helper).toContain('HAPPYCLAW_MOUNT_PREPARE_MODE=recursive');
  });
});

const integrationImage =
  process.env.HAPPYCLAW_CONTAINER_PERMISSION_TEST_IMAGE ??
  'riba2534/happyclaw-agent:latest';
let integrationImageAvailable = false;
let integrationImageHasInotify = false;
try {
  execFileSync('docker', ['image', 'inspect', integrationImage], {
    stdio: 'ignore',
  });
  integrationImageAvailable = true;
  execFileSync(
    'docker',
    [
      'run',
      '--rm',
      '--entrypoint',
      '/bin/sh',
      integrationImage,
      '-c',
      'command -v inotifywait >/dev/null',
    ],
    { stdio: 'ignore' },
  );
  integrationImageHasInotify = true;
} catch {
  // Unit and contract tests still run when Docker is unavailable in CI.
}

describe.skipIf(!integrationImageAvailable)(
  'session permission helper container behavior',
  () => {
    const helperPath = path.join(
      repoRoot,
      'container',
      'session-permissions.sh',
    );

    function runHelper(script: string): string {
      return execFileSync(
        'docker',
        [
          'run',
          '--rm',
          '--entrypoint',
          '/bin/bash',
          '-v',
          `${helperPath}:/tmp/session-permissions.sh:ro`,
          integrationImage,
          '-ceu',
          `source /tmp/session-permissions.sh\n${script}`,
        ],
        { encoding: 'utf8' },
      ).trim();
    }

    test('refuses zero ids and independently remaps a non-zero gid', () => {
      expect(
        runHelper(`
          HAPPYCLAW_HOST_IDENTITY_MODE=direct
          HAPPYCLAW_HOST_UID=0
          HAPPYCLAW_HOST_GID=12345
          happyclaw_configure_node_identity
          printf '%s:%s:%s' "$(id -u node)" "$(id -g node)" "$HAPPYCLAW_RECONCILE_SESSION_PERMISSIONS"
        `),
      ).toBe('1000:12345:1');
    });

    test('remaps separate non-zero uid and gid without scanning the image home', () => {
      expect(
        runHelper(`
          HAPPYCLAW_HOST_IDENTITY_MODE=direct
          HAPPYCLAW_HOST_UID=12346
          HAPPYCLAW_HOST_GID=12347
          happyclaw_configure_node_identity
          printf '%s:%s:%s' "$(id -u node)" "$(id -g node)" "$HAPPYCLAW_RECONCILE_SESSION_PERMISSIONS"
        `),
      ).toBe('12346:12347:0');
    });

    test('keeps node primary-group metadata aligned when the host gid exists', () => {
      expect(
        runHelper(`
          HAPPYCLAW_HOST_IDENTITY_MODE=direct
          HAPPYCLAW_HOST_UID=12346
          HAPPYCLAW_HOST_GID=65534
          happyclaw_configure_node_identity
          printf '%s:%s:%s' "$(id -u node)" "$(id -g node)" "$(getent group node | cut -d: -f3)"
        `),
      ).toBe('12346:65534:65534');
    });

    test('keeps image ids in namespace mode and repairs a 0600 transcript', () => {
      expect(
        runHelper(`
          session_root=$(mktemp -d)
          touch "$session_root/transcript.jsonl"
          chmod 0600 "$session_root/transcript.jsonl"
          HAPPYCLAW_HOST_IDENTITY_MODE=namespaced
          HAPPYCLAW_SESSION_ROOT="$session_root"
          happyclaw_configure_node_identity
          happyclaw_relax_session_permissions
          printf '%s:%s:%s:%s' "$(id -u node)" "$(id -g node)" "$HAPPYCLAW_RECONCILE_SESSION_PERMISSIONS" "$(stat -c %a "$session_root/transcript.jsonl")"
        `),
      ).toBe('1000:1000:1:666');
    });

    test('does not numerically chown namespace or virtualized mounts', () => {
      for (const mode of ['namespaced', 'virtualized']) {
        expect(
          runHelper(`
            session_root=$(mktemp -d)
            touch "$session_root/transcript.jsonl"
            chmod 0700 "$session_root"
            chmod 0600 "$session_root/transcript.jsonl"
            before=$(stat -c '%u:%g' "$session_root/transcript.jsonl")
            HAPPYCLAW_HOST_IDENTITY_MODE=${mode}
            HAPPYCLAW_SESSION_ROOT="$session_root"
            happyclaw_configure_node_identity
            happyclaw_prepare_mounted_path "$session_root"
            after=$(stat -c '%u:%g' "$session_root/transcript.jsonl")
            happyclaw_relax_session_permissions
            printf '%s:%s:%s:%s' "$before" "$after" "$(stat -c %a "$session_root")" "$(stat -c %a "$session_root/transcript.jsonl")"
          `),
        ).toBe('0:0:0:0:777:666');
      }
    });

    test('keeps host-root agent non-root and prepares only the explicit mount', () => {
      expect(
        runHelper(`
          mounted=$(mktemp -d)
          mkdir "$mounted/nested"
          touch "$mounted/nested/transcript.jsonl"
          HAPPYCLAW_HOST_IDENTITY_MODE=host-root
          happyclaw_configure_node_identity
          happyclaw_prepare_mounted_path "$mounted"
          printf '%s:%s:%s:%s' "$(id -u node)" "$HAPPYCLAW_RECONCILE_SESSION_PERMISSIONS" "$(stat -c %u "$mounted")" "$(stat -c %u "$mounted/nested/transcript.jsonl")"
        `),
      ).toBe('1000:0:1000:1000');
    });

    test('direct-mode cleanup does not widen a private file', () => {
      expect(
        runHelper(`
          session_root=$(mktemp -d)
          touch "$session_root/private.json"
          chmod 0600 "$session_root/private.json"
          HAPPYCLAW_HOST_IDENTITY_MODE=direct
          HAPPYCLAW_HOST_UID=1000
          HAPPYCLAW_HOST_GID=1000
          HAPPYCLAW_SESSION_ROOT="$session_root"
          happyclaw_configure_node_identity
          happyclaw_stop_session_permission_reconciler
          stat -c %a "$session_root/private.json"
        `),
      ).toBe('600');
    });

    test('never follows a session symlink or touches a sibling path', () => {
      expect(
        runHelper(`
          parent=$(mktemp -d)
          session_root="$parent/session"
          mkdir "$session_root"
          touch "$parent/outside" "$session_root/local"
          chmod 0600 "$parent/outside" "$session_root/local"
          ln -s "$parent/outside" "$session_root/outside-link"
          HAPPYCLAW_SESSION_ROOT="$session_root"
          happyclaw_relax_session_permissions
          happyclaw_relax_session_path "$session_root/outside-link"
          printf '%s:%s' "$(stat -c %a "$session_root/local")" "$(stat -c %a "$parent/outside")"
        `),
      ).toBe('666:600');
    });

    test.skipIf(!integrationImageHasInotify)(
      'repairs new files and moved-in subtrees through inotify events',
      () => {
        expect(
          runHelper(`
            session_root=$(mktemp -d)
            HAPPYCLAW_HOST_IDENTITY_MODE=namespaced
            HAPPYCLAW_SESSION_ROOT="$session_root"
            happyclaw_configure_node_identity
            happyclaw_start_session_permission_reconciler
            install -m 0600 /dev/null "$session_root/live.jsonl"
            incoming=$(mktemp -d)
            mkdir -p "$incoming/deep"
            install -m 0600 /dev/null "$incoming/deep/moved.jsonl"
            mv "$incoming" "$session_root/moved"
            for attempt in $(seq 1 250); do
              if [ "$(stat -c %a "$session_root/live.jsonl")" = 666 ] && \
                [ "$(stat -c %a "$session_root/moved/deep/moved.jsonl")" = 666 ]; then
                break
              fi
              sleep 0.02
            done
            result="$(stat -c %a "$session_root/live.jsonl"):$(stat -c %a "$session_root/moved/deep/moved.jsonl")"
            happyclaw_stop_session_permission_reconciler
            printf '%s' "$result"
          `),
        ).toBe('666:666');
      },
      20_000,
    );

    test.skipIf(!integrationImageHasInotify)(
      'does not repeat full-tree scans while a large session is idle or active',
      () => {
        expect(
          runHelper(`
            session_root=$(mktemp -d)
            find_log=$(mktemp)
            wrapper_dir=$(mktemp -d)
            printf '%s\n' '#!/bin/sh' 'printf "%s\\n" "$1" >> "$HAPPYCLAW_FIND_LOG"' 'exec /usr/bin/find "$@"' > "$wrapper_dir/find"
            chmod +x "$wrapper_dir/find"
            for shard in $(seq 1 25); do
              mkdir "$session_root/$shard"
              for item in $(seq 1 100); do
                install -m 0600 /dev/null "$session_root/$shard/$item.jsonl"
              done
            done
            export HAPPYCLAW_FIND_LOG="$find_log"
            export PATH="$wrapper_dir:$PATH"
            HAPPYCLAW_HOST_IDENTITY_MODE=namespaced
            HAPPYCLAW_SESSION_ROOT="$session_root"
            happyclaw_configure_node_identity
            happyclaw_start_session_permission_reconciler
            full_before=$(grep -Fxc "$session_root" "$find_log" || true)
            sleep 2
            full_idle=$(grep -Fxc "$session_root" "$find_log" || true)
            install -m 0600 /dev/null "$session_root/new.jsonl"
            for attempt in $(seq 1 250); do
              [ "$(stat -c %a "$session_root/new.jsonl")" = 666 ] && break
              sleep 0.02
            done
            full_active=$(grep -Fxc "$session_root" "$find_log" || true)
            mode=$(stat -c %a "$session_root/new.jsonl")
            happyclaw_stop_session_permission_reconciler
            printf '%s:%s:%s:%s' "$full_before" "$full_idle" "$full_active" "$mode"
          `),
        ).toBe('1:1:1:666');
      },
      30_000,
    );
  },
);
