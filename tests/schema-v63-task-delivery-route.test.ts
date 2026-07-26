import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v63-delivery-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
const databasePath = path.join(storeDir, 'messages.db');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });

vi.mock('../src/config.js', () => ({
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

beforeAll(() => {
  const legacy = new Database(databasePath);
  legacy.exec(`
    CREATE TABLE router_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO router_state VALUES ('schema_version', '62');
    CREATE TABLE registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      created_by TEXT,
      is_home INTEGER DEFAULT 0
    );
    INSERT INTO registered_groups (jid, name, folder, added_at, created_by, is_home)
    VALUES ('feishu:oc_legacy#account:bot-a', 'Legacy Chat', 'legacy-ws',
            '2026-07-24T00:00:00.000Z', 'legacy-owner', 0);
    CREATE TABLE scheduled_tasks (
      id TEXT PRIMARY KEY,
      group_folder TEXT NOT NULL,
      chat_jid TEXT NOT NULL,
      prompt TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_value TEXT NOT NULL,
      context_mode TEXT NOT NULL DEFAULT 'isolated',
      next_run TEXT,
      last_run TEXT,
      last_result TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL
    );
    INSERT INTO scheduled_tasks
      (id, group_folder, chat_jid, prompt, schedule_type, schedule_value,
       context_mode, next_run, status, created_at)
    VALUES
      ('legacy-task', 'legacy-ws', 'feishu:oc_legacy#account:bot-a',
       'daily report', 'cron', '0 9 * * *', 'isolated',
       '2026-07-26T01:00:00.000Z', 'active', '2026-07-24T00:00:00.000Z');
  `);
  legacy.close();
});

const db = await import('../src/db.js');

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('schema v63 scheduled-task delivery route migration', () => {
  test('backfills the binding from chat_jid and reaches head idempotently', () => {
    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );

    // A row written before the column existed keeps behaving as before: it was
    // effectively bound to its chat_jid, so that becomes its explicit binding
    // rather than leaving execution free to re-derive a target.
    const migrated = db.getTaskById('legacy-task');
    expect(migrated?.delivery_route_jid).toBe('feishu:oc_legacy#account:bot-a');

    // Re-running initDatabase must not disturb the backfilled value.
    db.closeDatabase();
    db.initDatabase();
    expect(db.getTaskById('legacy-task')?.delivery_route_jid).toBe(
      'feishu:oc_legacy#account:bot-a',
    );
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
  });

  test('a new task records a thread-scoped binding distinct from its chat_jid', () => {
    const route = 'feishu:oc_legacy#account:bot-a#thread:t-1#root:m-1';
    db.createTask({
      id: 'thread-task',
      group_folder: 'legacy-ws',
      chat_jid: 'feishu:oc_legacy#account:bot-a',
      delivery_route_jid: route,
      prompt: 'thread digest',
      schedule_type: 'cron',
      schedule_value: '0 9 * * *',
      context_mode: 'isolated',
      execution_type: 'agent',
      execution_mode: 'container',
      script_command: null,
      next_run: '2026-07-26T01:00:00.000Z',
      status: 'active',
      created_at: '2026-07-25T00:00:00.000Z',
      notify_channels: null,
    } as Parameters<typeof db.createTask>[0]);

    const stored = db.getTaskById('thread-task');
    expect(stored?.delivery_route_jid).toBe(route);
    expect(stored?.chat_jid).toBe('feishu:oc_legacy#account:bot-a');
  });
});
