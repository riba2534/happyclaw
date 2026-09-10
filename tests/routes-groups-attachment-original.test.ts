/**
 * GET /api/groups/:jid/messages/:messageId/attachments/:index/original
 * must reuse the same virtual-JID, access, and host-execution gates as
 * single-message delete. The list now returns thumbnails; this route is the
 * only way the viewer reads full-resolution bytes.
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
      path.join(os.tmpdir(), 'happyclaw-routes-groups-origatt-'),
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

vi.mock('../src/web.js', () => ({
  broadcastNewMessage: () => {},
  broadcastMessageDeleted: () => {},
  invalidateAllowedUserCache: () => {},
}));

const groupRoutesModule = await import('../src/routes/groups.js');
const db = await import('../src/db.js');
const webContext = await import('../src/web-context.js');

const groupRoutes = groupRoutesModule.default;

const OWNER_ID = 'alice';
const OTHER_ID = 'mallory';
const JID = 'web:origatt-workspace';
const FOLDER = 'origatt-workspace';
const SESSION_ID = 'session-origatt-1';
const VIRTUAL_JID = `${JID}#agent:${SESSION_ID}`;
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function asUser(userId: string, role: 'admin' | 'member' = 'member'): void {
  process.env.HAPPYCLAW_TEST_USER_ID = userId;
  process.env.HAPPYCLAW_TEST_USER_ROLE = role;
}

function originalUrl(
  chatJid: string,
  messageId: string,
  index: number,
): string {
  return `/${encodeURIComponent(chatJid)}/messages/${encodeURIComponent(messageId)}/attachments/${index}/original`;
}

function getOriginal(
  chatJid: string,
  messageId: string,
  index: number,
): Promise<Response> {
  return groupRoutes.request(originalUrl(chatJid, messageId, index), {
    method: 'GET',
  });
}

function seedImageMessage(
  id: string,
  chatJid: string,
  sender = OWNER_ID,
): void {
  db.ensureChatExists(chatJid);
  db.storeMessageDirect(
    id,
    chatJid,
    sender,
    sender,
    `image ${id}`,
    new Date().toISOString(),
    false,
    {
      attachments: JSON.stringify([
        { type: 'file', name: 'notes.txt' },
        {
          type: 'image',
          data: PNG_BYTES.toString('base64'),
          mimeType: 'image/png',
        },
      ]),
    },
  );
}

beforeAll(() => {
  fs.mkdirSync(path.join(tmpDataDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDataDir, 'groups'), { recursive: true });
  db.initDatabase();
  webContext.setWebDeps({
    getRegisteredGroups: () => ({}),
    broadcastNewMessage: vi.fn(),
    broadcastMessageDeleted: vi.fn(),
  } as unknown as Parameters<typeof webContext.setWebDeps>[0]);
});

beforeEach(() => {
  db.setRegisteredGroup(JID, {
    name: 'Original Attachment Workspace',
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
    name: 'Original-Attachment-Session',
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

describe('GET /:jid/messages/:messageId/attachments/:index/original', () => {
  test('serves the stored image by attachment-array index on a runtime JID', async () => {
    seedImageMessage('msg-orig-1', VIRTUAL_JID);

    const res = await getOriginal(VIRTUAL_JID, 'msg-orig-1', 1);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG_BYTES)).toBe(true);
  });

  test('a non-image index and an unknown workspace stay 404', async () => {
    seedImageMessage('msg-orig-2', JID);

    expect((await getOriginal(JID, 'msg-orig-2', 0)).status).toBe(404);
    expect((await getOriginal(JID, 'msg-orig-2', 9)).status).toBe(404);
    expect(
      (await getOriginal('web:no-such-workspace', 'msg-orig-2', 1)).status,
    ).toBe(404);
  });

  test('another user cannot read originals from this workspace', async () => {
    seedImageMessage('msg-orig-3', JID);
    asUser(OTHER_ID, 'member');

    const res = await getOriginal(JID, 'msg-orig-3', 1);

    expect(res.status).toBe(404);
  });

  test('a foreign session id cannot be used as a workspace path', async () => {
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
    seedImageMessage('msg-orig-foreign', foreignVirtualJid);

    const res = await getOriginal(foreignVirtualJid, 'msg-orig-foreign', 1);

    expect(res.status).toBe(404);
    db.deleteAgent('session-owned-elsewhere');
  });
});

describe('GET original attachment host execution gate', () => {
  const HOST_JID = 'web:origatt-host-workspace';
  const HOST_FOLDER = 'origatt-host-workspace';

  beforeEach(() => {
    db.setRegisteredGroup(HOST_JID, {
      name: 'Host Workspace',
      folder: HOST_FOLDER,
      added_at: new Date().toISOString(),
      executionMode: 'host',
      created_by: OWNER_ID,
      is_home: true,
    } as any);
  });

  afterEach(() => {
    try {
      db.deleteRegisteredGroup(HOST_JID);
    } catch {
      /* ignore */
    }
  });

  test('a non-admin owner is denied on a host workspace', async () => {
    seedImageMessage('msg-host-orig', HOST_JID);
    asUser(OWNER_ID, 'member');

    const res = await getOriginal(HOST_JID, 'msg-host-orig', 1);

    expect(res.status).toBe(403);
  });
});
