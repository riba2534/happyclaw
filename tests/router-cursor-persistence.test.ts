import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import { RouterCursorPersistence } from '../src/router-cursor-persistence.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'router-cursors-'));
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
const { logger } = await import('../src/logger.js');

const nextPullBlob = {
  'web:a': { timestamp: '2026-01-01T00:00:00.000Z', id: 'm1', sequence: 4 },
  'web:legacy': '2025-12-31T00:00:00.000Z',
};
const committedBlob = {
  'web:a': { timestamp: '2026-01-01T00:00:00.000Z', id: 'm0', sequence: 3 },
};

beforeAll(() => {
  process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
  try {
    db.initDatabase();
  } finally {
    delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
  }
  db.closeDatabase();
  // Rewind to the v75 layout: cursors as whole-map blobs in router_state.
  const legacy = new Database(databasePath);
  legacy.exec('DROP TABLE router_cursors');
  const set = legacy.prepare(
    'INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)',
  );
  set.run('schema_version', '75');
  set.run('last_agent_timestamp', JSON.stringify(nextPullBlob));
  set.run('last_committed_cursor', JSON.stringify(committedBlob));
  set.run('last_timestamp', '2026-01-01T00:00:00.000Z');
  legacy.close();
  process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP = '1';
  try {
    db.initDatabase();
  } finally {
    delete process.env.HAPPYCLAW_SKIP_MIGRATION_BACKUP;
  }
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('router cursor migration', () => {
  test('moves both blobs into rows and removes the blob keys', () => {
    const rows = db
      .getRouterCursorRows()
      .sort((a, b) =>
        `${a.kind}${a.chat_jid}`.localeCompare(`${b.kind}${b.chat_jid}`),
      );
    expect(rows).toEqual([
      {
        kind: 'committed',
        chat_jid: 'web:a',
        cursor: JSON.stringify(committedBlob['web:a']),
      },
      {
        kind: 'next_pull',
        chat_jid: 'web:a',
        cursor: JSON.stringify(nextPullBlob['web:a']),
      },
      {
        kind: 'next_pull',
        chat_jid: 'web:legacy',
        cursor: JSON.stringify(nextPullBlob['web:legacy']),
      },
    ]);
    expect(db.getRouterState('last_agent_timestamp')).toBeUndefined();
    expect(db.getRouterState('last_committed_cursor')).toBeUndefined();
    expect(db.getRouterState('last_timestamp')).toBe(
      '2026-01-01T00:00:00.000Z',
    );
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
  });

  test('persists state keys and cursor upserts/deletes atomically', () => {
    db.persistRouterState({
      state: [['last_timestamp', '2026-02-01T00:00:00.000Z']],
      cursors: [
        {
          kind: 'next_pull',
          chatJid: 'web:a',
          cursor: '{"timestamp":"x","id":"y","sequence":9}',
        },
        { kind: 'next_pull', chatJid: 'web:legacy', cursor: null },
        {
          kind: 'committed',
          chatJid: 'web:new',
          cursor: '{"timestamp":"t","id":"i","sequence":1}',
        },
      ],
    });
    const rows = new Map(
      db
        .getRouterCursorRows()
        .map((row) => [`${row.kind}:${row.chat_jid}`, row.cursor]),
    );
    expect(rows.get('next_pull:web:a')).toBe(
      '{"timestamp":"x","id":"y","sequence":9}',
    );
    expect(rows.has('next_pull:web:legacy')).toBe(false);
    expect(rows.get('committed:web:new')).toBe(
      '{"timestamp":"t","id":"i","sequence":1}',
    );
    expect(db.getRouterState('last_timestamp')).toBe(
      '2026-02-01T00:00:00.000Z',
    );

    // A failing statement rolls the whole batch back.
    expect(() =>
      db.persistRouterState({
        state: [['last_timestamp', 'rolled-back']],
        cursors: [{ kind: 'bogus' as any, chatJid: 'web:a', cursor: '{}' }],
      }),
    ).toThrow();
    expect(db.getRouterState('last_timestamp')).toBe(
      '2026-02-01T00:00:00.000Z',
    );
  });
});

describe('router cursor blobs after v76', () => {
  test('a stray blob key is dropped without overwriting cursor rows', () => {
    db.persistRouterState({
      state: [],
      cursors: [
        {
          kind: 'next_pull',
          chatJid: 'web:a',
          cursor: '{"timestamp":"new","id":"m9","sequence":9}',
        },
      ],
    });
    const before = db.getRouterCursorRows();
    db.closeDatabase();
    const raw = new Database(databasePath);
    raw
      .prepare('INSERT OR REPLACE INTO router_state (key, value) VALUES (?, ?)')
      .run(
        'last_agent_timestamp',
        JSON.stringify({
          'web:a': { timestamp: 'old', id: 'm1', sequence: 1 },
          'web:stale-only': { timestamp: 'old', id: 'm1', sequence: 1 },
        }),
      );
    raw.close();
    vi.mocked(logger.warn).mockClear();
    db.initDatabase();

    expect(db.getRouterCursorRows()).toEqual(before);
    expect(db.getRouterState('last_agent_timestamp')).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      { key: 'last_agent_timestamp' },
      expect.stringContaining('dropped without touching router_cursors'),
    );
  });
});

describe('RouterCursorPersistence', () => {
  const normalize = (value: unknown) =>
    typeof value === 'string'
      ? { timestamp: value, id: '', sequence: 0 }
      : (value as { timestamp: string; id: string; sequence: number });

  test('loads rows and marks only upgraded or corrupt entries dirty', () => {
    const tracker = new RouterCursorPersistence();
    const maps = tracker.load(
      [
        {
          kind: 'next_pull',
          chat_jid: 'a',
          cursor: '{"timestamp":"t","id":"m","sequence":2}',
        },
        { kind: 'next_pull', chat_jid: 'legacy', cursor: '"2025-01-01"' },
        {
          kind: 'committed',
          chat_jid: 'a',
          cursor: '{"timestamp":"t","id":"m","sequence":1}',
        },
        { kind: 'committed', chat_jid: 'broken', cursor: '{not json' },
      ],
      normalize,
    );
    expect(maps.nextPull).toEqual({
      a: { timestamp: 't', id: 'm', sequence: 2 },
      legacy: { timestamp: '2025-01-01', id: '', sequence: 0 },
    });
    expect(maps.committed).toEqual({
      a: { timestamp: 't', id: 'm', sequence: 1 },
    });
    expect(tracker.collectChanges(maps)).toEqual([
      {
        kind: 'next_pull',
        chatJid: 'legacy',
        cursor: '{"timestamp":"2025-01-01","id":"","sequence":0}',
      },
      { kind: 'committed', chatJid: 'broken', cursor: null },
    ]);
  });

  test('collects current values, deletes for removed entries, and forgets acknowledged ones', () => {
    const tracker = new RouterCursorPersistence();
    const maps = {
      nextPull: { a: { timestamp: 't1', id: 'x', sequence: 5 } },
      committed: {} as Record<
        string,
        { timestamp: string; id: string; sequence: number }
      >,
    };
    tracker.markDirty('next_pull', 'a');
    tracker.markDirty('next_pull', 'a');
    tracker.markDirty('committed', 'gone');
    const changes = tracker.collectChanges(maps);
    expect(changes).toEqual([
      {
        kind: 'next_pull',
        chatJid: 'a',
        cursor: '{"timestamp":"t1","id":"x","sequence":5}',
      },
      { kind: 'committed', chatJid: 'gone', cursor: null },
    ]);
    // A write that fails is not acknowledged and is retried next time.
    expect(tracker.collectChanges(maps)).toHaveLength(2);
    tracker.acknowledge(changes);
    expect(tracker.pendingCount).toBe(0);
    expect(tracker.collectChanges(maps)).toEqual([]);
  });

  test('does not confuse jids containing the separator-free prefix of another kind', () => {
    const tracker = new RouterCursorPersistence();
    tracker.markDirty('committed', 'web:x#agent:next_pull');
    expect(
      tracker.collectChanges({
        nextPull: {},
        committed: { 'web:x#agent:next_pull': { timestamp: 't', id: 'i' } },
      }),
    ).toEqual([
      {
        kind: 'committed',
        chatJid: 'web:x#agent:next_pull',
        cursor: '{"timestamp":"t","id":"i"}',
      },
    ]);
  });
});
