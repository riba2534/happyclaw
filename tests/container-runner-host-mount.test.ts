import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

const SHARED_TMP =
  process.env.HAPPYCLAW_HOST_MOUNT_RUNNER_TEST_DIR ??
  (() => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'happyclaw-host-mount-runner-'),
    );
    process.env.HAPPYCLAW_HOST_MOUNT_RUNNER_TEST_DIR = dir;
    return dir;
  })();

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  const root = process.env.HAPPYCLAW_HOST_MOUNT_RUNNER_TEST_DIR!;
  return {
    ...real,
    DATA_DIR: path.join(root, 'data'),
    GROUPS_DIR: path.join(root, 'data', 'groups'),
    STORE_DIR: path.join(root, 'data', 'db'),
    MOUNT_ALLOWLIST_PATH: path.join(root, 'mount-allowlist.json'),
    CONTAINER_IMAGE: 'happyclaw-agent:test',
    TIMEZONE: 'UTC',
    MAIN_GROUP_FOLDER: 'main',
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

const db = await import('../src/db.js');
const {
  buildVolumeMounts,
  clearSessionClaudeOAuthFiles,
  workspaceRuntimeCredentialOwnerId,
} = await import('../src/container-runner.js');

const OWNER_ID = 'host-mount-admin';
const ALLOWED_ROOT = path.join(SHARED_TMP, 'allowed');
const OTHER_ROOT = path.join(SHARED_TMP, 'other');
const POLICY_PATH = path.join(SHARED_TMP, 'mount-allowlist.json');
let policyRevision = 0;

function writePolicy(allowedRoot = ALLOWED_ROOT): void {
  fs.writeFileSync(
    POLICY_PATH,
    JSON.stringify({
      allowedRoots: [
        {
          path: allowedRoot,
          allowReadWrite: false,
          description: 'runner test root',
        },
      ],
      blockedPatterns: ['blocked'],
      nonMainReadOnly: true,
    }),
  );
  policyRevision += 1;
  const revisionTime = new Date(1_900_000_000_000 + policyRevision * 1_000);
  fs.utimesSync(POLICY_PATH, revisionTime, revisionTime);
}

function source(name: string): string {
  const directory = path.join(ALLOWED_ROOT, name);
  fs.mkdirSync(directory, { recursive: true });
  return fs.realpathSync(directory);
}

function group(additionalMounts: unknown) {
  return {
    name: 'runtime-mount-workspace',
    folder: 'runtime-mount-workspace',
    added_at: '2026-07-26T00:00:00.000Z',
    created_by: OWNER_ID,
    is_home: false,
    executionMode: 'container',
    containerConfig: { additionalMounts },
  };
}

const SESSION = 'session-1';

function runtimeAdditionalMounts(additionalMounts: unknown) {
  return buildVolumeMounts(
    group(additionalMounts) as any,
    false,
    SESSION,
    false,
  ).filter((mount) => mount.containerPath.startsWith('/workspace/extra/'));
}

beforeAll(() => {
  fs.mkdirSync(path.join(SHARED_TMP, 'data', 'db'), { recursive: true });
  fs.mkdirSync(ALLOWED_ROOT, { recursive: true });
  fs.mkdirSync(OTHER_ROOT, { recursive: true });
  writePolicy();
  db.initDatabase();
  const now = new Date().toISOString();
  db.createUser({
    id: OWNER_ID,
    username: OWNER_ID,
    password_hash: 'not-used',
    display_name: 'Mount Admin',
    role: 'admin',
    status: 'active',
    must_change_password: false,
    created_at: now,
    updated_at: now,
  });
});

beforeEach(() => {
  db.updateUserFields(OWNER_ID, {
    role: 'admin',
    status: 'active',
    disable_reason: null,
    deleted_at: null,
  });
  fs.rmSync(ALLOWED_ROOT, { recursive: true, force: true });
  fs.mkdirSync(ALLOWED_ROOT, { recursive: true });
  writePolicy();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(SHARED_TMP, { recursive: true, force: true });
});

describe.sequential(
  'buildVolumeMounts host-directory runtime authorization',
  () => {
    it('mounts every valid persisted entry with canonical paths and read-only mode', () => {
      const first = source('first');
      const second = source('second');

      expect(
        runtimeAdditionalMounts([
          {
            hostPath: first,
            containerPath: 'project/first',
            readonly: true,
          },
          {
            hostPath: second,
            containerPath: 'second',
            readonly: true,
          },
        ]),
      ).toEqual([
        {
          hostPath: first,
          containerPath: '/workspace/extra/project/first',
          readonly: true,
        },
        {
          hostPath: second,
          containerPath: '/workspace/extra/second',
          readonly: true,
        },
      ]);
    });

    it('rejects old persisted mounts immediately after the owner is downgraded', () => {
      const hostPath = source('downgraded');
      db.updateUserFields(OWNER_ID, { role: 'member' });

      expect(() =>
        runtimeAdditionalMounts([
          { hostPath, containerPath: 'downgraded', readonly: true },
        ]),
      ).toThrow();
    });

    it('rejects old persisted mounts immediately after the owner is disabled', () => {
      const hostPath = source('disabled');
      db.updateUserFields(OWNER_ID, {
        status: 'disabled',
        disable_reason: 'security test',
      });

      expect(() =>
        runtimeAdditionalMounts([
          { hostPath, containerPath: 'disabled', readonly: true },
        ]),
      ).toThrow();
    });

    it('rejects malformed persisted shapes instead of treating them as no mounts', () => {
      expect(() =>
        runtimeAdditionalMounts({
          hostPath: source('wrong-shape'),
          containerPath: 'wrong-shape',
          readonly: true,
        }),
      ).toThrow();
    });

    it('retains malformed raw database config as a runtime safety block', () => {
      const jid = 'web:raw-corrupted-mount-config';
      db.setRegisteredGroup(jid, {
        name: 'raw-corrupted-mount-config',
        folder: 'raw-corrupted-mount-config',
        added_at: '2026-07-26T00:00:00.000Z',
        created_by: OWNER_ID,
        executionMode: 'container',
        is_home: false,
      });

      const rawDb = new Database(
        path.join(SHARED_TMP, 'data', 'db', 'messages.db'),
      );
      try {
        rawDb
          .prepare(
            'UPDATE registered_groups SET container_config = ? WHERE jid = ?',
          )
          .run('{"additionalMounts":[', jid);
      } finally {
        rawDb.close();
      }

      const loaded = db.getRegisteredGroup(jid);
      expect(loaded?.containerConfigError).toBeTruthy();
      expect(() => buildVolumeMounts(loaded!, false, SESSION, false)).toThrow();
    });

    it('does not let a structurally invalid raw database value bypass validation', () => {
      const jid = 'web:raw-wrong-shape-mount-config';
      db.setRegisteredGroup(jid, {
        name: 'raw-wrong-shape-mount-config',
        folder: 'raw-wrong-shape-mount-config',
        added_at: '2026-07-26T00:00:00.000Z',
        created_by: OWNER_ID,
        executionMode: 'container',
        is_home: false,
      });

      const rawDb = new Database(
        path.join(SHARED_TMP, 'data', 'db', 'messages.db'),
      );
      try {
        rawDb
          .prepare(
            'UPDATE registered_groups SET container_config = ? WHERE jid = ?',
          )
          .run(
            JSON.stringify({
              additionalMounts: {
                hostPath: source('raw-shape'),
                containerPath: 'raw-shape',
                readonly: true,
              },
            }),
            jid,
          );
      } finally {
        rawDb.close();
      }

      const loaded = db.getRegisteredGroup(jid);
      expect(() => buildVolumeMounts(loaded!, false, SESSION, false)).toThrow();
    });

    it('re-reads a tightened allowlist without restarting the process', () => {
      const hostPath = source('hot-reload');
      expect(() =>
        runtimeAdditionalMounts([
          { hostPath, containerPath: 'hot-reload', readonly: true },
        ]),
      ).not.toThrow();

      writePolicy(OTHER_ROOT);
      expect(() =>
        runtimeAdditionalMounts([
          { hostPath, containerPath: 'hot-reload', readonly: true },
        ]),
      ).toThrow();
    });

    it('revalidates source existence before every container launch', () => {
      const hostPath = source('deleted');
      fs.rmSync(hostPath, { recursive: true, force: true });

      expect(() =>
        runtimeAdditionalMounts([
          { hostPath, containerPath: 'deleted', readonly: true },
        ]),
      ).toThrow();
    });

    it('revalidates symlinks before every launch and blocks replacement escapes', () => {
      const hostPath = source('replaced');
      fs.rmSync(hostPath, { recursive: true, force: true });
      fs.symlinkSync(OTHER_ROOT, hostPath, 'dir');

      expect(() =>
        runtimeAdditionalMounts([
          { hostPath, containerPath: 'replaced', readonly: true },
        ]),
      ).toThrow();
    });

    it('fails the entire launch when any one mount is invalid', () => {
      const valid = source('valid-half');
      const missing = path.join(ALLOWED_ROOT, 'missing-half');

      expect(() =>
        runtimeAdditionalMounts([
          { hostPath: valid, containerPath: 'valid-half', readonly: true },
          { hostPath: missing, containerPath: 'missing-half', readonly: true },
        ]),
      ).toThrow();
    });

    it('clears stale Docker session OAuth when a workspace API key is explicit', () => {
      const folder = 'runtime-mount-workspace';
      const envDir = path.join(SHARED_TMP, 'data', 'config', 'container-env');
      const sessionDir = path.join(
        SHARED_TMP,
        'data',
        'sessions',
        folder,
        'agents',
        SESSION,
        '.claude',
      );
      fs.mkdirSync(envDir, { recursive: true });
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(
        path.join(envDir, `${folder}.json`),
        JSON.stringify({ anthropicApiKey: 'workspace-key' }),
      );
      fs.writeFileSync(
        path.join(sessionDir, '.claude.json'),
        JSON.stringify({
          userID: 'stable-device',
          oauthAccount: { id: 'old' },
        }),
      );
      fs.writeFileSync(
        path.join(sessionDir, '.credentials.json'),
        JSON.stringify({ claudeAiOauth: { accessToken: 'old' } }),
      );

      buildVolumeMounts(group([]) as any, false, SESSION, false);

      expect(
        JSON.parse(
          fs.readFileSync(path.join(sessionDir, '.claude.json'), 'utf8'),
        ),
      ).toEqual({ userID: 'stable-device' });
      expect(fs.existsSync(path.join(sessionDir, '.credentials.json'))).toBe(
        false,
      );
      fs.unlinkSync(path.join(envDir, `${folder}.json`));
    });

    it('materializes a host session without mutating global OAuth and uses a stable Keychain owner', () => {
      const hostRoot = path.join(SHARED_TMP, 'host-auth-test');
      const sessionDir = path.join(hostRoot, 'session');
      const globalClaudeJson = path.join(hostRoot, '.claude.json');
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(
        globalClaudeJson,
        JSON.stringify({ userID: 'host-device', oauthAccount: { id: 'old' } }),
      );
      fs.symlinkSync(globalClaudeJson, path.join(sessionDir, '.claude.json'));
      fs.writeFileSync(path.join(sessionDir, '.credentials.json'), '{}');

      clearSessionClaudeOAuthFiles(sessionDir, globalClaudeJson);

      expect(
        JSON.parse(fs.readFileSync(globalClaudeJson, 'utf8')).oauthAccount,
      ).toEqual({ id: 'old' });
      expect(
        JSON.parse(
          fs.readFileSync(path.join(sessionDir, '.claude.json'), 'utf8'),
        ),
      ).toEqual({ userID: 'host-device' });
      expect(fs.lstatSync(path.join(sessionDir, '.claude.json')).isFile()).toBe(
        true,
      );
      expect(workspaceRuntimeCredentialOwnerId('runtime-mount-workspace')).toBe(
        'runtime-workspace-auth:runtime-mount-workspace',
      );

      const runnerSource = fs.readFileSync(
        new URL('../src/container-runner.ts', import.meta.url),
        'utf8',
      );
      expect(runnerSource).toMatch(
        /removeClaudeKeychainOAuth\([\s\S]*workspaceRuntimeCredentialOwnerId\(group\.folder\)/,
      );
    });
  },
);
