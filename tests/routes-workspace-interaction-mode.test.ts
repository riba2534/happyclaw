import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'routes-workspace-interaction-mode-'),
);
const dataDir = path.join(root, 'data');
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    DATA_DIR: dataDir,
    STORE_DIR: storeDir,
    GROUPS_DIR: groupsDir,
    isDockerAvailable: vi.fn(async () => true),
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    const id =
      process.env.HAPPYCLAW_INTERACTION_TEST_USER ?? 'interaction-owner';
    c.set('user', {
      id,
      username: id,
      role: 'member',
      permissions: [],
    });
    return next();
  },
}));
vi.mock('../src/web.js', () => ({
  broadcastNewMessage: vi.fn(),
  invalidateAllowedUserCache: vi.fn(),
}));

const db = await import('../src/db.js');
const webContext = await import('../src/web-context.js');
const groupRoutes = (await import('../src/routes/groups.js')).default;
const workspaceRoutes = (await import('../src/routes/workspaces.js')).default;

const OWNER_ID = 'interaction-owner';
const STRANGER_ID = 'interaction-stranger';
const registeredGroups: Record<string, any> = {};
const sessions: Record<string, string> = {};
const stopGroup = vi.fn(async () => {});
const queue = {
  pauseGroupsForMutation: vi.fn(() => ({ id: 1 })),
  resumeGroupsAfterMutation: vi.fn(),
  listDescendantJids: vi.fn(() => []),
  stopGroup,
  isGroupRuntimeSafetyBlocked: vi.fn(() => false),
  blockGroupsForRuntimeSafety: vi.fn(),
  unblockGroupsForRuntimeSafety: vi.fn(),
};

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

function asUser(id: string): void {
  process.env.HAPPYCLAW_INTERACTION_TEST_USER = id;
}

beforeAll(() => {
  db.initDatabase();
  createUser(OWNER_ID);
  createUser(STRANGER_ID);
  webContext.setWebDeps({
    queue,
    sessions,
    getRegisteredGroups: () => registeredGroups,
    ensureTerminalContainerStarted: vi.fn(() => true),
  } as unknown as Parameters<typeof webContext.setWebDeps>[0]);
});

afterEach(() => {
  delete process.env.HAPPYCLAW_INTERACTION_TEST_USER;
  vi.clearAllMocks();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('workspace interaction_mode API', () => {
  test('creation persists proactive and groups/workspaces serialize it', async () => {
    asUser(OWNER_ID);
    const profile = db.getOrCreateDefaultAgentProfile(OWNER_ID);
    const createResponse = await groupRoutes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Proactive Workspace',
        agent_profile_id: profile.id,
        execution_mode: 'container',
        interaction_mode: 'proactive',
      }),
    });
    expect(createResponse.status).toBe(200);
    const created = await createResponse.json();
    expect(created.group.interaction_mode).toBe('proactive');
    expect(
      db.getWorkspaceAgentProfileBinding(created.group.folder),
    ).toMatchObject({
      agent_profile_id: profile.id,
      interaction_mode: 'proactive',
    });

    const groupList = await groupRoutes.request('/', { method: 'GET' });
    const groupListBody = await groupList.json();
    expect(groupListBody.groups[created.jid]).toMatchObject({
      interaction_mode: 'proactive',
      agent_profile_id: profile.id,
    });

    const workspaceDetail = await workspaceRoutes.request(
      `/${encodeURIComponent(created.jid)}`,
      { method: 'GET' },
    );
    expect(workspaceDetail.status).toBe(200);
    await expect(workspaceDetail.json()).resolves.toMatchObject({
      workspace: {
        jid: created.jid,
        interaction_mode: 'proactive',
      },
    });
  });

  test('normalizes the legacy persona API value to proactive', async () => {
    asUser(OWNER_ID);
    const profile = db.getOrCreateDefaultAgentProfile(OWNER_ID);
    const response = await groupRoutes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Legacy Reply Mode Input',
        agent_profile_id: profile.id,
        interaction_mode: 'persona',
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      group: { interaction_mode: 'proactive' },
    });
  });

  test('owner mode change quiesces around commit and invalidates sessions', async () => {
    const jid = 'web:interaction-mode-switch';
    const folder = 'interaction-mode-switch';
    const profile = db.getOrCreateDefaultAgentProfile(OWNER_ID);
    db.setRegisteredGroup(jid, {
      name: 'Interaction Mode Switch',
      folder,
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
      executionMode: 'container',
    });
    registeredGroups[jid] = db.getRegisteredGroup(jid);
    db.assignWorkspaceAgentProfile(folder, profile.id, 'assistant');
    db.setSession(folder, 'sdk-session-before-proactive');
    sessions[folder] = 'sdk-session-before-proactive';

    stopGroup.mockImplementationOnce(async () => {
      expect(db.getWorkspaceInteractionMode(folder)).toBe('assistant');
    });
    stopGroup.mockImplementationOnce(async () => {
      expect(db.getWorkspaceInteractionMode(folder)).toBe('proactive');
    });

    asUser(OWNER_ID);
    const response = await groupRoutes.request(`/${encodeURIComponent(jid)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ interaction_mode: 'proactive' }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      interaction_mode: 'proactive',
    });
    expect(stopGroup).toHaveBeenCalledTimes(2);
    expect(db.getWorkspaceInteractionMode(folder)).toBe('proactive');
    expect(db.getSession(folder)).toBeUndefined();
    expect(sessions[folder]).toBeUndefined();
  });

  test('non-owner cannot change mode and AgentProfile switch preserves it', async () => {
    const jid = 'web:interaction-profile-switch';
    const folder = 'interaction-profile-switch';
    const first = db.getOrCreateDefaultAgentProfile(OWNER_ID);
    const second = db.createAgentProfile({
      ownerUserId: OWNER_ID,
      name: 'Second Agent',
      identityPrompt: 'Second identity',
    });
    db.setRegisteredGroup(jid, {
      name: 'Profile Switch',
      folder,
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
      executionMode: 'container',
    });
    registeredGroups[jid] = db.getRegisteredGroup(jid);
    db.assignWorkspaceAgentProfile(folder, first.id, 'proactive');

    asUser(STRANGER_ID);
    const denied = await groupRoutes.request(`/${encodeURIComponent(jid)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ interaction_mode: 'assistant' }),
    });
    expect(denied.status).toBe(404);
    expect(db.getWorkspaceInteractionMode(folder)).toBe('proactive');

    asUser(OWNER_ID);
    const switched = await groupRoutes.request(
      `/${encodeURIComponent(jid)}/agent-profile`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agent_profile_id: second.id }),
      },
    );
    expect(switched.status).toBe(200);
    await expect(switched.json()).resolves.toMatchObject({
      agent_profile_id: second.id,
      interaction_mode: 'proactive',
    });
    expect(db.getWorkspaceAgentProfileBinding(folder)).toMatchObject({
      agent_profile_id: second.id,
      interaction_mode: 'proactive',
    });
  });
});
