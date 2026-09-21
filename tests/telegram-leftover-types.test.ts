import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const inbound = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (ctx: any, next?: () => Promise<unknown>) => Promise<void>
  >(),
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

vi.mock('../src/im-media-download.js', () => nativeMedia);

vi.mock('../src/db.js', () => ({
  storeChatMetadata: vi.fn(),
  storeMessageDirect: inbound.storeMessageDirect,
  updateChatName: vi.fn(),
}));
vi.mock('../src/message-notifier.js', () => ({
  notifyNewImMessage: inbound.notifyNewImMessage,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  createTelegramConnection,
  telegramContactMessageText,
  telegramLocationMessageText,
  telegramNativeFileFromMessage,
} from '../src/telegram.js';

describe('telegram leftover inbound helpers', () => {
  test('picks sticker and video_note without changing empty messages', () => {
    expect(
      telegramNativeFileFromMessage({
        sticker: { file_id: 's1', file_size: 4 },
      }),
    ).toEqual({
      fileId: 's1',
      fileName: 'sticker.webp',
      fileSize: 4,
      kind: 'sticker',
    });
    expect(
      telegramNativeFileFromMessage({
        sticker: { file_id: 's2', is_animated: true },
      }),
    ).toMatchObject({ fileName: 'sticker.tgs', kind: 'sticker' });
    expect(
      telegramNativeFileFromMessage({
        sticker: { file_id: 's3', is_video: true },
      }),
    ).toMatchObject({ fileName: 'sticker.webm', kind: 'sticker' });
    expect(
      telegramNativeFileFromMessage({
        video_note: { file_id: 'vn1', file_size: 9 },
      }),
    ).toEqual({
      fileId: 'vn1',
      fileName: 'video_note.mp4',
      fileSize: 9,
      kind: 'video_note',
    });
    expect(telegramNativeFileFromMessage({})).toBeNull();
  });

  test('formats location and contact placeholders', () => {
    expect(
      telegramLocationMessageText({ latitude: 31.2, longitude: 121.5 }),
    ).toBe('[位置: 31.2, 121.5]');
    expect(
      telegramLocationMessageText(
        { latitude: 1, longitude: 2 },
        { title: 'Dock' },
      ),
    ).toBe('[位置: Dock (1, 2)]');
    expect(
      telegramContactMessageText({
        first_name: 'Ada',
        last_name: 'Lovelace',
        phone_number: '+1555',
      }),
    ).toBe('[联系人: Ada Lovelace] +1555');
    expect(telegramContactMessageText({})).toBe('[联系人]');
  });
});

describe('Telegram leftover inbound listeners', () => {
  let connection: ReturnType<typeof createTelegramConnection> | null = null;

  beforeEach(() => {
    inbound.handlers.clear();
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

  test('authorized sticker and video_note download, persist, and notify', async () => {
    const downloadFolder = 'leftover-types-' + process.pid;
    await connect(true, { resolveGroupFolder: () => downloadFolder });
    await inbound.handlers.get('message:sticker')!(
      baseCtx(301, { sticker: { file_id: 's1', file_size: 4 } }),
    );
    await inbound.handlers.get('message:video_note')!(
      baseCtx(302, { video_note: { file_id: 'vn1', file_size: 9 } }),
    );
    expect(inbound.storeMessageDirect).toHaveBeenCalledTimes(2);
    expect(inbound.notifyNewImMessage).toHaveBeenCalledTimes(2);
    const texts = inbound.storeMessageDirect.mock.calls.map((call) => call[4]);
    const date = new Date().toISOString().slice(0, 10);
    expect(texts[0]).toBe(
      '[文件: downloads/telegram/' + date + '/sticker.webp]',
    );
    expect(texts[1]).toBe(
      '[文件: downloads/telegram/' + date + '/video_note.mp4]',
    );
    expect(
      await readFile(
        'data/groups/' +
          downloadFolder +
          '/downloads/telegram/' +
          date +
          '/sticker.webp',
        'utf8',
      ),
    ).toBe('real downloadable Telegram media bytes');
    expect(
      await readFile(
        'data/groups/' +
          downloadFolder +
          '/downloads/telegram/' +
          date +
          '/video_note.mp4',
        'utf8',
      ),
    ).toBe('real downloadable Telegram media bytes');
    expect(inbound.getFile).toHaveBeenNthCalledWith(1, 's1');
    expect(inbound.getFile).toHaveBeenNthCalledWith(2, 'vn1');
    expect(nativeMedia.downloadHttpsBuffer).toHaveBeenCalledTimes(2);
  });

  test('authorized location and contact persist placeholder text', async () => {
    await connect(true);
    await inbound.handlers.get('message:location')!(
      baseCtx(401, { location: { latitude: 31.2, longitude: 121.5 } }),
    );
    await inbound.handlers.get('message:contact')!(
      baseCtx(402, {
        contact: {
          first_name: 'Ada',
          last_name: 'Lovelace',
          phone_number: '+1555',
        },
      }),
    );
    expect(inbound.storeMessageDirect).toHaveBeenCalledTimes(2);
    expect(inbound.notifyNewImMessage).toHaveBeenCalledTimes(2);
    expect(inbound.storeMessageDirect.mock.calls[0][4]).toBe(
      '[位置: 31.2, 121.5]',
    );
    expect(inbound.storeMessageDirect.mock.calls[1][4]).toBe(
      '[联系人: Ada Lovelace] +1555',
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
