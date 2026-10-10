/**
 * Regression tests for the Feishu intake/send review (inbound P0-1, P0-2,
 * P1-1, P1-2, P1-5, P2-x; production P1-1, P1-3, P2-4, P2-7, P2-11; outbound
 * P1-2, P1-5, P1-6, P2-1, P2-3). Each test reproduces one reviewed failure
 * against the real connection with a mocked Lark SDK.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-review-fixes-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

const controls = vi.hoisted(() => ({
  dispatchers: [] as Array<Record<string, (data: any) => Promise<unknown>>>,
  messageList: vi.fn(),
  messageGet: vi.fn(),
  messageResourceGet: vi.fn(),
  chatList: vi.fn(),
  chatGet: vi.fn(),
  messageCreate: vi.fn(),
  messageReply: vi.fn(),
  reactionCreate: vi.fn(),
  reactionDelete: vi.fn(),
  imageCreate: vi.fn(),
}));

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: tmpGroupsDir,
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  AppType: { SelfBuild: 'SelfBuild' },
  LoggerLevel: { info: 'info' },
  defaultHttpInstance: { defaults: { timeout: 0 } },
  Client: class {
    request = vi.fn().mockResolvedValue({
      bot: { open_id: 'ou_bot', app_name: 'Review Bot' },
    });
    im = {
      v1: {
        chat: { list: controls.chatList, get: controls.chatGet },
        message: {
          list: controls.messageList,
          get: controls.messageGet,
          create: controls.messageCreate,
        },
        image: { create: controls.imageCreate },
      },
      message: { reply: controls.messageReply },
      messageReaction: {
        create: controls.reactionCreate,
        delete: controls.reactionDelete,
      },
      messageResource: { get: controls.messageResourceGet },
    };
  },
  EventDispatcher: class {
    private readonly handlers: Record<string, (data: any) => Promise<unknown>> =
      {};
    constructor() {
      controls.dispatchers.push(this.handlers);
    }
    register(input: Record<string, (data: any) => Promise<unknown>>) {
      Object.assign(this.handlers, input);
      return this;
    }
  },
  WSClient: class {
    async start() {}
    async close() {}
  },
}));

const loggerMock = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock('../src/logger.js', () => ({ logger: loggerMock }));

const db = await import('../src/db.js');
const { createFeishuConnection } = await import('../src/feishu.js');
const store = await import('../src/channel-reliability-store.js');
const { DefinitiveChannelDeliveryError } =
  await import('../src/channel-outbox-delivery.js');
const { classifyFeishuError } = await import('../src/feishu-errors.js');

const WORKSPACE = 'web:review-fixes';
const open: Array<{ stop(): Promise<void> }> = [];

beforeAll(() => {
  db.initDatabase();
  db.setRegisteredGroup(WORKSPACE, {
    name: 'Review fixes',
    folder: 'review-fixes',
    added_at: new Date().toISOString(),
  });
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** message.list pages keyed by container id; page_token is the page index. */
let containerPages: Record<string, any[][]> = {};

beforeEach(() => {
  controls.dispatchers.length = 0;
  containerPages = {};
  loggerMock.info.mockClear();
  loggerMock.warn.mockClear();
  controls.chatList
    .mockReset()
    .mockResolvedValue({ data: { items: [], has_more: false } });
  controls.chatGet
    .mockReset()
    .mockRejectedValue(new Error('chat.get unmocked'));
  controls.messageList.mockReset().mockImplementation(async (req: any) => {
    const pages = containerPages[req?.params?.container_id] ?? [];
    const index = req?.params?.page_token ? Number(req.params.page_token) : 0;
    const hasMore = index + 1 < pages.length;
    return {
      data: {
        items: pages[index] ?? [],
        has_more: hasMore,
        page_token: hasMore ? String(index + 1) : undefined,
      },
    };
  });
  controls.messageGet.mockReset().mockResolvedValue({ data: { items: [] } });
  controls.messageCreate
    .mockReset()
    .mockResolvedValue({ code: 0, data: { message_id: 'om_out' } });
  controls.messageReply
    .mockReset()
    .mockResolvedValue({ code: 0, data: { message_id: 'om_out' } });
  controls.reactionCreate
    .mockReset()
    .mockResolvedValue({ code: 0, data: { reaction_id: 'reaction_1' } });
  controls.reactionDelete.mockReset().mockResolvedValue({ code: 0 });
  controls.imageCreate.mockReset().mockResolvedValue({ image_key: 'img_up' });
  controls.messageResourceGet.mockReset().mockResolvedValue({
    getReadableStream: () =>
      (async function* () {
        yield Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      })(),
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.allSettled(open.splice(0).map((c) => c.stop()));
});

type ConnectOpts = Parameters<
  ReturnType<typeof createFeishuConnection>['connect']
>[0];

async function connect(
  accountId: string,
  overrides: Partial<ConnectOpts> = {},
) {
  const executed: string[] = [];
  const connection = createFeishuConnection({
    appId: 'app_review',
    appSecret: 'secret',
    channelAccountId: accountId,
  });
  const index = controls.dispatchers.length;
  expect(
    await connection.connect({
      onReady: vi.fn(),
      resolveEffectiveChatJid: (jid) => ({
        effectiveJid: WORKSPACE,
        agentId: null,
        sourceJid: jid,
      }),
      onFollowUpMessage: (input) => {
        executed.push(input.messageId);
        return { disposition: 'started' as const };
      },
      ...overrides,
    }),
  ).toBe(true);
  open.push(connection);
  const handlers = controls.dispatchers[index]!;
  return {
    connection,
    handlers,
    handler: handlers['im.message.receive_v1']!,
    executed,
  };
}

function p2pEvent(
  messageId: string,
  text: string,
  extra: Record<string, unknown> = {},
) {
  return {
    message: {
      chat_id: 'oc_p2p_review',
      message_id: messageId,
      create_time: String(Date.now()),
      message_type: 'text',
      content: JSON.stringify({ text }),
      chat_type: 'p2p',
      ...extra,
    },
    sender: {
      sender_id: { open_id: 'ou_user' },
      sender_type: 'user',
      sender_name: 'User',
    },
  };
}

function groupEvent(
  chatId: string,
  messageId: string,
  text: string,
  extra: Record<string, unknown> = {},
) {
  return {
    message: {
      chat_id: chatId,
      message_id: messageId,
      create_time: String(Date.now()),
      message_type: 'text',
      content: JSON.stringify({ text }),
      chat_type: 'group',
      ...extra,
    },
    sender: { sender_id: { open_id: 'ou_member' }, sender_type: 'user' },
  };
}

const botMention = {
  key: '@_user_1',
  name: 'Review Bot',
  id: { open_id: 'ou_bot' },
};

function inbox(accountId: string, messageId: string, chatId: string) {
  return store.recordChannelInbox({
    provider: 'feishu',
    accountId,
    externalMessageId: messageId,
    sourceJid: `feishu:${chatId}`,
    chatId,
    status: 'queued',
  }).item;
}

function persistChatMode(chatId: string, mode: 'topic' | 'group' | 'p2p') {
  db.setRegisteredGroup(`feishu:${chatId}`, {
    name: chatId,
    folder: 'review-fixes',
    added_at: new Date().toISOString(),
    feishu_chat_mode: mode,
  });
}

function seedCursor(accountId: string, chatId: string, position: number) {
  store.advanceChannelCursor({
    provider: 'feishu',
    accountId,
    scope: 'chat_messages',
    chatId,
    cursor: 'om_seed',
    position,
    tieBreaker: 'om_seed',
  });
}

/** Exact message.list REST item shape (string mention ids, {id,id_type}). */
function listItem(
  messageId: string,
  createTimeMs: number,
  text: string,
  extra: Record<string, unknown> = {},
) {
  return {
    message_id: messageId,
    create_time: String(createTimeMs),
    msg_type: 'text',
    body: { content: JSON.stringify({ text }) },
    sender: {
      id: 'ou_user',
      id_type: 'open_id',
      sender_type: 'user',
      tenant_key: 't',
    },
    ...extra,
  };
}

function axios400(code: number, msg = 'rejected') {
  return Object.assign(new Error('Request failed with status code 400'), {
    code: 'ERR_BAD_REQUEST',
    response: { status: 400, data: { code, msg } },
  });
}

function sentTexts(): string[] {
  return [
    ...controls.messageCreate.mock.calls,
    ...controls.messageReply.mock.calls,
  ].map((call) => String(call[0]?.data?.content ?? ''));
}

describe('backfill (inbound P0-1, production P1-1)', () => {
  test('a list-API @Bot message in a mention-gated group executes', async () => {
    const accountId = `bf-mention-${Date.now()}`;
    const chatId = 'oc_group_mention_review';
    const base = Date.now() - 60_000;
    seedCursor(accountId, chatId, base);
    controls.chatGet.mockResolvedValue({
      data: { chat_mode: 'group', name: 'Group' },
    });
    containerPages[chatId] = [
      [
        listItem('om_bf_at_bot', base + 5_000, '@_user_1 帮我看下这个报错', {
          mentions: [
            {
              key: '@_user_1',
              id: 'ou_bot',
              id_type: 'open_id',
              name: 'Review Bot',
            },
          ],
        }),
      ],
    ];
    const { executed } = await connect(accountId, {
      isChatBound: () => true,
      shouldProcessGroupMessage: () => false,
    });
    await vi.waitFor(() => expect(executed).toEqual(['om_bf_at_bot']));
    expect(
      db
        .getMessagesPage(WORKSPACE)
        .find((message) => message.id === 'om_bf_at_bot')?.content,
    ).toBe('帮我看下这个报错');
  });

  test('a WS redelivery re-judges a message that backfill ignored at the mention gate', async () => {
    const accountId = `bf-reopen-${Date.now()}`;
    const chatId = 'oc_group_reopen_review';
    const { handler, executed } = await connect(accountId, {
      isChatBound: () => true,
      shouldProcessGroupMessage: () => false,
    });
    const seeded = store.recordChannelInbox({
      provider: 'feishu',
      accountId,
      externalMessageId: 'om_reopen',
      sourceJid: `feishu:${chatId}`,
      chatId,
      rawPayload: { version: 1, source: 'backfill', payload: {} },
      status: 'queued',
    }).item;
    const claim = store.claimChannelInboxById(seeded.id, 'seed', 60_000)!;
    store.ignoreChannelInbox(claim, 'mention_gate:not_mentioned');

    await handler(
      groupEvent(chatId, 'om_reopen', '@_user_1 现在能看到吗', {
        mentions: [botMention],
      }),
    );
    expect(executed).toEqual(['om_reopen']);
    expect(inbox(accountId, 'om_reopen', chatId).status).toBe('processed');
  });

  test('never guesses a group: an untyped chat is resolved with chat.get', async () => {
    const accountId = `bf-chat-type-${Date.now()}`;
    const chatId = 'oc_p2p_untyped_review';
    const base = Date.now() - 60_000;
    seedCursor(accountId, chatId, base);
    controls.chatGet.mockResolvedValue({ data: { chat_mode: 'p2p' } });
    containerPages[chatId] = [[listItem('om_untyped', base + 1_000, '你好')]];
    const { executed } = await connect(accountId, {
      // when_mentioned would drop this if it were (wrongly) treated as group.
      shouldProcessGroupMessage: () => false,
    });
    await vi.waitFor(() => expect(executed).toEqual(['om_untyped']));
    expect(controls.chatGet).toHaveBeenCalledWith({
      path: { chat_id: chatId },
    });
  });

  test('skips a chat whose type cannot be resolved instead of judging it as a group', async () => {
    const accountId = `bf-chat-type-unknown-${Date.now()}`;
    const chatId = 'oc_unknown_type_review';
    const base = Date.now() - 60_000;
    seedCursor(accountId, chatId, base);
    containerPages[chatId] = [[listItem('om_unknown', base + 1_000, 'hi')]];
    const { executed } = await connect(accountId);
    await vi.waitFor(() =>
      expect(loggerMock.warn).toHaveBeenCalledWith(
        { chatId },
        'Skipping Feishu backfill: chat type is unknown',
      ),
    );
    expect(executed).toEqual([]);
    expect(
      store.getChannelCursor({
        provider: 'feishu',
        accountId,
        scope: 'chat_messages',
        chatId,
      })?.position,
    ).toBe(base);
  });

  test('backfills topic replies through the thread container, in order', async () => {
    const accountId = `bf-thread-${Date.now()}`;
    const chatId = 'oc_topic_review';
    const base = Date.now() - 60_000;
    seedCursor(accountId, chatId, base);
    controls.chatGet.mockResolvedValue({ data: { chat_mode: 'topic' } });
    containerPages[chatId] = [
      [
        listItem('om_topic_root', base + 1_000, '新话题', {
          thread_id: 'omt_review',
        }),
      ],
    ];
    containerPages.omt_review = [
      [
        listItem('om_topic_reply_2', base + 3_000, '第二条回复', {
          root_id: 'om_topic_root',
          parent_id: 'om_topic_root',
        }),
        listItem('om_topic_reply_1', base + 2_000, '第一条回复', {
          root_id: 'om_topic_root',
          parent_id: 'om_topic_root',
        }),
        listItem('om_topic_root', base + 1_000, '新话题'),
      ],
    ];
    const { executed } = await connect(accountId, {
      shouldProcessGroupMessage: () => true,
    });
    await vi.waitFor(() =>
      expect(executed).toEqual([
        'om_topic_root',
        'om_topic_reply_1',
        'om_topic_reply_2',
      ]),
    );
    expect(controls.messageList).toHaveBeenCalledWith({
      params: expect.objectContaining({
        container_id_type: 'thread',
        container_id: 'omt_review',
      }),
    });
  });

  test('pages back past the old 250-message cap and reports a real gap once', async () => {
    const accountId = `bf-pages-${Date.now()}`;
    const chatId = 'oc_p2p_pages_review';
    const base = Date.now() - 60 * 60_000;
    seedCursor(accountId, chatId, base);
    controls.chatGet.mockResolvedValue({ data: { chat_mode: 'p2p' } });
    // 22 pages of 50, newest first: 20 are fetched, 1 is counted, 1 more exists.
    const items = Array.from({ length: 1_100 }, (_, i) =>
      listItem(
        `om_page_${String(i).padStart(4, '0')}`,
        base + 1_000 + i,
        `m${i}`,
      ),
    ).reverse();
    containerPages[chatId] = Array.from({ length: 22 }, (_, p) =>
      items.slice(p * 50, p * 50 + 50),
    );
    const { executed } = await connect(accountId);
    await vi.waitFor(() => expect(executed.length).toBe(1_000), {
      timeout: 20_000,
    });
    // The 300 messages the old 5-page cap silently dropped are processed.
    expect(executed).toContain('om_page_0300');
    const gapNotices = sentTexts().filter((text) =>
      text.includes('条较早的离线消息未补回'),
    );
    expect(gapNotices).toHaveLength(1);
    expect(gapNotices[0]).toContain('50+');
  }, 30_000);

  test('topics are scanned only for bound topic groups', async () => {
    const accountId = `bf-thread-unbound-${Date.now()}`;
    const chatId = 'oc_topic_unbound_review';
    const base = Date.now() - 60_000;
    seedCursor(accountId, chatId, base);
    persistChatMode(chatId, 'topic');
    containerPages[chatId] = [
      [
        listItem('om_unbound_root', base + 1_000, '话题', {
          thread_id: 'omt_unbound',
          chat_type: 'group',
        }),
      ],
    ];
    containerPages.omt_unbound = [
      [
        listItem('om_unbound_reply', base + 2_000, '回复', {
          chat_type: 'group',
        }),
      ],
    ];
    await connect(accountId, { isChatBound: () => false });
    await vi.waitFor(() =>
      expect(controls.messageList).toHaveBeenCalledWith({
        params: expect.objectContaining({ container_id: chatId }),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(
      controls.messageList.mock.calls.some(
        (call) => call[0].params.container_id_type === 'thread',
      ),
    ).toBe(false);
  });

  test('a rate-limited list call is retried instead of read as "no messages"', async () => {
    const accountId = `bf-rate-${Date.now()}`;
    const chatId = 'oc_p2p_rate_review';
    const base = Date.now() - 60_000;
    seedCursor(accountId, chatId, base);
    controls.chatGet.mockResolvedValue({ data: { chat_mode: 'p2p' } });
    containerPages[chatId] = [[listItem('om_after_rate', base + 1_000, 'hi')]];
    const listed = controls.messageList.getMockImplementation()!;
    controls.messageList.mockImplementationOnce(async () => {
      throw Object.assign(new Error('Request failed with status code 429'), {
        response: { status: 429, data: { code: 99991400 }, headers: {} },
      });
    });
    controls.messageList.mockImplementation(listed);
    const { executed } = await connect(accountId);
    await vi.waitFor(() => expect(executed).toEqual(['om_after_rate']));
  });

  test('the count-only page is kept when it reaches the cursor window', async () => {
    const accountId = `bf-21st-${Date.now()}`;
    const chatId = 'oc_p2p_21st_review';
    const base = Date.now() - 60 * 60_000;
    seedCursor(accountId, chatId, base);
    controls.chatGet.mockResolvedValue({ data: { chat_mode: 'p2p' } });
    // Exactly 21 pages: the 21st both is the count-only page and ends the
    // window, so nothing is missing.
    const items = Array.from({ length: 1_030 }, (_, i) =>
      listItem(
        `om_21_${String(i).padStart(4, '0')}`,
        base + 1_000 + i,
        `m${i}`,
      ),
    ).reverse();
    containerPages[chatId] = Array.from({ length: 21 }, (_, p) =>
      items.slice(p * 50, p * 50 + 50),
    );
    const { executed } = await connect(accountId);
    await vi.waitFor(() => expect(executed.length).toBe(1_030), {
      timeout: 20_000,
    });
    expect(sentTexts().some((text) => text.includes('离线消息未补回'))).toBe(
      false,
    );
  }, 30_000);

  test('a month-old message at the cursor is never replayed after its Inbox row was pruned', async () => {
    const accountId = `bf-month-${Date.now()}`;
    const chatId = 'oc_p2p_month_review';
    const cursorAt = Date.now() - 31 * 24 * 60 * 60_000;
    seedCursor(accountId, chatId, cursorAt);
    controls.chatGet.mockResolvedValue({ data: { chat_mode: 'p2p' } });
    containerPages[chatId] = [
      [
        listItem('om_new_after_cursor', Date.now() - 1_000, '新消息'),
        listItem('om_month_old', cursorAt - 60_000, '31 天前的旧消息'),
      ],
    ];
    const { executed } = await connect(accountId);
    await vi.waitFor(() => expect(executed).toEqual(['om_new_after_cursor']));
    expect(
      store.recordChannelInbox({
        provider: 'feishu',
        accountId,
        externalMessageId: 'om_month_old',
        sourceJid: `feishu:${chatId}`,
        chatId,
        status: 'queued',
      }).created,
    ).toBe(true);
  });

  test('an at-cursor message already in the message table is terminal, not re-run', async () => {
    const accountId = `bf-ingested-${Date.now()}`;
    const chatId = 'oc_p2p_ingested_review';
    const cursorAt = Date.now() - 60_000;
    seedCursor(accountId, chatId, cursorAt);
    controls.chatGet.mockResolvedValue({ data: { chat_mode: 'p2p' } });
    db.storeMessageDirect(
      'om_already_ingested',
      WORKSPACE,
      'ou_user',
      'User',
      '早就处理过',
      new Date(cursorAt - 30_000).toISOString(),
      false,
    );
    containerPages[chatId] = [
      [listItem('om_already_ingested', cursorAt - 30_000, '早就处理过')],
    ];
    const { executed } = await connect(accountId);
    await vi.waitFor(() =>
      expect(inbox(accountId, 'om_already_ingested', chatId)).toMatchObject({
        status: 'ignored',
        error: 'already_ingested',
      }),
    );
    expect(executed).toEqual([]);
  });
});

describe('group slash commands need a proven @Bot (inbound P0-2)', () => {
  test('a bare /recall in a mention-gated group is not a command', async () => {
    const onCommand = vi.fn().mockResolvedValue('owner private summary');
    const { handler, executed } = await connect(`cmd-bare-${Date.now()}`, {
      isChatBound: () => true,
      isSenderAllowedInGroup: () => true,
      shouldProcessGroupMessage: () => false,
      onCommand,
    });
    await handler(
      groupEvent('oc_topic_cmd_review', 'om_recall_bare', '/recall', {
        thread_id: 'omt_cmd',
        root_id: 'om_cmd_root',
        parent_id: 'om_cmd_root',
      }),
    );
    expect(onCommand).not.toHaveBeenCalled();
    expect(controls.messageReply).not.toHaveBeenCalled();
    expect(executed).toEqual([]);
  });

  test('a bare command in an always-on group is ordinary text for the Agent', async () => {
    const onCommand = vi.fn().mockResolvedValue('reply');
    const { handler, executed } = await connect(`cmd-always-${Date.now()}`, {
      shouldProcessGroupMessage: () => true,
      onCommand,
    });
    await handler(groupEvent('oc_always_cmd_review', 'om_list_bare', '/list'));
    expect(onCommand).not.toHaveBeenCalled();
    expect(executed).toEqual(['om_list_bare']);
  });

  test('@Bot /status in a group and /status in a private chat still run', async () => {
    const onCommand = vi.fn().mockResolvedValue('status reply');
    const { handler } = await connect(`cmd-at-${Date.now()}`, {
      shouldProcessGroupMessage: () => false,
      onCommand,
    });
    await handler(
      groupEvent('oc_cmd_at_review', 'om_status_at', '@_user_1 /status', {
        mentions: [botMention],
      }),
    );
    await handler(p2pEvent('om_status_p2p', '/status'));
    expect(onCommand.mock.calls.map((call) => call[1])).toEqual([
      'status',
      'status',
    ]);
  });

  test('a topic-group @Bot /recall reaches the handler with the topic meta', async () => {
    const onCommand = vi.fn().mockResolvedValue('topic summary');
    const { handler } = await connect(`cmd-topic-meta-${Date.now()}`, {
      shouldProcessGroupMessage: () => false,
      resolveFeishuConversationPlan: () => ({
        disabled: false,
        allowWithoutMention: false,
        independentContext: true,
        contextId: 'omt_recall_topic',
        rootMessageId: 'om_recall_topic_root',
      }),
      onCommand,
    });
    await handler(
      groupEvent(
        'oc_topic_meta_review',
        'om_recall_topic',
        '@_user_1 /recall',
        {
          mentions: [botMention],
          thread_id: 'omt_recall_topic',
          root_id: 'om_recall_topic_root',
          parent_id: 'om_recall_topic_root',
        },
      ),
    );
    expect(onCommand).toHaveBeenCalledTimes(1);
    const [jid, command, sender, mentions, meta] = onCommand.mock.calls[0];
    expect([jid, command, sender]).toEqual([
      'feishu:oc_topic_meta_review',
      'recall',
      'ou_member',
    ]);
    expect(mentions).toEqual([botMention]);
    expect(meta).toMatchObject({
      chatType: 'group',
      mentionedBot: true,
      nativeContextType: 'thread',
      contextId: 'omt_recall_topic',
      threadId: 'omt_recall_topic',
      rootId: 'om_recall_topic_root',
      messageId: 'om_recall_topic',
    });
    // The reply stays in the topic.
    expect(controls.messageReply).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { message_id: 'om_recall_topic_root' },
      }),
    );
  });

  test('a disabled group can still recover itself with @Bot generic commands', async () => {
    const onCommand = vi.fn().mockResolvedValue('activation updated');
    const onSessionClear = vi
      .fn()
      .mockResolvedValue('Session context cleared.');
    const { handler, executed } = await connect(`cmd-disabled-${Date.now()}`, {
      onCommand,
      onSessionClear,
      resolveFeishuConversationPlan: () => ({
        disabled: true,
        allowWithoutMention: false,
        independentContext: false,
      }),
    });
    await handler(
      groupEvent(
        'oc_disabled_cmd_review',
        'om_req_mention',
        '@_user_1 /require_mention false',
        {
          mentions: [botMention],
        },
      ),
    );
    expect(onCommand.mock.calls.map((call) => call[1])).toEqual([
      'require_mention false',
    ]);
    // Runtime controls still respect the activation gate.
    await handler(
      groupEvent(
        'oc_disabled_cmd_review',
        'om_clear_disabled',
        '@_user_1 /clear',
        {
          mentions: [botMention],
        },
      ),
    );
    expect(onSessionClear).not.toHaveBeenCalled();
    // A bare command is still not a command.
    await handler(
      groupEvent(
        'oc_disabled_cmd_review',
        'om_bare_disabled',
        '/owner_mention',
      ),
    );
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(executed).toEqual([]);
  });

  test('runtime controls tell the host the native chat type', async () => {
    const onSessionBreak = vi.fn().mockResolvedValue('No active task to stop.');
    const onSessionClear = vi
      .fn()
      .mockResolvedValue('Session context cleared.');
    const onSessionFresh = vi.fn().mockResolvedValue('ok');
    const { handler } = await connect(`chat-type-ctl-${Date.now()}`, {
      shouldProcessGroupMessage: () => true,
      onSessionBreak,
      onSessionClear,
      onSessionFresh,
    });
    await handler(p2pEvent('om_p2p_break_type', '/break'));
    await handler(p2pEvent('om_p2p_clear_type', '/clear'));
    await handler(p2pEvent('om_p2p_fresh_type', '/fresh 交接'));
    await handler(
      groupEvent(
        'oc_ctl_type_review',
        'om_group_clear_type',
        '@_user_1 /clear',
        {
          mentions: [botMention],
        },
      ),
    );
    expect(onSessionBreak).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceJid: 'feishu:oc_p2p_review',
        chatType: 'p2p',
      }),
    );
    expect(onSessionFresh).toHaveBeenCalledWith(
      expect.objectContaining({ chatType: 'p2p', notes: '交接' }),
    );
    expect(onSessionClear.mock.calls.map((call) => call[0].chatType)).toEqual([
      'p2p',
      'group',
    ]);
  });

  test('a disabled private chat ignores runtime controls (P2-12)', async () => {
    const onSessionBreak = vi.fn().mockResolvedValue('Current task stopped.');
    const { handler } = await connect(`p2p-disabled-${Date.now()}`, {
      onSessionBreak,
      resolveFeishuConversationPlan: () => ({
        disabled: true,
        allowWithoutMention: false,
        independentContext: false,
      }),
    });
    await handler(p2pEvent('om_disabled_break', '/break'));
    expect(onSessionBreak).not.toHaveBeenCalled();
    expect(controls.messageCreate).not.toHaveBeenCalled();
  });
});

describe('bounded intake retries (inbound P1-1, P2-2)', () => {
  test('a reply whose root lookup is refused (4xx) is treated as a plain reply', async () => {
    const accountId = `poison-4xx-${Date.now()}`;
    const { handler, executed } = await connect(accountId);
    controls.messageGet.mockRejectedValue(axios400(230027, 'no permission'));
    await handler(
      p2pEvent('om_reply_4xx', '回复一下这条', {
        root_id: 'om_root_old',
        parent_id: 'om_root_old',
      }),
    );
    expect(executed).toEqual(['om_reply_4xx']);
    expect(sentTexts().some((t) => t.includes('暂时失败'))).toBe(false);
  });

  test('persistent transient failures stop after 8 attempts with one retry and one terminal notice in the topic', async () => {
    vi.useFakeTimers();
    const accountId = `poison-transient-${Date.now()}`;
    let attempts = 0;
    const { handler } = await connect(accountId, {
      onFollowUpMessage: () => {
        attempts++;
        throw new Error('transient intake failure');
      },
    });
    await handler(
      groupEvent('oc_topic_poison_review', 'om_poison', '会一直失败', {
        thread_id: 'omt_poison',
        root_id: 'om_poison_root',
        parent_id: 'om_poison_root',
      }),
    );
    // 5s, 10s, ... 320s: well below an hour of retries.
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(attempts).toBe(8);
    expect(
      inbox(accountId, 'om_poison', 'oc_topic_poison_review'),
    ).toMatchObject({ status: 'failed' });
    const notices = controls.messageReply.mock.calls.filter((call) =>
      String(call[0].data.content).includes('⚠️'),
    );
    expect(
      notices.map((call) => JSON.parse(call[0].data.content).text),
    ).toEqual([
      '⚠️ 消息处理暂时失败，系统将自动重试',
      '⚠️ 这条消息多次处理失败，系统已停止自动重试，请稍后重新发送。',
    ]);
    // Topic-aware: replies to the topic root, never a new top-level message.
    expect(
      notices.every((call) => call[0].path.message_id === 'om_poison_root'),
    ).toBe(true);
    expect(controls.messageCreate).not.toHaveBeenCalled();
  });

  test('a message that keeps failing stops holding its chat after its first retries', async () => {
    vi.useFakeTimers();
    const accountId = `order-hold-${Date.now()}`;
    const executed: string[] = [];
    const { handler } = await connect(accountId, {
      onFollowUpMessage: (input) => {
        if (input.messageId === 'om_always_failing') {
          throw new Error('still failing');
        }
        executed.push(input.messageId);
        return { disposition: 'started' as const };
      },
    });
    const now = Date.now();
    await handler(
      p2pEvent('om_always_failing', 'A', { create_time: String(now) }),
    );
    // Failures 1 and 2 hold the lane (5s, 10s); the third (at ~15s) does not.
    await vi.advanceTimersByTimeAsync(16_000);
    await handler(
      p2pEvent('om_after_holds', 'B', { create_time: String(now + 1) }),
    );
    expect(executed).toEqual(['om_after_holds']);
  });

  test('a later message waits behind an earlier one that is retrying', async () => {
    vi.useFakeTimers();
    const accountId = `order-${Date.now()}`;
    let failOnce = true;
    const { handler, executed } = await connect(accountId);
    controls.messageGet.mockImplementation(async () => {
      if (failOnce) {
        failOnce = false;
        throw Object.assign(new Error('socket hang up'), {
          code: 'ECONNRESET',
        });
      }
      return { data: { items: [] } };
    });
    const now = Date.now();
    await handler(
      p2pEvent('om_first', '第一条（引用回复）', {
        root_id: 'om_r',
        parent_id: 'om_r',
        create_time: String(now),
      }),
    );
    await handler(
      p2pEvent('om_second', '第二条', { create_time: String(now + 1) }),
    );
    expect(executed).toEqual([]);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(executed).toEqual(['om_first', 'om_second']);
  });
});

describe('user text and forwarded material (inbound P1-2, P1-5, P2-9)', () => {
  test('a 30,000-character text reaches the Agent intact', async () => {
    const { handler, executed } = await connect(`long-${Date.now()}`);
    const longText =
      'A'.repeat(19_990) + '<<TAIL-MARKER>>' + 'B'.repeat(10_000);
    await handler(p2pEvent('om_long_text', longText));
    expect(executed).toEqual(['om_long_text']);
    expect(
      db.getMessagesPage(WORKSPACE).find((m) => m.id === 'om_long_text')
        ?.content,
    ).toBe(longText);
  });

  test('a 25-message forward runs with an explicit "共 N 条" note', async () => {
    vi.useFakeTimers();
    const { handler, executed } = await connect(`fwd-big-${Date.now()}`);
    const children = Array.from({ length: 25 }, (_, i) => ({
      message_id: `om_child_${i}`,
      msg_type: 'text',
      upper_message_id: 'om_fwd_big',
      body: { content: JSON.stringify({ text: `第 ${i} 条聊天记录` }) },
      sender: { id: 'ou_someone', name: '同事' },
    }));
    controls.messageGet.mockImplementation(async (req: any) =>
      req?.path?.message_id === 'om_fwd_big'
        ? {
            data: {
              items: [
                {
                  message_id: 'om_fwd_big',
                  msg_type: 'merge_forward',
                  body: { content: 'Merged and Forwarded Message' },
                  sender: { id: 'ou_user' },
                },
                ...children,
              ],
            },
          }
        : { data: { items: [] } },
    );
    await handler(
      p2pEvent('om_fwd_big', 'Merged and Forwarded Message', {
        message_type: 'merge_forward',
        content: 'Merged and Forwarded Message',
      }),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(executed).toEqual(['om_fwd_big']);
    const content = db
      .getMessagesPage(WORKSPACE)
      .find((m) => m.id === 'om_fwd_big')?.content;
    expect(content).toContain('共 25 条，仅展示前 20 条');
    expect(sentTexts().some((t) => t.includes('暂时无法读取'))).toBe(false);
  });

  test('a recalled child is a placeholder and file children are marked as not downloaded', async () => {
    vi.useFakeTimers();
    const { handler, executed } = await connect(`fwd-del-${Date.now()}`);
    controls.messageGet.mockImplementation(async (req: any) =>
      req?.path?.message_id === 'om_fwd_del'
        ? {
            data: {
              items: [
                {
                  message_id: 'om_fwd_del',
                  msg_type: 'merge_forward',
                  body: { content: 'x' },
                  sender: { id: 'ou_user' },
                },
                {
                  message_id: 'om_c1',
                  msg_type: 'text',
                  upper_message_id: 'om_fwd_del',
                  body: { content: JSON.stringify({ text: '正常消息' }) },
                  sender: { id: 'ou_a', name: 'A' },
                },
                {
                  message_id: 'om_c2',
                  msg_type: 'text',
                  upper_message_id: 'om_fwd_del',
                  deleted: true,
                  body: { content: JSON.stringify({ text: '' }) },
                  sender: { id: 'ou_b', name: 'B' },
                },
                {
                  message_id: 'om_c3',
                  msg_type: 'file',
                  upper_message_id: 'om_fwd_del',
                  body: {
                    content: JSON.stringify({
                      file_key: 'file_k',
                      file_name: 'report.pdf',
                    }),
                  },
                  sender: { id: 'ou_c', name: 'C' },
                },
              ],
            },
          }
        : { data: { items: [] } },
    );
    await handler(
      p2pEvent('om_fwd_del', 'Merged and Forwarded Message', {
        message_type: 'merge_forward',
        content: 'Merged and Forwarded Message',
      }),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(executed).toEqual(['om_fwd_del']);
    const content = db
      .getMessagesPage(WORKSPACE)
      .find((m) => m.id === 'om_fwd_del')?.content;
    expect(content).toContain('B: [已撤回]');
    expect(content).toContain('[文件: report.pdf]（未下载）');
  });

  test('a forward note always runs, even when its forwarded material stays unreadable', async () => {
    vi.useFakeTimers();
    const rootId = `om_unreadable_root_${Date.now()}`;
    const noteId = `${rootId}_note`;
    const { handler, executed } = await connect(`fwd-note-${Date.now()}`);
    const createTime = Date.now();
    // The root is a merged forward, but its children never become readable.
    controls.messageGet.mockImplementation(async (req: any) =>
      req?.path?.message_id === rootId
        ? {
            data: {
              items: [
                {
                  message_id: rootId,
                  msg_type: 'merge_forward',
                  create_time: String(createTime),
                  body: { content: 'Merged and Forwarded Message' },
                  sender: { id: 'ou_user' },
                },
              ],
            },
          }
        : { data: { items: [] } },
    );
    await handler(
      p2pEvent(noteId, '请帮我总结', {
        root_id: rootId,
        parent_id: rootId,
        create_time: String(createTime + 500),
      }),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(executed).toEqual([noteId]);
  });
});

describe('recovery gate, ordering and retirement (inbound P2-3/P2-4/P2-7, production P2-7)', () => {
  test('gated messages spend no attempt and resume on the gate-open event', async () => {
    const accountId = `gate-${Date.now()}`;
    let deferred = true;
    const listeners = new Set<() => void>();
    const { handler, executed } = await connect(accountId, {
      shouldDeferInbound: () => deferred,
      onInboundGateOpen: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    await handler(p2pEvent('om_gated', 'wait'));
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(executed).toEqual([]);
    expect(inbox(accountId, 'om_gated', 'oc_p2p_review')).toMatchObject({
      status: 'queued',
      attempt: 0,
    });
    expect(loggerMock.info).not.toHaveBeenCalledWith(
      expect.anything(),
      'Recovered queued Feishu Inbox messages',
    );

    deferred = false;
    for (const listener of listeners) listener();
    await vi.waitFor(() => expect(executed).toEqual(['om_gated']));
    expect(inbox(accountId, 'om_gated', 'oc_p2p_review')).toMatchObject({
      status: 'processed',
      attempt: 1,
    });
  });

  test('a merged-forward root held during the gate still waits for its companion', async () => {
    vi.useFakeTimers();
    const accountId = `gate-forward-${Date.now()}`;
    let deferred = true;
    const rootId = `om_gate_fwd_${Date.now()}`;
    controls.messageGet.mockResolvedValue({
      data: {
        items: [
          {
            message_id: rootId,
            msg_type: 'merge_forward',
            body: { content: 'x' },
            sender: { id: 'ou_user' },
          },
          {
            message_id: `${rootId}_c`,
            msg_type: 'text',
            upper_message_id: rootId,
            body: { content: JSON.stringify({ text: '材料' }) },
          },
        ],
      },
    });
    const { handler, executed } = await connect(accountId, {
      shouldDeferInbound: () => deferred,
    });
    await handler(
      p2pEvent(rootId, 'x', {
        message_type: 'merge_forward',
        content: 'Merged and Forwarded Message',
      }),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    deferred = false;
    // Gate opens: the first real pass holds the root for its companion
    // (it did not burn "attempt 1" while gated), then promotes it.
    await vi.advanceTimersByTimeAsync(1_500);
    expect(executed).toEqual([]);
    expect(
      db.getMessagesPage(WORKSPACE).find((m) => m.id === rootId)
        ?.delivery_status,
    ).toBe('awaiting_companion');
    await vi.advanceTimersByTimeAsync(4_000);
    expect(executed).toEqual([rootId]);
  });

  test('stop() during an image download re-queues instead of completing with a failure marker', async () => {
    const accountId = `retire-${Date.now()}`;
    let releaseDownload!: () => void;
    controls.messageResourceGet.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseDownload = () =>
            resolve({
              getReadableStream: () =>
                (async function* () {
                  yield Buffer.from([0x89, 0x50, 0x4e, 0x47]);
                })(),
            });
        }),
    );
    const { connection, handler, executed } = await connect(accountId);
    const pending = handler(
      p2pEvent('om_image_retire', '', {
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img_retire' }),
      }),
    );
    await vi.waitFor(() => expect(releaseDownload).toBeTypeOf('function'));
    await connection.stop();
    releaseDownload();
    await pending;
    expect(executed).toEqual([]);
    expect(inbox(accountId, 'om_image_retire', 'oc_p2p_review').status).toBe(
      'queued',
    );
    expect(
      db.getMessagesPage(WORKSPACE).some((m) => m.id === 'om_image_retire'),
    ).toBe(false);
  });

  test('attachments land in the folder of the admitted route target', async () => {
    const resolveGroupFolder = vi.fn((jid: string) =>
      jid === WORKSPACE ? 'review-fixes' : 'legacy-folder',
    );
    const { handler, executed } = await connect(`folder-${Date.now()}`, {
      resolveGroupFolder,
      resolveEffectiveChatJid: (jid) => ({
        effectiveJid: `${WORKSPACE}#agent:session-1`,
        agentId: 'session-1',
        sourceJid: jid,
      }),
    });
    await handler(
      p2pEvent('om_image_folder', '', {
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img_folder' }),
      }),
    );
    expect(executed).toEqual(['om_image_folder']);
    expect(resolveGroupFolder).toHaveBeenCalledTimes(1);
    expect(resolveGroupFolder).toHaveBeenCalledWith(WORKSPACE);
  });
});

describe('intake lanes (inbound P2-1, optional part)', () => {
  test('topics of a topic group are admitted concurrently, in order within a topic', async () => {
    const chatId = 'oc_topic_lanes_review';
    // The lane comes from the persisted chat mode, never a lazy cache.
    persistChatMode(chatId, 'topic');
    let releaseLookup!: () => void;
    controls.messageGet
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseLookup = () => resolve({ data: { items: [] } });
          }),
      )
      .mockResolvedValue({ data: { items: [] } });
    const { handler, executed } = await connect(`lanes-${Date.now()}`, {
      shouldProcessGroupMessage: () => true,
    });
    const now = Date.now();
    // Topic A: a quoted reply whose root lookup is slow.
    const slowA = handler(
      groupEvent(chatId, 'om_lane_a1', 'A 的回复', {
        thread_id: 'omt_lane_a',
        root_id: 'om_lane_a_root',
        parent_id: 'om_lane_a_root',
        create_time: String(now),
      }),
    );
    const laterA = handler(
      groupEvent(chatId, 'om_lane_a2', 'A 的第二条', {
        thread_id: 'omt_lane_a',
        create_time: String(now + 1),
      }),
    );
    // Topic B is not held behind topic A.
    await handler(
      groupEvent(chatId, 'om_lane_b1', 'B 的消息', {
        thread_id: 'omt_lane_b',
        create_time: String(now + 2),
      }),
    );
    expect(executed).toEqual(['om_lane_b1']);
    await vi.waitFor(() => expect(releaseLookup).toBeTypeOf('function'));
    releaseLookup();
    await Promise.all([slowA, laterA]);
    expect(executed).toEqual(['om_lane_b1', 'om_lane_a1', 'om_lane_a2']);
  });

  test('without a persisted topic mode one chat keeps a single ordered lane', async () => {
    const chatId = 'oc_unknown_mode_lanes_review';
    controls.chatGet.mockResolvedValue({ data: { chat_mode: 'topic' } });
    let releaseLookup!: () => void;
    controls.messageGet
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseLookup = () => resolve({ data: { items: [] } });
          }),
      )
      .mockResolvedValue({ data: { items: [] } });
    const { connection, handler, executed } = await connect(
      `lanes-unknown-${Date.now()}`,
      { shouldProcessGroupMessage: () => true },
    );
    // A cached chat.get result alone must not split lanes.
    await connection.getChatInfo(chatId);
    const now = Date.now();
    const slowA = handler(
      groupEvent(chatId, 'om_one_lane_a', 'A', {
        thread_id: 'omt_one_a',
        root_id: 'om_one_a_root',
        parent_id: 'om_one_a_root',
        create_time: String(now),
      }),
    );
    const laterB = handler(
      groupEvent(chatId, 'om_one_lane_b', 'B', {
        thread_id: 'omt_one_b',
        create_time: String(now + 1),
      }),
    );
    await vi.waitFor(() => expect(releaseLookup).toBeTypeOf('function'));
    expect(executed).toEqual([]);
    releaseLookup();
    await Promise.all([slowA, laterB]);
    expect(executed).toEqual(['om_one_lane_a', 'om_one_lane_b']);
  });
});

describe('chat identity (inbound P2-11, P2-13)', () => {
  test('a bound private chat is not renamed back to the placeholder', async () => {
    const onNewChat = vi.fn();
    const { handler } = await connect(`p2p-name-${Date.now()}`, {
      isChatBound: () => true,
      onNewChat,
    });
    await handler(p2pEvent('om_p2p_name', 'hello'));
    expect(onNewChat).toHaveBeenCalledTimes(1);
    expect(onNewChat).toHaveBeenCalledWith('feishu:oc_p2p_review', '');
  });

  test('a rejected principal is never recorded or routed under the unscoped JID', async () => {
    const accountId = `principal-${Date.now()}`;
    const resolveEffectiveChatJid = vi.fn();
    const { handler, executed } = await connect(accountId, {
      normalizeIncomingJid: () => null,
      resolveEffectiveChatJid,
    });
    await handler(p2pEvent('om_rejected_principal', 'hello'));
    expect(executed).toEqual([]);
    expect(resolveEffectiveChatJid).not.toHaveBeenCalled();
    expect(
      store.recordChannelInbox({
        provider: 'feishu',
        accountId,
        externalMessageId: 'om_rejected_principal',
        sourceJid: 'feishu:oc_p2p_review',
        chatId: 'oc_p2p_review',
        status: 'queued',
      }).created,
    ).toBe(true);
  });
});

describe('recall events (production P2-4)', () => {
  test('a recall closes the queued row, tombstones an unseen one and notifies the host', async () => {
    const accountId = `recall-${Date.now()}`;
    const onMessageRecalled = vi.fn();
    const { handlers, handler, executed } = await connect(accountId, {
      normalizeIncomingJid: (jid) => `${jid}#account:${accountId}`,
      onMessageRecalled,
    });
    expect(handlers['im.message.recalled_v1']).toBeTypeOf('function');

    await handlers['im.message.recalled_v1']!({
      chat_id: 'oc_p2p_review',
      message_id: 'om_recalled_before_receive',
      recall_type: 'message_owner',
    });
    expect(onMessageRecalled).toHaveBeenCalledWith(
      `feishu:oc_p2p_review#account:${accountId}`,
      'om_recalled_before_receive',
    );
    // The late receive event (or a backfill) must not run it.
    await handler(p2pEvent('om_recalled_before_receive', '撤回了'));
    expect(executed).toEqual([]);
    expect(
      inbox(accountId, 'om_recalled_before_receive', 'oc_p2p_review'),
    ).toMatchObject({ status: 'ignored', error: 'recalled' });
  });

  test('a recall that arrives during intake keeps the message from being handed off', async () => {
    const accountId = `recall-inflight-${Date.now()}`;
    let releaseDownload!: () => void;
    controls.messageResourceGet.mockImplementation(
      () =>
        new Promise((resolve) => {
          releaseDownload = () =>
            resolve({
              getReadableStream: () =>
                (async function* () {
                  yield Buffer.from([0x89, 0x50, 0x4e, 0x47]);
                })(),
            });
        }),
    );
    const onMessageRecalled = vi.fn();
    const { handlers, handler, executed } = await connect(accountId, {
      onMessageRecalled,
    });
    const pending = handler(
      p2pEvent('om_recall_inflight', '', {
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img_inflight' }),
      }),
    );
    await vi.waitFor(() => expect(releaseDownload).toBeTypeOf('function'));
    await handlers['im.message.recalled_v1']!({
      chat_id: 'oc_p2p_review',
      message_id: 'om_recall_inflight',
    });
    releaseDownload();
    await pending;
    expect(executed).toEqual([]);
    expect(
      inbox(accountId, 'om_recall_inflight', 'oc_p2p_review'),
    ).toMatchObject({ status: 'ignored', error: 'recalled' });
    expect(
      db.getMessagesPage(WORKSPACE).some((m) => m.id === 'om_recall_inflight'),
    ).toBe(false);
  });

  test('a recall while inbound is paused still writes the tombstone', async () => {
    const accountId = `recall-paused-${Date.now()}`;
    let paused = true;
    const onMessageRecalled = vi.fn();
    const { handlers, handler, executed } = await connect(accountId, {
      normalizeIncomingJid: (jid) =>
        paused ? null : `${jid}#account:${accountId}`,
      shouldDeferInbound: () => paused,
      onMessageRecalled,
    });
    await handlers['im.message.recalled_v1']!({
      chat_id: 'oc_p2p_review',
      message_id: 'om_recall_paused',
    });
    expect(onMessageRecalled).not.toHaveBeenCalled();
    expect(inbox(accountId, 'om_recall_paused', 'oc_p2p_review')).toMatchObject(
      { status: 'ignored', error: 'recalled' },
    );
    paused = false;
    await handler(p2pEvent('om_recall_paused', '暂停期间撤回'));
    expect(executed).toEqual([]);
  });

  test('no-op handlers keep subscribed but unused events out of the logs', async () => {
    const { handlers } = await connect(`noop-${Date.now()}`);
    for (const event of [
      'docs_link_status_changed',
      'im.message.message_read_v1',
      'im.chat.access_event.bot_p2p_chat_entered_v1',
      'im.message.reaction.created_v1',
      'im.message.reaction.deleted_v1',
    ]) {
      expect(handlers[event], event).toBeTypeOf('function');
    }
  });
});

describe('reply anchors (inbound P2-10, outbound P2-1)', () => {
  test('a private-chat answer quotes its own input, not the latest inbound message', async () => {
    const { connection, handler } = await connect(`anchor-${Date.now()}`, {
      onFollowUpMessage: () => ({ disposition: 'queued' as const }),
    });
    await handler(p2pEvent('om_input_a', 'A'));
    await handler(p2pEvent('om_input_b', 'B'));

    expect(connection.getLastMessageId('oc_p2p_review')).toBe('om_input_b');
    expect(connection.getLastMessageId('oc_p2p_review', 'om_input_a')).toBe(
      'om_input_a',
    );
    // A Web or scheduled input is not a Feishu message: no anchor, no guess.
    expect(
      connection.getLastMessageId('oc_p2p_review', 'scheduled-task-prompt:1'),
    ).toBeUndefined();

    await connection.sendMessage('oc_p2p_review', 'answer to A', [], {
      presentation: 'native',
      inputMessageId: 'om_input_a',
    });
    expect(controls.messageReply).toHaveBeenLastCalledWith(
      expect.objectContaining({ path: { message_id: 'om_input_a' } }),
    );
  });

  test('another chat’s message is never used as an anchor', async () => {
    const { connection, handler } = await connect(`anchor-x-${Date.now()}`);
    await handler(p2pEvent('om_other_chat', 'x', { chat_id: 'oc_other_p2p' }));
    expect(
      connection.getLastMessageId('oc_p2p_review', 'om_other_chat'),
    ).toBeUndefined();
  });
});

describe('send-side Feishu errors (outbound P1-2, P1-5, P1-6, production P1-3)', () => {
  test('in a topic group a recalled anchor stops the card → post chain definitively', async () => {
    const { connection } = await connect(`target-gone-${Date.now()}`);
    persistChatMode('oc_topic_gone_review', 'topic');
    controls.messageReply.mockRejectedValue(axios400(230011, 'recalled'));
    const failure = await connection
      .sendMessage(
        'oc_topic_gone_review#thread:omt_gone#root:om_recalled',
        'answer',
      )
      .catch((error) => error);
    expect(failure).toBeInstanceOf(DefinitiveChannelDeliveryError);
    expect(classifyFeishuError(failure.cause)).toMatchObject({
      kind: 'target_unavailable',
      code: 230011,
    });
    expect(controls.messageReply).toHaveBeenCalledTimes(1);
    // No new top-level topic, no post fallback.
    expect(controls.messageCreate).not.toHaveBeenCalled();
  });

  test.each([
    ['a private chat', 'oc_p2p_review', 'p2p' as const],
    ['an ordinary group', 'oc_group_gone_review', 'group' as const],
  ])(
    'in %s a recalled anchor falls back once to posting into the chat',
    async (_label, chatId, mode) => {
      const { connection } = await connect(`anchor-gone-${mode}-${Date.now()}`);
      persistChatMode(chatId, mode);
      controls.messageReply.mockRejectedValue(axios400(231003, 'deleted'));
      await connection.sendMessage(`${chatId}#root:om_deleted`, 'answer', [], {
        deliveryId: `outbox-anchor-${mode}`,
        chunkIndex: 0,
      });
      expect(controls.messageReply).toHaveBeenCalledTimes(1);
      expect(controls.messageCreate).toHaveBeenCalledTimes(1);
      const created = controls.messageCreate.mock.calls[0][0];
      expect(created.data).toMatchObject({
        receive_id: chatId,
        msg_type: 'interactive',
      });
      // The fallback is a different request: its own uuid.
      expect(created.data.uuid).toEqual(expect.any(String));
      expect(created.data.uuid).not.toBe(
        controls.messageReply.mock.calls[0][0].data.uuid,
      );
    },
  );

  test('the interactive send has a 15s request timeout', async () => {
    vi.useFakeTimers();
    const { connection } = await connect(`card-timeout-${Date.now()}`);
    controls.messageCreate.mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    const pending = connection
      .sendMessage('oc_group', 'hello card')
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(15_001);
    const failure = await pending;
    expect(String(failure?.message)).toMatch(/timed out/i);
    expect(controls.messageCreate).toHaveBeenCalledTimes(1);
  });

  test('a card and its post fallback never share a uuid', async () => {
    const { connection } = await connect(`card-post-uuid-${Date.now()}`);
    controls.messageCreate
      .mockRejectedValueOnce(axios400(230099, 'card content invalid'))
      .mockResolvedValue({ code: 0, data: { message_id: 'om_post' } });
    await connection.sendMessage('oc_group', 'card first', [], {
      deliveryId: 'outbox-card-post',
      chunkIndex: 0,
    });
    const [card, post] = controls.messageCreate.mock.calls.map((c) => c[0]);
    expect(card.data.msg_type).toBe('interactive');
    expect(post.data.msg_type).toBe('post');
    expect(card.data.uuid).toEqual(expect.any(String));
    expect(post.data.uuid).toEqual(expect.any(String));
    expect(card.data.uuid).not.toBe(post.data.uuid);
  });

  test('a model-emitted interactive card cannot @ everyone', async () => {
    const { connection } = await connect(`card-json-at-${Date.now()}`);
    const card = JSON.stringify({
      type: 'interactive',
      card: {
        schema: '2.0',
        body: {
          elements: [
            { tag: 'markdown', content: 'hi <at id=all></at> team' },
            { tag: 'img', img_key: 'img_keep' },
          ],
        },
      },
    });
    await connection.sendMessage('oc_group', card);
    const sent = String(controls.messageCreate.mock.calls[0][0].data.content);
    expect(sent).not.toMatch(/<at id=all>/);
    expect(sent).toContain('&#60;at id=all>');
    expect(sent).toContain('img_keep');

    controls.messageCreate.mockClear();
    const plain = JSON.stringify({
      type: 'interactive',
      card: { schema: '2.0', body: { elements: [] } },
    });
    await connection.sendMessage('oc_group', plain);
    expect(controls.messageCreate.mock.calls[0][0].data.content).toBe(plain);
  });

  test('a DLP refusal is definitive with its Feishu cause and is not retried as post', async () => {
    const { connection } = await connect(`dlp-${Date.now()}`);
    controls.messageCreate.mockRejectedValue(
      axios400(230028, 'contain sensitive data: EMAIL_ADDRESS'),
    );
    const failure = await connection
      .sendMessage('oc_group', 'mail me at a@b.c')
      .catch((error) => error);
    expect(failure).toBeInstanceOf(DefinitiveChannelDeliveryError);
    expect(classifyFeishuError(failure.cause).reason).toContain('敏感信息');
    expect(controls.messageCreate).toHaveBeenCalledTimes(1);
  });

  test('a rate limit resends the same request with backoff and never switches format', async () => {
    vi.useFakeTimers();
    const { connection } = await connect(`rate-${Date.now()}`);
    controls.messageCreate
      .mockRejectedValueOnce(axios400(230020, 'rate limit'))
      .mockRejectedValueOnce(axios400(230020, 'rate limit'))
      .mockResolvedValueOnce({ code: 0, data: { message_id: 'om_ok' } });
    const pending = connection.sendMessage('oc_group', 'hello', [], {
      deliveryId: 'outbox-rate',
      chunkIndex: 0,
    });
    await vi.advanceTimersByTimeAsync(3_100);
    await expect(pending).resolves.toBeUndefined();
    const requests = controls.messageCreate.mock.calls.map((call) => call[0]);
    expect(requests).toHaveLength(3);
    expect(new Set(requests.map((r) => r.data.msg_type))).toEqual(
      new Set(['interactive']),
    );
    expect(new Set(requests.map((r) => r.data.uuid)).size).toBe(1);
  });

  test('an exhausted rate limit is a definitive failure without a post fallback', async () => {
    vi.useFakeTimers();
    const { connection } = await connect(`rate-out-${Date.now()}`);
    controls.messageCreate.mockRejectedValue(
      Object.assign(new Error('Request failed with status code 429'), {
        response: { status: 429, data: { code: 99991400 }, headers: {} },
      }),
    );
    const pending = connection
      .sendMessage('oc_group', 'hello')
      .catch((error) => error);
    await vi.advanceTimersByTimeAsync(20_000);
    const failure = await pending;
    expect(failure).toBeInstanceOf(DefinitiveChannelDeliveryError);
    expect(failure.retryAt).toBeUndefined();
    expect(classifyFeishuError(failure.cause).kind).toBe('rate_limited');
    expect(
      controls.messageCreate.mock.calls.every(
        (call) => call[0].data.msg_type === 'interactive',
      ),
    ).toBe(true);
    expect(controls.messageCreate).toHaveBeenCalledTimes(4);
  });

  test('local preflight failures (#agent: target, unreadable file) are definitive', async () => {
    const { connection } = await connect(`preflight-${Date.now()}`);
    await expect(
      connection.sendMessage('oc_group#agent:650c4d1b', 'x'),
    ).rejects.toBeInstanceOf(DefinitiveChannelDeliveryError);
    await expect(
      connection.sendFile(
        'oc_group',
        path.join(tmpDir, 'missing-file.pdf'),
        'missing-file.pdf',
      ),
    ).rejects.toBeInstanceOf(DefinitiveChannelDeliveryError);
    await expect(
      connection.sendMessage('oc_group', 'x', [path.join(tmpDir, 'nope.png')], {
        presentation: 'native',
      }),
    ).rejects.toMatchObject({ code: 'CHANNEL_DELIVERY_PARTIAL' });
    expect(controls.messageCreate).toHaveBeenCalledTimes(1);
  });

  test('every physical message of an outbox row carries a stable Feishu uuid', async () => {
    const { connection } = await connect(`uuid-${Date.now()}`);
    const send = () =>
      connection.sendMessage('oc_group', 'a'.repeat(320_000), [], {
        presentation: 'native',
        deliveryId: 'outbox-item-1',
        chunkIndex: 2,
      });
    await send();
    const first = controls.messageCreate.mock.calls.map((c) => c[0].data.uuid);
    controls.messageCreate.mockClear();
    await send();
    const replay = controls.messageCreate.mock.calls.map((c) => c[0].data.uuid);
    expect(first.length).toBeGreaterThan(1);
    expect(
      first.every((uuid) => typeof uuid === 'string' && uuid.length <= 50),
    ).toBe(true);
    expect(new Set(first).size).toBe(first.length);
    expect(replay).toEqual(first);

    controls.messageCreate.mockClear();
    await connection.sendImage(
      'oc_group',
      Buffer.from('img'),
      'image/png',
      undefined,
      undefined,
      { deliveryId: 'outbox-item-2', chunkIndex: 0 },
    );
    expect(controls.messageCreate.mock.calls[0]?.[0].data.uuid).toEqual(
      expect.any(String),
    );
  });

  test('text and post payloads cannot @ everyone', async () => {
    const { connection } = await connect(`at-all-${Date.now()}`);
    await connection.sendMessage(
      'oc_group',
      'hi <at user_id="all"></at> and `<at id=all>` in code',
      [],
      { presentation: 'native' },
    );
    const content = String(
      controls.messageCreate.mock.calls[0][0].data.content,
    );
    expect(content).not.toMatch(/<at user_id/);
    expect(content).toContain('＜at user_id');
    expect(content).toContain('`<at id=all>`');
  });
});

describe('OnIt reactions (outbound P2-3)', () => {
  test('a synthetic input id never reaches the reaction API', async () => {
    const { connection } = await connect(`synthetic-onit-${Date.now()}`);
    for (const inputMessageId of [
      'scheduled-task-prompt:3f1c2d4e',
      '6b0c7f2e-1d3a-4b5c-9e8f-0a1b2c3d4e5f',
      'om_bad id',
    ]) {
      await connection.beginAckReaction('oc_p2p_review', inputMessageId);
      await connection.clearAckReaction('oc_p2p_review', inputMessageId);
    }
    expect(controls.reactionCreate).not.toHaveBeenCalled();
    expect(controls.reactionDelete).not.toHaveBeenCalled();
    expect(loggerMock.debug).toHaveBeenCalledWith(
      { inputMessageId: 'scheduled-task-prompt:3f1c2d4e' },
      'Skipped OnIt reaction: input is not a Feishu message id',
    );

    await connection.beginAckReaction('oc_p2p_review', 'om_real_input');
    expect(controls.reactionCreate).toHaveBeenCalledTimes(1);
  });

  test('a reaction that lands after the add timed out is still removed', async () => {
    vi.useFakeTimers();
    const { connection } = await connect(`late-onit-${Date.now()}`);
    let land!: (value: unknown) => void;
    controls.reactionCreate.mockImplementation(
      () => new Promise((resolve) => (land = resolve)),
    );
    const begin = connection.beginAckReaction('oc_p2p_review', 'om_slow_ack');
    await vi.advanceTimersByTimeAsync(10_001);
    await begin;
    await connection.clearAckReaction('oc_p2p_review', 'om_slow_ack');
    expect(controls.reactionDelete).not.toHaveBeenCalled();

    land({ code: 0, data: { reaction_id: 'reaction_late' } });
    await vi.advanceTimersByTimeAsync(1);
    expect(controls.reactionDelete).toHaveBeenCalledWith({
      path: { message_id: 'om_slow_ack', reaction_id: 'reaction_late' },
    });
  });

  test('a late reaction that lands before the batch ends is owned and removed once', async () => {
    vi.useFakeTimers();
    const { connection } = await connect(`late-onit-owned-${Date.now()}`);
    let land!: (value: unknown) => void;
    controls.reactionCreate.mockImplementation(
      () => new Promise((resolve) => (land = resolve)),
    );
    const begin = connection.beginAckReaction('oc_p2p_review', 'om_slow_ack2');
    await vi.advanceTimersByTimeAsync(10_001);
    await begin;
    land({ code: 0, data: { reaction_id: 'reaction_backfilled' } });
    await vi.advanceTimersByTimeAsync(1);
    expect(controls.reactionDelete).not.toHaveBeenCalled();
    await connection.clearAckReaction('oc_p2p_review', 'om_slow_ack2');
    await vi.advanceTimersByTimeAsync(1);
    expect(controls.reactionDelete).toHaveBeenCalledTimes(1);
  });
});
