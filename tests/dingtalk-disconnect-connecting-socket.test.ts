import net from 'node:net';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import WebSocket from 'ws';

// Minimal stand-in for dingtalk-stream's DWClient. connect() leaves a real
// ws@8 socket in CONNECTING (as the SDK's auto-reconnect does mid-handshake)
// and disconnect() mirrors the SDK cleanup(): removeAllListeners() and then
// terminate(), which makes ws emit 'error' on the next tick.
const sdk = vi.hoisted(() => {
  const state = {
    endpoint: '',
    failConnect: false,
    sockets: [] as import('ws').WebSocket[],
  };
  class MockDWClient {
    socket?: import('ws').WebSocket;
    registerCallbackListener = vi.fn(() => this);
    socketCallBackResponse = vi.fn();
    constructor(public options: Record<string, unknown>) {}
    async connect(): Promise<void> {
      const { default: WS } = await import('ws');
      const socket = new WS(state.endpoint);
      socket.on('error', () => {});
      this.socket = socket;
      state.sockets.push(socket);
      if (state.failConnect) throw new Error('gateway handshake failed');
    }
    disconnect(): void {
      if (this.socket) {
        this.socket.removeAllListeners();
        this.socket.terminate();
        this.socket = undefined;
      }
    }
  }
  return { MockDWClient, state };
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
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import { createDingTalkConnection } from '../src/dingtalk.js';

// Accepts TCP connections but never answers the HTTP upgrade, so the ws
// client stays in CONNECTING until it is terminated.
let blackhole: net.Server;
const held = new Set<net.Socket>();

beforeEach(async () => {
  blackhole = net.createServer((sock) => {
    held.add(sock);
    sock.on('error', () => {});
    sock.on('close', () => held.delete(sock));
  });
  await new Promise<void>((resolve) =>
    blackhole.listen(0, '127.0.0.1', resolve),
  );
  const { port } = blackhole.address() as net.AddressInfo;
  sdk.state.endpoint = `ws://127.0.0.1:${port}`;
  sdk.state.failConnect = false;
  sdk.state.sockets = [];
});

afterEach(async () => {
  for (const sock of held) sock.destroy();
  await new Promise<void>((resolve) => blackhole.close(() => resolve()));
});

function connectOpts() {
  return {
    onNewChat: vi.fn(),
    isChatAuthorized: () => true,
    resolveEffectiveChatJid: (jid: string) => ({
      effectiveJid: jid,
      agentId: null,
    }),
    onMessagePersisted: vi.fn(),
  };
}

async function waitForAccepted(): Promise<void> {
  await vi.waitFor(() => expect(held.size).toBeGreaterThan(0));
}

// ws emits 'error' then 'close' via process.nextTick after terminate(). With no
// 'error' listener the emit throws (uncaughtException) and 'close' never runs,
// leaving the socket stuck in CLOSING.
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('DingTalk disconnect while the SDK socket is CONNECTING', () => {
  test('disconnect() does not leak an unhandled ws error', async () => {
    const connection = createDingTalkConnection({
      clientId: 'ding-client',
      clientSecret: 'ding-secret',
    });
    expect(await connection.connect(connectOpts())).toBe(true);
    const socket = sdk.state.sockets.at(-1)!;
    await waitForAccepted();
    expect(socket.readyState).toBe(WebSocket.CONNECTING);

    await connection.disconnect();
    await settle();

    expect(socket.listenerCount('error')).toBeGreaterThan(0);
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });

  test('connect-failure cleanup does not leak an unhandled ws error', async () => {
    sdk.state.failConnect = true;
    const connection = createDingTalkConnection({
      clientId: 'ding-client',
      clientSecret: 'ding-secret',
    });
    expect(await connection.connect(connectOpts())).toBe(false);
    const socket = sdk.state.sockets.at(-1)!;
    expect(socket).toBeDefined();
    await settle();

    expect(socket.listenerCount('error')).toBeGreaterThan(0);
    expect(socket.readyState).toBe(WebSocket.CLOSED);
  });
});
