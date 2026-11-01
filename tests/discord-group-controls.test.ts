import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const discord = vi.hoisted(() => {
  const listeners = new Map<string, Array<(...args: any[]) => unknown>>();
  const onceListeners = new Map<string, Array<(...args: any[]) => unknown>>();
  const sentChannel = {
    send: vi.fn(async () => ({ id: 'sent-1' })),
    isTextBased: () => true,
    sendTyping: vi.fn(async () => undefined),
  };
  const client = {
    user: { id: '900', tag: 'happy#0001' },
    application: { commands: { set: vi.fn(async () => []) } },
    guilds: { cache: { values: () => [] } },
    channels: { fetch: vi.fn(async () => sentChannel) },
    users: {
      fetch: vi.fn(async () => ({ createDM: async () => sentChannel })),
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
    client,
    listeners,
    sentChannel,
    ChannelType: { DM: 1, GuildText: 0, GroupDM: 3 },
  };
});

vi.mock('discord.js', () => ({
  Client: class {
    constructor() {
      return discord.client;
    }
  },
  GatewayIntentBits: {
    Guilds: 1,
    GuildMessages: 2,
    DirectMessages: 4,
    MessageContent: 8,
    GuildMessageReactions: 16,
  },
  Events: {
    ClientReady: 'ready',
    InteractionCreate: 'interactionCreate',
    MessageCreate: 'messageCreate',
    GuildCreate: 'guildCreate',
    GuildDelete: 'guildDelete',
  },
  Partials: { Channel: 1, Message: 2 },
  AttachmentBuilder: class {},
  ChannelType: discord.ChannelType,
}));
vi.mock('../src/db.js', () => ({
  storeChatMetadata: vi.fn(),
  storeMessageDirect: vi.fn(),
  updateChatName: vi.fn(),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { storeMessageDirect } from '../src/db.js';
import {
  createDiscordConnection,
  discordAddressedText,
  discordCommandMentions,
  type DiscordConnectOpts,
} from '../src/discord.js';
import { STEER_TARGET_MISSING_REPLY } from '../src/im-connector-follow-up.js';
import { followUpHost } from './helpers/follow-up-host.js';
import {
  groupAudienceHost,
  type AudienceGroup,
} from './helpers/group-audience.js';

const GUILD_JID = 'discord:chan-1';
const BOT = discord.client.user.id;
let seq = 0;

interface FakeUser {
  id: string;
  bot?: boolean;
}

function guildMsg(input: {
  author: string;
  content: string;
  mentioned?: FakeUser[];
  dm?: boolean;
  attachments?: object[];
}) {
  seq += 1;
  const mentioned = new Map(
    (input.mentioned ?? []).map((user) => [user.id, user]),
  );
  return {
    id: `m-${seq}`,
    author: {
      bot: false,
      id: input.author,
      username: input.author,
      displayName: input.author,
    },
    member: { displayName: input.author },
    channel: {
      type: input.dm ? discord.ChannelType.DM : discord.ChannelType.GuildText,
      name: 'general',
    },
    channelId: 'chan-1',
    content: input.content,
    createdTimestamp: Date.now(),
    attachments: { values: () => input.attachments ?? [] },
    mentions: {
      has: (user: FakeUser) => mentioned.has(user.id),
      users: mentioned,
    },
    react: vi.fn(async () => {}),
    reply: vi.fn(async () => {}),
  };
}

describe('Discord guild response audience', () => {
  let connection: ReturnType<typeof createDiscordConnection> | null = null;
  let groups: Record<string, AudienceGroup>;
  let onCommand: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    discord.listeners.clear();
    groups = {};
    onCommand = vi.fn(async (_jid: string, command: string) =>
      command.startsWith('status') || command.startsWith('owner_mention')
        ? 'ok'
        : null,
    );
  });

  afterEach(async () => {
    await connection?.disconnect();
    connection = null;
  });

  async function connect(
    group?: AudienceGroup,
    overrides: Partial<DiscordConnectOpts> = {},
  ) {
    if (group) groups[GUILD_JID] = group;
    const host = groupAudienceHost('discord', groups);
    connection = createDiscordConnection({ botToken: 'test-token' });
    await connection.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
      resolveEffectiveChatJid: (jid: string) => ({
        effectiveJid: jid,
        agentId: null,
      }),
      onCommand,
      ...host,
      ...overrides,
    });
    const handler = discord.listeners.get('messageCreate')![0]!;
    return {
      host,
      deliver: (msg: ReturnType<typeof guildMsg>) => handler(msg),
    };
  }

  test('owner_only: the owner reaches the Agent, another member does not', async () => {
    const { deliver } = await connect({
      audience_mode: 'owner_only',
      owner_im_id: '1',
    });
    await deliver(guildMsg({ author: '1', content: 'hi' }));
    await deliver(guildMsg({ author: '2', content: 'hi' }));
    await deliver(
      guildMsg({
        author: '2',
        content: `<@${BOT}> /status`,
        mentioned: [{ id: BOT, bot: true }],
      }),
    );
    expect(storeMessageDirect).toHaveBeenCalledOnce();
    expect(vi.mocked(storeMessageDirect).mock.calls[0][2]).toBe('discord:1');
    expect(onCommand).not.toHaveBeenCalled();
  });

  test('allowlist: listed members pass, others are dropped', async () => {
    const { deliver } = await connect({
      audience_mode: 'everyone',
      owner_im_id: '1',
      sender_allowlist: ['1', '2'],
    });
    await deliver(guildMsg({ author: '2', content: 'listed' }));
    await deliver(guildMsg({ author: '3', content: 'not listed' }));
    expect(storeMessageDirect).toHaveBeenCalledOnce();
    expect(vi.mocked(storeMessageDirect).mock.calls[0][4]).toBe('listed');
  });

  test('everyone without an allowlist admits every member', async () => {
    const { deliver } = await connect({ audience_mode: 'everyone' });
    await deliver(guildMsg({ author: '2', content: 'a' }));
    await deliver(guildMsg({ author: '3', content: 'b' }));
    expect(storeMessageDirect).toHaveBeenCalledTimes(2);
  });

  test('DMs never consult the group gate', async () => {
    const { host, deliver } = await connect();
    host.isSenderAllowedInGroup.mockReturnValue(false);
    await deliver(guildMsg({ author: '3', content: 'dm', dm: true }));
    expect(storeMessageDirect).toHaveBeenCalledOnce();
    expect(host.isSenderAllowedInGroup).not.toHaveBeenCalled();
  });

  test('an unowned owner_only channel can only be claimed with /owner_mention', async () => {
    const { deliver } = await connect({ audience_mode: 'owner_only' });
    await deliver(guildMsg({ author: '2', content: '/status' }));
    expect(onCommand).not.toHaveBeenCalled();
    await deliver(
      guildMsg({
        author: '2',
        content: `<@${BOT}> /owner_mention`,
        mentioned: [{ id: BOT, bot: true }],
      }),
    );
    expect(onCommand).toHaveBeenCalledWith(GUILD_JID, 'owner_mention', '2', []);
  });

  test('/allow hands the host the members named in the content', async () => {
    const { deliver } = await connect({
      audience_mode: 'everyone',
      owner_im_id: '1',
    });
    await deliver(
      guildMsg({
        author: '1',
        content: `<@${BOT}> /allow <@!2>`,
        mentioned: [{ id: BOT, bot: true }, { id: '2' }, { id: '4' }],
      }),
    );
    expect(onCommand).toHaveBeenCalledWith(GUILD_JID, 'allow', '1', [
      { imId: '2' },
    ]);
  });
});

describe('Discord audience: /owner_mention and native commands', () => {
  let connection: ReturnType<typeof createDiscordConnection> | null = null;
  let groups: Record<string, AudienceGroup>;
  let onCommand: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    discord.listeners.clear();
    groups = {};
    onCommand = vi.fn(async (_jid: string, command: string) =>
      command.startsWith('owner_mention') ? 'claimed' : 'status text',
    );
  });

  afterEach(async () => {
    await connection?.disconnect();
    connection = null;
  });

  async function connect(group: AudienceGroup) {
    groups[GUILD_JID] = group;
    connection = createDiscordConnection({ botToken: 'test-token' });
    await connection.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
      resolveEffectiveChatJid: (jid: string) => ({
        effectiveJid: jid,
        agentId: null,
      }),
      onCommand,
      ...groupAudienceHost('discord', groups),
    });
  }

  function interaction(user: string, commandName: string, enabled?: string) {
    return {
      isChatInputCommand: () => true,
      channel: { type: discord.ChannelType.GuildText, name: 'general' },
      guildId: 'guild-1',
      channelId: 'chan-1',
      user: { id: user, displayName: user },
      commandName,
      options: {
        getString: (name: string) => (name === 'enabled' ? enabled : null),
      },
      deferReply: vi.fn(async () => undefined),
      editReply: vi.fn(async () => undefined),
    };
  }

  test('a multi-line /owner_mention that is not dispatched is dropped', async () => {
    await connect({ audience_mode: 'owner_only' });
    const handler = discord.listeners.get('messageCreate')![0]!;
    await handler(
      guildMsg({
        author: '2',
        content: `<@${BOT}> /owner_mention\nA\nB`,
        mentioned: [{ id: BOT, bot: true }],
      }),
    );
    expect(onCommand).not.toHaveBeenCalled();
    expect(storeMessageDirect).not.toHaveBeenCalled();
  });

  test('native slash commands pass the same audience gate', async () => {
    await connect({ audience_mode: 'owner_only', owner_im_id: '1' });
    const handler = discord.listeners.get('interactionCreate')![0]!;

    const outsider = interaction('2', 'status');
    await handler(outsider);
    expect(onCommand).not.toHaveBeenCalled();
    expect(outsider.editReply).toHaveBeenCalledWith(
      '⚠️ 本频道只响应指定成员，命令未执行。',
    );

    const toggle = interaction('2', 'require_mention', 'false');
    await handler(toggle);
    expect(onCommand).not.toHaveBeenCalled();

    await handler(interaction('1', 'status'));
    expect(onCommand).toHaveBeenCalledWith(GUILD_JID, 'status', '1');
  });

  test('a native /owner_mention can claim an unowned owner_only channel', async () => {
    await connect({ audience_mode: 'owner_only' });
    const handler = discord.listeners.get('interactionCreate')![0]!;
    await handler(interaction('2', 'status'));
    expect(onCommand).not.toHaveBeenCalled();
    await handler(interaction('2', 'owner_mention'));
    expect(onCommand).toHaveBeenCalledWith(GUILD_JID, 'owner_mention', '2');
  });
});

describe('discordCommandMentions', () => {
  test('only users named by a mention token, never bots or reply pings', () => {
    expect(
      discordCommandMentions('<@900> /allow <@2> <@!3>', [
        { id: '900', bot: true },
        { id: '2' },
        { id: '3' },
        { id: '4' },
      ]),
    ).toEqual([{ imId: '2' }, { imId: '3' }]);
  });
});

describe('Discord durable queue and runtime controls', () => {
  let connection: ReturnType<typeof createDiscordConnection> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    discord.listeners.clear();
  });

  afterEach(async () => {
    await connection?.disconnect();
    connection = null;
  });

  async function connect(
    host: ReturnType<typeof followUpHost>,
    overrides: Partial<DiscordConnectOpts> = {},
  ) {
    connection = createDiscordConnection({ botToken: 'test-token' });
    const route = (jid: string) => ({ effectiveJid: jid, agentId: null });
    const opts = {
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
      resolveEffectiveChatJid: vi.fn(route),
      lookupEffectiveChatJid: vi.fn(route),
      onCommand: vi.fn(async () => null),
      onMessagePersisted: vi.fn(),
      ...host,
      ...overrides,
    };
    await connection.connect(opts);
    const handler = discord.listeners.get('messageCreate')![0]!;
    return {
      opts,
      deliver: (msg: ReturnType<typeof guildMsg>) => handler(msg),
    };
  }

  test('a control for a chat without a Session only looks it up', async () => {
    const host = followUpHost('queued');
    const { opts, deliver } = await connect(host, {
      lookupEffectiveChatJid: vi.fn(() => null),
    });
    await deliver(guildMsg({ author: '5', content: '/break', dm: true }));
    expect(host.onSessionBreak).toHaveBeenCalledWith(
      expect.objectContaining({ targetJid: undefined }),
    );
    await deliver(guildMsg({ author: '5', content: '/steer go', dm: true }));
    expect(discord.sentChannel.send).toHaveBeenLastCalledWith(
      STEER_TARGET_MISSING_REPLY,
    );
    expect(opts.lookupEffectiveChatJid).toHaveBeenCalledWith('discord:dm:5');
    expect(opts.resolveEffectiveChatJid).not.toHaveBeenCalled();
    expect(storeMessageDirect).not.toHaveBeenCalled();
  });

  test('an input arriving during a run waits in the durable queue', async () => {
    const host = followUpHost('queued');
    const { opts, deliver } = await connect(host);
    await deliver(guildMsg({ author: '5', content: 'later', dm: true }));
    expect(host.onFollowUpMessage.mock.calls[0][0]).toMatchObject({
      targetJid: 'discord:dm:5',
      sourceJid: 'discord:dm:5',
      senderImId: 'discord:5',
    });
    expect(opts.onMessagePersisted.mock.calls[0][1]).toMatchObject({
      delivery_status: 'queued',
    });
    expect(host.onFollowUpsChanged).toHaveBeenCalledWith('discord:dm:5');
  });

  test('with no active run the input starts a turn as before', async () => {
    const host = followUpHost('started');
    const { deliver } = await connect(host);
    await deliver(guildMsg({ author: '5', content: 'now', dm: true }));
    expect(host.onFollowUpMessage).toHaveBeenCalledOnce();
  });

  test('/steer and /break in a DM', async () => {
    const host = followUpHost('queued');
    const { opts, deliver } = await connect(host);
    await deliver(
      guildMsg({ author: '5', content: '/steer go left', dm: true }),
    );
    expect(vi.mocked(storeMessageDirect).mock.calls[0][4]).toBe('go left');
    expect(host.onFollowUpMessage.mock.calls[0][0]).toMatchObject({
      requestedMode: 'steer',
    });
    expect(opts.onCommand).not.toHaveBeenCalled();

    await deliver(guildMsg({ author: '5', content: '/break', dm: true }));
    expect(host.onSessionBreak).toHaveBeenCalledWith({
      sourceJid: 'discord:dm:5',
      targetJid: 'discord:dm:5',
      senderImId: '5',
      chatType: 'p2p',
    });
    expect(discord.sentChannel.send).toHaveBeenCalledWith(
      'Current task stopped.',
    );
    expect(storeMessageDirect).toHaveBeenCalledTimes(1);
  });

  test('a guild control needs a leading @Bot that Discord resolved', async () => {
    const host = followUpHost('started');
    const { deliver } = await connect(host);
    await deliver(guildMsg({ author: '5', content: '/break' }));
    await deliver(
      guildMsg({ author: '5', content: `<@${BOT}> /break`, mentioned: [] }),
    );
    expect(host.onSessionBreak).not.toHaveBeenCalled();

    await deliver(
      guildMsg({
        author: '5',
        content: `<@!${BOT}> /break`,
        mentioned: [{ id: BOT, bot: true }],
      }),
    );
    expect(host.onSessionBreak).toHaveBeenCalledWith(
      expect.objectContaining({ sourceJid: GUILD_JID, chatType: 'group' }),
    );
  });

  test('/break with an attachment is ordinary input', async () => {
    const host = followUpHost('started');
    const { deliver } = await connect(host);
    await deliver(
      guildMsg({
        author: '5',
        content: '/break',
        dm: true,
        // Oversized, so the connector records a marker without downloading.
        attachments: [
          { name: 'a.txt', size: 10 ** 12, url: 'https://cdn.test/a.txt' },
        ],
      }),
    );
    expect(host.onSessionBreak).not.toHaveBeenCalled();
  });
});

describe('discordAddressedText', () => {
  test('a leading resolved bot mention only', () => {
    const users = new Map([['900', {}]]);
    expect(discordAddressedText('<@900> /break', users, '900')).toBe('/break');
    expect(discordAddressedText('<@!900>/break', users, '900')).toBe('/break');
    expect(discordAddressedText('/break <@900>', users, '900')).toBeNull();
    expect(discordAddressedText('<@901> /break', users, '900')).toBeNull();
    expect(discordAddressedText('<@900> /break', new Map(), '900')).toBeNull();
    expect(discordAddressedText('<@900> /break', users, undefined)).toBeNull();
  });
});
