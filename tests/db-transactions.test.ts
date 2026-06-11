import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

// Isolate DB to a temp dir
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-tx-test-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../src/config.js', async () => {
  return {
    STORE_DIR: tmpStoreDir,
    GROUPS_DIR: tmpGroupsDir,
  };
});

const {
  initDatabase,
  incrementUsageBoth,
  createBillingPlan,
  getBillingPlan,
  deleteBillingPlan,
} = await import('../src/db.js');

// Reach into the same DB file via a separate connection for read-only verifications.
// Avoids needing to export the internal `db` binding.
const dbPath = path.join(tmpStoreDir, 'messages.db');
let probeDb: InstanceType<typeof Database>;

beforeAll(() => {
  initDatabase();
  probeDb = new Database(dbPath, { readonly: true });
});

afterAll(() => {
  if (probeDb) probeDb.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Wipe usage tables between tests via a write connection.
  const wb = new Database(dbPath);
  // FK ordering: subscriptions referencing plans must go first.
  wb.exec(
    'DELETE FROM monthly_usage; DELETE FROM daily_usage; DELETE FROM user_subscriptions; DELETE FROM billing_plans; DELETE FROM users;',
  );
  wb.close();
});

describe('incrementUsageBoth (R2 fix: atomic monthly + daily)', () => {
  test('updates both monthly and daily atomically on success', () => {
    incrementUsageBoth('user1', '2026-06', '2026-06-04', 100, 50, 0.001);

    const monthly = probeDb
      .prepare("SELECT * FROM monthly_usage WHERE user_id = ? AND month = ?")
      .get('user1', '2026-06') as any;
    const daily = probeDb
      .prepare("SELECT * FROM daily_usage WHERE user_id = ? AND date = ?")
      .get('user1', '2026-06-04') as any;

    expect(monthly).toBeTruthy();
    expect(daily).toBeTruthy();
    expect(monthly.total_input_tokens).toBe(100);
    expect(daily.total_input_tokens).toBe(100);
    expect(monthly.total_cost_usd).toBeCloseTo(0.001);
    expect(daily.total_cost_usd).toBeCloseTo(0.001);
  });

  test('multiple calls accumulate correctly', () => {
    incrementUsageBoth('user1', '2026-06', '2026-06-04', 100, 50, 0.001);
    incrementUsageBoth('user1', '2026-06', '2026-06-04', 200, 100, 0.002);

    const monthly = probeDb
      .prepare("SELECT * FROM monthly_usage WHERE user_id = ? AND month = ?")
      .get('user1', '2026-06') as any;
    const daily = probeDb
      .prepare("SELECT * FROM daily_usage WHERE user_id = ? AND date = ?")
      .get('user1', '2026-06-04') as any;

    expect(monthly.total_input_tokens).toBe(300);
    expect(monthly.total_output_tokens).toBe(150);
    expect(monthly.message_count).toBe(2);
    expect(daily.total_input_tokens).toBe(300);
    expect(daily.message_count).toBe(2);
  });

  test('different days under same month are summed in monthly only', () => {
    incrementUsageBoth('user1', '2026-06', '2026-06-04', 100, 50, 0.001);
    incrementUsageBoth('user1', '2026-06', '2026-06-05', 200, 100, 0.002);

    const monthly = probeDb
      .prepare("SELECT * FROM monthly_usage WHERE user_id = ? AND month = ?")
      .get('user1', '2026-06') as any;
    const day1 = probeDb
      .prepare("SELECT * FROM daily_usage WHERE user_id = ? AND date = ?")
      .get('user1', '2026-06-04') as any;
    const day2 = probeDb
      .prepare("SELECT * FROM daily_usage WHERE user_id = ? AND date = ?")
      .get('user1', '2026-06-05') as any;

    expect(monthly.total_input_tokens).toBe(300);
    expect(monthly.message_count).toBe(2);
    expect(day1.total_input_tokens).toBe(100);
    expect(day2.total_input_tokens).toBe(200);
  });

  test('per-user isolation', () => {
    incrementUsageBoth('user1', '2026-06', '2026-06-04', 100, 50, 0.001);
    incrementUsageBoth('user2', '2026-06', '2026-06-04', 200, 100, 0.002);

    const u1 = probeDb
      .prepare("SELECT * FROM monthly_usage WHERE user_id = ?")
      .get('user1') as any;
    const u2 = probeDb
      .prepare("SELECT * FROM monthly_usage WHERE user_id = ?")
      .get('user2') as any;
    expect(u1.total_input_tokens).toBe(100);
    expect(u2.total_input_tokens).toBe(200);
  });

  test('invariant: monthly and daily totals consistent for same-day burst', () => {
    for (let i = 0; i < 10; i++) {
      incrementUsageBoth('user1', '2026-06', '2026-06-04', 10, 5, 0.0001);
    }

    const monthly = probeDb
      .prepare("SELECT total_input_tokens FROM monthly_usage WHERE user_id = ?")
      .get('user1') as any;
    const daily = probeDb
      .prepare("SELECT total_input_tokens FROM daily_usage WHERE user_id = ?")
      .get('user1') as any;

    expect(monthly.total_input_tokens).toBe(100);
    expect(daily.total_input_tokens).toBe(100);
    expect(monthly.total_input_tokens).toBe(daily.total_input_tokens);
  });
});

describe('deleteBillingPlan (R3 fix: covers cancelled/expired subscriptions)', () => {
  function makePlan(id: string, tier: number, name: string) {
    createBillingPlan({
      id,
      name,
      description: null,
      tier,
      monthly_cost_usd: tier * 10,
      monthly_token_quota: null,
      monthly_cost_quota: null,
      daily_cost_quota: null,
      weekly_cost_quota: null,
      daily_token_quota: null,
      weekly_token_quota: null,
      rate_multiplier: 1.0,
      trial_days: null,
      sort_order: tier,
      display_price: null,
      highlight: false,
      max_groups: tier + 1,
      max_concurrent_containers: tier + 1,
      max_im_channels: tier + 1,
      max_mcp_servers: 5 * (tier + 1),
      max_storage_mb: 100 * (tier + 1),
      allow_overage: false,
      features: [],
      is_default: false,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }

  test('deletes plan with no subscribers', () => {
    makePlan('plan-free', 0, 'Free');
    expect(getBillingPlan('plan-free')).toBeTruthy();
    expect(deleteBillingPlan('plan-free')).toBe(true);
    expect(getBillingPlan('plan-free')).toBeUndefined();
  });

  test('refuses to delete plan with active subscription', () => {
    makePlan('plan-pro', 2, 'Pro');
    const db = new Database(dbPath);
    // Insert prerequisite user row to satisfy user_subscriptions.user_id FK.
    db.prepare(
      `INSERT OR IGNORE INTO users (id, username, password_hash, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('u1', 'testu1', 'x', 'member', 'active', new Date().toISOString(), new Date().toISOString());
    db.prepare(
      `INSERT INTO user_subscriptions (id, user_id, plan_id, status, started_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      'sub1',
      'u1',
      'plan-pro',
      'active',
      new Date().toISOString(),
      new Date().toISOString(),
    );
    db.close();

    expect(deleteBillingPlan('plan-pro')).toBe(false);
    expect(getBillingPlan('plan-pro')).toBeTruthy();
  });

  test('R3 fix: refuses to delete plan with cancelled subscription too', () => {
    makePlan('plan-trial', 1, 'Trial');
    const db = new Database(dbPath);
    db.prepare(
      `INSERT OR IGNORE INTO users (id, username, password_hash, role, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run('u1', 'testu1', 'x', 'member', 'active', new Date().toISOString(), new Date().toISOString());
    db.prepare(
      `INSERT INTO user_subscriptions (id, user_id, plan_id, status, started_at, cancelled_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'sub-cancelled',
      'u1',
      'plan-trial',
      'cancelled',
      new Date().toISOString(),
      new Date().toISOString(),
      new Date().toISOString(),
    );
    db.close();

    // Pre-R3 this returned true because only 'active' was checked.
    // Post-R3: with FK ON the raw DELETE would throw SQLITE_CONSTRAINT_FOREIGNKEY;
    // application layer pre-checks any-status reference and returns false cleanly.
    expect(deleteBillingPlan('plan-trial')).toBe(false);
    expect(getBillingPlan('plan-trial')).toBeTruthy();
  });

  test('returns false for non-existent plan', () => {
    expect(deleteBillingPlan('nonexistent')).toBe(false);
  });
});
