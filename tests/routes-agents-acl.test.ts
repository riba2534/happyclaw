/**
 * Verifies Sub-Agent CRUD (create / rename / delete) requires workspace
 * ownership (canModifyGroup).
 *
 * Coverage matrix:
 *   - owner        → POST creates a conversation (200)
 *   - non-owner → routes return 404 (group hidden by canAccessGroup)
 *
 * Mirrors tests/routes-workspace-config-acl.test.ts. web.js's broadcast is
 * mocked so the success path doesn't pull in the full Hono app / WebSocket.
 */
import crypto from 'crypto';
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

import { buildNativeThreadRouteJid } from '../src/channel-native-context.js';
import type { RegisteredGroup } from '../src/types.js';
import { createRuntimeSourceHarness } from './helpers/runtime-source.js';

const SHARED_TMP =
  process.env.HAPPYCLAW_TEST_DATA_DIR ??
  (() => {
    const d = fs.mkdtempSync(
      path.join(os.tmpdir(), 'happyclaw-routes-agents-'),
    );
    process.env.HAPPYCLAW_TEST_DATA_DIR = d;
    return d;
  })();

const tmpDataDir = SHARED_TMP;

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  const dataDir = process.env.HAPPYCLAW_TEST_DATA_DIR!;
  return {
    ...real,
    DATA_DIR: dataDir,
    GROUPS_DIR: path.join(dataDir, 'groups'),
    STORE_DIR: path.join(dataDir, 'db'),
  };
});

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: vi.fn() },
}));

vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: process.env.HAPPYCLAW_TEST_USER_ID ?? 'alice',
      username: 'alice',
      role: process.env.HAPPYCLAW_TEST_USER_ROLE ?? 'member',
      permissions: [],
    });
    return next();
  },
}));

// Avoid loading the full web.js (Hono app + WebSocket) for the success path.
vi.mock('../src/web.js', () => ({
  broadcastAgentStatus: () => {},
  broadcastAgentRemoved: () => {},
}));

const agentRoutesModule = await import('../src/routes/agents.js');
const db = await import('../src/db.js');
const mountService = await import('../src/channel-mount-service.js');
const webContext = await import('../src/web-context.js');
const ledger = await import('../src/automation-run-ledger.js');
const reliability = await import('../src/channel-reliability-store.js');
const { logger } = await import('../src/logger.js');

const agentRoutes = agentRoutesModule.default;

const OWNER_ID = 'alice';
const OUTSIDER_ID = 'charlie';
const GROUP_JID = 'web:agents-acl-group';
const GROUP_FOLDER = 'agents-acl-group';

function seedTestGroup(): void {
  db.setRegisteredGroup(GROUP_JID, {
    name: 'Agents ACL Group',
    folder: GROUP_FOLDER,
    added_at: new Date().toISOString(),
    executionMode: 'container',
    created_by: OWNER_ID,
    is_home: false,
  } as any);
}

function asUser(userId: string, role: 'admin' | 'member' = 'member'): void {
  process.env.HAPPYCLAW_TEST_USER_ID = userId;
  process.env.HAPPYCLAW_TEST_USER_ROLE = role;
}

beforeAll(() => {
  fs.mkdirSync(path.join(tmpDataDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDataDir, 'groups'), { recursive: true });
  db.initDatabase();
});

let enqueueTask = vi.fn();
let broadcastNewMessage = vi.fn();

beforeEach(() => {
  enqueueTask = vi.fn();
  broadcastNewMessage = vi.fn();
  webContext.setWebDeps({
    getRegisteredGroups: () => ({}),
    broadcastAgentStatus: vi.fn(),
    broadcastAgentRemoved: vi.fn(),
    broadcastNewMessage,
    getLastAgentTimestamp: () => ({}),
    processAgentConversation: vi.fn(async () => {}),
    queue: {
      stopGroup: vi.fn(async () => {}),
      getActiveQueryId: () => null,
      enqueueTask,
    },
  } as unknown as Parameters<typeof webContext.setWebDeps>[0]);
  try {
    db.deleteRegisteredGroup(GROUP_JID);
  } catch {
    /* ignore */
  }
  try {
    db.deleteRegisteredGroup('telegram:bound-session');
  } catch {
    /* ignore */
  }
});

afterEach(() => {
  delete process.env.HAPPYCLAW_TEST_USER_ID;
  delete process.env.HAPPYCLAW_TEST_USER_ROLE;
});

async function postAgent(
  body: unknown,
): Promise<{ status: number; body: any }> {
  const res = await agentRoutes.request(
    `/${encodeURIComponent(GROUP_JID)}/agents`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function postSession(
  body: unknown,
): Promise<{ status: number; body: any }> {
  const res = await agentRoutes.request(
    `/${encodeURIComponent(GROUP_JID)}/sessions`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function newSessionId(name = 'Bound session'): Promise<string> {
  const created = await postSession({ name });
  expect(created.status).toBe(200);
  return created.body.session.id as string;
}

async function deleteSessionRoute(
  sessionId: string,
  query = '',
): Promise<{ status: number; body: any }> {
  const res = await agentRoutes.request(
    `/${encodeURIComponent(GROUP_JID)}/sessions/${sessionId}${query}`,
    { method: 'DELETE' },
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function patchSession(
  sessionId: string,
  body: unknown,
): Promise<{ status: number; body: any }> {
  const res = await agentRoutes.request(
    `/${encodeURIComponent(GROUP_JID)}/sessions/${sessionId}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function patchAgent(
  agentId: string,
  body: unknown,
): Promise<{ status: number; body: any }> {
  const res = await agentRoutes.request(
    `/${encodeURIComponent(GROUP_JID)}/agents/${agentId}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function deleteAgent(
  agentId: string,
): Promise<{ status: number; body: any }> {
  const res = await agentRoutes.request(
    `/${encodeURIComponent(GROUP_JID)}/agents/${agentId}`,
    { method: 'DELETE' },
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function getAgents(): Promise<{ status: number; body: any }> {
  const res = await agentRoutes.request(
    `/${encodeURIComponent(GROUP_JID)}/agents`,
    { method: 'GET' },
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

describe('agents CRUD ACL', () => {
  test('owner can POST (create) a conversation', async () => {
    seedTestGroup();
    asUser(OWNER_ID);

    const { status, body } = await postAgent({ name: 'My conversation' });
    expect(status).toBe(200);
    expect(body.agent?.id).toBeTruthy();
    expect(body.agent?.name).toBe('My conversation');
  });

  test('non-member returns 404 on POST (group hidden)', async () => {
    seedTestGroup();
    asUser(OUTSIDER_ID);

    const { status, body } = await postAgent({ name: 'Nope' });
    expect(status).toBe(404);
    expect(body.error).toMatch(/not found/i);
  });
});

describe('formal sessions API', () => {
  test('owner can POST /sessions (create) a conversation session', async () => {
    seedTestGroup();
    asUser(OWNER_ID);

    const { status, body } = await postSession({ name: 'Session API' });
    expect(status).toBe(200);
    expect(body.session?.id).toBeTruthy();
    expect(body.session?.name).toBe('Session API');
    expect(body.agent?.id).toBe(body.session?.id);
  });

  test('thread-mapped workspaces still allow independent Web sessions', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    db.setRegisteredGroup(GROUP_JID, {
      ...db.getRegisteredGroup(GROUP_JID)!,
      conversation_source: 'native_thread',
      conversation_nav_mode: 'vertical_threads',
    });

    const { status, body } = await postSession({
      name: 'Web alongside topics',
    });

    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.session).toMatchObject({
      name: 'Web alongside topics',
      source_kind: 'manual',
      title_source: 'manual',
    });
    expect(db.getAgent(body.session.id)).toMatchObject({
      chat_jid: GROUP_JID,
      source_kind: 'manual',
    });
    expect(db.getRegisteredGroup(GROUP_JID)).toMatchObject({
      conversation_source: 'native_thread',
      conversation_nav_mode: 'vertical_threads',
    });
  });

  test('legacy conversation creation also coexists with native topics', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    db.setRegisteredGroup(GROUP_JID, {
      ...db.getRegisteredGroup(GROUP_JID)!,
      conversation_source: 'feishu_thread',
      conversation_nav_mode: 'vertical_threads',
    });

    const { status, body } = await postAgent({ name: 'Legacy Web session' });

    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.agent).toMatchObject({
      name: 'Legacy Web session',
      source_kind: 'manual',
    });
  });

  test('a session with bindings answers 409 with every chat, topic and automation it takes', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    const sessionId = await newSessionId();
    db.setRegisteredGroup('telegram:bound-session', {
      name: 'Bound Telegram',
      folder: 'owner-home',
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
      target_agent_id: sessionId,
    } as any);
    db.upsertImContextBinding({
      source_jid: 'telegram:bound-session',
      context_type: 'thread',
      context_id: 'topic-9',
      workspace_jid: GROUP_JID,
      agent_id: sessionId,
      root_message_id: 'root-9',
      title: 'Topic',
      last_active_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    const service = {
      listForSession: vi.fn(() => [
        { id: 'auto-1', name: '日报', status: 'active' },
        { id: 'auto-2', name: '旧任务', status: 'completed' },
      ]),
      onSessionDeleted: vi.fn(),
    };
    ledger.setAutomationRuntimeService(service as never);
    try {
      expect(await deleteSessionRoute(sessionId)).toEqual({
        status: 409,
        body: {
          error: 'Session has channel bindings or automations',
          code: 'session_has_bindings',
          linked_im_groups: [
            { jid: 'telegram:bound-session', name: 'Bound Telegram' },
          ],
          thread_bindings: [
            {
              jid: 'telegram:bound-session',
              name: 'Bound Telegram',
              context_id: 'topic-9',
            },
          ],
          automations: [{ id: 'auto-1', name: '日报' }],
        },
      });
      expect(service.listForSession).toHaveBeenCalledWith(
        `${GROUP_JID}#agent:${sessionId}`,
      );
      expect(db.getAgent(sessionId)).toBeDefined();

      // Confirmed: the chats are left unbound, the topic binding goes, the
      // bound automations pause through onSessionDeleted.
      const cache: Record<string, RegisteredGroup> = {
        'telegram:bound-session': db.getRegisteredGroup(
          'telegram:bound-session',
        )!,
      };
      mountService.injectChannelMountRuntimePort({
        getRegisteredGroups: () => cache,
      });
      expect(
        await deleteSessionRoute(sessionId, '?confirm_bindings=true'),
      ).toEqual({ status: 200, body: { success: true } });
      expect(db.getAgent(sessionId)).toBeUndefined();
      expect(
        db.getRegisteredGroup('telegram:bound-session')?.target_agent_id,
      ).toBeUndefined();
      expect(cache['telegram:bound-session'].target_agent_id).toBeUndefined();
      expect(db.getChannelMount('telegram:bound-session')).toBeUndefined();
      expect(db.listImContextBindingsByAgent(sessionId)).toEqual([]);
      expect(service.onSessionDeleted).toHaveBeenCalledWith(
        `${GROUP_JID}#agent:${sessionId}`,
      );
    } finally {
      ledger.setAutomationRuntimeService(null);
      mountService.injectChannelMountRuntimePort(null);
      db.deleteRegisteredGroup('telegram:bound-session');
    }
  });

  test('a session without bindings or automations is deleted at once', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    const sessionId = await newSessionId();
    expect(await deleteSessionRoute(sessionId)).toEqual({
      status: 200,
      body: { success: true },
    });
    expect(db.getAgent(sessionId)).toBeUndefined();
  });

  test('rebind_to moves every bound chat to the other session before deleting', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    const doomed = await newSessionId('Doomed');
    const target = await newSessionId('Target');
    const chats = ['telegram:7001', 'telegram:7002'];
    for (const jid of chats) {
      db.setRegisteredGroup(jid, {
        name: jid,
        folder: 'owner-home',
        added_at: new Date().toISOString(),
        created_by: OWNER_ID,
        target_agent_id: doomed,
        activation_mode: 'always',
      } as any);
    }
    const cache: Record<string, RegisteredGroup> = Object.fromEntries(
      chats.map((jid) => [jid, db.getRegisteredGroup(jid)!]),
    );
    mountService.injectChannelMountRuntimePort({
      getRegisteredGroups: () => cache,
    });
    try {
      expect(
        await deleteSessionRoute(
          doomed,
          `?confirm_bindings=true&rebind_to=${target}`,
        ),
      ).toEqual({ status: 200, body: { success: true } });
      expect(db.getAgent(doomed)).toBeUndefined();
      for (const jid of chats) {
        expect(db.getRegisteredGroup(jid)).toMatchObject({
          target_agent_id: target,
          activation_mode: 'always',
        });
        expect(db.getChannelMount(jid)).toMatchObject({
          session_id: target,
          workspace_jid: GROUP_JID,
        });
        expect(cache[jid].target_agent_id).toBe(target);
      }
    } finally {
      mountService.injectChannelMountRuntimePort(null);
      for (const jid of chats) db.deleteRegisteredGroup(jid);
    }
  });

  test('rebinding several chats is one transaction: a failing chat moves none', () => {
    seedTestGroup();
    const sessions = ['tx-old', 'tx-new'];
    for (const id of sessions) {
      db.createAgent({
        id,
        group_folder: GROUP_FOLDER,
        chat_jid: GROUP_JID,
        name: id,
        prompt: '',
        status: 'idle',
        kind: 'conversation',
        created_by: OWNER_ID,
        created_at: new Date().toISOString(),
        completed_at: null,
        result_summary: null,
        last_im_jid: null,
        spawned_from_jid: null,
      });
    }
    const chats = ['telegram:tx-a', 'telegram:tx-b'];
    for (const jid of chats) {
      db.setRegisteredGroup(jid, {
        name: jid,
        folder: 'owner-home',
        added_at: new Date().toISOString(),
        created_by: OWNER_ID,
        target_agent_id: 'tx-old',
      } as any);
    }
    try {
      const [a, b] = chats.map((jid) => db.getRegisteredGroup(jid)!);
      expect(() =>
        mountService.commitChannelMountUpdates([
          [chats[0], mountService.buildSessionMountUpdate(a, 'tx-new')],
          [
            chats[1],
            {
              ...mountService.buildSessionMountUpdate(b, 'tx-new'),
              containerConfigError: 'broken',
            },
          ],
        ]),
      ).toThrow();
      for (const jid of chats) {
        expect(db.getRegisteredGroup(jid)?.target_agent_id).toBe('tx-old');
        expect(db.getChannelMount(jid)?.session_id).toBe('tx-old');
      }
    } finally {
      for (const jid of chats) db.deleteRegisteredGroup(jid);
      for (const id of sessions) db.deleteAgent(id);
    }
  });

  describe('rebinding the chats of a deleted session', () => {
    function makeSession(id: string, extra: Record<string, unknown> = {}) {
      db.createAgent({
        id,
        group_folder: GROUP_FOLDER,
        chat_jid: GROUP_JID,
        name: id,
        prompt: '',
        status: 'completed',
        kind: 'conversation',
        created_by: OWNER_ID,
        created_at: new Date().toISOString(),
        completed_at: null,
        result_summary: null,
        last_im_jid: null,
        spawned_from_jid: null,
        ...extra,
      } as any);
    }
    function chat(jid: string, extra: Record<string, unknown> = {}) {
      db.setRegisteredGroup(jid, {
        name: jid,
        folder: 'owner-home',
        added_at: new Date().toISOString(),
        created_by: OWNER_ID,
        ...extra,
      } as any);
    }
    const rebind = (doomed: string, target: string) =>
      deleteSessionRoute(doomed, `?confirm_bindings=true&rebind_to=${target}`);
    const suffix = () => Math.random().toString(36).slice(2, 8);
    let chatSeq = 8000;
    /** A direct Telegram chat id: a known conversation kind. */
    const nextChatId = () => ++chatSeq;

    test('a chat bound only through its mount moves too, with its own settings', async () => {
      seedTestGroup();
      asUser(OWNER_ID);
      const doomed = `doomed-${suffix()}`;
      const target = `target-${suffix()}`;
      makeSession(doomed);
      makeSession(target);
      const rowBound = `telegram:${nextChatId()}`;
      const mountOnly = `telegram:${nextChatId()}`;
      chat(rowBound, {
        target_agent_id: doomed,
        reply_policy: 'mirror',
        activation_mode: 'always',
        audience_mode: 'owner_only',
        owner_im_id: 'owner-im',
      });
      chat(mountOnly);
      db.upsertChannelMount({
        channel_jid: mountOnly,
        channel_account_id: null,
        channel_type: 'telegram',
        workspace_jid: GROUP_JID,
        session_id: doomed,
        routing_mode: 'single_session',
        reply_policy: 'source_only',
        activation_mode: 'auto',
        audience_mode: 'everyone',
        owner_im_id: null,
      });
      const listed = await deleteSessionRoute(doomed);
      expect(listed.status).toBe(409);
      expect(
        listed.body.linked_im_groups.map((g: { jid: string }) => g.jid).sort(),
      ).toEqual([mountOnly, rowBound].sort());

      expect(await rebind(doomed, target)).toEqual({
        status: 200,
        body: { success: true },
      });
      for (const jid of [rowBound, mountOnly]) {
        expect(db.getRegisteredGroup(jid)?.target_agent_id).toBe(target);
        expect(db.getChannelMount(jid)?.session_id).toBe(target);
      }
      expect(db.getRegisteredGroup(rowBound)).toMatchObject({
        reply_policy: 'mirror',
        activation_mode: 'always',
        audience_mode: 'owner_only',
        owner_im_id: 'owner-im',
      });
      // Nothing was waiting, so the target has no turn to start.
      expect(enqueueTask).not.toHaveBeenCalled();
      for (const jid of [rowBound, mountOnly]) db.deleteRegisteredGroup(jid);
    });

    test('the target must be a session chats can bind to, and each chat must pass a bind', async () => {
      seedTestGroup();
      asUser(OWNER_ID);
      const doomed = `doomed-${suffix()}`;
      makeSession(doomed);
      const bound = `telegram:${nextChatId()}`;
      chat(bound, { target_agent_id: doomed });
      for (const sourceKind of [
        'team_router',
        'work_item',
        'automation',
        'native_thread',
        'feishu_thread',
      ]) {
        const target = `${sourceKind}-${suffix()}`;
        makeSession(target, { source_kind: sourceKind });
        const result = await rebind(doomed, target);
        expect([sourceKind, result.status, result.body.code]).toEqual([
          sourceKind,
          400,
          'invalid_rebind_target',
        ]);
        // The same rule refuses a direct bind.
        const res = await agentRoutes.request(
          `/${encodeURIComponent(GROUP_JID)}/sessions/${target}/im-binding`,
          {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ im_jid: bound }),
          },
        );
        const direct = { status: res.status, body: await res.json() };
        expect([sourceKind, direct.status, direct.body]).toEqual([
          sourceKind,
          400,
          {
            error: 'This session cannot be bound to a chat',
            code: 'session_not_bindable',
          },
        ]);
      }
      // A chat another user owns cannot be moved by this one.
      const target = `target-${suffix()}`;
      makeSession(target);
      const foreign = `telegram:${nextChatId()}`;
      db.setRegisteredGroup(foreign, {
        name: 'Foreign',
        folder: 'other-home',
        added_at: new Date().toISOString(),
        created_by: OUTSIDER_ID,
        target_agent_id: doomed,
      } as any);
      const refused = await rebind(doomed, target);
      expect(refused.status).toBe(400);
      expect(refused.body.code).toBe('invalid_rebind_target');
      expect(db.getAgent(doomed)).toBeDefined();
      expect(db.getRegisteredGroup(bound)?.target_agent_id).toBe(doomed);
      for (const jid of [bound, foreign]) db.deleteRegisteredGroup(jid);
    });

    test('a target deleted while the delete waits is caught at the commit; nothing is deleted', async () => {
      seedTestGroup();
      asUser(OWNER_ID);
      const doomed = `doomed-${suffix()}`;
      const target = `target-${suffix()}`;
      makeSession(doomed);
      makeSession(target);
      const bound = `telegram:${nextChatId()}`;
      chat(bound, { target_agent_id: doomed });
      // The impact lookup runs after the first check: delete the target there.
      ledger.setAutomationRuntimeService({
        listForSession: () => {
          db.deleteAgent(target);
          return [];
        },
        onSessionDeleted: vi.fn(),
      } as never);
      try {
        const result = await rebind(doomed, target);
        expect(result.status).toBe(400);
        expect(result.body.code).toBe('invalid_rebind_target');
        expect(db.getAgent(doomed)).toBeDefined();
        expect(db.getRegisteredGroup(bound)?.target_agent_id).toBe(doomed);
      } finally {
        ledger.setAutomationRuntimeService(null);
        db.deleteRegisteredGroup(bound);
      }
    });

    /** A session about to go with one chat bound to it, and a session to move the chat to. */
    function rebindFixture(doomedExtra: Record<string, unknown> = {}) {
      seedTestGroup();
      asUser(OWNER_ID);
      const doomed = `doomed-${suffix()}`;
      const target = `target-${suffix()}`;
      makeSession(doomed, doomedExtra);
      makeSession(target);
      const bound = `telegram:${nextChatId()}`;
      chat(bound, { target_agent_id: doomed });
      const doomedLane = `${GROUP_JID}#agent:${doomed}`;
      db.ensureChatExists(doomedLane);
      /** An input in the doomed session's lane, from the bound chat by default. */
      const store = (
        id: string,
        input: {
          sourceJid?: string;
          timestamp?: string;
          meta?: Record<string, unknown>;
        } = {},
      ) =>
        db.storeMessageDirect(
          id,
          doomedLane,
          'tg:user',
          'User',
          `text ${id}`,
          input.timestamp ?? new Date().toISOString(),
          false,
          { sourceJid: input.sourceJid ?? bound, meta: input.meta },
        );
      /** A turn of session `agentId` for input `inputId` that has not ended. */
      const openTurn = (agentId: string, inputId: string) =>
        reliability.createChannelTurnRun({
          provider: 'telegram',
          accountId: 'test-account',
          sourceJid: bound,
          idempotencyKey: `turn-${agentId}-${inputId}`,
          agentId,
          correlationId: inputId,
        }).run;
      const targetLane = `${GROUP_JID}#agent:${target}`;
      return { doomed, target, bound, doomedLane, targetLane, store, openTurn };
    }

    test('a delete that throws at its last step changes nothing outside the database either', async () => {
      const { doomed, target, bound, doomedLane, targetLane, store, openTurn } =
        rebindFixture({ status: 'idle' });
      // An open turn of the session covers its first input.
      store('turn-input', { timestamp: '2026-11-01T10:00:00.000Z' });
      store('pending-input', { timestamp: '2026-11-01T10:01:00.000Z' });
      const turn = openTurn(doomed, 'turn-input');
      const sessionDir = path.join(
        tmpDataDir,
        'sessions',
        GROUP_FOLDER,
        'agents',
        doomed,
      );
      fs.mkdirSync(sessionDir, { recursive: true });
      const routerCache = { [bound]: db.getRegisteredGroup(bound)! };
      mountService.injectChannelMountRuntimePort({
        getRegisteredGroups: () => routerCache,
      });
      // The last write of the deletion fails.
      ledger.setAutomationRuntimeService({
        listForSession: () => [],
        onSessionDeleted: () => {
          throw new Error('hook failed');
        },
      } as never);
      try {
        // With the chat moved to another session, and with it left unbound.
        for (const attempt of [
          () => rebind(doomed, target),
          () => deleteSessionRoute(doomed, '?confirm_bindings=true'),
        ]) {
          expect((await attempt()).status).toBe(500);
          expect(db.getAgent(doomed)?.status).toBe('idle');
          expect(db.getRegisteredGroup(bound)?.target_agent_id).toBe(doomed);
          expect(db.getMessage(doomedLane, 'pending-input')).not.toBeNull();
          expect(db.getMessage(targetLane, 'pending-input')).toBeNull();
          expect(reliability.getChannelTurnRun(turn.id)?.status).toBe('queued');
          expect(routerCache[bound].target_agent_id).toBe(doomed);
          expect(fs.existsSync(sessionDir)).toBe(true);
          const deps = webContext.getWebDeps()!;
          expect(deps.queue.stopGroup).not.toHaveBeenCalled();
          expect(enqueueTask).not.toHaveBeenCalled();
          expect(broadcastNewMessage).not.toHaveBeenCalled();
          expect(deps.broadcastAgentRemoved).not.toHaveBeenCalled();
        }
      } finally {
        mountService.injectChannelMountRuntimePort(null);
        ledger.setAutomationRuntimeService(null);
        db.deleteRegisteredGroup(bound);
        db.deleteAgent(doomed);
      }
    });

    test('a step after the commit that fails is logged; the carried inputs still arrive', async () => {
      const { doomed, target, bound, targetLane, store } = rebindFixture();
      store('carry-me');
      mountService.injectChannelMountRuntimePort({
        getRegisteredGroups: () => {
          throw new Error('router cache unavailable');
        },
      });
      vi.mocked(logger.error).mockClear();
      try {
        expect(await rebind(doomed, target)).toEqual({
          status: 200,
          body: { success: true },
        });
      } finally {
        mountService.injectChannelMountRuntimePort(null);
      }
      expect(db.getAgent(doomed)).toBeUndefined();
      expect(
        broadcastNewMessage.mock.calls.map(([lane, message]) => [
          lane,
          message.id,
        ]),
      ).toEqual([[targetLane, 'carry-me']]);
      expect(enqueueTask).toHaveBeenCalledWith(
        targetLane,
        expect.stringContaining(`agent-conv:${target}`),
        expect.any(Function),
      );
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: doomed,
          step: 'reboundChatsCache',
        }),
        'A step after deleting a session failed',
      );
      db.deleteRegisteredGroup(bound);
    });

    test('inputs the session had not taken yet follow the chat to the target', async () => {
      const { doomed, target, bound, doomedLane, targetLane, store, openTurn } =
        rebindFixture();
      store('carry-plain');
      store('carry-queued', {
        meta: {
          deliveryMode: 'queue',
          deliveryStatus: 'queued',
          deliveryRunId: 'run-old',
        },
      });
      store('stay-other', { sourceJid: `telegram:${nextChatId()}` });
      store('stay-automation', { meta: { sourceKind: 'automation_prompt' } });
      // A turn of another session is not this deletion's.
      const otherTurn = openTurn(target, 'carry-plain');
      const routerCache = { [bound]: db.getRegisteredGroup(bound)! };
      mountService.injectChannelMountRuntimePort({
        getRegisteredGroups: () => routerCache,
      });

      try {
        expect((await rebind(doomed, target)).status).toBe(200);
      } finally {
        mountService.injectChannelMountRuntimePort(null);
      }
      // The router follows the commit.
      expect(routerCache[bound].target_agent_id).toBe(target);
      expect(reliability.getChannelTurnRun(otherTurn.id)?.status).toBe(
        'queued',
      );
      // A session not running still has its lane stopped (a retry timer goes).
      expect(webContext.getWebDeps()!.queue.stopGroup).toHaveBeenCalledWith(
        doomedLane,
      );
      const carried = db
        .getMessagesSince(targetLane, { timestamp: '', id: '' })
        .map((m) => m.id);
      expect(carried).toEqual(['carry-plain', 'carry-queued']);
      expect(db.getMessage(doomedLane, 'carry-plain')).toBeNull();
      // Announced in the target session and its turn started, after the commit.
      expect(
        broadcastNewMessage.mock.calls.map(([lane, message]) => [
          lane,
          message.id,
        ]),
      ).toEqual([
        [targetLane, 'carry-plain'],
        [targetLane, 'carry-queued'],
      ]);
      expect(enqueueTask).toHaveBeenCalledWith(
        targetLane,
        expect.stringContaining(`agent-conv:${target}`),
        expect.any(Function),
      );
      db.deleteRegisteredGroup(bound);
    });
  });

  test('rebind_to must be another session of this workspace', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    const doomed = await newSessionId('Doomed');
    db.setRegisteredGroup('web:rebind-elsewhere', {
      name: 'Elsewhere',
      folder: 'rebind-elsewhere',
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
    });
    db.createAgent({
      id: 'elsewhere-session',
      group_folder: 'rebind-elsewhere',
      chat_jid: 'web:rebind-elsewhere',
      name: 'Elsewhere',
      prompt: '',
      status: 'idle',
      kind: 'conversation',
      created_by: OWNER_ID,
      created_at: new Date().toISOString(),
      completed_at: null,
      result_summary: null,
      last_im_jid: null,
      spawned_from_jid: null,
    });
    try {
      for (const target of [doomed, 'missing-session', 'elsewhere-session']) {
        const result = await deleteSessionRoute(
          doomed,
          `?confirm_bindings=true&rebind_to=${target}`,
        );
        expect(result.status).toBe(400);
        expect(result.body.code).toBe('invalid_rebind_target');
      }
      expect(db.getAgent(doomed)).toBeDefined();
    } finally {
      db.deleteAgent('elsewhere-session');
      db.deleteRegisteredGroup('web:rebind-elsewhere');
    }
  });

  test('a former main session and the `main` id are sessions like any other', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    expect((await deleteSessionRoute('main')).status).toBe(404);
    expect((await patchSession('main', { pinned: true })).status).toBe(404);
    db.createAgent({
      id: 'legacy-main-session',
      group_folder: GROUP_FOLDER,
      chat_jid: GROUP_JID,
      name: 'Old conversation',
      prompt: '',
      status: 'idle',
      kind: 'conversation',
      created_by: OWNER_ID,
      created_at: new Date().toISOString(),
      completed_at: null,
      result_summary: null,
      last_im_jid: null,
      spawned_from_jid: null,
      source_kind: 'legacy_main',
      title_source: 'auto',
    });
    expect(
      (await patchSession('legacy-main-session', { name: 'Renamed' })).status,
    ).toBe(200);
    expect(await deleteSessionRoute('legacy-main-session')).toEqual({
      status: 200,
      body: { success: true },
    });
  });

  test('lists only real sessions, pinned first, each with the viewer pin time', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    const older = await newSessionId('Older');
    const newer = await newSessionId('Newer');
    db.updateAgentContextInfo(older, {
      last_active_at: '2026-01-01T00:00:00.000Z',
    });
    db.updateAgentContextInfo(newer, {
      last_active_at: '2026-06-01T00:00:00.000Z',
    });
    const list = async () => {
      const res = await agentRoutes.request(
        `/${encodeURIComponent(GROUP_JID)}/sessions`,
      );
      const all = (await res.json()).sessions as Array<Record<string, unknown>>;
      expect(
        all.filter(
          (s) => s.id === 'main' || s.kind === 'main' || 'is_main' in s,
        ),
      ).toEqual([]);
      // Sessions earlier tests left in the shared workspace are not ours.
      return all.filter((s) => s.id === older || s.id === newer);
    };
    let sessions = await list();
    expect(sessions.map((s) => s.id)).toEqual([newer, older]);
    expect(sessions.every((s) => s.pinned_at === null)).toBe(true);

    const pinned = await patchSession(older, { pinned: true });
    expect(pinned.status).toBe(200);
    expect(pinned.body).toEqual({
      success: true,
      pinned_at: expect.any(String),
    });
    sessions = await list();
    expect(sessions.map((s) => s.id)).toEqual([older, newer]);
    expect(sessions[0].pinned_at).toBe(pinned.body.pinned_at);

    const agentsRes = await agentRoutes.request(
      `/${encodeURIComponent(GROUP_JID)}/agents`,
    );
    const agents = (
      (await agentsRes.json()).agents as Array<Record<string, unknown>>
    ).filter((a) => a.id === older || a.id === newer);
    expect(agents.map((a) => a.id)).toEqual([older, newer]);
    expect(agents[0].pinned_at).toBe(pinned.body.pinned_at);

    // Another user's pins are their own.
    expect(db.getUserPinnedSessions(OUTSIDER_ID)).toEqual({});

    expect(await patchSession(older, { pinned: false })).toEqual({
      status: 200,
      body: { success: true, pinned_at: null },
    });
    expect((await list()).map((s) => s.id)).toEqual([newer, older]);
  });

  test('the agent list leaves out rows of the retired task kind', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    const session = await newSessionId('Kept');
    for (const [id, kind] of [
      ['retired-task-row', 'task'],
      ['spawned-task-row', 'spawn'],
    ] as const) {
      db.createAgent({
        id,
        group_folder: GROUP_FOLDER,
        chat_jid: GROUP_JID,
        name: id,
        prompt: '',
        status: 'completed',
        kind,
        created_by: OWNER_ID,
        created_at: new Date().toISOString(),
        completed_at: null,
        result_summary: null,
        last_im_jid: null,
        spawned_from_jid: null,
      });
    }
    const res = await agentRoutes.request(
      `/${encodeURIComponent(GROUP_JID)}/agents`,
    );
    const ids = ((await res.json()).agents as Array<{ id: string }>).map(
      (a) => a.id,
    );
    expect(ids).toContain(session);
    expect(ids).toContain('spawned-task-row');
    expect(ids).not.toContain('retired-task-row');
  });

  test('the topic of a deleted session opens a new session on its next message', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    const chatJid = `feishu:topics-${Date.now()}`;
    db.setRegisteredGroup(chatJid, {
      name: 'Topics',
      folder: GROUP_FOLDER,
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
      feishu_chat_mode: 'topic',
      target_main_jid: GROUP_JID,
      binding_mode: 'thread_map',
    } as any);
    const globals: Record<string, unknown> = {
      crypto,
      buildNativeThreadRouteJid,
      getImContextBinding: db.getImContextBinding,
      getAgent: db.getAgent,
      createAgent: db.createAgent,
      ensureAgentDirectories: () => {},
      ensureChatExists: db.ensureChatExists,
      updateChatName: db.updateChatName,
      updateAgentLastImJid: db.updateAgentLastImJid,
      broadcastAgentStatus: () => {},
      upsertImContextBinding: db.upsertImContextBinding,
      updateAgentContextInfo: db.updateAgentContextInfo,
      touchImContextBindingActivity: db.touchImContextBindingActivity,
    };
    createRuntimeSourceHarness(globals).install(
      'resolveOrCreateNativeThreadAgent',
    );
    const route = () =>
      (
        globals.resolveOrCreateNativeThreadAgent as (...args: unknown[]) => {
          agentId: string;
        }
      )(
        chatJid,
        GROUP_JID,
        db.getRegisteredGroup(GROUP_JID),
        db.getRegisteredGroup(chatJid),
        { contextId: 'omt_1', rootMessageId: 'om_1', title: 'A topic' },
      );
    try {
      const first = route().agentId;
      expect(route().agentId).toBe(first);
      const deletion = await deleteSessionRoute(first);
      expect(deletion.status).toBe(409);
      expect(deletion.body.thread_bindings).toEqual([
        { jid: chatJid, name: 'Topics', context_id: 'omt_1' },
      ]);
      expect(
        (await deleteSessionRoute(first, '?confirm_bindings=true')).status,
      ).toBe(200);
      expect(
        db.getImContextBinding(chatJid, 'thread', 'omt_1'),
      ).toBeUndefined();
      const second = route().agentId;
      expect(second).not.toBe(first);
      expect(db.getAgent(second)).toMatchObject({
        source_kind: 'native_thread',
        chat_jid: GROUP_JID,
      });
    } finally {
      db.deleteRegisteredGroup(chatJid);
    }
  });
  test('native-thread sessions have read-only titles but can be deleted', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    const sessionId = `native-session-${Date.now()}`;
    db.createAgent({
      id: sessionId,
      group_folder: GROUP_FOLDER,
      chat_jid: GROUP_JID,
      name: 'Native topic',
      prompt: '',
      status: 'idle',
      kind: 'conversation',
      created_by: OWNER_ID,
      created_at: new Date().toISOString(),
      completed_at: null,
      result_summary: null,
      last_im_jid: null,
      spawned_from_jid: null,
      source_kind: 'native_thread',
      title_source: 'native_root',
    });

    const rename = await patchAgent(sessionId, { name: 'Do not rename' });
    expect(rename.status, JSON.stringify(rename.body)).toBe(400);
    expect(rename.body.error).toMatch(/read-only/i);

    const deletion = await deleteSessionRoute(sessionId);
    expect(deletion, JSON.stringify(deletion.body)).toEqual({
      status: 200,
      body: { success: true },
    });
    expect(db.getAgent(sessionId)).toBeUndefined();
  });
});

describe('agents IM-binding ACL (owner-only, mirrors CRUD)', () => {
  async function req(
    pathSuffix: string,
    method: string,
    body?: unknown,
  ): Promise<{ status: number; body: any }> {
    const res = await agentRoutes.request(
      `/${encodeURIComponent(GROUP_JID)}${pathSuffix}`,
      {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      },
    );
    return { status: res.status, body: await res.json().catch(() => ({})) };
  }

  test('non-member returns 404 on PUT /im-binding (group hidden)', async () => {
    seedTestGroup();
    asUser(OUTSIDER_ID);
    const { status, body } = await req('/im-binding', 'PUT', {
      im_jid: 'feishu:x',
    });
    expect(status).toBe(404);
    expect(body.error).toMatch(/not found/i);
  });

  test('IM candidates expose account identity and keep same-chat bots distinct', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    const suffix = Date.now().toString(36);
    const first = db.createChannelAccount({
      id: `account-a-${suffix}`,
      owner_user_id: OWNER_ID,
      provider: 'telegram',
      name: 'Support bot',
      secret_ref: `channel-account:account-a-${suffix}`,
    });
    const second = db.createChannelAccount({
      id: `account-b-${suffix}`,
      owner_user_id: OWNER_ID,
      provider: 'telegram',
      name: 'Review bot',
      secret_ref: `channel-account:account-b-${suffix}`,
    });
    for (const account of [first, second]) {
      db.setRegisteredGroup(`telegram:-1004242#account:${account.id}`, {
        name: 'Shared external chat',
        folder: GROUP_FOLDER,
        added_at: new Date().toISOString(),
        created_by: OWNER_ID,
        channel_account_id: account.id,
      });
    }

    const { status, body } = await req('/im-groups', 'GET');
    expect(status).toBe(200);
    const matching = body.imGroups.filter((item: any) =>
      item.jid.startsWith('telegram:-1004242#account:'),
    );
    expect(matching).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          channel_account_id: first.id,
          channel_account_name: 'Support bot',
          conversation_kind: 'group',
        }),
        expect.objectContaining({
          channel_account_id: second.id,
          channel_account_name: 'Review bot',
          conversation_kind: 'group',
        }),
      ]),
    );
    expect(new Set(matching.map((item: any) => item.jid)).size).toBe(2);
  });

  test('manual discovery registers a bot-visible chat before it sends any message', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    const suffix = Date.now().toString(36);
    const discoveredJid = `feishu:discovered-${suffix}`;
    const syncUserImGroups = vi.fn(async () => {
      db.setRegisteredGroup(discoveredJid, {
        name: '新加入但尚未发言的群',
        folder: GROUP_FOLDER,
        added_at: new Date().toISOString(),
        created_by: OWNER_ID,
      });
      return { feishuAccounts: 1 };
    });
    webContext.setWebDeps({
      syncUserImGroups,
      getRegisteredGroups: () => ({}),
    } as unknown as Parameters<typeof webContext.setWebDeps>[0]);

    try {
      const sync = await req('/im-groups/sync', 'POST');
      expect(sync.status).toBe(200);
      expect(sync.body).toMatchObject({ success: true, feishuAccounts: 1 });
      expect(syncUserImGroups).toHaveBeenCalledWith(OWNER_ID);

      const listed = await req('/im-groups', 'GET');
      expect(listed.status).toBe(200);
      expect(listed.body.imGroups).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            jid: discoveredJid,
            name: '新加入但尚未发言的群',
          }),
        ]),
      );
    } finally {
      webContext.setWebDeps(
        null as unknown as Parameters<typeof webContext.setWebDeps>[0],
      );
    }
  });

  test('IM candidates are ordered by current binding, recent discovery, unbound, then bound elsewhere', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    const suffix = Date.now().toString(36);
    const otherWorkspace = `web:other-${suffix}`;
    db.setRegisteredGroup(otherWorkspace, {
      name: 'Other workspace',
      folder: `other-${suffix}`,
      added_at: '2025-01-01T00:00:00.000Z',
      created_by: OWNER_ID,
    });
    const rows = [
      {
        jid: `telegram:current-${suffix}`,
        added_at: '2025-01-01T00:00:00.000Z',
        target_main_jid: GROUP_JID,
      },
      {
        jid: `telegram:recent-${suffix}`,
        added_at: new Date().toISOString(),
      },
      {
        jid: `telegram:unbound-${suffix}`,
        added_at: '2025-02-01T00:00:00.000Z',
      },
      {
        jid: `telegram:elsewhere-${suffix}`,
        added_at: '2025-03-01T00:00:00.000Z',
        target_main_jid: otherWorkspace,
      },
    ];
    for (const row of rows) {
      db.setRegisteredGroup(row.jid, {
        name: row.jid,
        folder: GROUP_FOLDER,
        added_at: row.added_at,
        created_by: OWNER_ID,
        target_main_jid: row.target_main_jid,
      });
    }

    const listed = await req('/im-groups', 'GET');
    expect(listed.status).toBe(200);
    const ordered = listed.body.imGroups
      .map((item: any) => item.jid)
      .filter((jid: string) => jid.endsWith(suffix));
    expect(ordered).toEqual(rows.map((row) => row.jid));
  });

  test('live Feishu topic metadata is persisted and reused by cached reads', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    const suffix = Date.now().toString(36);
    const imJid = `feishu:topic-${suffix}`;
    db.setRegisteredGroup(imJid, {
      name: 'Old topic name',
      folder: GROUP_FOLDER,
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
    });
    const getChannelChatInfo = vi.fn().mockResolvedValue({
      name: '地址',
      avatar: 'https://example.com/address.png',
      chat_mode: 'topic',
      group_message_type: 'chat',
      user_count: '1',
    });
    webContext.setWebDeps({
      getChannelChatInfo,
      getRegisteredGroups: () => ({}),
    } as unknown as Parameters<typeof webContext.setWebDeps>[0]);

    try {
      const first = await req('/im-groups', 'GET');
      expect(first.status).toBe(200);
      expect(first.body.imGroups).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            jid: imJid,
            name: '地址',
            avatar: 'https://example.com/address.png',
            chat_mode: 'topic',
            is_thread_capable: true,
          }),
        ]),
      );
      expect(db.getRegisteredGroup(imJid)).toMatchObject({
        name: '地址',
        avatar_url: 'https://example.com/address.png',
        feishu_chat_mode: 'topic',
        native_context_type: 'thread',
      });

      getChannelChatInfo.mockClear();
      const second = await req('/im-groups', 'GET');
      expect(second.status).toBe(200);
      expect(getChannelChatInfo).not.toHaveBeenCalled();
      expect(second.body.imGroups).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            jid: imJid,
            avatar: 'https://example.com/address.png',
            chat_mode: 'topic',
            is_thread_capable: true,
          }),
        ]),
      );
    } finally {
      webContext.setWebDeps(
        null as unknown as Parameters<typeof webContext.setWebDeps>[0],
      );
    }
  });

  test('a direct chat binds to a session; `main` is no session', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    const sessionId = await newSessionId();
    const suffix = Date.now().toString(36);
    const account = db.createChannelAccount({
      id: `qq-workspace-${suffix}`,
      owner_user_id: OWNER_ID,
      provider: 'qq',
      name: `QQ session bot ${suffix}`,
      secret_ref: `channel-account:qq-workspace-${suffix}`,
      default_workspace_jid: GROUP_JID,
    });
    const imJid = `qq:c2c:user-${suffix}#account:${account.id}`;
    db.setRegisteredGroup(imJid, {
      name: 'QQ direct chat',
      folder: GROUP_FOLDER,
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
      channel_account_id: account.id,
      native_context_type: 'none',
    });

    for (const method of ['PUT', 'DELETE'] as const) {
      const path =
        method === 'PUT'
          ? '/sessions/main/im-binding'
          : `/sessions/main/im-binding/${encodeURIComponent(imJid)}`;
      const { status, body } = await req(path, method, { im_jid: imJid });
      expect({ status, body }).toEqual({
        status: 404,
        body: { error: 'Session not found' },
      });
    }
    expect(db.getRegisteredGroup(imJid)?.target_main_jid).toBeUndefined();

    const { status } = await req(`/sessions/${sessionId}/im-binding`, 'PUT', {
      im_jid: imJid,
    });
    expect(status).toBe(200);
    expect(db.getRegisteredGroup(imJid)).toMatchObject({
      target_agent_id: sessionId,
      binding_mode: 'single_context',
    });
    expect(db.getRegisteredGroup(imJid)?.target_main_jid).toBeUndefined();
  });

  test('workspace binding rejects a direct chat', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    const suffix = Date.now().toString(36);
    const account = db.createChannelAccount({
      id: `qq-direct-workspace-reject-${suffix}`,
      owner_user_id: OWNER_ID,
      provider: 'qq',
      name: `QQ direct workspace reject bot ${suffix}`,
      secret_ref: `channel-account:qq-direct-workspace-reject-${suffix}`,
      default_workspace_jid: GROUP_JID,
    });
    const imJid = `qq:c2c:user-${suffix}#account:${account.id}`;
    db.setRegisteredGroup(imJid, {
      name: 'QQ direct chat',
      folder: GROUP_FOLDER,
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
      channel_account_id: account.id,
    });

    const { status, body } = await req('/im-binding', 'PUT', {
      im_jid: imJid,
    });
    expect(status).toBe(400);
    expect(body.error).toMatch(/only accept native topic groups/i);
    expect(db.getRegisteredGroup(imJid)?.target_main_jid).toBeUndefined();
  });

  test('session binding accepts an ordinary group chat', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    const created = await postSession({ name: 'Direct-only session' });
    const sessionId = created.body.session.id as string;
    const suffix = Date.now().toString(36);
    const account = db.createChannelAccount({
      id: `qq-group-session-reject-${suffix}`,
      owner_user_id: OWNER_ID,
      provider: 'qq',
      name: `QQ session reject bot ${suffix}`,
      secret_ref: `channel-account:qq-group-session-reject-${suffix}`,
      default_workspace_jid: GROUP_JID,
    });
    const imJid = `qq:group:team-${suffix}#account:${account.id}`;
    db.setRegisteredGroup(imJid, {
      name: 'QQ group chat',
      folder: GROUP_FOLDER,
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
      channel_account_id: account.id,
    });

    const { status } = await req(`/sessions/${sessionId}/im-binding`, 'PUT', {
      im_jid: imJid,
    });
    expect(status).toBe(200);
    expect(db.getRegisteredGroup(imJid)?.target_agent_id).toBe(sessionId);
  });

  test('ordinary Feishu mention and always modes keep the selected session', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    const sessionId = await newSessionId();
    const suffix = Date.now().toString(36);
    const account = db.createChannelAccount({
      id: `feishu-mention-${suffix}`,
      owner_user_id: OWNER_ID,
      provider: 'feishu',
      name: 'Feishu bot',
      secret_ref: `channel-account:feishu-mention-${suffix}`,
      default_workspace_jid: GROUP_JID,
    });
    const imJid = `feishu:ordinary-${suffix}#account:${account.id}`;
    db.setRegisteredGroup(imJid, {
      name: 'Ordinary Feishu group',
      folder: GROUP_FOLDER,
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
      channel_account_id: account.id,
      feishu_chat_mode: 'group',
      feishu_group_message_type: 'chat',
    });
    webContext.setWebDeps({
      getChannelChatInfo: vi.fn().mockResolvedValue({
        chat_mode: 'group',
        group_message_type: 'chat',
      }),
      getRegisteredGroups: () => ({}),
    } as unknown as Parameters<typeof webContext.setWebDeps>[0]);

    try {
      const mentioned = await req(`/sessions/${sessionId}/im-binding`, 'PUT', {
        im_jid: imJid,
        activation_mode: 'when_mentioned',
      });
      expect(mentioned.status, JSON.stringify(mentioned.body)).toBe(200);
      expect(db.getRegisteredGroup(imJid)).toMatchObject({
        target_agent_id: sessionId,
        binding_mode: 'single_context',
        activation_mode: 'when_mentioned',
      });

      const always = await req(`/sessions/${sessionId}/im-binding`, 'PUT', {
        im_jid: imJid,
        activation_mode: 'always',
        force: true,
      });
      expect(always.status, JSON.stringify(always.body)).toBe(200);
      expect(db.getRegisteredGroup(imJid)).toMatchObject({
        target_agent_id: sessionId,
        binding_mode: 'single_context',
        activation_mode: 'always',
      });
    } finally {
      webContext.setWebDeps(
        null as unknown as Parameters<typeof webContext.setWebDeps>[0],
      );
    }
  });

  test('Feishu response audience changes independently from mention activation', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    const sessionId = await newSessionId();
    const suffix = Date.now().toString(36);
    const account = db.createChannelAccount({
      id: `feishu-audience-${suffix}`,
      owner_user_id: OWNER_ID,
      provider: 'feishu',
      name: 'Feishu audience bot',
      secret_ref: `channel-account:feishu-audience-${suffix}`,
      default_workspace_jid: GROUP_JID,
    });
    const imJid = `feishu:audience-${suffix}#account:${account.id}`;
    db.setRegisteredGroup(imJid, {
      name: 'Feishu audience group',
      folder: GROUP_FOLDER,
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
      channel_account_id: account.id,
      feishu_chat_mode: 'group',
      feishu_group_message_type: 'chat',
      owner_im_id: 'ou_owner',
    });
    webContext.setWebDeps({
      getChannelChatInfo: vi.fn().mockResolvedValue({
        chat_mode: 'group',
        group_message_type: 'chat',
      }),
      getRegisteredGroups: () => ({}),
    } as unknown as Parameters<typeof webContext.setWebDeps>[0]);

    try {
      const ownerWithoutMention = await req(
        `/sessions/${sessionId}/im-binding`,
        'PUT',
        {
          im_jid: imJid,
          activation_mode: 'always',
          audience_mode: 'owner_only',
        },
      );
      expect(ownerWithoutMention.status).toBe(200);
      expect(db.getRegisteredGroup(imJid)).toMatchObject({
        activation_mode: 'always',
        audience_mode: 'owner_only',
        binding_mode: 'single_context',
      });

      const ownerWithMention = await req(
        `/sessions/${sessionId}/im-binding`,
        'PUT',
        {
          im_jid: imJid,
          activation_mode: 'when_mentioned',
          audience_mode: 'owner_only',
          force: true,
        },
      );
      expect(ownerWithMention.status).toBe(200);
      expect(db.getRegisteredGroup(imJid)).toMatchObject({
        activation_mode: 'when_mentioned',
        audience_mode: 'owner_only',
        binding_mode: 'single_context',
      });

      const everyoneWithMention = await req(
        `/sessions/${sessionId}/im-binding`,
        'PUT',
        {
          im_jid: imJid,
          activation_mode: 'when_mentioned',
          audience_mode: 'everyone',
          force: true,
        },
      );
      expect(everyoneWithMention.status).toBe(200);
      expect(db.getRegisteredGroup(imJid)).toMatchObject({
        activation_mode: 'when_mentioned',
        audience_mode: 'everyone',
        binding_mode: 'single_context',
      });

      const legacyComposite = await req(
        `/sessions/${sessionId}/im-binding`,
        'PUT',
        {
          im_jid: imJid,
          activation_mode: 'owner_mentioned',
          force: true,
        },
      );
      expect(legacyComposite.status).toBe(200);
      expect(db.getRegisteredGroup(imJid)).toMatchObject({
        activation_mode: 'when_mentioned',
        audience_mode: 'owner_only',
      });
    } finally {
      webContext.setWebDeps(
        null as unknown as Parameters<typeof webContext.setWebDeps>[0],
      );
    }
  });

  test('Feishu private chats reject mention activation at the binding API', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    const sessionId = await newSessionId();
    const suffix = Date.now().toString(36);
    const account = db.createChannelAccount({
      id: `feishu-direct-${suffix}`,
      owner_user_id: OWNER_ID,
      provider: 'feishu',
      name: 'Feishu direct bot',
      secret_ref: `channel-account:feishu-direct-${suffix}`,
      default_workspace_jid: GROUP_JID,
    });
    const imJid = `feishu:direct-${suffix}#account:${account.id}`;
    db.setRegisteredGroup(imJid, {
      name: 'Feishu private chat',
      folder: GROUP_FOLDER,
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
      channel_account_id: account.id,
      feishu_chat_mode: 'p2p',
    });
    webContext.setWebDeps({
      getChannelChatInfo: vi.fn().mockResolvedValue({ chat_mode: 'p2p' }),
      getRegisteredGroups: () => ({}),
    } as unknown as Parameters<typeof webContext.setWebDeps>[0]);

    try {
      const result = await req(`/sessions/${sessionId}/im-binding`, 'PUT', {
        im_jid: imJid,
        activation_mode: 'when_mentioned',
      });
      expect(result.status).toBe(400);
      expect(result.body.error).toMatch(/private chats/i);
      expect(db.getRegisteredGroup(imJid)?.target_agent_id).toBeUndefined();
    } finally {
      webContext.setWebDeps(
        null as unknown as Parameters<typeof webContext.setWebDeps>[0],
      );
    }
  });

  test('a concurrent write during checkThreadCapableBinding is not clobbered by the pre-await snapshot', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    const sessionId = await newSessionId();
    const suffix = Date.now().toString(36);
    const account = db.createChannelAccount({
      id: `qq-toctou-${suffix}`,
      owner_user_id: OWNER_ID,
      provider: 'qq',
      name: `QQ TOCTOU bot ${suffix}`,
      secret_ref: `channel-account:qq-toctou-${suffix}`,
      default_workspace_jid: GROUP_JID,
    });
    const imJid = `qq:c2c:user-${suffix}#account:${account.id}`;
    db.setRegisteredGroup(imJid, {
      name: 'QQ direct chat',
      folder: GROUP_FOLDER,
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
      channel_account_id: account.id,
      native_context_type: 'none',
    });

    // checkThreadCapableBinding awaits deps.getChannelChatInfo — a real
    // network call in production (e.g. Feishu getFeishuChatInfo). Use that
    // await as the injection point to simulate a concurrent write landing
    // on this exact imJid (e.g. the message router auto-learning
    // owner_im_id, or a second bind request) while the first request is
    // still suspended.
    webContext.setWebDeps({
      getChannelChatInfo: async () => {
        const current = db.getRegisteredGroup(imJid)!;
        db.setRegisteredGroup(imJid, {
          ...current,
          owner_im_id: 'concurrent-writer',
        });
        return null;
      },
      getRegisteredGroups: () => ({}),
    } as unknown as Parameters<typeof webContext.setWebDeps>[0]);

    try {
      const { status } = await req(`/sessions/${sessionId}/im-binding`, 'PUT', {
        im_jid: imJid,
      });
      expect(status).toBe(200);
      const after = db.getRegisteredGroup(imJid);
      // Both writes must survive: the intended bind (this request) and the
      // concurrent write that landed mid-await. A stale pre-await snapshot
      // would silently overwrite owner_im_id back to its original value.
      expect(after).toMatchObject({
        target_agent_id: sessionId,
        binding_mode: 'single_context',
        owner_im_id: 'concurrent-writer',
      });
    } finally {
      webContext.setWebDeps(
        null as unknown as Parameters<typeof webContext.setWebDeps>[0],
      );
    }
  });

  test('a concurrent ownership transfer during checkThreadCapableBinding is rejected, not silently applied', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    const sessionId = await newSessionId();
    const suffix = Date.now().toString(36);
    const account = db.createChannelAccount({
      id: `qq-reauth-${suffix}`,
      owner_user_id: OWNER_ID,
      provider: 'qq',
      name: `QQ reauth bot ${suffix}`,
      secret_ref: `channel-account:qq-reauth-${suffix}`,
      default_workspace_jid: GROUP_JID,
    });
    const imJid = `qq:c2c:user-${suffix}#account:${account.id}`;
    db.setRegisteredGroup(imJid, {
      name: 'QQ direct chat',
      folder: GROUP_FOLDER,
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
      channel_account_id: account.id,
      native_context_type: 'none',
    });

    // The pre-await canModifyGroup/hasConsistentChannelAccount checks only
    // proved authorization against the row as it existed BEFORE the await.
    // Simulate the row's ownership transferring to a different user (e.g.
    // credential transfer, delete+recreate) during that await, and confirm
    // the fresh re-read is re-authorized rather than committing a mutation
    // that crosses the original authorization boundary.
    webContext.setWebDeps({
      getChannelChatInfo: async () => {
        const current = db.getRegisteredGroup(imJid)!;
        db.setRegisteredGroup(imJid, {
          ...current,
          created_by: OUTSIDER_ID,
          channel_account_id: undefined,
        });
        return null;
      },
      getRegisteredGroups: () => ({}),
    } as unknown as Parameters<typeof webContext.setWebDeps>[0]);

    try {
      const { status, body } = await req(
        `/sessions/${sessionId}/im-binding`,
        'PUT',
        {
          im_jid: imJid,
        },
      );
      expect(status).toBe(403);
      expect(body.error).toMatch(/forbidden/i);
      // The mutation must not have been applied — the row still reflects
      // only the concurrent write, not this request's intended bind.
      const after = db.getRegisteredGroup(imJid);
      expect(after?.target_agent_id).not.toBe(sessionId);
      expect(after?.created_by).toBe(OUTSIDER_ID);
    } finally {
      webContext.setWebDeps(
        null as unknown as Parameters<typeof webContext.setWebDeps>[0],
      );
    }
  });

  test('native thread containers reject a fixed session target', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    const created = await postSession({ name: 'Fixed session' });
    const sessionId = created.body.session.id as string;
    const suffix = Date.now().toString(36);
    const account = db.createChannelAccount({
      id: `telegram-forum-${suffix}`,
      owner_user_id: OWNER_ID,
      provider: 'telegram',
      name: 'Forum bot',
      secret_ref: `channel-account:telegram-forum-${suffix}`,
      default_workspace_jid: GROUP_JID,
    });
    const imJid = `telegram:-100${Date.now()}#account:${account.id}`;
    db.setRegisteredGroup(imJid, {
      name: 'Telegram Forum',
      folder: GROUP_FOLDER,
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
      channel_account_id: account.id,
      native_context_type: 'thread',
    });

    const { status, body } = await req(
      `/sessions/${sessionId}/im-binding`,
      'PUT',
      { im_jid: imJid },
    );
    expect(status).toBe(400);
    expect(body.error).toMatch(/native thread/i);
    expect(db.getRegisteredGroup(imJid)?.target_agent_id).toBeUndefined();
  });

  test('a concurrent none->thread upgrade during the live chat-info fetch is still rejected for a session bind', async () => {
    // The pre-await snapshot has native_context_type: 'none' (ordinary
    // session-bindable chat). Simulate the message router upgrading it to
    // a native thread container (native_context_type: 'thread') WHILE the
    // live chat-info fetch is in flight. threadCapable must be computed
    // against the fresh row, not the stale pre-await one — otherwise this
    // request would incorrectly bind a now-thread-capable container as a
    // fixed single session, breaking that thread's session isolation from
    // its siblings.
    seedTestGroup();
    asUser(OWNER_ID);
    const created = await postSession({ name: 'Racing session' });
    const sessionId = created.body.session.id as string;
    const suffix = Date.now().toString(36);
    const account = db.createChannelAccount({
      id: `telegram-race-${suffix}`,
      owner_user_id: OWNER_ID,
      provider: 'telegram',
      name: `Forum race bot ${suffix}`,
      secret_ref: `channel-account:telegram-race-${suffix}`,
      default_workspace_jid: GROUP_JID,
    });
    const imJid = `telegram:-101${Date.now()}#account:${account.id}`;
    db.setRegisteredGroup(imJid, {
      name: 'Telegram Forum (about to upgrade)',
      folder: GROUP_FOLDER,
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
      channel_account_id: account.id,
      native_context_type: 'none',
    });

    webContext.setWebDeps({
      getChannelChatInfo: async () => {
        const current = db.getRegisteredGroup(imJid)!;
        db.setRegisteredGroup(imJid, {
          ...current,
          native_context_type: 'thread',
        });
        return null;
      },
      getRegisteredGroups: () => ({}),
    } as unknown as Parameters<typeof webContext.setWebDeps>[0]);

    try {
      const { status, body } = await req(
        `/sessions/${sessionId}/im-binding`,
        'PUT',
        { im_jid: imJid },
      );
      expect(status).toBe(400);
      expect(body.error).toMatch(/native thread/i);
      // The bind must not have been applied.
      expect(db.getRegisteredGroup(imJid)?.target_agent_id).toBeUndefined();
    } finally {
      webContext.setWebDeps(
        null as unknown as Parameters<typeof webContext.setWebDeps>[0],
      );
    }
  });

  test('a session deleted during live metadata lookup cannot receive a stale binding', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    const created = await postSession({ name: 'Soon deleted session' });
    const sessionId = created.body.session.id as string;
    const suffix = Date.now().toString(36);
    const account = db.createChannelAccount({
      id: `deleted-target-${suffix}`,
      owner_user_id: OWNER_ID,
      provider: 'qq',
      name: 'Deleted target bot',
      secret_ref: `channel-account:deleted-target-${suffix}`,
      default_workspace_jid: GROUP_JID,
    });
    const imJid = `qq:c2c:deleted-target-${suffix}#account:${account.id}`;
    db.setRegisteredGroup(imJid, {
      name: 'Race source',
      folder: GROUP_FOLDER,
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
      channel_account_id: account.id,
    });
    webContext.setWebDeps({
      getChannelChatInfo: async () => {
        db.deleteAgent(sessionId);
        return null;
      },
      getRegisteredGroups: () => ({}),
    } as unknown as Parameters<typeof webContext.setWebDeps>[0]);

    try {
      const { status, body } = await req(
        `/sessions/${sessionId}/im-binding`,
        'PUT',
        { im_jid: imJid },
      );
      expect(status).toBe(404);
      expect(body.error).toMatch(/session not found/i);
      expect(db.getRegisteredGroup(imJid)?.target_agent_id).toBeUndefined();
    } finally {
      webContext.setWebDeps(
        null as unknown as Parameters<typeof webContext.setWebDeps>[0],
      );
    }
  });

  test('a concurrent none->thread upgrade during the live chat-info fetch routes a workspace bind as thread_map, not single_session', async () => {
    // Same race as above, but for the workspace-bind branch (sessionId
    // 'main'), where threadCapable decides thread_map vs single_session
    // routing mode rather than an outright rejection.
    seedTestGroup();
    asUser(OWNER_ID);
    const suffix = Date.now().toString(36);
    const account = db.createChannelAccount({
      id: `telegram-race-ws-${suffix}`,
      owner_user_id: OWNER_ID,
      provider: 'telegram',
      name: `Forum race workspace bot ${suffix}`,
      secret_ref: `channel-account:telegram-race-ws-${suffix}`,
      default_workspace_jid: GROUP_JID,
    });
    const imJid = `telegram:-102${Date.now()}#account:${account.id}`;
    db.setRegisteredGroup(imJid, {
      name: 'Telegram Forum (about to upgrade, workspace bind)',
      folder: GROUP_FOLDER,
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
      channel_account_id: account.id,
      native_context_type: 'none',
    });

    webContext.setWebDeps({
      getChannelChatInfo: async () => {
        const current = db.getRegisteredGroup(imJid)!;
        db.setRegisteredGroup(imJid, {
          ...current,
          native_context_type: 'thread',
        });
        return null;
      },
      getRegisteredGroups: () => ({}),
    } as unknown as Parameters<typeof webContext.setWebDeps>[0]);

    try {
      const { status } = await req('/im-binding', 'PUT', {
        im_jid: imJid,
      });
      expect(status).toBe(200);
      // A stale (pre-upgrade) computation would have produced
      // 'single_session' here instead.
      expect(db.getRegisteredGroup(imJid)?.binding_mode).toBe('thread_map');
    } finally {
      webContext.setWebDeps(
        null as unknown as Parameters<typeof webContext.setWebDeps>[0],
      );
    }
  });

  test('deleting a session binding leaves the direct chat unbound', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    const created = await postSession({ name: 'Temporary session' });
    const sessionId = created.body.session.id as string;
    const suffix = Date.now().toString(36);
    const account = db.createChannelAccount({
      id: `whatsapp-default-${suffix}`,
      owner_user_id: OWNER_ID,
      provider: 'whatsapp',
      name: 'WhatsApp account',
      secret_ref: `channel-account:whatsapp-default-${suffix}`,
      default_workspace_jid: GROUP_JID,
    });
    const imJid = `whatsapp:user-${suffix}@s.whatsapp.net#account:${account.id}`;
    db.setRegisteredGroup(imJid, {
      name: 'WhatsApp chat',
      folder: GROUP_FOLDER,
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
      channel_account_id: account.id,
      target_agent_id: sessionId,
      activation_mode: 'when_mentioned',
      owner_im_id: 'owner-im',
      sender_allowlist: ['owner-im'],
      reply_policy: 'mirror',
    });

    const { status, body } = await req(
      `/sessions/${sessionId}/im-binding/${encodeURIComponent(imJid)}`,
      'DELETE',
    );
    expect(status).toBe(200);
    expect(body.target_main_jid).toBeNull();
    const restored = db.getRegisteredGroup(imJid);
    expect(restored).toMatchObject({
      target_main_jid: undefined,
      binding_mode: 'single_context',
      activation_mode: 'when_mentioned',
      owner_im_id: 'owner-im',
      sender_allowlist: ['owner-im'],
      reply_policy: 'source_only',
    });
    expect(restored?.target_agent_id).toBeUndefined();
    expect(db.getChannelMount(imJid)).toBeUndefined();
    expect(db.getAgent(sessionId)).toBeDefined();
  });

  test('unbinding one of multiple chats keeps the agent fallback route on a remaining chat', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    const created = await postSession({ name: 'Multi-channel session' });
    const sessionId = created.body.session.id as string;
    const suffix = Date.now().toString(36);
    const account = db.createChannelAccount({
      id: `multi-route-${suffix}`,
      owner_user_id: OWNER_ID,
      provider: 'whatsapp',
      name: 'Multi-route account',
      secret_ref: `channel-account:multi-route-${suffix}`,
      default_workspace_jid: GROUP_JID,
    });
    const firstJid = `whatsapp:first-${suffix}@s.whatsapp.net#account:${account.id}`;
    const secondJid = `whatsapp:second-${suffix}@s.whatsapp.net#account:${account.id}`;
    for (const [index, imJid] of [firstJid, secondJid].entries()) {
      db.setRegisteredGroup(imJid, {
        name: `WhatsApp chat ${index + 1}`,
        folder: GROUP_FOLDER,
        added_at: new Date(Date.now() + index * 1000).toISOString(),
        created_by: OWNER_ID,
        channel_account_id: account.id,
        target_agent_id: sessionId,
      });
    }
    db.updateAgentLastImJid(sessionId, firstJid);

    const { status } = await req(
      `/sessions/${sessionId}/im-binding/${encodeURIComponent(firstJid)}`,
      'DELETE',
    );
    expect(status).toBe(200);
    expect(db.getAgent(sessionId)?.last_im_jid).toBe(secondJid);
    expect(db.getRegisteredGroup(secondJid)?.target_agent_id).toBe(sessionId);
  });

  test('multiple native-context containers can share one workspace', () => {
    asUser(OWNER_ID);
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const workspaceJid = `web:native-upgrade-${suffix}`;
    const firstJid = `telegram:forum-upgrade-a-${suffix}`;
    const secondJid = `telegram:forum-upgrade-b-${suffix}`;
    db.setRegisteredGroup(workspaceJid, {
      name: 'Native upgrade workspace',
      folder: `native-upgrade-${suffix}`,
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
    });
    const base = {
      name: 'Forum',
      folder: `native-upgrade-${suffix}`,
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
      target_main_jid: workspaceJid,
      binding_mode: 'single_context' as const,
      native_context_type: 'thread' as const,
    };
    db.setRegisteredGroup(firstJid, base);
    db.setRegisteredGroup(secondJid, base);

    expect(
      mountService.upgradeNativeContextChannelMount(firstJid, base),
    ).toMatchObject({
      status: 'upgraded',
      updated: { binding_mode: 'thread_map' },
    });
    expect(
      mountService.upgradeNativeContextChannelMount(secondJid, base),
    ).toMatchObject({
      status: 'upgraded',
      updated: { binding_mode: 'thread_map' },
    });
    expect(db.getRegisteredGroup(firstJid)?.binding_mode).toBe('thread_map');
    expect(db.getRegisteredGroup(secondJid)?.binding_mode).toBe('thread_map');

    db.deleteRegisteredGroup(firstJid);
    db.deleteRegisteredGroup(secondJid);
    db.deleteRegisteredGroup(workspaceJid);
  });

  test('REST unbind detaches native navigation only after the last source leaves', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const defaultWorkspaceJid = `web:native-default-${suffix}`;
    db.setRegisteredGroup(defaultWorkspaceJid, {
      name: 'Native default workspace',
      folder: `native-default-${suffix}`,
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
    });

    const sourceJids: string[] = [];
    for (const name of ['first', 'second']) {
      const account = db.createChannelAccount({
        id: `native-restore-${name}-${suffix}`,
        owner_user_id: OWNER_ID,
        provider: name === 'first' ? 'feishu' : 'telegram',
        name: `${name} bot`,
        secret_ref: `channel-account:native-restore-${name}-${suffix}`,
        default_workspace_jid: defaultWorkspaceJid,
      });
      const sourceJid =
        account.provider === 'feishu'
          ? `feishu:native-${name}-${suffix}#account:${account.id}`
          : `telegram:-103${Date.now()}#account:${account.id}`;
      sourceJids.push(sourceJid);
      db.setRegisteredGroup(sourceJid, {
        name: `${name} native container`,
        folder: GROUP_FOLDER,
        added_at: new Date().toISOString(),
        created_by: OWNER_ID,
        channel_account_id: account.id,
        native_context_type: 'thread',
        ...(account.provider === 'feishu' ? { feishu_chat_mode: 'topic' } : {}),
      });

      const bound = await req('/im-binding', 'PUT', {
        im_jid: sourceJid,
      });
      expect(bound.status, JSON.stringify(bound.body)).toBe(200);
      expect(db.getRegisteredGroup(sourceJid)).toMatchObject({
        target_main_jid: GROUP_JID,
        binding_mode: 'thread_map',
      });
    }

    expect(db.getRegisteredGroup(GROUP_JID)).toMatchObject({
      conversation_source: 'native_thread',
      conversation_nav_mode: 'vertical_threads',
    });

    const firstRestored = await req(
      `/im-binding/${encodeURIComponent(sourceJids[0])}`,
      'DELETE',
    );
    expect(firstRestored.status, JSON.stringify(firstRestored.body)).toBe(200);
    expect(db.getRegisteredGroup(GROUP_JID)).toMatchObject({
      conversation_source: 'native_thread',
      conversation_nav_mode: 'vertical_threads',
    });

    const lastRestored = await req(
      `/im-binding/${encodeURIComponent(sourceJids[1])}`,
      'DELETE',
    );
    expect(lastRestored.status, JSON.stringify(lastRestored.body)).toBe(200);
    expect(db.getRegisteredGroup(GROUP_JID)).toMatchObject({
      conversation_source: 'manual',
      conversation_nav_mode: 'horizontal',
    });
    expect(db.getRegisteredGroup(defaultWorkspaceJid)).toMatchObject({
      conversation_source: 'manual',
      conversation_nav_mode: 'horizontal',
    });

    for (const sourceJid of sourceJids) db.deleteRegisteredGroup(sourceJid);
    db.deleteRegisteredGroup(defaultWorkspaceJid);
  });
});
