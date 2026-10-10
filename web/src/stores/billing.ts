import { create } from 'zustand';
import { api } from '../api/client';

// Several billing cards mount together and each asks for the same data;
// concurrent calls share one request. A refresh after a mutation passes
// `force`: a request already in flight may predate the change.
const inFlight = new Map<string, Promise<void>>();
function shared(
  key: string,
  load: () => Promise<void>,
  force = false,
): Promise<void> {
  const pending = inFlight.get(key);
  if (pending && !force) return pending;
  const request = load().finally(() => {
    if (inFlight.get(key) === request) inFlight.delete(key);
  });
  inFlight.set(key, request);
  return request;
}

// --- Types ---

export interface BillingPlan {
  id: string;
  name: string;
  description: string | null;
  tier: number;
  monthly_cost_usd: number;
  monthly_token_quota: number | null;
  monthly_cost_quota: number | null;
  max_groups: number | null;
  max_concurrent_containers: number | null;
  max_im_channels: number | null;
  max_mcp_servers: number | null;
  max_storage_mb: number | null;
  allow_overage: boolean;
  features: string[];
  is_default: boolean;
  is_active: boolean;
  daily_cost_quota: number | null;
  weekly_cost_quota: number | null;
  daily_token_quota: number | null;
  weekly_token_quota: number | null;
  rate_multiplier: number;
  trial_days: number | null;
  sort_order: number;
  display_price: string | null;
  highlight: boolean;
  created_at: string;
  updated_at: string;
}

export interface UserSubscription {
  id: string;
  user_id: string;
  plan_id: string;
  status: 'active' | 'expired' | 'cancelled';
  started_at: string;
  expires_at: string | null;
  cancelled_at: string | null;
  auto_renew: boolean;
  trial_ends_at: string | null;
  notes: string | null;
  created_at: string;
}

export interface UserBalance {
  user_id: string;
  balance_usd: number;
  total_deposited_usd: number;
  total_consumed_usd: number;
  updated_at: string;
}

export interface BalanceTransaction {
  id: number;
  user_id: string;
  type: string;
  amount_usd: number;
  balance_after: number;
  description: string | null;
  reference_type: string | null;
  reference_id: string | null;
  actor_id: string | null;
  source?: string | null;
  operator_type?: string | null;
  notes?: string | null;
  idempotency_key?: string | null;
  created_at: string;
}

export interface MonthlyUsage {
  user_id: string;
  month: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  message_count: number;
  updated_at: string;
}

export interface QuotaWindowUsage {
  costUsed: number;
  costQuota: number | null;
  tokenUsed: number;
  tokenQuota: number | null;
}

export interface QuotaCheckResult {
  allowed: boolean;
  reason?: string;
  exceededWindow?: 'daily' | 'weekly' | 'monthly';
  resetAt?: string;
  warningPercent?: number;
  usage?: QuotaWindowUsage & {
    daily?: QuotaWindowUsage;
    weekly?: QuotaWindowUsage;
  };
}

export type BillingBlockType =
  | 'insufficient_balance'
  | 'plan_inactive'
  | 'quota_exceeded'
  | 'resource_limit';

export interface BillingAccessResult {
  allowed: boolean;
  blockType?: BillingBlockType;
  reason?: string;
  balanceUsd: number;
  minBalanceUsd: number;
  balanceMissingUsd?: number;
  planId: string | null;
  planName: string | null;
  subscriptionStatus: 'active' | 'expired' | 'cancelled' | 'default' | null;
  warningPercent?: number;
  usage?: QuotaCheckResult['usage'];
  exceededWindow?: 'daily' | 'weekly' | 'monthly';
  resetAt?: string;
}

export interface RedeemCode {
  code: string;
  type: 'balance' | 'subscription' | 'trial';
  value_usd: number | null;
  plan_id: string | null;
  duration_days: number | null;
  batch_id: string | null;
  max_uses: number;
  used_count: number;
  expires_at: string | null;
  created_by: string;
  notes: string | null;
  created_at: string;
}

export interface BillingAuditLog {
  id: number;
  event_type: string;
  user_id: string;
  actor_id: string | null;
  details: Record<string, unknown> | null;
  created_at: string;
}

export interface UserBillingOverview {
  user_id: string;
  username: string;
  display_name: string;
  role: string;
  plan_id: string | null;
  plan_name: string | null;
  is_fallback?: boolean;
  balance_usd: number;
  current_month_cost: number;
  access_allowed?: boolean;
  access_block_type?: BillingBlockType | null;
  access_reason?: string | null;
  min_balance_usd?: number;
}

export interface RevenueStats {
  totalDeposited: number;
  totalConsumed: number;
  activeSubscriptions: number;
  currentMonthRevenue: number;
  blockedUsers?: number;
}

export interface DailyUsage {
  user_id: string;
  date: string;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  message_count: number;
}

export interface DashboardData {
  activeUsers: number;
  totalUsers: number;
  planDistribution: Array<{ plan_name: string; count: number }>;
  todayCost: number;
  monthCost: number;
  activeSubscriptions: number;
  blockedUsers?: number;
}

export interface RevenueTrendItem {
  month: string;
  revenue: number;
  users: number;
}

export interface SubscriptionHistoryItem {
  id: string;
  user_id: string;
  plan_id: string;
  plan_name: string;
  status: string;
  started_at: string;
  expires_at: string | null;
  cancelled_at: string | null;
  trial_ends_at: string | null;
  notes: string | null;
  created_at: string;
}

// --- Store ---

interface BillingState {
  // Status
  billingEnabled: boolean;
  billingStatusLoaded: boolean;
  billingMode: 'wallet_first';
  billingMinStartBalanceUsd: number;
  billingCurrency: string;
  billingCurrencyRate: number;
  loading: boolean;
  error: string | null;

  // User data
  subscription: UserSubscription | null;
  plan: BillingPlan | null;
  balance: UserBalance | null;
  access: BillingAccessResult | null;
  currentUsage: MonthlyUsage | null;
  usageHistory: MonthlyUsage[];
  transactions: BalanceTransaction[];
  transactionsTotal: number;
  quota: QuotaCheckResult | null;

  // Admin data
  plans: BillingPlan[];
  allUsers: UserBillingOverview[];
  redeemCodes: RedeemCode[];
  auditLogs: BillingAuditLog[];
  auditLogsTotal: number;
  revenue: RevenueStats | null;
  dailyUsage: DailyUsage[];
  dashboardData: DashboardData | null;
  revenueTrend: RevenueTrendItem[];

  // User actions
  loadBillingStatus: (opts?: { force?: boolean }) => Promise<void>;
  loadMySubscription: () => Promise<void>;
  loadMyBalance: () => Promise<void>;
  loadMyAccess: (opts?: { force?: boolean }) => Promise<void>;
  loadMyUsage: () => Promise<void>;
  loadMyTransactions: (limit?: number, offset?: number) => Promise<void>;
  loadMyQuota: () => Promise<void>;
  redeemCode: (code: string) => Promise<{ success: boolean; message: string }>;
  loadPlans: () => Promise<void>;
  loadDailyUsage: (days?: number) => Promise<void>;
  toggleAutoRenew: (autoRenew: boolean) => Promise<void>;
  cancelMySubscription: () => Promise<void>;

  // WebSocket handler
  handleBillingUpdate: (data: BillingAccessResult) => void;

  // Admin actions
  loadAllPlans: () => Promise<void>;
  createPlan: (
    plan: Partial<BillingPlan> & { id: string; name: string },
  ) => Promise<void>;
  updatePlan: (id: string, updates: Partial<BillingPlan>) => Promise<void>;
  deletePlan: (id: string) => Promise<boolean>;
  loadAllUsers: () => Promise<void>;
  assignPlan: (
    userId: string,
    planId: string,
    durationDays?: number,
  ) => Promise<void>;
  adjustBalance: (
    userId: string,
    amount: number,
    description: string,
  ) => Promise<void>;
  loadRedeemCodes: () => Promise<void>;
  createRedeemCodes: (params: {
    type: 'balance' | 'subscription' | 'trial';
    value_usd?: number;
    plan_id?: string;
    duration_days?: number;
    max_uses?: number;
    count?: number;
    prefix?: string;
    expires_in_hours?: number;
    notes?: string;
  }) => Promise<RedeemCode[]>;
  deleteRedeemCode: (code: string) => Promise<void>;
  loadAuditLog: (
    limit?: number,
    offset?: number,
    userId?: string,
    eventType?: string,
  ) => Promise<void>;
  loadRevenue: () => Promise<void>;
  cancelUserSubscription: (userId: string) => Promise<void>;
  batchAssignPlan: (
    userIds: string[],
    planId: string,
    durationDays?: number,
  ) => Promise<void>;
  exportRedeemCodesCSV: () => Promise<void>;
  getRedeemCodeUsage: (
    code: string,
  ) => Promise<
    Array<{ user_id: string; username: string; redeemed_at: string }>
  >;
  loadDashboard: () => Promise<void>;
  loadRevenueTrend: (months?: number) => Promise<void>;
  getUserSubscriptionHistory: (
    userId: string,
  ) => Promise<SubscriptionHistoryItem[]>;
}

export const useBillingStore = create<BillingState>((set, get) => ({
  billingEnabled: false,
  billingStatusLoaded: false,
  billingMode: 'wallet_first',
  billingMinStartBalanceUsd: 0.01,
  billingCurrency: 'USD',
  billingCurrencyRate: 1,
  loading: false,
  error: null,

  subscription: null,
  plan: null,
  balance: null,
  access: null,
  currentUsage: null,
  usageHistory: [],
  transactions: [],
  transactionsTotal: 0,
  quota: null,

  plans: [],
  allUsers: [],
  redeemCodes: [],
  auditLogs: [],
  auditLogsTotal: 0,
  revenue: null,
  dailyUsage: [],
  dashboardData: null,
  revenueTrend: [],

  // --- User actions ---

  loadBillingStatus: (opts) =>
    shared(
      'status',
      async () => {
        try {
          const data = await api.get<{
            enabled: boolean;
            mode?: 'wallet_first';
            minStartBalanceUsd?: number;
            currency?: string;
            currencyRate?: number;
          }>('/api/billing/status');
          set({
            billingEnabled: data.enabled,
            billingStatusLoaded: true,
            billingMode: data.mode ?? 'wallet_first',
            billingMinStartBalanceUsd: data.minStartBalanceUsd ?? 0.01,
            billingCurrency: data.currency ?? 'USD',
            billingCurrencyRate: data.currencyRate ?? 1,
          });
        } catch {
          set({
            billingEnabled: false,
            billingStatusLoaded: true,
            billingMode: 'wallet_first',
            billingMinStartBalanceUsd: 0.01,
            billingCurrency: 'USD',
            billingCurrencyRate: 1,
          });
        }
      },
      opts?.force,
    ),

  loadMySubscription: async () => {
    set({ loading: true });
    try {
      const data = await api.get<{
        subscription: UserSubscription | null;
        plan: BillingPlan | null;
      }>('/api/billing/my/subscription');
      set({
        subscription: data.subscription,
        plan: data.plan,
        loading: false,
        error: null,
      });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  loadMyBalance: async () => {
    try {
      const data = await api.get<UserBalance>('/api/billing/my/balance');
      set({ balance: data });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  loadMyAccess: (opts) =>
    shared(
      'access',
      async () => {
        try {
          const data = await api.get<BillingAccessResult>(
            '/api/billing/my/access',
          );
          set((state) => ({
            access: data,
            balance: state.balance
              ? {
                  ...state.balance,
                  balance_usd: data.balanceUsd,
                  updated_at: new Date().toISOString(),
                }
              : state.balance,
            quota: data.usage
              ? {
                  allowed: data.allowed,
                  reason: data.reason,
                  exceededWindow: data.exceededWindow,
                  resetAt: data.resetAt,
                  warningPercent: data.warningPercent,
                  usage: data.usage,
                }
              : null,
          }));
        } catch (err) {
          set({ error: err instanceof Error ? err.message : String(err) });
        }
      },
      opts?.force,
    ),

  loadMyUsage: async () => {
    try {
      const data = await api.get<{
        currentMonth: string;
        usage: MonthlyUsage;
        plan: BillingPlan | null;
        history: MonthlyUsage[];
      }>('/api/billing/my/usage');
      set({
        currentUsage: data.usage,
        usageHistory: data.history,
        plan: data.plan ?? get().plan,
      });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  loadMyTransactions: async (limit = 50, offset = 0) => {
    try {
      const data = await api.get<{
        transactions: BalanceTransaction[];
        total: number;
      }>(`/api/billing/my/transactions?limit=${limit}&offset=${offset}`);
      set({ transactions: data.transactions, transactionsTotal: data.total });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  loadMyQuota: async () => {
    try {
      const data = await api.get<QuotaCheckResult>('/api/billing/my/quota');
      set({ quota: data });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  redeemCode: async (code: string) => {
    try {
      const data = await api.post<{ message: string }>(
        '/api/billing/my/redeem',
        { code },
      );
      // Refresh all billing state after redeem
      get().loadMyBalance();
      get().loadMyAccess({ force: true });
      get().loadMySubscription();
      get().loadMyQuota();
      get().loadMyUsage();
      return { success: true, message: data.message };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, message: msg };
    }
  },

  loadPlans: async () => {
    try {
      const data = await api.get<{ plans: BillingPlan[] }>(
        '/api/billing/plans',
      );
      set({ plans: data.plans });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  toggleAutoRenew: async (autoRenew: boolean) => {
    try {
      await api.patch('/api/billing/my/auto-renew', { auto_renew: autoRenew });
      get().loadMySubscription();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  cancelMySubscription: async () => {
    try {
      await api.post('/api/billing/my/cancel-subscription', {});
      get().loadMySubscription();
      get().loadMyQuota();
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
      throw err;
    }
  },

  loadDailyUsage: async (days = 30) => {
    try {
      const data = await api.get<{ history: DailyUsage[] }>(
        `/api/billing/my/usage/daily?days=${days}`,
      );
      set({ dailyUsage: data.history });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  // --- WebSocket handler ---

  handleBillingUpdate: (data) => {
    set((state) => ({
      access: data,
      balance: state.balance
        ? {
            ...state.balance,
            balance_usd: data.balanceUsd,
            updated_at: new Date().toISOString(),
          }
        : state.balance,
      quota: data.usage
        ? {
            allowed: data.allowed,
            reason: data.reason,
            exceededWindow: data.exceededWindow,
            resetAt: data.resetAt,
            warningPercent: data.warningPercent,
            usage: data.usage,
          }
        : null,
    }));
  },

  // --- Admin actions ---

  loadAllPlans: async () => {
    set({ loading: true });
    try {
      const data = await api.get<{ plans: BillingPlan[] }>(
        '/api/billing/admin/plans',
      );
      set({ plans: data.plans, loading: false, error: null });
    } catch (err) {
      set({
        loading: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },

  createPlan: async (plan) => {
    await api.post('/api/billing/admin/plans', plan);
    get().loadAllPlans();
  },

  updatePlan: async (id, updates) => {
    await api.patch(`/api/billing/admin/plans/${id}`, updates);
    get().loadAllPlans();
  },

  deletePlan: async (id) => {
    try {
      await api.delete(`/api/billing/admin/plans/${id}`);
      get().loadAllPlans();
      return true;
    } catch {
      return false;
    }
  },

  loadAllUsers: async () => {
    try {
      const data = await api.get<{ users: UserBillingOverview[] }>(
        '/api/billing/admin/users',
      );
      set({ allUsers: data.users });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  assignPlan: async (userId, planId, durationDays) => {
    await api.post(`/api/billing/admin/users/${userId}/assign-plan`, {
      plan_id: planId,
      duration_days: durationDays,
    });
    get().loadAllUsers();
  },

  adjustBalance: async (userId, amount, description) => {
    const idempotencyKey = `adj_${userId}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    await api.post(`/api/billing/admin/users/${userId}/adjust-balance`, {
      amount_usd: amount,
      description,
      idempotency_key: idempotencyKey,
    });
    get().loadAllUsers();
  },

  loadRedeemCodes: async () => {
    try {
      const data = await api.get<{ codes: RedeemCode[] }>(
        '/api/billing/admin/redeem-codes',
      );
      set({ redeemCodes: data.codes });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  createRedeemCodes: async (params) => {
    const data = await api.post<{ codes: RedeemCode[] }>(
      '/api/billing/admin/redeem-codes',
      params,
    );
    get().loadRedeemCodes();
    return data.codes;
  },

  deleteRedeemCode: async (code) => {
    await api.delete(
      `/api/billing/admin/redeem-codes/${encodeURIComponent(code)}`,
    );
    get().loadRedeemCodes();
  },

  loadAuditLog: async (
    limit = 50,
    offset = 0,
    userId?: string,
    eventType?: string,
  ) => {
    try {
      let url = `/api/billing/admin/audit-log?limit=${limit}&offset=${offset}`;
      if (userId) url += `&user_id=${userId}`;
      if (eventType) url += `&event_type=${encodeURIComponent(eventType)}`;
      const data = await api.get<{ logs: BillingAuditLog[]; total: number }>(
        url,
      );
      set({ auditLogs: data.logs, auditLogsTotal: data.total });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  loadRevenue: async () => {
    try {
      const data = await api.get<RevenueStats>('/api/billing/admin/revenue');
      set({ revenue: data });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  cancelUserSubscription: async (userId) => {
    await api.post(
      `/api/billing/admin/users/${userId}/cancel-subscription`,
      {},
    );
    get().loadAllUsers();
  },

  batchAssignPlan: async (userIds, planId, durationDays) => {
    await api.post('/api/billing/admin/users/batch-assign-plan', {
      user_ids: userIds,
      plan_id: planId,
      duration_days: durationDays,
    });
    get().loadAllUsers();
  },

  exportRedeemCodesCSV: async () => {
    const resp = await fetch('/api/billing/admin/redeem-codes/export', {
      credentials: 'include',
    });
    if (!resp.ok) throw new Error('Export failed');
    const blob = await resp.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `redeem-codes-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  },

  getRedeemCodeUsage: async (code) => {
    const data = await api.get<{
      details: Array<{
        user_id: string;
        username: string;
        redeemed_at: string;
      }>;
    }>(`/api/billing/admin/redeem-codes/${encodeURIComponent(code)}/usage`);
    return data.details;
  },

  loadDashboard: async () => {
    try {
      const data = await api.get<DashboardData>('/api/billing/admin/dashboard');
      set({ dashboardData: data });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  loadRevenueTrend: async (months = 12) => {
    try {
      const data = await api.get<{ trend: RevenueTrendItem[] }>(
        `/api/billing/admin/revenue/trend?months=${months}`,
      );
      set({ revenueTrend: data.trend });
    } catch (err) {
      set({ error: err instanceof Error ? err.message : String(err) });
    }
  },

  getUserSubscriptionHistory: async (userId) => {
    const data = await api.get<{ history: SubscriptionHistoryItem[] }>(
      `/api/billing/admin/users/${userId}/subscription-history`,
    );
    return data.history;
  },
}));
