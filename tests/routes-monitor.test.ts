import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-monitor-test-'));

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    DATA_DIR: tmp,
    STORE_DIR: path.join(tmp, 'db'),
    GROUPS_DIR: path.join(tmp, 'groups'),
    CONTAINER_IMAGE: 'test-image',
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: 'admin-user-id',
      username: 'admin',
      role: 'admin',
      permissions: ['manage_system_config', 'host_execution'],
    });
    return next();
  },
  systemConfigMiddleware: async (c: any, next: any) => next(),
}));

const db = await import('../src/db.js');
const reliability = await import('../src/channel-reliability-store.js');
const readiness = await import('../src/readiness-manager.js');
const webContext = await import('../src/web-context.js');
const monitorModule = await import('../src/routes/monitor.js');
const routes = monitorModule.default;

beforeAll(() => {
  db.initDatabase();

  // 注入 Web 依赖以满足健康检查中对 queue 的要求
  webContext.setWebDeps({
    queue: {
      getStatus: () => ({
        activeCount: 0,
        activeContainerCount: 0,
        activeHostProcessCount: 0,
        waitingCount: 0,
        waitingGroupJids: [],
        groups: [],
      }),
      setOnContainerExit: vi.fn(),
    } as any,
  } as any);

  // 写入测试用户
  const nowIso = new Date().toISOString();
  db.createUser({
    id: 'admin-user-id',
    username: 'admin',
    password_hash: 'hash',
    display_name: 'Super Admin',
    role: 'admin',
    status: 'active',
    created_at: nowIso,
    updated_at: nowIso,
  });

  // 写入测试渠道账号
  db.createChannelAccount({
    id: 'bot-feishu-main',
    owner_user_id: 'admin-user-id',
    provider: 'feishu',
    name: '运维监控机器人',
    enabled: true,
    is_default: true,
    secret_ref: 'sec-main',
  });

  // 写入测试群组
  db.setRegisteredGroup('feishu:bot-feishu-main:chat-alert', {
    name: '生产报警群',
    folder: 'alert-workspace',
    trigger: '@bot',
    added_at: nowIso,
    created_by: 'admin-user-id',
  });
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('Monitor Routes API (Health, Readiness, Outbox, Uncertain CAS)', () => {
  test('GET /health 保持兼容返回原有 status 和 checks', async () => {
    const res = await routes.fetch(new Request('http://localhost/health'));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.status).toBe('healthy');
    expect(body.checks.database).toBe(true);
    expect(body.checks.queue).toBe(true);
    expect(typeof body.checks.uptime).toBe('number');
  });

  test('GET /health/readiness 返回多阶段就绪探针报告', async () => {
    readiness.readinessManager.setDbStatus('ready');
    readiness.readinessManager.setRecoveryStatus('ready', {
      uncertain: 0,
      retryable: 0,
    });
    readiness.readinessManager.setConsumersStatus('ready');
    readiness.readinessManager.registerChannel({
      id: 'bot-feishu-main',
      provider: 'feishu',
      name: '运维监控机器人',
      enabled: true,
    });
    readiness.readinessManager.setChannelStatus('bot-feishu-main', 'connected');

    const res = await routes.fetch(
      new Request('http://localhost/health/readiness'),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ready).toBe(true);
    expect(body.status).toBe('ready');
    expect(body.phases.database.status).toBe('ready');
    expect(body.phases.recovery.status).toBe('ready');
    expect(body.phases.consumers.status).toBe('ready');
    expect(body.phases.channels.connectedCount).toBe(1);
  });

  test('GET /status/channel-outbox 暴露年龄、超期、丰富路由身份且严禁泄漏 payload', async () => {
    const now = Date.now();
    const oldTime = new Date(now - 100_000).toISOString();

    // 建立 Turn 与 Outbox 待确认项
    reliability.createChannelTurnRun({
      id: 'turn-route-1',
      idempotencyKey: 'idem-turn-route-1',
      provider: 'feishu',
      accountId: 'bot-feishu-main',
      sourceJid: 'feishu:bot-feishu-main:chat-alert',
      sessionId: 'session-alert-123',
      chatId: 'chat-alert',
      rootId: 'root-msg-1',
      threadId: 'thread-99',
    });

    reliability.enqueueChannelOutbox({
      turnRunId: 'turn-route-1',
      ordinal: 0,
      kind: 'text',
      idempotencyKey: 'idem-outbox-payload-secret',
      provider: 'feishu',
      accountId: 'bot-feishu-main',
      sourceJid: 'feishu:bot-feishu-main:chat-alert',
      payload: { secret_data: 'DO_NOT_LEAK_THIS_SECRET_TEXT_12345' },
      now: oldTime,
    });

    const claimed = reliability.claimNextChannelOutbox('worker-test', 60_000, {
      provider: 'feishu',
      accountId: 'bot-feishu-main',
      now: oldTime,
    });
    expect(claimed).toBeDefined();
    if (claimed) {
      reliability.failChannelOutbox(claimed, {
        error: 'Network timeout during ACK',
        uncertain: true,
        now: oldTime,
      });
    }

    const res = await routes.fetch(
      new Request('http://localhost/status/channel-outbox'),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;

    expect(body.summary).toBeDefined();
    expect(body.summary.uncertain).toBeGreaterThanOrEqual(1);
    expect(body.summary.overdue).toBeGreaterThanOrEqual(1);

    const item = body.items.find((i: any) => i.id === claimed?.id);
    expect(item).toBeDefined();
    expect(item.status).toBe('uncertain');
    expect(item.isOverdue).toBe(true);
    expect(item.ageSeconds).toBeGreaterThanOrEqual(90);
    expect(item.ageFormatted).toContain('m');

    // 验证真实路由身份
    expect(item.route.provider).toBe('feishu');
    expect(item.route.accountId).toBe('bot-feishu-main');
    expect(item.route.botName).toBe('运维监控机器人');
    expect(item.route.sourceJid).toBe('feishu:bot-feishu-main:chat-alert');
    expect(item.route.groupName).toBe('生产报警群');
    expect(item.route.groupFolder).toBe('alert-workspace');
    expect(item.route.sessionId).toBe('session-alert-123');
    expect(item.route.navigationUrl).toBe(
      '/chat/alert-workspace?session=session-alert-123',
    );

    // 严格安全边界断言：绝对不能包含 payload！
    expect(item.payload).toBeUndefined();
    const rawJson = JSON.stringify(body);
    expect(rawJson).not.toContain('DO_NOT_LEAK_THIS_SECRET_TEXT_12345');
  });

  test('POST /status/channel-outbox/:id/resolve CAS 裁决与 impact 结果返回', async () => {
    const listRes = await routes.fetch(
      new Request('http://localhost/status/channel-outbox/uncertain'),
    );
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as any;
    expect(listBody.items.length).toBeGreaterThanOrEqual(1);

    const target = listBody.items[0];

    // 1. CAS 冲突测试：传错 expectedRevision
    const conflictRes = await routes.fetch(
      new Request(
        `http://localhost/status/channel-outbox/${target.id}/resolve`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            resolution: 'delivered',
            expectedRevision: target.revision + 50,
            providerMessageId: 'fs_msg_9999',
          }),
        },
      ),
    );
    expect(conflictRes.status).toBe(409);
    const conflictBody = (await conflictRes.json()) as any;
    expect(conflictBody.error).toContain('Outbox item changed');
    expect(conflictBody.currentRevision).toBe(target.revision);

    // 2. CAS 成功测试：正确 revision 裁决为 delivered
    const successRes = await routes.fetch(
      new Request(
        `http://localhost/status/channel-outbox/${target.id}/resolve`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            resolution: 'delivered',
            expectedRevision: target.revision,
            providerMessageId: 'fs_msg_9999',
          }),
        },
      ),
    );
    expect(successRes.status).toBe(200);
    const successBody = (await successRes.json()) as any;
    expect(successBody.ok).toBe(true);
    expect(successBody.resolution).toBe('delivered');
    expect(successBody.impact).toBeDefined();
    expect(successBody.impact.action).toBe('marked_delivered');
    expect(successBody.impact.turnStatus).toBe('fence_released');
    expect(successBody.impact.description).toContain('fs_msg_9999');
    expect(successBody.impact.route.botName).toBe('运维监控机器人');
    expect(successBody.impact.route.groupName).toBe('生产报警群');
  });
});
