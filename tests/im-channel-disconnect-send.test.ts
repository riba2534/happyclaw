import { describe, expect, test, vi } from 'vitest';

import { syntheticChannelProviderAck } from '../src/channel-outbox-runtime-scope.js';
import type { IMChannel, IMChannelConnectOpts } from '../src/im-channel.js';

const innerCalls = vi.hoisted(() => ({
  sendMessage: 0,
  sendImage: 0,
  sendFile: 0,
}));

function createMockConnection() {
  return {
    async connect() {
      return true;
    },
    async disconnect() {},
    async sendMessage() {
      innerCalls.sendMessage += 1;
    },
    async sendImage() {
      innerCalls.sendImage += 1;
    },
    async sendFile() {
      innerCalls.sendFile += 1;
    },
    async sendChatAction() {},
    async sendReaction() {},
    async setTyping() {},
    async clearAckReaction() {},
    isConnected() {
      return true;
    },
  };
}

vi.mock('../src/telegram.js', () => ({
  createTelegramConnection: () => createMockConnection(),
}));
vi.mock('../src/qq.js', () => ({
  createQQConnection: () => createMockConnection(),
}));
vi.mock('../src/dingtalk.js', () => ({
  createDingTalkConnection: () => createMockConnection(),
}));
vi.mock('../src/discord.js', () => ({
  createDiscordConnection: () => createMockConnection(),
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const {
  createTelegramChannel,
  createQQChannel,
  createDingTalkChannel,
  createDiscordChannel,
} = await import('../src/im-channel.js');

const connectOpts: IMChannelConnectOpts = {
  onReady: vi.fn(),
  onNewChat: vi.fn(),
};

const cases: Array<{
  name: string;
  create: () => IMChannel;
}> = [
  {
    name: 'Telegram',
    create: () => createTelegramChannel({ botToken: 'token' }),
  },
  {
    name: 'QQ',
    create: () => createQQChannel({ appId: 'app', appSecret: 'secret' }),
  },
  {
    name: 'DingTalk',
    create: () =>
      createDingTalkChannel({ clientId: 'client', clientSecret: 'secret' }),
  },
  {
    name: 'Discord',
    create: () => createDiscordChannel({ botToken: 'token' }),
  },
];

/**
 * Mirrors deliverScopedChannelOutput / sendImWithRetry: a void send that
 * does not throw is treated as success and a synthetic delivered ACK is
 * minted. After disconnect that must not happen.
 */
async function sendAndMintDeliveredAck(
  send: () => Promise<void>,
): Promise<string> {
  await send();
  return syntheticChannelProviderAck({
    turnRunId: 'disconnect-send-test',
    ordinal: 1,
    payloadHash: 'payload',
  });
}

describe('disconnect must not mint a delivered ACK', () => {
  test.each(cases)(
    '$name send after disconnect throws and does not mint a synthetic ACK',
    async ({ create }) => {
      innerCalls.sendMessage = 0;
      innerCalls.sendImage = 0;
      innerCalls.sendFile = 0;

      const channel = create();
      await expect(channel.connect(connectOpts)).resolves.toBe(true);
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);

      let mintedAck: string | undefined;
      await expect(
        sendAndMintDeliveredAck(async () => {
          await channel.sendMessage('chat-1', 'hello after disconnect');
          mintedAck = 'must-not-assign';
        }),
      ).rejects.toThrow('not connected');

      expect(mintedAck).toBeUndefined();
      expect(innerCalls.sendMessage).toBe(0);

      await expect(
        sendAndMintDeliveredAck(async () => {
          await channel.sendImage?.(
            'chat-1',
            Buffer.from('image'),
            'image/png',
          );
        }),
      ).rejects.toThrow('not connected');
      expect(innerCalls.sendImage).toBe(0);

      await expect(
        sendAndMintDeliveredAck(async () => {
          await channel.sendFile?.('chat-1', '/tmp/file', 'file.txt');
        }),
      ).rejects.toThrow('not connected');
      expect(innerCalls.sendFile).toBe(0);
    },
  );
});
