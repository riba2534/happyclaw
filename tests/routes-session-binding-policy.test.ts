import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hono } from 'hono';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import type { RegisteredGroup } from '../src/types.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-binding-policy-'));
vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: path.join(root, 'data'),
  GROUPS_DIR: path.join(root, 'groups'),
  STORE_DIR: path.join(root, 'db'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/middleware/auth.js', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: 'policy-owner',
      username: 'policy-owner',
      role: 'member',
      permissions: [],
    });
    return next();
  },
  adminRoleMiddleware: async (_c: any, next: any) => next(),
  systemConfigMiddleware: async (_c: any, next: any) => next(),
}));
vi.mock('../src/web.js', () => ({
  broadcastAgentStatus: vi.fn(),
  broadcastAgentRemoved: vi.fn(),
}));

const db = await import('../src/db.js');
const { setWebDeps } = await import('../src/web-context.js');
const { injectChannelMountRuntimePort } =
  await import('../src/channel-mount-service.js');
const agents = (await import('../src/routes/agents.js')).default;
const config = (await import('../src/routes/config.js')).default;
const app = new Hono().route('/groups', agents).route('/config', config);
const workspaceJid = 'web:policy-workspace';
const cache: Record<string, RegisteredGroup> = {};
const liveChatInfo = vi.fn();
let sequence = 0;
let imJid: string;
let sessionId: string;

beforeAll(() => {
  for (const dir of ['db', 'data', 'groups'])
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  db.initDatabase();
  const now = new Date().toISOString();
  db.createUser({
    id: 'policy-owner',
    username: 'policy-owner',
    password_hash: 'test-only',
    display_name: 'Policy owner',
    role: 'member',
    status: 'active',
    created_at: now,
    updated_at: now,
    must_change_password: false,
  });
  db.setRegisteredGroup(workspaceJid, {
    name: 'Policy workspace',
    folder: 'policy-workspace',
    added_at: now,
    created_by: 'policy-owner',
  });
  db.createChannelAccount({
    id: 'policy-bot',
    owner_user_id: 'policy-owner',
    provider: 'feishu',
    name: 'Policy bot',
    secret_ref: 'test-only:policy-bot',
  });
  setWebDeps({
    getRegisteredGroups: () => cache,
    getChannelChatInfo: liveChatInfo,
  } as unknown as Parameters<typeof setWebDeps>[0]);
  injectChannelMountRuntimePort({ getRegisteredGroups: () => cache });
});

beforeEach(() => {
  sequence += 1;
  imJid = `feishu:oc_policy_${sequence}#account:policy-bot`;
  sessionId = `policy-session-${sequence}`;
  const now = new Date().toISOString();
  db.createAgent({
    id: sessionId,
    group_folder: 'policy-workspace',
    chat_jid: workspaceJid,
    name: 'Policy session',
    prompt: '',
    status: 'idle',
    kind: 'conversation',
    created_by: 'policy-owner',
    created_at: now,
    completed_at: null,
    result_summary: null,
    last_im_jid: null,
    spawned_from_jid: null,
    source_kind: 'manual',
  });
  cache[imJid] = {
    name: 'Ordinary Feishu group',
    folder: 'policy-workspace',
    added_at: now,
    created_by: 'policy-owner',
    channel_account_id: 'policy-bot',
    feishu_chat_mode: 'group',
    feishu_group_message_type: 'chat',
    activation_mode: 'always',
    audience_mode: 'everyone',
  };
  db.setRegisteredGroup(imJid, cache[imJid]);
  liveChatInfo
    .mockReset()
    .mockResolvedValue({ chat_mode: 'group', group_message_type: 'chat' });
});

afterAll(() => {
  injectChannelMountRuntimePort(null);
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

async function bind(
  endpoint: 'session' | 'agent-alias' | 'settings' | 'settings-main',
  policy: Record<string, unknown>,
) {
  const settings = endpoint.startsWith('settings');
  const url = settings
    ? `/config/user-im/bindings/${encodeURIComponent(imJid)}`
    : `/groups/${encodeURIComponent(workspaceJid)}/${endpoint === 'session' ? 'sessions' : 'agents'}/${sessionId}/im-binding`;
  const target =
    endpoint === 'settings-main'
      ? { target_session_id: 'main' }
      : settings
        ? { target_session_id: sessionId }
        : { im_jid: imJid };
  const response = await app.request(url, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...target, ...policy }),
  });
  return { status: response.status, body: await response.json() };
}

function expectPolicy(activation: string, audience: string) {
  const expected = {
    activation_mode: activation,
    audience_mode: audience,
    reply_policy: 'source_only',
  };
  expect(db.getRegisteredGroup(imJid)).toMatchObject(expected);
  expect(db.getChannelMount(imJid)).toMatchObject(expected);
  expect(cache[imJid]).toMatchObject(expected);
}

for (const endpoint of ['session', 'agent-alias', 'settings'] as const) {
  describe(`${endpoint} named-session response policy`, () => {
    test('persists selected activation and audience into the mount and live cache', async () => {
      const result = await bind(endpoint, {
        activation_mode: 'when_mentioned',
        audience_mode: 'owner_only',
        reply_policy: 'mirror',
      });
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expectPolicy('when_mentioned', 'owner_only');
      expect(db.getChannelMount(imJid)).toMatchObject({
        session_id: sessionId,
        workspace_jid: workspaceJid,
        routing_mode: 'single_session',
      });
    });

    test('normalizes legacy owner_mentioned without widening its audience', async () => {
      const result = await bind(endpoint, {
        activation_mode: 'owner_mentioned',
        audience_mode: 'everyone',
      });
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expectPolicy('when_mentioned', 'owner_only');
    });

    test('preserves omitted or invalid policies and updates audience independently', async () => {
      db.setRegisteredGroup(imJid, {
        ...cache[imJid],
        activation_mode: 'disabled',
        audience_mode: 'owner_only',
      });
      let result = await bind(endpoint, {
        activation_mode: 'invalid',
        audience_mode: 'invalid',
      });
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expectPolicy('disabled', 'owner_only');
      result = await bind(endpoint, { audience_mode: 'everyone' });
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expectPolicy('disabled', 'everyone');
    });

    test.each(['when_mentioned', 'owner_mentioned'])(
      'rejects private %s using fresh provider metadata without writing',
      async (activation_mode) => {
        liveChatInfo.mockResolvedValue({ chat_mode: 'p2p' });
        const before = db.getRegisteredGroup(imJid);
        const mountBefore = db.getChannelMount(imJid);
        const cacheBefore = cache[imJid];
        const result = await bind(endpoint, {
          activation_mode,
          audience_mode: 'owner_only',
        });
        expect(result.status, JSON.stringify(result.body)).toBe(400);
        expect(result.body.error).toMatch(/private chats.*mention activation/i);
        expect(db.getRegisteredGroup(imJid)).toEqual(before);
        expect(db.getChannelMount(imJid)).toEqual(mountBefore);
        expect(cache[imJid]).toBe(cacheBefore);
      },
    );

    test('allows private always mode with an explicit audience', async () => {
      liveChatInfo.mockResolvedValue({ chat_mode: 'p2p' });
      const result = await bind(endpoint, {
        activation_mode: 'always',
        audience_mode: 'owner_only',
      });
      expect(result.status, JSON.stringify(result.body)).toBe(200);
      expectPolicy('always', 'owner_only');
    });

    test('still rejects a native topic group as a fixed session', async () => {
      liveChatInfo.mockResolvedValue({
        chat_mode: 'group',
        group_message_type: 'thread',
      });
      const result = await bind(endpoint, {
        activation_mode: 'always',
        audience_mode: 'everyone',
      });
      expect(result.status, JSON.stringify(result.body)).toBe(400);
      expect(db.getRegisteredGroup(imJid)?.target_agent_id).toBeUndefined();
    });
  });
}

describe('settings has no main-session target', () => {
  test('`main` names no session', async () => {
    const result = await bind('settings-main', { activation_mode: 'always' });
    expect(result).toEqual({
      status: 404,
      body: { error: 'Session not found' },
    });
    expect(db.getChannelMount(imJid)).toBeUndefined();
  });

  test.each([
    ['an ordinary group', { chat_mode: 'group', group_message_type: 'chat' }],
    ['a private chat', { chat_mode: 'p2p' }],
  ])('%s cannot bind to a workspace', async (_label, chatInfo) => {
    liveChatInfo.mockResolvedValue(chatInfo);
    const response = await app.request(
      `/config/user-im/bindings/${encodeURIComponent(imJid)}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          target_main_jid: workspaceJid,
          activation_mode: 'always',
        }),
      },
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(
      /only accept native topic groups/,
    );
    expect(db.getRegisteredGroup(imJid)?.target_main_jid).toBeUndefined();
    expect(db.getChannelMount(imJid)).toBeUndefined();
  });
});
