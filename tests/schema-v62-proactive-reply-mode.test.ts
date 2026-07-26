import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v62-reply-mode-'));
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
    INSERT INTO router_state VALUES ('schema_version', '61');
    CREATE TABLE registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      created_by TEXT,
      is_home INTEGER DEFAULT 0
    );
    INSERT INTO registered_groups
      (jid, name, folder, added_at, created_by, is_home)
    VALUES
      ('web:legacy-proactive-workspace', 'Legacy Proactive Workspace',
       'legacy-proactive-workspace', '2026-07-24T00:00:00.000Z',
       'legacy-owner', 0);
    CREATE TABLE workspace_agent_profiles (
      group_folder TEXT PRIMARY KEY,
      agent_profile_id TEXT NOT NULL,
      interaction_mode TEXT NOT NULL DEFAULT 'assistant'
        CHECK (interaction_mode IN ('assistant', 'persona')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO workspace_agent_profiles
      (group_folder, agent_profile_id, interaction_mode, created_at, updated_at)
    VALUES
      ('legacy-proactive-workspace', 'legacy-profile', 'persona',
       '2026-07-24T00:00:00.000Z', '2026-07-24T00:00:00.000Z');
  `);
  legacy.close();
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('schema v62 proactive reply-mode migration', () => {
  test('renames persisted persona values and rebuilds the CHECK constraint', async () => {
    const db = await import('../src/db.js');
    db.initDatabase();

    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
    expect(
      db.getWorkspaceAgentProfileBinding('legacy-proactive-workspace'),
    ).toMatchObject({
      agent_profile_id: 'legacy-profile',
      interaction_mode: 'proactive',
    });
    expect(
      db.setWorkspaceInteractionMode('legacy-proactive-workspace', 'proactive'),
    ).toBe(true);
    db.closeDatabase();

    const migrated = new Database(databasePath);
    const table = migrated
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workspace_agent_profiles'",
      )
      .get() as { sql: string };
    expect(table.sql).toContain("'proactive'");
    expect(table.sql).not.toContain("'persona'");
    migrated.close();

    const backups = fs.readdirSync(path.join(storeDir, 'migration-backups'));
    expect(
      backups.some((name) =>
        name.includes(`v61-to-v${db.CURRENT_SCHEMA_VERSION}`),
      ),
    ).toBe(true);

    db.initDatabase();
    expect(db.getWorkspaceInteractionMode('legacy-proactive-workspace')).toBe(
      'proactive',
    );
    db.closeDatabase();
  });
});
