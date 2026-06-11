/**
 * Covers the two owner-lifecycle fixes on the groups routes:
 *
 *   ③a  POST /api/groups/:jid/reset-owner — admin break-glass that clears a
 *       stuck IM owner (owner_im_id + sender_allowlist) and downgrades
 *       owner_mentioned → when_mentioned. Admin-only (members get 403).
 *
 *   ③b  PATCH /api/groups/:jid regression — the route used to rebuild the row
 *       from an explicit field list, and since setRegisteredGroup is
 *       INSERT OR REPLACE, a rename silently wiped owner_im_id / sender_allowlist
 *       / conversation_nav_mode / conversation_source. It now spreads ...existing.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

const SHARED_TMP =
  process.env.HAPPYCLAW_TEST_DATA_DIR ??
  (() => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-routes-groups-owner-'));
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
      permissions: [],
    });
    return next();
  },
}));

// groups.ts statically imports these from web.js; mock them so importing the
// route module doesn't pull in the full Hono app + every route's middleware.
vi.mock('../src/web.js', () => ({
  broadcastNewMessage: () => {},
  invalidateAllowedUserCache: () => {},
}));

const groupRoutesModule = await import('../src/routes/groups.js');
const db = await import('../src/db.js');
const webContext = await import('../src/web-context.js');

const groupRoutes = groupRoutesModule.default;

const OWNER_ID = 'alice';
const ADMIN_ID = 'zadmin';

function asUser(userId: string, role: 'admin' | 'member' = 'member'): void {
  process.env.HAPPYCLAW_TEST_USER_ID = userId;
  process.env.HAPPYCLAW_TEST_USER_ROLE = role;
}

// Persistent stub cache (see setWebDeps below) — stable across getRegisteredGroups() calls.
const webDepsCache: Record<string, unknown> = {};

beforeAll(() => {
  fs.mkdirSync(path.join(tmpDataDir, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmpDataDir, 'groups'), { recursive: true });
  db.initDatabase();
  // Routes guard on getWebDeps(); they only touch getRegisteredGroups().
  // Back the stub with a single persistent object (not a fresh {} per call) so
  // reset-owner's persistGroupUpdate cache-sync writes to a stable map, matching
  // production's `() => registeredGroups` and keeping cache state assertable.
  webContext.setWebDeps({
    getRegisteredGroups: () => webDepsCache,
  } as unknown as Parameters<typeof webContext.setWebDeps>[0]);
});

afterEach(() => {
  delete process.env.HAPPYCLAW_TEST_USER_ID;
  delete process.env.HAPPYCLAW_TEST_USER_ROLE;
});

describe('POST /:jid/reset-owner (admin break-glass)', () => {
  const JID = 'feishu:stuck-group';
  const FOLDER = 'stuck-group';

  beforeEach(() => {
    db.setRegisteredGroup(JID, {
      name: 'Stuck IM Group',
      folder: FOLDER,
      added_at: new Date().toISOString(),
      executionMode: 'container',
      created_by: ADMIN_ID,
      is_home: false,
      owner_im_id: 'ou_owner_who_left',
      sender_allowlist: ['ou_owner_who_left'],
      activation_mode: 'owner_mentioned',
    } as any);
  });

  afterEach(() => {
    try {
      db.deleteRegisteredGroup(JID);
    } catch {
      /* ignore */
    }
  });

  test('admin clears owner_im_id + allowlist and downgrades activation_mode', async () => {
    asUser(ADMIN_ID, 'admin');
    const res = await groupRoutes.request(
      `/${encodeURIComponent(JID)}/reset-owner`,
      { method: 'POST' },
    );
    expect(res.status).toBe(200);

    const after = db.getRegisteredGroup(JID);
    expect(after?.owner_im_id).toBeUndefined();
    expect(after?.sender_allowlist).toBeUndefined();
    expect(after?.activation_mode).toBe('when_mentioned');
  });

  test('non-admin member is denied (403)', async () => {
    asUser(OWNER_ID, 'member');
    const res = await groupRoutes.request(
      `/${encodeURIComponent(JID)}/reset-owner`,
      { method: 'POST' },
    );
    expect(res.status).toBe(403);

    // Owner must be untouched after a denied attempt.
    const after = db.getRegisteredGroup(JID);
    expect(after?.owner_im_id).toBe('ou_owner_who_left');
  });

  test('non-admin downgrade attempt does not change activation_mode', async () => {
    asUser(OWNER_ID, 'member');
    await groupRoutes.request(`/${encodeURIComponent(JID)}/reset-owner`, {
      method: 'POST',
    });
    expect(db.getRegisteredGroup(JID)?.activation_mode).toBe('owner_mentioned');
  });
});

describe('PATCH /:jid preserves owner fields on rename (regression)', () => {
  const JID = 'web:rename-me';
  const FOLDER = 'rename-me';

  beforeEach(() => {
    db.setRegisteredGroup(JID, {
      name: 'Original',
      folder: FOLDER,
      added_at: new Date().toISOString(),
      executionMode: 'container',
      created_by: OWNER_ID,
      is_home: false,
      owner_im_id: 'keep-this-owner',
      sender_allowlist: ['keep-this-owner'],
      conversation_nav_mode: 'vertical_threads',
    } as any);
  });

  afterEach(() => {
    try {
      db.deleteRegisteredGroup(JID);
    } catch {
      /* ignore */
    }
  });

  test('renaming a web group keeps owner_im_id / allowlist / nav_mode', async () => {
    asUser(OWNER_ID, 'member');
    const res = await groupRoutes.request(`/${encodeURIComponent(JID)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed' }),
    });
    expect(res.status).toBe(200);

    const after = db.getRegisteredGroup(JID);
    expect(after?.name).toBe('Renamed');
    expect(after?.owner_im_id).toBe('keep-this-owner');
    expect(after?.sender_allowlist).toEqual(['keep-this-owner']);
    expect(after?.conversation_nav_mode).toBe('vertical_threads');
  });
});
