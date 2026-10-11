import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v77-checkpoints-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
const dataDir = path.join(root, 'data');
const backupDir = path.join(root, 'backups');
const databasePath = path.join(storeDir, 'messages.db');
for (const dir of [storeDir, groupsDir, dataDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: dataDir,
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');

function tableNames(conn: Database.Database): string[] {
  return (
    conn
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

/** Build a current database, then rewind it to a v76 shape on disk. */
beforeAll(() => {
  process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
  try {
    db.initDatabase();
  } finally {
    delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
  }
  db.closeDatabase();

  const legacy = new Database(databasePath);
  legacy.exec('DROP TABLE IF EXISTS subagent_checkpoints');
  legacy
    .prepare(
      "UPDATE router_state SET value = '76' WHERE key = 'schema_version'",
    )
    .run();
  legacy.close();
});

afterAll(() => {
  db.closeDatabase();
  delete process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('schema v77 sub-agent checkpoints', () => {
  test('backs up the v76 database, creates the table and stamps v77', () => {
    process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR = backupDir;
    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe('77');
    const backups = fs.readdirSync(backupDir);
    expect(
      backups.some((name) => name.startsWith('messages-v76-to-v77-')),
    ).toBe(true);

    const backup = new Database(path.join(backupDir, backups[0]), {
      readonly: true,
    });
    expect(tableNames(backup)).not.toContain('subagent_checkpoints');
    backup.close();

    const conn = new Database(databasePath, { readonly: true });
    try {
      expect(tableNames(conn)).toContain('subagent_checkpoints');
      const plan = (
        conn
          .prepare(
            `EXPLAIN QUERY PLAN SELECT * FROM subagent_checkpoints
              WHERE group_folder = ? AND chat_jid = ?
                AND input_message_id IN (?, ?)`,
          )
          .all('main', 'web:main', 'a', 'b') as Array<{ detail: string }>
      )
        .map((row) => row.detail)
        .join(' | ');
      expect(plan).toContain('idx_subagent_checkpoints_input');
    } finally {
      conn.close();
    }

    db.upsertSubagentCheckpoint({
      taskId: 'toolu_1',
      groupFolder: 'main',
      chatJid: 'web:main',
      inputMessageId: 'msg-1',
      description: 'after migration',
    });
    expect(
      db.listSubagentCheckpointsForInputs('main', 'web:main', ['msg-1']),
    ).toHaveLength(1);
  });

  test('re-running the current schema is a no-op and newer schemas are refused', () => {
    db.closeDatabase();
    const before = fs.readdirSync(backupDir).length;
    db.initDatabase();
    expect(fs.readdirSync(backupDir)).toHaveLength(before);
    expect(
      db.listSubagentCheckpointsForInputs('main', 'web:main', ['msg-1']),
    ).toHaveLength(1);
    db.closeDatabase();

    const conn = new Database(databasePath);
    conn
      .prepare(
        "UPDATE router_state SET value = '78' WHERE key = 'schema_version'",
      )
      .run();
    conn.close();
    expect(() => db.initDatabase()).toThrow('refusing downgrade');
  });
});
