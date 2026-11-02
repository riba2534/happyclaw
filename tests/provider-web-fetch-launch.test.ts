import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { WebFetchPreflightPolicy } from '../src/runtime-config.js';

// Run the real Launcher/config/DB against a child that records its bootstrap.
// No Docker daemon, model endpoint, native home or Keychain is touched.
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-web-fetch-'));
const fakeRunner = path.join(root, 'capture.mjs');
const capture = path.join(root, 'input.json');
const home = path.join(root, 'home');
fs.mkdirSync(home);
const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
const preparation = vi.hoisted(() => ({
  beforeCapabilities: undefined as (() => void) | undefined,
}));

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
  checkHostCapabilities: async () => {
    preparation.beforeCapabilities?.();
    return { available: [], missing: [], envVars: {}, resolvedPaths: {} };
  },
  logCapabilityPreflight: () => {},
}));

const db = await import('../src/db.js');
const config = await import('../src/runtime-config.js');
const { runHostAgent, runContainerAgent } =
  await import('../src/container-runner.js');
const { webFetchPreflightSettings } =
  await import('../container/agent-runner/src/web-fetch-preflight.js');
const folder = 'connection-policy';
const session = 'connection-session';
let firstId: string;
let secondId: string;

beforeAll(() => {
  fs.writeFileSync(
    fakeRunner,
    `
import fs from 'node:fs';
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
  policy: input.webFetchPreflightPolicy,
  endpoint: process.env.ANTHROPIC_BASE_URL,
}));
console.log('---HAPPYCLAW_OUTPUT_START---');
console.log(JSON.stringify({status:'success', result:'captured'}));
console.log('---HAPPYCLAW_OUTPUT_END---');
`,
  );
  db.initDatabase();
  firstId = config.createProvider({
    name: 'First connection',
    type: 'third_party',
    anthropicBaseUrl: 'https://first.example.test',
    anthropicAuthToken: 'test-first-token',
    anthropicModel: 'first-model',
    enabled: true,
    webFetchPreflightPolicy: 'check',
  }).id;
  secondId = config.createProvider({
    name: 'Selected connection',
    type: 'third_party',
    anthropicBaseUrl: 'https://selected.example.test',
    anthropicAuthToken: 'test-second-token',
    anthropicModel: 'second-model',
    enabled: true,
    webFetchPreflightPolicy: 'skip',
  }).id;
});

afterAll(() => {
  db.closeDatabase();
  homeSpy.mockRestore();
  fs.rmSync(root, { recursive: true, force: true });
});

async function launch(
  mode: 'host' | 'container',
  agentConnection: string | null,
  callerPolicy: WebFetchPreflightPolicy = 'check',
) {
  const existsSync = fs.existsSync.bind(fs);
  const exists = vi.spyOn(fs, 'existsSync').mockImplementation((target) => {
    const value = String(target);
    return value.includes(`${path.sep}agent-runner${path.sep}`) &&
      (value.endsWith(`${path.sep}package.json`) ||
        value.endsWith(`${path.sep}index.js`))
      ? true
      : existsSync(target);
  });
  const selected = vi.fn();
  const input = {
    prompt: 'capture configuration',
    groupFolder: folder,
    chatJid: `web:${folder}#agent:${session}`,
    agentId: session,
    webFetchPreflightPolicy: callerPolicy, // Deliberately stale caller input.
    agentProfile: {
      id: 'profile',
      name: 'Profile',
      version: 1,
      isDefault: false,
      identityHash: 'test-hash',
      identityPrompt: '',
      includeClaudePreset: true,
      modelConfigId: agentConnection,
    },
  };
  try {
    const run = mode === 'host' ? runHostAgent : runContainerAgent;
    const result = await run(
      {
        name: 'Workspace',
        folder,
        added_at: '2026-11-02',
        executionMode: mode,
      },
      input,
      selected,
    );
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'success' });
    expect(input.webFetchPreflightPolicy).toBe(callerPolicy);
    return {
      ...JSON.parse(fs.readFileSync(capture, 'utf8')),
      providerId: selected.mock.calls[0]?.[2],
    };
  } finally {
    exists.mockRestore();
    preparation.beforeCapabilities = undefined;
  }
}

describe('selected connection WebFetch policy at launch', () => {
  test.each(['host', 'container'] as const)(
    '%s uses the session pick, not the first connection or Agent binding',
    async (mode) => {
      db.setSessionModelSelection(folder, session, secondId, 'owner');
      const saw = await launch(mode, firstId);
      expect(saw).toMatchObject({ providerId: secondId, policy: 'skip' });
      expect(webFetchPreflightSettings(saw.policy)).toEqual({
        skipWebFetchPreflight: true,
      });
    },
  );

  test.each(['host', 'container'] as const)(
    '%s follows a changed connection selection',
    async (mode) => {
      db.setSessionModelSelection(folder, session, firstId, 'owner');
      expect(await launch(mode, secondId)).toMatchObject({
        providerId: firstId,
        policy: 'check',
      });
      db.setSessionModelSelection(folder, session, null);
      expect(await launch(mode, secondId)).toMatchObject({
        providerId: secondId,
        policy: 'skip',
      });
    },
  );

  test('host reads policy saved while its selected connection is still preparing', async () => {
    db.setSessionModelSelection(folder, session, secondId, 'owner');
    preparation.beforeCapabilities = () => {
      config.updateProvider(secondId, { webFetchPreflightPolicy: 'check' });
    };
    expect(await launch('host', firstId)).toMatchObject({
      providerId: secondId,
      policy: 'check',
    });
    config.updateProvider(secondId, { webFetchPreflightPolicy: 'skip' });
  });

  test.each(['host', 'container'] as const)(
    '%s workspace env does not borrow a saved connection policy',
    async (mode) => {
      db.setSessionModelSelection(folder, session, null);
      config.saveContainerEnvConfig(folder, {
        anthropicBaseUrl: 'https://workspace.example.test',
        anthropicAuthToken: 'test-workspace-token',
      });
      try {
        expect(await launch(mode, null, 'skip')).toMatchObject({
          providerId: null,
          policy: 'check',
        });
      } finally {
        config.saveContainerEnvConfig(folder, {});
      }
    },
  );

  test.each([
    [undefined, { skipWebFetchPreflight: false }],
    ['check', { skipWebFetchPreflight: false }],
    ['skip', { skipWebFetchPreflight: true }],
  ] as const)(
    'pins %s above the opposite native setting without changing native configuration',
    (policy, expected) => {
      const native = { skipWebFetchPreflight: !expected.skipWebFetchPreflight };
      const settings = webFetchPreflightSettings(policy);
      expect(settings).toEqual(expected);
      expect({ ...native, ...settings }).toEqual(expected);
      expect(native.skipWebFetchPreflight).toBe(
        !expected.skipWebFetchPreflight,
      );
    },
  );

  test('an old serialized inherit input cannot retain a native skip', () => {
    expect(webFetchPreflightSettings('inherit' as never)).toEqual({
      skipWebFetchPreflight: false,
    });
  });
});
