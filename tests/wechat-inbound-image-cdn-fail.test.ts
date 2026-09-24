import type { Dispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type {
  WeChatContextTokenClaimInput,
  WeChatContextTokenRecord,
  WeChatContextTokenReleaseInput,
  WeChatContextTokenStore,
} from '../src/wechat-context-token.js';

const crypto = vi.hoisted(() => ({
  downloadAndDecryptMedia: vi.fn(async () => Buffer.from('media-bytes')),
  uploadMediaBuffer: vi.fn(),
}));
const downloader = vi.hoisted(() => ({
  saveDownloadedFile: vi.fn(async (_folder, _ch, fileName) => `ws/${fileName}`),
  MAX_FILE_SIZE: 20 * 1024 * 1024,
}));
const db = vi.hoisted(() => ({
  storeChatMetadata: vi.fn(),
  storeMessageDirect: vi.fn(),
  updateChatName: vi.fn(),
  isDatabaseInitialized: () => false,
}));
const notify = vi.hoisted(() => ({ notifyNewImMessage: vi.fn() }));

vi.mock('../src/wechat-crypto.js', () => crypto);
vi.mock('../src/im-downloader.js', () => downloader);
vi.mock('../src/db.js', () => db);
vi.mock('../src/message-notifier.js', () => notify);
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createWeChatConnection } = await import('../src/wechat.js');

class MemoryTokenStore implements WeChatContextTokenStore {
  record: WeChatContextTokenRecord | undefined;
  upserts: WeChatContextTokenRecord[] = [];

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
    this.record = {
      ...input,
      sourceMessageId: input.sourceMessageId ?? null,
      sourceSequence: input.sourceSequence ?? null,
      sendCount: 0,
      lastSentAtMs: null,
    };
    this.upserts.push({ ...this.record });
    return { ...this.record };
  }

  claim(
    _input: WeChatContextTokenClaimInput,
  ):
    | { status: 'claimed'; record: WeChatContextTokenRecord }
    | { status: 'missing' | 'changed' | 'expired' | 'quota_exhausted' } {
    return { status: 'missing' };
  }

  release(
    _input: WeChatContextTokenReleaseInput,
  ):
    | { status: 'released'; record: WeChatContextTokenRecord }
    | { status: 'missing' | 'changed' } {
    return { status: 'missing' };
  }

  delete(): boolean {
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

function inboundImage(id: string) {
  return {
    message_id: id,
    from_user_id: 'wxid_user1',
    create_time_ms: Date.now(),
    context_token: 'tok-img-salvage',
    item_list: [
      {
        type: 2,
        image_item: {
          media: {
            encrypt_query_param: 'q-img',
            aes_key: 'k-img',
          },
        },
      },
    ],
  };
}

function fetchOnceThenHang(firstBody: unknown): ReturnType<typeof vi.fn> {
  let first = true;
  return vi.fn(async (_url: string, init?: { signal?: AbortSignal | null }) => {
    if (first) {
      first = false;
      return Response.json(firstBody);
    }
    return waitUntilAborted(init?.signal);
  });
}

async function connectImageOnly(
  fetchMock: ReturnType<typeof vi.fn>,
  store: MemoryTokenStore,
  opts?: { expectPersist?: boolean },
) {
  const close = vi.fn(async () => undefined);
  const connection = createWeChatConnection(
    {
      botToken: 'secret-token',
      ilinkBotId: 'bot-identity@example',
      logContext: { accountId: 'acct-img-salvage' },
    },
    {
      fetch: fetchMock as typeof fetch,
      createDispatcher: () => ({ close }) as unknown as Dispatcher,
      contextTokenStore: store,
      random: () => 0.5,
      now: () => Date.now(),
    },
  );
  try {
    await connection.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
      resolveGroupFolder: () => '/tmp/wechat-ws',
      resolveEffectiveChatJid: (jid: string) => ({
        effectiveJid: jid,
        agentId: null,
      }),
    });
    if (opts?.expectPersist !== false) {
      await vi.waitFor(() => expect(db.storeMessageDirect).toHaveBeenCalled(), {
        timeout: 3000,
      });
    } else {
      await new Promise((r) => setTimeout(r, 400));
    }
  } finally {
    await connection.disconnect();
  }
  return connection;
}

describe('WeChat inbound image-only CDN fail salvage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    crypto.downloadAndDecryptMedia.mockResolvedValue(
      Buffer.from('media-bytes'),
    );
    downloader.saveDownloadedFile.mockImplementation(
      async (_folder, _ch, fileName) => `ws/${fileName}`,
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  test('CDN throw on image-only persists [图片], token, and notify (empty gate not hit)', async () => {
    crypto.downloadAndDecryptMedia.mockRejectedValue(new Error('cdn fail'));
    const store = new MemoryTokenStore();
    const fetchMock = fetchOnceThenHang({
      get_updates_buf: 'c-img-fail',
      msgs: [inboundImage('img-cdn-throw')],
    });
    await connectImageOnly(fetchMock, store);

    expect(crypto.downloadAndDecryptMedia).toHaveBeenCalled();
    expect(db.storeMessageDirect).toHaveBeenCalledTimes(1);
    expect(db.storeMessageDirect.mock.calls[0][4]).toBe('[图片]');
    expect(notify.notifyNewImMessage).toHaveBeenCalled();
    expect(store.upserts.length).toBeGreaterThan(0);
    expect(store.record?.token).toBe('tok-img-salvage');
    // No attachment JSON when download failed — salvage is text-only.
    expect(db.storeMessageDirect.mock.calls[0][7]?.attachments).toBeUndefined();
  });

  test('CDN empty/null on image-only persists [图片] sibling salvage', async () => {
    crypto.downloadAndDecryptMedia.mockResolvedValue(Buffer.alloc(0));
    const store = new MemoryTokenStore();
    const fetchMock = fetchOnceThenHang({
      get_updates_buf: 'c-img-empty',
      msgs: [inboundImage('img-cdn-empty')],
    });
    await connectImageOnly(fetchMock, store);

    expect(crypto.downloadAndDecryptMedia).toHaveBeenCalled();
    expect(db.storeMessageDirect.mock.calls[0][4]).toBe('[图片]');
    expect(notify.notifyNewImMessage).toHaveBeenCalled();
    expect(store.record?.token).toBe('tok-img-salvage');
  });

  test('successful image-only still downloads and notifies', async () => {
    // Minimal JPEG SOI so detectImageMimeType accepts it as image/jpeg.
    crypto.downloadAndDecryptMedia.mockResolvedValue(
      Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x00, 0x01]),
    );
    const store = new MemoryTokenStore();
    const fetchMock = fetchOnceThenHang({
      get_updates_buf: 'c-img-ok',
      msgs: [inboundImage('img-cdn-ok')],
    });
    await connectImageOnly(fetchMock, store);

    expect(downloader.saveDownloadedFile).toHaveBeenCalled();
    const content = String(db.storeMessageDirect.mock.calls[0][4]);
    expect(content).toMatch(/\[图片/);
    expect(content).toMatch(/ws\//);
    expect(notify.notifyNewImMessage).toHaveBeenCalled();
  });
});
