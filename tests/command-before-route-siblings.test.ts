/**
 * Same-class fold: WeCom / DingTalk / WeChat had auth→route→command, so a
 * paired account mount dropped /new at the route gate. WhatsApp is already
 * command-first and is not changed here.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import https from 'node:https';

/* ─── WeCom ─── */
const wecomSdk = vi.hoisted(() => {
  type Listener = (...args: any[]) => void;
  class MockWSClient {
    static instances: MockWSClient[] = [];
    readonly listeners = new Map<string, Listener[]>();
    connect = vi.fn(() => this);
    disconnect = vi.fn();
    sendMessage = vi.fn(async () => ({ errcode: 0, headers: { req_id: 'm' } }));
    replyStream = vi.fn(async () => ({ errcode: 0, headers: { req_id: 's' } }));
    uploadMedia = vi.fn();
    sendMediaMessage = vi.fn();
    constructor(public options: Record<string, unknown>) {
      MockWSClient.instances.push(this);
    }
    on(event: string, listener: Listener): this {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
      return this;
    }
    emit(event: string, ...args: any[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }
  }
  return { MockWSClient, req: 0 };
});

vi.mock('@wecom/aibot-node-sdk', () => ({
  WSClient: wecomSdk.MockWSClient,
  generateReqId: (prefix: string) => `${prefix}-${++wecomSdk.req}`,
}));

/* ─── DingTalk ─── */
const dtSdk = vi.hoisted(() => {
  class MockDWClient {
    static instances: MockDWClient[] = [];
    listener:
      | ((downstream: {
          headers?: { messageId?: string };
          data: string;
        }) => Promise<void> | void)
      | null = null;
    registerCallbackListener = vi.fn(
      (
        _topic: string,
        listener: (downstream: {
          headers?: { messageId?: string };
          data: string;
        }) => Promise<void> | void,
      ) => {
        this.listener = listener;
        return this;
      },
    );
    socketCallBackResponse = vi.fn();
    connect = vi.fn(async () => undefined);
    disconnect = vi.fn();
    constructor(public options: Record<string, unknown>) {
      MockDWClient.instances.push(this);
    }
  }
  return { MockDWClient };
});

vi.mock('dingtalk-stream', () => ({
  DWClient: dtSdk.MockDWClient,
  TOPIC_ROBOT: '/v1.0/im/bot/messages/get',
}));

const db = vi.hoisted(() => ({
  getMessage: vi.fn(() => null),
  getMessagePayload: vi.fn(() => null),
  sequenceInboundTimestampAfterChatTail: vi.fn((_c: string, ts: string) => ts),
  storeMessageDirect: vi.fn(),
  storeChatMetadata: vi.fn(),
  updateChatName: vi.fn(),
  getRegisteredGroup: vi.fn(),
  isDatabaseInitialized: vi.fn(() => false),
  listWeChatContextTokens: vi.fn(() => []),
}));
vi.mock('../src/db.js', () => db);
vi.mock('../src/message-notifier.js', () => ({ notifyNewImMessage: vi.fn() }));
const audienceOverrides = vi.hoisted(() => ({
  next: null as 'bootstrap' | null,
}));
vi.mock('../src/im-group-audience.js', async (importOriginal) => {
  const real =
    await importOriginal<typeof import('../src/im-group-audience.js')>();
  return {
    ...real,
    groupSenderAdmission: (
      ...args: Parameters<typeof real.groupSenderAdmission>
    ) => {
      if (audienceOverrides.next) {
        const val = audienceOverrides.next;
        audienceOverrides.next = null;
        return val;
      }
      return real.groupSenderAdmission(...args);
    },
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createWeComConnection } = await import('../src/wecom.js');
const { createDingTalkConnection } = await import('../src/dingtalk.js');
const { createWeChatConnection } = await import('../src/wechat.js');
const { logger } = await import('../src/logger.js');

function wecomFrame(content: string, reqId: string) {
  return {
    headers: { req_id: reqId },
    body: {
      msgid: reqId,
      aibotid: 'bot-1',
      chattype: 'single',
      from: { userid: 'user-1' },
      create_time: Math.floor(Date.now() / 1000),
      msgtype: 'text',
      text: { content },
    },
  } as any;
}

describe('(4) sibling connectors: paired-unbound /new reaches onCommand; plain drops', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    wecomSdk.MockWSClient.instances.length = 0;
    dtSdk.MockDWClient.instances.length = 0;
    db.storeMessageDirect.mockImplementation(() => 'stored');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('WeCom: paired-unbound /new reaches onCommand; plain message drops at route', async () => {
    const onCommand = vi.fn(async () => 'new-ok');
    const resolveEffectiveChatJid = vi.fn(() => null);
    const connection = createWeComConnection({
      botId: 'bot-1',
      secret: 'secret-1',
      channelAccountId: 'account-1',
      authTimeoutMs: 1000,
    });
    const pending = connection.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
      resolveEffectiveChatJid,
      onCommand,
      onMessagePersisted: vi.fn(),
    });
    const client = wecomSdk.MockWSClient.instances.at(-1)!;
    client.emit('authenticated');
    await pending;

    client.emit('message.text', wecomFrame('/new', 'wc-new'));
    await vi.waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    expect(onCommand).toHaveBeenCalledWith('wecom:c2c:user-1', 'new', 'user-1');

    client.emit('message.text', wecomFrame('hello', 'wc-plain'));
    await vi.waitFor(() => expect(resolveEffectiveChatJid).toHaveBeenCalled());
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(db.storeMessageDirect).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jid: 'wecom:c2c:user-1' }),
      expect.stringContaining('binding resolver rejected route'),
    );
    await connection.disconnect();
  });

  test('DingTalk: paired-unbound /new reaches onCommand; plain message drops at route', async () => {
    const onCommand = vi.fn(async () => 'new-ok');
    const resolveEffectiveChatJid = vi.fn(() => null);
    const connection = createDingTalkConnection({
      clientId: 'ding-client',
      clientSecret: 'ding-secret',
    });
    await connection.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
      resolveEffectiveChatJid,
      onCommand,
      onMessagePersisted: vi.fn(),
    });
    const client = dtSdk.MockDWClient.instances.at(-1)!;
    expect(client.listener).toBeTypeOf('function');

    const downstream = (content: string, messageId: string) => ({
      headers: { messageId },
      data: JSON.stringify({
        conversationId: 'staff-1',
        conversationType: '1',
        msgId: messageId,
        senderId: 'staff-1',
        senderNick: '钉钉用户',
        senderStaffId: 'staff-1',
        createAt: Date.now(),
        msgtype: 'text',
        text: { content },
        sessionWebhook: 'https://example.test/hook',
      }),
    });

    // Avoid real HTTPS for webhook reply / token
    vi.spyOn(https, 'request').mockImplementation(((_opts: any, cb?: any) => {
      const req = new EventEmitter() as any;
      req.write = () => undefined;
      req.end = () => {
        queueMicrotask(() => {
          const res = new EventEmitter() as any;
          res.statusCode = 200;
          cb?.(res);
          res.emit('data', Buffer.from(JSON.stringify({ access_token: 't' })));
          res.emit('end');
        });
      };
      req.setTimeout = () => undefined;
      req.destroy = () => undefined;
      return req;
    }) as any);

    await client.listener!(downstream('/new', 'dt-new'));
    await vi.waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    expect(onCommand).toHaveBeenCalledWith(
      expect.stringMatching(/^dingtalk:/),
      'new',
      'staff-1',
      [],
    );

    await client.listener!(downstream('hello', 'dt-plain'));
    await vi.waitFor(() =>
      expect(resolveEffectiveChatJid.mock.calls.length).toBeGreaterThan(0),
    );
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(db.storeMessageDirect).not.toHaveBeenCalled();
    await connection.disconnect();
  });

  test('WeChat: paired-unbound /new reaches onCommand; plain message drops at route', async () => {
    vi.useFakeTimers();
    const onCommand = vi.fn(async () => 'new-ok');
    const resolveEffectiveChatJid = vi.fn(() => null);
    let round = 0;
    const fetchMock = vi.fn(
      async (input: any, init?: { signal?: AbortSignal | null }) => {
        const url = String(input);
        if (url.includes('getupdates')) {
          round += 1;
          if (round === 1) {
            return Response.json({
              get_updates_buf: 'cursor-1',
              msgs: [
                {
                  from_user_id: 'wx-user-1',
                  create_time_ms: Date.now(),
                  message_id: 1001,
                  seq: 1,
                  context_token: 'ctx-1',
                  message_type: 1,
                  item_list: [{ type: 1, text_item: { text: '/new' } }],
                },
              ],
            });
          }
          if (round === 2) {
            return Response.json({
              get_updates_buf: 'cursor-2',
              msgs: [
                {
                  from_user_id: 'wx-user-1',
                  create_time_ms: Date.now(),
                  message_id: 1002,
                  seq: 2,
                  context_token: 'ctx-2',
                  message_type: 1,
                  item_list: [{ type: 1, text_item: { text: 'hello' } }],
                },
              ],
            });
          }
          return new Promise((_resolve, reject) => {
            const signal = init?.signal;
            if (signal?.aborted) {
              reject(new DOMException('aborted', 'AbortError'));
              return;
            }
            signal?.addEventListener(
              'abort',
              () => reject(new DOMException('aborted', 'AbortError')),
              { once: true },
            );
          });
        }
        if (url.includes('sendmessage')) {
          return Response.json({ ret: 0 });
        }
        return Response.json({ ret: 0 });
      },
    );
    const close = vi.fn(async () => undefined);
    const connection = createWeChatConnection(
      {
        botToken: 'secret-token',
        ilinkBotId: 'bot-identity@example',
      },
      {
        fetch: fetchMock as typeof fetch,
        createDispatcher: () => ({ close }) as any,
      },
    );

    await connection.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
      resolveEffectiveChatJid,
      onCommand,
      onMessagePersisted: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(0);

    await vi.waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    expect(onCommand).toHaveBeenCalledWith(
      'wechat:wx-user-1',
      'new',
      'wx-user-1',
    );

    await vi.waitFor(() => expect(resolveEffectiveChatJid).toHaveBeenCalled());
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(db.storeMessageDirect).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jid: 'wechat:wx-user-1' }),
      expect.stringContaining('binding resolver rejected route'),
    );
    await connection.disconnect();
    vi.useRealTimers();
  });

  test('WeCom group: bootstrap-admitted /break runs before bootstrap return', async () => {
    const onSessionBreak = vi.fn(async () => 'break-ok');
    const connection = createWeComConnection({
      botId: 'bot-1',
      secret: 'secret-1',
      channelAccountId: 'account-1',
      authTimeoutMs: 1000,
    });
    const pending = connection.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
      resolveEffectiveChatJid: (jid: string) => ({
        effectiveJid: `${jid}#agent:a1`,
        agentId: 'a1',
      }),
      onSessionBreak,
      onMessagePersisted: vi.fn(),
    });
    const client = wecomSdk.MockWSClient.instances.at(-1)!;
    client.emit('authenticated');
    await pending;

    audienceOverrides.next = 'bootstrap';
    client.emit('message.text', {
      headers: { req_id: 'wc-boot-break' },
      body: {
        msgid: 'wc-boot-break',
        aibotid: 'bot-1',
        chattype: 'group',
        chatid: 'chat-boot-1',
        from: { userid: 'user-1' },
        create_time: Math.floor(Date.now() / 1000),
        msgtype: 'text',
        text: { content: '/break' },
      },
    } as any);
    await vi.waitFor(() => expect(onSessionBreak).toHaveBeenCalledTimes(1));
    expect(onSessionBreak).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceJid: 'wecom:group:chat-boot-1',
        targetJid: 'wecom:group:chat-boot-1#agent:a1',
      }),
    );
    expect(db.storeMessageDirect).not.toHaveBeenCalled();
    await connection.disconnect();
  });

  test('DingTalk: unknown text slash on routed chat calls onCommand only once', async () => {
    const onCommand = vi.fn(async () => null);
    const connection = createDingTalkConnection({
      clientId: 'ding-client',
      clientSecret: 'ding-secret',
    });
    await connection.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
      resolveEffectiveChatJid: (jid: string) => ({
        effectiveJid: `${jid}#agent:a1`,
        agentId: 'a1',
      }),
      onCommand,
      onMessagePersisted: vi.fn(),
    });
    const client = dtSdk.MockDWClient.instances.at(-1)!;
    await client.listener!({
      headers: { messageId: 'dt-unknown-1' },
      data: JSON.stringify({
        conversationId: 'staff-1',
        conversationType: '1',
        msgId: 'dt-unknown-1',
        senderId: 'staff-1',
        senderNick: '钉钉用户',
        senderStaffId: 'staff-1',
        createAt: Date.now(),
        msgtype: 'text',
        text: { content: '/unknown_cmd' },
        sessionWebhook: 'https://example.test/hook',
      }),
    });
    await vi.waitFor(() =>
      expect(db.storeMessageDirect).toHaveBeenCalledTimes(1),
    );
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onCommand).toHaveBeenCalledWith(
      expect.stringMatching(/^dingtalk:/),
      'unknown_cmd',
      'staff-1',
      [],
    );
    await connection.disconnect();
  });
});
