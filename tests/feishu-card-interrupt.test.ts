import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const controls = vi.hoisted(() => ({
  handlers: {} as Record<string, (data: unknown) => Promise<unknown>>,
  patch: vi.fn(),
}));

vi.mock('@larksuiteoapi/node-sdk', () => ({
  AppType: { SelfBuild: 'SelfBuild' },
  LoggerLevel: { info: 'info' },
  Client: class {
    request = vi.fn().mockResolvedValue({ bot: { open_id: 'ou_bot' } });
    im = {
      v1: {
        chat: {
          list: vi.fn().mockResolvedValue({
            data: { items: [], has_more: false },
          }),
        },
        message: { patch: controls.patch },
      },
    };
  },
  EventDispatcher: class {
    register(handlers: typeof controls.handlers) {
      controls.handlers = handlers;
      return this;
    }
  },
  WSClient: class {
    async start() {}
    async close() {}
  },
}));

vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { createFeishuConnection } = await import('../src/feishu.js');
const { registerMessageIdMapping, unregisterMessageId } =
  await import('../src/feishu-streaming-card.js');

const targetJid = 'feishu:oc_group#thread:omt_topic';
const cardMessageId = 'om_streaming_stop_test';
const interrupt = vi.fn();
const followUp = vi.fn();
let connection: ReturnType<typeof createFeishuConnection>;

beforeEach(async () => {
  vi.clearAllMocks();
  controls.patch.mockResolvedValue({ code: 0 });
  registerMessageIdMapping(cardMessageId, targetJid);
  connection = createFeishuConnection({
    appId: 'app_card_interrupt_test',
    appSecret: 'test-only-secret',
  });
  expect(
    await connection.connect({
      onReady: vi.fn(),
      onCardInterrupt: interrupt,
      onFollowUpCardAction: followUp,
    }),
  ).toBe(true);
});

afterEach(async () => {
  unregisterMessageId(cardMessageId);
  await connection.stop();
});

function trigger(value: Record<string, string>, messageId = cardMessageId) {
  return controls.handlers['card.action.trigger']({
    action: { value },
    context: { open_message_id: messageId },
    operator: { open_id: 'ou_operator' },
  });
}

describe('Feishu streaming stop callback', () => {
  test('acknowledges the stop without overwriting the session-owned answer', async () => {
    // Session finalization is asynchronous. A callback acknowledgement must
    // neither wait for it nor replace the answer with a short receipt card.
    const pendingAbort = vi.fn(() => new Promise<void>(() => {}));
    interrupt.mockImplementation(() => {
      void pendingAbort();
      return { ok: true, state: 'interrupting', message: '已停止当前回复。' };
    });

    await expect(trigger({ action: 'interrupt_stream' })).resolves.toEqual({
      toast: { type: 'success', content: '已停止当前回复。' },
    });
    expect(interrupt).toHaveBeenCalledExactlyOnceWith(targetJid, 'ou_operator');
    expect(pendingAbort).toHaveBeenCalledTimes(1);
    expect(controls.patch).not.toHaveBeenCalled();
    expect(followUp).not.toHaveBeenCalled();
  });

  test('keeps permission rejection as a warning without mutating the card', async () => {
    interrupt.mockReturnValue({
      ok: false,
      message: '你没有中断这个会话的权限。',
    });

    await expect(trigger({ action: 'interrupt_stream' })).resolves.toEqual({
      toast: { type: 'warning', content: '你没有中断这个会话的权限。' },
    });
    expect(controls.patch).not.toHaveBeenCalled();
  });

  test('does not interrupt another conversation for an unmapped old card', async () => {
    await trigger({ action: 'interrupt_stream' }, 'om_unknown_old_card');
    expect(interrupt).not.toHaveBeenCalled();
    expect(controls.patch).not.toHaveBeenCalled();
  });

  test.each([
    ['steer_queued', 'steer'],
    ['cancel_queued', 'cancel'],
    ['interrupt_and_run', 'interrupt_and_run'],
  ])('preserves legacy queued-card handling for %s', async (action, mapped) => {
    followUp.mockResolvedValue({ ok: true, message: '排队消息已处理。' });
    await trigger({
      action,
      sourceJid: 'feishu:oc_group',
      targetJid,
      messageId: 'om_queued_source',
      expectedRunId: 'run_original',
    });

    expect(followUp).toHaveBeenCalledExactlyOnceWith({
      sourceJid: 'feishu:oc_group',
      targetJid,
      messageId: 'om_queued_source',
      expectedRunId: 'run_original',
      operatorImId: 'ou_operator',
      action: mapped,
    });
    expect(interrupt).not.toHaveBeenCalled();
    expect(controls.patch).toHaveBeenCalledTimes(1);
    expect(controls.patch.mock.calls[0][0].path).toEqual({
      message_id: cardMessageId,
    });
    expect(controls.patch.mock.calls[0][0].data.content).toContain(
      '排队消息已处理。',
    );
  });
});
