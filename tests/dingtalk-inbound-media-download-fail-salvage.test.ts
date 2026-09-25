import { EventEmitter } from 'node:events';
import https from 'node:https';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * picture / legacy image / file / richText media that could not be fetched
 * (download failed, or the download code/URL was missing) used to
 * early-return without persist. handleRobotMessage then resolved →
 * socketCallBackResponse {success:true} → Stream stopped retry → permanent
 * silent drop. Audio/video already salvage; these paths must too.
 */

const sdk = vi.hoisted(() => {
  class MockDWClient {
    static instances: MockDWClient[] = [];
    listener:
      | ((downstream: {
          headers?: { messageId?: string };
          data: string;
        }) => Promise<void> | void)
      | null = null;
    registerCallbackListener = vi.fn(
      (
        _topic: string,
        listener: (downstream: {
          headers?: { messageId?: string };
          data: string;
        }) => Promise<void> | void,
      ) => {
        this.listener = listener;
        return this;
      },
    );
    socketCallBackResponse = vi.fn();
    connect = vi.fn(async () => undefined);
    disconnect = vi.fn();
    constructor(public options: Record<string, unknown>) {
      MockDWClient.instances.push(this);
    }
  }
  return { MockDWClient };
});

const inbound = vi.hoisted(() => ({
  storeMessageDirect: vi.fn(),
  saveDownloadedFile: vi.fn(),
  notifyNewImMessage: vi.fn(),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('dingtalk-stream', () => ({
  DWClient: sdk.MockDWClient,
  TOPIC_ROBOT: '/v1.0/im/bot/messages/get',
}));

vi.mock('../src/db.js', () => ({
  storeChatMetadata: vi.fn(),
  storeMessageDirect: inbound.storeMessageDirect,
}));

vi.mock('../src/message-notifier.js', () => ({
  notifyNewImMessage: inbound.notifyNewImMessage,
}));

vi.mock('../src/im-downloader.js', () => ({
  MAX_FILE_SIZE: 20 * 1024 * 1024,
  saveDownloadedFile: inbound.saveDownloadedFile,
}));

vi.mock('../src/logger.js', () => ({
  logger: inbound.logger,
}));

import { createDingTalkConnection } from '../src/dingtalk.js';

type MockClient = InstanceType<typeof sdk.MockDWClient>;

/** Force every https.request to fail — download helpers return null. */
function mockAllHttpsFail() {
  return vi.spyOn(https, 'request').mockImplementation(() => {
    const req = new EventEmitter() as EventEmitter & {
      write: () => void;
      end: () => void;
      setTimeout: () => void;
      destroy: () => void;
    };
    req.write = () => {};
    req.setTimeout = () => {};
    req.destroy = () => {};
    req.end = () => {
      req.emit('error', new Error('cdn unavailable'));
    };
    return req as any;
  });
}

function jpegBuffer(size: number): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(size - 4, 1),
  ]);
}

/**
 * Serve robot messageFiles/download per downloadCode: `ok-*` resolves to a
 * small JPEG, `large-*` to one above the 5 MB inline Vision limit, anything
 * else to a CDN URL whose GET fails.
 */
function mockRichTextDownloads() {
  const small = jpegBuffer(600);
  const large = jpegBuffer(5 * 1024 * 1024 + 1024);
  return vi
    .spyOn(https, 'request')
    .mockImplementation((options: any, cb?: any) => {
      const chunks: string[] = [];
      const req = new EventEmitter() as EventEmitter & {
        write: (data: string) => void;
        end: () => void;
        setTimeout: () => void;
        destroy: () => void;
      };
      req.write = (data: string) => {
        chunks.push(String(data));
      };
      req.setTimeout = () => {};
      req.destroy = () => {};
      req.end = () => {
        const reqPath = options instanceof URL ? '' : String(options.path);
        let body: Buffer;
        if (reqPath.includes('/gettoken')) {
          body = Buffer.from(
            JSON.stringify({
              errcode: 0,
              access_token: 'tok',
              expires_in: 7200,
            }),
          );
        } else if (reqPath.includes('/messageFiles/download')) {
          const { downloadCode } = JSON.parse(chunks.join(''));
          body = Buffer.from(
            JSON.stringify({
              downloadUrl: `https://cdn.example/${downloadCode}`,
            }),
          );
        } else if (options instanceof URL) {
          const code = options.pathname.slice(1);
          if (code.startsWith('ok-')) body = small;
          else if (code.startsWith('large-')) body = large;
          else {
            req.emit('error', new Error('cdn unavailable'));
            return;
          }
        } else {
          req.emit('error', new Error(`unexpected request ${reqPath}`));
          return;
        }
        const res = new EventEmitter() as EventEmitter & {
          statusCode: number;
          headers: Record<string, string>;
          destroy: () => void;
        };
        res.statusCode = 200;
        res.headers = {};
        res.destroy = () => {};
        cb?.(res);
        res.emit('data', body);
        res.emit('end');
      };
      return req as any;
    });
}

describe('DingTalk inbound picture/file/image download-null salvage', () => {
  let connection: ReturnType<typeof createDingTalkConnection> | null = null;
  let httpsSpy: ReturnType<typeof mockAllHttpsFail> | null = null;

  beforeEach(() => {
    sdk.MockDWClient.instances = [];
    inbound.storeMessageDirect.mockReset();
    inbound.saveDownloadedFile.mockReset();
    inbound.notifyNewImMessage.mockReset();
    inbound.logger.debug.mockReset();
    inbound.logger.info.mockReset();
    inbound.logger.warn.mockReset();
    inbound.logger.error.mockReset();
  });

  afterEach(async () => {
    httpsSpy?.mockRestore();
    httpsSpy = null;
    if (connection) {
      await connection.disconnect();
      connection = null;
    }
  });

  async function connectAuthorized(): Promise<{
    listener: NonNullable<MockClient['listener']>;
    client: MockClient;
  }> {
    connection = createDingTalkConnection({
      clientId: 'app-key',
      clientSecret: 'app-secret',
    });
    const ok = await connection.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => true,
      resolveGroupFolder: () => 'workspace-dt-salvage',
    });
    expect(ok).toBe(true);
    const client = sdk.MockDWClient.instances.at(-1)!;
    expect(typeof client.listener).toBe('function');
    return { listener: client.listener!, client };
  }

  function downstream(
    msg: Record<string, unknown>,
    opts: { msgId: string; streamId: string },
  ) {
    return {
      headers: { messageId: opts.streamId },
      data: JSON.stringify({
        msgId: opts.msgId,
        conversationId: 'cid-salvage',
        conversationType: '1',
        senderId: 'user-salvage',
        senderNick: 'Ada',
        createAt: Date.now(),
        robotCode: 'robot-1',
        ...msg,
      }),
    };
  }

  async function firePersistAndAck(
    listener: NonNullable<MockClient['listener']>,
    client: MockClient,
    msg: Record<string, unknown>,
    ids: { msgId: string; streamId: string },
  ) {
    const pending = Promise.resolve(listener(downstream(msg, ids)));
    await vi.waitFor(() => {
      expect(inbound.storeMessageDirect).toHaveBeenCalled();
    });
    await pending;
    await vi.waitFor(() => {
      expect(client.socketCallBackResponse).toHaveBeenCalled();
    });
  }

  test('picture download-null persists [图片消息（下载失败）] and Stream-ACKs (no silent drop)', async () => {
    httpsSpy = mockAllHttpsFail();
    const { listener, client } = await connectAuthorized();
    await firePersistAndAck(
      listener,
      client,
      { msgtype: 'picture', content: { downloadCode: 'pic-fail' } },
      { msgId: 'pic-null-1', streamId: 'stream-pic-1' },
    );

    expect(inbound.storeMessageDirect).toHaveBeenCalledTimes(1);
    expect(inbound.storeMessageDirect.mock.calls[0][4]).toBe(
      '[图片消息（下载失败）]',
    );
    expect(inbound.notifyNewImMessage).toHaveBeenCalled();
    expect(client.socketCallBackResponse).toHaveBeenCalledWith('stream-pic-1', {
      success: true,
    });
    // Salvage is text-only — no attachment JSON on download null.
    expect(
      inbound.storeMessageDirect.mock.calls[0][7]?.attachments,
    ).toBeUndefined();
  });

  test('file download-null persists [文件: …（下载失败）] and Stream-ACKs', async () => {
    httpsSpy = mockAllHttpsFail();
    const { listener, client } = await connectAuthorized();
    await firePersistAndAck(
      listener,
      client,
      {
        msgtype: 'file',
        content: { downloadCode: 'file-fail', fileName: 'notes.pdf' },
      },
      { msgId: 'file-null-1', streamId: 'stream-file-1' },
    );

    expect(inbound.storeMessageDirect.mock.calls[0][4]).toBe(
      '[文件: notes.pdf（下载失败）]',
    );
    expect(inbound.notifyNewImMessage).toHaveBeenCalled();
    expect(client.socketCallBackResponse).toHaveBeenCalledWith(
      'stream-file-1',
      { success: true },
    );
  });

  test('legacy image download-null persists [图片消息（下载失败）] and Stream-ACKs', async () => {
    httpsSpy = mockAllHttpsFail();
    const { listener, client } = await connectAuthorized();
    await firePersistAndAck(
      listener,
      client,
      {
        msgtype: 'image',
        image: { contentUrl: 'https://cdn.example/legacy.jpg' },
      },
      { msgId: 'img-null-1', streamId: 'stream-img-1' },
    );

    expect(inbound.storeMessageDirect.mock.calls[0][4]).toBe(
      '[图片消息（下载失败）]',
    );
    expect(inbound.notifyNewImMessage).toHaveBeenCalled();
    expect(client.socketCallBackResponse).toHaveBeenCalledWith('stream-img-1', {
      success: true,
    });
  });

  test('sibling audio download-null still persists [语音消息（下载失败）]', async () => {
    httpsSpy = mockAllHttpsFail();
    const { listener, client } = await connectAuthorized();
    await firePersistAndAck(
      listener,
      client,
      {
        msgtype: 'audio',
        content: { downloadCode: 'audio-fail', recognition: '' },
      },
      { msgId: 'audio-null-1', streamId: 'stream-audio-1' },
    );
    expect(inbound.storeMessageDirect.mock.calls[0][4]).toBe(
      '[语音消息（下载失败）]',
    );
    expect(client.socketCallBackResponse).toHaveBeenCalledWith(
      'stream-audio-1',
      { success: true },
    );
  });
  test.each([
    [
      'picture without downloadCode',
      { msgtype: 'picture', content: {} },
      '[图片消息（下载失败）]',
    ],
    [
      'file without downloadCode',
      { msgtype: 'file', content: { fileName: 'notes.pdf' } },
      '[文件: notes.pdf（下载失败）]',
    ],
    [
      'legacy image without contentUrl',
      { msgtype: 'image', image: {} },
      '[图片消息（下载失败）]',
    ],
  ])(
    '%s persists a salvage label and Stream-ACKs',
    async (_label, msg, label) => {
      // Keep the test off the real network (the inbound path still issues
      // unrelated provider calls); no media download may be attempted.
      httpsSpy = mockAllHttpsFail();
      const { listener, client } = await connectAuthorized();
      await firePersistAndAck(listener, client, msg, {
        msgId: `nocode-${msg.msgtype}`,
        streamId: `stream-nocode-${msg.msgtype}`,
      });

      expect(inbound.storeMessageDirect).toHaveBeenCalledTimes(1);
      expect(inbound.storeMessageDirect.mock.calls[0][4]).toBe(label);
      const downloads = httpsSpy.mock.calls.filter(
        ([options]) =>
          options instanceof URL ||
          String((options as { path?: string }).path).includes(
            '/messageFiles/download',
          ),
      );
      expect(downloads).toEqual([]);
      expect(inbound.notifyNewImMessage).toHaveBeenCalled();
      expect(client.socketCallBackResponse).toHaveBeenCalledWith(
        `stream-nocode-${msg.msgtype}`,
        { success: true },
      );
    },
  );

  describe('richText pictures', () => {
    beforeEach(() => {
      inbound.saveDownloadedFile.mockImplementation(
        async (_folder: string, channel: string, fileName: string) =>
          `files/${channel}/${fileName}`,
      );
    });

    function richText(...entries: Array<Record<string, unknown>>) {
      return { msgtype: 'richText', content: { richText: entries } };
    }

    test('an oversized saved image keeps its path and is not a failure', async () => {
      httpsSpy = mockRichTextDownloads();
      const { listener, client } = await connectAuthorized();
      await firePersistAndAck(
        listener,
        client,
        richText({ type: 'picture', downloadCode: 'large-1' }),
        { msgId: 'rich-large-1', streamId: 'stream-rich-large-1' },
      );

      const [, , , , content, , , extra] =
        inbound.storeMessageDirect.mock.calls[0];
      expect(content).toMatch(/^\[图片: files\/dingtalk\/img_\d+\.jpeg\]$/);
      expect(extra.attachments).toBeUndefined();
    });

    test('every picture failing leaves a count marker', async () => {
      httpsSpy = mockRichTextDownloads();
      const { listener, client } = await connectAuthorized();
      await firePersistAndAck(
        listener,
        client,
        richText(
          { type: 'picture', downloadCode: 'fail-1' },
          { type: 'picture' },
        ),
        { msgId: 'rich-all-fail-1', streamId: 'stream-rich-all-fail-1' },
      );

      expect(inbound.storeMessageDirect.mock.calls[0][4]).toBe(
        '[图片（2 张下载失败）]',
      );
      expect(
        inbound.storeMessageDirect.mock.calls[0][7].attachments,
      ).toBeUndefined();
    });

    test('text with a failed picture keeps the text and marks the failure', async () => {
      httpsSpy = mockRichTextDownloads();
      const { listener, client } = await connectAuthorized();
      await firePersistAndAck(
        listener,
        client,
        richText(
          { text: '看看这张图' },
          { type: 'picture', downloadCode: 'fail-1' },
        ),
        { msgId: 'rich-text-fail-1', streamId: 'stream-rich-text-fail-1' },
      );

      expect(inbound.storeMessageDirect.mock.calls[0][4]).toBe(
        '[图片（1 张下载失败）]\n看看这张图',
      );
    });

    test('mixed pictures label each saved image and count only failures', async () => {
      httpsSpy = mockRichTextDownloads();
      const { listener, client } = await connectAuthorized();
      await firePersistAndAck(
        listener,
        client,
        richText(
          { text: '两张图' },
          { type: 'picture', downloadCode: 'ok-1' },
          { type: 'picture', downloadCode: 'large-1' },
          { type: 'picture', downloadCode: 'fail-1' },
        ),
        { msgId: 'rich-mixed-1', streamId: 'stream-rich-mixed-1' },
      );

      const [, , , , content, , , extra] =
        inbound.storeMessageDirect.mock.calls[0];
      const lines = String(content).split('\n');
      expect(lines).toHaveLength(4);
      expect(lines[0]).toMatch(/^\[图片: files\/dingtalk\/img_\d+\.jpeg\]$/);
      expect(lines[1]).toMatch(/^\[图片: files\/dingtalk\/img_\d+\.jpeg\]$/);
      expect(lines.slice(2)).toEqual(['[图片（1 张下载失败）]', '两张图']);
      expect(JSON.parse(extra.attachments)).toHaveLength(1);
    });
  });
});
