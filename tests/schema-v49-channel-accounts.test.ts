import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v49-channel-'));
const store = path.join(tmp, 'db');
const groups = path.join(tmp, 'groups');
fs.mkdirSync(store, { recursive: true });
fs.mkdirSync(groups, { recursive: true });

vi.mock('../src/config.js', () => ({ STORE_DIR: store, GROUPS_DIR: groups }));

beforeAll(() => {
  const legacy = new Database(path.join(store, 'messages.db'));
  legacy.exec(`
    CREATE TABLE router_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO router_state VALUES ('schema_version', '48');
    CREATE TABLE registered_groups (
      jid TEXT PRIMARY KEY, name TEXT NOT NULL, folder TEXT NOT NULL,
      added_at TEXT NOT NULL, container_config TEXT, created_by TEXT,
      is_home INTEGER DEFAULT 0, activation_mode TEXT, owner_im_id TEXT
    );
    INSERT INTO registered_groups (
      jid, name, folder, added_at, container_config, created_by, is_home
    ) VALUES (
      'telegram:legacy-chat', 'Legacy', 'legacy-folder',
      '2026-07-01T00:00:00.000Z', NULL, 'legacy-owner', 0
    );
    INSERT INTO registered_groups (
      jid, name, folder, added_at, container_config, created_by, is_home,
      activation_mode, owner_im_id
    ) VALUES (
      'feishu:legacy-owner-chat', 'Legacy owner chat', 'legacy-folder',
      '2026-07-01T00:00:00.000Z', NULL, 'legacy-owner', 0,
      'owner_mentioned', 'ou_owner'
    );
    CREATE TABLE channel_mounts (
      channel_jid TEXT PRIMARY KEY, channel_type TEXT NOT NULL,
      workspace_jid TEXT NOT NULL, session_id TEXT, routing_mode TEXT NOT NULL,
      reply_policy TEXT NOT NULL, activation_mode TEXT NOT NULL,
      owner_im_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE agent_channel_mounts (
      channel_jid TEXT PRIMARY KEY, agent_profile_id TEXT, owner_user_id TEXT,
      channel_type TEXT NOT NULL, workspace_jid TEXT NOT NULL,
      workspace_folder TEXT, session_id TEXT, routing_mode TEXT NOT NULL,
      reply_policy TEXT NOT NULL, activation_mode TEXT NOT NULL,
      owner_im_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);
  legacy.close();
});

afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('schema v50 channel account protocol lifecycle', () => {
  test('adds account metadata and account dimensions without rewriting legacy JIDs', async () => {
    const db = await import('../src/db.js');
    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
    expect(db.getRegisteredGroup('telegram:legacy-chat')).toMatchObject({
      channel_account_id: undefined,
      created_by: 'legacy-owner',
    });
    expect(db.getRegisteredGroup('feishu:legacy-owner-chat')).toMatchObject({
      activation_mode: 'when_mentioned',
      audience_mode: 'owner_only',
      owner_im_id: 'ou_owner',
      require_mention: true,
    });

    const account = db.createChannelAccount({
      id: 'account-v49',
      owner_user_id: 'legacy-owner',
      provider: 'telegram',
      name: 'Default bot',
      secret_ref: 'channel-account:account-v49',
    });
    expect(account).toMatchObject({
      is_default: true,
      auth_status: 'draft',
      transport_status: 'disconnected',
      status: 'disconnected',
    });

    db.setRegisteredGroup('telegram:chat#account:account-v49', {
      name: 'Scoped',
      folder: 'legacy-folder',
      added_at: '2026-07-01T00:00:00.000Z',
      created_by: 'legacy-owner',
      channel_account_id: 'account-v49',
    });
    expect(
      db.getRegisteredGroup('telegram:chat#account:account-v49'),
    ).toMatchObject({ channel_account_id: 'account-v49' });

    // A sender allowlist is an owner identity anchor, not a permanent audience
    // choice. Once the user explicitly selects "everyone", later startups
    // must not replay the v58 backfill and silently restore owner-only mode.
    db.setRegisteredGroup('feishu:restart-audience-chat', {
      name: 'Restart audience regression',
      folder: 'legacy-folder',
      added_at: '2026-07-01T00:00:00.000Z',
      created_by: 'legacy-owner',
      channel_account_id: 'account-v49',
      audience_mode: 'everyone',
      owner_im_id: 'ou_owner',
      sender_allowlist: ['ou_owner'],
    });
    expect(db.getRegisteredGroup('feishu:restart-audience-chat')).toMatchObject(
      { audience_mode: 'everyone' },
    );
    db.closeDatabase();

    db.initDatabase();
    expect(db.getRegisteredGroup('feishu:restart-audience-chat')).toMatchObject(
      { audience_mode: 'everyone' },
    );
    db.closeDatabase();

    const raw = new Database(path.join(store, 'messages.db'), {
      readonly: true,
    });
    for (const table of [
      'registered_groups',
      'channel_mounts',
      'agent_channel_mounts',
    ]) {
      const columns = raw
        .prepare(`PRAGMA table_info(${table})`)
        .all() as Array<{
        name: string;
      }>;
      expect(columns.map((column) => column.name)).toContain(
        'channel_account_id',
      );
      expect(columns.map((column) => column.name)).toContain('audience_mode');
    }
    const accountColumns = raw
      .prepare('PRAGMA table_info(channel_accounts)')
      .all() as Array<{
      name: string;
    }>;
    expect(accountColumns.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        'secret_ref',
        'default_agent_profile_id',
        'default_workspace_jid',
        'status',
      ]),
    );
    raw.close();
  });
});
