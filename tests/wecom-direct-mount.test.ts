import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import type { ChannelProvider, RegisteredGroup } from '../src/types.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-direct-mount-'));
const store = path.join(tmp, 'db');
const groups = path.join(tmp, 'groups');
const dataDir = path.join(tmp, 'data');
fs.mkdirSync(store, { recursive: true });
fs.mkdirSync(groups, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });

vi.mock('../src/config.js', () => ({
  ASSISTANT_NAME: 'HappyClaw Test',
  DATA_DIR: dataDir,
  STORE_DIR: store,
  GROUPS_DIR: groups,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const { buildRecentConversationHistoryContext } =
  await import('../src/conversation-history.js');
const {
  attachDefaultChannelAccountMount,
  buildSessionMountUpdate,
  resolveChannelMountTarget,
} = await import('../src/channel-mount-service.js');

const now = '2026-08-17T00:00:00.000Z';
const workspaceJid = 'web:wecom-ws';
const dmJid = 'wecom:c2c:user-1#account:bot-a';
const groupJid = 'wecom:group:chat-1#account:bot-a';

const CLASSIFIABLE_ISOLATION_CASES = [
  {
    name: 'QQ',
    provider: 'qq' as ChannelProvider,
    accountId: 'qq-bot-a',
    workspaceJid: 'web:qq-iso-ws',
    folder: 'qq-iso-ws',
    dms: ['qq:c2c:alice#account:qq-bot-a'],
    groupJid: 'qq:group:sales#account:qq-bot-a',
  },
  {
    name: 'Discord',
    provider: 'discord' as ChannelProvider,
    accountId: 'discord-bot-a',
    workspaceJid: 'web:discord-iso-ws',
    folder: 'discord-iso-ws',
    dms: ['discord:dm:alice#account:discord-bot-a'],
    groupJid: 'discord:guild-channel-1#account:discord-bot-a',
  },
  {
    name: 'WhatsApp',
    provider: 'whatsapp' as ChannelProvider,
    accountId: 'wa-bot-a',
    workspaceJid: 'web:wa-iso-ws',
    folder: 'wa-iso-ws',
    dms: [
      'whatsapp:15551230000@s.whatsapp.net#account:wa-bot-a',
      'whatsapp:123456789012345@lid#account:wa-bot-a',
      'whatsapp:15551230001@hosted#account:wa-bot-a',
    ],
    groupJid: 'whatsapp:120363000000000000@g.us#account:wa-bot-a',
  },
] as const;

function workspaceGroup() {
  return {
    name: 'WeCom workspace',
    folder: 'wecom-ws',
    added_at: now,
    created_by: 'owner-a',
  };
}

function chatGroup(name: string, overrides: Record<string, unknown> = {}) {
  return {
    name,
    folder: 'wecom-chat',
    added_at: now,
    created_by: 'owner-a',
    ...overrides,
  };
}

let sessionSeq = 0;

/** An explicit bind of a chat to a new session of the workspace. */
function bindSession(
  sourceJid: string,
  group: RegisteredGroup,
  targetWorkspaceJid = workspaceJid,
): RegisteredGroup {
  const workspace = db.getRegisteredGroup(targetWorkspaceJid)!;
  const id = `session-${++sessionSeq}`;
  db.createAgent({
    id,
    group_folder: workspace.folder,
    chat_jid: targetWorkspaceJid,
    name: group.name,
    prompt: '',
    status: 'idle',
    kind: 'conversation',
    created_by: 'owner-a',
    created_at: now,
    completed_at: null,
    result_summary: null,
    last_im_jid: sourceJid,
    spawned_from_jid: null,
  });
  const bound = buildSessionMountUpdate(group, id, {
    replyPolicy: 'source_only',
  });
  db.setRegisteredGroup(sourceJid, bound);
  return bound;
}

function expectRoutesToOwnSession(sourceJid: string, bound: RegisteredGroup) {
  const mount = db.getChannelMount(sourceJid);
  expect(mount).toMatchObject({
    session_id: bound.target_agent_id,
    routing_mode: 'single_session',
  });
  expect(
    resolveChannelMountTarget(mount!, {
      getAgent: db.getAgent,
      getRegisteredGroup: db.getRegisteredGroup,
    }),
  ).toMatchObject({
    status: 'session',
    effectiveJid: `${mount!.workspace_jid}#agent:${bound.target_agent_id}`,
    agentId: bound.target_agent_id,
  });
}

beforeAll(() => {
  db.initDatabase();
  db.setRegisteredGroup(workspaceJid, workspaceGroup());
  db.createChannelAccount({
    id: 'bot-a',
    owner_user_id: 'owner-a',
    provider: 'wecom',
    name: 'WeCom bot',
    secret_ref: 'channel-account:bot-a',
    default_workspace_jid: workspaceJid,
  });
  for (const fixture of CLASSIFIABLE_ISOLATION_CASES) {
    db.setRegisteredGroup(fixture.workspaceJid, {
      name: `${fixture.name} workspace`,
      folder: fixture.folder,
      added_at: now,
      created_by: 'owner-a',
    });
    db.createChannelAccount({
      id: fixture.accountId,
      owner_user_id: 'owner-a',
      provider: fixture.provider,
      name: `${fixture.name} bot`,
      secret_ref: `channel-account:${fixture.accountId}`,
      default_workspace_jid: fixture.workspaceJid,
    });
  }
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe.sequential('WeCom DM / group channel-account mounts', () => {
  test('discovery records the account but leaves new DMs and groups unbound', () => {
    const onCreated = vi.fn();
    const sessionsBefore = db.listAgentsByJid(workspaceJid);
    for (const sourceJid of [dmJid, groupJid]) {
      const discovered = attachDefaultChannelAccountMount({
        sourceJid,
        // Even sharing the workspace folder does not authorize a binding.
        group: chatGroup('Discovered WeCom chat', { folder: 'wecom-ws' }),
        accountId: 'bot-a',
        fallbackWorkspaceJid: workspaceJid,
        userId: 'owner-a',
        onCreated,
      });
      expect(discovered.channel_account_id).toBe('bot-a');
      expect(discovered.target_main_jid).toBeUndefined();
      expect(discovered.target_agent_id).toBeUndefined();
      db.setRegisteredGroup(sourceJid, discovered);
      expect(db.getRegisteredGroup(sourceJid)?.channel_account_id).toBe(
        'bot-a',
      );
      expect(db.getChannelMount(sourceJid)).toBeUndefined();
    }
    expect(db.listAgentsByJid(workspaceJid)).toEqual(sessionsBefore);
    expect(onCreated).not.toHaveBeenCalled();
  });

  test('explicit session bindings keep the DM and the group in their own sessions', () => {
    const dm = bindSession(
      dmJid,
      chatGroup('Explicit private session', { channel_account_id: 'bot-a' }),
    );
    const group = bindSession(
      groupJid,
      chatGroup('Team group', { channel_account_id: 'bot-a' }),
    );
    expect(dm.target_agent_id).not.toBe(group.target_agent_id);
    expectRoutesToOwnSession(dmJid, dm);
    expectRoutesToOwnSession(groupJid, group);

    // Each session's channel owner is its own chat.
    expect(
      db.setSessionChannelOwnerOnce('wecom-ws', dm.target_agent_id, dmJid),
    ).toBe(dmJid);
    expect(
      db.setSessionChannelOwnerOnce(
        'wecom-ws',
        group.target_agent_id,
        groupJid,
      ),
    ).toBe(groupJid);
    expect(
      db.setSessionChannelOwnerOnce('wecom-ws', dm.target_agent_id, groupJid),
    ).toBe(dmJid);
  });

  test('rediscovery neither changes nor creates a binding', () => {
    const bound = bindSession(
      dmJid,
      chatGroup('Explicit private session', { channel_account_id: 'bot-a' }),
    );
    expect(
      attachDefaultChannelAccountMount({
        sourceJid: dmJid,
        group: bound,
        accountId: 'bot-a',
        fallbackWorkspaceJid: workspaceJid,
        userId: 'owner-a',
      }),
    ).toBe(bound);

    const discoveredAgain = attachDefaultChannelAccountMount({
      sourceJid: dmJid,
      group: chatGroup('Private DM replay'),
      accountId: 'bot-a',
      fallbackWorkspaceJid: workspaceJid,
      userId: 'owner-a',
    });
    expect(discoveredAgain.target_agent_id).toBeUndefined();
    expect(discoveredAgain.target_main_jid).toBeUndefined();
  });

  test('keeps the same native DM isolated across WeCom accounts', () => {
    db.createChannelAccount({
      id: 'bot-b',
      owner_user_id: 'owner-a',
      provider: 'wecom',
      name: 'Second WeCom bot',
      secret_ref: 'channel-account:bot-b',
      default_workspace_jid: workspaceJid,
    });
    const secondJid = 'wecom:c2c:user-1#account:bot-b';
    let secondAgentId: string | undefined;
    try {
      const first = bindSession(
        dmJid,
        chatGroup('First bot session', { channel_account_id: 'bot-a' }),
      );
      const second = bindSession(
        secondJid,
        chatGroup('Second bot session', { channel_account_id: 'bot-b' }),
      );
      secondAgentId = second.target_agent_id;
      expect(secondAgentId).not.toBe(first.target_agent_id);
      expectRoutesToOwnSession(secondJid, second);
      expect(db.getChannelMount(secondJid)?.channel_account_id).toBe('bot-b');
    } finally {
      db.deleteRegisteredGroup(secondJid);
      if (secondAgentId) db.deleteAgent(secondAgentId);
      db.deleteChannelAccount('bot-b', 'owner-a');
    }
  });

  test('does not overwrite an explicit session or topic-workspace bind', () => {
    const sessionBound = chatGroup('Manual session', {
      channel_account_id: 'bot-a',
      target_agent_id: 'manual-session',
    });
    expect(
      attachDefaultChannelAccountMount({
        sourceJid: 'wecom:c2c:user-2#account:bot-a',
        group: sessionBound,
        accountId: 'bot-a',
        fallbackWorkspaceJid: workspaceJid,
        userId: 'owner-a',
      }),
    ).toBe(sessionBound);

    const workspaceBound = chatGroup('Manual topic workspace', {
      channel_account_id: 'bot-a',
      target_main_jid: 'web:user-selected',
      binding_mode: 'thread_map',
    });
    expect(
      attachDefaultChannelAccountMount({
        sourceJid: 'wecom:group:chat-2#account:bot-a',
        group: workspaceBound,
        accountId: 'bot-a',
        fallbackWorkspaceJid: workspaceJid,
        userId: 'owner-a',
      }),
    ).toBe(workspaceBound);
  });
});

describe.sequential(
  'QQ/Discord/WhatsApp DM / group channel-account mounts',
  () => {
    test.each(CLASSIFIABLE_ISOLATION_CASES)(
      '$name: discovery leaves DMs and groups unbound despite an account default workspace',
      (fixture) => {
        const onCreated = vi.fn();
        const sessionsBefore = db.listAgentsByJid(fixture.workspaceJid);
        for (const sourceJid of [...fixture.dms, fixture.groupJid]) {
          const discovered = attachDefaultChannelAccountMount({
            sourceJid,
            group: chatGroup(`${fixture.name} discovered chat`, {
              folder: fixture.folder,
            }),
            accountId: fixture.accountId,
            fallbackWorkspaceJid: fixture.workspaceJid,
            userId: 'owner-a',
            onCreated,
          });
          expect(discovered.channel_account_id).toBe(fixture.accountId);
          expect(discovered.target_main_jid).toBeUndefined();
          expect(discovered.target_agent_id).toBeUndefined();
          db.setRegisteredGroup(sourceJid, discovered);
          expect(db.getRegisteredGroup(sourceJid)).toBeDefined();
          expect(db.getChannelMount(sourceJid)).toBeUndefined();
        }
        expect(db.listAgentsByJid(fixture.workspaceJid)).toEqual(
          sessionsBefore,
        );
        expect(onCreated).not.toHaveBeenCalled();
      },
    );

    test.each(CLASSIFIABLE_ISOLATION_CASES)(
      '$name: explicit session bindings keep every DM and the group apart',
      (fixture) => {
        const bound = [...fixture.dms, fixture.groupJid].map((sourceJid) => {
          const chat = bindSession(
            sourceJid,
            chatGroup(`${fixture.name} chat`, {
              channel_account_id: fixture.accountId,
            }),
            fixture.workspaceJid,
          );
          expect(chat.channel_account_id).toBe(fixture.accountId);
          expect(chat.target_main_jid).toBeUndefined();
          expectRoutesToOwnSession(sourceJid, chat);
          return chat;
        });
        expect(new Set(bound.map((chat) => chat.target_agent_id)).size).toBe(
          bound.length,
        );
      },
    );

    test.each(CLASSIFIABLE_ISOLATION_CASES)(
      '$name: recovery of one session never replays another session transcript',
      (fixture) => {
        const sourceJid = fixture.dms[0]!;
        const dm = bindSession(
          sourceJid,
          chatGroup(`${fixture.name} isolated recovery session`, {
            channel_account_id: fixture.accountId,
          }),
          fixture.workspaceJid,
        );
        const group = bindSession(
          fixture.groupJid,
          chatGroup(`${fixture.name} group recovery session`, {
            channel_account_id: fixture.accountId,
          }),
          fixture.workspaceJid,
        );
        const groupChatJid = `${fixture.workspaceJid}#agent:${group.target_agent_id}`;
        const dmChatJid = `${fixture.workspaceJid}#agent:${dm.target_agent_id}`;
        for (const [chatJid, id, sender, text, source] of [
          [
            groupChatJid,
            `${fixture.folder}-group-recovery`,
            'Group Bob',
            `${fixture.name} group context that recovery may replay`,
            fixture.groupJid,
          ],
          [
            dmChatJid,
            `${fixture.folder}-dm-recovery`,
            'Private Alice',
            `${fixture.name} private value that must never share recovery`,
            sourceJid,
          ],
        ] as const) {
          db.ensureChatExists(chatJid);
          db.storeMessageDirect(id, chatJid, source, sender, text, now, false, {
            sourceJid: source,
          });
        }
        const history = buildRecentConversationHistoryContext(
          groupChatJid,
          new Set(),
          { intro: 'recovery' },
        );
        expect(history?.context).toContain(
          `${fixture.name} group context that recovery may replay`,
        );
        expect(history?.context).not.toContain(
          `${fixture.name} private value that must never share recovery`,
        );
        const dmHistory = buildRecentConversationHistoryContext(
          dmChatJid,
          new Set(),
          { intro: 'recovery' },
        );
        expect(dmHistory?.context).toContain(
          `${fixture.name} private value that must never share recovery`,
        );
        expect(dmHistory?.context).not.toContain(
          `${fixture.name} group context that recovery may replay`,
        );
      },
    );
  },
);
