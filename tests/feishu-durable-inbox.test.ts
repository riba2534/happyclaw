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

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-inbox-test-'));
const tmpStoreDir = path.join(tmpDir, 'db');
const tmpGroupsDir = path.join(tmpDir, 'groups');
fs.mkdirSync(tmpStoreDir, { recursive: true });
fs.mkdirSync(tmpGroupsDir, { recursive: true });

const controls = vi.hoisted(() => ({
  dispatchers: [] as Array<Record<string, (data: any) => Promise<unknown>>>,
  backfillItems: [] as any[],
  messageList: vi.fn(),
  messageGet: vi.fn(),
  messageResourceGet: vi.fn(),
  chatList: vi.fn(),
  messageCreate: vi.fn(),
  messageReply: vi.fn(),
  reactionCreate: vi.fn(),
  reactionDelete: vi.fn(),
}));

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  STORE_DIR: tmpStoreDir,
  GROUPS_DIR: tmpGroupsDir,
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  AppType: { SelfBuild: 'SelfBuild' },
  LoggerLevel: { info: 'info' },
  Client: class {
    request = vi.fn().mockResolvedValue({
      bot: { open_id: 'ou_bot', app_name: 'Inbox Test Bot' },
    });
    im = {
      v1: {
        chat: { list: controls.chatList },
        message: {
          list: controls.messageList,
          get: controls.messageGet,
          create: controls.messageCreate,
        },
        messageReaction: {
          create: vi.fn().mockResolvedValue({
            code: 0,
            data: { reaction_id: 'reaction_1' },
          }),
          delete: vi.fn().mockResolvedValue({ code: 0 }),
        },
      },
      message: {
        reply: controls.messageReply,
      },
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

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const { createFeishuConnection } = await import('../src/feishu.js');
const { ChannelRouteRejectedError } =
  await import('../src/channel-admission.js');
const {
  createChannelTurnRun,
  getChannelCursor,
  getUncertainChannelOutboxForTurn,
  recordChannelInbox,
} = await import('../src/channel-reliability-store.js');
const { deliverChannelOutboxItem } =
  await import('../src/channel-outbox-delivery.js');

const openConnections: Array<{ stop(): Promise<void> }> = [];

beforeAll(() => {
  db.initDatabase();
  db.setRegisteredGroup('web:durable-feishu-test', {
    name: 'Durable Feishu Test',
    folder: 'durable-feishu-test',
    added_at: new Date().toISOString(),
  });
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  controls.dispatchers.length = 0;
  controls.backfillItems = [];
  controls.chatList.mockReset().mockResolvedValue({
    data: { items: [], has_more: false },
  });
  controls.messageList.mockReset().mockImplementation(async () => ({
    data: { items: controls.backfillItems, has_more: false },
  }));
  controls.messageGet.mockReset().mockResolvedValue({ data: { items: [] } });
  controls.messageCreate.mockReset().mockResolvedValue({
    code: 0,
    data: { message_id: 'om_reply' },
  });
  controls.messageReply.mockReset().mockResolvedValue({
    code: 0,
    data: { message_id: 'om_reply' },
  });
  controls.reactionCreate.mockReset().mockResolvedValue({
    code: 0,
    data: { reaction_id: 'reaction_1' },
  });
  controls.reactionDelete.mockReset().mockResolvedValue({ code: 0 });
  controls.messageResourceGet.mockReset().mockResolvedValue({
    getReadableStream: () =>
      (async function* () {
        yield Buffer.from([0x89, 0x50, 0x4e, 0x47]);
      })(),
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await Promise.allSettled(
    openConnections.splice(0).map((item) => item.stop()),
  );
});

function event(messageId: string, createTimeMs: number, text: string) {
  return {
    message: {
      chat_id: 'ou_durable_user',
      message_id: messageId,
      create_time: String(createTimeMs),
      message_type: 'text',
      content: JSON.stringify({ text }),
      chat_type: 'p2p',
    },
    sender: {
      sender_id: { open_id: 'ou_durable_user' },
      sender_type: 'user',
      sender_name: 'Durable User',
    },
  };
}

function backfillItem(messageId: string, createTimeMs: number, text: string) {
  return {
    message_id: messageId,
    create_time: String(createTimeMs),
    msg_type: 'text',
    body: { content: JSON.stringify({ text }) },
    chat_type: 'p2p',
    sender: {
      sender_type: 'user',
      name: 'Durable User',
      sender_id: { open_id: 'ou_durable_user' },
    },
  };
}

type TestConnectOptions = Parameters<
  ReturnType<typeof createFeishuConnection>['connect']
>[0];

async function connect(
  accountId: string,
  executed: ReturnType<typeof vi.fn>,
  overrides: Partial<TestConnectOptions> = {},
) {
  const connection = createFeishuConnection({
    appId: 'app_durable',
    appSecret: 'secret',
    channelAccountId: accountId,
  });
  const dispatcherIndex = controls.dispatchers.length;
  expect(
    await connection.connect({
      onReady: vi.fn(),
      ignoreMessagesBefore: Date.now() + 60_000,
      resolveEffectiveChatJid: (jid) => ({
        effectiveJid: 'web:durable-feishu-test',
        agentId: null,
        sourceJid: jid,
      }),
      onFollowUpMessage: (input) => {
        executed(input.messageId);
        return { disposition: 'started' as const };
      },
      ...overrides,
    }),
  ).toBe(true);
  openConnections.push(connection);
  const handler =
    controls.dispatchers[dispatcherIndex]?.['im.message.receive_v1'];
  expect(handler).toBeTypeOf('function');
  return {
    connection,
    handler,
    handlers: controls.dispatchers[dispatcherIndex]!,
  };
}

describe('Feishu durable Inbox and cursor integration', () => {
  test('safely retries a pre-TLS send failure without fencing the turn', async () => {
    const accountId = `account-pre-tls-retry-${Date.now()}`;
    const connected = await connect(accountId, vi.fn());
    const preTlsFailure = () =>
      Object.assign(
        new Error(
          'Client network socket disconnected before secure TLS connection was established',
        ),
        { code: 'ECONNRESET' },
      );
    controls.messageCreate
      .mockRejectedValueOnce(preTlsFailure())
      .mockRejectedValueOnce(preTlsFailure())
      .mockResolvedValueOnce({
        code: 0,
        data: { message_id: 'om_recovered' },
      });
    const route = {
      provider: 'feishu',
      accountId,
      sourceJid: 'feishu:ou_durable_user',
      chatId: 'ou_durable_user',
    };
    const run = createChannelTurnRun({
      ...route,
      idempotencyKey: `pre-tls-retry-turn-${Date.now()}`,
    }).run;

    vi.useFakeTimers();
    const pending = deliverChannelOutboxItem({
      ...route,
      turnRunId: run.id,
      ordinal: 0,
      kind: 'text',
      payload: { text: '网络恢复后自动送达' },
      owner: 'pre-tls-retry-worker',
      delivery: {
        mode: 'single',
        send: async () => {
          await connected.connection.sendMessage(
            'ou_durable_user',
            '网络恢复后自动送达',
            [],
            { presentation: 'native' },
          );
          return { providerMessageId: 'om_recovered' };
        },
      },
    });
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(pending).resolves.toMatchObject({ status: 'delivered' });
    expect(controls.messageCreate).toHaveBeenCalledTimes(3);
    expect(getUncertainChannelOutboxForTurn(run.id)).toBeUndefined();
  });

  test('records exhausted pre-TLS retries as not delivered instead of uncertain', async () => {
    const accountId = `account-pre-tls-exhausted-${Date.now()}`;
    const connected = await connect(accountId, vi.fn());
    const preTlsFailure = () =>
      Object.assign(
        new Error(
          'Client network socket disconnected before secure TLS connection was established',
        ),
        { code: 'ECONNRESET' },
      );
    controls.messageCreate.mockImplementation(async () => {
      throw preTlsFailure();
    });
    const route = {
      provider: 'feishu',
      accountId,
      sourceJid: 'feishu:ou_durable_user',
      chatId: 'ou_durable_user',
    };
    const run = createChannelTurnRun({
      ...route,
      idempotencyKey: `pre-tls-exhausted-turn-${Date.now()}`,
    }).run;

    vi.useFakeTimers();
    const pending = deliverChannelOutboxItem({
      ...route,
      turnRunId: run.id,
      ordinal: 0,
      kind: 'text',
      payload: { text: '网络持续不可达' },
      owner: 'pre-tls-exhausted-worker',
      delivery: {
        mode: 'single',
        send: async () => {
          await connected.connection.sendMessage(
            'ou_durable_user',
            '网络持续不可达',
            [],
            { presentation: 'native' },
          );
          return { providerMessageId: 'must-not-succeed' };
        },
      },
    });
    await vi.advanceTimersByTimeAsync(6_000);
    await expect(pending).resolves.toMatchObject({
      status: 'failed',
      error: expect.stringContaining('before the request was sent'),
    });
    expect(controls.messageCreate).toHaveBeenCalledTimes(3);
    expect(getUncertainChannelOutboxForTurn(run.id)).toBeUndefined();
  });

  test('classifies an Axios-style content-audit HTTP 400 as a definitive Outbox failure', async () => {
    const accountId = `account-content-audit-${Date.now()}`;
    const connected = await connect(accountId, vi.fn());
    controls.messageCreate.mockRejectedValueOnce(
      Object.assign(new Error('Request failed with status code 400'), {
        response: {
          status: 400,
          data: {
            code: 230028,
            msg: 'The messages do NOT pass the audit, ext=contain sensitive data: EMAIL_ADDRESS',
          },
        },
      }),
    );
    const route = {
      provider: 'feishu',
      accountId,
      sourceJid: 'feishu:ou_durable_user',
      chatId: 'ou_durable_user',
    };
    const run = createChannelTurnRun({
      ...route,
      idempotencyKey: `content-audit-turn-${Date.now()}`,
    }).run;

    const result = await deliverChannelOutboxItem({
      ...route,
      turnRunId: run.id,
      ordinal: 0,
      kind: 'text',
      payload: { text: 'general@incubator.apache.org' },
      owner: 'content-audit-worker',
      delivery: {
        mode: 'single',
        send: async () => {
          await connected.connection.sendMessage(
            'ou_durable_user',
            'general@incubator.apache.org',
            [],
            { presentation: 'native' },
          );
          return { providerMessageId: 'must-not-succeed' };
        },
      },
    });

    expect(result).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('code=230028'),
    });
    expect(result.error).toContain('EMAIL_ADDRESS');
    expect(getUncertainChannelOutboxForTurn(run.id)).toBeUndefined();
    expect(controls.messageCreate).toHaveBeenCalledTimes(1);
  });

  test('adds OnIt only when the active batch explicitly acquires it', async () => {
    const connected = await connect(`account-batch-ack-${Date.now()}`, vi.fn());
    const messageId = 'om_batch_ack';

    await connected.handler(event(messageId, Date.now(), '排队时不要打表情'));
    expect(controls.reactionCreate).not.toHaveBeenCalled();
    expect(connected.handlers['im.message.reaction.created_v1']).toBeTypeOf(
      'function',
    );
    expect(connected.handlers['im.message.reaction.deleted_v1']).toBeTypeOf(
      'function',
    );

    await connected.connection.beginAckReaction('ou_durable_user', messageId);
    expect(controls.reactionCreate).toHaveBeenCalledWith({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: 'OnIt' } },
    });

    await connected.connection.clearAckReaction('ou_durable_user', messageId);
    expect(controls.reactionDelete).toHaveBeenCalledWith({
      path: { message_id: messageId, reaction_id: 'reaction_1' },
    });
  });

  test('durably queues a busy follow-up without sending an action card', async () => {
    const accountId = `account-silent-queue-${Date.now()}`;
    const followUp = vi.fn(() => ({
      disposition: 'queued' as const,
      runId: 'run-busy',
      position: 1,
    }));
    const connected = await connect(accountId, vi.fn(), {
      onFollowUpMessage: followUp,
    });

    await connected.handler(
      event('om_silent_queue', Date.now(), '自然排队，不要发卡片'),
    );

    expect(controls.messageCreate).not.toHaveBeenCalled();
    expect(controls.messageReply).not.toHaveBeenCalled();
    expect(followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        targetJid: 'web:durable-feishu-test',
        messageId: 'om_silent_queue',
        requestedMode: undefined,
      }),
    );
  });

  test('a real group mention with exact /steer strips the directive and requests immediate steering', async () => {
    const accountId = `account-steer-command-${Date.now()}`;
    const followUp = vi.fn(() => ({
      disposition: 'steered' as const,
      runId: 'run-busy',
    }));
    const connected = await connect(accountId, vi.fn(), {
      shouldProcessGroupMessage: () => true,
      onFollowUpMessage: followUp,
    });
    const messageId = 'om_real_steer';
    const createTime = Date.now();

    await connected.handler({
      ...event(messageId, createTime, ''),
      message: {
        ...event(messageId, createTime, '').message,
        chat_id: 'oc_steer_group',
        chat_type: 'group',
        content: JSON.stringify({ text: '@_user_1 /steer 优先处理这件事' }),
        mentions: [
          {
            key: '@_user_1',
            name: 'Inbox Test Bot',
            id: { open_id: 'ou_bot' },
          },
        ],
      },
    });

    expect(followUp).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceJid: 'feishu:oc_steer_group',
        targetJid: 'web:durable-feishu-test',
        messageId,
        requestedMode: 'steer',
      }),
    );
    expect(
      db
        .getMessagesSince('web:durable-feishu-test', {
          timestamp: '',
          id: '',
        })
        .find((message) => message.id === messageId)?.content,
    ).toBe('优先处理这件事');
    expect(controls.messageCreate).not.toHaveBeenCalled();
    expect(controls.messageReply).not.toHaveBeenCalled();
  });

  test('only a real Bot mention can execute the exact lowercase /break command in a group', async () => {
    const accountId = `account-break-command-${Date.now()}`;
    const onSessionBreak = vi.fn().mockResolvedValue('Current task stopped.');
    const executed = vi.fn();
    const connected = await connect(accountId, executed, {
      shouldProcessGroupMessage: () => true,
      resolveEffectiveChatJid: (jid, meta) => ({
        effectiveJid: meta?.threadId
          ? 'web:durable-feishu-test#agent:break-thread-agent'
          : 'web:durable-feishu-test',
        agentId: meta?.threadId ? 'break-thread-agent' : null,
        sourceJid: jid,
      }),
      onSessionBreak,
    });
    const createTime = Date.now();

    await connected.handler({
      ...event('om_real_break', createTime, ''),
      message: {
        ...event('om_real_break', createTime, '').message,
        chat_id: 'oc_break_group',
        chat_type: 'group',
        root_id: 'om_break_root',
        parent_id: 'om_break_root',
        thread_id: 'omt_break_thread',
        content: JSON.stringify({ text: '@_user_1 /break' }),
        mentions: [
          {
            key: '@_user_1',
            name: 'Inbox Test Bot',
            id: { open_id: 'ou_bot' },
          },
        ],
      },
    });

    expect(onSessionBreak).toHaveBeenCalledWith({
      sourceJid: 'feishu:oc_break_group',
      targetJid: 'web:durable-feishu-test#agent:break-thread-agent',
      senderImId: 'ou_durable_user',
    });
    expect(executed).not.toHaveBeenCalledWith('om_real_break');
    expect(controls.messageReply).toHaveBeenCalledTimes(1);

    controls.messageReply.mockClear();
    await connected.handler({
      ...event('om_fake_break', createTime + 1, ''),
      message: {
        ...event('om_fake_break', createTime + 1, '').message,
        chat_id: 'oc_break_group',
        chat_type: 'group',
        content: JSON.stringify({ text: '@Inbox Test Bot /break' }),
        mentions: [],
      },
    });

    expect(onSessionBreak).toHaveBeenCalledTimes(1);
    expect(executed).toHaveBeenCalledWith('om_fake_break');
    expect(controls.messageReply).not.toHaveBeenCalled();
  });

  test('only a real Bot mention can execute exact lowercase /clear', async () => {
    const accountId = `account-clear-command-${Date.now()}`;
    const onSessionClear = vi
      .fn()
      .mockResolvedValue('Session context cleared.');
    const executed = vi.fn();
    const connected = await connect(accountId, executed, {
      shouldProcessGroupMessage: () => true,
      resolveEffectiveChatJid: (jid, meta) => ({
        effectiveJid: meta?.threadId
          ? 'web:durable-feishu-test#agent:thread-agent'
          : 'web:durable-feishu-test',
        agentId: meta?.threadId ? 'thread-agent' : null,
        sourceJid: jid,
      }),
      onSessionClear,
    });
    const createTime = Date.now();
    const mentioned = {
      key: '@_user_1',
      name: 'Inbox Test Bot',
      id: { open_id: 'ou_bot' },
    };

    await connected.handler({
      ...event('om_real_clear', createTime, ''),
      message: {
        ...event('om_real_clear', createTime, '').message,
        chat_id: 'oc_clear_group',
        chat_type: 'group',
        root_id: 'om_clear_root',
        parent_id: 'om_clear_root',
        thread_id: 'omt_clear_thread',
        content: JSON.stringify({ text: '@_user_1 /clear' }),
        mentions: [mentioned],
      },
    });

    expect(onSessionClear).toHaveBeenCalledWith({
      sourceJid: 'feishu:oc_clear_group',
      targetJid: 'web:durable-feishu-test#agent:thread-agent',
      senderImId: 'ou_durable_user',
    });
    expect(executed).not.toHaveBeenCalledWith('om_real_clear');
    expect(controls.messageReply).toHaveBeenCalledTimes(1);

    controls.messageReply.mockClear();
    await connected.handler({
      ...event('om_fake_clear', createTime + 1, ''),
      message: {
        ...event('om_fake_clear', createTime + 1, '').message,
        chat_id: 'oc_clear_group',
        chat_type: 'group',
        content: JSON.stringify({ text: '@Inbox Test Bot /clear' }),
        mentions: [],
      },
    });

    expect(onSessionClear).toHaveBeenCalledTimes(1);
    expect(executed).toHaveBeenCalledWith('om_fake_clear');
    expect(controls.messageReply).not.toHaveBeenCalled();
  });

  test('only a real Bot mention can execute exact lowercase /fresh on the thread session', async () => {
    const accountId = `account-fresh-command-${Date.now()}`;
    const onSessionFresh = vi
      .fn()
      .mockResolvedValue('已开启新上下文窗口（零摘要换窗）✓');
    const executed = vi.fn();
    const connected = await connect(accountId, executed, {
      shouldProcessGroupMessage: () => true,
      resolveEffectiveChatJid: (jid, meta) => ({
        effectiveJid: meta?.threadId
          ? 'web:durable-feishu-test#agent:thread-agent'
          : 'web:durable-feishu-test',
        agentId: meta?.threadId ? 'thread-agent' : null,
        sourceJid: jid,
      }),
      onSessionFresh,
    });
    const createTime = Date.now();
    const mentioned = {
      key: '@_user_1',
      name: 'Inbox Test Bot',
      id: { open_id: 'ou_bot' },
    };

    await connected.handler({
      ...event('om_real_fresh', createTime, ''),
      message: {
        ...event('om_real_fresh', createTime, '').message,
        chat_id: 'oc_fresh_group',
        chat_type: 'group',
        root_id: 'om_fresh_root',
        parent_id: 'om_fresh_root',
        thread_id: 'omt_fresh_thread',
        content: JSON.stringify({ text: '@_user_1 /fresh 已修好登录' }),
        mentions: [mentioned],
      },
    });

    expect(onSessionFresh).toHaveBeenCalledWith({
      sourceJid: 'feishu:oc_fresh_group',
      targetJid: 'web:durable-feishu-test#agent:thread-agent',
      senderImId: 'ou_durable_user',
      notes: '已修好登录',
    });
    expect(executed).not.toHaveBeenCalledWith('om_real_fresh');
    expect(controls.messageReply).toHaveBeenCalledTimes(1);

    controls.messageReply.mockClear();
    await connected.handler({
      ...event('om_fake_fresh', createTime + 1, ''),
      message: {
        ...event('om_fake_fresh', createTime + 1, '').message,
        chat_id: 'oc_fresh_group',
        chat_type: 'group',
        content: JSON.stringify({ text: '@Inbox Test Bot /fresh later' }),
        mentions: [],
      },
    });

    expect(onSessionFresh).toHaveBeenCalledTimes(1);
    expect(executed).toHaveBeenCalledWith('om_fake_fresh');
    expect(controls.messageReply).not.toHaveBeenCalled();
  });

  test.each(['p2p', 'group'] as const)(
    'an unbound %s stays silent before commands, reactions and routing',
    async (chatType) => {
      const accountId = `unbound-side-effects-${chatType}`;
      const executed = vi.fn();
      const onCommand = vi.fn();
      const onNewChat = vi.fn();
      const onP2pSender = vi.fn();
      const resolveEffectiveChatJid = vi.fn();
      const connected = await connect(accountId, executed, {
        isChatBound: () => false,
        isSenderAllowedInGroup: () => true,
        onNewChat,
        onP2pSender,
        onCommand,
        resolveEffectiveChatJid,
      });
      const input = event(`unbound-${chatType}`, Date.now(), '/help');
      input.message.chat_type = chatType;
      await connected.handler(input);
      expect(executed).not.toHaveBeenCalled();
      expect(onCommand).not.toHaveBeenCalled();
      expect(resolveEffectiveChatJid).not.toHaveBeenCalled();
      expect(controls.messageCreate).not.toHaveBeenCalled();
      expect(controls.messageReply).not.toHaveBeenCalled();
      expect(controls.reactionCreate).not.toHaveBeenCalled();
      expect(onNewChat).toHaveBeenCalledTimes(chatType === 'p2p' ? 1 : 0);
    },
  );

  test('an unbound stranger cannot claim the private-chat owner during discovery', async () => {
    const onNewChat = vi.fn();
    const onP2pSender = vi.fn();
    const connected = await connect('unbound-stranger', vi.fn(), {
      isChatBound: () => false,
      isSenderAllowedInGroup: () => false,
      onNewChat,
      onP2pSender,
    });
    await connected.handler(
      event('unbound-stranger-message', Date.now(), 'hello'),
    );
    expect(onNewChat).not.toHaveBeenCalled();
    expect(onP2pSender).not.toHaveBeenCalled();
    expect(controls.messageCreate).not.toHaveBeenCalled();
    expect(controls.reactionCreate).not.toHaveBeenCalled();
  });

  test('binding and then unbinding takes effect on the next inbound message', async () => {
    let bound = false;
    const executed = vi.fn();
    const connected = await connect('bind-transition', executed, {
      isChatBound: () => bound,
      isSenderAllowedInGroup: () => true,
    });
    await connected.handler(event('before-bind', Date.now(), 'hello'));
    bound = true;
    await connected.handler(event('after-bind', Date.now(), 'hello'));
    bound = false;
    await connected.handler(event('after-unbind', Date.now(), 'hello'));
    expect(executed.mock.calls).toEqual([['after-bind']]);
  });

  test('bootstraps the first P2P DM after an account-scoped route rejection', async () => {
    const accountId = `account-first-dm-${Date.now()}`;
    const executed = vi.fn();
    const onNewChat = vi.fn();
    const onP2pSender = vi.fn();
    let registered = false;
    onNewChat.mockImplementation(() => {
      registered = true;
    });
    const resolveEffectiveChatJid = vi.fn((jid: string) => {
      if (!registered) throw new ChannelRouteRejectedError(jid);
      return {
        effectiveJid: 'web:durable-feishu-test',
        agentId: null,
        sourceJid: jid,
      };
    });
    const connected = await connect(accountId, executed, {
      normalizeIncomingJid: (jid) => `${jid}#account:${accountId}`,
      resolveEffectiveChatJid,
      isSenderAllowedInGroup: () => true,
      onNewChat,
      onP2pSender,
    });

    await connected.handler(event('om_first_dm', Date.now(), 'hello'));

    expect(resolveEffectiveChatJid).toHaveBeenCalledTimes(2);
    expect(resolveEffectiveChatJid).toHaveBeenNthCalledWith(
      1,
      `feishu:ou_durable_user#account:${accountId}`,
    );
    expect(onNewChat).toHaveBeenCalledWith(
      `feishu:ou_durable_user#account:${accountId}`,
      '飞书私聊',
    );
    expect(onP2pSender).toHaveBeenCalledWith('ou_durable_user');
    expect(executed).toHaveBeenCalledWith('om_first_dm');
  });

  test('treats an unbound group route as terminal without retry feedback', async () => {
    const accountId = `account-unbound-group-${Date.now()}`;
    const executed = vi.fn();
    const connected = await connect(accountId, executed, {
      resolveEffectiveChatJid: (jid) => {
        throw new ChannelRouteRejectedError(jid);
      },
    });
    const messageId = `om_unbound_group_${Date.now()}`;

    await connected.handler({
      ...event(messageId, Date.now(), '不应重试'),
      message: {
        ...event(messageId, Date.now(), '不应重试').message,
        chat_id: 'oc_unbound_group',
        chat_type: 'group',
      },
    });

    expect(executed).not.toHaveBeenCalled();
    expect(controls.messageCreate).not.toHaveBeenCalled();
    expect(
      recordChannelInbox({
        provider: 'feishu',
        accountId,
        externalMessageId: messageId,
        sourceJid: 'feishu:oc_unbound_group',
        chatId: 'oc_unbound_group',
        status: 'queued',
      }).item,
    ).toMatchObject({
      status: 'ignored',
      attempt: 1,
      error: 'binding_rejected',
    });
  });

  test('rejects a known-owner mismatch before P2P registration or routing', async () => {
    const accountId = `account-owner-gate-${Date.now()}`;
    const executed = vi.fn();
    const onNewChat = vi.fn();
    const onP2pSender = vi.fn();
    const resolveEffectiveChatJid = vi.fn();
    const connected = await connect(accountId, executed, {
      normalizeIncomingJid: (jid) => `${jid}#account:${accountId}`,
      resolveEffectiveChatJid,
      isSenderAllowedInGroup: (_jid, sender) => sender === 'ou_owner',
      onNewChat,
      onP2pSender,
    });

    await connected.handler(
      event('om_non_owner_first_dm', Date.now(), 'not the owner'),
    );

    expect(onNewChat).not.toHaveBeenCalled();
    expect(onP2pSender).not.toHaveBeenCalled();
    expect(resolveEffectiveChatJid).not.toHaveBeenCalled();
    expect(executed).not.toHaveBeenCalled();
  });

  test('does not bootstrap P2P registration after an unrelated route failure', async () => {
    const accountId = `account-route-error-${Date.now()}`;
    const executed = vi.fn();
    const onNewChat = vi.fn();
    const onP2pSender = vi.fn();
    const resolveEffectiveChatJid = vi.fn(() => {
      throw new Error('route storage unavailable');
    });
    const connected = await connect(accountId, executed, {
      resolveEffectiveChatJid,
      isSenderAllowedInGroup: () => true,
      onNewChat,
      onP2pSender,
    });

    await connected.handler(
      event('om_route_error', Date.now(), 'do not register'),
    );

    expect(resolveEffectiveChatJid).toHaveBeenCalledTimes(1);
    expect(onNewChat).not.toHaveBeenCalled();
    expect(onP2pSender).not.toHaveBeenCalled();
    expect(executed).not.toHaveBeenCalled();
  });

  test('does not register an owner merely because a user opens the P2P chat', async () => {
    const accountId = `account-no-enter-claim-${Date.now()}`;
    const connected = await connect(accountId, vi.fn(), {
      onNewChat: vi.fn(),
      onP2pSender: vi.fn(),
    });

    expect(
      connected.handlers['im.chat.access_event.bot_p2p_chat_entered_v1'],
    ).toBeUndefined();
  });

  test('recovery gate queues a live event and executes it only after the gate opens', async () => {
    const accountId = `account-recovery-gate-${Date.now()}`;
    const executed = vi.fn();
    let deferred = true;
    const connected = await connect(accountId, executed, {
      shouldDeferInbound: () => deferred,
    });
    vi.useFakeTimers();

    await connected.handler(
      event('om_during_recovery_gate', Date.now(), 'wait for recovery'),
    );
    expect(executed).not.toHaveBeenCalled();
    expect(
      recordChannelInbox({
        provider: 'feishu',
        accountId,
        externalMessageId: 'om_during_recovery_gate',
        sourceJid: 'feishu:ou_durable_user',
        chatId: 'ou_durable_user',
        status: 'queued',
      }).item.status,
    ).toBe('queued');

    deferred = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(executed).toHaveBeenCalledTimes(1);
    expect(executed).toHaveBeenCalledWith('om_during_recovery_gate');
    expect(
      recordChannelInbox({
        provider: 'feishu',
        accountId,
        externalMessageId: 'om_during_recovery_gate',
        sourceJid: 'feishu:ou_durable_user',
        chatId: 'ou_durable_user',
        status: 'queued',
      }).item.status,
    ).toBe('processed');
  });

  test('downloads a merged-forward child image using the outer owner message id', async () => {
    const accountId = `account-forward-image-${Date.now()}`;
    const executed = vi.fn();
    controls.messageGet.mockResolvedValue({
      data: {
        items: [
          {
            message_id: 'om_forward_owner_test',
            msg_type: 'merge_forward',
            body: { content: 'Merged and Forwarded Message' },
          },
          {
            message_id: 'om_forward_child_image',
            upper_message_id: 'om_forward_owner_test',
            msg_type: 'image',
            body: {
              content: JSON.stringify({ image_key: 'img_child_owned' }),
            },
          },
        ],
      },
    });
    const connected = await connect(accountId, executed);

    await connected.handler({
      ...event('om_forward_owner_test', Date.now(), ''),
      message: {
        ...event('om_forward_owner_test', Date.now(), '').message,
        message_type: 'merge_forward',
        content: 'Merged and Forwarded Message',
      },
    });

    expect(controls.messageResourceGet).toHaveBeenCalledWith(
      expect.objectContaining({
        path: {
          message_id: 'om_forward_owner_test',
          file_key: 'img_child_owned',
        },
        params: { type: 'image' },
      }),
    );
    expect(executed).not.toHaveBeenCalled();
    expect(
      db
        .getMessagesPage('web:durable-feishu-test')
        .find((message) => message.id === 'om_forward_owner_test'),
    ).toMatchObject({ delivery_status: 'awaiting_companion' });
  });

  test('requests safe merged-forward coalescing while preserving both structural roles', async () => {
    const accountId = `account-forward-companion-${Date.now()}`;
    const followUps = vi.fn(() => ({ disposition: 'started' as const }));
    controls.messageGet.mockResolvedValue({
      data: {
        items: [
          {
            message_id: 'om_forward_bundle_root',
            msg_type: 'merge_forward',
            create_time: '1000',
            sender: { id: 'ou_durable_user', name: 'Durable User' },
            body: { content: 'Merged and Forwarded Message' },
          },
          {
            message_id: 'om_forward_bundle_child',
            upper_message_id: 'om_forward_bundle_root',
            msg_type: 'text',
            sender: { id: 'ou_customer', name: 'Customer' },
            body: {
              content: JSON.stringify({ text: '被转发的客诉正文' }),
            },
          },
        ],
      },
    });
    const connected = await connect(accountId, vi.fn(), {
      onFollowUpMessage: followUps as TestConnectOptions['onFollowUpMessage'],
    });
    const createTime = Date.now();

    await Promise.all([
      connected.handler({
        ...event('om_forward_bundle_root', createTime, ''),
        message: {
          ...event('om_forward_bundle_root', createTime, '').message,
          message_type: 'merge_forward',
          content: 'Merged and Forwarded Message',
        },
      }),
      connected.handler({
        ...event('om_forward_bundle_note', createTime + 9_000, '怎么处理？'),
        message: {
          ...event('om_forward_bundle_note', createTime + 9_000, '怎么处理？')
            .message,
          root_id: 'om_forward_bundle_root',
          parent_id: 'om_forward_bundle_root',
        },
      }),
    ]);

    expect(followUps).toHaveBeenCalledTimes(1);
    expect(followUps).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'om_forward_bundle_note',
        requestedMode: undefined,
        coalesceBundleId: 'om_forward_bundle_root',
      }),
    );
    expect(
      db.getMessageChannelTurnContext(
        'web:durable-feishu-test',
        'om_forward_bundle_root',
      )?.message.contentLink,
    ).toMatchObject({
      kind: 'forward_bundle',
      bundleId: 'om_forward_bundle_root',
      role: 'forwarded_content',
      materialResolved: true,
    });
    const noteContext = db.getMessageChannelTurnContext(
      'web:durable-feishu-test',
      'om_forward_bundle_note',
    );
    expect(noteContext?.message.contentLink).toMatchObject({
      bundleId: 'om_forward_bundle_root',
      role: 'forwarder_comment',
    });
    expect(noteContext?.message.referencedMessages?.[0]).toMatchObject({
      id: 'om_forward_bundle_root',
      text: expect.stringContaining('被转发的客诉正文'),
      contentLink: {
        bundleId: 'om_forward_bundle_root',
        role: 'forwarded_content',
      },
    });
    expect(controls.messageGet).toHaveBeenCalledTimes(1);
    expect(
      db
        .getMessagesSince('web:durable-feishu-test', {
          timestamp: new Date(createTime - 1).toISOString(),
          id: '',
        })
        .filter(
          (message) =>
            message.id === 'om_forward_bundle_root' ||
            message.id === 'om_forward_bundle_note',
        )
        .map((message) => message.id),
    ).toEqual(['om_forward_bundle_root', 'om_forward_bundle_note']);
    expect(
      recordChannelInbox({
        provider: 'feishu',
        accountId,
        externalMessageId: 'om_forward_bundle_root',
        sourceJid: 'feishu:ou_durable_user',
        chatId: 'ou_durable_user',
        status: 'queued',
      }).item.status,
    ).toBe('ignored');
  });

  test('coalesces an immediate image-root caption into one vision turn', async () => {
    const accountId = `account-image-caption-${Date.now()}`;
    const executed = vi.fn();
    const rootId = `om_image_caption_root_${Date.now()}`;
    const noteId = `${rootId}_note`;
    const threadId = `omt_image_caption_${Date.now()}`;
    const createTime = Date.now();
    const connected = await connect(accountId, executed);
    const groupEvent = (messageId: string, time: number) => ({
      ...event(messageId, time, ''),
      message: {
        ...event(messageId, time, '').message,
        chat_id: 'oc_image_caption_group',
        chat_type: 'group',
        thread_id: threadId,
      },
    });

    await connected.handler({
      ...groupEvent(rootId, createTime),
      message: {
        ...groupEvent(rootId, createTime).message,
        message_type: 'image',
        content: JSON.stringify({ image_key: 'img_caption_root' }),
      },
    });
    expect(executed).not.toHaveBeenCalled();
    expect(
      db
        .getMessagesPage('web:durable-feishu-test')
        .find((message) => message.id === rootId),
    ).toMatchObject({
      delivery_status: 'awaiting_companion',
      attachments: expect.any(String),
      channel_context: {
        message: {
          contentLink: {
            kind: 'forward_bundle',
            role: 'forwarded_content',
            materialResolved: true,
          },
        },
      },
    });

    await connected.handler({
      ...groupEvent(noteId, createTime + 1_500),
      message: {
        ...groupEvent(noteId, createTime + 1_500).message,
        message_type: 'text',
        content: JSON.stringify({ text: '理解一下这张图的含义。' }),
        root_id: rootId,
        parent_id: rootId,
      },
    });

    expect(executed).toHaveBeenCalledTimes(1);
    expect(executed).toHaveBeenCalledWith(noteId);
    const note = db
      .getMessagesPage('web:durable-feishu-test')
      .find((message) => message.id === noteId);
    expect(note).toMatchObject({
      content: '理解一下这张图的含义。',
      attachments: expect.any(String),
      channel_context: {
        message: {
          contentLink: {
            kind: 'forward_bundle',
            bundleId: rootId,
            role: 'forwarder_comment',
          },
          referencedMessages: [
            expect.objectContaining({
              id: rootId,
              text: '[图片]',
              materialResolved: true,
            }),
          ],
        },
      },
    });
    expect(controls.messageResourceGet).toHaveBeenCalledTimes(1);
    expect(controls.messageGet).not.toHaveBeenCalled();
    expect(
      recordChannelInbox({
        provider: 'feishu',
        accountId,
        externalMessageId: rootId,
        sourceJid: 'feishu:oc_image_caption_group',
        chatId: 'oc_image_caption_group',
        status: 'queued',
      }).item.status,
    ).toBe('ignored');
  });

  test('keeps a held root and its note in one queued follow-up batch', async () => {
    const accountId = `account-forward-queued-${Date.now()}`;
    const rootId = `om_forward_queued_${Date.now()}`;
    const noteId = `${rootId}_note`;
    const createTime = Date.now();
    controls.messageGet.mockResolvedValue({
      data: {
        items: [
          {
            message_id: rootId,
            msg_type: 'merge_forward',
            create_time: String(createTime),
            sender: { id: 'ou_durable_user', name: 'Durable User' },
            body: { content: 'Merged and Forwarded Message' },
          },
          {
            message_id: `${rootId}_child`,
            upper_message_id: rootId,
            msg_type: 'text',
            sender: { id: 'ou_customer', name: 'Customer' },
            body: { content: JSON.stringify({ text: '排队时也不能拆开' }) },
          },
        ],
      },
    });
    const connected = await connect(accountId, vi.fn(), {
      onFollowUpMessage: vi.fn((input) => {
        expect(
          db.setMessageFollowUp(input.targetJid, input.messageId, {
            mode: 'queue',
            status: 'queued',
            runId: 'run-unrelated-active',
          }),
        ).toBe(true);
        return {
          disposition: 'queued' as const,
          runId: 'run-unrelated-active',
          position: 1,
        };
      }) as TestConnectOptions['onFollowUpMessage'],
    });

    await connected.handler({
      ...event(rootId, createTime, ''),
      message: {
        ...event(rootId, createTime, '').message,
        message_type: 'merge_forward',
        content: 'Merged and Forwarded Message',
      },
    });
    await connected.handler({
      ...event(noteId, createTime + 300, '请处理'),
      message: {
        ...event(noteId, createTime + 300, '请处理').message,
        root_id: rootId,
        parent_id: rootId,
      },
    });

    expect(
      db.listQueuedFollowUps('web:durable-feishu-test').map((item) => item.id),
    ).toEqual([rootId, noteId]);
    expect(
      db
        .claimNextQueuedFollowUpBatch(
          'web:durable-feishu-test',
          'run-forward-batch',
        )
        .map((item) => item.id),
    ).toEqual([rootId, noteId]);
  });

  test('promotes an admitted forward without a note to one default-summary turn', async () => {
    const accountId = `account-forward-default-${Date.now()}`;
    const executed = vi.fn();
    const rootId = `om_forward_default_${Date.now()}`;
    const createTime = Date.now();
    controls.messageGet.mockResolvedValue({
      data: {
        items: [
          {
            message_id: rootId,
            msg_type: 'merge_forward',
            create_time: String(createTime),
            sender: { id: 'ou_durable_user', name: 'Durable User' },
            body: { content: 'Merged and Forwarded Message' },
          },
          {
            message_id: `${rootId}_child`,
            upper_message_id: rootId,
            msg_type: 'text',
            sender: { id: 'ou_customer', name: 'Customer' },
            body: { content: JSON.stringify({ text: '默认需要理解的材料' }) },
          },
        ],
      },
    });
    const connected = await connect(accountId, executed);

    vi.useFakeTimers();
    await connected.handler({
      ...event(rootId, createTime, ''),
      message: {
        ...event(rootId, createTime, '').message,
        message_type: 'merge_forward',
        content: 'Merged and Forwarded Message',
      },
    });

    expect(executed).not.toHaveBeenCalled();
    expect(
      db
        .getMessagesPage('web:durable-feishu-test')
        .find((message) => message.id === rootId),
    ).toMatchObject({ delivery_status: 'awaiting_companion' });
    expect(
      db
        .getMessagesSince('web:durable-feishu-test', {
          timestamp: new Date(createTime - 1).toISOString(),
          id: '',
        })
        .some((message) => message.id === rootId),
    ).toBe(false);

    await vi.advanceTimersByTimeAsync(3_100);

    expect(executed).toHaveBeenCalledTimes(1);
    expect(executed).toHaveBeenCalledWith(rootId);
    expect(controls.messageGet).toHaveBeenCalledTimes(1);
    expect(
      db.getMessageChannelTurnContext('web:durable-feishu-test', rootId)
        ?.message.contentLink,
    ).toMatchObject({
      bundleId: rootId,
      role: 'forwarded_content',
      materialResolved: true,
      defaultAction: 'summarize',
    });
    expect(
      db
        .getMessagesPage('web:durable-feishu-test')
        .find((message) => message.id === rootId),
    ).toMatchObject({ delivery_status: null });
    expect(
      db
        .getMessagesSince('web:durable-feishu-test', {
          timestamp: new Date(createTime - 1).toISOString(),
          id: '',
        })
        .some((message) => message.id === rootId),
    ).toBe(true);
  });

  test('coalesces the real rapid topic root+reply event shape as one complete request', async () => {
    const accountId = `account-rapid-topic-${Date.now()}`;
    const rootId = 'om_x100rapidtopicroot000000000000001';
    const noteId = 'om_x100rapidtopicnote000000000000002';
    const threadId = 'omt_rapidtopic000000000000001';
    const createTime = Date.now();
    const followUps = vi.fn((input: { messageId: string }) =>
      input.messageId === rootId
        ? { disposition: 'started' as const }
        : { disposition: 'steered' as const, runId: 'run_topic_root' },
    );
    controls.messageGet.mockResolvedValue({
      data: {
        items: [
          {
            message_id: rootId,
            msg_type: 'text',
            create_time: String(createTime),
            thread_id: threadId,
            chat_type: 'group',
            sender: { id: 'ou_durable_user', name: 'Durable User' },
            body: {
              content: JSON.stringify({
                text: 'https://github.com/example/example-repo',
              }),
            },
          },
        ],
      },
    });
    const connected = await connect(accountId, vi.fn(), {
      onFollowUpMessage: followUps as TestConnectOptions['onFollowUpMessage'],
    });
    const groupEvent = (messageId: string, time: number, text: string) => ({
      ...event(messageId, time, text),
      message: {
        ...event(messageId, time, text).message,
        chat_id: 'oc_rapid_topic_group',
        chat_type: 'group',
        thread_id: threadId,
      },
    });

    await connected.handler(
      groupEvent(rootId, createTime, 'https://github.com/example/example-repo'),
    );
    await connected.handler({
      ...groupEvent(noteId, createTime + 287, '<p>请克隆并分析这个仓库。</p>'),
      message: {
        ...groupEvent(noteId, createTime + 287, '<p>请克隆并分析这个仓库。</p>')
          .message,
        root_id: rootId,
        parent_id: rootId,
      },
    });

    expect(followUps).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        messageId: rootId,
        coalesceBundleId: undefined,
      }),
    );
    expect(followUps).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        messageId: noteId,
        requestedMode: undefined,
        coalesceBundleId: rootId,
      }),
    );
    expect(
      db.getMessageChannelTurnContext('web:durable-feishu-test', rootId)
        ?.message.contentLink,
    ).toBeUndefined();
    const noteContext = db.getMessageChannelTurnContext(
      'web:durable-feishu-test',
      noteId,
    );
    expect(noteContext?.message.contentLink).toEqual({
      kind: 'rapid_topic_bundle',
      bundleId: rootId,
      role: 'forwarder_comment',
      relatedMessageId: rootId,
    });
    expect(noteContext?.message.referencedMessages?.[0]).toMatchObject({
      id: rootId,
      text: 'https://github.com/example/example-repo',
      contentLink: {
        kind: 'rapid_topic_bundle',
        bundleId: rootId,
        role: 'forwarded_content',
      },
    });
    expect(
      db
        .getMessagesSince('web:durable-feishu-test', {
          timestamp: '',
          id: '',
        })
        .find((message) => message.id === noteId)?.content,
    ).toBe('请克隆并分析这个仓库。');
  });

  test('note-first intake preserves a late root without scheduling it twice', async () => {
    const accountId = `account-forward-note-first-${Date.now()}`;
    const executed = vi.fn();
    const rootId = `om_note_first_root_${Date.now()}`;
    const noteId = `${rootId}_note`;
    const rootTime = Date.now();
    controls.messageGet.mockResolvedValue({
      data: {
        items: [
          {
            message_id: rootId,
            msg_type: 'merge_forward',
            create_time: String(rootTime),
            sender: { id: 'ou_durable_user', name: 'Durable User' },
            body: { content: 'Merged and Forwarded Message' },
          },
          {
            message_id: `${rootId}_child`,
            upper_message_id: rootId,
            msg_type: 'text',
            sender: { id: 'ou_customer', name: 'Customer' },
            body: { content: JSON.stringify({ text: '反序到达的材料' }) },
          },
        ],
      },
    });
    const connected = await connect(accountId, executed);

    await connected.handler({
      ...event(noteId, rootTime + 9_000, '请分析这个问题'),
      message: {
        ...event(noteId, rootTime + 9_000, '请分析这个问题').message,
        root_id: rootId,
        parent_id: rootId,
      },
    });
    await connected.handler({
      ...event(rootId, rootTime, ''),
      message: {
        ...event(rootId, rootTime, '').message,
        message_type: 'merge_forward',
        content: 'Merged and Forwarded Message',
      },
    });

    expect(executed).toHaveBeenCalledTimes(1);
    expect(executed).toHaveBeenCalledWith(noteId);
    expect(
      db
        .getMessagesSince('web:durable-feishu-test', {
          timestamp: new Date(rootTime - 1).toISOString(),
          id: '',
        })
        .filter((message) => message.id === rootId || message.id === noteId)
        .map((message) => message.id),
    ).toEqual([noteId]);
    expect(
      db
        .getMessagesPage('web:durable-feishu-test')
        .find((message) => message.id === rootId),
    ).toMatchObject({
      delivery_status: 'subsumed',
      delivery_run_id: noteId,
      channel_context: {
        message: {
          contentLink: {
            bundleId: rootId,
            role: 'forwarded_content',
          },
        },
      },
    });
  });

  test('defers an incomplete note until its late root supplies complete material', async () => {
    const accountId = `account-forward-note-first-incomplete-${Date.now()}`;
    const followUps = vi.fn(() => ({ disposition: 'started' as const }));
    const rootId = `om_note_first_incomplete_root_${Date.now()}`;
    const noteId = `${rootId}_note`;
    const rootTime = Date.now();
    controls.messageGet.mockResolvedValue({
      data: {
        items: [
          {
            message_id: rootId,
            msg_type: 'merge_forward',
            create_time: String(rootTime),
            sender: { id: 'ou_durable_user', name: 'Durable User' },
            body: { content: 'Merged and Forwarded Message' },
          },
        ],
      },
    });
    const connected = await connect(accountId, vi.fn(), {
      onFollowUpMessage: followUps as TestConnectOptions['onFollowUpMessage'],
    });
    vi.useFakeTimers();

    await connected.handler({
      ...event(noteId, rootTime + 9_000, '请分析这个问题'),
      message: {
        ...event(noteId, rootTime + 9_000, '请分析这个问题').message,
        root_id: rootId,
        parent_id: rootId,
      },
    });
    expect(followUps).not.toHaveBeenCalled();

    controls.messageGet.mockResolvedValue({
      data: {
        items: [
          {
            message_id: rootId,
            msg_type: 'merge_forward',
            create_time: String(rootTime),
            sender: { id: 'ou_durable_user', name: 'Durable User' },
            body: { content: 'Merged and Forwarded Message' },
          },
          {
            message_id: `${rootId}_child`,
            upper_message_id: rootId,
            msg_type: 'text',
            sender: { id: 'ou_customer', name: 'Customer' },
            body: { content: JSON.stringify({ text: '迟到的完整材料' }) },
          },
        ],
      },
    });
    await connected.handler({
      ...event(rootId, rootTime, ''),
      message: {
        ...event(rootId, rootTime, '').message,
        message_type: 'merge_forward',
        content: 'Merged and Forwarded Message',
      },
    });
    expect(followUps).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2_100);
    await connected.handler({
      ...event(noteId, rootTime + 9_000, '请分析这个问题'),
      message: {
        ...event(noteId, rootTime + 9_000, '请分析这个问题').message,
        root_id: rootId,
        parent_id: rootId,
      },
    });

    expect(followUps).toHaveBeenCalledTimes(1);
    expect(followUps).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: noteId,
        coalesceBundleId: rootId,
      }),
    );
    expect(
      db
        .getMessagesPage('web:durable-feishu-test')
        .find((message) => message.id === rootId),
    ).toMatchObject({
      delivery_status: null,
      content: expect.stringContaining('迟到的完整材料'),
    });
    expect(
      db
        .getMessagesPage('web:durable-feishu-test')
        .find((message) => message.id === noteId),
    ).toMatchObject({
      content: '请分析这个问题',
      channel_context: {
        message: {
          referencedMessages: [
            expect.objectContaining({
              id: rootId,
              materialResolved: true,
            }),
          ],
        },
      },
    });
  });

  test('sequences a late root when the note-first structural lookup returned no item', async () => {
    const accountId = `account-forward-note-first-empty-${Date.now()}`;
    const rootId = `om_note_first_empty_root_${Date.now()}`;
    const noteId = `${rootId}_note`;
    const rootTime = Date.now();
    controls.messageGet.mockResolvedValue({ data: { items: [] } });
    const connected = await connect(accountId, vi.fn(), {
      onFollowUpMessage: vi.fn(() => ({
        disposition: 'started' as const,
      })) as TestConnectOptions['onFollowUpMessage'],
    });

    await connected.handler({
      ...event(noteId, rootTime + 9_000, '请分析这个问题'),
      message: {
        ...event(noteId, rootTime + 9_000, '请分析这个问题').message,
        root_id: rootId,
        parent_id: rootId,
      },
    });
    expect(
      db.getMessageChannelTurnContext('web:durable-feishu-test', noteId)
        ?.message.contentLink,
    ).toBeUndefined();

    controls.messageGet.mockResolvedValue({
      data: {
        items: [
          {
            message_id: rootId,
            msg_type: 'merge_forward',
            create_time: String(rootTime),
            sender: { id: 'ou_durable_user', name: 'Durable User' },
            body: { content: 'Merged and Forwarded Message' },
          },
          {
            message_id: `${rootId}_child`,
            upper_message_id: rootId,
            msg_type: 'text',
            sender: { id: 'ou_customer', name: 'Customer' },
            body: { content: JSON.stringify({ text: '空查询后迟到的材料' }) },
          },
        ],
      },
    });
    await connected.handler({
      ...event(rootId, rootTime, ''),
      message: {
        ...event(rootId, rootTime, '').message,
        message_type: 'merge_forward',
        content: 'Merged and Forwarded Message',
      },
    });

    expect(
      db
        .getMessagesSince('web:durable-feishu-test', {
          timestamp: new Date(rootTime + 9_000).toISOString(),
          id: noteId,
        })
        .map((message) => message.id),
    ).toContain(rootId);
    expect(
      db
        .getMessagesPage('web:durable-feishu-test')
        .find((message) => message.id === rootId),
    ).toMatchObject({
      delivery_status: null,
      content: expect.stringContaining('空查询后迟到的材料'),
    });
  });

  test('treats legacy /queue text as an ordinary default-queued message', async () => {
    const accountId = `account-forward-explicit-queue-${Date.now()}`;
    const followUps = vi.fn(() => ({ disposition: 'started' as const }));
    const onCommand = vi.fn().mockResolvedValue(null);
    controls.messageGet.mockResolvedValue({
      data: {
        items: [
          {
            message_id: 'om_forward_queue_root',
            msg_type: 'merge_forward',
            create_time: '1000',
            sender: { id: 'ou_durable_user' },
            body: { content: 'Merged and Forwarded Message' },
          },
          {
            message_id: 'om_forward_queue_child',
            upper_message_id: 'om_forward_queue_root',
            msg_type: 'text',
            body: { content: JSON.stringify({ text: '材料' }) },
          },
        ],
      },
    });
    const connected = await connect(accountId, vi.fn(), {
      onFollowUpMessage: followUps as TestConnectOptions['onFollowUpMessage'],
      onCommand,
    });
    const createTime = Date.now();

    await connected.handler({
      ...event('om_forward_queue_root', createTime, ''),
      message: {
        ...event('om_forward_queue_root', createTime, '').message,
        message_type: 'merge_forward',
        content: 'Merged and Forwarded Message',
      },
    });
    await connected.handler({
      ...event('om_forward_queue_note', createTime + 1_000, '/queue 稍后处理'),
      message: {
        ...event('om_forward_queue_note', createTime + 1_000, '/queue 稍后处理')
          .message,
        root_id: 'om_forward_queue_root',
        parent_id: 'om_forward_queue_root',
      },
    });

    expect(followUps).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messageId: 'om_forward_queue_note',
        requestedMode: undefined,
        coalesceBundleId: undefined,
      }),
    );
    expect(onCommand).not.toHaveBeenCalled();
  });

  test('two live instances concurrently execute one external message exactly once', async () => {
    const accountId = `account-concurrent-${Date.now()}`;
    const executed = vi.fn();
    const first = await connect(accountId, executed);
    const second = await connect(accountId, executed);
    const createTime = Date.now() - 30_000;

    await Promise.all([
      first.handler(event('om_concurrent', createTime, 'once')),
      second.handler(event('om_concurrent', createTime, 'once')),
    ]);

    expect(executed).toHaveBeenCalledTimes(1);
    expect(executed).toHaveBeenCalledWith('om_concurrent');
    const duplicate = recordChannelInbox({
      provider: 'feishu',
      accountId,
      externalMessageId: 'om_concurrent',
      sourceJid: 'feishu:ou_durable_user',
      chatId: 'ou_durable_user',
      status: 'queued',
    });
    expect(duplicate.created).toBe(false);
    expect(duplicate.item.status).toBe('processed');
  });

  test('restart backfills downtime messages from the durable cursor despite the legacy ignore threshold', async () => {
    const accountId = `account-restart-${Date.now()}`;
    const executed = vi.fn();
    const base = Date.now() - 120_000;
    const first = await connect(accountId, executed);
    await first.handler(event('om_before_restart', base, 'before'));
    await first.connection.stop();
    openConnections.splice(openConnections.indexOf(first.connection), 1);

    controls.backfillItems = [
      backfillItem('om_during_downtime', base + 30_000, 'during'),
      backfillItem('om_before_restart', base, 'before'),
    ];
    await connect(accountId, executed);

    expect(executed.mock.calls.map(([id]) => id)).toEqual([
      'om_before_restart',
      'om_during_downtime',
    ]);
    const cursor = getChannelCursor({
      provider: 'feishu',
      accountId,
      scope: 'chat_messages',
      chatId: 'ou_durable_user',
    });
    expect(cursor?.cursor).toBe('om_during_downtime');
    expect(cursor?.position).toBe(base + 30_000);
  });

  test('cursor backfill keeps a safety window so late older events are not skipped', async () => {
    const accountId = `account-late-${Date.now()}`;
    const executed = vi.fn();
    const newestTime = Date.now() - 10_000;
    const lateTime = newestTime - 4 * 60_000;
    controls.messageList.mockImplementation(async (request: any) => {
      const startMs = Number(request.params.start_time) * 1_000;
      return {
        data: {
          items: controls.backfillItems.filter(
            (item) => Number(item.create_time) >= startMs,
          ),
          has_more: false,
        },
      };
    });

    const first = await connect(accountId, executed);
    await first.handler(event('om_newest_cursor', newestTime, 'newest'));
    await first.connection.stop();
    openConnections.splice(openConnections.indexOf(first.connection), 1);

    controls.backfillItems = [
      backfillItem('om_late_older', lateTime, 'arrived late'),
      backfillItem('om_newest_cursor', newestTime, 'newest'),
    ];
    await connect(accountId, executed);

    expect(executed.mock.calls.map(([id]) => id)).toEqual([
      'om_newest_cursor',
      'om_late_older',
    ]);
    expect(
      getChannelCursor({
        provider: 'feishu',
        accountId,
        scope: 'chat_messages',
        chatId: 'ou_durable_user',
      })?.cursor,
    ).toBe('om_newest_cursor');
  });

  test('startup inventory makes a known group eligible for backfill before onReady', async () => {
    const accountId = `account-inventory-${Date.now()}`;
    const executed = vi.fn();
    const createTime = Date.now() - 10_000;
    controls.chatList.mockResolvedValue({
      data: {
        items: [
          {
            chat_id: 'oc_known_group',
            name: 'Known Group',
            chat_type: 'group',
          },
        ],
        has_more: false,
      },
    });
    controls.backfillItems = [
      {
        ...backfillItem('om_group_downtime', createTime, 'group downtime'),
        chat_type: 'group',
      },
    ];

    await connect(accountId, executed);

    expect(executed).toHaveBeenCalledTimes(1);
    expect(executed).toHaveBeenCalledWith('om_group_downtime');
    expect(
      getChannelCursor({
        provider: 'feishu',
        accountId,
        scope: 'chat_messages',
        chatId: 'oc_known_group',
      })?.cursor,
    ).toBe('om_group_downtime');
  });

  test('an intake exception stays queued and is automatically retried', async () => {
    vi.useFakeTimers();
    const accountId = `account-retry-${Date.now()}`;
    const executed = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('transient intake failure');
      })
      .mockImplementation(() => undefined);
    const connected = await connect(accountId, executed);
    const createTime = Date.now();

    await connected.handler(event('om_retry', createTime, 'retry me'));
    expect(executed).toHaveBeenCalledTimes(1);
    expect(
      recordChannelInbox({
        provider: 'feishu',
        accountId,
        externalMessageId: 'om_retry',
        sourceJid: 'feishu:ou_durable_user',
        chatId: 'ou_durable_user',
        status: 'queued',
      }).item.status,
    ).toBe('queued');

    await vi.advanceTimersByTimeAsync(5_100);

    expect(executed).toHaveBeenCalledTimes(2);
    expect(
      recordChannelInbox({
        provider: 'feishu',
        accountId,
        externalMessageId: 'om_retry',
        sourceJid: 'feishu:ou_durable_user',
        chatId: 'ou_durable_user',
        status: 'queued',
      }).item.status,
    ).toBe('processed');
  });

  test('heartbeat fences a slow command beyond the original lease from a second instance', async () => {
    vi.useFakeTimers();
    const accountId = `account-heartbeat-${Date.now()}`;
    const executed = vi.fn();
    let releaseCommand!: (reply: string | null) => void;
    const onCommand = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          releaseCommand = resolve;
        }),
    );
    const first = await connect(accountId, executed, { onCommand });
    await connect(accountId, executed, { onCommand });

    const pending = first.handler(
      event('om_slow_command', Date.now(), '/slow'),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(onCommand).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(onCommand).toHaveBeenCalledTimes(1);

    releaseCommand('done');
    await pending;
    expect(
      recordChannelInbox({
        provider: 'feishu',
        accountId,
        externalMessageId: 'om_slow_command',
        sourceJid: 'feishu:ou_durable_user',
        chatId: 'ou_durable_user',
        status: 'queued',
      }).item.status,
    ).toBe('processed');
  });

  test('slash command Inbox completes only after a successful provider ACK', async () => {
    const accountId = `account-command-ack-${Date.now()}`;
    const executed = vi.fn();
    const onCommand = vi.fn().mockResolvedValue('command reply');
    const connected = await connect(accountId, executed, { onCommand });

    await connected.handler(event('om_command_ack', Date.now(), '/status'));

    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(controls.messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { receive_id_type: 'open_id' },
        data: expect.objectContaining({
          receive_id: 'ou_durable_user',
          msg_type: 'text',
          content: JSON.stringify({ text: 'command reply' }),
        }),
      }),
    );
    expect(
      recordChannelInbox({
        provider: 'feishu',
        accountId,
        externalMessageId: 'om_command_ack',
        sourceJid: 'feishu:ou_durable_user',
        chatId: 'ou_durable_user',
        status: 'queued',
      }).item.status,
    ).toBe('processed');
  });

  test('slash command API failure remains durable and is never marked processed', async () => {
    vi.useFakeTimers();
    const accountId = `account-command-api-failure-${Date.now()}`;
    const executed = vi.fn();
    const onCommand = vi.fn().mockResolvedValue('command reply');
    controls.messageCreate.mockResolvedValueOnce({
      code: 23_001,
      msg: 'connector unavailable',
    });
    const connected = await connect(accountId, executed, { onCommand });

    await connected.handler(
      event('om_command_api_failure', Date.now(), '/status'),
    );

    expect(onCommand).toHaveBeenCalledTimes(1);
    // A resolved non-zero API code is a definitive rejection, so the durable
    // reply may return to pending_reply and be retried without re-running the
    // command.
    expect(controls.messageCreate).toHaveBeenCalledTimes(1);
    expect(
      recordChannelInbox({
        provider: 'feishu',
        accountId,
        externalMessageId: 'om_command_api_failure',
        sourceJid: 'feishu:ou_durable_user',
        chatId: 'ou_durable_user',
        status: 'queued',
      }).item,
    ).toMatchObject({
      status: 'queued',
      normalizedPayload: {
        version: 1,
        kind: 'feishu_slash_command',
        state: 'pending_reply',
        command: 'status',
        replyText: 'command reply',
      },
    });

    await vi.advanceTimersByTimeAsync(5_100);
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(controls.messageCreate).toHaveBeenCalledTimes(2);
    expect(
      recordChannelInbox({
        provider: 'feishu',
        accountId,
        externalMessageId: 'om_command_api_failure',
        sourceJid: 'feishu:ou_durable_user',
        chatId: 'ou_durable_user',
        status: 'queued',
      }).item.status,
    ).toBe('processed');
  });

  test('slash command API timeout remains durable and is never marked processed', async () => {
    vi.useFakeTimers();
    const accountId = `account-command-timeout-${Date.now()}`;
    const executed = vi.fn();
    const onCommand = vi.fn().mockResolvedValue('command reply');
    controls.messageCreate.mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    const connected = await connect(accountId, executed, { onCommand });

    const pending = connected.handler(
      event('om_command_timeout', Date.now(), '/status'),
    );
    await vi.advanceTimersByTimeAsync(15_100);
    await pending;

    expect(onCommand).toHaveBeenCalledTimes(1);
    // The second send is a distinct manual-reconciliation notice, never the
    // persisted command reply.
    expect(controls.messageCreate).toHaveBeenCalledTimes(2);
    expect(
      recordChannelInbox({
        provider: 'feishu',
        accountId,
        externalMessageId: 'om_command_timeout',
        sourceJid: 'feishu:ou_durable_user',
        chatId: 'ou_durable_user',
        status: 'queued',
      }).item,
    ).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('manual reconciliation'),
      normalizedPayload: expect.objectContaining({ state: 'sending_reply' }),
    });
  });

  test('restart recovers a persisted command reply without executing the command again', async () => {
    const accountId = `account-command-restart-${Date.now()}`;
    const messageId = 'om_command_restart_pending_reply';
    const createTimeMs = Date.now() - 1_000;
    recordChannelInbox({
      provider: 'feishu',
      accountId,
      externalMessageId: messageId,
      sourceJid: 'feishu:ou_durable_user',
      chatId: 'ou_durable_user',
      rawPayload: {
        version: 1,
        source: 'ws',
        payload: {
          chatId: 'ou_durable_user',
          messageId,
          createTimeMs,
          messageType: 'text',
          content: JSON.stringify({ text: '/status' }),
          chatType: 'p2p',
          senderOpenId: 'ou_durable_user',
          senderName: 'Durable User',
          senderType: 'user',
        },
      },
      normalizedPayload: {
        version: 1,
        kind: 'feishu_slash_command',
        state: 'pending_reply',
        command: 'status',
        replyTarget: 'ou_durable_user',
        replyText: 'persisted reply',
      },
      status: 'queued',
    });
    const executed = vi.fn();
    const onCommand = vi.fn().mockResolvedValue('must not run');

    await connect(accountId, executed, { onCommand });

    expect(onCommand).not.toHaveBeenCalled();
    expect(controls.messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          content: JSON.stringify({ text: 'persisted reply' }),
        }),
      }),
    );
    expect(
      recordChannelInbox({
        provider: 'feishu',
        accountId,
        externalMessageId: messageId,
        sourceJid: 'feishu:ou_durable_user',
        chatId: 'ou_durable_user',
        status: 'queued',
      }).item.status,
    ).toBe('processed');
  });

  test('restart never re-executes a command interrupted before result persistence', async () => {
    const accountId = `account-command-interrupted-${Date.now()}`;
    const messageId = 'om_command_interrupted_executing';
    const createTimeMs = Date.now() - 1_000;
    recordChannelInbox({
      provider: 'feishu',
      accountId,
      externalMessageId: messageId,
      sourceJid: 'feishu:ou_durable_user',
      chatId: 'ou_durable_user',
      rawPayload: {
        version: 1,
        source: 'ws',
        payload: {
          chatId: 'ou_durable_user',
          messageId,
          createTimeMs,
          messageType: 'text',
          content: JSON.stringify({ text: '/dangerous' }),
          chatType: 'p2p',
          senderOpenId: 'ou_durable_user',
          senderName: 'Durable User',
          senderType: 'user',
        },
      },
      normalizedPayload: {
        version: 1,
        kind: 'feishu_slash_command',
        state: 'executing',
        command: 'dangerous',
        replyTarget: 'ou_durable_user',
      },
      status: 'queued',
    });
    const executed = vi.fn();
    const onCommand = vi.fn().mockResolvedValue('must not run');

    await connect(accountId, executed, { onCommand });

    expect(onCommand).not.toHaveBeenCalled();
    expect(controls.messageCreate).toHaveBeenCalledTimes(1);
    expect(controls.messageCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          content: expect.stringContaining('避免重复执行'),
        }),
      }),
    );
    expect(
      recordChannelInbox({
        provider: 'feishu',
        accountId,
        externalMessageId: messageId,
        sourceJid: 'feishu:ou_durable_user',
        chatId: 'ou_durable_user',
        status: 'queued',
      }).item,
    ).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('manual reconciliation required'),
    });
  });

  test('restart never resends a reply after provider acceptance but before ACK persistence', async () => {
    const accountId = `account-command-send-crash-${Date.now()}`;
    const messageId = 'om_command_provider_accepted_before_checkpoint';
    const createTimeMs = Date.now() - 1_000;
    recordChannelInbox({
      provider: 'feishu',
      accountId,
      externalMessageId: messageId,
      sourceJid: 'feishu:ou_durable_user',
      chatId: 'ou_durable_user',
      rawPayload: {
        version: 1,
        source: 'ws',
        payload: {
          chatId: 'ou_durable_user',
          messageId,
          createTimeMs,
          messageType: 'text',
          content: JSON.stringify({ text: '/dangerous' }),
          chatType: 'p2p',
          senderOpenId: 'ou_durable_user',
          senderName: 'Durable User',
          senderType: 'user',
        },
      },
      normalizedPayload: {
        version: 1,
        kind: 'feishu_slash_command',
        state: 'sending_reply',
        command: 'dangerous',
        replyTarget: 'ou_durable_user',
        replyText: 'provider already accepted this reply',
      },
      status: 'queued',
    });
    const executed = vi.fn();
    const onCommand = vi.fn().mockResolvedValue('must not run');

    await connect(accountId, executed, { onCommand });

    expect(onCommand).not.toHaveBeenCalled();
    expect(controls.messageCreate).toHaveBeenCalledTimes(1);
    const sentContent = controls.messageCreate.mock.calls.map(
      ([request]) => request.data.content,
    );
    expect(sentContent).not.toContain(
      JSON.stringify({ text: 'provider already accepted this reply' }),
    );
    expect(sentContent.join('\n')).toContain('可能已经送达');
    expect(
      recordChannelInbox({
        provider: 'feishu',
        accountId,
        externalMessageId: messageId,
        sourceJid: 'feishu:ou_durable_user',
        chatId: 'ou_durable_user',
        status: 'queued',
      }).item,
    ).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('manual reconciliation required'),
      normalizedPayload: expect.objectContaining({ state: 'sending_reply' }),
    });
  });
});
