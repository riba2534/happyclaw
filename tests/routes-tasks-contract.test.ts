import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-tasks-contract-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    DATA_DIR: tmpDir,
    STORE_DIR: tmpStoreDir,
    GROUPS_DIR: tmpGroupsDir,
  };
});

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

const webDepsState = vi.hoisted(() => ({ current: null as any }));
vi.mock('../src/web.js', () => ({
  getWebDeps: () => webDepsState.current,
}));

const sdkQueryMock = vi.hoisted(() => vi.fn());
vi.mock('../src/sdk-query.js', () => ({ sdkQuery: sdkQueryMock }));

vi.mock('../src/middleware/auth.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/middleware/auth.js')>();
  return {
    ...actual,
    authMiddleware: async (c: any, next: any) => {
      c.set('user', {
        id: process.env.HAPPYCLAW_TEST_USER_ID ?? 'alice',
        username: process.env.HAPPYCLAW_TEST_USER_ID ?? 'alice',
        role: process.env.HAPPYCLAW_TEST_USER_ROLE ?? 'member',
        permissions: [],
      });
      return next();
    },
  };
});

const tasksRoutesModule = await import('../src/routes/tasks.js');
const db = await import('../src/db.js');
const { MAX_TASK_PROMPT_LENGTH } = await import('../src/schemas.js');
const webContext = await import('../src/web-context.js');
const { enqueueIsolatedScheduledTask, getRunningTaskIds } =
  await import('../src/task-scheduler.js');

const tasksRoutes = tasksRoutesModule.default;

const OWNER_ID = 'alice';
const GROUP_JID = 'web:tasks-contract';
const GROUP_FOLDER = 'tasks-contract';

function asUser(userId: string, role: 'admin' | 'member' = 'member'): void {
  process.env.HAPPYCLAW_TEST_USER_ID = userId;
  process.env.HAPPYCLAW_TEST_USER_ROLE = role;
}

function seedGroup(): void {
  db.setRegisteredGroup(GROUP_JID, {
    name: 'Tasks Contract Workspace',
    folder: GROUP_FOLDER,
    added_at: new Date().toISOString(),
    executionMode: 'container',
    created_by: OWNER_ID,
    is_home: false,
  } as any);
  fs.mkdirSync(path.join(tmpGroupsDir, GROUP_FOLDER), { recursive: true });
}

function createTask(
  id: string,
  createdBy: string | null,
  overrides: Partial<Parameters<typeof db.createTask>[0]> = {},
): void {
  db.createTask({
    id,
    group_folder: GROUP_FOLDER,
    chat_jid: GROUP_JID,
    prompt: `prompt for ${id}`,
    schedule_type: 'cron',
    schedule_value: '0 9 * * *',
    context_mode: 'isolated',
    execution_type: 'agent',
    execution_mode: 'container',
    script_command: null,
    next_run: new Date(Date.now() + 60_000).toISOString(),
    status: 'active',
    created_at: new Date().toISOString(),
    created_by: createdBy ?? undefined,
    notify_channels: null,
    ...overrides,
  });
}

async function deleteTask(id: string) {
  const revision = db.getTaskById(id)?.revision;
  const res = await tasksRoutes.request(
    `/${id}?expected_revision=${revision ?? ''}`,
    { method: 'DELETE' },
  );
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function purgeTasks(
  tasks: Array<{ id: string; expected_revision?: number }>,
) {
  const response = await tasksRoutes.request('/purge', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      tasks: tasks.map((task) => ({
        id: task.id,
        expected_revision:
          task.expected_revision ?? db.getTaskById(task.id)?.revision,
      })),
    }),
  });
  return {
    status: response.status,
    body: await response.json().catch(() => ({})),
  };
}

async function patchTask(
  id: string,
  body: Record<string, unknown>,
  autoRevision = true,
) {
  if (autoRevision && body.expected_revision == null) {
    body = {
      ...body,
      expected_revision: db.getTaskById(id)?.revision,
    };
  }
  const res = await tasksRoutes.request(`/${id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

beforeAll(() => {
  db.initDatabase();
});

beforeEach(() => {
  for (const id of [
    'dirty-source-task',
    'queued-route-task',
    'revision-route-task',
    'restore-route-task',
    'runs-route-task',
    'frequency-route-task',
    'history-route-task',
    'cancelled-history-route-task',
    'future-once-restore-task',
    'past-once-restore-task',
    'paused-once-cancel-task',
    'final-agent-definition-task',
    'final-script-definition-task',
    'script-to-agent-definition-task',
    'unsafe-script-route-task',
    'script-permissions-task',
    'cancel-no-scheduler-task',
    'capacity-live-task',
    'capacity-deleted-task',
    'purge-route-task-a',
    'purge-route-task-b',
    'purge-live-route-task',
    'purge-stale-route-task-a',
    'purge-stale-route-task-b',
    'route-move-task',
    'delivered-group-list-task',
  ]) {
    try {
      db.deleteTask(id);
    } catch {
      /* ignore */
    }
  }
  seedGroup();
  webDepsState.current = null;
  webContext.setWebDeps({} as any);
  sdkQueryMock.mockReset();
});

afterEach(() => {
  delete process.env.HAPPYCLAW_TEST_USER_ID;
  delete process.env.HAPPYCLAW_TEST_USER_ROLE;
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('tasks route ownership and cleanup contract', () => {
  test('create and patch reject cron schedules faster than once per minute', async () => {
    asUser(OWNER_ID);
    for (const scheduleValue of ['* * * * * *', '0,30 0 * * * *']) {
      const create = await tasksRoutes.request('/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          group_folder: GROUP_FOLDER,
          chat_jid: GROUP_JID,
          prompt: 'too frequent',
          schedule_type: 'cron',
          schedule_value: scheduleValue,
        }),
      });
      expect(create.status).toBe(400);
      expect(await create.json()).toMatchObject({
        error: expect.stringContaining('at least 60 seconds'),
      });
    }
    const fastInterval = await tasksRoutes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        group_folder: GROUP_FOLDER,
        chat_jid: GROUP_JID,
        prompt: 'too frequent interval',
        schedule_type: 'interval',
        schedule_value: '1000',
      }),
    });
    expect(fastInterval.status).toBe(400);

    createTask('frequency-route-task', OWNER_ID);
    const patch = await patchTask('frequency-route-task', {
      schedule_type: 'cron',
      schedule_value: '* * * * * *',
    });
    expect(patch.status).toBe(400);
    expect(db.getTaskById('frequency-route-task')?.schedule_value).toBe(
      '0 9 * * *',
    );
    const intervalPatch = await patchTask('frequency-route-task', {
      schedule_type: 'interval',
      schedule_value: '1000',
    });
    expect(intervalPatch.status).toBe(400);
    expect(db.getTaskById('frequency-route-task')?.schedule_type).toBe('cron');
  });

  test('AI parse rejects a sub-minute cron and respects a concurrent pause', async () => {
    asUser(OWNER_ID);
    sdkQueryMock.mockResolvedValueOnce(
      JSON.stringify({
        prompt: 'parsed prompt',
        schedule_type: 'cron',
        schedule_value: '* * * * * *',
        summary: 'too frequent',
      }),
    );
    const rejected = await tasksRoutes.request('/ai', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: '每秒执行', chat_jid: GROUP_JID }),
    });
    const rejectedBody = await rejected.json();
    await vi.waitFor(() => {
      expect(db.getTaskById(rejectedBody.taskId)?.status).toBe('paused');
    });

    let resolveParse!: (value: string) => void;
    sdkQueryMock.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveParse = resolve;
        }),
    );
    const concurrent = await tasksRoutes.request('/ai', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ description: '每天执行', chat_jid: GROUP_JID }),
    });
    const concurrentBody = await concurrent.json();
    await vi.waitFor(() => expect(resolveParse).toBeTypeOf('function'));
    const rejectedEdit = await patchTask(concurrentBody.taskId, {
      prompt: 'user-owned edit',
    });
    expect(rejectedEdit.status).toBe(409);
    const edited = await patchTask(concurrentBody.taskId, { status: 'paused' });
    expect(edited.status).toBe(200);
    const editedRevision = db.getTaskById(concurrentBody.taskId)!.revision;
    resolveParse(
      JSON.stringify({
        prompt: 'stale AI result',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        summary: 'valid but stale',
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(db.getTaskById(concurrentBody.taskId)).toMatchObject({
      prompt: '每天执行',
      revision: editedRevision,
      status: 'paused',
    });
  });

  test('AI creation enforces both user and model prompt bounds', async () => {
    asUser(OWNER_ID);

    let response = await tasksRoutes.request('/ai', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        description: 'x'.repeat(MAX_TASK_PROMPT_LENGTH + 1),
        chat_jid: GROUP_JID,
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: 'TASK_PROMPT_TOO_LONG',
    });
    expect(sdkQueryMock).not.toHaveBeenCalled();

    sdkQueryMock.mockResolvedValueOnce(
      JSON.stringify({
        prompt: 'y'.repeat(MAX_TASK_PROMPT_LENGTH + 1),
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        summary: 'oversized model output',
      }),
    );
    response = await tasksRoutes.request('/ai', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        description: '每天生成摘要',
        chat_jid: GROUP_JID,
      }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    await vi.waitFor(() => {
      expect(db.getTaskById(body.taskId)).toMatchObject({
        prompt: '每天生成摘要',
        status: 'paused',
      });
    });
    db.deleteTask(body.taskId);
  });

  test('moving a task updates its concrete delivery route', async () => {
    const targetJid = 'web:route-move-target';
    const targetFolder = 'route-move-target';
    db.setRegisteredGroup(targetJid, {
      name: 'Route Move Target',
      folder: targetFolder,
      added_at: new Date().toISOString(),
      executionMode: 'container',
      created_by: OWNER_ID,
      is_home: false,
    } as any);
    createTask('route-move-task', OWNER_ID, {
      delivery_route_jid: `${GROUP_JID}#thread:old`,
    });
    asUser(OWNER_ID);

    const moved = await patchTask('route-move-task', {
      chat_jid: targetJid,
      execution_mode: 'container',
    });
    expect(moved.status).toBe(200);
    expect(db.getTaskById('route-move-task')).toMatchObject({
      chat_jid: targetJid,
      group_folder: targetFolder,
      delivery_route_jid: targetJid,
    });
  });

  test('DELETE soft-deletes the task, retains history, and never deletes the source workspace', async () => {
    createTask('dirty-source-task', OWNER_ID);
    db.updateTaskWorkspace('dirty-source-task', GROUP_JID, GROUP_FOLDER);
    const marker = path.join(tmpGroupsDir, GROUP_FOLDER, 'keep.txt');
    fs.writeFileSync(marker, 'workspace data');

    asUser(OWNER_ID);
    const res = await deleteTask('dirty-source-task');
    expect(res.status).toBe(200);
    expect(db.getTaskById('dirty-source-task')).toMatchObject({
      status: 'paused',
      next_run: null,
    });
    expect(db.getTaskById('dirty-source-task')?.deleted_at).toBeTruthy();
    expect(
      db.getAllTasks().some((task) => task.id === 'dirty-source-task'),
    ).toBe(false);
    expect(
      db.getDeletedTasks().some((task) => task.id === 'dirty-source-task'),
    ).toBe(true);
    expect(db.getRegisteredGroup(GROUP_JID)).toBeTruthy();
    expect(fs.readFileSync(marker, 'utf8')).toBe('workspace data');
  });

  test('capacity-queued scheduled run blocks route mutation and drop releases it', async () => {
    const targetJid = 'web:tasks-contract-target';
    const targetFolder = 'tasks-contract-target';
    db.setRegisteredGroup(targetJid, {
      name: 'Target Workspace',
      folder: targetFolder,
      added_at: new Date().toISOString(),
      executionMode: 'container',
      created_by: OWNER_ID,
      is_home: false,
    } as any);
    createTask('queued-route-task', OWNER_ID);

    const droppedCallbacks: Array<() => void> = [];
    const queue = {
      enqueueTask: vi.fn(
        (
          _jid: string,
          _taskId: string,
          _fn: () => Promise<void>,
          options?: { onDropped?: () => void },
        ) => {
          if (options?.onDropped) droppedCallbacks.push(options.onDropped);
          return true;
        },
      ),
    };
    const groups = {
      [GROUP_JID]: db.getRegisteredGroup(GROUP_JID)!,
      [targetJid]: db.getRegisteredGroup(targetJid)!,
    };
    const deps = {
      registeredGroups: () => groups,
      queue,
    } as any;

    expect(
      enqueueIsolatedScheduledTask(db.getTaskById('queued-route-task')!, deps),
    ).toBe(true);
    expect(getRunningTaskIds()).toContain('queued-route-task');

    asUser(OWNER_ID);
    const blocked = await patchTask('queued-route-task', {
      chat_jid: targetJid,
    });
    expect(blocked.status).toBe(409);
    expect(db.getTaskById('queued-route-task')?.chat_jid).toBe(GROUP_JID);

    droppedCallbacks.shift()?.();
    expect(getRunningTaskIds()).not.toContain('queued-route-task');
    const patched = await patchTask('queued-route-task', {
      chat_jid: targetJid,
    });
    expect(patched.status).toBe(200);
    expect(db.getTaskById('queued-route-task')?.chat_jid).toBe(targetJid);

    expect(
      enqueueIsolatedScheduledTask(db.getTaskById('queued-route-task')!, deps),
    ).toBe(true);
    expect(queue.enqueueTask).toHaveBeenCalledTimes(2);
    droppedCallbacks.shift()?.();
  });

  test('PATCH rejects a stale revision instead of overwriting a newer edit', async () => {
    createTask('revision-route-task', OWNER_ID);
    asUser(OWNER_ID);
    const initial = db.getTaskById('revision-route-task')!;

    const missing = await patchTask(
      'revision-route-task',
      { prompt: 'unprotected edit' },
      false,
    );
    expect(missing.status).toBe(428);
    expect(missing.body).toMatchObject({ code: 'TASK_REVISION_REQUIRED' });

    const first = await patchTask('revision-route-task', {
      prompt: 'first edit',
      expected_revision: initial.revision,
    });
    expect(first.status).toBe(200);

    const stale = await patchTask('revision-route-task', {
      prompt: 'stale edit',
      expected_revision: initial.revision,
    });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'TASK_REVISION_CONFLICT' });
    expect(db.getTaskById('revision-route-task')?.prompt).toBe('first edit');
  });

  test('PATCH rejects final agent/script definitions that cannot execute', async () => {
    createTask('final-agent-definition-task', OWNER_ID);
    asUser(OWNER_ID, 'admin');

    const missingCommand = await patchTask('final-agent-definition-task', {
      execution_type: 'script',
    });
    expect(missingCommand.status).toBe(400);
    expect(missingCommand.body.error).toContain('script_command');
    expect(db.getTaskById('final-agent-definition-task')).toMatchObject({
      execution_type: 'agent',
      script_command: null,
    });

    createTask('final-script-definition-task', OWNER_ID, {
      execution_type: 'script',
      script_command: 'echo ready',
    });
    const clearedCommand = await patchTask('final-script-definition-task', {
      script_command: null,
    });
    expect(clearedCommand.status).toBe(400);
    expect(clearedCommand.body.error).toContain('script_command');
    expect(db.getTaskById('final-script-definition-task')?.script_command).toBe(
      'echo ready',
    );

    createTask('script-to-agent-definition-task', OWNER_ID, {
      prompt: '',
      execution_type: 'script',
      script_command: 'echo ready',
    });
    const missingPrompt = await patchTask('script-to-agent-definition-task', {
      execution_type: 'agent',
    });
    expect(missingPrompt.status).toBe(400);
    expect(missingPrompt.body.error).toContain('prompt');
    expect(
      db.getTaskById('script-to-agent-definition-task')?.execution_type,
    ).toBe('script');
  });

  test('script create/run/restore require an administrator host workspace', async () => {
    asUser(OWNER_ID, 'admin');
    let response = await tasksRoutes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        group_folder: GROUP_FOLDER,
        chat_jid: GROUP_JID,
        prompt: '',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        execution_type: 'script',
        script_command: 'echo unsafe',
      }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('host');

    const hostJid = 'web:tasks-contract-host';
    const hostFolder = 'tasks-contract-host';
    db.setRegisteredGroup(hostJid, {
      name: 'Host Workspace',
      folder: hostFolder,
      added_at: new Date().toISOString(),
      executionMode: 'host',
      created_by: OWNER_ID,
      is_home: true,
    } as any);
    response = await tasksRoutes.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        group_folder: hostFolder,
        chat_jid: hostJid,
        prompt: '',
        schedule_type: 'cron',
        schedule_value: '0 9 * * *',
        execution_type: 'script',
        script_command: 'echo safe',
      }),
    });
    expect(response.status).toBe(200);
    const legalTask = db.getTaskById((await response.json()).taskId)!;
    expect(legalTask).toMatchObject({
      execution_type: 'script',
      execution_mode: 'host',
      chat_jid: hostJid,
    });

    createTask('unsafe-script-route-task', OWNER_ID, {
      execution_type: 'script',
      execution_mode: 'container',
      script_command: 'echo must-not-run',
    });
    const trigger = vi.fn(() => ({ success: true, runId: 'unexpected' }));
    webContext.setWebDeps({ triggerTaskRun: trigger } as any);
    response = await tasksRoutes.request('/unsafe-script-route-task/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(400);
    expect(trigger).not.toHaveBeenCalled();
    expect(db.getTaskById('unsafe-script-route-task')).toMatchObject({
      status: 'paused',
      next_run: null,
    });

    expect((await deleteTask('unsafe-script-route-task')).status).toBe(200);
    const deleted = db.getTaskById('unsafe-script-route-task')!;
    response = await tasksRoutes.request('/unsafe-script-route-task/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expected_revision: deleted.revision }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('host');
    expect(db.getTaskById('unsafe-script-route-task')?.deleted_at).toBeTruthy();
  });

  test('soft-deleted task can be restored only as paused while keeping runs', async () => {
    createTask('restore-route-task', OWNER_ID);
    const task = db.getTaskById('restore-route-task')!;
    const previousRun = db.createTaskRun({
      task,
      triggerType: 'manual',
      idempotencyKey: 'history-before-delete',
    });
    db.cancelTaskRun(previousRun.run.id, 'test history');
    asUser(OWNER_ID);

    expect((await deleteTask('restore-route-task')).status).toBe(200);
    const deleted = db.getTaskById('restore-route-task')!;
    const response = await tasksRoutes.request('/restore-route-task/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expected_revision: deleted.revision }),
    });
    expect(response.status).toBe(200);
    expect(db.getTaskById('restore-route-task')).toMatchObject({
      status: 'paused',
      deleted_at: null,
      next_run: null,
    });
    expect(db.getTaskRunsForTask('restore-route-task')).toHaveLength(1);
  });

  test('permanently deletes selected recycle-bin tasks and their run history', async () => {
    createTask('purge-route-task-a', OWNER_ID);
    createTask('purge-route-task-b', OWNER_ID);
    const run = db.createTaskRun({
      task: db.getTaskById('purge-route-task-a')!,
      triggerType: 'manual',
      idempotencyKey: 'purge-history',
    });
    db.cancelTaskRun(run.run.id, 'finished before recycle-bin cleanup');
    asUser(OWNER_ID);

    expect((await deleteTask('purge-route-task-a')).status).toBe(200);
    expect((await deleteTask('purge-route-task-b')).status).toBe(200);
    const response = await purgeTasks([
      { id: 'purge-route-task-a' },
      { id: 'purge-route-task-b' },
    ]);

    expect(response).toMatchObject({
      status: 200,
      body: {
        success: true,
        deleted_count: 2,
        task_ids: ['purge-route-task-a', 'purge-route-task-b'],
      },
    });
    expect(db.getTaskById('purge-route-task-a')).toBeUndefined();
    expect(db.getTaskById('purge-route-task-b')).toBeUndefined();
    expect(db.getTaskRunsForTask('purge-route-task-a')).toEqual([]);
  });

  test('recycle-bin purge rejects live tasks and is atomic on revision conflict', async () => {
    createTask('purge-live-route-task', OWNER_ID);
    createTask('purge-stale-route-task-a', OWNER_ID);
    createTask('purge-stale-route-task-b', OWNER_ID);
    asUser(OWNER_ID);

    const liveResponse = await purgeTasks([{ id: 'purge-live-route-task' }]);
    expect(liveResponse).toMatchObject({
      status: 409,
      body: { code: 'TASK_NOT_DELETED' },
    });
    expect(db.getTaskById('purge-live-route-task')).toBeTruthy();

    expect((await deleteTask('purge-stale-route-task-a')).status).toBe(200);
    expect((await deleteTask('purge-stale-route-task-b')).status).toBe(200);
    const staleRevision =
      db.getTaskById('purge-stale-route-task-b')!.revision + 1;
    const staleResponse = await purgeTasks([
      { id: 'purge-stale-route-task-a' },
      {
        id: 'purge-stale-route-task-b',
        expected_revision: staleRevision,
      },
    ]);

    expect(staleResponse).toMatchObject({
      status: 409,
      body: { code: 'TASK_REVISION_CONFLICT' },
    });
    expect(db.getTaskById('purge-stale-route-task-a')?.deleted_at).toBeTruthy();
    expect(db.getTaskById('purge-stale-route-task-b')?.deleted_at).toBeTruthy();
  });

  test('restoring a soft-deleted task is independent of other owned tasks', async () => {
    const capOwner = 'capacity-owner';
    const capJid = 'web:capacity-owner';
    const capFolder = 'capacity-owner';
    db.setRegisteredGroup(capJid, {
      name: 'Capacity Workspace',
      folder: capFolder,
      added_at: new Date().toISOString(),
      executionMode: 'container',
      created_by: capOwner,
      is_home: false,
    } as any);
    createTask('capacity-live-task', capOwner, {
      group_folder: capFolder,
      chat_jid: capJid,
    });
    createTask('capacity-deleted-task', capOwner, {
      group_folder: capFolder,
      chat_jid: capJid,
    });
    const deleted = db.softDeleteTaskWithRevision(
      'capacity-deleted-task',
      db.getTaskById('capacity-deleted-task')!.revision,
    );
    expect(deleted.status).toBe('updated');
    if (deleted.status !== 'updated') return;

    asUser(capOwner);
    const response = await tasksRoutes.request(
      '/capacity-deleted-task/restore',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expected_revision: deleted.task.revision }),
      },
    );
    expect(response.status).toBe(200);
    expect(db.getTaskById('capacity-deleted-task')).toMatchObject({
      deleted_at: null,
      status: 'paused',
      next_run: null,
    });
  });

  test('restored future once task rebuilds next_run, while an expired once task is rejected', async () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    createTask('future-once-restore-task', OWNER_ID, {
      schedule_type: 'once',
      schedule_value: future,
      next_run: future,
    });
    asUser(OWNER_ID);
    expect((await deleteTask('future-once-restore-task')).status).toBe(200);
    let deleted = db.getTaskById('future-once-restore-task')!;
    let response = await tasksRoutes.request(
      '/future-once-restore-task/restore',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ expected_revision: deleted.revision }),
      },
    );
    expect(response.status).toBe(200);
    expect(db.getTaskById('future-once-restore-task')).toMatchObject({
      status: 'paused',
      next_run: null,
      schedule_value: future,
    });

    const resumed = await patchTask('future-once-restore-task', {
      status: 'active',
    });
    expect(resumed.status).toBe(200);
    expect(db.getTaskById('future-once-restore-task')).toMatchObject({
      status: 'active',
      next_run: future,
    });

    const past = new Date(Date.now() - 60_000).toISOString();
    createTask('past-once-restore-task', OWNER_ID, {
      schedule_type: 'once',
      schedule_value: past,
      next_run: null,
      status: 'completed',
    });
    expect((await deleteTask('past-once-restore-task')).status).toBe(200);
    deleted = db.getTaskById('past-once-restore-task')!;
    response = await tasksRoutes.request('/past-once-restore-task/restore', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expected_revision: deleted.revision }),
    });
    expect(response.status).toBe(200);
    const expiredResume = await patchTask('past-once-restore-task', {
      status: 'active',
    });
    expect(expiredResume.status).toBe(400);
    expect(expiredResume.body.error).toContain('执行时间已过');
    expect(db.getTaskById('past-once-restore-task')).toMatchObject({
      status: 'paused',
      next_run: null,
    });
  });

  test('pausing then stopping a materialized once run leaves a terminal task', async () => {
    const scheduledFor = new Date(Date.now() - 1_000).toISOString();
    createTask('paused-once-cancel-task', OWNER_ID, {
      schedule_type: 'once',
      schedule_value: scheduledFor,
      next_run: scheduledFor,
    });
    const materialized = db.materializeTaskOccurrence({
      taskId: 'paused-once-cancel-task',
      scheduledFor,
      nextRun: null,
      triggerType: 'scheduled',
    })!;
    db.updateTask('paused-once-cancel-task', { status: 'paused' });
    webContext.setWebDeps({
      cancelTaskRun: (runId: string) => ({
        success: db.cancelTaskRun(runId),
      }),
    } as any);
    asUser(OWNER_ID);

    const stopped = await tasksRoutes.request(
      `/runs/${materialized.run.id}/cancel`,
      { method: 'POST' },
    );
    expect(stopped.status).toBe(200);
    expect(db.getTaskRunById(materialized.run.id)?.status).toBe('cancelled');
    expect(db.getTaskById('paused-once-cancel-task')).toMatchObject({
      status: 'completed',
      next_run: null,
    });

    const resumed = await patchTask('paused-once-cancel-task', {
      status: 'active',
    });
    expect(resumed.status).toBe(400);
    expect(resumed.body.error).toContain('已完成的一次性任务');
  });

  test('runs endpoint returns durable occurrence fields', async () => {
    createTask('runs-route-task', OWNER_ID);
    const task = db.getTaskById('runs-route-task')!;
    const created = db.createTaskRun({
      task,
      triggerType: 'manual',
      idempotencyKey: 'runs-route-idem',
    });
    asUser(OWNER_ID);

    const response = await tasksRoutes.request('/runs-route-task/runs');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.runs[0]).toMatchObject({
      id: created.run.id,
      task_id: 'runs-route-task',
      trigger_type: 'manual',
      status: 'queued',
      attempt: 0,
      notification_status: 'pending',
    });
  });

  test('task list exposes a delivered group run as stoppable current work', async () => {
    createTask('delivered-group-list-task', OWNER_ID, {
      context_mode: 'group',
    });
    const task = db.getTaskById('delivered-group-list-task')!;
    const created = db.createTaskRun({
      task,
      triggerType: 'manual',
      idempotencyKey: 'delivered-group-list-run',
    });
    const claim = db.claimNextTaskRun('delivered-group-list-worker', 60_000)!;
    expect(claim.id).toBe(created.run.id);
    expect(
      db.markTaskRunExecutionStarted(
        claim.id,
        claim.lease_owner,
        claim.lease_token,
      ),
    ).toBe(true);
    expect(
      db.completeTaskRun(claim.id, claim.lease_owner, claim.lease_token, {
        status: 'delivered',
        result: '已投递到主会话',
        notificationStatus: 'skipped',
      }),
    ).toBe(true);
    asUser(OWNER_ID);

    const response = await tasksRoutes.request('/');
    expect(response.status).toBe(200);
    const listed = (await response.json()).tasks.find(
      (candidate: any) => candidate.id === task.id,
    );
    expect(listed).toMatchObject({
      current_run: {
        id: created.run.id,
        status: 'delivered',
      },
      permissions: {
        can_stop: true,
      },
    });
    expect(
      db.finalizeDeliveredGroupTaskRun(created.run.id, task.id, {
        status: 'cancelled',
        error: 'test cleanup',
      }),
    ).toBe(true);
  });

  test('runs endpoint merges pre-upgrade history with V2 runs and removes duplicates', async () => {
    createTask('history-route-task', OWNER_ID);
    const oldRunAt = '2025-01-01T00:00:00.000Z';
    db.logTaskRun({
      task_id: 'history-route-task',
      run_at: oldRunAt,
      duration_ms: 10,
      status: 'success',
      result: 'legacy result',
      error: null,
    });
    asUser(OWNER_ID);
    const beforeV2 = await tasksRoutes.request('/');
    const beforeV2Task = (await beforeV2.json()).tasks.find(
      (task: any) => task.id === 'history-route-task',
    );
    expect(beforeV2Task.last_run_summary).toMatchObject({
      run_at: oldRunAt,
      status: 'success',
    });
    const durable = db.createTaskRun({
      task: db.getTaskById('history-route-task')!,
      triggerType: 'manual',
      idempotencyKey: 'mixed-history',
    });
    db.logTaskRun({
      task_id: 'history-route-task',
      run_at: durable.run.created_at,
      duration_ms: 0,
      status: 'queued',
      result: null,
      error: null,
    });
    const nearbyRealRunAt = new Date(
      new Date(durable.run.created_at).getTime() - 1_000,
    ).toISOString();
    db.logTaskRun({
      task_id: 'history-route-task',
      run_at: nearbyRealRunAt,
      duration_ms: 0,
      status: 'queued',
      result: null,
      error: null,
    });
    const response = await tasksRoutes.request('/history-route-task/runs');
    const body = await response.json();
    expect(body.runs).toHaveLength(3);
    expect(body.runs.map((run: any) => run.id)).toContain(durable.run.id);
    expect(body.runs.some((run: any) => run.run_at === oldRunAt)).toBe(true);
    expect(
      body.runs.filter(
        (run: any) =>
          run.run_at === nearbyRealRunAt ||
          run.run_at === durable.run.created_at,
      ),
    ).toHaveLength(1);
    const afterV2 = await tasksRoutes.request('/');
    const afterV2Task = (await afterV2.json()).tasks.find(
      (task: any) => task.id === 'history-route-task',
    );
    expect(afterV2Task.last_run_summary.id).toBe(durable.run.id);
  });

  test('runs endpoint shows one cancelled run when its in-flight legacy log ends as error', async () => {
    createTask('cancelled-history-route-task', OWNER_ID);
    const created = db.createTaskRun({
      task: db.getTaskById('cancelled-history-route-task')!,
      triggerType: 'manual',
      idempotencyKey: 'cancelled-history',
    });
    const claimed = db.claimNextTaskRun('history-runner', 60_000)!;
    expect(claimed.id).toBe(created.run.id);
    expect(
      db.markTaskRunExecutionStarted(
        claimed.id,
        claimed.lease_owner,
        claimed.lease_token,
      ),
    ).toBe(true);
    const started = db.getTaskRunById(claimed.id)!;
    expect(started.status).toBe('running');
    expect(started.started_at).toBeTruthy();

    // The legacy logger is finalized by the aborted worker after the durable
    // row has already been fenced as cancelled.
    db.logTaskRun({
      task_id: 'cancelled-history-route-task',
      run_at: started.started_at!,
      duration_ms: 25,
      status: 'error',
      result: null,
      error: 'Agent execution aborted',
    });
    expect(db.cancelTaskRun(claimed.id)).toBe(true);
    asUser(OWNER_ID);

    const response = await tasksRoutes.request(
      '/cancelled-history-route-task/runs',
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0]).toMatchObject({
      id: claimed.id,
      status: 'cancelled',
      error: 'Cancelled by user',
    });
  });

  test('script task permissions match REST and cancellation fails closed without scheduler', async () => {
    createTask('script-permissions-task', OWNER_ID, {
      execution_type: 'script',
      script_command: 'echo ok',
    });
    createTask('cancel-no-scheduler-task', OWNER_ID);
    const queued = db.createTaskRun({
      task: db.getTaskById('cancel-no-scheduler-task')!,
      triggerType: 'manual',
      idempotencyKey: 'cancel-no-scheduler',
    });
    asUser(OWNER_ID);

    const list = await tasksRoutes.request('/');
    const listed = (await list.json()).tasks.find(
      (task: any) => task.id === 'script-permissions-task',
    );
    expect(listed.permissions).toMatchObject({
      can_run: false,
      can_stop: false,
      can_delete: false,
      can_restore: false,
      can_purge: false,
    });
    expect(
      (
        await tasksRoutes.request('/script-permissions-task/runs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
      ).status,
    ).toBe(403);

    const cancel = await tasksRoutes.request(`/runs/${queued.run.id}/cancel`, {
      method: 'POST',
    });
    expect(cancel.status).toBe(503);
    expect(db.getTaskRunById(queued.run.id)?.status).toBe('queued');
  });

  test('legacy run endpoint accepts a stable idempotency key and returns conflict run id', async () => {
    createTask('runs-route-task', OWNER_ID);
    asUser(OWNER_ID);
    const trigger = vi
      .fn()
      .mockReturnValueOnce({ success: true, runId: 'run-stable' })
      .mockReturnValueOnce({
        success: false,
        error: 'Task is already running',
        runId: 'run-stable',
      });
    webContext.setWebDeps({ triggerTaskRun: trigger } as any);

    const first = await tasksRoutes.request('/runs-route-task/run', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'Idempotency-Key': 'legacy-stable-key',
      },
      body: '{}',
    });
    expect(first.status).toBe(200);
    expect(trigger).toHaveBeenLastCalledWith(
      'runs-route-task',
      'legacy-stable-key',
    );

    const retry = await tasksRoutes.request('/runs-route-task/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idempotency_key: 'legacy-stable-key' }),
    });
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({ runId: 'run-stable' });
  });
});
