import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'messages-since-bounded-'));
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
const chat = 'web:backlog';
const EMPTY = { timestamp: '', id: '' };

beforeAll(() => {
  for (const dir of [storeDir, groupsDir, dataDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  db.initDatabase();
  db.ensureChatExists(chat);
  for (let i = 0; i < 25; i += 1) {
    const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    db.storeMessageDirect(`in-${i}`, chat, 'u', 'U', `input ${i}`, ts, false);
    // Assistant rows and queued follow-ups are never turn inputs.
    db.storeMessageDirect(
      `out-${i}`,
      chat,
      'bot',
      'Bot',
      `reply ${i}`,
      ts,
      true,
    );
  }
  db.storeMessageDirect(
    'queued',
    chat,
    'u',
    'U',
    'queued',
    '2026-01-02T00:00:00.000Z',
    false,
    {
      meta: { deliveryStatus: 'queued' } as any,
    },
  );
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('getMessagesSinceBounded', () => {
  test('returns the oldest inputs of the unbounded read and flags the rest', () => {
    const all = db.getMessagesSince(chat, EMPTY);
    expect(all).toHaveLength(25);
    const window = db.getMessagesSinceBounded(chat, EMPTY, 10);
    expect(window.truncated).toBe(true);
    expect(window.messages).toEqual(all.slice(0, 10));

    const next = db.getMessagesSinceBounded(
      chat,
      {
        timestamp: window.messages[9].timestamp,
        id: window.messages[9].id,
        sequence: window.messages[9].ingest_sequence,
      },
      10,
    );
    expect(next.messages).toEqual(all.slice(10, 20));
    expect(next.truncated).toBe(true);
  });

  test('is not truncated when the backlog fits exactly', () => {
    const exact = db.getMessagesSinceBounded(chat, EMPTY, 25);
    expect(exact.truncated).toBe(false);
    expect(exact.messages).toEqual(db.getMessagesSince(chat, EMPTY));
    expect(db.MAX_TURN_INPUT_MESSAGES).toBeGreaterThanOrEqual(250);
  });
});
