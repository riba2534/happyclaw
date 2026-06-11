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
 *   - non-member  + /clear        → 403 (Access denied, fails canAccessGroup)
 *   - shared member + /clear      → 403 (owner-only, fails canModifyGroup)
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

import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const SHARED_TMP =
  process.env.HAPPYCLAW_TEST_DATA_DIR ??
  (() => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-routes-messages-'));
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
        role: (process.env.HAPPYCLAW_TEST_USER_ROLE ?? 'member') as 'admin' | 'member',
        permissions: [],
      });
      return next();
    },
  };
});

const web = await import('../src/web.js');
const db = await import('../src/db.js');

const OWNER_ID = 'alice';
const MEMBER_ID = 'bob';
const OUTSIDER_ID = 'charlie';
const GROUP_JID = 'web:messages-acl-group';
const GROUP_FOLDER = 'messages-acl-group';

// Record queue.stopGroup calls so the owner path can assert a real reset.
const stopGroupCalls: Array<{ jid: string; opts?: { force?: boolean } }> = [];

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
  },
  getSessions: () => ({}) as Record<string, string>,
  setLastAgentTimestamp: () => {},
  getRegisteredGroups: () => registeredGroupsCache,
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
  db.addGroupMember(GROUP_FOLDER, OWNER_ID, 'owner');
  db.addGroupMember(GROUP_FOLDER, MEMBER_ID, 'member');
}

function asUser(userId: string, role: 'admin' | 'member' = 'member'): void {
  process.env.HAPPYCLAW_TEST_USER_ID = userId;
  process.env.HAPPYCLAW_TEST_USER_ROLE = role;
}

async function postMessage(body: unknown): Promise<{ status: number; body: any }> {
  const res = await app.request('/api/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

beforeAll(() => {
  fs.mkdirSync(path.join(tmpDataDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDataDir, 'groups'), { recursive: true });
  db.initDatabase();
});

beforeEach(() => {
  stopGroupCalls.length = 0;
  try {
    db.removeGroupMember(GROUP_FOLDER, OWNER_ID);
    db.removeGroupMember(GROUP_FOLDER, MEMBER_ID);
  } catch {
    /* ignore */
  }
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

describe('POST /api/messages — /clear interception ACL', () => {
  test('non-member is denied (403 Access denied)', async () => {
    seedTestGroup();
    asUser(OUTSIDER_ID);
    const { status, body } = await postMessage({ chatJid: GROUP_JID, content: '/clear' });
    expect(status).toBe(403);
    expect(body.error).toMatch(/access denied/i);
    expect(stopGroupCalls).toHaveLength(0);
  });

  test('shared member is denied (403 owner-only)', async () => {
    seedTestGroup();
    asUser(MEMBER_ID);
    const { status, body } = await postMessage({ chatJid: GROUP_JID, content: '/clear' });
    expect(status).toBe(403);
    expect(body.error).toMatch(/owner/i);
    expect(stopGroupCalls).toHaveLength(0);
  });

  test('owner can /clear (200, session reset)', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    const { status, body } = await postMessage({ chatJid: GROUP_JID, content: '/clear' });
    expect(status).toBe(200);
    expect(body.cleared).toBe(true);
    // executeSessionReset stopped the folder's sibling containers …
    expect(stopGroupCalls.length).toBeGreaterThan(0);
    expect(stopGroupCalls.every((c) => c.opts?.force === true)).toBe(true);
    // … and wrote a context_reset divider into the chat history.
    const msgs = db.getMessagesPage(GROUP_JID, undefined, 10) as Array<{ content: string }>;
    expect(msgs.some((m) => m.content === 'context_reset')).toBe(true);
  });

  test('owner with leading/trailing whitespace still triggers /clear', async () => {
    seedTestGroup();
    asUser(OWNER_ID);
    const { status, body } = await postMessage({ chatJid: GROUP_JID, content: '  /clear  ' });
    expect(status).toBe(200);
    expect(body.cleared).toBe(true);
  });
});
