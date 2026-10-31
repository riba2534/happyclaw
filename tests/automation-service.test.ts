import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-service-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
for (const dir of [storeDir, groupsDir]) fs.mkdirSync(dir, { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: root,
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
  TIMEZONE: 'Asia/Shanghai',
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const store = await import('../src/automation-store.js');
const { createAutomationCore } = await import('../src/automation-service.js');
const { AutomationError } = await import('../src/automation-contract.js');
const harness = await import('./automation-harness.js');

import type { AutomationActor } from '../src/automation-contract.js';
import type { AutomationEngine } from '../src/automation-scheduler.js';

const WS = 'web:svc';
const HOST_WS = 'web:svc-host';
const OTHER_WS = 'web:svc-other';
const OWNER = 'alice';
const STRANGER = 'mallory';

const alice: AutomationActor = { kind: 'web', userId: OWNER, isAdmin: false };
const aliceAdmin: AutomationActor = {
  kind: 'web',
  userId: OWNER,
  isAdmin: true,
};
const mallory: AutomationActor = {
  kind: 'web',
  userId: STRANGER,
  isAdmin: true,
};
const ownerTurn: AutomationActor = {
  kind: 'owner_turn',
  userId: OWNER,
  isAdmin: false,
  workspaceJid: WS,
  sessionJid: `${WS}#agent:topic`,
  sourceRouteJid: 'feishu:oc_x#thread:omt_1',
};
const delegateTurn: AutomationActor = {
  kind: 'delegate_turn',
  ownerUserId: OWNER,
  ownerIsAdmin: true,
  workspaceJid: WS,
  sessionJid: `${WS}#agent:topic`,
  sourceRouteJid: 'qq:c2c:AAAA',
};
const memberTurn: AutomationActor = {
  kind: 'other_turn',
  workspaceJid: WS,
  sessionJid: WS,
};

beforeAll(() => {
  process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
  db.initDatabase();
  harness.seedWorkspace(db, { jid: WS, owner: OWNER });
  harness.seedWorkspace(db, { jid: HOST_WS, owner: OWNER, host: true });
  harness.seedWorkspace(db, { jid: OTHER_WS, owner: STRANGER });
});

afterAll(() => {
  db.closeDatabase();
  delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  store.deleteAutomations(store.listAutomations({}).map((a) => a.id));
});

function setup(
  overrides: Parameters<typeof harness.createFakeRuntime>[0] = {},
) {
  const clock = new harness.FakeClock(Date.parse('2026-10-30T00:00:00Z'));
  const runtime = harness.createFakeRuntime({
    allowsHostCommands: (jid) => jid === HOST_WS,
    ...overrides,
  });
  for (const jid of [WS, `${WS}#agent:topic`, HOST_WS, OTHER_WS])
    runtime.sessions.add(jid);
  const core = createAutomationCore(runtime.deps, { now: clock.now });
  return {
    clock,
    runtime,
    service: core.service,
    engine: core.scheduler as AutomationEngine,
  };
}

async function expectError(
  fn: () => unknown,
  status: number,
  message?: string | RegExp,
) {
  let caught: unknown;
  try {
    await fn();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AutomationError);
  expect((caught as InstanceType<typeof AutomationError>).status).toBe(status);
  if (message) expect((caught as Error).message).toMatch(message);
  expect((caught as Error).message).not.toMatch(/web:|feishu:|#agent:/);
}

describe('Web permissions', () => {
  test("another user's automation is hidden (404), even for an admin", async () => {
    const { service } = setup();
    const a = service.create(alice, { workspaceJid: WS, ...harness.draft() });
    expect(service.list(mallory)).toEqual([]);
    await expectError(() => service.get(mallory, a.id), 404, '自动化不存在');
    await expectError(
      () => service.update(mallory, a.id, a.revision, { name: 'x' }),
      404,
    );
    await expectError(() => service.pause(mallory, a.id), 404);
    await expectError(() => service.delete(mallory, a.id, 'keep'), 404);
    await expectError(() => service.runNow(mallory, a.id), 404);
    await expectError(() => service.listRuns(mallory, a.id), 404);
    await expectError(
      () =>
        service.create(alice, { workspaceJid: OTHER_WS, ...harness.draft() }),
      404,
      '工作区不存在',
    );
  });

  test('Host workspaces need an admin; commands need a host workspace', async () => {
    const { service } = setup();
    await expectError(
      () =>
        service.create(alice, { workspaceJid: HOST_WS, ...harness.draft() }),
      403,
    );
    const made = service.create(aliceAdmin, {
      workspaceJid: HOST_WS,
      ...harness.draft({ preRunCheck: { command: 'true' } }),
    });
    expect(made.preRunCheck).toEqual({ command: 'true', timeoutMs: null });
    await expectError(() => service.pause(alice, made.id), 403);
    await expectError(
      () =>
        service.create(aliceAdmin, {
          workspaceJid: WS,
          ...harness.draft({ preRunCheck: { command: 'true' } }),
        }),
      400,
      '宿主机工作区',
    );
  });

  test('validation: shared rules, cron syntax, bound target', async () => {
    const { service } = setup();
    await expectError(
      () =>
        service.create(alice, {
          workspaceJid: WS,
          ...harness.draft({
            schedule: { kind: 'cron', cronExpr: '0 0 9 * * *' },
          }),
        }),
      400,
      'Cron',
    );
    await expectError(
      () =>
        service.create(alice, {
          workspaceJid: WS,
          ...harness.draft({
            schedule: { kind: 'interval', intervalMs: 1000 },
          }),
        }),
      400,
      '1 分钟',
    );
    await expectError(
      () =>
        service.create(alice, {
          workspaceJid: WS,
          ...harness.draft({
            schedule: { kind: 'once', runAt: '2026-10-29T00:00:00Z' },
          }),
        }),
      400,
      '已经过去',
    );
    await expectError(
      () =>
        service.create(alice, {
          workspaceJid: WS,
          ...harness.draft({ sessionMode: 'bound' }),
          targetSessionJid: `${OTHER_WS}#agent:x`,
        }),
      400,
      '不属于',
    );
  });

  test('stale revisions are refused', async () => {
    const { service } = setup();
    const a = service.create(alice, { workspaceJid: WS, ...harness.draft() });
    const updated = service.update(alice, a.id, a.revision, { name: '周报' });
    expect(updated).toMatchObject({ name: '周报', revision: a.revision + 1 });
    await expectError(
      () => service.update(alice, a.id, a.revision, { name: '月报' }),
      409,
    );
  });

  test('a cadence edit and a resume count from now', () => {
    const { service, clock } = setup();
    const a = service.create(alice, {
      workspaceJid: WS,
      ...harness.draft({
        schedule: { kind: 'interval', intervalMs: 3_600_000 },
      }),
    });
    clock.advance(10 * 60_000);
    const edited = service.update(alice, a.id, a.revision, {
      schedule: { kind: 'interval', intervalMs: 7_200_000 },
    });
    expect(edited.nextFireAt).toBe('2026-10-30T02:10:00.000Z');
    const paused = service.pause(alice, a.id);
    expect(paused).toMatchObject({ status: 'paused', nextFireAt: null });
    clock.advance(60 * 60_000);
    expect(service.resume(alice, a.id).nextFireAt).toBe(
      '2026-10-30T03:10:00.000Z',
    );
  });
});

describe('agent turns', () => {
  test('owner turns create bound to the calling session and its route', async () => {
    const { service } = setup();
    const result = await service.handleIpc(ownerTurn, {
      type: 'automation_create',
      requestId: 'r1',
      name: '盯 PR',
      prompt: '看看 PR 状态',
      schedule: { kind: 'cron', cronExpr: '*/30 * * * *' },
      timestamp: '',
    });
    expect(result.success).toBe(true);
    expect(result.automation).toMatchObject({
      sessionMode: 'bound',
      targetSessionJid: `${WS}#agent:topic`,
      deliveryRouteJid: 'feishu:oc_x#thread:omt_1',
      createdBy: OWNER,
      workspaceJid: WS,
    });
  });

  test('other turns may only list', async () => {
    const { service } = setup();
    const a = service.create(alice, { workspaceJid: WS, ...harness.draft() });
    const listed = await service.handleIpc(memberTurn, {
      type: 'automation_list',
      requestId: 'l',
      timestamp: '',
    });
    expect(listed.automations?.map((x) => x.id)).toEqual([a.id]);
    for (const request of [
      { type: 'automation_pause', id: a.id },
      { type: 'automation_resume', id: a.id },
      { type: 'automation_delete', id: a.id },
      { type: 'automation_run_now', id: a.id },
      { type: 'automation_complete', id: a.id, reason: 'x' },
      {
        type: 'automation_update',
        id: a.id,
        expectedRevision: a.revision,
        patch: { name: 'x' },
      },
      {
        type: 'automation_create',
        name: 'x',
        prompt: 'y',
        schedule: { kind: 'manual' },
      },
    ] as const) {
      const result = await service.handleIpc(memberTurn, {
        ...request,
        requestId: request.type,
        timestamp: '',
      } as never);
      expect(result).toEqual({
        requestId: request.type,
        success: false,
        error: '只有工作区主人可以创建或修改自动化',
      });
    }
    expect(service.get(alice, a.id).status).toBe('active');
  });

  test("a delegate manages its workspace's automations; what it creates is the owner's", async () => {
    const { service } = setup();
    const created = await service.handleIpc(delegateTurn, {
      type: 'automation_create',
      requestId: 'c',
      name: '吃药提醒',
      prompt: '提醒吃药',
      schedule: { kind: 'cron', cronExpr: '0 20 * * *' },
      timestamp: '',
    });
    expect(created.success).toBe(true);
    expect(created.automation).toMatchObject({
      sessionMode: 'bound',
      targetSessionJid: `${WS}#agent:topic`,
      deliveryRouteJid: 'qq:c2c:AAAA',
      createdBy: OWNER,
      workspaceJid: WS,
    });
    const id = created.automation!.id;
    // It shows on the owner's Web page.
    expect(service.list(alice).map((a) => a.id)).toContain(id);
    const ownersOwn = service.create(alice, {
      workspaceJid: WS,
      ...harness.draft(),
    });
    for (const request of [
      { type: 'automation_list' },
      { type: 'automation_list_runs', id },
      {
        type: 'automation_update',
        id,
        expectedRevision: created.automation!.revision,
        patch: { name: '晚间吃药提醒' },
      },
      { type: 'automation_pause', id },
      { type: 'automation_resume', id },
      { type: 'automation_run_now', id: ownersOwn.id },
      { type: 'automation_delete', id },
    ] as const) {
      const result = await service.handleIpc(delegateTurn, {
        ...request,
        requestId: request.type,
        timestamp: '',
      } as never);
      expect(result).toMatchObject({ success: true });
    }
    expect(() => service.get(alice, id)).toThrow();
  });

  test('a delegate never touches host commands, Host workspaces or other workspaces', async () => {
    const { service } = setup();
    for (const extra of [
      { preRunCheck: { command: 'true' } },
      { execution: 'script', scriptCommand: 'echo hi' },
    ]) {
      const result = await service.handleIpc(delegateTurn, {
        type: 'automation_create',
        requestId: 'c',
        name: 'x',
        prompt: 'y',
        schedule: { kind: 'manual' },
        ...extra,
        timestamp: '',
      } as never);
      expect(result).toMatchObject({ success: false });
      expect(result.error).toContain('脚本与前置检查');
    }
    const plain = service.create(alice, {
      workspaceJid: WS,
      ...harness.draft(),
    });
    const patched = await service.handleIpc(delegateTurn, {
      type: 'automation_update',
      requestId: 'u',
      id: plain.id,
      expectedRevision: plain.revision,
      patch: { preRunCheck: { command: 'true' } },
      timestamp: '',
    });
    expect(patched.error).toContain('脚本与前置检查');

    // An automation with a host command (made while the workspace ran on
    // the host) stays the owner's to change.
    const withCheck = service.create(aliceAdmin, {
      workspaceJid: HOST_WS,
      ...harness.draft({ preRunCheck: { command: 'true' } }),
    });
    const onHost: AutomationActor = { ...delegateTurn, workspaceJid: HOST_WS };
    await expectError(
      () => service.pause(onHost, withCheck.id),
      403,
      '宿主机工作区',
    );
    await expectError(
      () =>
        service.create(onHost, {
          workspaceJid: HOST_WS,
          ...harness.draft(),
        }),
      403,
      '宿主机工作区',
    );
    // Seeded straight into the store: a container workspace row with a check.
    store.insertAutomation({
      ...service.get(alice, plain.id),
      id: 'legacy-check',
      preRunCheck: { command: 'true', timeoutMs: null },
    });
    await expectError(
      () => service.pause(delegateTurn, 'legacy-check'),
      403,
      '脚本与前置检查',
    );

    const foreign = service.create(mallory, {
      workspaceJid: OTHER_WS,
      ...harness.draft(),
    });
    await expectError(() => service.pause(delegateTurn, foreign.id), 404);
    expect(service.list(delegateTurn).every((a) => a.workspaceJid === WS)).toBe(
      true,
    );
  });

  test("a turn never sees another workspace's automations", async () => {
    const { service } = setup();
    const a = service.create(mallory, {
      workspaceJid: OTHER_WS,
      ...harness.draft(),
    });
    const result = await service.handleIpc(ownerTurn, {
      type: 'automation_pause',
      requestId: 'p',
      id: a.id,
      timestamp: '',
    });
    expect(result).toMatchObject({ success: false, error: '自动化不存在' });
  });

  test('a run may pause, complete or delete only its own automation', async () => {
    const { service, engine } = setup();
    const own = service.create(alice, {
      workspaceJid: WS,
      ...harness.draft({ schedule: { kind: 'manual' } }),
    });
    const other = service.create(alice, {
      workspaceJid: WS,
      ...harness.draft({ name: '另一个' }),
    });
    const run = await service.runNow(alice, own.id);
    await engine.idle();
    const actor: AutomationActor = {
      kind: 'automation_run',
      workspaceJid: WS,
      sessionJid: store.getAutomationRun(run.id)!.sessionJid!,
      automationId: own.id,
      runId: run.id,
    };
    const call = (request: Record<string, unknown>) =>
      service.handleIpc(actor, {
        requestId: 'x',
        timestamp: '',
        ...request,
      } as never);

    expect(
      (await call({ type: 'automation_pause', id: other.id })).error,
    ).toMatch('自己所属');
    expect(
      (await call({ type: 'automation_run_now', id: own.id })).success,
    ).toBe(false);
    expect(
      (
        await call({
          type: 'automation_create',
          name: 'x',
          prompt: 'y',
          schedule: { kind: 'manual' },
        })
      ).success,
    ).toBe(false);
    const done = await call({
      type: 'automation_complete',
      id: own.id,
      reason: '第 1–29 集已全部下载',
    });
    expect(done.automation).toMatchObject({
      status: 'completed',
      statusReason: '第 1–29 集已全部下载',
    });
    // Its own run finishes normally.
    expect(store.getAutomationRun(run.id)?.status).toBe('queued');
    service.runSink.onRunInputSettled(run.id, {
      status: 'success',
      resultText: '完成',
    });
    expect(store.getAutomationRun(run.id)?.status).toBe('success');
    expect(store.getAutomation(own.id)?.status).toBe('completed');
  });

  test('deleting its own automation from a run does not cancel that run', async () => {
    const { service, engine, runtime } = setup();
    const a = service.create(alice, {
      workspaceJid: WS,
      ...harness.draft({ schedule: { kind: 'manual' } }),
    });
    const run = await service.runNow(alice, a.id);
    await engine.idle();
    const stored = store.getAutomationRun(run.id)!;
    const result = await service.handleIpc(
      {
        kind: 'automation_run',
        workspaceJid: WS,
        sessionJid: stored.sessionJid!,
        automationId: a.id,
        runId: run.id,
      },
      { type: 'automation_delete', requestId: 'd', id: a.id, timestamp: '' },
    );
    expect(result.success).toBe(true);
    expect(runtime.cancelled).toEqual([]);
    expect(store.getAutomation(a.id)).toBeNull();
    // The settlement of the deleted run is ignored.
    service.runSink.onRunInputSettled(run.id, {
      status: 'success',
      resultText: null,
    });
  });

  test('the current-run tools need an automation run', async () => {
    const { service } = setup();
    const result = await service.handleIpc(ownerTurn, {
      type: 'automation_silence_current_run',
      requestId: 's',
      timestamp: '',
    });
    expect(result).toMatchObject({ success: false });
    expect(result.error).toMatch('不是自动化运行');
  });
});

describe('deletion and sessions', () => {
  test('delete from the Web cancels the live run and disposes run sessions', async () => {
    const { service, engine, runtime } = setup();
    const a = service.create(alice, {
      workspaceJid: WS,
      ...harness.draft({ schedule: { kind: 'manual' } }),
    });
    const run = await service.runNow(alice, a.id);
    await engine.idle();
    const sessionJid = store.getAutomationRun(run.id)!.sessionJid!;
    await service.delete(alice, a.id, 'delete');
    expect(runtime.cancelled).toEqual([
      { sessionJid, inputMessageId: runtime.injected[0].inputMessageId },
    ]);
    expect(runtime.deleted).toEqual([sessionJid]);
    expect(store.getAutomation(a.id)).toBeNull();
    expect(store.getAutomationRun(run.id)).toBeNull();
    expect(runtime.events.at(-1)).toMatchObject({
      type: 'automation_changed',
      automationId: a.id,
      deleted: true,
      ownerId: OWNER,
    });
  });

  test('a bound automation never disposes the session it borrows', async () => {
    const { service, runtime } = setup();
    const a = service.create(alice, {
      workspaceJid: WS,
      ...harness.draft({ sessionMode: 'bound' }),
      targetSessionJid: WS,
    });
    await service.delete(alice, a.id, 'delete');
    expect(runtime.deleted).toEqual([]);
  });

  test('a deleted session pauses bound automations and frees persistent ones', () => {
    const { service } = setup();
    const topic = `${WS}#agent:topic`;
    const bound = service.create(alice, {
      workspaceJid: WS,
      ...harness.draft({ sessionMode: 'bound' }),
      targetSessionJid: topic,
    });
    const persistent = service.create(alice, {
      workspaceJid: WS,
      ...harness.draft({ sessionMode: 'persistent' }),
      targetSessionJid: topic,
    });
    expect(service.listForSession(topic).map((a) => a.id)).toEqual([bound.id]);
    service.onSessionDeleted(topic);
    expect(store.getAutomation(bound.id)).toMatchObject({
      status: 'paused',
      statusReason: '绑定的会话已删除',
    });
    expect(store.getAutomation(persistent.id)).toMatchObject({
      status: 'active',
      targetSessionJid: null,
    });
  });

  test('automations survive a workspace rebuild', async () => {
    const { service, engine, clock } = setup();
    const topic = `${WS}#agent:topic`;
    const fresh = service.create(alice, {
      workspaceJid: WS,
      ...harness.draft({ schedule: { kind: 'manual' } }),
    });
    const bound = service.create(alice, {
      workspaceJid: WS,
      ...harness.draft({ name: 'bound', sessionMode: 'bound' }),
      targetSessionJid: topic,
    });
    const alreadyPaused = service.create(alice, {
      workspaceJid: WS,
      ...harness.draft({ name: 'paused' }),
    });
    service.pause(alice, alreadyPaused.id);
    const run = await service.runNow(alice, fresh.id);
    await engine.idle();

    const suspended = service.suspendWorkspace(WS);
    expect(suspended.sort()).toEqual([fresh.id, bound.id].sort());
    expect(store.getAutomationRun(run.id)).toMatchObject({
      status: 'cancelled',
    });
    expect(store.getAutomationRun(run.id)?.readAt).not.toBeNull();

    // The rebuild removed the topic session.
    service.onSessionDeleted(topic);
    clock.advance(60_000);
    service.restoreWorkspace(suspended);
    expect(store.getAutomation(fresh.id)?.status).toBe('active');
    expect(store.getAutomation(bound.id)).toMatchObject({
      status: 'paused',
      statusReason: '绑定的会话已删除',
    });
    expect(store.getAutomation(alreadyPaused.id)?.status).toBe('paused');
  });

  test('workspace deletion drops its automations', () => {
    const { service } = setup();
    const a = service.create(alice, { workspaceJid: WS, ...harness.draft() });
    service.onWorkspaceDeleted(WS);
    expect(store.getAutomation(a.id)).toBeNull();
  });
});

describe('runs', () => {
  test('run now refuses while a run is live, cancel withdraws the input', async () => {
    const { service, engine, runtime } = setup();
    const a = service.create(alice, {
      workspaceJid: WS,
      ...harness.draft({ schedule: { kind: 'manual' } }),
    });
    const run = await service.runNow(alice, a.id);
    await engine.idle();
    await expectError(() => service.runNow(alice, a.id), 409);
    await service.cancelRun(alice, a.id, run.id);
    expect(runtime.cancelled).toHaveLength(1);
    expect(store.getAutomationRun(run.id)?.status).toBe('cancelled');
    // Cancelling again is a no-op.
    await service.cancelRun(alice, a.id, run.id);
    expect(runtime.cancelled).toHaveLength(1);
  });

  test('mark read clears the unread count', async () => {
    const { service, engine } = setup();
    const a = service.create(alice, {
      workspaceJid: WS,
      ...harness.draft({ schedule: { kind: 'manual' } }),
    });
    const run = await service.runNow(alice, a.id);
    await engine.idle();
    service.runSink.onRunInputSettled(run.id, {
      status: 'failed',
      error: 'x',
    });
    expect(service.get(alice, a.id)).toMatchObject({
      unreadRuns: 1,
      lastRunStatus: 'failed',
      workspaceName: `WS ${WS}`,
    });
    service.markRunsRead(alice, a.id);
    expect(service.get(alice, a.id).unreadRuns).toBe(0);
  });
});

describe('session and route changes', () => {
  test('changing the target session clears the delivery route', () => {
    const { service } = setup();
    const a = service.create(ownerTurn, {
      workspaceJid: WS,
      ...harness.draft({ sessionMode: 'bound' }),
      targetSessionJid: `${WS}#agent:topic`,
    });
    expect(a.deliveryRouteJid).toBe('feishu:oc_x#thread:omt_1');
    const renamed = service.update(alice, a.id, a.revision, { name: '新名' });
    expect(renamed.deliveryRouteJid).toBe('feishu:oc_x#thread:omt_1');
    const moved = service.update(alice, a.id, renamed.revision, {
      targetSessionJid: WS,
    });
    expect(moved.deliveryRouteJid).toBeNull();
    const fresh = service.create(ownerTurn, {
      workspaceJid: WS,
      ...harness.draft(),
    });
    expect(fresh.deliveryRouteJid).toBe('feishu:oc_x#thread:omt_1');
    expect(
      service.update(alice, fresh.id, fresh.revision, {
        sessionMode: 'persistent',
      }).deliveryRouteJid,
    ).toBeNull();
  });

  test('the delete dialog uses every run session, not the trimmed run rows', async () => {
    const { service, runtime } = setup();
    const a = service.create(alice, {
      workspaceJid: WS,
      ...harness.draft({ schedule: { kind: 'manual' } }),
    });
    // Sessions whose run rows were trimmed long ago.
    for (const id of ['old1', 'old2']) {
      const sessionJid = `${WS}#agent:${id}`;
      runtime.sessions.add(sessionJid);
      runtime.created.push({ sessionJid, title: id, automationId: a.id });
    }
    runtime.archived.push(`${WS}#agent:old1`);
    await service.delete(alice, a.id, 'archive');
    // Already archived sessions are left alone.
    expect(runtime.archived).toEqual([`${WS}#agent:old1`, `${WS}#agent:old2`]);

    const b = service.create(alice, {
      workspaceJid: WS,
      ...harness.draft({ schedule: { kind: 'manual' } }),
    });
    const sessionJid = `${WS}#agent:old3`;
    runtime.sessions.add(sessionJid);
    runtime.created.push({ sessionJid, title: 'x', automationId: b.id });
    runtime.archived.push(sessionJid);
    await service.delete(alice, b.id, 'delete');
    expect(runtime.deleted).toEqual([sessionJid]);
  });

  test('suspend and session deletion also withdraw queued inputs', async () => {
    const { service, engine, runtime } = setup();
    const topic = `${WS}#agent:topic`;
    const queued = service.create(alice, {
      workspaceJid: WS,
      ...harness.draft({ sessionMode: 'bound', schedule: { kind: 'manual' } }),
      targetSessionJid: topic,
    });
    const running = service.create(alice, {
      workspaceJid: WS,
      ...harness.draft({
        name: 'r',
        sessionMode: 'bound',
        schedule: { kind: 'manual' },
      }),
      targetSessionJid: WS,
    });
    const q = await service.runNow(alice, queued.id);
    const r = await service.runNow(alice, running.id);
    await engine.idle();
    service.runSink.onRunInputStarted(r.id);

    service.onSessionDeleted(topic);
    await new Promise((resolve) => setImmediate(resolve));
    expect(store.getAutomationRun(q.id)?.status).toBe('cancelled');
    expect(runtime.cancelled.map((c) => c.inputMessageId)).toEqual([
      store.getAutomationRun(q.id)!.inputMessageId,
    ]);

    service.suspendWorkspace(WS);
    await new Promise((resolve) => setImmediate(resolve));
    expect(store.getAutomationRun(r.id)?.status).toBe('cancelled');
    // The running turn is not interrupted; the runtime drops it by isRunLive.
    expect(runtime.cancelled).toHaveLength(1);
  });

  test('a failing withdrawal is only logged', async () => {
    const { service, engine } = setup({
      cancelAutomationInput: async () => {
        throw new Error('gone');
      },
    });
    const a = service.create(alice, {
      workspaceJid: WS,
      ...harness.draft({ schedule: { kind: 'manual' } }),
    });
    const run = await service.runNow(alice, a.id);
    await engine.idle();
    await service.cancelRun(alice, a.id, run.id);
    expect(store.getAutomationRun(run.id)?.status).toBe('cancelled');
  });
});
