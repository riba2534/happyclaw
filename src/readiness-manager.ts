import { logger } from './logger.js';

export type ReadinessPhaseStatus =
  | 'pending'
  | 'in_progress'
  | 'starting'
  | 'ready'
  | 'failed';

export type ChannelConnectionStatus =
  | 'disabled'
  | 'connecting'
  | 'connected'
  | 'failed'
  | 'degraded';

export interface ChannelReadinessItem {
  id: string;
  provider: string;
  name: string;
  enabled: boolean;
  optional: boolean;
  status: ChannelConnectionStatus;
  error?: string | null;
  lastAttemptAt?: string | null;
  connectedAt?: string | null;
}

export interface DbPhase {
  status: 'pending' | 'ready' | 'failed';
  error?: string | null;
  checkedAt?: string | null;
}

export interface RecoveryPhase {
  status: 'pending' | 'in_progress' | 'ready' | 'failed';
  error?: string | null;
  completedAt?: string | null;
  detail?: Record<string, unknown> | null;
}

export interface ConsumersPhase {
  status: 'pending' | 'starting' | 'ready' | 'failed';
  error?: string | null;
  startedAt?: string | null;
}

export interface ChannelsPhase {
  status: 'ready' | 'degraded' | 'connecting' | 'failed';
  totalAccounts: number;
  enabledCount: number;
  connectedCount: number;
  failedCount: number;
  disabledCount: number;
  items: ChannelReadinessItem[];
}

export interface ReadinessReport {
  status: 'ready' | 'degraded' | 'initializing' | 'failed';
  ready: boolean;
  statusCode: 200 | 503;
  summary: string;
  timestamp: string;
  uptimeSeconds: number;
  phases: {
    database: DbPhase;
    recovery: RecoveryPhase;
    consumers: ConsumersPhase;
    channels: ChannelsPhase;
  };
}

class ReadinessManager {
  private dbPhase: DbPhase = {
    status: 'pending',
    error: null,
    checkedAt: null,
  };
  private recoveryPhase: RecoveryPhase = {
    status: 'pending',
    error: null,
    completedAt: null,
    detail: null,
  };
  private consumersPhase: ConsumersPhase = {
    status: 'pending',
    error: null,
    startedAt: null,
  };
  private channelMap = new Map<string, ChannelReadinessItem>();

  /** 标记数据库阶段 */
  setDbStatus(status: 'ready' | 'failed', error?: string | null): void {
    this.dbPhase = {
      status,
      error: error ?? null,
      checkedAt: new Date().toISOString(),
    };
    if (status === 'failed') {
      logger.error({ error }, 'Readiness: 数据库检查失败');
    }
  }

  /** 标记数据恢复阶段（Outbox/Inbox 等） */
  setRecoveryStatus(
    status: 'in_progress' | 'ready' | 'failed',
    detail?: Record<string, unknown> | null,
    error?: string | null,
  ): void {
    this.recoveryPhase = {
      status,
      error: error ?? null,
      completedAt: status === 'ready' ? new Date().toISOString() : null,
      detail: detail ?? null,
    };
    if (status === 'failed') {
      logger.error({ error, detail }, 'Readiness: 启动恢复流程失败');
    }
  }

  /** 标记消息队列与消费者阶段 */
  setConsumersStatus(
    status: 'starting' | 'ready' | 'failed',
    error?: string | null,
  ): void {
    this.consumersPhase = {
      status,
      error: error ?? null,
      startedAt: status === 'ready' ? new Date().toISOString() : null,
    };
    if (status === 'failed') {
      logger.error({ error }, 'Readiness: 消息消费者启动失败');
    }
  }

  /** 注册或更新渠道账号 */
  registerChannel(account: {
    id: string;
    provider: string;
    name: string;
    enabled: boolean;
    optional?: boolean;
  }): void {
    const existing = this.channelMap.get(account.id);
    const optional = account.optional ?? true; // 默认渠道故障支持业务降级，不阻塞全站
    if (!account.enabled) {
      this.channelMap.set(account.id, {
        id: account.id,
        provider: account.provider,
        name: account.name,
        enabled: false,
        optional,
        status: 'disabled',
        error: null,
        lastAttemptAt: null,
        connectedAt: null,
      });
      return;
    }

    this.channelMap.set(account.id, {
      id: account.id,
      provider: account.provider,
      name: account.name,
      enabled: true,
      optional,
      status: existing?.status ?? 'connecting',
      error: existing?.error ?? null,
      lastAttemptAt: existing?.lastAttemptAt ?? new Date().toISOString(),
      connectedAt: existing?.connectedAt ?? null,
    });
  }

  /** 更新渠道连接状态 */
  setChannelStatus(
    accountId: string,
    status: ChannelConnectionStatus,
    error?: string | null,
  ): void {
    const item = this.channelMap.get(accountId);
    if (!item) return;

    item.status = status;
    item.error = error ?? null;
    item.lastAttemptAt = new Date().toISOString();
    if (status === 'connected') {
      item.connectedAt = new Date().toISOString();
    }
  }

  /** 清空或重置状态（供测试或重新初始化） */
  reset(): void {
    this.dbPhase = { status: 'pending', error: null, checkedAt: null };
    this.recoveryPhase = {
      status: 'pending',
      error: null,
      completedAt: null,
      detail: null,
    };
    this.consumersPhase = { status: 'pending', error: null, startedAt: null };
    this.channelMap.clear();
  }

  /** 生成业务就绪报告 */
  getReport(): ReadinessReport {
    const channelItems = Array.from(this.channelMap.values());
    const totalAccounts = channelItems.length;
    const enabledItems = channelItems.filter((i) => i.enabled);
    const enabledCount = enabledItems.length;
    const connectedCount = enabledItems.filter(
      (i) => i.status === 'connected',
    ).length;
    const failedItems = enabledItems.filter(
      (i) => i.status === 'failed' || i.status === 'degraded',
    );
    const failedCount = failedItems.length;
    const disabledCount = channelItems.filter((i) => !i.enabled).length;
    const connectingCount = enabledItems.filter(
      (i) => i.status === 'connecting',
    ).length;

    // 渠道阶段状态判定
    let channelsStatus: ChannelsPhase['status'] = 'ready';
    if (connectingCount > 0) {
      channelsStatus = 'connecting';
    } else if (failedCount > 0) {
      const allFailedAreOptional = failedItems.every((i) => i.optional);
      channelsStatus = allFailedAreOptional ? 'degraded' : 'failed';
    }

    const channelsPhase: ChannelsPhase = {
      status: channelsStatus,
      totalAccounts,
      enabledCount,
      connectedCount,
      failedCount,
      disabledCount,
      items: channelItems,
    };

    // 综合判定
    let overallStatus: ReadinessReport['status'] = 'ready';
    const reasons: string[] = [];

    // 1. 检查 DB
    if (this.dbPhase.status === 'failed') {
      overallStatus = 'failed';
      reasons.push(`Database failed: ${this.dbPhase.error ?? 'unknown error'}`);
    } else if (this.dbPhase.status === 'pending') {
      overallStatus = 'initializing';
      reasons.push('Database initialization pending');
    }

    // 2. 检查 Recovery
    if (this.recoveryPhase.status === 'failed') {
      overallStatus = 'failed';
      reasons.push(
        `Startup recovery failed: ${this.recoveryPhase.error ?? 'unknown error'}`,
      );
    } else if (
      this.recoveryPhase.status === 'pending' ||
      this.recoveryPhase.status === 'in_progress'
    ) {
      if (overallStatus !== 'failed') overallStatus = 'initializing';
      reasons.push('Startup reliability recovery in progress');
    }

    // 3. 检查 Consumers
    if (this.consumersPhase.status === 'failed') {
      overallStatus = 'failed';
      reasons.push(
        `Message consumers failed: ${this.consumersPhase.error ?? 'unknown error'}`,
      );
    } else if (
      this.consumersPhase.status === 'pending' ||
      this.consumersPhase.status === 'starting'
    ) {
      if (overallStatus !== 'failed') overallStatus = 'initializing';
      reasons.push('Message consumers starting');
    }

    // 4. 检查 Channels
    if (channelsStatus === 'connecting') {
      if (overallStatus !== 'failed') overallStatus = 'initializing';
      reasons.push(`${connectingCount} enabled channel(s) connecting`);
    } else if (channelsStatus === 'failed') {
      overallStatus = 'failed';
      const nonOptionalFailed = failedItems.filter((i) => !i.optional);
      reasons.push(
        `Critical channel(s) failed: ${nonOptionalFailed.map((i) => `${i.name}(${i.provider})`).join(', ')}`,
      );
    } else if (channelsStatus === 'degraded') {
      if (overallStatus === 'ready') {
        overallStatus = 'degraded';
      }
      reasons.push(
        `Optional channel(s) degraded: ${failedItems.map((i) => `${i.name}(${i.provider})`).join(', ')}`,
      );
    }

    const ready = overallStatus === 'ready' || overallStatus === 'degraded';
    const statusCode: 200 | 503 = ready ? 200 : 503;
    const summary =
      reasons.length > 0
        ? reasons.join('; ')
        : 'All systems and enabled channels operational';

    return {
      status: overallStatus,
      ready,
      statusCode,
      summary,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      phases: {
        database: this.dbPhase,
        recovery: this.recoveryPhase,
        consumers: this.consumersPhase,
        channels: channelsPhase,
      },
    };
  }
}

export const readinessManager = new ReadinessManager();
