import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

// Shrink the per-file cap through the real env knob (read by config.ts at
// import time) so oversized media stays cheap: cap = 1 MiB.
const priorMaxFileSizeMb = vi.hoisted(() => {
  const prior = process.env.MAX_FILE_SIZE_MB;
  process.env.MAX_FILE_SIZE_MB = '1';
  return prior;
});

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-media-cap-'));
const groupsDir = path.join(tmpDir, 'groups');
const GROUP_FOLDER = 'wa-cap-workspace';
const CHUNK = 64 * 1024;

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

// One lazily produced media source per download. 'stream' hands it out as a
// Readable that only pulls a chunk when the consumer asks; 'buffer' drains
// that same source to the end and concatenates it, as Baileys rc13 does.
const media = vi.hoisted(() => ({
  bytes: Buffer.alloc(0),
  pulled: 0,
  streams: [] as import('node:stream').Readable[],
}));

const downloadMediaMessage = vi.hoisted(() => vi.fn());

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

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    DATA_DIR: tmpDir,
    GROUPS_DIR: groupsDir,
    STORE_DIR: path.join(tmpDir, 'db'),
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
const { MAX_FILE_SIZE } = await import('../src/config.js');

afterAll(() => {
  if (priorMaxFileSizeMb === undefined) delete process.env.MAX_FILE_SIZE_MB;
  else process.env.MAX_FILE_SIZE_MB = priorMaxFileSizeMb;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function lazyMediaStream(): Readable {
  let offset = 0;
  const stream = new Readable({
    highWaterMark: 0,
    read() {
      if (offset >= media.bytes.length) {
        this.push(null);
        return;
      }
      const chunk = media.bytes.subarray(offset, offset + CHUNK);
      offset += chunk.length;
      media.pulled += chunk.length;
      this.push(chunk);
    },
  });
  media.streams.push(stream);
  return stream;
}

downloadMediaMessage.mockImplementation(async (_message, type: string) => {
  const stream = lazyMediaStream();
  if (type === 'stream') return stream;
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(chunk as Buffer);
  return Buffer.concat(parts);
});

function documentUpsert(id: string, fileName: string) {
  return {
    type: 'notify',
    messages: [
      {
        key: { remoteJid: '15559876543@s.whatsapp.net', id, fromMe: false },
        message: {
          documentMessage: {
            mimetype: 'application/octet-stream',
            fileName,
            caption: 'see attached',
            // Sender-declared and forgeable: lie low so only the stream cap
            // can protect the host.
            fileLength: 1024,
          },
        },
        pushName: 'Ada',
        messageTimestamp: Math.floor(Date.now() / 1000),
      },
    ],
  };
}

async function connect(withWorkspace: boolean) {
  const connection = createWhatsAppConnection({
    accountId: 'bot-cap',
    authDir: path.join(tmpDir, 'auth'),
  });
  await connection.connect({
    onNewChat: vi.fn(),
    isChatAuthorized: () => true,
    resolveGroupFolder: () => (withWorkspace ? GROUP_FOLDER : undefined),
  });
  return { connection, socket: harness.sockets.at(-1)! };
}

function savedFiles(): string[] {
  const root = path.join(groupsDir, GROUP_FOLDER, 'downloads', 'whatsapp');
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
}

function storedContent(): string {
  expect(db.storeMessageDirect).toHaveBeenCalledOnce();
  return String(db.storeMessageDirect.mock.calls[0][4]);
}

describe('WhatsApp inbound media download is capped while streaming', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.sockets.length = 0;
    media.pulled = 0;
    media.streams.length = 0;
    fs.rmSync(groupsDir, { recursive: true, force: true });
  });

  test('oversized document stops pulling at MAX_FILE_SIZE and reports too large', async () => {
    expect(MAX_FILE_SIZE).toBe(1024 * 1024);
    media.bytes = Buffer.alloc(8 * MAX_FILE_SIZE, 0x61);
    const { connection, socket } = await connect(true);

    await socket.emit('messages.upsert', documentUpsert('big-1', 'big.bin'));

    expect(media.pulled).toBeLessThanOrEqual(MAX_FILE_SIZE + CHUNK);
    expect(media.streams).toHaveLength(1);
    expect(media.streams[0].destroyed).toBe(true);
    expect(media.streams[0].readableEnded).toBe(false);
    expect(storedContent()).toBe(
      '[文档: 文件过大未保存（超过 1MB 上限）\nsee attached]',
    );
    expect(savedFiles()).toEqual([]);
    await connection.disconnect();
  });

  test('oversized document without a workspace is still not fully buffered', async () => {
    media.bytes = Buffer.alloc(8 * MAX_FILE_SIZE, 0x62);
    const { connection, socket } = await connect(false);

    await socket.emit('messages.upsert', documentUpsert('big-2', 'big.bin'));

    expect(media.pulled).toBeLessThanOrEqual(MAX_FILE_SIZE + CHUNK);
    expect(media.streams[0].destroyed).toBe(true);
    expect(media.streams[0].readableEnded).toBe(false);
    expect(storedContent()).toBe('[文档（未关联工作区）\nsee attached]');
    await connection.disconnect();
  });

  test('media within the cap is saved byte-identical', async () => {
    media.bytes = Buffer.alloc(MAX_FILE_SIZE - 12345);
    for (let i = 0; i < media.bytes.length; i++) media.bytes[i] = i % 251;
    const { connection, socket } = await connect(true);

    await socket.emit('messages.upsert', documentUpsert('small-1', 'ok.bin'));

    expect(media.pulled).toBe(media.bytes.length);
    expect(downloadMediaMessage.mock.calls[0][2]).toEqual({
      options: { signal: expect.any(AbortSignal) },
    });
    const files = savedFiles();
    expect(files).toHaveLength(1);
    expect(path.basename(files[0])).toBe('ok.bin');
    expect(fs.readFileSync(files[0]).equals(media.bytes)).toBe(true);
    expect(storedContent()).toMatch(/^\[文档: .*ok\.bin\]\nsee attached$/);
    await connection.disconnect();
  });
});
