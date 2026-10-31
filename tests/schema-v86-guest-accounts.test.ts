import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v86-guests-'));
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

const NOW = '2026-10-20T00:00:00.000Z';

function tableNames(conn: Database.Database): string[] {
  return (
    conn
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

/** Build a current database, then rewind it to the v85 shape on disk. */
beforeAll(() => {
  process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
  try {
    db.initDatabase();
  } finally {
    delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
  }
  db.createUser({
    id: 'u1',
    username: 'owner_one',
    password_hash: 'x',
    display_name: 'Owner',
    role: 'member',
    status: 'active',
    created_at: NOW,
    updated_at: NOW,
  });
  db.closeDatabase();

  const legacy = new Database(databasePath);
  legacy.exec('DROP TABLE guest_workspace_grants');
  legacy.exec('DROP INDEX IF EXISTS idx_users_guest_owner');
  legacy.exec('ALTER TABLE users DROP COLUMN guest_owner_id');
  legacy
    .prepare(
      "UPDATE router_state SET value = '85' WHERE key = 'schema_version'",
    )
    .run();
  legacy.close();
});

afterAll(() => {
  db.closeDatabase();
  delete process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('schema v86 guest accounts', () => {
  test('backs up the v85 database and adds the guest column and grants table', () => {
    process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR = backupDir;
    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );

    const backupName = fs
      .readdirSync(backupDir)
      .find((name) =>
        name.startsWith(`messages-v85-to-v${db.CURRENT_SCHEMA_VERSION}-`),
      );
    expect(backupName).toBeDefined();
    const backup = new Database(path.join(backupDir, backupName!), {
      readonly: true,
    });
    try {
      expect(tableNames(backup)).not.toContain('guest_workspace_grants');
    } finally {
      backup.close();
    }

    const conn = new Database(databasePath, { readonly: true });
    try {
      expect(tableNames(conn)).toContain('guest_workspace_grants');
      const userColumns = (
        conn.prepare('PRAGMA table_info(users)').all() as Array<{
          name: string;
        }>
      ).map((c) => c.name);
      expect(userColumns).toContain('guest_owner_id');
      const indexes = (
        conn
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'guest_workspace_grants'",
          )
          .all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(indexes).toEqual(
        expect.arrayContaining([
          'idx_guest_workspace_grants_workspace',
          'idx_guest_workspace_grants_owner',
        ]),
      );
    } finally {
      conn.close();
    }

    // Pre-existing accounts keep their role and are not guests.
    const owner = db.getUserById('u1')!;
    expect(owner.role).toBe('member');
    expect(owner.guest_owner_id).toBeNull();
  });

  test('guests round-trip and the grant predicate checks both accounts', () => {
    db.setRegisteredGroup('web:flow-x', {
      name: 'Flow X',
      folder: 'flow-x',
      added_at: NOW,
      executionMode: 'container',
      created_by: 'u1',
      is_home: false,
    } as any);
    db.createUser({
      id: 'guest-1',
      username: 'guest_one',
      password_hash: 'x',
      display_name: 'Guest',
      role: 'guest',
      status: 'active',
      permissions: ['manage_users'],
      guest_owner_id: 'u1',
      created_at: NOW,
      updated_at: NOW,
    });
    const guest = db.getUserById('guest-1')!;
    expect(guest.role).toBe('guest');
    expect(guest.guest_owner_id).toBe('u1');
    // Guests never hold a permission, whatever was requested.
    expect(guest.permissions).toEqual([]);

    db.replaceGuestWorkspaceGrants('guest-1', 'u1', ['web:flow-x']);
    expect(db.hasActiveGuestWorkspaceGrant('guest-1', 'web:flow-x', 'u1')).toBe(
      true,
    );
    // A grant is honoured only for the workspace's current owner.
    expect(db.hasActiveGuestWorkspaceGrant('guest-1', 'web:flow-x', 'u2')).toBe(
      false,
    );

    db.updateUserFields('u1', { status: 'disabled' });
    expect(db.hasActiveGuestWorkspaceGrant('guest-1', 'web:flow-x', 'u1')).toBe(
      false,
    );
    expect(db.listActiveGuestIdsForWorkspace('web:flow-x', 'u1')).toEqual([]);
    db.updateUserFields('u1', { status: 'active' });
    expect(db.listActiveGuestIdsForWorkspace('web:flow-x', 'u1')).toEqual([
      'guest-1',
    ]);

    expect(() =>
      db.createUser({
        id: 'guest-2',
        username: 'guest_two',
        password_hash: 'x',
        display_name: 'Orphan',
        role: 'guest',
        status: 'active',
        created_at: NOW,
        updated_at: NOW,
      }),
    ).toThrow(/guest_owner_id/);
    expect(() => db.ensureUserHomeGroup('guest-1', 'guest')).toThrow(
      /home workspace/,
    );
  });

  test('re-running the current schema is a no-op and newer schemas are refused', () => {
    db.closeDatabase();
    const before = fs.readdirSync(backupDir).length;
    db.initDatabase();
    expect(fs.readdirSync(backupDir)).toHaveLength(before);
    expect(db.listGuestWorkspaceGrants('guest-1')).toHaveLength(1);
    db.closeDatabase();

    const conn = new Database(databasePath);
    conn
      .prepare("UPDATE router_state SET value = ? WHERE key = 'schema_version'")
      .run(String(db.CURRENT_SCHEMA_VERSION + 1));
    conn.close();
    expect(() => db.initDatabase()).toThrow('refusing downgrade');
  });
});
