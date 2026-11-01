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

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-scheduler-'));
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
const scheduler = await import('../src/automation-scheduler.js');
const { createAutomationCore } = await import('../src/automation-service.js');
const harness = await import('./automation-harness.js');

import type { Automation } from '../src/automation.js';
import type { AutomationActor } from '../src/automation-contract.js';
import type { AutomationEngine } from '../src/automation-scheduler.js';

const WS = 'web:sched';
/** The session bound automations of this file run in. */
const BOUND = `${WS}#agent:bound`;
const OWNER = 'owner-1';
const web: AutomationActor = { kind: 'web', userId: OWNER, isAdmin: true };

beforeAll(() => {
  process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
  db.initDatabase();
  harness.seedWorkspace(db, { jid: WS, owner: OWNER, host: true });
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
  start = '2026-10-30T00:00:00.000Z',
  overrides: Parameters<typeof harness.createFakeRuntime>[0] = {},
) {
  const clock = new harness.FakeClock(Date.parse(start));
  const runtime = harness.createFakeRuntime(overrides);
  runtime.sessions.add(BOUND);
  const core = createAutomationCore(runtime.deps, {
    now: clock.now,
    scriptIdleTimeoutMs: () => 5_000,
  });
  const engine = core.scheduler as AutomationEngine;
  return { clock, runtime, core, engine, service: core.service };
}

function base(overrides: Partial<Automation> = {}) {
  return {
    schedule: { kind: 'cron', cronExpr: '0 9 * * *' },
    endAt: null,
    lastFinishedAt: null,
    createdAt: '2026-10-30T00:00:00.000Z',
    ...overrides,
  } as Automation;
}

describe('computeNextFireAt', () => {
  const now = new Date('2026-10-30T00:00:00.000Z'); // 08:00 in Shanghai

  test('cron uses the automation zone, else the scheduler zone', () => {
    expect(scheduler.computeNextFireAt(base(), now)).toBe(
      '2026-10-30T01:00:00.000Z',
    );
    expect(
      scheduler.computeNextFireAt(
        base({
          schedule: { kind: 'cron', cronExpr: '0 9 * * *', timezone: 'UTC' },
        }),
        now,
      ),
    ).toBe('2026-10-30T09:00:00.000Z');
  });

  test('cron counts from the later of now and the last finish', () => {
    const lastFinishedAt = '2026-10-30T02:00:00.000Z'; // after today 09:00 CST
    expect(scheduler.computeNextFireAt(base({ lastFinishedAt }), now)).toBe(
      '2026-10-31T01:00:00.000Z',
    );
    // `now` basis (resume, edits) ignores the last finish.
    expect(
      scheduler.computeNextFireAt(base({ lastFinishedAt }), now, 'now'),
    ).toBe('2026-10-30T01:00:00.000Z');
  });

  test('interval counts from the finish, the creation, or now', () => {
    const schedule = { kind: 'interval' as const, intervalMs: 3_600_000 };
    expect(
      scheduler.computeNextFireAt(
        base({ schedule, lastFinishedAt: '2026-10-30T05:00:00.000Z' }),
        now,
      ),
    ).toBe('2026-10-30T06:00:00.000Z');
    expect(
      scheduler.computeNextFireAt(
        base({ schedule, createdAt: '2026-10-29T23:30:00.000Z' }),
        now,
      ),
    ).toBe('2026-10-30T00:30:00.000Z');
    expect(
      scheduler.computeNextFireAt(
        base({ schedule, lastFinishedAt: '2026-10-29T00:00:00.000Z' }),
        now,
        'now',
      ),
    ).toBe('2026-10-30T01:00:00.000Z');
  });

  test('once is its run time, manual never fires, nothing after endAt', () => {
    const runAt = '2026-11-01T00:00:00.000Z';
    expect(
      scheduler.computeNextFireAt(
        base({ schedule: { kind: 'once', runAt } }),
        now,
      ),
    ).toBe(runAt);
    expect(
      scheduler.computeNextFireAt(base({ schedule: { kind: 'manual' } }), now),
    ).toBeNull();
    expect(
      scheduler.computeNextFireAt(
        base({ endAt: '2026-10-30T00:59:00.000Z' }),
        now,
      ),
    ).toBeNull();
    expect(
      scheduler.computeNextFireAt(
        base({ endAt: '2026-10-30T01:00:00.000Z' }),
        now,
      ),
    ).toBe('2026-10-30T01:00:00.000Z');
  });

  test('cron syntax: five fields, parseable', () => {
    expect(scheduler.isValidCronExpression('*/5 * * * *')).toBe(true);
    expect(scheduler.isValidCronExpression('0 0 9 * * *')).toBe(false);
    expect(scheduler.isValidCronExpression('61 * * * *')).toBe(false);
  });
});

describe('firing', () => {
  test('a due fire claims one run, hands it to the session and moves on', async () => {
    const { clock, runtime, engine, service } = setup();
    const a = service.create(web, { workspaceJid: WS, ...harness.draft() });
    expect(a.nextFireAt).toBe('2026-10-30T01:00:00.000Z');

    clock.set('2026-10-30T01:00:00.000Z');
    engine.tick();
    engine.tick();
    await engine.idle();

    const runs = store.listAutomationRuns(a.id, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: 'queued', trigger: 'schedule' });
    expect(runs[0].inputMessageId).toBe(runtime.injected[0].inputMessageId);
    expect(runtime.injected).toHaveLength(1);
    expect(runtime.injected[0].contextSuffix).toContain(runs[0].id);
    expect(runtime.injected[0].displayContent).toBe('整理今天的进展');
    expect(store.getAutomation(a.id)?.nextFireAt).toBe(
      '2026-10-31T01:00:00.000Z',
    );
  });

  test('the unique index refuses a second live run', () => {
    const { service } = setup();
    const a = service.create(web, { workspaceJid: WS, ...harness.draft() });
    const run = (id: string) => ({
      id,
      automationId: a.id,
      trigger: 'manual' as const,
      status: 'queued' as const,
      sessionJid: null,
      inputMessageId: null,
      scheduledFor: a.createdAt,
      firedAt: a.createdAt,
      finishedAt: null,
      resultText: null,
      error: null,
      preCheck: null,
      silenced: false,
      readAt: null,
      createdAt: a.createdAt,
    });
    store.insertAutomationRun(run('r1'));
    expect(() => store.insertAutomationRun(run('r2'))).toThrow();
  });

  test('a failing hand-off fails the run and leaves the schedule moving', async () => {
    const { clock, runtime, engine, service } = setup('2026-10-30T00:00:00Z', {
      injectAutomationInput: async () => {
        throw new Error('queue down');
      },
    });
    const a = service.create(web, { workspaceJid: WS, ...harness.draft() });
    clock.set('2026-10-30T01:00:00.000Z');
    engine.tick();
    await engine.idle();
    const [run] = store.listAutomationRuns(a.id, 10);
    expect(run.status).toBe('failed');
    expect(run.error).toContain('queue down');
    expect(store.getAutomation(a.id)?.nextFireAt).toBe(
      '2026-10-31T01:00:00.000Z',
    );
    expect(store.getLiveAutomationRun(a.id)).toBeNull();
    // No IM route: the failure is in the run record, no notice anywhere.
    expect(runtime.notices).toHaveLength(0);
  });

  test('a fire while a run is live is recorded as skipped', async () => {
    const { clock, engine, service } = setup();
    const a = service.create(web, {
      workspaceJid: WS,
      ...harness.draft({ schedule: { kind: 'cron', cronExpr: '*/5 * * * *' } }),
    });
    clock.set('2026-10-30T00:05:00.000Z');
    engine.tick();
    await engine.idle();
    clock.set('2026-10-30T00:10:00.000Z');
    engine.tick();
    await engine.idle();
    const runs = store.listAutomationRuns(a.id, 10);
    expect(runs.map((r) => r.status)).toEqual(['skipped', 'queued']);
    expect(runs[0].error).toBe('上一次运行还没结束');
    expect(runs[0].readAt).not.toBeNull();
    expect(store.getAutomation(a.id)?.nextFireAt).toBe(
      '2026-10-30T00:15:00.000Z',
    );
  });

  test('interval waits for the finish', async () => {
    const { clock, engine, service } = setup();
    const a = service.create(web, {
      workspaceJid: WS,
      ...harness.draft({
        schedule: { kind: 'interval', intervalMs: 3_600_000 },
      }),
    });
    expect(a.nextFireAt).toBe('2026-10-30T01:00:00.000Z');
    clock.set('2026-10-30T01:00:00.000Z');
    engine.tick();
    await engine.idle();
    expect(store.getAutomation(a.id)?.nextFireAt).toBeNull();
    const [run] = store.listAutomationRuns(a.id, 1);
    service.runSink.onRunInputStarted(run.id);
    clock.set('2026-10-30T01:20:00.000Z');
    service.runSink.onRunInputSettled(run.id, {
      status: 'success',
      resultText: 'ok',
    });
    expect(store.getAutomationRun(run.id)?.status).toBe('success');
    expect(store.getAutomation(a.id)?.nextFireAt).toBe(
      '2026-10-30T02:20:00.000Z',
    );
    // A late duplicate settlement is a no-op.
    service.runSink.onRunInputSettled(run.id, {
      status: 'failed',
      error: 'late',
    });
    expect(store.getAutomationRun(run.id)?.status).toBe('success');
  });

  test('once completes after its run; a manual run does not complete it', async () => {
    const { clock, engine, service } = setup();
    const a = service.create(web, {
      workspaceJid: WS,
      ...harness.draft({
        schedule: { kind: 'once', runAt: '2026-10-30T03:00:00Z' },
      }),
    });
    const manual = await service.runNow(web, a.id);
    await engine.idle();
    service.runSink.onRunInputSettled(manual.id, {
      status: 'success',
      resultText: null,
    });
    expect(store.getAutomation(a.id)?.status).toBe('active');

    clock.set('2026-10-30T03:00:00.000Z');
    engine.tick();
    await engine.idle();
    const [run] = store.listAutomationRuns(a.id, 1);
    service.runSink.onRunInputSettled(run.id, {
      status: 'failed',
      error: 'x',
    });
    expect(store.getAutomation(a.id)).toMatchObject({
      status: 'completed',
      statusReason: '一次性运行已完成',
      nextFireAt: null,
    });
  });

  test('a due once waits for a live manual run instead of being skipped', async () => {
    const { clock, engine, service } = setup();
    const a = service.create(web, {
      workspaceJid: WS,
      ...harness.draft({
        schedule: { kind: 'once', runAt: '2026-10-30T03:00:00Z' },
      }),
    });
    const manual = await service.runNow(web, a.id);
    await engine.idle();
    clock.set('2026-10-30T03:00:00.000Z');
    engine.tick();
    expect(store.listAutomationRuns(a.id, 10)).toHaveLength(1);
    // Not a reason to wake while the manual run is live.
    expect(store.getNextAutomationWakeAt()).toBeNull();
    service.runSink.onRunInputSettled(manual.id, {
      status: 'success',
      resultText: null,
    });
    engine.tick();
    await engine.idle();
    const runs = store.listAutomationRuns(a.id, 10);
    expect(runs.map((r) => [r.trigger, r.status])).toEqual([
      ['schedule', 'queued'],
      ['manual', 'success'],
    ]);
  });

  test('endAt is enforced and completes the automation', async () => {
    const { clock, engine, service, runtime } = setup();
    const a = service.create(web, {
      workspaceJid: WS,
      ...harness.draft({ endAt: '2026-10-31T00:00:00Z' }),
    });
    expect(a.nextFireAt).toBe('2026-10-30T01:00:00.000Z');
    clock.set('2026-10-30T01:00:00.000Z');
    engine.tick();
    await engine.idle();
    // The next 09:00 is past the end: no next fire.
    expect(store.getAutomation(a.id)?.nextFireAt).toBeNull();
    clock.set('2026-10-31T00:00:00.000Z');
    engine.tick();
    expect(store.getAutomation(a.id)).toMatchObject({
      status: 'completed',
      statusReason: '已到结束时间',
    });
    expect(runtime.injected).toHaveLength(1);
  });

  test('billing denial fails the run without a turn', async () => {
    const { clock, engine, service, runtime } = setup('2026-10-30T00:00:00Z', {
      checkBilling: () => ({ ok: false, reason: '余额不足' }),
    });
    const a = service.create(web, { workspaceJid: WS, ...harness.draft() });
    clock.set('2026-10-30T01:00:00.000Z');
    engine.tick();
    await engine.idle();
    expect(store.listAutomationRuns(a.id, 1)[0]).toMatchObject({
      status: 'failed',
      error: '余额不足',
    });
    expect(runtime.injected).toHaveLength(0);
  });

  test('a bound run whose session is gone fails and pauses', async () => {
    const { clock, engine, service, runtime } = setup();
    runtime.sessions.add(`${WS}#agent:b1`);
    const a = service.create(web, {
      workspaceJid: WS,
      ...harness.draft({ sessionMode: 'bound' }),
      targetSessionJid: `${WS}#agent:b1`,
    });
    runtime.sessions.delete(`${WS}#agent:b1`);
    clock.set('2026-10-30T01:00:00.000Z');
    engine.tick();
    await engine.idle();
    expect(store.listAutomationRuns(a.id, 1)[0].status).toBe('failed');
    expect(store.getAutomation(a.id)).toMatchObject({
      status: 'paused',
      statusReason: '绑定的会话已不存在',
    });
  });

  test('bound runs answer on the delivery route; fresh runs only on the Web', async () => {
    const { clock, engine, service, runtime } = setup();
    const route = 'feishu:oc_1#thread:t1';
    const owner: AutomationActor = {
      kind: 'owner_turn',
      userId: OWNER,
      isAdmin: true,
      workspaceJid: WS,
      sessionJid: BOUND,
      sourceRouteJid: route,
    };
    const bound = service.create(owner, {
      workspaceJid: WS,
      ...harness.draft({ sessionMode: 'bound' }),
      targetSessionJid: BOUND,
    });
    expect(bound.deliveryRouteJid).toBe(route);
    const fresh = service.create(owner, {
      workspaceJid: WS,
      ...harness.draft(),
    });
    expect(fresh.deliveryRouteJid).toBe(route);
    clock.set('2026-10-30T01:00:00.000Z');
    engine.tick();
    await engine.idle();
    const byAutomation = new Map(
      runtime.injected.map((i) => [i.automation.id, i]),
    );
    expect(byAutomation.get(bound.id)).toMatchObject({
      sessionJid: BOUND,
      deliveryRouteJid: route,
    });
    expect(byAutomation.get(fresh.id)?.deliveryRouteJid).toBeNull();
    expect(byAutomation.get(fresh.id)?.sessionJid).toMatch(/#agent:/);
  });
});

describe('sessions', () => {
  test('fresh mode keeps the newest 20 sessions', async () => {
    const { clock, engine, service, runtime } = setup();
    const a = service.create(web, {
      workspaceJid: WS,
      ...harness.draft({ schedule: { kind: 'manual' } }),
    });
    for (let i = 0; i < 22; i += 1) {
      clock.advance(60_000);
      const run = await service.runNow(web, a.id);
      await engine.idle();
      service.runSink.onRunInputSettled(run.id, {
        status: 'success',
        resultText: null,
      });
    }
    expect(runtime.created).toHaveLength(22);
    const archived = [...new Set(runtime.archived)];
    expect(archived.sort()).toEqual(
      runtime.created
        .slice(0, 2)
        .map((c) => c.sessionJid)
        .sort(),
    );
  });

  test('persistent mode reuses its session and recreates a lost one', async () => {
    const { clock, engine, service, runtime } = setup();
    const a = service.create(web, {
      workspaceJid: WS,
      ...harness.draft({
        sessionMode: 'persistent',
        schedule: { kind: 'manual' },
      }),
    });
    const settle = async () => {
      clock.advance(60_000);
      const run = await service.runNow(web, a.id);
      await engine.idle();
      service.runSink.onRunInputSettled(run.id, {
        status: 'success',
        resultText: null,
      });
    };
    await settle();
    await settle();
    expect(runtime.created).toHaveLength(1);
    expect(new Set(runtime.injected.map((i) => i.sessionJid)).size).toBe(1);
    service.onSessionDeleted(runtime.created[0].sessionJid);
    runtime.sessions.delete(runtime.created[0].sessionJid);
    await settle();
    expect(runtime.created).toHaveLength(2);
    expect(store.getAutomation(a.id)?.targetSessionJid).toBe(
      runtime.created[1].sessionJid,
    );
  });
});

describe('history', () => {
  test('keeps the newest runs of an automation', () => {
    const { service } = setup();
    const a = service.create(web, { workspaceJid: WS, ...harness.draft() });
    const row = (i: number, status: 'success' | 'queued') => ({
      id: `h${i}`,
      automationId: a.id,
      trigger: 'schedule' as const,
      status,
      sessionJid: null,
      inputMessageId: null,
      scheduledFor: a.createdAt,
      firedAt: a.createdAt,
      finishedAt: null,
      resultText: null,
      error: null,
      preCheck: null,
      silenced: false,
      readAt: null,
      createdAt: new Date(Date.parse(a.createdAt) + i * 1000).toISOString(),
    });
    // The oldest row is live and must survive any trim.
    store.insertAutomationRun(row(0, 'queued'));
    for (let i = 1; i <= 5; i += 1)
      store.insertAutomationRun(row(i, 'success'));
    store.trimAutomationRuns(a.id, 3);
    expect(
      store
        .listAutomationRuns(a.id, 10)
        .map((r) => r.id)
        .sort(),
    ).toEqual(['h0', 'h3', 'h4', 'h5']);
  });
});

describe('notices', () => {
  test('a failure streak notifies once, the next success announces recovery', async () => {
    const { clock, engine, service, runtime } = setup();
    const route = 'feishu:oc_2';
    const a = service.create(
      {
        kind: 'owner_turn',
        userId: OWNER,
        isAdmin: true,
        workspaceJid: WS,
        sessionJid: BOUND,
        sourceRouteJid: route,
      },
      { workspaceJid: WS, ...harness.draft({ schedule: { kind: 'manual' } }) },
    );
    const runOnce = async (
      outcome: Parameters<typeof service.runSink.onRunInputSettled>[1],
    ) => {
      clock.advance(60_000);
      const run = await service.runNow(web, a.id);
      await engine.idle();
      service.runSink.onRunInputSettled(run.id, outcome);
      await new Promise((resolve) => setImmediate(resolve));
    };
    await runOnce({ status: 'failed', error: 'HTTP 500 after 12 s' });
    await runOnce({ status: 'failed', error: 'HTTP 500 after 31 s' });
    await runOnce({ status: 'failed', error: 'HTTP 500 after 7 s' });
    expect(runtime.notices).toHaveLength(1);
    expect(runtime.notices[0]).toMatchObject({ routeJid: route });
    expect(runtime.notices[0].text).toContain('运行失败');

    await runOnce({ status: 'success', resultText: '全部完成' });
    expect(runtime.notices.map((n) => n.text)).toEqual([
      expect.stringContaining('运行失败'),
      '自动化「日报」已恢复正常',
      '自动化「日报」已完成：全部完成',
    ]);
    await runOnce({ status: 'success', resultText: '又完成' });
    expect(runtime.notices).toHaveLength(4);
  });

  test('a quiet run is born read and silent until it escalates', async () => {
    const { clock, engine, service, runtime } = setup();
    const a = service.create(
      {
        kind: 'owner_turn',
        userId: OWNER,
        isAdmin: true,
        workspaceJid: WS,
        sessionJid: BOUND,
        sourceRouteJid: 'feishu:oc_3',
      },
      {
        workspaceJid: WS,
        ...harness.draft({
          schedule: { kind: 'manual' },
          silentWhenIdle: true,
        }),
      },
    );
    const quiet = await service.runNow(web, a.id);
    await engine.idle();
    expect(service.runSink.isRunSilenced(quiet.id)).toBe(true);
    service.runSink.onRunInputSettled(quiet.id, {
      status: 'success',
      resultText: '无变化',
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(store.getAutomationRun(quiet.id)?.readAt).not.toBeNull();
    expect(service.get(web, a.id).unreadRuns).toBe(0);
    expect(runtime.notices).toHaveLength(0);

    clock.advance(60_000);
    const loud = await service.runNow(web, a.id);
    await engine.idle();
    const result = await service.handleIpc(
      {
        kind: 'automation_run',
        workspaceJid: WS,
        sessionJid: loud.sessionJid ?? BOUND,
        automationId: a.id,
        runId: loud.id,
      },
      {
        type: 'automation_notify_current_run',
        requestId: 'n1',
        timestamp: clock.iso(),
      },
    );
    expect(result.success).toBe(true);
    expect(service.runSink.isRunSilenced(loud.id)).toBe(false);
    service.runSink.onRunInputSettled(loud.id, {
      status: 'success',
      resultText: '发现新版本',
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(service.get(web, a.id).unreadRuns).toBe(1);
    expect(runtime.notices).toHaveLength(1);
  });
});

describe('startup', () => {
  test('missed recurring fires are recorded once; a due once backfills', async () => {
    const { clock, engine, service, runtime } = setup();
    const cron = service.create(web, { workspaceJid: WS, ...harness.draft() });
    const once = service.create(web, {
      workspaceJid: WS,
      ...harness.draft({
        name: '一次',
        schedule: { kind: 'once', runAt: '2026-10-30T02:00:00Z' },
      }),
    });
    // The service was down for two days.
    clock.set('2026-11-01T05:00:00.000Z');
    engine.start();
    await engine.idle();
    await engine.stop();

    const cronRuns = store.listAutomationRuns(cron.id, 10);
    expect(cronRuns).toHaveLength(1);
    expect(cronRuns[0]).toMatchObject({
      status: 'missed',
      scheduledFor: '2026-10-30T01:00:00.000Z',
    });
    expect(store.getAutomation(cron.id)?.nextFireAt).toBe(
      '2026-11-02T01:00:00.000Z',
    );
    const onceRuns = store.listAutomationRuns(once.id, 10);
    expect(onceRuns).toHaveLength(1);
    expect(onceRuns[0]).toMatchObject({
      trigger: 'backfill',
      status: 'queued',
    });
    expect(runtime.injected.map((i) => i.automation.id)).toEqual([once.id]);
  });

  test('runs whose input is gone are interrupted; pending ones stay', async () => {
    const { engine, service, runtime } = setup();
    const keep = service.create(web, {
      workspaceJid: WS,
      ...harness.draft({ schedule: { kind: 'manual' } }),
    });
    const lose = service.create(web, {
      workspaceJid: WS,
      ...harness.draft({ name: 'b', schedule: { kind: 'manual' } }),
    });
    const kept = await service.runNow(web, keep.id);
    const lost = await service.runNow(web, lose.id);
    await engine.idle();
    const lostInput = store.getAutomationRun(lost.id)!.inputMessageId!;
    runtime.pendingInputs.delete(lostInput);
    // A claim that crashed before the hand-off: no input id.
    const orphan = service.create(web, {
      workspaceJid: WS,
      ...harness.draft({ name: 'c', schedule: { kind: 'manual' } }),
    });
    store.insertAutomationRun({
      ...store.getAutomationRun(kept.id)!,
      id: 'orphan-run',
      automationId: orphan.id,
      inputMessageId: null,
      status: 'queued',
    });

    engine.start();
    await engine.stop();
    expect(store.getAutomationRun(kept.id)?.status).toBe('queued');
    expect(store.getAutomationRun(lost.id)).toMatchObject({
      status: 'interrupted',
      error: '服务重启，运行已中断',
    });
    expect(store.getAutomationRun('orphan-run')?.status).toBe('interrupted');
  });

  test('migrated automations without a next fire get one from now', async () => {
    const { clock, engine, service } = setup();
    const a = service.create(web, {
      workspaceJid: WS,
      ...harness.draft({ schedule: { kind: 'interval', intervalMs: 600_000 } }),
    });
    store.saveAutomation({ ...store.getAutomation(a.id)!, nextFireAt: null });
    clock.advance(3_600_000);
    engine.start();
    await engine.stop();
    expect(store.getAutomation(a.id)?.nextFireAt).toBe(
      new Date(clock.ms + 600_000).toISOString(),
    );
    expect(store.listAutomationRuns(a.id, 10)).toHaveLength(0);
  });
});

describe('host commands', () => {
  test('pre-run check: 0 runs with its output, 2 skips, other fails', async () => {
    const { engine, service, runtime, clock } = setup();
    const make = (name: string, command: string) =>
      service.create(web, {
        workspaceJid: WS,
        ...harness.draft({
          name,
          schedule: { kind: 'manual' },
          preRunCheck: { command },
        }),
      });
    const go = make('go', 'echo found-3-items');
    const skip = make('skip', 'exit 2');
    const fail = make('fail', 'echo boom >&2; exit 1');
    for (const a of [go, skip, fail]) {
      clock.advance(1000);
      await service.runNow(web, a.id);
    }
    await engine.idle();
    expect(runtime.injected.map((i) => i.automation.id)).toEqual([go.id]);
    expect(runtime.injected[0].contextSuffix).toContain('found-3-items');
    expect(store.listAutomationRuns(skip.id, 1)[0]).toMatchObject({
      status: 'skipped',
      preCheck: expect.objectContaining({ decision: 'skip', exitCode: 2 }),
    });
    expect(store.listAutomationRuns(skip.id, 1)[0].readAt).not.toBeNull();
    const failed = store.listAutomationRuns(fail.id, 1)[0];
    expect(failed.status).toBe('failed');
    expect(failed.error).toContain('退出码 1');
    expect(failed.error).toContain('boom');
  });

  test('pre-run checks and scripts need a host workspace at run time', async () => {
    let allowed = true;
    const { engine, service, runtime } = setup('2026-10-30T00:00:00Z', {
      allowsHostCommands: () => allowed,
    });
    const a = service.create(web, {
      workspaceJid: WS,
      ...harness.draft({
        schedule: { kind: 'manual' },
        preRunCheck: { command: 'true' },
      }),
    });
    allowed = false;
    const run = await service.runNow(web, a.id);
    await engine.idle();
    expect(store.getAutomationRun(run.id)?.error).toBe(
      '脚本和前置检查只能在管理员的宿主机工作区使用',
    );
    expect(runtime.injected).toHaveLength(0);
  });

  test('a script posts its output into the session', async () => {
    const { engine, service, runtime } = setup();
    const ok = service.create(web, {
      workspaceJid: WS,
      ...harness.draft({
        name: 'ok',
        prompt: null,
        execution: 'script',
        scriptCommand: 'echo "$HAPPYCLAW_AUTOMATION_NAME done"',
        sessionMode: 'bound',
        schedule: { kind: 'manual' },
      }),
      targetSessionJid: BOUND,
    });
    const bad = service.create(web, {
      workspaceJid: WS,
      ...harness.draft({
        name: 'bad',
        prompt: null,
        execution: 'script',
        scriptCommand: 'echo partial; exit 3',
        sessionMode: 'bound',
        schedule: { kind: 'manual' },
      }),
      targetSessionJid: BOUND,
    });
    await service.runNow(web, ok.id);
    await service.runNow(web, bad.id);
    await engine.idle();
    expect(store.listAutomationRuns(ok.id, 1)[0]).toMatchObject({
      status: 'success',
      resultText: 'ok done',
    });
    expect(store.listAutomationRuns(bad.id, 1)[0]).toMatchObject({
      status: 'failed',
      error: '脚本退出码 3',
    });
    expect(runtime.scripts.map((s) => s.text).sort()).toEqual([
      'ok done',
      '⚠️ 脚本退出码 3\n\npartial',
    ]);
    expect(runtime.injected).toHaveLength(0);
  });

  test('cancelling a running script kills it and records cancelled', async () => {
    const { engine, service, runtime } = setup();
    const a = service.create(web, {
      workspaceJid: WS,
      ...harness.draft({
        prompt: null,
        execution: 'script',
        scriptCommand: 'sleep 30',
        sessionMode: 'bound',
        schedule: { kind: 'manual' },
      }),
      targetSessionJid: BOUND,
    });
    const run = await service.runNow(web, a.id);
    await vi.waitFor(() =>
      expect(store.getAutomationRun(run.id)?.status).toBe('running'),
    );
    await service.cancelRun(web, a.id, run.id);
    await engine.idle();
    expect(store.getAutomationRun(run.id)).toMatchObject({
      status: 'cancelled',
      error: '已手动终止',
    });
    expect(runtime.scripts).toHaveLength(0);
  });
});

describe('run lifecycle fixes', () => {
  test('a cancelled pre-run check is killed at once and creates no session', async () => {
    const { engine, service, runtime } = setup();
    const a = service.create(web, {
      workspaceJid: WS,
      ...harness.draft({
        schedule: { kind: 'manual' },
        preRunCheck: { command: 'sleep 30', timeoutMs: 600_000 },
      }),
    });
    const run = await service.runNow(web, a.id);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const started = Date.now();
    await service.cancelRun(web, a.id, run.id);
    await engine.idle();
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(store.getAutomationRun(run.id)?.status).toBe('cancelled');
    expect(runtime.created).toHaveLength(0);
    expect(runtime.injected).toHaveLength(0);
  });

  test('stop() is not held up by a running pre-run check', async () => {
    const { engine, service } = setup();
    const a = service.create(web, {
      workspaceJid: WS,
      ...harness.draft({
        schedule: { kind: 'manual' },
        preRunCheck: { command: 'sleep 30', timeoutMs: 600_000 },
      }),
    });
    engine.start();
    await service.runNow(web, a.id);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const started = Date.now();
    await engine.stop();
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test('the pre-run check runs in the workspace before any session exists', async () => {
    const workdirs: Array<string | null> = [];
    const { engine, service, runtime } = setup('2026-10-30T00:00:00Z', {
      resolveWorkdir: (_automation, sessionJid) => {
        workdirs.push(sessionJid);
        return os.tmpdir();
      },
    });
    const skip = service.create(web, {
      workspaceJid: WS,
      ...harness.draft({
        schedule: { kind: 'manual' },
        preRunCheck: { command: 'exit 2' },
      }),
    });
    const go = service.create(web, {
      workspaceJid: WS,
      ...harness.draft({
        name: 'go',
        schedule: { kind: 'manual' },
        preRunCheck: { command: 'true' },
      }),
    });
    await service.runNow(web, skip.id);
    await engine.idle();
    expect(runtime.created).toHaveLength(0);
    await service.runNow(web, go.id);
    await engine.idle();
    expect(workdirs).toEqual([null, null]);
    expect(runtime.created).toHaveLength(1);
    expect(runtime.injected).toHaveLength(1);
  });

  test('a bound run checks in its target session directory', async () => {
    const workdirs: Array<string | null> = [];
    const { engine, service } = setup('2026-10-30T00:00:00Z', {
      resolveWorkdir: (_automation, sessionJid) => {
        workdirs.push(sessionJid);
        return os.tmpdir();
      },
    });
    const a = service.create(web, {
      workspaceJid: WS,
      ...harness.draft({
        schedule: { kind: 'manual' },
        sessionMode: 'bound',
        preRunCheck: { command: 'exit 2' },
      }),
      targetSessionJid: BOUND,
    });
    await service.runNow(web, a.id);
    await engine.idle();
    expect(workdirs).toEqual([BOUND]);
  });

  test('a billing denial creates no session', async () => {
    const { engine, service, runtime } = setup('2026-10-30T00:00:00Z', {
      checkBilling: () => ({ ok: false, reason: '余额不足' }),
    });
    const a = service.create(web, {
      workspaceJid: WS,
      ...harness.draft({ schedule: { kind: 'manual' } }),
    });
    await service.runNow(web, a.id);
    await engine.idle();
    expect(runtime.created).toHaveLength(0);
  });

  test('old fresh sessions are archived only after a successful hand-off, awaited', async () => {
    let failInject = false;
    let seq = 0;
    const { engine, service, runtime, clock } = setup('2026-10-30T00:00:00Z', {
      injectAutomationInput: async () => {
        if (failInject) throw new Error('queue down');
        return { inputMessageId: `in-${++seq}` };
      },
      archiveAutomationSession: async (jid) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        runtime.archived.push(jid);
      },
    });
    const a = service.create(web, {
      workspaceJid: WS,
      ...harness.draft({ schedule: { kind: 'manual' } }),
    });
    const runOnce = async () => {
      clock.advance(60_000);
      const run = await service.runNow(web, a.id);
      await engine.idle();
      service.runSink.onRunInputSettled(run.id, {
        status: 'success',
        resultText: null,
      });
    };
    for (let i = 0; i < 20; i += 1) await runOnce();
    expect(runtime.archived).toEqual([]);
    failInject = true;
    await runOnce();
    // The 21st session exists but its hand-off failed: nothing archived.
    expect(runtime.archived).toEqual([]);
    failInject = false;
    await runOnce();
    // Awaited inside the run: done by the time the run is idle.
    expect(runtime.archived.sort()).toEqual(
      runtime.created
        .slice(0, 2)
        .map((c) => c.sessionJid)
        .sort(),
    );
  });

  test('isRunLive follows the run row', async () => {
    const { engine, service } = setup();
    const a = service.create(web, {
      workspaceJid: WS,
      ...harness.draft({ schedule: { kind: 'manual' } }),
    });
    const run = await service.runNow(web, a.id);
    await engine.idle();
    expect(service.runSink.isRunLive(run.id)).toBe(true);
    service.runSink.onRunInputSettled(run.id, {
      status: 'success',
      resultText: null,
    });
    expect(service.runSink.isRunLive(run.id)).toBe(false);
    expect(service.runSink.isRunLive('unknown')).toBe(false);
  });

  test('the delivery route is resolved at fire time and for every notice', async () => {
    const calls: Array<{
      sessionJid: string | null;
      preferred: string | null;
    }> = [];
    let resolved: string | null = 'feishu:oc_new';
    const { engine, service, runtime, clock } = setup('2026-10-30T00:00:00Z', {
      resolveDeliveryRoute: ({ sessionJid, preferredRouteJid }) => {
        calls.push({ sessionJid, preferred: preferredRouteJid });
        return resolved;
      },
    });
    const owner: AutomationActor = {
      kind: 'owner_turn',
      userId: OWNER,
      isAdmin: true,
      workspaceJid: WS,
      sessionJid: BOUND,
      sourceRouteJid: 'feishu:oc_old',
    };
    const bound = service.create(owner, {
      workspaceJid: WS,
      ...harness.draft({ sessionMode: 'bound', schedule: { kind: 'manual' } }),
      targetSessionJid: BOUND,
    });
    const run = await service.runNow(web, bound.id);
    await engine.idle();
    expect(runtime.injected[0].deliveryRouteJid).toBe('feishu:oc_new');
    expect(calls[0]).toEqual({ sessionJid: BOUND, preferred: 'feishu:oc_old' });
    service.runSink.onRunInputSettled(run.id, {
      status: 'failed',
      error: 'boom',
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(runtime.notices.at(-1)?.routeJid).toBe('feishu:oc_new');

    // Unbound meanwhile: the failure stays in the run record, and nothing is
    // written into any session.
    resolved = null;
    const fresh = service.create(owner, {
      workspaceJid: WS,
      ...harness.draft({ name: 'f', schedule: { kind: 'manual' } }),
    });
    clock.advance(60_000);
    const freshRun = await service.runNow(web, fresh.id);
    await engine.idle();
    const noticesBeforeFailure = runtime.notices.length;
    service.runSink.onRunInputSettled(freshRun.id, {
      status: 'failed',
      error: 'boom',
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(runtime.notices).toHaveLength(noticesBeforeFailure);
    expect(store.getAutomationRun(freshRun.id)).toMatchObject({
      status: 'failed',
      error: 'boom',
    });
    // No IM route: neither the recovery nor a fresh result is announced.
    const before = runtime.notices.length;
    clock.advance(60_000);
    const ok = await service.runNow(web, fresh.id);
    await engine.idle();
    service.runSink.onRunInputSettled(ok.id, {
      status: 'success',
      resultText: 'done',
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(runtime.notices.slice(before)).toEqual([]);
  });
});
