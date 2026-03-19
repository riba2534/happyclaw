/**
 * Provider Pool — 多提供商负载均衡
 *
 * 支持三种策略：round-robin、weighted-round-robin、failover
 * 健康状态纯内存管理，配置持久化到 data/config/provider-pool.json
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

// ─── 类型定义 ──────────────────────────────────────────────

export interface StoredProviderPoolConfig {
  version: 1;
  mode: 'fixed' | 'pool';
  strategy: 'round-robin' | 'weighted-round-robin' | 'failover';
  members: ProviderPoolMember[];
  unhealthyThreshold: number;
  recoveryIntervalMs: number;
  updatedAt: string;
}

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

const CLAUDE_CONFIG_DIR = path.join(DATA_DIR, 'config');
const POOL_CONFIG_FILE = path.join(CLAUDE_CONFIG_DIR, 'provider-pool.json');

const DEFAULT_UNHEALTHY_THRESHOLD = 3;
const DEFAULT_RECOVERY_INTERVAL_MS = 300_000; // 5 minutes

function defaultConfig(): StoredProviderPoolConfig {
  return {
    version: 1,
    mode: 'fixed',
    strategy: 'round-robin',
    members: [],
    unhealthyThreshold: DEFAULT_UNHEALTHY_THRESHOLD,
    recoveryIntervalMs: DEFAULT_RECOVERY_INTERVAL_MS,
    updatedAt: new Date().toISOString(),
  };
}

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
  private config: StoredProviderPoolConfig;
  private healthMap: Map<string, ProviderHealthStatus> = new Map();
  private roundRobinIndex = 0;
  private configMtimeMs = 0;

  constructor() {
    this.config = this.loadConfigFromDisk();
  }

  // ─── 配置管理 ────────────────────────────────────────────

  private loadConfigFromDisk(): StoredProviderPoolConfig {
    try {
      if (!fs.existsSync(POOL_CONFIG_FILE)) return defaultConfig();
      const content = fs.readFileSync(POOL_CONFIG_FILE, 'utf-8');
      const parsed = JSON.parse(content) as StoredProviderPoolConfig;
      if (parsed.version !== 1) return defaultConfig();
      this.configMtimeMs = fs.statSync(POOL_CONFIG_FILE).mtimeMs;
      return parsed;
    } catch (err) {
      logger.warn({ err }, 'Failed to read provider-pool.json, using defaults');
      return defaultConfig();
    }
  }

  /** Reload config from disk if file changed */
  reload(): void {
    try {
      if (!fs.existsSync(POOL_CONFIG_FILE)) {
        this.config = defaultConfig();
        this.configMtimeMs = 0;
        return;
      }
      const stat = fs.statSync(POOL_CONFIG_FILE);
      if (stat.mtimeMs === this.configMtimeMs) return; // unchanged
      this.config = this.loadConfigFromDisk();
      // Clean up health entries for removed members
      const memberIds = new Set(this.config.members.map((m) => m.profileId));
      for (const key of this.healthMap.keys()) {
        if (!memberIds.has(key)) this.healthMap.delete(key);
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to reload provider-pool.json');
    }
  }

  saveConfig(config: StoredProviderPoolConfig): void {
    fs.mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
    const tmp = `${POOL_CONFIG_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmp, POOL_CONFIG_FILE);
    this.config = config;
    try {
      this.configMtimeMs = fs.statSync(POOL_CONFIG_FILE).mtimeMs;
    } catch {
      /* ignore */
    }
  }

  getConfig(): StoredProviderPoolConfig {
    return this.config;
  }

  // ─── 选择算法 ────────────────────────────────────────────

  /** 选择一个提供商，返回 profileId */
  selectProvider(): string {
    // Auto-reload config if file changed on disk
    this.reload();

    const { strategy, members, recoveryIntervalMs } = this.config;
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
      // No members at all — shouldn't happen if mode=pool, but be safe
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
        // Build weighted array
        const weighted: ProviderPoolMember[] = [];
        for (const c of candidates) {
          const w = Math.max(1, Math.min(100, c.weight || 1));
          for (let i = 0; i < w; i++) {
            weighted.push(c);
          }
        }
        const idx = this.roundRobinIndex % weighted.length;
        selected = weighted[idx];
        this.roundRobinIndex = idx + 1;
        break;
      }

      case 'failover': {
        // Return first healthy candidate (preserves original order)
        selected = candidates[0];
        break;
      }

      default: {
        selected = candidates[0];
        break;
      }
    }

    logger.info(
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
      health.consecutiveErrors >= this.config.unhealthyThreshold
    ) {
      health.healthy = false;
      health.unhealthySince = Date.now();
      logger.warn(
        {
          profileId,
          consecutiveErrors: health.consecutiveErrors,
          threshold: this.config.unhealthyThreshold,
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
    for (const member of this.config.members) {
      this.getOrCreateHealth(member.profileId);
    }
    return this.config.members.map(
      (m) => this.healthMap.get(m.profileId) || makeHealthStatus(m.profileId),
    );
  }

  getHealthStatus(profileId: string): ProviderHealthStatus {
    return this.healthMap.get(profileId) || makeHealthStatus(profileId);
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
