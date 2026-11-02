/**
 * Host-mode agent-browser / Chrome must not survive a successful browse.
 *
 * runHostAgent() spawns the runner with detached:true (own process group).
 * The success path must reap browser resources without killing an unrelated
 * background shell job the Agent intentionally left running.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const SHARED_TMP =
  process.env.HAPPYCLAW_HOST_BROWSER_CLEANUP_DIR ??
  (() => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'happyclaw-host-browser-cleanup-'),
    );
    process.env.HAPPYCLAW_HOST_BROWSER_CLEANUP_DIR = dir;
    return dir;
  })();

const FAKE_RUNNER = path.join(SHARED_TMP, 'fake-host-browse-runner.mjs');
const BIN_DIR = path.join(SHARED_TMP, 'bin');

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  return {
    ...real,
    spawn: ((
      command: string,
      args?: readonly string[] | string,
      options?: object,
    ) => {
      const dir = process.env.HAPPYCLAW_HOST_BROWSER_CLEANUP_DIR;
      const runner = dir ? path.join(dir, 'fake-host-browse-runner.mjs') : '';
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
  const root = process.env.HAPPYCLAW_HOST_BROWSER_CLEANUP_DIR!;
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

vi.mock('../src/macos-keychain-credentials.js', () => ({
  removeClaudeKeychainOAuth: async () => {},
  syncClaudeKeychainOAuth: async (
    _dir: string,
    payload: { claudeAiOauth?: unknown },
  ) => payload.claudeAiOauth,
}));

const db = await import('../src/db.js');
const {
  cleanupHostBrowserResources,
  isManagedHostBrowserProcess,
  runHostAgent,
} = await import('../src/container-runner.js');
type HostProcessSnapshot =
  import('../src/container-runner.js').HostProcessSnapshot;

const FOLDER = 'host-browser-cleanup';
const livePids = new Set<number>();

function writeFakeBrowseRunner(): void {
  fs.mkdirSync(BIN_DIR, { recursive: true });
  const chromeShim = path.join(BIN_DIR, 'Google Chrome');
  const agentBrowserShim = path.join(BIN_DIR, 'agent-browser');
  const shimSource = `#!/usr/bin/env node
setInterval(() => {}, 60_000);
`;
  fs.writeFileSync(chromeShim, shimSource, { mode: 0o755 });
  fs.writeFileSync(agentBrowserShim, shimSource, { mode: 0o755 });
  fs.writeFileSync(
    FAKE_RUNNER,
    `import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const token = process.env.HAPPYCLAW_HOST_BROWSER_LEAK_TOKEN;
const binDir = process.env.HAPPYCLAW_HOST_BROWSER_BIN;
const pidFile = process.env.HAPPYCLAW_HOST_BROWSER_PID_FILE;
const chrome = spawn(
  process.execPath,
  [
    path.join(binDir, 'Google Chrome'),
    '--headless=new',
    '--user-data-dir=' + path.join(binDir, 'chrome-profile'),
    '--happyclaw-host-browse-test=' + token,
  ],
  { stdio: 'ignore', detached: false },
);
const agentBrowser = spawn(
  process.execPath,
  [
    path.join(binDir, 'agent-browser'),
    'open',
    'https://example.com',
    '--happyclaw-host-browse-test=' + token,
  ],
  { stdio: 'ignore', detached: false },
);
const background = spawn(
  '/bin/bash',
  ['-c', 'while true; do sleep 60; done', 'happyclaw-background-' + token],
  { stdio: 'ignore', detached: false },
);
fs.writeFileSync(
  pidFile,
  JSON.stringify({
    chrome: chrome.pid,
    agentBrowser: agentBrowser.pid,
    background: background.pid,
  }),
);
process.stdout.write(
  [
    '---HAPPYCLAW_OUTPUT_START---',
    JSON.stringify({
      status: 'success',
      result: 'opened https://example.com',
    }),
    '---HAPPYCLAW_OUTPUT_END---',
    '',
  ].join('\\n'),
);
process.exit(0);
`,
  );
}

function listLeftoverBrowserProcesses(token: string): {
  pid: number;
  command: string;
}[] {
  const stdout = execFileSync('ps', ['-ax', '-o', 'pid=,args='], {
    encoding: 'utf8',
  });
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.includes(token) &&
        (line.includes('Google Chrome') || line.includes('agent-browser')),
    )
    .map((line) => {
      const pid = Number.parseInt(line, 10);
      return { pid, command: line };
    })
    .filter((row) => Number.isFinite(row.pid) && row.pid > 0);
}

function killLeftovers(token: string): void {
  for (const row of listLeftoverBrowserProcesses(token)) {
    try {
      process.kill(row.pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  for (const pid of livePids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
  livePids.clear();
}

beforeAll(() => {
  fs.mkdirSync(path.join(SHARED_TMP, 'data', 'db'), { recursive: true });
  writeFakeBrowseRunner();
  db.initDatabase();
});

afterEach(() => {
  const token = process.env.HAPPYCLAW_HOST_BROWSER_LEAK_TOKEN;
  if (token) killLeftovers(token);
});

afterAll(() => {
  const token = process.env.HAPPYCLAW_HOST_BROWSER_LEAK_TOKEN;
  if (token) killLeftovers(token);
  try {
    db.closeDatabase();
  } catch {
    // test-only
  }
  fs.rmSync(SHARED_TMP, { recursive: true, force: true });
});

describe('runHostAgent success-path browser cleanup', () => {
  test('successful host-mode browse does not leave agent-browser or Chrome running', async () => {
    const token = randomUUID();
    const pidFile = path.join(SHARED_TMP, `pids-${token}.json`);
    process.env.HAPPYCLAW_HOST_BROWSER_LEAK_TOKEN = token;
    process.env.HAPPYCLAW_HOST_BROWSER_BIN = BIN_DIR;
    process.env.HAPPYCLAW_HOST_BROWSER_PID_FILE = pidFile;

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

    try {
      const result = await runHostAgent(
        {
          name: 'Host browser cleanup',
          folder: FOLDER,
          added_at: '2026-08-21T00:00:00.000Z',
          executionMode: 'host',
          is_home: false,
        },
        {
          prompt: 'browse https://example.com',
          groupFolder: FOLDER,
          chatJid: `web:${FOLDER}#agent:session-1`,
          agentId: 'session-1',
        },
        () => {},
      );

      expect(result, JSON.stringify(result)).toMatchObject({
        status: 'success',
        result: 'opened https://example.com',
      });
      expect(fs.existsSync(pidFile)).toBe(true);
      const started = JSON.parse(fs.readFileSync(pidFile, 'utf8')) as {
        chrome: number;
        agentBrowser: number;
        background: number;
      };
      livePids.add(started.chrome);
      livePids.add(started.agentBrowser);
      livePids.add(started.background);
      expect(started.chrome).toBeGreaterThan(0);
      expect(started.agentBrowser).toBeGreaterThan(0);

      await expect
        .poll(() => listLeftoverBrowserProcesses(token), { timeout: 3_000 })
        .toEqual([]);
      expect(() => process.kill(started.background, 0)).not.toThrow();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('host browser process identity policy', () => {
  test('matches Linux interpreter scripts and macOS app executables', () => {
    expect(
      isManagedHostBrowserProcess({
        executable: '/usr/bin/node',
        argv: [
          '/usr/bin/node',
          '/opt/node_modules/agent-browser/bin/agent-browser.js',
          'open',
        ],
      }),
    ).toBe(true);
    expect(
      isManagedHostBrowserProcess({
        executable:
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        argv: [
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          '--headless=new',
        ],
      }),
    ).toBe(true);
    // macOS `ps` flattens the existing `Google Chrome` shim path without
    // quotes. The process reader must recover that first positional script
    // without treating arbitrary later arguments as process identity.
    const splitChromePath = path.join(BIN_DIR, 'Google Chrome').split(' ');
    expect(splitChromePath).toHaveLength(2);
    expect(
      isManagedHostBrowserProcess({
        executable: process.execPath,
        argv: [process.execPath, ...splitChromePath, '--headless=new'],
      }),
    ).toBe(true);

    const realPrefixScript = path.join(BIN_DIR, 'Google');
    fs.writeFileSync(realPrefixScript, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    try {
      for (const executable of [
        process.execPath,
        '/bin/bash',
        '/usr/bin/python3',
      ]) {
        expect(
          isManagedHostBrowserProcess({
            executable,
            argv: [executable, realPrefixScript, 'Chrome', '--background-job'],
          }),
        ).toBe(false);
      }
    } finally {
      fs.rmSync(realPrefixScript, { force: true });
    }

    for (const argv of [
      ['/bin/bash', '--rcfile', ...splitChromePath, 'worker.sh'],
      ['/bin/bash', '--init-file', ...splitChromePath, 'worker.sh'],
      ['/usr/bin/python3', '-W', ...splitChromePath, 'worker.py'],
      [process.execPath, '--require', ...splitChromePath, 'worker.js'],
    ]) {
      expect(isManagedHostBrowserProcess({ executable: argv[0], argv })).toBe(
        false,
      );
    }
  });

  test('does not match shell/python jobs that only mention agent-browser in arguments', () => {
    expect(
      isManagedHostBrowserProcess({
        executable: '/bin/bash',
        argv: ['/bin/bash', '-c', 'echo agent-browser && sleep 60'],
      }),
    ).toBe(false);
    expect(
      isManagedHostBrowserProcess({
        executable: '/usr/bin/python3',
        argv: [
          '/usr/bin/python3',
          '/tmp/worker.py',
          '--label',
          'agent-browser',
        ],
      }),
    ).toBe(false);
  });

  test('TERM/KILL use one fixed target set and reject PID identity reuse', () => {
    const root: HostProcessSnapshot = {
      pid: 10,
      ppid: 1,
      pgid: 9,
      startIdentity: 'Thu Aug 27 12:00:00 2026',
      executable: '/usr/bin/node',
      argv: ['/usr/bin/node', '/opt/agent-browser/bin/agent-browser.js'],
    };
    const child: HostProcessSnapshot = {
      pid: 11,
      ppid: 10,
      pgid: 9,
      startIdentity: 'Thu Aug 27 12:00:01 2026',
      executable: '/usr/bin/helper',
      argv: ['/usr/bin/helper'],
    };
    const decoy: HostProcessSnapshot = {
      pid: 20,
      ppid: 1,
      pgid: 9,
      startIdentity: 'Thu Aug 27 12:00:02 2026',
      executable: '/bin/bash',
      argv: ['/bin/bash', '-c', 'echo agent-browser'],
    };
    const snapshots: HostProcessSnapshot[][] = [
      [root, child, decoy],
      [root, child, decoy],
      [
        root,
        { ...child, startIdentity: 'Thu Aug 27 12:01:00 2026' },
        decoy,
        {
          ...root,
          pid: 30,
          startIdentity: 'Thu Aug 27 12:01:01 2026',
        },
      ],
    ];
    const signals: Array<[number, NodeJS.Signals]> = [];
    let delayed: (() => void) | undefined;

    expect(
      cleanupHostBrowserResources(9, 1_000, {
        snapshot: () => snapshots.shift() ?? [],
        signal: (pid, signal) => signals.push([pid, signal]),
        schedule: (callback) => {
          delayed = callback;
          return { unref: () => {} };
        },
      }),
    ).toBe(2);
    expect(signals).toEqual([
      [10, 'SIGTERM'],
      [11, 'SIGTERM'],
    ]);

    delayed?.();
    expect(signals).toEqual([
      [10, 'SIGTERM'],
      [11, 'SIGTERM'],
      [10, 'SIGKILL'],
    ]);
  });
});
