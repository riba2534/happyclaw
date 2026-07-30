import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-workspace-rebuild-memory-'),
);
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    STORE_DIR: storeDir,
    GROUPS_DIR: groupsDir,
    DATA_DIR: root,
    isDockerAvailable: () => false,
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: 'alice',
      username: 'alice',
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
const { cancelTaskRunNow } = await import('../src/task-scheduler.js');
const memoryStore = await import('../src/memory-store.js');
const ownerProfile = await import('../src/owner-profile-store.js');
const webContext = await import('../src/web-context.js');
const groupRoutes = (await import('../src/routes/groups.js')).default;

const JID = 'web:rebuild-memory';
const FOLDER = 'rebuild-memory';
const stopGroup = vi.fn(async () => {});
const pauseToken = { id: 1 };
const pauseGroupsForMutation = vi.fn(() => pauseToken);
const resumeGroupsAfterMutation = vi.fn();
const cancelTaskRun = vi.fn((runId: string) => cancelTaskRunNow(runId));
const waitForTaskRunsToStop = vi.fn(async () => true);
const sessions: Record<string, unknown> = {};

beforeAll(() => {
  db.initDatabase();
});

beforeEach(() => {
  vi.clearAllMocks();
  stopGroup.mockResolvedValue(undefined);
  waitForTaskRunsToStop.mockResolvedValue(true);
  webContext.setWebDeps({
    getRegisteredGroups: () => db.getAllRegisteredGroups(),
    getSessions: () => sessions,
    setLastAgentTimestamp: vi.fn(),
    queue: {
      listDescendantJids: () => [],
      stopGroup,
      pauseGroupsForMutation,
      resumeGroupsAfterMutation,
    },
    cancelTaskRun,
    waitForTaskRunsToStop,
  } as unknown as Parameters<typeof webContext.setWebDeps>[0]);
});

afterAll(() => {
  try {
    db.deleteRegisteredGroup(JID);
  } catch {
    // absent
  }
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('POST /:jid/clear-history workspace rebuild', () => {
  test('replaces Workspace Memory and Home Owner Profile with a clean slate', async () => {
    db.setRegisteredGroup(JID, {
      name: 'Rebuild Memory',
      folder: FOLDER,
      added_at: new Date().toISOString(),
      executionMode: 'container',
      created_by: 'alice',
      is_home: true,
    });

    const context = {
      actorId: 'alice',
      sourceType: 'web_user' as const,
      sourceId: 'message-before-rebuild',
      sessionId: 'session-before-rebuild',
    };
    const active = memoryStore.createWorkspaceMemoryItem({
      workspaceJid: JID,
      value: {
        kind: 'fact',
        title: 'Old fact',
        content: 'This Memory must not survive a workspace rebuild.',
      },
      context,
    });
    const forgotten = memoryStore.createWorkspaceMemoryItem({
      workspaceJid: JID,
      value: {
        kind: 'open_loop',
        title: 'Old tombstone',
        content: 'This forgotten Memory lineage must also be removed.',
      },
      context,
    });
    memoryStore.forgetWorkspaceMemoryItem({
      workspaceJid: JID,
      itemId: forgotten.item.id,
      expectedRevision: 1,
      reason: 'Prepare a tombstone for the regression test',
      context,
    });
    ownerProfile.setHappyClawOwnerPreferredAddress({
      workspaceJid: JID,
      preferredAddress: '小何',
      expectedRevision: 0,
      context,
    });

    const oldStore = memoryStore.getWorkspaceMemoryStore(JID);
    expect(oldStore?.revision).toBeGreaterThan(0);
    expect(ownerProfile.getHappyClawOwnerProfileProjection(JID)).toMatchObject({
      preferredAddress: '小何',
      onboarding: { state: 'completed' },
    });

    const taskNextRun = new Date(Date.now() + 60_000).toISOString();
    db.createTask({
      id: 'rebuild-memory-task',
      group_folder: FOLDER,
      chat_jid: JID,
      prompt: 'This task must move to the recycle bin.',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      context_mode: 'group',
      execution_type: 'agent',
      execution_mode: 'container',
      script_command: null,
      next_run: taskNextRun,
      status: 'active',
      created_at: new Date().toISOString(),
      created_by: 'alice',
      notify_channels: null,
    });
    const task = db.getTaskById('rebuild-memory-task')!;
    const activeRun = db.createTaskRun({
      task,
      triggerType: 'manual',
      idempotencyKey: 'rebuild-active-run',
    }).run;
    const activeClaim = db.claimNextTaskRun(
      'rebuild-delivered-worker',
      60_000,
    )!;
    expect(activeClaim.id).toBe(activeRun.id);
    expect(
      db.markTaskRunExecutionStarted(
        activeClaim.id,
        activeClaim.lease_owner,
        activeClaim.lease_token,
      ),
    ).toBe(true);
    expect(
      db.completeTaskRun(
        activeClaim.id,
        activeClaim.lease_owner,
        activeClaim.lease_token,
        {
          status: 'delivered',
          result: '已排队到源工作区，等待智能体执行',
          notificationStatus: 'skipped',
        },
      ),
    ).toBe(true);

    const workspaceDir = path.join(groupsDir, FOLDER);
    const legacyMemoryDir = path.join(root, 'memory', FOLDER);
    const persistentDir = path.join(root, 'extra');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(legacyMemoryDir, { recursive: true });
    fs.mkdirSync(persistentDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'old-file.txt'), 'delete me');
    fs.writeFileSync(path.join(legacyMemoryDir, 'old-memory.md'), 'delete me');
    fs.writeFileSync(path.join(persistentDir, 'keep.txt'), 'keep me');

    const response = await groupRoutes.request(
      `/${encodeURIComponent(JID)}/clear-history`,
      { method: 'POST' },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });
    expect(pauseGroupsForMutation).toHaveBeenCalledWith([JID]);
    expect(pauseGroupsForMutation.mock.invocationCallOrder[0]).toBeLessThan(
      stopGroup.mock.invocationCallOrder[0],
    );
    expect(stopGroup).toHaveBeenCalledWith(JID, { force: true });
    expect(cancelTaskRun).toHaveBeenCalledWith(activeRun.id);
    expect(waitForTaskRunsToStop).toHaveBeenCalledWith([activeRun.id]);
    expect(resumeGroupsAfterMutation).toHaveBeenCalledWith(pauseToken);
    expect(db.getRegisteredGroup(JID)).toBeDefined();

    const newStore = memoryStore.getWorkspaceMemoryStore(JID);
    expect(newStore).toMatchObject({ workspaceJid: JID, revision: 0 });
    expect(newStore?.id).not.toBe(oldStore?.id);
    expect(
      memoryStore.listWorkspaceMemoryItems({
        workspaceJid: JID,
        limit: 100,
      }).items,
    ).toEqual([]);
    expect(() =>
      memoryStore.getWorkspaceMemoryItem(JID, active.item.id),
    ).toThrowError(
      expect.objectContaining({
        code: 'item_not_found',
      }),
    );
    expect(ownerProfile.getHappyClawOwnerProfileProjection(JID)).toMatchObject({
      preferredAddress: null,
      revision: null,
      onboarding: {
        state: 'pending',
        revision: 0,
        firstWakeAt: null,
      },
    });

    expect(db.getTaskById(task.id)).toMatchObject({
      id: task.id,
      status: 'paused',
      next_run: null,
    });
    expect(db.getTaskById(task.id)?.deleted_at).not.toBeNull();
    expect(db.getTaskRunById(activeRun.id)).toMatchObject({
      id: activeRun.id,
      status: 'cancelled',
    });

    const raw = new Database(path.join(storeDir, 'messages.db'), {
      readonly: true,
    });
    const counts = raw
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM workspace_memory_stores WHERE workspace_jid = ?) AS stores,
          (SELECT COUNT(*) FROM workspace_memory_items WHERE workspace_jid = ?) AS items,
          (SELECT COUNT(*) FROM workspace_memory_versions WHERE workspace_jid = ?) AS versions,
          (SELECT COUNT(*) FROM workspace_memory_provenance
             WHERE item_id IN (
               SELECT id FROM workspace_memory_items WHERE workspace_jid = ?
             )) AS provenance,
          (SELECT COUNT(*) FROM workspace_memory_tombstones WHERE workspace_jid = ?) AS tombstones,
          (SELECT COUNT(*) FROM workspace_memory_outbox WHERE workspace_jid = ?) AS outbox,
          (SELECT COUNT(*) FROM workspace_memory_audit_events WHERE workspace_jid = ?) AS audits,
          (SELECT COUNT(*) FROM workspace_memory_fts WHERE workspace_jid = ?) AS fts`,
      )
      .get(JID, JID, JID, JID, JID, JID, JID, JID);
    expect(counts).toEqual({
      stores: 1,
      items: 0,
      versions: 0,
      provenance: 0,
      tombstones: 0,
      outbox: 0,
      audits: 0,
      fts: 0,
    });
    raw.close();

    expect(fs.readdirSync(workspaceDir)).toEqual([]);
    expect(fs.existsSync(legacyMemoryDir)).toBe(false);
    expect(fs.readFileSync(path.join(persistentDir, 'keep.txt'), 'utf8')).toBe(
      'keep me',
    );
  });

  test('rolls files, Memory and task definitions back when SQLite commit fails', async () => {
    const jid = 'web:rebuild-memory-rollback';
    const folder = 'rebuild-memory-rollback';
    db.setRegisteredGroup(jid, {
      name: 'Rebuild Rollback',
      folder,
      added_at: new Date().toISOString(),
      executionMode: 'container',
      created_by: 'alice',
      is_home: false,
    });
    const memory = memoryStore.createWorkspaceMemoryItem({
      workspaceJid: jid,
      value: {
        kind: 'decision',
        title: 'Keep on failure',
        content: 'The failed rebuild must preserve this Memory.',
      },
      context: {
        actorId: 'alice',
        sourceType: 'web_user',
        sourceId: 'rollback-source',
        sessionId: 'rollback-session',
      },
    });
    const originalStore = memoryStore.getWorkspaceMemoryStore(jid)!;
    const originalNextRun = new Date(Date.now() + 120_000).toISOString();
    db.createTask({
      id: 'rebuild-rollback-task',
      group_folder: folder,
      chat_jid: jid,
      prompt: 'Restore this task if rebuild fails.',
      schedule_type: 'cron',
      schedule_value: '0 10 * * *',
      context_mode: 'isolated',
      execution_type: 'agent',
      execution_mode: 'container',
      script_command: null,
      next_run: originalNextRun,
      status: 'active',
      created_at: new Date().toISOString(),
      created_by: 'alice',
      notify_channels: null,
    });
    db.createTask({
      id: 'rebuild-rollback-parsing-task',
      group_folder: folder,
      chat_jid: jid,
      prompt: 'An in-flight parser owns this revision.',
      schedule_type: 'cron',
      schedule_value: '0 0 * * *',
      context_mode: 'isolated',
      execution_type: 'agent',
      execution_mode: 'container',
      script_command: null,
      next_run: null,
      status: 'parsing',
      created_at: new Date().toISOString(),
      created_by: 'alice',
      notify_channels: null,
    });
    const parsingRevision = db.getTaskById(
      'rebuild-rollback-parsing-task',
    )!.revision;
    const workspaceDir = path.join(groupsDir, folder);
    const sessionDir = path.join(root, 'sessions', folder);
    const ipcDir = path.join(root, 'ipc', folder);
    const legacyMemoryDir = path.join(root, 'memory', folder);
    for (const dir of [workspaceDir, sessionDir, ipcDir, legacyMemoryDir]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'before.txt'), dir);
    }

    const raw = new Database(path.join(storeDir, 'messages.db'));
    raw.exec(`
      CREATE TRIGGER fail_workspace_rebuild_memory
      BEFORE DELETE ON workspace_memory_stores
      WHEN OLD.workspace_jid = 'web:rebuild-memory-rollback'
      BEGIN
        SELECT RAISE(ABORT, 'injected workspace rebuild failure');
      END;
    `);
    try {
      const response = await groupRoutes.request(
        `/${encodeURIComponent(jid)}/clear-history`,
        { method: 'POST' },
      );
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error: 'Workspace rebuild failed; original data was restored',
      });
    } finally {
      raw.exec('DROP TRIGGER IF EXISTS fail_workspace_rebuild_memory');
      raw.close();
    }

    expect(memoryStore.getWorkspaceMemoryStore(jid)).toEqual(originalStore);
    expect(
      memoryStore.getWorkspaceMemoryItem(jid, memory.item.id).item.content,
    ).toContain('preserve this Memory');
    expect(db.getTaskById('rebuild-rollback-task')).toMatchObject({
      status: 'active',
      next_run: originalNextRun,
      deleted_at: null,
    });
    expect(db.getTaskById('rebuild-rollback-parsing-task')).toMatchObject({
      status: 'parsing',
      revision: parsingRevision,
      deleted_at: null,
    });
    for (const dir of [workspaceDir, sessionDir, ipcDir, legacyMemoryDir]) {
      expect(fs.readFileSync(path.join(dir, 'before.txt'), 'utf8')).toBe(dir);
      expect(
        fs
          .readdirSync(path.dirname(dir))
          .some((name) => name.includes('.rebuild-backup-')),
      ).toBe(false);
    }
    expect(resumeGroupsAfterMutation).toHaveBeenCalledWith(pauseToken);
    db.deleteRegisteredGroup(jid);
  });
});
