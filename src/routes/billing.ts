/**
 * Billing API routes: user-facing + admin management.
 */

import { Hono } from 'hono';
import { authMiddleware, requirePermission } from '../middleware/auth.js';
import {
  getActiveBillingPlans,
  getAllBillingPlans,
  getBillingPlan,
  createBillingPlan,
  updateBillingPlan,
  deleteBillingPlan,
  getUserActiveSubscription,
  getUserBalance,
  getBalanceTransactions,
  getMonthlyUsage,
  getUserMonthlyUsageHistory,
  getUserDailyUsageHistory,
  getSubscriptionHistory,
  getRedeemCodeUsageDetails,
  getDashboardStats,
  getRevenueTrend,
  getAllRedeemCodes,
  getAllPlanSubscriberCounts,
  createRedeemCode as dbCreateRedeemCode,
  deleteRedeemCode as dbDeleteRedeemCode,
  logBillingAudit,
  getBillingAuditLog,
  getAllUserBillingOverview,
  getRevenueStats,
  getUserById,
  getDailyUsage,
  getWeeklyUsageSummary,
} from '../db.js';
import {
  isBillingEnabled,
  checkBillingAccess,
  getUserEffectivePlan,
  checkQuota,
  assignPlan,
  applyAdminBalanceAdjustment,
  batchAssignPlans,
  cancelSubscription,
  redeemCode,
  generateRedeemCode,
  invalidateAllBillingCaches,
} from '../billing.js';
import {
  BillingPlanCreateSchema,
  BillingPlanPatchSchema,
  AssignPlanSchema,
  AdjustBalanceSchema,
  BatchAssignPlanSchema,
  RedeemCodeCreateSchema,
  RedeemCodeSchema,
} from '../schemas.js';
import { getSystemSettings } from '../runtime-config.js';
import type { Variables } from '../web-context.js';
import type { AuthUser, BillingPlan, RedeemCode } from '../types.js';

const billingRoutes = new Hono<{ Variables: Variables }>();
const billingManageMiddleware = requirePermission('manage_billing');

// ==================== User-facing endpoints ====================

// GET /plans — list available plans
billingRoutes.get('/plans', authMiddleware, async (c) => {
  const plans = getActiveBillingPlans();
  return c.json({ plans });
});

// GET /my/subscription — current subscription + plan details
billingRoutes.get('/my/subscription', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const effective = getUserEffectivePlan(user.id);
  if (!effective) {
    return c.json({ subscription: null, plan: null });
  }
  return c.json({
    subscription: effective.subscription,
    plan: effective.plan,
  });
});

// GET /my/balance — current balance
billingRoutes.get('/my/balance', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const balance = getUserBalance(user.id);
  return c.json(balance);
});

// GET /my/usage — current month usage + quota progress
billingRoutes.get('/my/usage', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const month = new Date().toISOString().slice(0, 7);
  const usage = getMonthlyUsage(user.id, month);
  const effective = getUserEffectivePlan(user.id);
  const history = getUserMonthlyUsageHistory(user.id, 6);

  return c.json({
    currentMonth: month,
    usage: usage ?? {
      user_id: user.id,
      month,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_cost_usd: 0,
      message_count: 0,
      updated_at: new Date().toISOString(),
    },
    plan: effective?.plan ?? null,
    history,
  });
});

// GET /my/transactions — balance change history (paginated)
billingRoutes.get('/my/transactions', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const limit = Math.min(parseInt(c.req.query('limit') || '50'), 100);
  const offset = parseInt(c.req.query('offset') || '0');
  const result = getBalanceTransactions(user.id, limit, offset);
  return c.json(result);
});

// GET /my/quota — enhanced current quota status (daily/weekly/monthly)
billingRoutes.get('/my/quota', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const result = checkQuota(user.id, user.role);
  return c.json(result);
});

// GET /my/access — current billing access status (wallet-first)
billingRoutes.get('/my/access', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const result = checkBillingAccess(user.id, user.role);
  return c.json(result);
});

// POST /my/redeem — use a redeem code
billingRoutes.post('/my/redeem', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const validation = RedeemCodeSchema.safeParse(body);
  if (!validation.success) {
    return c.json({ error: 'Invalid request body' }, 400);
  }
  const result = redeemCode(user.id, validation.data.code);
  if (!result.success) {
    return c.json({ error: result.message }, 400);
  }
  return c.json({ message: result.message });
});

// PATCH /my/auto-renew — toggle auto-renew
billingRoutes.patch('/my/auto-renew', authMiddleware, async (c) => {
  return c.json(
    { error: '余额优先模式下不支持用户自助自动续费，请联系管理员处理套餐' },
    409,
  );
});

// POST /my/cancel-subscription — user self-cancel
billingRoutes.post('/my/cancel-subscription', authMiddleware, async (c) => {
  return c.json(
    { error: '余额优先模式下不支持用户自助取消套餐，请联系管理员处理' },
    409,
  );
});

// ==================== Admin endpoints ====================

// POST /admin/plans — create plan
billingRoutes.post(
  '/admin/plans',
  authMiddleware,
  billingManageMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const validation = BillingPlanCreateSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }

    const existing = getBillingPlan(validation.data.id);
    if (existing) {
      return c.json({ error: 'Plan ID already exists' }, 409);
    }

    const now = new Date().toISOString();
    const plan: BillingPlan = {
      id: validation.data.id,
      name: validation.data.name,
      description: validation.data.description ?? null,
      tier: validation.data.tier ?? 0,
      monthly_cost_usd: validation.data.monthly_cost_usd ?? 0,
      monthly_token_quota: validation.data.monthly_token_quota ?? null,
      monthly_cost_quota: validation.data.monthly_cost_quota ?? null,
      daily_cost_quota: validation.data.daily_cost_quota ?? null,
      weekly_cost_quota: validation.data.weekly_cost_quota ?? null,
      daily_token_quota: validation.data.daily_token_quota ?? null,
      weekly_token_quota: validation.data.weekly_token_quota ?? null,
      rate_multiplier: validation.data.rate_multiplier ?? 1.0,
      trial_days: validation.data.trial_days ?? null,
      sort_order: validation.data.sort_order ?? 0,
      display_price: validation.data.display_price ?? null,
      highlight: validation.data.highlight ?? false,
      max_groups: validation.data.max_groups ?? null,
      max_concurrent_containers:
        validation.data.max_concurrent_containers ?? null,
      max_im_channels: validation.data.max_im_channels ?? null,
      max_mcp_servers: validation.data.max_mcp_servers ?? null,
      max_storage_mb: validation.data.max_storage_mb ?? null,
      allow_overage: validation.data.allow_overage ?? false,
      features: validation.data.features ?? [],
      is_default: validation.data.is_default ?? false,
      is_active: validation.data.is_active ?? true,
      created_at: now,
      updated_at: now,
    };

    createBillingPlan(plan);
    const actor = c.get('user') as AuthUser;
    logBillingAudit('plan_created', actor.id, actor.id, {
      planId: plan.id,
      planName: plan.name,
    });
    return c.json(plan, 201);
  },
);

// PATCH /admin/plans/:id — update plan
billingRoutes.patch(
  '/admin/plans/:id',
  authMiddleware,
  billingManageMiddleware,
  async (c) => {
    const id = c.req.param('id');
    const existing = getBillingPlan(id);
    if (!existing) return c.json({ error: 'Plan not found' }, 404);

    const body = await c.req.json().catch(() => ({}));
    const validation = BillingPlanPatchSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }

    updateBillingPlan(id, validation.data);
    invalidateAllBillingCaches();
    const actor = c.get('user') as AuthUser;
    logBillingAudit('plan_updated', actor.id, actor.id, {
      planId: id,
      updates: validation.data,
    });
    const updated = getBillingPlan(id);
    return c.json(updated);
  },
);

// DELETE /admin/plans/:id — delete plan
billingRoutes.delete(
  '/admin/plans/:id',
  authMiddleware,
  billingManageMiddleware,
  async (c) => {
    const id = c.req.param('id');
    const plan = getBillingPlan(id);
    if (!plan) return c.json({ error: 'Plan not found' }, 404);
    if (plan.is_default) {
      return c.json({ error: 'Cannot delete the default plan' }, 400);
    }

    const deleted = deleteBillingPlan(id);
    if (!deleted) {
      return c.json(
        {
          error:
            'Cannot delete plan with referenced subscriptions (including cancelled/expired). Migrate or delete those subscription rows first.',
        },
        409,
      );
    }

    const actor = c.get('user') as AuthUser;
    logBillingAudit('plan_deleted', actor.id, actor.id, {
      planId: id,
      planName: plan.name,
    });
    return c.json({ success: true });
  },
);

// GET /admin/users — all users billing overview
billingRoutes.get(
  '/admin/users',
  authMiddleware,
  billingManageMiddleware,
  async (c) => {
    const users = getAllUserBillingOverview().map((u) => {
      // Fill in fallback plan info for users without a real subscription
      const access = checkBillingAccess(u.user_id, u.role);
      if (!u.plan_id) {
        const effective = getUserEffectivePlan(u.user_id);
        if (effective) {
          return {
            ...u,
            plan_id: effective.plan.id,
            plan_name: effective.plan.name,
            is_fallback: true,
            access_allowed: access.allowed,
            access_block_type: access.blockType ?? null,
            access_reason: access.reason ?? null,
            min_balance_usd: access.minBalanceUsd,
          };
        }
      }
      return {
        ...u,
        is_fallback: false,
        access_allowed: access.allowed,
        access_block_type: access.blockType ?? null,
        access_reason: access.reason ?? null,
        min_balance_usd: access.minBalanceUsd,
      };
    });
    return c.json({ users });
  },
);

// GET /admin/users/:id/detail — user billing detail (flat structure for drawer)
billingRoutes.get(
  '/admin/users/:id/detail',
  authMiddleware,
  billingManageMiddleware,
  async (c) => {
    const userId = c.req.param('id');
    const user = getUserById(userId);
    if (!user) {
      return c.json({ error: '用户不存在' }, 404);
    }
    const effective = getUserEffectivePlan(userId);
    const realSubscription = getUserActiveSubscription(userId);
    const balance = getUserBalance(userId);
    const month = new Date().toISOString().slice(0, 7);
    const today = new Date().toISOString().slice(0, 10);
    const usage = getMonthlyUsage(userId, month);
    const dailyUsage = getDailyUsage(userId, today);
    const weeklySummary = getWeeklyUsageSummary(userId);
    const plan = effective?.plan ?? null;
    const isFallback = !realSubscription && !!effective;
    const access = checkBillingAccess(userId, user.role);

    return c.json({
      // User info
      user_id: user.id,
      username: user.username,
      display_name: user.display_name,
      role: user.role,
      // Plan info
      plan_id: plan?.id ?? null,
      plan_name: plan?.name ?? null,
      subscription_status: realSubscription?.status ?? (isFallback ? 'default' : null),
      is_fallback: isFallback,
      has_real_subscription: !!realSubscription,
      access_allowed: access.allowed,
      access_block_type: access.blockType ?? null,
      access_reason: access.reason ?? null,
      min_balance_usd: access.minBalanceUsd,
      // Balance
      balance_usd: balance.balance_usd,
      // Usage
      current_month_cost: usage?.total_cost_usd ?? 0,
      daily_cost_used: dailyUsage?.total_cost_usd ?? 0,
      daily_cost_quota: plan?.daily_cost_quota ?? null,
      weekly_cost_used: weeklySummary.totalCost,
      weekly_cost_quota: plan?.weekly_cost_quota ?? null,
      monthly_cost_quota: plan?.monthly_cost_quota ?? null,
    });
  },
);

// GET /admin/users/:id/transactions — user balance transactions
billingRoutes.get(
  '/admin/users/:id/transactions',
  authMiddleware,
  billingManageMiddleware,
  async (c) => {
    const userId = c.req.param('id');
    const limit = Math.min(parseInt(c.req.query('limit') || '20'), 100);
    const offset = parseInt(c.req.query('offset') || '0');
    const result = getBalanceTransactions(userId, limit, offset);
    return c.json(result);
  },
);

// POST /admin/users/:id/assign-plan — assign plan to user
billingRoutes.post(
  '/admin/users/:id/assign-plan',
  authMiddleware,
  billingManageMiddleware,
  async (c) => {
    const userId = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const validation = AssignPlanSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }

    const actor = c.get('user') as AuthUser;
    try {
      assignPlan(
        userId,
        validation.data.plan_id,
        actor.id,
        validation.data.duration_days,
      );
      return c.json({ success: true });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to assign plan';
      return c.json({ error: message }, 400);
    }
  },
);

// POST /admin/users/:id/adjust-balance — adjust user balance
billingRoutes.post(
  '/admin/users/:id/adjust-balance',
  authMiddleware,
  billingManageMiddleware,
  async (c) => {
    const userId = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const validation = AdjustBalanceSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }

    const actor = c.get('user') as AuthUser;
    try {
      const tx = applyAdminBalanceAdjustment(
        userId,
        validation.data.amount_usd,
        validation.data.description,
        actor.id,
        validation.data.idempotency_key,
      );
      return c.json(tx);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : '调整余额失败';
      return c.json({ error: message }, 400);
    }
  },
);

// GET /admin/redeem-codes — list all redeem codes
billingRoutes.get(
  '/admin/redeem-codes',
  authMiddleware,
  billingManageMiddleware,
  async (c) => {
    const codes = getAllRedeemCodes();
    return c.json({ codes });
  },
);

// POST /admin/redeem-codes — create redeem code(s)
billingRoutes.post(
  '/admin/redeem-codes',
  authMiddleware,
  billingManageMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const validation = RedeemCodeCreateSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }

    const actor = c.get('user') as AuthUser;
    const count = validation.data.count ?? 1;
    const prefix = validation.data.prefix ?? '';
    const now = new Date();
    const expiresAt = validation.data.expires_in_hours
      ? new Date(
          now.getTime() + validation.data.expires_in_hours * 60 * 60 * 1000,
        ).toISOString()
      : null;

    const batchId = count > 1 ? `batch_${Date.now()}` : null;
    const codes: RedeemCode[] = [];
    for (let i = 0; i < count; i++) {
      const rawCode = generateRedeemCode();
      const code: RedeemCode = {
        code: prefix ? `${prefix}-${rawCode}` : rawCode,
        type: validation.data.type,
        value_usd: validation.data.value_usd ?? null,
        plan_id: validation.data.plan_id ?? null,
        duration_days: validation.data.duration_days ?? null,
        max_uses: validation.data.max_uses ?? 1,
        used_count: 0,
        expires_at: expiresAt,
        created_by: actor.id,
        notes: validation.data.notes ?? null,
        batch_id: batchId,
        created_at: now.toISOString(),
      };
      dbCreateRedeemCode(code);
      codes.push(code);
    }

    logBillingAudit('code_created', actor.id, actor.id, {
      count,
      type: validation.data.type,
      codes: codes.map((c) => c.code),
    });

    return c.json({ codes }, 201);
  },
);

// DELETE /admin/redeem-codes/:code — delete redeem code
billingRoutes.delete(
  '/admin/redeem-codes/:code',
  authMiddleware,
  billingManageMiddleware,
  async (c) => {
    const code = c.req.param('code');
    const deleted = dbDeleteRedeemCode(code);
    if (!deleted) return c.json({ error: 'Code not found' }, 404);

    const actor = c.get('user') as AuthUser;
    logBillingAudit('code_deleted', actor.id, actor.id, { code });
    return c.json({ success: true });
  },
);

// GET /admin/audit-log — billing audit log
billingRoutes.get(
  '/admin/audit-log',
  authMiddleware,
  billingManageMiddleware,
  async (c) => {
    const limit = Math.min(parseInt(c.req.query('limit') || '50'), 200);
    const offset = parseInt(c.req.query('offset') || '0');
    const userId = c.req.query('user_id');
    const eventType = c.req.query('event_type');
    const result = getBillingAuditLog(limit, offset, userId || undefined, eventType || undefined);
    return c.json(result);
  },
);

// GET /admin/revenue — revenue summary
billingRoutes.get(
  '/admin/revenue',
  authMiddleware,
  billingManageMiddleware,
  async (c) => {
    const stats = getRevenueStats();
    return c.json(stats);
  },
);

// GET /admin/plans — all plans (including inactive)
billingRoutes.get(
  '/admin/plans',
  authMiddleware,
  billingManageMiddleware,
  async (c) => {
    const plans = getAllBillingPlans();
    const subscriberCounts = getAllPlanSubscriberCounts();
    const plansWithCount = plans.map((p) => ({
      ...p,
      subscriber_count: subscriberCounts[p.id] ?? 0,
    }));
    return c.json({ plans: plansWithCount });
  },
);

// POST /admin/users/batch-assign-plan — batch assign plan
billingRoutes.post(
  '/admin/users/batch-assign-plan',
  authMiddleware,
  billingManageMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const validation = BatchAssignPlanSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }
    const actor = c.get('user') as AuthUser;
    try {
      const count = batchAssignPlans(
        validation.data.user_ids,
        validation.data.plan_id,
        actor.id,
        validation.data.duration_days,
      );
      return c.json({ success: true, count });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to batch assign';
      return c.json({ error: message }, 400);
    }
  },
);

// POST /admin/users/:id/cancel-subscription — cancel user subscription
billingRoutes.post(
  '/admin/users/:id/cancel-subscription',
  authMiddleware,
  billingManageMiddleware,
  async (c) => {
    const userId = c.req.param('id');
    const actor = c.get('user') as AuthUser;
    cancelSubscription(userId, actor.id);
    return c.json({ success: true });
  },
);

// GET /admin/users/:id/subscription-history — user subscription history
billingRoutes.get(
  '/admin/users/:id/subscription-history',
  authMiddleware,
  billingManageMiddleware,
  async (c) => {
    const userId = c.req.param('id');
    const history = getSubscriptionHistory(userId);
    return c.json({ history });
  },
);

// GET /admin/redeem-codes/export — CSV export
billingRoutes.get(
  '/admin/redeem-codes/export',
  authMiddleware,
  billingManageMiddleware,
  async (c) => {
    const codes = getAllRedeemCodes();
    const header = 'code,type,value_usd,plan_id,duration_days,max_uses,used_count,expires_at,notes,batch_id,created_at\n';
    const csvEscape = (val: unknown): string => {
      const s = String(val ?? '');
      if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };
    const rows = codes.map((rc) =>
      [
        csvEscape(rc.code),
        csvEscape(rc.type),
        csvEscape(rc.value_usd ?? ''),
        csvEscape(rc.plan_id ?? ''),
        csvEscape(rc.duration_days ?? ''),
        csvEscape(rc.max_uses),
        csvEscape(rc.used_count),
        csvEscape(rc.expires_at ?? ''),
        csvEscape(rc.notes ?? ''),
        csvEscape(rc.batch_id ?? ''),
        csvEscape(rc.created_at ?? ''),
      ].join(','),
    );
    const csv = '\uFEFF' + header + rows.join('\n');
    return new Response(csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename=redeem-codes-${new Date().toISOString().slice(0, 10)}.csv`,
      },
    });
  },
);

// GET /admin/redeem-codes/:code/usage — redeem code usage details
billingRoutes.get(
  '/admin/redeem-codes/:code/usage',
  authMiddleware,
  billingManageMiddleware,
  async (c) => {
    const code = c.req.param('code');
    const details = getRedeemCodeUsageDetails(code);
    return c.json({ details });
  },
);

// GET /admin/dashboard — dashboard stats
billingRoutes.get(
  '/admin/dashboard',
  authMiddleware,
  billingManageMiddleware,
  async (c) => {
    const stats = getDashboardStats();
    return c.json(stats);
  },
);

// GET /admin/revenue/trend — revenue trend by month
billingRoutes.get(
  '/admin/revenue/trend',
  authMiddleware,
  billingManageMiddleware,
  async (c) => {
    const months = Math.min(parseInt(c.req.query('months') || '6'), 24);
    const trend = getRevenueTrend(months);
    return c.json({ trend });
  },
);

// GET /my/usage/daily — daily usage history for charts
billingRoutes.get('/my/usage/daily', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const days = Math.min(parseInt(c.req.query('days') || '14'), 90);
  const history = getUserDailyUsageHistory(user.id, days);
  return c.json({ history });
});

// GET /status — billing enabled status + currency settings (no manage_billing required)
billingRoutes.get('/status', authMiddleware, async (c) => {
  const enabled = isBillingEnabled();
  const settings = getSystemSettings();
  return c.json({
    enabled,
    mode: settings.billingMode ?? 'wallet_first',
    minStartBalanceUsd: settings.billingMinStartBalanceUsd ?? 0.01,
    currency: settings.billingCurrency ?? 'USD',
    currencyRate: settings.billingCurrencyRate ?? 1,
  });
});

export default billingRoutes;
