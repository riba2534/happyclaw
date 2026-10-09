import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v76-indexes-'));
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

const NEW_INDEXES = [
  'idx_messages_chat_turn_ts',
  'idx_messages_status_chat',
  'idx_rg_folder',
];

function indexNames(conn: Database.Database): string[] {
  return (
    conn
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function plan(conn: Database.Database, sql: string, ...args: unknown[]) {
  return (
    conn.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{
      detail: string;
    }>
  )
    .map((row) => row.detail)
    .join(' | ');
}

/** Build a current database, then rewind it to a v75 shape on disk. */
beforeAll(() => {
  process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
  try {
    db.initDatabase();
  } finally {
    delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
  }
  db.ensureChatExists('web:main');
  db.storeMessageDirect(
    'u1',
    'web:main',
    'u',
    'U',
    'question',
    '2026-01-01T00:00:00.000Z',
    false,
  );
  db.storeMessageDirect(
    'f1',
    'web:main',
    'bot',
    'Bot',
    'draft answer',
    '2026-01-01T00:00:01.000Z',
    true,
    {
      meta: { turnId: 'turn-1', sourceKind: 'sdk_final' } as any,
    },
  );
  db.closeDatabase();

  const legacy = new Database(databasePath);
  for (const name of NEW_INDEXES) legacy.exec(`DROP INDEX IF EXISTS ${name}`);
  legacy
    .prepare(
      "UPDATE router_state SET value = '75' WHERE key = 'schema_version'",
    )
    .run();
  legacy.close();
});

afterAll(() => {
  db.closeDatabase();
  delete process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('schema v76 hot-path indexes', () => {
  test('backs up the v75 database, adds the indexes and stamps v76', () => {
    process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR = backupDir;
    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe('76');
    const backups = fs.readdirSync(backupDir);
    expect(
      backups.some((name) => name.startsWith('messages-v75-to-v76-')),
    ).toBe(true);

    const conn = new Database(databasePath, { readonly: true });
    try {
      expect(indexNames(conn)).toEqual(expect.arrayContaining(NEW_INDEXES));
      // The backup is the untouched v75 file.
      const backup = new Database(path.join(backupDir, backups[0]), {
        readonly: true,
      });
      expect(indexNames(backup)).not.toContain('idx_messages_chat_turn_ts');
      backup.close();

      expect(
        plan(
          conn,
          `SELECT id FROM messages WHERE chat_jid = ? AND turn_id = ?
             AND source_kind IN ('sdk_final','truncation_continue','scheduled_task_result')
           ORDER BY timestamp DESC LIMIT 1`,
          'web:main',
          'turn-1',
        ),
      ).toContain('idx_messages_chat_turn_ts');
      expect(
        plan(
          conn,
          `SELECT DISTINCT chat_jid FROM messages
           WHERE delivery_status IN ('queued', 'promoting') ORDER BY chat_jid`,
        ),
      ).toContain('idx_messages_status_chat');
      expect(
        plan(
          conn,
          'SELECT jid FROM registered_groups WHERE folder = ?',
          'main',
        ),
      ).toContain('idx_rg_folder');
    } finally {
      conn.close();
    }
  });

  test('keeps turn-final upserts and follow-up discovery behavior', () => {
    // A second final for the same turn replaces the first row in place.
    const id = db.storeMessageDirect(
      'f2',
      'web:main',
      'bot',
      'Bot',
      'final answer',
      '2026-01-01T00:00:02.000Z',
      true,
      { meta: { turnId: 'turn-1', sourceKind: 'sdk_final' } as any },
    );
    expect(id).toBe('f1');
    const page = db.getMessagesPage('web:main', undefined, 10);
    expect(page.map((row) => [row.id, row.content])).toEqual([
      ['f1', 'final answer'],
      ['u1', 'question'],
    ]);
    expect(db.getQueuedFollowUpChatJids()).toEqual([]);
  });

  test('re-running the current schema is a no-op and newer schemas are refused', () => {
    db.closeDatabase();
    const before = fs.readdirSync(backupDir).length;
    db.initDatabase();
    expect(fs.readdirSync(backupDir)).toHaveLength(before);
    db.closeDatabase();

    const conn = new Database(databasePath);
    conn
      .prepare(
        "UPDATE router_state SET value = '77' WHERE key = 'schema_version'",
      )
      .run();
    conn.close();
    expect(() => db.initDatabase()).toThrow('refusing downgrade');
  });
});
