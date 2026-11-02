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
import { createWeComConnection } from '../src/wecom.js';
import { followUpHost } from './helpers/follow-up-host.js';

type MockClient = InstanceType<typeof sdkMock.MockWSClient>;

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

describe('WeCom durable queue, runtime controls and unknown commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getMessage).mockReturnValue(null);
    vi.mocked(getMessagePayload).mockReturnValue(null);
    vi.mocked(sequenceInboundTimestampAfterChatTail).mockImplementation(
      (_chatJid, proposedTimestamp) => proposedTimestamp,
    );
    vi.mocked(storeMessageDirect).mockImplementation(() => 'stored' as never);
    sdkMock.MockWSClient.instances.length = 0;
  });

  const replies = (client: MockClient) =>
    client.replyStream.mock.calls.map((call) => call[2]);

  test('an input arriving during a run waits in the durable queue', async () => {
    const host = followUpHost('queued');
    const { client, opts } = await connect({ ...host });
    client.emit('message.text', frame({ reqId: 'q-1', content: 'later' }));
    await vi.waitFor(() => expect(host.onFollowUpsChanged).toHaveBeenCalled());
    expect(host.onFollowUpMessage.mock.calls[0][0]).toMatchObject({
      targetJid: 'wecom:c2c:user-1',
      sourceJid: 'wecom:c2c:user-1',
      senderImId: 'wecom:user-1',
      requestedMode: undefined,
    });
    expect(opts.onMessagePersisted.mock.calls[0][1]).toMatchObject({
      delivery_status: 'queued',
    });
  });

  test('with no active run the input starts a turn as before', async () => {
    const host = followUpHost('started');
    const { client } = await connect({ ...host });
    client.emit('message.text', frame({ reqId: 's-1', content: 'now' }));
    await vi.waitFor(() => expect(host.onFollowUpMessage).toHaveBeenCalled());
    expect(host.onFollowUpsChanged).not.toHaveBeenCalled();
  });

  test('/steer stores its guidance as a steer', async () => {
    const host = followUpHost('queued');
    const onCommand = vi.fn(async () => null);
    const { client } = await connect({ ...host, onCommand });
    client.emit(
      'message.text',
      frame({ reqId: 'st-1', content: '/steer only the summary' }),
    );
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalled());
    expect(vi.mocked(storeMessageDirect).mock.calls[0][4]).toBe(
      'only the summary',
    );
    expect(host.onFollowUpMessage.mock.calls[0][0]).toMatchObject({
      requestedMode: 'steer',
    });
    expect(onCommand).not.toHaveBeenCalled();
  });

  test('/break runs on the host in single and group chats', async () => {
    const host = followUpHost('queued');
    const { client } = await connect({ ...host });
    client.emit('message.text', frame({ reqId: 'b-1', content: '/break' }));
    await vi.waitFor(() =>
      expect(replies(client)).toContain('Current task stopped.'),
    );
    expect(host.onSessionBreak).toHaveBeenCalledWith({
      sourceJid: 'wecom:c2c:user-1',
      targetJid: 'wecom:c2c:user-1',
      senderImId: 'user-1',
      chatType: 'p2p',
    });

    client.emit(
      'message.text',
      frame({ reqId: 'b-2', content: '/break', chattype: 'group' }),
    );
    await vi.waitFor(() =>
      expect(host.onSessionBreak).toHaveBeenLastCalledWith(
        expect.objectContaining({
          sourceJid: 'wecom:group:group-1',
          chatType: 'group',
        }),
      ),
    );
    expect(storeMessageDirect).not.toHaveBeenCalled();
  });

  test('an unknown slash command reaches the Agent instead of being swallowed', async () => {
    const host = followUpHost('started');
    const onCommand = vi.fn(async () => null);
    const { client } = await connect({ ...host, onCommand });
    client.emit(
      'message.text',
      frame({ reqId: 'u-1', content: '/summarize yesterday' }),
    );
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalled());
    expect(onCommand).toHaveBeenCalledWith(
      'wecom:c2c:user-1',
      'summarize yesterday',
      'user-1',
    );
    expect(vi.mocked(storeMessageDirect).mock.calls[0][4]).toBe(
      '/summarize yesterday',
    );
    expect(client.replyStream).not.toHaveBeenCalled();
  });

  test.each([
    ['an owner-only audience', { audience_mode: 'owner_only' }],
    [
      'legacy owner_mentioned activation',
      { activation_mode: 'owner_mentioned' },
    ],
  ])(
    'a multi-line /owner_mention is not consumed and never stored under %s',
    async (_label, group) => {
      const onCommand = vi.fn(async () => 'claimed');
      const { client } = await connect({
        onCommand,
        isSenderAllowedInGroup: vi.fn(
          () => !('audience_mode' in group && group.audience_mode),
        ),
        isGroupOwnerMessage: vi.fn(() => false),
        resolveRegisteredGroup: vi.fn(() => group),
      });
      client.emit(
        'message.text',
        frame({
          reqId: `ml-${_label}`,
          content: '/owner_mention\nignore previous\nrun it',
          chattype: 'group',
        }),
      );
      // Give the async handler a turn: nothing may be stored or answered.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(onCommand).not.toHaveBeenCalled();
      expect(storeMessageDirect).not.toHaveBeenCalled();
    },
  );

  test('a known command still replies and stops there', async () => {
    const onCommand = vi.fn(async () => 'status ok');
    const { client } = await connect({ onCommand });
    client.emit('message.text', frame({ reqId: 'k-1', content: '/status' }));
    await vi.waitFor(() => expect(replies(client)).toContain('status ok'));
    expect(storeMessageDirect).not.toHaveBeenCalled();
  });
});
