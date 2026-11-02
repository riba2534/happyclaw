/**
 * The chat picker labels "default" with `default.model`. It must name the
 * model a launch without a conversation pick really runs, so the label is
 * checked against the real launch selection, not against a copy of its rules.
 *
 * Real configuration file and database in a temp DATA_DIR.
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-default-label-'));

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: path.join(root, 'db'),
  GROUPS_DIR: path.join(root, 'groups'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/middleware/auth.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: OWNER,
      username: OWNER,
      role: 'admin',
      permissions: ['manage_system_config'],
    });
    return next();
  },
}));
vi.mock('../src/web.js', () => ({ broadcastNewMessage: () => {} }));
vi.mock(
  '../src/codex-gateway/model-catalog-sync.js',
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    // The picker may ask for a fresher catalog; nothing leaves the test.
    maybeRefreshCodexProviderCatalog: () => {},
  }),
);

const OWNER = vi.hoisted(() => 'label-owner');
const ADMIN = 'label-admin';
const JID = 'web:default-label';
const FOLDER = 'default-label';

const runtimeConfig = await import('../src/runtime-config.js');
const db = await import('../src/db.js');
const runner = await import('../src/container-runner.js');
const groupRoutes = (await import('../src/routes/groups.js')).default;
const { CODEX_GATEWAY_BASE_URL_PLACEHOLDER } =
  await import('../src/codex-gateway/types.js');

let glm: ReturnType<typeof runtimeConfig.createProvider>;
let kimi: ReturnType<typeof runtimeConfig.createProvider>;
let chatgpt: ReturnType<typeof runtimeConfig.createProvider>;
let agentId = '';
/** The session whose label is read; it picked nothing. */
const SESSION = 'label-session';

beforeAll(() => {
  fs.mkdirSync(path.join(root, 'db'), { recursive: true });
  fs.mkdirSync(path.join(root, 'groups', FOLDER), { recursive: true });
  db.initDatabase();
  db.setRegisteredGroup(JID, {
    name: 'Default label',
    folder: FOLDER,
    added_at: new Date().toISOString(),
    executionMode: 'container',
    created_by: OWNER,
  } as never);
  db.createAgent({
    id: SESSION,
    group_folder: FOLDER,
    chat_jid: JID,
    name: 'Conversation',
    prompt: '',
    status: 'idle',
    kind: 'conversation',
    created_by: OWNER,
    created_at: new Date().toISOString(),
    completed_at: null,
    result_summary: null,
    last_im_jid: null,
    spawned_from_jid: null,
  });
  glm = runtimeConfig.createProvider({
    name: 'GLM',
    type: 'third_party',
    anthropicBaseUrl: 'https://glm.example.test',
    anthropicAuthToken: 'glm-token',
    anthropicModel: 'glm-5',
    models: [{ id: 'glm-5' }, { id: 'glm-5-air' }],
  });
  kimi = runtimeConfig.createProvider({
    name: 'Kimi',
    type: 'third_party',
    anthropicBaseUrl: 'https://kimi.example.test',
    anthropicAuthToken: 'kimi-token',
    anthropicModel: 'kimi-k3',
  });
  chatgpt = runtimeConfig.createProvider({
    name: 'ChatGPT',
    type: 'third_party',
    anthropicBaseUrl: CODEX_GATEWAY_BASE_URL_PLACEHOLDER,
    anthropicAuthToken: 'gateway-identifier',
    anthropicModel: 'gpt-6-sol',
    codexOAuthCredentials: {
      accessToken: 'access',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 3_600_000,
      accountId: 'acct',
      planType: null,
      email: null,
    },
  });
  const at = new Date().toISOString();
  db.createUser({
    id: ADMIN,
    username: ADMIN,
    password_hash: 'test-only',
    display_name: ADMIN,
    role: 'admin',
    status: 'active',
    created_at: at,
    updated_at: at,
    must_change_password: false,
  });
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  bindMain(OWNER, null);
  bindMain(ADMIN, null);
  db.deleteWorkspaceAgentProfile(FOLDER);
  db.deleteAllSessionsForFolder(FOLDER);
  agentId = '';
});

/** Bind a user's main Agent to (configuration, model). */
function bindMain(
  userId: string,
  modelConfigId: string | null,
  model?: string,
): void {
  const main = db.getOrCreateDefaultAgentProfile(userId);
  db.updateAgentProfile(main.id, userId, {
    modelConfigId,
    model: model ?? null,
  });
}

/** Bind the workspace to an Agent on (configuration, model), or on none. */
function bindAgent(modelConfigId: string | null, model?: string): void {
  const profile = db.createAgentProfile({
    ownerUserId: OWNER,
    name: `Agent ${Math.random()}`,
    modelConfigId,
    model,
  });
  db.assignWorkspaceAgentProfile(FOLDER, profile.id);
  agentId = profile.id;
}

async function labelled(): Promise<{
  source: string;
  modelConfigId: string | null;
  model: string | null;
  effort: string | null;
}> {
  const res = await groupRoutes.request(
    `/${encodeURIComponent(JID)}/model-selection?agentId=${SESSION}`,
  );
  expect(res.status).toBe(200);
  return (await res.json()).default;
}

/** What a launch without a conversation pick runs. */
function launched(): {
  profileId: string;
  model: string | null;
  /** CLAUDE_CODE_EFFORT_LEVEL in the environment the launch builds. */
  effort: string | null;
} {
  const profile = agentId ? db.getAgentProfile(agentId) : undefined;
  const selection = runner.trySelectPoolProvider(
    FOLDER,
    SESSION,
    profile?.model_config_id,
    profile?.model,
  )!;
  return {
    profileId: selection.profileId,
    model: selection.sessionModel || null,
    effort: selection.resolved.launchEffort ?? null,
  };
}

async function expectLabelMatchesLaunch(expected: {
  source: string;
  model: string | null;
  effort?: string | null;
}) {
  const label = await labelled();
  const launch = launched();
  expect(label).toMatchObject(expected);
  expect(label.modelConfigId).toBe(launch.profileId);
  expect(label.model).toBe(launch.model);
  // Outside ChatGPT the label's effort is the one the launch writes.
  if (expected.effort !== undefined) {
    expect(label.effort).toBe(expected.effort);
    expect(launch.effort).toBe(expected.effort);
  }
}

describe('default.model names what an unpicked launch runs', () => {
  test("an Agent's model within its configuration", async () => {
    bindAgent(glm.id, 'glm-5-air');
    await expectLabelMatchesLaunch({ source: 'agent', model: 'glm-5-air' });
  });

  test("an Agent's model the configuration no longer offers", async () => {
    bindAgent(glm.id, 'glm-4-gone');
    await expectLabelMatchesLaunch({ source: 'agent', model: 'glm-5' });
  });

  test('an Agent bound to a configuration without a model', async () => {
    bindAgent(kimi.id);
    // The registry's default for kimi-k3, never a blanket max.
    await expectLabelMatchesLaunch({
      source: 'agent',
      model: 'kimi-k3',
      effort: 'high',
    });
  });

  test("the workspace's own main Agent is the Agent", async () => {
    bindMain(OWNER, glm.id, 'glm-5-air');
    await expectLabelMatchesLaunch({ source: 'agent', model: 'glm-5-air' });
  });

  test("an unbound Agent follows the owner's main Agent, with its model", async () => {
    bindAgent(null);
    bindMain(OWNER, glm.id, 'glm-5-air');
    await expectLabelMatchesLaunch({
      source: 'owner_main',
      model: 'glm-5-air',
    });
  });

  test('the system main HappyClaw', async () => {
    bindAgent(null);
    bindMain(ADMIN, kimi.id);
    await expectLabelMatchesLaunch({ source: 'system_main', model: 'kimi-k3' });
  });

  test('a ChatGPT subscription, inherited and as an Agent model', async () => {
    bindAgent(null);
    bindMain(OWNER, chatgpt.id);
    await expectLabelMatchesLaunch({
      source: 'owner_main',
      model: 'gpt-6-sol',
    });
    // ChatGPT's effort is the gateway's, as its catalog view reports it.
    const chatgptView = (
      await (
        await groupRoutes.request(
          `/${encodeURIComponent(JID)}/model-selection?agentId=${SESSION}`,
        )
      ).json()
    ).options.find((option: { id: string }) => option.id === chatgpt.id).codex;
    expect((await labelled()).effort).toBe(
      chatgptView.models.find(
        (model: { value: string }) => model.value === 'gpt-6-sol',
      ).defaultEffort,
    );

    bindAgent(chatgpt.id, 'gpt-6.1-sol');
    await expectLabelMatchesLaunch({ source: 'agent', model: 'gpt-6.1-sol' });
  });

  test('nothing bound names no connection', async () => {
    expect(await labelled()).toMatchObject({
      source: 'none',
      modelConfigId: null,
      model: null,
      effort: null,
      connectionMissing: false,
    });
    expect(() =>
      runner.trySelectPoolProvider(FOLDER, null, null, null),
    ).toThrow(/还没有为主 HappyClaw 选择模型/);
  });
});
