import { describe, it, expect, beforeEach } from 'vitest';
import { readinessManager } from '../src/readiness-manager.js';

describe('ReadinessManager Lifecycle & Probes', () => {
  beforeEach(() => {
    readinessManager.reset();
  });

  it('初始未就绪状态返回 initializing (503)', () => {
    const report = readinessManager.getReport();
    expect(report.ready).toBe(false);
    expect(report.status).toBe('initializing');
    expect(report.statusCode).toBe(503);
    expect(report.phases.database.status).toBe('pending');
    expect(report.phases.recovery.status).toBe('pending');
    expect(report.phases.consumers.status).toBe('pending');
  });

  it('数据库失败时返回 failed (503)', () => {
    readinessManager.setDbStatus('failed', 'SQLITE_CORRUPT: disk I/O error');
    const report = readinessManager.getReport();
    expect(report.ready).toBe(false);
    expect(report.status).toBe('failed');
    expect(report.statusCode).toBe(503);
    expect(report.summary).toContain('Database failed');
    expect(report.phases.database.error).toBe('SQLITE_CORRUPT: disk I/O error');
  });

  it('恢复失败时返回 failed (503)', () => {
    readinessManager.setDbStatus('ready');
    readinessManager.setRecoveryStatus(
      'failed',
      null,
      'Failed to reconcile outbox deliveries',
    );
    const report = readinessManager.getReport();
    expect(report.ready).toBe(false);
    expect(report.status).toBe('failed');
    expect(report.statusCode).toBe(503);
    expect(report.summary).toContain('Startup recovery failed');
  });

  it('恢复中与消费者启动中保持 initializing (503)', () => {
    readinessManager.setDbStatus('ready');
    readinessManager.setRecoveryStatus('in_progress');
    let report = readinessManager.getReport();
    expect(report.status).toBe('initializing');
    expect(report.ready).toBe(false);

    readinessManager.setRecoveryStatus('ready', { uncertain: 0, retryable: 2 });
    readinessManager.setConsumersStatus('starting');
    report = readinessManager.getReport();
    expect(report.status).toBe('initializing');
    expect(report.ready).toBe(false);
  });

  it('渠道延迟连接 (connecting) 阶段保持 initializing (503)', () => {
    readinessManager.setDbStatus('ready');
    readinessManager.setRecoveryStatus('ready');
    readinessManager.setConsumersStatus('ready');

    // 注册启用的渠道，处于 connecting
    readinessManager.registerChannel({
      id: 'acc-feishu-1',
      provider: 'feishu',
      name: '研发飞书机器人',
      enabled: true,
      optional: true,
    });

    const report = readinessManager.getReport();
    expect(report.status).toBe('initializing');
    expect(report.ready).toBe(false);
    expect(report.statusCode).toBe(503);
    expect(report.summary).toContain('connecting');
    expect(report.phases.channels.items[0].status).toBe('connecting');
  });

  it('禁用渠道 (disabled) 不阻塞就绪', () => {
    readinessManager.setDbStatus('ready');
    readinessManager.setRecoveryStatus('ready');
    readinessManager.setConsumersStatus('ready');

    // 注册已禁用的渠道
    readinessManager.registerChannel({
      id: 'acc-telegram-off',
      provider: 'telegram',
      name: '未启用的 Telegram',
      enabled: false,
    });

    const report = readinessManager.getReport();
    expect(report.status).toBe('ready');
    expect(report.ready).toBe(true);
    expect(report.statusCode).toBe(200);
    expect(report.phases.channels.disabledCount).toBe(1);
    expect(report.phases.channels.items[0].status).toBe('disabled');
  });

  it('可选渠道连接失败时支持业务降级 (degraded, 200)', () => {
    readinessManager.setDbStatus('ready');
    readinessManager.setRecoveryStatus('ready');
    readinessManager.setConsumersStatus('ready');

    readinessManager.registerChannel({
      id: 'acc-feishu',
      provider: 'feishu',
      name: '主飞书机器人',
      enabled: true,
      optional: true,
    });
    readinessManager.setChannelStatus('acc-feishu', 'connected');

    readinessManager.registerChannel({
      id: 'acc-discord',
      provider: 'discord',
      name: '备选 Discord',
      enabled: true,
      optional: true,
    });
    readinessManager.setChannelStatus(
      'acc-discord',
      'failed',
      'Discord gateway login timeout 401',
    );

    const report = readinessManager.getReport();
    expect(report.status).toBe('degraded');
    expect(report.ready).toBe(true);
    expect(report.statusCode).toBe(200);
    expect(report.summary).toContain('Optional channel(s) degraded');
    expect(report.summary).toContain('备选 Discord(discord)');
  });

  it('关键非可选渠道失败时阻断就绪 (failed, 503)', () => {
    readinessManager.setDbStatus('ready');
    readinessManager.setRecoveryStatus('ready');
    readinessManager.setConsumersStatus('ready');

    readinessManager.registerChannel({
      id: 'acc-core-feishu',
      provider: 'feishu',
      name: '核心飞书机器人',
      enabled: true,
      optional: false, // 必选渠道，不可降级
    });
    readinessManager.setChannelStatus(
      'acc-core-feishu',
      'failed',
      'Feishu appSecret invalid',
    );

    const report = readinessManager.getReport();
    expect(report.status).toBe('failed');
    expect(report.ready).toBe(false);
    expect(report.statusCode).toBe(503);
    expect(report.summary).toContain('Critical channel(s) failed');
  });

  it('全套启用的组件与渠道连接就绪后达到完全 ready (200)', () => {
    readinessManager.setDbStatus('ready');
    readinessManager.setRecoveryStatus('ready', { uncertain: 0, retryable: 0 });
    readinessManager.setConsumersStatus('ready');

    readinessManager.registerChannel({
      id: 'acc-feishu',
      provider: 'feishu',
      name: '主飞书',
      enabled: true,
    });
    readinessManager.setChannelStatus('acc-feishu', 'connected');

    readinessManager.registerChannel({
      id: 'acc-qq',
      provider: 'qq',
      name: 'QQ 机器人',
      enabled: false,
    });

    const report = readinessManager.getReport();
    expect(report.status).toBe('ready');
    expect(report.ready).toBe(true);
    expect(report.statusCode).toBe(200);
    expect(report.phases.channels.connectedCount).toBe(1);
    expect(report.phases.channels.disabledCount).toBe(1);
    expect(report.summary).toContain('operational');
  });
});
