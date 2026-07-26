import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v51-usage-'));
const store = path.join(tmp, 'db');
const groups = path.join(tmp, 'groups');
fs.mkdirSync(store, { recursive: true });
fs.mkdirSync(groups, { recursive: true });

vi.mock('../src/config.js', () => ({ STORE_DIR: store, GROUPS_DIR: groups }));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('schema v51 usage event migration', () => {
  test('backfills stable legacy events and provider cost', async () => {
    const db = await import('../src/db.js');
    db.initDatabase();
    db.closeDatabase();

    const raw = new Database(path.join(store, 'messages.db'));
    raw
      .prepare(
        `INSERT OR REPLACE INTO registered_groups
        (jid, name, folder, added_at, created_by, is_home)
       VALUES ('web:legacy-workspace', 'Legacy workspace', 'legacy-workspace',
         '2026-07-01T00:00:00.000Z', 'real-owner', 0)`,
      )
      .run();
    raw
      .prepare(
        `INSERT INTO usage_records (
        id, event_id, user_id, group_folder, model, input_tokens,
        output_tokens, cache_read_input_tokens, cache_creation_input_tokens,
        cost_usd, provider_estimated_cost_usd, billed_cost_usd,
        duration_ms, num_turns, source, created_at
      ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 1, 'agent', ?)`,
      )
      .run(
        'old-row',
        'system',
        'legacy-workspace',
        'legacy-model',
        10,
        2,
        20,
        5,
        3.5,
        '2026-07-01T00:00:00.000Z',
      );
    raw
      .prepare(
        "UPDATE router_state SET value = '50' WHERE key = 'schema_version'",
      )
      .run();
    raw.close();

    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
    expect(db.getUsageUsers()).toEqual([
      { id: 'real-owner', username: 'real-owner' },
    ]);
    db.closeDatabase();

    const probe = new Database(path.join(store, 'messages.db'), {
      readonly: true,
    });
    const record = probe
      .prepare(
        "SELECT event_id, provider_estimated_cost_usd FROM usage_records WHERE id = 'old-row'",
      )
      .get() as any;
    expect(record).toEqual({
      event_id: 'legacy:old-row',
      provider_estimated_cost_usd: 3.5,
    });
    expect(
      probe
        .prepare(
          "SELECT cache_read_input_tokens, cache_creation_input_tokens, reasoning_output_tokens FROM usage_events WHERE event_id = 'legacy:old-row'",
        )
        .get(),
    ).toEqual({
      cache_read_input_tokens: 20,
      cache_creation_input_tokens: 5,
      reasoning_output_tokens: 0,
    });
    probe.close();

    // Repair is intentionally idempotent for a node that already stamped 51
    // while an early build had added the column but not backfilled it.
    const partialV51 = new Database(path.join(store, 'messages.db'));
    partialV51
      .prepare(
        "UPDATE usage_records SET usage_date = NULL WHERE id = 'old-row'",
      )
      .run();
    partialV51.close();
    db.initDatabase();
    expect(
      db.getUsageAnalytics({
        from: '2026-07-01',
        to: '2026-07-01',
        userId: 'real-owner',
      }).summary.runCount,
    ).toBe(1);
    db.closeDatabase();
  });
});
