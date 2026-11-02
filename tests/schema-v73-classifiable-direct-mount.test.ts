import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'schema-v73-classifiable-mount-'),
);
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
const { formerMainSession } = await import('./helpers/legacy-main-session.js');
const { buildRecentConversationHistoryContext } =
  await import('../src/conversation-history.js');

const now = '2026-08-18T00:00:00.000Z';
const workspaceJid = 'web:legacy-shared-ws';
const legacyFolderJid = 'web:legacy-shared-ws';

const qqDmJid = 'qq:c2c:alice#account:bot-a';
const qqGroupJid = 'qq:group:sales#account:bot-a';
const telegramDmJid = 'telegram:123456#account:bot-a';
const telegramGroupJid = 'telegram:-100123#account:bot-a';
const wechatDmJid = 'wechat:wxid_alice#account:bot-a';
const wecomMigratedJid = 'wecom:c2c:already#account:bot-a';
const wecomLeftoverJid = 'wecom:c2c:leftover#account:bot-a';
const manualDmJid = 'qq:c2c:bob#account:bot-a';
const missingWsDmJid = 'dingtalk:c2c:carol#account:bot-a';
const feishuUnknownJid = 'feishu:oc_opaque#account:bot-a';
const malformedTelegramJid = 'telegram:not-a-number#account:bot-a';

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('schema v73 classifiable direct workspace-mount migration', () => {
  test('moves leftover classifiable DMs off a shared workspace owner and skips groups/manual/unknown', () => {
    db.initDatabase();
    db.setRegisteredGroup(workspaceJid, {
      name: 'Legacy shared workspace',
      folder: 'legacy-shared-ws',
      added_at: now,
      created_by: 'owner-a',
    });
    db.createAgent({
      id: 'manual-session',
      group_folder: 'legacy-shared-ws',
      chat_jid: workspaceJid,
      name: 'Manual QQ DM session',
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
    db.createAgent({
      id: 'wecom-v72-session',
      group_folder: 'legacy-shared-ws',
      chat_jid: workspaceJid,
      name: 'Already migrated WeCom DM',
      prompt: '',
      status: 'idle',
      kind: 'conversation',
      created_by: 'owner-a',
      created_at: now,
      completed_at: null,
      result_summary: null,
      last_im_jid: wecomMigratedJid,
      spawned_from_jid: null,
      source_kind: 'channel_direct',
    });

    db.setRegisteredGroup(qqDmJid, {
      name: 'Alice QQ DM',
      folder: 'qq-alice',
      added_at: now,
      created_by: 'owner-a',
      channel_account_id: 'bot-a',
      target_main_jid: legacyFolderJid,
    });
    db.setRegisteredGroup(qqGroupJid, {
      name: 'QQ sales group',
      folder: 'qq-sales',
      added_at: now,
      created_by: 'owner-a',
      channel_account_id: 'bot-a',
      target_main_jid: workspaceJid,
    });
    db.setRegisteredGroup(telegramDmJid, {
      name: 'Telegram DM',
      folder: 'tg-dm',
      added_at: now,
      created_by: 'owner-a',
      channel_account_id: 'bot-a',
      target_main_jid: workspaceJid,
    });
    db.setRegisteredGroup(telegramGroupJid, {
      name: 'Telegram group',
      folder: 'tg-group',
      added_at: now,
      created_by: 'owner-a',
      channel_account_id: 'bot-a',
      target_main_jid: workspaceJid,
    });
    db.setRegisteredGroup(wechatDmJid, {
      name: 'WeChat DM',
      folder: 'wechat-alice',
      added_at: now,
      created_by: 'owner-a',
      channel_account_id: 'bot-a',
      target_main_jid: workspaceJid,
    });
    db.setRegisteredGroup(wecomMigratedJid, {
      name: 'WeCom already migrated',
      folder: 'wecom-already',
      added_at: now,
      created_by: 'owner-a',
      channel_account_id: 'bot-a',
      target_agent_id: 'wecom-v72-session',
    });
    db.setRegisteredGroup(wecomLeftoverJid, {
      name: 'WeCom leftover',
      folder: 'wecom-leftover',
      added_at: now,
      created_by: 'owner-a',
      channel_account_id: 'bot-a',
      target_main_jid: workspaceJid,
    });
    db.setRegisteredGroup(manualDmJid, {
      name: 'Bob QQ DM',
      folder: 'qq-bob',
      added_at: now,
      created_by: 'owner-a',
      channel_account_id: 'bot-a',
      target_agent_id: 'manual-session',
    });
    db.setRegisteredGroup(missingWsDmJid, {
      name: 'Carol DingTalk DM',
      folder: 'dt-carol',
      added_at: now,
      created_by: 'owner-a',
      channel_account_id: 'bot-a',
      target_main_jid: 'web:deleted-workspace',
    });
    db.setRegisteredGroup(feishuUnknownJid, {
      name: 'Feishu opaque chat',
      folder: 'feishu-opaque',
      added_at: now,
      created_by: 'owner-a',
      channel_account_id: 'bot-a',
      target_main_jid: workspaceJid,
    });
    db.setRegisteredGroup(malformedTelegramJid, {
      name: 'Malformed Telegram',
      folder: 'tg-bad',
      added_at: now,
      created_by: 'owner-a',
      channel_account_id: 'bot-a',
      target_main_jid: workspaceJid,
    });

    expect(
      db.setSessionChannelOwnerOnce('legacy-shared-ws', null, qqDmJid),
    ).toBe(qqDmJid);
    db.setSession('legacy-shared-ws', 'contaminated-main-session');
    db.setSession('legacy-shared-ws', 'manual-session-sdk', 'manual-session');

    const failureInjector = new Database(databasePath);
    failureInjector.exec(`
      CREATE TRIGGER fail_classifiable_direct_session_delete
      BEFORE DELETE ON sessions
      WHEN OLD.group_folder = 'legacy-shared-ws' AND OLD.agent_id = ''
      BEGIN
        SELECT RAISE(ABORT, 'injected migration failure');
      END;
    `);
    failureInjector.close();

    expect(() =>
      db.migrateClassifiableDirectWorkspaceMountsToSessions(),
    ).toThrow('injected migration failure');
    expect(db.getRegisteredGroup(qqDmJid)).toMatchObject({
      target_main_jid: legacyFolderJid,
    });
    expect(
      db
        .listAgentsByJid(workspaceJid)
        .filter(
          (agent) =>
            agent.source_kind === 'channel_direct' &&
            agent.id !== 'wecom-v72-session',
        ),
    ).toHaveLength(0);
    expect(db.getSessionChannelOwner('legacy-shared-ws')).toBe(qqDmJid);
    expect(db.getSession('legacy-shared-ws')).toBe('contaminated-main-session');
    expect(db.getWorkspaceRuntimeSession('legacy-shared-ws')).toMatchObject({
      sdk_session_id: 'contaminated-main-session',
    });
    expect(
      db.getConversationHistoryIsolationMarker(workspaceJid),
    ).toBeUndefined();

    const triggerCleanup = new Database(databasePath);
    triggerCleanup.exec('DROP TRIGGER fail_classifiable_direct_session_delete');
    triggerCleanup.close();

    expect(db.migrateClassifiableDirectWorkspaceMountsToSessions()).toBe(4);
    expect(db.getSession('legacy-shared-ws')).toBeUndefined();
    expect(db.getWorkspaceRuntimeSession('legacy-shared-ws')).toBeUndefined();
    expect(db.getSession('legacy-shared-ws', 'manual-session')).toBe(
      'manual-session-sdk',
    );
    expect(db.getSessionChannelOwner('legacy-shared-ws')).toBeUndefined();
    const isolationMarker =
      db.getConversationHistoryIsolationMarker(workspaceJid);
    expect(isolationMarker).toBeTruthy();

    // Re-running the migration must not erase a clean main session/owner that
    // was established after the one-shot isolation completed.
    db.setSession('legacy-shared-ws', 'clean-main-session');
    expect(
      db.setSessionChannelOwnerOnce('legacy-shared-ws', null, qqGroupJid),
    ).toBe(qqGroupJid);
    expect(db.migrateClassifiableDirectWorkspaceMountsToSessions()).toBe(0);
    expect(db.getSession('legacy-shared-ws')).toBe('clean-main-session');
    expect(db.getSessionChannelOwner('legacy-shared-ws')).toBe(qqGroupJid);
    expect(db.getConversationHistoryIsolationMarker(workspaceJid)).toBe(
      isolationMarker,
    );

    const migratedQq = db.getRegisteredGroup(qqDmJid)!;
    expect(migratedQq.target_main_jid).toBeUndefined();
    expect(migratedQq.target_agent_id).toBeTruthy();
    expect(db.getAgent(migratedQq.target_agent_id!)?.source_kind).toBe(
      'channel_direct',
    );
    expect(db.getChannelMount(qqDmJid)).toMatchObject({
      workspace_jid: workspaceJid,
      session_id: migratedQq.target_agent_id,
    });

    const migratedTelegram = db.getRegisteredGroup(telegramDmJid)!;
    expect(migratedTelegram.target_main_jid).toBeUndefined();
    expect(migratedTelegram.target_agent_id).toBeTruthy();
    expect(migratedTelegram.target_agent_id).not.toBe(
      migratedQq.target_agent_id,
    );
    expect(db.getAgent(migratedTelegram.target_agent_id!)?.source_kind).toBe(
      'channel_direct',
    );

    const migratedWechat = db.getRegisteredGroup(wechatDmJid)!;
    expect(migratedWechat.target_main_jid).toBeUndefined();
    expect(migratedWechat.target_agent_id).toBeTruthy();
    expect(db.getAgent(migratedWechat.target_agent_id!)?.last_im_jid).toBe(
      wechatDmJid,
    );

    const migratedWecomLeftover = db.getRegisteredGroup(wecomLeftoverJid)!;
    expect(migratedWecomLeftover.target_main_jid).toBeUndefined();
    expect(migratedWecomLeftover.target_agent_id).toBeTruthy();

    expect(db.getRegisteredGroup(qqGroupJid)).toMatchObject({
      target_main_jid: workspaceJid,
    });
    expect(db.getRegisteredGroup(qqGroupJid)?.target_agent_id).toBeUndefined();
    expect(db.getChannelMount(qqGroupJid)).toMatchObject({
      workspace_jid: workspaceJid,
      session_id: null,
    });
    expect(db.getRegisteredGroup(telegramGroupJid)).toMatchObject({
      target_main_jid: workspaceJid,
    });

    expect(db.getRegisteredGroup(wecomMigratedJid)).toMatchObject({
      target_agent_id: 'wecom-v72-session',
    });
    expect(db.getRegisteredGroup(wecomMigratedJid)?.target_main_jid).toBe(
      undefined,
    );

    expect(db.getRegisteredGroup(manualDmJid)).toMatchObject({
      target_agent_id: 'manual-session',
    });
    expect(db.getRegisteredGroup(missingWsDmJid)).toMatchObject({
      target_main_jid: 'web:deleted-workspace',
    });
    expect(db.getRegisteredGroup(feishuUnknownJid)).toMatchObject({
      target_main_jid: workspaceJid,
    });
    expect(db.getRegisteredGroup(malformedTelegramJid)).toMatchObject({
      target_main_jid: workspaceJid,
    });

    db.closeDatabase();
    const stamped = new Database(databasePath);
    stamped
      .prepare(
        "UPDATE router_state SET value = '72' WHERE key = 'schema_version'",
      )
      .run();
    stamped.close();

    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
    expect(db.getRegisteredGroup(qqDmJid)?.target_agent_id).toBe(
      migratedQq.target_agent_id,
    );
    expect(db.getRegisteredGroup(wecomMigratedJid)?.target_agent_id).toBe(
      'wecom-v72-session',
    );
    // Groups and unknown chats are not v73's to move; v88 binds them to the
    // former main session.
    const formerMain = formerMainSession(db, workspaceJid).id;
    expect(db.getRegisteredGroup(qqGroupJid)?.target_agent_id).toBe(formerMain);
    expect(db.getRegisteredGroup(feishuUnknownJid)?.target_agent_id).toBe(
      formerMain,
    );
  });

  test('first v72-to-v73 startup migrates real WhatsApp LID forms per account and fences contaminated history', () => {
    const waWorkspaceJid = 'web:wa-lid-upgrade';
    const waFolder = 'wa-lid-upgrade';
    const waGroupJid = 'whatsapp:120363000000000000@g.us#account:bot-a';
    const waDirectJids = [
      'whatsapp:123456789012345@lid#account:bot-a',
      'whatsapp:123456789012345@lid#account:bot-b',
      'whatsapp:15551230000@hosted#account:bot-a',
      'whatsapp:15551230001@hosted.lid#account:bot-a',
    ];
    db.setRegisteredGroup(waWorkspaceJid, {
      name: 'WhatsApp upgrade workspace',
      folder: waFolder,
      added_at: now,
      created_by: 'owner-wa',
    });
    db.setRegisteredGroup(waGroupJid, {
      name: 'WhatsApp group',
      folder: 'wa-group',
      added_at: now,
      created_by: 'owner-wa',
      channel_account_id: 'bot-a',
      target_main_jid: waWorkspaceJid,
    });
    for (const [index, jid] of waDirectJids.entries()) {
      db.setRegisteredGroup(jid, {
        name: `WhatsApp direct ${index}`,
        folder: `wa-direct-${index}`,
        added_at: now,
        created_by: 'owner-wa',
        channel_account_id: index === 1 ? 'bot-b' : 'bot-a',
        target_main_jid: waWorkspaceJid,
      });
    }
    db.setSession(waFolder, 'contaminated-wa-main');
    db.setSessionChannelOwnerOnce(waFolder, null, waGroupJid);
    db.ensureChatExists(waWorkspaceJid);
    db.storeMessageDirect(
      'wa-private-before-v73',
      waWorkspaceJid,
      waDirectJids[0],
      'Private Alice',
      'private value that must never be replayed',
      now,
      false,
      { sourceJid: waDirectJids[0] },
    );
    db.storeMessageDirect(
      'wa-group-before-v73',
      waWorkspaceJid,
      waGroupJid,
      'Group Bob',
      'old group context before the privacy boundary',
      '2026-08-18T00:00:00.001Z',
      false,
      { sourceJid: waGroupJid },
    );
    db.storeMessageDirect(
      'wa-private-future-clock-before-v73',
      waWorkspaceJid,
      waDirectJids[0],
      'Private Alice',
      'future-clock private value that must never be replayed',
      '2099-01-01T00:00:00.000Z',
      false,
      { sourceJid: waDirectJids[0] },
    );

    // Reproduce the old v72 WeCom migration shape: the mount is already a
    // channel_direct session, but the workspace main transcript still proves
    // that private input was persisted there. A sibling with no such row must
    // not be invalidated merely because it has a channel_direct mount.
    const repairedWorkspaceJid = 'web:v72-wecom-contaminated';
    const repairedFolder = 'v72-wecom-contaminated';
    const repairedDirectJid = 'wecom:c2c:v72-alice#account:wecom-a';
    const cleanWorkspaceJid = 'web:v72-wecom-no-evidence';
    const cleanFolder = 'v72-wecom-no-evidence';
    const cleanDirectJid = 'wecom:c2c:v72-bob#account:wecom-a';
    for (const [workspace, folder] of [
      [repairedWorkspaceJid, repairedFolder],
      [cleanWorkspaceJid, cleanFolder],
    ] as const) {
      db.setRegisteredGroup(workspace, {
        name: workspace,
        folder,
        added_at: now,
        created_by: 'owner-wecom',
      });
      db.ensureChatExists(workspace);
    }
    for (const [id, jid, workspace, folder] of [
      [
        'v72-repaired-direct-session',
        repairedDirectJid,
        repairedWorkspaceJid,
        repairedFolder,
      ],
      [
        'v72-clean-direct-session',
        cleanDirectJid,
        cleanWorkspaceJid,
        cleanFolder,
      ],
    ] as const) {
      db.createAgent({
        id,
        group_folder: folder,
        chat_jid: workspace,
        name: jid,
        prompt: '',
        status: 'idle',
        kind: 'conversation',
        created_by: 'owner-wecom',
        created_at: now,
        completed_at: null,
        result_summary: null,
        last_im_jid: jid,
        spawned_from_jid: null,
        source_kind: 'channel_direct',
      });
      db.setRegisteredGroup(jid, {
        name: jid,
        folder: `${folder}-direct`,
        added_at: now,
        created_by: 'owner-wecom',
        channel_account_id: 'wecom-a',
        target_agent_id: id,
      });
      db.setSession(folder, `${folder}-main-session`);
    }
    db.storeMessageDirect(
      'v72-wecom-private-evidence',
      repairedWorkspaceJid,
      repairedDirectJid,
      'Private Alice',
      'old v72 private evidence',
      now,
      false,
      { sourceJid: repairedDirectJid },
    );

    // Reproduce a database whose v73 migration has genuinely never run.
    db.closeDatabase();
    const stamped = new Database(databasePath);
    stamped
      .prepare(
        "UPDATE router_state SET value = '72' WHERE key = 'schema_version'",
      )
      .run();
    stamped.close();
    db.initDatabase();

    const migratedAgentIds = waDirectJids.map((jid) => {
      const group = db.getRegisteredGroup(jid)!;
      expect(group.target_main_jid).toBeUndefined();
      expect(group.target_agent_id).toBeTruthy();
      expect(db.getAgent(group.target_agent_id!)?.source_kind).toBe(
        'channel_direct',
      );
      return group.target_agent_id!;
    });
    expect(new Set(migratedAgentIds).size).toBe(waDirectJids.length);
    // v88 then moved each main session onto a session of its own; the
    // recovery fence travels with the rows and the marker with the address.
    const { id: waSessionId, jid: waSessionJid } = formerMainSession(
      db,
      waWorkspaceJid,
    );
    expect(db.getRegisteredGroup(waGroupJid)).toMatchObject({
      target_agent_id: waSessionId,
    });
    expect(db.getSession(waFolder)).toBeUndefined();
    expect(db.getSession(waFolder, waSessionId)).toBeUndefined();
    expect(
      db.getWorkspaceRuntimeSession(waFolder, waSessionId),
    ).toBeUndefined();
    expect(db.getSessionChannelOwner(waFolder, waSessionId)).toBeUndefined();
    expect(db.getSession(repairedFolder)).toBeUndefined();
    expect(
      db.getConversationHistoryIsolationMarker(
        formerMainSession(db, repairedWorkspaceJid).jid,
      ),
    ).toBeTruthy();
    expect(
      db.getSession(cleanFolder, formerMainSession(db, cleanWorkspaceJid).id),
    ).toBe(`${cleanFolder}-main-session`);
    expect(
      db.getConversationHistoryIsolationMarker(cleanWorkspaceJid),
    ).toBeUndefined();

    const isolationMarker =
      db.getConversationHistoryIsolationMarker(waSessionJid);
    expect(isolationMarker).toBeTruthy();
    db.storeMessageDirect(
      'wa-safe-after-v73',
      waSessionJid,
      waGroupJid,
      'Group Bob',
      'safe group context after migration',
      '2026-08-18T00:00:00.002Z',
      false,
      { sourceJid: waGroupJid },
    );
    const history = buildRecentConversationHistoryContext(
      waSessionJid,
      new Set(),
      { intro: 'recovery' },
    );
    expect(history?.messageIds).toEqual(['wa-safe-after-v73']);
    expect(history?.context).toContain('safe group context after migration');
    expect(history?.context).not.toContain(
      'private value that must never be replayed',
    );
    expect(history?.context).not.toContain(
      'future-clock private value that must never be replayed',
    );
    const oversizedPendingSet = new Set(
      Array.from({ length: 40_000 }, (_, index) => `pending-${index}`),
    );
    expect(
      db
        .getConversationHistoryMessagesPage(
          waSessionJid,
          oversizedPendingSet,
          30,
        )
        .map((message) => message.id),
    ).toEqual(['wa-safe-after-v73']);

    // Replacing an old row must preserve its recovery fence.
    db.storeMessageDirect(
      'wa-private-before-v73',
      waSessionJid,
      waDirectJids[0],
      'Private Alice',
      'replaced private value that must still stay fenced',
      '2099-01-02T00:00:00.000Z',
      false,
      { sourceJid: waDirectJids[0] },
    );
    const historyAfterReplace = buildRecentConversationHistoryContext(
      waSessionJid,
      new Set(),
      { intro: 'recovery' },
    );
    expect(historyAfterReplace?.context).not.toContain(
      'replaced private value that must still stay fenced',
    );

    // A schema retry preserves the clean session lifecycle instead of
    // invalidating the workspace a second time.
    db.setSession(waFolder, 'clean-wa-main', waSessionId);
    db.setSessionChannelOwnerOnce(waFolder, waSessionId, waGroupJid);
    db.closeDatabase();
    const retryStamp = new Database(databasePath);
    retryStamp
      .prepare(
        "UPDATE router_state SET value = '72' WHERE key = 'schema_version'",
      )
      .run();
    retryStamp.close();
    db.initDatabase();
    expect(db.getSession(waFolder, waSessionId)).toBe('clean-wa-main');
    expect(db.getSessionChannelOwner(waFolder, waSessionId)).toBe(waGroupJid);
    expect(db.getConversationHistoryIsolationMarker(waSessionJid)).toBe(
      isolationMarker,
    );
  });
});
