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
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { storeChatMetadata, storeMessageDirect } from '../src/db.js';
import {
  createDingTalkConnection,
  dingTalkCommandMentions,
  type DingTalkConnectOpts,
} from '../src/dingtalk.js';
import { followUpHost } from './helpers/follow-up-host.js';
import {
  groupAudienceHost,
  type AudienceGroup,
} from './helpers/group-audience.js';

const GROUP_JID = 'dingtalk:group:conv-1';
const webhookBodies: string[] = [];
let seq = 0;

function downstream(input: {
  senderId: string;
  content: string;
  group?: boolean;
  isInAtList?: boolean;
  atUsers?: Array<{ dingtalkId?: string; staffId?: string }>;
}) {
  seq += 1;
  const group = input.group ?? true;
  const payload: Record<string, unknown> = {
    conversationId: group ? 'conv-1' : `c2c-${input.senderId}`,
    conversationType: group ? '2' : '1',
    msgId: `dt-${seq}`,
    senderId: input.senderId,
    senderNick: input.senderId,
    senderStaffId: `staff-${input.senderId}`,
    createAt: Date.now(),
    msgtype: 'text',
    text: { content: input.content },
    sessionWebhook: 'https://hook.example/session',
    chatbotUserId: 'bot-dingtalk-id',
    robotCode: 'ding-client',
    isInAtList: input.isInAtList ?? group,
    atUsers: input.atUsers,
  };
  return {
    headers: { messageId: `stream-${seq}` },
    data: JSON.stringify(payload),
  };
}

describe('DingTalk group response audience', () => {
  let groups: Record<string, AudienceGroup>;
  let onCommand: ReturnType<typeof vi.fn>;
  let connection: ReturnType<typeof createDingTalkConnection> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    sdk.MockDWClient.instances.length = 0;
    webhookBodies.length = 0;
    groups = {};
    onCommand = vi.fn(async (_jid: string, command: string) =>
      command.startsWith('status') || command.startsWith('owner_mention')
        ? 'ok'
        : null,
    );
    vi.mocked(storeMessageDirect).mockImplementation(() => 'stored');
    vi.spyOn(https, 'request').mockImplementation(((
      _opts: unknown,
      callback?: (res: EventEmitter) => void,
    ) => {
      const req = new EventEmitter() as EventEmitter & Record<string, any>;
      req.setTimeout = () => undefined;
      req.write = (chunk: unknown) => webhookBodies.push(String(chunk));
      req.destroy = () => undefined;
      req.end = () => {
        const res = new EventEmitter() as EventEmitter & Record<string, any>;
        res.statusCode = 200;
        res.headers = {};
        callback?.(res);
        res.emit(
          'data',
          Buffer.from(
            JSON.stringify({ errcode: 0, access_token: 't', expires_in: 7200 }),
          ),
        );
        res.emit('end');
      };
      return req as any;
    }) as any);
  });

  afterEach(async () => {
    await connection?.disconnect();
    connection = null;
    vi.restoreAllMocks();
  });

  async function connect(
    group?: AudienceGroup,
    overrides: Partial<DingTalkConnectOpts> = {},
  ) {
    if (group) groups[GROUP_JID] = group;
    const host = groupAudienceHost('dingtalk', groups);
    connection = createDingTalkConnection({
      clientId: 'ding-client',
      clientSecret: 'ding-secret',
    });
    await connection.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
      resolveEffectiveChatJid: (jid: string) => ({
        effectiveJid: jid,
        agentId: null,
      }),
      onMessagePersisted: vi.fn(),
      onCommand,
      ...host,
      ...overrides,
    });
    const client = sdk.MockDWClient.instances.at(-1)!;
    return {
      host,
      deliver: (d: ReturnType<typeof downstream>) => client.listener!(d),
    };
  }

  test('owner_only: the owner reaches the Agent, another member does not', async () => {
    const { deliver } = await connect({
      audience_mode: 'owner_only',
      owner_im_id: 'OWNER',
    });
    await deliver(downstream({ senderId: 'OWNER', content: 'hi' }));
    await deliver(downstream({ senderId: 'MEMBER', content: 'hi' }));
    await deliver(downstream({ senderId: 'MEMBER', content: '/status' }));
    expect(storeMessageDirect).toHaveBeenCalledOnce();
    expect(vi.mocked(storeMessageDirect).mock.calls[0][2]).toBe(
      'dingtalk:OWNER',
    );
    expect(onCommand).not.toHaveBeenCalled();
  });

  test('allowlist: listed members pass, others are dropped', async () => {
    const { deliver } = await connect({
      audience_mode: 'everyone',
      owner_im_id: 'OWNER',
      sender_allowlist: ['OWNER', 'MEMBER'],
    });
    await deliver(downstream({ senderId: 'MEMBER', content: 'listed' }));
    await deliver(downstream({ senderId: 'OUTSIDER', content: 'not listed' }));
    expect(storeMessageDirect).toHaveBeenCalledOnce();
    expect(vi.mocked(storeMessageDirect).mock.calls[0][4]).toBe('listed');
  });

  test('everyone without an allowlist admits every member', async () => {
    const { deliver } = await connect({ audience_mode: 'everyone' });
    await deliver(downstream({ senderId: 'A', content: 'a' }));
    await deliver(downstream({ senderId: 'B', content: 'b' }));
    expect(storeMessageDirect).toHaveBeenCalledTimes(2);
  });

  test('private chats never consult the group gate', async () => {
    const { host, deliver } = await connect();
    host.isSenderAllowedInGroup.mockReturnValue(false);
    await deliver(
      downstream({ senderId: 'USER', content: 'dm', group: false }),
    );
    expect(storeMessageDirect).toHaveBeenCalledOnce();
    expect(host.isSenderAllowedInGroup).not.toHaveBeenCalled();
  });

  test('an unowned owner_only group can only be claimed with /owner_mention', async () => {
    const { deliver } = await connect({ audience_mode: 'owner_only' });
    await deliver(downstream({ senderId: 'MEMBER', content: '/status' }));
    expect(onCommand).not.toHaveBeenCalled();
    await deliver(
      downstream({ senderId: 'MEMBER', content: '/owner_mention' }),
    );
    expect(onCommand).toHaveBeenCalledWith(
      GROUP_JID,
      'owner_mention',
      'MEMBER',
      [],
    );
  });

  test('/allow hands the host the @mentioned members', async () => {
    const { deliver } = await connect({
      audience_mode: 'everyone',
      owner_im_id: 'OWNER',
    });
    await deliver(
      downstream({
        senderId: 'OWNER',
        content: '/allow',
        atUsers: [{ dingtalkId: 'bot-dingtalk-id' }, { dingtalkId: 'MEMBER' }],
      }),
    );
    expect(onCommand).toHaveBeenCalledWith(GROUP_JID, 'allow', 'OWNER', [
      { imId: 'MEMBER' },
    ]);
  });

  test('/owner_mention from outside the audience leaves no chat state behind', async () => {
    const onNewChat = vi.fn();
    const { deliver } = await connect(
      { audience_mode: 'owner_only' },
      { onNewChat },
    );
    await deliver(
      downstream({ senderId: 'MEMBER', content: '/owner_mention' }),
    );
    onCommand.mockResolvedValueOnce(null);
    await deliver(
      downstream({ senderId: 'MEMBER', content: '/owner_mention' }),
    );
    expect(onCommand).toHaveBeenCalledTimes(2);
    expect(onNewChat).not.toHaveBeenCalled();
    expect(storeChatMetadata).not.toHaveBeenCalled();
    expect(connection!.getLastMessageId(GROUP_JID)).toBeUndefined();

    // Once claimed, the same sender is admitted and the chat is recorded.
    groups[GROUP_JID].owner_im_id = 'MEMBER';
    await deliver(downstream({ senderId: 'MEMBER', content: 'hi' }));
    expect(onNewChat).toHaveBeenCalledOnce();
    expect(connection!.getLastMessageId(GROUP_JID)).toBeDefined();
  });

  test('a multi-line /owner_mention that is not dispatched is dropped', async () => {
    const { deliver } = await connect({ audience_mode: 'owner_only' });
    await deliver(
      downstream({ senderId: 'MEMBER', content: '/owner_mention\nA\nB' }),
    );
    expect(onCommand).not.toHaveBeenCalled();
    expect(storeMessageDirect).not.toHaveBeenCalled();
  });

  test('a rich-text /owner_mention is never downloaded or stored', async () => {
    const { deliver } = await connect({ audience_mode: 'owner_only' });
    const message = downstream({ senderId: 'MEMBER', content: '' });
    const payload = JSON.parse(message.data);
    payload.msgtype = 'richText';
    delete payload.text;
    payload.content = {
      richText: [
        { text: '/owner_mention' },
        { type: 'picture', downloadCode: 'code-1' },
      ],
    };
    await deliver({ ...message, data: JSON.stringify(payload) });
    expect(onCommand).not.toHaveBeenCalled();
    expect(storeMessageDirect).not.toHaveBeenCalled();
    expect(https.request).not.toHaveBeenCalled();
  });
});

describe('dingTalkCommandMentions', () => {
  test('dingtalkId of every @mentioned member except the bot', () => {
    expect(
      dingTalkCommandMentions({
        chatbotUserId: 'bot',
        atUsers: [
          { dingtalkId: 'bot' },
          { dingtalkId: 'A', staffId: 's' },
          { staffId: 'only-staff' },
          { dingtalkId: 'A' },
        ],
      }),
    ).toEqual([{ imId: 'A' }]);
    expect(dingTalkCommandMentions({})).toEqual([]);
  });
});

describe('DingTalk durable queue and runtime controls', () => {
  let connection: ReturnType<typeof createDingTalkConnection> | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    sdk.MockDWClient.instances.length = 0;
    webhookBodies.length = 0;
    vi.mocked(storeMessageDirect).mockImplementation(() => 'stored');
    vi.spyOn(https, 'request').mockImplementation(((
      _opts: unknown,
      callback?: (res: EventEmitter) => void,
    ) => {
      const req = new EventEmitter() as EventEmitter & Record<string, any>;
      req.setTimeout = () => undefined;
      req.write = (chunk: unknown) => webhookBodies.push(String(chunk));
      req.destroy = () => undefined;
      req.end = () => {
        const res = new EventEmitter() as EventEmitter & Record<string, any>;
        res.statusCode = 200;
        res.headers = {};
        callback?.(res);
        res.emit(
          'data',
          Buffer.from(
            JSON.stringify({ errcode: 0, access_token: 't', expires_in: 7200 }),
          ),
        );
        res.emit('end');
      };
      return req as any;
    }) as any);
  });

  afterEach(async () => {
    await connection?.disconnect();
    connection = null;
    vi.restoreAllMocks();
  });

  async function connect(
    host: ReturnType<typeof followUpHost>,
    overrides: Partial<DingTalkConnectOpts> = {},
  ) {
    connection = createDingTalkConnection({
      clientId: 'ding-client',
      clientSecret: 'ding-secret',
    });
    const opts = {
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
      resolveEffectiveChatJid: (jid: string) => ({
        effectiveJid: jid,
        agentId: null,
      }),
      onMessagePersisted: vi.fn(),
      onAgentMessage: vi.fn(),
      onCommand: vi.fn(async () => null),
      ...host,
      ...overrides,
    };
    await connection.connect(opts);
    const client = sdk.MockDWClient.instances.at(-1)!;
    return {
      opts,
      deliver: (d: ReturnType<typeof downstream>) => client.listener!(d),
    };
  }

  const repliedText = () =>
    webhookBodies
      .map((body) => JSON.parse(body))
      .map((b) => b.text?.content ?? b.markdown?.text);

  test('an input arriving during a run waits in the durable queue', async () => {
    const host = followUpHost('queued');
    const { opts, deliver } = await connect(host);
    await deliver(
      downstream({ senderId: 'U1', content: 'later', group: false }),
    );
    const stored = vi.mocked(storeMessageDirect).mock.calls[0];
    expect(host.onFollowUpMessage).toHaveBeenCalledWith({
      targetJid: 'dingtalk:c2c:U1',
      sourceJid: 'dingtalk:c2c:U1',
      messageId: stored[0],
      senderImId: 'dingtalk:U1',
      requestedMode: undefined,
    });
    expect(opts.onMessagePersisted.mock.calls[0][1]).toMatchObject({
      delivery_status: 'queued',
      delivery_mode: 'queue',
    });
    expect(host.onFollowUpsChanged).toHaveBeenCalledWith('dingtalk:c2c:U1');
  });

  test('with no active run the input starts a turn as before', async () => {
    const host = followUpHost('started');
    const { deliver } = await connect(host);
    await deliver(downstream({ senderId: 'U1', content: 'now', group: false }));
    expect(host.onFollowUpMessage).toHaveBeenCalledOnce();
    expect(host.onFollowUpsChanged).not.toHaveBeenCalled();
  });

  test('/steer stores its guidance as a steer', async () => {
    const host = followUpHost('queued');
    const { opts, deliver } = await connect(host);
    await deliver(
      downstream({ senderId: 'U1', content: '/steer stop and summarize' }),
    );
    expect(vi.mocked(storeMessageDirect).mock.calls[0][4]).toBe(
      'stop and summarize',
    );
    expect(host.onFollowUpMessage.mock.calls[0][0]).toMatchObject({
      requestedMode: 'steer',
    });
    expect(opts.onCommand).not.toHaveBeenCalled();
  });

  test('/break runs on the host and replies through the session webhook', async () => {
    const host = followUpHost('queued');
    const { deliver } = await connect(host);
    await deliver(downstream({ senderId: 'U1', content: '/break' }));
    expect(host.onSessionBreak).toHaveBeenCalledWith({
      sourceJid: GROUP_JID,
      targetJid: GROUP_JID,
      senderImId: 'U1',
      chatType: 'group',
    });
    expect(repliedText()).toContain('Current task stopped.');
    expect(storeMessageDirect).not.toHaveBeenCalled();

    await deliver(
      downstream({ senderId: 'U2', content: '/break', group: false }),
    );
    expect(host.onSessionBreak).toHaveBeenLastCalledWith(
      expect.objectContaining({ chatType: 'p2p', senderImId: 'U2' }),
    );
  });

  test('a group message without the @ flag is not a runtime control', async () => {
    const host = followUpHost('started');
    const { deliver } = await connect(host, {
      shouldProcessGroupMessage: () => true,
    });
    await deliver(
      downstream({ senderId: 'U1', content: '/break', isInAtList: false }),
    );
    expect(host.onSessionBreak).not.toHaveBeenCalled();
    expect(vi.mocked(storeMessageDirect).mock.calls[0][4]).toBe('/break');
  });

  test('a /break whose route is rejected reports no target to the host', async () => {
    const host = followUpHost('started');
    const { deliver } = await connect(host, {
      resolveEffectiveChatJid: () => null,
    });
    await deliver(downstream({ senderId: 'U1', content: '/break' }));
    expect(host.onSessionBreak).toHaveBeenCalledWith(
      expect.objectContaining({ targetJid: undefined }),
    );
  });
});
