import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

// Real database in a temp DATA_DIR. Provider configuration and the account
// model catalog are mocked so the real launch functions run their decision
// branches against ChatGPT configurations.
const tmpRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-session-model-overrides-'),
);

const GATEWAY_URL = 'http://happyclaw-codex-gateway.internal';

const mocks = vi.hoisted(() => ({
  providers: [] as Array<Record<string, unknown>>,
  catalog: { models: [] as Array<Record<string, unknown>>, source: 'builtin' },
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/config.js', async () => {
  const actual =
    await vi.importActual<typeof import('../src/config.js')>(
      '../src/config.js',
    );
  return {
    ...actual,
    DATA_DIR: tmpRoot,
    STORE_DIR: path.join(tmpRoot, 'db'),
    GROUPS_DIR: path.join(tmpRoot, 'groups'),
  };
});

vi.mock('../src/logger.js', () => ({ logger: mocks.logger }));

vi.mock('../src/runtime-config.js', async () => {
  const actual = await vi.importActual<
    typeof import('../src/runtime-config.js')
  >('../src/runtime-config.js');
  return {
    ...actual,
    getProviders: () => mocks.providers,
    getEnabledProviders: () => mocks.providers.filter((p) => p.enabled),
    getContainerEnvConfig: () => ({}),
    getBalancingConfig: () => ({
      strategy: 'failover',
      unhealthyThreshold: 3,
      recoveryIntervalMs: 300_000,
    }),
    resolveProviderById: (id: string) => {
      const provider = mocks.providers.find((p) => p.id === id)!;
      return {
        config: {
          anthropicBaseUrl: provider.anthropicBaseUrl,
          anthropicModel: provider.anthropicModel,
        },
        customEnv: {},
      };
    },
  };
});

vi.mock('../src/codex-gateway/model-catalog-sync.js', async () => {
  const actual = await vi.importActual<
    typeof import('../src/codex-gateway/model-catalog-sync.js')
  >('../src/codex-gateway/model-catalog-sync.js');
  return {
    ...actual,
    listCodexModelsForProvider: () => mocks.catalog,
  };
});

const db = await import('../src/db.ts');
const runner = await import('../src/container-runner.ts');
const overrides = await import('../src/session-model-overrides.ts');
const { applyProviderSwitchToInput } =
  await import('../src/provider-switch-context.ts');
const { providerPool } = await import('../src/provider-pool.ts');

const CATALOG = [
  {
    value: 'gpt-6.1-sol',
    label: 'gpt-6.1-sol',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  },
  {
    value: 'gpt-6-astra',
    label: 'gpt-6-astra',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
  },
  {
    value: 'gpt-6-luna',
    label: 'gpt-6-luna',
    efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
];

function chatGpt(id: string, enabled = true, model = 'gpt-6.1-sol') {
  return {
    id,
    type: 'third_party',
    enabled,
    weight: 1,
    anthropicBaseUrl: GATEWAY_URL,
    anthropicModel: model,
    anthropicAuthToken: `${id}-gateway-identifier`,
    customEnv: {},
    codexOAuthCredentials: { accountId: `acct-${id}`, planType: 'plus' },
  };
}

function thirdParty(id: string, enabled = true) {
  return {
    id,
    type: 'third_party',
    enabled,
    weight: 1,
    anthropicBaseUrl: `https://${id}.example`,
    anthropicModel: `${id}-model`,
    anthropicAuthToken: `${id}-token`,
    customEnv: {},
    codexOAuthCredentials: null,
  };
}

function setProviders(...providers: Array<Record<string, unknown>>) {
  mocks.providers = providers;
  for (const provider of providers)
    providerPool.resetHealth(provider.id as string);
}

function createUser(
  id: string,
  role: 'admin' | 'member',
  permissions: string[] = [],
  status: 'active' | 'disabled' = 'active',
) {
  const now = new Date().toISOString();
  db.createUser({
    id,
    username: id,
    password_hash: 'hash',
    display_name: id,
    role,
    status,
    permissions: permissions as never,
    must_change_password: false,
    created_at: now,
    updated_at: now,
  });
}

/** A session that already ran: bound, recorded on `model`, SDK id present. */
function resumableSession(provider: string, model: string | null) {
  db.setSession('grp', 'sdk-session-1', null);
  db.setSessionProviderId('grp', null, provider);
  db.setSessionModel('grp', null, model);
}

beforeAll(() => {
  db.initDatabase();
  createUser('admin-1', 'admin');
  createUser('ops-1', 'member', ['manage_system_config']);
  createUser('member-1', 'member');
  createUser('retired-ops', 'member', ['manage_system_config'], 'disabled');
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  db.deleteAllSessionsForFolder('grp');
  db.setSessionModelSelection('grp', null, null);
  db.setSessionModelSelection('grp', 'agent-1', null);
  mocks.catalog = { models: CATALOG, source: 'builtin' };
  setProviders(chatGpt('gpt'), thirdParty('glm'));
});

describe('who may pick efforts above the ceiling', () => {
  test('administrators and holders of manage_system_config, while active', () => {
    expect(overrides.canChooseBeyondEffortCeiling('admin-1')).toBe(true);
    expect(overrides.canChooseBeyondEffortCeiling('ops-1')).toBe(true);
    expect(overrides.canChooseBeyondEffortCeiling('member-1')).toBe(false);
    expect(overrides.canChooseBeyondEffortCeiling('retired-ops')).toBe(false);
    expect(overrides.canChooseBeyondEffortCeiling('nobody')).toBe(false);
    expect(overrides.canChooseBeyondEffortCeiling(null)).toBe(false);
  });
});

describe('resolveSessionLaunchOverrides', () => {
  const resolve = () =>
    overrides.resolveSessionLaunchOverrides(
      'grp',
      null,
      mocks.providers[0] as never,
    );

  test('is empty without a choice, for another configuration and off ChatGPT', () => {
    expect(resolve()).toEqual({});
    db.setSessionModelSelection('grp', null, 'gpt', 'ops-1');
    expect(resolve()).toEqual({});
    db.setSessionModelSelection('grp', null, 'glm', 'ops-1', {
      model: 'gpt-6-astra',
    });
    expect(resolve()).toEqual({});
    db.setSessionModelSelection('grp', null, 'gpt', 'ops-1', {
      model: 'gpt-6-astra',
    });
    expect(
      overrides.resolveSessionLaunchOverrides(
        'grp',
        null,
        mocks.providers[1] as never,
      ),
    ).toEqual({});
  });

  test('returns the pinned model and effort', () => {
    db.setSessionModelSelection('grp', null, 'gpt', 'member-1', {
      model: 'gpt-6-astra',
      effort: 'high',
    });
    expect(resolve()).toEqual({ model: 'gpt-6-astra', effort: 'high' });
  });

  test('ultra needs a chooser who may still pick it', () => {
    db.setSessionModelSelection('grp', null, 'gpt', 'ops-1', {
      effort: 'ultra',
    });
    expect(resolve()).toEqual({ effort: 'ultra' });

    db.setSessionModelSelection('grp', null, 'gpt', 'member-1', {
      model: 'gpt-6-astra',
      effort: 'ultra',
    });
    expect(resolve()).toEqual({ model: 'gpt-6-astra' });
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        problems: [{ kind: 'effort_restricted', effort: 'ultra' }],
      }),
      expect.any(String),
    );

    // The chooser lost the permission after choosing.
    db.setSessionModelSelection('grp', null, 'gpt', 'retired-ops', {
      effort: 'ultra',
    });
    expect(resolve()).toEqual({});
    // Nobody recorded: treated as unprivileged.
    db.setSessionModelSelection('grp', null, 'gpt', null, { effort: 'ultra' });
    expect(resolve()).toEqual({});
  });

  test('an effort the model lacks is dropped, the model stays', () => {
    db.setSessionModelSelection('grp', null, 'gpt', 'ops-1', {
      model: 'gpt-6-luna',
      effort: 'ultra',
    });
    expect(resolve()).toEqual({ model: 'gpt-6-luna' });
  });

  test('a model the account list contradicts is dropped, one it cannot judge is kept', () => {
    db.setSessionModelSelection('grp', null, 'gpt', 'ops-1', {
      model: 'gpt-7-new',
      effort: 'high',
    });
    // A fallback catalog may not have the model yet.
    mocks.catalog = { models: CATALOG, source: 'upstream' };
    expect(resolve()).toEqual({ model: 'gpt-7-new', effort: 'high' });
    // The account's own list is authoritative.
    mocks.catalog = { models: CATALOG, source: 'live' };
    expect(resolve()).toEqual({ effort: 'high' });
  });

  test('can stay quiet when it only predicts', () => {
    db.setSessionModelSelection('grp', null, 'gpt', 'member-1', {
      effort: 'ultra',
    });
    overrides.resolveSessionLaunchOverrides(
      'grp',
      null,
      mocks.providers[0] as never,
      { warn: false },
    );
    expect(mocks.logger.warn).not.toHaveBeenCalled();
  });

  test('within another configuration, returns a model its list offers', () => {
    setProviders(chatGpt('gpt'), {
      ...thirdParty('glm'),
      models: [
        { id: 'glm-model' },
        { id: 'glm-air' },
        { id: 'glm-old', hidden: true },
      ],
    });
    const glm = () =>
      overrides.resolveSessionLaunchOverrides(
        'grp',
        null,
        mocks.providers[1] as never,
      );
    db.setSessionModelSelection('grp', null, 'glm', 'member-1', {
      model: 'glm-air',
    });
    expect(glm()).toEqual({ model: 'glm-air' });
    // Left out of the picker, still the conversation's choice.
    db.setSessionModelSelection('grp', null, 'glm', 'member-1', {
      model: 'glm-old',
    });
    expect(glm()).toEqual({ model: 'glm-old' });
    expect(mocks.logger.warn).not.toHaveBeenCalled();
    // An effort goes with a model that takes it...
    setProviders(chatGpt('gpt'), {
      ...thirdParty('glm'),
      models: [{ id: 'glm-model' }, { id: 'glm-air' }, { id: 'glm-5.3' }],
    });
    db.setSessionModelSelection('grp', null, 'glm', 'member-1', {
      model: 'glm-5.3',
      effort: 'high',
    });
    expect(glm()).toEqual({ model: 'glm-5.3', effort: 'high' });
    // ...and is ignored, with a warning, on one that takes none.
    db.setSessionModelSelection('grp', null, 'glm', 'member-1', {
      model: 'glm-air',
      effort: 'high',
    });
    expect(glm()).toEqual({ model: 'glm-air' });
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'glm', effort: 'high' }),
      expect.any(String),
    );
  });

  test('within another configuration, a model it dropped is ignored, quietly when predicting', () => {
    db.setSessionModelSelection('grp', null, 'glm', 'member-1', {
      model: 'glm-air',
    });
    const glm = mocks.providers[1] as never;
    expect(
      overrides.resolveSessionLaunchOverrides('grp', null, glm, {
        warn: false,
      }),
    ).toEqual({});
    expect(mocks.logger.warn).not.toHaveBeenCalled();
    expect(overrides.resolveSessionLaunchOverrides('grp', null, glm)).toEqual(
      {},
    );
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'glm', model: 'glm-air' }),
      expect.any(String),
    );
  });
});

describe('a pinned ChatGPT launch', () => {
  test("an Agent's model is judged against the account catalog", () => {
    const bound = runner.trySelectPoolProvider(
      'grp',
      null,
      'gpt',
      'gpt-6-astra',
    );
    providerPool.releaseSession('gpt');
    expect(bound).toMatchObject({
      profileId: 'gpt',
      chosenModel: 'gpt-6-astra',
      sessionModel: 'gpt-6-astra',
      resolved: { config: { anthropicModel: 'gpt-6-astra' } },
    });
    expect(bound).not.toHaveProperty('sessionEffort');

    // The account's own list rules out a model it does not have.
    mocks.catalog = { models: CATALOG, source: 'live' };
    const stale = runner.trySelectPoolProvider('grp', null, 'gpt', 'gpt-7-new');
    providerPool.releaseSession('gpt');
    expect(stale?.resolved.config.anthropicModel).toBe('gpt-6.1-sol');
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'gpt', model: 'gpt-7-new' }),
      expect.any(String),
    );
  });

  test('a model list never reaches a ChatGPT launch', () => {
    setProviders(
      { ...chatGpt('gpt'), models: [{ id: 'gpt-6.1-sol', effort: 'low' }] },
      thirdParty('glm'),
    );
    db.setSessionModelSelection('grp', null, 'gpt', 'member-1');
    const selected = runner.trySelectPoolProvider('grp', null);
    providerPool.releaseSession('gpt');
    expect(selected?.resolved.customEnv).toEqual({});
  });

  test('runs the pinned model and hands the effort to the gateway lease', () => {
    db.setSessionModelSelection('grp', null, 'gpt', 'ops-1', {
      model: 'gpt-6-astra',
      effort: 'ultra',
    });
    const selected = runner.trySelectPoolProvider('grp', null);
    providerPool.releaseSession('gpt');
    expect(selected).toMatchObject({
      profileId: 'gpt',
      sessionModel: 'gpt-6-astra',
      sessionEffort: 'ultra',
      resolved: {
        config: {
          anthropicModel: 'gpt-6-astra',
          anthropicBaseUrl: GATEWAY_URL,
        },
      },
    });
  });

  test('without a choice it runs the configuration model at its own effort', () => {
    db.setSessionModelSelection('grp', null, 'gpt', 'member-1');
    const selected = runner.trySelectPoolProvider('grp', null);
    providerPool.releaseSession('gpt');
    expect(selected?.resolved.config.anthropicModel).toBe('gpt-6.1-sol');
    expect(selected?.sessionModel).toBe('gpt-6.1-sol');
    expect(selected).not.toHaveProperty('sessionEffort');
  });

  test('legacy model names run as the catalog model the gateway maps them to', () => {
    setProviders(chatGpt('gpt', true, 'gpt-5.1-codex'));
    db.setSessionModelSelection('grp', null, 'gpt', 'member-1');
    const selected = runner.trySelectPoolProvider('grp', null);
    providerPool.releaseSession('gpt');
    expect(selected?.sessionModel).toBe('gpt-6-sol');
  });

  test('does not touch other providers', () => {
    db.setSessionModelSelection('grp', null, 'glm', 'member-1');
    const selected = runner.trySelectPoolProvider('grp', null);
    providerPool.releaseSession('glm');
    expect(selected).toMatchObject({ profileId: 'glm' });
    // Every configuration records the model its session runs on; only a
    // ChatGPT one gets a gateway effort.
    expect(selected).toMatchObject({ sessionModel: 'glm-model' });
    expect(selected).not.toHaveProperty('sessionEffort');
    expect(db.getSessionModel('grp', null)).toBe('glm-model');
  });

  test('records the model beside the provider binding', () => {
    db.setSessionModelSelection('grp', null, 'gpt', 'ops-1', {
      model: 'gpt-6-astra',
    });
    runner.trySelectPoolProvider('grp', null);
    providerPool.releaseSession('gpt');
    expect(db.getSessionProviderId('grp', null)).toBe('gpt');
    expect(db.getSessionModel('grp', null)).toBe('gpt-6-astra');
  });
});

describe('changing the model starts a new session', () => {
  test('a resumable session on another model is reset, one on the same model is not', () => {
    resumableSession('gpt', 'gpt-6.1-sol');
    db.setSessionModelSelection('grp', null, 'gpt', 'ops-1', {
      model: 'gpt-6-astra',
    });
    expect(runner.willClearSessionOnProviderSwitch('grp', null)).toBe(true);
    const switched = runner.trySelectPoolProvider('grp', null);
    providerPool.releaseSession('gpt');
    expect(switched).toMatchObject({
      profileId: 'gpt',
      resetSession: true,
      sessionModel: 'gpt-6-astra',
    });
    expect(mocks.logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: 'gpt' }),
      'Conversation model changed; starting a new session',
    );

    // The same choice again resumes what is there.
    resumableSession('gpt', 'gpt-6-astra');
    expect(runner.willClearSessionOnProviderSwitch('grp', null)).toBe(false);
    const resumed = runner.trySelectPoolProvider('grp', null);
    providerPool.releaseSession('gpt');
    expect(resumed?.resetSession).toBeFalsy();
  });

  test('a change of effort alone never resets anything', () => {
    resumableSession('gpt', 'gpt-6-astra');
    db.setSessionModelSelection('grp', null, 'gpt', 'ops-1', {
      model: 'gpt-6-astra',
      effort: 'ultra',
    });
    expect(runner.willClearSessionOnProviderSwitch('grp', null)).toBe(false);
    const selected = runner.trySelectPoolProvider('grp', null);
    providerPool.releaseSession('gpt');
    expect(selected?.resetSession).toBeFalsy();
    expect(selected?.sessionEffort).toBe('ultra');
  });

  test('a session from before models were tracked ran on the configuration model', () => {
    resumableSession('gpt', null);
    // Picking the configuration's own model changes nothing...
    db.setSessionModelSelection('grp', null, 'gpt', 'ops-1', {
      model: 'gpt-6.1-sol',
    });
    expect(runner.willClearSessionOnProviderSwitch('grp', null)).toBe(false);
    // ...any other model does.
    db.setSessionModelSelection('grp', null, 'gpt', 'ops-1', {
      model: 'gpt-6-luna',
    });
    expect(runner.willClearSessionOnProviderSwitch('grp', null)).toBe(true);
  });

  test('a Session that has no SDK session has nothing to reset', () => {
    db.setSessionProviderId('grp', null, 'gpt');
    db.setSessionModelSelection('grp', null, 'gpt', 'ops-1', {
      model: 'gpt-6-astra',
    });
    expect(runner.willClearSessionOnProviderSwitch('grp', null)).toBe(false);
    const selected = runner.trySelectPoolProvider('grp', null);
    providerPool.releaseSession('gpt');
    expect(selected?.resetSession).toBeFalsy();
    expect(db.getSessionModel('grp', null)).toBe('gpt-6-astra');
  });

  test('going back to the default model is a change too', () => {
    resumableSession('gpt', 'gpt-6-astra');
    db.setSessionModelSelection('grp', null, 'gpt', 'ops-1');
    expect(runner.willClearSessionOnProviderSwitch('grp', null)).toBe(true);
    const selected = runner.trySelectPoolProvider('grp', null);
    providerPool.releaseSession('gpt');
    expect(selected).toMatchObject({
      resetSession: true,
      sessionModel: 'gpt-6.1-sol',
    });
  });

  test('another configuration resets through the provider rule', () => {
    resumableSession('glm', null);
    db.setSessionModelSelection('grp', null, 'gpt', 'ops-1', {
      model: 'gpt-6-astra',
    });
    const selected = runner.trySelectPoolProvider('grp', null);
    providerPool.releaseSession('gpt');
    expect(selected).toMatchObject({
      resetSession: true,
      previousProviderId: 'glm',
      sessionModel: 'gpt-6-astra',
    });
  });

  test('the reset keeps the binding and the model of the new session', () => {
    resumableSession('gpt', 'gpt-6.1-sol');
    db.setSessionModelSelection('grp', null, 'gpt', 'ops-1', {
      model: 'gpt-6-astra',
    });
    const selected = runner.trySelectPoolProvider('grp', null);
    providerPool.releaseSession('gpt');
    const input = applyProviderSwitchToInput(
      {
        prompt: 'continue',
        sessionId: 'sdk-session-1',
        groupFolder: 'grp',
        chatJid: 'web:grp',
      },
      selected,
    );
    expect(input.sessionId).toBeUndefined();
    // deleteSession wiped the row; the new session is bound and recorded again.
    expect(db.getSession('grp', null) || undefined).toBeUndefined();
    expect(db.getSessionProviderId('grp', null)).toBe('gpt');
    expect(db.getSessionModel('grp', null)).toBe('gpt-6-astra');
  });

  test('the reset rebinds the session the launch runs', () => {
    const session = 'session-1';
    db.setSession('grp', 'sdk-session-1', session);
    db.setSessionProviderId('grp', session, 'gpt');
    db.setSessionModel('grp', session, 'gpt-6.1-sol');
    db.setSessionModelSelection('grp', session, 'gpt', 'ops-1', {
      model: 'gpt-6-astra',
    });
    const selected = runner.trySelectPoolProvider('grp', session);
    providerPool.releaseSession('gpt');
    applyProviderSwitchToInput(
      {
        prompt: 'continue',
        sessionId: 'sdk-session-1',
        groupFolder: 'grp',
        chatJid: `web:grp#agent:${session}`,
        agentId: session,
      },
      selected,
    );
    expect(db.getSession('grp', session) || undefined).toBeUndefined();
    expect(db.getSessionProviderId('grp', session)).toBe('gpt');
    expect(db.getSessionModel('grp', session)).toBe('gpt-6-astra');
  });
});

describe('buildCodexSelectionView', () => {
  const view = (
    provider: Record<string, unknown>,
    context: { canExceedCeiling: boolean; agentEffort?: string },
  ) => overrides.buildCodexSelectionView(provider as never, context);

  test('lists the account catalog, each model with the efforts the chooser may pick', () => {
    const result = view(chatGpt('gpt'), { canExceedCeiling: false });
    expect(result.source).toBe('builtin');
    expect(result.needsReauth).toBe(false);
    expect(result.models.map((model) => model.value)).toEqual([
      'gpt-6.1-sol',
      'gpt-6-astra',
      'gpt-6-luna',
    ]);
    expect(result.models[0].efforts).toEqual([
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
    expect(
      view(chatGpt('gpt'), { canExceedCeiling: true }).models[0].efforts,
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  });

  test('"default" is what an unpicked conversation really runs', () => {
    // The configuration's own effort, clamped to each model's levels.
    const provider = {
      ...chatGpt('gpt'),
      customEnv: { CODEX_REASONING_EFFORT: 'ultra' },
    };
    const result = view(provider, { canExceedCeiling: false });
    expect(result.defaultModel).toBe('gpt-6.1-sol');
    // Reported as is even though this chooser could not pick it: it is what runs.
    expect(result.defaultEffort).toBe('ultra');
    // gpt-6-luna has no ultra: the gateway would fall back to its own default.
    expect(result.models.find((m) => m.value === 'gpt-6-luna')).toMatchObject({
      defaultEffort: expect.stringMatching(/^(low|medium|high|xhigh|max)$/),
    });

    // An Agent with an explicit effort takes precedence over the configuration.
    const agent = view(provider, {
      canExceedCeiling: false,
      agentEffort: 'medium',
    });
    expect(agent.defaultEffort).toBe('medium');
    expect(
      agent.models.every((model) => model.defaultEffort === 'medium'),
    ).toBe(true);
  });

  test('names the configuration model after legacy normalization and flags a dead login', () => {
    const provider = {
      ...chatGpt('gpt', true, 'gpt-5.1-codex'),
      codexOAuthLastRefreshError: { kind: 'reauth_required' },
    };
    const result = view(provider, { canExceedCeiling: false });
    expect(result.defaultModel).toBe('gpt-6-sol');
    expect(result.needsReauth).toBe(true);
  });
});
