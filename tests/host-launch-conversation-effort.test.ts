/**
 * A conversation's effort reaches Claude Code through the environment and
 * leaves the Agent profile the runner receives as stored: the runner hashes
 * that profile into the context audit, and the capability preview compares
 * the hash with the stored profile's.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const SHARED_TMP =
  process.env.HAPPYCLAW_HOST_EFFORT_DIR ??
  (() => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'happyclaw-host-effort-'),
    );
    process.env.HAPPYCLAW_HOST_EFFORT_DIR = dir;
    return dir;
  })();
const FAKE_RUNNER = path.join(SHARED_TMP, 'fake-effort-runner.mjs');
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
      const dir = process.env.HAPPYCLAW_HOST_EFFORT_DIR;
      const runner = dir ? path.join(dir, 'fake-effort-runner.mjs') : '';
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
  const root = process.env.HAPPYCLAW_HOST_EFFORT_DIR!;
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
const runtimeConfig = await import('../src/runtime-config.js');
const { runHostAgent } = await import('../src/container-runner.js');
const { hashRuntimePolicy } = await import('../src/run-context-snapshot.js');

const FOLDER = 'host-conversation-effort';
const SESSION = 'session-1';
const DATA_DIR = path.join(SHARED_TMP, 'data');

function writeFakeRunner(): void {
  // Records what Claude Code would be launched with, then answers.
  fs.writeFileSync(
    FAKE_RUNNER,
    `import fs from 'node:fs';
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.writeFileSync(${JSON.stringify(CAPTURE)}, JSON.stringify({
  runtimePolicy: input.agentProfile?.runtimePolicy ?? null,
  effortEnv: process.env.CLAUDE_CODE_EFFORT_LEVEL ?? null,
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
}

async function launch(runtimePolicy: unknown): Promise<unknown> {
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
        name: 'Host conversation effort',
        folder: FOLDER,
        added_at: '2026-10-28T00:00:00.000Z',
        executionMode: 'host',
        is_home: false,
      },
      {
        prompt: 'hello',
        groupFolder: FOLDER,
        chatJid: `web:${FOLDER}#agent:${SESSION}`,
        agentId: SESSION,
        agentProfile: {
          id: 'agent-effort',
          name: 'Agent',
          version: 1,
          isDefault: false,
          identityHash: 'hash',
          identityPrompt: '',
          includeClaudePreset: true,
          runtimePolicy: runtimePolicy as never,
        },
      },
      () => {},
    );
  } finally {
    spy.mockRestore();
  }
}

beforeAll(() => {
  fs.mkdirSync(path.join(DATA_DIR, 'db'), { recursive: true });
  writeFakeRunner();
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

describe("a conversation's effort at launch", () => {
  test("runs Claude Code at it over the Agent's, with the Agent profile as stored", async () => {
    const provider = runtimeConfig.createProvider({
      name: 'Kimi',
      type: 'third_party',
      anthropicBaseUrl: 'https://kimi.example.test',
      anthropicAuthToken: 'kimi-token-123456',
      anthropicModel: 'kimi-k3',
      enabled: true,
    });
    db.setSessionModelSelection(FOLDER, SESSION, provider.id, 'user-1', {
      model: 'kimi-k3',
      effort: 'low',
    });
    const runtimePolicy = db.normalizeAgentProfileRuntimePolicy({
      reasoning: { effort: 'max' },
    });

    const result = await launch(runtimePolicy);
    expect(result, JSON.stringify(result)).toMatchObject({ status: 'success' });
    const saw = JSON.parse(fs.readFileSync(CAPTURE, 'utf8'));
    expect(saw.effortEnv).toBe('low');
    // The hash the runner audits is the stored profile's: no stale preview.
    expect(hashRuntimePolicy(saw.runtimePolicy)).toBe(
      hashRuntimePolicy(runtimePolicy),
    );
  });
});
