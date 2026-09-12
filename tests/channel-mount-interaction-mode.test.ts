import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mount-interaction-mode-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });
vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: root,
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
let userId = 'mount-owner';
vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: userId,
      username: userId,
      role: 'member',
      permissions: [],
    });
    await next();
  },
}));
const db = await import('../src/db.js');
const { setWebDeps } = await import('../src/web-context.js');
const routes = (await import('../src/routes/workspaces.js')).default;
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
const workspaceJid = 'web:mount-workspace';
const folder = 'mount-workspace';
let ordinal = 0;
function addMount(): string {
  const jid = `feishu:mount-${++ordinal}`;
  db.setRegisteredGroup(jid, {
    name: jid,
    folder,
    created_by: 'mount-owner',
    added_at: new Date().toISOString(),
    target_main_jid: workspaceJid,
  });
  return jid;
}
function patch(jid: string, mode: unknown, workspace = workspaceJid) {
  return routes.request(
    `/${encodeURIComponent(workspace)}/channel-mounts/${encodeURIComponent(jid)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ interaction_mode_override: mode }),
    },
  );
}
beforeAll(() => {
  db.initDatabase();
  const now = new Date().toISOString();
  for (const id of ['mount-owner', 'mount-stranger'])
    db.createUser({
      id,
      username: id,
      password_hash: 'hash',
      display_name: id,
      role: 'member',
      status: 'active',
      must_change_password: false,
      created_at: now,
      updated_at: now,
    });
  const profile = db.getOrCreateDefaultAgentProfile('mount-owner');
  db.setRegisteredGroup(workspaceJid, {
    name: 'Shared workspace',
    folder,
    created_by: 'mount-owner',
    added_at: now,
  });
  db.assignWorkspaceAgentProfile(folder, profile.id, 'proactive');
  db.setSession(folder, 'sdk-history-preserved');
  db.ensureChatExists(workspaceJid);
  db.storeMessageDirect(
    'history-before-override',
    workspaceJid,
    'owner',
    'Owner',
    'Keep this conversation',
    now,
    false,
  );
  setWebDeps({
    queue,
    sessions: { [folder]: 'sdk-history-preserved' },
    getRegisteredGroups: () => db.getAllRegisteredGroups(),
  } as any);
});
afterEach(() => {
  userId = 'mount-owner';
  vi.clearAllMocks();
  stopGroup.mockReset().mockResolvedValue(undefined);
  queue.isGroupRuntimeSafetyBlocked.mockReset().mockReturnValue(false);
});
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('mount-specific interaction mode', () => {
  test('owner changes only one mount, preserving bindings, history and SDK resume rows', async () => {
    const target = addMount();
    const sibling = addMount();
    const before = db.getChannelMount(target)!;
    const result = await patch(target, 'assistant');
    expect(result.status).toBe(200);
    expect((await result.json()).channel_mount).toMatchObject({
      interaction_mode_override: 'assistant',
      interaction_mode: 'assistant',
    });
    expect(db.getChannelMount(target)).toMatchObject({
      ...before,
      interaction_mode_override: 'assistant',
      updated_at: expect.any(String),
    });
    expect(db.getChannelMountInteractionModeOverride(sibling)).toBe(null);
    expect(db.getWorkspaceInteractionMode(folder)).toBe('proactive');
    expect(db.getSession(folder)).toBe('sdk-history-preserved');
    expect(
      db
        .getMessagesPage(workspaceJid)
        .find((message) => message.id === 'history-before-override')?.content,
    ).toBe('Keep this conversation');
    expect(queue.pauseGroupsForMutation).toHaveBeenCalledOnce();
    expect(queue.resumeGroupsAfterMutation).toHaveBeenCalledOnce();
    expect(stopGroup).toHaveBeenCalledWith(workspaceJid, {
      force: true,
      preserveQueuedWork: true,
    });
    const read = await routes.request(`/${workspaceJid}/channel-mounts`);
    expect((await read.json()).channel_mounts).toContainEqual(
      expect.objectContaining({
        channel_jid: target,
        interaction_mode_override: 'assistant',
      }),
    );
  });

  test('null resumes inheritance and an identical request is idempotent', async () => {
    const target = addMount();
    await patch(target, 'assistant');
    queue.pauseGroupsForMutation.mockClear();
    expect((await patch(target, 'assistant')).status).toBe(200);
    expect(queue.pauseGroupsForMutation).not.toHaveBeenCalled();
    const response = await patch(target, null);
    expect(response.status).toBe(200);
    expect((await response.json()).channel_mount).toMatchObject({
      interaction_mode_override: null,
      interaction_mode: 'proactive',
    });
  });

  test('unrelated users and wrong workspace paths cannot mutate a mount', async () => {
    const target = addMount();
    userId = 'mount-stranger';
    expect((await patch(target, 'assistant')).status).toBe(404);
    userId = 'mount-owner';
    expect(
      (await patch(target, 'assistant', 'web:another-workspace')).status,
    ).toBe(404);
    expect(db.getChannelMountInteractionModeOverride(target)).toBe(null);
    expect(stopGroup).not.toHaveBeenCalled();
  });

  test.each(['persona', 'invalid', 1, undefined])(
    'rejects invalid override %s',
    async (mode) => {
      expect((await patch(addMount(), mode)).status).toBe(400);
      expect(stopGroup).not.toHaveBeenCalled();
    },
  );

  test('failed pre-commit quiesce leaves the setting untouched and resumes queued work', async () => {
    const target = addMount();
    stopGroup.mockRejectedValueOnce(new Error('cannot stop'));
    const response = await patch(target, 'assistant');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      persisted: false,
      retryable: true,
    });
    expect(db.getChannelMountInteractionModeOverride(target)).toBe(null);
    expect(queue.resumeGroupsAfterMutation).toHaveBeenCalledOnce();
  });

  test('an ownership transfer while stopping the runner cannot grant the previous owner a write', async () => {
    const target = addMount();
    stopGroup.mockImplementationOnce(async () => {
      db.setRegisteredGroup(target, {
        ...db.getRegisteredGroup(target)!,
        created_by: 'mount-stranger',
      });
    });
    const response = await patch(target, 'assistant');
    expect(response.status).toBe(409);
    expect(db.getChannelMountInteractionModeOverride(target)).toBe(null);
    expect(queue.resumeGroupsAfterMutation).toHaveBeenCalledOnce();
  });

  test('post-commit failure blocks runtime admission and a same-value retry cleans up', async () => {
    const target = addMount();
    // Identify the second pass by the database commit, independent of how many
    // sibling routes share this workspace.
    stopGroup.mockImplementation(async () => {
      if (db.getChannelMountInteractionModeOverride(target) === 'assistant')
        throw new Error('cleanup failed');
    });
    const response = await patch(target, 'assistant');
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ persisted: true });
    expect(queue.blockGroupsForRuntimeSafety).toHaveBeenCalled();
    stopGroup.mockResolvedValue(undefined);
    queue.isGroupRuntimeSafetyBlocked.mockReturnValue(true);
    expect((await patch(target, 'assistant')).status).toBe(200);
    expect(queue.unblockGroupsForRuntimeSafety).toHaveBeenCalled();
  });

  test('projection refresh, rename and restart preserve overrides on the same binding', () => {
    const target = addMount();
    db.setChannelMountInteractionModeOverride(
      target,
      workspaceJid,
      'assistant',
    );
    db.setRegisteredGroup(target, {
      ...db.getRegisteredGroup(target)!,
      name: 'Renamed',
    });
    db.syncAllChannelMountsFromRegisteredGroups();
    expect(db.getChannelMountInteractionModeOverride(target)).toBe('assistant');
    expect(db.getAgentChannelMount(target)?.interaction_mode_override).toBe(
      'assistant',
    );
    db.closeDatabase();
    db.initDatabase();
    expect(db.getChannelMountInteractionModeOverride(target)).toBe('assistant');
    expect(db.getAgentChannelMount(target)?.interaction_mode_override).toBe(
      'assistant',
    );
  });

  test('rebinding starts with the destination default rather than carrying an old override', () => {
    const target = addMount();
    db.setChannelMountInteractionModeOverride(
      target,
      workspaceJid,
      'assistant',
    );
    db.setRegisteredGroup('web:destination', {
      name: 'Destination',
      folder: 'destination',
      created_by: 'mount-owner',
      added_at: new Date().toISOString(),
    });
    db.setRegisteredGroup(target, {
      ...db.getRegisteredGroup(target)!,
      target_main_jid: 'web:destination',
    });
    expect(db.getChannelMountInteractionModeOverride(target)).toBe(null);
  });

  test('SDK interaction metadata follows exact session scope and survives resume ID updates', () => {
    db.setSession(folder, 'sdk-main');
    db.setSessionInteractionMode(folder, null, 'proactive');
    db.setSession(folder, 'sdk-agent', 'agent-scope');
    db.setSessionInteractionMode(folder, 'agent-scope', 'assistant');
    db.setSession(folder, 'sdk-agent-next', 'agent-scope');
    expect(db.getSessionInteractionMode(folder)).toBe('proactive');
    expect(db.getSessionInteractionMode(folder, 'agent-scope')).toBe(
      'assistant',
    );
    db.setSessionInteractionMode(folder, 'missing', 'assistant');
    expect(db.getSession(folder, 'missing')).toBeUndefined();
    db.deleteSession(folder, 'agent-scope');
    expect(db.getSessionInteractionMode(folder, 'agent-scope')).toBe(null);
  });

  test('schema 74 migration adds nullable columns without altering legacy bindings or history', () => {
    const target = addMount();
    db.closeDatabase();
    const legacy = new Database(path.join(storeDir, 'messages.db'));
    legacy.exec(
      'ALTER TABLE channel_mounts DROP COLUMN interaction_mode_override; ALTER TABLE agent_channel_mounts DROP COLUMN interaction_mode_override; ALTER TABLE sessions DROP COLUMN interaction_mode;',
    );
    legacy
      .prepare(
        "UPDATE router_state SET value = '74' WHERE key = 'schema_version'",
      )
      .run();
    legacy.close();
    const previous = process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
    process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
    try {
      db.initDatabase();
    } finally {
      if (previous === undefined)
        delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
      else process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = previous;
    }
    expect(db.getRouterState('schema_version')).toBe('75');
    expect(db.getChannelMount(target)?.workspace_jid).toBe(workspaceJid);
    expect(db.getChannelMountInteractionModeOverride(target)).toBe(null);
    expect(db.getWorkspaceInteractionMode(folder)).toBe('proactive');
    expect(
      db
        .getMessagesPage(workspaceJid)
        .find((message) => message.id === 'history-before-override')?.content,
    ).toBe('Keep this conversation');
  });
});
