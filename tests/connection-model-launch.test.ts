/**
 * A conversation or an Agent picks a model within a model configuration. The
 * launch runs it, its effort comes from the pick, the Agent or the model's
 * default (none for a model without efforts), and one SDK session runs on one
 * model: a pick or an un-pick starts a new session once, nothing else does.
 *
 * Real configuration file and database in a temp DATA_DIR; the real launch
 * selection and environment builder run.
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'connection-model-launch-'));

const mocks = vi.hoisted(() => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
  CONTAINER_IMAGE: 'happyclaw-agent:test',
  TIMEZONE: 'UTC',
}));
vi.mock('../src/logger.js', () => ({ logger: mocks.logger }));

const runtimeConfig = await import('../src/runtime-config.js');
const db = await import('../src/db.js');
const runner = await import('../src/container-runner.js');
const { applyProviderSwitchToInput } =
  await import('../src/provider-switch-context.js');

const FOLDER = 'model-launch';
const SESSION = 'session-1';
let glm: ReturnType<typeof runtimeConfig.createProvider>;
let kimi: ReturnType<typeof runtimeConfig.createProvider>;
let relay: ReturnType<typeof runtimeConfig.createProvider>;

beforeAll(() => {
  fs.mkdirSync(path.join(root, 'db'), { recursive: true });
  fs.mkdirSync(path.join(root, 'groups', FOLDER), { recursive: true });
  db.initDatabase();
  glm = runtimeConfig.createProvider({
    name: 'GLM',
    type: 'third_party',
    anthropicBaseUrl: 'https://glm.example.test',
    anthropicAuthToken: 'glm-token',
    anthropicModel: 'glm-5',
    models: [
      { id: 'glm-5' },
      { id: 'glm-5-air', efforts: ['low', 'medium'], defaultEffort: 'low' },
      { id: 'glm-5-long', contextWindow: 1_000_000 },
    ],
  });
  kimi = runtimeConfig.createProvider({
    name: 'Kimi',
    type: 'third_party',
    anthropicBaseUrl: 'https://kimi.example.test',
    anthropicAuthToken: 'kimi-token',
    anthropicModel: 'kimi-k3',
    models: [{ id: 'kimi-k3', efforts: ['low', 'high', 'max'] }],
  });
  // A pass-through relay names no model of its own.
  relay = runtimeConfig.createProvider({
    name: 'Relay',
    type: 'third_party',
    anthropicBaseUrl: 'https://relay.example.test',
    anthropicAuthToken: 'relay-token',
    anthropicModel: '',
    models: [{ id: 'relay-a' }],
  });
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  db.deleteAllSessionsForFolder(FOLDER);
  db.setSessionModelSelection(FOLDER, null, null);
  runtimeConfig.saveSystemSettings({ fallbackModel: '' });
});

function pick(modelConfigId: string | null, model?: string, effort?: string) {
  db.setSessionModelSelection(FOLDER, null, modelConfigId, 'user-1', {
    model: model ?? null,
    effort: effort ?? null,
  });
}

type Agent = {
  modelConfigId?: string;
  model?: string;
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
};

function select(agent: Agent = {}) {
  return runner.trySelectPoolProvider(
    FOLDER,
    null,
    agent.modelConfigId,
    agent.model,
    agent.effort,
  )!;
}

function agentProfile(effort: string) {
  return {
    id: 'agent',
    name: 'Agent',
    version: 1,
    isDefault: false,
    identityHash: '',
    identityPrompt: '',
    includeClaudePreset: true,
    runtimePolicy: db.normalizeAgentProfileRuntimePolicy({
      reasoning: { effort },
    }),
  };
}

/** The runner environment a selection launches with. */
function envOf(
  selection: ReturnType<typeof select>,
  profile?: Record<string, unknown>,
): (key: string) => string | undefined {
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
    profile as never,
    undefined,
    { envLines: [], addHostGateway: false },
  );
  const envFile = fs.readFileSync(
    path.join(runner.getContainerRuntimeEnvDir(FOLDER, SESSION), 'env'),
    'utf8',
  );
  return (key) => new RegExp(`^${key}='([^']*)'$`, 'm').exec(envFile)?.[1];
}

let sdkSessions = 0;

/**
 * One turn as the orchestration runs it: predict, select, clear the SDK
 * session when told to, and let the runner store the session it ran on.
 */
function launch(agent: Agent = {}) {
  const predicted = runner.willClearSessionOnProviderSwitch(
    FOLDER,
    null,
    agent.modelConfigId,
    agent.model,
  );
  const selection = select(agent);
  const sessionId = db.getSession(FOLDER, null) || undefined;
  applyProviderSwitchToInput(
    {
      prompt: 'next',
      sessionId,
      groupFolder: FOLDER,
      chatJid: `web:${FOLDER}`,
    },
    selection,
  );
  if (!sessionId || selection.resetSession) {
    sdkSessions += 1;
    db.setSession(FOLDER, `sdk-${sdkSessions}`, null);
  }
  return { predicted, reset: !!selection.resetSession, selection };
}

/** A Session that already ran on `providerId` before models were recorded. */
function legacySession(providerId: string) {
  db.setSession(FOLDER, 'sdk-legacy', null);
  db.setSessionProviderId(FOLDER, null, providerId);
}

describe('a conversation runs the model it picked within its configuration', () => {
  test('the pick replaces the main model, always without [1m]', () => {
    pick(glm.id, 'glm-5-long');
    const selection = select();
    expect(selection).toMatchObject({
      profileId: glm.id,
      chosenModel: 'glm-5-long',
      sessionModel: 'glm-5-long',
      resolved: { config: { anthropicModel: 'glm-5-long' } },
    });

    pick(glm.id);
    expect(select().resolved.config.anthropicModel).toBe('glm-5');
  });

  test('a pick the configuration no longer offers runs its default and says why', () => {
    pick(glm.id, 'glm-4');
    const selection = select();
    expect(selection.resolved.config.anthropicModel).toBe('glm-5');
    expect(selection).not.toHaveProperty('chosenModel');
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: glm.id, model: 'glm-4' }),
      'Conversation model is no longer offered by its configuration; following the configuration default',
    );
  });

  test('a pass-through relay runs the picked model, and none without a pick', () => {
    pick(relay.id, 'relay-a');
    expect(select().resolved.config.anthropicModel).toBe('relay-a');
    pick(relay.id);
    const selection = select();
    expect(selection.sessionModel).toBe('');
    expect(selection.resolved.launchEffort).toBeUndefined();
  });
});

describe('an Agent runs the model it is bound to', () => {
  test('when its binding is what pins the launch', () => {
    const selection = select({ modelConfigId: glm.id, model: 'glm-5-air' });
    expect(selection).toMatchObject({
      profileId: glm.id,
      chosenModel: 'glm-5-air',
      resolved: { config: { anthropicModel: 'glm-5-air' } },
    });
  });

  test('a conversation pick outranks it; one on its own connection without a model keeps its model', () => {
    // Only the effort was picked: the Agent's model stays, and the session.
    legacySession(glm.id);
    db.setSessionModel(FOLDER, null, 'glm-5-air');
    pick(glm.id, undefined, 'medium');
    const sameConnection = launch({
      modelConfigId: glm.id,
      model: 'glm-5-air',
    });
    expect(sameConnection.selection.resolved.config.anthropicModel).toBe(
      'glm-5-air',
    );
    expect(sameConnection.selection.resolved.launchEffort).toBe('medium');
    expect(sameConnection).toMatchObject({ predicted: false, reset: false });
    pick(kimi.id);
    expect(
      select({ modelConfigId: glm.id, model: 'glm-5-air' }).resolved.config
        .anthropicModel,
    ).toBe('kimi-k3');
  });

  test('nothing bound while connections exist fails instead of picking one', () => {
    expect(() => select({ model: 'glm-5-air' })).toThrow(
      /还没有为主 HappyClaw 选择模型/,
    );
  });

  test('a set binding whose connection is gone fails, never moving accounts', () => {
    expect(() => select({ modelConfigId: 'deleted-connection' })).toThrow(
      /^agent_profile_unavailable: 智能体绑定的模型连接已删除或缺少凭据/,
    );
    // A conversation pick that went stale reads as no pick.
    pick('deleted-connection');
    expect(select({ modelConfigId: glm.id }).profileId).toBe(glm.id);
  });

  test("a pass-through relay with no model runs the Agent's explicit effort", () => {
    expect(
      select({ modelConfigId: relay.id, effort: 'high' }).launchEffort,
    ).toBe('high');
    expect(select({ modelConfigId: relay.id }).launchEffort).toBeNull();
    // A named model nothing is known about still takes none.
    pick(relay.id, 'relay-a');
    expect(
      select({ modelConfigId: relay.id, effort: 'high' }).launchEffort,
    ).toBeNull();
  });

  test("only the Agent's own binding reports a dropped Agent model", () => {
    pick(glm.id);
    select({ modelConfigId: glm.id, model: 'glm-4' });
    expect(mocks.logger.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      'Agent model is no longer offered by its configuration; following the configuration default',
    );
  });

  test('the runner is told the launch effort, null for none', () => {
    const tellsNone = select({ modelConfigId: glm.id, effort: 'high' });
    expect(tellsNone.launchEffort).toBeNull();
    const input = {
      prompt: 'next',
      groupFolder: FOLDER,
      chatJid: `web:${FOLDER}`,
      agentId: SESSION,
    };
    expect(runner.prepareLaunchInput(input, tellsNone)).toHaveProperty(
      'launchEffort',
      null,
    );
    // No connection: the runner keeps sending the Agent's own effort.
    expect(runner.prepareLaunchInput(input, null)).not.toHaveProperty(
      'launchEffort',
    );
    const tells = select({ modelConfigId: kimi.id, effort: 'high' });
    expect(tells.launchEffort).toBe('high');
  });

  test('leaving every connection for the Workspace env starts a new session once', () => {
    legacySession(glm.id);
    const left = runner.leaveSessionConnection(FOLDER, null);
    expect(left).toEqual({
      profileId: '',
      previousProviderId: glm.id,
      resetSession: true,
    });
    expect(runner.leaveSessionConnection(FOLDER, null)).toBeNull();
  });

  test('a model the configuration dropped runs its default and says why', () => {
    const selection = select({ modelConfigId: glm.id, model: 'glm-4' });
    expect(selection.resolved.config.anthropicModel).toBe('glm-5');
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: glm.id, model: 'glm-4' }),
      'Agent model is no longer offered by its configuration; following the configuration default',
    );
  });
});

describe('the launch effort', () => {
  test("is the model's default without a pick, written to the environment", () => {
    const selection = select({ modelConfigId: glm.id, model: 'glm-5-air' });
    expect(selection.resolved.launchEffort).toBe('low');
    expect(envOf(selection)('CLAUDE_CODE_EFFORT_LEVEL')).toBe('low');
  });

  test("an Agent's explicit effort wins when the model takes it", () => {
    const agent: Agent = {
      modelConfigId: glm.id,
      model: 'glm-5-air',
      effort: 'medium',
    };
    const selection = select(agent);
    expect(selection.resolved.launchEffort).toBe('medium');
    expect(
      envOf(selection, agentProfile('medium'))('CLAUDE_CODE_EFFORT_LEVEL'),
    ).toBe('medium');
    // Not taken: the model's default runs instead.
    expect(select({ ...agent, effort: 'max' }).resolved.launchEffort).toBe(
      'low',
    );
  });

  test("a conversation's effort wins over the model's and the Agent's", () => {
    pick(kimi.id, 'kimi-k3', 'low');
    const selection = select({ effort: 'max' });
    expect(selection.resolved.launchEffort).toBe('low');
    // Claude Code ranks the environment above the SDK effort the runner
    // passes for the Agent; the profile the runner sees stays as stored.
    const profile = agentProfile('max');
    const stored = JSON.stringify(profile.runtimePolicy);
    expect(envOf(selection, profile)('CLAUDE_CODE_EFFORT_LEVEL')).toBe('low');
    expect(JSON.stringify(profile.runtimePolicy)).toBe(stored);
  });

  test('an effort the model does not take is ignored', () => {
    pick(glm.id, 'glm-5-air', 'high');
    expect(select().resolved.launchEffort).toBe('low');
  });

  test('a model that takes no effort gets none, whatever the connection env says', () => {
    pick(glm.id, 'glm-5');
    const selection = select({ effort: 'high' });
    expect(selection.resolved.launchEffort).toBeUndefined();
    expect(
      envOf(
        {
          ...selection,
          resolved: {
            ...selection.resolved,
            customEnv: {
              ...selection.resolved.customEnv,
              CLAUDE_CODE_EFFORT_LEVEL: 'max',
            },
          },
        },
        agentProfile('high'),
      )('CLAUDE_CODE_EFFORT_LEVEL'),
    ).toBeUndefined();
  });

  test('an effort-only change keeps the SDK session', () => {
    legacySession(kimi.id);
    pick(kimi.id, 'kimi-k3');
    expect(launch()).toMatchObject({ predicted: false, reset: false });
    pick(kimi.id, 'kimi-k3', 'low');
    expect(launch()).toMatchObject({ predicted: false, reset: false });
    pick(kimi.id, 'kimi-k3', 'max');
    expect(launch()).toMatchObject({ predicted: false, reset: false });
    expect(db.getSession(FOLDER, null)).toBe('sdk-legacy');
  });
});

describe('the runner fallback model', () => {
  test('is named for the connection: [1m] when its window needs it', () => {
    runtimeConfig.saveSystemSettings({ fallbackModel: 'glm-5-long' });
    const selection = select({ modelConfigId: glm.id });
    expect(selection.resolved.fallbackModel).toBe('glm-5-long[1m]');
    expect(envOf(selection)('HAPPYCLAW_FALLBACK_MODEL')).toBe('glm-5-long[1m]');
  });
});

describe('one SDK session runs on one model', () => {
  test('a session from before models were recorded keeps its SDK session', () => {
    legacySession(glm.id);
    expect(db.getSessionModel(FOLDER, null)).toBeNull();
    const pinned = launch({ modelConfigId: glm.id });
    expect(pinned).toMatchObject({ predicted: false, reset: false });
    expect(db.getSession(FOLDER, null)).toBe('sdk-legacy');
    expect(db.getSessionModel(FOLDER, null)).toBe('glm-5');
  });

  test('a pick and an un-pick each start a new session exactly once', () => {
    legacySession(glm.id);
    pick(glm.id);
    const steps: Array<[string, boolean]> = [];
    const turn = (label: string) => {
      const { predicted, reset } = launch({ modelConfigId: glm.id });
      expect(predicted).toBe(reset);
      steps.push([label, reset]);
    };
    turn('the configuration default, as before');
    pick(glm.id, 'glm-5-air');
    turn('picked');
    turn('picked again');
    pick(glm.id);
    turn('back to the default');
    turn('default again');
    pick(glm.id, 'glm-5-air');
    turn('picked once more');
    pick(null);
    turn('no pick: the Agent binding runs its default');
    turn('binding again');
    expect(steps).toEqual([
      ['the configuration default, as before', false],
      ['picked', true],
      ['picked again', false],
      ['back to the default', true],
      ['default again', false],
      ['picked once more', true],
      ['no pick: the Agent binding runs its default', true],
      ['binding again', false],
    ]);
    expect(db.getSessionModel(FOLDER, null)).toBe('glm-5');
  });

  test('a session recorded with [1m] keeps running: only the window differed', () => {
    legacySession(glm.id);
    db.setSessionModel(FOLDER, null, 'glm-5[1m]');
    expect(launch({ modelConfigId: glm.id })).toMatchObject({
      predicted: false,
      reset: false,
    });
    expect(db.getSession(FOLDER, null)).toBe('sdk-legacy');
    expect(db.getSessionModel(FOLDER, null)).toBe('glm-5');
  });

  test("an Agent's model binding that changes the model starts a new session once", () => {
    legacySession(glm.id);
    const agent = { modelConfigId: glm.id };
    expect(launch(agent)).toMatchObject({ predicted: false, reset: false });
    const bound = { modelConfigId: glm.id, model: 'glm-5-air' };
    expect(launch(bound)).toMatchObject({ predicted: true, reset: true });
    expect(launch(bound)).toMatchObject({ predicted: false, reset: false });
    expect(launch(agent)).toMatchObject({ predicted: true, reset: true });
    expect(launch(agent)).toMatchObject({ predicted: false, reset: false });
  });

  test('another connection starts a new session', () => {
    legacySession(glm.id);
    expect(launch({ modelConfigId: kimi.id })).toMatchObject({
      predicted: true,
      reset: true,
    });
    expect(db.getSessionModel(FOLDER, null)).toBe('kimi-k3');
  });
});
