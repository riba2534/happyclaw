import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

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
import {
  createDiscordConnection,
  discordSupplementalInboundText,
} from '../src/discord.js';

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

describe('discordSupplementalInboundText', () => {
  test('sticker-only uses sticker name', () => {
    expect(
      discordSupplementalInboundText({
        stickers: { values: () => [{ name: 'wave' }] },
      }),
    ).toBe('[表情包: wave]');
  });

  test('forward snapshot content is kept', () => {
    expect(
      discordSupplementalInboundText({
        messageSnapshots: {
          values: () => [{ message: { content: 'forwarded hello' } }],
        },
      }),
    ).toBe('forwarded hello');
  });
});

function snapshotImageOnlyMsg(id: string) {
  return fakeMsg({
    id,
    content: '',
    attachments: { values: () => [] },
    messageSnapshots: {
      values: () => [
        {
          message: {
            content: '',
            attachments: {
              values: () => [
                {
                  url: 'https://cdn.discord.test/forward.png',
                  name: 'forward.png',
                  contentType: 'image/png',
                },
              ],
            },
          },
        },
      ],
    },
  });
}

const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

function stubPngFetch() {
  const fetchMock = vi.fn(async () => ({
    ok: true,
    arrayBuffer: async () => PNG_BYTES.buffer,
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('Discord empty-gate live persist', () => {
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
    vi.unstubAllGlobals();
  });

  async function connect(
    authorized = true,
    overrides: Record<string, unknown> = {},
  ) {
    connection = createDiscordConnection({ botToken: 'test-token' });
    const ok = await connection.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => authorized,
      resolveEffectiveChatJid: (jid: string) => ({
        effectiveJid: jid,
        agentId: null,
      }),
      ...overrides,
    });
    expect(ok).toBe(true);
    return connection;
  }

  test('sticker-only message persists and notifies', async () => {
    await connect();
    const handlers = discord.listeners.get('messageCreate') ?? [];
    await handlers[0]?.(
      fakeMsg({
        id: 'sticker-1',
        stickers: { values: () => [{ name: 'wave' }] },
      }),
    );
    expect(storeMessageDirect).toHaveBeenCalled();
    expect(storeMessageDirect.mock.calls[0][4]).toBe('[表情包: wave]');
    expect(notifyNewImMessage).toHaveBeenCalled();
  });

  test('forwarded snapshot with content persists', async () => {
    await connect();
    const handlers = discord.listeners.get('messageCreate') ?? [];
    await handlers[0]?.(
      fakeMsg({
        id: 'snap-1',
        messageSnapshots: {
          values: () => [{ message: { content: 'forwarded hello' } }],
        },
      }),
    );
    expect(storeMessageDirect).toHaveBeenCalled();
    expect(storeMessageDirect.mock.calls[0][4]).toBe('forwarded hello');
    expect(notifyNewImMessage).toHaveBeenCalled();
  });

  test('unauthorized sticker-only does not persist', async () => {
    await connect(false);
    const handlers = discord.listeners.get('messageCreate') ?? [];
    await handlers[0]?.(
      fakeMsg({
        id: 'sticker-deny',
        stickers: { values: () => [{ name: 'wave' }] },
      }),
    );
    expect(storeMessageDirect).not.toHaveBeenCalled();
    expect(notifyNewImMessage).not.toHaveBeenCalled();
  });

  test('empty message still does not persist', async () => {
    await connect();
    const handlers = discord.listeners.get('messageCreate') ?? [];
    await handlers[0]?.(fakeMsg({ id: 'empty-1' }));
    expect(storeMessageDirect).not.toHaveBeenCalled();
  });

  test('snapshot-with-attachments-only persists, downloads, and notifies once', async () => {
    const fetchMock = stubPngFetch();
    await connect();
    const handlers = discord.listeners.get('messageCreate') ?? [];
    await handlers[0]?.(snapshotImageOnlyMsg('snap-att-1'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://cdn.discord.test/forward.png',
    );
    expect(storeMessageDirect).toHaveBeenCalledTimes(1);
    expect(storeMessageDirect.mock.calls[0][4]).toBe('[图片]');
    expect(storeMessageDirect.mock.calls[0][7]).toEqual(
      expect.objectContaining({
        attachments: expect.stringContaining('"type":"image"'),
      }),
    );
    expect(notifyNewImMessage).toHaveBeenCalledTimes(1);
  });

  test('unauthorized snapshot-with-attachments-only does not persist', async () => {
    const fetchMock = stubPngFetch();
    await connect(false);
    const handlers = discord.listeners.get('messageCreate') ?? [];
    await handlers[0]?.(snapshotImageOnlyMsg('snap-att-deny'));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storeMessageDirect).not.toHaveBeenCalled();
    expect(notifyNewImMessage).not.toHaveBeenCalled();
  });

  test('disconnect fences a held media callback and a new connection stores redelivery once', async () => {
    let releaseDownload!: (response: unknown) => void;
    let admittedSignal: AbortSignal | undefined;
    const heldFetch = vi.fn(
      async (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((resolve) => {
          admittedSignal = init?.signal;
          releaseDownload = resolve;
        }),
    );
    vi.stubGlobal('fetch', heldFetch);

    const onMessagePersisted = vi.fn();
    await connect(true, { onMessagePersisted });
    const inbound = fakeMsg({
      id: 'disconnect-media-1',
      attachments: {
        values: () => [
          {
            url: 'https://cdn.discord.test/held.png',
            name: 'held.png',
            contentType: 'image/png',
          },
        ],
      },
    });
    const oldHandler = (discord.listeners.get('messageCreate') ?? [])[0]!;
    const oldAttempt = Promise.resolve(oldHandler(inbound));
    await vi.waitFor(() => expect(heldFetch).toHaveBeenCalledOnce());

    const disconnect = connection!.disconnect();
    await vi.waitFor(() => expect(admittedSignal?.aborted).toBe(true));
    releaseDownload({
      ok: true,
      arrayBuffer: async () =>
        Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
          .buffer,
    });
    await Promise.all([oldAttempt, disconnect]);

    expect(storeMessageDirect).not.toHaveBeenCalled();
    expect(onMessagePersisted).not.toHaveBeenCalled();
    expect(inbound.react).not.toHaveBeenCalled();

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () =>
          Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
            .buffer,
      })),
    );
    await connect(true, { onMessagePersisted });
    const newHandler = (discord.listeners.get('messageCreate') ?? []).at(-1)!;
    await newHandler(inbound);
    await newHandler(inbound);

    expect(storeMessageDirect).toHaveBeenCalledTimes(1);
    expect(onMessagePersisted).toHaveBeenCalledTimes(1);
  });
});
