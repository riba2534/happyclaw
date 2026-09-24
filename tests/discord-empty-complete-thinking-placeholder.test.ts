import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

import { DiscordStreamingEditController } from '../src/discord-streaming-edit.js';
import { finalizeChannelCardAfterDelivery } from '../src/channel-card-finalization.js';

const EMPTY_NOTICE = '> ⚠️ 本次运行没有生成可展示的最终内容。';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('Discord empty complete() must not false-ACK a thinking placeholder', () => {
  test('setThinking → finalize complete("") does not leave 💭 思考中... with acknowledged true', async () => {
    let content = '';
    const message = {
      id: 'msg-thinking',
      edit: vi.fn(async (next: string) => {
        content = next;
        return message;
      }),
      delete: vi.fn(async () => message),
    };
    const channel = {
      send: vi.fn(async (text: string) => {
        content = text;
        return message;
      }),
    };

    const ctrl = new DiscordStreamingEditController(channel as any);
    ctrl.setThinking();
    // Allow ensureMessage() to resolve the placeholder create.
    await Promise.resolve();
    await Promise.resolve();

    expect(channel.send).toHaveBeenCalledWith('💭 思考中...');
    expect(content).toBe('💭 思考中...');

    const finalized = await finalizeChannelCardAfterDelivery(
      ctrl,
      '',
      true,
      'empty final',
    );

    // Must not success-ACK while the visible placeholder is still thinking text.
    expect(content).not.toBe('💭 思考中...');
    expect(finalized.acknowledged).toBe(true);
    expect(finalized.error).toBeUndefined();
    // Prefer Feishu-like empty notice edit; delete also clears the zombie.
    if (message.edit.mock.calls.length > 0) {
      expect(content).toBe(EMPTY_NOTICE);
    } else {
      expect(message.delete).toHaveBeenCalledOnce();
    }
  });

  test('empty complete awaits in-flight placeholder create before terminalizing', async () => {
    let resolveSend!: (msg: {
      id: string;
      edit: ReturnType<typeof vi.fn>;
      delete: ReturnType<typeof vi.fn>;
    }) => void;
    let content = '';
    const message = {
      id: 'msg-inflight',
      edit: vi.fn(async (next: string) => {
        content = next;
        return message;
      }),
      delete: vi.fn(async () => message),
    };
    const channel = {
      send: vi.fn(
        () =>
          new Promise<typeof message>((resolve) => {
            resolveSend = resolve;
          }),
      ),
    };

    const ctrl = new DiscordStreamingEditController(channel as any);
    ctrl.setThinking();
    expect(channel.send).toHaveBeenCalledOnce();

    const finalizePromise = finalizeChannelCardAfterDelivery(
      ctrl,
      '',
      true,
      'empty final',
    );

    // Create still in flight — must not have ACK'd yet.
    await Promise.resolve();
    resolveSend(message);
    content = '💭 思考中...';

    const finalized = await finalizePromise;

    expect(content).not.toBe('💭 思考中...');
    expect(finalized.acknowledged).toBe(true);
    if (message.edit.mock.calls.length > 0) {
      expect(content).toBe(EMPTY_NOTICE);
    } else {
      expect(message.delete).toHaveBeenCalledOnce();
    }
  });

  test('empty-complete placeholder mutation failure is Partial, not acknowledged true', async () => {
    const editError = new Error('discord empty-notice edit failed');
    const message = {
      id: 'msg-fail',
      edit: vi.fn(async () => {
        throw editError;
      }),
      delete: vi.fn(async () => {
        throw editError;
      }),
    };
    const channel = {
      send: vi.fn(async () => message),
    };

    const ctrl = new DiscordStreamingEditController(channel as any);
    ctrl.setThinking();
    await Promise.resolve();
    await Promise.resolve();

    const finalized = await finalizeChannelCardAfterDelivery(
      ctrl,
      '',
      true,
      'empty final',
    );

    expect(finalized.acknowledged).toBe(false);
    expect(finalized.error).toMatchObject({
      code: 'CHANNEL_DELIVERY_PARTIAL',
      cause: editError,
    });
  });

  test('empty complete with no placeholder still resolves without creating a message', async () => {
    const channel = { send: vi.fn(async () => ({ id: 'x', edit: vi.fn() })) };
    const ctrl = new DiscordStreamingEditController(channel as any);

    const finalized = await finalizeChannelCardAfterDelivery(
      ctrl,
      '   ',
      true,
      'empty final',
    );

    expect(finalized).toEqual({ acknowledged: true });
    expect(channel.send).not.toHaveBeenCalled();
  });
});
