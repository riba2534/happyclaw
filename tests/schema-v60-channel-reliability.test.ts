import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v60-channel-'));
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
    INSERT INTO router_state VALUES ('schema_version', '59');
    INSERT INTO router_state VALUES ('preserved-key', 'preserved-value');
  `);
  legacy.close();
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('schema v60 channel reliability migration', () => {
  test('upgrades v59 in place, preserves state, and is restart-idempotent', async () => {
    const db = await import('../src/db.js');
    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
    expect(db.getRouterState('preserved-key')).toBe('preserved-value');
    db.closeDatabase();

    const probe = new Database(databasePath, { readonly: true });
    const tables = probe
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN (
           'channel_inbox','channel_cursors','turn_runs','channel_outbox','streaming_cards'
         ) ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual([
      'channel_cursors',
      'channel_inbox',
      'channel_outbox',
      'streaming_cards',
      'turn_runs',
    ]);
    probe.close();

    const backups = fs.readdirSync(path.join(storeDir, 'migration-backups'));
    expect(
      backups.some((name) =>
        name.includes(`v59-to-v${db.CURRENT_SCHEMA_VERSION}`),
      ),
    ).toBe(true);

    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
    expect(db.getRouterState('preserved-key')).toBe('preserved-value');
    db.closeDatabase();
  });
});
