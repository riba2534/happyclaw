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

  // 写入测试工作区群组
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

  test('GET /health/readiness (公开接口) 严格脱敏且包含 currentSha', async () => {
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
    expect(body.currentSha).toBeDefined();

    // 关键安全验证：公开报告不得输出内部账号 ID 与账号名
    const jsonStr = JSON.stringify(body);
    expect(jsonStr).not.toContain('bot-feishu-main');
    expect(jsonStr).not.toContain('运维监控机器人');
  });

  test('GET /status/readiness (管理员接口) 包含账号明细与内部诊断', async () => {
    const res = await routes.fetch(
      new Request('http://localhost/status/readiness'),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.ready).toBe(true);
    expect(body.phases.channels.items).toBeDefined();
    expect(body.phases.channels.items[0].id).toBe('bot-feishu-main');
    expect(body.phases.channels.items[0].name).toBe('运维监控机器人');
  });

  test('GET /status/channel-outbox 暴露真实 Workspace 路由、?agent= 导航且保留顶层字段兼容', async () => {
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
      agentId: 'agent-ops-primary',
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

    const item = body.items.find((i: any) => i.id === claimed?.id);
    expect(item).toBeDefined();

    // 1. 顶层兼容性验证
    expect(item.provider).toBe('feishu');
    expect(item.accountId).toBe('bot-feishu-main');
    expect(item.turnRunId).toBe('turn-route-1');

    // 2. 真实 Workspace 解析与 ?agent= 导航验证
    expect(item.route.groupFolder).toBe('alert-workspace');
    expect(item.route.agentId).toBe('agent-ops-primary');
    expect(item.route.navigationUrl).toBe(
      '/chat/alert-workspace?agent=agent-ops-primary',
    );

    // 3. 严格数据隐私保护：绝无 payload
    expect(item.payload).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(
      'DO_NOT_LEAK_THIS_SECRET_TEXT_12345',
    );
  });

  test('POST /status/channel-outbox/:id/resolve 真实栅栏状态判定（同 Turn 存在兄弟项时不宣告释放）', async () => {
    const now = Date.now();
    const oldTime = new Date(now - 50_000).toISOString();

    // 创建一个 Turn，包含两条 uncertain 消息（例如图文混合发送）
    reliability.createChannelTurnRun({
      id: 'turn-multi-uncertain',
      idempotencyKey: 'idem-multi-turn',
      provider: 'feishu',
      accountId: 'bot-feishu-main',
      sourceJid: 'feishu:bot-feishu-main:chat-alert',
    });

    reliability.enqueueChannelOutbox({
      turnRunId: 'turn-multi-uncertain',
      ordinal: 0,
      kind: 'text',
      idempotencyKey: 'idem-multi-1',
      provider: 'feishu',
      accountId: 'bot-feishu-main',
      sourceJid: 'feishu:bot-feishu-main:chat-alert',
      payload: { text: '文本段' },
      now: oldTime,
    });
    reliability.enqueueChannelOutbox({
      turnRunId: 'turn-multi-uncertain',
      ordinal: 1,
      kind: 'image',
      idempotencyKey: 'idem-multi-2',
      provider: 'feishu',
      accountId: 'bot-feishu-main',
      sourceJid: 'feishu:bot-feishu-main:chat-alert',
      payload: { image_key: 'img-1' },
      now: oldTime,
    });

    // 声明两条都被置为 uncertain
    const claim1 = reliability.claimChannelOutboxById(
      reliability
        .listChannelOutboxForMonitoring({ limit: 100 })
        .find((i) => i.idempotencyKey === 'idem-multi-1')!.id,
      'w1',
      60000,
      oldTime,
    );
    reliability.failChannelOutbox(claim1!, {
      error: 'ACK dropped 1',
      uncertain: true,
      now: oldTime,
    });

    const claim2 = reliability.claimChannelOutboxById(
      reliability
        .listChannelOutboxForMonitoring({ limit: 100 })
        .find((i) => i.idempotencyKey === 'idem-multi-2')!.id,
      'w1',
      60000,
      oldTime,
    );
    reliability.failChannelOutbox(claim2!, {
      error: 'ACK dropped 2',
      uncertain: true,
      now: oldTime,
    });

    // 获取当前最新版本号 (经过 claim 与 fail 两次状态推进，revision 递增为 2)
    const item1 = reliability.getChannelOutboxItem(claim1!.id)!;
    const item2 = reliability.getChannelOutboxItem(claim2!.id)!;

    // 裁决第一条：因为第二条仍为 uncertain，因此不能判定 fence_released！
    const res1 = await routes.fetch(
      new Request(
        `http://localhost/status/channel-outbox/${claim1!.id}/resolve`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            resolution: 'delivered',
            expectedRevision: item1.revision,
            providerMessageId: 'msg-part-1',
          }),
        },
      ),
    );
    expect(res1.status).toBe(200);
    const body1 = (await res1.json()) as any;
    expect(body1.impact.turnStatus).toBe('fenced_by_siblings');
    expect(body1.impact.description).toContain(
      '仍有其他待确认兄弟项，栅栏保持有效',
    );

    // 裁决第二条：兄弟项全部解决，Turn 栅栏真正释放！
    const res2 = await routes.fetch(
      new Request(
        `http://localhost/status/channel-outbox/${claim2!.id}/resolve`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            resolution: 'delivered',
            expectedRevision: item2.revision,
            providerMessageId: 'msg-part-2',
          }),
        },
      ),
    );
    expect(res2.status).toBe(200);
    const body2 = (await res2.json()) as any;
    expect(body2.impact.turnStatus).toBe('fence_released');
    expect(body2.impact.description).toContain('栅栏已完全释放');
  });
});
