import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { proto } from 'baileys';

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

const { createWhatsAppConnection, detectMedia, unwrapMessageContent } =
  await import('../src/whatsapp.js');

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'whatsapp-unwrap-associated-'),
);

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function upsertMessage(
  remoteJid: string,
  id: string,
  message: Record<string, unknown>,
) {
  return {
    key: { remoteJid, id, fromMe: false },
    message,
    pushName: 'Ada',
    messageTimestamp: Math.floor(Date.now() / 1000),
  };
}

function associatedChildImagePayload() {
  return {
    associatedChildMessage: {
      message: {
        imageMessage: {
          mimetype: 'image/jpeg',
          url: 'https://mmg.whatsapp.net/assoc-image.enc',
          caption: 'album child',
        },
      },
    },
  };
}

function associatedChildVideoPayload() {
  return {
    associatedChildMessage: {
      message: {
        videoMessage: {
          mimetype: 'video/mp4',
          url: 'https://mmg.whatsapp.net/assoc-video.enc',
          caption: 'assoc video',
        },
      },
    },
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

describe('WhatsApp unwrap associatedChild / groupStatus (Baileys rc13 parity)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.sockets.length = 0;
    downloadMediaMessage.mockResolvedValue(Buffer.from('media-bytes'));
  });

  test('associatedChildMessage unwraps to inner imageMessage', () => {
    const unwrapped = unwrapMessageContent({
      ...associatedChildImagePayload(),
    } as proto.IMessage);
    expect(unwrapped.imageMessage).toBeTruthy();
    expect(unwrapped.associatedChildMessage).toBeUndefined();
    expect(detectMedia(unwrapped)?.kind).toBe('image');
  });

  test('associatedChildMessage unwraps to inner videoMessage', () => {
    const unwrapped = unwrapMessageContent({
      ...associatedChildVideoPayload(),
    } as proto.IMessage);
    expect(unwrapped.videoMessage).toBeTruthy();
    expect(unwrapped.associatedChildMessage).toBeUndefined();
    expect(detectMedia(unwrapped)?.kind).toBe('video');
  });

  test('groupStatusMessage and V2 unwrap to inner conversation', () => {
    const status = unwrapMessageContent({
      groupStatusMessage: {
        message: { conversation: 'status text' },
      },
    } as proto.IMessage);
    expect(status.conversation).toBe('status text');
    expect(status.groupStatusMessage).toBeUndefined();

    const statusV2 = unwrapMessageContent({
      groupStatusMessageV2: {
        message: { conversation: 'status v2' },
      },
    } as proto.IMessage);
    expect(statusV2.conversation).toBe('status v2');
    expect(statusV2.groupStatusMessageV2).toBeUndefined();
  });

  test('ephemeral control still unwraps (regression)', () => {
    const unwrapped = unwrapMessageContent({
      ephemeralMessage: {
        message: {
          imageMessage: { mimetype: 'image/jpeg' },
        },
      },
    } as proto.IMessage);
    expect(unwrapped.imageMessage).toBeTruthy();
    expect(unwrapped.ephemeralMessage).toBeUndefined();
  });

  test('authorized associatedChild image downloads and persists via upsert', async () => {
    const { socket } = await connect(true);
    await socket.emit('messages.upsert', {
      type: 'notify',
      messages: [
        upsertMessage('15559876543@s.whatsapp.net', 'assoc-img-1', {
          ...associatedChildImagePayload(),
        }),
      ],
    });

    expect(downloadMediaMessage).toHaveBeenCalledOnce();
    const passed = downloadMediaMessage.mock.calls[0][0] as {
      message?: {
        imageMessage?: unknown;
        associatedChildMessage?: unknown;
      };
    };
    expect(passed.message?.imageMessage).toBeTruthy();
    expect(passed.message?.associatedChildMessage).toBeUndefined();
    expect(db.storeMessageDirect).toHaveBeenCalledOnce();
    expect(String(db.storeMessageDirect.mock.calls[0][4])).toMatch(
      /图片.*album child/s,
    );
  });

  test('authorized associatedChild video downloads and persists via upsert', async () => {
    const { socket } = await connect(true);
    await socket.emit('messages.upsert', {
      type: 'notify',
      messages: [
        upsertMessage('15559876543@s.whatsapp.net', 'assoc-vid-1', {
          ...associatedChildVideoPayload(),
        }),
      ],
    });

    expect(downloadMediaMessage).toHaveBeenCalledOnce();
    const passed = downloadMediaMessage.mock.calls[0][0] as {
      message?: {
        videoMessage?: unknown;
        associatedChildMessage?: unknown;
      };
    };
    expect(passed.message?.videoMessage).toBeTruthy();
    expect(passed.message?.associatedChildMessage).toBeUndefined();
    expect(db.storeMessageDirect).toHaveBeenCalledOnce();
    expect(String(db.storeMessageDirect.mock.calls[0][4])).toMatch(
      /视频.*assoc video/s,
    );
  });
});
