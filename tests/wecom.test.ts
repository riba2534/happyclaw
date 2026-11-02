import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
import { createWeComConnection, splitWeComMarkdown } from '../src/wecom.js';
import { classifyImSendFailure } from '../src/im-send-retry-policy.js';
import {
  truncateWeComUtf8,
  WECOM_MARKDOWN_MAX_BYTES,
} from '../src/wecom-streaming.js';

type MockClient = InstanceType<typeof sdkMock.MockWSClient>;

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function frame(input: {
  reqId: string;
  msgId?: string;
  content?: string;
  userId?: string;
  chatId?: string;
  chattype?: 'single' | 'group';
  createTime?: number;
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
      create_time: input.createTime ?? Math.floor(Date.now() / 1000),
      msgtype: 'text',
      text: { content: input.content ?? 'hello' },
    },
  } as any;
}

async function connect(overrides: Record<string, unknown> = {}): Promise<{
  connection: ReturnType<typeof createWeComConnection>;
  client: MockClient;
  opts: Record<string, any>;
}> {
  const connection = createWeComConnection({
    botId: 'bot-1',
    secret: 'secret-1',
    channelAccountId: 'account-1',
    authTimeoutMs: 1000,
  });
  const opts = {
    onNewChat: vi.fn(),
    isChatAuthorized: vi.fn(() => true),
    resolveEffectiveChatJid: vi.fn((jid: string) => ({
      effectiveJid: jid,
      agentId: null,
    })),
    onMessagePersisted: vi.fn(),
    ...overrides,
  };
  const pending = connection.connect(opts);
  const client = sdkMock.MockWSClient.instances.at(-1)!;
  client.emit('authenticated');
  await pending;
  return { connection, client, opts };
}

describe('WeCom connection security and delivery', () => {
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

  test('connect waits for authentication and publishes lifecycle state', async () => {
    const states: string[] = [];
    const connection = createWeComConnection({
      botId: 'bot-1',
      secret: 'secret-1',
      authTimeoutMs: 1000,
    });
    let settled = false;
    const pending = connection
      .connect({
        onNewChat: vi.fn(),
        isChatAuthorized: () => false,
        onConnectionStateChange: (state) => states.push(state.status),
      })
      .then(() => {
        settled = true;
      });
    const client = sdkMock.MockWSClient.instances[0];
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(connection.isConnected()).toBe(false);

    client.emit('authenticated');
    await pending;
    expect(connection.isConnected()).toBe(true);
    expect(states).toEqual(['connecting', 'connected']);

    client.emit('reconnecting', 2);
    expect(connection.isConnected()).toBe(false);
    expect(states.at(-1)).toBe('reconnecting');
    client.emit('authenticated');
    expect(connection.isConnected()).toBe(true);
  });

  test('authentication timeout rejects and closes the transport', async () => {
    const connection = createWeComConnection({
      botId: 'bot-1',
      secret: 'secret-1',
      authTimeoutMs: 5,
    });
    await expect(
      connection.connect({
        onNewChat: vi.fn(),
        isChatAuthorized: () => false,
      }),
    ).rejects.toThrow('authentication timed out');
    expect(sdkMock.MockWSClient.instances[0].disconnect).toHaveBeenCalled();
    expect(connection.isConnected()).toBe(false);
  });

  test('sends markdown plus every local image through uploadMedia and sendMediaMessage', async () => {
    const connected = await connect();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-outbound-'));
    const first = path.join(dir, 'first.png');
    const second = path.join(dir, 'second.png');
    fs.writeFileSync(first, PNG_1X1);
    fs.writeFileSync(second, PNG_1X1);
    try {
      await connected.connection.sendMessage('c2c:user-1', 'body', [
        first,
        second,
      ]);
      expect(connected.client.sendMessage).toHaveBeenCalledOnce();
      expect(connected.client.uploadMedia).toHaveBeenCalledTimes(2);
      expect(connected.client.sendMediaMessage).toHaveBeenNthCalledWith(
        1,
        'user-1',
        'image',
        'media-image',
      );
      expect(connected.client.sendMediaMessage).toHaveBeenNthCalledWith(
        2,
        'user-1',
        'image',
        'media-image',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      await connected.connection.disconnect();
    }
  });

  test('ACKed body/image prefix makes a later media rejection partial and uncertain', async () => {
    const connected = await connect();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-partial-'));
    const first = path.join(dir, 'first.png');
    const second = path.join(dir, 'second.png');
    fs.writeFileSync(first, PNG_1X1);
    fs.writeFileSync(second, PNG_1X1);
    connected.client.sendMediaMessage
      .mockResolvedValueOnce({ errcode: 0, headers: { req_id: 'ok' } })
      .mockResolvedValueOnce({ errcode: 40013, errmsg: 'invalid media' });
    let failure: unknown;
    try {
      await connected.connection.sendMessage('c2c:user-1', 'body', [
        first,
        second,
      ]);
    } catch (error) {
      failure = error;
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      await connected.connection.disconnect();
    }
    expect(failure).toMatchObject({
      code: 'CHANNEL_DELIVERY_PARTIAL',
      deliveredOutputs: 2,
      totalOutputs: 3,
    });
    expect(classifyImSendFailure(failure)).toBe('uncertain');
  });

  test('public image caption and file APIs send every requested provider output', async () => {
    const connected = await connect();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wecom-file-'));
    const filePath = path.join(dir, 'report.bin');
    fs.writeFileSync(filePath, 'report');
    try {
      await connected.connection.sendImage(
        'c2c:user-1',
        PNG_1X1,
        'image/png',
        'caption',
        'photo.png',
      );
      await connected.connection.sendFile(
        'c2c:user-1',
        filePath,
        '../unsafe/report.bin',
      );
      expect(connected.client.sendMessage).toHaveBeenCalledOnce();
      expect(connected.client.uploadMedia).toHaveBeenNthCalledWith(1, PNG_1X1, {
        type: 'image',
        filename: 'photo.png',
      });
      expect(connected.client.uploadMedia.mock.calls[1]?.[1]).toEqual({
        type: 'file',
        filename: 'report.bin',
      });
      expect(connected.client.sendMediaMessage).toHaveBeenNthCalledWith(
        1,
        'user-1',
        'image',
        'media-image',
      );
      expect(connected.client.sendMediaMessage).toHaveBeenNthCalledWith(
        2,
        'user-1',
        'file',
        'media-file',
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      await connected.connection.disconnect();
    }
  });

  test('missing media ACK is uncertain and never accepted as success', async () => {
    const connected = await connect();
    connected.client.sendMediaMessage.mockResolvedValueOnce({});
    await expect(
      connected.connection.sendImage('c2c:user-1', PNG_1X1, 'image/png'),
    ).rejects.toMatchObject({ deliveryPhase: 'uncertain' });
    await connected.connection.disconnect();
  });

  test('invalid image preflight fails before sending its caption', async () => {
    const connected = await connect();
    await expect(
      connected.connection.sendImage(
        'c2c:user-1',
        Buffer.from('not-an-image'),
        'image/png',
        'must not be sent',
      ),
    ).rejects.toMatchObject({ deliveryPhase: 'pre_accept' });
    expect(connected.client.sendMessage).not.toHaveBeenCalled();
    expect(connected.client.uploadMedia).not.toHaveBeenCalled();
    await connected.connection.disconnect();
  });

  test('disconnect during upload prevents a stale media send', async () => {
    const connected = await connect();
    let finishUpload!: () => void;
    connected.client.uploadMedia.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishUpload = () =>
            resolve({
              type: 'image',
              media_id: 'stale-media',
              created_at: '2026-08-27T00:00:00.000Z',
            });
        }),
    );
    const pending = connected.connection.sendImage(
      'c2c:user-1',
      PNG_1X1,
      'image/png',
    );
    await vi.waitFor(() =>
      expect(connected.client.uploadMedia).toHaveBeenCalledOnce(),
    );
    await connected.connection.disconnect();
    finishUpload();
    await expect(pending).rejects.toMatchObject({
      code: 'WECOM_MEDIA_CANCELLED',
    });
    expect(connected.client.sendMediaMessage).not.toHaveBeenCalled();
  });

  test('unauthorized and resolver-rejected messages have no business side effects', async () => {
    const unauthorized = await connect({
      isChatAuthorized: vi.fn(() => false),
      resolveEffectiveChatJid: vi.fn(() => {
        throw new Error('must not route');
      }),
    });
    unauthorized.client.emit('message.text', frame({ reqId: 'unauthorized' }));
    await vi.waitFor(() =>
      expect(unauthorized.client.replyStream).toHaveBeenCalled(),
    );
    expect(unauthorized.opts.onNewChat).not.toHaveBeenCalled();
    expect(unauthorized.opts.resolveEffectiveChatJid).not.toHaveBeenCalled();
    expect(storeMessageDirect).not.toHaveBeenCalled();
    expect(unauthorized.opts.onMessagePersisted).not.toHaveBeenCalled();

    await unauthorized.connection.disconnect();
    vi.clearAllMocks();
    const rejected = await connect({
      resolveEffectiveChatJid: vi.fn(() => null),
    });
    rejected.client.emit('message.text', frame({ reqId: 'rejected' }));
    await vi.waitFor(() =>
      expect(rejected.opts.resolveEffectiveChatJid).toHaveBeenCalled(),
    );
    expect(rejected.opts.onNewChat).not.toHaveBeenCalled();
    expect(storeMessageDirect).not.toHaveBeenCalled();
  });

  test('pairing is consumed before routing and persistence', async () => {
    const onPairAttempt = vi.fn(async () => true);
    const connected = await connect({
      isChatAuthorized: vi.fn(() => false),
      onPairAttempt,
      resolveEffectiveChatJid: vi.fn(() => {
        throw new Error('must not route pairing');
      }),
    });
    connected.client.emit(
      'message.text',
      frame({ reqId: 'pair', content: '/pair CODE-1' }),
    );
    await vi.waitFor(() =>
      expect(connected.client.replyStream).toHaveBeenCalled(),
    );
    expect(connected.opts.resolveEffectiveChatJid).not.toHaveBeenCalled();
    expect(connected.opts.onNewChat).not.toHaveBeenCalled();
    expect(storeMessageDirect).not.toHaveBeenCalled();
    expect(connected.client.replyStream).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { req_id: 'pair' } }),
      expect.stringMatching(/^reply-/),
      expect.stringContaining('配对成功'),
      true,
    );
  });

  test('applies stale filtering, bounded msgid dedup, and in-flight exclusion', async () => {
    const connected = await connect({
      ignoreMessagesBefore: Date.now() - 1000,
    });
    connected.client.emit(
      'message.text',
      frame({ reqId: 'old', createTime: Math.floor(Date.now() / 1000) - 3600 }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(storeMessageDirect).not.toHaveBeenCalled();

    const duplicate = frame({ reqId: 'same', msgId: 'same' });
    connected.client.emit('message.text', duplicate);
    connected.client.emit('message.text', duplicate);
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalledTimes(1));
  });

  test('retries a failed provider event without repeating completed side effects', async () => {
    const connected = await connect();
    vi.mocked(storeMessageDirect)
      .mockImplementationOnce(() => {
        throw new Error('database temporarily unavailable');
      })
      .mockImplementation(() => 'stored');
    const retry = frame({ reqId: 'retry', msgId: 'provider-event-1' });

    connected.client.emit('message.text', retry);
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(connected.opts.onMessagePersisted).not.toHaveBeenCalled();

    connected.client.emit('message.text', retry);
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(connected.opts.onMessagePersisted).toHaveBeenCalledTimes(1),
    );
    expect(connected.opts.onNewChat).toHaveBeenCalledTimes(1);
    const firstId = vi.mocked(storeMessageDirect).mock.calls[0][0];
    const retryId = vi.mocked(storeMessageDirect).mock.calls[1][0];
    expect(retryId).toBe(firstId);
    expect(retryId).toMatch(/^wecom_[0-9a-f]{64}$/);
  });

  test('resumes after persistence when a later Agent notification fails', async () => {
    const onAgentMessage = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('queue temporarily unavailable');
      })
      .mockImplementation(() => undefined);
    const connected = await connect({
      resolveEffectiveChatJid: vi.fn((jid: string) => ({
        effectiveJid: `${jid}#agent:agent-1`,
        agentId: 'agent-1',
      })),
      onAgentMessage,
    });
    const retry = frame({ reqId: 'late-retry', msgId: 'provider-event-2' });

    connected.client.emit('message.text', retry);
    await vi.waitFor(() => expect(onAgentMessage).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(storeMessageDirect).toHaveBeenCalledTimes(1);
    expect(connected.opts.onMessagePersisted).toHaveBeenCalledTimes(1);

    connected.client.emit('message.text', retry);
    await vi.waitFor(() => expect(onAgentMessage).toHaveBeenCalledTimes(2));
    expect(storeMessageDirect).toHaveBeenCalledTimes(1);
    expect(connected.opts.onMessagePersisted).toHaveBeenCalledTimes(1);
  });

  test('sequences same-second messages and reuses the committed timestamp on staged retry', async () => {
    const firstTimestamp = '2026-08-15T00:00:00.000Z';
    const secondTimestamp = '2026-08-15T00:00:00.001Z';
    vi.mocked(sequenceInboundTimestampAfterChatTail)
      .mockReturnValueOnce(firstTimestamp)
      .mockReturnValueOnce(secondTimestamp);
    const onAgentMessage = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('queue temporarily unavailable');
      })
      .mockImplementation(() => undefined);
    const connected = await connect({
      resolveEffectiveChatJid: vi.fn((jid: string) => ({
        effectiveJid: `${jid}#agent:agent-1`,
        agentId: 'agent-1',
      })),
      onAgentMessage,
    });

    connected.client.emit(
      'message.text',
      frame({ reqId: 'same-second-a', createTime: 1_786_752_000 }),
    );
    await vi.waitFor(() => expect(onAgentMessage).toHaveBeenCalledTimes(1));
    connected.client.emit(
      'message.text',
      frame({
        reqId: 'same-second-a-retry',
        msgId: 'same-second-a',
        createTime: 1_786_752_000,
      }),
    );
    await vi.waitFor(() => expect(onAgentMessage).toHaveBeenCalledTimes(2));
    connected.client.emit(
      'message.text',
      frame({ reqId: 'same-second-b', createTime: 1_786_752_000 }),
    );
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalledTimes(2));

    expect(sequenceInboundTimestampAfterChatTail).toHaveBeenCalledTimes(2);
    expect(vi.mocked(storeMessageDirect).mock.calls[0][5]).toBe(firstTimestamp);
    expect(vi.mocked(storeMessageDirect).mock.calls[1][5]).toBe(
      secondTimestamp,
    );
    expect(connected.opts.onMessagePersisted.mock.calls[0][1]).toMatchObject({
      timestamp: firstTimestamp,
    });
    expect(connected.opts.onMessagePersisted.mock.calls[1][1]).toMatchObject({
      timestamp: secondTimestamp,
    });
  });

  test('checks the group audience before commands and permits only unowned owner bootstrap', async () => {
    const onCommand = vi.fn(async () => 'command reply');
    const connected = await connect({
      onCommand,
      isSenderAllowedInGroup: vi.fn(() => false),
      resolveRegisteredGroup: vi.fn(() => ({
        activation_mode: 'when_mentioned',
        owner_im_id: 'owner-1',
      })),
    });

    connected.client.emit(
      'message.text',
      frame({
        reqId: 'blocked-command',
        chattype: 'group',
        content: '/recall',
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onCommand).not.toHaveBeenCalled();
    expect(connected.client.replyStream).not.toHaveBeenCalled();

    const unowned = await connect({
      onCommand,
      isSenderAllowedInGroup: vi.fn(() => false),
      resolveRegisteredGroup: vi.fn(() => ({
        activation_mode: 'when_mentioned',
      })),
    });
    unowned.client.emit(
      'message.text',
      frame({
        reqId: 'owner-bootstrap',
        msgId: 'owner-bootstrap',
        chattype: 'group',
        content: '/owner_mention',
      }),
    );
    await vi.waitFor(() => expect(onCommand).toHaveBeenCalledTimes(1));
    expect(onCommand).toHaveBeenCalledWith(
      'wecom:group:group-1',
      'owner_mention',
      'user-1',
    );
    expect(unowned.client.replyStream).toHaveBeenCalledTimes(1);
  });

  test('retries a failed command reply without executing the command twice', async () => {
    const onCommand = vi.fn(async () => 'cached command result');
    const connected = await connect({ onCommand });
    connected.client.replyStream.mockRejectedValueOnce(
      new Error('temporary reply failure'),
    );

    connected.client.emit(
      'message.text',
      frame({
        reqId: 'command-first',
        msgId: 'command-event',
        content: '/where',
      }),
    );
    await vi.waitFor(() =>
      expect(connected.client.replyStream).toHaveBeenCalledTimes(1),
    );
    connected.client.emit(
      'message.text',
      frame({
        reqId: 'command-retry',
        msgId: 'command-event',
        content: '/where',
      }),
    );
    await vi.waitFor(() =>
      expect(connected.client.replyStream).toHaveBeenCalledTimes(2),
    );

    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(connected.client.replyStream.mock.calls[1][2]).toBe(
      'cached command result',
    );
  });

  test('treats a WeCom group callback as provider mention evidence', async () => {
    const shouldProcessGroupMessage = vi.fn(() => false);
    let activationMode = 'when_mentioned';
    const connected = await connect({
      shouldProcessGroupMessage,
      isSenderAllowedInGroup: vi.fn(() => true),
      resolveRegisteredGroup: vi.fn(() => ({
        activation_mode: activationMode,
      })),
    });

    connected.client.emit(
      'message.text',
      frame({
        reqId: 'mentioned-group',
        chattype: 'group',
        content: '@HappyClaw hello',
      }),
    );
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalledTimes(1));
    expect(shouldProcessGroupMessage).not.toHaveBeenCalled();

    vi.clearAllMocks();
    vi.mocked(getMessage).mockReturnValue(null);
    vi.mocked(storeMessageDirect).mockImplementation(() => 'stored');
    activationMode = 'disabled';
    connected.client.emit(
      'message.text',
      frame({
        reqId: 'disabled-group',
        msgId: 'disabled-group',
        chattype: 'group',
        content: '@HappyClaw ignored',
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(storeMessageDirect).not.toHaveBeenCalled();
    expect(shouldProcessGroupMessage).not.toHaveBeenCalled();
  });

  test('keeps legacy owner_mentioned restricted to the owner', async () => {
    const connected = await connect({
      isSenderAllowedInGroup: vi.fn(() => true),
      isGroupOwnerMessage: vi.fn(() => false),
      resolveRegisteredGroup: vi.fn(() => ({
        activation_mode: 'owner_mentioned',
        owner_im_id: 'owner-1',
      })),
    });
    connected.client.emit(
      'message.text',
      frame({ reqId: 'non-owner', chattype: 'group' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(storeMessageDirect).not.toHaveBeenCalled();
  });

  test('freezes the original req_id for concurrent messages in one chat', async () => {
    const connected = await connect();
    connected.client.emit(
      'message.text',
      frame({ reqId: 'req-a', msgId: 'a' }),
    );
    connected.client.emit(
      'message.text',
      frame({ reqId: 'req-b', msgId: 'b' }),
    );
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalledTimes(2));
    const inputA = vi.mocked(storeMessageDirect).mock.calls[0][0];
    const inputB = vi.mocked(storeMessageDirect).mock.calls[1][0];

    const sessionA = await connected.connection.createStreamingSession(
      'c2c:user-1',
      inputA,
    );
    const sessionB = await connected.connection.createStreamingSession(
      'c2c:user-1',
      inputB,
    );
    expect(sessionA).toBeDefined();
    expect(sessionB).toBeDefined();
    await sessionB!.complete('answer B');
    await sessionA!.complete('answer A');

    const finalCalls = connected.client.replyStream.mock.calls.filter(
      (call) => call[3] === true,
    );
    expect(finalCalls.map((call) => call[0].headers.req_id)).toEqual([
      'req-b',
      'req-a',
    ]);
    // A cached frame can be claimed only once.
    await expect(
      connected.connection.createStreamingSession('c2c:user-1', inputA),
    ).resolves.toBeUndefined();
  });

  test('throws when unauthenticated and propagates provider ACK failures', async () => {
    const connection = createWeComConnection({
      botId: 'bot',
      secret: 'secret',
    });
    await expect(connection.sendMessage('c2c:user', 'hello')).rejects.toThrow(
      'not authenticated',
    );

    const connected = await connect();
    connected.client.sendMessage.mockRejectedValueOnce(new Error('ACK failed'));
    await expect(
      connected.connection.sendMessage('c2c:user-1', 'hello'),
    ).rejects.toThrow('ACK failed');
  });

  test('propagates streaming finalization failure without controller fallback', async () => {
    const connected = await connect();
    connected.client.emit('message.text', frame({ reqId: 'req-fail' }));
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalledTimes(1));
    const inputId = vi.mocked(storeMessageDirect).mock.calls[0][0];
    const session = await connected.connection.createStreamingSession(
      'c2c:user-1',
      inputId,
    );
    connected.client.replyStream.mockRejectedValueOnce(new Error('stream ACK'));
    await expect(session!.complete('answer')).rejects.toThrow('stream ACK');
    expect(connected.client.sendMessage).not.toHaveBeenCalled();
  });
});

describe('WeCom UTF-8 byte limits', () => {
  test('paginates Unicode markdown without exceeding 20480 bytes', () => {
    const input = `${'企业微信🙂'.repeat(5000)}\n${'tail '.repeat(2000)}`;
    const pages = splitWeComMarkdown(input, WECOM_MARKDOWN_MAX_BYTES - 64);
    expect(pages.length).toBeGreaterThan(1);
    expect(
      pages.every((page) => Buffer.byteLength(page, 'utf8') <= 20_416),
    ).toBe(true);
    expect(pages.join('').replace(/\s/g, '')).toBe(input.replace(/\s/g, ''));
  });

  test('truncates streaming previews on code-point boundaries', () => {
    const preview = truncateWeComUtf8('🙂'.repeat(10_000));
    expect(Buffer.byteLength(preview, 'utf8')).toBeLessThanOrEqual(
      WECOM_MARKDOWN_MAX_BYTES,
    );
    expect(preview).not.toContain('\uFFFD');
    expect(preview).toContain('完成后将分段发送');
  });
});
