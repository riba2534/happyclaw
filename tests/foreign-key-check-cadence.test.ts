import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fk-check-cadence-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
const dataDir = path.join(root, 'data');
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
const MARKER = 'foreign_key_check_clean_at';

function reopen(): void {
  db.closeDatabase();
  db.initDatabase();
}

/** Plant a messages→chats orphan behind enforcement's back. */
function plantOrphan(id: string): void {
  db.closeDatabase();
  const raw = new Database(databasePath);
  raw.pragma('foreign_keys = OFF');
  raw
    .prepare(
      `INSERT INTO messages (id, chat_jid, sender, sender_name, content, timestamp, is_from_me)
       VALUES (?, 'web:deleted-chat', 'u', 'U', 'orphan', '2026-01-01T00:00:00.000Z', 0)`,
    )
    .run(id);
  raw.close();
  db.initDatabase();
}

function orphanCount(): number {
  const raw = new Database(databasePath, { readonly: true });
  try {
    return (
      raw
        .prepare(
          "SELECT COUNT(*) AS n FROM messages WHERE chat_jid = 'web:deleted-chat'",
        )
        .get() as { n: number }
    ).n;
  } finally {
    raw.close();
  }
}

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('startup foreign-key check cadence', () => {
  test('records a clean check and skips the scan on the next boots', () => {
    db.initDatabase();
    reopen(); // first boot on the current schema with router_state present
    const marker = db.getRouterState(MARKER);
    expect(marker).toBeDefined();

    plantOrphan('skipped-orphan');
    // A recent clean check on the same schema: the scan (and its orphan
    // repair) is skipped.
    expect(orphanCount()).toBe(1);
    expect(db.getRouterState(MARKER)).toBe(marker);
  });

  test('scans again once the clean result is a week old', () => {
    db.setRouterState(
      MARKER,
      new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
    );
    reopen();
    expect(orphanCount()).toBe(0);
    expect(
      Date.now() - Date.parse(db.getRouterState(MARKER) ?? ''),
    ).toBeLessThan(60_000);
  });

  test('scans after a schema change and when no clean result is recorded', () => {
    plantOrphan('after-schema-change');
    db.closeDatabase();
    const raw = new Database(databasePath);
    raw
      .prepare(
        "UPDATE router_state SET value = '75' WHERE key = 'schema_version'",
      )
      .run();
    raw.close();
    process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
    try {
      db.initDatabase();
    } finally {
      delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
    }
    expect(orphanCount()).toBe(0);

    plantOrphan('without-marker');
    db.deleteRouterState(MARKER);
    reopen();
    expect(orphanCount()).toBe(0);
  });
});
