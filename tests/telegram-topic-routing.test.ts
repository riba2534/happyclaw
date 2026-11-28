import { describe, expect, test, vi } from 'vitest';
import {
  buildTelegramRouteJid,
  parseTelegramProviderTarget,
  prepareTelegramForumPairing,
  telegramTopicThreadId,
} from '../src/telegram.js';
import {
  channelConversationJid,
  scopeChannelJid,
  extractProviderTarget,
} from '../src/channel-address.js';

describe('Telegram Forum topic routing', () => {
  test('keeps the account-scoped base chat bindable while preserving topic route', () => {
    const native = buildTelegramRouteJid('-100123', 77);
    const scoped = scopeChannelJid(native, 'telegram-account');

    expect(scoped).toBe('telegram:-100123#account:telegram-account#thread:77');
    expect(channelConversationJid(scoped)).toBe(
      'telegram:-100123#account:telegram-account',
    );
    expect(extractProviderTarget(scoped)).toBe('-100123#thread:77');
    expect(parseTelegramProviderTarget(extractProviderTarget(scoped))).toEqual({
      chatId: -100123,
      messageThreadId: 77,
    });
  });

  test('does not manufacture a thread for flat chats and rejects malformed targets', () => {
    expect(buildTelegramRouteJid('42')).toBe('telegram:42');
    expect(parseTelegramProviderTarget('42')).toEqual({ chatId: 42 });
    expect(parseTelegramProviderTarget('42#thread:not-a-number')).toBeNull();
    expect(parseTelegramProviderTarget('not-a-chat#thread:1')).toBeNull();
  });

  test('persists Forum capability on the base chat before pairing is ready', async () => {
    const group = {
      nativeContextType: 'none',
      bindingMode: 'single_session',
    };
    const detected = vi.fn(async (jid: string) => {
      expect(jid).toBe('telegram:-100123#account:bot-a');
      expect(jid).not.toContain('#thread:');
      group.nativeContextType = 'thread';
      group.bindingMode = 'thread_map';
      return true;
    });
    const fetchChat = vi.fn();

    await expect(
      prepareTelegramForumPairing(
        'telegram:-100123#account:bot-a',
        { id: -100123, type: 'supergroup', is_forum: true },
        fetchChat,
        detected,
      ),
    ).resolves.toBe('thread_ready');
    expect(fetchChat).not.toHaveBeenCalled();
    expect(group).toEqual({
      nativeContextType: 'thread',
      bindingMode: 'thread_map',
    });
  });

  test('falls back to getChat and reports an unavailable Forum upgrade', async () => {
    await expect(
      prepareTelegramForumPairing(
        'telegram:-100123#account:bot-a',
        { id: -100123, type: 'supergroup' },
        async () => ({ is_forum: true }),
        async () => false,
      ),
    ).resolves.toBe('thread_unavailable');
    await expect(
      prepareTelegramForumPairing(
        'telegram:-100123#account:bot-a',
        { id: -100123, type: 'supergroup' },
        async () => {
          throw new Error('network unavailable');
        },
        async () => true,
      ),
    ).resolves.toBe('thread_unavailable');
  });
});

describe('telegramTopicThreadId', () => {
  test('ignores a reply-chain message_thread_id without is_topic_message', () => {
    // A reply in an ordinary supergroup or a Forum's General topic.
    expect(
      telegramTopicThreadId({
        message_thread_id: 101,
        reply_to_message: {},
      }),
    ).toBeUndefined();
    expect(
      telegramTopicThreadId({
        message_thread_id: 101,
        is_topic_message: false,
      }),
    ).toBeUndefined();
  });

  test('returns the topic id for a topic message', () => {
    expect(
      telegramTopicThreadId({
        message_thread_id: 55,
        is_topic_message: true,
        reply_to_message: {},
      }),
    ).toBe(55);
    // The implicit reply to the topic's opening message.
    expect(
      telegramTopicThreadId({
        message_thread_id: 55,
        reply_to_message: { forum_topic_created: {} },
      }),
    ).toBe(55);
    // No reply, so no reply chain: the thread is the topic.
    expect(telegramTopicThreadId({ message_thread_id: 55 })).toBe(55);
    expect(telegramTopicThreadId({ is_topic_message: true })).toBeUndefined();
  });
});
