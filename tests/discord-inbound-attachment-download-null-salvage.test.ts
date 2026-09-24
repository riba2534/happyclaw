import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * Batch-28: wrapper attachment downloadAttachment → null used to add no label,
 * so image-only / file-only messages hit the empty gate and silently dropped
 * (no persist, no notify, no ack). Save-fail siblings already salvage [图片] /
 * [文件: name]; download-null must match. ≠ #731 snapshot attachment scope.
 */

const discord = vi.hoisted(() => {
  const listeners = new Map<string, Array<(...args: any[]) => unknown>>();
  const onceListeners = new Map<string, Array<(...args: any[]) => unknown>>();
  const client = {
    user: { id: 'bot-1', tag: 'test#0001' },
    application: { commands: { set: vi.fn(async () => []) } },
    guilds: { cache: { values: () => [] } },
    once(event: string, fn: (...args: any[]) => unknown) {
      const list = onceListeners.get(event) ?? [];
      list.push(fn);
      onceListeners.set(event, list);
    },
    on(event: string, fn: (...args: any[]) => unknown) {
      const list = listeners.get(event) ?? [];
      list.push(fn);
      listeners.set(event, list);
    },
    async login() {
      for (const fn of onceListeners.get('ready') ?? []) {
        await fn(client);
      }
    },
    async destroy() {},
    listeners,
  };
  return {
    client,
    listeners,
    onceListeners,
    ChannelType: { DM: 1, GuildText: 0, GroupDM: 3 },
    Events: {
      ClientReady: 'ready',
      InteractionCreate: 'interactionCreate',
      MessageCreate: 'messageCreate',
      GuildCreate: 'guildCreate',
      GuildDelete: 'guildDelete',
    },
    GatewayIntentBits: {
      Guilds: 1,
      GuildMessages: 2,
      DirectMessages: 4,
      MessageContent: 8,
      GuildMessageReactions: 16,
    },
    Partials: { Channel: 1, Message: 2 },
    AttachmentBuilder: class {},
  };
});

vi.mock('discord.js', () => ({
  Client: class {
    constructor() {
      return discord.client;
    }
  },
  GatewayIntentBits: discord.GatewayIntentBits,
  Events: discord.Events,
  Partials: discord.Partials,
  AttachmentBuilder: discord.AttachmentBuilder,
  ChannelType: discord.ChannelType,
}));

vi.mock('../src/db.js', () => ({
  storeChatMetadata: vi.fn(),
  storeMessageDirect: vi.fn(),
  updateChatName: vi.fn(),
}));
vi.mock('../src/message-notifier.js', () => ({
  notifyNewImMessage: vi.fn(),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { storeMessageDirect } from '../src/db.js';
import { notifyNewImMessage } from '../src/message-notifier.js';
import { createDiscordConnection } from '../src/discord.js';

function fakeMsg(overrides: Record<string, unknown> = {}) {
  return {
    id: overrides.id ?? `m-${Math.random().toString(16).slice(2)}`,
    author: { bot: false, id: 'user-1', username: 'Ada', displayName: 'Ada' },
    member: { displayName: 'Ada' },
    channel: { type: discord.ChannelType.DM },
    channelId: 'chan-1',
    content: '',
    createdTimestamp: Date.now(),
    attachments: { values: () => [] },
    mentions: { has: () => false },
    react: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
    ...overrides,
  };
}

/** Force downloadAttachment → null via !response.ok. */
function stubNullDownload() {
  const fetchMock = vi.fn(async () => ({
    ok: false,
    status: 503,
    arrayBuffer: async () => new ArrayBuffer(0),
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('Discord wrapper attachment download-null salvage', () => {
  let connection: ReturnType<typeof createDiscordConnection> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    discord.listeners.clear();
    discord.onceListeners.clear();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    if (connection) {
      await connection.disconnect();
      connection = null;
    }
  });

  async function connectAuthorized() {
    connection = createDiscordConnection({ botToken: 'test-token' });
    const ok = await connection.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
      resolveEffectiveChatJid: (jid: string) => ({
        effectiveJid: jid,
        agentId: null,
      }),
    });
    expect(ok).toBe(true);
    return connection;
  }

  test('image-only download-null persists [图片] and notifies (empty gate not hit)', async () => {
    const fetchMock = stubNullDownload();
    await connectAuthorized();
    const handlers = discord.listeners.get('messageCreate') ?? [];
    await handlers[0]?.(
      fakeMsg({
        id: 'img-null-1',
        content: '',
        attachments: {
          values: () => [
            {
              url: 'https://cdn.discord.test/photo.png',
              name: 'photo.png',
              contentType: 'image/png',
            },
          ],
        },
      }),
    );

    expect(fetchMock).toHaveBeenCalled();
    expect(storeMessageDirect).toHaveBeenCalled();
    expect(storeMessageDirect.mock.calls[0][4]).toBe('[图片]');
    expect(notifyNewImMessage).toHaveBeenCalled();
  });

  test('file-only download-null persists [文件: name] and notifies (empty gate not hit)', async () => {
    const fetchMock = stubNullDownload();
    await connectAuthorized();
    const handlers = discord.listeners.get('messageCreate') ?? [];
    await handlers[0]?.(
      fakeMsg({
        id: 'file-null-1',
        content: '',
        attachments: {
          values: () => [
            {
              url: 'https://cdn.discord.test/report.pdf',
              name: 'report.pdf',
              contentType: 'application/pdf',
            },
          ],
        },
      }),
    );

    expect(fetchMock).toHaveBeenCalled();
    expect(storeMessageDirect).toHaveBeenCalled();
    expect(storeMessageDirect.mock.calls[0][4]).toBe('[文件: report.pdf]');
    expect(notifyNewImMessage).toHaveBeenCalled();
  });
});
