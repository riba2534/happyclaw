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
  vi.fn(async () => Buffer.from('sticker-bytes')),
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

const {
  createWhatsAppConnection,
  detectMedia,
  extractMessageText,
  isMentioningBot,
  unwrapMessageContent,
} = await import('../src/whatsapp.js');

const root = fs.mkdtempSync(
  path.join(os.tmpdir(), 'whatsapp-inbound-sticker-'),
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

function lottieStickerPayload() {
  return {
    lottieStickerMessage: {
      message: {
        stickerMessage: {
          mimetype: 'image/webp',
          url: 'https://mmg.whatsapp.net/lottie.enc',
          isLottie: true,
          isAnimated: true,
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

describe('WhatsApp inbound sticker / location / contact (live upsert)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.sockets.length = 0;
    downloadMediaMessage.mockResolvedValue(Buffer.from('sticker-bytes'));
  });

  test('authorized stickerMessage persists and notifies via messages.upsert', async () => {
    const { socket } = await connect(true);
    await socket.emit('messages.upsert', {
      type: 'notify',
      messages: [
        upsertMessage('15559876543@s.whatsapp.net', 'sticker-1', {
          stickerMessage: { mimetype: 'image/webp' },
        }),
      ],
    });
    expect(downloadMediaMessage).toHaveBeenCalled();
    expect(db.storeMessageDirect).toHaveBeenCalled();
    expect(String(db.storeMessageDirect.mock.calls[0][4])).toMatch(/贴纸/);
  });

  test('authorized ptvMessage video note downloads and persists', async () => {
    const { socket } = await connect(true);
    await socket.emit('messages.upsert', {
      type: 'notify',
      messages: [
        upsertMessage('15559876543@s.whatsapp.net', 'ptv-1', {
          ptvMessage: { mimetype: 'video/mp4', caption: 'video note' },
        }),
      ],
    });

    expect(downloadMediaMessage).toHaveBeenCalledOnce();
    expect(db.storeMessageDirect).toHaveBeenCalledOnce();
    expect(String(db.storeMessageDirect.mock.calls[0][4])).toMatch(
      /视频.*video note/s,
    );
  });

  test('authorized Event and group invite persist as bounded text', async () => {
    const { socket } = await connect(true);
    await socket.emit('messages.upsert', {
      type: 'notify',
      messages: [
        upsertMessage('15559876543@s.whatsapp.net', 'event-1', {
          eventMessage: { name: '周五\u0000例会' },
        }),
        upsertMessage('15559876543@s.whatsapp.net', 'invite-1', {
          groupInviteMessage: { groupName: '产品群' },
        }),
      ],
    });

    expect(db.storeMessageDirect).toHaveBeenCalledTimes(2);
    expect(db.storeMessageDirect.mock.calls[0][4]).toBe('[活动: 周五 例会]');
    expect(db.storeMessageDirect.mock.calls[1][4]).toBe('[群邀请: 产品群]');
    expect(downloadMediaMessage).not.toHaveBeenCalled();
  });

  test('authorized lottieStickerMessage downloads the unwrapped sticker', async () => {
    const { socket } = await connect(true);
    await socket.emit('messages.upsert', {
      type: 'notify',
      messages: [
        upsertMessage('15559876543@s.whatsapp.net', 'lottie-1', {
          ...lottieStickerPayload(),
        }),
      ],
    });

    expect(downloadMediaMessage).toHaveBeenCalledOnce();
    const passed = downloadMediaMessage.mock.calls[0][0] as {
      message?: { stickerMessage?: unknown; lottieStickerMessage?: unknown };
    };
    expect(passed.message?.stickerMessage).toBeTruthy();
    expect(passed.message?.lottieStickerMessage).toBeUndefined();
    expect(String(db.storeMessageDirect.mock.calls[0][4])).toMatch(/贴纸/);
  });

  test('authorized locationMessage persists as text via messages.upsert', async () => {
    const { socket } = await connect(true);
    await socket.emit('messages.upsert', {
      type: 'notify',
      messages: [
        upsertMessage('15559876543@s.whatsapp.net', 'loc-1', {
          locationMessage: {
            degreesLatitude: 31.2,
            degreesLongitude: 121.5,
            name: '外滩',
            address: '上海市中山东一路',
          },
        }),
      ],
    });
    expect(db.storeMessageDirect.mock.calls[0][4]).toBe(
      '[位置: 外滩 | 地址: 上海市中山东一路 | 坐标: 31.2, 121.5]',
    );
  });

  test('authorized contactMessage persists as text via messages.upsert', async () => {
    const { socket } = await connect(true);
    await socket.emit('messages.upsert', {
      type: 'notify',
      messages: [
        upsertMessage('15559876543@s.whatsapp.net', 'contact-1', {
          contactMessage: {
            displayName: '张三',
            vcard:
              'BEGIN:VCARD\nVERSION:3.0\nFN:张三\nTEL;TYPE=CELL:+86 13800000000\nEMAIL:zhangsan@example.com\nORG:示例公司;研发部\nEND:VCARD',
          },
        }),
      ],
    });
    expect(db.storeMessageDirect.mock.calls[0][4]).toBe(
      '[联系人: 张三]\n电话: +86 13800000000\n邮箱: zhangsan@example.com\n组织: 示例公司 / 研发部',
    );
  });

  test('unauthorized stickerMessage does not persist', async () => {
    const { socket } = await connect(false);
    await socket.emit('messages.upsert', {
      type: 'notify',
      messages: [
        upsertMessage('15559876543@s.whatsapp.net', 'sticker-deny', {
          stickerMessage: { mimetype: 'image/webp' },
        }),
      ],
    });
    expect(db.storeMessageDirect).not.toHaveBeenCalled();
  });

  test.each([
    ['ptv', { ptvMessage: { mimetype: 'video/mp4' } }],
    ['event', { eventMessage: { name: '秘密会议' } }],
    ['lottie', lottieStickerPayload()],
  ])(
    'unauthorized %s payload has no durable or media side effect',
    async (_label, message) => {
      const { socket } = await connect(false);
      await socket.emit('messages.upsert', {
        type: 'notify',
        messages: [
          upsertMessage(
            '15559876543@s.whatsapp.net',
            `deny-${_label}`,
            message,
          ),
        ],
      });

      expect(downloadMediaMessage).not.toHaveBeenCalled();
      expect(db.storeMessageDirect).not.toHaveBeenCalled();
    },
  );

  test('disconnect fences held media and a new connection stores redelivery once', async () => {
    let releaseDownload!: (value: Buffer) => void;
    let admittedSignal: AbortSignal | undefined;
    downloadMediaMessage.mockImplementation(
      async (_message, _type, options) =>
        new Promise<Buffer>((resolve) => {
          admittedSignal = options?.options?.signal ?? undefined;
          releaseDownload = resolve;
        }),
    );

    const first = await connect(true);
    const inbound = upsertMessage(
      '15559876543@s.whatsapp.net',
      'disconnect-sticker-1',
      { stickerMessage: { mimetype: 'image/webp' } },
    );
    const oldAttempt = first.socket.emit('messages.upsert', {
      type: 'notify',
      messages: [inbound],
    });
    await vi.waitFor(() => expect(downloadMediaMessage).toHaveBeenCalledOnce());

    const disconnect = first.connection.disconnect();
    await vi.waitFor(() => expect(admittedSignal?.aborted).toBe(true));
    releaseDownload(Buffer.from('late-sticker'));
    await Promise.all([oldAttempt, disconnect]);
    expect(db.storeMessageDirect).not.toHaveBeenCalled();

    downloadMediaMessage.mockResolvedValue(Buffer.from('fresh-sticker'));
    const second = await connect(true);
    await second.socket.emit('messages.upsert', {
      type: 'notify',
      messages: [inbound],
    });
    await second.socket.emit('messages.upsert', {
      type: 'notify',
      messages: [inbound],
    });
    expect(db.storeMessageDirect).toHaveBeenCalledTimes(1);
    await second.connection.disconnect();
  });

  test('disconnect fences an unwrapped Lottie download before persistence', async () => {
    let releaseDownload!: (value: Buffer) => void;
    let admittedSignal: AbortSignal | undefined;
    downloadMediaMessage.mockImplementation(
      async (_message, _type, options) =>
        new Promise<Buffer>((resolve) => {
          admittedSignal = options?.options?.signal ?? undefined;
          releaseDownload = resolve;
        }),
    );

    const first = await connect(true);
    const inbound = upsertMessage(
      '15559876543@s.whatsapp.net',
      'disconnect-lottie-1',
      lottieStickerPayload(),
    );
    const oldAttempt = first.socket.emit('messages.upsert', {
      type: 'notify',
      messages: [inbound],
    });
    await vi.waitFor(() => expect(downloadMediaMessage).toHaveBeenCalledOnce());
    expect(
      (downloadMediaMessage.mock.calls[0][0] as { message?: proto.IMessage })
        .message?.stickerMessage,
    ).toBeTruthy();

    const disconnect = first.connection.disconnect();
    await vi.waitFor(() => expect(admittedSignal?.aborted).toBe(true));
    releaseDownload(Buffer.from('late-lottie'));
    await Promise.all([oldAttempt, disconnect]);
    expect(db.storeMessageDirect).not.toHaveBeenCalled();

    downloadMediaMessage.mockResolvedValue(Buffer.from('fresh-lottie'));
    const second = await connect(true);
    await second.socket.emit('messages.upsert', {
      type: 'notify',
      messages: [inbound],
    });
    expect(db.storeMessageDirect).toHaveBeenCalledOnce();
    await second.connection.disconnect();
  });

  test('public send waits for a Meta server ACK instead of socket-write success', async () => {
    const { connection, socket } = await connect(true);
    socket.sendMessage.mockResolvedValue({
      key: {
        id: 'outbound-ack-1',
        remoteJid: '15559876543@s.whatsapp.net',
        fromMe: true,
      },
    });
    await socket.emit('connection.update', { connection: 'open' });

    let settled = false;
    const send = connection
      .sendMessage('whatsapp:15559876543@s.whatsapp.net', 'hello')
      .then(() => {
        settled = true;
      });
    await vi.waitFor(() => expect(socket.sendMessage).toHaveBeenCalledOnce());
    expect(settled).toBe(false);

    await socket.emit('messages.update', [
      {
        key: { id: 'outbound-ack-1' },
        update: { status: 2 },
      },
    ]);
    await send;
    expect(settled).toBe(true);
    await connection.disconnect();
  });
});

describe('detectMedia / extractMessageText helpers', () => {
  test('stickerMessage is detected', () => {
    expect(
      detectMedia({
        stickerMessage: { mimetype: 'image/webp' },
      } as proto.IMessage),
    ).toMatchObject({ kind: 'sticker', label: '贴纸' });
  });

  test('ptvMessage is detected as video and preserves its caption', () => {
    const content = {
      ptvMessage: { mimetype: 'video/mp4', caption: 'video note' },
    } as proto.IMessage;
    expect(detectMedia(content)).toMatchObject({
      kind: 'video',
      label: '视频',
      node: { caption: 'video note' },
    });
    expect(extractMessageText(content)).toBe('video note');
  });

  test('Event and invite labels are sanitized and bounded', () => {
    const longName = ` event\u0000name ${'x'.repeat(800)}`;
    const eventText = extractMessageText({
      eventMessage: { name: longName },
    } as proto.IMessage)!;
    expect(eventText.startsWith('[活动: event name ')).toBe(true);
    expect(eventText).not.toContain('\u0000');
    expect(eventText.length).toBeLessThanOrEqual(518);
    expect(
      extractMessageText({
        groupInviteMessage: { groupName: '  ', caption: '研发群' },
      } as proto.IMessage),
    ).toBe('[群邀请: 研发群]');
    expect(extractMessageText({ eventMessage: {} } as proto.IMessage)).toBe(
      '[活动]',
    );
    expect(
      extractMessageText({ groupInviteMessage: {} } as proto.IMessage),
    ).toBe('[群邀请]');
  });

  test.each([
    {
      ptvMessage: {
        contextInfo: { mentionedJid: ['19990001111@s.whatsapp.net'] },
      },
    },
    {
      eventMessage: {
        name: '例会',
        contextInfo: { mentionedJid: ['19990001111@s.whatsapp.net'] },
      },
    },
    {
      groupInviteMessage: {
        groupName: '产品群',
        contextInfo: { mentionedJid: ['19990001111@s.whatsapp.net'] },
      },
    },
    {
      lottieStickerMessage: {
        message: {
          stickerMessage: {
            contextInfo: { mentionedJid: ['19990001111@s.whatsapp.net'] },
          },
        },
      },
    },
  ])('new supported payloads retain group mention policy', (wrapped) => {
    expect(
      isMentioningBot(
        unwrapMessageContent(wrapped as proto.IMessage),
        '19990001111:7@s.whatsapp.net',
      ),
    ).toBe(true);
  });

  test('lottieStickerMessage unwraps to its inner sticker', () => {
    const unwrapped = unwrapMessageContent({
      ...lottieStickerPayload(),
    } as proto.IMessage);
    expect(unwrapped.stickerMessage).toBeTruthy();
    expect(unwrapped.lottieStickerMessage).toBeUndefined();
  });

  test('location and contact extract as text', () => {
    expect(
      extractMessageText({
        locationMessage: {
          degreesLatitude: 31.2,
          degreesLongitude: 121.5,
          name: '外滩',
          address: '上海市中山东一路',
        },
      } as proto.IMessage),
    ).toBe('[位置: 外滩 | 地址: 上海市中山东一路 | 坐标: 31.2, 121.5]');
    expect(
      extractMessageText({
        contactMessage: {
          displayName: '张三',
          vcard:
            'BEGIN:VCARD\nN:Zhang;San;;;\nTEL:+8613800000000\nEMAIL:san@example.com\nORG:Acme;R&D\nEND:VCARD',
        },
      } as proto.IMessage),
    ).toBe(
      '[联系人: 张三]\n电话: +8613800000000\n邮箱: san@example.com\n组织: Acme / R&D',
    );
  });

  test('vCard parser ignores executable/unknown fields and unfolds safe values', () => {
    expect(
      extractMessageText({
        contactMessage: {
          vcard:
            'BEGIN:VCARD\r\nN:Doe;Jane;;;\r\nTEL;TYPE=CELL:+1-555-0100\r\nEMAIL:jane@exam\r\n ple.com\r\nURL:javascript:alert(1)\r\nEND:VCARD',
        },
      } as proto.IMessage),
    ).toBe('[联系人: Jane Doe]\n电话: +1-555-0100\n邮箱: jane@example.com');
  });

  test('contact arrays cap both item count and total durable text length', () => {
    const contacts = Array.from({ length: 100 }, (_, index) => ({
      displayName: `contact-${index}-${'x'.repeat(500)}`,
      vcard: `BEGIN:VCARD\nTEL:+1555${String(index).padStart(4, '0')}\nEMAIL:user-${index}@example.com\nEND:VCARD`,
    }));
    const text = extractMessageText({
      contactsArrayMessage: { contacts },
    } as proto.IMessage)!;
    expect(text.length).toBeLessThanOrEqual(8192);
    expect(text).toContain('contact-0-');
    expect(text).not.toContain('contact-20-');
    expect(text).toMatch(/另有 \d+ 个联系人未显示/);
  });
});
