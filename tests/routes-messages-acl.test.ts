/**
 * Integration test for the inline `POST /api/messages` route in src/web.ts,
 * focused on its `/clear` interception + ACL.
 *
 * This route is declared inline on the module-level Hono `app` (not a sub-
 * router), so it cannot be reached the way the other route tests reach their
 * routers. We use the `createAppForTest()` factory (added alongside
 * `startWebServer`) which injects test `WebDeps` and returns the fully-wired
 * `app` without starting the HTTP/WebSocket servers or polling intervals, then
 * drive it via `app.request(...)`.
 *
 * Coverage (the `/clear` owner-only tightening introduced for #518):
 *   - invalid body                → 400
 *   - unknown group               → 404
 *   - non-owner + /clear          → 403 (Access denied)
 *   - owner + /clear              → 200 {cleared:true}; resets session
 *                                   (queue.stopGroup called, context_reset row written)
 *
 * The normal (non-/clear) message happy-path is intentionally out of scope: it
 * funnels into `handleWebUserMessage` (plugin expansion, attachment handling,
 * processGroupMessages) which needs far more wiring than the destructive-
 * command ACL this test guards. We import the REAL web.js (not a mock) so the
 * route wiring under test is the production one.
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

const SHARED_TMP =
  process.env.HAPPYCLAW_TEST_DATA_DIR ??
  (() => {
    const d = fs.mkdtempSync(
      path.join(os.tmpdir(), 'happyclaw-routes-messages-'),
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
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

// web.ts imports the FULL route surface, so the auth-middleware mock must keep
// every real export (requirePermission, systemConfigMiddleware, …) and only
// swap out authMiddleware to inject the test user.
vi.mock('../src/middleware/auth.ts', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    authMiddleware: async (c: any, next: any) => {
      c.set('user', {
        id: process.env.HAPPYCLAW_TEST_USER_ID ?? 'alice',
        username: 'alice',
        display_name: 'Alice',
        role: (process.env.HAPPYCLAW_TEST_USER_ROLE ?? 'member') as
          | 'admin'
          | 'member',
        permissions: [],
      });
      return next();
    },
  };
});

const web = await import('../src/web.js');
const db = await import('../src/db.js');

const OWNER_ID = 'alice';
const OUTSIDER_ID = 'charlie';
const GROUP_JID = 'web:messages-acl-group';
const GROUP_FOLDER = 'messages-acl-group';
const SESSION_ID = '00000000-0000-4000-8000-0000000000a1';
const SESSION_JID = `${GROUP_JID}#agent:${SESSION_ID}`;

// Record queue.stopGroup calls so the owner path can assert a real reset.
const stopGroupCalls: Array<{ jid: string; opts?: { force?: boolean } }> = [];
const promoteFollowUpCalls: Array<{
  chatJid: string;
  messageId: string;
  expectedRunId: string;
}> = [];
const editFollowUpCalls: Array<{
  chatJid: string;
  messageId: string;
  content: string;
}> = [];
const reorderFollowUpCalls: Array<{
  chatJid: string;
  messageId: string;
  direction: 'up' | 'down';
}> = [];
let activeQueryId: string | null = null;

// Back getRegisteredGroups with a single persistent object (NOT a fresh {} per
// call) so any route's persistGroupUpdate cache-sync writes to a stable map,
// matching production's `() => registeredGroups`. Keeps future cache-coherence
// assertions meaningful instead of writing to a discarded object.
const registeredGroupsCache: Record<string, unknown> = {};

const testDeps = {
  queue: {
    stopGroup: async (jid: string, opts?: { force?: boolean }) => {
      stopGroupCalls.push({ jid, opts });
    },
    getActiveQueryId: () => activeQueryId,
  },
  getSessions: () => ({}) as Record<string, string>,
  setLastAgentTimestamp: () => {},
  getRegisteredGroups: () => registeredGroupsCache,
  advanceGlobalCursor: () => {},
  promoteFollowUp: (
    chatJid: string,
    messageId: string,
    expectedRunId: string,
  ) => {
    promoteFollowUpCalls.push({ chatJid, messageId, expectedRunId });
    return {
      ok: true,
      state: 'interrupting' as const,
      message: '正在中断当前运行。',
    };
  },
  editFollowUp: (chatJid: string, messageId: string, content: string) => {
    editFollowUpCalls.push({ chatJid, messageId, content });
    return { ok: true, state: 'queued' as const, message: '已更新。' };
  },
  reorderFollowUp: (
    chatJid: string,
    messageId: string,
    direction: 'up' | 'down',
  ) => {
    reorderFollowUpCalls.push({ chatJid, messageId, direction });
    return { ok: true, state: 'queued' as const, message: '已排序。' };
  },
} as unknown as Parameters<typeof web.createAppForTest>[0];

const app = web.createAppForTest(testDeps);

function seedTestGroup(): void {
  db.setRegisteredGroup(GROUP_JID, {
    name: 'Messages ACL Group',
    folder: GROUP_FOLDER,
    added_at: new Date().toISOString(),
    executionMode: 'container',
    created_by: OWNER_ID,
    is_home: false,
  } as any);
  if (!db.getAgent(SESSION_ID)) {
    db.createAgent({
      id: SESSION_ID,
      group_folder: GROUP_FOLDER,
      chat_jid: GROUP_JID,
      name: 'Session',
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
}

function asUser(userId: string, role: 'admin' | 'member' = 'member'): void {
  process.env.HAPPYCLAW_TEST_USER_ID = userId;
  process.env.HAPPYCLAW_TEST_USER_ROLE = role;
}

async function postMessage(
  body: unknown,
): Promise<{ status: number; body: any }> {
  const res = await app.request('/api/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function postFollowUpAction(
  messageId: string,
  body: unknown,
): Promise<{ status: number; body: any }> {
  const res = await app.request(
    `/api/follow-ups/${encodeURIComponent(messageId)}/action`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

beforeAll(() => {
  fs.mkdirSync(path.join(tmpDataDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDataDir, 'groups'), { recursive: true });
  db.initDatabase();
});

beforeEach(() => {
  stopGroupCalls.length = 0;
  promoteFollowUpCalls.length = 0;
  editFollowUpCalls.length = 0;
  reorderFollowUpCalls.length = 0;
  activeQueryId = null;
  try {
    db.deleteRegisteredGroup(GROUP_JID);
  } catch {
    /* ignore */
  }
});

afterEach(() => {
  delete process.env.HAPPYCLAW_TEST_USER_ID;
  delete process.env.HAPPYCLAW_TEST_USER_ROLE;
});

describe('POST /api/messages — validation & lookup', () => {
  test('invalid body returns 400', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    const { status, body } = await postMessage({ content: '/clear' }); // no chatJid
    expect(status).toBe(400);
    expect(body.error).toMatch(/invalid/i);
  });

  test('unknown group returns 404', async () => {
    asUser(OWNER_ID);
    const { status, body } = await postMessage({
      chatJid: 'web:does-not-exist',
      content: '/clear',
    });
    expect(status).toBe(404);
    expect(body.error).toMatch(/not found/i);
  });
});

describe('GET /api/groups/:jid/messages — stable sequence cursor', () => {
  test('paginates same-timestamp messages and polls late arrivals', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    const timestamp = '2026-08-31T00:00:00.000Z';
    for (let index = 0; index < 52; index++) {
      db.ensureChatExists(GROUP_JID);
      db.storeMessageDirect(
        `same-ts-${String(51 - index).padStart(2, '0')}`,
        GROUP_JID,
        OWNER_ID,
        'Alice',
        `message ${index}`,
        timestamp,
        false,
      );
    }

    const firstResponse = await app.request(
      `/api/groups/${encodeURIComponent(GROUP_JID)}/messages?limit=20`,
    );
    expect(firstResponse.status).toBe(200);
    const first = (await firstResponse.json()) as {
      messages: Array<{ id: string; ingest_sequence: number }>;
      hasMore: boolean;
    };
    expect(first.messages).toHaveLength(20);
    expect(first.hasMore).toBe(true);

    const boundary = first.messages.at(-1)!.ingest_sequence;
    const secondResponse = await app.request(
      `/api/groups/${encodeURIComponent(GROUP_JID)}/messages?limit=20&beforeSequence=${boundary}`,
    );
    const second = (await secondResponse.json()) as typeof first;
    expect(second.messages).toHaveLength(20);
    expect(
      new Set(
        [...first.messages, ...second.messages].map((message) => message.id),
      ).size,
    ).toBe(40);

    const newestSequence = first.messages[0].ingest_sequence;
    db.storeMessageDirect(
      'late-old-provider-clock',
      GROUP_JID,
      OWNER_ID,
      'Alice',
      'late arrival',
      '2020-01-01T00:00:00.000Z',
      false,
    );
    const pollResponse = await app.request(
      `/api/groups/${encodeURIComponent(GROUP_JID)}/messages?limit=20&afterSequence=${newestSequence}`,
    );
    const poll = (await pollResponse.json()) as typeof first;
    expect(poll.messages.map((message) => message.id)).toEqual([
      'late-old-provider-clock',
    ]);
  });
});

describe('POST /api/messages — every input names a session', () => {
  test('a workspace JID without agentId is refused and nothing is stored', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    const before = db.getMessagesPage(GROUP_JID, undefined, 50).length;
    for (const content of ['hello', '/clear', '/fresh notes']) {
      const { status, body } = await postMessage({
        chatJid: GROUP_JID,
        content,
      });
      expect(status, content).toBe(400);
      expect(body, content).toEqual({
        error: 'Session required',
        code: 'session_required',
      });
    }
    expect(db.getMessagesPage(GROUP_JID, undefined, 50)).toHaveLength(before);
    expect(stopGroupCalls).toHaveLength(0);
  });

  test('an agentId of another workspace is not found', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    const { status } = await postMessage({
      chatJid: 'web:messages-acl-other',
      agentId: SESSION_ID,
      content: 'hello',
    });
    expect(status).toBe(404);
  });
});

describe('POST /api/messages — /clear interception ACL', () => {
  test('non-owner is denied (403 Access denied)', async () => {
    seedTestGroup();
    asUser(OUTSIDER_ID);
    const { status, body } = await postMessage({
      chatJid: GROUP_JID,
      agentId: SESSION_ID,
      content: '/clear',
    });
    expect(status).toBe(403);
    expect(body.error).toMatch(/access denied/i);
    expect(stopGroupCalls).toHaveLength(0);
  });

  test('owner can /clear (200, session reset)', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    const { status, body } = await postMessage({
      chatJid: GROUP_JID,
      agentId: SESSION_ID,
      content: '/clear',
    });
    expect(status).toBe(200);
    expect(body.cleared).toBe(true);
    // executeSessionReset stopped only the session's runner …
    expect(stopGroupCalls).toEqual([
      { jid: SESSION_JID, opts: { force: true } },
    ]);
    // … and wrote a context_reset divider into the session's history.
    const msgs = db.getMessagesPage(SESSION_JID, undefined, 10) as Array<{
      content: string;
    }>;
    expect(msgs.some((m) => m.content === 'context_reset')).toBe(true);
  });

  test('owner with leading/trailing whitespace still triggers /clear', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    const { status, body } = await postMessage({
      chatJid: GROUP_JID,
      agentId: SESSION_ID,
      content: '  /clear  ',
    });
    expect(status).toBe(200);
    expect(body.cleared).toBe(true);
  });
});

describe('POST /api/messages — active-run steering', () => {
  test('keeps steer durable and requests a controlled interrupt', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    activeQueryId = 'run-active';

    const { status, body } = await postMessage({
      chatJid: GROUP_JID,
      agentId: SESSION_ID,
      content: '先回答这条高优先级消息',
      followUpBehavior: 'steer',
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({
      disposition: 'steered',
      runId: 'run-active',
    });
    const cursor = db.getMessageCursor(SESSION_JID, body.messageId);
    expect(body.ingestSequence).toBe(cursor?.sequence);
    expect(body.ingestSequence).toBeGreaterThan(0);
    expect(promoteFollowUpCalls).toEqual([
      {
        chatJid: SESSION_JID,
        messageId: body.messageId,
        expectedRunId: 'run-active',
      },
    ]);
    expect(db.getQueuedFollowUp(SESSION_JID, body.messageId)).toMatchObject({
      delivery_mode: 'steer',
      delivery_status: 'queued',
      delivery_run_id: 'run-active',
    });
    expect(
      db
        .getMessagesSince(SESSION_JID, { timestamp: '', id: '' })
        .some((message: { id: string }) => message.id === body.messageId),
    ).toBe(false);
  });

  test('queued send-now and direct steer target the same current run', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    activeQueryId = 'run-original';

    const queued = await postMessage({
      chatJid: GROUP_JID,
      agentId: SESSION_ID,
      content: '先排队，稍后点发送',
      followUpBehavior: 'queue',
    });
    expect(queued.status).toBe(200);
    expect(queued.body).toMatchObject({
      disposition: 'queued',
      runId: 'run-original',
    });

    activeQueryId = 'run-current';
    const direct = await postMessage({
      chatJid: GROUP_JID,
      agentId: SESSION_ID,
      content: '直接引导',
      followUpBehavior: 'steer',
    });
    expect(direct.status).toBe(200);

    const sendNow = await postFollowUpAction(queued.body.messageId, {
      chatJid: SESSION_JID,
      action: 'steer',
      expectedRunId: 'run-original',
    });
    expect(sendNow.status).toBe(200);
    expect(promoteFollowUpCalls).toEqual([
      {
        chatJid: SESSION_JID,
        messageId: direct.body.messageId,
        expectedRunId: 'run-current',
      },
      {
        chatJid: SESSION_JID,
        messageId: queued.body.messageId,
        expectedRunId: 'run-current',
      },
    ]);
  });

  test('routes queued edit and reorder operations', async () => {
    seedTestGroup();
    asUser(OWNER_ID);

    const edit = await postFollowUpAction('queued-message', {
      chatJid: GROUP_JID,
      action: 'edit',
      content: '  更新后的消息  ',
    });
    const move = await postFollowUpAction('queued-message', {
      chatJid: GROUP_JID,
      action: 'move_up',
    });

    expect(edit.status).toBe(200);
    expect(move.status).toBe(200);
    expect(editFollowUpCalls).toEqual([
      {
        chatJid: GROUP_JID,
        messageId: 'queued-message',
        content: '更新后的消息',
      },
    ]);
    expect(reorderFollowUpCalls).toEqual([
      {
        chatJid: GROUP_JID,
        messageId: 'queued-message',
        direction: 'up',
      },
    ]);
  });
});
