/**
 * 模型端点故障转移管理器
 *
 * 功能：
 * - 支持多端点配置（官方 + 多个 backup）
 * - 优先级：Claude原生 > 三方backup
 * - 检测限流/不可用并自动切换
 * - 切换时向用户发送通知
 */

import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

// ==================== 类型定义 ====================

export type EndpointType = 'official' | 'third_party';

export type EndpointStatus = 'healthy' | 'degraded' | 'unhealthy' | 'unknown';

export interface ModelEndpoint {
  id: string;
  type: EndpointType;
  name: string;
  baseUrl: string;
  authToken?: string;
  apiKey?: string;
  priority: number; // 数字越小优先级越高
  status: EndpointStatus;
  lastHealthCheckAt: number | null;
  lastUsedAt: number | null;
  failureCount: number;
  successCount: number;
  enabled: boolean;
}

export interface FailoverState {
  version: number;
  currentEndpointId: string | null;
  endpoints: ModelEndpoint[];
  lastSwitchAt: number | null;
  switchHistory: Array<{
    from: string | null;
    to: string;
    reason: string;
    timestamp: number;
  }>;
}

export interface EndpointHealth {
  status: EndpointStatus;
  latency?: number;
  error?: string;
}

// ==================== 常量 ====================

const FAILOVER_CONFIG_FILE = path.join(DATA_DIR, 'config', 'model-failover.json');
const CURRENT_STATE_VERSION = 1;

// 健康检查阈值
const MAX_FAILURES_BEFORE_SWITCH = 3;
const HEALTH_CHECK_INTERVAL = 60_000; // 1分钟
const RECOVERY_CHECK_INTERVAL = 5 * 60_000; // 5分钟
const SWITCH_COOLDOWN = 30_000; // 30秒切换冷却时间

// 限流/错误检测关键词
const RATE_LIMIT_PATTERNS = [
  /rate.?limit/i,
  /429/i,
  /too.?many.?requests/i,
  /quota.?exceeded/i,
];

const UNAVAILABLE_PATTERNS = [
  /50[23]/,
  /service.?unavailable/i,
  /gateway.?timeout/i,
  /connection.?refused/i,
  /network.?error/i,
  /timeout/i,
];

// ==================== 默认配置 ====================

function createOfficialEndpoint(): ModelEndpoint {
  return {
    id: 'official',
    type: 'official',
    name: 'Claude 官方',
    baseUrl: '',
    priority: 0,
    status: 'unknown',
    lastHealthCheckAt: null,
    lastUsedAt: null,
    failureCount: 0,
    successCount: 0,
    enabled: true,
  };
}

function getDefaultState(): FailoverState {
  return {
    version: CURRENT_STATE_VERSION,
    currentEndpointId: 'official',
    endpoints: [createOfficialEndpoint()],
    lastSwitchAt: null,
    switchHistory: [],
  };
}

// ==================== 状态持久化 ====================

let cachedState: FailoverState | null = null;

export function getFailoverState(): FailoverState {
  if (cachedState) return cachedState;

  try {
    if (fs.existsSync(FAILOVER_CONFIG_FILE)) {
      const content = fs.readFileSync(FAILOVER_CONFIG_FILE, 'utf-8');
      const parsed = JSON.parse(content) as Partial<FailoverState>;
      if (parsed.version === CURRENT_STATE_VERSION) {
        cachedState = parsed as FailoverState;
        return cachedState;
      }
      logger.warn({ storedVersion: parsed.version }, 'Failover state version mismatch, using defaults');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to read failover state, using defaults');
  }

  cachedState = getDefaultState();
  return cachedState;
}

function saveFailoverState(state: FailoverState): void {
  cachedState = state;
  const dir = path.dirname(FAILOVER_CONFIG_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${FAILOVER_CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, FAILOVER_CONFIG_FILE);
}

// ==================== 端点管理 ====================

export function getEndpoints(): ModelEndpoint[] {
  return getFailoverState().endpoints;
}

export function getCurrentEndpoint(): ModelEndpoint | null {
  const state = getFailoverState();
  if (!state.currentEndpointId) return null;
  return state.endpoints.find((e) => e.id === state.currentEndpointId) || null;
}

export function getEndpointById(id: string): ModelEndpoint | null {
  return getFailoverState().endpoints.find((e) => e.id === id) || null;
}

/**
 * 按优先级排序获取可用端点
 * 优先级：enabled=true > priority数字小 > 状态好
 */
export function getSortedAvailableEndpoints(): ModelEndpoint[] {
  const state = getFailoverState();
  return [...state.endpoints]
    .filter((e) => e.enabled)
    .sort((a, b) => {
      // 优先级数字小的排前面
      if (a.priority !== b.priority) return a.priority - b.priority;
      // 状态好的排前面
      const statusOrder: Record<EndpointStatus, number> = {
        healthy: 0,
        degraded: 1,
        unknown: 2,
        unhealthy: 3,
      };
      if (statusOrder[a.status] !== statusOrder[b.status]) {
        return statusOrder[a.status] - statusOrder[b.status];
      }
      // 失败次数少的排前面
      return a.failureCount - b.failureCount;
    });
}

/**
 * 添加或更新端点
 */
export function upsertEndpoint(endpoint: Omit<ModelEndpoint, 'lastHealthCheckAt' | 'lastUsedAt' | 'failureCount' | 'successCount'>): ModelEndpoint {
  const state = getFailoverState();
  const existingIdx = state.endpoints.findIndex((e) => e.id === endpoint.id);

  const now = Date.now();
  const endpointWithDefaults: ModelEndpoint = {
    ...endpoint,
    lastHealthCheckAt: null,
    lastUsedAt: null,
    failureCount: 0,
    successCount: 0,
  };

  if (existingIdx >= 0) {
    // 保留统计信息
    const existing = state.endpoints[existingIdx];
    endpointWithDefaults.lastHealthCheckAt = existing.lastHealthCheckAt;
    endpointWithDefaults.lastUsedAt = existing.lastUsedAt;
    endpointWithDefaults.failureCount = existing.failureCount;
    endpointWithDefaults.successCount = existing.successCount;
    state.endpoints[existingIdx] = endpointWithDefaults;
  } else {
    state.endpoints.push(endpointWithDefaults);
  }

  // 如果当前没有选中端点，选择优先级最高的
  if (!state.currentEndpointId) {
    const sorted = getSortedAvailableEndpoints();
    if (sorted.length > 0) {
      state.currentEndpointId = sorted[0].id;
    }
  }

  saveFailoverState(state);
  return endpointWithDefaults;
}

/**
 * 删除端点
 */
export function deleteEndpoint(id: string): boolean {
  const state = getFailoverState();
  const idx = state.endpoints.findIndex((e) => e.id === id);
  if (idx < 0) return false;

  // 不允许删除最后一个端点
  if (state.endpoints.length <= 1) {
    logger.warn('Cannot delete last endpoint');
    return false;
  }

  state.endpoints.splice(idx, 1);

  // 如果删除的是当前端点，切换到下一个
  if (state.currentEndpointId === id) {
    const sorted = getSortedAvailableEndpoints();
    state.currentEndpointId = sorted.length > 0 ? sorted[0].id : null;
  }

  saveFailoverState(state);
  return true;
}

// ==================== 错误检测与故障转移 ====================

/**
 * 检测错误是否应该触发故障转移
 */
export function shouldFailoverForError(error: string | Error): boolean {
  const msg = typeof error === 'string' ? error : error.message || String(error);

  // 检查限流
  if (RATE_LIMIT_PATTERNS.some((p) => p.test(msg))) {
    return true;
  }

  // 检查服务不可用
  if (UNAVAILABLE_PATTERNS.some((p) => p.test(msg))) {
    return true;
  }

  return false;
}

/**
 * 记录端点调用结果
 */
export function recordEndpointResult(endpointId: string, success: boolean, error?: string): void {
  const state = getFailoverState();
  const endpoint = state.endpoints.find((e) => e.id === endpointId);
  if (!endpoint) return;

  const now = Date.now();
  endpoint.lastUsedAt = now;

  if (success) {
    endpoint.successCount++;
    endpoint.failureCount = Math.max(0, endpoint.failureCount - 1);
    if (endpoint.status === 'unhealthy') {
      endpoint.status = 'degraded';
    } else if (endpoint.failureCount === 0) {
      endpoint.status = 'healthy';
    }
  } else {
    endpoint.failureCount++;
    if (endpoint.failureCount >= MAX_FAILURES_BEFORE_SWITCH) {
      endpoint.status = 'unhealthy';
    } else if (endpoint.failureCount > 0) {
      endpoint.status = 'degraded';
    }

    // 检查是否需要故障转移
    if (state.currentEndpointId === endpointId) {
      const shouldSwitch =
        endpoint.status === 'unhealthy' ||
        (error && shouldFailoverForError(error));

      if (shouldSwitch) {
        trySwitchEndpoint(endpointId, error || 'endpoint_failure');
      }
    }
  }

  saveFailoverState(state);
}

/**
 * 尝试切换到下一个可用端点
 */
export function trySwitchEndpoint(fromEndpointId: string, reason: string): ModelEndpoint | null {
  const state = getFailoverState();
  const now = Date.now();

  // 检查切换冷却时间
  if (state.lastSwitchAt && now - state.lastSwitchAt < SWITCH_COOLDOWN) {
    logger.debug('Switch cooldown active, skipping failover');
    return null;
  }

  const sorted = getSortedAvailableEndpoints();
  const currentIdx = sorted.findIndex((e) => e.id === fromEndpointId);

  // 找到下一个可用的端点
  let nextEndpoint: ModelEndpoint | null = null;

  // 先尝试找官方端点（如果可用）
  if (fromEndpointId !== 'official') {
    const official = sorted.find((e) => e.id === 'official' && e.status !== 'unhealthy');
    if (official) {
      nextEndpoint = official;
    }
  }

  // 如果没有找到官方端点，找下一个优先级高的
  if (!nextEndpoint) {
    for (const endpoint of sorted) {
      if (endpoint.id !== fromEndpointId && endpoint.status !== 'unhealthy') {
        nextEndpoint = endpoint;
        break;
      }
    }
  }

  if (!nextEndpoint) {
    logger.warn('No available endpoints for failover');
    return null;
  }

  // 执行切换
  const previousEndpointId = state.currentEndpointId;
  state.currentEndpointId = nextEndpoint.id;
  state.lastSwitchAt = now;

  state.switchHistory.unshift({
    from: previousEndpointId,
    to: nextEndpoint.id,
    reason,
    timestamp: now,
  });

  // 保留最近20条历史
  if (state.switchHistory.length > 20) {
    state.switchHistory = state.switchHistory.slice(0, 20);
  }

  saveFailoverState(state);

  logger.info(
    { from: previousEndpointId, to: nextEndpoint.id, reason },
    'Model endpoint failover triggered',
  );

  return nextEndpoint;
}

/**
 * 强制切换到指定端点
 */
export function forceSwitchEndpoint(endpointId: string): boolean {
  const state = getFailoverState();
  const endpoint = state.endpoints.find((e) => e.id === endpointId);

  if (!endpoint || !endpoint.enabled) {
    return false;
  }

  const previousEndpointId = state.currentEndpointId;
  state.currentEndpointId = endpointId;
  state.lastSwitchAt = Date.now();

  state.switchHistory.unshift({
    from: previousEndpointId,
    to: endpointId,
    reason: 'manual_switch',
    timestamp: Date.now(),
  });

  saveFailoverState(state);
  return true;
}

/**
 * 重置所有端点的健康状态
 */
export function resetAllEndpointHealth(): void {
  const state = getFailoverState();
  for (const endpoint of state.endpoints) {
    endpoint.status = 'unknown';
    endpoint.failureCount = 0;
  }
  saveFailoverState(state);
}

// ==================== 生成切换通知消息 ====================

export function getSwitchNotificationMessage(
  fromEndpoint: ModelEndpoint | null,
  toEndpoint: ModelEndpoint,
  reason: string,
): string {
  const reasonText: Record<string, string> = {
    endpoint_failure: '检测到端点不可用',
    rate_limit: '检测到官方 API 限流',
    manual_switch: '手动切换',
    config_change: '配置变更',
  };

  const reasonDisplay = reasonText[reason] || reason;

  if (!fromEndpoint) {
    return `🔄 已切换到模型端点：**${toEndpoint.name}**\n\n原因：${reasonDisplay}`;
  }

  return `🔄 模型端点已切换\n\n**从**: ${fromEndpoint.name}\n**到**: ${toEndpoint.name}\n\n原因：${reasonDisplay}\n\n将使用新的端点继续为您服务。`;
}

// ==================== 从旧配置迁移 ====================

/**
 * 从旧的 ClaudeProviderConfig 迁移到新的端点配置
 */
export function migrateFromLegacyConfig(
  anthropicBaseUrl: string,
  anthropicAuthToken?: string,
  anthropicApiKey?: string,
): void {
  const state = getFailoverState();

  // 更新官方端点
  const official = state.endpoints.find((e) => e.id === 'official');
  if (official) {
    official.baseUrl = '';
    official.authToken = undefined;
    official.apiKey = undefined;
  }

  // 如果有旧的第三方配置，添加为 backup 端点
  if (anthropicBaseUrl) {
    const existingThirdParty = state.endpoints.find((e) => e.id === 'legacy-third-party');
    if (existingThirdParty) {
      existingThirdParty.baseUrl = anthropicBaseUrl;
      existingThirdParty.authToken = anthropicAuthToken;
      existingThirdParty.apiKey = anthropicApiKey;
    } else {
      state.endpoints.push({
        id: 'legacy-third-party',
        type: 'third_party',
        name: '第三方 (已迁移)',
        baseUrl: anthropicBaseUrl,
        authToken: anthropicAuthToken,
        apiKey: anthropicApiKey,
        priority: 10,
        status: 'unknown',
        lastHealthCheckAt: null,
        lastUsedAt: null,
        failureCount: 0,
        successCount: 0,
        enabled: true,
      });
    }
  }

  saveFailoverState(state);
}
