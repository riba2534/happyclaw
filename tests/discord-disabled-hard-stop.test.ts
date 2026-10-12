import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * UF-1006: Discord guild traffic must hard-stop when activation_mode=disabled
 * before Gate1's mention-OR and before InteractionCreate App Commands.
 * shouldProcessGroupMessage returns false for BOTH when_mentioned and disabled,
 * so without resolveRegisteredGroup the @bot reopen path falsely clears sessions.
 */

const discord = vi.hoisted(() => {
  const BOT = '111111111111111111';
  const listeners = new Map<string, Array<(...args: any[]) => unknown>>();
  const onceListeners = new Map<string, Array<(...args: any[]) => unknown>>();
  const channelSend = vi.fn(async () => ({}));
  const textChannel = {
    isTextBased: () => true,
    send: channelSend,
    name: 'general',
  };
  const client = {
    user: { id: BOT, tag: 'HappyClaw#0001' },
    application: { commands: { set: vi.fn(async () => []) } },
    guilds: { cache: { values: () => [] } },
    channels: {
      fetch: vi.fn(async () => textChannel),
    },
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
    BOT,
    client,
    listeners,
    channelSend,
    textChannel,
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

const BOT = discord.BOT;

/** Mirrors index.ts shouldProcessGroupMessage for when_mentioned + disabled. */
function shouldProcessLikeIndex(activation_mode: string): boolean {
  switch (activation_mode) {
    case 'always':
      return true;
    case 'when_mentioned':
    case 'owner_mentioned':
    case 'disabled':
      return false;
    default:
      return true;
  }
}

function guildMsg(overrides: Record<string, unknown> = {}) {
  return {
    id: `m-${Math.random().toString(16).slice(2)}`,
    author: {
      bot: false,
      id: 'user-1',
      username: 'Ada',
      displayName: 'Ada',
    },
    member: { displayName: 'Ada' },
    channel: { type: discord.ChannelType.GuildText, name: 'general' },
    channelId: 'chan-1',
    guildId: 'guild-1',
    content: '',
    createdTimestamp: Date.now(),
    attachments: { values: () => [] },
    mentions: {
      has: (user: { id?: string }) => user?.id === BOT,
      users: new Map([[BOT, { id: BOT }]]),
    },
    react: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
    ...overrides,
  };
}

function guildInteraction(commandName: string) {
  return {
    isChatInputCommand: () => true,
    guildId: 'guild-1',
    channelId: 'chan-1',
    channel: { type: discord.ChannelType.GuildText, name: 'general' },
    user: { id: 'user-1', displayName: 'Ada' },
    commandName,
    options: {
      getString: () => null,
    },
    deferReply: vi.fn(async () => {}),
    editReply: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
  };
}

describe('Discord disabled hard-stop (UF-1006)', () => {
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

  async function connect(
    activation_mode: 'disabled' | 'when_mentioned',
    overrides: Record<string, unknown> = {},
  ) {
    connection = createDiscordConnection({ botToken: 'test-token' });
    const opts = {
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
      shouldProcessGroupMessage: () => shouldProcessLikeIndex(activation_mode),
      resolveRegisteredGroup: () => ({ activation_mode }),
      resolveEffectiveChatJid: (jid: string) => ({
        effectiveJid: jid,
        agentId: null,
      }),
      onCommand: vi.fn(async () => 'cleared'),
      onPairAttempt: vi.fn(async () => true),
      ...overrides,
    };
    const ok = await connection.connect(opts);
    expect(ok).toBe(true);
    return opts;
  }

  test('disabled + @bot /clear drops before onCommand (fail@parent → pass@tip)', async () => {
    const opts = await connect('disabled');
    const handlers = discord.listeners.get('messageCreate') ?? [];
    await handlers[0]?.(
      guildMsg({
        content: `<@${BOT}> /clear`,
      }),
    );
    // Allow any async settle; command must never fire.
    await new Promise((r) => setTimeout(r, 50));
    expect(opts.onCommand).not.toHaveBeenCalled();
    expect(storeMessageDirect).not.toHaveBeenCalled();
  });

  test('when_mentioned + @bot /clear still admits onCommand', async () => {
    const opts = await connect('when_mentioned');
    const handlers = discord.listeners.get('messageCreate') ?? [];
    await handlers[0]?.(
      guildMsg({
        content: `<@${BOT}> /clear`,
      }),
    );
    await vi.waitFor(() => expect(opts.onCommand).toHaveBeenCalledTimes(1));
    expect(opts.onCommand).toHaveBeenCalledWith(
      'discord:chan-1',
      'clear',
      'user-1',
      [{ imId: BOT }],
    );
    expect(storeMessageDirect).not.toHaveBeenCalled();
  });

  test('App Command on disabled guild drops with ephemeral reply (fail@parent → pass@tip)', async () => {
    const opts = await connect('disabled');
    const handlers = discord.listeners.get('interactionCreate') ?? [];
    const interaction = guildInteraction('clear');
    await handlers[0]?.(interaction);
    await new Promise((r) => setTimeout(r, 50));
    expect(opts.onCommand).not.toHaveBeenCalled();
    expect(interaction.deferReply).not.toHaveBeenCalled();
    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('disabled'),
        ephemeral: true,
      }),
    );
  });

  test('when_mentioned + no @bot still drops (control)', async () => {
    const opts = await connect('when_mentioned');
    const handlers = discord.listeners.get('messageCreate') ?? [];
    await handlers[0]?.(
      guildMsg({
        content: '/clear',
        mentions: { has: () => false, users: new Map() },
      }),
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(opts.onCommand).not.toHaveBeenCalled();
  });

  test('DiscordConnectOpts accepts resolveRegisteredGroup and uses it', async () => {
    const resolveRegisteredGroup = vi.fn(() => ({
      activation_mode: 'disabled' as const,
    }));
    const opts = await connect('disabled', { resolveRegisteredGroup });
    const handlers = discord.listeners.get('messageCreate') ?? [];
    await handlers[0]?.(guildMsg({ content: `<@${BOT}> hello` }));
    await new Promise((r) => setTimeout(r, 50));
    expect(resolveRegisteredGroup).toHaveBeenCalledWith('discord:chan-1');
    expect(opts.onCommand).not.toHaveBeenCalled();
    expect(storeMessageDirect).not.toHaveBeenCalled();
  });
});
