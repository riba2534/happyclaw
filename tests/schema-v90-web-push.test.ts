import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v90-web-push-'));
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
const store = await import('../src/web-push-store.js');

const NOW = '2026-11-05T00:00:00.000Z';

function createUser(id: string): void {
  db.createUser({
    id,
    username: id,
    password_hash: 'hash',
    display_name: id,
    role: 'member',
    status: 'active',
    created_at: NOW,
    updated_at: NOW,
    must_change_password: false,
  });
}

function tableNames(conn: Database.Database): string[] {
  return (
    conn
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

/** Build a current database, then rewind it to the v89 shape on disk. */
beforeAll(() => {
  process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
  try {
    db.initDatabase();
  } finally {
    delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
  }
  createUser('push-owner');
  db.closeDatabase();

  const legacy = new Database(databasePath);
  legacy.exec(`
    DROP INDEX idx_web_push_subscriptions_user;
    DROP TABLE web_push_subscriptions;
  `);
  legacy
    .prepare(
      "UPDATE router_state SET value = '89' WHERE key = 'schema_version'",
    )
    .run();
  legacy.close();
});

afterAll(() => {
  db.closeDatabase();
  delete process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR;
  fs.rmSync(root, { recursive: true, force: true });
});

describe('schema v90 web push subscriptions', () => {
  test('a new database has the table and the index', () => {
    const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v90-new-'));
    try {
      const conn = new Database(path.join(fresh, 'fresh.db'));
      try {
        store.initWebPushStore(conn);
        const columns = (
          conn
            .prepare('PRAGMA table_info(web_push_subscriptions)')
            .all() as Array<{ name: string; pk: number }>
        ).map((column) => column.name);
        expect(columns).toEqual([
          'endpoint',
          'user_id',
          'p256dh',
          'auth',
          'user_agent',
          'created_at',
          'updated_at',
          'last_success_at',
        ]);
        expect(
          (
            conn
              .prepare('PRAGMA index_list(web_push_subscriptions)')
              .all() as Array<{ name: string }>
          ).map((index) => index.name),
        ).toContain('idx_web_push_subscriptions_user');
        // Idempotent: binding again changes nothing.
        store.initWebPushStore(conn);
        expect(tableNames(conn)).toContain('web_push_subscriptions');
      } finally {
        store.initWebPushStore(null);
        conn.close();
      }
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });

  test('backs up the v89 database and creates the table', () => {
    process.env.HAPPYCLAW_MIGRATION_BACKUP_DIR = backupDir;
    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
    expect(db.CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(90);
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
      expect(tableNames(backup)).not.toContain('web_push_subscriptions');
    } finally {
      backup.close();
    }
    const conn = new Database(databasePath, { readonly: true });
    try {
      expect(tableNames(conn)).toContain('web_push_subscriptions');
    } finally {
      conn.close();
    }
  });

  test('stores one row per endpoint and re-owns it on re-registration', () => {
    createUser('other-user');
    store.upsertWebPushSubscription(
      {
        endpoint: 'https://fcm.googleapis.com/e/1',
        userId: 'push-owner',
        p256dh: 'k1',
        auth: 'a1',
        userAgent: 'UA',
      },
      '2026-11-05T01:00:00.000Z',
    );
    store.upsertWebPushSubscription(
      {
        endpoint: 'https://fcm.googleapis.com/e/2',
        userId: 'push-owner',
        p256dh: 'k2',
        auth: 'a2',
      },
      '2026-11-05T02:00:00.000Z',
    );
    expect(
      store.listWebPushSubscriptions('push-owner').map((row) => row.endpoint),
    ).toEqual([
      'https://fcm.googleapis.com/e/1',
      'https://fcm.googleapis.com/e/2',
    ]);

    // Same device, another account: the row moves, keys refresh, created_at stays.
    store.upsertWebPushSubscription(
      {
        endpoint: 'https://fcm.googleapis.com/e/1',
        userId: 'other-user',
        p256dh: 'k1b',
        auth: 'a1b',
      },
      '2026-11-05T03:00:00.000Z',
    );
    expect(store.listWebPushSubscriptions('push-owner')).toHaveLength(1);
    expect(
      store.getWebPushSubscription('https://fcm.googleapis.com/e/1'),
    ).toMatchObject({
      user_id: 'other-user',
      p256dh: 'k1b',
      auth: 'a1b',
      created_at: '2026-11-05T01:00:00.000Z',
      updated_at: '2026-11-05T03:00:00.000Z',
    });
  });

  test("deleting is scoped to the owner; the push service's 410 deletes by endpoint", () => {
    const endpoint = 'https://fcm.googleapis.com/e/2';
    expect(store.deleteWebPushSubscription(endpoint, 'other-user')).toBe(false);
    expect(store.getWebPushSubscription(endpoint)).toBeDefined();
    expect(store.deleteWebPushSubscription(endpoint, 'push-owner')).toBe(true);
    expect(store.getWebPushSubscription(endpoint)).toBeUndefined();

    store.markWebPushSuccess('https://fcm.googleapis.com/e/1', NOW);
    expect(
      store.getWebPushSubscription('https://fcm.googleapis.com/e/1')
        ?.last_success_at,
    ).toBe(NOW);
    expect(
      store.deleteWebPushSubscriptionByEndpoint(
        'https://fcm.googleapis.com/e/1',
      ),
    ).toBe(true);
    expect(
      store.deleteWebPushSubscriptionByEndpoint(
        'https://fcm.googleapis.com/e/1',
      ),
    ).toBe(false);
  });

  test('deleting a user drops their subscriptions', () => {
    store.upsertWebPushSubscription({
      endpoint: 'https://fcm.googleapis.com/e/3',
      userId: 'push-owner',
      p256dh: 'k',
      auth: 'a',
    });
    store.upsertWebPushSubscription({
      endpoint: 'https://fcm.googleapis.com/e/4',
      userId: 'other-user',
      p256dh: 'k',
      auth: 'a',
    });
    db.deleteUser('push-owner');
    expect(store.listWebPushSubscriptions('push-owner')).toEqual([]);
    expect(store.listWebPushSubscriptions('other-user')).toHaveLength(1);
  });

  test('re-running the current schema is a no-op and newer schemas are refused', () => {
    db.closeDatabase();
    const before = fs.readdirSync(backupDir).length;
    db.initDatabase();
    expect(fs.readdirSync(backupDir)).toHaveLength(before);
    expect(store.listWebPushSubscriptions('other-user')).toHaveLength(1);
    db.closeDatabase();

    const conn = new Database(databasePath);
    conn
      .prepare("UPDATE router_state SET value = ? WHERE key = 'schema_version'")
      .run(String(db.CURRENT_SCHEMA_VERSION + 1));
    conn.close();
    expect(() => db.initDatabase()).toThrow('refusing downgrade');
  });
});
