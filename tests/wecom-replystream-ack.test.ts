import { beforeEach, describe, expect, test, vi } from 'vitest';

const sdkMock = vi.hoisted(() => {
  type Listener = (...args: any[]) => void;
  class MockWSClient {
    static instances: MockWSClient[] = [];
    readonly listeners = new Map<string, Listener[]>();
    readonly options: Record<string, unknown>;
    connect = vi.fn(() => this);
    disconnect = vi.fn();
    sendMessage = vi.fn(async () => ({ errcode: 0, headers: { req_id: 'm' } }));
    replyStream = vi.fn(async () => ({ errcode: 0, headers: { req_id: 's' } }));
    uploadMedia = vi.fn(async (_buffer: Buffer, options: { type: string }) => ({
      type: options.type,
      media_id: `media-${options.type}`,
      created_at: '2026-08-27T00:00:00.000Z',
    }));
    sendMediaMessage = vi.fn(async () => ({
      errcode: 0,
      headers: { req_id: 'media' },
    }));

    constructor(options: Record<string, unknown>) {
      this.options = options;
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
  WSClient: sdkMock.MockWSClient,
  generateReqId: (prefix: string) => `${prefix}-${++sdkMock.req}`,
}));

vi.mock('../src/db.js', () => ({
  getMessage: vi.fn(() => null),
  getMessagePayload: vi.fn(() => null),
  sequenceInboundTimestampAfterChatTail: vi.fn(
    (_chatJid: string, proposedTimestamp: string) => proposedTimestamp,
  ),
  storeMessageDirect: vi.fn(),
}));
vi.mock('../src/message-notifier.js', () => ({
  notifyNewImMessage: vi.fn(),
}));
vi.mock('../src/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  getMessage,
  getMessagePayload,
  sequenceInboundTimestampAfterChatTail,
  storeMessageDirect,
} from '../src/db.js';
import { logger } from '../src/logger.js';
import { createWeComConnection } from '../src/wecom.js';
import { classifyImSendFailure } from '../src/im-send-retry-policy.js';
import { DefinitiveChannelDeliveryError } from '../src/channel-outbox-delivery.js';

type MockClient = InstanceType<typeof sdkMock.MockWSClient>;

function frame(input: {
  reqId: string;
  msgId?: string;
  content?: string;
  userId?: string;
  chatId?: string;
  chattype?: 'single' | 'group';
}) {
  const chattype = input.chattype ?? 'single';
  return {
    headers: { req_id: input.reqId },
    body: {
      msgid: input.msgId ?? input.reqId,
      aibotid: 'bot-1',
      chattype,
      chatid: chattype === 'group' ? (input.chatId ?? 'group-1') : undefined,
      from: { userid: input.userId ?? 'user-1' },
      create_time: Math.floor(Date.now() / 1000),
      msgtype: 'text',
      text: { content: input.content ?? 'hello' },
    },
  } as any;
}

async function connect(overrides: Record<string, unknown> = {}): Promise<{
  connection: ReturnType<typeof createWeComConnection>;
  client: MockClient;
}> {
  const connection = createWeComConnection({
    botId: 'bot-1',
    secret: 'secret-1',
    channelAccountId: 'account-1',
    authTimeoutMs: 1000,
  });
  const pending = connection.connect({
    onNewChat: vi.fn(),
    isChatAuthorized: vi.fn(() => true),
    resolveEffectiveChatJid: vi.fn((jid: string) => ({
      effectiveJid: jid,
      agentId: null,
    })),
    onMessagePersisted: vi.fn(),
    ...overrides,
  });
  const client = sdkMock.MockWSClient.instances.at(-1)!;
  client.emit('authenticated');
  await pending;
  return { connection, client };
}

describe('WeCom replyStream awaitWeComProviderAck wrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getMessage).mockReturnValue(null);
    vi.mocked(getMessagePayload).mockImplementation((chatJid, messageId) => {
      const call = vi
        .mocked(storeMessageDirect)
        .mock.calls.find(
          (entry) => entry[0] === messageId && entry[1] === chatJid,
        );
      return call
        ? {
            content: call[4],
            attachments: call[7]?.attachments ?? null,
          }
        : null;
    });
    vi.mocked(sequenceInboundTimestampAfterChatTail).mockImplementation(
      (_chatJid, proposedTimestamp) => proposedTimestamp,
    );
    vi.mocked(storeMessageDirect).mockImplementation(() => 'stored');
    sdkMock.MockWSClient.instances.length = 0;
    sdkMock.req = 0;
  });

  test('stream replyStream errcode frame becomes Definitive → rejected; isActive clears', async () => {
    const connected = await connect();
    connected.client.emit('message.text', frame({ reqId: 'req-errcode' }));
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalledTimes(1));
    const inputId = vi.mocked(storeMessageDirect).mock.calls[0][0];
    const session = await connected.connection.createStreamingSession(
      'c2c:user-1',
      inputId,
    );
    expect(session).toBeDefined();

    const sdkFrame = {
      errcode: 40013,
      errmsg: 'invalid media',
      headers: { req_id: 'r1' },
    };
    connected.client.replyStream.mockRejectedValueOnce(sdkFrame);

    let caught: unknown;
    try {
      await session!.complete('final answer');
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DefinitiveChannelDeliveryError);
    expect((caught as DefinitiveChannelDeliveryError).code).toBe(
      'CHANNEL_DELIVERY_REJECTED',
    );
    expect(classifyImSendFailure(caught)).toBe('rejected');
    // Host gate: definitive reject clears sticky isActive so static can open.
    expect(session!.isActive()).toBe(false);
  });

  test('stream replyStream timeout / non-errcode reject stays uncertain (rethrown)', async () => {
    const connected = await connect();
    connected.client.emit('message.text', frame({ reqId: 'req-timeout' }));
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalledTimes(1));
    const inputId = vi.mocked(storeMessageDirect).mock.calls[0][0];
    const session = await connected.connection.createStreamingSession(
      'c2c:user-1',
      inputId,
    );
    expect(session).toBeDefined();

    const timeoutErr = Object.assign(new Error('WeCom stream ACK timed out'), {
      code: 'ETIMEDOUT',
    });
    connected.client.replyStream.mockRejectedValueOnce(timeoutErr);

    await expect(session!.complete('answer')).rejects.toBe(timeoutErr);
    expect(classifyImSendFailure(timeoutErr)).toBe('uncertain');
    // Uncertain terminal keeps isActive sticky so host refuses static.
    expect(session!.isActive()).toBe(true);
  });

  test('command sendReply errcode frame becomes Definitive (logged as rejected)', async () => {
    const onCommand = vi.fn(async () => 'command reply text');
    const connected = await connect({ onCommand });
    const sdkFrame = { errcode: 40058, errmsg: 'invalid request' };
    connected.client.replyStream.mockRejectedValueOnce(sdkFrame);

    connected.client.emit(
      'message.text',
      frame({
        reqId: 'cmd-errcode',
        msgId: 'cmd-errcode-event',
        content: '/where',
      }),
    );

    await vi.waitFor(() => expect(vi.mocked(logger.error)).toHaveBeenCalled());

    const errorCall = vi
      .mocked(logger.error)
      .mock.calls.find(
        (call) =>
          call[1] === 'WeCom inbound handling failed' &&
          call[0] &&
          typeof call[0] === 'object' &&
          'error' in (call[0] as object),
      );
    expect(errorCall).toBeDefined();
    const logged = (errorCall![0] as { error: unknown }).error;
    expect(logged).toBeInstanceOf(DefinitiveChannelDeliveryError);
    expect(classifyImSendFailure(logged)).toBe('rejected');
    expect(onCommand).toHaveBeenCalledTimes(1);
  });

  test('command sendReply timeout stays non-Definitive (uncertain fence)', async () => {
    const onCommand = vi.fn(async () => 'command reply text');
    const connected = await connect({ onCommand });
    const timeoutErr = Object.assign(new Error('reply ACK lost'), {
      code: 'ETIMEDOUT',
    });
    connected.client.replyStream.mockRejectedValueOnce(timeoutErr);

    connected.client.emit(
      'message.text',
      frame({
        reqId: 'cmd-timeout',
        msgId: 'cmd-timeout-event',
        content: '/where',
      }),
    );

    await vi.waitFor(() => expect(vi.mocked(logger.error)).toHaveBeenCalled());

    const errorCall = vi
      .mocked(logger.error)
      .mock.calls.find(
        (call) =>
          call[1] === 'WeCom inbound handling failed' &&
          call[0] &&
          typeof call[0] === 'object' &&
          'error' in (call[0] as object),
      );
    expect(errorCall).toBeDefined();
    const logged = (errorCall![0] as { error: unknown }).error;
    expect(logged).toBe(timeoutErr);
    expect(logged).not.toBeInstanceOf(DefinitiveChannelDeliveryError);
    expect(classifyImSendFailure(logged)).toBe('uncertain');
  });
});
