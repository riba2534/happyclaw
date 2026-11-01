/**
 * Regression: DELETE /api/groups/:jid/messages/:messageId for runtime sessions.
 *
 * Runtime session messages are stored under the virtual chat JID
 * `{workspaceJid}#agent:{sessionId}`, and the Web client sends the message's
 * own chat_jid. The route used to resolve that raw JID through
 * getRegisteredGroup(), which never has a row for a virtual JID, so every
 * delete inside a runtime session returned 404 and the message stayed put.
 *
 * The route now splits the `#agent:` suffix off for the workspace lookup and
 * ACL check, validates the session belongs to that workspace, and deletes from
 * the virtual JID the row actually lives in.
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
      path.join(os.tmpdir(), 'happyclaw-routes-groups-msgdel-'),
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

vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: process.env.HAPPYCLAW_TEST_USER_ID ?? 'alice',
      username: 'alice',
      role: process.env.HAPPYCLAW_TEST_USER_ROLE ?? 'member',
      status: 'active',
      permissions: [],
    });
    return next();
  },
}));

const { broadcastMessageDeletedMock } = vi.hoisted(() => ({
  broadcastMessageDeletedMock: vi.fn(),
}));

vi.mock('../src/web.js', () => ({
  broadcastNewMessage: () => {},
  broadcastMessageDeleted: broadcastMessageDeletedMock,
  invalidateAllowedUserCache: () => {},
}));

const groupRoutesModule = await import('../src/routes/groups.js');
const db = await import('../src/db.js');
const webContext = await import('../src/web-context.js');

const groupRoutes = groupRoutesModule.default;

const OWNER_ID = 'alice';
const OTHER_ID = 'mallory';

const JID = 'web:msgdel-workspace';
const FOLDER = 'msgdel-workspace';
const SESSION_ID = 'session-msgdel-1';
const VIRTUAL_JID = `${JID}#agent:${SESSION_ID}`;

function asUser(userId: string, role: 'admin' | 'member' = 'member'): void {
  process.env.HAPPYCLAW_TEST_USER_ID = userId;
  process.env.HAPPYCLAW_TEST_USER_ROLE = role;
}

function del(chatJid: string, messageId: string): Promise<Response> {
  return groupRoutes.request(
    `/${encodeURIComponent(chatJid)}/messages/${encodeURIComponent(messageId)}`,
    { method: 'DELETE' },
  );
}

function seedMessage(
  id: string,
  chatJid: string,
  sender: string,
  isFromMe = false,
): void {
  db.ensureChatExists(chatJid);
  db.storeMessageDirect(
    id,
    chatJid,
    sender,
    sender,
    `content of ${id}`,
    new Date().toISOString(),
    isFromMe,
  );
}

beforeAll(() => {
  fs.mkdirSync(path.join(tmpDataDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDataDir, 'groups'), { recursive: true });
  db.initDatabase();
  webContext.setWebDeps({
    getRegisteredGroups: () => ({}),
    broadcastNewMessage: vi.fn(),
    broadcastMessageDeleted: broadcastMessageDeletedMock,
  } as unknown as Parameters<typeof webContext.setWebDeps>[0]);
});

beforeEach(() => {
  broadcastMessageDeletedMock.mockReset();
  db.setRegisteredGroup(JID, {
    name: 'Msg Delete Workspace',
    folder: FOLDER,
    added_at: new Date().toISOString(),
    executionMode: 'container',
    created_by: OWNER_ID,
    is_home: false,
  } as any);
  db.createAgent({
    id: SESSION_ID,
    group_folder: FOLDER,
    chat_jid: JID,
    name: 'ChatHistory-Session',
    prompt: '',
    status: 'completed',
    kind: 'conversation',
    created_by: OWNER_ID,
    created_at: new Date().toISOString(),
  } as any);
  asUser(OWNER_ID, 'member');
});

afterEach(() => {
  try {
    db.deleteAgent(SESSION_ID);
  } catch {
    /* ignore */
  }
  try {
    db.deleteRegisteredGroup(JID);
  } catch {
    /* ignore */
  }
  delete process.env.HAPPYCLAW_TEST_USER_ID;
  delete process.env.HAPPYCLAW_TEST_USER_ROLE;
});

describe('DELETE /:jid/messages/:messageId', () => {
  test('deletes a runtime session message addressed by its virtual JID', async () => {
    seedMessage('msg-runtime-1', VIRTUAL_JID, OWNER_ID);

    const res = await del(VIRTUAL_JID, 'msg-runtime-1');

    expect(res.status).toBe(200);
    expect(db.getMessage(VIRTUAL_JID, 'msg-runtime-1')).toBeNull();
    expect(broadcastMessageDeletedMock).toHaveBeenCalledWith(
      VIRTUAL_JID,
      'msg-runtime-1',
    );
  });

  test('still deletes a main session message addressed by the workspace JID', async () => {
    seedMessage('msg-main-1', JID, OWNER_ID);

    const res = await del(JID, 'msg-main-1');

    expect(res.status).toBe(200);
    expect(db.getMessage(JID, 'msg-main-1')).toBeNull();
  });

  test('a session id from another workspace cannot delete through this workspace', async () => {
    const foreignVirtualJid = `${JID}#agent:session-owned-elsewhere`;
    db.createAgent({
      id: 'session-owned-elsewhere',
      group_folder: 'other-folder',
      chat_jid: 'web:other-workspace',
      name: 'Foreign Session',
      prompt: '',
      status: 'completed',
      kind: 'conversation',
      created_by: OWNER_ID,
      created_at: new Date().toISOString(),
    } as any);
    seedMessage('msg-foreign-1', foreignVirtualJid, OWNER_ID);

    const res = await del(foreignVirtualJid, 'msg-foreign-1');

    expect(res.status).toBe(404);
    expect(db.getMessage(foreignVirtualJid, 'msg-foreign-1')).not.toBeNull();
    db.deleteAgent('session-owned-elsewhere');
  });

  test('an unknown session id is rejected', async () => {
    const unknownVirtualJid = `${JID}#agent:no-such-session`;
    seedMessage('msg-unknown-1', unknownVirtualJid, OWNER_ID);

    const res = await del(unknownVirtualJid, 'msg-unknown-1');

    expect(res.status).toBe(404);
    expect(db.getMessage(unknownVirtualJid, 'msg-unknown-1')).not.toBeNull();
  });

  test('a non-owner cannot delete a runtime session message', async () => {
    seedMessage('msg-runtime-2', VIRTUAL_JID, OWNER_ID);
    asUser(OTHER_ID, 'member');

    const res = await del(VIRTUAL_JID, 'msg-runtime-2');

    expect(res.status).toBe(404);
    expect(db.getMessage(VIRTUAL_JID, 'msg-runtime-2')).not.toBeNull();
  });

  test('the AI-message ownership rule still applies inside a runtime session', async () => {
    seedMessage('msg-runtime-ai', VIRTUAL_JID, 'happyclaw-agent', true);

    const res = await del(VIRTUAL_JID, 'msg-runtime-ai');

    expect(res.status).toBe(403);
    expect(db.getMessage(VIRTUAL_JID, 'msg-runtime-ai')).not.toBeNull();
  });
});

/**
 * GET /:jid/messages and POST /:jid/clear-history both gate host workspaces on
 * the admin role, but the single-message delete never did. An owner who is no
 * longer admin could therefore delete a host workspace's messages one by one
 * while being unable to read or bulk-clear them.
 */
describe('DELETE /:jid/messages/:messageId host execution gate', () => {
  const HOST_JID = 'web:msgdel-host-workspace';
  const HOST_FOLDER = 'msgdel-host-workspace';
  const HOST_SESSION_ID = 'session-msgdel-host';
  const HOST_VIRTUAL_JID = `${HOST_JID}#agent:${HOST_SESSION_ID}`;
  const HOST_IM_JID = 'feishu:msgdel-host-home-sibling';
  const BOUND_HOST_IM_JID = 'telegram:msgdel-bound-host-workspace';
  const CROSS_OWNER_IM_JID = 'qq:msgdel-cross-owner-host-workspace';

  beforeEach(() => {
    db.setRegisteredGroup(HOST_JID, {
      name: 'Host Workspace',
      folder: HOST_FOLDER,
      added_at: new Date().toISOString(),
      executionMode: 'host',
      created_by: OWNER_ID,
      is_home: true,
    } as any);
    db.setRegisteredGroup(HOST_IM_JID, {
      name: 'Host Home IM sibling',
      folder: HOST_FOLDER,
      added_at: new Date().toISOString(),
      executionMode: 'container',
      created_by: OWNER_ID,
      is_home: false,
    } as any);
    db.setRegisteredGroup(BOUND_HOST_IM_JID, {
      name: 'Bound host workspace IM',
      folder: 'channel-owner-folder',
      added_at: new Date().toISOString(),
      executionMode: 'container',
      created_by: OWNER_ID,
      is_home: false,
      target_main_jid: HOST_JID,
    } as any);
    db.setRegisteredGroup(CROSS_OWNER_IM_JID, {
      name: 'Cross-owner host workspace IM',
      folder: 'other-channel-owner-folder',
      added_at: new Date().toISOString(),
      executionMode: 'container',
      created_by: OTHER_ID,
      is_home: false,
      target_main_jid: HOST_JID,
    } as any);
    db.createAgent({
      id: HOST_SESSION_ID,
      group_folder: HOST_FOLDER,
      chat_jid: HOST_JID,
      name: 'Host Session',
      prompt: '',
      status: 'completed',
      kind: 'conversation',
      created_by: OWNER_ID,
      created_at: new Date().toISOString(),
    } as any);
  });

  afterEach(() => {
    try {
      db.deleteAgent(HOST_SESSION_ID);
    } catch {
      /* ignore */
    }
    try {
      db.deleteRegisteredGroup(HOST_JID);
    } catch {
      /* ignore */
    }
    for (const jid of [HOST_IM_JID, BOUND_HOST_IM_JID, CROSS_OWNER_IM_JID]) {
      try {
        db.deleteRegisteredGroup(jid);
      } catch {
        /* ignore */
      }
    }
  });

  test('a non-admin owner is denied on the workspace JID', async () => {
    seedMessage('msg-host-1', HOST_JID, OWNER_ID);
    asUser(OWNER_ID, 'member');

    const res = await del(HOST_JID, 'msg-host-1');

    expect(res.status).toBe(403);
    expect(db.getMessage(HOST_JID, 'msg-host-1')).not.toBeNull();
  });

  test('a non-admin owner is denied on a runtime session JID', async () => {
    seedMessage('msg-host-2', HOST_VIRTUAL_JID, OWNER_ID);
    asUser(OWNER_ID, 'member');

    const res = await del(HOST_VIRTUAL_JID, 'msg-host-2');

    expect(res.status).toBe(403);
    expect(db.getMessage(HOST_VIRTUAL_JID, 'msg-host-2')).not.toBeNull();
  });

  test('an unbound IM chat keeps its own execution contract, not its folder Home', async () => {
    seedMessage('msg-host-home-im', HOST_IM_JID, OWNER_ID);
    asUser(OWNER_ID, 'member');

    const res = await del(HOST_IM_JID, 'msg-host-home-im');

    // The chat is no session of the host Home that shares its folder.
    expect(res.status).toBe(200);
    expect(db.getMessage(HOST_IM_JID, 'msg-host-home-im')).toBeNull();
  });

  test('a non-admin owner is denied through an IM chat bound to a host workspace', async () => {
    seedMessage('msg-host-bound-im', BOUND_HOST_IM_JID, OWNER_ID);
    asUser(OWNER_ID, 'member');

    const res = await del(BOUND_HOST_IM_JID, 'msg-host-bound-im');

    expect(res.status).toBe(403);
    expect(
      db.getMessage(BOUND_HOST_IM_JID, 'msg-host-bound-im'),
    ).not.toBeNull();
  });

  test('a workspace admin cannot delete a physical IM row owned by another user', async () => {
    seedMessage('msg-cross-owner-im', CROSS_OWNER_IM_JID, OTHER_ID);
    asUser(OWNER_ID, 'admin');

    const res = await del(CROSS_OWNER_IM_JID, 'msg-cross-owner-im');

    expect(res.status).toBe(404);
    expect(
      db.getMessage(CROSS_OWNER_IM_JID, 'msg-cross-owner-im'),
    ).not.toBeNull();
    expect(broadcastMessageDeletedMock).not.toHaveBeenCalled();
  });

  test('an admin owner can still delete', async () => {
    seedMessage('msg-host-3', HOST_VIRTUAL_JID, OWNER_ID);
    asUser(OWNER_ID, 'admin');

    const res = await del(HOST_VIRTUAL_JID, 'msg-host-3');

    expect(res.status).toBe(200);
    expect(db.getMessage(HOST_VIRTUAL_JID, 'msg-host-3')).toBeNull();
  });
});
