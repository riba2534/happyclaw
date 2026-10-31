import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v87-delegate-'));
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

const NOW = '2026-10-30T00:00:00.000Z';
const DM = 'qq:c2c:AAAA';

function columns(conn: Database.Database, table: string): string[] {
  return (
    conn.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>
  ).map((column) => column.name);
}

/** Build a current database with one DM binding, then rewind it to v86. */
beforeAll(() => {
  process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
  try {
    db.initDatabase();
  } finally {
    delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
  }
  db.setRegisteredGroup('web:flow-x', {
    name: 'Flow X',
    folder: 'flow-x',
    created_by: 'u1',
    added_at: NOW,
  });
  db.setRegisteredGroup(DM, {
    name: 'DM',
    folder: 'flow-x',
    created_by: 'u1',
    added_at: NOW,
    target_main_jid: 'web:flow-x',
  });
  db.closeDatabase();

  const legacy = new Database(databasePath);
  legacy.exec('ALTER TABLE channel_mounts DROP COLUMN delegate_enabled');
  legacy.exec('ALTER TABLE agent_channel_mounts DROP COLUMN delegate_enabled');
  legacy
    .prepare(
      "UPDATE router_state SET value = '86' WHERE key = 'schema_version'",
    )
    .run();
  legacy.close();
});

afterAll(() => {
  db.closeDatabase();
  delete process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('schema v87 channel mount delegate', () => {
  test('backs up the v86 database and adds an off-by-default delegate column to both mount tables', () => {
    process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR = backupDir;
    db.initDatabase();
    expect(db.CURRENT_SCHEMA_VERSION).toBe(87);
    expect(db.getRouterState('schema_version')).toBe('87');

    const backupName = fs
      .readdirSync(backupDir)
      .find((name) => name.startsWith('messages-v86-to-v87-'));
    expect(backupName).toBeDefined();
    const backup = new Database(path.join(backupDir, backupName!), {
      readonly: true,
    });
    try {
      expect(columns(backup, 'channel_mounts')).not.toContain(
        'delegate_enabled',
      );
    } finally {
      backup.close();
    }

    const conn = new Database(databasePath, { readonly: true });
    try {
      expect(columns(conn, 'channel_mounts')).toContain('delegate_enabled');
      expect(columns(conn, 'agent_channel_mounts')).toContain(
        'delegate_enabled',
      );
    } finally {
      conn.close();
    }
    // The existing binding survives and starts untrusted.
    expect(db.getChannelMount(DM)).toMatchObject({
      workspace_jid: 'web:flow-x',
      delegate_enabled: false,
    });
    expect(db.getAgentChannelMount(DM)?.delegate_enabled).toBe(false);
  });

  test('refuses to open a newer database', () => {
    db.closeDatabase();
    const conn = new Database(databasePath);
    conn
      .prepare("UPDATE router_state SET value = ? WHERE key = 'schema_version'")
      .run(String(db.CURRENT_SCHEMA_VERSION + 1));
    conn.close();
    expect(() => db.initDatabase()).toThrow(/refusing downgrade/);
  });
});
