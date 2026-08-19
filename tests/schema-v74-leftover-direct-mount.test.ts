import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'schema-v74-leftover-mount-'),
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
const { buildRecentConversationHistoryContext } =
  await import('../src/conversation-history.js');

const now = '2026-08-19T00:00:00.000Z';
const workspaceJid = 'web:v73-stamped-ws';
const folder = 'v73-stamped-ws';

const leftoverWaLidA = 'whatsapp:123456789012345@lid#account:bot-a';
const leftoverWaLidB = 'whatsapp:123456789012345@lid#account:bot-b';
const leftoverWaHosted = 'whatsapp:15551230000@hosted#account:bot-a';
const leftoverWaHostedLid = 'whatsapp:15551230001@hosted.lid#account:bot-a';
const leftoverQqDm = 'qq:c2c:leftover-alice#account:bot-a';
const leftoverDiscordDm = 'discord:dm:leftover-alice#account:bot-a';

const qqGroupJid = 'qq:group:sales#account:bot-a';
const discordGroupJid = 'discord:guild-channel-1#account:bot-a';
const waGroupJid = 'whatsapp:120363000000000000@g.us#account:bot-a';

const wecomMigratedJid = 'wecom:c2c:already#account:bot-a';
const qqMigratedJid = 'qq:c2c:already#account:bot-a';
const discordMigratedJid = 'discord:dm:already#account:bot-a';
const waPnMigratedJid = 'whatsapp:15550001111@s.whatsapp.net#account:bot-a';

const manualDmJid = 'qq:c2c:bob#account:bot-a';
const missingWsDmJid = 'dingtalk:c2c:carol#account:bot-a';
const feishuUnknownJid = 'feishu:oc_opaque#account:bot-a';
const malformedTelegramJid = 'telegram:not-a-number#account:bot-a';
const waBroadcastJid = 'whatsapp:status@broadcast#account:bot-a';

const leftoverDirectJids = [
  leftoverWaLidA,
  leftoverWaLidB,
  leftoverWaHosted,
  leftoverWaHostedLid,
  leftoverQqDm,
  leftoverDiscordDm,
];

function stampSchema(version: string): void {
  db.closeDatabase();
  const stamped = new Database(databasePath);
  stamped
    .prepare("UPDATE router_state SET value = ? WHERE key = 'schema_version'")
    .run(version);
  stamped.close();
  db.initDatabase();
}

function expectDirectSessionMount(jid: string): string {
  const group = db.getRegisteredGroup(jid)!;
  expect(group.target_main_jid).toBeUndefined();
  expect(group.target_agent_id).toBeTruthy();
  expect(db.getAgent(group.target_agent_id!)?.source_kind).toBe(
    'channel_direct',
  );
  expect(db.getChannelMount(jid)).toMatchObject({
    workspace_jid: workspaceJid,
    session_id: group.target_agent_id,
  });
  return group.target_agent_id!;
}

function expectGroupStaysOnMain(jid: string): void {
  expect(db.getRegisteredGroup(jid)).toMatchObject({
    target_main_jid: workspaceJid,
  });
  expect(db.getRegisteredGroup(jid)?.target_agent_id).toBeUndefined();
  expect(db.getChannelMount(jid)).toMatchObject({
    workspace_jid: workspaceJid,
    session_id: null,
  });
}

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe.sequential(
  'schema v74 leftover classifiable direct workspace-mount migration',
  () => {
    test('remounts leftover LID/QQ/Discord DMs on a v73-stamped database and skips groups/manual/unknown', () => {
      db.initDatabase();
      db.setRegisteredGroup(workspaceJid, {
        name: 'v73 stamped workspace',
        folder,
        added_at: now,
        created_by: 'owner-a',
      });
      db.createAgent({
        id: 'manual-session',
        group_folder: folder,
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
      for (const [id, jid] of [
        ['wecom-v72-session', wecomMigratedJid],
        ['qq-v73-session', qqMigratedJid],
        ['discord-v73-session', discordMigratedJid],
        ['wa-pn-v73-session', waPnMigratedJid],
      ] as const) {
        db.createAgent({
          id,
          group_folder: folder,
          chat_jid: workspaceJid,
          name: jid,
          prompt: '',
          status: 'idle',
          kind: 'conversation',
          created_by: 'owner-a',
          created_at: now,
          completed_at: null,
          result_summary: null,
          last_im_jid: jid,
          spawned_from_jid: null,
          source_kind: 'channel_direct',
        });
        db.setRegisteredGroup(jid, {
          name: jid,
          folder: `${id}-folder`,
          added_at: now,
          created_by: 'owner-a',
          channel_account_id: 'bot-a',
          target_agent_id: id,
        });
      }

      for (const [index, jid] of leftoverDirectJids.entries()) {
        db.setRegisteredGroup(jid, {
          name: `Leftover direct ${index}`,
          folder: `leftover-${index}`,
          added_at: now,
          created_by: 'owner-a',
          channel_account_id: jid.includes('bot-b') ? 'bot-b' : 'bot-a',
          target_main_jid: workspaceJid,
        });
      }
      db.setRegisteredGroup(qqGroupJid, {
        name: 'QQ sales group',
        folder: 'qq-sales',
        added_at: now,
        created_by: 'owner-a',
        channel_account_id: 'bot-a',
        target_main_jid: workspaceJid,
      });
      db.setRegisteredGroup(discordGroupJid, {
        name: 'Discord guild channel',
        folder: 'discord-guild',
        added_at: now,
        created_by: 'owner-a',
        channel_account_id: 'bot-a',
        target_main_jid: workspaceJid,
      });
      db.setRegisteredGroup(waGroupJid, {
        name: 'WhatsApp group',
        folder: 'wa-group',
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
      db.setRegisteredGroup(waBroadcastJid, {
        name: 'WhatsApp broadcast',
        folder: 'wa-broadcast',
        added_at: now,
        created_by: 'owner-a',
        channel_account_id: 'bot-a',
        target_main_jid: workspaceJid,
      });

      expect(db.setSessionChannelOwnerOnce(folder, null, leftoverWaLidA)).toBe(
        leftoverWaLidA,
      );
      db.setSession(folder, 'contaminated-main-session');
      db.setSession(folder, 'manual-session-sdk', 'manual-session');

      const failureInjector = new Database(databasePath);
      failureInjector.exec(`
      CREATE TRIGGER fail_leftover_direct_session_delete
      BEFORE DELETE ON sessions
      WHEN OLD.group_folder = '${folder}' AND OLD.agent_id = ''
      BEGIN
        SELECT RAISE(ABORT, 'injected migration failure');
      END;
    `);
      failureInjector.close();

      expect(() =>
        db.migrateClassifiableDirectWorkspaceMountsToSessions(),
      ).toThrow('injected migration failure');
      expect(db.getRegisteredGroup(leftoverWaLidA)).toMatchObject({
        target_main_jid: workspaceJid,
      });
      expect(db.getSessionChannelOwner(folder)).toBe(leftoverWaLidA);
      expect(db.getSession(folder)).toBe('contaminated-main-session');
      expect(db.getConversationHistoryIsolationMarker(workspaceJid)).toBe(
        undefined,
      );

      const triggerCleanup = new Database(databasePath);
      triggerCleanup.exec('DROP TRIGGER fail_leftover_direct_session_delete');
      triggerCleanup.close();

      expect(db.migrateClassifiableDirectWorkspaceMountsToSessions()).toBe(
        leftoverDirectJids.length,
      );
      expect(db.getSession(folder)).toBeUndefined();
      expect(db.getWorkspaceRuntimeSession(folder)).toBeUndefined();
      expect(db.getSession(folder, 'manual-session')).toBe(
        'manual-session-sdk',
      );
      expect(db.getSessionChannelOwner(folder)).toBeUndefined();
      const isolationMarker =
        db.getConversationHistoryIsolationMarker(workspaceJid);
      expect(isolationMarker).toBeTruthy();

      const migratedIds = leftoverDirectJids.map((jid) =>
        expectDirectSessionMount(jid),
      );
      expect(new Set(migratedIds).size).toBe(leftoverDirectJids.length);

      expectGroupStaysOnMain(qqGroupJid);
      expectGroupStaysOnMain(discordGroupJid);
      expectGroupStaysOnMain(waGroupJid);

      expect(db.getRegisteredGroup(wecomMigratedJid)?.target_agent_id).toBe(
        'wecom-v72-session',
      );
      expect(db.getRegisteredGroup(qqMigratedJid)?.target_agent_id).toBe(
        'qq-v73-session',
      );
      expect(db.getRegisteredGroup(discordMigratedJid)?.target_agent_id).toBe(
        'discord-v73-session',
      );
      expect(db.getRegisteredGroup(waPnMigratedJid)?.target_agent_id).toBe(
        'wa-pn-v73-session',
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
      expect(db.getRegisteredGroup(waBroadcastJid)).toMatchObject({
        target_main_jid: workspaceJid,
      });

      db.setSession(folder, 'clean-main-session');
      expect(db.setSessionChannelOwnerOnce(folder, null, waGroupJid)).toBe(
        waGroupJid,
      );
      expect(db.migrateClassifiableDirectWorkspaceMountsToSessions()).toBe(0);
      expect(db.getSession(folder)).toBe('clean-main-session');
      expect(db.getSessionChannelOwner(folder)).toBe(waGroupJid);
      expect(db.getConversationHistoryIsolationMarker(workspaceJid)).toBe(
        isolationMarker,
      );

      // A database already stamped 73 must still run v74 on upgrade.
      stampSchema('73');
      expect(db.getRouterState('schema_version')).toBe(
        String(db.CURRENT_SCHEMA_VERSION),
      );
      expect(db.getRegisteredGroup(leftoverWaLidA)?.target_agent_id).toBe(
        migratedIds[0],
      );
      expect(db.getRegisteredGroup(leftoverQqDm)?.target_agent_id).toBe(
        migratedIds[4],
      );
      expect(db.getRegisteredGroup(leftoverDiscordDm)?.target_agent_id).toBe(
        migratedIds[5],
      );
      expect(db.getRegisteredGroup(waPnMigratedJid)?.target_agent_id).toBe(
        'wa-pn-v73-session',
      );
      expect(db.getSession(folder)).toBe('clean-main-session');
      expect(db.getSessionChannelOwner(folder)).toBe(waGroupJid);
    });

    test('v73 leftover QQ/Discord/WhatsApp DMs do not share main owner and fence recovery without timestamps', () => {
      const cases = [
        {
          folder: 'qq-v74-recovery',
          workspaceJid: 'web:qq-v74-recovery',
          dmJid: 'qq:c2c:recovery-alice#account:bot-a',
          groupJid: 'qq:group:recovery-sales#account:bot-a',
          privateText: 'qq private value that must never be replayed',
          futurePrivateText:
            'qq future-clock private value that must never be replayed',
          groupBeforeText: 'qq old group context before the privacy boundary',
          groupAfterText: 'qq safe group context after migration',
        },
        {
          folder: 'discord-v74-recovery',
          workspaceJid: 'web:discord-v74-recovery',
          dmJid: 'discord:dm:recovery-alice#account:bot-a',
          groupJid: 'discord:recovery-guild#account:bot-a',
          privateText: 'discord private value that must never be replayed',
          futurePrivateText:
            'discord future-clock private value that must never be replayed',
          groupBeforeText:
            'discord old group context before the privacy boundary',
          groupAfterText: 'discord safe group context after migration',
        },
        {
          folder: 'wa-v74-recovery',
          workspaceJid: 'web:wa-v74-recovery',
          dmJid: 'whatsapp:123456789099999@lid#account:bot-a',
          extraDmJid: 'whatsapp:15559990000@s.whatsapp.net#account:bot-a',
          groupJid: 'whatsapp:120363000000000111@g.us#account:bot-a',
          privateText: 'wa private value that must never be replayed',
          futurePrivateText:
            'wa future-clock private value that must never be replayed',
          groupBeforeText: 'wa old group context before the privacy boundary',
          groupAfterText: 'wa safe group context after migration',
        },
      ] as const;

      for (const fixture of cases) {
        db.setRegisteredGroup(fixture.workspaceJid, {
          name: fixture.workspaceJid,
          folder: fixture.folder,
          added_at: now,
          created_by: 'owner-recovery',
        });
        db.setRegisteredGroup(fixture.dmJid, {
          name: fixture.dmJid,
          folder: `${fixture.folder}-dm`,
          added_at: now,
          created_by: 'owner-recovery',
          channel_account_id: 'bot-a',
          target_main_jid: fixture.workspaceJid,
        });
        if ('extraDmJid' in fixture && fixture.extraDmJid) {
          db.setRegisteredGroup(fixture.extraDmJid, {
            name: fixture.extraDmJid,
            folder: `${fixture.folder}-pn`,
            added_at: now,
            created_by: 'owner-recovery',
            channel_account_id: 'bot-a',
            target_main_jid: fixture.workspaceJid,
          });
        }
        db.setRegisteredGroup(fixture.groupJid, {
          name: fixture.groupJid,
          folder: `${fixture.folder}-group`,
          added_at: now,
          created_by: 'owner-recovery',
          channel_account_id: 'bot-a',
          target_main_jid: fixture.workspaceJid,
        });
        db.setSession(fixture.folder, `${fixture.folder}-contaminated`);
        db.setSessionChannelOwnerOnce(fixture.folder, null, fixture.dmJid);
        db.ensureChatExists(fixture.workspaceJid);
        db.storeMessageDirect(
          `${fixture.folder}-private-before`,
          fixture.workspaceJid,
          fixture.dmJid,
          'Private Alice',
          fixture.privateText,
          now,
          false,
          { sourceJid: fixture.dmJid },
        );
        db.storeMessageDirect(
          `${fixture.folder}-group-before`,
          fixture.workspaceJid,
          fixture.groupJid,
          'Group Bob',
          fixture.groupBeforeText,
          '2026-08-19T00:00:00.001Z',
          false,
          { sourceJid: fixture.groupJid },
        );
        db.storeMessageDirect(
          `${fixture.folder}-private-future`,
          fixture.workspaceJid,
          fixture.dmJid,
          'Private Alice',
          fixture.futurePrivateText,
          '2099-01-01T00:00:00.000Z',
          false,
          { sourceJid: fixture.dmJid },
        );
      }

      const isolatedFolder = 'already-isolated-ws';
      const isolatedWorkspaceJid = 'web:already-isolated-ws';
      const isolatedLid = 'whatsapp:15551239999@lid#account:bot-a';
      const isolatedGroup = 'whatsapp:120363000000000222@g.us#account:bot-a';
      db.setRegisteredGroup(isolatedWorkspaceJid, {
        name: isolatedWorkspaceJid,
        folder: isolatedFolder,
        added_at: now,
        created_by: 'owner-recovery',
      });
      db.setRegisteredGroup(isolatedLid, {
        name: isolatedLid,
        folder: `${isolatedFolder}-lid`,
        added_at: now,
        created_by: 'owner-recovery',
        channel_account_id: 'bot-a',
        target_main_jid: isolatedWorkspaceJid,
      });
      db.setRegisteredGroup(isolatedGroup, {
        name: isolatedGroup,
        folder: `${isolatedFolder}-group`,
        added_at: now,
        created_by: 'owner-recovery',
        channel_account_id: 'bot-a',
        target_main_jid: isolatedWorkspaceJid,
      });
      db.setRouterState(
        `conversation_history_isolation:${isolatedWorkspaceJid}`,
        now,
      );
      db.setSession(isolatedFolder, 'clean-after-v73-main');
      expect(
        db.setSessionChannelOwnerOnce(isolatedFolder, null, isolatedLid),
      ).toBe(isolatedLid);

      stampSchema('73');

      for (const fixture of cases) {
        const migrated = db.getRegisteredGroup(fixture.dmJid)!;
        expect(migrated.target_main_jid).toBeUndefined();
        expect(migrated.target_agent_id).toBeTruthy();
        expect(db.getAgent(migrated.target_agent_id!)?.source_kind).toBe(
          'channel_direct',
        );
        if ('extraDmJid' in fixture && fixture.extraDmJid) {
          const extra = db.getRegisteredGroup(fixture.extraDmJid)!;
          expect(extra.target_main_jid).toBeUndefined();
          expect(extra.target_agent_id).toBeTruthy();
          expect(extra.target_agent_id).not.toBe(migrated.target_agent_id);
        }
        expect(db.getRegisteredGroup(fixture.groupJid)).toMatchObject({
          target_main_jid: fixture.workspaceJid,
        });
        expect(db.getSession(fixture.folder)).toBeUndefined();
        expect(db.getSessionChannelOwner(fixture.folder)).toBeUndefined();
        expect(
          db.setSessionChannelOwnerOnce(fixture.folder, null, fixture.groupJid),
        ).toBe(fixture.groupJid);
        expect(
          db.setSessionChannelOwnerOnce(fixture.folder, null, fixture.dmJid),
        ).toBe(fixture.groupJid);
        expect(
          db.setSessionChannelOwnerOnce(
            fixture.folder,
            migrated.target_agent_id,
            fixture.dmJid,
          ),
        ).toBe(fixture.dmJid);

        const isolationMarker = db.getConversationHistoryIsolationMarker(
          fixture.workspaceJid,
        );
        expect(isolationMarker).toBeTruthy();
        db.storeMessageDirect(
          `${fixture.folder}-group-after`,
          fixture.workspaceJid,
          fixture.groupJid,
          'Group Bob',
          fixture.groupAfterText,
          '2026-08-19T00:00:00.002Z',
          false,
          { sourceJid: fixture.groupJid },
        );
        const history = buildRecentConversationHistoryContext(
          fixture.workspaceJid,
          new Set(),
          { intro: 'recovery' },
        );
        expect(history?.messageIds).toEqual([`${fixture.folder}-group-after`]);
        expect(history?.context).toContain(fixture.groupAfterText);
        expect(history?.context).not.toContain(fixture.privateText);
        expect(history?.context).not.toContain(fixture.futurePrivateText);
        expect(history?.context).not.toContain(fixture.groupBeforeText);

        db.storeMessageDirect(
          `${fixture.folder}-private-before`,
          fixture.workspaceJid,
          fixture.dmJid,
          'Private Alice',
          `replaced ${fixture.privateText}`,
          '2099-01-02T00:00:00.000Z',
          false,
          { sourceJid: fixture.dmJid },
        );
        const historyAfterReplace = buildRecentConversationHistoryContext(
          fixture.workspaceJid,
          new Set(),
          { intro: 'recovery' },
        );
        expect(historyAfterReplace?.context).not.toContain(
          `replaced ${fixture.privateText}`,
        );
      }

      const remountedLid = db.getRegisteredGroup(isolatedLid)!;
      expect(remountedLid.target_main_jid).toBeUndefined();
      expect(remountedLid.target_agent_id).toBeTruthy();
      expect(db.getSession(isolatedFolder)).toBe('clean-after-v73-main');
      expect(db.getSessionChannelOwner(isolatedFolder)).toBeUndefined();
      expect(
        db.getConversationHistoryIsolationMarker(isolatedWorkspaceJid),
      ).toBe(now);
      expect(
        db.setSessionChannelOwnerOnce(isolatedFolder, null, isolatedGroup),
      ).toBe(isolatedGroup);
      expect(
        db.setSessionChannelOwnerOnce(isolatedFolder, null, isolatedLid),
      ).toBe(isolatedGroup);
    });
  },
);
