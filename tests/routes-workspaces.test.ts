import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-workspaces-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...actual,
    DATA_DIR: tmpDir,
    STORE_DIR: tmpStoreDir,
    GROUPS_DIR: tmpGroupsDir,
  };
});

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: process.env.HAPPYCLAW_TEST_USER_ID ?? 'routes-workspace-owner',
      username: process.env.HAPPYCLAW_TEST_USER_ID ?? 'routes-workspace-owner',
      role: process.env.HAPPYCLAW_TEST_USER_ROLE ?? 'member',
      permissions: [],
    });
    return next();
  },
}));

const db = await import('../src/db.js');
const routeModule = await import('../src/routes/workspaces.js');
const routes = routeModule.default;

const OWNER_ID = 'routes-workspace-owner';
const STRANGER_ID = 'routes-workspace-stranger';
const OTHER_OWNER_ID = 'routes-workspace-other-owner';

function asUser(userId: string, role: 'admin' | 'member' = 'member'): void {
  process.env.HAPPYCLAW_TEST_USER_ID = userId;
  process.env.HAPPYCLAW_TEST_USER_ROLE = role;
}

function createUser(id: string): void {
  const now = new Date().toISOString();
  db.createUser({
    id,
    username: id,
    password_hash: 'hash',
    display_name: id,
    role: 'member',
    status: 'active',
    created_at: now,
    updated_at: now,
    must_change_password: false,
  });
}

beforeAll(() => {
  db.initDatabase();
  for (const id of [OWNER_ID, STRANGER_ID, OTHER_OWNER_ID]) {
    createUser(id);
  }
});

afterEach(() => {
  delete process.env.HAPPYCLAW_TEST_USER_ID;
  delete process.env.HAPPYCLAW_TEST_USER_ROLE;
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('/api/workspaces canonical read routes', () => {
  test('owner can list workspace summaries and inspect sessions plus mounts', async () => {
    const profile = db.createAgentProfile({
      ownerUserId: OWNER_ID,
      name: 'Canonical Agent',
      identityPrompt: 'Operate from canonical workspace state.',
    });
    db.setRegisteredGroup('web:canonical-owned', {
      name: 'Canonical Owned',
      folder: 'canonical-owned',
      added_at: '2026-07-09T00:00:00.000Z',
      created_by: OWNER_ID,
      is_home: false,
    });
    db.assignWorkspaceAgentProfile('canonical-owned', profile.id);
    db.setSession('canonical-owned', 'claude-canonical-main', '', {
      agentProfileId: profile.id,
      agentProfileVersion: profile.version,
      identityHash: profile.identity_hash,
    });
    db.setRegisteredGroup('telegram:canonical-owned-chat', {
      name: 'Canonical Telegram',
      folder: 'owner-home',
      added_at: '2026-07-09T00:00:00.000Z',
      created_by: OWNER_ID,
      target_main_jid: 'web:canonical-owned',
      reply_policy: 'mirror',
    });

    asUser(OWNER_ID);
    const listRes = await routes.request('/', { method: 'GET' });
    expect(listRes.status).toBe(200);
    const listBody = await listRes.json();
    expect(listBody.workspaces).toContainEqual(
      expect.objectContaining({
        jid: 'web:canonical-owned',
        folder: 'canonical-owned',
        owner_user_id: OWNER_ID,
        runtime_session_count: 1,
        channel_mount_count: 1,
        agent_profile: expect.objectContaining({
          id: profile.id,
          version: profile.version,
        }),
      }),
    );

    const detailRes = await routes.request('/web:canonical-owned', {
      method: 'GET',
    });
    expect(detailRes.status).toBe(200);
    const detailBody = await detailRes.json();
    expect(detailBody.runtime_sessions).toEqual([
      expect.objectContaining({
        runtime_agent_id: '',
        sdk_session_id: 'claude-canonical-main',
        agent_profile_id: profile.id,
        agent_profile_version: profile.version,
      }),
    ]);
    expect(detailBody.channel_mounts).toEqual([
      expect.objectContaining({
        channel_jid: 'telegram:canonical-owned-chat',
        workspace_jid: 'web:canonical-owned',
        workspace_folder: 'canonical-owned',
        session_id: null,
        routing_mode: 'single_session',
        reply_policy: 'mirror',
        agent_profile_id: profile.id,
      }),
    ]);
  });

  test('non-owners cannot list or inspect another account workspace', async () => {
    asUser(STRANGER_ID);
    const strangerListRes = await routes.request('/', { method: 'GET' });
    const strangerListBody = await strangerListRes.json();
    expect(strangerListBody.workspaces).not.toContainEqual(
      expect.objectContaining({ jid: 'web:canonical-owned' }),
    );
    const strangerDetailRes = await routes.request('/web:canonical-owned', {
      method: 'GET',
    });
    expect(strangerDetailRes.status).toBe(404);
  });

  test('mount listing is filtered by visible workspaces', async () => {
    db.setRegisteredGroup('web:canonical-other', {
      name: 'Other Owner Workspace',
      folder: 'canonical-other',
      added_at: '2026-07-09T00:00:00.000Z',
      created_by: OTHER_OWNER_ID,
      is_home: false,
    });
    db.setRegisteredGroup('telegram:canonical-other-chat', {
      name: 'Other Telegram',
      folder: 'other-home',
      added_at: '2026-07-09T00:00:00.000Z',
      created_by: OTHER_OWNER_ID,
      target_main_jid: 'web:canonical-other',
    });

    asUser(OWNER_ID);
    const res = await routes.request('/mounts', { method: 'GET' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.channel_mounts).toContainEqual(
      expect.objectContaining({
        channel_jid: 'telegram:canonical-owned-chat',
        workspace_jid: 'web:canonical-owned',
      }),
    );
    expect(body.channel_mounts).not.toContainEqual(
      expect.objectContaining({
        channel_jid: 'telegram:canonical-other-chat',
      }),
    );
  });

  test('a legacy cross-owner binding never exposes the foreign Agent policy', async () => {
    const foreignProfile = db.createAgentProfile({
      ownerUserId: OTHER_OWNER_ID,
      name: 'Private Agent of another owner',
      runtimePolicy: {
        skills: { mode: 'custom', ids: ['private-owner-skill'] },
      },
    });
    const jid = 'web:legacy-foreign-profile';
    const folder = 'legacy-foreign-profile';
    db.setRegisteredGroup(jid, {
      name: 'Workspace with an invalid legacy binding',
      folder,
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
    });
    db.assignWorkspaceAgentProfile(
      folder,
      db.getOrCreateDefaultAgentProfile(OWNER_ID).id,
    );
    // Simulate pre-validation persisted data, independently of the current
    // assignment API's write guard. A read must not disclose another owner.
    const legacyDb = new Database(path.join(tmpStoreDir, 'messages.db'));
    try {
      legacyDb
        .prepare(
          'UPDATE workspace_agent_profiles SET agent_profile_id = ? WHERE group_folder = ?',
        )
        .run(foreignProfile.id, folder);
    } finally {
      legacyDb.close();
    }

    asUser(OWNER_ID);
    const detail = await routes.request(`/${jid}`);
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    expect(detailBody.workspace.agent_profile).toBeNull();
    const list = await routes.request('/');
    const listBody = await list.json();
    expect(listBody.workspaces).toContainEqual(
      expect.objectContaining({ jid, agent_profile: null }),
    );
    for (const body of [detailBody, listBody]) {
      expect(JSON.stringify(body)).not.toContain(foreignProfile.name);
      expect(JSON.stringify(body)).not.toContain('private-owner-skill');
    }
    // Reporting a broken binding must not silently reassign the workspace.
    expect(db.getWorkspaceAgentProfileId(folder)).toBe(foreignProfile.id);
  });
});
