import { beforeEach, describe, expect, test, vi } from 'vitest';

const sdkMock = vi.hoisted(() => {
  type Listener = (...args: any[]) => void;
  class MockWSClient {
    static instances: MockWSClient[] = [];
    readonly listeners = new Map<string, Listener[]>();
    readonly options: Record<string, unknown>;
    connect = vi.fn(() => this);
    disconnect = vi.fn();
    sendMessage = vi.fn(async () => ({ errcode: 0 }));
    replyStream = vi.fn(async () => ({ errcode: 0 }));
    downloadFile = vi.fn();

    constructor(options: Record<string, unknown>) {
      this.options = options;
      MockWSClient.instances.push(this);
    }

    on(event: string, listener: Listener): this {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    emit(event: string, ...args: any[]): void {
      for (const listener of this.listeners.get(event) ?? []) listener(...args);
    }
  }
  return { MockWSClient, req: 0 };
});

const mediaStore = vi.hoisted(() => ({
  saveDownloadedFile: vi.fn(
    async (_folder: string, channel: string, fileName: string) =>
      `downloads/${channel}/${fileName}`,
  ),
}));
const mediaDownload = vi.hoisted(() => vi.fn());

vi.mock('@wecom/aibot-node-sdk', () => ({
  WSClient: sdkMock.MockWSClient,
  generateReqId: (prefix: string) => `${prefix}-${++sdkMock.req}`,
}));

vi.mock('../src/db.js', () => ({
  getMessage: vi.fn(() => null),
  getMessagePayload: vi.fn(() => null),
  sequenceInboundTimestampAfterChatTail: vi.fn(
    (_chatJid: string, proposedTimestamp: string) => proposedTimestamp,
  ),
  storeMessageDirect: vi.fn(),
}));
vi.mock('../src/im-downloader.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/im-downloader.js')>()),
  saveDownloadedFile: mediaStore.saveDownloadedFile,
}));
vi.mock('../src/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

import {
  getMessage,
  getMessagePayload,
  sequenceInboundTimestampAfterChatTail,
  storeMessageDirect,
} from '../src/db.js';
import {
  createWeComConnection,
  type WeComConnectionConfig,
} from '../src/wecom.js';

type MockClient = InstanceType<typeof sdkMock.MockWSClient>;

function mediaFrame(input: {
  reqId: string;
  msgtype: string;
  chattype?: 'single' | 'group';
  userId?: string;
  chatId?: string;
  text?: string;
  voice?: string;
  imageUrl?: string;
  imageAeskey?: string;
  mixedText?: string;
  mixedImageUrl?: string;
  fileUrl?: string;
  videoUrl?: string;
  createTime?: number;
}) {
  const chattype = input.chattype ?? 'single';
  const body: Record<string, unknown> = {
    msgid: input.reqId,
    aibotid: 'bot-1',
    chattype,
    chatid: chattype === 'group' ? (input.chatId ?? 'group-1') : undefined,
    from: { userid: input.userId ?? 'user-1' },
    create_time: input.createTime ?? Math.floor(Date.now() / 1000),
    msgtype: input.msgtype,
  };
  if (input.msgtype === 'text') body.text = { content: input.text ?? 'hello' };
  if (input.msgtype === 'voice') body.voice = { content: input.voice ?? '' };
  if (input.msgtype === 'image') {
    body.image = {
      url: input.imageUrl ?? 'https://example.com/a.jpg',
      aeskey: input.imageAeskey ?? 'k',
    };
  }
  if (input.msgtype === 'mixed') {
    const msgItems: Array<Record<string, unknown>> = [
      { msgtype: 'text', text: { content: input.mixedText ?? 'hello' } },
    ];
    if (input.mixedImageUrl) {
      msgItems.push({
        msgtype: 'image',
        image: { url: input.mixedImageUrl, aeskey: 'mixed-key' },
      });
    }
    body.mixed = {
      msg_item: msgItems,
    };
  }
  if (input.msgtype === 'file') {
    body.file = {
      url: input.fileUrl ?? 'https://example.com/notes.pdf',
      aeskey: 'k',
    };
  }
  if (input.msgtype === 'video') {
    body.video = {
      url: input.videoUrl ?? 'https://example.com/clip.mp4',
      aeskey: 'k',
    };
  }
  return { headers: { req_id: input.reqId }, body } as any;
}

async function connect(
  overrides: Record<string, unknown> = {},
  configOverrides: Partial<WeComConnectionConfig> = {},
): Promise<{
  connection: ReturnType<typeof createWeComConnection>;
  client: MockClient;
  opts: Record<string, any>;
}> {
  const connection = createWeComConnection({
    botId: 'bot-1',
    secret: 'secret-1',
    channelAccountId: 'account-1',
    authTimeoutMs: 1000,
    mediaDownloader: mediaDownload,
    ...configOverrides,
  });
  const opts = {
    onNewChat: vi.fn(),
    isChatAuthorized: vi.fn(() => true),
    resolveEffectiveChatJid: vi.fn((jid: string) => ({
      effectiveJid: jid,
      agentId: null,
    })),
    resolveGroupFolder: vi.fn(() => 'workspace-1'),
    onMessagePersisted: vi.fn(),
    ...overrides,
  };
  const pending = connection.connect(opts);
  const client = sdkMock.MockWSClient.instances.at(-1)!;
  client.emit('authenticated');
  await pending;
  return { connection, client, opts };
}

describe('WeCom inbound media persist/notify', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getMessage).mockReturnValue(null);
    vi.mocked(getMessagePayload).mockReturnValue(null);
    vi.mocked(sequenceInboundTimestampAfterChatTail).mockImplementation(
      (_chatJid, proposedTimestamp) => proposedTimestamp,
    );
    vi.mocked(storeMessageDirect).mockImplementation(() => 'stored');
    mediaStore.saveDownloadedFile.mockImplementation(
      async (_folder, channel, fileName) => `downloads/${channel}/${fileName}`,
    );
    sdkMock.MockWSClient.instances.length = 0;
    sdkMock.req = 0;
  });

  test('authorized C2C voice persists transcript and notifies', async () => {
    const { client } = await connect();
    client.emit(
      'message.voice',
      mediaFrame({ reqId: 'voice-1', msgtype: 'voice', voice: '你好' }),
    );
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalled());
    expect(storeMessageDirect.mock.calls[0][4]).toBe('你好');
  });

  test('authorized C2C mixed persists text items and notifies', async () => {
    const { client } = await connect();
    const imageBuffer = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    mediaDownload.mockResolvedValue({
      buffer: imageBuffer,
      filename: 'mixed.jpg',
    });
    client.emit(
      'message.mixed',
      mediaFrame({
        reqId: 'mixed-1',
        msgtype: 'mixed',
        mixedText: 'hello',
        mixedImageUrl: 'https://example.com/mixed.jpg',
      }),
    );
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalled());
    expect(storeMessageDirect.mock.calls[0][4]).toBe(
      'hello\n[图片: downloads/wecom/mixed.jpg]',
    );
    expect(mediaDownload).toHaveBeenCalledTimes(1);
    expect(JSON.parse(storeMessageDirect.mock.calls[0][7].attachments)).toEqual(
      [
        {
          type: 'image',
          data: imageBuffer.toString('base64'),
          mimeType: 'image/jpeg',
        },
      ],
    );
  });

  test('mixed media enforces the image-count ceiling', async () => {
    const { client } = await connect();
    mediaDownload.mockResolvedValue({
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]),
      filename: 'count.jpg',
    });
    const frame = mediaFrame({ reqId: 'mixed-count', msgtype: 'mixed' });
    frame.body.mixed.msg_item = Array.from({ length: 10 }, (_, index) => ({
      msgtype: 'image',
      image: { url: `https://example.com/${index}.jpg`, aeskey: 'k' },
    }));

    client.emit('message.mixed', frame);
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalled());

    expect(mediaDownload).toHaveBeenCalledTimes(8);
    expect(storeMessageDirect.mock.calls[0][4]).toContain(
      '[其余图片因数量或总大小限制已跳过]',
    );
  });

  test('mixed media bounds aggregate inline base64 while preserving files', async () => {
    const { client } = await connect();
    const largeImage = Buffer.alloc(4 * 1024 * 1024, 1);
    largeImage.set([0xff, 0xd8, 0xff, 0xe0], 0);
    mediaDownload.mockResolvedValue({
      buffer: largeImage,
      filename: 'large.jpg',
    });
    const frame = mediaFrame({ reqId: 'mixed-base64', msgtype: 'mixed' });
    frame.body.mixed.msg_item = Array.from({ length: 3 }, (_, index) => ({
      msgtype: 'image',
      image: { url: `https://example.com/${index}.jpg`, aeskey: 'k' },
    }));

    client.emit('message.mixed', frame);
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalled());

    expect(mediaDownload).toHaveBeenCalledTimes(3);
    expect(mediaStore.saveDownloadedFile).toHaveBeenCalledTimes(3);
    const attachments = JSON.parse(
      storeMessageDirect.mock.calls[0][7].attachments,
    );
    expect(attachments).toHaveLength(1);
    expect(attachments[0].data.length).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  test('authorized C2C image downloads and persists a picture marker', async () => {
    const { client } = await connect();
    mediaDownload.mockResolvedValue({
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]),
      filename: 'a.jpg',
    });
    client.emit(
      'message.image',
      mediaFrame({ reqId: 'image-1', msgtype: 'image' }),
    );
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalled());
    expect(mediaDownload).toHaveBeenCalled();
    expect(storeMessageDirect.mock.calls[0][4]).toBe(
      '[图片: downloads/wecom/a.jpg]',
    );
    expect(storeMessageDirect.mock.calls[0][7].attachments).toBeTruthy();
  });

  test('unauthorized C2C voice does not persist', async () => {
    const { client } = await connect({
      isChatAuthorized: vi.fn(() => false),
    });
    client.emit(
      'message.voice',
      mediaFrame({ reqId: 'voice-deny', msgtype: 'voice', voice: '你好' }),
    );
    await vi.waitFor(() => expect(client.replyStream).toHaveBeenCalled());
    expect(storeMessageDirect).not.toHaveBeenCalled();
  });

  test('authorization rejects image before any download', async () => {
    const { client } = await connect({
      isChatAuthorized: vi.fn(() => false),
    });
    client.emit(
      'message.image',
      mediaFrame({ reqId: 'image-deny', msgtype: 'image' }),
    );
    await vi.waitFor(() => expect(client.replyStream).toHaveBeenCalled());
    expect(mediaDownload).not.toHaveBeenCalled();
    expect(mediaStore.saveDownloadedFile).not.toHaveBeenCalled();
    expect(storeMessageDirect).not.toHaveBeenCalled();
  });

  test('stale media is rejected before admission and download', async () => {
    const isChatAuthorized = vi.fn(() => true);
    const { client } = await connect({
      isChatAuthorized,
      ignoreMessagesBefore: Date.now(),
    });
    client.emit(
      'message.image',
      mediaFrame({
        reqId: 'image-stale',
        msgtype: 'image',
        createTime: Math.floor(Date.now() / 1000) - 60,
      }),
    );
    await Promise.resolve();
    expect(isChatAuthorized).not.toHaveBeenCalled();
    expect(mediaDownload).not.toHaveBeenCalled();
    expect(storeMessageDirect).not.toHaveBeenCalled();
  });

  test('duplicate media callbacks download and persist only once', async () => {
    const { client } = await connect();
    mediaDownload.mockResolvedValue({
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]),
      filename: 'once.jpg',
    });
    const frame = mediaFrame({ reqId: 'image-duplicate', msgtype: 'image' });
    client.emit('message.image', frame);
    client.emit('message.image', frame);
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalled());
    expect(mediaDownload).toHaveBeenCalledTimes(1);
    expect(storeMessageDirect).toHaveBeenCalledTimes(1);
  });

  test('bounds 11 concurrent media messages at 2 active + 8 queued and persists a busy marker', async () => {
    let releaseDownloads!: () => void;
    const downloadGate = new Promise<void>((resolve) => {
      releaseDownloads = resolve;
    });
    let active = 0;
    let maxActive = 0;
    mediaDownload.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await downloadGate;
      active -= 1;
      return {
        buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]),
        filename: 'queued.jpg',
      };
    });
    const { client } = await connect();

    for (let index = 0; index < 11; index += 1) {
      client.emit(
        'message.image',
        mediaFrame({ reqId: `concurrent-${index}`, msgtype: 'image' }),
      );
    }

    await vi.waitFor(() => expect(mediaDownload).toHaveBeenCalledTimes(2));
    await vi.waitFor(() =>
      expect(
        storeMessageDirect.mock.calls.some(
          (call) => call[4] === '[图片（系统繁忙未下载）]',
        ),
      ).toBe(true),
    );
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(mediaDownload).toHaveBeenCalledTimes(2);

    releaseDownloads();
    await vi.waitFor(() => expect(mediaDownload).toHaveBeenCalledTimes(10));
    await vi.waitFor(() =>
      expect(storeMessageDirect).toHaveBeenCalledTimes(11),
    );
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(
      storeMessageDirect.mock.calls.filter(
        (call) => call[4] === '[图片（系统繁忙未下载）]',
      ),
    ).toHaveLength(1);
  });

  test('bounds media concurrency to four across connections', async () => {
    let releaseDownloads!: () => void;
    const downloadGate = new Promise<void>((resolve) => {
      releaseDownloads = resolve;
    });
    let active = 0;
    let maxActive = 0;
    mediaDownload.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await downloadGate;
      active -= 1;
      return {
        buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]),
        filename: 'global.jpg',
      };
    });
    const connected = await Promise.all([connect(), connect(), connect()]);

    connected.forEach(({ client }, connectionIndex) => {
      for (let mediaIndex = 0; mediaIndex < 2; mediaIndex += 1) {
        client.emit(
          'message.image',
          mediaFrame({
            reqId: `global-${connectionIndex}-${mediaIndex}`,
            msgtype: 'image',
          }),
        );
      }
    });

    await vi.waitFor(() => expect(mediaDownload).toHaveBeenCalledTimes(4));
    expect(maxActive).toBeLessThanOrEqual(4);
    releaseDownloads();
    await vi.waitFor(() => expect(mediaDownload).toHaveBeenCalledTimes(6));
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalledTimes(6));
    expect(maxActive).toBeLessThanOrEqual(4);
    await Promise.all(
      connected.map(({ connection }) => connection.disconnect()),
    );
  });

  test('queued media shares the total download deadline', async () => {
    let releaseDownloads!: () => void;
    const downloadGate = new Promise<void>((resolve) => {
      releaseDownloads = resolve;
    });
    mediaDownload.mockImplementation(async () => {
      await downloadGate;
      return {
        buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]),
        filename: 'deadline.jpg',
      };
    });
    const { client } = await connect({}, { mediaDownloadTimeoutMs: 20 });

    for (let index = 0; index < 3; index += 1) {
      client.emit(
        'message.image',
        mediaFrame({ reqId: `deadline-${index}`, msgtype: 'image' }),
      );
    }

    await vi.waitFor(() =>
      expect(
        storeMessageDirect.mock.calls.some(
          (call) => call[4] === '[图片（系统繁忙未下载）]',
        ),
      ).toBe(true),
    );
    expect(mediaDownload).toHaveBeenCalledTimes(2);

    releaseDownloads();
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalledTimes(3));
  });

  test('disconnect aborts two active downloads and removes one local waiter without persistence', async () => {
    let aborted = 0;
    mediaDownload.mockImplementation(
      async (
        _url: string,
        _aesKey: string | undefined,
        _maxBytes: number,
        _timeoutMs: number,
        signal?: AbortSignal,
      ) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener(
            'abort',
            () => {
              aborted += 1;
              reject(new Error('transport aborted'));
            },
            { once: true },
          );
        }),
    );
    const { client, connection } = await connect();
    for (let index = 0; index < 3; index += 1) {
      client.emit(
        'message.image',
        mediaFrame({ reqId: `disconnect-local-${index}`, msgtype: 'image' }),
      );
    }
    await vi.waitFor(() => expect(mediaDownload).toHaveBeenCalledTimes(2));

    await connection.disconnect();
    await vi.waitFor(() => expect(aborted).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mediaDownload).toHaveBeenCalledTimes(2);
    expect(storeMessageDirect).not.toHaveBeenCalled();
    expect(mediaStore.saveDownloadedFile).not.toHaveBeenCalled();
  });

  test('disconnect removes a global waiter and does not leak the global permit', async () => {
    let releaseBlockers!: () => void;
    const blockerGate = new Promise<void>((resolve) => {
      releaseBlockers = resolve;
    });
    const imageResult = {
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]),
      filename: 'global-cancel.jpg',
    };
    const blockerDownload = vi.fn(async () => {
      await blockerGate;
      return imageResult;
    });
    const targetDownload = vi.fn(async () => imageResult);
    const blockers = await Promise.all([
      connect({}, { mediaDownloader: blockerDownload }),
      connect({}, { mediaDownloader: blockerDownload }),
    ]);
    blockers.forEach(({ client }, connectionIndex) => {
      for (let mediaIndex = 0; mediaIndex < 2; mediaIndex += 1) {
        client.emit(
          'message.image',
          mediaFrame({
            reqId: `global-blocker-${connectionIndex}-${mediaIndex}`,
            msgtype: 'image',
          }),
        );
      }
    });
    await vi.waitFor(() => expect(blockerDownload).toHaveBeenCalledTimes(4));

    const target = await connect({}, { mediaDownloader: targetDownload });
    target.client.emit(
      'message.image',
      mediaFrame({ reqId: 'global-cancel-target', msgtype: 'image' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(targetDownload).not.toHaveBeenCalled();
    await target.connection.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(targetDownload).not.toHaveBeenCalled();
    expect(storeMessageDirect).not.toHaveBeenCalled();

    releaseBlockers();
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalledTimes(4));

    const freshDownload = vi.fn(async () => imageResult);
    const fresh = await connect({}, { mediaDownloader: freshDownload });
    fresh.client.emit(
      'message.image',
      mediaFrame({ reqId: 'global-after-cancel', msgtype: 'image' }),
    );
    await vi.waitFor(() => expect(freshDownload).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalledTimes(5));

    await Promise.all([
      ...blockers.map(({ connection }) => connection.disconnect()),
      fresh.connection.disconnect(),
    ]);
  });

  test('durable media replay is detected before download', async () => {
    vi.mocked(getMessage).mockReturnValue({ id: 'stored' } as any);
    const { client } = await connect();
    client.emit(
      'message.image',
      mediaFrame({ reqId: 'image-durable', msgtype: 'image' }),
    );
    await vi.waitFor(() => expect(getMessage).toHaveBeenCalled());
    expect(mediaDownload).not.toHaveBeenCalled();
    expect(storeMessageDirect).not.toHaveBeenCalled();
  });

  test('a retry reuses the staged route and workspace after routing changes', async () => {
    mediaDownload.mockResolvedValue({
      buffer: Buffer.from('pdf'),
      filename: 'route.pdf',
    });
    vi.mocked(storeMessageDirect)
      .mockImplementationOnce(() => {
        throw new Error('database unavailable');
      })
      .mockImplementation(() => 'stored');
    const resolveEffectiveChatJid = vi
      .fn()
      .mockReturnValueOnce({ effectiveJid: 'wecom:c2c:target-a', agentId: 'a' })
      .mockReturnValue({ effectiveJid: 'wecom:c2c:target-b', agentId: 'b' });
    const { client } = await connect({
      resolveEffectiveChatJid,
      resolveGroupFolder: vi.fn((jid: string) =>
        jid.endsWith('target-a') ? 'folder-a' : 'folder-b',
      ),
    });
    const frame = mediaFrame({ reqId: 'route-retry', msgtype: 'file' });

    client.emit('message.file', frame);
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    client.emit('message.file', frame);
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalledTimes(2));

    expect(resolveEffectiveChatJid).toHaveBeenCalledTimes(2);
    expect(mediaDownload).toHaveBeenCalledTimes(1);
    expect(mediaStore.saveDownloadedFile).toHaveBeenCalledTimes(1);
    expect(mediaStore.saveDownloadedFile).toHaveBeenCalledWith(
      'folder-a',
      'wecom',
      'route.pdf',
      Buffer.from('pdf'),
      // The staged route, which picks a session's worktree.
      'wecom:c2c:target-a',
    );
    expect(storeMessageDirect.mock.calls[1][1]).toBe('wecom:c2c:target-a');
    expect(storeMessageDirect.mock.calls[1][4]).toBe(
      '[文件: downloads/wecom/route.pdf]',
    );
  });

  test('expired staged progress is discarded and rebuilt on the current route', async () => {
    let now = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      mediaDownload.mockResolvedValue({
        buffer: Buffer.from('pdf'),
        filename: 'expired.pdf',
      });
      vi.mocked(storeMessageDirect)
        .mockImplementationOnce(() => {
          throw new Error('database unavailable');
        })
        .mockImplementation(() => 'stored');
      const resolveEffectiveChatJid = vi
        .fn()
        .mockReturnValueOnce({
          effectiveJid: 'wecom:c2c:target-a',
          agentId: null,
        })
        .mockReturnValue({
          effectiveJid: 'wecom:c2c:target-b',
          agentId: null,
        });
      const { client } = await connect({
        resolveEffectiveChatJid,
        resolveGroupFolder: vi.fn((jid: string) =>
          jid.endsWith('target-a') ? 'folder-a' : 'folder-b',
        ),
      });
      const retry = mediaFrame({ reqId: 'expired-stage', msgtype: 'file' });

      client.emit('message.file', retry);
      await vi.waitFor(() =>
        expect(storeMessageDirect).toHaveBeenCalledTimes(1),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      now += 11 * 60_000;
      client.emit('message.file', retry);
      await vi.waitFor(() =>
        expect(storeMessageDirect).toHaveBeenCalledTimes(2),
      );

      expect(mediaDownload).toHaveBeenCalledTimes(2);
      expect(mediaStore.saveDownloadedFile.mock.calls[0][0]).toBe('folder-a');
      expect(mediaStore.saveDownloadedFile.mock.calls[1][0]).toBe('folder-b');
      expect(storeMessageDirect.mock.calls[1][1]).toBe('wecom:c2c:target-b');
    } finally {
      nowSpy.mockRestore();
    }
  });

  test('post-persist retry rehydrates payload instead of retaining or redownloading it', async () => {
    mediaDownload.mockResolvedValue({
      buffer: Buffer.from('pdf'),
      filename: 'durable.pdf',
    });
    const onMessagePersisted = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('projection unavailable');
      })
      .mockImplementation(() => undefined);
    vi.mocked(getMessagePayload).mockReturnValue({
      content: '[文件: downloads/wecom/durable.pdf]',
      attachments: null,
    });
    const { client } = await connect({ onMessagePersisted });
    const frame = mediaFrame({ reqId: 'post-persist-retry', msgtype: 'file' });

    client.emit('message.file', frame);
    await vi.waitFor(() => expect(onMessagePersisted).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    client.emit('message.file', frame);
    await vi.waitFor(() => expect(onMessagePersisted).toHaveBeenCalledTimes(2));

    expect(storeMessageDirect).toHaveBeenCalledTimes(1);
    expect(getMessagePayload).toHaveBeenCalledTimes(1);
    expect(mediaDownload).toHaveBeenCalledTimes(1);
    expect(mediaStore.saveDownloadedFile).toHaveBeenCalledTimes(1);
  });

  test('group image is saved to the group workspace like a single-chat image', async () => {
    const resolveGroupFolder = vi.fn(() => 'group-workspace');
    const { client } = await connect({ resolveGroupFolder });
    mediaDownload.mockResolvedValue({
      buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]),
      filename: 'g.jpg',
    });
    client.emit(
      'message.image',
      mediaFrame({ reqId: 'image-g', msgtype: 'image', chattype: 'group' }),
    );
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalled());
    expect(mediaDownload).toHaveBeenCalledTimes(1);
    expect(resolveGroupFolder).toHaveBeenCalledWith('wecom:group:group-1');
    expect(mediaStore.saveDownloadedFile).toHaveBeenCalledWith(
      'group-workspace',
      'wecom',
      'g.jpg',
      expect.any(Buffer),
      'wecom:group:group-1',
    );
    expect(storeMessageDirect.mock.calls[0][1]).toBe('wecom:group:group-1');
    expect(storeMessageDirect.mock.calls[0][4]).toBe(
      '[图片: downloads/wecom/g.jpg]',
    );
    expect(storeMessageDirect.mock.calls[0][7].attachments).toBeTruthy();
  });

  test('group file and video are saved under the single-chat limits', async () => {
    const { client } = await connect();
    mediaDownload.mockResolvedValueOnce({
      buffer: Buffer.from('pdf'),
      filename: 'group-notes.pdf',
    });
    client.emit(
      'message.file',
      mediaFrame({ reqId: 'file-g', msgtype: 'file', chattype: 'group' }),
    );
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalledTimes(1));
    expect(storeMessageDirect.mock.calls[0][4]).toBe(
      '[文件: downloads/wecom/group-notes.pdf]',
    );

    // The image ceiling (20 MiB) applies to groups exactly as to single chats.
    const oversized = Buffer.alloc(20 * 1024 * 1024 + 1, 1);
    oversized.set([0xff, 0xd8, 0xff, 0xe0], 0);
    mediaDownload.mockResolvedValueOnce({
      buffer: oversized,
      filename: 'huge.jpg',
    });
    client.emit(
      'message.image',
      mediaFrame({ reqId: 'image-g-big', msgtype: 'image', chattype: 'group' }),
    );
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalledTimes(2));
    expect(storeMessageDirect.mock.calls[1][4]).toBe('[图片（文件过大）]');
    expect(mediaStore.saveDownloadedFile).toHaveBeenCalledTimes(1);
  });

  test('group voice persists its transcript', async () => {
    const { client } = await connect();
    client.emit(
      'message.voice',
      mediaFrame({
        reqId: 'voice-g',
        msgtype: 'voice',
        chattype: 'group',
        voice: '群语音',
      }),
    );
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalled());
    expect(storeMessageDirect.mock.calls[0][4]).toBe('群语音');
  });

  test('authorized group mixed persists text items and notifies', async () => {
    const { client } = await connect();
    client.emit(
      'message.mixed',
      mediaFrame({
        reqId: 'mixed-g',
        msgtype: 'mixed',
        chattype: 'group',
        mixedText: 'group hello',
      }),
    );
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalled());
    expect(storeMessageDirect.mock.calls[0][4]).toBe('group hello');
  });

  test('authorized C2C file downloads and persists exact file marker', async () => {
    const { client } = await connect();
    mediaDownload.mockResolvedValue({
      buffer: Buffer.from('pdf'),
      filename: 'notes.pdf',
    });
    client.emit(
      'message.file',
      mediaFrame({ reqId: 'file-1', msgtype: 'file' }),
    );
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalled());
    expect(mediaDownload).toHaveBeenCalled();
    expect(mediaStore.saveDownloadedFile).toHaveBeenCalledWith(
      'workspace-1',
      'wecom',
      'notes.pdf',
      Buffer.from('pdf'),
      storeMessageDirect.mock.calls[0][1],
    );
    expect(storeMessageDirect.mock.calls[0][4]).toBe(
      '[文件: downloads/wecom/notes.pdf]',
    );
  });

  test('authorized C2C video downloads and persists exact video marker', async () => {
    const { client } = await connect();
    mediaDownload.mockResolvedValue({
      buffer: Buffer.from('mp4'),
      filename: 'clip.mp4',
    });
    client.emit(
      'message.video',
      mediaFrame({ reqId: 'video-1', msgtype: 'video' }),
    );
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalled());
    expect(mediaDownload).toHaveBeenCalled();
    expect(storeMessageDirect.mock.calls[0][4]).toBe(
      '[视频: downloads/wecom/clip.mp4]',
    );
  });

  test('C2C image CDN-fail persists exact [图片]', async () => {
    const { client } = await connect();
    mediaDownload.mockRejectedValue(new Error('cdn fail'));
    client.emit(
      'message.image',
      mediaFrame({ reqId: 'image-fail', msgtype: 'image' }),
    );
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalled());
    expect(mediaDownload).toHaveBeenCalled();
    expect(storeMessageDirect.mock.calls[0][4]).toBe('[图片]');
  });

  test('C2C file CDN-fail persists exact [文件]', async () => {
    const { client } = await connect();
    mediaDownload.mockRejectedValue(new Error('cdn fail'));
    client.emit(
      'message.file',
      mediaFrame({ reqId: 'file-fail', msgtype: 'file' }),
    );
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalled());
    expect(storeMessageDirect.mock.calls[0][4]).toBe('[文件（下载失败）]');
  });

  test('C2C video CDN-fail persists exact [视频消息]', async () => {
    const { client } = await connect();
    mediaDownload.mockRejectedValue(new Error('cdn fail'));
    client.emit(
      'message.video',
      mediaFrame({ reqId: 'video-fail', msgtype: 'video' }),
    );
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalled());
    expect(storeMessageDirect.mock.calls[0][4]).toBe('[视频（下载失败）]');
  });
  test('existing authorized C2C text path still persists and notifies', async () => {
    const { client } = await connect();
    client.emit(
      'message.text',
      mediaFrame({ reqId: 'text-1', msgtype: 'text', text: 'hello' }),
    );
    await vi.waitFor(() => expect(storeMessageDirect).toHaveBeenCalled());
    expect(storeMessageDirect.mock.calls[0][4]).toBe('hello');
  });
});
