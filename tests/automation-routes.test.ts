import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'automation-routes-'));
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
vi.mock('../src/middleware/auth.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../src/middleware/auth.js')>();
  return {
    ...actual,
    authMiddleware: async (c: any, next: any) => {
      c.set('user', {
        id: process.env.HAPPYCLAW_TEST_USER_ID ?? 'alice',
        username: 'u',
        role: 'member',
        status: 'active',
        permissions: [],
      });
      return next();
    },
  };
});

const db = await import('../src/db.js');
const routes = await import('../src/routes/automations.js');
const tasksRoutes = (await import('../src/routes/tasks.js')).default;
const { createAutomationCore } = await import('../src/automation-service.js');
const harness = await import('./automation-harness.js');

import type { AutomationEngine } from '../src/automation-scheduler.js';

const WS = 'web:rest';
const SESSION = `${WS}#agent:rest-session`;
const app = new Hono();
app.route('/api/automations', routes.default);
app.route('/api/tasks', tasksRoutes);

const runtime = harness.createFakeRuntime();
runtime.sessions.add(SESSION);
const clock = new harness.FakeClock(Date.parse('2026-10-30T00:00:00Z'));
const core = createAutomationCore(runtime.deps, { now: clock.now });
const engine = core.scheduler as AutomationEngine;

beforeAll(() => {
  process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
  db.initDatabase();
  harness.seedWorkspace(db, { jid: WS, owner: 'alice' });
});

afterAll(() => {
  routes.setAutomationService(null);
  db.closeDatabase();
  delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
  delete process.env.HAPPYCLAW_TEST_USER_ID;
  fs.rmSync(root, { recursive: true, force: true });
});

function as(user: string) {
  process.env.HAPPYCLAW_TEST_USER_ID = user;
}

async function call(method: string, url: string, body?: unknown) {
  const res = await app.request(url, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

describe('/api/automations', () => {
  test('503 until the service is injected', async () => {
    as('alice');
    expect((await call('GET', '/api/automations')).status).toBe(503);
    routes.setAutomationService(core.service);
  });

  test('the REST contract', async () => {
    as('alice');
    const created = await call('POST', '/api/automations', {
      workspaceJid: WS,
      ...harness.draft({ schedule: { kind: 'manual' } }),
    });
    expect(created.status).toBe(201);
    const { automation } = created.body;
    expect(automation).toMatchObject({ name: '日报', unreadRuns: 0 });

    const list = await call('GET', `/api/automations?workspace=${WS}`);
    expect(list.body.automations.map((a: { id: string }) => a.id)).toEqual([
      automation.id,
    ]);

    const run = await call('POST', `/api/automations/${automation.id}/run`);
    expect(run.status).toBe(202);
    await engine.idle();
    expect(
      (await call('POST', `/api/automations/${automation.id}/run`)).status,
    ).toBe(409);

    const detail = await call('GET', `/api/automations/${automation.id}`);
    expect(detail.body.automation.id).toBe(automation.id);
    expect(detail.body.runs).toHaveLength(1);
    expect(
      (await call('GET', `/api/automations/${automation.id}/runs?limit=1`)).body
        .runs,
    ).toHaveLength(1);

    const cancel = await call(
      'POST',
      `/api/automations/${automation.id}/runs/${run.body.run.id}/cancel`,
    );
    expect(cancel.status).toBe(204);
    expect(
      (await call('POST', `/api/automations/${automation.id}/runs/read`, {}))
        .status,
    ).toBe(204);

    const patched = await call('PATCH', `/api/automations/${automation.id}`, {
      expectedRevision: automation.revision,
      name: '周报',
    });
    expect(patched.body.automation).toMatchObject({ name: '周报' });
    const stale = await call('PATCH', `/api/automations/${automation.id}`, {
      expectedRevision: automation.revision,
      name: '月报',
    });
    expect(stale).toEqual({
      status: 409,
      body: { error: '自动化已被修改，请刷新后重试' },
    });

    expect(
      (await call('POST', `/api/automations/${automation.id}/pause`)).body
        .automation.status,
    ).toBe('paused');
    expect(
      (await call('POST', `/api/automations/${automation.id}/resume`)).body
        .automation.status,
    ).toBe('active');

    expect(
      (await call('DELETE', `/api/automations/${automation.id}?sessions=burn`))
        .status,
    ).toBe(400);
    expect(
      (await call('DELETE', `/api/automations/${automation.id}?sessions=keep`))
        .status,
    ).toBe(204);
    expect(
      (await call('GET', `/api/automations/${automation.id}`)).status,
    ).toBe(404);
  });

  test("another user's automations are 404 and absent from lists", async () => {
    as('alice');
    const { body } = await call('POST', '/api/automations', {
      workspaceJid: WS,
      ...harness.draft({ sessionMode: 'bound' }),
      targetSessionJid: SESSION,
    });
    const id = body.automation.id;
    expect(
      (
        await call(
          'GET',
          `/api/automations/for-session?jid=${encodeURIComponent(SESSION)}`,
        )
      ).body.automations,
    ).toHaveLength(1);

    as('bob');
    expect((await call('GET', '/api/automations')).body.automations).toEqual(
      [],
    );
    expect(
      (
        await call(
          'GET',
          `/api/automations/for-session?jid=${encodeURIComponent(SESSION)}`,
        )
      ).body.automations,
    ).toEqual([]);
    for (const [method, url] of [
      ['GET', `/api/automations/${id}`],
      ['POST', `/api/automations/${id}/pause`],
      ['POST', `/api/automations/${id}/run`],
      ['DELETE', `/api/automations/${id}`],
    ] as const) {
      expect(await call(method, url)).toEqual({
        status: 404,
        body: { error: '自动化不存在' },
      });
    }
  });

  test('malformed bodies and invalid drafts are 400 in Chinese', async () => {
    as('alice');
    expect(
      await call('POST', '/api/automations', { workspaceJid: WS }),
    ).toEqual({ status: 400, body: { error: '请求格式不正确' } });
    const invalid = await call('POST', '/api/automations', {
      workspaceJid: WS,
      ...harness.draft({
        name: ' ',
        schedule: { kind: 'cron', cronExpr: 'x' },
      }),
    });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toContain('请填写名称');
    expect(invalid.body.error).toContain('Cron 表达式无效');
  });

  test('a bound automation on the workspace itself is refused with its code', async () => {
    as('alice');
    expect(
      await call('POST', '/api/automations', {
        workspaceJid: WS,
        ...harness.draft({ sessionMode: 'bound' }),
        targetSessionJid: WS,
      }),
    ).toEqual({
      status: 400,
      body: {
        error: '自动化只能绑定到一个具体的会话',
        code: 'automation_target_not_session',
      },
    });
  });
});

describe('/api/tasks', () => {
  test('every task route is gone', async () => {
    for (const [method, url] of [
      ['GET', '/api/tasks'],
      ['POST', '/api/tasks'],
      ['PATCH', '/api/tasks/abc'],
      ['POST', '/api/tasks/abc/run'],
      ['GET', '/api/tasks/runs/xyz'],
    ] as const) {
      expect(
        await call(method, url, method === 'GET' ? undefined : {}),
      ).toEqual({
        status: 410,
        body: { error: '定时任务已改为自动化，请使用 /api/automations' },
      });
    }
  });
});
