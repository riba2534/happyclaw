/**
 * After /pair, QQ mounts often have channel_account_id only (no target).
 * resolveAdmittedChannelRoute then returns null. Slash commands must still
 * reach onCommand; plain traffic stays fail-closed at the route gate.
 * /steer and /break stay post-route (need targetJid).
 */
import { beforeEach, describe, expect, test, vi } from 'vitest';

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
  const apiBodies: Array<{ path: string; body: string }> = [];

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
        queueMicrotask(() => {
          const path = String(options.path ?? '');
          apiBodies.push({ path, body });
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
              : path.includes('/gateway')
                ? { url: 'wss://api.sgroup.qq.com/websocket' }
                : { id: 'sent-1' };
          responseEvents.emit('data', Buffer.from(JSON.stringify(payload)));
          responseEvents.emit('end');
        });
      },
      destroy(error?: Error) {
        if (error) requestEvents.emit('error', error);
      },
    };
    return request;
  });

  return { FakeWebSocket, sockets, httpsRequest, apiBodies };
});

vi.mock('ws', () => ({ default: harness.FakeWebSocket }));
vi.mock('node:https', () => ({
  default: { request: harness.httpsRequest },
  request: harness.httpsRequest,
}));

const db = vi.hoisted(() => ({
  getRegisteredGroup: vi.fn(),
  storeChatMetadata: vi.fn(),
  storeMessageDirect: vi.fn(),
  updateChatName: vi.fn(),
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

const { createQQConnection } = await import('../src/qq.js');
const { logger } = await import('../src/logger.js');

function c2cPayload(content: string, id = `c2c-${content}`) {
  return {
    op: 0,
    t: 'C2C_MESSAGE_CREATE',
    s: 2,
    d: {
      id,
      timestamp: new Date().toISOString(),
      author: { id: 'user-1', username: 'Ada', user_openid: 'user-1' },
      content,
    },
  };
}

function groupPayload(content: string, id = `group-${content}`) {
  return {
    op: 0,
    t: 'GROUP_AT_MESSAGE_CREATE',
    s: 3,
    d: {
      id,
      timestamp: new Date().toISOString(),
      group_openid: 'group-1',
      author: { member_openid: 'member-1', username: 'Bob' },
      content,
    },
  };
}

describe('QQ slash commands before route (paired account mount)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.sockets.length = 0;
    harness.apiBodies.length = 0;
  });

  test('(1) C2C after pair with account mount only: /new and /bind reach onCommand; plain drops', async () => {
    const resolveEffectiveChatJid = vi.fn(() => null);
    const onCommand = vi.fn(async (_j: string, cmd: string) => `ok:${cmd}`);
    const onMessagePersisted = vi.fn();
    const connection = createQQConnection({
      appId: 'app',
      appSecret: 'secret',
    });
    await connection.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
      resolveEffectiveChatJid,
      onCommand,
      onMessagePersisted,
    });
    const socket = harness.sockets.at(-1)!;

    await socket.emitAsync(
      'message',
      Buffer.from(JSON.stringify(c2cPayload('/new', 'c2c-new'))),
    );
    await socket.emitAsync(
      'message',
      Buffer.from(JSON.stringify(c2cPayload('/bind web:w1', 'c2c-bind'))),
    );
    await socket.emitAsync(
      'message',
      Buffer.from(JSON.stringify(c2cPayload('hello after pair', 'c2c-plain'))),
    );

    expect(onCommand).toHaveBeenCalledWith(
      'qq:c2c:user-1',
      'new',
      'c2c:user-1',
    );
    expect(onCommand).toHaveBeenCalledWith(
      'qq:c2c:user-1',
      'bind web:w1',
      'c2c:user-1',
    );
    expect(onCommand).toHaveBeenCalledTimes(2);
    expect(onMessagePersisted).not.toHaveBeenCalled();
    expect(db.storeMessageDirect).not.toHaveBeenCalled();
    expect(resolveEffectiveChatJid).toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jid: 'qq:c2c:user-1' }),
      expect.stringContaining('binding resolver rejected route'),
    );
    await connection.disconnect();
  });

  test('(2) group after pair with account mount only: /new reaches onCommand; plain drops', async () => {
    const resolveEffectiveChatJid = vi.fn(() => null);
    const onCommand = vi.fn(async (_j: string, cmd: string) => `ok:${cmd}`);
    const onMessagePersisted = vi.fn();
    const connection = createQQConnection({
      appId: 'app',
      appSecret: 'secret',
    });
    await connection.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
      resolveEffectiveChatJid,
      onCommand,
      onMessagePersisted,
    });
    const socket = harness.sockets.at(-1)!;

    await socket.emitAsync(
      'message',
      Buffer.from(JSON.stringify(groupPayload('/new', 'g-new'))),
    );
    await socket.emitAsync(
      'message',
      Buffer.from(JSON.stringify(groupPayload('plain group', 'g-plain'))),
    );

    expect(onCommand).toHaveBeenCalledWith(
      'qq:group:group-1',
      'new',
      'group:member-1',
      [],
    );
    expect(onCommand).toHaveBeenCalledTimes(1);
    expect(onMessagePersisted).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jid: 'qq:group:group-1' }),
      expect.stringContaining('binding resolver rejected route'),
    );
    await connection.disconnect();
  });

  test('(3) already-bound chat: slash, plain, /steer and /break still work', async () => {
    const resolveEffectiveChatJid = vi.fn((jid: string) => ({
      effectiveJid: `${jid}#agent:a1`,
      agentId: 'a1',
    }));
    const onCommand = vi.fn(async (_j: string, cmd: string) => `ok:${cmd}`);
    const onSessionBreak = vi.fn(async () => 'break-ok');
    const onMessagePersisted = vi.fn();
    const connection = createQQConnection({
      appId: 'app',
      appSecret: 'secret',
    });
    await connection.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
      resolveEffectiveChatJid,
      onCommand,
      onSessionBreak,
      onMessagePersisted,
    });
    const socket = harness.sockets.at(-1)!;

    await socket.emitAsync(
      'message',
      Buffer.from(JSON.stringify(c2cPayload('/status', 'bound-status'))),
    );
    await socket.emitAsync(
      'message',
      Buffer.from(JSON.stringify(c2cPayload('hello bound', 'bound-plain'))),
    );
    await socket.emitAsync(
      'message',
      Buffer.from(JSON.stringify(c2cPayload('/break', 'bound-break'))),
    );
    await socket.emitAsync(
      'message',
      Buffer.from(
        JSON.stringify(c2cPayload('/steer keep going', 'bound-steer')),
      ),
    );

    expect(onCommand).toHaveBeenCalledWith(
      'qq:c2c:user-1',
      'status',
      'c2c:user-1',
    );
    expect(onSessionBreak).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceJid: 'qq:c2c:user-1',
        targetJid: 'qq:c2c:user-1#agent:a1',
      }),
    );
    expect(onMessagePersisted).toHaveBeenCalled();
    const persistedContents = onMessagePersisted.mock.calls.map(
      (c) => c[1]?.content ?? c[1],
    );
    // plain + steered text (without the /steer prefix)
    expect(
      onMessagePersisted.mock.calls.some(
        (c) => typeof c[1] === 'object' && c[1]?.content === 'hello bound',
      ) || db.storeMessageDirect.mock.calls.some((c) => c[4] === 'hello bound'),
    ).toBe(true);
    expect(
      db.storeMessageDirect.mock.calls.some((c) => c[4] === 'keep going'),
    ).toBe(true);
    await connection.disconnect();
  });

  test('(4) QQ group: bootstrap-admitted /break runs before bootstrap return', async () => {
    const onSessionBreak = vi.fn(async () => 'break-ok');
    const onMessagePersisted = vi.fn();
    const connection = createQQConnection({
      appId: 'app',
      appSecret: 'secret',
    });
    await connection.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
      resolveEffectiveChatJid: (jid: string) => ({
        effectiveJid: `${jid}#agent:a1`,
        agentId: 'a1',
      }),
      onSessionBreak,
      onMessagePersisted,
    });
    const socket = harness.sockets.at(-1)!;

    audienceOverrides.next = 'bootstrap';
    await socket.emitAsync(
      'message',
      Buffer.from(JSON.stringify(groupPayload('/break', 'group-boot-break'))),
    );

    expect(onSessionBreak).toHaveBeenCalledTimes(1);
    expect(onSessionBreak).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceJid: 'qq:group:group-1',
        targetJid: 'qq:group:group-1#agent:a1',
      }),
    );
    expect(onMessagePersisted).not.toHaveBeenCalled();
    await connection.disconnect();
  });
});
