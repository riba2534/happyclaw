/**
 * The host tells each Runner it launches how long it tolerates silence (its
 * idle close), so a result held for background work can keep it off with
 * keepalives paced to the configured timeouts.
 *
 * The real launcher, configuration and database run against a child that
 * records the input it was given. No Docker daemon or model endpoint is
 * touched.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-idle-close-'));
const fakeRunner = path.join(root, 'capture.mjs');
const capture = path.join(root, 'input.json');
const home = path.join(root, 'home');
fs.mkdirSync(home);
const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  return {
    ...real,
    spawn: ((command: string, args: string[], options: object) => {
      if (command === 'docker') {
        return real.spawn(process.execPath, [fakeRunner], {
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      }
      if (
        args[0]?.includes(`${path.sep}agent-runner${path.sep}dist${path.sep}`)
      ) {
        return real.spawn(command, [fakeRunner], options);
      }
      return real.spawn(command, args, options);
    }) as typeof real.spawn,
    execFile: ((command: string, ...args: unknown[]) => {
      if (command === 'docker') {
        const callback = args.at(-1) as (...values: unknown[]) => void;
        queueMicrotask(() => callback(null, '[]', ''));
        return {};
      }
      return (real.execFile as (...values: unknown[]) => unknown)(
        command,
        ...args,
      );
    }) as typeof real.execFile,
  };
});
vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: path.join(root, 'data'),
  GROUPS_DIR: path.join(root, 'data', 'groups'),
  STORE_DIR: path.join(root, 'data', 'db'),
  CONTAINER_IMAGE: 'happyclaw-agent:test',
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/macos-keychain-credentials.js', () => ({
  removeClaudeKeychainOAuth: async () => {},
  syncClaudeKeychainOAuth: async (
    _: string,
    value: { claudeAiOauth: unknown },
  ) => value.claudeAiOauth,
}));
vi.mock('../src/agent-capabilities.js', () => ({
  checkHostCapabilities: async () => ({
    available: [],
    missing: [],
    envVars: {},
    resolvedPaths: {},
  }),
  logCapabilityPreflight: () => {},
}));

const db = await import('../src/db.js');
const config = await import('../src/runtime-config.js');
const { runHostAgent, runContainerAgent } =
  await import('../src/container-runner.js');
const { backgroundHoldKeepaliveIntervalMs } =
  await import('../container/agent-runner/src/background-task-drain.js');
const folder = 'idle-close';
const session = 'idle-close-session';

beforeAll(() => {
  fs.writeFileSync(
    fakeRunner,
    `
import fs from 'node:fs';
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
  hostIdleCloseMs: input.hostIdleCloseMs,
}));
console.log('---HAPPYCLAW_OUTPUT_START---');
console.log(JSON.stringify({status:'success', result:'captured'}));
console.log('---HAPPYCLAW_OUTPUT_END---');
`,
  );
  db.initDatabase();
  const providerId = config.createProvider({
    name: 'Connection',
    type: 'third_party',
    anthropicBaseUrl: 'https://connection.example.test',
    anthropicAuthToken: 'test-token',
    anthropicModel: 'test-model',
    enabled: true,
  }).id;
  db.setSessionModelSelection(folder, session, providerId, 'owner');
});

afterAll(() => {
  db.closeDatabase();
  homeSpy.mockRestore();
  fs.rmSync(root, { recursive: true, force: true });
});

async function launch(
  mode: 'host' | 'container',
  containerTimeout?: number,
): Promise<number | undefined> {
  const existsSync = fs.existsSync.bind(fs);
  const exists = vi.spyOn(fs, 'existsSync').mockImplementation((target) => {
    const value = String(target);
    return value.includes(`${path.sep}agent-runner${path.sep}`) &&
      (value.endsWith(`${path.sep}package.json`) ||
        value.endsWith(`${path.sep}index.js`))
      ? true
      : existsSync(target);
  });
  try {
    const run = mode === 'host' ? runHostAgent : runContainerAgent;
    const result = await run(
      {
        name: 'Workspace',
        folder,
        added_at: '2026-11-20',
        executionMode: mode,
        ...(containerTimeout
          ? { containerConfig: { timeout: containerTimeout } }
          : {}),
      },
      {
        prompt: 'capture the input',
        groupFolder: folder,
        chatJid: `web:${folder}#agent:${session}`,
        agentId: session,
      },
      vi.fn(),
    );
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'success' });
    return JSON.parse(fs.readFileSync(capture, 'utf8')).hostIdleCloseMs;
  } finally {
    exists.mockRestore();
  }
}

describe("the host's idle close reaches the Runner", () => {
  test.each(['host', 'container'] as const)(
    '%s: the shorter of the idle and execution timeouts, as configured',
    async (mode) => {
      config.saveSystemSettings({
        idleTimeout: 30 * 60_000,
        containerTimeout: 30 * 60_000,
      });
      const byDefault = await launch(mode);
      expect(byDefault).toBe(30 * 60_000);
      expect(backgroundHoldKeepaliveIntervalMs(byDefault)).toBe(5 * 60_000);

      config.saveSystemSettings({ idleTimeout: 60_000 });
      const shortest = await launch(mode);
      expect(shortest).toBe(60_000);
      expect(backgroundHoldKeepaliveIntervalMs(shortest)).toBe(20_000);

      config.saveSystemSettings({
        idleTimeout: 30 * 60_000,
        containerTimeout: 6 * 60_000,
      });
      expect(await launch(mode)).toBe(6 * 60_000);
      // The workspace's own execution timeout comes first.
      expect(await launch(mode, 3 * 60_000)).toBe(3 * 60_000);
    },
  );
});
