import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v90-workdirs-'));
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
const dir = await import('../src/workspace-dir.js');

const NOW = '2026-11-04T00:00:00.000Z';

function tableNames(conn: Database.Database): string[] {
  return (
    conn
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

/**
 * A real v89 database: the schema a v89 build created (dumped from it into
 * tests/fixtures/schema-v89.sql), one Host workspace and its owner.
 */
beforeAll(() => {
  const legacy = new Database(databasePath);
  legacy.exec(
    fs.readFileSync(
      path.join(import.meta.dirname, 'fixtures', 'schema-v89.sql'),
      'utf8',
    ),
  );
  legacy
    .prepare('INSERT INTO router_state (key, value) VALUES (?, ?)')
    .run('schema_version', '89');
  legacy
    .prepare(
      `INSERT INTO users (id, username, password_hash, display_name, role, status, created_at, updated_at)
       VALUES ('owner', 'owner', 'hash', 'owner', 'admin', 'active', ?, ?)`,
    )
    .run(NOW, NOW);
  legacy
    .prepare(
      `INSERT INTO registered_groups (jid, name, folder, added_at, execution_mode, created_by)
       VALUES ('web:legacy-ws', 'Legacy', 'legacy-ws', ?, 'host', 'owner')`,
    )
    .run(NOW);
  expect(tableNames(legacy)).not.toContain('workspace_workdirs');
  legacy.close();
  fs.mkdirSync(path.join(groupsDir, 'legacy-ws'), { recursive: true });
});

afterAll(() => {
  db.closeDatabase();
  delete process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('schema v90 workspace directories', () => {
  test('backs up the v89 database and adds the table; old workspaces stay put', () => {
    process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR = backupDir;
    db.initDatabase();
    // Later migrations run on top; the v89 -> v90 step is what is checked.
    expect(db.CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(90);
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );

    const backupName = fs
      .readdirSync(backupDir)
      .find((name) =>
        name.startsWith(`messages-v89-to-v${db.CURRENT_SCHEMA_VERSION}-`),
      );
    expect(backupName).toBeDefined();
    const backup = new Database(path.join(backupDir, backupName!), {
      readonly: true,
    });
    try {
      expect(tableNames(backup)).not.toContain('workspace_workdirs');
    } finally {
      backup.close();
    }

    const conn = new Database(databasePath, { readonly: true });
    try {
      expect(tableNames(conn)).toContain('workspace_workdirs');
    } finally {
      conn.close();
    }
    expect(db.getRegisteredGroup('web:legacy-ws')?.folder).toBe('legacy-ws');
    expect(dir.getRecordedWorkdir('legacy-ws')).toBeNull();
    expect(dir.workspaceDirOf('legacy-ws')).toBe(
      path.join(groupsDir, 'legacy-ws'),
    );
  });

  test('one directory per folder, never shared by two folders', () => {
    db.closeDatabase();
    const conn = new Database(databasePath);
    try {
      const insert = conn.prepare(
        'INSERT INTO workspace_workdirs (folder, workdir, root, created_at) VALUES (?, ?, ?, ?)',
      );
      insert.run('a', '/r/a', '/r', NOW);
      expect(() => insert.run('a', '/r/a2', '/r', NOW)).toThrow(/UNIQUE/);
      expect(() => insert.run('b', '/r/a', '/r', NOW)).toThrow(/UNIQUE/);
      // The root it was created in is part of every record.
      expect(() =>
        conn
          .prepare(
            'INSERT INTO workspace_workdirs (folder, workdir, created_at) VALUES (?, ?, ?)',
          )
          .run('c', '/r/c', NOW),
      ).toThrow(/NOT NULL/);
      conn.prepare("DELETE FROM workspace_workdirs WHERE folder = 'a'").run();
    } finally {
      conn.close();
    }
    db.initDatabase();
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
