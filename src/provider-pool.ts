/**
 * Provider Pool — 多提供商负载均衡
 *
 * 支持三种策略：round-robin、weighted-round-robin、failover
 * 健康状态纯内存管理，配置由 runtime-config V4 注入（不再自行管理配置文件）
 */
import { logger } from './logger.js';
import type { BalancingConfig } from './runtime-config.js';

// ─── 类型定义 ──────────────────────────────────────────────

export interface ProviderPoolMember {
  profileId: string;
  weight: number;
  enabled: boolean;
}

export interface ProviderHealthStatus {
  profileId: string;
  healthy: boolean;
  consecutiveErrors: number;
  lastErrorAt: number | null;
  lastSuccessAt: number | null;
  unhealthySince: number | null;
  activeSessionCount: number;
}

// ─── 常量 ──────────────────────────────────────────────────

const DEFAULT_UNHEALTHY_THRESHOLD = 3;
const DEFAULT_RECOVERY_INTERVAL_MS = 300_000; // 5 minutes

function makeHealthStatus(profileId: string): ProviderHealthStatus {
  return {
    profileId,
    healthy: true,
    consecutiveErrors: 0,
    lastErrorAt: null,
    lastSuccessAt: null,
    unhealthySince: null,
    activeSessionCount: 0,
  };
}

// ─── ProviderPool 类 ──────────────────────────────────────

export class ProviderPool {
  private members: ProviderPoolMember[] = [];
  private strategy: BalancingConfig['strategy'] = 'round-robin';
  private unhealthyThreshold = DEFAULT_UNHEALTHY_THRESHOLD;
  private recoveryIntervalMs = DEFAULT_RECOVERY_INTERVAL_MS;
  private healthMap: Map<string, ProviderHealthStatus> = new Map();
  private roundRobinIndex = 0;

  /**
   * Refresh internal state from V4 provider config.
   * Called by container-runner before selection, and by routes after config changes.
   */
  refreshFromConfig(
    providers: Array<{ id: string; enabled: boolean; weight: number }>,
    balancing: BalancingConfig,
  ): void {
    this.members = providers.map((p) => ({
      profileId: p.id,
      weight: Math.max(1, Math.min(100, p.weight || 1)),
      enabled: p.enabled,
    }));
    this.strategy = balancing.strategy;
    this.unhealthyThreshold = balancing.unhealthyThreshold;
    this.recoveryIntervalMs = balancing.recoveryIntervalMs;

    // Clean up health entries for removed members
    const memberIds = new Set(this.members.map((m) => m.profileId));
    for (const key of this.healthMap.keys()) {
      if (!memberIds.has(key)) this.healthMap.delete(key);
    }
  }

  /** How many enabled members are currently configured */
  getEnabledCount(): number {
    return this.members.filter((m) => m.enabled).length;
  }

  // ─── 选择算法 ────────────────────────────────────────────

  /** 选择一个提供商，返回 profileId */
  selectProvider(): string {
    const { strategy, members, recoveryIntervalMs } = this;
    const now = Date.now();

    // Auto-recover unhealthy members (skip disabled ones)
    for (const member of members) {
      if (!member.enabled) continue;
      const health = this.healthMap.get(member.profileId);
      if (
        health &&
        !health.healthy &&
        health.unhealthySince !== null &&
        now - health.unhealthySince >= recoveryIntervalMs
      ) {
        health.healthy = true;
        health.consecutiveErrors = 0;
        health.unhealthySince = null;
        logger.info(
          { profileId: member.profileId },
          'Provider auto-recovered after recovery interval',
        );
      }
    }

    // Filter to enabled + healthy candidates
    const candidates = members.filter((m) => {
      if (!m.enabled) return false;
      const health = this.healthMap.get(m.profileId);
      return !health || health.healthy;
    });

    if (candidates.length === 0) {
      // All unhealthy — best-effort: return first enabled member, or first member
      const firstEnabled = members.find((m) => m.enabled);
      const fallback = firstEnabled || members[0];
      if (fallback) {
        logger.warn(
          { profileId: fallback.profileId, strategy },
          'All providers unhealthy, falling back to first available',
        );
        return fallback.profileId;
      }
      // No members at all
      throw new Error('Provider pool has no members configured');
    }

    let selected: ProviderPoolMember;

    switch (strategy) {
      case 'round-robin': {
        const idx = this.roundRobinIndex % candidates.length;
        selected = candidates[idx];
        this.roundRobinIndex = idx + 1;
        break;
      }

      case 'weighted-round-robin': {
        const totalWeight = candidates.reduce(
          (sum, c) => sum + Math.max(1, Math.min(100, c.weight || 1)),
          0,
        );
        const target = this.roundRobinIndex % totalWeight;
        let cumulative = 0;
        selected = candidates[0];
        for (const c of candidates) {
          cumulative += Math.max(1, Math.min(100, c.weight || 1));
          if (target < cumulative) {
            selected = c;
            break;
          }
        }
        this.roundRobinIndex += 1;
        break;
      }

      case 'failover': {
        selected = candidates[0];
        break;
      }

      default: {
        selected = candidates[0];
        break;
      }
    }

    logger.debug(
      { profileId: selected.profileId, strategy },
      'Selected provider for session',
    );
    return selected.profileId;
  }

  // ─── 健康上报 ────────────────────────────────────────────

  reportSuccess(profileId: string): void {
    const health = this.getOrCreateHealth(profileId);
    health.consecutiveErrors = 0;
    health.lastSuccessAt = Date.now();
    if (!health.healthy) {
      health.healthy = true;
      health.unhealthySince = null;
      logger.info({ profileId }, 'Provider recovered after success report');
    }
  }

  reportFailure(profileId: string): void {
    const health = this.getOrCreateHealth(profileId);
    health.consecutiveErrors += 1;
    health.lastErrorAt = Date.now();

    if (
      health.healthy &&
      health.consecutiveErrors >= this.unhealthyThreshold
    ) {
      health.healthy = false;
      health.unhealthySince = Date.now();
      logger.warn(
        {
          profileId,
          consecutiveErrors: health.consecutiveErrors,
          threshold: this.unhealthyThreshold,
        },
        'Provider marked unhealthy after consecutive failures',
      );
    }
  }

  // ─── 会话计数 ────────────────────────────────────────────

  acquireSession(profileId: string): void {
    const health = this.getOrCreateHealth(profileId);
    health.activeSessionCount += 1;
  }

  releaseSession(profileId: string): void {
    const health = this.getOrCreateHealth(profileId);
    health.activeSessionCount = Math.max(0, health.activeSessionCount - 1);
  }

  // ─── 查询 ───────────────────────────────────────────────

  getHealthStatuses(): ProviderHealthStatus[] {
    // Ensure all configured members have health entries
    for (const member of this.members) {
      this.getOrCreateHealth(member.profileId);
    }
    return this.members.map((m) => ({
      ...(this.healthMap.get(m.profileId) || makeHealthStatus(m.profileId)),
    }));
  }

  getHealthStatus(profileId: string): ProviderHealthStatus {
    const health = this.healthMap.get(profileId);
    return health ? { ...health } : makeHealthStatus(profileId);
  }

  resetHealth(profileId: string): void {
    this.healthMap.set(profileId, makeHealthStatus(profileId));
  }

  // ─── 内部工具 ────────────────────────────────────────────

  private getOrCreateHealth(profileId: string): ProviderHealthStatus {
    let health = this.healthMap.get(profileId);
    if (!health) {
      health = makeHealthStatus(profileId);
      this.healthMap.set(profileId, health);
    }
    return health;
  }
}

// ─── 单例 ──────────────────────────────────────────────────

export const providerPool = new ProviderPool();
