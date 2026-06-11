/**
 * Resource-level ACL for POST /:jid/stop and /:jid/interrupt.
 *
 * Both routes were `canAccessGroup` (any shared member could stop/interrupt the
 * owner's container). They now additionally require the caller to be the owner
 * (canModifyGroup) OR the initiator of the currently-running query (queue's
 * getActiveRunInitiator). Coverage:
 *   - owner                              → 200 (canModifyGroup)
 *   - shared member, they are initiator  → 200
 *   - shared member, owner is initiator  → 403
 *   - shared member, no active initiator → 403
 *   - non-member                         → 404 (hidden by canAccessGroup)
 *
 * The queue is stubbed (getActiveRunInitiator returns a per-test value); the
 * deps.queue.stopGroup / interruptQuery happy paths are no-ops so the test
 * isolates the ACL decision.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const SHARED_TMP =
  process.env.HAPPYCLAW_TEST_DATA_DIR ??
  (() => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-stop-interrupt-'));
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

vi.mock('../src/middleware/auth.ts', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    authMiddleware: async (c: any, next: any) => {
      c.set('user', {
        id: process.env.HAPPYCLAW_TEST_USER_ID ?? 'alice',
        username: 'alice',
        role: (process.env.HAPPYCLAW_TEST_USER_ROLE ?? 'member') as 'admin' | 'member',
        permissions: [],
      });
      return next();
    },
  };
});

// groups.ts statically imports these from web.js — mock so importing the route
// module doesn't pull in the full Hono app + WebSocket.
vi.mock('../src/web.js', () => ({
  broadcastNewMessage: () => {},
  invalidateAllowedUserCache: () => {},
}));

const groupRoutesModule = await import('../src/routes/groups.js');
const db = await import('../src/db.js');
const webContext = await import('../src/web-context.js');

const groupRoutes = groupRoutesModule.default;

const OWNER_ID = 'alice';
const MEMBER_ID = 'bob';
const OUTSIDER_ID = 'charlie';
const GROUP_JID = 'web:stop-interrupt-group';
const GROUP_FOLDER = 'stop-interrupt-group';

// Per-test value returned by the stubbed queue.getActiveRunInitiator, and the
// last jid it was asked about (to assert the route's full-vs-base jid choice).
let activeInitiator: string | null = null;
let lastInitiatorJid: string | null = null;

function seedTestGroup(): void {
  db.setRegisteredGroup(GROUP_JID, {
    name: 'Stop/Interrupt ACL Group',
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

async function post(pathSuffix: string): Promise<{ status: number; body: any }> {
  const res = await groupRoutes.request(
    `/${encodeURIComponent(GROUP_JID)}${pathSuffix}`,
    { method: 'POST' },
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

beforeAll(() => {
  fs.mkdirSync(path.join(tmpDataDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDataDir, 'groups'), { recursive: true });
  db.initDatabase();
  webContext.setWebDeps({
    queue: {
      stopGroup: async () => {},
      interruptQuery: () => false,
      getActiveRunInitiator: (jid: string) => {
        lastInitiatorJid = jid;
        return activeInitiator;
      },
    },
  } as unknown as Parameters<typeof webContext.setWebDeps>[0]);
});

beforeEach(() => {
  activeInitiator = null;
  lastInitiatorJid = null;
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

for (const route of ['/stop', '/interrupt'] as const) {
  describe(`POST /:jid${route} resource-level ACL`, () => {
    test('owner is allowed (200)', async () => {
      seedTestGroup();
      asUser(OWNER_ID);
      activeInitiator = MEMBER_ID; // even when someone else initiated
      const { status } = await post(route);
      expect(status).toBe(200);
    });

    test('shared member who initiated the run is allowed (200)', async () => {
      seedTestGroup();
      asUser(MEMBER_ID);
      activeInitiator = MEMBER_ID;
      const { status } = await post(route);
      expect(status).toBe(200);
    });

    test('shared member is denied when the owner initiated the run (403)', async () => {
      seedTestGroup();
      asUser(MEMBER_ID);
      activeInitiator = OWNER_ID;
      const { status, body } = await post(route);
      expect(status).toBe(403);
      expect(body.error).toMatch(/owner or the run initiator/i);
    });

    test('shared member is denied when there is no active initiator (403)', async () => {
      seedTestGroup();
      asUser(MEMBER_ID);
      activeInitiator = null;
      const { status } = await post(route);
      expect(status).toBe(403);
    });

    test('non-member gets 404 (group hidden by canAccessGroup)', async () => {
      seedTestGroup();
      asUser(OUTSIDER_ID);
      activeInitiator = OUTSIDER_ID; // irrelevant — fails canAccessGroup first
      const { status, body } = await post(route);
      expect(status).toBe(404);
      expect(body.error).toMatch(/not found/i);
    });
  });
}

describe('interrupt resolves the initiator by the FULL #agent: jid', () => {
  test('passes the full virtual jid (not baseJid) to getActiveRunInitiator', async () => {
    seedTestGroup();
    asUser(MEMBER_ID); // non-owner → canModifyGroup false → getActiveRunInitiator IS consulted
    activeInitiator = MEMBER_ID;
    const agentJid = `${GROUP_JID}#agent:abc`;
    const res = await groupRoutes.request(
      `/${encodeURIComponent(agentJid)}/interrupt`,
      { method: 'POST' },
    );
    expect(res.status).toBe(200); // member is the agent run's initiator
    // The route must look up the AGENT runner (full jid), not the base group.
    expect(lastInitiatorJid).toBe(agentJid);
  });
});
