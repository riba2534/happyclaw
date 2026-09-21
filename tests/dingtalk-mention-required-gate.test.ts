import { EventEmitter } from 'node:events';
import https from 'node:https';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const sdk = vi.hoisted(() => {
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
  DWClient: sdk.MockDWClient,
  TOPIC_ROBOT: '/v1.0/im/bot/messages/get',
}));

vi.mock('../src/db.js', () => ({
  storeChatMetadata: vi.fn(),
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

import { storeMessageDirect } from '../src/db.js';
import {
  createDingTalkConnection,
  isDingTalkBotMentioned,
  type DingTalkConnectOpts,
} from '../src/dingtalk.js';

type MockClient = InstanceType<typeof sdk.MockDWClient>;

function groupRobotDownstream(input: {
  messageId?: string;
  msgId?: string;
  content?: string;
  senderId?: string;
  conversationId?: string;
  isInAtList?: boolean | string;
  omitIsInAtList?: boolean;
}) {
  const senderId = input.senderId ?? 'staff-mentionee';
  const conversationId = input.conversationId ?? 'open-conv-group-1';
  const payload: Record<string, unknown> = {
    conversationId,
    conversationType: '2',
    msgId: input.msgId ?? `dt-group-${Math.random().toString(16).slice(2)}`,
    senderId,
    senderNick: '群成员',
    senderStaffId: senderId,
    createAt: Date.now(),
    msgtype: 'text',
    text: { content: input.content ?? '@机器人 你好' },
    sessionWebhook: 'https://hook.example/session',
    chatbotUserId: 'bot-chatbot-user',
    robotCode: 'ding-client',
  };
  if (!input.omitIsInAtList) {
    payload.isInAtList = input.isInAtList ?? true;
  }
  return {
    headers: { messageId: input.messageId ?? `stream-${payload.msgId}` },
    data: JSON.stringify(payload),
  };
}

async function connect(overrides: Partial<DingTalkConnectOpts> = {}): Promise<{
  client: MockClient;
  connection: ReturnType<typeof createDingTalkConnection>;
}> {
  const connection = createDingTalkConnection({
    clientId: 'ding-client',
    clientSecret: 'ding-secret',
  });
  const ok = await connection.connect({
    onNewChat: vi.fn(),
    isChatAuthorized: () => true,
    resolveEffectiveChatJid: (jid: string) => ({
      effectiveJid: jid,
      agentId: null,
    }),
    onMessagePersisted: vi.fn(),
    ...overrides,
  });
  expect(ok).toBe(true);
  const client = sdk.MockDWClient.instances.at(-1);
  if (!client?.listener) {
    throw new Error('DingTalk callback listener was not registered');
  }
  return { client, connection };
}

describe('isDingTalkBotMentioned', () => {
  test('treats boolean true and string "true" as mentioned', () => {
    expect(isDingTalkBotMentioned({ isInAtList: true })).toBe(true);
    expect(isDingTalkBotMentioned({ isInAtList: 'true' })).toBe(true);
  });

  test('treats false, missing, and other values as not mentioned', () => {
    expect(isDingTalkBotMentioned({ isInAtList: false })).toBe(false);
    expect(isDingTalkBotMentioned({})).toBe(false);
    expect(isDingTalkBotMentioned({ isInAtList: 'false' })).toBe(false);
    expect(isDingTalkBotMentioned({ isInAtList: 1 })).toBe(false);
  });
});

describe('DingTalk mention-required group gate (live handleRobotMessage)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sdk.MockDWClient.instances.length = 0;
    vi.mocked(storeMessageDirect).mockImplementation(() => 'stored');
    // Avoid real HTTPS from any incidental webhook path.
    vi.spyOn(https, 'request').mockImplementation(((
      _opts: unknown,
      callback?: (res: EventEmitter) => void,
    ) => {
      const req = new EventEmitter() as EventEmitter & {
        setTimeout: () => void;
        write: () => void;
        end: () => void;
        destroy: () => void;
      };
      req.setTimeout = () => undefined;
      req.write = () => undefined;
      req.destroy = () => undefined;
      req.end = () => {
        const res = new EventEmitter() as EventEmitter & {
          statusCode: number;
          headers: Record<string, string>;
        };
        res.statusCode = 200;
        res.headers = {};
        callback?.(res);
        res.emit(
          'data',
          Buffer.from(
            JSON.stringify({
              errcode: 0,
              access_token: 'ding-token',
              expires_in: 7200,
            }),
          ),
        );
        res.emit('end');
      };
      return req as any;
    }) as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('when_mentioned + Stream @bot (isInAtList) must admit and persist', async () => {
    const shouldProcessGroupMessage = vi.fn(() => false); // when_mentioned / require_mention
    const { client, connection } = await connect({
      shouldProcessGroupMessage,
      resolveRegisteredGroup: () => ({ activation_mode: 'when_mentioned' }),
    });

    await client.listener!(
      groupRobotDownstream({
        msgId: 'wm-at-1',
        messageId: 'wm-at-stream-1',
        isInAtList: true,
        content: '@机器人 你好',
      }),
    );

    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalledTimes(1));
    expect(shouldProcessGroupMessage).toHaveBeenCalledWith(
      'dingtalk:group:open-conv-group-1',
      'staff-mentionee',
    );
    expect(client.socketCallBackResponse).toHaveBeenCalledWith(
      'wm-at-stream-1',
      { success: true },
    );
    await connection.disconnect();
  });

  test('auto + require_mention (shouldProcess false) + @bot must admit', async () => {
    const { client, connection } = await connect({
      shouldProcessGroupMessage: () => false,
      resolveRegisteredGroup: () => ({ activation_mode: 'auto' }),
    });

    await client.listener!(
      groupRobotDownstream({
        msgId: 'auto-req-at-1',
        messageId: 'auto-req-at-stream-1',
        isInAtList: true,
      }),
    );

    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalledTimes(1));
    await connection.disconnect();
  });

  test('mention required + not @bot must silent-drop (no persist)', async () => {
    const { client, connection } = await connect({
      shouldProcessGroupMessage: () => false,
      resolveRegisteredGroup: () => ({ activation_mode: 'when_mentioned' }),
    });

    await client.listener!(
      groupRobotDownstream({
        msgId: 'wm-noat-1',
        messageId: 'wm-noat-stream-1',
        isInAtList: false,
        content: '普通群聊消息',
      }),
    );

    // Give the async handler a turn; must never persist.
    await new Promise((r) => setTimeout(r, 50));
    expect(storeMessageDirect).not.toHaveBeenCalled();
    // Dropped-before-persist still ACKs the Stream callback after handle returns.
    expect(client.socketCallBackResponse).toHaveBeenCalledWith(
      'wm-noat-stream-1',
      { success: true },
    );
    await connection.disconnect();
  });

  test('owner_mentioned + @bot + non-owner must drop', async () => {
    const { client, connection } = await connect({
      shouldProcessGroupMessage: () => false,
      resolveRegisteredGroup: () => ({ activation_mode: 'owner_mentioned' }),
      isGroupOwnerMessage: () => false,
    });

    await client.listener!(
      groupRobotDownstream({
        msgId: 'own-non-1',
        messageId: 'own-non-stream-1',
        isInAtList: true,
      }),
    );

    await new Promise((r) => setTimeout(r, 50));
    expect(storeMessageDirect).not.toHaveBeenCalled();
    await connection.disconnect();
  });

  test('owner_mentioned + @bot + owner must admit', async () => {
    const { client, connection } = await connect({
      shouldProcessGroupMessage: () => false,
      resolveRegisteredGroup: () => ({ activation_mode: 'owner_mentioned' }),
      isGroupOwnerMessage: () => true,
    });

    await client.listener!(
      groupRobotDownstream({
        msgId: 'own-yes-1',
        messageId: 'own-yes-stream-1',
        isInAtList: true,
      }),
    );

    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalledTimes(1));
    await connection.disconnect();
  });
});
