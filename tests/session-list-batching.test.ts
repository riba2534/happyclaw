import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-list-batching-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
const dataDir = path.join(root, 'data');

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
  DATA_DIR: dataDir,
}));

const db = await import('../src/db.js');
const Database = (await import('better-sqlite3')).default;

const chats = ['web:alpha', 'web:beta', 'web:gamma', 'web:empty'];
const longReply =
  '第一行预览😀 ' + 'lorem ipsum dolor sit amet '.repeat(40) + 'tail';

beforeAll(() => {
  for (const dir of [storeDir, groupsDir, dataDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  db.initDatabase();
  for (const jid of chats) db.ensureChatExists(jid);
  // alpha: plain history, newest wins.
  db.storeMessageDirect(
    'a1',
    'web:alpha',
    'u',
    'U',
    'old',
    '2026-01-01T00:00:00.000Z',
    false,
  );
  db.storeMessageDirect(
    'a2',
    'web:alpha',
    'u',
    'U',
    longReply,
    '2026-01-02T00:00:00.000Z',
    true,
  );
  // beta: identical timestamps; the largest id must win, not insertion order.
  db.storeMessageDirect(
    'b-zzz',
    'web:beta',
    'u',
    'U',
    'zzz wins',
    '2026-01-03T00:00:00.000Z',
    false,
  );
  db.storeMessageDirect(
    'b-aaa',
    'web:beta',
    'u',
    'U',
    'aaa loses',
    '2026-01-03T00:00:00.000Z',
    false,
  );
  // gamma: out-of-order insertion; timestamp decides.
  db.storeMessageDirect(
    'g2',
    'web:gamma',
    'u',
    'U',
    'newer',
    '2026-01-05T00:00:00.000Z',
    false,
  );
  db.storeMessageDirect(
    'g1',
    'web:gamma',
    'u',
    'U',
    'older',
    '2026-01-04T00:00:00.000Z',
    false,
  );
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

/** The pre-optimization window query, kept as the behavioral reference. */
function referencePreview(jids: string[]) {
  const conn = new Database(path.join(storeDir, 'messages.db'), {
    readonly: true,
  });
  try {
    const placeholders = jids.map(() => '?').join(',');
    const rows = conn
      .prepare(
        `SELECT chat_jid, content, timestamp FROM (
           SELECT chat_jid, content, timestamp,
                  ROW_NUMBER() OVER (
                    PARTITION BY chat_jid ORDER BY timestamp DESC, id DESC
                  ) AS rn
           FROM messages WHERE chat_jid IN (${placeholders})
         ) WHERE rn = 1`,
      )
      .all(...jids) as Array<{
      chat_jid: string;
      content: string;
      timestamp: string;
    }>;
    return new Map(rows.map((r) => [r.chat_jid, r]));
  } finally {
    conn.close();
  }
}

describe('getLatestMessagePreviewPerChat', () => {
  test('picks the same latest row as the window query, truncated to the preview length', () => {
    const preview = db.getLatestMessagePreviewPerChat(chats);
    const reference = referencePreview(chats);
    expect([...preview.keys()].sort()).toEqual([...reference.keys()].sort());
    for (const [jid, row] of reference) {
      expect(preview.get(jid)).toEqual({
        content: Array.from(row.content)
          .slice(0, db.MESSAGE_PREVIEW_MAX_CHARS)
          .join(''),
        timestamp: row.timestamp,
      });
    }
    expect(preview.get('web:beta')?.content).toBe('zzz wins');
    expect(preview.get('web:gamma')?.content).toBe('newer');
    expect(preview.has('web:empty')).toBe(false);
  });

  test('cuts on code points, so multi-byte text and emoji stay intact', () => {
    const preview = db.getLatestMessagePreviewPerChat(['web:alpha'], 8);
    expect(preview.get('web:alpha')?.content).toBe('第一行预览😀 l');
    const full = db.getLatestMessagePreviewPerChat(['web:alpha'], 100_000);
    expect(full.get('web:alpha')?.content).toBe(longReply);
  });

  test('handles duplicates and empty input', () => {
    expect(db.getLatestMessagePreviewPerChat([]).size).toBe(0);
    expect(
      db
        .getLatestMessagePreviewPerChat(['web:gamma', 'web:gamma'])
        .get('web:gamma')?.content,
    ).toBe('newer');
  });
});

describe('batched session-list lookups', () => {
  beforeAll(() => {
    const now = '2026-01-10T00:00:00.000Z';
    const base = {
      channel_type: 'feishu',
      workspace_jid: 'web:alpha',
      routing_mode: 'session',
      reply_policy: 'source_only',
      activation_mode: 'auto',
      audience_mode: 'everyone',
    } as const;
    db.upsertChannelMount({
      ...base,
      channel_jid: 'feishu:oc_1',
      session_id: 's1',
      created_at: now,
      updated_at: '2026-01-10T00:00:01.000Z',
    } as any);
    db.upsertChannelMount({
      ...base,
      channel_jid: 'feishu:oc_2',
      session_id: 's1',
      created_at: now,
      updated_at: '2026-01-10T00:00:02.000Z',
    } as any);
    db.upsertChannelMount({
      ...base,
      channel_jid: 'feishu:oc_3',
      session_id: 's2',
      created_at: now,
      updated_at: now,
    } as any);
    for (const [jid, target] of [
      ['feishu:oc_1', 's1'],
      ['feishu:oc_4', 's1'],
      ['feishu:oc_5', 's3'],
    ] as const) {
      db.setRegisteredGroup(jid, {
        name: `group ${jid}`,
        folder: 'alpha',
        added_at: now,
        target_agent_id: target,
      } as any);
    }
  });

  test('mount batches equal the per-session lookups', () => {
    const ids = ['s1', 's2', 's-missing'];
    const batched = db.listChannelMountsBySessions(ids);
    for (const id of ids) {
      expect(batched.get(id) ?? []).toEqual(db.listChannelMountsBySession(id));
    }
    expect(db.listChannelMountsBySessions([]).size).toBe(0);
  });

  test('target-agent batches equal the per-agent lookups', () => {
    const ids = ['s1', 's3', 's-missing'];
    const batched = db.getGroupsByTargetAgents(ids);
    for (const id of ids) {
      expect(batched.get(id) ?? []).toEqual(db.getGroupsByTargetAgent(id));
    }
  });

  test('group names resolve in one query and skip unknown jids', () => {
    const names = db.getRegisteredGroupNames(['feishu:oc_1', 'feishu:nope']);
    expect(names.get('feishu:oc_1')).toBe('group feishu:oc_1');
    expect(names.has('feishu:nope')).toBe(false);
  });
});
