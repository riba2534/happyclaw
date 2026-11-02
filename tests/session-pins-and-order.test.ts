/**
 * A user's pinned sessions and the shared list order: pinned first, then by
 * latest activity. Pins go away with the session or the whole workspace.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import {
  compareSessionsForList,
  sessionActivityAt,
  sortSessionsForList,
} from '../shared/session-order.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'session-pins-'));
fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'groups'), { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: tmp,
  STORE_DIR: path.join(tmp, 'db'),
  GROUPS_DIR: path.join(tmp, 'groups'),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');

const now = new Date().toISOString();

function seedWorkspace(jid: string, folder: string): void {
  db.setRegisteredGroup(jid, {
    name: folder,
    folder,
    added_at: now,
    executionMode: 'container',
    is_home: false,
  } as any);
}

function seedSession(chatJid: string, folder: string, id: string): void {
  db.createAgent({
    id,
    group_folder: folder,
    chat_jid: chatJid,
    name: id,
    prompt: '',
    status: 'idle',
    kind: 'conversation',
    created_by: null,
    created_at: now,
    completed_at: null,
    result_summary: null,
    last_im_jid: null,
    spawned_from_jid: null,
  });
}

beforeAll(() => {
  db.initDatabase();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('session pins', () => {
  test('are per user and can be removed', () => {
    seedWorkspace('web:pins', 'pins');
    seedSession('web:pins', 'pins', 'pin-a');
    seedSession('web:pins', 'pins', 'pin-b');

    const pinnedAt = db.pinSession('user-1', 'pin-a');
    db.pinSession('user-2', 'pin-b');

    expect(db.getUserPinnedSessions('user-1')).toEqual({ 'pin-a': pinnedAt });
    expect(Object.keys(db.getUserPinnedSessions('user-2'))).toEqual(['pin-b']);

    db.unpinSession('user-1', 'pin-a');
    expect(db.getUserPinnedSessions('user-1')).toEqual({});
  });

  test('go away when the session is deleted', () => {
    seedWorkspace('web:pin-del', 'pin-del');
    seedSession('web:pin-del', 'pin-del', 'pin-del-a');
    db.pinSession('user-1', 'pin-del-a');

    db.deleteAgent('pin-del-a');

    expect(db.getUserPinnedSessions('user-1')['pin-del-a']).toBeUndefined();
  });

  test('go away when the workspace is deleted', () => {
    seedWorkspace('web:pin-ws', 'pin-ws');
    seedSession('web:pin-ws', 'pin-ws', 'pin-ws-a');
    db.pinSession('user-3', 'pin-ws-a');

    db.deleteGroupData('web:pin-ws', 'pin-ws');

    expect(db.getUserPinnedSessions('user-3')).toEqual({});
  });
});

describe('session list order', () => {
  const at = (minutes: number) =>
    new Date(Date.UTC(2026, 10, 1, 0, minutes)).toISOString();

  test('pinned first, then newest activity first, ties by id', () => {
    const sessions = [
      { id: 'old', created_at: at(0), last_active_at: at(1) },
      { id: 'new', created_at: at(0), last_active_at: at(30) },
      { id: 'pinned-old', created_at: at(0), pinned_at: at(40) },
      { id: 'tie-b', created_at: at(10) },
      { id: 'tie-a', created_at: at(10) },
    ];

    expect(sortSessionsForList(sessions).map((s) => s.id)).toEqual([
      'pinned-old',
      'new',
      'tie-a',
      'tie-b',
      'old',
    ]);
  });

  test('activity falls back to creation; unparsable times sort last', () => {
    expect(sessionActivityAt({ created_at: at(5) })).toBe(at(5));
    expect(
      compareSessionsForList(
        { id: 'a', created_at: 'not a date' },
        { id: 'b', created_at: at(5) },
      ),
    ).toBeGreaterThan(0);
  });
});
