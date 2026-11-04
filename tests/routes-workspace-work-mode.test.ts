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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-work-mode-'));
const dataDir = path.join(root, 'data');
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
for (const dir of [dataDir, storeDir, groupsDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: dataDir,
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
  isDockerAvailable: vi.fn(async () => true),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    const id = process.env.HAPPYCLAW_WORK_MODE_TEST_USER ?? 'work-mode-owner';
    c.set('user', { id, username: id, role: 'member', permissions: [] });
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

const OWNER_ID = 'work-mode-owner';
const STRANGER_ID = 'work-mode-stranger';
const registeredGroups: Record<string, any> = {};
const queue = {
  pauseGroupsForMutation: vi.fn(() => ({ id: 1 })),
  resumeGroupsAfterMutation: vi.fn(),
  listDescendantJids: vi.fn((jid: string) => [`${jid}#agent:s1`]),
  stopGroup: vi.fn(async () => {}),
  retireRunnerAfterQuery: vi.fn(() => true),
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
  process.env.HAPPYCLAW_WORK_MODE_TEST_USER = id;
}

function workspace(jid: string, folder: string): void {
  db.setRegisteredGroup(jid, {
    name: folder,
    folder,
    added_at: new Date().toISOString(),
    created_by: OWNER_ID,
    executionMode: 'container',
  });
  registeredGroups[jid] = db.getRegisteredGroup(jid);
  db.assignWorkspaceAgentProfile(
    folder,
    db.getOrCreateDefaultAgentProfile(OWNER_ID).id,
  );
}

function patch(jid: string, body: Record<string, unknown>) {
  return groupRoutes.request(`/${encodeURIComponent(jid)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeAll(() => {
  db.initDatabase();
  createUser(OWNER_ID);
  createUser(STRANGER_ID);
  webContext.setWebDeps({
    queue,
    getRegisteredGroups: () => registeredGroups,
    ensureTerminalContainerStarted: vi.fn(() => true),
  } as unknown as Parameters<typeof webContext.setWebDeps>[0]);
});

afterEach(() => {
  delete process.env.HAPPYCLAW_WORK_MODE_TEST_USER;
  vi.clearAllMocks();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('workspace work_mode API', () => {
  test('creation defaults to single and accepts multi; every view serializes it', async () => {
    asUser(OWNER_ID);
    const create = async (body: Record<string, unknown>) => {
      const response = await groupRoutes.request('/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ execution_mode: 'container', ...body }),
      });
      expect(response.status).toBe(200);
      return response.json();
    };
    const single = await create({ name: 'Single' });
    const multi = await create({ name: 'Multi', work_mode: 'multi' });
    expect(single.group.work_mode).toBe('single');
    expect(multi.group.work_mode).toBe('multi');
    expect(db.getWorkspaceWorkMode(single.group.folder)).toBe('single');
    expect(db.getWorkspaceWorkMode(multi.group.folder)).toBe('multi');

    const list = await (
      await groupRoutes.request('/', { method: 'GET' })
    ).json();
    expect(list.groups[single.jid].work_mode).toBe('single');
    expect(list.groups[multi.jid].work_mode).toBe('multi');

    const detail = await workspaceRoutes.request(
      `/${encodeURIComponent(multi.jid)}`,
      { method: 'GET' },
    );
    await expect(detail.json()).resolves.toMatchObject({
      workspace: { jid: multi.jid, work_mode: 'multi' },
    });

    const invalid = await groupRoutes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bad', work_mode: 'many' }),
    });
    expect(invalid.status).toBe(400);
  });

  test('PATCH switches it without stopping anything: warm runners retire after their turn', async () => {
    const jid = 'web:work-mode-switch';
    workspace(jid, 'work-mode-switch');
    db.setSession('work-mode-switch', 'sdk-session', 's1');

    asUser(OWNER_ID);
    const response = await patch(jid, { work_mode: 'multi' });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      work_mode: 'multi',
    });
    expect(db.getWorkspaceWorkMode('work-mode-switch')).toBe('multi');
    expect(queue.retireRunnerAfterQuery).toHaveBeenCalledWith(
      `${jid}#agent:s1`,
    );
    expect(queue.stopGroup).not.toHaveBeenCalled();
    // The SDK session is kept: only the next runner's tools change.
    expect(db.getSession('work-mode-switch', 's1')).toBe('sdk-session');

    // The same value again retires nothing.
    queue.retireRunnerAfterQuery.mockClear();
    expect((await patch(jid, { work_mode: 'multi' })).status).toBe(200);
    expect(queue.retireRunnerAfterQuery).not.toHaveBeenCalled();

    expect((await patch(jid, { work_mode: 'bogus' })).status).toBe(400);
  });

  test('same permissions as interaction_mode', async () => {
    const jid = 'web:work-mode-acl';
    workspace(jid, 'work-mode-acl');
    asUser(STRANGER_ID);
    expect((await patch(jid, { work_mode: 'multi' })).status).toBe(404);
    expect(db.getWorkspaceWorkMode('work-mode-acl')).toBe('single');

    // An IM chat is not a workspace with a work mode.
    asUser(OWNER_ID);
    const chat = 'feishu:oc_work_mode';
    db.setRegisteredGroup(chat, {
      name: 'chat',
      folder: 'work-mode-acl',
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
    });
    expect((await patch(chat, { work_mode: 'multi' })).status).toBe(403);

    // A workspace without an Agent binding cannot store it.
    const unbound = 'web:work-mode-unbound';
    db.setRegisteredGroup(unbound, {
      name: 'unbound',
      folder: 'work-mode-unbound',
      added_at: new Date().toISOString(),
      created_by: OWNER_ID,
      executionMode: 'container',
    });
    registeredGroups[unbound] = db.getRegisteredGroup(unbound);
    const refused = await patch(unbound, { work_mode: 'multi' });
    expect(refused.status).toBe(409);
    await expect(refused.json()).resolves.toMatchObject({
      code: 'WORKSPACE_AGENT_PROFILE_MISSING',
    });
  });
});
