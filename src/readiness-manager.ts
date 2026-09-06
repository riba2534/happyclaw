import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
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

export interface PublicReadinessReport {
  status: 'ready' | 'degraded' | 'initializing' | 'failed';
  ready: boolean;
  statusCode: 200 | 503;
  currentSha: string;
  summary: string;
  timestamp: string;
  uptimeSeconds: number;
  phases: {
    database: { status: 'pending' | 'ready' | 'failed' };
    recovery: { status: 'pending' | 'in_progress' | 'ready' | 'failed' };
    consumers: { status: 'pending' | 'starting' | 'ready' | 'failed' };
    channels: {
      status: 'ready' | 'degraded' | 'connecting' | 'failed';
      totalAccounts: number;
      enabledCount: number;
      connectedCount: number;
      failedCount: number;
      disabledCount: number;
    };
  };
}

export interface AdminReadinessReport extends PublicReadinessReport {
  phases: {
    database: DbPhase;
    recovery: RecoveryPhase;
    consumers: ConsumersPhase;
    channels: ChannelsPhase;
  };
}

function detectBootstrapReleaseSha(): string {
  // 1. 显式环境变量优先
  if (process.env.HAPPYCLAW_GIT_SHA) return process.env.HAPPYCLAW_GIT_SHA;
  if (process.env.HAPPYCLAW_BOOTSTRAP_SHA)
    return process.env.HAPPYCLAW_BOOTSTRAP_SHA;

  // 2. 通过 import.meta.url 真实物理路径反查所属不可变 release 根中的 version.json
  try {
    const currentScriptPath = fs.realpathSync(new URL(import.meta.url));
    let searchDir = path.dirname(currentScriptPath);
    for (let i = 0; i < 5; i++) {
      const versionFile = path.join(searchDir, 'version.json');
      if (fs.existsSync(versionFile)) {
        const v = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
        if (v.commitSha) return v.commitSha;
      }
      const parent = path.dirname(searchDir);
      if (parent === searchDir) break;
      searchDir = parent;
    }
  } catch {}

  // 3. 启动时刻读取 .releases/current/version.json 或 .release-current.json
  try {
    const metaPath = path.join(
      process.cwd(),
      '.releases',
      'current',
      'version.json',
    );
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (meta.commitSha) return meta.commitSha;
    }
  } catch {}

  try {
    const currentFile = path.join(process.cwd(), '.release-current.json');
    if (fs.existsSync(currentFile)) {
      const current = JSON.parse(fs.readFileSync(currentFile, 'utf8'));
      if (current.commitSha) return current.commitSha;
    }
  } catch {}

  // 4. 进程启动冷启兜底：一次性读取启动时的 git HEAD
  try {
    const sha = execSync('git rev-parse HEAD 2>/dev/null', {
      timeout: 1000,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    if (sha) return sha;
  } catch {}

  return 'unknown';
}

// 进程启动时刻一次性固化的不可变版本常量，生命周期内绝不随外部 git HEAD 切换漂移
export const BOOTSTRAP_COMMIT_SHA: string = detectBootstrapReleaseSha();

export function resolveCurrentCommitSha(): string {
  return BOOTSTRAP_COMMIT_SHA;
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

  registerChannel(account: {
    id: string;
    provider: string;
    name: string;
    enabled: boolean;
    optional?: boolean;
    status?: ChannelConnectionStatus;
    error?: string | null;
  }): void {
    const existing = this.channelMap.get(account.id);
    const optional = account.optional ?? true;

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

    let nextStatus = account.status;
    if (!nextStatus) {
      if (!existing || existing.status === 'disabled') {
        nextStatus = 'connecting';
      } else {
        nextStatus = existing.status;
      }
    }
    this.channelMap.set(account.id, {
      id: account.id,
      provider: account.provider,
      name: account.name,
      enabled: true,
      optional,
      status: nextStatus,
      error:
        account.error ??
        (existing?.status === 'disabled' ? null : (existing?.error ?? null)),
      lastAttemptAt: existing?.lastAttemptAt ?? new Date().toISOString(),
      connectedAt:
        nextStatus === 'connected'
          ? (existing?.connectedAt ?? new Date().toISOString())
          : null,
    });
  }

  removeChannel(accountId: string): void {
    this.channelMap.delete(accountId);
  }

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

  private computeChannelsPhase(): ChannelsPhase {
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

    let channelsStatus: ChannelsPhase['status'] = 'ready';
    if (connectingCount > 0) {
      channelsStatus = 'connecting';
    } else if (failedCount > 0) {
      const allFailedAreOptional = failedItems.every((i) => i.optional);
      channelsStatus = allFailedAreOptional ? 'degraded' : 'failed';
    }

    return {
      status: channelsStatus,
      totalAccounts,
      enabledCount,
      connectedCount,
      failedCount,
      disabledCount,
      items: channelItems,
    };
  }

  private evaluateStatus(channelsPhase: ChannelsPhase): {
    overallStatus: 'ready' | 'degraded' | 'initializing' | 'failed';
    reasons: string[];
    safeSummary: string;
  } {
    let overallStatus: 'ready' | 'degraded' | 'initializing' | 'failed' =
      'ready';
    const reasons: string[] = [];

    if (this.dbPhase.status === 'failed') {
      overallStatus = 'failed';
      reasons.push('Database failed');
    } else if (this.dbPhase.status === 'pending') {
      overallStatus = 'initializing';
      reasons.push('Database pending');
    }

    if (this.recoveryPhase.status === 'failed') {
      overallStatus = 'failed';
      reasons.push('Startup recovery failed');
    } else if (
      this.recoveryPhase.status === 'pending' ||
      this.recoveryPhase.status === 'in_progress'
    ) {
      if (overallStatus !== 'failed') overallStatus = 'initializing';
      reasons.push('Startup recovery in progress');
    }

    if (this.consumersPhase.status === 'failed') {
      overallStatus = 'failed';
      reasons.push('Consumers failed');
    } else if (
      this.consumersPhase.status === 'pending' ||
      this.consumersPhase.status === 'starting'
    ) {
      if (overallStatus !== 'failed') overallStatus = 'initializing';
      reasons.push('Consumers starting');
    }

    if (channelsPhase.status === 'connecting') {
      if (overallStatus !== 'failed') overallStatus = 'initializing';
      reasons.push(
        `${channelsPhase.items.filter((i) => i.enabled && i.status === 'connecting').length} channel(s) connecting`,
      );
    } else if (channelsPhase.status === 'failed') {
      overallStatus = 'failed';
      reasons.push('Critical channel connection failed');
    } else if (channelsPhase.status === 'degraded') {
      if (overallStatus === 'ready') overallStatus = 'degraded';
      reasons.push('Optional channel degraded');
    }

    const safeSummary =
      reasons.length > 0
        ? reasons.join('; ')
        : 'All systems and enabled channels operational';

    return { overallStatus, reasons, safeSummary };
  }

  /**
   * 公开探针报告（无认证，严格脱敏：绝不泄露账号 ID、账号名或详细报错堆栈）
   */
  getPublicReport(
    currentSha = resolveCurrentCommitSha(),
  ): PublicReadinessReport {
    const channelsPhase = this.computeChannelsPhase();
    const { overallStatus, safeSummary } = this.evaluateStatus(channelsPhase);

    const ready = overallStatus === 'ready' || overallStatus === 'degraded';
    const statusCode: 200 | 503 = ready ? 200 : 503;

    return {
      status: overallStatus,
      ready,
      statusCode,
      currentSha,
      summary: safeSummary,
      timestamp: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      phases: {
        database: { status: this.dbPhase.status },
        recovery: { status: this.recoveryPhase.status },
        consumers: { status: this.consumersPhase.status },
        channels: {
          status: channelsPhase.status,
          totalAccounts: channelsPhase.totalAccounts,
          enabledCount: channelsPhase.enabledCount,
          connectedCount: channelsPhase.connectedCount,
          failedCount: channelsPhase.failedCount,
          disabledCount: channelsPhase.disabledCount,
        },
      },
    };
  }

  /**
   * 管理员详情报告（需认证：包含内部账号、时间戳及具体错误）
   */
  getAdminReport(currentSha = resolveCurrentCommitSha()): AdminReadinessReport {
    const channelsPhase = this.computeChannelsPhase();
    const { overallStatus, safeSummary } = this.evaluateStatus(channelsPhase);

    const ready = overallStatus === 'ready' || overallStatus === 'degraded';
    const statusCode: 200 | 503 = ready ? 200 : 503;

    return {
      status: overallStatus,
      ready,
      statusCode,
      currentSha,
      summary: safeSummary,
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

  /** 兼容别名 */
  getReport(): PublicReadinessReport {
    return this.getPublicReport();
  }
}

export const readinessManager = new ReadinessManager();
