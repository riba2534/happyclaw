import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const TEST_ROOT =
  process.env.HAPPYCLAW_MOUNT_SECURITY_STRICT_TEST_DIR ??
  (() => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'happyclaw-mount-security-strict-'),
    );
    process.env.HAPPYCLAW_MOUNT_SECURITY_STRICT_TEST_DIR = dir;
    return dir;
  })();
const allowlistPath = path.join(TEST_ROOT, 'mount-allowlist.json');
const allowedRoot = path.join(TEST_ROOT, 'allowed');
const outsideRoot = path.join(TEST_ROOT, 'outside');

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    MOUNT_ALLOWLIST_PATH: path.join(
      process.env.HAPPYCLAW_MOUNT_SECURITY_STRICT_TEST_DIR!,
      'mount-allowlist.json',
    ),
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

type AllowedRootInput = {
  path: string;
  allowReadWrite: boolean;
  description?: string;
};

function writePolicy(
  roots: AllowedRootInput[],
  blockedPatterns: string[] = ['blocked'],
  storageSources?: unknown[],
): void {
  fs.writeFileSync(
    allowlistPath,
    JSON.stringify({
      allowedRoots: roots,
      blockedPatterns,
      nonMainReadOnly: false,
      ...(storageSources ? { storageSources } : {}),
    }),
  );
}

async function loadStrictValidator() {
  vi.resetModules();
  const security = await import('../src/mount-security.js');
  return {
    validate: security.validateAdditionalMountsStrict,
    ValidationError: security.AdditionalMountValidationError,
  };
}

function mount(
  hostPath: string,
  containerPath: string,
  readonly: boolean = true,
) {
  return { hostPath, containerPath, readonly };
}

beforeAll(() => {
  fs.mkdirSync(allowedRoot, { recursive: true });
  fs.mkdirSync(outsideRoot, { recursive: true });
});

beforeEach(() => {
  fs.rmSync(allowlistPath, { force: true });
});

describe.sequential('validateAdditionalMountsStrict', () => {
  test('returns canonical runtime and persistence forms', async () => {
    const source = path.join(allowedRoot, 'canonical');
    fs.mkdirSync(source, { recursive: true });
    writePolicy([{ path: allowedRoot, allowReadWrite: false }]);
    const { validate } = await loadStrictValidator();

    const result = validate(
      [
        mount(
          path.join(allowedRoot, '..', path.basename(allowedRoot), 'canonical'),
          'project/data',
        ),
      ],
      'canonical-workspace',
      false,
    );

    expect(result).toEqual([
      {
        hostPath: fs.realpathSync(source),
        containerPath: '/workspace/extra/project/data',
        readonly: true,
        persisted: {
          hostPath: fs.realpathSync(source),
          containerPath: 'project/data',
          readonly: true,
        },
      },
    ]);
  });

  test.each([
    null,
    {},
    'mounts',
    [null],
    [{}],
    [{ hostPath: 42, containerPath: 'target', readonly: true }],
    [{ hostPath: allowedRoot, readonly: true }],
    [{ hostPath: allowedRoot, containerPath: 42, readonly: true }],
    [{ hostPath: allowedRoot, containerPath: 'target', readonly: 'yes' }],
    [{ hostPath: allowedRoot, containerPath: 'target', extra: true }],
  ])('rejects malformed persisted shape %#', async (raw) => {
    writePolicy([{ path: allowedRoot, allowReadWrite: false }]);
    const { validate, ValidationError } = await loadStrictValidator();

    expect(() => validate(raw, 'malformed-workspace', false)).toThrow(
      ValidationError,
    );
  });

  test('rejects an invalid allowlist instead of widening access', async () => {
    fs.writeFileSync(
      allowlistPath,
      JSON.stringify({
        allowedRoots: [{ path: allowedRoot, allowReadWrite: 'yes' }],
        blockedPatterns: [],
        nonMainReadOnly: false,
      }),
    );
    const { validate, ValidationError } = await loadStrictValidator();

    expect(() =>
      validate([mount(allowedRoot, 'target')], 'invalid-policy', false),
    ).toThrow(ValidationError);
  });

  test.each(['/proc', '/sys', '/dev', '/run'])(
    'hard-denies privileged source %s even when root is allowlisted',
    async (privilegedPath) => {
      if (!fs.existsSync(privilegedPath)) return;
      writePolicy([{ path: '/', allowReadWrite: true }], []);
      const { validate, ValidationError } = await loadStrictValidator();

      expect(() =>
        validate(
          [mount(privilegedPath, path.basename(privilegedPath))],
          'hard-deny-workspace',
          false,
        ),
      ).toThrow(ValidationError);
    },
  );

  test('rejects read-write instead of silently downgrading it', async () => {
    const source = path.join(allowedRoot, 'readonly-root');
    fs.mkdirSync(source, { recursive: true });
    writePolicy([{ path: allowedRoot, allowReadWrite: false }]);
    const { validate, ValidationError } = await loadStrictValidator();

    expect(() =>
      validate(
        [mount(source, 'readonly-root', false)],
        'readonly-workspace',
        false,
      ),
    ).toThrow(ValidationError);
  });

  test.each([
    ['colon', path.join(allowedRoot, 'colon:name')],
    ['control character', path.join(allowedRoot, 'control\u0007name')],
  ])('rejects a host path containing a %s', async (_label, hostPath) => {
    fs.mkdirSync(hostPath, { recursive: true });
    writePolicy([{ path: allowedRoot, allowReadWrite: false }]);
    const { validate, ValidationError } = await loadStrictValidator();

    expect(() =>
      validate(
        [mount(hostPath, 'unsafe-host-path')],
        'unsafe-host-path-workspace',
        false,
      ),
    ).toThrow(ValidationError);
  });

  test('is all-or-nothing when one of several mounts is invalid', async () => {
    const valid = path.join(allowedRoot, 'valid-in-batch');
    const invalid = path.join(allowedRoot, 'missing-in-batch');
    fs.mkdirSync(valid, { recursive: true });
    fs.rmSync(invalid, { recursive: true, force: true });
    writePolicy([{ path: allowedRoot, allowReadWrite: false }]);
    const { validate, ValidationError } = await loadStrictValidator();

    expect(() =>
      validate(
        [mount(valid, 'valid'), mount(invalid, 'invalid')],
        'atomic-workspace',
        false,
      ),
    ).toThrow(ValidationError);
  });

  test('hot-reloads a tightened allowlist in the same process', async () => {
    const source = path.join(allowedRoot, 'hot-reload');
    fs.mkdirSync(source, { recursive: true });
    writePolicy([{ path: allowedRoot, allowReadWrite: false }]);
    const { validate, ValidationError } = await loadStrictValidator();

    expect(
      validate([mount(source, 'hot-reload')], 'hot-reload-workspace', false),
    ).toHaveLength(1);

    writePolicy([{ path: outsideRoot, allowReadWrite: false }]);
    const future = new Date(Date.now() + 2_000);
    fs.utimesSync(allowlistPath, future, future);

    expect(() =>
      validate([mount(source, 'hot-reload')], 'hot-reload-workspace', false),
    ).toThrow(ValidationError);
  });

  test('revalidation fails after a previously valid directory is deleted', async () => {
    const source = path.join(allowedRoot, 'deleted-after-validation');
    fs.mkdirSync(source, { recursive: true });
    writePolicy([{ path: allowedRoot, allowReadWrite: false }]);
    const { validate, ValidationError } = await loadStrictValidator();
    const mounts = [mount(source, 'deleted')];

    expect(validate(mounts, 'deleted-workspace', false)).toHaveLength(1);
    fs.rmSync(source, { recursive: true, force: true });

    expect(() => validate(mounts, 'deleted-workspace', false)).toThrow(
      ValidationError,
    );
  });

  test('revalidation fails after a directory is replaced by an escaping symlink', async () => {
    const source = path.join(allowedRoot, 'replaced-after-validation');
    const outside = path.join(outsideRoot, 'replacement-target');
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    writePolicy([{ path: allowedRoot, allowReadWrite: false }]);
    const { validate, ValidationError } = await loadStrictValidator();
    const mounts = [mount(source, 'replaced')];

    expect(validate(mounts, 'replaced-workspace', false)).toHaveLength(1);
    fs.rmSync(source, { recursive: true, force: true });
    fs.symlinkSync(outside, source, 'dir');

    expect(() => validate(mounts, 'replaced-workspace', false)).toThrow(
      ValidationError,
    );
  });

  test('resolves a storage-source mount next to a host directory', async () => {
    const source = path.join(allowedRoot, 'beside-storage');
    fs.mkdirSync(source, { recursive: true });
    writePolicy(
      [{ path: allowedRoot, allowReadWrite: false }],
      ['blocked'],
      [
        {
          id: 'nas',
          type: 'nfs',
          server: 'nas.lan',
          exportPath: '/export',
          allowReadWrite: true,
        },
      ],
    );
    const { validate } = await loadStrictValidator();

    expect(
      validate(
        [
          mount(source, 'local'),
          {
            source: 'nas',
            subPath: 'team/a/',
            containerPath: 'nas/team',
            readonly: false,
          },
        ],
        'storage-workspace',
        false,
      )[1],
    ).toEqual({
      hostPath: 'nfs://nas.lan/export/team/a',
      containerPath: '/workspace/extra/nas/team',
      readonly: false,
      storage: {
        type: 'nfs',
        server: 'nas.lan',
        device: '/export/team/a',
        options: 'nfsvers=3,proto=tcp,hard,nolock',
      },
      persisted: {
        source: 'nas',
        subPath: 'team/a',
        containerPath: 'nas/team',
        readonly: false,
      },
    });
  });

  test.each([
    [{ source: 'missing', containerPath: 'x' }],
    [{ source: 'nas', containerPath: 'x', hostPath: '/tmp' }],
    [{ source: 'nas', subPath: '../up', containerPath: 'x' }],
    [{ source: 'nas', containerPath: '/abs' }],
    [{ source: 'nas', subPath: 7, containerPath: 'x' }],
  ])('rejects an invalid storage-source mount %#', async (raw) => {
    writePolicy(
      [{ path: allowedRoot, allowReadWrite: false }],
      ['blocked'],
      [
        {
          id: 'nas',
          type: 'nfs',
          server: 'nas.lan',
          exportPath: '/export',
          allowReadWrite: true,
        },
      ],
    );
    const { validate, ValidationError } = await loadStrictValidator();
    expect(() => validate([raw], 'bad-storage', false)).toThrow(
      ValidationError,
    );
  });

  test('a storage source removed from the allowlist stops old workspaces', async () => {
    const policy = (sources: unknown[]) =>
      writePolicy(
        [{ path: allowedRoot, allowReadWrite: false }],
        ['blocked'],
        sources,
      );
    policy([
      {
        id: 'nas',
        type: 'nfs',
        server: 'nas.lan',
        exportPath: '/e',
        allowReadWrite: false,
      },
    ]);
    const { validate, ValidationError } = await loadStrictValidator();
    const mounts = [{ source: 'nas', containerPath: 'nas' }];
    expect(validate(mounts, 'storage-revoked', false)).toHaveLength(1);
    policy([]);
    expect(() => validate(mounts, 'storage-revoked', false)).toThrow(
      ValidationError,
    );
  });
});
