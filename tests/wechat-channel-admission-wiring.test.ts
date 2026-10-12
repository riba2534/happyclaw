import { beforeEach, describe, expect, test, vi } from 'vitest';
import type { IMChannelConnectOpts } from '../src/im-channel.js';
import type { WeChatConnectOpts } from '../src/wechat.js';

const capture = vi.hoisted(() => ({
  connectOpts: null as WeChatConnectOpts | null,
  sendMessage: vi.fn(),
  sendImage: vi.fn(),
  sendFile: vi.fn(),
}));

vi.mock('../src/wechat.js', () => ({
  createWeChatConnection: () => ({
    async connect(opts: WeChatConnectOpts) {
      capture.connectOpts = opts;
    },
    async disconnect() {},
    sendMessage: capture.sendMessage,
    sendImage: capture.sendImage,
    sendFile: capture.sendFile,
    async sendTyping() {},
    isRunning: () => true,
    isConnected: () => true,
    getUpdatesBuf: () => '',
  }),
}));

const { createWeChatChannel } = await import('../src/im-channel.js');
const { IMConnectionManager } = await import('../src/im-manager.js');

describe('WeChat admission and lifecycle wiring', () => {
  beforeEach(() => {
    capture.connectOpts = null;
    capture.sendMessage.mockReset();
    capture.sendImage.mockReset();
    capture.sendFile.mockReset();
  });

  test('adapter forwards authorization, pairing, and connection state callbacks', async () => {
    const isChatAuthorized = vi.fn(() => true);
    const onPairAttempt = vi.fn(async () => true);
    const onConnectionStateChange = vi.fn();
    const shouldDeferInbound = vi.fn(() => false);
    const opts: IMChannelConnectOpts = {
      onReady: vi.fn(),
      onNewChat: vi.fn(),
      isChatAuthorized,
      onPairAttempt,
      onWeChatConnectionStateChange: onConnectionStateChange,
      shouldDeferInbound,
    };
    const channel = createWeChatChannel({
      botToken: 'token',
      ilinkBotId: 'bot',
    });

    await expect(channel.connect(opts)).resolves.toBe(true);

    expect(capture.connectOpts?.isChatAuthorized).toBe(isChatAuthorized);
    expect(capture.connectOpts?.onPairAttempt).toBe(onPairAttempt);
    expect(capture.connectOpts?.onConnectionStateChange).toBe(
      onConnectionStateChange,
    );
    expect(capture.connectOpts?.shouldDeferInbound).toBe(
      opts.shouldDeferInbound,
    );
  });

  test('adapter never acknowledges outbound work without a live connector', async () => {
    const channel = createWeChatChannel({
      botToken: 'token',
      ilinkBotId: 'bot',
    });

    await expect(channel.sendMessage('peer', 'hello')).rejects.toThrow(
      'not connected',
    );
    await expect(
      channel.sendImage?.('peer', Buffer.from('image'), 'image/png'),
    ).rejects.toThrow('not connected');
    await expect(
      channel.sendFile?.('peer', '/tmp/file', 'file.txt'),
    ).rejects.toThrow('not connected');
  });

  test('adapter forwards the stable durable delivery identity', async () => {
    const channel = createWeChatChannel({
      botToken: 'token',
      ilinkBotId: 'bot',
    });
    await channel.connect({ onNewChat: vi.fn() });
    await channel.sendMessage('peer', 'hello', [], {
      deliveryId: 'turn-1:reply-0',
      chunkIndex: 3,
      physicalOutput: true,
    });
    expect(capture.sendMessage).toHaveBeenCalledWith('peer', 'hello', [], {
      deliveryId: 'turn-1:reply-0',
      chunkIndex: 3,
      physicalOutput: true,
    });
    await channel.sendImage?.(
      'peer',
      Buffer.from('image'),
      'image/png',
      undefined,
      'image.png',
      { deliveryId: 'image-row', chunkIndex: 0, physicalOutput: true },
    );
    expect(capture.sendImage).toHaveBeenCalledWith(
      'peer',
      Buffer.from('image'),
      'image/png',
      undefined,
      'image.png',
      { deliveryId: 'image-row', chunkIndex: 0, physicalOutput: true },
    );
    await channel.sendFile?.('peer', '/tmp/report', 'report.txt', {
      deliveryId: 'file-row',
      chunkIndex: 0,
      physicalOutput: true,
    });
    expect(capture.sendFile).toHaveBeenCalledWith(
      'peer',
      '/tmp/report',
      'report.txt',
      { deliveryId: 'file-row', chunkIndex: 0, physicalOutput: true },
    );
  });

  test('manager account-scopes WeChat admission callbacks and forwards expiry', async () => {
    const manager = new IMConnectionManager();
    const isChatAuthorized = vi.fn(() => true);
    const onPairAttempt = vi.fn(async () => true);
    const onConnectionStateChange = vi.fn();

    await manager.connectUserWeChat(
      'owner',
      { botToken: 'token', ilinkBotId: 'bot' },
      vi.fn(),
      {
        accountId: 'wechat-account',
        scopeIncomingJids: true,
        isChatAuthorized,
        onPairAttempt,
        onConnectionStateChange,
      },
    );

    expect(capture.connectOpts?.isChatAuthorized?.('wechat:contact')).toBe(
      true,
    );
    expect(isChatAuthorized).toHaveBeenCalledWith(
      'wechat:contact#account:wechat-account',
    );
    await capture.connectOpts?.onPairAttempt?.(
      'wechat:contact',
      'Contact',
      'PAIR-CODE',
    );
    expect(onPairAttempt).toHaveBeenCalledWith(
      'wechat:contact#account:wechat-account',
      'Contact',
      'PAIR-CODE',
    );

    capture.connectOpts?.onConnectionStateChange?.({
      status: 'expired',
      error: 'errcode -14',
    });
    expect(onConnectionStateChange).toHaveBeenCalledWith({
      status: 'expired',
      error: 'errcode -14',
    });
    await manager.disconnectAll();
  });

  test('one iLink bot identity cannot be polled by two accounts', async () => {
    const manager = new IMConnectionManager();
    await expect(
      manager.connectUserWeChat(
        'owner-a',
        { botToken: 'token-a', ilinkBotId: 'same-ilink-bot' },
        vi.fn(),
        { accountId: 'wechat-account-a' },
      ),
    ).resolves.toBe(true);

    await expect(
      manager.connectUserWeChat(
        'owner-b',
        { botToken: 'token-b', ilinkBotId: 'same-ilink-bot' },
        vi.fn(),
        { accountId: 'wechat-account-b' },
      ),
    ).rejects.toThrow('already connected by another channel account');

    await manager.disconnectAll();
  });
});
