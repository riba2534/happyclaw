import { beforeEach, describe, expect, test, vi } from 'vitest';

const discord = vi.hoisted(() => {
  let capturedOptions: any = null;
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
    get capturedOptions() {
      return capturedOptions;
    },
    set capturedOptions(opts: any) {
      capturedOptions = opts;
    },
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
    constructor(options: any) {
      discord.capturedOptions = options;
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
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createDiscordConnection } from '../src/discord.js';

describe('createDiscordConnection Client options wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    discord.capturedOptions = null;
  });

  test('constructs discord.js Client with rest: { retries: 0 }', async () => {
    const connection = createDiscordConnection({ botToken: 'test-token' });
    const ok = await connection.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
      resolveEffectiveChatJid: (jid: string) => ({
        effectiveJid: jid,
        agentId: null,
      }),
    });
    expect(ok).toBe(true);

    expect(discord.capturedOptions).toBeDefined();
    expect(discord.capturedOptions?.rest).toBeDefined();
    expect(discord.capturedOptions?.rest?.retries).toBe(0);

    await connection.disconnect();
  });
});
