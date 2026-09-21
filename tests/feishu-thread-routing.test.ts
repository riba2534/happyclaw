import { describe, expect, test, vi } from 'vitest';
import {
  buildFeishuRouteTarget,
  parseFeishuRouteTarget,
} from '../src/feishu.js';
import { resolveFeishuConversationPlan } from '../src/feishu-conversation-policy.js';
import { StreamingCardController } from '../src/feishu-streaming-card.js';

describe('parseFeishuRouteTarget', () => {
  test('parses thread/root metadata and marks thread replies', () => {
    expect(
      parseFeishuRouteTarget('oc_123#thread:omt_thread#root:om_root'),
    ).toEqual({
      raw: 'oc_123#thread:omt_thread#root:om_root',
      chatId: 'oc_123',
      threadId: 'omt_thread',
      rootMessageId: 'om_root',
      replyInThread: true,
    });
  });

  test('keeps bare chat targets as non-thread replies', () => {
    expect(parseFeishuRouteTarget('oc_123')).toEqual({
      raw: 'oc_123',
      chatId: 'oc_123',
      threadId: undefined,
      rootMessageId: undefined,
      replyInThread: false,
    });
  });

  test('an ordinary-group mention keeps the ordinary group reply target', () => {
    const plan = resolveFeishuConversationPlan({
      chatType: 'group',
      chatMode: 'group',
      activationMode: 'when_mentioned',
      mentionedBot: true,
      messageId: 'om_mention',
    });
    const target = buildFeishuRouteTarget(
      'oc_ordinary',
      undefined,
      plan.rootMessageId,
    );
    expect(target).toMatchObject({
      chatId: 'oc_ordinary',
      replyInThread: false,
    });
  });
});

describe('StreamingCardController Feishu thread reply', () => {
  test('emits durable lifecycle identities through waiting and terminal states', async () => {
    const events: Array<{
      status: string;
      messageId: string | null;
      cardId: string | null;
      version: number;
    }> = [];
    const client = {
      cardkit: {
        v1: {
          card: {
            create: vi
              .fn()
              .mockResolvedValue({ code: 0, data: { card_id: 'card_life' } }),
            settings: vi.fn().mockResolvedValue({ code: 0 }),
            update: vi.fn().mockResolvedValue({ code: 0 }),
            batchUpdate: vi.fn().mockResolvedValue({ code: 0 }),
          },
          cardElement: { content: vi.fn().mockResolvedValue({ code: 0 }) },
        },
      },
      im: {
        message: {
          reply: vi.fn().mockResolvedValue({ data: { message_id: 'om_life' } }),
        },
        v1: { message: { create: vi.fn(), patch: vi.fn() } },
      },
    };
    const controller = new StreamingCardController({
      client: client as any,
      chatId: 'oc_life',
      replyToMsgId: 'om_root',
      lifecycle: { onEvent: (event) => events.push(event) },
    });

    controller.append('开始');
    await vi.waitFor(() =>
      expect(events.some((event) => event.status === 'streaming')).toBe(true),
    );
    controller.startTool('ask-life', 'AskUserQuestion');
    controller.endTool('ask-life', false);
    await controller.complete('完成');

    expect(events.map((event) => event.status)).toEqual(
      expect.arrayContaining([
        'creating',
        'streaming',
        'waiting_user',
        'running',
        'finalizing',
        'completed',
      ]),
    );
    expect(events.at(-1)).toMatchObject({
      status: 'completed',
      messageId: 'om_life',
      cardId: 'card_life',
    });
    expect(events.at(-1)!.version).toBeGreaterThan(1);
  });

  test('passes reply_in_thread when creating the initial streaming card', async () => {
    const reply = vi
      .fn()
      .mockResolvedValue({ data: { message_id: 'om_card' } });
    const client = {
      cardkit: {
        v1: {
          card: {
            create: vi
              .fn()
              .mockResolvedValue({ code: 0, data: { card_id: 'card_1' } }),
          },
          cardElement: {},
        },
      },
      im: {
        message: { reply },
        v1: { message: { create: vi.fn() } },
      },
    };

    const controller = new StreamingCardController({
      client: client as any,
      chatId: 'oc_123',
      replyToMsgId: 'om_root',
      replyInThread: true,
    });

    controller.setThinking();
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
    expect(reply.mock.calls[0][0].data).toMatchObject({
      msg_type: 'interactive',
      reply_in_thread: true,
    });
  });

  test('retries a card reply without reply_in_thread only for unsupported thread errors', async () => {
    const reply = vi
      .fn()
      .mockRejectedValueOnce({ code: 230071, message: 'thread unsupported' })
      .mockResolvedValueOnce({ data: { message_id: 'om_plain_reply' } });
    const client = {
      cardkit: {
        v1: {
          card: {
            create: vi
              .fn()
              .mockResolvedValue({ code: 0, data: { card_id: 'card_1' } }),
          },
          cardElement: {},
        },
      },
      im: {
        message: { reply },
        v1: { message: { create: vi.fn() } },
      },
    };

    const controller = new StreamingCardController({
      client: client as any,
      chatId: 'oc_123',
      replyToMsgId: 'om_root',
      replyInThread: true,
    });

    controller.setThinking();
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(2));
    expect(reply.mock.calls[0][0].data.reply_in_thread).toBe(true);
    expect(reply.mock.calls[1][0].data.reply_in_thread).toBeUndefined();
  });

  test('AskUserQuestion is a real waiting phase and wins over thinking', async () => {
    const reply = vi
      .fn()
      .mockResolvedValue({ data: { message_id: 'om_card' } });
    const client = {
      cardkit: {
        v1: {
          card: {
            create: vi
              .fn()
              .mockResolvedValue({ code: 0, data: { card_id: 'card_1' } }),
          },
          cardElement: {},
        },
      },
      im: {
        message: { reply },
        v1: { message: { create: vi.fn() } },
      },
    };
    const controller = new StreamingCardController({
      client: client as any,
      chatId: 'oc_123',
      replyToMsgId: 'om_root',
    });

    controller.setThinking();
    await vi.waitFor(() => expect(reply).toHaveBeenCalledTimes(1));
    controller.startTool('ask-1', 'AskUserQuestion');
    controller.setToolMeta('ask-1', {
      toolInput: { question: '请选择投递方式？' },
    });

    const internals = controller as unknown as {
      derivePhase(): string;
      buildRichPanelPatches(): { askContent?: string; statusBanner: string };
    };
    expect(internals.derivePhase()).toBe('waiting');
    expect(internals.buildRichPanelPatches().statusBanner).toContain(
      '等待输入',
    );
    expect(internals.buildRichPanelPatches().askContent).toContain(
      '等待你的回复',
    );
    expect(internals.buildRichPanelPatches().askContent).toContain(
      '请选择投递方式',
    );

    controller.endTool('ask-1', false);
    expect(internals.derivePhase()).toBe('idle');
    expect(internals.buildRichPanelPatches().askContent).toBeUndefined();
  });

  test('preserves trace link when usage patch updates a legacy completed card', async () => {
    const patch = vi.fn().mockResolvedValue({ code: 0 });
    const create = vi
      .fn()
      .mockResolvedValue({ data: { message_id: 'om_card' } });
    const client = {
      cardkit: {
        v1: {
          card: {
            create: vi
              .fn()
              .mockRejectedValue(new Error('streaming unavailable')),
          },
          cardElement: {},
        },
      },
      im: {
        message: { reply: vi.fn() },
        v1: { message: { create, patch } },
      },
    };

    const controller = new StreamingCardController({
      client: client as any,
      chatId: 'oc_123',
    });
    controller.setTraceUrl('https://happy.example/chat/main?trace=1');
    controller.append('hello');

    await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    await controller.complete('hello');
    await controller.patchUsageNote({
      inputTokens: 10,
      outputTokens: 5,
      costUSD: 0.01,
      durationMs: 1000,
      numTurns: 1,
    });

    const finalContent = patch.mock.calls.at(-1)?.[0]?.data?.content;
    expect(finalContent).toContain('查看完整运行轨迹');
    expect(finalContent).toContain('happy.example/chat/main');
    expect(finalContent).toContain('15 tokens（输入 10 · 输出 5）');
  });
});
