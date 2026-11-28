import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * UF-984: Discord MessageCreate must strip only this bot's <@botId>
 * before admission / slash / persist. Tip used raw msg.content for
 * evaluateChannelAdmission, then later replace(/<@!?\d+>/g,'') stripped
 * EVERY user mention — so under default require_mention=false,
 * "<@alice> /clear" false-fired slash and "@bot tell @alice hi" lost alice.
 */

const discord = vi.hoisted(() => {
  const BOT = '111111111111111111';
  const ALICE = '222222222222222222';
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
    ALICE,
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
const ALICE = discord.ALICE;

function guildMsg(overrides: Record<string, unknown>) {
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

describe('Discord bot-only mention strip (UF-984)', () => {
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

  async function connect(overrides: Record<string, unknown> = {}) {
    connection = createDiscordConnection({ botToken: 'test-token' });
    const opts = {
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
      shouldProcessGroupMessage: () => true,
      resolveEffectiveChatJid: (jid: string) => ({
        effectiveJid: jid,
        agentId: null,
      }),
      onCommand: vi.fn(async () => 'ok'),
      onPairAttempt: vi.fn(async () => true),
      ...overrides,
    };
    const ok = await connection.connect(opts);
    expect(ok).toBe(true);
    return opts;
  }

  test('<@alice> /clear must NOT become a slash command (fail@parent → pass@tip)', async () => {
    const opts = await connect();
    const handlers = discord.listeners.get('messageCreate') ?? [];
    await handlers[0]?.(
      guildMsg({
        content: `<@${ALICE}> /clear`,
        mentions: { has: () => false, users: new Map() },
      }),
    );
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalledTimes(1));
    expect(opts.onCommand).not.toHaveBeenCalled();
    expect(vi.mocked(storeMessageDirect).mock.calls[0][4]).toBe(
      `<@${ALICE}> /clear`,
    );
  });

  test('<@bot> tell <@alice> hi keeps alice mention in persisted content', async () => {
    const opts = await connect();
    const handlers = discord.listeners.get('messageCreate') ?? [];
    await handlers[0]?.(
      guildMsg({
        content: `<@${BOT}> tell <@${ALICE}> hi`,
      }),
    );
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalledTimes(1));
    expect(opts.onCommand).not.toHaveBeenCalled();
    expect(vi.mocked(storeMessageDirect).mock.calls[0][4]).toBe(
      `tell <@${ALICE}> hi`,
    );
  });

  test('<@bot> /pair CODE pairs when unpaired (fail@parent → pass@tip)', async () => {
    const opts = await connect({
      isChatAuthorized: () => false,
      resolveEffectiveChatJid: vi.fn(() => {
        throw new Error('must not route pairing');
      }),
    });
    const handlers = discord.listeners.get('messageCreate') ?? [];
    const msg = guildMsg({
      content: `<@${BOT}> /pair ABC123`,
    });
    await handlers[0]?.(msg);
    await vi.waitFor(() => expect(opts.onPairAttempt).toHaveBeenCalled());
    expect(opts.onPairAttempt).toHaveBeenCalledWith(
      'discord:chan-1',
      'general',
      'ABC123',
    );
    expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining('配对成功'));
    expect(storeMessageDirect).not.toHaveBeenCalled();
    expect(opts.resolveEffectiveChatJid).not.toHaveBeenCalled();
  });

  test('control: <@bot> /clear and <@!bot> /status still reach onCommand', async () => {
    const opts = await connect();
    const handlers = discord.listeners.get('messageCreate') ?? [];

    await handlers[0]?.(guildMsg({ content: `<@${BOT}> /clear` }));
    await vi.waitFor(() => expect(opts.onCommand).toHaveBeenCalledTimes(1));
    expect(opts.onCommand).toHaveBeenCalledWith(
      'discord:chan-1',
      'clear',
      'user-1',
      [{ imId: BOT }],
    );

    await handlers[0]?.(guildMsg({ content: `<@!${BOT}> /status` }));
    await vi.waitFor(() => expect(opts.onCommand).toHaveBeenCalledTimes(2));
    expect(opts.onCommand).toHaveBeenLastCalledWith(
      'discord:chan-1',
      'status',
      'user-1',
      [{ imId: BOT }],
    );
    expect(storeMessageDirect).not.toHaveBeenCalled();
  });

  test('control: bare /pair still pairs', async () => {
    const opts = await connect({
      isChatAuthorized: () => false,
    });
    const handlers = discord.listeners.get('messageCreate') ?? [];
    const msg = guildMsg({ content: '/pair CODE-9' });
    await handlers[0]?.(msg);
    await vi.waitFor(() => expect(opts.onPairAttempt).toHaveBeenCalled());
    expect(opts.onPairAttempt).toHaveBeenCalledWith(
      'discord:chan-1',
      'general',
      'CODE-9',
    );
  });
});
