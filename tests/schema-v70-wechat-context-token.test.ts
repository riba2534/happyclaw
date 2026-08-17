import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v70-wechat-token-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
const dataDir = path.join(root, 'data');
const databasePath = path.join(storeDir, 'messages.db');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });

vi.mock('../src/config.js', () => ({
  ASSISTANT_NAME: 'HappyClaw Test',
  DATA_DIR: dataDir,
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe.sequential('schema v71 WeChat context_token generations', () => {
  test('migrates a production v70 row, classifies replays, and still upgrades v69', () => {
    // Build a realistic v70 production database and preserve an already-used
    // quota row while recreating the table in its exact pre-v71 shape.
    db.initDatabase();
    const account = db.createChannelAccount({
      id: 'wechat-account',
      owner_user_id: 'owner',
      provider: 'wechat',
      name: 'WeChat',
      secret_ref: 'channel-account:wechat-account',
    });
    db.closeDatabase();
    const legacy = new Database(databasePath);
    legacy.exec(`
      DROP TABLE wechat_context_tokens;
      CREATE TABLE wechat_context_tokens (
        channel_account_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        context_token TEXT NOT NULL,
        refreshed_at_ms INTEGER NOT NULL,
        send_count INTEGER NOT NULL DEFAULT 0,
        last_sent_at_ms INTEGER,
        PRIMARY KEY (channel_account_id, user_id),
        FOREIGN KEY (channel_account_id) REFERENCES channel_accounts(id) ON DELETE CASCADE
      );
      INSERT INTO wechat_context_tokens VALUES (
        'wechat-account', 'peer', 'legacy-token', 1000, 9, 1500
      );
      UPDATE router_state SET value = '70' WHERE key = 'schema_version';
    `);
    legacy.close();

    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
    expect(db.listWeChatContextTokens(account.id)[0]).toMatchObject({
      context_token: 'legacy-token',
      send_count: 9,
      source_message_id: null,
      source_sequence: null,
    });

    // For a migrated row, equal time + equal token is the only replay signal
    // available. Preserve its quota and do not establish a guessed identity.
    db.upsertWeChatContextToken({
      channelAccountId: account.id,
      userId: 'peer',
      contextToken: 'legacy-token',
      refreshedAtMs: 1_000,
      sourceMessageId: 'message-1',
      sourceSequence: 1,
    });
    expect(db.listWeChatContextTokens(account.id)[0]).toMatchObject({
      context_token: 'legacy-token',
      send_count: 9,
      source_message_id: null,
    });

    // Equal time + a different per-message token is a new generation at the
    // v70 upgrade boundary and must replace the old credential.
    db.upsertWeChatContextToken({
      channelAccountId: account.id,
      userId: 'peer',
      contextToken: 'sensitive-token',
      refreshedAtMs: 1_000,
      sourceMessageId: 'message-2',
      sourceSequence: 2,
    });

    expect(
      db.claimWeChatContextToken({
        channelAccountId: account.id,
        userId: 'peer',
        expectedToken: 'sensitive-token',
        expectedRefreshedAtMs: 1_000,
        expectedSourceMessageId: 'message-2',
        claimCount: 10,
        maxSendCount: 10,
        maxAgeMs: 100_000,
        nowMs: 2_000,
      }),
    ).toMatchObject({ status: 'claimed', record: { send_count: 10 } });
    expect(
      db.claimWeChatContextToken({
        channelAccountId: account.id,
        userId: 'peer',
        expectedToken: 'sensitive-token',
        expectedRefreshedAtMs: 1_000,
        expectedSourceMessageId: 'message-2',
        claimCount: 1,
        maxSendCount: 10,
        maxAgeMs: 100_000,
        nowMs: 2_001,
      }),
    ).toEqual({ status: 'quota_exhausted' });

    // Replaying the same inbound batch after a cursor-persistence crash must
    // not reset quota and permit more than ten downstream calls.
    db.upsertWeChatContextToken({
      channelAccountId: account.id,
      userId: 'peer',
      contextToken: 'changed-on-exact-replay',
      refreshedAtMs: 1_000,
      sourceMessageId: 'message-2',
      sourceSequence: 2,
    });
    expect(db.listWeChatContextTokens(account.id)[0]).toMatchObject({
      context_token: 'sensitive-token',
      send_count: 10,
    });

    // A distinct message in the same millisecond is a new generation and
    // resets quota. Replaying the lower sequence afterward cannot roll it back.
    db.upsertWeChatContextToken({
      channelAccountId: account.id,
      userId: 'peer',
      contextToken: 'fresh-token',
      refreshedAtMs: 1_000,
      sourceMessageId: 'message-3',
      sourceSequence: 3,
    });
    expect(db.listWeChatContextTokens(account.id)[0]).toMatchObject({
      context_token: 'fresh-token',
      send_count: 0,
      source_message_id: 'message-3',
    });
    db.upsertWeChatContextToken({
      channelAccountId: account.id,
      userId: 'peer',
      contextToken: 'old-batch-replay',
      refreshedAtMs: 1_000,
      sourceMessageId: 'message-2',
      sourceSequence: 2,
    });
    expect(db.listWeChatContextTokens(account.id)[0]).toMatchObject({
      context_token: 'fresh-token',
      source_message_id: 'message-3',
    });

    db.closeDatabase();
    db.initDatabase();
    expect(db.listWeChatContextTokens(account.id)).toHaveLength(1);
    expect(db.deleteChannelAccount(account.id, 'owner')).toBe(true);
    expect(db.listWeChatContextTokens(account.id)).toEqual([]);

    // Older databases where v70 never created the table still take the normal
    // CREATE TABLE path and land directly on the v71 columns.
    db.closeDatabase();
    const v69 = new Database(databasePath);
    v69.exec(`
      DROP TABLE wechat_context_tokens;
      UPDATE router_state SET value = '69' WHERE key = 'schema_version';
    `);
    v69.close();
    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
    const probe = new Database(databasePath, { readonly: true });
    const columns = probe
      .prepare('PRAGMA table_info(wechat_context_tokens)')
      .all() as Array<{ name: string }>;
    probe.close();
    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(['source_message_id', 'source_sequence']),
    );
  });
});
