import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * discord.js Message.system is `!NonSystemMessageTypes.includes(type)` where
 * NonSystemMessageTypes = Default(0), Reply(19), ChatInputCommand(20),
 * ContextMenuCommand(23). Plain-object mocks below set `system` to match that
 * for each exercised type (THREAD_CREATED=18 / CHANNEL_NAME_CHANGE=4 => true;
 * Default/Reply/ChatInputCommand => false).
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
  };
  return {
    client,
    listeners,
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

vi.mock('discord.js', async () => {
  const actual =
    await vi.importActual<typeof import('discord.js')>('discord.js');
  return {
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
    MessageType: actual.MessageType,
  };
});

vi.mock('../src/db.js', () => ({
  storeChatMetadata: vi.fn(),
  storeMessageDirect: vi.fn(),
  updateChatName: vi.fn(),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { storeMessageDirect } from '../src/db.js';
import { createDiscordConnection } from '../src/discord.js';

/** Build a real discord.js Message to pin library `system` semantics. */
async function realDiscordJsMessage(raw: Record<string, unknown>) {
  const actual =
    await vi.importActual<typeof import('discord.js')>('discord.js');
  const client = new actual.Client({ intents: [] });
  try {
    const m = Reflect.construct(actual.Message, [client, raw]) as {
      type: number;
      system: boolean;
      content: string;
      author?: { bot?: boolean };
    };
    return {
      type: m.type,
      system: m.system,
      content: m.content,
      authorBot: m.author?.bot,
      MessageType: actual.MessageType,
    };
  } finally {
    await client.destroy();
  }
}

function guildMsg(overrides: Record<string, unknown>) {
  return {
    id: `m-${Math.random().toString(16).slice(2)}`,
    author: { bot: false, id: 'user-1', username: 'Ada', displayName: 'Ada' },
    member: { displayName: 'Ada' },
    channel: { type: discord.ChannelType.GuildText, name: 'general' },
    channelId: 'chan-1',
    content: '',
    createdTimestamp: Date.now(),
    attachments: { values: () => [] },
    mentions: { has: () => false, users: new Map() },
    react: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
    ...overrides,
  };
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 20));
}

describe('Discord skip system messages', () => {
  let connection: ReturnType<typeof createDiscordConnection> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    discord.listeners.clear();
  });

  afterEach(async () => {
    if (connection) {
      await connection.disconnect();
      connection = null;
    }
  });

  async function connect() {
    connection = createDiscordConnection({ botToken: 'test-token' });
    const ok = await connection.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
      shouldProcessGroupMessage: () => true,
      resolveEffectiveChatJid: (jid: string) => ({
        effectiveJid: jid,
        agentId: null,
      }),
    });
    expect(ok).toBe(true);
  }

  test('discord.js: THREAD_CREATED / CHANNEL_NAME_CHANGE are non-bot system with name content', async () => {
    const tc = await realDiscordJsMessage({
      id: '1',
      channel_id: 'chan-1',
      type: 18,
      content: 'Q3 launch retro',
      author: { id: 'user-1', username: 'Ada', discriminator: '0' },
      message_reference: { channel_id: 'thread-9', guild_id: 'g' },
    });
    expect(tc.type).toBe(tc.MessageType.ThreadCreated);
    expect(tc.system).toBe(true);
    expect(tc.authorBot).toBe(false);
    expect(tc.content).toBe('Q3 launch retro');

    const rn = await realDiscordJsMessage({
      id: '2',
      channel_id: 'chan-1',
      type: 4,
      content: 'renamed-topic',
      author: { id: 'user-1', username: 'Ada', discriminator: '0' },
    });
    expect(rn.type).toBe(rn.MessageType.ChannelNameChange);
    expect(rn.system).toBe(true);
    expect(rn.content).toBe('renamed-topic');
  });

  test('discord.js: Default / Reply / ChatInputCommand are non-system', async () => {
    for (const [type, label] of [
      [0, 'Default'],
      [19, 'Reply'],
      [20, 'ChatInputCommand'],
    ] as const) {
      const m = await realDiscordJsMessage({
        id: `ctl-${type}`,
        channel_id: 'chan-1',
        type,
        content: label,
        author: { id: 'user-1', username: 'Ada', discriminator: '0' },
      });
      expect(m.system).toBe(false);
    }
  });

  test('THREAD_CREATED is not stored and does not notify', async () => {
    await connect();
    const handlers = discord.listeners.get('messageCreate') ?? [];
    await handlers[0]?.(
      guildMsg({
        id: 'sys-thread-1',
        type: 18,
        system: true,
        content: 'Q3 launch retro',
      }),
    );
    await settle();
    expect(storeMessageDirect).not.toHaveBeenCalled();
  });

  test('CHANNEL_NAME_CHANGE is not stored and does not notify', async () => {
    await connect();
    const handlers = discord.listeners.get('messageCreate') ?? [];
    await handlers[0]?.(
      guildMsg({
        id: 'sys-rename-1',
        type: 4,
        system: true,
        content: 'renamed-topic',
      }),
    );
    await settle();
    expect(storeMessageDirect).not.toHaveBeenCalled();
  });

  test('control: Default (type 0) still persists', async () => {
    await connect();
    const handlers = discord.listeners.get('messageCreate') ?? [];
    await handlers[0]?.(
      guildMsg({
        id: 'user-default-1',
        type: 0,
        system: false,
        content: 'hello bot',
      }),
    );
    await settle();
    expect((storeMessageDirect as any).mock.calls[0]?.[4]).toBe('hello bot');
  });

  test('control: Reply (type 19) still persists', async () => {
    await connect();
    const handlers = discord.listeners.get('messageCreate') ?? [];
    await handlers[0]?.(
      guildMsg({
        id: 'user-reply-1',
        type: 19,
        system: false,
        content: 'following up',
      }),
    );
    await settle();
    expect((storeMessageDirect as any).mock.calls[0]?.[4]).toBe('following up');
  });

  test('control: ChatInputCommand (type 20) still persists', async () => {
    await connect();
    const handlers = discord.listeners.get('messageCreate') ?? [];
    await handlers[0]?.(
      guildMsg({
        id: 'user-slash-1',
        type: 20,
        system: false,
        content: '/ask something',
      }),
    );
    await settle();
    expect((storeMessageDirect as any).mock.calls[0]?.[4]).toBe(
      '/ask something',
    );
  });
});
