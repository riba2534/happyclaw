import type { Dispatcher } from 'undici';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  WeChatContextTokenClaimInput,
  WeChatContextTokenRecord,
  WeChatContextTokenStore,
} from '../src/wechat-context-token.js';

const dbCalls = vi.hoisted(() => ({
  storeChatMetadata: vi.fn(),
  storeMessageDirect: vi.fn(),
  updateChatName: vi.fn(),
}));

vi.mock('../src/db.js', () => ({
  ...dbCalls,
  isDatabaseInitialized: () => false,
}));
vi.mock('../src/web.js', () => ({ broadcastNewMessage: vi.fn() }));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createWeChatConnection } = await import('../src/wechat.js');

class SharedStore implements WeChatContextTokenStore {
  record: WeChatContextTokenRecord | undefined;

  list(accountId: string): WeChatContextTokenRecord[] {
    return this.record?.accountId === accountId ? [{ ...this.record }] : [];
  }

  upsert(input: {
    accountId: string;
    userId: string;
    token: string;
    refreshedAtMs: number;
    sourceMessageId?: string | null;
    sourceSequence?: number | null;
  }): WeChatContextTokenRecord {
    this.record = { ...input, sendCount: 0, lastSentAtMs: null };
    return { ...this.record };
  }

  claim(
    input: WeChatContextTokenClaimInput,
  ):
    | { status: 'claimed'; record: WeChatContextTokenRecord }
    | { status: 'missing' | 'changed' | 'expired' | 'quota_exhausted' } {
    const record = this.record;
    if (!record) return { status: 'missing' };
    if (
      record.token !== input.expectedToken ||
      record.refreshedAtMs !== input.expectedRefreshedAtMs ||
      (input.expectedSourceMessageId !== undefined &&
        (record.sourceMessageId ?? null) !== input.expectedSourceMessageId)
    ) {
      return { status: 'changed' };
    }
    const claimed = {
      ...record,
      sendCount: record.sendCount + input.claimCount,
      lastSentAtMs: input.nowMs,
    };
    this.record = claimed;
    return { status: 'claimed', record: { ...claimed } };
  }

  delete(input: {
    accountId: string;
    userId: string;
    expectedToken?: string;
    expectedRefreshedAtMs?: number;
    expectedSourceMessageId?: string | null;
  }): boolean {
    if (
      !this.record ||
      this.record.accountId !== input.accountId ||
      this.record.userId !== input.userId ||
      (input.expectedToken !== undefined &&
        (this.record.token !== input.expectedToken ||
          this.record.refreshedAtMs !== input.expectedRefreshedAtMs ||
          (input.expectedSourceMessageId !== undefined &&
            (this.record.sourceMessageId ?? null) !==
              input.expectedSourceMessageId)))
    ) {
      return false;
    }
    this.record = undefined;
    return true;
  }
}

function waitUntilAborted(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const abort = () =>
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function seedStore(): SharedStore {
  const store = new SharedStore();
  store.record = {
    accountId: 'account',
    userId: 'peer',
    token: 'durable-secret',
    refreshedAtMs: Date.now(),
    sourceMessageId: 'inbound-1',
    sourceSequence: 1,
    sendCount: 0,
    lastSentAtMs: null,
  };
  return store;
}

type LiveSend =
  | { mode: 'file'; fileName: string; contents: string }
  | { mode: 'image'; mimeType: string; contents: string; fileName?: string };

async function liveSend(input: LiveSend): Promise<{
  uploadMedia: ReturnType<typeof vi.fn>;
  sendBodies: unknown[];
  fileSize: number;
  fileSizeCiphertext: number;
}> {
  const store = seedStore();
  const dispatcher = {
    close: vi.fn(async () => undefined),
  } as unknown as Dispatcher;
  const fileSize = input.contents.length;
  const fileSizeCiphertext = fileSize + 16;
  const uploadMedia = vi.fn(async () => ({
    filekey: 'fk',
    downloadEncryptedQueryParam: 'q-enc',
    aeskey: 'aes-key',
    fileSize,
    fileSizeCiphertext,
  }));
  const sendBodies: unknown[] = [];
  const fetchMock = vi.fn(
    async (
      url: string,
      init?: { body?: unknown; signal?: AbortSignal | null },
    ) => {
      if (String(url).includes('sendmessage')) {
        sendBodies.push(JSON.parse(String(init?.body)));
        return Response.json({ ret: 0 });
      }
      return waitUntilAborted(init?.signal);
    },
  );
  const connection = createWeChatConnection(
    {
      botToken: 'bot-token',
      ilinkBotId: 'bot-id',
      logContext: { accountId: 'account' },
    },
    {
      fetch: fetchMock as typeof fetch,
      createDispatcher: () => dispatcher,
      contextTokenStore: store,
      uploadMediaBuffer: uploadMedia,
    },
  );
  await connection.connect({ onNewChat: vi.fn() });
  try {
    if (input.mode === 'file') {
      const filePath = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'happyclaw-wechat-sendfile-')),
        input.fileName,
      );
      fs.writeFileSync(filePath, input.contents);
      try {
        await connection.sendFile('peer', filePath, input.fileName);
      } finally {
        fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
      }
    } else {
      await connection.sendImage(
        'peer',
        Buffer.from(input.contents),
        input.mimeType,
        undefined,
        input.fileName,
      );
    }
  } finally {
    await connection.disconnect();
  }
  return { uploadMedia, sendBodies, fileSize, fileSizeCiphertext };
}

function firstItem(sendBodies: unknown[]): Record<string, unknown> {
  return (
    sendBodies[0] as { msg: { item_list: Array<Record<string, unknown>> } }
  ).msg.item_list[0];
}

describe('WeChat sendFile native video', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dbCalls.storeMessageDirect.mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('clip.mp4 uploads as mediaType 2 and sends type 5 video_item', async () => {
    const { uploadMedia, sendBodies, fileSizeCiphertext } = await liveSend({
      mode: 'file',
      fileName: 'clip.mp4',
      contents: 'video-bytes',
    });
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect(uploadMedia.mock.calls[0][0]).toMatchObject({
      fileName: 'clip.mp4',
      mediaType: 2,
    });
    const item = firstItem(sendBodies);
    expect(item.type).toBe(5);
    expect(item.file_item).toBeUndefined();
    expect(item.video_item).toEqual({
      media: {
        encrypt_query_param: 'q-enc',
        aes_key: 'aes-key',
        encrypt_type: 1,
      },
      video_size: fileSizeCiphertext,
    });
  });

  test('CLIP.MP4 still routes as native video', async () => {
    const { uploadMedia, sendBodies, fileSizeCiphertext } = await liveSend({
      mode: 'file',
      fileName: 'CLIP.MP4',
      contents: 'upper',
    });
    expect(uploadMedia.mock.calls[0][0]).toMatchObject({ mediaType: 2 });
    const item = firstItem(sendBodies);
    expect(item.type).toBe(5);
    expect((item.video_item as { video_size: number }).video_size).toBe(
      fileSizeCiphertext,
    );
  });

  test('non-video stays FILE mediaType 3 + type 4 file_item', async () => {
    const { uploadMedia, sendBodies, fileSize } = await liveSend({
      mode: 'file',
      fileName: 'report.txt',
      contents: 'report',
    });
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect(uploadMedia.mock.calls[0][0]).toMatchObject({
      fileName: 'report.txt',
      mediaType: 3,
    });
    const item = firstItem(sendBodies);
    expect(item.type).toBe(4);
    expect(item.video_item).toBeUndefined();
    expect(item.file_item).toEqual({
      media: {
        encrypt_query_param: 'q-enc',
        aes_key: 'aes-key',
        encrypt_type: 1,
      },
      file_name: 'report.txt',
      len: String(fileSize),
    });
  });

  test('report.pdf stays FILE mediaType 3 + type 4', async () => {
    const { uploadMedia, sendBodies, fileSize } = await liveSend({
      mode: 'file',
      fileName: 'report.pdf',
      contents: '%PDF-1.4',
    });
    expect(uploadMedia.mock.calls[0][0]).toMatchObject({
      fileName: 'report.pdf',
      mediaType: 3,
    });
    const item = firstItem(sendBodies);
    expect(item.type).toBe(4);
    expect(item.video_item).toBeUndefined();
    expect(item.file_item).toMatchObject({
      file_name: 'report.pdf',
      len: String(fileSize),
    });
  });

  test('sendImage JPEG uses mediaType 1 + type 2 mid_size ciphertext', async () => {
    const { uploadMedia, sendBodies, fileSizeCiphertext } = await liveSend({
      mode: 'image',
      mimeType: 'image/jpeg',
      contents: 'jpeg-bytes',
      fileName: 'shot.jpg',
    });
    expect(uploadMedia).toHaveBeenCalledTimes(1);
    expect(uploadMedia.mock.calls[0][0]).toMatchObject({
      fileName: 'shot.jpg',
      mediaType: 1,
    });
    const item = firstItem(sendBodies);
    expect(item.type).toBe(2);
    expect(item.image_item).toEqual({
      media: {
        encrypt_query_param: 'q-enc',
        aes_key: 'aes-key',
        encrypt_type: 1,
      },
      mid_size: fileSizeCiphertext,
    });
  });
});
