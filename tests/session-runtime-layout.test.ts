/**
 * Every launch runs one session, and its runtime directories are that
 * session's own in both execution modes: the Claude directory is
 * sessions/<folder>/agents/<id>/.claude and the IPC root is
 * ipc/<folder>/agents/<id>, with no workspace-level directory beside them
 * and no nested agents/ directory inside the IPC root.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const SHARED_TMP =
  process.env.HAPPYCLAW_SESSION_LAYOUT_DIR ??
  (() => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'happyclaw-session-layout-'),
    );
    process.env.HAPPYCLAW_SESSION_LAYOUT_DIR = dir;
    return dir;
  })();
const FAKE_RUNNER = path.join(SHARED_TMP, 'fake-layout-runner.mjs');
const CAPTURE = path.join(SHARED_TMP, 'runner-saw.json');

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  return {
    ...real,
    spawn: ((
      command: string,
      args?: readonly string[] | string,
      options?: object,
    ) => {
      const dir = process.env.HAPPYCLAW_SESSION_LAYOUT_DIR;
      const runner = dir ? path.join(dir, 'fake-layout-runner.mjs') : '';
      if (
        runner &&
        fs.existsSync(runner) &&
        Array.isArray(args) &&
        typeof args[0] === 'string' &&
        args[0].includes(`${path.sep}agent-runner${path.sep}dist${path.sep}`)
      ) {
        return real.spawn(command, [runner], options);
      }
      return real.spawn(command, args as string[], options);
    }) as typeof real.spawn,
  };
});

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  const root = process.env.HAPPYCLAW_SESSION_LAYOUT_DIR!;
  return {
    ...real,
    DATA_DIR: path.join(root, 'data'),
    GROUPS_DIR: path.join(root, 'data', 'groups'),
    STORE_DIR: path.join(root, 'data', 'db'),
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
    isLevelEnabled: () => false,
  },
}));

vi.mock('../src/agent-capabilities.js', () => ({
  checkHostCapabilities: async () => ({
    available: [],
    missing: [],
    envVars: {},
    resolvedPaths: {},
  }),
  logCapabilityPreflight: () => {},
  resetHostCapabilitiesCache: () => {},
}));

const db = await import('../src/db.js');
const { buildVolumeMounts, runHostAgent, writeGroupsSnapshot } =
  await import('../src/container-runner.js');

const DATA_DIR = path.join(SHARED_TMP, 'data');
const SESSION = 'session-1';

function group(folder: string, executionMode: 'host' | 'container') {
  return {
    name: folder,
    folder,
    added_at: '2026-11-02T00:00:00.000Z',
    executionMode,
    is_home: false,
  };
}

function expectSessionLayout(
  folder: string,
  dirs: { ipc: string; claude: string },
) {
  const ipcRoot = path.join(DATA_DIR, 'ipc', folder, 'agents', SESSION);
  const claudeDir = path.join(
    DATA_DIR,
    'sessions',
    folder,
    'agents',
    SESSION,
    '.claude',
  );
  expect(dirs.ipc).toBe(ipcRoot);
  // Host mode hands Claude Code the resolved path.
  expect(fs.realpathSync(dirs.claude)).toBe(fs.realpathSync(claudeDir));
  expect(fs.readdirSync(ipcRoot).sort()).toEqual([
    'input',
    'messages',
    'tasks',
  ]);
  // Nothing workspace-level sits beside the session directories.
  expect(fs.readdirSync(path.join(DATA_DIR, 'ipc', folder))).toEqual([
    'agents',
  ]);
  expect(fs.readdirSync(path.join(DATA_DIR, 'sessions', folder))).toEqual([
    'agents',
  ]);
}

beforeAll(() => {
  fs.mkdirSync(path.join(DATA_DIR, 'db'), { recursive: true });
  fs.writeFileSync(
    FAKE_RUNNER,
    `import fs from 'node:fs';
fs.readFileSync(0, 'utf8');
fs.writeFileSync(${JSON.stringify(CAPTURE)}, JSON.stringify({
  ipc: process.env.HAPPYCLAW_WORKSPACE_IPC ?? null,
  claude: process.env.CLAUDE_CONFIG_DIR ?? null,
}));
process.stdout.write(
  [
    '---HAPPYCLAW_OUTPUT_START---',
    JSON.stringify({ status: 'success', result: 'done' }),
    '---HAPPYCLAW_OUTPUT_END---',
    '',
  ].join('\\n'),
);
process.exit(0);
`,
  );
  db.initDatabase();
});

afterAll(() => {
  try {
    db.closeDatabase();
  } catch {
    // test-only
  }
  fs.rmSync(SHARED_TMP, { recursive: true, force: true });
});

describe('session runtime layout', () => {
  test('a container launch mounts the session Claude directory, IPC root and env directory', () => {
    const folder = 'layout-container';
    const mounts = buildVolumeMounts(
      group(folder, 'container') as never,
      false,
      SESSION,
    );
    const hostPathOf = (containerPath: string) =>
      mounts.find((mount) => mount.containerPath === containerPath)?.hostPath;

    expectSessionLayout(folder, {
      ipc: hostPathOf('/workspace/ipc')!,
      claude: hostPathOf('/home/node/.claude')!,
    });
    expect(hostPathOf('/workspace/env-dir')).toBe(
      path.join(DATA_DIR, 'env', folder, 'default', 'agents', SESSION),
    );
  });

  test('a host launch runs from the session Claude directory and IPC root', async () => {
    const folder = 'layout-host';
    const existsSync = fs.existsSync.bind(fs);
    const spy = vi.spyOn(fs, 'existsSync').mockImplementation((target) => {
      const value = String(target);
      if (
        value.includes(`${path.sep}agent-runner${path.sep}`) &&
        (value.endsWith(`${path.sep}package.json`) ||
          value.endsWith(`${path.sep}index.js`))
      ) {
        return true;
      }
      return existsSync(target);
    });
    let result: unknown;
    try {
      result = await runHostAgent(
        group(folder, 'host') as never,
        {
          prompt: 'hello',
          groupFolder: folder,
          chatJid: `web:${folder}#agent:${SESSION}`,
          agentId: SESSION,
        },
        () => {},
      );
    } finally {
      spy.mockRestore();
    }
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'success' });

    const saw = JSON.parse(fs.readFileSync(CAPTURE, 'utf8')) as {
      ipc: string;
      claude: string;
    };
    expectSessionLayout(folder, saw);
  });

  test("the available-groups snapshot lands in the session's IPC root", () => {
    const folder = 'layout-snapshot';
    const groups = [
      { jid: 'feishu:oc_a', name: 'A', lastActivity: '', isRegistered: true },
    ];
    writeGroupsSnapshot(folder, SESSION, true, groups);
    const file = path.join(
      DATA_DIR,
      'ipc',
      folder,
      'agents',
      SESSION,
      'available_groups.json',
    );
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).groups).toEqual(groups);
    expect(
      fs.existsSync(
        path.join(DATA_DIR, 'ipc', folder, 'available_groups.json'),
      ),
    ).toBe(false);
  });
});
