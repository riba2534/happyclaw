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

const COMPLETED_MARKER = '> ⚠️ 本次运行没有生成可展示的最终内容。';

function fakeDiscordChannel(messageId = 'msg-1') {
  const state = { content: '' };
  const message = {
    id: messageId,
    edit: vi.fn(async (next: string) => {
      state.content = next;
      return message;
    }),
  };
  const channel = {
    send: vi.fn(async (text: string) => {
      state.content = text;
      return message;
    }),
  };
  return { state, message, channel };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('Discord empty complete() settles the streaming message', () => {
  test('a bare thinking placeholder becomes the shared empty-final notice', async () => {
    const { state, message, channel } = fakeDiscordChannel();
    const ctrl = new DiscordStreamingEditController(channel as any);
    ctrl.setThinking();
    await vi.waitFor(() => expect(state.content).toBe('💭 思考中...'));

    const finalized = await finalizeChannelCardAfterDelivery(
      ctrl,
      '',
      true,
      'empty final',
    );

    expect(finalized).toEqual({ acknowledged: true });
    expect(message.edit).toHaveBeenCalledOnce();
    expect(state.content).toBe(COMPLETED_MARKER);
    expect(ctrl.isActive()).toBe(false);
  });

  test('keeps the tool trace but drops thinking and status (reply sent via send_message)', async () => {
    const { state, channel } = fakeDiscordChannel();
    const ctrl = new DiscordStreamingEditController(channel as any);
    ctrl.setThinking();
    await vi.waitFor(() => expect(channel.send).toHaveBeenCalledOnce());
    ctrl.appendThinking('checking the repo');
    ctrl.setSystemStatus('正在完成最终回复…');
    ctrl.startTool('tool-1', 'mcp__happyclaw__send_message');
    ctrl.endTool('tool-1', false);
    ctrl.pushRecentEvent('🔄 sent reply');

    await ctrl.complete('');

    const lines = state.content.split('\n');
    expect(lines[0]).toMatch(/^✅ `mcp__happyclaw__send_message` \(/);
    expect(state.content).toContain('📝 **调用轨迹**\n- 🔄 sent reply');
    expect(state.content.endsWith(`---\n\n${COMPLETED_MARKER}`)).toBe(true);
    expect(state.content).not.toMatch(
      /Thinking|Reason|思考中|⏳|正在完成最终回复/,
    );
  });

  test('an empty final keeps previously streamed text and only removes the aux prefix', async () => {
    const { state, message, channel } = fakeDiscordChannel();
    const ctrl = new DiscordStreamingEditController(channel as any);
    ctrl.startTool('tool-1', 'Read');
    ctrl.append('partial answer already visible');
    await vi.waitFor(() => {
      expect(state.content).toContain('`Read`');
      expect(state.content).toContain('partial answer already visible');
    });
    const editsBeforeComplete = message.edit.mock.calls.length;

    const finalized = await finalizeChannelCardAfterDelivery(
      ctrl,
      '',
      true,
      'empty final',
    );

    expect(finalized).toEqual({ acknowledged: true });
    expect(message.edit.mock.calls.length).toBe(editsBeforeComplete + 1);
    expect(state.content).toBe('partial answer already visible');
    expect(channel.send).toHaveBeenCalledOnce();
  });

  test('empty complete awaits an in-flight placeholder create before settling it', async () => {
    const { state, message } = fakeDiscordChannel('msg-inflight');
    let resolveSend!: (msg: typeof message) => void;
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

    let settled = false;
    const finalizePromise = finalizeChannelCardAfterDelivery(
      ctrl,
      '',
      true,
      'empty final',
    ).finally(() => {
      settled = true;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    state.content = '💭 思考中...';
    resolveSend(message);

    const finalized = await finalizePromise;

    expect(finalized).toEqual({ acknowledged: true });
    expect(message.edit).toHaveBeenCalledOnce();
    expect(state.content).toBe(COMPLETED_MARKER);
  });

  test('a failed placeholder create stays a terminal delivery error', async () => {
    const createError = new Error('Discord create failed before acceptance');
    const channel = {
      send: vi.fn(async () => {
        throw createError;
      }),
    };

    const ctrl = new DiscordStreamingEditController(channel as any);
    ctrl.setThinking();

    const finalized = await finalizeChannelCardAfterDelivery(
      ctrl,
      '',
      true,
      'empty final',
    );

    expect(finalized.acknowledged).toBe(false);
    expect(finalized.error).toBe(createError);
  });

  test('a failed settle edit is Partial, not acknowledged', async () => {
    const editError = new Error('discord settle edit failed');
    const message = {
      id: 'msg-fail',
      edit: vi.fn(async () => {
        throw editError;
      }),
    };
    const channel = { send: vi.fn(async () => message) };

    const ctrl = new DiscordStreamingEditController(channel as any);
    ctrl.setThinking();
    await vi.waitFor(() => expect(channel.send).toHaveBeenCalledOnce());

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

  test('empty complete with no placeholder resolves without creating a message', async () => {
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
