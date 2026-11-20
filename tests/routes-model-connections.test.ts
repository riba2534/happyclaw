import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const tmpDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-model-connections-'),
);

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: tmpDir,
  STORE_DIR: path.join(tmpDir, 'db'),
  GROUPS_DIR: path.join(tmpDir, 'groups'),
}));

const logger = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../src/logger.js', () => ({ logger }));

vi.mock('../src/middleware/auth.ts', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../src/middleware/auth.ts')>();
  return {
    ...real,
    authMiddleware: async (c: any, next: any) => {
      c.set('user', {
        id: `connections-admin-${currentUser.n}`,
        username: 'connections-admin',
        display_name: 'Admin',
        role: currentUser.role,
        status: 'active',
        permissions: [],
        must_change_password: false,
      });
      return next();
    },
  };
});

// Each test is its own admin, so the per-minute check budget never carries over.
const currentUser = vi.hoisted(() => ({ n: 0, role: 'admin' }));

const web = await import('../src/web.js');
const db = await import('../src/db.js');
const runtimeConfig = await import('../src/runtime-config.js');
const runner = await import('../src/container-runner.js');
const { providerPool } = await import('../src/provider-pool.js');
const catalogSync = await import('../src/codex-gateway/model-catalog-sync.js');
const { CODEX_GATEWAY_BASE_URL_PLACEHOLDER } =
  await import('../src/codex-gateway/types.js');

const realFetch = globalThis.fetch;

const queue = {
  stopGroup: vi.fn(async () => {}),
  listDescendantJids: () => [],
  pauseGroupsForMutation: vi.fn(() => ({ id: 0 })),
  resumeGroupsAfterMutation: vi.fn(),
  blockGroupsForRuntimeSafety: vi.fn(),
  unblockGroupsForRuntimeSafety: vi.fn(),
  drainProviderRunnersForCredentialRefresh: vi.fn(() => 0),
  getStatus: vi.fn(() => ({ groups: [] as unknown[] })),
};
const app = web.createAppForTest({
  queue,
  getRegisteredGroups: () => ({}),
  sessions: {},
} as any);

// ─── A scripted upstream ───────────────────────────────────────

interface Seen {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}
type Reply = { status: number; body?: unknown };
let reply: (seen: Seen) => Reply = () => ({ status: 200, body: {} });
const seen: Seen[] = [];
let server: http.Server;
let upstream = '';

/** Answers like an endpoint that only takes the key as `x-api-key`. */
function xApiKeyOnly(key: string, ok: Reply): (seen: Seen) => Reply {
  return (request) =>
    request.headers['x-api-key'] === key
      ? ok
      : {
          status: 401,
          body: { error: { message: `invalid api key ${key}` } },
        };
}

/** Refuses the key in one header style; answers `other` to the other style. */
function refuses(
  style: 'bearer' | 'x-api-key',
  other: Reply,
): (seen: Seen) => Reply {
  return (request) =>
    (
      style === 'bearer'
        ? !!request.headers.authorization
        : !!request.headers['x-api-key']
    )
      ? {
          status: 403,
          body: {
            error: {
              type: 'permission_error',
              message: 'Request not allowed in this region',
            },
          },
        }
      : other;
}

// Requests to the real Anthropic and ChatGPT hosts, answered in-process.
const anthropic = vi.fn<(url: string, init: RequestInit) => Reply>();
const chatgpt = vi.fn<(url: string, init: RequestInit) => Reply>();

beforeAll(async () => {
  fs.mkdirSync(path.join(tmpDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'groups'), { recursive: true });
  db.initDatabase();
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      const request = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body,
      };
      seen.push(request);
      const answer = reply(request);
      res.writeHead(answer.status, { 'content-type': 'application/json' });
      res.end(
        typeof answer.body === 'string'
          ? answer.body
          : JSON.stringify(answer.body ?? {}),
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  upstream = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  currentUser.n += 1;
  currentUser.role = 'admin';
  fs.rmSync(path.join(tmpDir, 'config'), { recursive: true, force: true });
  seen.length = 0;
  reply = () => ({ status: 200, body: {} });
  anthropic.mockReset();
  chatgpt.mockReset();
  logger.info.mockClear();
  for (const fn of Object.values(queue)) {
    if (vi.isMockFunction(fn)) fn.mockClear();
  }
  catalogSync.resetCodexCatalogSyncForTests();
  catalogSync.setCodexCatalogDiskCachePathForTests(null);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const route = url.startsWith('https://api.anthropic.com/')
        ? anthropic
        : url.startsWith('https://chatgpt.com/')
          ? chatgpt
          : url.startsWith('http://127.0.0.1')
            ? null
            : // Nothing else may leave the test.
              () => ({ status: 599, body: 'blocked' });
      if (!route) return realFetch(input, init);
      const answer = route(url, init ?? {}) ?? { status: 500 };
      return new Response(
        typeof answer.body === 'string'
          ? answer.body
          : JSON.stringify(answer.body ?? {}),
        { status: answer.status },
      );
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function request(
  method: string,
  url: string,
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const res = await app.request(`/api/config/claude${url}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

function thirdParty(patch: Record<string, unknown> = {}) {
  return runtimeConfig.createProvider({
    name: 'Relay',
    type: 'third_party',
    anthropicBaseUrl: upstream,
    anthropicAuthToken: 'relay-secret-123456',
    anthropicModel: 'glm-5.3',
    ...patch,
  });
}

function chatGptProvider() {
  return runtimeConfig.createProvider({
    name: 'ChatGPT',
    type: 'third_party',
    anthropicBaseUrl: CODEX_GATEWAY_BASE_URL_PLACEHOLDER,
    anthropicAuthToken: 'gateway-identifier-123456',
    anthropicModel: 'gpt-6-sol',
    codexOAuthCredentials: {
      accessToken: 'chatgpt-access-123456',
      refreshToken: 'refresh',
      expiresAt: Date.now() + 3_600_000,
      accountId: 'account-plus',
      planType: 'plus',
      email: null,
    },
  });
}

const CHATGPT_MODELS = {
  models: [
    {
      slug: 'gpt-6-sol',
      visibility: 'list',
      priority: 1,
      available_in_plans: ['plus'],
      supported_reasoning_levels: [{ effort: 'low' }],
    },
  ],
};

function bindAgent(providerId: string, model: string, name = 'Coder') {
  return db.createAgentProfile({
    ownerUserId: 'connections-admin',
    name,
    modelConfigId: providerId,
    model,
  });
}

// ─── Creating ──────────────────────────────────────────────────

describe('creating a connection', () => {
  test('needs a credential of every kind', async () => {
    for (const body of [
      { name: 'Relay', type: 'third_party', anthropicBaseUrl: upstream },
      { name: 'Claude', type: 'official' },
      { name: 'Claude', type: 'official', anthropicModel: 'opus' },
    ]) {
      const created = await request('POST', '/providers', body);
      expect(created).toEqual({
        status: 400,
        body: { error: '新建模型配置需要凭据' },
      });
    }
    expect(runtimeConfig.getProviders()).toEqual([]);
  });

  test('there is no pool to join: enabled and weight are ignored', async () => {
    const create = (extra: Record<string, unknown> = {}) =>
      request('POST', '/providers', {
        name: 'Relay',
        type: 'third_party',
        anthropicBaseUrl: upstream,
        anthropicAuthToken: 'relay-secret-123456',
        ...extra,
      });
    expect((await create()).status).toBe(201);
    const created = await create({ enabled: true, weight: 9 });
    expect(created.status).toBe(201);
    expect(created.body).not.toHaveProperty('enabled');
    expect(created.body).not.toHaveProperty('weight');
    expect(runtimeConfig.readLegacyModelDefaults().enabledIds).toEqual([]);
    const list = await request('GET', '/providers');
    expect(Object.keys(list.body)).toEqual(['providers']);
    expect(list.body.providers[0]).not.toHaveProperty('health');
    expect(runtimeConfig.readLegacyModelDefaults().defaultModelConfigId).toBe(
      null,
    );
  });

  test('a new connection keeps exactly the env it was given', async () => {
    const created = await request('POST', '/providers', {
      name: 'Relay',
      type: 'third_party',
      anthropicBaseUrl: upstream,
      anthropicAuthToken: 'relay-secret-123456',
      customEnv: { API_TIMEOUT_MS: '600000', CLAUDE_CODE_NO_FLICKER: '' },
    });
    expect(created.body.customEnv).toEqual({ API_TIMEOUT_MS: '600000' });
    // The prefill is the wizard's to offer; a later read adds nothing.
    expect(runtimeConfig.getProviderById(created.body.id)!.customEnv).toEqual({
      API_TIMEOUT_MS: '600000',
    });
  });

  test('env keys the models decide are refused with RESERVED_ENV_KEY', async () => {
    const base = {
      name: 'Relay',
      type: 'third_party',
      anthropicBaseUrl: upstream,
      anthropicAuthToken: 'relay-secret-123456',
    };
    for (const key of [
      'ANTHROPIC_DEFAULT_HAIKU_MODEL',
      'CLAUDE_CODE_SUBAGENT_MODEL',
      'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
      'CLAUDE_CODE_EFFORT_LEVEL',
      'ANTHROPIC_MODEL',
    ]) {
      const created = await request('POST', '/providers', {
        ...base,
        customEnv: { [key]: 'x' },
      });
      expect(created.status).toBe(400);
      expect(created.body).toMatchObject({
        code: 'RESERVED_ENV_KEY',
        keys: [key],
      });
    }
    expect(runtimeConfig.getProviders()).toEqual([]);

    const provider = thirdParty({});
    const patched = await request('PATCH', `/providers/${provider.id}`, {
      customEnv: { CLAUDE_CODE_EFFORT_LEVEL: 'max' },
    });
    expect(patched.status).toBe(400);
    expect(patched.body.code).toBe('RESERVED_ENV_KEY');
  });

  test('stores its model list and preset and reports them', async () => {
    const created = await request('POST', '/providers', {
      name: 'GLM',
      type: 'third_party',
      presetId: 'zhipu-glm-cn',
      anthropicBaseUrl: 'https://open.bigmodel.cn/api/anthropic',
      anthropicAuthToken: 'glm-secret-123456',
      anthropicAuthMode: 'bearer',
      anthropicModel: 'glm-5.3[1m]',
      models: [
        { id: 'glm-5.2', contextWindow: 128_000, efforts: ['low', 'high'] },
        { id: 'glm-5.1' },
      ],
      roles: { smallFast: 'glm-5.1', subagent: 'not-offered' },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      presetId: 'zhipu-glm-cn',
      anthropicModel: 'glm-5.3',
      anthropicAuthMode: 'bearer',
      models: [
        { id: 'glm-5.3', contextWindow: 1_000_000 },
        { id: 'glm-5.2', contextWindow: 128_000, efforts: ['low', 'high'] },
        { id: 'glm-5.1' },
      ],
      // A role naming a model the connection does not offer is dropped.
      roles: { smallFast: 'glm-5.1' },
      lastTest: null,
    });
  });

  test('a preset connection may leave its address to the preset', async () => {
    const created = await request('POST', '/providers', {
      name: 'DeepSeek',
      type: 'third_party',
      presetId: 'deepseek',
      anthropicAuthToken: 'ds-secret-123456',
      anthropicModel: 'deepseek-flash[1m]',
    });
    expect(created.status).toBe(201);
    expect(created.body.anthropicBaseUrl).toBe(
      'https://api.deepseek.com/anthropic',
    );
  });

  test('refuses an unknown preset and a model Claude Code cannot take', async () => {
    const base = {
      name: 'Relay',
      type: 'third_party',
      anthropicBaseUrl: upstream,
      anthropicAuthToken: 'relay-secret-123456',
    };
    expect(
      (await request('POST', '/providers', { ...base, presetId: 'nope' }))
        .status,
    ).toBe(400);
    expect(
      (
        await request('POST', '/providers', {
          ...base,
          models: [{ id: 'has space' }],
        })
      ).status,
    ).toBe(400);
    expect(
      (await request('POST', '/providers', { ...base, anthropicModel: 'a b' }))
        .status,
    ).toBe(400);
    expect(runtimeConfig.getProviders()).toEqual([]);
  });
});

// ─── Editing the model list ────────────────────────────────────

describe('editing a model list', () => {
  function boundSession(providerId: string) {
    db.setSession('connections-folder', 'sdk-session-1');
    db.setSessionProviderId('connections-folder', null, providerId);
  }

  test('re-tuning windows, efforts or roles, or adding models stops nothing', async () => {
    const provider = thirdParty({
      enabled: true,
      models: [{ id: 'glm-5.3' }, { id: 'glm-5.2' }],
    });
    boundSession(provider.id);
    const patched = await request('PATCH', `/providers/${provider.id}`, {
      name: 'Relay',
      weight: 1,
      models: [
        { id: 'glm-5.3', contextWindow: 256_000 },
        { id: 'glm-5.2', efforts: ['high', 'low'], defaultEffort: 'high' },
        { id: 'glm-5.1' },
      ],
      roles: { smallFast: 'glm-5.1' },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.applied).toMatchObject({ stoppedCount: 0 });
    expect(patched.body.provider.models).toEqual([
      { id: 'glm-5.3', contextWindow: 256_000 },
      { id: 'glm-5.2', efforts: ['low', 'high'], defaultEffort: 'high' },
      { id: 'glm-5.1' },
    ]);
    expect(patched.body.provider.roles).toEqual({ smallFast: 'glm-5.1' });
    expect(queue.pauseGroupsForMutation).not.toHaveBeenCalled();
    expect(db.getSession('connections-folder')).toBe('sdk-session-1');
  });

  test('a rename, a weight or a preset change stops no runner', async () => {
    const provider = thirdParty({
      enabled: true,
      anthropicBaseUrl: 'https://api.deepseek.com/anthropic',
    });
    for (const patch of [
      { name: 'Renamed' },
      { weight: 7 },
      { presetId: 'deepseek' },
    ]) {
      const patched = await request(
        'PATCH',
        `/providers/${provider.id}`,
        patch,
      );
      expect(patched.status).toBe(200);
      expect(patched.body.applied).toMatchObject({ stoppedCount: 0 });
    }
    expect(queue.pauseGroupsForMutation).not.toHaveBeenCalled();
    // A weight is accepted from older clients and means nothing.
    expect(runtimeConfig.getProviderById(provider.id)).toMatchObject({
      name: 'Renamed',
      presetId: 'deepseek',
    });
  });

  test("a model's effort, the default's too, waits for the next launch; a removed model stops runners", async () => {
    const provider = thirdParty({
      enabled: true,
      models: [{ id: 'glm-5.3' }, { id: 'glm-5.2' }],
    });
    const retuned = await request('PATCH', `/providers/${provider.id}`, {
      models: [
        { id: 'glm-5.3', effort: 'low' },
        { id: 'glm-5.2', effort: 'high' },
      ],
    });
    expect(retuned.status).toBe(200);
    expect(retuned.body.applied).toMatchObject({ stoppedCount: 0 });
    expect(queue.pauseGroupsForMutation).not.toHaveBeenCalled();

    const removed = await request('PATCH', `/providers/${provider.id}`, {
      models: [{ id: 'glm-5.3', effort: 'low' }],
    });
    expect(removed.status).toBe(200);
    expect(queue.pauseGroupsForMutation).toHaveBeenCalledTimes(1);
  });

  test('clearing the auth header style brings back the inference', async () => {
    const provider = thirdParty({ enabled: true, anthropicAuthMode: 'bearer' });
    boundSession(provider.id);
    const cleared = await request('PATCH', `/providers/${provider.id}`, {
      anthropicAuthMode: null,
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.provider.anthropicAuthMode).toBeNull();
    expect(runtimeConfig.getProviderById(provider.id)!.anthropicAuthMode).toBe(
      undefined,
    );
    // A different header style is a protocol change.
    expect(queue.pauseGroupsForMutation).toHaveBeenCalledTimes(1);
    expect(db.getSession('connections-folder')).toBeUndefined();

    // The test falls back again: the inferred x-api-key first, then Bearer.
    reply = refuses('x-api-key', { status: 200, body: {} });
    const tested = await request('POST', '/providers/test', {
      providerId: provider.id,
    });
    expect(
      seen.map((item) => (item.headers['x-api-key'] ? 'x-api-key' : 'bearer')),
    ).toEqual(['x-api-key', 'bearer']);
    expect(tested.body).toMatchObject({ ok: true, authMode: 'bearer' });

    // Clearing a style that is not there changes nothing.
    const legacy = thirdParty({ enabled: true });
    const again = await request('PATCH', `/providers/${legacy.id}`, {
      anthropicAuthMode: null,
    });
    expect(again.status).toBe(200);
    expect(queue.pauseGroupsForMutation).toHaveBeenCalledTimes(1);
  });

  test('a new default model is still a protocol change', async () => {
    const provider = thirdParty({ enabled: true });
    boundSession(provider.id);
    const patched = await request('PATCH', `/providers/${provider.id}`, {
      anthropicModel: 'glm-5.2',
    });
    expect(patched.status).toBe(200);
    expect(queue.pauseGroupsForMutation).toHaveBeenCalled();
    expect(db.getSession('connections-folder')).toBeUndefined();
    // The old default stays on offer.
    expect(patched.body.provider.models).toEqual([
      { id: 'glm-5.2' },
      { id: 'glm-5.3' },
    ]);
  });

  test('a new address stops the runners and keeps every session', async () => {
    const provider = thirdParty({ enabled: true });
    boundSession(provider.id);
    const moved = await request('PATCH', `/providers/${provider.id}`, {
      anthropicBaseUrl: 'https://relay.example.test',
    });
    expect(moved.status).toBe(200);
    expect(moved.body.provider.anthropicBaseUrl).toBe(
      'https://relay.example.test',
    );
    // Runners were launched with the old address, so they stop.
    expect(queue.pauseGroupsForMutation).toHaveBeenCalledTimes(1);
    expect(moved.body.applied.clearedSessionsCount).toBeUndefined();
    expect(db.getSession('connections-folder')).toBe('sdk-session-1');
    expect(runner.willClearSessionOnProviderSwitch('connections-folder')).toBe(
      false,
    );
  });

  test('a new address with a new key still starts new sessions', async () => {
    const provider = thirdParty({ enabled: true });
    boundSession(provider.id);
    const moved = await request('PATCH', `/providers/${provider.id}`, {
      anthropicBaseUrl: 'https://relay.example.test',
      anthropicAuthToken: 'another-account-123456',
    });
    expect(moved.status).toBe(200);
    expect(db.getSession('connections-folder')).toBeUndefined();
  });

  test('a new default model drops only the sessions that ran the old one', async () => {
    const folder = 'default-change-folder';
    const workspaceJid = 'web:default-change-folder';
    // A workspace, so each session also has its runtime projection row.
    db.setRegisteredGroup(workspaceJid, {
      name: folder,
      folder,
      added_at: new Date().toISOString(),
      executionMode: 'container',
      created_by: 'connections-admin',
    } as never);
    const provider = thirdParty({
      enabled: true,
      models: [{ id: 'glm-5.3' }, { id: 'glm-5.2' }, { id: 'glm-5.1' }],
    });
    const session = (agentId: string | null, model: string | null) => {
      db.setSession(folder, `sdk-${agentId ?? 'main'}`, agentId);
      db.setSessionProviderId(folder, agentId, provider.id);
      if (model) db.setSessionModel(folder, agentId, model);
    };
    // The conversation picked glm-5.2 and ran it.
    db.setSessionModelSelection(folder, null, provider.id, 'u', {
      model: 'glm-5.2',
    });
    session(null, 'glm-5.2');
    session('on-default', 'glm-5.3');
    session('unrecorded', null);

    const patched = await request('PATCH', `/providers/${provider.id}`, {
      anthropicModel: 'glm-5.1',
    });
    expect(patched.status).toBe(200);
    expect(patched.body.applied).toMatchObject({ clearedSessionsCount: 2 });
    expect(db.getSession(folder)).toBe('sdk-main');
    expect(db.getSession(folder, 'on-default')).toBeUndefined();
    expect(db.getSession(folder, 'unrecorded')).toBeUndefined();
    expect(
      db
        .listWorkspaceRuntimeSessionsByWorkspace(workspaceJid)
        .map((row) => [row.runtime_agent_id, row.sdk_session_id]),
    ).toEqual([['', 'sdk-main']]);

    // The pinned conversation resumes the session it ran on glm-5.2.
    expect(runner.willClearSessionOnProviderSwitch(folder, null)).toBe(false);
    const next = runner.trySelectPoolProvider(folder, null)!;
    providerPool.releaseSession(next.profileId);
    expect(next.resetSession).toBeFalsy();
    expect(next.resolved.config.anthropicModel).toBe('glm-5.2');
    expect(db.getSession(folder)).toBe('sdk-main');
    db.setSessionModelSelection(folder, null, null);
  });

  test('a new address with a new default drops only the sessions on the old default', async () => {
    const folder = 'address-default-folder';
    const provider = thirdParty({
      enabled: true,
      models: [{ id: 'glm-5.3' }, { id: 'glm-5.2' }],
    });
    for (const [agentId, model] of [
      ['on-other', 'glm-5.2'],
      ['on-default', 'glm-5.3'],
    ] as const) {
      db.setSession(folder, `sdk-${agentId}`, agentId);
      db.setSessionProviderId(folder, agentId, provider.id);
      db.setSessionModel(folder, agentId, model);
    }

    const patched = await request('PATCH', `/providers/${provider.id}`, {
      anthropicBaseUrl: 'https://relay.example.test',
      anthropicModel: 'glm-5.2',
    });
    expect(patched.status).toBe(200);
    expect(patched.body.applied).toMatchObject({ clearedSessionsCount: 1 });
    expect(db.getSession(folder, 'on-other')).toBe('sdk-on-other');
    expect(db.getSession(folder, 'on-default')).toBeUndefined();
  });

  test("an older client's [1m] on the model sets its window and keeps every session", async () => {
    const provider = thirdParty({ enabled: true });
    boundSession(provider.id);
    const patched = await request('PATCH', `/providers/${provider.id}`, {
      anthropicModel: 'glm-5.3[1m]',
    });
    expect(patched.status).toBe(200);
    expect(patched.body.provider).toMatchObject({
      anthropicModel: 'glm-5.3',
      models: [{ id: 'glm-5.3', contextWindow: 1_000_000 }],
    });
    // Not a model change: the window reaches the next launch.
    expect(queue.pauseGroupsForMutation).not.toHaveBeenCalled();
    expect(db.getSession('connections-folder')).toBe('sdk-session-1');
  });

  test('a default that would push a full list past its cap is refused', async () => {
    const provider = thirdParty({
      models: Array.from({ length: 100 }, (_, index) => ({
        id: index === 0 ? 'glm-5.3' : `m-${index}`,
      })),
    });
    const patched = await request('PATCH', `/providers/${provider.id}`, {
      anthropicModel: 'glm-new',
    });
    expect(patched.status).toBe(400);
    expect(patched.body.error).toContain('最多 100 个模型');
    expect(runtimeConfig.getProviderById(provider.id)!.models).toHaveLength(
      100,
    );
  });

  test('a preset does not follow the connection to another address', async () => {
    const created = await request('POST', '/providers', {
      name: 'Relay',
      type: 'third_party',
      presetId: 'deepseek',
      anthropicBaseUrl: upstream,
      anthropicAuthToken: 'relay-secret-123456',
    });
    expect(created.body.presetId).toBeNull();

    const preset = thirdParty({
      anthropicBaseUrl: 'https://api.deepseek.com/anthropic',
      presetId: 'deepseek',
    });
    expect(preset.presetId).toBe('deepseek');
    const moved = await request('PATCH', `/providers/${preset.id}`, {
      anthropicBaseUrl: upstream,
    });
    expect(moved.body.provider.presetId).toBeNull();
  });

  test('a model an Agent runs cannot be removed or renamed; its window can change', async () => {
    const provider = thirdParty({
      models: [{ id: 'glm-5.3' }, { id: 'glm-5.2' }, { id: 'glm-5.1' }],
    });
    const agent = bindAgent(provider.id, 'glm-5.2');
    bindAgent(provider.id, 'glm-5.3', 'On the default');

    const removed = await request('PATCH', `/providers/${provider.id}`, {
      models: [{ id: 'glm-5.3' }],
    });
    expect(removed).toEqual({
      status: 409,
      body: {
        error: expect.stringContaining('Coder'),
        code: 'MODEL_IN_USE',
        agents: [{ id: agent.id, name: 'Coder' }],
      },
    });
    const renamed = await request('PATCH', `/providers/${provider.id}`, {
      models: [{ id: 'glm-5.3' }, { id: 'glm-5.2-x' }, { id: 'glm-5.1' }],
    });
    expect(renamed.status).toBe(409);
    expect(runtimeConfig.getProviderById(provider.id)?.models).toHaveLength(3);
    // `[1m]` is the window, not a new name.
    const widened = await request('PATCH', `/providers/${provider.id}`, {
      models: [{ id: 'glm-5.3' }, { id: 'glm-5.2[1m]' }, { id: 'glm-5.1' }],
    });
    expect(widened.status).toBe(200);
    expect(widened.body.provider.models[1]).toEqual({
      id: 'glm-5.2',
      contextWindow: 1_000_000,
    });

    // A model nobody runs goes.
    const dropped = await request('PATCH', `/providers/${provider.id}`, {
      models: [{ id: 'glm-5.3' }, { id: 'glm-5.2' }],
    });
    expect(dropped.status).toBe(200);
    expect(dropped.body.provider.models).toEqual([
      { id: 'glm-5.3' },
      { id: 'glm-5.2' },
    ]);
  });

  test('presetId can be cleared', async () => {
    const provider = thirdParty({ presetId: 'zhipu-glm-cn' });
    const patched = await request('PATCH', `/providers/${provider.id}`, {
      presetId: null,
    });
    expect(patched.body.provider.presetId).toBeNull();
  });
});

// ─── Model lists ───────────────────────────────────────────────

describe('POST /providers/discover-models', () => {
  test('lists a draft endpoint, finding the header style it takes', async () => {
    reply = xApiKeyOnly('relay-secret-123456', {
      status: 200,
      body: {
        data: [
          { id: 'glm-5.3', display_name: 'GLM 5.3', context_length: 1_000_000 },
          { id: 'glm-5.2' },
        ],
      },
    });
    const { status, body } = await request(
      'POST',
      '/providers/discover-models',
      {
        type: 'third_party',
        anthropicBaseUrl: upstream,
        anthropicAuthToken: 'relay-secret-123456',
      },
    );
    expect(status).toBe(200);
    expect(body).toEqual({
      ok: true,
      source: 'endpoint',
      authMode: 'x-api-key',
      gateway: null,
      models: [
        { id: 'glm-5.3', name: 'GLM 5.3', contextWindow: 1_000_000 },
        { id: 'glm-5.2' },
      ],
    });
    expect(seen.map((item) => item.url)).toEqual(['/v1/models', '/v1/models']);
    expect(seen[0].headers.authorization).toBe('Bearer relay-secret-123456');
    expect(seen[1].headers['x-api-key']).toBe('relay-secret-123456');
    expect(seen[1].headers['user-agent']).toMatch(/^claude-cli/);
  });

  test('returns the efforts and window a vendor declares', async () => {
    reply = () => ({
      status: 200,
      body: {
        data: [
          {
            id: 'k3',
            context_length: 256_000,
            supported_reasoning_levels: ['low', 'medium', 'high', 'minimal'],
            default_reasoning_level: 'high',
          },
          { id: 'k3-mini' },
        ],
      },
    });
    const { status, body } = await request(
      'POST',
      '/providers/discover-models',
      {
        type: 'third_party',
        anthropicBaseUrl: upstream,
        anthropicAuthToken: 'relay-secret-123456',
        anthropicAuthMode: 'bearer',
      },
    );
    expect(status).toBe(200);
    expect(body.models).toEqual([
      {
        id: 'k3',
        contextWindow: 256_000,
        efforts: ['low', 'medium', 'high'],
        defaultEffort: 'high',
      },
      { id: 'k3-mini' },
    ]);
  });

  test('a chosen header style is not second-guessed', async () => {
    reply = xApiKeyOnly('relay-secret-123456', { status: 200, body: [] });
    const { body } = await request('POST', '/providers/discover-models', {
      anthropicBaseUrl: upstream,
      anthropicAuthToken: 'relay-secret-123456',
      anthropicAuthMode: 'bearer',
    });
    expect(body).toMatchObject({
      ok: false,
      code: 'AUTH_INVALID',
      status: 401,
    });
    expect(seen).toHaveLength(1);
  });

  test('reads a saved connection, its custom headers and a versioned path', async () => {
    reply = () => ({ status: 200, body: { models: ['m-1', 'm-2'] } });
    const provider = thirdParty({
      anthropicBaseUrl: `${upstream}/api/v4`,
      anthropicAuthMode: 'bearer',
      customEnv: { ANTHROPIC_CUSTOM_HEADERS: 'X-Tenant: acme' },
    });
    const { body } = await request('POST', '/providers/discover-models', {
      providerId: provider.id,
    });
    expect(body).toMatchObject({
      ok: true,
      models: [{ id: 'm-1' }, { id: 'm-2' }],
      authMode: 'bearer',
    });
    expect(seen[0].url).toBe('/api/v4/models');
    expect(seen[0].headers['x-tenant']).toBe('acme');
  });

  test('a draft lists models with its custom headers, keeping their values out of errors', async () => {
    reply = (request) =>
      request.headers['x-relay-key'] === 'relay-header-secret'
        ? { status: 200, body: { data: [{ id: 'relay-1' }] } }
        : {
            status: 401,
            body: {
              error: {
                message: `bad x-relay-key ${request.headers['x-relay-key']}`,
              },
            },
          };
    const customEnv = {
      ANTHROPIC_CUSTOM_HEADERS: 'X-Relay-Key: relay-header-secret',
    };
    const { body } = await request('POST', '/providers/discover-models', {
      anthropicBaseUrl: upstream,
      anthropicAuthToken: 'relay-secret-123456',
      customEnv,
    });
    expect(body).toMatchObject({ ok: true, models: [{ id: 'relay-1' }] });

    // A saved connection uses its own env, not one sent with the request.
    const saved = thirdParty({
      customEnv: {
        ANTHROPIC_CUSTOM_HEADERS: 'X-Relay-Key: stale-header-value',
      },
    });
    const refused = await request('POST', '/providers/discover-models', {
      providerId: saved.id,
      customEnv,
    });
    expect(refused.body).toMatchObject({ ok: false, code: 'AUTH_INVALID' });
    expect(refused.body.message).not.toContain('stale-header-value');
  });

  test('explains failures without the key', async () => {
    reply = () => ({ status: 404, body: { error: 'model list not found' } });
    expect(
      (
        await request('POST', '/providers/discover-models', {
          anthropicBaseUrl: upstream,
          anthropicAuthToken: 'relay-secret-123456',
        })
      ).body,
    ).toMatchObject({ ok: false, code: 'ENDPOINT_NOT_FOUND', status: 404 });

    reply = () => ({ status: 200, body: '<html>hello</html>' });
    expect(
      (
        await request('POST', '/providers/discover-models', {
          anthropicBaseUrl: upstream,
          anthropicAuthToken: 'relay-secret-123456',
        })
      ).body,
    ).toEqual({
      ok: false,
      code: 'UNKNOWN',
      status: 200,
      message: '返回的内容不是模型列表',
    });

    reply = () => ({
      status: 401,
      body: { error: { message: 'bad key relay-secret-123456' } },
    });
    const refused = await request('POST', '/providers/discover-models', {
      anthropicBaseUrl: upstream,
      anthropicAuthToken: 'relay-secret-123456',
    });
    expect(refused.body).toMatchObject({
      ok: false,
      code: 'AUTH_INVALID',
      status: 401,
    });
    expect(JSON.stringify(refused.body)).not.toContain('relay-secret-123456');
    // Logs name the origin only.
    const logged = JSON.stringify(logger.info.mock.calls);
    expect(logged).toContain(upstream);
    expect(logged).not.toContain('/v1/models');
    expect(logged).not.toContain('relay-secret-123456');
  });

  test('a preset named with another address lists models at that address', async () => {
    reply = () => ({ status: 200, body: { data: [{ id: 'relay-1' }] } });
    const { body } = await request('POST', '/providers/discover-models', {
      presetId: 'moonshot-kimi-cn',
      anthropicBaseUrl: upstream,
      anthropicAuthToken: 'relay-secret-123456',
    });
    expect(body).toMatchObject({ ok: true, models: [{ id: 'relay-1' }] });
    expect(seen.map((item) => item.url)).toEqual(['/v1/models']);
  });

  test('a retry that fails for another reason adopts no header style', async () => {
    reply = refuses('bearer', { status: 500, body: { error: 'boom' } });
    const { body } = await request('POST', '/providers/discover-models', {
      anthropicBaseUrl: upstream,
      anthropicAuthToken: 'relay-secret-123456',
    });
    expect(body).toMatchObject({
      ok: false,
      code: 'AUTH_FORBIDDEN',
      status: 403,
    });
    expect(body).not.toHaveProperty('authMode');
    expect(seen).toHaveLength(2);
  });

  test('a preset address lists models where the vendor does', async () => {
    reply = () => ({ status: 200, body: { data: [] } });
    // Kimi lists its models off the /anthropic path; the preset knows where.
    const { body } = await request('POST', '/providers/discover-models', {
      presetId: 'moonshot-kimi-cn',
      anthropicAuthToken: 'kimi-secret-123456',
    });
    // The request goes to the real vendor, which this test blocks.
    expect(body).toMatchObject({ ok: false, status: 599 });
  });

  test('a subscription offers the built-in aliases without a request', async () => {
    const { body } = await request('POST', '/providers/discover-models', {
      type: 'official',
      claudeCredentialInput: 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz',
    });
    expect(body).toMatchObject({ ok: true, source: 'builtin' });
    expect(body.models.map((model: { id: string }) => model.id)).toEqual([
      'opus',
      'sonnet',
      'haiku',
      'fable',
    ]);
    expect(anthropic).not.toHaveBeenCalled();
  });

  test('an official key lists Anthropic models', async () => {
    anthropic.mockReturnValue({
      status: 200,
      body: {
        data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }],
      },
    });
    const { body } = await request('POST', '/providers/discover-models', {
      type: 'official',
      anthropicApiKey: 'sk-ant-api03-abcdefghijklmnop',
    });
    expect(body).toEqual({
      ok: true,
      source: 'endpoint',
      authMode: 'x-api-key',
      gateway: null,
      models: [{ id: 'claude-opus-5-5', name: 'Claude Opus 5.5' }],
    });
    const [url, init] = anthropic.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/models?limit=1000');
    expect(init.headers).toMatchObject({
      'x-api-key': 'sk-ant-api03-abcdefghijklmnop',
      'anthropic-version': '2023-06-01',
    });
  });

  test('a ChatGPT subscription offers its catalog', async () => {
    chatgpt.mockReturnValue({ status: 200, body: CHATGPT_MODELS });
    const provider = chatGptProvider();
    const { body } = await request('POST', '/providers/discover-models', {
      providerId: provider.id,
    });
    expect(body).toEqual({
      ok: true,
      source: 'catalog',
      gateway: null,
      models: [{ id: 'gpt-6-sol' }],
    });
  });

  test('shares the per-minute budget with the connection test', async () => {
    for (let index = 0; index < 5; index += 1) {
      await request('POST', '/providers/discover-models', { type: 'official' });
      await request('POST', '/providers/test', { type: 'official' });
    }
    expect(
      (
        await request('POST', '/providers/discover-models', {
          type: 'official',
        })
      ).status,
    ).toBe(429);
    expect(
      (await request('POST', '/providers/test', { type: 'official' })).status,
    ).toBe(429);
  });
});

// ─── Connection tests ──────────────────────────────────────────

describe('POST /providers/test', () => {
  test('a draft endpoint reports the header style that worked', async () => {
    reply = xApiKeyOnly('relay-secret-123456', { status: 200, body: {} });
    const { body } = await request('POST', '/providers/test', {
      type: 'third_party',
      anthropicBaseUrl: upstream,
      anthropicAuthToken: 'relay-secret-123456',
      anthropicModel: 'glm-5.3[1m]',
    });
    expect(body).toMatchObject({
      ok: true,
      code: null,
      authMode: 'x-api-key',
      record: { ok: true, code: null, status: 200, model: 'glm-5.3' },
    });
    expect(seen.map((item) => [item.method, item.url])).toEqual([
      ['POST', '/v1/messages'],
      ['POST', '/v1/messages'],
    ]);
    expect(JSON.parse(seen[1].body)).toMatchObject({
      model: 'glm-5.3',
      max_tokens: 16,
    });
  });

  test('both styles refused is a bad key, with no style reported', async () => {
    reply = () => ({
      status: 401,
      body: { error: { message: 'invalid token relay-secret-123456' } },
    });
    const { body } = await request('POST', '/providers/test', {
      anthropicBaseUrl: upstream,
      anthropicAuthToken: 'relay-secret-123456',
      anthropicModel: 'glm-5.3',
    });
    expect(body).toMatchObject({
      ok: false,
      code: 'AUTH_INVALID',
      record: { ok: false, code: 'AUTH_INVALID', status: 401 },
    });
    expect(body).not.toHaveProperty('authMode');
    expect(body.probes[0].hint).toContain('两种认证方式');
    expect(JSON.stringify(body)).not.toContain('relay-secret-123456');
  });

  test('a retry that proves nothing about the key adopts no header style', async () => {
    for (const other of [
      { status: 503, body: { error: { message: 'upstream overloaded' } } },
      { status: 429, body: { error: { message: 'slow down' } } },
      { status: 400, body: { error: { message: 'bad request' } } },
    ]) {
      seen.length = 0;
      reply = refuses('bearer', other);
      const { body } = await request('POST', '/providers/test', {
        anthropicBaseUrl: upstream,
        anthropicAuthToken: 'relay-secret-123456',
        anthropicModel: 'glm-5.3',
      });
      expect(seen).toHaveLength(2);
      // The first answer stands: the key was refused in its first style.
      expect(body).toMatchObject({
        ok: false,
        code: 'AUTH_FORBIDDEN',
        record: { status: 403 },
      });
      expect(body).not.toHaveProperty('authMode');
    }
  });

  test('a retry the endpoint judged past the key adopts that style', async () => {
    reply = (request) =>
      request.headers['x-api-key']
        ? {
            status: 404,
            body: { error: { message: 'model glm-5.3 does not exist' } },
          }
        : { status: 401, body: { error: { message: 'unauthorized' } } };
    const { body } = await request('POST', '/providers/test', {
      anthropicBaseUrl: upstream,
      anthropicAuthToken: 'relay-secret-123456',
      anthropicModel: 'glm-5.3',
    });
    expect(body).toMatchObject({
      ok: false,
      code: 'MODEL_NOT_FOUND',
      authMode: 'x-api-key',
    });
  });

  test('a first answer that proves nothing about the key reports no style', async () => {
    reply = () => ({ status: 429, body: { error: { message: 'slow down' } } });
    const { body } = await request('POST', '/providers/test', {
      anthropicBaseUrl: upstream,
      anthropicAuthToken: 'relay-secret-123456',
      anthropicModel: 'glm-5.3',
    });
    expect(body).toMatchObject({ ok: false, code: 'RATE_LIMITED' });
    expect(body).not.toHaveProperty('authMode');
    expect(seen).toHaveLength(1);
  });

  test('a saved connection keeps no header style an inconclusive retry suggested', async () => {
    // Saved before styles were chosen: its runtime sends a bare token as
    // x-api-key, which this endpoint refuses; Bearer only gets a 503.
    reply = refuses('x-api-key', {
      status: 503,
      body: { error: { message: 'upstream overloaded' } },
    });
    const provider = thirdParty();
    const { body } = await request('POST', '/providers/test', {
      providerId: provider.id,
    });
    expect(body).not.toHaveProperty('authMode');
    const saved = runtimeConfig.getProviderById(provider.id)!;
    expect(saved.anthropicAuthMode).toBeUndefined();
    expect(saved.lastTest).toMatchObject({ ok: false, code: 'AUTH_FORBIDDEN' });
    expect(
      queue.drainProviderRunnersForCredentialRefresh,
    ).not.toHaveBeenCalled();
  });

  test("a preset named with another address does not lend it the preset's model", async () => {
    const { body } = await request('POST', '/providers/test', {
      presetId: 'deepseek',
      anthropicBaseUrl: upstream,
      anthropicAuthToken: 'relay-secret-123456',
    });
    expect(body.ok).toBe(true);
    expect(JSON.parse(seen[0].body).model).toBe('claude-haiku-5-5');
  });

  test('a preset draft is probed on its first model at its address', async () => {
    const { body } = await request('POST', '/providers/test', {
      presetId: 'deepseek',
      anthropicAuthToken: 'ds-secret-123456',
    });
    // Blocked here: what matters is which model the probe named.
    expect(body.record).toMatchObject({ model: 'deepseek-flash' });
  });

  test('a saved connection keeps the result and the header style it found', async () => {
    reply = xApiKeyOnly('relay-secret-123456', { status: 200, body: {} });
    // Saved before styles were chosen, with a `Bearer …` token: its runtime
    // sends Authorization, which this endpoint refuses.
    const provider = thirdParty({
      anthropicAuthToken: 'Bearer relay-secret-123456',
    });
    const { body } = await request('POST', '/providers/test', {
      providerId: provider.id,
    });
    expect(body).toMatchObject({ ok: true, authMode: 'x-api-key' });
    const saved = runtimeConfig.getProviderById(provider.id)!;
    expect(saved.anthropicAuthMode).toBe('x-api-key');
    expect(saved.lastTest).toEqual(body.record);
    expect(runtimeConfig.toPublicProvider(saved).lastTest).toEqual(body.record);
    // Its runners still send the refused header: they retire.
    expect(queue.drainProviderRunnersForCredentialRefresh).toHaveBeenCalledWith(
      provider.id,
    );
    expect(queue.pauseGroupsForMutation).not.toHaveBeenCalled();
  });

  test('a saved connection that works as it is keeps running as it is', async () => {
    const provider = thirdParty({ anthropicAuthMode: 'bearer' });
    const before = runtimeConfig.getProviderById(provider.id)!.updatedAt;
    const { body } = await request('POST', '/providers/test', {
      providerId: provider.id,
    });
    expect(body.ok).toBe(true);
    const saved = runtimeConfig.getProviderById(provider.id)!;
    expect(saved.lastTest).toMatchObject({ ok: true });
    expect(saved.updatedAt).toBe(before);
    expect(
      queue.drainProviderRunnersForCredentialRefresh,
    ).not.toHaveBeenCalled();
  });

  test('testing edits that are not saved leaves the saved result alone', async () => {
    const provider = thirdParty({ anthropicAuthMode: 'bearer' });
    await request('POST', '/providers/test', {
      providerId: provider.id,
      anthropicAuthToken: 'another-secret-654321',
    });
    expect(
      runtimeConfig.getProviderById(provider.id)!.lastTest,
    ).toBeUndefined();
    // Another model of the same connection is still this connection.
    await request('POST', '/providers/test', {
      providerId: provider.id,
      anthropicModel: 'glm-5.2',
    });
    expect(runtimeConfig.getProviderById(provider.id)!.lastTest).toMatchObject({
      model: 'glm-5.2',
    });
  });

  test('an official key runs a minimal message on a concrete model', async () => {
    anthropic.mockReturnValue({ status: 200, body: { id: 'msg_1' } });
    const { body } = await request('POST', '/providers/test', {
      type: 'official',
      anthropicApiKey: 'sk-ant-api03-abcdefghijklmnop',
      anthropicModel: 'claude-opus-5-5[1m]',
    });
    expect(body).toMatchObject({
      ok: true,
      record: { model: 'claude-opus-5-5', status: 200 },
    });
    const [url, init] = anthropic.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers).toMatchObject({
      'x-api-key': 'sk-ant-api03-abcdefghijklmnop',
    });
  });

  test('an official key on an alias reads the model list, which bills nothing', async () => {
    anthropic.mockReturnValue({
      status: 401,
      body: {
        type: 'error',
        error: {
          type: 'authentication_error',
          message: 'invalid x-api-key sk-ant-api03-abcdefghijklmnop',
        },
      },
    });
    const provider = runtimeConfig.createProvider({
      name: 'Claude',
      type: 'official',
      anthropicApiKey: 'sk-ant-api03-abcdefghijklmnop',
      anthropicModel: 'opus',
    });
    const { body } = await request('POST', '/providers/test', {
      providerId: provider.id,
    });
    expect(anthropic.mock.calls[0][0]).toBe(
      'https://api.anthropic.com/v1/models?limit=1',
    );
    expect(body).toMatchObject({
      ok: false,
      code: 'AUTH_INVALID',
      record: { ok: false, code: 'AUTH_INVALID', status: 401, model: null },
    });
    expect(JSON.stringify(body)).not.toContain('abcdefghijklmnop');
  });

  test('a credential in the request replaces the saved one as a whole', async () => {
    anthropic.mockReturnValue({ status: 200, body: { data: [] } });
    const provider = runtimeConfig.createProvider({
      name: 'Claude',
      type: 'official',
      anthropicApiKey: 'sk-ant-api03-saved-key-123456',
    });
    await request('POST', '/providers/test', {
      providerId: provider.id,
      anthropicAuthToken: 'sk-ant-api03-other-token-654321',
    });
    expect(anthropic.mock.calls[0][1].headers).toMatchObject({
      authorization: 'Bearer sk-ant-api03-other-token-654321',
    });
    expect(anthropic.mock.calls[0][1].headers).not.toHaveProperty('x-api-key');
    // The saved connection was not what ran.
    expect(
      runtimeConfig.getProviderById(provider.id)!.lastTest,
    ).toBeUndefined();
  });

  test('a pasted setup-token is checked against the account, not billed', async () => {
    anthropic.mockReturnValue({
      status: 403,
      body: {
        error: { message: 'OAuth token does not meet scope requirement' },
      },
    });
    const token = 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz';
    const ok = await request('POST', '/providers/test', {
      type: 'official',
      claudeCredentialInput: token,
    });
    expect(ok.body).toMatchObject({ ok: true, record: { model: null } });
    const [url, init] = anthropic.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/api/oauth/usage');
    expect(init.headers).toMatchObject({ authorization: `Bearer ${token}` });

    anthropic.mockReturnValue({
      status: 401,
      body: { error: { message: 'invalid bearer token' } },
    });
    const refused = await request('POST', '/providers/test', {
      type: 'official',
      claudeCredentialInput: token,
    });
    expect(refused.body).toMatchObject({ ok: false, code: 'AUTH_INVALID' });
    // Never saved.
    expect(runtimeConfig.getProviders()).toEqual([]);
  });

  test('an account refused for anything but a missing scope fails', async () => {
    for (const message of [
      'OAuth authentication is currently not allowed for this organization.',
      'Request not allowed',
    ]) {
      anthropic.mockReturnValue({
        status: 403,
        body: { type: 'error', error: { type: 'permission_error', message } },
      });
      const { body } = await request('POST', '/providers/test', {
        type: 'official',
        claudeCredentialInput: 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyz',
      });
      expect(body).toMatchObject({ ok: false, code: 'AUTH_FORBIDDEN' });
    }
  });

  test('a saved login whose renewal fails for now is not called a bad key', async () => {
    const provider = runtimeConfig.createProvider({
      name: 'Claude',
      type: 'official',
      claudeOAuthCredentials: {
        accessToken: 'sk-ant-oat01-expired-access-token',
        refreshToken: 'sk-ant-ort01-refresh-token-abcdef',
        expiresAt: Date.now() - 1_000,
        scopes: ['user:inference', 'user:profile'],
      },
    });
    // The token endpoint is unreachable here; the usage endpoint would
    // refuse the expired token.
    anthropic.mockReturnValue({ status: 401, body: { error: 'expired' } });
    const { body } = await request('POST', '/providers/test', {
      providerId: provider.id,
    });
    expect(body).toMatchObject({
      ok: false,
      code: 'UPSTREAM_ERROR',
      probes: [{ message: '续期失败，稍后再试' }],
    });
    expect(anthropic).not.toHaveBeenCalled();
    expect(runtimeConfig.getProviderById(provider.id)!.lastTest).toMatchObject({
      code: 'UPSTREAM_ERROR',
    });
  });

  test('a pasted login whose access token expired is not renewed here', async () => {
    const { body } = await request('POST', '/providers/test', {
      type: 'official',
      claudeCredentialInput: JSON.stringify({
        claudeAiOauth: {
          accessToken: 'sk-ant-oat01-expired-access-token',
          refreshToken: 'sk-ant-ort01-refresh-token-abcdef',
          expiresAt: Date.now() - 1_000,
          scopes: ['user:inference', 'user:profile'],
        },
      }),
    });
    expect(body).toMatchObject({ ok: false, code: 'UNKNOWN' });
    expect(anthropic).not.toHaveBeenCalled();
  });

  test('a ChatGPT subscription fetches its live catalog', async () => {
    chatgpt.mockReturnValue({ status: 200, body: CHATGPT_MODELS });
    const provider = chatGptProvider();
    const passed = await request('POST', '/providers/test', {
      providerId: provider.id,
    });
    expect(passed.body).toMatchObject({
      ok: true,
      code: null,
      record: { ok: true, model: null, status: 200 },
    });
    expect(runtimeConfig.getProviderById(provider.id)!.lastTest).toMatchObject({
      ok: true,
    });

    chatgpt.mockReturnValue({ status: 429, body: {} });
    const limited = await request('POST', '/providers/test', {
      providerId: provider.id,
    });
    expect(limited.body).toMatchObject({
      ok: false,
      code: 'RATE_LIMITED',
      record: { status: 429 },
    });
  });
});

// ─── What an edit would stop ───────────────────────────────────

describe('GET /providers/:id/impact', () => {
  test('counts the runners on the connection and those an edit stops', async () => {
    const provider = thirdParty({ enabled: true });
    queue.getStatus.mockReturnValue({
      groups: [
        { jid: 'web:a', active: true, selectedProviderId: provider.id },
        { jid: 'web:b', active: true, selectedProviderId: 'other' },
        { jid: 'web:c', active: false, selectedProviderId: provider.id },
      ],
    });
    expect(await request('GET', `/providers/${provider.id}/impact`)).toEqual({
      status: 200,
      body: { activeRunners: 1, stoppedRunners: 2 },
    });

    // Disabled, bound by no Agent and picked by no conversation: an edit
    // stops nothing.
    const idle = thirdParty();
    expect((await request('GET', `/providers/${idle.id}/impact`)).body).toEqual(
      { activeRunners: 0, stoppedRunners: 0 },
    );
    db.setSessionModelSelection('connections-folder', null, idle.id, 'u');
    expect((await request('GET', `/providers/${idle.id}/impact`)).body).toEqual(
      { activeRunners: 0, stoppedRunners: 2 },
    );
    db.setSessionModelSelection('connections-folder', null, null);

    expect((await request('GET', '/providers/missing/impact')).status).toBe(
      404,
    );
  });
});

describe('who may check connections', () => {
  test('only manage_system_config reaches tests, model lists and impact', async () => {
    const provider = thirdParty();
    currentUser.role = 'member';
    for (const [method, url, body] of [
      ['POST', '/providers/test', { providerId: provider.id }],
      ['POST', '/providers/discover-models', { providerId: provider.id }],
      ['GET', `/providers/${provider.id}/impact`, undefined],
    ] as const) {
      expect((await request(method, url, body)).status).toBe(403);
    }
    expect(seen).toEqual([]);
  });
});
