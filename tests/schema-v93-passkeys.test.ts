import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v93-passkeys-'));
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
const store = await import('../src/auth-factor-store.js');

const FACTOR_TABLES = ['webauthn_credentials'];

function tableNames(conn: Database.Database): string[] {
  return (
    conn
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

/** Build a current database, then rewind it to the v92 shape on disk. */
beforeAll(() => {
  process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
  try {
    db.initDatabase();
  } finally {
    delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
  }
  db.closeDatabase();
  const legacy = new Database(databasePath);
  legacy.exec('DROP TABLE webauthn_credentials;');
  legacy
    .prepare(
      "UPDATE router_state SET value = '92' WHERE key = 'schema_version'",
    )
    .run();
  legacy.close();
});

afterAll(() => {
  db.closeDatabase();
  delete process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('schema v93 passkeys', () => {
  test('backs up the v92 database and creates the passkey table', () => {
    process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR = backupDir;
    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
    const backupName = fs
      .readdirSync(backupDir)
      .find((name) =>
        name.startsWith(`messages-v92-to-v${db.CURRENT_SCHEMA_VERSION}-`),
      );
    expect(backupName).toBeDefined();
    const backup = new Database(path.join(backupDir, backupName!), {
      readonly: true,
    });
    try {
      for (const table of FACTOR_TABLES) {
        expect(tableNames(backup)).not.toContain(table);
      }
    } finally {
      backup.close();
    }
    const conn = new Database(databasePath, { readonly: true });
    try {
      expect(tableNames(conn)).toEqual(expect.arrayContaining(FACTOR_TABLES));
    } finally {
      conn.close();
    }
    expect(store.listPasskeys('nobody')).toEqual([]);
  });

  test('re-running the current schema is a no-op and newer schemas are refused', () => {
    db.closeDatabase();
    const before = fs.readdirSync(backupDir).length;
    db.initDatabase();
    expect(fs.readdirSync(backupDir)).toHaveLength(before);
    db.closeDatabase();
    const conn = new Database(databasePath);
    conn
      .prepare("UPDATE router_state SET value = ? WHERE key = 'schema_version'")
      .run(String(db.CURRENT_SCHEMA_VERSION + 1));
    conn.close();
    expect(() => db.initDatabase()).toThrow('refusing downgrade');
  });
});
