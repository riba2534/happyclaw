import { EventEmitter } from 'node:events';
import https from 'node:https';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * Batch-27: picture / legacy image / file download-null used to early-return
 * without persist. handleRobotMessage then resolved → socketCallBackResponse
 * {success:true} → Stream stopped retry → permanent silent drop.
 * Audio/video already salvage; these paths must too.
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
});
