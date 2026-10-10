import { describe, expect, test, vi } from 'vitest';

import {
  FEISHU_INBOUND_MAX_FAILURES,
  feishuChatTypeFromMode,
  feishuInboundRetryDelayMs,
  normalizeFeishuMentions,
  normalizeFeishuSender,
  normalizeListApiMessage,
  readFeishuIntakeState,
  withFeishuIntakeState,
} from '../src/feishu-intake-message.js';
import {
  clipFeishuMaterial,
  enrichFeishuInboundContent,
  sliceFeishuText,
} from '../src/feishu-rich-content.js';
import { IMConnectionManager } from '../src/im-manager.js';
import type { IMChannel, IMChannelConnectOpts } from '../src/im-channel.js';

describe('Feishu REST message normalization', () => {
  test('maps list-API mentions (string id + id_type) to the event shape', () => {
    expect(
      normalizeFeishuMentions([
        { key: '@_user_1', id: 'ou_bot', id_type: 'open_id', name: 'Bot' },
        { key: '@_user_2', id: 'u_1', id_type: 'user_id', name: 'U' },
        { key: '@_user_3', id: 'cli_x', id_type: 'app_id', name: 'App' },
        { key: '@_user_4', id: { open_id: 'ou_evt' }, name: 'Evt' },
      ]),
    ).toEqual([
      { key: '@_user_1', name: 'Bot', id: { open_id: 'ou_bot' } },
      { key: '@_user_2', name: 'U', id: { user_id: 'u_1' } },
      { key: '@_user_3', name: 'App' },
      { key: '@_user_4', name: 'Evt', id: { open_id: 'ou_evt' } },
    ]);
  });

  test('reads both sender shapes', () => {
    expect(
      normalizeFeishuSender({
        id: 'ou_rest',
        id_type: 'open_id',
        sender_type: 'user',
        tenant_key: 't',
      }),
    ).toEqual({ openId: 'ou_rest', type: 'user', tenantKey: 't' });
    expect(
      normalizeFeishuSender({
        sender_id: { open_id: 'ou_evt', union_id: 'on_x' },
        sender_name: 'Evt',
      }),
    ).toEqual({ openId: 'ou_evt', unionId: 'on_x', name: 'Evt' });
  });

  test('builds the WS payload shape and drops deleted and Bot items', () => {
    const payload = normalizeListApiMessage(
      {
        message_id: 'om_1',
        create_time: '1700000000',
        msg_type: 'text',
        body: { content: '{"text":"hi"}' },
        mentions: [{ key: '@_user_1', id: 'ou_bot', id_type: 'open_id' }],
        sender: { id: 'ou_u', id_type: 'open_id', sender_type: 'user' },
      },
      { chatId: 'oc_1', chatType: 'p2p', threadId: 'omt_1' },
    );
    expect(payload).toMatchObject({
      chatId: 'oc_1',
      messageId: 'om_1',
      threadId: 'omt_1',
      createTimeMs: 1_700_000_000_000,
      chatType: 'p2p',
      senderOpenId: 'ou_u',
      mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' } }],
    });
    expect(
      normalizeListApiMessage(
        { message_id: 'om_2', deleted: true },
        { chatId: 'oc_1' },
      ),
    ).toBeUndefined();
    expect(
      normalizeListApiMessage(
        { message_id: 'om_3', sender: { id: 'cli', sender_type: 'app' } },
        { chatId: 'oc_1' },
      ),
    ).toBeUndefined();
    // No chat type is invented when neither the item nor the chat knows it.
    expect(
      normalizeListApiMessage({ message_id: 'om_4' }, { chatId: 'oc_1' })
        ?.chatType,
    ).toBeUndefined();
  });

  test('chat_mode decides the chat type; private/public chat_type is ignored', () => {
    expect(feishuChatTypeFromMode('p2p')).toBe('p2p');
    expect(feishuChatTypeFromMode('topic')).toBe('group');
    expect(feishuChatTypeFromMode(undefined, 'private')).toBeUndefined();
    expect(feishuChatTypeFromMode(undefined, 'group')).toBe('group');
  });
});

describe('intake bookkeeping', () => {
  test('retry backoff grows 5s → 10min and is bounded', () => {
    expect(
      Array.from({ length: FEISHU_INBOUND_MAX_FAILURES }, (_, i) =>
        feishuInboundRetryDelayMs(i + 1),
      ),
    ).toEqual([
      5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000, 600_000,
    ]);
    expect(feishuInboundRetryDelayMs(40)).toBe(600_000);
  });

  test('intake state rides along any normalized payload', () => {
    const checkpoint = { version: 1, kind: 'feishu_slash_command' };
    const state = { failures: 2, forwardMaterialAttempt: 1 };
    const stored = withFeishuIntakeState(checkpoint, state);
    expect(stored).toMatchObject(checkpoint);
    expect(readFeishuIntakeState(stored)).toEqual(state);
    expect(readFeishuIntakeState(null)).toEqual({
      failures: 0,
      forwardMaterialAttempt: 0,
    });
    expect(
      withFeishuIntakeState(null, { failures: 0, forwardMaterialAttempt: 0 }),
    ).toBeNull();
  });
});

describe('enriched material bounds (inbound P1-2, P2-13)', () => {
  test('clips with an explicit marker and never splits a code point', () => {
    const text = '🙂'.repeat(100);
    const clipped = clipFeishuMaterial(text, 60);
    expect(clipped.truncated).toBe(true);
    expect(clipped.text.length).toBeLessThanOrEqual(60);
    expect(clipped.text).toMatch(/\[…已截断 \d+ 字符\]$/);
    expect(clipped.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
    expect(sliceFeishuText('a🙂', 2)).toBe('a');
    expect(clipFeishuMaterial('short', 60)).toEqual({
      text: 'short',
      truncated: false,
    });
  });

  test('a long card is bounded with a marker while plain text is untouched', async () => {
    const parseContent = (_type: string, content: string) => ({
      text: JSON.parse(content).text as string,
    });
    const card = JSON.stringify({
      schema: '2.0',
      body: {
        elements: Array.from({ length: 40 }, (_, i) => ({
          tag: 'markdown',
          content: `段落${i} ${'x'.repeat(40)}`,
        })),
      },
    });
    const client = {
      im: {
        v1: {
          message: {
            get: vi.fn(async () => ({
              data: {
                items: [
                  {
                    message_id: 'om_card',
                    msg_type: 'interactive',
                    body: { content: card },
                  },
                ],
              },
            })),
          },
        },
      },
    };
    const rich = await enrichFeishuInboundContent({
      client,
      messageId: 'om_card',
      messageType: 'interactive',
      fallbackText: '[卡片]',
      parseContent,
      limits: { maxTextChars: 400, maxCardNodes: 5_000 },
    });
    expect(rich.text.length).toBeLessThanOrEqual(400);
    expect(rich.text).toMatch(/\[…已截断 \d+ 字符\]$/);

    const plain = await enrichFeishuInboundContent({
      client: { im: {} },
      messageId: 'om_plain',
      messageType: 'text',
      fallbackText: 'y'.repeat(1_000),
      parseContent,
      limits: { maxTextChars: 400 },
    });
    expect(plain.text).toBe('y'.repeat(1_000));
  });

  test('fallback image keys are capped when enrichment fails', async () => {
    const result = await enrichFeishuInboundContent({
      client: {
        im: {
          v1: {
            message: {
              get: () => new Promise(() => undefined),
            },
          },
        },
      },
      messageId: 'om_many_images',
      messageType: 'post',
      fallbackText: 'images',
      fallbackImageKeys: Array.from({ length: 30 }, (_, i) => `img_${i}`),
      parentId: 'om_parent',
      parseContent: () => ({ text: '' }),
      limits: { totalTimeoutMs: 10, maxImageKeys: 12 },
    });
    expect(result.imageKeys).toHaveLength(12);
    expect(result.currentImageRefs).toHaveLength(12);
  });
});

describe('IM manager wiring for Feishu recall and the inbound gate', () => {
  function fakeFeishu() {
    let opts: IMChannelConnectOpts | null = null;
    let connected = false;
    const channel: IMChannel = {
      channelType: 'feishu',
      connect: vi.fn(async (value: IMChannelConnectOpts) => {
        opts = value;
        connected = true;
        return true;
      }),
      disconnect: vi.fn(async () => {
        connected = false;
      }),
      async sendMessage() {},
      async setTyping() {},
      isConnected: () => connected,
    };
    return { channel, getOpts: () => opts! };
  }

  test('onMessageRecalled is account-scoped and silenced while inbound is paused', async () => {
    const manager = new IMConnectionManager();
    const feishu = fakeFeishu();
    const onMessageRecalled = vi.fn();
    await manager.connectChannel(
      'recall-owner',
      'feishu',
      feishu.channel,
      { onReady: vi.fn(), onNewChat: vi.fn(), onMessageRecalled },
      'recall-account',
    );
    const opts = feishu.getOpts();
    await opts.onMessageRecalled?.('feishu:oc_recall', 'om_recalled');
    expect(onMessageRecalled).toHaveBeenCalledWith(
      'feishu:oc_recall#account:recall-account',
      'om_recalled',
    );
    manager.pauseInbound();
    await opts.onMessageRecalled?.('feishu:oc_recall', 'om_paused');
    expect(onMessageRecalled).toHaveBeenCalledTimes(1);
    manager.resumeInbound();
    await manager.disconnectAll();
  });

  test('onCommand forwards mentions and the routed message meta', async () => {
    const manager = new IMConnectionManager();
    const feishu = fakeFeishu();
    const onCommand = vi.fn().mockResolvedValue('ok');
    await manager.connectChannel(
      'command-owner',
      'feishu',
      feishu.channel,
      { onReady: vi.fn(), onNewChat: vi.fn(), onCommand },
      'command-account',
    );
    const mentions = [{ key: '@_user_2', id: { open_id: 'ou_target' } }];
    const meta = { provider: 'feishu', threadId: 'omt_1', rootId: 'om_root' };
    await feishu
      .getOpts()
      .onCommand?.('feishu:oc_cmd', 'allow @x', 'ou_owner', mentions, meta);
    expect(onCommand).toHaveBeenCalledWith(
      'feishu:oc_cmd#account:command-account',
      'allow @x',
      'ou_owner',
      mentions,
      meta,
    );
    await manager.disconnectAll();
  });

  test('session controls keep the native chat type through account scoping', async () => {
    const manager = new IMConnectionManager();
    const feishu = fakeFeishu();
    const onSessionClear = vi
      .fn()
      .mockResolvedValue('Session context cleared.');
    await manager.connectChannel(
      'clear-owner',
      'feishu',
      feishu.channel,
      { onReady: vi.fn(), onNewChat: vi.fn(), onSessionClear },
      'clear-account',
    );
    await feishu.getOpts().onSessionClear?.({
      sourceJid: 'feishu:oc_dm',
      senderImId: 'ou_owner',
      chatType: 'p2p',
    });
    expect(onSessionClear).toHaveBeenCalledWith({
      sourceJid: 'feishu:oc_dm#account:clear-account',
      senderImId: 'ou_owner',
      chatType: 'p2p',
    });
    await manager.disconnectAll();
  });

  test('gate-open listeners fire only once both pause and deferral are lifted', async () => {
    const manager = new IMConnectionManager();
    const feishu = fakeFeishu();
    await manager.connectChannel(
      'gate-owner',
      'feishu',
      feishu.channel,
      { onReady: vi.fn(), onNewChat: vi.fn() },
      'gate-account',
    );
    const listener = vi.fn();
    const unsubscribe = feishu.getOpts().onInboundGateOpen!(listener);
    manager.deferInbound();
    manager.pauseInbound();
    manager.resumeDeferredInbound();
    expect(listener).not.toHaveBeenCalled();
    expect(feishu.getOpts().shouldDeferInbound?.()).toBe(true);
    manager.resumeInbound();
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    manager.deferInbound();
    manager.resumeDeferredInbound();
    expect(listener).toHaveBeenCalledTimes(1);
    await manager.disconnectAll();
  });
});
