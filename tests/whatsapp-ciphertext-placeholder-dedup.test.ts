import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * Baileys upserts CIPHERTEXT/unavailable stubs (no decryptable body,
 * messageStubType 2) then may re-emit the same key.id with real content
 * via PDO placeholder resend or decrypt retry.
 *
 * Tip: runMessage markSeen's after the stub's empty-content early return,
 * so the follow-up is isDuplicate-dropped — durable silent loss.
 *
 * Fix: continue past stubs lacking a decryptable message (or stubType 2)
 * before runMessage so markSeen never fires for placeholders.
 */
const CIPHERTEXT = 2; // proto.WebMessageInfo.StubType.CIPHERTEXT

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

const downloadMediaMessage = vi.hoisted(() =>
  vi.fn(async () => Buffer.from('media-bytes')),
);

vi.mock('baileys', async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    downloadMediaMessage,
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
vi.mock('../src/logger.js', () => ({
  logger: {
    child: vi.fn(() => ({
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    })),
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock('qrcode', () => ({
  default: { toDataURL: vi.fn(async () => 'data:image/png;base64,test') },
}));
vi.mock('proxy-agent', () => ({
  ProxyAgent: class {
    destroy() {}
  },
}));

const { createWhatsAppConnection } = await import('../src/whatsapp.js');

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'whatsapp-ciphertext-placeholder-'),
);

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const PEER = '15551234567@s.whatsapp.net';

function ciphertextStub(id: string, params?: string[]) {
  return {
    key: { remoteJid: PEER, id, fromMe: false },
    message: undefined,
    messageStubType: CIPHERTEXT,
    messageStubParameters: params ?? ['Message absent from node'],
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: 'Alice',
  };
}

function missingMessageStub(id: string) {
  // Unavailable / failed-decrypt upsert without an explicit stubType 2 —
  // still must not enter runMessage (no decryptable body).
  return {
    key: { remoteJid: PEER, id, fromMe: false },
    message: undefined,
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: 'Alice',
  };
}

function conversationUpsert(id: string, text: string) {
  return {
    key: { remoteJid: PEER, id, fromMe: false },
    message: { conversation: text },
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: 'Alice',
  };
}

async function connect(authorized: boolean) {
  const connection = createWhatsAppConnection({
    accountId: authorized ? 'bot-ok' : 'bot-deny',
    authDir: path.join(root, authorized ? 'bot-ok' : 'bot-deny'),
  });
  await connection.connect({
    onNewChat: vi.fn(),
    isChatAuthorized: () => authorized,
  });
  const socket = harness.sockets.at(-1)!;
  return { connection, socket };
}

function storedTexts(): string[] {
  return db.storeMessageDirect.mock.calls.map((call) => String(call[4]));
}

describe('WhatsApp CIPHERTEXT / placeholder-resend dedup (UF-1003)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.sockets.length = 0;
    downloadMediaMessage.mockResolvedValue(Buffer.from('media-bytes'));
  });

  test('CIPHERTEXT stub then same-id PDO resend persists real content', async () => {
    const { socket } = await connect(true);
    const id = 'MSG-PLACEHOLDER-1';

    await socket.emit('messages.upsert', {
      type: 'notify',
      messages: [ciphertextStub(id)],
    });
    // Stub has no decryptable body — must not persist anything.
    expect(db.storeMessageDirect).not.toHaveBeenCalled();

    await socket.emit('messages.upsert', {
      type: 'notify',
      messages: [conversationUpsert(id, 'hello after placeholder resend')],
    });

    // Tip FAIL: stub markSeen → DEDUP_DROP on resend (0 stores).
    // Fix PASS: stub skipped → resend persists.
    expect(db.storeMessageDirect).toHaveBeenCalledOnce();
    expect(storedTexts()).toEqual(['hello after placeholder resend']);
  });

  test('CIPHERTEXT decrypt-fail stub then same-id retry persists', async () => {
    const { socket } = await connect(true);
    const id = 'MSG-RETRY-3';

    await socket.emit('messages.upsert', {
      type: 'notify',
      messages: [ciphertextStub(id, ['Bad MAC'])],
    });
    expect(db.storeMessageDirect).not.toHaveBeenCalled();

    await socket.emit('messages.upsert', {
      type: 'notify',
      messages: [conversationUpsert(id, 'hello after decrypt retry')],
    });

    expect(db.storeMessageDirect).toHaveBeenCalledOnce();
    expect(storedTexts()).toEqual(['hello after decrypt retry']);
  });

  test('normal notify with real msg.message still runs', async () => {
    const { socket } = await connect(true);

    await socket.emit('messages.upsert', {
      type: 'notify',
      messages: [conversationUpsert('MSG-LIVE-2', 'plain live message')],
    });

    expect(db.storeMessageDirect).toHaveBeenCalledOnce();
    expect(storedTexts()).toEqual(['plain live message']);
  });

  test('missing-message stub without stubType 2 also skips before dedup', async () => {
    const { socket } = await connect(true);
    const id = 'MSG-UNAVAILABLE-4';

    await socket.emit('messages.upsert', {
      type: 'notify',
      messages: [missingMessageStub(id)],
    });
    expect(db.storeMessageDirect).not.toHaveBeenCalled();

    await socket.emit('messages.upsert', {
      type: 'notify',
      messages: [conversationUpsert(id, 'hello after unavailable stub')],
    });

    expect(db.storeMessageDirect).toHaveBeenCalledOnce();
    expect(storedTexts()).toEqual(['hello after unavailable stub']);
  });

  test('batch: stub + same-id real in one notify — real persists', async () => {
    // Same for-loop order Baileys may emit; stub must not poison dedup
    // before the follow-up in the same upsert batch.
    const { socket } = await connect(true);
    const id = 'MSG-BATCH-5';

    await socket.emit('messages.upsert', {
      type: 'notify',
      messages: [
        ciphertextStub(id),
        conversationUpsert(id, 'hello same-batch after stub'),
      ],
    });

    expect(db.storeMessageDirect).toHaveBeenCalledOnce();
    expect(storedTexts()).toEqual(['hello same-batch after stub']);
  });
});
