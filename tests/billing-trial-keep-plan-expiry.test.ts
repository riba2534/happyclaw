import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'billing-trial-expiry-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<any>()),
  DATA_DIR: tmpDir,
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: tmpGroupsDir,
}));

const db = await import('../src/db.js');
const {
  assignPlan,
  redeemCode,
  redeemTrial,
  getUserEffectivePlan,
  checkAndExpireSubscriptions,
} = await import('../src/billing.js');

const NOW_ISO = '2026-10-05T05:00:00.000Z';

function ensureProPlan() {
  const now = NOW_ISO;
  if (!db.getBillingPlan('pro')) {
    db.createBillingPlan({
      id: 'pro',
      name: 'Pro',
      description: null,
      tier: 20,
      monthly_cost_usd: 20,
      monthly_token_quota: null,
      monthly_cost_quota: 200,
      daily_cost_quota: null,
      weekly_cost_quota: null,
      daily_token_quota: null,
      weekly_token_quota: null,
      rate_multiplier: 1,
      trial_days: null,
      sort_order: 1,
      display_price: '¥99/月',
      highlight: false,
      max_groups: 50,
      max_concurrent_containers: 10,
      max_im_channels: 10,
      max_mcp_servers: 50,
      max_storage_mb: 10240,
      allow_overage: false,
      features: [],
      is_default: false,
      is_active: true,
      created_at: now,
      updated_at: now,
    });
  }
}

function mkTrialCode(code: string, days: number) {
  db.createRedeemCode({
    code,
    type: 'trial',
    value_usd: null,
    plan_id: null,
    duration_days: days,
    max_uses: 10,
    used_count: 0,
    expires_at: null,
    created_by: 'admin',
    notes: null,
    batch_id: null,
    created_at: NOW_ISO,
  } as any);
}

beforeAll(() => {
  // Seed the DB with the real clock so free-plan bootstrap ids don't collide
  // with later assignPlan calls under fake timers.
  db.initDatabase();
  ensureProPlan();
  for (const id of ['u1', 'u2', 'u3']) {
    db.createUser({
      id,
      username: id,
      password_hash: 'x',
      display_name: id,
      role: 'member' as any,
      status: 'active' as any,
      created_at: NOW_ISO,
      updated_at: NOW_ISO,
    });
  }
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW_ISO));
});

afterAll(() => {
  vi.useRealTimers();
  db.closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.setSystemTime(new Date(NOW_ISO));
});

/** assignPlan ids use Date.now(); nudge the fake clock so rows stay unique. */
function tickMs(ms = 1) {
  vi.setSystemTime(new Date(Date.now() + ms));
}

describe('redeemTrial preserves time-limited plan expiry (strict)', () => {
  test('30-day Pro + trial: expires_at and auto_renew unchanged; sweep matches control', () => {
    // u1: Pro 30d with auto_renew, then redeems a 7-day trial
    // u2: Pro 30d control, never redeems a trial
    assignPlan('u1', 'pro', 'admin', 30, { autoRenew: true });
    tickMs();
    assignPlan('u2', 'pro', 'admin', 30, { autoRenew: true });

    const before = getUserEffectivePlan('u1')!;
    expect(before.plan.id).toBe('pro');
    expect(before.subscription.expires_at).toBeTruthy();
    expect(before.subscription.auto_renew).toBe(true);
    const expiresBefore = before.subscription.expires_at!;

    mkTrialCode('TRY7-U1', 7);
    tickMs();
    const redeemed = redeemCode('u1', 'TRY7-U1');
    expect(redeemed.success).toBe(true);

    const after = getUserEffectivePlan('u1')!;
    expect(after.plan.id).toBe('pro');
    // STRICT preserve: do not stretch expiry to the trial end.
    expect(after.subscription.expires_at).toBe(expiresBefore);
    expect(after.subscription.auto_renew).toBe(true);
    expect(after.subscription.trial_ends_at).toBeTruthy();
    const trialEnd = new Date(after.subscription.trial_ends_at!).getTime();
    // ~7 days from redemption time (allowing for our 1ms id ticks).
    expect(trialEnd).toBeGreaterThanOrEqual(
      new Date(NOW_ISO).getTime() + 7 * 86400_000,
    );
    expect(trialEnd).toBeLessThan(
      new Date(NOW_ISO).getTime() + 7 * 86400_000 + 60_000,
    );
    // Trial ends well before plan expiry; expiry must still be the original +30d.
    expect(new Date(after.subscription.expires_at!).getTime()).toBeGreaterThan(
      trialEnd,
    );

    vi.setSystemTime(new Date(new Date(NOW_ISO).getTime() + 31 * 86400_000));
    checkAndExpireSubscriptions();
    expect(getUserEffectivePlan('u1')!.plan.id).toBe('free');
    expect(getUserEffectivePlan('u2')!.plan.id).toBe('free');
  });

  test('default-plan user trial still works (expires_at stays null)', () => {
    // u3 starts on the seeded free default (no active paid subscription row
    // after any prior expiry). Ensure a clean default effective plan.
    const prior = getUserEffectivePlan('u3')!;
    expect(prior.plan.id).toBe('free');
    expect(prior.subscription.expires_at).toBeNull();

    mkTrialCode('TRY7-FREE', 7);
    tickMs();
    const redeemed = redeemCode('u3', 'TRY7-FREE');
    expect(redeemed.success).toBe(true);

    const after = getUserEffectivePlan('u3')!;
    expect(after.plan.id).toBe('free');
    expect(after.subscription.expires_at).toBeNull();
    expect(after.subscription.trial_ends_at).toBeTruthy();
    tickMs();
    expect(redeemTrial('u3', 3)).toBe(true);
    const extended = getUserEffectivePlan('u3')!;
    expect(extended.subscription.expires_at).toBeNull();
    expect(
      new Date(extended.subscription.trial_ends_at!).getTime(),
    ).toBeGreaterThan(new Date(after.subscription.trial_ends_at!).getTime());
  });
});
