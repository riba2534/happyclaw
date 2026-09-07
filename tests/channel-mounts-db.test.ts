import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-mounts-test-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/config.js')>();
  return {
    ...actual,
    DATA_DIR: tmpDir,
    STORE_DIR: tmpStoreDir,
    GROUPS_DIR: tmpGroupsDir,
  };
});

const dbPath = path.join(tmpStoreDir, 'messages.db');
const seedDb = new Database(dbPath);
seedDb.pragma('foreign_keys = OFF');
seedDb.exec(`
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT 'member',
    status TEXT NOT NULL DEFAULT 'active',
    permissions TEXT NOT NULL DEFAULT '[]',
    must_change_password INTEGER NOT NULL DEFAULT 0,
    disable_reason TEXT,
    notes TEXT,
    avatar_emoji TEXT,
    avatar_color TEXT,
    avatar_url TEXT,
    ai_name TEXT,
    ai_avatar_emoji TEXT,
    ai_avatar_color TEXT,
    ai_avatar_url TEXT,
    default_require_mention INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_login_at TEXT,
    deleted_at TEXT
  );
  CREATE TABLE user_balances (
    user_id TEXT PRIMARY KEY,
    balance_usd REAL NOT NULL DEFAULT 0,
    total_deposited_usd REAL NOT NULL DEFAULT 0,
    total_consumed_usd REAL NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);
seedDb
  .prepare(
    'INSERT INTO user_balances (user_id, balance_usd, total_deposited_usd, total_consumed_usd, updated_at) VALUES (?, 1, 1, 0, ?)',
  )
  .run('deleted-user', new Date().toISOString());
seedDb.close();

const {
  initDatabase,
  setRegisteredGroup,
  getRegisteredGroup,
  updateRegisteredGroupAvatar,
  deleteRegisteredGroup,
  createAgent,
  getChannelMount,
  listChannelMountsByWorkspace,
  listChannelMountsBySession,
} = await import('../src/db.js');

let probeDb: InstanceType<typeof Database>;

beforeAll(() => {
  initDatabase();
  probeDb = new Database(dbPath, { readonly: true });
});

afterAll(() => {
  probeDb?.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('channel_mounts compatibility model', () => {
  test('provider chat avatars persist across ordinary group updates', () => {
    const jid = 'feishu:avatar-cache';
    const now = new Date().toISOString();
    setRegisteredGroup(jid, {
      name: 'Avatar group',
      folder: 'avatar-cache',
      added_at: now,
      created_by: 'owner-a',
    });

    expect(
      updateRegisteredGroupAvatar(jid, ' https://example.com/group.png '),
    ).toBe(true);
    expect(getRegisteredGroup(jid)?.avatar_url).toBe(
      'https://example.com/group.png',
    );

    // Binding/name updates often omit provider presentation metadata. They
    // must not erase the last successfully synchronized avatar.
    setRegisteredGroup(jid, {
      name: 'Renamed avatar group',
      folder: 'avatar-cache',
      added_at: now,
      created_by: 'owner-a',
      target_main_jid: 'web:missing-is-fine-for-legacy-compat',
    });
    expect(getRegisteredGroup(jid)?.avatar_url).toBe(
      'https://example.com/group.png',
    );
  });

  test('updating a registered group preserves its SQLite row identity', () => {
    const jid = 'telegram:stable-row';
    const now = new Date().toISOString();
    setRegisteredGroup(jid, {
      name: 'Before',
      folder: 'stable-row',
      added_at: now,
      created_by: 'owner-a',
    });
    const before = probeDb
      .prepare('SELECT rowid FROM registered_groups WHERE jid = ?')
      .get(jid) as { rowid: number };

    setRegisteredGroup(jid, {
      name: 'After',
      folder: 'stable-row',
      added_at: now,
      created_by: 'owner-a',
    });
    const after = probeDb
      .prepare('SELECT rowid, name FROM registered_groups WHERE jid = ?')
      .get(jid) as { rowid: number; name: string };

    expect(after).toEqual({ rowid: before.rowid, name: 'After' });
  });

  test('startup preserves orphaned user balances for operator review', () => {
    const row = probeDb
      .prepare('SELECT COUNT(*) as cnt FROM user_balances WHERE user_id = ?')
      .get('deleted-user') as { cnt: number };
    expect(row.cnt).toBe(1);

    const violations = probeDb
      .prepare('PRAGMA foreign_key_check')
      .all() as Array<{
      table: string;
      parent: string;
    }>;
    expect(violations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: 'user_balances',
          parent: 'users',
        }),
      ]),
    );
  });

  test('session binding written to registered_groups is mirrored to channel_mounts', () => {
    const now = new Date().toISOString();
    setRegisteredGroup('web:workspace-a', {
      name: 'Workspace A',
      folder: 'workspace-a',
      added_at: now,
      created_by: 'owner-a',
    });
    createAgent({
      id: 'session-a',
      group_folder: 'workspace-a',
      chat_jid: 'web:workspace-a',
      name: 'Review Session',
      prompt: '',
      status: 'idle',
      kind: 'conversation',
      created_by: 'owner-a',
      created_at: now,
      completed_at: null,
      result_summary: null,
      last_im_jid: null,
      spawned_from_jid: null,
    });

    setRegisteredGroup('telegram:chat-a', {
      name: 'Telegram Chat',
      folder: 'home-owner-a',
      added_at: now,
      target_agent_id: 'session-a',
      reply_policy: 'mirror',
      activation_mode: 'when_mentioned',
    });

    expect(getChannelMount('telegram:chat-a')).toMatchObject({
      channel_jid: 'telegram:chat-a',
      channel_type: 'telegram',
      workspace_jid: 'web:workspace-a',
      session_id: 'session-a',
      routing_mode: 'single_session',
      reply_policy: 'mirror',
      activation_mode: 'when_mentioned',
    });
    expect(listChannelMountsBySession('session-a')).toHaveLength(1);
    expect(listChannelMountsByWorkspace('web:workspace-a')).toHaveLength(1);
  });

  test('workspace thread-map binding and unbind update channel_mounts', () => {
    const now = new Date().toISOString();
    setRegisteredGroup('web:workspace-b', {
      name: 'Workspace B',
      folder: 'workspace-b',
      added_at: now,
      created_by: 'owner-b',
    });
    setRegisteredGroup('feishu:topic-b', {
      name: 'Feishu Topic',
      folder: 'home-owner-b',
      added_at: now,
      target_main_jid: 'web:workspace-b',
      binding_mode: 'thread_map',
      reply_policy: 'source_only',
      audience_mode: 'owner_only',
      owner_im_id: 'ou_owner_b',
    });

    expect(getChannelMount('feishu:topic-b')).toMatchObject({
      channel_type: 'feishu',
      workspace_jid: 'web:workspace-b',
      session_id: null,
      routing_mode: 'thread_map',
      audience_mode: 'owner_only',
      owner_im_id: 'ou_owner_b',
    });

    setRegisteredGroup('feishu:topic-b', {
      name: 'Feishu Topic',
      folder: 'home-owner-b',
      added_at: now,
    });
    expect(getChannelMount('feishu:topic-b')).toBeUndefined();
  });

  test('deleting an IM registered group removes its channel mount', () => {
    const now = new Date().toISOString();
    setRegisteredGroup('web:workspace-c', {
      name: 'Workspace C',
      folder: 'workspace-c',
      added_at: now,
    });
    setRegisteredGroup('qq:chat-c', {
      name: 'QQ Chat',
      folder: 'home-owner-c',
      added_at: now,
      target_main_jid: 'web:workspace-c',
    });

    expect(getChannelMount('qq:chat-c')).toBeTruthy();
    deleteRegisteredGroup('qq:chat-c');
    expect(getChannelMount('qq:chat-c')).toBeUndefined();
  });
});
