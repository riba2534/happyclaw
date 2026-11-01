import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const inbound = vi.hoisted(() => ({
  handlers: new Map<
    string,
    (ctx: any, next?: () => Promise<unknown>) => Promise<void>
  >(),
  storeMessageDirect: vi.fn(),
  stop: null as (() => void) | null,
}));

vi.mock('grammy', () => ({
  Bot: class {
    api = {
      config: { use: vi.fn() },
      getMe: vi.fn(async () => ({ id: 1, username: 'media_bot' })),
      getFile: vi.fn(async () => ({})),
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

vi.mock('../src/db.js', () => ({
  storeChatMetadata: vi.fn(),
  storeMessageDirect: inbound.storeMessageDirect,
  updateChatName: vi.fn(),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  createTelegramConnection,
  telegramMediaMessageText,
  telegramNativeFileFromMessage,
} from '../src/telegram.js';

describe('telegramNativeFileFromMessage', () => {
  test('picks video, voice, audio, and animation', () => {
    expect(
      telegramNativeFileFromMessage({
        video: { file_id: 'v1', file_name: 'clip.mp4', file_size: 12 },
      }),
    ).toEqual({
      fileId: 'v1',
      fileName: 'clip.mp4',
      fileSize: 12,
      kind: 'video',
    });
    expect(
      telegramNativeFileFromMessage({
        voice: { file_id: 'vo1', file_size: 3 },
      }),
    ).toEqual({
      fileId: 'vo1',
      fileName: 'voice.ogg',
      fileSize: 3,
      kind: 'voice',
    });
    expect(
      telegramNativeFileFromMessage({
        audio: { file_id: 'a1', file_name: 'song.mp3', file_size: 8 },
      }),
    ).toEqual({
      fileId: 'a1',
      fileName: 'song.mp3',
      fileSize: 8,
      kind: 'audio',
    });
    expect(
      telegramNativeFileFromMessage({
        animation: { file_id: 'g1', file_size: 4 },
      }),
    ).toEqual({
      fileId: 'g1',
      fileName: 'animation.mp4',
      fileSize: 4,
      kind: 'animation',
    });
  });

  test('ignores empty messages and safely appends captions', () => {
    expect(telegramNativeFileFromMessage({})).toBeNull();
    expect(telegramMediaMessageText('[文件下载失败: clip.mp4]', ' note ')).toBe(
      '[文件下载失败: clip.mp4]\nnote',
    );
  });
});

describe('Telegram native media inbound listeners', () => {
  let connection: ReturnType<typeof createTelegramConnection> | null = null;

  beforeEach(() => {
    inbound.handlers.clear();
    inbound.storeMessageDirect.mockReset();
    inbound.stop = null;
  });

  afterEach(async () => {
    if (connection) {
      await connection.disconnect();
      connection = null;
    }
  }, 8000);

  async function connectAuthorized(extra: Record<string, unknown> = {}) {
    connection = createTelegramConnection({ botToken: 'test-token' });
    const opts = {
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
      ...extra,
    };
    const ok = await connection.connect(opts as never);
    expect(ok).toBe(true);
  }

  function videoCtx(messageId: number, caption?: string) {
    return {
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        caption,
        video: { file_id: 'v1', file_name: 'clip.mp4', file_size: 12 },
      },
      chat: { id: 42, type: 'private', title: 'Ada' },
      from: { id: 9, first_name: 'Ada' },
      react: vi.fn(async () => {}),
      reply: vi.fn(async () => {}),
    };
  }

  test('uses the resolved route and one UUID for reaction/persistence projection', async () => {
    const onMessagePersisted = vi.fn();
    const onAgentMessage = vi.fn();
    await connectAuthorized({
      resolveEffectiveChatJid: () => ({
        effectiveJid: 'web:routed-workspace',
        sourceJid: 'telegram:42',
        agentId: 'agent-7',
      }),
      onMessagePersisted,
      onAgentMessage,
    });

    const handler = inbound.handlers.get('message:video');
    expect(handler).toBeTypeOf('function');
    await handler!(videoCtx(101, 'caption'));

    expect(inbound.storeMessageDirect).toHaveBeenCalledOnce();
    const stored = inbound.storeMessageDirect.mock.calls[0];
    expect(stored[1]).toBe('web:routed-workspace');
    expect(stored[4]).toBe('[文件下载失败: 无法确定工作目录]\ncaption');
    expect(stored[7]).toMatchObject({ sourceJid: 'telegram:42' });
    expect(onMessagePersisted).toHaveBeenCalledOnce();
    expect(onMessagePersisted.mock.calls[0][0]).toBe('web:routed-workspace');
    expect(onMessagePersisted.mock.calls[0][1].id).toBe(stored[0]);
    expect(onMessagePersisted.mock.calls[0][2]).toBe('agent-7');
    expect(onAgentMessage).toHaveBeenCalledWith('telegram:42', 'agent-7');
  });

  test('animation/document compatibility overlap persists exactly once', async () => {
    await connectAuthorized();
    const ctx = {
      message: {
        message_id: 202,
        date: Math.floor(Date.now() / 1000),
        animation: { file_id: 'gif-1', file_name: 'loop.mp4' },
        document: { file_id: 'gif-1', file_name: 'loop.mp4' },
      },
      chat: { id: 42, type: 'private', title: 'Ada' },
      from: { id: 9, first_name: 'Ada' },
      react: vi.fn(async () => {}),
      reply: vi.fn(async () => {}),
    };
    await inbound.handlers.get('message:document')!(ctx, () =>
      inbound.handlers.get('message:animation')!(ctx),
    );
    expect(inbound.storeMessageDirect).toHaveBeenCalledOnce();
  });
});
