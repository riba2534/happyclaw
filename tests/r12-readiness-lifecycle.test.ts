import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r12-readiness-lifecycle-'));

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    DATA_DIR: tmp,
    STORE_DIR: path.join(tmp, 'db'),
    GROUPS_DIR: path.join(tmp, 'groups'),
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/middleware/auth.ts', () => ({
  authMiddleware: async (c: any, next: any) => {
    c.set('user', {
      id: 'owner-r12',
      username: 'test-admin',
      role: 'admin',
      permissions: ['manage_system_config'],
    });
    return next();
  },
  systemConfigMiddleware: async (c: any, next: any) => next(),
}));

const db = await import('../src/db.js');
const routeModule = await import('../src/routes/channel-accounts.js');
const routes = routeModule.default;
const { readinessManager, setChannelAuthoritativeSyncSource } =
  await import('../src/readiness-manager.js');

const reload = vi.fn(async () => true);
const disconnect = vi.fn(async () => undefined);
routeModule.injectChannelAccountDeps({
  reloadChannelAccount: reload,
  disconnectChannelAccount: disconnect,
  testChannelAccount: async () => ({ success: true }),
});

beforeAll(() => {
  fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'groups'), { recursive: true });
  db.initDatabase();

  const nowIso = new Date().toISOString();
  db.createUser({
    id: 'owner-r12',
    username: 'test-admin',
    password_hash: 'hash',
    display_name: 'Test Admin',
    role: 'admin',
    status: 'active',
    created_at: nowIso,
    updated_at: nowIso,
  });
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('R12 真实路由与底层连接生命周期端到端测试', () => {
  test('启用未授权 (auth_status=draft) 账号时绝不能误报为 ready (针对 Leader 复现 1)', async () => {
    readinessManager.reset();
    readinessManager.setDbStatus('ready');
    readinessManager.setRecoveryStatus('ready');
    readinessManager.setConsumersStatus('ready');

    // 建立一个启用了但处于 draft 未扫码状态的 WhatsApp 账号
    const account = db.createChannelAccount({
      id: 'proof-auth-wa',
      owner_user_id: 'owner-r12',
      provider: 'whatsapp',
      name: '待扫码 WhatsApp',
      secret_ref: 'channel-account:proof-auth-wa',
      enabled: false,
      auth_mode: 'qr_session',
      auth_status: 'draft',
    } as any);

    // 调用真实路由开启该账号
    const response = await routes.request('/proof-auth-wa/toggle', {
      method: 'POST',
    });
    expect(response.status).toBe(200);
    expect(db.getChannelAccount(account.id)?.enabled).toBe(true);

    // 严格断言：公开报告与管理员报告绝不能判定为 ready！
    const adminReport = readinessManager.getAdminReport();
    expect(adminReport.status).not.toBe('ready');
    expect(adminReport.status).toBe('initializing');
    expect(adminReport.ready).toBe(false);
    expect(adminReport.phases.channels.connectedCount).toBe(0);

    const targetItem = adminReport.phases.channels.items.find(
      (x) => x.id === account.id,
    );
    expect(targetItem).toBeDefined();
    // 绝不能被当成 disabled 忽略
    expect(targetItem?.status).toBe('connecting');
    expect(targetItem?.error).toContain('Awaiting authorization');
  });

  test('微信异步重载仅保留 poller 时严格保持 connecting，直到 native 回调触发才转为 ready (针对 Leader 复现 2)', async () => {
    readinessManager.reset();
    readinessManager.setDbStatus('ready');
    readinessManager.setRecoveryStatus('ready');
    readinessManager.setConsumersStatus('ready');

    const account = db.createChannelAccount({
      id: 'proof-native-wx',
      owner_user_id: 'owner-r12',
      provider: 'wechat',
      name: '微信机器人',
      secret_ref: 'channel-account:proof-native-wx',
      enabled: false,
      auth_mode: 'token',
      auth_status: 'authorized',
    } as any);

    // 模拟 reloadChannelAccount 保留了本地 poller 并将状态置为 connecting（符合真实 index.ts 行为）
    reload.mockImplementationOnce(async () => {
      readinessManager.setChannelStatus(account.id, 'connecting');
      return true;
    });

    const response = await routes.request('/proof-native-wx/toggle', {
      method: 'POST',
    });
    expect(response.status).toBe(200);

    // 严格断言：微信异步连接在 route toggle 之后必须严格保持 connecting，绝不能被无条件提前置为 connected！
    const adminReport = readinessManager.getAdminReport();
    const targetItem = adminReport.phases.channels.items.find(
      (x) => x.id === account.id,
    );
    expect(targetItem?.status).toBe('connecting');
    expect(adminReport.status).toBe('initializing');
    expect(adminReport.ready).toBe(false);

    // 模拟随后底层 native 回调到达，确认连接真正建立
    readinessManager.setChannelStatus(account.id, 'connected');
    const readyReport = readinessManager.getAdminReport();
    expect(readyReport.status).toBe('ready');
    expect(readyReport.ready).toBe(true);
    expect(
      readyReport.phases.channels.items.find((x) => x.id === account.id)
        ?.status,
    ).toBe('connected');
  });

  test('中央权威同步与断连感知：底层 isConnected 变为 false 时立即更新状态并清除过时时间戳', () => {
    readinessManager.reset();
    readinessManager.setDbStatus('ready');
    readinessManager.setRecoveryStatus('ready');
    readinessManager.setConsumersStatus('ready');

    let connectionLive = true;

    // 注册权威同步源（模拟底层 IMManager）
    setChannelAuthoritativeSyncSource(() => [
      {
        id: 'acc-authoritative-feishu',
        provider: 'feishu',
        name: '生产飞书',
        enabled: true,
        auth_status: 'authorized',
        transport_status: connectionLive ? 'connected' : 'disconnected',
        last_error: connectionLive ? null : 'WebSocket socket closed by peer',
        owner_user_id: 'owner-r12',
        isConnected: connectionLive,
      },
    ]);

    // 1. 底层连接正常时 -> ready
    let report = readinessManager.getAdminReport();
    expect(report.status).toBe('ready');
    const itemLive = report.phases.channels.items[0];
    expect(itemLive.status).toBe('connected');
    expect(itemLive.connectedAt).not.toBeNull();

    // 2. 底层连接异常中断 (isConnected = false) -> 立即感知，清除 connectedAt 并转为 degraded/failed
    connectionLive = false;
    report = readinessManager.getAdminReport();
    expect(report.status).toBe('degraded');
    const itemDead = report.phases.channels.items[0];
    expect(itemDead.status).toBe('failed');
    expect(itemDead.connectedAt).toBeNull(); // 严格清除过时时间戳！
    expect(itemDead.error).toContain('WebSocket socket closed');
  });
});
