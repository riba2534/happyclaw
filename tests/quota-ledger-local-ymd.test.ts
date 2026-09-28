import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

// Document and enforce timezone assumption
process.env.TZ = 'Asia/Shanghai';

const tmp = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-quota-ledger-local-ymd-'),
);
const store = path.join(tmp, 'db');
const groups = path.join(tmp, 'groups');
fs.mkdirSync(store, { recursive: true });
fs.mkdirSync(groups, { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  STORE_DIR: store,
  GROUPS_DIR: groups,
}));

vi.mock('../src/runtime-config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  getSystemSettings: () => ({ billingEnabled: true }),
}));

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const billing = await import('../src/billing.js');

const FIXED_INSTANT_STR = '2026-09-28T01:00:00+08:00';
const fixedInstant = new Date(FIXED_INSTANT_STR);

const DAILY_USER_ID = 'quota-user-daily';
const WEEKLY_USER_ID = 'quota-user-weekly';

const dailyPlan = {
  id: 'plan-daily-1000',
  name: 'Daily 1000 Plan',
  description: null,
  tier: 10,
  monthly_cost_usd: 0,
  monthly_token_quota: null,
  monthly_cost_quota: null,
  daily_cost_quota: null,
  weekly_cost_quota: null,
  daily_token_quota: 1000,
  weekly_token_quota: null,
  rate_multiplier: 1.0,
  trial_days: null,
  sort_order: 1,
  display_price: null,
  highlight: false,
  max_groups: null,
  max_concurrent_containers: null,
  max_im_channels: null,
  max_mcp_servers: null,
  max_storage_mb: null,
  allow_overage: false,
  features: [],
  is_default: false,
  is_active: true,
  created_at: FIXED_INSTANT_STR,
  updated_at: FIXED_INSTANT_STR,
};

const weeklyPlan = {
  id: 'plan-weekly-1000',
  name: 'Weekly 1000 Plan',
  description: null,
  tier: 10,
  monthly_cost_usd: 0,
  monthly_token_quota: null,
  monthly_cost_quota: null,
  daily_cost_quota: null,
  weekly_cost_quota: null,
  daily_token_quota: null,
  weekly_token_quota: 1000,
  rate_multiplier: 1.0,
  trial_days: null,
  sort_order: 2,
  display_price: null,
  highlight: false,
  max_groups: null,
  max_concurrent_containers: null,
  max_im_channels: null,
  max_mcp_servers: null,
  max_storage_mb: null,
  allow_overage: false,
  features: [],
  is_default: false,
  is_active: true,
  created_at: FIXED_INSTANT_STR,
  updated_at: FIXED_INSTANT_STR,
};

beforeAll(() => {
  db.initDatabase();

  // Create test users
  db.createUser({
    id: DAILY_USER_ID,
    username: DAILY_USER_ID,
    password_hash: 'x',
    display_name: 'Daily Quota User',
    role: 'member',
    status: 'active',
    permissions: [],
    must_change_password: false,
    created_at: FIXED_INSTANT_STR,
    updated_at: FIXED_INSTANT_STR,
  });

  db.createUser({
    id: WEEKLY_USER_ID,
    username: WEEKLY_USER_ID,
    password_hash: 'x',
    display_name: 'Weekly Quota User',
    role: 'member',
    status: 'active',
    permissions: [],
    must_change_password: false,
    created_at: FIXED_INSTANT_STR,
    updated_at: FIXED_INSTANT_STR,
  });

  // Create billing plans
  db.createBillingPlan(dailyPlan);
  db.createBillingPlan(weeklyPlan);

  // Assign subscriptions
  db.createUserSubscription({
    id: `sub-${DAILY_USER_ID}`,
    user_id: DAILY_USER_ID,
    plan_id: dailyPlan.id,
    status: 'active',
    started_at: FIXED_INSTANT_STR,
    expires_at: null,
    cancelled_at: null,
    trial_ends_at: null,
    notes: null,
    auto_renew: false,
    created_at: FIXED_INSTANT_STR,
  });

  db.createUserSubscription({
    id: `sub-${WEEKLY_USER_ID}`,
    user_id: WEEKLY_USER_ID,
    plan_id: weeklyPlan.id,
    status: 'active',
    started_at: FIXED_INSTANT_STR,
    expires_at: null,
    cancelled_at: null,
    trial_ends_at: null,
    notes: null,
    auto_renew: false,
    created_at: FIXED_INSTANT_STR,
  });
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('quota ledger local YMD vs UTC read (UF-683-1)', () => {
  test('asserts environment timezone is Asia/Shanghai', () => {
    const tz =
      process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(['Asia/Shanghai', 'Asia/Chongqing', 'PRC', 'UTC+8']).toContain(tz);
  });

  test('pure assertion: at 2026-09-28T01:00:00+08:00 local YMD diverges from UTC ISO slice', () => {
    const localYMD = db.toLocalDateString(fixedInstant);
    const localMonth = db.toLocalMonthString(fixedInstant);
    const utcIsoSlice = fixedInstant.toISOString().slice(0, 10);
    const utcMonthSlice = fixedInstant.toISOString().slice(0, 7);

    expect(localYMD).toBe('2026-09-28');
    expect(utcIsoSlice).toBe('2026-09-27');
    expect(localYMD).not.toBe(utcIsoSlice);

    expect(localMonth).toBe('2026-09');
    expect(utcMonthSlice).toBe('2026-09');
  });

  test('daily quota check: write uses local YMD and read snapshot matches local YMD', () => {
    // Record 1000 billable tokens at local 01:00
    const recordResult = db.recordUsageEventBatch({
      eventId: 'evt-daily-1000',
      userId: DAILY_USER_ID,
      groupFolder: 'test-workspace',
      source: 'web',
      createdAt: fixedInstant.toISOString(),
      inputTokens: 600,
      outputTokens: 400,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      providerEstimatedCostUSD: 0,
      billedCostUSD: 0,
      trackBillingUsage: true,
      models: [
        {
          model: 'test-model',
          inputTokens: 600,
          outputTokens: 400,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          providerEstimatedCostUSD: 0,
          billedCostUSD: 0,
        },
      ],
    });
    expect(recordResult.inserted).toBe(true);

    // Assert daily_usage row landed under local today 2026-09-28, not UTC 2026-09-27
    const localUsage = db.getDailyUsage(DAILY_USER_ID, '2026-09-28');
    const utcUsage = db.getDailyUsage(DAILY_USER_ID, '2026-09-27');

    expect(localUsage).toBeDefined();
    expect(
      (localUsage?.total_input_tokens ?? 0) +
        (localUsage?.total_output_tokens ?? 0),
    ).toBe(1000);
    expect(utcUsage).toBeUndefined();

    // Check snapshot keys directly: snapshot must include the 1000 tokens using local YMD
    const snapshot = billing.getQuotaUsageSnapshot(
      DAILY_USER_ID,
      dailyPlan,
      fixedInstant,
    );
    expect(snapshot.dailyTokens).toBe(1000);
    expect(snapshot.baseUsage.daily.tokenUsed).toBe(1000);

    // checkQuota under fake timer at local 01:00
    vi.useFakeTimers({ now: fixedInstant });
    try {
      billing.invalidateUserBillingCache(DAILY_USER_ID);
      const quota = billing.checkQuota(DAILY_USER_ID, 'member');

      // After fix: daily quota 1000 is exceeded (token quota limit reached)
      expect(quota.allowed).toBe(false);
      expect(quota.exceededWindow).toBe('daily');
      expect(quota.reason).toContain('日度 Token 已达上限 1,000');
    } finally {
      vi.useRealTimers();
    }
  });

  test('weekly quota check: getWeeklyUsageSummary uses local Monday YMD instead of UTC-shifted Sunday', () => {
    // At early Monday local (2026-09-28T01:00:00+08:00):
    // Local date is Monday 2026-09-28.
    // UTC date is Sunday 2026-09-27.
    // Record 1000 tokens on Monday local
    const recordResult = db.recordUsageEventBatch({
      eventId: 'evt-weekly-1000',
      userId: WEEKLY_USER_ID,
      groupFolder: 'test-workspace',
      source: 'web',
      createdAt: fixedInstant.toISOString(),
      inputTokens: 500,
      outputTokens: 500,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      providerEstimatedCostUSD: 0,
      billedCostUSD: 0,
      trackBillingUsage: true,
      models: [
        {
          model: 'test-model',
          inputTokens: 500,
          outputTokens: 500,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          providerEstimatedCostUSD: 0,
          billedCostUSD: 0,
        },
      ],
    });
    expect(recordResult.inserted).toBe(true);

    // Verify start date computation:
    // With old UTC ISO slice: monday.toISOString().slice(0, 10) === '2026-09-27' (Sunday)
    // With local YMD: toLocalDateString(monday) === '2026-09-28' (Monday)
    const dayOfWeek = fixedInstant.getDay();
    const daysSinceMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const monday = new Date(fixedInstant);
    monday.setDate(fixedInstant.getDate() - daysSinceMonday);
    const utcMondayKey = monday.toISOString().slice(0, 10);
    const localMondayKey = db.toLocalDateString(monday);

    expect(utcMondayKey).toBe('2026-09-27');
    expect(localMondayKey).toBe('2026-09-28');

    // Weekly summary with now = fixedInstant (Monday 01:00 local)
    // Local Monday is 2026-09-28.
    // If startDate were wrongly computed as monday.toISOString().slice(0, 10), it would be '2026-09-27'.
    // Here we ensure getWeeklyUsageSummary returns the tokens recorded under local Monday 2026-09-28.
    const weeklySummary = db.getWeeklyUsageSummary(
      WEEKLY_USER_ID,
      fixedInstant,
    );
    expect(weeklySummary.totalTokens).toBe(1000);

    // Also verify checkQuota blocks when weekly token quota is reached
    vi.useFakeTimers({ now: fixedInstant });
    try {
      billing.invalidateUserBillingCache(WEEKLY_USER_ID);
      const quota = billing.checkQuota(WEEKLY_USER_ID, 'member');

      expect(quota.allowed).toBe(false);
      expect(quota.exceededWindow).toBe('weekly');
      expect(quota.reason).toContain('周度 Token 已达上限 1,000');
    } finally {
      vi.useRealTimers();
    }
  });

  test('weekly boundary isolation: previous week Sunday usage does not leak into new week Monday', () => {
    const ISOLATION_USER_ID = 'quota-user-weekly-isolation';
    db.createUser({
      id: ISOLATION_USER_ID,
      username: ISOLATION_USER_ID,
      password_hash: 'x',
      display_name: 'Weekly Isolation User',
      role: 'member',
      status: 'active',
      permissions: [],
      must_change_password: false,
      created_at: FIXED_INSTANT_STR,
      updated_at: FIXED_INSTANT_STR,
    });

    const isolationPlan = {
      ...weeklyPlan,
      id: 'plan-weekly-800',
      weekly_token_quota: 800,
    };
    db.createBillingPlan(isolationPlan);
    db.createUserSubscription({
      id: `sub-${ISOLATION_USER_ID}`,
      user_id: ISOLATION_USER_ID,
      plan_id: isolationPlan.id,
      status: 'active',
      started_at: FIXED_INSTANT_STR,
      expires_at: null,
      cancelled_at: null,
      trial_ends_at: null,
      notes: null,
      auto_renew: false,
      created_at: FIXED_INSTANT_STR,
    });

    // Record 500 tokens on Sunday 2026-09-27 12:00+08:00 (previous calendar week)
    db.recordUsageEventBatch({
      eventId: 'evt-sunday-500',
      userId: ISOLATION_USER_ID,
      groupFolder: 'test-workspace',
      source: 'web',
      createdAt: '2026-09-27T12:00:00+08:00',
      inputTokens: 250,
      outputTokens: 250,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      providerEstimatedCostUSD: 0,
      billedCostUSD: 0,
      trackBillingUsage: true,
      models: [
        {
          model: 'test-model',
          inputTokens: 250,
          outputTokens: 250,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          providerEstimatedCostUSD: 0,
          billedCostUSD: 0,
        },
      ],
    });

    // Record 400 tokens on Monday 2026-09-28 01:00+08:00 (new calendar week)
    db.recordUsageEventBatch({
      eventId: 'evt-monday-400',
      userId: ISOLATION_USER_ID,
      groupFolder: 'test-workspace',
      source: 'web',
      createdAt: FIXED_INSTANT_STR,
      inputTokens: 200,
      outputTokens: 200,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      providerEstimatedCostUSD: 0,
      billedCostUSD: 0,
      trackBillingUsage: true,
      models: [
        {
          model: 'test-model',
          inputTokens: 200,
          outputTokens: 200,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          providerEstimatedCostUSD: 0,
          billedCostUSD: 0,
        },
      ],
    });

    // If startDate is wrongly '2026-09-27' (UTC slice of Monday 01:00+08),
    // Sunday's 500 tokens are included, giving 500 + 400 = 900 (> 800 quota).
    // With correct local Monday startDate ('2026-09-28'),
    // only Monday's 400 tokens are in the current week (400 <= 800 quota).
    const weeklySummary = db.getWeeklyUsageSummary(
      ISOLATION_USER_ID,
      fixedInstant,
    );
    expect(weeklySummary.totalTokens).toBe(400);

    vi.useFakeTimers({ now: fixedInstant });
    try {
      billing.invalidateUserBillingCache(ISOLATION_USER_ID);
      const quota = billing.checkQuota(ISOLATION_USER_ID, 'member');
      // 400 used < 800 quota -> allowed should be true!
      expect(quota.allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
