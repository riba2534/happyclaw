import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-v72-wecom-mount-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
const dataDir = path.join(root, 'data');
const databasePath = path.join(storeDir, 'messages.db');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

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

const now = '2026-08-17T00:00:00.000Z';
const workspaceJid = 'web:wecom-legacy-ws';
const legacyFolderJid = 'web:wecom-legacy-ws';
const dmJid = 'wecom:c2c:alice#account:bot-a';
const groupJid = 'wecom:group:sales#account:bot-a';
const manualDmJid = 'wecom:c2c:bob#account:bot-a';
const missingWsDmJid = 'wecom:c2c:carol#account:bot-a';

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('schema v72 WeCom direct workspace-mount migration', () => {
  test('moves existing WeCom DMs off a shared workspace owner and keeps groups/manual binds', () => {
    db.initDatabase();
    db.setRegisteredGroup(workspaceJid, {
      name: 'Legacy workspace',
      folder: 'wecom-legacy-ws',
      added_at: now,
      created_by: 'owner-a',
    });
    db.createAgent({
      id: 'manual-session',
      group_folder: 'wecom-legacy-ws',
      chat_jid: workspaceJid,
      name: 'Manual DM session',
      prompt: '',
      status: 'idle',
      kind: 'conversation',
      created_by: 'owner-a',
      created_at: now,
      completed_at: null,
      result_summary: null,
      last_im_jid: manualDmJid,
      spawned_from_jid: null,
      source_kind: 'manual',
    });
    db.setRegisteredGroup(dmJid, {
      name: 'Alice DM',
      folder: 'wecom-alice',
      added_at: now,
      created_by: 'owner-a',
      channel_account_id: 'bot-a',
      target_main_jid: legacyFolderJid,
    });
    db.setRegisteredGroup(groupJid, {
      name: 'Sales group',
      folder: 'wecom-sales',
      added_at: now,
      created_by: 'owner-a',
      channel_account_id: 'bot-a',
      target_main_jid: workspaceJid,
    });
    db.setRegisteredGroup(manualDmJid, {
      name: 'Bob DM',
      folder: 'wecom-bob',
      added_at: now,
      created_by: 'owner-a',
      channel_account_id: 'bot-a',
      target_agent_id: 'manual-session',
    });
    db.setRegisteredGroup(missingWsDmJid, {
      name: 'Carol DM',
      folder: 'wecom-carol',
      added_at: now,
      created_by: 'owner-a',
      channel_account_id: 'bot-a',
      target_main_jid: 'web:deleted-workspace',
    });
    expect(db.setSessionChannelOwnerOnce('wecom-legacy-ws', null, dmJid)).toBe(
      dmJid,
    );

    const failureInjector = new Database(databasePath);
    failureInjector.exec(`
      CREATE TRIGGER fail_wecom_direct_mount_update
      BEFORE UPDATE OF target_agent_id ON registered_groups
      WHEN OLD.jid = '${dmJid}'
      BEGIN
        SELECT RAISE(ABORT, 'injected migration failure');
      END;
    `);
    failureInjector.close();

    expect(() => db.migrateWecomDirectWorkspaceMountsToSessions()).toThrow(
      'injected migration failure',
    );
    expect(db.getRegisteredGroup(dmJid)).toMatchObject({
      target_main_jid: legacyFolderJid,
    });
    expect(
      db
        .listAgentsByJid(workspaceJid)
        .filter((agent) => agent.source_kind === 'channel_direct'),
    ).toHaveLength(0);
    expect(db.getSessionChannelOwner('wecom-legacy-ws')).toBe(dmJid);

    const triggerCleanup = new Database(databasePath);
    triggerCleanup.exec('DROP TRIGGER fail_wecom_direct_mount_update');
    triggerCleanup.close();

    expect(db.migrateWecomDirectWorkspaceMountsToSessions()).toBe(1);
    expect(db.migrateWecomDirectWorkspaceMountsToSessions()).toBe(0);

    const migratedDm = db.getRegisteredGroup(dmJid)!;
    expect(migratedDm.target_main_jid).toBeUndefined();
    expect(migratedDm.target_agent_id).toBeTruthy();
    expect(db.getAgent(migratedDm.target_agent_id!)?.source_kind).toBe(
      'channel_direct',
    );
    expect(db.getChannelMount(dmJid)).toMatchObject({
      workspace_jid: workspaceJid,
      session_id: migratedDm.target_agent_id,
    });
    expect(db.getSessionChannelOwner('wecom-legacy-ws')).toBeUndefined();

    expect(db.getRegisteredGroup(groupJid)).toMatchObject({
      target_main_jid: workspaceJid,
    });
    expect(db.getRegisteredGroup(groupJid)?.target_agent_id).toBeUndefined();
    expect(db.getChannelMount(groupJid)).toMatchObject({
      workspace_jid: workspaceJid,
      session_id: null,
    });

    expect(db.getRegisteredGroup(manualDmJid)).toMatchObject({
      target_agent_id: 'manual-session',
    });
    expect(db.getRegisteredGroup(missingWsDmJid)).toMatchObject({
      target_main_jid: 'web:deleted-workspace',
    });

    db.closeDatabase();
    const stamped = new Database(databasePath);
    stamped
      .prepare(
        "UPDATE router_state SET value = '71' WHERE key = 'schema_version'",
      )
      .run();
    stamped.close();

    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
    expect(db.getRegisteredGroup(dmJid)?.target_agent_id).toBe(
      migratedDm.target_agent_id,
    );
    expect(db.getRegisteredGroup(groupJid)?.target_main_jid).toBe(workspaceJid);
  });
});
