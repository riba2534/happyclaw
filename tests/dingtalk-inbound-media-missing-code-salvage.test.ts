import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

/**
 * Batch-42: picture / file / legacy-image missing downloadCode/contentUrl
 * used to early-return without persist. handleRobotMessage then resolved →
 * socketCallBackResponse {success:true} → Stream stopped retry → permanent
 * silent drop. Audio already defaults [语音消息] when code absent; these
 * gates must salvage too. Distinct from #738 (!normalized download-null).
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

describe('DingTalk inbound picture/file/image missing-code salvage', () => {
  let connection: ReturnType<typeof createDingTalkConnection> | null = null;

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
      resolveGroupFolder: () => 'workspace-dt-nocode',
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
        conversationId: 'cid-nocode',
        conversationType: '1',
        senderId: 'user-nocode',
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

  test('picture missing downloadCode persists salvage and Stream-ACKs (no silent drop)', async () => {
    const { listener, client } = await connectAuthorized();
    // No https stub needed — gate is before download.
    await firePersistAndAck(
      listener,
      client,
      { msgtype: 'picture', content: {} },
      { msgId: 'pic-nocode-1', streamId: 'stream-pic-nocode-1' },
    );

    expect(inbound.storeMessageDirect).toHaveBeenCalledTimes(1);
    expect(inbound.storeMessageDirect.mock.calls[0][4]).toMatch(/图片/);
    expect(inbound.storeMessageDirect.mock.calls[0][4]).toBe(
      '[图片消息（缺少下载码）]',
    );
    expect(inbound.notifyNewImMessage).toHaveBeenCalled();
    expect(client.socketCallBackResponse).toHaveBeenCalledWith(
      'stream-pic-nocode-1',
      { success: true },
    );
  });

  test('file missing downloadCode persists salvage and Stream-ACKs', async () => {
    const { listener, client } = await connectAuthorized();
    await firePersistAndAck(
      listener,
      client,
      { msgtype: 'file', content: { fileName: 'notes.pdf' } },
      { msgId: 'file-nocode-1', streamId: 'stream-file-nocode-1' },
    );

    expect(inbound.storeMessageDirect.mock.calls[0][4]).toBe(
      '[文件: notes.pdf（缺少下载码）]',
    );
    expect(inbound.notifyNewImMessage).toHaveBeenCalled();
    expect(client.socketCallBackResponse).toHaveBeenCalledWith(
      'stream-file-nocode-1',
      { success: true },
    );
  });

  test('legacy image missing contentUrl persists salvage and Stream-ACKs', async () => {
    const { listener, client } = await connectAuthorized();
    await firePersistAndAck(
      listener,
      client,
      { msgtype: 'image', image: {} },
      { msgId: 'img-nocode-1', streamId: 'stream-img-nocode-1' },
    );

    expect(inbound.storeMessageDirect.mock.calls[0][4]).toBe(
      '[图片消息（缺少 contentUrl）]',
    );
    expect(inbound.notifyNewImMessage).toHaveBeenCalled();
    expect(client.socketCallBackResponse).toHaveBeenCalledWith(
      'stream-img-nocode-1',
      { success: true },
    );
  });

  test('sibling audio missing downloadCode still persists [语音消息]', async () => {
    const { listener, client } = await connectAuthorized();
    await firePersistAndAck(
      listener,
      client,
      { msgtype: 'audio', content: { recognition: '' } },
      { msgId: 'audio-nocode-1', streamId: 'stream-audio-nocode-1' },
    );
    expect(inbound.storeMessageDirect.mock.calls[0][4]).toBe('[语音消息]');
    expect(client.socketCallBackResponse).toHaveBeenCalledWith(
      'stream-audio-nocode-1',
      { success: true },
    );
  });
});
