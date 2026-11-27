import { describe, expect, test, vi } from 'vitest';
import {
  buildTelegramRouteJid,
  parseTelegramProviderTarget,
  prepareTelegramForumPairing,
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

  test('ignores #root: on native thread routes and rejects root-only/unknown', () => {
    // buildNativeThreadRouteJid emits base#thread:N#root:N; outbound must keep thread
    expect(parseTelegramProviderTarget('-1001#thread:55#root:55')).toEqual({
      chatId: -1001,
      messageThreadId: 55,
    });
    expect(parseTelegramProviderTarget('-1001#thread:55')).toEqual({
      chatId: -1001,
      messageThreadId: 55,
    });
    expect(parseTelegramProviderTarget('-1001')).toEqual({ chatId: -1001 });
    expect(parseTelegramProviderTarget('-1001#root:55')).toBeNull();
    expect(parseTelegramProviderTarget('-1001#thread:55#foo:1')).toBeNull();
    expect(parseTelegramProviderTarget('-1001#thread:0')).toBeNull();
    expect(parseTelegramProviderTarget('-1001#thread:55#thread:66')).toBeNull();
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
