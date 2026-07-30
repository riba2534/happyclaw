import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate DB to a temp dir — mock config.js before importing db.js so STORE_DIR
// points at a fresh directory owned by this test run.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-meta-test-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../src/config.js', async () => {
  // Keep any other unused exports benign; db.ts only reads STORE_DIR + GROUPS_DIR.
  return {
    STORE_DIR: tmpStoreDir,
    GROUPS_DIR: tmpGroupsDir,
  };
});

// Dynamic import AFTER the mock so db.ts picks up the mocked STORE_DIR.
const {
  initDatabase,
  ensureChatExists,
  storeMessageDirect,
  getMessagesSince,
  getNewMessages,
} = await import('../src/db.js');

beforeAll(() => {
  initDatabase();
});

afterAll(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const EMPTY_CURSOR = { timestamp: '', id: '' };

describe('storeMessageDirect + task_id propagation', () => {
  test('scenario A: meta.taskId is persisted and returned by getMessagesSince', () => {
    const chatJid = 'web:task-meta-A';
    ensureChatExists(chatJid);
    storeMessageDirect(
      'm-A-1',
      chatJid,
      'system',
      'scheduler',
      'prompt for task t1',
      '2026-04-17T00:00:00.000Z',
      false,
      { meta: { sourceKind: 'scheduled_task_prompt', taskId: 't1' } },
    );

    const rows = getMessagesSince(chatJid, EMPTY_CURSOR);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('m-A-1');
    expect(rows[0].source_kind).toBe('scheduled_task_prompt');
    expect(rows[0].task_id).toBe('t1');
  });

  test('scenario B: meta without taskId leaves task_id null', () => {
    const chatJid = 'web:task-meta-B';
    ensureChatExists(chatJid);
    storeMessageDirect(
      'm-B-1',
      chatJid,
      'user-1',
      'Alice',
      'regular message, no task',
      '2026-04-17T00:00:01.000Z',
      false,
      { meta: { sourceKind: 'legacy' } },
    );
    // Also store a message with no meta at all to confirm the default is null.
    storeMessageDirect(
      'm-B-2',
      chatJid,
      'user-1',
      'Alice',
      'another plain message',
      '2026-04-17T00:00:02.000Z',
      false,
    );

    const rows = getMessagesSince(chatJid, EMPTY_CURSOR);
    expect(rows).toHaveLength(2);
    // sqlite returns NULL → better-sqlite3 surfaces it as `null`; assert null-ish.
    for (const r of rows) {
      expect(r.task_id == null).toBe(true); // matches null or undefined
    }
  });

  test('scenario C: getNewMessages returns task_id column on surfaced rows', () => {
    // getNewMessages filters out 'scheduled_task_prompt' + 'user_command' rows,
    // but the SELECT still projects task_id so any non-prompt row that carries
    // task_id (e.g. a future migration) is available to the caller.
    const chatJid = 'web:task-meta-C';
    ensureChatExists(chatJid);
    // A regular IM message (legacy source_kind) carrying a taskId — not filtered.
    storeMessageDirect(
      'm-C-1',
      chatJid,
      'user-2',
      'Carol',
      'message tagged with task id',
      '2026-04-17T00:00:03.000Z',
      false,
      { meta: { sourceKind: 'legacy', taskId: 't2' } },
    );
    // A scheduled_task_prompt row — should be filtered out by getNewMessages.
    storeMessageDirect(
      'm-C-2',
      chatJid,
      'system',
      'scheduler',
      'prompt for task t2',
      '2026-04-17T00:00:04.000Z',
      false,
      { meta: { sourceKind: 'scheduled_task_prompt', taskId: 't2' } },
    );

    const { messages } = getNewMessages([chatJid], EMPTY_CURSOR);
    const ids = messages.map((m) => m.id);
    expect(ids).toContain('m-C-1');
    expect(ids).not.toContain('m-C-2'); // scheduled_task_prompt is filtered
    const surfaced = messages.find((m) => m.id === 'm-C-1');
    expect(surfaced!.source_kind).toBe('legacy');
    expect(surfaced!.task_id).toBe('t2');
  });

  test('scenario D: mixed rows — task_id is per-message, not sticky', () => {
    const chatJid = 'web:task-meta-D';
    ensureChatExists(chatJid);
    storeMessageDirect(
      'm-D-1',
      chatJid,
      'system',
      'scheduler',
      'task prompt',
      '2026-04-17T00:00:10.000Z',
      false,
      { meta: { sourceKind: 'scheduled_task_prompt', taskId: 't3' } },
    );
    storeMessageDirect(
      'm-D-2',
      chatJid,
      'user-9',
      'Bob',
      'follow-up regular message',
      '2026-04-17T00:00:11.000Z',
      false,
    );
    storeMessageDirect(
      'm-D-3',
      chatJid,
      'system',
      'scheduler',
      'another task prompt',
      '2026-04-17T00:00:12.000Z',
      false,
      { meta: { sourceKind: 'scheduled_task_prompt', taskId: 't4' } },
    );

    const rows = getMessagesSince(chatJid, EMPTY_CURSOR);
    const byId = new Map(rows.map((r) => [r.id, r.task_id]));
    expect(byId.get('m-D-1')).toBe('t3');
    expect(byId.get('m-D-2') == null).toBe(true);
    expect(byId.get('m-D-3')).toBe('t4');
  });
});
