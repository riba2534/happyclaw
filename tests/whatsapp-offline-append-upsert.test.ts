import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

const harness = vi.hoisted(() => {
  type Listener = (value: any) => unknown;
  function createSocket() {
    const listeners = new Map<string, Listener[]>();
    return {
      listeners,
      ev: {
        on: vi.fn((event: string, listener: Listener) => {
          const entries = listeners.get(event) ?? [];
          entries.push(listener);
          listeners.set(event, entries);
        }),
      },
      ws: { on: vi.fn(), isConnecting: false },
      user: { id: '19990001111:7@s.whatsapp.net', name: 'Test bot' },
      sendMessage: vi.fn(async () => undefined),
      sendPresenceUpdate: vi.fn(async () => undefined),
      groupMetadata: vi.fn(async () => ({ subject: 'Test group' })),
      end: vi.fn(),
      logout: vi.fn(async () => undefined),
      updateMediaMessage: vi.fn(),
      async emit(event: string, value: unknown) {
        await Promise.all(
          (listeners.get(event) ?? []).map((listener) => listener(value)),
        );
      },
    };
  }
  return { sockets: [] as ReturnType<typeof createSocket>[], createSocket };
});

vi.mock('baileys', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    makeWASocket: vi.fn(() => {
      const socket = harness.createSocket();
      harness.sockets.push(socket);
      return socket;
    }),
    useMultiFileAuthState: vi.fn(async () => ({
      state: { creds: {}, keys: {} },
      saveCreds: vi.fn(async () => undefined),
    })),
    fetchLatestBaileysVersion: vi.fn(async () => ({
      version: [2, 3000, 1],
      isLatest: true,
    })),
  };
});

const db = vi.hoisted(() => ({
  storeChatMetadata: vi.fn(),
  storeMessageDirect: vi.fn(),
  updateChatName: vi.fn(),
  getRegisteredGroup: vi.fn(),
  getDefaultChannelAccount: vi.fn(),
  getLegacyChannelAccount: vi.fn(),
  getChannelAccount: vi.fn(),
  getUserById: vi.fn(),
  isDatabaseInitialized: vi.fn(() => false),
}));
vi.mock('../src/db.js', () => db);

vi.mock('../src/web.js', () => ({ broadcastNewMessage: vi.fn() }));
vi.mock('../src/logger.js', () => {
  const noop = () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  });
  return { logger: { ...noop(), child: vi.fn(noop) } };
});
vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn(async () => 'data:image/png;base64,test') },
}));
vi.mock('proxy-agent', () => ({
  ProxyAgent: class {
    destroy() {}
  },
}));

const { createWhatsAppConnection } = await import('../src/whatsapp.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-offline-append-'));

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const PEER = '15559876543@s.whatsapp.net';

function textMsg(
  id: string,
  text: string,
  opts: { fromMe?: boolean; tsMs?: number } = {},
) {
  const tsMs = opts.tsMs ?? Date.now();
  return {
    key: { remoteJid: PEER, id, fromMe: opts.fromMe ?? false },
    message: { conversation: text },
    pushName: 'Ada',
    messageTimestamp: Math.floor(tsMs / 1000),
  };
}

async function connect(ignoreMessagesBefore?: number) {
  const connection = createWhatsAppConnection({
    accountId: 'bot-append',
    authDir: path.join(root, `auth-${harness.sockets.length}`),
  });
  await connection.connect({
    onNewChat: vi.fn(),
    isChatAuthorized: () => true,
    ...(ignoreMessagesBefore !== undefined ? { ignoreMessagesBefore } : {}),
  });
  return { connection, socket: harness.sockets.at(-1)! };
}

function storedContents(): string[] {
  return db.storeMessageDirect.mock.calls.map((c) => String(c[4]));
}

describe('WhatsApp offline-queued append upserts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.sockets.length = 0;
  });

  test('a recent append from a paired chat is stored once', async () => {
    const { connection, socket } = await connect(Date.now() - 60_000);

    await socket.emit('messages.upsert', {
      type: 'append',
      messages: [textMsg('GAP-1', 'are you there? (sent during reconnect)')],
    });
    // Re-emit the same offline stanza (Baileys can flush twice at the boundary).
    await socket.emit('messages.upsert', {
      type: 'append',
      messages: [textMsg('GAP-1', 'are you there? (sent during reconnect)')],
    });

    expect(storedContents()).toEqual([
      'are you there? (sent during reconnect)',
    ]);
    await connection.disconnect();
  });

  test('an append older than ignoreMessagesBefore is dropped', async () => {
    // Pair a recent offline append with a pre-startup history straggler so the
    // parent (which drops every append) fails on the recent message, while the
    // fix still drops only the old one via ignoreMessagesBefore.
    // Pin timestamps explicitly: messageTimestamp is second-granularity, so a
    // mid-second ignoreMessagesBefore would otherwise drop a "now" message.
    const startedAt = Date.now() - 60_000;
    const { connection, socket } = await connect(startedAt);

    await socket.emit('messages.upsert', {
      type: 'append',
      messages: [
        textMsg('GAP-2', 'please deploy the fix', {
          tsMs: startedAt + 30_000,
        }),
        textMsg('HIST-OLD', 'old history before startup', {
          tsMs: startedAt - 3_600_000,
        }),
      ],
    });

    expect(storedContents()).toEqual(['please deploy the fix']);
    expect(storedContents().some((c) => c.includes('old history'))).toBe(false);
    await connection.disconnect();
  });

  test('a fromMe append is dropped', async () => {
    // Pair a peer offline append with an own-echo append so the parent fails
    // on the peer message, while the fix still drops fromMe via key.fromMe.
    const { connection, socket } = await connect(Date.now() - 60_000);

    await socket.emit('messages.upsert', {
      type: 'append',
      messages: [
        textMsg('GAP-3', 'peer offline message'),
        textMsg('ECHO-1', 'my own reply echo', { fromMe: true }),
      ],
    });

    expect(storedContents()).toEqual(['peer offline message']);
    expect(storedContents().some((c) => c.includes('own reply echo'))).toBe(
      false,
    );
    await connection.disconnect();
  });

  test('the same id delivered as notify then append is not double-stored', async () => {
    const { connection, socket } = await connect(Date.now() - 60_000);
    const inbound = textMsg('LIVE-1', 'hello (live)');

    await socket.emit('messages.upsert', {
      type: 'notify',
      messages: [inbound],
    });
    await socket.emit('messages.upsert', {
      type: 'append',
      messages: [inbound],
    });

    expect(storedContents()).toEqual(['hello (live)']);
    await connection.disconnect();
  });
});
