import { EventEmitter } from 'node:events';
import https from 'node:https';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const inbound = vi.hoisted(() => ({
  listener: null as null | ((downstream: { data: string }) => Promise<void>),
  storeMessageDirect: vi.fn(),
  saveDownloadedFile: vi.fn(),
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('dingtalk-stream', () => ({
  DWClient: class {
    registerCallbackListener(
      _topic: string,
      fn: (downstream: { data: string }) => Promise<void>,
    ) {
      inbound.listener = fn;
    }
    async connect() {}
    disconnect() {}
    socketCallBackResponse() {}
  },
  TOPIC_ROBOT: 'dingtalk::robot',
}));

vi.mock('../src/db.js', () => ({
  storeChatMetadata: vi.fn(),
  storeMessageDirect: inbound.storeMessageDirect,
}));

vi.mock('../src/im-downloader.js', () => ({
  MAX_FILE_SIZE: 20 * 1024 * 1024,
  saveDownloadedFile: inbound.saveDownloadedFile,
}));

vi.mock('../src/logger.js', () => ({
  logger: inbound.logger,
}));

import { createDingTalkConnection } from '../src/dingtalk.js';

function jpegBuffer(): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(600, 1),
  ]);
}

function mockDingTalkHttpsDownloads(downloadBody = jpegBuffer()) {
  return vi
    .spyOn(https, 'request')
    .mockImplementation((options: any, cb?: any) => {
      const path =
        typeof options === 'object' && options
          ? String(options.path || '')
          : '';
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
        let body: Buffer;
        if (path.includes('/gettoken')) {
          body = Buffer.from(
            JSON.stringify({
              errcode: 0,
              access_token: 'tok',
              expires_in: 7200,
            }),
          );
        } else if (path.includes('/messageFiles/download')) {
          body = Buffer.from(
            JSON.stringify({ downloadUrl: 'https://cdn.example/blob' }),
          );
        } else {
          body = downloadBody;
        }
        const res = new EventEmitter() as EventEmitter & {
          statusCode: number;
          headers: Record<string, string>;
        };
        res.statusCode = 200;
        res.headers = {};
        cb?.(res);
        res.emit('data', body);
        res.emit('end');
      };
      return req as any;
    });
}

function mockDingTalkHttpsCdnFail() {
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

describe('DingTalk C2C inbound audio/video', () => {
  let connection: ReturnType<typeof createDingTalkConnection> | null = null;
  let httpsSpy: ReturnType<typeof mockDingTalkHttpsDownloads> | null = null;

  beforeEach(() => {
    inbound.listener = null;
    inbound.storeMessageDirect.mockReset();
    inbound.saveDownloadedFile.mockReset();
    inbound.saveDownloadedFile.mockImplementation(
      async (_folder, channel, fileName) => `files/${channel}/${fileName}`,
    );
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

  async function connect(authorized: boolean, groupFolder?: string) {
    connection = createDingTalkConnection({
      clientId: 'app-key',
      clientSecret: 'app-secret',
    });
    const ok = await connection.connect({
      onNewChat: vi.fn(),
      isChatAuthorized: () => authorized,
      resolveGroupFolder: groupFolder ? () => groupFolder : undefined,
    });
    expect(ok).toBe(true);
    expect(typeof inbound.listener).toBe('function');
    return inbound.listener!;
  }

  function downstream(msg: Record<string, unknown>, msgId: string) {
    return {
      data: JSON.stringify({
        msgId,
        conversationId: 'cid-1',
        conversationType: '1',
        senderId: 'user-1',
        senderNick: 'Ada',
        createAt: Date.now(),
        robotCode: 'robot-1',
        ...msg,
      }),
    };
  }

  async function fireAndWait(
    listener: (d: { data: string }) => Promise<void>,
    msg: Record<string, unknown>,
    msgId: string,
  ) {
    const pending = listener(downstream(msg, msgId));
    await vi.waitFor(() => {
      expect(inbound.storeMessageDirect).toHaveBeenCalled();
    });
    await pending;
  }

  test('paired C2C audio persists recognition and notifies', async () => {
    const rawAudio = Buffer.concat([Buffer.from('#!AMR\n'), Buffer.alloc(13)]);
    httpsSpy = mockDingTalkHttpsDownloads(rawAudio);
    const listener = await connect(true, 'workspace-1');
    await fireAndWait(
      listener,
      {
        msgtype: 'audio',
        content: {
          duration: 2000,
          downloadCode: 'audio-code',
          recognition: '你好',
        },
      },
      'audio-1',
    );
    expect(inbound.saveDownloadedFile).toHaveBeenCalledWith(
      'workspace-1',
      'dingtalk',
      expect.stringMatching(/^audio_\d+\.amr$/),
      rawAudio,
      // Saved under the route the message is stored under.
      inbound.storeMessageDirect.mock.calls[0][1],
    );
    expect(inbound.storeMessageDirect.mock.calls[0][4]).toMatch(
      /^你好\n\n\[语音: audio\.amr → files\/dingtalk\/audio_\d+\.amr\]$/,
    );
  });

  test('paired C2C audio without recognition persists [语音消息]', async () => {
    const rawAudio = Buffer.concat([Buffer.from('#!AMR\n'), Buffer.alloc(13)]);
    httpsSpy = mockDingTalkHttpsDownloads(rawAudio);
    const listener = await connect(true, 'workspace-1');
    await fireAndWait(
      listener,
      {
        msgtype: 'audio',
        content: {
          duration: 2000,
          downloadCode: 'audio-code',
          recognition: '',
        },
      },
      'audio-empty',
    );
    expect(inbound.storeMessageDirect.mock.calls[0][4]).toMatch(
      /^\[语音: audio\.amr → files\/dingtalk\/audio_\d+\.amr\]$/,
    );
  });

  test('paired C2C video persists [视频消息] when CDN GET fails', async () => {
    httpsSpy = mockDingTalkHttpsCdnFail();
    const listener = await connect(true);
    await fireAndWait(
      listener,
      {
        msgtype: 'video',
        content: {
          duration: 4000,
          downloadCode: 'video-code',
          videoType: 'mp4',
        },
      },
      'video-1',
    );
    expect(inbound.storeMessageDirect.mock.calls[0][4]).toBe('[视频消息]');
  });

  test('paired C2C picture still persists', async () => {
    httpsSpy = mockDingTalkHttpsDownloads();
    const listener = await connect(true);
    await fireAndWait(
      listener,
      {
        msgtype: 'picture',
        content: { downloadCode: 'pic-code' },
      },
      'pic-1',
    );
    expect(inbound.storeMessageDirect).toHaveBeenCalled();
  });

  test('paired C2C file still persists', async () => {
    httpsSpy = mockDingTalkHttpsDownloads();
    const listener = await connect(true);
    await fireAndWait(
      listener,
      {
        msgtype: 'file',
        content: { downloadCode: 'file-code', fileName: 'notes.pdf' },
      },
      'file-1',
    );
    expect(inbound.storeMessageDirect.mock.calls[0][4]).toMatch(/文件|notes/);
  });

  test('unauthorized C2C audio does not persist', async () => {
    httpsSpy = vi.spyOn(https, 'request');
    const listener = await connect(false);
    await listener(
      downstream(
        {
          msgtype: 'audio',
          content: { recognition: '你好', downloadCode: 'x' },
        },
        'audio-unauth',
      ),
    );
    await vi.waitFor(() => {
      expect(inbound.logger.debug).toHaveBeenCalledWith(
        expect.objectContaining({ jid: expect.any(String) }),
        'DingTalk chat not authorized',
      );
    });
    expect(inbound.storeMessageDirect).not.toHaveBeenCalled();
    expect(httpsSpy).not.toHaveBeenCalled();
    expect(inbound.saveDownloadedFile).not.toHaveBeenCalled();
  });
});
