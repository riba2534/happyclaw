/**
 * A launch on a magpie connection whose models came from magpie's list:
 * the reply limit the models declare reaches CLAUDE_CODE_MAX_OUTPUT_TOKENS,
 * a model declared to take no effort runs with thinking off, the global
 * fallback model goes only by a name the connection lists, and tool search
 * is on by default.
 *
 * The models are read from a magpie-shaped list (tests/fixtures/magpie.ts)
 * through the same parser and merge discovery uses; the real configuration
 * file, database, launch selection and environment builder run.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

import { magpieModelList } from './fixtures/magpie.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'magpie-launch-'));

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
  CONTAINER_IMAGE: 'happyclaw-agent:test',
  TIMEZONE: 'UTC',
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const runtimeConfig = await import('../src/runtime-config.js');
const db = await import('../src/db.js');
const runner = await import('../src/container-runner.js');
const { mergeDiscoveredModels, parseModelList } =
  await import('../src/model-providers.js');

const FOLDER = 'magpie-launch';
const SESSION = 'session-1';
let magpie: ReturnType<typeof runtimeConfig.createProvider>;

beforeAll(() => {
  fs.mkdirSync(path.join(root, 'db'), { recursive: true });
  fs.mkdirSync(path.join(root, 'groups', FOLDER), { recursive: true });
  db.initDatabase();
  const { models } = mergeDiscoveredModels(
    [],
    parseModelList(magpieModelList())!,
  );
  magpie = runtimeConfig.createProvider({
    name: 'Magpie',
    type: 'third_party',
    presetId: 'magpie',
    anthropicBaseUrl: 'http://127.0.0.1:3425',
    anthropicAuthToken: 'magpie-gateway-key',
    anthropicModel: 'codex/gpt-5.6-sol',
    models,
  });
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  db.deleteAllSessionsForFolder(FOLDER);
  db.setSessionModelSelection(FOLDER, null, null);
  runtimeConfig.saveSystemSettings({ fallbackModel: '' });
});

function select(model?: string, effort?: 'high') {
  return runner.trySelectPoolProvider(FOLDER, null, magpie.id, model, effort)!;
}

function envOf(selection: ReturnType<typeof select>) {
  runner.buildVolumeMounts(
    {
      name: FOLDER,
      folder: FOLDER,
      added_at: new Date().toISOString(),
    } as never,
    false,
    SESSION,
    false,
    undefined,
    selection.resolved,
    undefined,
    undefined,
    { envLines: [], addHostGateway: false },
  );
  const envFile = fs.readFileSync(
    path.join(runner.getContainerRuntimeEnvDir(FOLDER, SESSION), 'env'),
    'utf8',
  );
  return (key: string) =>
    new RegExp(`^${key}='([^']*)'$`, 'm').exec(envFile)?.[1];
}

const input = {
  prompt: 'next',
  groupFolder: FOLDER,
  chatJid: `web:${FOLDER}`,
  agentId: SESSION,
};

describe('a magpie launch', () => {
  test("the models' declared reply limit becomes CLAUDE_CODE_MAX_OUTPUT_TOKENS", () => {
    // GPT-5.6-Sol declares 128000 on magpie's list.
    expect(envOf(select())('CLAUDE_CODE_MAX_OUTPUT_TOKENS')).toBe('128000');
    // GLM-5 declares 131072: capped at Claude Code's 128K.
    expect(envOf(select('relaya/glm-5'))('CLAUDE_CODE_MAX_OUTPUT_TOKENS')).toBe(
      '128000',
    );
    // DeepSeek Chat declares 8192, below Claude Code's own 32K: left alone.
    expect(
      envOf(select('relaya/deepseek-chat'))('CLAUDE_CODE_MAX_OUTPUT_TOKENS'),
    ).toBeUndefined();
  });

  test('a model declared to take no effort runs without thinking or effort', () => {
    const none = select('relaya/deepseek-chat', 'high');
    expect(none.launchEffort).toBeNull();
    expect(runner.prepareLaunchInput(input, none)).toMatchObject({
      launchEffort: null,
      thinking: 'disabled',
    });
    expect(envOf(none)('CLAUDE_CODE_EFFORT_LEVEL')).toBeUndefined();
    // One that reasons without levels keeps thinking, still with no effort.
    const thinks = select('relaya/glm-5', 'high');
    expect(thinks.launchEffort).toBeNull();
    expect(runner.prepareLaunchInput(input, thinks)).not.toHaveProperty(
      'thinking',
    );
    // A model with levels runs the effort and thinks.
    const sol = select(undefined, 'high');
    expect(sol.launchEffort).toBe('high');
    const prepared = runner.prepareLaunchInput(
      { ...input, thinking: 'disabled' },
      sol,
    );
    expect(prepared).not.toHaveProperty('thinking');
  });

  test('the global fallback goes only by a name the connection lists', () => {
    runtimeConfig.saveSystemSettings({ fallbackModel: 'claude-sonnet-5-5' });
    expect(select().resolved.fallbackModel).toBeUndefined();
    expect(envOf(select())('HAPPYCLAW_FALLBACK_MODEL')).toBeUndefined();
    // Listed: named like the turn's model, `[1m]` for its 202K window.
    runtimeConfig.saveSystemSettings({ fallbackModel: 'relaya/glm-5' });
    expect(envOf(select())('HAPPYCLAW_FALLBACK_MODEL')).toBe(
      'relaya/glm-5[1m]',
    );
  });

  test("the fallback's reply limit counts toward the launch's", () => {
    // GLM-5 declares 131072: the 128K cap still applies.
    runtimeConfig.saveSystemSettings({ fallbackModel: 'relaya/glm-5' });
    expect(envOf(select())('CLAUDE_CODE_MAX_OUTPUT_TOKENS')).toBe('128000');
    // DeepSeek Chat declares 8192: a reply that long might be refused there.
    runtimeConfig.saveSystemSettings({ fallbackModel: 'relaya/deepseek-chat' });
    expect(envOf(select())('CLAUDE_CODE_MAX_OUTPUT_TOKENS')).toBeUndefined();
  });

  test('a reply limit HappyClaw derived is handed to the Runner to pin', () => {
    expect(runner.resolveLaunchMaxOutputTokens(select().resolved, FOLDER)).toBe(
      128_000,
    );
    // A model that declares too little: nothing derived, nothing pinned.
    expect(
      runner.resolveLaunchMaxOutputTokens(
        select('relaya/deepseek-chat').resolved,
        FOLDER,
      ),
    ).toBeUndefined();
    // The connection's own value: written to the env, left to settings.
    const selection = select();
    expect(
      runner.resolveLaunchMaxOutputTokens(
        {
          ...selection.resolved,
          customEnv: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '50000' },
        },
        FOLDER,
      ),
    ).toBeUndefined();
    // The Workspace's own override.
    runtimeConfig.saveContainerEnvConfig(FOLDER, {
      customEnv: { CLAUDE_CODE_MAX_OUTPUT_TOKENS: '40000' },
    });
    expect(
      runner.resolveLaunchMaxOutputTokens(select().resolved, FOLDER),
    ).toBeUndefined();
    runtimeConfig.saveContainerEnvConfig(FOLDER, { customEnv: {} });
    expect(runner.resolveLaunchMaxOutputTokens(undefined, FOLDER)).toBe(
      undefined,
    );
    // Both launch paths hand it over.
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src', 'container-runner.ts'),
      'utf8',
    );
    expect(
      source.match(/maxOutputTokens: resolveLaunchMaxOutputTokens\(/g),
    ).toHaveLength(2);
    expect(source).toContain(
      'maxOutputTokens: resolveLaunchMaxOutputTokens(\n          resolvedProvider,',
    );
    expect(source).toContain(
      'maxOutputTokens: resolveLaunchMaxOutputTokens(\n          hostPoolResult?.resolved,',
    );
  });

  test("the Agent's sub-agent models count toward the launch's reply limit", () => {
    const withSubagents = (model: string | null, defined: string | null) =>
      runner.trySelectPoolProvider(
        FOLDER,
        null,
        magpie.id,
        undefined,
        undefined,
        {
          model,
          max_concurrent: null,
          definitions: [
            {
              name: 'reviewer',
              description: 'Reviews diffs',
              prompt: 'Review.',
              tools: null,
              model: defined,
              effort: null,
            },
          ],
        },
      )!;
    const limitOf = (selection: ReturnType<typeof withSubagents>) => ({
      env: envOf(selection)('CLAUDE_CODE_MAX_OUTPUT_TOKENS'),
      pinned: runner.resolveLaunchMaxOutputTokens(selection.resolved, FOLDER),
    });
    // GLM-5 declares 131072: the 128K cap still applies.
    expect(limitOf(withSubagents(null, 'relaya/glm-5'))).toEqual({
      env: '128000',
      pinned: 128_000,
    });
    // DeepSeek Chat declares 8192: a custom sub-agent on it could be refused
    // a longer reply, so nothing is raised.
    expect(limitOf(withSubagents(null, 'relaya/deepseek-chat'))).toEqual({
      env: undefined,
      pinned: undefined,
    });
    // The same as the default sub-agent model.
    expect(limitOf(withSubagents('relaya/deepseek-chat', null))).toEqual({
      env: undefined,
      pinned: undefined,
    });
    // Which reaches the launch's env, named like the turn's model.
    expect(
      envOf(withSubagents('relaya/glm-5', null))('CLAUDE_CODE_SUBAGENT_MODEL'),
    ).toBe('relaya/glm-5[1m]');
    expect(envOf(select())('CLAUDE_CODE_SUBAGENT_MODEL')).toBe(
      envOf(select())('ANTHROPIC_MODEL'),
    );
  });

  test('tool search is on by default and follows the setting', () => {
    expect(runner.resolveProviderToolSearch(magpie.id)).toBe(true);
    runtimeConfig.updateProvider(magpie.id, { toolSearch: 'off' });
    expect(runner.resolveProviderToolSearch(magpie.id)).toBeUndefined();
    runtimeConfig.updateProvider(magpie.id, { toolSearch: 'default' });
    expect(runner.resolveProviderToolSearch(null)).toBeUndefined();
  });
});
