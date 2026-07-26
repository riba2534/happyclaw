import { afterAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from '../src/sqlite-compat.js';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v46-migration-'));
const storeDir = path.join(tmpDir, 'db');
const groupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });

vi.mock('../src/config.js', async () => ({
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));

const db = await import('../src/db.js');
const dbPath = path.join(storeDir, 'messages.db');

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('schema v46 migration', () => {
  test('preserves runtime data, removes workspace memberships, and is idempotent', () => {
    db.initDatabase();
    db.setRegisteredGroup('web:migration-runtime-workspace', {
      name: 'Migration Runtime Workspace',
      folder: 'migration-runtime-workspace',
      added_at: '2026-07-10T00:00:00.000Z',
      created_by: 'migration-owner',
    });
    db.setSession(
      'migration-runtime-workspace',
      'sdk-session-preserved',
      'runtime-agent-preserved',
    );
    db.closeDatabase();

    const legacy = new Database(dbPath);
    legacy.exec(`
      ALTER TABLE workspace_runtime_sessions RENAME TO workspace_sessions;
      ALTER TABLE workspace_sessions RENAME COLUMN runtime_agent_id TO session_agent_id;
      ALTER TABLE workspace_sessions RENAME COLUMN sdk_session_id TO claude_session_id;
      CREATE TABLE group_members (
        group_folder TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member',
        added_at TEXT NOT NULL,
        added_by TEXT,
        PRIMARY KEY (group_folder, user_id)
      );
      INSERT INTO group_members VALUES (
        'migration-runtime-workspace', 'legacy-member', 'member',
        '2026-07-10T00:00:00.000Z', 'migration-owner'
      );
      UPDATE router_state SET value = '42' WHERE key = 'schema_version';
    `);
    legacy.close();

    db.initDatabase();
    // Startup continues through the later channel-account lifecycle migration.
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
    expect(
      db.getWorkspaceRuntimeSession(
        'migration-runtime-workspace',
        'runtime-agent-preserved',
      ),
    ).toMatchObject({
      runtime_agent_id: 'runtime-agent-preserved',
      sdk_session_id: 'sdk-session-preserved',
    });
    db.closeDatabase();

    const withGhosts = new Database(dbPath);
    withGhosts.exec(`
      INSERT INTO workspaces (
        jid, folder, owner_user_id, name, status, is_home, created_at, updated_at
      ) VALUES (
        'web:projection-ghost', 'projection-ghost', 'ghost-owner', 'Ghost',
        'active', 0, '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z'
      );
      INSERT INTO workspace_runtime_sessions (
        group_folder, runtime_agent_id, workspace_jid, sdk_session_id,
        provider_id, agent_profile_id, agent_profile_version, identity_hash,
        created_at, updated_at
      ) VALUES (
        'projection-ghost', 'ghost-agent', 'web:projection-ghost', 'ghost-sdk',
        'ghost-provider', NULL, NULL, NULL,
        '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z'
      );
      INSERT INTO workspace_agent_profiles (
        group_folder, agent_profile_id, created_at, updated_at
      ) VALUES (
        'projection-ghost', 'ghost-profile',
        '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z'
      );
      INSERT INTO agent_channel_mounts (
        channel_jid, agent_profile_id, owner_user_id, channel_type,
        workspace_jid, workspace_folder, session_id, routing_mode,
        reply_policy, activation_mode, owner_im_id, created_at, updated_at
      ) VALUES (
        'telegram:projection-ghost', NULL, 'ghost-owner', 'telegram',
        'web:projection-ghost', 'projection-ghost', NULL, 'single_session',
        'source_only', 'auto', NULL,
        '2026-07-10T00:00:00.000Z', '2026-07-10T00:00:00.000Z'
      );
    `);
    withGhosts.close();

    // A second startup must be a no-op, not recreate the legacy table or
    // duplicate/drop the preserved runtime state. It also reconciles ghosts
    // that have no authoritative registered-group/session/channel source.
    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
    expect(
      db.getWorkspaceRuntimeSession(
        'migration-runtime-workspace',
        'runtime-agent-preserved',
      ),
    ).toMatchObject({ sdk_session_id: 'sdk-session-preserved' });
    expect(db.getWorkspaceRecord('web:projection-ghost')).toBeUndefined();
    expect(
      db.getWorkspaceRuntimeSession('projection-ghost', 'ghost-agent'),
    ).toBeUndefined();
    expect(db.getWorkspaceAgentProfileId('projection-ghost')).toBeUndefined();
    expect(
      db.getAgentChannelMount('telegram:projection-ghost'),
    ).toBeUndefined();

    db.closeDatabase();
    const inspected = new Database(dbPath, { readonly: true });
    const tables = inspected
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'workspace%session%' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    const indexes = inspected
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'workspace_runtime_sessions' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    const legacyMembershipTable = inspected
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'group_members'",
      )
      .get();
    inspected.close();
    expect(tables).toEqual([{ name: 'workspace_runtime_sessions' }]);
    expect(indexes.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'idx_workspace_runtime_sessions_profile',
        'idx_workspace_runtime_sessions_workspace',
      ]),
    );
    expect(legacyMembershipTable).toBeUndefined();

    // Keep afterAll safe after the explicit inspection close.
    db.initDatabase();
  });
});
