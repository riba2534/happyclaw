/**
 * `POST /api/messages` with a `clientMessageId`: a resend after a slow or
 * lost response must not store, queue or bill the same message twice.
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

const ROOT =
  process.env.HAPPYCLAW_WEB_IDEMPOTENCY_TEST_DIR ??
  (() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-idempotency-'));
    process.env.HAPPYCLAW_WEB_IDEMPOTENCY_TEST_DIR = dir;
    return dir;
  })();

const auth = vi.hoisted(() => ({ userId: 'owner' }));
const resets = vi.hoisted(() => ({
  clear: 0,
  fresh: 0,
  gate: null as Promise<void> | null,
}));

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  const dataDir = path.join(
    process.env.HAPPYCLAW_WEB_IDEMPOTENCY_TEST_DIR!,
    'data',
  );
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
vi.mock('../src/middleware/auth.ts', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    authMiddleware: async (c: any, next: any) => {
      c.set('user', {
        id: auth.userId,
        username: auth.userId,
        display_name: auth.userId,
        role: 'admin',
        permissions: [],
      });
      return next();
    },
  };
});

vi.mock('../src/commands.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    executeSessionReset: async (
      chatJid: string,
      _folder: string,
      deps: { broadcast: (jid: string, msg: object) => void },
    ) => {
      resets.clear += 1;
      deps.broadcast(chatJid, {
        id: `divider-${resets.clear}`,
        chat_jid: chatJid,
        sender: '__system__',
        sender_name: 'system',
        content: 'context_reset',
        timestamp: new Date().toISOString(),
        is_from_me: true,
      });
    },
    executeFreshWindowReset: async () => {
      resets.fresh += 1;
      await resets.gate;
    },
  };
});
vi.mock('../src/fresh-window.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    captureWorkspaceSnapshot: async () => ({
      available: false,
      reason: 'test',
    }),
  };
});
// Every WebSocket client counts as the workspace owner's live session.
vi.mock('../src/web-context.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    getCachedSessionWithUser: () => ({
      user_id: 'owner',
      role: 'admin',
      status: 'active',
      expires_at: '2999-01-01T00:00:00.000Z',
    }),
  };
});

const web = await import('../src/web.js');
const { wsClients } = await import('../src/web-context.js');
const db = await import('../src/db.js');
const store = await import('../src/runtime-state-store.js');

const OWNER_JID = 'web:idempotency-owner';
const OTHER_JID = 'web:idempotency-other';
const SESSION_ID = '11111111-2222-4333-8444-555555555555';
const SESSION_JID = `${OWNER_JID}#agent:${SESSION_ID}`;
const OTHER_SESSION_ID = '33333333-2222-4333-8444-555555555555';
const OTHER_SESSION_JID = `${OTHER_JID}#agent:${OTHER_SESSION_ID}`;

const calls = {
  promote: [] as string[],
  tasks: [] as string[],
  dispatched: [] as string[],
};
const pullCursors: Record<string, { timestamp: string; id: string }> = {};
let failFormat = false;
let activeRunId: string | null = null;
let promoteGate: Promise<void> | null = null;
let failNextResolve = false;
let failPromote = false;
const announced: Array<Record<string, any>> = [];

const app = web.createAppForTest({
  queue: {
    stopGroup: async () => {},
    getActiveQueryId: () => activeRunId,
    requiresFeishuCliContainerRestart: () => false,
    hasActiveRunnerForMessage: () => false,
    sendMessage: () => 'no_active',
    enqueueTask: (jid: string) => calls.tasks.push(jid),
    retireRunnerAfterQuery: () => false,
  },
  processAgentConversation: async () => {},
  getLastAgentTimestamp: () => pullCursors,
  dispatchQueuedFollowUps: (jid: string) => calls.dispatched.push(jid),
  setLastAgentTimestamp: () => {},
  getRegisteredGroups: () => ({}),
  resolveEffectiveGroup: (group: unknown) => {
    if (failNextResolve) {
      failNextResolve = false;
      throw new Error('transient failure before the message is stored');
    }
    return { effectiveGroup: group };
  },
  formatMessages: () => {
    if (failFormat) throw new Error('failed after the message was stored');
    return 'formatted';
  },
  advanceNextPullCursorOnly: () => {},
  promoteFollowUp: async (_jid: string, messageId: string) => {
    calls.promote.push(messageId);
    await promoteGate;
    if (failPromote)
      throw new Error('steer failed after the message was stored');
    return { ok: true, state: 'interrupting' };
  },
} as unknown as Parameters<typeof web.createAppForTest>[0]);

function registerGroup(jid: string, folder: string, owner: string) {
  db.setRegisteredGroup(jid, {
    name: folder,
    folder,
    added_at: new Date().toISOString(),
    executionMode: 'host',
    created_by: owner,
  } as any);
}

beforeAll(() => {
  fs.mkdirSync(path.join(ROOT, 'data', 'db'), { recursive: true });
  db.initDatabase();
  registerGroup(OWNER_JID, 'idempotency-owner', 'owner');
  registerGroup(OTHER_JID, 'idempotency-other', 'other');
  for (const [id, folder, chatJid, owner] of [
    [SESSION_ID, 'idempotency-owner', OWNER_JID, 'owner'],
    [OTHER_SESSION_ID, 'idempotency-other', OTHER_JID, 'other'],
  ]) {
    db.createAgent({
      id,
      group_folder: folder,
      chat_jid: chatJid,
      name: 'Session',
      prompt: '',
      status: 'idle',
      kind: 'conversation',
      created_by: owner,
      created_at: new Date().toISOString(),
      completed_at: null,
      result_summary: null,
      last_im_jid: null,
      spawned_from_jid: null,
    });
  }
  wsClients.set(
    {
      readyState: 1,
      bufferedAmount: 0,
      send: (data: string) => {
        const msg = JSON.parse(data);
        if (msg.type === 'new_message') announced.push(msg.message);
      },
    } as any,
    { sessionId: 'ws-session' } as any,
  );
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  auth.userId = 'owner';
  activeRunId = null;
  promoteGate = null;
  failNextResolve = false;
  failPromote = false;
  resets.gate = null;
  resets.clear = 0;
  resets.fresh = 0;
  failFormat = false;
  calls.tasks.length = 0;
  calls.dispatched.length = 0;
  for (const jid of Object.keys(pullCursors)) delete pullCursors[jid];
  announced.length = 0;
  calls.promote.length = 0;
});

let seq = 0;
function uuid(): string {
  seq += 1;
  return `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
}

async function post(body: Record<string, unknown>) {
  const res = await app.request('/api/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chatJid: OWNER_JID, agentId: SESSION_ID, ...body }),
  });
  const text = await res.text();
  let json: any = {};
  try {
    json = JSON.parse(text);
  } catch {
    // An uncaught handler error answers with a plain-text 500.
  }
  return { status: res.status, body: json };
}

function storedWith(jid: string, content: string) {
  return db
    .getMessagesPage(jid, undefined, 500)
    .filter((m) => m.content === content);
}

describe('Web send idempotency', () => {
  test('a resend with the same id stores one message and starts one turn', async () => {
    const id = uuid();
    const first = await post({ content: 'resend me', clientMessageId: id });
    const second = await post({ content: 'resend me', clientMessageId: id });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.messageId).toBe(first.body.messageId);
    expect(second.body.disposition).toBe(first.body.disposition);
    expect(second.body.deduplicated).toBe(true);
    expect(storedWith(SESSION_JID, 'resend me')).toHaveLength(1);
    expect(calls.tasks).toEqual([SESSION_JID]);
  });

  test('different ids are different messages', async () => {
    await post({ content: 'twice on purpose', clientMessageId: uuid() });
    await post({ content: 'twice on purpose', clientMessageId: uuid() });
    expect(storedWith(SESSION_JID, 'twice on purpose')).toHaveLength(2);
    expect(calls.tasks).toHaveLength(2);
  });

  test('a client without ids keeps the old behaviour', async () => {
    const first = await post({ content: 'legacy client' });
    const second = await post({ content: 'legacy client' });
    expect(first.status).toBe(200);
    expect(second.body.messageId).not.toBe(first.body.messageId);
    expect(second.body.deduplicated).toBeUndefined();
    expect(storedWith(SESSION_JID, 'legacy client')).toHaveLength(2);
  });

  test('a concurrent resend waits for the first attempt and shares its answer', async () => {
    activeRunId = 'run-active';
    let release!: () => void;
    promoteGate = new Promise((resolve) => (release = resolve));
    const id = uuid();
    const body = {
      content: 'steer concurrently',
      clientMessageId: id,
      followUpBehavior: 'steer',
    };
    const first = post(body);
    const second = post(body);
    await vi.waitFor(() => expect(calls.promote).toHaveLength(1));
    release();

    const [a, b] = await Promise.all([first, second]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(b.body.messageId).toBe(a.body.messageId);
    expect(storedWith(SESSION_JID, 'steer concurrently')).toHaveLength(1);
    expect(calls.promote).toHaveLength(1);
  });

  test('the same id with different content is a conflict, not a duplicate', async () => {
    const id = uuid();
    await post({ content: 'original', clientMessageId: id });
    const clash = await post({ content: 'edited', clientMessageId: id });
    const asSteer = await post({
      content: 'original',
      clientMessageId: id,
      followUpBehavior: 'steer',
    });

    expect(clash.status).toBe(409);
    expect(storedWith(SESSION_JID, 'edited')).toHaveLength(0);
    // Steering instead of queueing is a different send.
    expect(asSteer.status).toBe(409);
    expect(storedWith(SESSION_JID, 'original')).toHaveLength(1);
  });

  test('the announced message carries its id, so the client can tell it was stored', async () => {
    const id = uuid();
    await post({ content: 'announce me', clientMessageId: id });
    await vi.waitFor(() =>
      expect(announced.find((m) => m.content === 'announce me')).toBeDefined(),
    );
    expect(
      announced.find((m) => m.content === 'announce me')!.client_message_id,
    ).toBe(id);

    await post({ content: 'no id' });
    await vi.waitFor(() =>
      expect(announced.find((m) => m.content === 'no id')).toBeDefined(),
    );
    expect(
      announced.find((m) => m.content === 'no id')!.client_message_id,
    ).toBeUndefined();
  });

  test('a failure after the message is stored still answers the resend from it', async () => {
    activeRunId = 'run-active';
    failPromote = true;
    const id = uuid();
    const body = {
      content: 'stored then failed',
      clientMessageId: id,
      followUpBehavior: 'steer',
    };
    const failed = await post(body);
    failPromote = false;
    const resent = await post(body);

    expect(failed.status).toBe(500);
    const [stored] = storedWith(SESSION_JID, 'stored then failed');
    expect(failed.body).toMatchObject({ stored: true, messageId: stored.id });
    expect(resent.status).toBe(200);
    expect(resent.body.deduplicated).toBe(true);
    expect(resent.body.partial).toBeUndefined();
    expect(storedWith(SESSION_JID, 'stored then failed')).toHaveLength(1);
    expect(resent.body.messageId).toBe(
      storedWith(SESSION_JID, 'stored then failed')[0].id,
    );
    expect(calls.promote).toHaveLength(1);
    // The steer is a durable follow-up whose dispatch the failure skipped.
    expect(calls.dispatched).toEqual([SESSION_JID, SESSION_JID]);
  });

  test('a session input stored before a failure is queued again, and again on resend', async () => {
    failFormat = true;
    const id = uuid();
    const body = {
      agentId: SESSION_ID,
      content: 'session stored then failed',
      clientMessageId: id,
    };
    const failed = await post(body);
    expect(failed.status).toBe(500);
    expect(failed.body.stored).toBe(true);
    expect(calls.tasks).toEqual([SESSION_JID]);

    failFormat = false;
    const resent = await post(body);
    expect(resent.body.deduplicated).toBe(true);
    expect(calls.tasks).toEqual([SESSION_JID, SESSION_JID]);
    expect(storedWith(SESSION_JID, 'session stored then failed')).toHaveLength(
      1,
    );

    // A finished send's replay queues nothing.
    const doneId = uuid();
    await post({ ...body, content: 'session ok', clientMessageId: doneId });
    calls.tasks.length = 0;
    await post({ ...body, content: 'session ok', clientMessageId: doneId });
    expect(calls.tasks).toEqual([]);
  });

  test('a replay queues nothing once the session is gone or the input was read', async () => {
    const extraId = '22222222-3333-4444-8555-666666666666';
    db.createAgent({
      id: extraId,
      group_folder: 'idempotency-owner',
      chat_jid: OWNER_JID,
      name: 'Extra',
      prompt: '',
      status: 'idle',
      kind: 'conversation',
      created_by: 'owner',
      created_at: new Date().toISOString(),
      completed_at: null,
      result_summary: null,
      last_im_jid: null,
      spawned_from_jid: null,
    });
    failFormat = true;
    const goneBody = {
      agentId: extraId,
      content: 'session then deleted',
      clientMessageId: uuid(),
    };
    await post(goneBody);
    const readBody = {
      agentId: SESSION_ID,
      content: 'read meanwhile',
      clientMessageId: uuid(),
    };
    const read = await post(readBody);
    failFormat = false;
    calls.tasks.length = 0;

    db.deleteAgent(extraId);
    // The session has since pulled past the input.
    pullCursors[SESSION_JID] = {
      timestamp: '9999-01-01T00:00:00.000Z',
      id: read.body.messageId,
    };
    expect((await post(goneBody)).status).toBe(404);
    expect((await post(readBody)).body.deduplicated).toBe(true);
    expect(calls.tasks).toEqual([]);
  });

  test('the /clear divider carries the id', async () => {
    const id = uuid();
    await post({ content: '/clear', clientMessageId: id });
    const divider = announced.find((m) => m.content === 'context_reset');
    expect(divider?.client_message_id).toBe(id);
  });

  test('/clear and /fresh run once per id, concurrent resends included', async () => {
    const clearId = uuid();
    await post({ content: '/clear', clientMessageId: clearId });
    const clearAgain = await post({
      content: '/clear',
      clientMessageId: clearId,
    });
    expect(clearAgain.body).toMatchObject({
      cleared: true,
      deduplicated: true,
    });
    expect(resets.clear).toBe(1);

    let release!: () => void;
    resets.gate = new Promise((resolve) => (release = resolve));
    const freshId = uuid();
    const first = post({ content: '/fresh 交接', clientMessageId: freshId });
    const second = post({ content: '/fresh 交接', clientMessageId: freshId });
    await vi.waitFor(() => expect(resets.fresh).toBe(1));
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(a.body).toMatchObject({ cleared: true, fresh: true });
    expect(b.body).toMatchObject({
      cleared: true,
      fresh: true,
      deduplicated: true,
    });
    expect(resets.fresh).toBe(1);

    await post({ content: '/clear' });
    await post({ content: '/clear' });
    expect(resets.clear).toBe(3);
  });

  test('the same id with other images is a conflict too', async () => {
    const id = uuid();
    const image = (data: string) => ({
      type: 'image',
      data,
      mimeType: 'image/png',
    });
    const first = await post({
      content: 'with image',
      attachments: [image('iVBORw0KGgo=')],
      clientMessageId: id,
    });
    const again = await post({
      content: 'with image',
      attachments: [image('iVBORw0KGgo=')],
      clientMessageId: id,
    });
    const other = await post({
      content: 'with image',
      attachments: [image('iVBORw0KGgoA')],
      clientMessageId: id,
    });
    expect(first.status).toBe(200);
    expect(again.body.deduplicated).toBe(true);
    expect(other.status).toBe(409);
  });

  test('a failed first attempt is not remembered, so the resend is processed', async () => {
    const id = uuid();
    failNextResolve = true;
    const failed = await post({
      content: 'after failure',
      clientMessageId: id,
    });
    const retried = await post({
      content: 'after failure',
      clientMessageId: id,
    });

    expect(failed.status).toBe(500);
    expect(retried.status).toBe(200);
    expect(retried.body.deduplicated).toBeUndefined();
    expect(storedWith(SESSION_JID, 'after failure')).toHaveLength(1);
    expect(calls.tasks).toEqual([SESSION_JID]);
  });

  test('an expired record no longer answers and is pruned', async () => {
    const id = uuid();
    const longAgo = Date.now() - store.WEB_MESSAGE_DEDUP_TTL_MS - 1000;
    store.recordWebMessageDedup({
      userId: 'owner',
      chatJid: OWNER_JID,
      clientMessageId: id,
      fingerprint: 'stale',
      response: { success: true, messageId: 'stale-message' },
      now: longAgo,
    });
    expect(store.getWebMessageDedup('owner', OWNER_JID, id)).toBeNull();

    const sent = await post({ content: 'after expiry', clientMessageId: id });
    expect(sent.status).toBe(200);
    expect(sent.body.messageId).not.toBe('stale-message');
    expect(store.getWebMessageDedup('owner', OWNER_JID, id)).not.toBeNull();

    store.recordWebMessageDedup({
      userId: 'owner',
      chatJid: OWNER_JID,
      clientMessageId: uuid(),
      fingerprint: 'stale',
      response: {},
      now: longAgo,
    });
    expect(store.pruneWebMessageDedup()).toBe(1);
  });

  test('writes prune expired rows at most once a minute', () => {
    const now = Date.now();
    const longAgo = now - store.WEB_MESSAGE_DEDUP_TTL_MS - 1000;
    const record = (at: number) =>
      store.recordWebMessageDedup({
        userId: 'owner',
        chatJid: OWNER_JID,
        clientMessageId: uuid(),
        fingerprint: 'f',
        response: {},
        now: at,
      });
    store.pruneWebMessageDedup(now);
    record(longAgo);
    record(now + 1000);
    // The write a second after a prune left the expired row alone.
    expect(store.pruneWebMessageDedup(now + 2000)).toBe(1);

    record(longAgo);
    record(now + 2000 + 60_000);
    expect(store.pruneWebMessageDedup(now + 2000 + 60_000)).toBe(0);
  });

  test('ids are per user: nobody reads another user’s answer or collides with it', async () => {
    const id = uuid();
    const owners = await post({ content: 'mine', clientMessageId: id });
    expect(owners.status).toBe(200);

    auth.userId = 'other';
    const guessed = await post({ content: 'mine', clientMessageId: id });
    expect(guessed.status).toBe(403);
    expect(guessed.body.messageId).toBeUndefined();

    const ownChat = await post({
      chatJid: OTHER_JID,
      agentId: OTHER_SESSION_ID,
      content: 'mine',
      clientMessageId: id,
    });
    expect(ownChat.status).toBe(200);
    expect(ownChat.body.deduplicated).toBeUndefined();
    expect(storedWith(OTHER_SESSION_JID, 'mine')).toHaveLength(1);
  });

  test('a malformed id is rejected', async () => {
    const res = await post({ content: 'bad id', clientMessageId: 'nope' });
    expect(res.status).toBe(400);
  });
});
