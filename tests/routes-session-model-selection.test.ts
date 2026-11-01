/**
 * GET/PUT /:jid/model-selection — the chat composer's per-conversation model
 * picker. Reading needs workspace Access, changing it needs Modify; a change
 * drains only the runners of the affected conversation.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const tmpDataDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-session-model-route-'),
);

const mocks = vi.hoisted(() => ({
  userId: 'alice',
  permissions: [] as string[],
  drainCalls: [] as Array<{ jids: string[]; target: string | null }>,
  refresh: vi.fn(),
  chatgptPlan: null as string | null,
  chatgptRefreshError: null as { kind: string } | null,
  workspaceEnv: {} as Record<string, string>,
}));

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    DATA_DIR: tmpDataDir,
    GROUPS_DIR: path.join(tmpDataDir, 'groups'),
    STORE_DIR: path.join(tmpDataDir, 'db'),
  };
});

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

vi.mock('../src/middleware/auth.ts', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    authMiddleware: async (c: any, next: any) => {
      c.set('user', {
        id: mocks.userId,
        username: mocks.userId,
        role: 'member',
        permissions: mocks.permissions,
      });
      return next();
    },
  };
});

vi.mock('../src/web.js', () => ({
  broadcastNewMessage: () => {},
}));

// The picker may ask for a fresher account catalog; it must never wait for one.
vi.mock(
  '../src/codex-gateway/model-catalog-sync.js',
  async (importOriginal) => {
    const real = (await importOriginal()) as Record<string, unknown>;
    return { ...real, maybeRefreshCodexProviderCatalog: mocks.refresh };
  },
);

vi.mock('../src/runtime-config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    getContainerEnvConfig: () => mocks.workspaceEnv,
    getProviders: () => savedProviders(),
  };
});

function savedProviders() {
  return [
    {
      id: 'official',
      name: 'Claude 官方',
      type: 'official',
      enabled: true,
      anthropicModel: 'opus',
      anthropicApiKey: 'sk-ant-key',
      codexOAuthCredentials: null,
    },
    {
      id: 'chatgpt',
      name: 'ChatGPT 订阅',
      type: 'official',
      enabled: true,
      anthropicModel: 'gpt-6-sol',
      anthropicAuthToken: 'gateway-id',
      customEnv: { CODEX_REASONING_EFFORT: 'high' },
      codexOAuthLastRefreshError: mocks.chatgptRefreshError,
      codexOAuthCredentials: {
        accessToken: 'secret',
        accountId: 'acct-1',
        planType: mocks.chatgptPlan,
      },
    },
    {
      id: 'glm',
      name: 'GLM',
      type: 'third_party',
      enabled: false,
      anthropicBaseUrl: 'https://glm.example.test',
      anthropicModel: 'glm-5.3',
      anthropicAuthToken: 'glm-token',
      models: [
        { id: 'glm-5.3', contextWindow: 1_000_000 },
        { id: 'glm-5.3-air', effort: 'low' },
        { id: 'glm-5.3-legacy', hidden: true },
      ],
      codexOAuthCredentials: null,
    },
    {
      id: 'copy',
      name: 'GLM (副本)',
      type: 'third_party',
      enabled: false,
      anthropicModel: 'glm-5.3',
      anthropicAuthToken: '',
      codexOAuthCredentials: null,
    },
  ];
}

const groupRoutes = (await import('../src/routes/groups.js')).default;
const db = await import('../src/db.js');
const webContext = await import('../src/web-context.js');
const { issueCodexGatewayToken, revokeCodexGatewayToken } =
  await import('../src/codex-gateway/runner-tokens.js');

const OWNER_ID = 'alice';
const ADMIN_ID = 'model-selection-admin';

/** Bind a user's main Agent (its default profile) to a connection. */
function bindMain(userId: string, modelConfigId: string | null): void {
  const main = db.getOrCreateDefaultAgentProfile(userId);
  db.updateAgentProfile(main.id, userId, { modelConfigId, model: null });
}

function bindOwnerMain(modelConfigId: string | null): void {
  bindMain(OWNER_ID, modelConfigId);
}
const GROUP_JID = 'web:model-selection-group';
const GROUP_FOLDER = 'model-selection-group';
const AGENT_ID = 'agent-model-1';

async function call(
  method: 'GET' | 'PUT',
  query = '',
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await groupRoutes.request(
    `/${encodeURIComponent(GROUP_JID)}/model-selection${query}`,
    {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
    },
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

beforeAll(() => {
  fs.mkdirSync(path.join(tmpDataDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDataDir, 'groups'), { recursive: true });
  db.initDatabase();
  const at = new Date().toISOString();
  db.createUser({
    id: ADMIN_ID,
    username: ADMIN_ID,
    password_hash: 'test-only',
    display_name: ADMIN_ID,
    role: 'admin',
    status: 'active',
    created_at: at,
    updated_at: at,
    must_change_password: false,
  });
  db.setRegisteredGroup(GROUP_JID, {
    name: 'Model Selection Group',
    folder: GROUP_FOLDER,
    added_at: new Date().toISOString(),
    executionMode: 'container',
    created_by: OWNER_ID,
    is_home: false,
  } as any);
  db.createAgent({
    id: AGENT_ID,
    group_folder: GROUP_FOLDER,
    chat_jid: GROUP_JID,
    name: 'Side conversation',
    prompt: '',
    status: 'idle',
    kind: 'conversation',
    created_by: OWNER_ID,
    created_at: new Date().toISOString(),
    completed_at: null,
    result_summary: null,
    last_im_jid: null,
    spawned_from_jid: null,
  } as any);
  webContext.setWebDeps({
    queue: {
      drainRunnersForModelSelection: (
        jids: string[],
        target: string | null,
      ) => {
        mocks.drainCalls.push({ jids: [...jids], target });
        return 1;
      },
    },
  } as unknown as Parameters<typeof webContext.setWebDeps>[0]);
});

beforeEach(() => {
  mocks.userId = OWNER_ID;
  mocks.permissions = [];
  mocks.chatgptPlan = null;
  mocks.chatgptRefreshError = null;
  bindOwnerMain(null);
  mocks.workspaceEnv = {};
  mocks.drainCalls = [];
  mocks.refresh.mockClear();
  db.setSessionModelSelection(GROUP_FOLDER, null, null);
  db.setSessionModelSelection(GROUP_FOLDER, AGENT_ID, null);
});

afterEach(() => {
  mocks.userId = OWNER_ID;
});

const OPS = ['manage_system_config'];

describe('GET /:jid/model-selection', () => {
  test('lists every saved configuration without secrets and the default', async () => {
    const { status, body } = await call('GET');
    expect(status).toBe(200);
    expect(body.selectedModelConfigId).toBeNull();
    expect(body.selectedModel).toBeNull();
    expect(body.selectedEffort).toBeNull();
    // Nothing is bound: no pool, no single-enabled fallback.
    expect(body.default).toEqual({
      source: 'none',
      modelConfigId: null,
      connectionMissing: false,
      model: null,
      effort: null,
    });
    // A ChatGPT configuration offers its account catalog (`codex`); every
    // other one offers its own model list with what each model takes.
    expect(body.options.map(({ codex, ...option }: any) => option)).toEqual([
      {
        id: 'official',
        name: 'Claude 官方',
        kind: 'official',
        model: 'opus',
        usable: true,
        models: [
          {
            id: 'opus',
            efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
            defaultEffort: 'medium',
            // Only a declared window counts; the registry's is a suggestion.
            contextWindow: null,
            effortsSource: 'registry',
          },
        ],
      },
      {
        id: 'chatgpt',
        name: 'ChatGPT 订阅',
        kind: 'codex',
        model: 'gpt-6-sol',
        usable: true,
      },
      {
        id: 'glm',
        name: 'GLM',
        kind: 'third_party',
        model: 'glm-5.3',
        usable: true,
        models: [
          {
            id: 'glm-5.3',
            efforts: ['low', 'high', 'max'],
            defaultEffort: 'high',
            contextWindow: 1_000_000,
            effortsSource: 'registry',
          },
          // Nothing is known about it: no effort is offered, claimed or sent.
          {
            id: 'glm-5.3-air',
            efforts: [],
            defaultEffort: null,
            contextWindow: null,
            effortsSource: 'none',
          },
          {
            id: 'glm-5.3-legacy',
            efforts: [],
            defaultEffort: null,
            contextWindow: null,
            effortsSource: 'none',
          },
        ],
      },
      {
        id: 'copy',
        name: 'GLM (副本)',
        kind: 'third_party',
        model: 'glm-5.3',
        usable: false,
        models: [
          {
            id: 'glm-5.3',
            efforts: ['low', 'high', 'max'],
            defaultEffort: 'high',
            contextWindow: null,
            effortsSource: 'registry',
          },
        ],
      },
    ]);
    expect(
      body.options
        .filter((option: any) => 'codex' in option)
        .map((o: any) => o.id),
    ).toEqual(['chatgpt']);
    expect(JSON.stringify(body)).not.toContain('secret');
  });

  test("the workspace's Agent binding is what an unselected conversation runs on", async () => {
    bindOwnerMain('glm');
    const { body } = await call('GET');
    // The model's own default effort, never a blanket max.
    expect(body.default).toEqual({
      source: 'agent',
      modelConfigId: 'glm',
      connectionMissing: false,
      model: 'glm-5.3',
      effort: 'high',
    });
    // The bound connection lost its key: the row says so, nothing else runs.
    bindOwnerMain('copy');
    expect((await call('GET')).body.default).toEqual({
      source: 'agent',
      modelConfigId: 'copy',
      connectionMissing: true,
      model: null,
      effort: null,
    });
    expect(body.selectedModelConfigId).toBeNull();
  });

  test('an unbound Agent follows the owner main, then the system main', async () => {
    const custom = db.createAgentProfile({
      ownerUserId: OWNER_ID,
      name: `Unbound ${Math.random()}`,
    });
    db.assignWorkspaceAgentProfile(GROUP_FOLDER, custom.id);
    try {
      bindOwnerMain('official');
      expect((await call('GET')).body.default).toMatchObject({
        source: 'owner_main',
        modelConfigId: 'official',
        model: 'opus',
        effort: 'medium',
      });
      bindOwnerMain(null);
      bindMain(ADMIN_ID, 'glm');
      expect((await call('GET')).body.default).toMatchObject({
        source: 'system_main',
        modelConfigId: 'glm',
      });
    } finally {
      bindMain(ADMIN_ID, null);
      db.deleteWorkspaceAgentProfile(GROUP_FOLDER);
    }
  });

  test('a Workspace that brings its own provider environment outranks inherited bindings', async () => {
    const custom = db.createAgentProfile({
      ownerUserId: OWNER_ID,
      name: `Unbound ${Math.random()}`,
    });
    db.assignWorkspaceAgentProfile(GROUP_FOLDER, custom.id);
    try {
      bindOwnerMain('glm');
      mocks.workspaceEnv = { anthropicBaseUrl: 'https://own.example.test' };
      const { body } = await call('GET');
      expect(body.default).toMatchObject({
        source: 'workspace_env',
        modelConfigId: null,
      });
    } finally {
      db.deleteWorkspaceAgentProfile(GROUP_FOLDER);
    }
  });

  test('a conversation pick is reported next to, not instead of, the default', async () => {
    bindOwnerMain('glm');
    await call('PUT', '', { modelConfigId: 'official' });
    const { body } = await call('GET');
    expect(body.selectedModelConfigId).toBe('official');
    expect(body.default).toMatchObject({
      source: 'agent',
      modelConfigId: 'glm',
    });
  });

  test('offers a ChatGPT account its models, each with the efforts this user may pick', async () => {
    const { body } = await call('GET');
    const codex = body.options.find(
      (option: any) => option.id === 'chatgpt',
    ).codex;
    expect(codex).toMatchObject({
      defaultModel: 'gpt-6-sol',
      // The configuration's own effort, clamped to what its model supports.
      defaultEffort: 'high',
      source: 'builtin',
      needsReauth: false,
    });
    const astra = codex.models.find(
      (model: any) => model.value === 'gpt-6-astra',
    );
    expect(astra).toMatchObject({
      label: expect.stringContaining('gpt-6-astra'),
      // ultra is above the ceiling: not offered, in low to max order.
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      defaultEffort: 'high',
    });
    expect(codex.models.map((model: any) => model.value)).toEqual(
      expect.arrayContaining(['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna']),
    );

    mocks.permissions = OPS;
    const privileged = (await call('GET')).body.options.find(
      (option: any) => option.id === 'chatgpt',
    ).codex;
    expect(
      privileged.models.find((model: any) => model.value === 'gpt-6-astra')
        .efforts,
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
    // A model that never had ultra does not gain it.
    expect(
      privileged.models.find((model: any) => model.value === 'gpt-6-luna')
        .efforts,
    ).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  test('asks for a fresher account list without waiting for it', async () => {
    await call('GET');
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).toHaveBeenCalledWith('chatgpt', {
      accountId: 'acct-1',
    });
  });

  test('narrows the list to the plan and flags a login that has to be redone', async () => {
    mocks.chatgptPlan = 'promax';
    mocks.chatgptRefreshError = { kind: 'reauth_required' };
    const codex = (await call('GET')).body.options.find(
      (option: any) => option.id === 'chatgpt',
    ).codex;
    expect(codex.needsReauth).toBe(true);
    const values = codex.models.map((model: any) => model.value);
    expect(values).toContain('gpt-6.1-sol');
    // promax is not on gpt-6-sol's plan list.
    expect(values).not.toContain('gpt-6-sol');
  });

  test('reports the stored model and effort, reading what the user may not use as unset', async () => {
    db.setSessionModelSelection(GROUP_FOLDER, null, 'chatgpt', OWNER_ID, {
      model: 'gpt-6-astra',
      effort: 'xhigh',
    });
    let { body } = await call('GET');
    expect(body).toMatchObject({
      selectedModelConfigId: 'chatgpt',
      selectedModel: 'gpt-6-astra',
      selectedEffort: 'xhigh',
    });

    // An effort chosen when the user could pick it, and no longer backed.
    db.setSessionModelSelection(GROUP_FOLDER, null, 'chatgpt', OWNER_ID, {
      model: 'gpt-6-astra',
      effort: 'ultra',
    });
    ({ body } = await call('GET'));
    expect(body.selectedModel).toBe('gpt-6-astra');
    expect(body.selectedEffort).toBeNull();
    mocks.permissions = OPS;
    ({ body } = await call('GET'));
    expect(body.selectedEffort).toBe('ultra');
  });

  test('a model the list no longer offers, or an effort the model does not take, reads as unset', async () => {
    // The stale model runs the default, which takes `high`.
    db.setSessionModelSelection(GROUP_FOLDER, null, 'glm', OWNER_ID, {
      model: 'gpt-6-astra',
      effort: 'high',
    });
    expect((await call('GET')).body).toMatchObject({
      selectedModelConfigId: 'glm',
      selectedModel: null,
      selectedEffort: 'high',
    });
    db.setSessionModelSelection(GROUP_FOLDER, null, 'glm', OWNER_ID, {
      model: 'glm-5.3-air',
      effort: 'high',
    });
    expect((await call('GET')).body).toMatchObject({
      selectedModel: 'glm-5.3-air',
      selectedEffort: null,
    });
  });

  test('hides another account’s workspace', async () => {
    mocks.userId = 'mallory';
    expect((await call('GET')).status).toBe(404);
  });

  test('rejects a session from another workspace', async () => {
    expect((await call('GET', '?agentId=missing')).status).toBe(404);
  });
});

describe('PUT /:jid/model-selection', () => {
  test('pins the main conversation and drains its runners', async () => {
    const { status, body } = await call('PUT', '', { modelConfigId: 'glm' });
    expect(status).toBe(200);
    expect(body.selectedModelConfigId).toBe('glm');
    expect(db.getSessionModelSelection(GROUP_FOLDER, null)).toBe('glm');
    expect(mocks.drainCalls).toEqual([{ jids: [GROUP_JID], target: 'glm' }]);
  });

  test('pins only the addressed Runtime Session', async () => {
    const { status } = await call('PUT', '', {
      agentId: AGENT_ID,
      modelConfigId: 'chatgpt',
    });
    expect(status).toBe(200);
    expect(db.getSessionModelSelection(GROUP_FOLDER, AGENT_ID)).toBe('chatgpt');
    expect(db.getSessionModelSelection(GROUP_FOLDER, null)).toBeNull();
    expect(mocks.drainCalls).toEqual([
      { jids: [`${GROUP_JID}#agent:${AGENT_ID}`], target: 'chatgpt' },
    ]);
    const { body } = await call('GET', `?agentId=${AGENT_ID}`);
    expect(body.selectedModelConfigId).toBe('chatgpt');
  });

  test('null returns to the default; repeating a choice drains nothing', async () => {
    await call('PUT', '', { modelConfigId: 'official' });
    await call('PUT', '', { modelConfigId: 'official' });
    expect(mocks.drainCalls).toHaveLength(1);
    const { body } = await call('PUT', '', { modelConfigId: null });
    expect(body.selectedModelConfigId).toBeNull();
    expect(mocks.drainCalls.at(-1)).toEqual({
      jids: [GROUP_JID],
      target: null,
    });
  });

  test('refuses a configuration without a credential', async () => {
    const { status, body } = await call('PUT', '', { modelConfigId: 'copy' });
    expect(status).toBe(400);
    expect(body.error).toContain('缺少凭据');
    expect(db.getSessionModelSelection(GROUP_FOLDER, null)).toBeNull();
  });

  test('rejects an unknown configuration and non-owners', async () => {
    expect((await call('PUT', '', { modelConfigId: 'nope' })).status).toBe(404);
    mocks.userId = 'mallory';
    expect((await call('PUT', '', { modelConfigId: 'glm' })).status).toBe(404);
    expect(db.getSessionModelSelection(GROUP_FOLDER, null)).toBeNull();
  });
});

describe('PUT /:jid/model-selection inside a ChatGPT configuration', () => {
  const detail = () => db.getSessionModelSelectionDetail(GROUP_FOLDER, null);
  const live = (owner: Record<string, unknown> = {}) =>
    issueCodexGatewayToken('chatgpt', {
      kind: 'container',
      groupFolder: GROUP_FOLDER,
      agentId: null,
      ...owner,
    });

  test('pins a model and an effort, and retires the runner that is on another model', async () => {
    const { status, body } = await call('PUT', '', {
      modelConfigId: 'chatgpt',
      model: 'gpt-6-astra',
      effort: 'xhigh',
    });
    expect(status).toBe(200);
    expect(detail()).toEqual({
      modelConfigId: 'chatgpt',
      model: 'gpt-6-astra',
      effort: 'xhigh',
      updatedBy: OWNER_ID,
    });
    expect(body).toMatchObject({
      selectedModelConfigId: 'chatgpt',
      selectedModel: 'gpt-6-astra',
      selectedEffort: 'xhigh',
      drained: 1,
      liveUpdated: 0,
    });
    // A model is involved, so a runner already on this configuration is not
    // spared: it would keep running the old model.
    expect(mocks.drainCalls).toEqual([{ jids: [GROUP_JID], target: null }]);
  });

  test('a different model on the same configuration retires the runner; the same one does not', async () => {
    await call('PUT', '', { modelConfigId: 'chatgpt', model: 'gpt-6-astra' });
    mocks.drainCalls = [];
    await call('PUT', '', { modelConfigId: 'chatgpt', model: 'gpt-6-astra' });
    expect(mocks.drainCalls).toEqual([]);
    await call('PUT', '', { modelConfigId: 'chatgpt', model: 'gpt-6-luna' });
    expect(mocks.drainCalls).toEqual([{ jids: [GROUP_JID], target: null }]);
    // Back to the configuration's own model.
    await call('PUT', '', { modelConfigId: 'chatgpt' });
    expect(mocks.drainCalls).toHaveLength(2);
    expect(detail()).toMatchObject({ model: null, effort: null });
  });

  test("picking the configuration's own model by name is not a change", async () => {
    await call('PUT', '', { modelConfigId: 'chatgpt' });
    mocks.drainCalls = [];
    await call('PUT', '', { modelConfigId: 'chatgpt', model: 'gpt-6-sol' });
    expect(mocks.drainCalls).toEqual([]);
  });

  test('a new effort reaches live runners without restarting anything', async () => {
    const warm = live({ sessionEffort: 'low' });
    const other = live({ groupFolder: 'some-other-workspace' });
    try {
      await call('PUT', '', {
        modelConfigId: 'chatgpt',
        model: 'gpt-6-astra',
        effort: 'low',
      });
      mocks.drainCalls = [];
      const { status, body } = await call('PUT', '', {
        modelConfigId: 'chatgpt',
        model: 'gpt-6-astra',
        effort: 'high',
      });
      expect(status).toBe(200);
      expect(mocks.drainCalls).toEqual([]);
      expect(body).toMatchObject({ drained: 0, liveUpdated: 1 });
      expect(warm.grant.sessionEffort).toBe('high');
      expect(other.grant.sessionEffort).toBeUndefined();

      // Clearing the effort points the live runner back at the default.
      await call('PUT', '', { modelConfigId: 'chatgpt', model: 'gpt-6-astra' });
      expect(warm.grant.sessionEffort).toBeUndefined();
      expect(mocks.drainCalls).toEqual([]);
    } finally {
      revokeCodexGatewayToken(warm.token);
      revokeCodexGatewayToken(other.token);
    }
  });

  test('pinning the configuration a warm runner is already on only needs its effort updated', async () => {
    // The default was the single ChatGPT configuration: nothing is retired
    // that is already on it, but the runner must learn the effort.
    const warm = live();
    try {
      const { body } = await call('PUT', '', {
        modelConfigId: 'chatgpt',
        effort: 'high',
      });
      expect(mocks.drainCalls).toEqual([
        { jids: [GROUP_JID], target: 'chatgpt' },
      ]);
      expect(body.liveUpdated).toBe(1);
      expect(warm.grant.sessionEffort).toBe('high');
    } finally {
      revokeCodexGatewayToken(warm.token);
    }
  });

  test('a runner that is being replaced by another configuration keeps its own effort', async () => {
    const leaving = issueCodexGatewayToken('glm', {
      kind: 'container',
      groupFolder: GROUP_FOLDER,
      agentId: null,
      sessionEffort: 'low',
    });
    try {
      await call('PUT', '', { modelConfigId: 'chatgpt', effort: 'high' });
      expect(leaving.grant.sessionEffort).toBe('low');
    } finally {
      revokeCodexGatewayToken(leaving.token);
    }
  });

  test('a Runtime Session is changed on its own', async () => {
    const main = live({ sessionEffort: 'low' });
    const session = live({ agentId: AGENT_ID, sessionEffort: 'low' });
    try {
      await call('PUT', '', {
        agentId: AGENT_ID,
        modelConfigId: 'chatgpt',
        effort: 'low',
      });
      await call('PUT', '', {
        agentId: AGENT_ID,
        modelConfigId: 'chatgpt',
        effort: 'max',
      });
      expect(session.grant.sessionEffort).toBe('max');
      expect(main.grant.sessionEffort).toBe('low');
      expect(
        db.getSessionModelSelectionDetail(GROUP_FOLDER, AGENT_ID),
      ).toMatchObject({ effort: 'max' });
      expect(detail()).toBeNull();
    } finally {
      revokeCodexGatewayToken(main.token);
      revokeCodexGatewayToken(session.token);
    }
  });

  test('choosing again replaces the whole choice', async () => {
    await call('PUT', '', {
      modelConfigId: 'chatgpt',
      model: 'gpt-6-astra',
      effort: 'high',
    });
    // An older client that only names the configuration drops the rest.
    await call('PUT', '', { modelConfigId: 'chatgpt' });
    expect(detail()).toMatchObject({ model: null, effort: null });

    await call('PUT', '', {
      modelConfigId: 'chatgpt',
      model: 'gpt-6-astra',
      effort: 'high',
    });
    // Another configuration never inherits a model that is not its own.
    await call('PUT', '', { modelConfigId: 'glm' });
    expect(detail()).toEqual({
      modelConfigId: 'glm',
      model: null,
      effort: null,
      updatedBy: OWNER_ID,
    });
    await call('PUT', '', { modelConfigId: null });
    expect(detail()).toBeNull();
  });

  test('efforts above max need manage_system_config', async () => {
    const refused = await call('PUT', '', {
      modelConfigId: 'chatgpt',
      model: 'gpt-6-astra',
      effort: 'ultra',
    });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ code: 'EFFORT_RESTRICTED' });
    expect(refused.body.error).toContain('ultra');
    expect(detail()).toBeNull();
    expect(mocks.drainCalls).toEqual([]);

    mocks.permissions = OPS;
    const accepted = await call('PUT', '', {
      modelConfigId: 'chatgpt',
      model: 'gpt-6-astra',
      effort: 'ultra',
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ selectedEffort: 'ultra' });
    expect(detail()).toMatchObject({ effort: 'ultra', updatedBy: OWNER_ID });
  });

  test('refuses a model the account cannot run and an effort the model lacks', async () => {
    const unknown = await call('PUT', '', {
      modelConfigId: 'chatgpt',
      model: 'gpt-0-imaginary',
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body).toMatchObject({ code: 'MODEL_UNAVAILABLE' });

    mocks.chatgptPlan = 'promax';
    const outOfPlan = await call('PUT', '', {
      modelConfigId: 'chatgpt',
      model: 'gpt-6-sol',
    });
    expect(outOfPlan.body).toMatchObject({ code: 'MODEL_UNAVAILABLE' });
    mocks.chatgptPlan = null;

    mocks.permissions = OPS;
    const unsupported = await call('PUT', '', {
      modelConfigId: 'chatgpt',
      model: 'gpt-6-luna',
      effort: 'ultra',
    });
    expect(unsupported.status).toBe(400);
    expect(unsupported.body).toMatchObject({ code: 'EFFORT_UNSUPPORTED' });
    // Without a model the effort is judged on the configuration's own.
    const lacking = await call('PUT', '', {
      modelConfigId: 'chatgpt',
      effort: 'nonsense',
    });
    expect(lacking.body).toMatchObject({ code: 'EFFORT_UNSUPPORTED' });
    expect(detail()).toBeNull();
    expect(mocks.drainCalls).toEqual([]);
  });

  test('a model outside the list, an effort the model does not take, a model without a configuration are refused', async () => {
    const other = await call('PUT', '', {
      modelConfigId: 'glm',
      model: 'gpt-6-astra',
    });
    expect(other.status).toBe(400);
    expect(other.body).toMatchObject({ code: 'MODEL_NOT_IN_CONNECTION' });
    const effortOnly = await call('PUT', '', {
      modelConfigId: 'glm',
      effort: 'medium',
    });
    expect(effortOnly.body).toMatchObject({ code: 'EFFORT_NOT_SUPPORTED' });
    const orphan = await call('PUT', '', {
      modelConfigId: null,
      model: 'gpt-6-astra',
    });
    expect(orphan.status).toBe(400);
    expect(orphan.body).toMatchObject({ code: 'MODEL_CONFIG_REQUIRED' });
    expect(detail()).toBeNull();
  });

  test('a refusal changes nothing that was chosen before', async () => {
    await call('PUT', '', {
      modelConfigId: 'chatgpt',
      model: 'gpt-6-astra',
      effort: 'high',
    });
    mocks.drainCalls = [];
    const refused = await call('PUT', '', {
      modelConfigId: 'chatgpt',
      model: 'gpt-6-astra',
      effort: 'ultra',
    });
    expect(refused.status).toBe(400);
    expect(detail()).toMatchObject({ model: 'gpt-6-astra', effort: 'high' });
    expect(mocks.drainCalls).toEqual([]);
  });
});

describe('model-selection inside a configuration that is not ChatGPT', () => {
  const detail = () => db.getSessionModelSelectionDetail(GROUP_FOLDER, null);

  test('pins a model of its list, hidden ones included, and reports it', async () => {
    const { status, body } = await call('PUT', '', {
      modelConfigId: 'glm',
      model: 'glm-5.3-air',
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({
      selectedModelConfigId: 'glm',
      selectedModel: 'glm-5.3-air',
      selectedEffort: null,
    });
    expect(detail()).toEqual({
      modelConfigId: 'glm',
      model: 'glm-5.3-air',
      effort: null,
      updatedBy: OWNER_ID,
    });
    // A model is involved: a runner already on this configuration would keep
    // running the old one.
    expect(mocks.drainCalls).toEqual([{ jids: [GROUP_JID], target: null }]);

    const hidden = await call('PUT', '', {
      modelConfigId: 'glm',
      model: 'glm-5.3-legacy',
    });
    expect(hidden.status).toBe(200);
    expect(hidden.body.selectedModel).toBe('glm-5.3-legacy');
  });

  test('refuses a model the configuration does not offer and changes nothing', async () => {
    const refused = await call('PUT', '', {
      modelConfigId: 'glm',
      model: 'glm-9',
    });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ code: 'MODEL_NOT_IN_CONNECTION' });
    expect(refused.body.error).toContain('glm-9');
    expect(detail()).toBeNull();
    expect(mocks.drainCalls).toEqual([]);
  });

  test('an effort goes with a model that takes it', async () => {
    // glm-5.3-air has no known efforts, though it is configured to run low.
    const refused = await call('PUT', '', {
      modelConfigId: 'glm',
      model: 'glm-5.3-air',
      effort: 'low',
    });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ code: 'EFFORT_NOT_SUPPORTED' });
    expect(detail()).toBeNull();

    // Without a model, the configuration's default model decides.
    const accepted = await call('PUT', '', {
      modelConfigId: 'glm',
      effort: 'low',
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({
      selectedModel: null,
      selectedEffort: 'low',
    });
    expect(detail()).toMatchObject({ model: null, effort: 'low' });
  });

  test('an effort-only change retires the runner but keeps the model', async () => {
    await call('PUT', '', { modelConfigId: 'glm', model: 'glm-5.3[1m]' });
    mocks.drainCalls = [];
    const raised = await call('PUT', '', {
      modelConfigId: 'glm',
      model: 'glm-5.3[1m]',
      effort: 'max',
    });
    expect(raised.status).toBe(200);
    expect(raised.body.drained).toBe(1);
    // Every runner of the conversation, even one on this configuration.
    expect(mocks.drainCalls).toEqual([{ jids: [GROUP_JID], target: null }]);
    mocks.drainCalls = [];
    await call('PUT', '', {
      modelConfigId: 'glm',
      model: 'glm-5.3[1m]',
      effort: 'max',
    });
    expect(mocks.drainCalls).toEqual([]);
  });

  test('accepts a model id up to the shared length limit', async () => {
    const tooLong = await call('PUT', '', {
      modelConfigId: 'glm',
      model: 'm'.repeat(201),
    });
    expect(tooLong.status).toBe(400);
    expect(tooLong.body.error).toBe('Invalid request body');
    // Within the limit, the configuration's list alone decides.
    const unlisted = await call('PUT', '', {
      modelConfigId: 'glm',
      model: 'm'.repeat(200),
    });
    expect(unlisted.body).toMatchObject({ code: 'MODEL_NOT_IN_CONNECTION' });
  });

  test("an Agent model its connection dropped runs the connection's own: naming that is no change", async () => {
    const main = db.getOrCreateDefaultAgentProfile(OWNER_ID);
    db.updateAgentProfile(main.id, OWNER_ID, {
      modelConfigId: 'glm',
      model: 'glm-5.2-gone',
    });
    try {
      await call('PUT', '', { modelConfigId: 'glm' });
      mocks.drainCalls = [];
      await call('PUT', '', { modelConfigId: 'glm', model: 'glm-5.3' });
      expect(mocks.drainCalls).toEqual([]);
    } finally {
      bindOwnerMain(null);
    }
  });

  test('naming the default model is no change, another model is', async () => {
    await call('PUT', '', { modelConfigId: 'glm' });
    expect(mocks.drainCalls).toEqual([{ jids: [GROUP_JID], target: 'glm' }]);
    mocks.drainCalls = [];
    await call('PUT', '', { modelConfigId: 'glm', model: 'glm-5.3[1m]' });
    expect(mocks.drainCalls).toEqual([]);
    await call('PUT', '', { modelConfigId: 'glm', model: 'glm-5.3-air' });
    expect(mocks.drainCalls).toEqual([{ jids: [GROUP_JID], target: null }]);
    // Back to the configuration's own model.
    await call('PUT', '', { modelConfigId: 'glm' });
    expect(mocks.drainCalls).toEqual([
      { jids: [GROUP_JID], target: null },
      { jids: [GROUP_JID], target: null },
    ]);
  });

  test('reports a stored model only while the list still offers it', async () => {
    db.setSessionModelSelection(GROUP_FOLDER, null, 'glm', OWNER_ID, {
      model: 'glm-5.3-legacy',
    });
    expect((await call('GET')).body.selectedModel).toBe('glm-5.3-legacy');
    db.setSessionModelSelection(GROUP_FOLDER, null, 'glm', OWNER_ID, {
      model: 'glm-5.2',
    });
    expect((await call('GET')).body).toMatchObject({
      selectedModelConfigId: 'glm',
      selectedModel: null,
    });
  });

  test("a conversation that ran the Agent's model is not spared on the Agent's configuration", async () => {
    const profile = db.createAgentProfile({
      ownerUserId: OWNER_ID,
      name: 'GLM Agent',
      modelConfigId: 'glm',
      model: 'glm-5.3-air',
    });
    db.assignWorkspaceAgentProfile(GROUP_FOLDER, profile.id);
    try {
      // Unpicked, the conversation ran glm-5.3-air; picking GLM runs its
      // default, so a runner already on GLM must go too.
      await call('PUT', '', { modelConfigId: 'glm' });
      expect(mocks.drainCalls).toEqual([{ jids: [GROUP_JID], target: null }]);

      db.setSessionModelSelection(GROUP_FOLDER, null, null);
      db.updateAgentProfile(profile.id, OWNER_ID, { model: null });
      mocks.drainCalls = [];
      await call('PUT', '', { modelConfigId: 'glm' });
      expect(mocks.drainCalls).toEqual([{ jids: [GROUP_JID], target: 'glm' }]);
    } finally {
      db.deleteWorkspaceAgentProfile(GROUP_FOLDER);
    }
  });
});
