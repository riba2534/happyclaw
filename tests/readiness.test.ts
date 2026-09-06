import { describe, it, expect, beforeEach } from 'vitest';
import { readinessManager } from '../src/readiness-manager.js';

describe('ReadinessManager Lifecycle, Security & Native Probes', () => {
  beforeEach(() => {
    readinessManager.reset();
  });

  it('初始未就绪状态返回 initializing (503)', () => {
    const report = readinessManager.getPublicReport('sha-init');
    expect(report.ready).toBe(false);
    expect(report.status).toBe('initializing');
    expect(report.statusCode).toBe(503);
    expect(report.currentSha).toBe('sha-init');
    expect(report.phases.database.status).toBe('pending');
    expect(report.phases.recovery.status).toBe('pending');
    expect(report.phases.consumers.status).toBe('pending');
  });

  it('公开接口严格安全脱敏：不泄漏任何账号 ID、账号名或错误堆栈', () => {
    readinessManager.setDbStatus('failed', 'SQLITE_BUSY: database is locked');
    readinessManager.registerChannel({
      id: 'secret-acc-id-9988',
      provider: 'feishu',
      name: '内部隐私机器人',
      enabled: true,
      optional: true,
      status: 'failed',
      error: 'Token contains invalid private key payload',
    });

    const publicReport = readinessManager.getPublicReport('sha-clean');
    expect(publicReport.currentSha).toBe('sha-clean');
    expect(publicReport.status).toBe('failed');
    expect(publicReport.ready).toBe(false);

    // 转换为字符串进行彻底扫描
    const publicJson = JSON.stringify(publicReport);
    expect(publicJson).not.toContain('secret-acc-id-9988');
    expect(publicJson).not.toContain('内部隐私机器人');
    expect(publicJson).not.toContain(
      'Token contains invalid private key payload',
    );
    expect(publicJson).not.toContain('SQLITE_BUSY');

    // 只有管理员报告才输出内部详细诊断
    const adminReport = readinessManager.getAdminReport('sha-clean');
    const adminJson = JSON.stringify(adminReport);
    expect(adminJson).toContain('secret-acc-id-9988');
    expect(adminJson).toContain('内部隐私机器人');
    expect(adminJson).toContain('Token contains invalid private key payload');
    expect(adminJson).toContain('SQLITE_BUSY');
  });

  it('动态增删账户与启用状态切换测试', () => {
    readinessManager.setDbStatus('ready');
    readinessManager.setRecoveryStatus('ready');
    readinessManager.setConsumersStatus('ready');

    // 1. 新增启用账户 -> connecting，系统应处于 initializing
    readinessManager.registerChannel({
      id: 'acc-dynamic-1',
      provider: 'feishu',
      name: '动态飞书',
      enabled: true,
    });
    expect(readinessManager.getPublicReport().status).toBe('initializing');

    // 2. 停用该账户 (enabled = false) -> disabled，系统应恢复 ready
    readinessManager.registerChannel({
      id: 'acc-dynamic-1',
      provider: 'feishu',
      name: '动态飞书',
      enabled: false,
    });
    expect(readinessManager.getPublicReport().status).toBe('ready');

    // 3. 重新启用原先 disabled 账户 -> connecting，系统应变为 initializing
    readinessManager.registerChannel({
      id: 'acc-dynamic-1',
      provider: 'feishu',
      name: '动态飞书',
      enabled: true,
    });
    expect(readinessManager.getPublicReport().status).toBe('initializing');

    // 4. 删除账户 -> 移除后系统恢复 ready
    readinessManager.removeChannel('acc-dynamic-1');
    expect(readinessManager.getPublicReport().status).toBe('ready');
  });

  it('真实 native 异步连接生命周期驱动测试 (WeChat / WhatsApp / QQ)', () => {
    readinessManager.setDbStatus('ready');
    readinessManager.setRecoveryStatus('ready');
    readinessManager.setConsumersStatus('ready');

    // 注册 WeChat 账户
    readinessManager.registerChannel({
      id: 'acc-wechat-async',
      provider: 'wechat',
      name: '微信机器人',
      enabled: true,
      optional: true,
    });

    // 模拟 native 连接中
    readinessManager.setChannelStatus('acc-wechat-async', 'connecting');
    expect(readinessManager.getPublicReport().status).toBe('initializing');

    // 模拟 native connected 事件到达
    readinessManager.setChannelStatus('acc-wechat-async', 'connected');
    expect(readinessManager.getPublicReport().status).toBe('ready');

    // 模拟网络抖动 native reconnecting 事件到达
    readinessManager.setChannelStatus(
      'acc-wechat-async',
      'connecting',
      'Network socket dropped',
    );
    expect(readinessManager.getPublicReport().status).toBe('initializing');

    // 模拟重连成功
    readinessManager.setChannelStatus('acc-wechat-async', 'connected');
    expect(readinessManager.getPublicReport().status).toBe('ready');

    // 模拟永久失效 (expired/failed) -> 触发可选降级
    readinessManager.setChannelStatus(
      'acc-wechat-async',
      'failed',
      'Session QR expired',
    );
    expect(readinessManager.getPublicReport().status).toBe('degraded');
    expect(readinessManager.getPublicReport().summary).toContain(
      'Optional channel degraded',
    );
  });

  it('数据库失败时返回 failed (503)', () => {
    readinessManager.setDbStatus('failed', 'SQLITE_CORRUPT: disk I/O error');
    const report = readinessManager.getPublicReport();
    expect(report.ready).toBe(false);
    expect(report.status).toBe('failed');
    expect(report.statusCode).toBe(503);
    expect(report.summary).toContain('Database failed');
  });

  it('恢复失败与消费者失败真实标记', () => {
    readinessManager.setDbStatus('ready');
    readinessManager.setRecoveryStatus(
      'failed',
      null,
      'Failed to reconcile outbox deliveries',
    );
    let report = readinessManager.getPublicReport();
    expect(report.ready).toBe(false);
    expect(report.status).toBe('failed');
    expect(report.summary).toContain('Startup recovery failed');

    readinessManager.setRecoveryStatus('ready');
    readinessManager.setConsumersStatus('failed', 'GroupQueue start failed');
    report = readinessManager.getPublicReport();
    expect(report.ready).toBe(false);
    expect(report.status).toBe('failed');
    expect(report.summary).toContain('Consumers failed');
  });
});
