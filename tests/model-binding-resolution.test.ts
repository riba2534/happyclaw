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

// Real database in a temp DATA_DIR; the connections are mocked so the order
// runs its actual decision branches.
const tmpRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-model-binding-'),
);

interface MockProvider {
  id: string;
  type: 'third_party' | 'official';
  enabled: boolean;
  anthropicBaseUrl: string;
  anthropicModel: string;
  anthropicAuthToken: string;
  models?: Array<Record<string, unknown>>;
  customEnv: Record<string, string>;
}

const mocks = vi.hoisted(() => ({
  providers: [] as MockProvider[],
  workspaceEnv: {} as Record<string, string>,
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

vi.mock('../src/logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/runtime-config.js', async () => {
  const actual = await vi.importActual<
    typeof import('../src/runtime-config.js')
  >('../src/runtime-config.js');
  return {
    ...actual,
    getProviders: () => mocks.providers,
    getContainerEnvConfig: () => mocks.workspaceEnv,
    resolveProviderById: (id: string) => {
      const p = mocks.providers.find((item) => item.id === id)!;
      return {
        config: {
          anthropicBaseUrl: p.anthropicBaseUrl,
          anthropicAuthToken: p.anthropicAuthToken,
          anthropicApiKey: '',
          claudeCodeOauthToken: '',
          claudeOAuthCredentials: null,
          anthropicModel: p.anthropicModel,
          updatedAt: null,
        },
        customEnv: p.customEnv,
      };
    },
  };
});

const db = await import('../src/db.ts');
const runner = await import('../src/container-runner.ts');
const { logger } = await import('../src/logger.js');

function provider(id: string, patch: Partial<MockProvider> = {}): MockProvider {
  return {
    id,
    type: 'third_party',
    enabled: true,
    anthropicBaseUrl: `https://${id}.example`,
    anthropicModel: `${id}-model`,
    anthropicAuthToken: `${id}-token`,
    customEnv: {},
    ...patch,
  };
}

const session = { groupFolder: 'grp', agentId: null };
const now = Date.now();

function createUser(id: string, role: 'admin' | 'member', offsetMs: number) {
  const at = new Date(now + offsetMs).toISOString();
  db.createUser({
    id,
    username: id,
    password_hash: 'test-only',
    display_name: id,
    role,
    status: 'active',
    created_at: at,
    updated_at: at,
    must_change_password: false,
  });
  return db.getOrCreateDefaultAgentProfile(id);
}

function bind(
  userId: string,
  modelConfigId: string | null,
  model: string | null = null,
  effort: string = 'inherit',
) {
  const profile = db.getOrCreateDefaultAgentProfile(userId);
  db.updateAgentProfile(profile.id, userId, {
    modelConfigId,
    model,
    runtimePolicy: { reasoning: { effort } } as never,
  });
}

beforeAll(() => {
  db.initDatabase();
  createUser('admin-first', 'admin', 0);
  createUser('admin-later', 'admin', 1000);
  createUser('member', 'member', 2000);
  db.setRegisteredGroup('web:grp', {
    name: 'Workspace',
    folder: 'grp',
    added_at: new Date().toISOString(),
    created_by: 'member',
  });
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  db.setSessionModelSelection('grp', null, null);
  mocks.workspaceEnv = {};
  mocks.providers = [provider('A'), provider('B'), provider('C')];
  bind('admin-first', null);
  bind('admin-later', null);
  bind('member', null);
});

const resolve = (agentConfigId: string | null = null, agentModel?: string) => {
  const binding = runner.resolveModelBinding(
    { modelConfigId: agentConfigId, model: agentModel ?? null },
    session,
  );
  return { source: binding.source, id: binding.provider?.id ?? null };
};

describe('resolveModelBinding', () => {
  test('session → agent → workspace env → owner main → system main → none', () => {
    bind('admin-first', 'C', 'C-model');
    bind('member', 'B');
    db.setSessionModelSelection('grp', null, 'A', 'member');
    expect(resolve('B')).toEqual({ source: 'session', id: 'A' });

    db.setSessionModelSelection('grp', null, null);
    expect(resolve('A')).toEqual({ source: 'agent', id: 'A' });

    mocks.workspaceEnv = { anthropicBaseUrl: 'https://own.example' };
    expect(resolve('A')).toEqual({ source: 'agent', id: 'A' });
    expect(resolve()).toEqual({ source: 'workspace_env', id: null });

    mocks.workspaceEnv = {};
    expect(resolve()).toEqual({ source: 'owner_main', id: 'B' });

    bind('member', null);
    expect(resolve()).toEqual({ source: 'system_main', id: 'C' });

    bind('admin-first', null);
    // A later admin's main Agent is not the system main.
    bind('admin-later', 'A');
    expect(resolve()).toEqual({ source: 'none', id: null });
  });

  test('a stale pick reads as none; a set binding that is gone stops there', () => {
    bind('admin-first', 'C');
    db.setSessionModelSelection('grp', null, 'B', 'member');
    mocks.providers = [
      provider('B', { anthropicAuthToken: '' }),
      provider('C'),
    ];
    const missing = (agentConfigId: string | null) =>
      runner.resolveModelBinding({ modelConfigId: agentConfigId }, session);
    // Session pick B lost its key: back to the default, the Agent's binding,
    // whose connection A was deleted. That is authoritative.
    expect(missing('A')).toMatchObject({
      source: 'agent',
      provider: null,
      modelConfigId: 'A',
      connectionMissing: true,
    });
    expect(runner.modelBindingError(missing('A'))).toMatch(
      /智能体绑定的模型连接已删除或缺少凭据/,
    );
    // An unbound Agent: the owner main names a deleted connection; the system
    // main is not consulted.
    bind('member', 'gone');
    expect(missing(null)).toMatchObject({
      source: 'owner_main',
      modelConfigId: 'gone',
      connectionMissing: true,
    });
    bind('member', null);
    expect(resolve()).toEqual({ source: 'system_main', id: 'C' });
    expect(runner.modelBindingError(missing(null))).toBeNull();
  });

  test('nothing bound is an error only while connections exist', () => {
    const none = runner.resolveModelBinding({}, session);
    expect(none.source).toBe('none');
    expect(runner.modelBindingError(none)).toMatch(/还没有为主 HappyClaw/);
    mocks.providers = [];
    expect(runner.modelBindingError(none)).toBeNull();
  });

  test('a disabled admin stays the system main', () => {
    bind('admin-first', 'C');
    db.updateUserFields('admin-first', { status: 'disabled' } as never);
    try {
      expect(resolve()).toEqual({ source: 'system_main', id: 'C' });
    } finally {
      db.updateUserFields('admin-first', { status: 'active' } as never);
    }
  });

  test('enabled plays no part', () => {
    mocks.providers = [provider('A', { enabled: false }), provider('B')];
    expect(resolve('A')).toEqual({ source: 'agent', id: 'A' });
    // Nothing bound: there is no automatic pool or single-enabled fallback.
    expect(resolve()).toEqual({ source: 'none', id: null });
  });

  test('an inherited connection brings its profile model and effort', () => {
    bind('member', 'B', 'B-other', 'high');
    mocks.providers = [
      provider('B', {
        models: [
          { id: 'B-model' },
          { id: 'B-other', efforts: ['low', 'high'] },
        ],
      }),
    ];
    const binding = runner.resolveModelBinding({}, session);
    expect(binding).toMatchObject({
      source: 'owner_main',
      model: 'B-other',
      inheritedEffort: 'high',
    });
    const summary = runner.summarizeModelBinding(
      binding,
      'grp',
      null,
      undefined,
    );
    expect(summary).toMatchObject({ model: 'B-other', effort: 'high' });
    // The Agent's own effort wins when the model takes it.
    expect(
      runner.summarizeModelBinding(binding, 'grp', null, 'low').effort,
    ).toBe('low');
    // ...and is skipped when it does not.
    expect(
      runner.summarizeModelBinding(binding, 'grp', null, 'max').effort,
    ).toBe('high');
  });

  test('includeSession: false reads what runs without a pick', () => {
    db.setSessionModelSelection('grp', null, 'A', 'member');
    expect(
      runner.resolveModelBinding({ modelConfigId: 'B' }, session, {
        includeSession: false,
      }).source,
    ).toBe('agent');
  });
});

describe('launch effort', () => {
  function launch(model: string, models: Array<Record<string, unknown>>) {
    mocks.providers = [provider('A', { anthropicModel: model, models })];
    return (agentEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max') =>
      runner.trySelectPoolProvider('grp', null, 'A', null, agentEffort)!
        .resolved.launchEffort;
  }

  test('a registry model runs its own default, not max', () => {
    const run = launch('gpt-6.1-sol', []);
    expect(run()).toBe('medium');
    expect(run('xhigh')).toBe('xhigh');
  });

  test('a family member borrows its family efforts', () => {
    const run = launch('gpt-6.1-terra', []);
    expect(run()).toBe('medium');
    expect(run('max')).toBe('max');
  });

  test('declared efforts and default win over the registry', () => {
    const run = launch('gpt-6.1-sol', [
      { id: 'gpt-6.1-sol', efforts: ['low', 'high'], defaultEffort: 'high' },
    ]);
    expect(run()).toBe('high');
    expect(run('max')).toBe('high');
  });

  test('a model nothing is known about runs the Agent’s effort as set, else none', () => {
    const run = launch('mystery-model', []);
    expect(run()).toBeUndefined();
    expect(run('high')).toBe('high');
    expect(run('max')).toBe('max');
  });

  test('a model declared to take none gets no effort, even the Agent’s', () => {
    const run = launch('mystery-model', [{ id: 'mystery-model', efforts: [] }]);
    expect(run()).toBeUndefined();
    expect(run('high')).toBeUndefined();
  });

  test('the env carries exactly the launch effort', () => {
    mocks.providers = [
      provider('A', {
        anthropicModel: 'mystery-model',
        customEnv: { CLAUDE_CODE_EFFORT_LEVEL: 'max' },
      }),
    ];
    const selection = runner.trySelectPoolProvider('grp', null, 'A');
    expect(selection?.resolved.launchEffort).toBeUndefined();
  });

  test('a conversation pick runs its own effort and never [1m]', () => {
    mocks.providers = [
      provider('A', {
        anthropicModel: 'gpt-6.1-sol',
        models: [{ id: 'gpt-6.1-sol' }, { id: 'gpt-6-sol' }],
      }),
    ];
    db.setSessionModelSelection('grp', null, 'A', 'member', {
      model: 'gpt-6-sol[1m]',
      effort: 'low',
    });
    const selection = runner.trySelectPoolProvider('grp', null, null)!;
    expect(selection.chosenModel).toBe('gpt-6-sol');
    expect(selection.resolved.config.anthropicModel).toBe('gpt-6-sol');
    expect(selection.resolved.launchEffort).toBe('low');
  });
});

describe('sub-agent launch', () => {
  const definition = (patch: Record<string, unknown>) => ({
    name: 'reviewer',
    description: 'Reviews diffs',
    prompt: 'Review.',
    tools: null,
    model: null,
    effort: null,
    ...patch,
  });
  const policy = {
    model: 'A-flash',
    max_concurrent: 4,
    definitions: [definition({ model: 'A-pro' })],
  };
  const select = (subagents: unknown, modelConfigId: string | null = 'A') =>
    runner.trySelectPoolProvider(
      'grp',
      null,
      modelConfigId,
      null,
      undefined,
      subagents as never,
    )!;

  beforeEach(() => {
    vi.mocked(logger.warn).mockClear();
    mocks.providers = [
      provider('A', {
        models: [
          { id: 'A-model' },
          { id: 'A-flash' },
          { id: 'A-pro' },
          { id: 'A-known', efforts: ['low', 'high'] },
          { id: 'A-none', efforts: [] },
          { id: 'A-mystery' },
        ],
      }),
      provider('B'),
    ];
  });

  test('on the Agent’s connection its models drive the sub-agents', () => {
    const selection = select(policy);
    expect(selection.resolved.config.subagentModel).toBe('A-flash');
    // The custom sub-agents' models ride along for the reply limit.
    expect(selection.resolved.config.subagentModels).toEqual(['A-pro']);
    expect(selection.subagents).toEqual({
      defaultModel: 'A-flash',
      maxConcurrent: 4,
      agents: {
        reviewer: {
          description: 'Reviews diffs',
          prompt: 'Review.',
          model: 'A-pro',
        },
      },
    });
    const input = runner.prepareLaunchInput(
      { prompt: '', groupFolder: 'grp', chatJid: 'web:grp' } as never,
      selection,
    );
    expect(input.subagents?.agents?.reviewer.model).toBe('A-pro');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  test('a session pick of another connection drops the Agent’s models', () => {
    db.setSessionModelSelection('grp', null, 'B', 'member');
    const selection = select(policy);
    expect(selection.profileId).toBe('B');
    expect(selection.resolved.config.subagentModel).toBeUndefined();
    expect(selection.resolved.config.subagentModels).toBeUndefined();
    expect(selection.subagents?.defaultModel).toBeUndefined();
    expect(selection.subagents?.maxConcurrent).toBe(4);
    expect(selection.subagents?.agents?.reviewer.model).toBeUndefined();
  });

  test('a model the connection dropped follows it, with a warning', () => {
    const selection = select({
      model: 'A-gone',
      max_concurrent: null,
      definitions: [definition({ model: 'A-also-gone' })],
    });
    expect(selection.resolved.config.subagentModel).toBeUndefined();
    expect(selection.subagents?.agents?.reviewer.model).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'A',
        models: ['A-gone', 'A-also-gone'],
      }),
      expect.stringContaining('sub-agent model is no longer offered'),
    );
  });

  test('an effort goes to a sub-agent’s model as it would to the main one', () => {
    const selection = select({
      model: 'A-known',
      max_concurrent: null,
      definitions: [
        definition({ name: 'known-hit', model: 'A-known', effort: 'high' }),
        definition({ name: 'known-miss', model: 'A-known', effort: 'max' }),
        // Declared to take none: none goes.
        definition({ name: 'takes-none', model: 'A-none', effort: 'high' }),
        // Nothing known about it: sent as picked.
        definition({ name: 'unknown', model: 'A-mystery', effort: 'xhigh' }),
        // Runs the default sub-agent model, which takes `low`.
        definition({ name: 'inherits', effort: 'low' }),
        definition({ name: 'inherits-miss', effort: 'max' }),
      ],
    });
    const efforts = Object.fromEntries(
      Object.entries(selection.subagents?.agents ?? {}).map(([name, agent]) => [
        name,
        agent.effort,
      ]),
    );
    expect(efforts).toEqual({
      'known-hit': 'high',
      'known-miss': undefined,
      'takes-none': undefined,
      unknown: 'xhigh',
      inherits: 'low',
      'inherits-miss': undefined,
    });
  });

  test('a sub-agent left with no tool is left out of the launch, with a warning', () => {
    const toolless = {
      model: null,
      max_concurrent: null,
      definitions: [
        definition({ name: 'planner', tools: ['EnterPlanMode'] }),
        definition({ name: 'reader', tools: ['Read'] }),
      ],
    };
    const warned = () =>
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ subagents: ['planner'] }),
        expect.stringContaining('left out of the launch'),
      );
    const selection = select(toolless);
    expect(Object.keys(selection.subagents?.agents ?? {})).toEqual(['reader']);
    warned();
    // Without a connection too.
    vi.mocked(logger.warn).mockClear();
    const input = runner.prepareLaunchInput(
      {
        prompt: '',
        groupFolder: 'grp',
        chatJid: 'web:grp',
        agentProfile: { runtimePolicy: { subagents: toolless } },
      } as never,
      null,
    );
    expect(Object.keys(input.subagents?.agents ?? {})).toEqual(['reader']);
    warned();
  });

  test('an Agent without sub-agent settings launches as before', () => {
    const selection = select(undefined);
    expect(selection).not.toHaveProperty('subagents');
    expect(selection.resolved.config).not.toHaveProperty('subagentModel');
    expect(selection.resolved.config).not.toHaveProperty('subagentModels');
    const input = runner.prepareLaunchInput(
      {
        prompt: '',
        groupFolder: 'grp',
        chatJid: 'web:grp',
        // Left from an earlier launch: replaced, never inherited.
        subagents: { maxConcurrent: 2 },
      } as never,
      selection,
    );
    expect(input).not.toHaveProperty('subagents');
  });

  test('without a connection the definitions and the cap still go', () => {
    const input = runner.prepareLaunchInput(
      {
        prompt: '',
        groupFolder: 'grp',
        chatJid: 'web:grp',
        agentProfile: {
          runtimePolicy: {
            subagents: {
              ...policy,
              definitions: [definition({ model: 'A-pro', effort: 'high' })],
            },
          },
        },
      } as never,
      null,
    );
    expect(input.subagents).toEqual({
      maxConcurrent: 4,
      agents: {
        // No model of the Agent's connection applies; the effort goes as
        // the Agent's own would there.
        reviewer: {
          description: 'Reviews diffs',
          prompt: 'Review.',
          effort: 'high',
        },
      },
    });
  });
});
