import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const harness = vi.hoisted(() => {
  type Listener = (...args: any[]) => unknown;

  function emitter() {
    const listeners = new Map<string, Listener[]>();
    return {
      on(event: string, listener: Listener) {
        const entries = listeners.get(event) ?? [];
        entries.push(listener);
        listeners.set(event, entries);
      },
      emit(event: string, ...args: any[]) {
        return (listeners.get(event) ?? []).map((listener) =>
          listener(...args),
        );
      },
    };
  }

  const config = {
    /** New sockets open and send HELLO on their own. */
    autoOpen: true,
    /** The gateway confirms RESUME with RESUMED. */
    answerResume: true,
    /** Gateway URL lookups fail with ECONNREFUSED. */
    failGateway: false,
  };
  const sockets: FakeWebSocket[] = [];
  const gatewayRequests: number[] = [];

  class FakeWebSocket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 3;
    readyState = FakeWebSocket.CONNECTING;
    readonly sent: any[] = [];
    private readonly events = emitter();

    constructor(readonly url: string) {
      sockets.push(this);
      if (config.autoOpen) queueMicrotask(() => this.open());
    }

    on(event: string, listener: Listener) {
      this.events.on(event, listener);
      return this;
    }

    async open() {
      this.readyState = FakeWebSocket.OPEN;
      await Promise.all(this.events.emit('open'));
      await this.receive({ op: 10, d: { heartbeat_interval: 30_000 } });
    }

    async receive(payload: unknown) {
      await Promise.all(
        this.events.emit('message', Buffer.from(JSON.stringify(payload))),
      );
    }

    send(raw: string) {
      const payload = JSON.parse(raw);
      this.sent.push(payload);
      if (payload.op === 2 || (payload.op === 6 && config.answerResume)) {
        queueMicrotask(() =>
          this.receive({
            op: 0,
            t: payload.op === 6 ? 'RESUMED' : 'READY',
            s: 1,
            d: { session_id: 'session-1' },
          }),
        );
      }
    }

    close(code = 1000, reason = '') {
      if (this.readyState === FakeWebSocket.CLOSED) return;
      this.emitClose(code, reason);
    }

    /** Server-side close, delivered even if a close was already seen. */
    emitClose(code: number, reason = '') {
      this.readyState = FakeWebSocket.CLOSED;
      this.events.emit('close', code, Buffer.from(reason));
    }

    ops(): number[] {
      return this.sent.map((payload) => payload.op);
    }
  }

  const httpsRequest = vi.fn((options: any, callback: Listener) => {
    const requestEvents = emitter();
    return {
      on(event: string, listener: Listener) {
        requestEvents.on(event, listener);
        return this;
      },
      setTimeout: vi.fn(),
      write: vi.fn(),
      end() {
        queueMicrotask(() => {
          const isToken = options.hostname === 'bots.qq.com';
          if (!isToken) gatewayRequests.push(Date.now());
          if (!isToken && config.failGateway) {
            requestEvents.emit(
              'error',
              Object.assign(new Error('connect ECONNREFUSED'), {
                code: 'ECONNREFUSED',
              }),
            );
            return;
          }
          const responseEvents = emitter();
          callback({
            statusCode: 200,
            on: (event: string, listener: Listener) =>
              responseEvents.on(event, listener),
            destroy: vi.fn(),
          });
          const payload = isToken
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
  });

  return { FakeWebSocket, sockets, gatewayRequests, httpsRequest, config };
});

vi.mock('ws', () => ({ default: harness.FakeWebSocket }));
vi.mock('node:https', () => ({
  default: { request: harness.httpsRequest },
  request: harness.httpsRequest,
}));
vi.mock('../src/im-media-download.js', () => ({
  downloadHttpsBuffer: vi.fn(),
}));
vi.mock('../src/db.js', () => ({
  getRegisteredGroup: vi.fn(),
  storeChatMetadata: vi.fn(),
  storeMessageDirect: vi.fn(),
  updateChatName: vi.fn(),
}));
vi.mock('../src/message-notifier.js', () => ({ notifyNewImMessage: vi.fn() }));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createQQConnection } = await import('../src/qq.js');

const flush = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

async function connected() {
  const connection = createQQConnection({ appId: 'app', appSecret: 'secret' });
  await connection.connect({
    onNewChat: vi.fn(),
    isChatAuthorized: () => true,
    resolveEffectiveChatJid: (jid) => ({ effectiveJid: jid, agentId: null }),
  });
  await flush();
  expect(connection.isConnected()).toBe(true);
  return connection;
}

/** Advance fake time in small steps so microtask-driven handshakes settle. */
async function advance(ms: number, step = 250) {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    await vi.advanceTimersByTimeAsync(Math.min(step, ms - elapsed));
    await flush();
  }
}

describe('QQ reconnect state machine', () => {
  let connection: Awaited<ReturnType<typeof connected>> | null = null;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] });
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    harness.sockets.length = 0;
    harness.gatewayRequests.length = 0;
    harness.config.autoOpen = true;
    harness.config.answerResume = true;
    harness.config.failGateway = false;
  });

  afterEach(async () => {
    await connection?.disconnect();
    connection = null;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test('the watchdog does not start a second attempt while one is connecting', async () => {
    connection = await connected();
    const first = harness.sockets[0];
    harness.config.autoOpen = false;

    await first.receive({ op: 7 }); // server-requested reconnect
    await advance(1_500);
    expect(harness.sockets).toHaveLength(2);
    const pending = harness.sockets[1];
    expect(pending.readyState).toBe(harness.FakeWebSocket.CONNECTING);

    // Two watchdog periods pass while the attempt is still in flight.
    await advance(125_000, 5_000);
    expect(harness.sockets).toHaveLength(2);

    await pending.open();
    await flush();
    expect(pending.ops()).toContain(6); // resumed the session
    expect(connection.isConnected()).toBe(true);
  });

  test("a superseded socket's late close keeps the live heartbeat and does not reconnect", async () => {
    connection = await connected();
    const first = harness.sockets[0];
    await first.receive({ op: 7 });
    await advance(1_500);
    const live = harness.sockets[1];
    expect(live.ops()).toContain(6);

    // The gateway drops the old socket later (1006, no heartbeats).
    first.emitClose(1006);
    await advance(65_000, 1_000);

    expect(harness.sockets).toHaveLength(2);
    expect(live.ops().filter((op) => op === 1).length).toBeGreaterThanOrEqual(
      2,
    );
    expect(first.ops().filter((op) => op === 1)).toHaveLength(0);
  });

  test('identifies instead of resuming after the gateway rejected a resume', async () => {
    connection = await connected();
    // 4902 "reset by resume": the session is gone.
    harness.sockets[0].emitClose(4902, 'reset by resume');
    await advance(3_000);
    const next = harness.sockets[1];
    expect(next.ops()).toContain(2);
    expect(next.ops()).not.toContain(6);

    // A RESUME that is never confirmed before the socket drops also falls
    // back to IDENTIFY on the following attempt.
    await next.receive({ op: 7 });
    harness.config.answerResume = false;
    await advance(1_500);
    const unconfirmed = harness.sockets[2];
    expect(unconfirmed.ops()).toContain(6);
    unconfirmed.emitClose(1006);
    harness.config.answerResume = true;
    await advance(3_000);
    const fresh = harness.sockets[3];
    expect(fresh.ops()).toContain(2);
    expect(fresh.ops()).not.toContain(6);
  });

  test('transient failures back off along the ladder instead of retrying every second', async () => {
    connection = await connected();
    harness.config.failGateway = true;
    harness.gatewayRequests.length = 0;
    harness.sockets[0].emitClose(4902, 'reset by resume');
    await advance(30_000, 500);
    const attempts = harness.gatewayRequests.length;
    // Ladder 1s, 2s, 2s, 5s, 10s, 30s: five attempts in 30s, not ~30.
    expect(attempts).toBeGreaterThanOrEqual(3);
    expect(attempts).toBeLessThanOrEqual(5);

    harness.config.failGateway = false;
    await advance(40_000, 1_000);
    expect(connection.isConnected()).toBe(true);
  });
});
