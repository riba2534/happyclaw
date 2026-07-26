import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'db-upgrade-safety-'));
const store = path.join(tmp, 'db');
const groups = path.join(tmp, 'groups');
const dbPath = path.join(store, 'messages.db');
const migrationBackups = path.join(tmp, 'migration-backups');
fs.mkdirSync(store, { recursive: true });
fs.mkdirSync(groups, { recursive: true });

vi.mock('../src/config.js', () => ({ STORE_DIR: store, GROUPS_DIR: groups }));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');

afterAll(() => {
  delete process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR;
  try {
    db.closeDatabase();
  } catch {
    // A failed migration deliberately closes its connection.
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

function tableExists(probe: Database.Database, table: string): boolean {
  return Boolean(
    probe
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table),
  );
}

describe('database upgrade safety gate', () => {
  test('backs up before destructive migration, preserves audit orphans, and aborts when backup fails', () => {
    db.initDatabase();
    db.closeDatabase();

    const legacy = new Database(dbPath);
    legacy.exec(`
      CREATE TABLE group_members (
        group_folder TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        added_at TEXT NOT NULL,
        added_by TEXT,
        PRIMARY KEY (group_folder, user_id)
      );
      INSERT INTO group_members VALUES (
        'audit-workspace', 'legacy-member', 'member',
        '2026-07-16T00:00:00.000Z', 'operator'
      );
      INSERT INTO balance_transactions (
        user_id, type, amount_usd, balance_after, description,
        source, operator_type, created_at
      ) VALUES (
        'deleted-user', 'adjustment', 12.5, 12.5, 'retained audit evidence',
        'system_adjustment', 'system', '2026-07-16T00:00:00.000Z'
      );
      UPDATE router_state SET value = '39' WHERE key = 'schema_version';
    `);
    legacy.close();

    process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR = migrationBackups;
    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
    db.closeDatabase();

    const backupNames = fs.readdirSync(migrationBackups);
    expect(backupNames).toHaveLength(1);
    const backup = new Database(path.join(migrationBackups, backupNames[0]), {
      readonly: true,
    });
    expect(
      (
        backup
          .prepare(
            "SELECT value FROM router_state WHERE key = 'schema_version'",
          )
          .get() as { value: string }
      ).value,
    ).toBe('39');
    expect(tableExists(backup, 'group_members')).toBe(true);
    expect(
      (
        backup
          .prepare(
            "SELECT COUNT(*) AS count FROM balance_transactions WHERE user_id = 'deleted-user'",
          )
          .get() as { count: number }
      ).count,
    ).toBe(1);
    backup.close();

    const migrated = new Database(dbPath);
    expect(tableExists(migrated, 'group_members')).toBe(false);
    expect(
      (
        migrated
          .prepare(
            "SELECT COUNT(*) AS count FROM balance_transactions WHERE user_id = 'deleted-user'",
          )
          .get() as { count: number }
      ).count,
    ).toBe(1);
    migrated.exec(`
      CREATE TABLE group_members (
        group_folder TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        added_at TEXT NOT NULL,
        added_by TEXT,
        PRIMARY KEY (group_folder, user_id)
      );
      INSERT INTO group_members VALUES (
        'must-survive', 'legacy-member', 'member',
        '2026-07-16T00:00:00.000Z', 'operator'
      );
      UPDATE router_state SET value = '50' WHERE key = 'schema_version';
    `);
    migrated.close();

    const invalidBackupDir = path.join(tmp, 'not-a-directory');
    fs.writeFileSync(invalidBackupDir, 'blocks mkdir');
    process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR = invalidBackupDir;
    expect(() => db.initDatabase()).toThrow(/pre-migration backup failed/);

    const afterFailure = new Database(dbPath, { readonly: true });
    expect(tableExists(afterFailure, 'group_members')).toBe(true);
    expect(
      (
        afterFailure
          .prepare(
            "SELECT value FROM router_state WHERE key = 'schema_version'",
          )
          .get() as { value: string }
      ).value,
    ).toBe('50');
    afterFailure.close();

    process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR = migrationBackups;
    db.initDatabase();
    db.closeDatabase();
    const backupCountAfterRetry = fs.readdirSync(migrationBackups).length;
    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
    db.closeDatabase();
    expect(fs.readdirSync(migrationBackups)).toHaveLength(
      backupCountAfterRetry,
    );
  });
});

describe('schema version head', () => {
  test('pins the head version so a bump stays a reviewed decision', () => {
    // Deliberately a literal. The migration tests above compare against
    // CURRENT_SCHEMA_VERSION, which makes each of them tautological on its
    // own: initDatabase stores the very constant they assert on. This is the
    // one assertion that fails when the head moves, forcing whoever bumps it
    // to confirm the matching migration block — and a test covering it —
    // actually landed. Update the literal in the same commit as the migration.
    expect(db.CURRENT_SCHEMA_VERSION).toBe(63);
  });
});
