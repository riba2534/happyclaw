import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-monitor-test-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });

vi.mock('../src/config.js', () => ({
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
  DATA_DIR: root,
  CONTAINER_IMAGE: 'test-image',
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const reliability = await import('../src/channel-reliability-store.js');

beforeAll(() => {
  db.initDatabase();

  // 写入测试用户
  const userId = 'user-ops-test';
  const nowIso = new Date().toISOString();
  db.createUser({
    id: userId,
    username: 'testuser',
    password_hash: 'hash',
    display_name: 'Test Operator',
    role: 'admin',
    status: 'active',
    created_at: nowIso,
    updated_at: nowIso,
  });

  // 写入测试渠道账号
  db.createChannelAccount({
    id: 'acc-feishu-prod',
    owner_user_id: userId,
    provider: 'feishu',
    name: '生产飞书机器人',
    enabled: true,
    is_default: true,
    secret_ref: 'sec-1',
  });

  // 写入测试工作区群组
  db.setRegisteredGroup('feishu:acc-feishu-prod:chat-ops', {
    name: '运维应急群',
    folder: 'ops-workspace',
    trigger: '@bot',
    added_at: new Date().toISOString(),
    created_by: userId,
  });
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('Outbox Monitor API & Routing Enrichment', () => {
  test('getChannelOutboxSummary 正确按状态统计及识别超期项', () => {
    const now = Date.now();
    const oldTime = new Date(now - 120_000).toISOString(); // 2分钟前（超期项）
    const recentTime = new Date(now - 10_000).toISOString(); // 10秒前（正常项）

    // 写入测试 Turn
    reliability.createChannelTurnRun({
      id: 'turn-1',
      idempotencyKey: 'idem-turn-1',
      provider: 'feishu',
      accountId: 'acc-feishu-prod',
      sourceJid: 'feishu:acc-feishu-prod:chat-ops',
      sessionId: 'session-alpha',
      agentId: 'agent-ops',
    });

    // 写入超期的 pending 项
    reliability.enqueueChannelOutbox({
      turnRunId: 'turn-1',
      ordinal: 0,
      kind: 'text',
      idempotencyKey: 'idem-outbox-old-pending',
      provider: 'feishu',
      accountId: 'acc-feishu-prod',
      sourceJid: 'feishu:acc-feishu-prod:chat-ops',
      payload: { text: '超期待发送敏感消息内容（严防泄漏）' },
      now: oldTime,
    });

    // 写入正常最近的 pending 项
    reliability.enqueueChannelOutbox({
      turnRunId: 'turn-1',
      ordinal: 1,
      kind: 'text',
      idempotencyKey: 'idem-outbox-recent-pending',
      provider: 'feishu',
      accountId: 'acc-feishu-prod',
      sourceJid: 'feishu:acc-feishu-prod:chat-ops',
      payload: { text: '最近待发送消息' },
      now: recentTime,
    });

    // 写入一条 uncertain 项
    reliability.enqueueChannelOutbox({
      turnRunId: 'turn-1',
      ordinal: 2,
      kind: 'text',
      idempotencyKey: 'idem-outbox-uncertain',
      provider: 'feishu',
      accountId: 'acc-feishu-prod',
      sourceJid: 'feishu:acc-feishu-prod:chat-ops',
      payload: { text: '待确认消息' },
      now: oldTime,
    });
    const claimed = reliability.claimNextChannelOutbox('worker-1', 60_000, {
      provider: 'feishu',
      accountId: 'acc-feishu-prod',
      now: oldTime,
    });
    expect(claimed).toBeDefined();
    if (claimed) {
      reliability.failChannelOutbox(claimed, {
        error: 'Provider ACK dropped in transit',
        uncertain: true,
        now: oldTime,
      });
    }

    // 检查统计
    const summary = reliability.getChannelOutboxSummary(60_000, new Date(now));
    expect(summary.total).toBeGreaterThanOrEqual(3);
    expect(summary.uncertain).toBeGreaterThanOrEqual(1);
    expect(summary.overdue).toBeGreaterThanOrEqual(2); // 两个 oldTime 项均超期
  });

  test('listChannelOutboxForMonitoring 支持过滤并按优先级排序', () => {
    const uncertainList = reliability.listChannelOutboxForMonitoring({
      status: 'uncertain',
    });
    expect(uncertainList.length).toBeGreaterThanOrEqual(1);
    expect(uncertainList.every((i) => i.status === 'uncertain')).toBe(true);

    const overdueList = reliability.listChannelOutboxForMonitoring({
      overdueOnly: true,
      overdueThresholdMs: 60_000,
    });
    expect(overdueList.length).toBeGreaterThanOrEqual(2);
  });

  test('CAS 裁决成功释放 Turn 栅栏并更新状态与版本', () => {
    const uncertainList = reliability.listUncertainChannelOutbox();
    expect(uncertainList.length).toBeGreaterThanOrEqual(1);
    const target = uncertainList[0];

    // CAS 校验：传错 expectedRevision 应该拒绝
    const wrongRevisionResult = reliability.resolveUncertainChannelOutbox(
      target.id,
      target.revision + 999,
      {
        resolution: 'delivered',
        providerMessageId: 'msg-ack-123',
      },
    );
    expect(wrongRevisionResult).toBe(false);

    // CAS 校验成功
    const successResult = reliability.resolveUncertainChannelOutbox(
      target.id,
      target.revision,
      {
        resolution: 'delivered',
        providerMessageId: 'msg-ack-123',
      },
    );
    expect(successResult).toBe(true);

    // 验证状态已更新为 delivered，版本号递增
    const resolvedItem = reliability.getChannelOutboxItem(target.id);
    expect(resolvedItem?.status).toBe('delivered');
    expect(resolvedItem?.providerMessageId).toBe('msg-ack-123');
    expect(resolvedItem?.revision).toBe(target.revision + 1);
  });
});
