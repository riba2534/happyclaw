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

  return { FakeWebSocket, sockets, httpsRequest };
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

const { createQQConnection } = await import('../src/qq.js');

function inboundPayload() {
  return {
    op: 0,
    t: 'C2C_MESSAGE_CREATE',
    s: 2,
    d: {
      id: 'qq-disconnect-media-1',
      timestamp: new Date().toISOString(),
      author: { id: 'user-1', username: 'Ada' },
      content: 'caption',
      attachments: [
        { url: 'https://cdn.qq.test/held.png', filename: 'held.png' },
      ],
    },
  };
}

async function connect() {
  const onMessagePersisted = vi.fn();
  const connection = createQQConnection({ appId: 'app', appSecret: 'secret' });
  await connection.connect({
    onNewChat: vi.fn(),
    isChatAuthorized: () => true,
    resolveEffectiveChatJid: (jid) => ({ effectiveJid: jid, agentId: null }),
    onMessagePersisted,
  });
  return {
    connection,
    socket: harness.sockets.at(-1)!,
    onMessagePersisted,
  };
}

describe('QQ disconnect inbound generation fence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.sockets.length = 0;
  });

  test('held media cannot persist after disconnect; new redelivery stores once', async () => {
    let releaseDownload!: (value: Buffer) => void;
    let admittedSignal: AbortSignal | undefined;
    media.downloadHttpsBuffer.mockImplementation(
      async (_url: string, options: { signal?: AbortSignal }) =>
        new Promise<Buffer>((resolve) => {
          admittedSignal = options.signal;
          releaseDownload = resolve;
        }),
    );

    const first = await connect();
    const oldAttempt = first.socket.emitAsync(
      'message',
      Buffer.from(JSON.stringify(inboundPayload())),
    );
    await vi.waitFor(() =>
      expect(media.downloadHttpsBuffer).toHaveBeenCalledOnce(),
    );

    const disconnect = first.connection.disconnect();
    await vi.waitFor(() => expect(admittedSignal?.aborted).toBe(true));
    releaseDownload(Buffer.from('late-image'));
    await Promise.all([oldAttempt, disconnect]);
    expect(db.storeMessageDirect).not.toHaveBeenCalled();
    expect(first.onMessagePersisted).not.toHaveBeenCalled();

    media.downloadHttpsBuffer.mockResolvedValue(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    const second = await connect();
    const redelivery = Buffer.from(JSON.stringify(inboundPayload()));
    await second.socket.emitAsync('message', redelivery);
    await second.socket.emitAsync('message', redelivery);

    expect(db.storeMessageDirect).toHaveBeenCalledTimes(1);
    expect(second.onMessagePersisted).toHaveBeenCalledTimes(1);
    await second.connection.disconnect();
  });
});
