import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v54-task-runs-'));
const store = path.join(tmp, 'db');
const groups = path.join(tmp, 'groups');
const dbPath = path.join(store, 'messages.db');
fs.mkdirSync(store, { recursive: true });
fs.mkdirSync(groups, { recursive: true });

vi.mock('../src/config.js', () => ({ STORE_DIR: store, GROUPS_DIR: groups }));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

beforeAll(() => {
  const legacy = new Database(dbPath);
  legacy.exec(`
    CREATE TABLE router_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO router_state VALUES ('schema_version', '53');

    CREATE TABLE scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      context_mode TEXT DEFAULT 'isolated',
      execution_type TEXT DEFAULT 'agent',
      script_command TEXT,
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT DEFAULT 'active',
      created_at TEXT NOT NULL,
      created_by TEXT,
      notify_channels TEXT,
      running_until TEXT,
      runner_id TEXT
    );
    INSERT INTO scheduled_tasks VALUES (
      'legacy-task', 'legacy-workspace', 'web:legacy-workspace',
      'legacy prompt', 'cron', '0 * * * *', 'isolated', 'agent', NULL,
      '2026-07-19T06:00:00.000Z', '2026-07-19T05:00:00.000Z',
      'legacy result', 'active', '2026-07-01T00:00:00.000Z',
      'legacy-owner', '["feishu"]', NULL, NULL
    );

    -- Exact v53 durable-run shape: v54 must add the lease payload snapshot
    -- without rebuilding or dropping this audit table.
    CREATE TABLE task_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      occurrence_key TEXT NOT NULL UNIQUE,
      trigger_type TEXT NOT NULL,
      idempotency_key TEXT,
      scheduled_for TEXT NOT NULL,
      definition_revision INTEGER NOT NULL,
      definition_snapshot TEXT NOT NULL,
      status TEXT NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 0,
      available_at TEXT NOT NULL,
      lease_owner TEXT,
      lease_token INTEGER NOT NULL DEFAULT 0,
      lease_expires_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      result TEXT,
      error TEXT,
      notification_status TEXT NOT NULL DEFAULT 'pending',
      notification_error TEXT,
      notification_summary TEXT,
      notification_payload TEXT,
      notification_attempt INTEGER NOT NULL DEFAULT 0,
      notification_available_at TEXT,
      notification_lease_owner TEXT,
      notification_lease_token INTEGER NOT NULL DEFAULT 0,
      notification_lease_expires_at TEXT,
      notification_generation INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );

    CREATE TABLE task_run_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      run_at TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      status TEXT NOT NULL,
      result TEXT,
      error TEXT,
      FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
    );
    INSERT INTO task_run_logs
      (task_id, run_at, duration_ms, status, result, error)
    VALUES
      ('legacy-task', '2026-07-19T05:00:00.000Z', 4321, 'success',
       'legacy result', NULL);
  `);
  legacy.close();
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('schema v54 durable scheduled task migration', () => {
  test('preserves legacy definitions and run logs while adding V2 state', async () => {
    const db = await import('../src/db.js');
    db.initDatabase();

    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
    expect(db.getTaskById('legacy-task')).toMatchObject({
      id: 'legacy-task',
      prompt: 'legacy prompt',
      last_result: 'legacy result',
      notify_channels: ['feishu'],
      revision: 1,
      updated_at: '2026-07-01T00:00:00.000Z',
      deleted_at: null,
    });
    expect(db.getTaskRunLogs('legacy-task')).toEqual([
      expect.objectContaining({
        task_id: 'legacy-task',
        run_at: '2026-07-19T05:00:00.000Z',
        duration_ms: 4321,
        status: 'success',
        result: 'legacy result',
        error: null,
      }),
    ]);
    expect(db.getTaskRunsForTask('legacy-task')).toEqual([]);
    db.closeDatabase();

    const probe = new Database(dbPath, { readonly: true });
    expect(
      (
        probe
          .prepare(
            "SELECT COUNT(*) AS count FROM scheduled_tasks WHERE id = 'legacy-task'",
          )
          .get() as { count: number }
      ).count,
    ).toBe(1);
    expect(
      (
        probe
          .prepare(
            "SELECT COUNT(*) AS count FROM task_run_logs WHERE task_id = 'legacy-task'",
          )
          .get() as { count: number }
      ).count,
    ).toBe(1);
    const taskRunColumns = probe
      .prepare('PRAGMA table_info(task_runs)')
      .all() as Array<{ name: string }>;
    expect(taskRunColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'occurrence_key',
        'definition_snapshot',
        'lease_token',
        'notification_status',
        'notification_generation',
        'notification_lease_payload',
      ]),
    );
    probe.close();

    // Restarting an already-upgraded installation must be idempotent.
    db.initDatabase();
    expect(db.getTaskById('legacy-task')?.revision).toBe(1);
    expect(db.getTaskRunLogs('legacy-task')).toHaveLength(1);
    db.closeDatabase();
  });
});
