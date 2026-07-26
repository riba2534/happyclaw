import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const tmpDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'channel-turn-context-test-'),
);
const storeDir = path.join(tmpDir, 'db');
const groupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config.js')>()),
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
  DATA_DIR: tmpDir,
}));

const db = await import('../src/db.js');
const { buildFeishuChannelTurnContext } = await import('../src/feishu.js');

beforeAll(() => db.initDatabase());

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('message-level ChannelTurnContext', () => {
  test('sanitizes and structures all available Feishu turn identifiers', () => {
    const context = buildFeishuChannelTurnContext({
      appId: 'cli_public_app',
      configuredChannelAccountId: 'account-fallback',
      bot: {
        openId: 'ou_bot',
        name: 'E2E Bot',
        avatarUrl: 'https://example.test/bot.png',
      },
      chat: {
        id: 'oc_group',
        type: 'group',
        name: 'AIAM-E2E-话题测试群',
        mode: 'topic',
        groupMessageType: 'thread',
      },
      message: {
        id: 'om_message',
        rootId: 'om_root',
        parentId: 'om_parent',
        threadId: 'omt_thread',
        type: 'text',
      },
      sender: {
        openId: 'ou_sender',
        userId: 'u_sender',
        unionId: 'on_sender',
        name: 'Alice',
        tenantKey: 'tenant_public',
        type: 'user',
      },
      mentions: [
        {
          key: '@_user_1',
          name: 'E2E Bot',
          id: {
            open_id: 'ou_bot',
            user_id: 'u_bot',
            union_id: 'on_bot',
          },
        },
      ],
      sourceJid:
        'feishu:oc_group#account:account-scoped#thread:omt_thread#root:om_root',
      targetJid: 'web:main',
      sessionAgentId: 'agent-1',
    });

    expect(context).toMatchObject({
      schemaVersion: 1,
      provider: 'feishu',
      channelAccountId: 'account-scoped',
      sourceJid:
        'feishu:oc_group#account:account-scoped#thread:omt_thread#root:om_root',
      targetJid: 'web:main',
      sessionAgentId: 'agent-1',
      bot: { appId: 'cli_public_app', openId: 'ou_bot', name: 'E2E Bot' },
      chat: {
        id: 'oc_group',
        type: 'group',
        mode: 'topic',
        groupMessageType: 'thread',
        isTopicStyle: true,
      },
      message: {
        id: 'om_message',
        rootId: 'om_root',
        parentId: 'om_parent',
        threadId: 'omt_thread',
      },
      sender: {
        openId: 'ou_sender',
        userId: 'u_sender',
        unionId: 'on_sender',
        name: 'Alice',
        tenantKey: 'tenant_public',
        type: 'user',
      },
      mentions: [
        {
          key: '@_user_1',
          name: 'E2E Bot',
          openId: 'ou_bot',
          userId: 'u_bot',
          unionId: 'on_bot',
        },
      ],
      capabilities: expect.arrayContaining([
        'get_channel_context',
        'send_file',
        'feishu_get_chat',
        'feishu_get_history',
        'feishu_send_card',
        'feishu_api_request',
      ]),
    });
    expect(JSON.stringify(context)).not.toContain('secret');
    expect(JSON.stringify(context)).not.toContain('token');
  });

  test('persists and rehydrates context through incremental and history reads', () => {
    const chatJid = 'web:channel-context';
    db.ensureChatExists(chatJid);
    const context = buildFeishuChannelTurnContext({
      appId: 'cli_app',
      bot: { openId: 'ou_bot' },
      chat: { id: 'oc_chat', type: 'group' },
      message: { id: 'om_1', rootId: 'om_1', type: 'text' },
      sender: { openId: 'ou_sender', name: 'Alice' },
      sourceJid: 'feishu:oc_chat#account:account-1#root:om_1',
      targetJid: chatJid,
    });

    db.storeMessageDirect(
      'om_1',
      chatJid,
      'ou_sender',
      'Alice',
      'hello',
      '2026-07-22T00:00:00.000Z',
      false,
      { sourceJid: context.sourceJid, channelContext: context },
    );

    const incremental = db.getMessagesSince(chatJid, {
      timestamp: '',
      id: '',
    });
    expect(incremental[0].channel_context).toEqual(context);
    expect(db.getMessagesPage(chatJid)[0].channel_context).toEqual(context);
    expect(db.getMessageChannelTurnContext(chatJid, 'om_1')).toEqual(context);

    const raw = new Database(path.join(storeDir, 'messages.db'), {
      readonly: true,
    });
    const columns = raw.prepare('PRAGMA table_info(messages)').all() as Array<{
      name: string;
    }>;
    expect(columns.map((column) => column.name)).toContain('channel_context');
    const stored = raw
      .prepare(
        'SELECT channel_context FROM messages WHERE id = ? AND chat_jid = ?',
      )
      .get('om_1', chatJid) as { channel_context: string };
    expect(JSON.parse(stored.channel_context)).toEqual(context);
    raw.close();
  });

  test('keeps legacy rows without context readable', () => {
    const chatJid = 'web:legacy-context';
    db.ensureChatExists(chatJid);
    db.storeMessageDirect(
      'legacy-1',
      chatJid,
      'user',
      'Legacy user',
      'legacy message',
      '2026-07-22T00:00:01.000Z',
      false,
    );
    expect(db.getMessagesPage(chatJid)[0].channel_context).toBeUndefined();
  });

  test('migrates a v58 database by adding the nullable context column', () => {
    db.closeDatabase();
    const legacy = new Database(path.join(storeDir, 'messages.db'));
    legacy.exec(`
      ALTER TABLE messages DROP COLUMN channel_context;
      UPDATE router_state SET value = '58' WHERE key = 'schema_version';
    `);
    legacy.close();

    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe(
      String(db.CURRENT_SCHEMA_VERSION),
    );
    expect(db.getMessagesPage('web:legacy-context')[0].channel_context).toBe(
      undefined,
    );
    const migrated = new Database(path.join(storeDir, 'messages.db'), {
      readonly: true,
    });
    const columns = migrated
      .prepare('PRAGMA table_info(messages)')
      .all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain('channel_context');
    migrated.close();
  });
});
