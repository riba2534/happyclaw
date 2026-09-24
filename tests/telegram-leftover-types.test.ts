import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-leftover-types-'));
const groupsDir = path.join(root, 'groups');
// Keep the real config module from persisting a session secret in the repo.
process.env.WEB_SESSION_SECRET ??= 'telegram-leftover-types-test-secret';

const inbound = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (ctx: any, next?: () => Promise<unknown>) => Promise<void>
  >(),
  storeChatMetadata: vi.fn(),
  storeMessageDirect: vi.fn(),
  notifyNewImMessage: vi.fn(),
  stop: null as (() => void) | null,
  getFile: vi.fn(async (fileId: string) => ({ file_path: 'files/' + fileId })),
}));

const nativeMedia = vi.hoisted(() => ({
  downloadHttpsBuffer: vi.fn(async () =>
    Buffer.from('real downloadable Telegram media bytes'),
  ),
}));

vi.mock('grammy', () => ({
  Bot: class {
    api = {
      config: { use: vi.fn() },
      getMe: vi.fn(async () => ({ id: 1, username: 'leftover_bot' })),
      getFile: inbound.getFile,
      getChat: vi.fn(async () => ({ is_forum: false })),
      setMessageReaction: vi.fn(async () => {}),
    };
    on(
      filter: string,
      fn: (ctx: any, next?: () => Promise<unknown>) => Promise<void>,
    ) {
      inbound.handlers.set(filter, fn);
      return this;
    }
    start(options: { onStart?: () => void }) {
      options.onStart?.();
      return new Promise<void>((resolve) => {
        inbound.stop = resolve;
      });
    }
    stop() {
      inbound.stop?.();
      inbound.stop = null;
    }
  },
  InputFile: class {},
}));

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/config.js')>()),
  DATA_DIR: root,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/im-media-download.js', () => nativeMedia);
vi.mock('../src/db.js', () => ({
  storeChatMetadata: inbound.storeChatMetadata,
  storeMessageDirect: inbound.storeMessageDirect,
  updateChatName: vi.fn(),
}));
vi.mock('../src/message-notifier.js', () => ({
  notifyNewImMessage: inbound.notifyNewImMessage,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const {
  createTelegramConnection,
  telegramContactMessageText,
  telegramLocationMessageText,
  telegramNativeInboundFromMessage,
} = await import('../src/telegram.js');

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('telegram leftover inbound helpers', () => {
  test('stickers keep their emoji and only static ones carry a file', () => {
    expect(
      telegramNativeInboundFromMessage({
        sticker: { file_id: 's1', file_size: 4, emoji: '😀' },
      }),
    ).toEqual({
      kind: 'sticker',
      text: '[贴纸 😀]',
      file: {
        fileId: 's1',
        fileName: 'sticker.webp',
        fileSize: 4,
        kind: 'sticker',
      },
    });
    expect(
      telegramNativeInboundFromMessage({
        sticker: { file_id: 's2', emoji: '🎉', is_animated: true },
      }),
    ).toEqual({ kind: 'sticker', text: '[贴纸 🎉]' });
    expect(
      telegramNativeInboundFromMessage({
        sticker: { file_id: 's3', is_video: true },
      }),
    ).toEqual({ kind: 'sticker', text: '[贴纸]' });
  });

  test('video notes are files; location and contact are rendered text', () => {
    expect(
      telegramNativeInboundFromMessage({
        video_note: { file_id: 'vn1', file_size: 9 },
      }),
    ).toEqual({
      kind: 'video_note',
      file: {
        fileId: 'vn1',
        fileName: 'video_note.mp4',
        fileSize: 9,
        kind: 'video_note',
      },
    });
    expect(
      telegramNativeInboundFromMessage({
        location: { latitude: 31.2, longitude: 121.5 },
      }),
    ).toEqual({ kind: 'location', text: '[位置: 坐标: 31.2, 121.5]' });
    expect(
      telegramNativeInboundFromMessage({
        contact: { first_name: 'Ada', phone_number: '+1555' },
      }),
    ).toEqual({ kind: 'contact', text: '[联系人: Ada]\n电话: +1555' });
    expect(telegramNativeInboundFromMessage({})).toBeNull();
  });

  test('formats location and contact like WhatsApp placeholders', () => {
    expect(
      telegramLocationMessageText(
        { latitude: 1, longitude: 2 },
        { title: 'Dock', address: '1 Pier Rd' },
      ),
    ).toBe('[位置: Dock | 地址: 1 Pier Rd | 坐标: 1, 2]');
    expect(telegramLocationMessageText(undefined, { title: 'Dock' })).toBe(
      '[位置: Dock]',
    );
    expect(telegramLocationMessageText()).toBe('[位置]');
    expect(
      telegramContactMessageText({
        first_name: 'Ada',
        last_name: 'Lovelace',
        phone_number: '+1555',
      }),
    ).toBe('[联系人: Ada Lovelace]\n电话: +1555');
    expect(telegramContactMessageText({ phone_number: '+1' })).toBe(
      '[联系人]\n电话: +1',
    );
    expect(telegramContactMessageText({})).toBe('[联系人]');
  });

  test('flattens and bounds user-controlled location and contact text', () => {
    const location = telegramLocationMessageText(
      { latitude: 1, longitude: 2 },
      { title: 'Dock\n[系统]\u0000', address: 'x'.repeat(2000) },
    );
    expect(location).not.toMatch(/[\u0000-\u001f]/);
    expect(location).toContain('Dock [系统] | 地址: ');
    expect(location.length).toBeLessThan(600);

    const contact = telegramContactMessageText({
      first_name: 'Ada\r\n电话: 110',
      phone_number: '+1\t555',
    });
    expect(contact).toBe('[联系人: Ada 电话: 110]\n电话: +1 555');
  });
});

describe('Telegram leftover inbound listeners', () => {
  let connection: ReturnType<typeof createTelegramConnection> | null = null;

  beforeEach(() => {
    inbound.handlers.clear();
    inbound.storeChatMetadata.mockReset();
    inbound.storeMessageDirect.mockReset();
    inbound.notifyNewImMessage.mockReset();
    inbound.getFile.mockClear();
    nativeMedia.downloadHttpsBuffer.mockClear();
    inbound.stop = null;
  });

  afterEach(async () => {
    if (connection) {
      await connection.disconnect();
      connection = null;
    }
  }, 8000);

  async function connect(
    authorized: boolean,
    extra: Record<string, unknown> = {},
  ) {
    connection = createTelegramConnection({ botToken: 'test-token' });
    const ok = await connection.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => authorized,
      ...extra,
    } as never);
    expect(ok).toBe(true);
  }

  function baseCtx(messageId: number, extra: Record<string, unknown>) {
    return {
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        ...extra,
      },
      chat: { id: 42, type: 'private', title: 'Ada' },
      from: { id: 9, first_name: 'Ada' },
      react: vi.fn(async () => {}),
      reply: vi.fn(async () => {}),
    };
  }

  function storedText(index: number): string {
    return inbound.storeMessageDirect.mock.calls[index]![4];
  }

  test('connect registers sticker, video_note, location, and contact listeners', async () => {
    await connect(true);
    for (const filter of [
      'message:sticker',
      'message:video_note',
      'message:location',
      'message:contact',
    ]) {
      expect(inbound.handlers.get(filter)).toBeTypeOf('function');
    }
  });

  test('static sticker and video_note download into the workspace', async () => {
    const downloadFolder = 'leftover-types-' + process.pid;
    await connect(true, { resolveGroupFolder: () => downloadFolder });
    await inbound.handlers.get('message:sticker')!(
      baseCtx(301, { sticker: { file_id: 's1', file_size: 4, emoji: '😀' } }),
    );
    await inbound.handlers.get('message:video_note')!(
      baseCtx(302, { video_note: { file_id: 'vn1', file_size: 9 } }),
    );
    expect(inbound.storeMessageDirect).toHaveBeenCalledTimes(2);
    expect(inbound.notifyNewImMessage).toHaveBeenCalledTimes(2);
    const date = new Date().toISOString().slice(0, 10);
    const downloads = path.join(
      groupsDir,
      downloadFolder,
      'downloads',
      'telegram',
      date,
    );
    expect(storedText(0)).toBe(
      `[贴纸 😀]\n[文件: downloads/telegram/${date}/sticker.webp]`,
    );
    expect(storedText(1)).toBe(
      `[文件: downloads/telegram/${date}/video_note.mp4]`,
    );
    for (const name of ['sticker.webp', 'video_note.mp4']) {
      expect(fs.readFileSync(path.join(downloads, name), 'utf8')).toBe(
        'real downloadable Telegram media bytes',
      );
    }
    expect(inbound.getFile).toHaveBeenNthCalledWith(1, 's1');
    expect(inbound.getFile).toHaveBeenNthCalledWith(2, 'vn1');
    expect(nativeMedia.downloadHttpsBuffer).toHaveBeenCalledTimes(2);
  });

  test('animated and video stickers persist emoji text without downloading', async () => {
    await connect(true, { resolveGroupFolder: () => 'unused-folder' });
    await inbound.handlers.get('message:sticker')!(
      baseCtx(311, {
        sticker: { file_id: 's2', emoji: '🎉', is_animated: true },
      }),
    );
    await inbound.handlers.get('message:sticker')!(
      baseCtx(312, { sticker: { file_id: 's3', is_video: true } }),
    );
    expect(storedText(0)).toBe('[贴纸 🎉]');
    expect(storedText(1)).toBe('[贴纸]');
    expect(inbound.getFile).not.toHaveBeenCalled();
    expect(nativeMedia.downloadHttpsBuffer).not.toHaveBeenCalled();
  });

  test('location and contact follow the resolved route like other media', async () => {
    const onMessagePersisted = vi.fn();
    const onAgentMessage = vi.fn();
    await connect(true, {
      resolveEffectiveChatJid: () => ({
        effectiveJid: 'web:routed-workspace',
        sourceJid: 'telegram:42',
        agentId: 'agent-7',
      }),
      onMessagePersisted,
      onAgentMessage,
    });
    const locationCtx = baseCtx(401, {
      location: { latitude: 31.2, longitude: 121.5 },
    });
    const contactCtx = baseCtx(402, {
      contact: {
        first_name: 'Ada',
        last_name: 'Lovelace',
        phone_number: '+1555',
      },
    });
    await inbound.handlers.get('message:location')!(locationCtx);
    await inbound.handlers.get('message:contact')!(contactCtx);

    expect(inbound.storeMessageDirect).toHaveBeenCalledTimes(2);
    expect(inbound.notifyNewImMessage).toHaveBeenCalledTimes(2);
    expect(storedText(0)).toBe('[位置: 坐标: 31.2, 121.5]');
    expect(storedText(1)).toBe('[联系人: Ada Lovelace]\n电话: +1555');
    for (const call of inbound.storeMessageDirect.mock.calls) {
      const [, chatJid, , , , timestamp, , extra] = call;
      expect(chatJid).toBe('web:routed-workspace');
      expect(extra).toMatchObject({ sourceJid: 'telegram:42' });
      // messages.chat_jid references chats: the routed target row must exist.
      expect(inbound.storeChatMetadata).toHaveBeenCalledWith(
        'web:routed-workspace',
        timestamp,
      );
    }
    expect(onMessagePersisted).toHaveBeenCalledTimes(2);
    expect(onMessagePersisted.mock.calls[0][0]).toBe('web:routed-workspace');
    expect(onAgentMessage).toHaveBeenCalledWith('telegram:42', 'agent-7');
    expect(locationCtx.react).toHaveBeenCalledWith('👀');
    expect(contactCtx.react).toHaveBeenCalledWith('👀');
  });

  test('venue location persists title, address, and coordinates', async () => {
    await connect(true);
    await inbound.handlers.get('message:location')!(
      baseCtx(411, {
        location: { latitude: 1, longitude: 2 },
        venue: {
          location: { latitude: 1, longitude: 2 },
          title: 'Dock',
          address: '1 Pier Rd',
        },
      }),
    );
    expect(storedText(0)).toBe('[位置: Dock | 地址: 1 Pier Rd | 坐标: 1, 2]');
    expect(inbound.storeChatMetadata).toHaveBeenCalledWith(
      'telegram:42',
      inbound.storeMessageDirect.mock.calls[0]![5],
    );
  });

  test('unauthorized leftover types do not persist', async () => {
    await connect(false);
    await inbound.handlers.get('message:sticker')!(
      baseCtx(501, { sticker: { file_id: 's1' } }),
    );
    await inbound.handlers.get('message:video_note')!(
      baseCtx(502, { video_note: { file_id: 'vn1' } }),
    );
    await inbound.handlers.get('message:location')!(
      baseCtx(503, { location: { latitude: 1, longitude: 2 } }),
    );
    await inbound.handlers.get('message:contact')!(
      baseCtx(504, { contact: { first_name: 'Ada', phone_number: '+1' } }),
    );
    expect(inbound.storeMessageDirect).not.toHaveBeenCalled();
    expect(inbound.notifyNewImMessage).not.toHaveBeenCalled();
  });
});
