import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const harness = vi.hoisted(() => {
  type Listener = (...args: any[]) => unknown;

  function emitter() {
    const listeners = new Map<string, Listener[]>();
    return {
      listeners,
      on(event: string, listener: Listener) {
        const entries = listeners.get(event) ?? [];
        entries.push(listener);
        listeners.set(event, entries);
        return this;
      },
      once(event: string, listener: Listener) {
        const wrapped: Listener = (...args) => {
          const entries = listeners.get(event) ?? [];
          listeners.set(
            event,
            entries.filter((entry) => entry !== wrapped),
          );
          return listener(...args);
        };
        return this.on(event, wrapped);
      },
      emit(event: string, ...args: any[]) {
        return (listeners.get(event) ?? []).map((listener) =>
          listener(...args),
        );
      },
      async emitAsync(event: string, ...args: any[]) {
        await Promise.all(this.emit(event, ...args));
      },
    };
  }

  class FakeWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    readyState = FakeWebSocket.OPEN;
    private readonly events = emitter();

    constructor(_url: string) {
      sockets.push(this);
      queueMicrotask(async () => {
        await this.emitAsync('open');
        await this.emitAsync(
          'message',
          Buffer.from(
            JSON.stringify({ op: 10, d: { heartbeat_interval: 60_000 } }),
          ),
        );
      });
    }

    on(event: string, listener: Listener) {
      this.events.on(event, listener);
      return this;
    }

    send(raw: string) {
      const payload = JSON.parse(raw);
      if (payload.op === 2 || payload.op === 6) {
        queueMicrotask(() =>
          this.emitAsync(
            'message',
            Buffer.from(
              JSON.stringify({
                op: 0,
                t: payload.op === 6 ? 'RESUMED' : 'READY',
                s: 1,
                d: { session_id: 'session-1' },
              }),
            ),
          ),
        );
      }
    }

    close(code = 1000, reason = '') {
      if (this.readyState === FakeWebSocket.CLOSED) return;
      this.readyState = FakeWebSocket.CLOSED;
      this.events.emit('close', code, Buffer.from(reason));
    }

    emitAsync(event: string, ...args: any[]) {
      return this.events.emitAsync(event, ...args);
    }
  }

  const sockets: FakeWebSocket[] = [];
  const sent: Array<{ path: string; body: any }> = [];

  const httpsRequest = vi.fn((options: any, callback: Listener) => {
    const requestEvents = emitter();
    let body = '';
    const request = {
      on: requestEvents.on.bind(requestEvents),
      setTimeout: vi.fn(),
      write(chunk: unknown) {
        body += String(chunk);
      },
      end() {
        if (options.hostname !== 'bots.qq.com' && body) {
          sent.push({
            path: String(options.path ?? ''),
            body: JSON.parse(body),
          });
        }
        queueMicrotask(() => {
          const responseEvents = emitter();
          const response = {
            statusCode: 200,
            on: responseEvents.on.bind(responseEvents),
            destroy: vi.fn(),
          };
          callback(response);
          const payload =
            options.hostname === 'bots.qq.com'
              ? { access_token: 'token', expires_in: 7200 }
              : { url: 'wss://api.sgroup.qq.com/websocket' };
          responseEvents.emit('data', Buffer.from(JSON.stringify(payload)));
          responseEvents.emit('end');
        });
      },
      destroy(error?: Error) {
        if (error) requestEvents.emit('error', error);
      },
    };
    void body;
    return request;
  });

  return { FakeWebSocket, sockets, httpsRequest, sent };
});

vi.mock('ws', () => ({ default: harness.FakeWebSocket }));
vi.mock('node:https', () => ({
  default: { request: harness.httpsRequest },
  request: harness.httpsRequest,
}));

const media = vi.hoisted(() => ({ downloadHttpsBuffer: vi.fn() }));
vi.mock('../src/im-media-download.js', () => media);

const db = vi.hoisted(() => ({
  getRegisteredGroup: vi.fn(),
  storeChatMetadata: vi.fn(),
  storeMessageDirect: vi.fn(),
  updateChatName: vi.fn(),
}));
vi.mock('../src/db.js', () => db);
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createQQConnection, qqGroupCommandMentions } =
  await import('../src/qq.js');
const { groupAudienceHost } = await import('./helpers/group-audience.js');
type AudienceGroup = import('./helpers/group-audience.js').AudienceGroup;

const GROUP_JID = 'qq:group:G1';
let seq = 0;

function groupPayload(input: {
  member: string;
  content: string;
  mentions?: unknown[];
}) {
  seq += 1;
  return Buffer.from(
    JSON.stringify({
      op: 0,
      t: 'GROUP_AT_MESSAGE_CREATE',
      s: 10 + seq,
      d: {
        id: `qq-group-${seq}`,
        timestamp: new Date().toISOString(),
        group_openid: 'G1',
        author: { member_openid: input.member, username: input.member },
        content: `<@!bot> ${input.content}`,
        mentions: input.mentions,
      },
    }),
  );
}

function c2cPayload(user: string, content: string) {
  seq += 1;
  return Buffer.from(
    JSON.stringify({
      op: 0,
      t: 'C2C_MESSAGE_CREATE',
      s: 10 + seq,
      d: {
        id: `qq-c2c-${seq}`,
        timestamp: new Date().toISOString(),
        author: { user_openid: user, username: user },
        content,
      },
    }),
  );
}

describe('QQ group response audience', () => {
  let connection: ReturnType<typeof createQQConnection> | null = null;
  let groups: Record<string, AudienceGroup>;
  let onCommand: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    harness.sockets.length = 0;
    harness.sent.length = 0;
    groups = {};
    onCommand = vi.fn(async (_jid: string, command: string) =>
      command.startsWith('status') || command.startsWith('owner_mention')
        ? 'ok'
        : null,
    );
  });

  afterEach(async () => {
    await connection?.disconnect();
    connection = null;
  });

  async function connect(group?: AudienceGroup) {
    if (group) groups[GROUP_JID] = group;
    const host = groupAudienceHost('qq', groups);
    connection = createQQConnection({ appId: 'app', appSecret: 'secret' });
    await connection.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
      resolveEffectiveChatJid: (jid) => ({ effectiveJid: jid, agentId: null }),
      onCommand,
      ...host,
    });
    return { host, socket: harness.sockets.at(-1)! };
  }

  test('owner_only: the owner reaches the Agent, another member does not', async () => {
    const { socket } = await connect({
      audience_mode: 'owner_only',
      owner_im_id: 'group:OWNER',
    });
    await socket.emitAsync(
      'message',
      groupPayload({ member: 'OWNER', content: 'hi' }),
    );
    await socket.emitAsync(
      'message',
      groupPayload({ member: 'MEMBER', content: 'hi' }),
    );
    await socket.emitAsync(
      'message',
      groupPayload({ member: 'MEMBER', content: '/status' }),
    );
    expect(db.storeMessageDirect).toHaveBeenCalledOnce();
    expect(db.storeMessageDirect.mock.calls[0][2]).toBe('qq:OWNER');
    expect(onCommand).not.toHaveBeenCalled();
  });

  test('allowlist: listed members pass, others are dropped', async () => {
    const { socket } = await connect({
      audience_mode: 'everyone',
      owner_im_id: 'group:OWNER',
      sender_allowlist: ['group:OWNER', 'group:MEMBER'],
    });
    await socket.emitAsync(
      'message',
      groupPayload({ member: 'MEMBER', content: 'listed' }),
    );
    await socket.emitAsync(
      'message',
      groupPayload({ member: 'OUTSIDER', content: 'not listed' }),
    );
    expect(db.storeMessageDirect).toHaveBeenCalledOnce();
    expect(db.storeMessageDirect.mock.calls[0][4]).toBe('listed');
  });

  test('everyone without an allowlist admits every member', async () => {
    const { socket } = await connect({ audience_mode: 'everyone' });
    await socket.emitAsync(
      'message',
      groupPayload({ member: 'A', content: 'a' }),
    );
    await socket.emitAsync(
      'message',
      groupPayload({ member: 'B', content: 'b' }),
    );
    expect(db.storeMessageDirect).toHaveBeenCalledTimes(2);
  });

  test('private chats never consult the group gate', async () => {
    const { host, socket } = await connect();
    host.isSenderAllowedInGroup.mockReturnValue(false);
    await socket.emitAsync('message', c2cPayload('USER', 'dm'));
    expect(db.storeMessageDirect).toHaveBeenCalledOnce();
    expect(host.isSenderAllowedInGroup).not.toHaveBeenCalled();
  });

  test('an unowned owner_only group can only be claimed with /owner_mention', async () => {
    const { socket } = await connect({ audience_mode: 'owner_only' });
    await socket.emitAsync(
      'message',
      groupPayload({ member: 'MEMBER', content: '/status' }),
    );
    expect(onCommand).not.toHaveBeenCalled();
    await socket.emitAsync(
      'message',
      groupPayload({ member: 'MEMBER', content: '/owner_mention' }),
    );
    expect(onCommand).toHaveBeenCalledWith(
      GROUP_JID,
      'owner_mention',
      'group:MEMBER',
      [],
    );
  });

  test('/allow hands the host structured member mentions', async () => {
    const { socket } = await connect({
      audience_mode: 'everyone',
      owner_im_id: 'group:OWNER',
    });
    await socket.emitAsync(
      'message',
      groupPayload({
        member: 'OWNER',
        content: '/allow',
        mentions: [
          { member_openid: 'BOT', is_you: true },
          { member_openid: 'MEMBER' },
        ],
      }),
    );
    expect(onCommand).toHaveBeenCalledWith(GROUP_JID, 'allow', 'group:OWNER', [
      { imId: 'group:MEMBER' },
    ]);
  });
});

describe('QQ audience: /owner_mention is only an exception when consumed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.sockets.length = 0;
  });

  test('a multi-line /owner_mention that is not dispatched is dropped', async () => {
    const groups: Record<string, AudienceGroup> = {
      [GROUP_JID]: { audience_mode: 'owner_only' },
    };
    const onCommand = vi.fn(async () => 'claimed');
    const connection = createQQConnection({
      appId: 'app',
      appSecret: 'secret',
    });
    await connection.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
      resolveEffectiveChatJid: (jid) => ({ effectiveJid: jid, agentId: null }),
      onCommand,
      ...groupAudienceHost('qq', groups),
    });
    const socket = harness.sockets.at(-1)!;
    await socket.emitAsync(
      'message',
      groupPayload({ member: 'MEMBER', content: '/owner_mention\nA\nB' }),
    );
    expect(onCommand).not.toHaveBeenCalled();
    expect(db.storeMessageDirect).not.toHaveBeenCalled();
    await connection.disconnect();
  });
});

describe('qqGroupCommandMentions', () => {
  test('member openids in the group namespace, never the bot', () => {
    expect(
      qqGroupCommandMentions({
        mentions: [
          { member_openid: 'A' },
          { member_openid: 'B', bot: true },
          { member_openid: 'C', is_you: true },
          { user_openid: 'D' },
          null,
        ],
      }),
    ).toEqual([{ imId: 'group:A' }]);
    expect(qqGroupCommandMentions({})).toEqual([]);
  });
});
