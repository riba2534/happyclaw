import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-usage-quota-'));
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
const { recordUsageEvent } = await import('../src/usage-service.js');

const USER = 'quota-cache-user';
const DAILY_TOKEN_QUOTA = 1_000;
// Quota reads use the UTC day while the ledger write uses the host-local day
// (a separate known issue). Shift a UTC-midday instant by half the host
// offset so both calendar days are 2026-10-05 in every timezone.
const UTC_MIDDAY = new Date('2026-10-05T12:00:00.000Z');
const NOW = new Date(
  UTC_MIDDAY.getTime() + (UTC_MIDDAY.getTimezoneOffset() / 2) * 60_000,
);
const TODAY = '2026-10-05';

// 10 + 30 + 5 input-side + 2 output tokens = 47 quota tokens; this is far
// below one Kaboo cent, so the event is billed $0 (no deductUsageCost call).
const zeroCostUsage = (eventId: string) => ({
  eventId,
  inputTokens: 10,
  outputTokens: 2,
  cacheReadInputTokens: 30,
  cacheCreationInputTokens: 5,
  costUSD: 0,
  durationMs: 1,
  numTurns: 1,
});

beforeAll(() => {
  // Freeze only Date so the 30 s quota cache cannot expire mid-test.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);

  db.initDatabase();
  const now = NOW.toISOString();
  db.createBillingPlan({
    id: 'quota-cache-plan',
    name: 'Quota cache plan',
    description: null,
    tier: 0,
    monthly_cost_usd: 0,
    monthly_token_quota: null,
    monthly_cost_quota: null,
    daily_cost_quota: null,
    weekly_cost_quota: null,
    daily_token_quota: DAILY_TOKEN_QUOTA,
    weekly_token_quota: null,
    rate_multiplier: 1.0,
    trial_days: null,
    sort_order: 0,
    display_price: null,
    highlight: false,
    max_groups: null,
    max_concurrent_containers: null,
    max_im_channels: null,
    max_mcp_servers: null,
    max_storage_mb: null,
    allow_overage: false,
    features: [],
    is_default: true,
    is_active: true,
    created_at: now,
    updated_at: now,
  });
  db.createUser({
    id: USER,
    username: USER,
    password_hash: 'x',
    display_name: 'Quota cache user',
    role: 'member',
    status: 'active',
    permissions: [],
    must_change_password: false,
    created_at: now,
    updated_at: now,
  });
  db.adjustUserBalance(
    USER,
    10,
    'deposit',
    'test deposit',
    null,
    null,
    null,
    'quota-cache-deposit',
  );
  // Just under the daily token quota.
  db.incrementUsageBoth(USER, TODAY.slice(0, 7), TODAY, 990, 0, 0);
});

afterAll(() => {
  vi.useRealTimers();
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('recordUsageEvent quota cache invalidation', () => {
  test('a $0-billed event that exhausts a token quota closes the fresh gate', () => {
    const before = billing.checkBillingAccessFresh(USER, 'member');
    expect(before.allowed).toBe(true);
    expect(before.usage?.daily?.tokenUsed).toBe(990);

    const result = recordUsageEvent({
      eventId: 'quota-cache-event-1',
      userId: USER,
      groupFolder: 'quota-cache-workspace',
      source: 'web',
      createdAt: NOW.toISOString(),
      usage: zeroCostUsage('quota-cache-event-1'),
    });
    expect(result.inserted).toBe(true);
    expect(result.billedCostUSD).toBe(0);

    const ledger = db.getDailyUsage(USER, TODAY);
    expect(
      (ledger?.total_input_tokens ?? 0) + (ledger?.total_output_tokens ?? 0),
    ).toBe(1_037);

    const after = billing.checkBillingAccessFresh(USER, 'member');
    expect(after.allowed).toBe(false);
    expect(after.blockType).toBe('quota_exceeded');
    expect(after.exceededWindow).toBe('daily');
    expect(after.usage?.daily?.tokenUsed).toBe(1_037);
  });

  test('replaying the same eventId is a no-op and keeps the gate closed', () => {
    const replay = recordUsageEvent({
      eventId: 'quota-cache-event-1',
      userId: USER,
      groupFolder: 'quota-cache-workspace',
      source: 'web',
      createdAt: NOW.toISOString(),
      usage: zeroCostUsage('quota-cache-event-1'),
    });
    expect(replay.inserted).toBe(false);
    expect(replay.billedCostUSD).toBe(0);

    const ledger = db.getDailyUsage(USER, TODAY);
    expect(
      (ledger?.total_input_tokens ?? 0) + (ledger?.total_output_tokens ?? 0),
    ).toBe(1_037);

    const access = billing.checkBillingAccessFresh(USER, 'member');
    expect(access.allowed).toBe(false);
    expect(access.blockType).toBe('quota_exceeded');
  });
});
