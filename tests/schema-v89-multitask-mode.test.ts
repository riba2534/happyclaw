import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v89-multitask-'));
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
const store = await import('../src/work-item-store.js');

const OWNER_ID = 'multitask-owner';
const NOW = '2026-11-04T00:00:00.000Z';
const MANDATE = {
  strength: 'explicit' as const,
  requesterImId: null,
  requesterName: 'Owner',
  requesterListed: true,
  requesterIsOwner: true,
  matchedRules: [],
  settingsVersion: 0,
  writable: true,
};

function columnNames(conn: Database.Database, table: string): string[] {
  return (
    conn.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
}

function indexNames(conn: Database.Database, table: string): string[] {
  return (
    conn.prepare(`PRAGMA index_list(${table})`).all() as Array<{
      name: string;
    }>
  ).map((row) => row.name);
}

/** Register a real Web workspace: startup drops bindings that have none. */
function createWorkspace(folder: string): void {
  const profile = db.getOrCreateDefaultAgentProfile(OWNER_ID);
  db.setRegisteredGroup(`web:${folder}`, {
    name: folder,
    folder,
    added_at: NOW,
    created_by: OWNER_ID,
    executionMode: 'container',
  });
  db.assignWorkspaceAgentProfile(folder, profile.id, 'assistant');
}

/** Build a current database, then rewind it to the v88 shape on disk. */
beforeAll(() => {
  process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
  try {
    db.initDatabase();
  } finally {
    delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
  }
  db.createUser({
    id: OWNER_ID,
    username: OWNER_ID,
    password_hash: 'hash',
    display_name: OWNER_ID,
    role: 'member',
    status: 'active',
    created_at: NOW,
    updated_at: NOW,
    must_change_password: false,
  });
  createWorkspace('legacy-ws');
  // A team item a v88 build had already made.
  store.insertWorkItem({
    id: 'legacy-item',
    workspaceJid: 'web:legacy-ws',
    workspaceFolder: 'legacy-ws',
    channelJid: 'feishu:oc_g',
    agentId: 'legacy-worker',
    title: 'Fix it',
    sourceMessageId: 'om_1',
    sourceRouteJid: 'feishu:oc_g',
    mandate: { ...MANDATE, requesterImId: 'ou_a' },
    now: NOW,
  });
  db.closeDatabase();

  const legacy = new Database(databasePath);
  legacy.exec(`
    DROP INDEX idx_work_items_origin_agent;
    ALTER TABLE work_items DROP COLUMN origin;
    ALTER TABLE work_items DROP COLUMN origin_agent_id;
    ALTER TABLE work_items DROP COLUMN origin_input_id;
    ALTER TABLE workspace_agent_profiles DROP COLUMN work_mode;
  `);
  legacy
    .prepare(
      "UPDATE router_state SET value = '88' WHERE key = 'schema_version'",
    )
    .run();
  legacy.close();
});

afterAll(() => {
  db.closeDatabase();
  delete process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('schema v89 multi-task mode', () => {
  test('a new database has the columns and the index', () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v89-new-'));
    try {
      const conn = new Database(path.join(fresh, 'fresh.db'));
      try {
        store.initWorkItemStore(conn);
        expect(columnNames(conn, 'work_items')).toEqual(
          expect.arrayContaining([
            'origin',
            'origin_agent_id',
            'origin_input_id',
          ]),
        );
        expect(indexNames(conn, 'work_items')).toContain(
          'idx_work_items_origin_agent',
        );
        // Idempotent: a second bind changes nothing.
        store.initWorkItemStore(conn);
        expect(
          columnNames(conn, 'work_items').filter((c) => c === 'origin'),
        ).toHaveLength(1);
      } finally {
        store.initWorkItemStore(null);
        conn.close();
      }
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });

  test('backs up the v88 database; existing workspaces stay single and items team', () => {
    process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR = backupDir;
    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
    const backupName = fs
      .readdirSync(backupDir)
      .find((name) =>
        name.startsWith(`messages-v88-to-v${db.CURRENT_SCHEMA_VERSION}-`),
      );
    expect(backupName).toBeDefined();
    const backup = new Database(path.join(backupDir, backupName!), {
      readonly: true,
    });
    try {
      expect(columnNames(backup, 'work_items')).not.toContain('origin');
      expect(columnNames(backup, 'workspace_agent_profiles')).not.toContain(
        'work_mode',
      );
    } finally {
      backup.close();
    }

    const conn = new Database(databasePath, { readonly: true });
    try {
      expect(indexNames(conn, 'work_items')).toContain(
        'idx_work_items_origin_agent',
      );
    } finally {
      conn.close();
    }
    expect(db.getWorkspaceWorkMode('legacy-ws')).toBe('single');
    expect(store.getWorkItem('legacy-item')).toMatchObject({
      origin: 'team',
      originAgentId: null,
      originInputId: null,
    });
  });

  test('the work mode is stored per workspace; unbound reads single', () => {
    createWorkspace('other-ws');
    expect(db.setWorkspaceWorkMode('legacy-ws', 'multi')).toBe(true);
    expect(db.getWorkspaceWorkMode('legacy-ws')).toBe('multi');
    expect(db.getWorkspaceAgentProfileBinding('legacy-ws')?.work_mode).toBe(
      'multi',
    );
    expect(db.getWorkspaceWorkMode('other-ws')).toBe('single');
    expect(db.setWorkspaceWorkMode('missing-ws', 'multi')).toBe(false);
    expect(db.getWorkspaceWorkMode('missing-ws')).toBe('single');
    // Rebinding the Agent keeps it.
    db.assignWorkspaceAgentProfile(
      'legacy-ws',
      db.getOrCreateDefaultAgentProfile(OWNER_ID).id,
    );
    expect(db.getWorkspaceWorkMode('legacy-ws')).toBe('multi');
  });

  test('a delegated item round-trips and shares the workspace numbering', () => {
    const item = store.insertWorkItem({
      id: 'delegated-item',
      workspaceJid: 'web:legacy-ws',
      workspaceFolder: 'legacy-ws',
      channelJid: 'web:legacy-ws#agent:main-1',
      agentId: 'worker-1',
      title: 'Research',
      sourceMessageId: 'delegate:u1',
      sourceRouteJid: 'web:legacy-ws#agent:main-1',
      mandate: MANDATE,
      now: NOW,
      delegatedBy: { agentId: 'main-1', inputId: 'msg-1' },
    });
    expect(item).toMatchObject({
      origin: 'delegated',
      originAgentId: 'main-1',
      originInputId: 'msg-1',
      seq: 2,
    });
    expect(store.countOpenDelegatedWorkItems({ originAgentId: 'main-1' })).toBe(
      1,
    );
    expect(
      store.countOpenDelegatedWorkItems({ workspaceJid: 'web:legacy-ws' }),
    ).toBe(1);
    expect(store.getWorkItemBySeq('web:legacy-ws', 2)?.id).toBe(
      'delegated-item',
    );
  });

  test('the database refuses unknown modes and origins', () => {
    db.closeDatabase();
    const conn = new Database(databasePath);
    try {
      expect(() =>
        conn
          .prepare(
            "UPDATE workspace_agent_profiles SET work_mode = 'bogus' WHERE group_folder = 'legacy-ws'",
          )
          .run(),
      ).toThrow(/CHECK constraint/i);
      expect(() =>
        conn
          .prepare(
            "UPDATE work_items SET origin = 'bogus' WHERE id = 'legacy-item'",
          )
          .run(),
      ).toThrow(/CHECK constraint/i);
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
    expect(db.getWorkspaceWorkMode('legacy-ws')).toBe('multi');
    db.closeDatabase();

    const conn = new Database(databasePath);
    conn
      .prepare("UPDATE router_state SET value = ? WHERE key = 'schema_version'")
      .run(String(db.CURRENT_SCHEMA_VERSION + 1));
    conn.close();
    expect(() => db.initDatabase()).toThrow('refusing downgrade');
  });
});
