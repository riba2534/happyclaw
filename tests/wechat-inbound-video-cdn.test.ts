import type { Dispatcher } from 'undici';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

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

const { createWeChatConnection, detectWeChatVoiceExtension } =
  await import('../src/wechat.js');

function waitUntilAborted(signal?: AbortSignal | null): Promise<Response> {
  return new Promise((_resolve, reject) => {
    const abort = () =>
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function inboundMsg(item: Record<string, unknown>, id: string) {
  return {
    message_id: id,
    from_user_id: 'wxid_user1',
    create_time_ms: Date.now(),
    context_token: 'tok',
    item_list: [item],
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

async function connectAndDrain(fetchMock: ReturnType<typeof vi.fn>) {
  const close = vi.fn(async () => undefined);
  const connection = createWeChatConnection(
    {
      botToken: 'secret-token',
      ilinkBotId: 'bot-identity@example',
    },
    {
      fetch: fetchMock as typeof fetch,
      createDispatcher: () => ({ close }) as unknown as Dispatcher,
      contextTokenStore: null,
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
    await vi.waitFor(() => expect(db.storeMessageDirect).toHaveBeenCalled());
  } finally {
    await connection.disconnect();
  }
  return connection;
}

describe('WeChat inbound video CDN persist', () => {
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

  test('type-5 video-only persists a workspace file', async () => {
    const fetchMock = fetchOnceThenHang({
      get_updates_buf: 'c1',
      msgs: [
        inboundMsg(
          {
            type: 5,
            video_item: {
              media: {
                encrypt_query_param: 'q-video',
                aes_key: 'k-video',
              },
            },
          },
          'vid-1',
        ),
      ],
    });
    await connectAndDrain(fetchMock);
    expect(crypto.downloadAndDecryptMedia).toHaveBeenCalled();
    expect(downloader.saveDownloadedFile).toHaveBeenCalled();
    expect(String(db.storeMessageDirect.mock.calls[0][4])).toMatch(/视频/);
    expect(String(db.storeMessageDirect.mock.calls[0][4])).toMatch(/ws\//);
    expect(notify.notifyNewImMessage).toHaveBeenCalled();
  });

  test('type 2 image still downloads', async () => {
    const fetchMock = fetchOnceThenHang({
      get_updates_buf: 'c1',
      msgs: [
        inboundMsg(
          {
            type: 2,
            image_item: {
              media: {
                encrypt_query_param: 'q-img',
                aes_key: 'k-img',
              },
            },
          },
          'img-1',
        ),
      ],
    });
    await connectAndDrain(fetchMock);
    expect(crypto.downloadAndDecryptMedia).toHaveBeenCalled();
    expect(downloader.saveDownloadedFile).toHaveBeenCalled();
  });

  test('type 4 PDF still downloads', async () => {
    const fetchMock = fetchOnceThenHang({
      get_updates_buf: 'c1',
      msgs: [
        inboundMsg(
          {
            type: 4,
            file_item: {
              file_name: 'notes.pdf',
              media: {
                encrypt_query_param: 'q-pdf',
                aes_key: 'k-pdf',
              },
            },
          },
          'pdf-1',
        ),
      ],
    });
    await connectAndDrain(fetchMock);
    expect(crypto.downloadAndDecryptMedia).toHaveBeenCalled();
    expect(downloader.saveDownloadedFile).toHaveBeenCalled();
    expect(String(db.storeMessageDirect.mock.calls[0][4])).toMatch(/文件/);
  });

  test('voice filenames follow the decrypted container signature', () => {
    expect(detectWeChatVoiceExtension(Buffer.from('#!SILK_V3bytes'))).toBe(
      '.silk',
    );
    expect(
      detectWeChatVoiceExtension(
        Buffer.concat([Buffer.from([0x02]), Buffer.from('#!SILK_V3bytes')]),
      ),
    ).toBe('.silk');
    expect(detectWeChatVoiceExtension(Buffer.from('#!AMR\nbytes'))).toBe(
      '.amr',
    );
    expect(detectWeChatVoiceExtension(Buffer.from('OggSbytes'))).toBe('.ogg');
    expect(detectWeChatVoiceExtension(Buffer.from([0xff, 0xf1, 0x50]))).toBe(
      '.aac',
    );
    expect(
      detectWeChatVoiceExtension(Buffer.from('unknown-voice-container')),
    ).toBe('.bin');
  });

  test('downloadable voice keeps transcription once and saves the detected encoding', async () => {
    crypto.downloadAndDecryptMedia.mockResolvedValue(
      Buffer.from('#!AMR\nvoice'),
    );
    const fetchMock = fetchOnceThenHang({
      get_updates_buf: 'c1',
      msgs: [
        inboundMsg(
          {
            type: 3,
            voice_item: {
              text: '转写内容',
              media: {
                encrypt_query_param: 'q-voice',
                aes_key: 'k-voice',
              },
            },
          },
          'voice-1',
        ),
      ],
    });
    await connectAndDrain(fetchMock);
    expect(downloader.saveDownloadedFile.mock.calls[0][2]).toMatch(/\.amr$/);
    const content = String(db.storeMessageDirect.mock.calls[0][4]);
    expect(content).toContain('[语音: ws/');
    expect(content).toContain('转写内容');
    expect(content).not.toContain('(voice)');
    expect(content).not.toContain('[语音消息]');
  });

  test('incomplete voice media emits one placeholder without a download attempt', async () => {
    const fetchMock = fetchOnceThenHang({
      get_updates_buf: 'c1',
      msgs: [
        inboundMsg(
          {
            type: 3,
            voice_item: {
              media: { encrypt_query_param: 'missing-aes-key' },
            },
          },
          'voice-incomplete',
        ),
      ],
    });
    await connectAndDrain(fetchMock);
    expect(crypto.downloadAndDecryptMedia).not.toHaveBeenCalled();
    expect(db.storeMessageDirect.mock.calls[0][4]).toBe('(voice)');
  });
});

describe('WeChat inbound image CDN placeholders', () => {
  // Minimal JPEG signature so detectImageMimeType accepts the bytes.
  const jpeg = (size: number) => {
    const buffer = Buffer.alloc(size);
    buffer.set([0xff, 0xd8, 0xff]);
    return buffer;
  };
  const imageItem = {
    type: 2,
    image_item: {
      media: { encrypt_query_param: 'q-img', aes_key: 'k-img' },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    downloader.saveDownloadedFile.mockImplementation(
      async (_folder, _ch, fileName) => `ws/${fileName}`,
    );
  });

  async function persistImageOnly(item: Record<string, unknown> = imageItem) {
    const fetchMock = fetchOnceThenHang({
      get_updates_buf: 'c1',
      msgs: [inboundMsg(item, 'img-only')],
    });
    await connectAndDrain(fetchMock);
    expect(db.storeMessageDirect).toHaveBeenCalledTimes(1);
    const call = db.storeMessageDirect.mock.calls[0];
    return {
      content: String(call[4]),
      attachments: (call[7] as { attachments?: string } | undefined)
        ?.attachments,
    };
  }

  test.each([
    {
      name: 'CDN download throws',
      arrange: () =>
        crypto.downloadAndDecryptMedia.mockRejectedValue(new Error('cdn fail')),
    },
    {
      name: 'CDN returns an empty buffer',
      arrange: () =>
        crypto.downloadAndDecryptMedia.mockResolvedValue(Buffer.alloc(0)),
    },
  ])(
    '$name: image-only message keeps a download-failed placeholder',
    async ({ arrange }) => {
      arrange();
      const { content, attachments } = await persistImageOnly();
      expect(content).toBe('[图片消息（下载失败）]');
      expect(attachments).toBeUndefined();
      expect(notify.notifyNewImMessage).toHaveBeenCalled();
    },
  );

  test.each([
    {
      name: 'the save returns no path',
      arrange: () => downloader.saveDownloadedFile.mockResolvedValue(null),
    },
    {
      name: 'the save throws',
      arrange: () =>
        downloader.saveDownloadedFile.mockRejectedValue(new Error('disk full')),
    },
  ])(
    'too large to inline and $name: image-only message is not dropped',
    async ({ arrange }) => {
      crypto.downloadAndDecryptMedia.mockResolvedValue(
        jpeg(5 * 1024 * 1024 + 1),
      );
      arrange();
      const { content, attachments } = await persistImageOnly();
      expect(content).toBe('[图片消息（图片过大）]');
      expect(attachments).toBeUndefined();
      expect(notify.notifyNewImMessage).toHaveBeenCalled();
    },
  );

  test('a large image saved to the workspace is referenced by path', async () => {
    crypto.downloadAndDecryptMedia.mockResolvedValue(jpeg(5 * 1024 * 1024 + 1));
    const { content, attachments } = await persistImageOnly();
    expect(content).toBe('[图片: ws/wechat_img_img-only.jpg]');
    expect(attachments).toBeUndefined();
  });

  test('a small image is attached inline and referenced by path', async () => {
    crypto.downloadAndDecryptMedia.mockResolvedValue(jpeg(16));
    const { content, attachments } = await persistImageOnly();
    expect(content).toBe('[图片: ws/wechat_img_img-only.jpg]');
    expect(JSON.parse(attachments!)).toEqual([
      expect.objectContaining({ type: 'image', mimeType: 'image/jpeg' }),
    ]);
  });

  test('an image without downloadable media keeps one placeholder', async () => {
    const { content } = await persistImageOnly({
      type: 2,
      image_item: { media: { encrypt_query_param: 'missing-aes-key' } },
    });
    expect(crypto.downloadAndDecryptMedia).not.toHaveBeenCalled();
    expect(content).toBe('(image)');
  });
});
