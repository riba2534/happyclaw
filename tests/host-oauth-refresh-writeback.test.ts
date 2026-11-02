/**
 * Off macOS, Claude Code refreshes OAuth into the host session's
 * `.credentials.json`. The rotation must be written back to the provider
 * (and fanned out) instead of being overwritten by the stale stored
 * credential on the next launch.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const SHARED_TMP =
  process.env.HAPPYCLAW_HOST_OAUTH_WRITEBACK_DIR ??
  (() => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'happyclaw-host-oauth-writeback-'),
    );
    process.env.HAPPYCLAW_HOST_OAUTH_WRITEBACK_DIR = dir;
    return dir;
  })();
const FAKE_RUNNER = path.join(SHARED_TMP, 'fake-oauth-refresh-runner.mjs');

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  return {
    ...real,
    spawn: ((
      command: string,
      args?: readonly string[] | string,
      options?: object,
    ) => {
      const dir = process.env.HAPPYCLAW_HOST_OAUTH_WRITEBACK_DIR;
      const runner = dir ? path.join(dir, 'fake-oauth-refresh-runner.mjs') : '';
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
  const root = process.env.HAPPYCLAW_HOST_OAUTH_WRITEBACK_DIR!;
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

vi.mock('../src/macos-keychain-credentials.js', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('../src/macos-keychain-credentials.js')
  >()),
  removeClaudeKeychainOAuth: async () => {},
  syncClaudeKeychainOAuth: async (
    _dir: string,
    payload: { claudeAiOauth?: unknown },
  ) => payload.claudeAiOauth,
}));

const db = await import('../src/db.js');
const runtimeConfig = await import('../src/runtime-config.js');
const { runHostAgent } = await import('../src/container-runner.js');

const FOLDER = 'host-oauth-writeback';
const SIBLING = 'host-oauth-sibling';
const SESSION = 'session-1';
const SIBLING_SESSION = 'sibling-session';
const DATA_DIR = path.join(SHARED_TMP, 'data');
const original = {
  accessToken: 'host-access-original',
  refreshToken: 'host-refresh-original',
  expiresAt: Date.now() + 8 * 60 * 60_000,
  scopes: ['user:inference', 'user:profile'],
  subscriptionType: 'max',
};
const rotated = {
  accessToken: 'host-access-rotated',
  refreshToken: 'host-refresh-rotated',
  expiresAt: original.expiresAt + 60 * 60_000,
  scopes: ['user:inference', 'user:profile'],
  subscriptionType: 'max',
};

function writeFakeRunner(): void {
  // Behaves like Claude Code refreshing its own token mid-run.
  fs.writeFileSync(
    FAKE_RUNNER,
    `import fs from 'node:fs';
import path from 'node:path';

const file = path.join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json');
const rotated = process.env.HAPPYCLAW_TEST_ROTATED_OAUTH;
if (rotated) {
  const current = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(
    file,
    JSON.stringify({ ...current, claudeAiOauth: JSON.parse(rotated) }),
  );
}
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
}

async function runOnce(): Promise<unknown> {
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
    return await runHostAgent(
      {
        name: 'Host OAuth write-back',
        folder: FOLDER,
        added_at: '2026-09-02T00:00:00.000Z',
        executionMode: 'host',
        is_home: false,
      },
      {
        prompt: 'hello',
        groupFolder: FOLDER,
        chatJid: `web:${FOLDER}#agent:${SESSION}`,
        agentId: SESSION,
      },
      () => {},
    );
  } finally {
    spy.mockRestore();
  }
}

function sessionClaudeDir(folder: string, agentId: string): string {
  return path.join(DATA_DIR, 'sessions', folder, 'agents', agentId, '.claude');
}

function sessionCredentials(folder: string, agentId: string): unknown {
  return JSON.parse(
    fs.readFileSync(
      path.join(sessionClaudeDir(folder, agentId), '.credentials.json'),
      'utf8',
    ),
  ).claudeAiOauth;
}

beforeAll(() => {
  fs.mkdirSync(path.join(DATA_DIR, 'db'), { recursive: true });
  writeFakeRunner();
  db.initDatabase();
});

afterAll(() => {
  delete process.env.HAPPYCLAW_TEST_ROTATED_OAUTH;
  try {
    db.closeDatabase();
  } catch {
    // test-only
  }
  fs.rmSync(SHARED_TMP, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'darwin')(
  'host-mode OAuth refresh write-back',
  () => {
    test('persists a runner rotation, fans it out, and launches from it next time', async () => {
      const provider = runtimeConfig.createProvider({
        name: 'Host write-back provider',
        type: 'official',
        enabled: true,
        claudeOAuthCredentials: original,
      });
      const siblingDir = sessionClaudeDir(SIBLING, SIBLING_SESSION);
      fs.mkdirSync(siblingDir, { recursive: true });
      runtimeConfig.writeCredentialsFile(
        siblingDir,
        runtimeConfig.providerToConfig(provider),
      );
      db.setSessionProviderId(SIBLING, SIBLING_SESSION, provider.id);
      // The conversation runs on the provider: nothing runs unbound.
      db.setSessionModelSelection(FOLDER, SESSION, provider.id, 'test');

      process.env.HAPPYCLAW_TEST_ROTATED_OAUTH = JSON.stringify(rotated);
      const first = await runOnce();
      expect(first, JSON.stringify(first)).toMatchObject({ status: 'success' });

      expect(
        runtimeConfig.getProviderById(provider.id)?.claudeOAuthCredentials,
      ).toEqual(rotated);
      expect(sessionCredentials(SIBLING, SIBLING_SESSION)).toEqual(rotated);

      delete process.env.HAPPYCLAW_TEST_ROTATED_OAUTH;
      const second = await runOnce();
      expect(second, JSON.stringify(second)).toMatchObject({
        status: 'success',
      });
      expect(sessionCredentials(FOLDER, SESSION)).toEqual(rotated);
    });
  },
);
