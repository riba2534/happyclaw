import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v92-model-'));
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
const store = await import('../src/automation-store.js');

const NOW = '2026-11-15T00:00:00.000Z';
const MODEL_COLUMNS = ['model_config_id', 'model', 'reasoning_effort'];

function columnNames(conn: Database.Database): string[] {
  return (
    conn.prepare('PRAGMA table_info(automations)').all() as Array<{
      name: string;
    }>
  ).map((column) => column.name);
}

/** Build a current database, then rewind it to the v91 shape on disk. */
beforeAll(() => {
  process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
  try {
    db.initDatabase();
  } finally {
    delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
  }
  db.closeDatabase();

  const legacy = new Database(databasePath);
  for (const column of MODEL_COLUMNS) {
    legacy.exec(`ALTER TABLE automations DROP COLUMN ${column}`);
  }
  // An automation saved before automations had a model.
  legacy
    .prepare(
      `INSERT INTO automations (
         id, workspace_jid, workspace_folder, created_by, name, prompt,
         schedule_kind, session_mode, execution, status, revision,
         created_at, updated_at
       ) VALUES ('old-auto', 'web:old', 'old', 'owner', '日报', '汇总',
         'manual', 'persistent', 'agent', 'active', 3, ?, ?)`,
    )
    .run(NOW, NOW);
  legacy
    .prepare(
      "UPDATE router_state SET value = '91' WHERE key = 'schema_version'",
    )
    .run();
  legacy.close();
});

afterAll(() => {
  db.closeDatabase();
  delete process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('schema v92 automation model', () => {
  test('a new database has the columns', () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v92-new-'));
    try {
      const conn = new Database(path.join(fresh, 'fresh.db'));
      try {
        store.initAutomationStore(conn);
        expect(columnNames(conn)).toEqual(
          expect.arrayContaining(MODEL_COLUMNS),
        );
        // Idempotent: binding again changes nothing.
        store.initAutomationStore(conn);
        expect(
          columnNames(conn).filter((name) => MODEL_COLUMNS.includes(name)),
        ).toEqual(MODEL_COLUMNS);
      } finally {
        store.initAutomationStore(null);
        conn.close();
      }
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });

  test('backs up the v91 database and adds the columns; old automations have no model', () => {
    process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR = backupDir;
    db.initDatabase();
    expect(db.CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(92);
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
    const backupName = fs
      .readdirSync(backupDir)
      .find((name) =>
        name.startsWith(`messages-v91-to-v${db.CURRENT_SCHEMA_VERSION}-`),
      );
    expect(backupName).toBeDefined();
    const backup = new Database(path.join(backupDir, backupName!), {
      readonly: true,
    });
    try {
      expect(columnNames(backup)).not.toContain('model_config_id');
    } finally {
      backup.close();
    }
    const conn = new Database(databasePath, { readonly: true });
    try {
      expect(columnNames(conn)).toEqual(expect.arrayContaining(MODEL_COLUMNS));
    } finally {
      conn.close();
    }

    expect(store.getAutomation('old-auto')).toMatchObject({
      name: '日报',
      sessionMode: 'persistent',
      revision: 3,
      model: null,
    });

    // The columns round-trip a choice and its absence.
    const old = store.getAutomation('old-auto')!;
    const choice = { modelConfigId: 'glm', model: 'glm-5.3', effort: null };
    store.saveAutomation({ ...old, model: choice });
    expect(store.getAutomation('old-auto')?.model).toEqual(choice);
    store.saveAutomation({ ...old, model: null });
    expect(store.getAutomation('old-auto')?.model).toBeNull();
  });

  test('re-running the current schema is a no-op and newer schemas are refused', () => {
    db.closeDatabase();
    const before = fs.readdirSync(backupDir).length;
    db.initDatabase();
    expect(fs.readdirSync(backupDir)).toHaveLength(before);
    expect(store.getAutomation('old-auto')?.model).toBeNull();
    db.closeDatabase();

    const conn = new Database(databasePath);
    conn
      .prepare("UPDATE router_state SET value = ? WHERE key = 'schema_version'")
      .run(String(db.CURRENT_SCHEMA_VERSION + 1));
    conn.close();
    expect(() => db.initDatabase()).toThrow('refusing downgrade');
  });
});
