/**
 * Core billing logic: plan management, balance, quota checks, redeem codes, monthly aggregation.
 */

import crypto from 'crypto';
import {
  batchAssignPlan as dbBatchAssignPlan,
  getBillingPlan,
  getDefaultBillingPlan,
  getUserById,
  getUserActiveSubscription,
  createUserSubscription,
  cancelUserSubscription as dbCancelSubscription,
  getUserBalance,
  adjustUserBalance,
  getMonthlyUsage,
  incrementMonthlyUsage,
  incrementDailyUsage,
  incrementUsageBoth,
  getDailyUsage,
  getWeeklyUsageSummary,
  getUserGroupCount,
  logBillingAudit,
  getRedeemCode,
  hasUserRedeemedCode,
  tryIncrementRedeemCodeUsage,
  expireSubscriptions,
  getDailyUsageSumForMonth,
  correctMonthlyUsage,
} from './db.js';
import { getSystemSettings } from './runtime-config.js';
import { logger } from './logger.js';
import type {
  BillingAccessResult,
  BillingPlan,
  QuotaCheckResult,
  UserSubscription,
} from './types.js';

// --- Billing enabled check ---
// Delegates to getSystemSettings() which already has mtime-based file caching.
// No extra manual cache needed — avoids stale state when settings change.

export function isBillingEnabled(): boolean {
  return getSystemSettings().billingEnabled === true;
}

/** @deprecated No longer needed — isBillingEnabled reads from getSystemSettings cache */
export function clearBillingEnabledCache(): void {
  // no-op: getSystemSettings() handles its own cache invalidation via file mtime
}

// --- Plan management ---

export function getUserEffectivePlan(
  userId: string,
): { plan: BillingPlan; subscription: UserSubscription } | null {
  const sub = getUserActiveSubscription(userId);
  if (sub) return { plan: sub.plan, subscription: sub };

  // Fallback to default plan
  const defaultPlan = getDefaultBillingPlan();
  if (!defaultPlan) return null;

  return {
    plan: defaultPlan,
    subscription: {
      id: `fallback_${userId}`,
      user_id: userId,
      plan_id: defaultPlan.id,
      status: 'active',
      started_at: new Date().toISOString(),
      expires_at: null,
      cancelled_at: null,
      auto_renew: false,
      created_at: new Date().toISOString(),
      trial_ends_at: null,
      notes: null,
    },
  };
}

export function assignPlan(
  userId: string,
  planId: string,
  actorId: string,
  durationDays?: number,
  opts?: { trialDays?: number; notes?: string; autoRenew?: boolean },
): void {
  const plan = getBillingPlan(planId);
  if (!plan) throw new Error(`Plan not found: ${planId}`);

  const now = new Date();
  const expiresAt = durationDays
    ? new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000).toISOString()
    : null;

  const trialDays = opts?.trialDays ?? plan.trial_days;
  const trialEndsAt = trialDays
    ? new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000).toISOString()
    : null;

  const sub: UserSubscription = {
    id: `sub_${userId}_${Date.now()}`,
    user_id: userId,
    plan_id: planId,
    status: 'active',
    started_at: now.toISOString(),
    expires_at: expiresAt,
    cancelled_at: null,
    trial_ends_at: trialEndsAt,
    notes: opts?.notes ?? null,
    auto_renew: opts?.autoRenew ?? false,
    created_at: now.toISOString(),
  };

  createUserSubscription(sub);
  invalidateUserBillingCache(userId);
  logBillingAudit('subscription_assigned', userId, actorId, {
    planId,
    planName: plan.name,
    durationDays: durationDays ?? null,
    trialDays: trialDays ?? null,
    expiresAt,
    autoRenew: sub.auto_renew,
  });
}

export function cancelSubscription(
  userId: string,
  actorId: string,
): void {
  dbCancelSubscription(userId);
  invalidateUserBillingCache(userId);
  logBillingAudit('subscription_cancelled', userId, actorId, {});
}

// --- Quota check (core path) ---

// In-memory LRU cache for quota checks (30s TTL, max 500 entries)
const QUOTA_CACHE_MAX = 500;
const QUOTA_CACHE_TTL = 30_000;
const _quotaCache = new Map<
  string,
  { result: QuotaCheckResult; expires: number }
>();
const _accessCache = new Map<
  string,
  { result: BillingAccessResult; expires: number }
>();

function _quotaCacheSet(key: string, result: QuotaCheckResult): void {
  // Delete first to re-insert at end (Map insertion order = LRU)
  _quotaCache.delete(key);
  _quotaCache.set(key, { result, expires: Date.now() + QUOTA_CACHE_TTL });
  // Evict oldest entries if over capacity
  if (_quotaCache.size > QUOTA_CACHE_MAX) {
    const first = _quotaCache.keys().next().value;
    if (first !== undefined) _quotaCache.delete(first);
  }
}

function _accessCacheSet(key: string, result: BillingAccessResult): void {
  _accessCache.delete(key);
  _accessCache.set(key, { result, expires: Date.now() + QUOTA_CACHE_TTL });
  if (_accessCache.size > QUOTA_CACHE_MAX) {
    const first = _accessCache.keys().next().value;
    if (first !== undefined) _accessCache.delete(first);
  }
}

export function invalidateUserBillingCache(userId: string): void {
  _quotaCache.delete(userId);
  _accessCache.delete(userId);
}

export function invalidateAllBillingCaches(): void {
  _quotaCache.clear();
  _accessCache.clear();
}

export function checkQuota(
  userId: string,
  userRole: string,
): QuotaCheckResult {
  // Admin bypasses all billing
  if (userRole === 'admin') {
    return { allowed: true };
  }

  // Billing disabled → allow all
  if (!isBillingEnabled()) {
    return { allowed: true };
  }

  // Check cache
  const cached = _quotaCache.get(userId);
  if (cached && cached.expires > Date.now()) {
    return cached.result;
  }

  const result = _checkQuotaInternal(userId);

  // Cache result
  _quotaCacheSet(userId, result);

  return result;
}

export function checkBillingAccess(
  userId: string,
  userRole: string,
): BillingAccessResult {
  const cached = _accessCache.get(userId);
  if (cached && cached.expires > Date.now()) {
    return cached.result;
  }

  const result = _checkBillingAccessInternal(userId, userRole);
  _accessCacheSet(userId, result);
  return result;
}

export function checkBillingAccessFresh(
  userId: string,
  userRole: string,
): BillingAccessResult {
  const result = _checkBillingAccessInternal(userId, userRole);
  _accessCacheSet(userId, result);
  return result;
}

function _checkBillingAccessInternal(
  userId: string,
  userRole: string,
): BillingAccessResult {
  const balance = getUserBalance(userId);
  const minBalanceUsd = getSystemSettings().billingMinStartBalanceUsd ?? 0.01;

  if (userRole === 'admin' || !isBillingEnabled()) {
    return {
      allowed: true,
      balanceUsd: balance.balance_usd,
      minBalanceUsd,
      planId: null,
      planName: null,
      subscriptionStatus: null,
    };
  }

  const effective = getUserEffectivePlan(userId);
  if (!effective) {
    return {
      allowed: false,
      blockType: 'plan_inactive',
      reason: '未找到可用套餐，请联系管理员分配套餐',
      balanceUsd: balance.balance_usd,
      minBalanceUsd,
      balanceMissingUsd: Math.max(minBalanceUsd - balance.balance_usd, 0),
      planId: null,
      planName: null,
      subscriptionStatus: null,
    };
  }

  const realSubscription = getUserActiveSubscription(userId);
  const subscriptionStatus = realSubscription?.status ?? 'default';
  const quota = checkQuota(userId, userRole);

  if (balance.balance_usd < minBalanceUsd) {
    return {
      allowed: false,
      blockType: 'insufficient_balance',
      reason: `余额不足，当前余额 $${balance.balance_usd.toFixed(2)}，至少需要 $${minBalanceUsd.toFixed(2)} 才能开始使用`,
      balanceUsd: balance.balance_usd,
      minBalanceUsd,
      balanceMissingUsd: Math.max(minBalanceUsd - balance.balance_usd, 0),
      planId: effective.plan.id,
      planName: effective.plan.name,
      subscriptionStatus,
      warningPercent: quota.warningPercent,
      usage: quota.usage,
      exceededWindow: quota.exceededWindow,
      resetAt: quota.resetAt,
    };
  }

  if (!quota.allowed) {
    return {
      allowed: false,
      blockType: 'quota_exceeded',
      reason: quota.reason,
      balanceUsd: balance.balance_usd,
      minBalanceUsd,
      planId: effective.plan.id,
      planName: effective.plan.name,
      subscriptionStatus,
      warningPercent: quota.warningPercent,
      usage: quota.usage,
      exceededWindow: quota.exceededWindow,
      resetAt: quota.resetAt,
    };
  }

  return {
    allowed: true,
    balanceUsd: balance.balance_usd,
    minBalanceUsd,
    planId: effective.plan.id,
    planName: effective.plan.name,
    subscriptionStatus,
    warningPercent: quota.warningPercent,
    usage: quota.usage,
    exceededWindow: quota.exceededWindow,
    resetAt: quota.resetAt,
  };
}

export function formatBillingAccessDeniedMessage(
  accessResult: BillingAccessResult,
): string {
  const reason = accessResult.reason || '当前账户不可用';
  let resetHint = '';
  if (accessResult.resetAt) {
    const resetDate = new Date(accessResult.resetAt);
    const diffMs = resetDate.getTime() - Date.now();
    if (diffMs > 0) {
      const hours = Math.ceil(diffMs / (1000 * 60 * 60));
      resetHint = hours >= 24
        ? `，约 ${Math.ceil(hours / 24)} 天后重置`
        : `，约 ${hours} 小时后重置`;
    }
  }
  const actionHint =
    accessResult.blockType === 'insufficient_balance'
      ? '请联系管理员充值余额后继续使用。'
      : '请联系管理员调整套餐或额度后继续使用。';
  return `⚠️ ${reason}${resetHint}。${actionHint}`;
}

function logAccessTransition(
  userId: string,
  actorId: string | null,
  before: BillingAccessResult,
  after: BillingAccessResult,
): void {
  if (before.allowed === after.allowed) return;

  if (!after.allowed && after.blockType === 'insufficient_balance') {
    logBillingAudit('wallet_blocked', userId, actorId, {
      balanceUsd: after.balanceUsd,
      minBalanceUsd: after.minBalanceUsd,
      reason: after.reason,
    });
    return;
  }

  if (after.allowed) {
    logBillingAudit('wallet_unblocked', userId, actorId, {
      balanceUsd: after.balanceUsd,
      minBalanceUsd: after.minBalanceUsd,
    });
  }
}

function _checkQuotaInternal(userId: string): QuotaCheckResult {
  const effective = getUserEffectivePlan(userId);
  if (!effective) {
    return {
      allowed: false,
      reason: '未找到有效套餐，请联系管理员',
    };
  }

  const { plan } = effective;
  const now = new Date();
  const usageSnapshot = getQuotaUsageSnapshot(userId, plan, now);
  const {
    dailyCost,
    dailyTokens,
    weeklyCost,
    weeklyTokens,
    monthlyCost,
    monthlyTokens,
    baseUsage,
  } = usageSnapshot;

  // Helper to check a single window
  const checkWindow = (
    costUsed: number,
    costQuota: number | null,
    tokenUsed: number,
    tokenQuota: number | null,
    windowName: 'daily' | 'weekly' | 'monthly',
    resetAt: string,
  ): QuotaCheckResult | null => {
    const labels = { daily: '日度', weekly: '周度', monthly: '月度' };
    if (costQuota != null && costUsed >= costQuota) {
      return {
        allowed: false,
        reason: `${labels[windowName]}费用已达上限 $${costQuota.toFixed(2)}`,
        exceededWindow: windowName,
        resetAt,
        warningPercent: 100,
        usage: baseUsage,
      };
    }
    if (tokenQuota != null && tokenUsed >= tokenQuota) {
      return {
        allowed: false,
        reason: `${labels[windowName]} Token 已达上限 ${tokenQuota.toLocaleString()}`,
        exceededWindow: windowName,
        resetAt,
        warningPercent: 100,
        usage: baseUsage,
      };
    }
    return null;
  };

  // Calculate reset times
  // Check daily → weekly → monthly (first exceeded wins)
  const dailyExceeded = checkWindow(
    dailyCost, plan.daily_cost_quota, dailyTokens, plan.daily_token_quota,
    'daily', usageSnapshot.dailyResetAt,
  );
  if (dailyExceeded) return dailyExceeded;

  const weeklyExceeded = checkWindow(
    weeklyCost, plan.weekly_cost_quota, weeklyTokens, plan.weekly_token_quota,
    'weekly', usageSnapshot.weeklyResetAt,
  );
  if (weeklyExceeded) return weeklyExceeded;

  const monthlyExceeded = checkWindow(
    monthlyCost, plan.monthly_cost_quota, monthlyTokens, plan.monthly_token_quota,
    'monthly', usageSnapshot.monthlyResetAt,
  );
  if (monthlyExceeded) return monthlyExceeded;

  // Calculate warning percentage (highest of all windows)
  let warningPercent: number | undefined;
  const percents: number[] = [];
  if (plan.monthly_cost_quota != null && plan.monthly_cost_quota > 0)
    percents.push(Math.round((monthlyCost / plan.monthly_cost_quota) * 100));
  if (plan.monthly_token_quota != null && plan.monthly_token_quota > 0)
    percents.push(Math.round((monthlyTokens / plan.monthly_token_quota) * 100));
  if (plan.daily_cost_quota != null && plan.daily_cost_quota > 0)
    percents.push(Math.round((dailyCost / plan.daily_cost_quota) * 100));
  if (plan.daily_token_quota != null && plan.daily_token_quota > 0)
    percents.push(Math.round((dailyTokens / plan.daily_token_quota) * 100));
  if (plan.weekly_cost_quota != null && plan.weekly_cost_quota > 0)
    percents.push(Math.round((weeklyCost / plan.weekly_cost_quota) * 100));
  if (plan.weekly_token_quota != null && plan.weekly_token_quota > 0)
    percents.push(Math.round((weeklyTokens / plan.weekly_token_quota) * 100));
  if (percents.length > 0) warningPercent = Math.max(...percents);

  return {
    allowed: true,
    warningPercent,
    usage: baseUsage,
  };
}

// --- Resource limit checks ---

export function checkGroupLimit(
  userId: string,
  userRole: string,
): { allowed: boolean; reason?: string } {
  if (userRole === 'admin' || !isBillingEnabled()) return { allowed: true };

  const effective = getUserEffectivePlan(userId);
  if (!effective) return { allowed: true };

  const { plan } = effective;
  if (plan.max_groups == null) return { allowed: true };

  const count = getUserGroupCount(userId);
  if (count >= plan.max_groups) {
    return {
      allowed: false,
      reason: `工作区数量已达套餐上限 (${plan.max_groups})`,
    };
  }
  return { allowed: true };
}

export function checkImChannelLimit(
  userId: string,
  userRole: string,
  currentEnabledCount: number,
): { allowed: boolean; reason?: string } {
  if (userRole === 'admin' || !isBillingEnabled()) return { allowed: true };

  const effective = getUserEffectivePlan(userId);
  if (!effective) return { allowed: true };

  const { plan } = effective;
  if (plan.max_im_channels == null) return { allowed: true };

  if (currentEnabledCount >= plan.max_im_channels) {
    return {
      allowed: false,
      reason: `IM 通道数已达套餐上限 (${plan.max_im_channels})`,
    };
  }
  return { allowed: true };
}

export function checkMcpServerLimit(
  userId: string,
  userRole: string,
  currentCount: number,
): { allowed: boolean; reason?: string } {
  if (userRole === 'admin' || !isBillingEnabled()) return { allowed: true };

  const effective = getUserEffectivePlan(userId);
  if (!effective) return { allowed: true };

  const { plan } = effective;
  if (plan.max_mcp_servers == null) return { allowed: true };

  if (currentCount >= plan.max_mcp_servers) {
    return {
      allowed: false,
      reason: `MCP Server 数已达套餐上限 (${plan.max_mcp_servers})`,
    };
  }
  return { allowed: true };
}

export function checkStorageLimit(
  userId: string,
  userRole: string,
  currentStorageBytes: number,
  additionalBytes: number,
): { allowed: boolean; reason?: string } {
  if (userRole === 'admin' || !isBillingEnabled()) return { allowed: true };

  const effective = getUserEffectivePlan(userId);
  if (!effective) return { allowed: true };

  const { plan } = effective;
  if (plan.max_storage_mb == null) return { allowed: true };

  const limitBytes = plan.max_storage_mb * 1024 * 1024;
  if (currentStorageBytes + additionalBytes > limitBytes) {
    const usedMB = Math.round(currentStorageBytes / (1024 * 1024));
    return {
      allowed: false,
      reason: `存储空间已达套餐上限 (${usedMB}MB / ${plan.max_storage_mb}MB)`,
    };
  }
  return { allowed: true };
}

export function getUserConcurrentContainerLimit(
  userId: string,
  userRole: string,
): number | null {
  if (userRole === 'admin' || !isBillingEnabled()) return null;

  const effective = getUserEffectivePlan(userId);
  if (!effective) return null;

  return effective.plan.max_concurrent_containers;
}

export function applyAdminBalanceAdjustment(
  userId: string,
  amountUSD: number,
  description: string,
  actorId: string,
  idempotencyKey?: string,
) {
  const user = getUserById(userId);
  const userRole = user?.role ?? 'member';
  const before = checkBillingAccess(userId, userRole);
  const tx = adjustUserBalance(
    userId,
    amountUSD,
    amountUSD > 0 ? 'deposit' : 'adjustment',
    description,
    'admin_adjust',
    null,
    actorId,
    idempotencyKey,
    {
      source: amountUSD > 0 ? 'admin_manual_recharge' : 'admin_manual_deduct',
      operatorType: 'admin',
      notes: description,
      allowNegative: false,
    },
  );
  invalidateUserBillingCache(userId);
  const after = checkBillingAccess(userId, userRole);
  logBillingAudit(amountUSD > 0 ? 'manual_recharge' : 'manual_deduct', userId, actorId, {
    amount: amountUSD,
    description,
    newBalance: tx.balance_after,
  });
  logAccessTransition(userId, actorId, before, after);
  return tx;
}

export function batchAssignPlans(
  userIds: string[],
  planId: string,
  actorId: string,
  durationDays?: number,
): number {
  const count = dbBatchAssignPlan(userIds, planId, actorId, durationDays);
  for (const userId of userIds) invalidateUserBillingCache(userId);
  return count;
}

// --- Usage tracking ---

export function updateUsage(
  userId: string,
  costUSD: number,
  inputTokens: number,
  outputTokens: number,
): ReturnType<typeof getUserEffectivePlan> {
  // Apply rate_multiplier
  const effective = getUserEffectivePlan(userId);
  const multiplier = effective?.plan.rate_multiplier ?? 1.0;
  const effectiveCost = costUSD * multiplier;

  const now = new Date();
  const month = now.toISOString().slice(0, 7);
  const date = now.toISOString().slice(0, 10);

  // 走 atomic helper 让 monthly + daily 在同一 SQLite 事务里写入，
  // 避免进程在两次 UPSERT 之间崩溃留下永久 drift（quota 计算两边依赖一致性）。
  incrementUsageBoth(userId, month, date, inputTokens, outputTokens, effectiveCost);

  // Invalidate quota cache
  invalidateUserBillingCache(userId);

  return effective;
}

export function deductUsageCost(
  userId: string,
  costUSD: number,
  msgId: string,
  cachedEffective?: ReturnType<typeof getUserEffectivePlan>,
): void {
  if (!isBillingEnabled() || costUSD <= 0) return;

  const effective = cachedEffective ?? getUserEffectivePlan(userId);
  if (!effective) return;

  const { plan } = effective;
  const effectiveCost = costUSD * (plan.rate_multiplier ?? 1.0);
  const user = getUserById(userId);
  const userRole = user?.role ?? 'member';
  if (userRole === 'admin') return;
  const before = checkBillingAccess(userId, userRole);

  adjustUserBalance(
    userId,
    -effectiveCost,
    'deduction',
    'AI 调用消费扣费',
    'message',
    msgId,
    null,
    msgId ? `usage_${msgId}` : null,
    {
      source: 'usage_charge',
      operatorType: 'system',
      notes: `消息消费扣费: ${msgId}`,
      allowNegative: true,
    },
  );
  invalidateUserBillingCache(userId);
  const after = checkBillingAccess(userId, userRole);
  logBillingAudit('balance_deducted', userId, null, {
    amount: effectiveCost,
    messageId: msgId,
    balanceUsd: after.balanceUsd,
  });
  logAccessTransition(userId, null, before, after);
}

// --- Redeem codes ---

export function redeemCode(
  userId: string,
  code: string,
): { success: boolean; message: string } {
  const rc = getRedeemCode(code);
  if (!rc) {
    return { success: false, message: '兑换码不存在' };
  }

  // Check expiry
  if (rc.expires_at && new Date(rc.expires_at) < new Date()) {
    return { success: false, message: '兑换码已过期' };
  }

  // Check usage limit
  if (rc.used_count >= rc.max_uses) {
    return { success: false, message: '兑换码已达使用上限' };
  }

  // Check if user already redeemed
  if (hasUserRedeemedCode(userId, code)) {
    return { success: false, message: '您已使用过此兑换码' };
  }

  // Pre-validate code data before consuming usage (no rollback on failure)
  if (rc.type === 'balance' && (rc.value_usd ?? 0) <= 0) {
    return { success: false, message: '兑换码金额无效' };
  }
  if (rc.type === 'subscription') {
    if (!rc.plan_id) return { success: false, message: '兑换码配置错误（无套餐）' };
    if (!getBillingPlan(rc.plan_id)) return { success: false, message: '兑换码关联的套餐不存在' };
  }

  // Optimistic lock: try to increment usage count atomically
  if (!tryIncrementRedeemCodeUsage(code, userId)) {
    return { success: false, message: '兑换码已达使用上限' };
  }

  // Apply redeem code
  if (rc.type === 'balance') {
    const amount = rc.value_usd!;
    adjustUserBalance(
      userId,
      amount,
      'redeem',
      `兑换码充值: ${code}`,
      'redeem_code',
      code,
      null,
      `redeem_${code}_${userId}`,
      {
        source: 'redeem_code',
        operatorType: 'user',
        notes: `兑换码充值: ${code}`,
        allowNegative: false,
      },
    );
    invalidateUserBillingCache(userId);
    logBillingAudit('code_redeemed', userId, null, {
      code,
      type: 'balance',
      amount,
    });
    return {
      success: true,
      message: `成功充值 $${amount.toFixed(2)}`,
    };
  }

  if (rc.type === 'subscription') {
    const planId = rc.plan_id!;
    const plan = getBillingPlan(planId)!;

    assignPlan(userId, planId, userId, rc.duration_days ?? undefined);
    logBillingAudit('code_redeemed', userId, null, {
      code,
      type: 'subscription',
      planId,
      planName: plan.name,
      durationDays: rc.duration_days,
    });
    return {
      success: true,
      message: `成功激活套餐「${plan.name}」`,
    };
  }

  if (rc.type === 'trial') {
    const days = rc.duration_days ?? 7;
    if (!redeemTrial(userId, days)) {
      return { success: false, message: '无法激活试用（未找到可用套餐）' };
    }
    logBillingAudit('code_redeemed', userId, null, {
      code,
      type: 'trial',
      trialDays: days,
    });
    return {
      success: true,
      message: `成功激活 ${days} 天试用`,
    };
  }

  return { success: false, message: '未知兑换码类型' };
}

/**
 * Extend or create a trial period for a user's current subscription.
 */
export function redeemTrial(userId: string, days: number): boolean {
  const effective = getUserEffectivePlan(userId);
  if (!effective) return false;

  const now = new Date();
  const currentTrialEnd = effective.subscription.trial_ends_at
    ? new Date(effective.subscription.trial_ends_at)
    : now;
  const base = currentTrialEnd > now ? currentTrialEnd : now;
  const newTrialEnd = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);

  // Re-assign the same plan with extended trial
  assignPlan(userId, effective.plan.id, userId, undefined, {
    trialDays: Math.ceil((newTrialEnd.getTime() - now.getTime()) / (24 * 60 * 60 * 1000)),
    notes: `试用延长 ${days} 天`,
  });
  return true;
}

// --- Generate redeem codes ---

export function generateRedeemCode(length = 16): string {
  return crypto
    .randomBytes(length)
    .toString('base64url')
    .slice(0, length)
    .toUpperCase();
}

// --- Periodic tasks ---

export function checkAndExpireSubscriptions(): void {
  try {
    const expired = expireSubscriptions();
    if (expired > 0) {
      invalidateAllBillingCaches();
      logger.info({ expired }, 'Expired billing subscriptions');
    }
  } catch (err) {
    logger.error({ err }, 'Failed to check subscription expiry');
  }
}

/**
 * Reconcile monthly_usage against daily_usage aggregation for a specific user/month.
 * Used as a periodic safety net to fix drift when incrementMonthlyUsage was missed.
 * If drift exceeds threshold, corrects monthly_usage to match daily_usage sum.
 */
export function reconcileMonthlyUsage(
  userId: string,
  month: string,
): void {
  try {
    const dailySum = getDailyUsageSumForMonth(userId, month);
    const existing = getMonthlyUsage(userId, month);

    const recordedCost = existing?.total_cost_usd ?? 0;
    const actualCost = dailySum.totalCost;
    const drift = Math.abs(recordedCost - actualCost);

    // Only correct if drift exceeds $0.01 threshold
    if (drift > 0.01) {
      logger.info(
        {
          userId,
          month,
          recorded: recordedCost,
          actual: actualCost,
          drift,
          recordedTokens: (existing?.total_input_tokens ?? 0) + (existing?.total_output_tokens ?? 0),
          actualTokens: dailySum.totalInputTokens + dailySum.totalOutputTokens,
        },
        'Monthly usage drift detected, correcting',
      );
      correctMonthlyUsage(
        userId,
        month,
        dailySum.totalInputTokens,
        dailySum.totalOutputTokens,
        dailySum.totalCost,
        dailySum.messageCount,
      );
      // Invalidate quota cache after correction
      invalidateUserBillingCache(userId);
    }
  } catch (err) {
    logger.warn({ err, userId, month }, 'Monthly usage reconciliation failed');
  }
}

function getQuotaUsageSnapshot(
  userId: string,
  plan: BillingPlan,
  now = new Date(),
): {
  dailyCost: number;
  dailyTokens: number;
  weeklyCost: number;
  weeklyTokens: number;
  monthlyCost: number;
  monthlyTokens: number;
  dailyResetAt: string;
  weeklyResetAt: string;
  monthlyResetAt: string;
  baseUsage: NonNullable<QuotaCheckResult['usage']>;
} {
  const today = now.toISOString().slice(0, 10);
  const month = now.toISOString().slice(0, 7);

  const dailyUsage = getDailyUsage(userId, today);
  const weeklySummary = getWeeklyUsageSummary(userId);
  const monthlyUsage = getMonthlyUsage(userId, month);

  const dailyCost = dailyUsage?.total_cost_usd ?? 0;
  const dailyTokens =
    (dailyUsage?.total_input_tokens ?? 0) +
    (dailyUsage?.total_output_tokens ?? 0);
  const weeklyCost = weeklySummary.totalCost;
  const weeklyTokens = weeklySummary.totalTokens;
  const monthlyCost = monthlyUsage?.total_cost_usd ?? 0;
  const monthlyTokens =
    (monthlyUsage?.total_input_tokens ?? 0) +
    (monthlyUsage?.total_output_tokens ?? 0);

  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(0, 0, 0, 0);

  const nextMonday = new Date(now);
  nextMonday.setDate(
    nextMonday.getDate() + ((7 - nextMonday.getDay()) % 7) + 1,
  );
  nextMonday.setHours(0, 0, 0, 0);

  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  return {
    dailyCost,
    dailyTokens,
    weeklyCost,
    weeklyTokens,
    monthlyCost,
    monthlyTokens,
    dailyResetAt: tomorrow.toISOString(),
    weeklyResetAt: nextMonday.toISOString(),
    monthlyResetAt: nextMonth.toISOString(),
    baseUsage: {
      costUsed: monthlyCost,
      costQuota: plan.monthly_cost_quota,
      tokenUsed: monthlyTokens,
      tokenQuota: plan.monthly_token_quota,
      daily: {
        costUsed: dailyCost,
        costQuota: plan.daily_cost_quota,
        tokenUsed: dailyTokens,
        tokenQuota: plan.daily_token_quota,
      },
      weekly: {
        costUsed: weeklyCost,
        costQuota: plan.weekly_cost_quota,
        tokenUsed: weeklyTokens,
        tokenQuota: plan.weekly_token_quota,
      },
    },
  };
}
