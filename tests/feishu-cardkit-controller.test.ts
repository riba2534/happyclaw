import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  CARD_ELEMENT_IDS,
  buildStreamingDetails,
} from '../src/feishu-cards/sections.js';
import {
  StreamingCardController,
  streamingCardSnapshotText,
  resolveInterruptedStreamingCardRewrite,
} from '../src/feishu-streaming-card.js';
import {
  CARDKIT_JSON_MAX_BYTES,
  CARDKIT_MARKDOWN_MAX_CHARS,
} from '../src/feishu-cards/capacity.js';
import { finalizeChannelCardAfterDelivery } from '../src/channel-card-finalization.js';

function makeClient() {
  let cardNumber = 0;
  const cardCreate = vi.fn().mockImplementation(async () => ({
    code: 0,
    data: { card_id: `card_${++cardNumber}` },
  }));
  const batchUpdate = vi.fn().mockResolvedValue({ code: 0 });
  const elementContent = vi.fn().mockResolvedValue({ code: 0 });
  const cardSettings = vi.fn().mockResolvedValue({ code: 0 });
  const cardUpdate = vi.fn().mockResolvedValue({ code: 0 });
  const messageReply = vi
    .fn()
    .mockResolvedValue({ data: { message_id: 'om_card' } });
  const messageCreate = vi
    .fn()
    .mockResolvedValue({ data: { message_id: 'om_card' } });
  return {
    client: {
      cardkit: {
        v1: {
          card: {
            create: cardCreate,
            batchUpdate,
            settings: cardSettings,
            update: cardUpdate,
          },
          cardElement: {
            content: elementContent,
            update: vi.fn().mockResolvedValue({ code: 0 }),
          },
        },
      },
      im: {
        message: { reply: messageReply },
        v1: {
          message: {
            create: messageCreate,
            patch: vi.fn().mockResolvedValue({}),
          },
        },
      },
    },
    cardCreate,
    batchUpdate,
    elementContent,
    cardSettings,
    cardUpdate,
  };
}

function findElementContent(value: unknown, elementId: string): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findElementContent(item, elementId);
      if (found !== null) return found;
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (record.element_id === elementId && typeof record.content === 'string') {
    return record.content;
  }
  for (const child of Object.values(record)) {
    const found = findElementContent(child, elementId);
    if (found !== null) return found;
  }
  return null;
}

async function createThinkingController() {
  const mock = makeClient();
  const controller = new StreamingCardController({
    client: mock.client as any,
    chatId: 'oc_cardkit',
    replyToMsgId: 'om_root',
  });
  controller.setThinking();
  await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));
  const backend = (controller as any).streamingBackend as {
    drain(): Promise<void>;
    updateMarkdownContents(
      patches: Array<{ elementId: string; content: string }>,
    ): Promise<{ updated: string[]; failed: string[] }>;
    updateMarkdownContent(elementId: string, content: string): Promise<void>;
    streamContent(content: string): Promise<void>;
  };
  await backend.drain();
  return { ...mock, controller, backend };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Feishu CardKit streaming controller', () => {
  test('thinking/tool-only runs start with deterministic progress instead of a bare ellipsis', async () => {
    const { cardCreate, controller } = await createThinkingController();
    const initialCard = JSON.parse(cardCreate.mock.calls[0][0].data.data);
    const main = findElementContent(initialCard, CARD_ELEMENT_IDS.MAIN_CONTENT);

    expect(main).toContain('正在处理请求');
    expect(main?.trim()).not.toBe('...');
    expect(
      typeof findElementContent(initialCard, CARD_ELEMENT_IDS.STATUS_BANNER),
    ).toBe('string');
    controller.dispose();
  });

  test('retracting provisional narration keeps the live main slot on a neutral placeholder', async () => {
    const mock = makeClient();
    const controller = new StreamingCardController({
      client: mock.client as any,
      chatId: 'oc_retract',
    });
    controller.append('过程说明');
    await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));
    const backend = (controller as any).streamingBackend as {
      drain(): Promise<void>;
    };
    await backend.drain();
    mock.elementContent.mockClear();

    controller.append('');
    await vi.waitFor(() =>
      expect(
        mock.elementContent.mock.calls.some(
          (call) => call[0].path.element_id === CARD_ELEMENT_IDS.MAIN_CONTENT,
        ),
      ).toBe(true),
    );
    await backend.drain();

    const mainUpdate = mock.elementContent.mock.calls.find(
      (call) => call[0].path.element_id === CARD_ELEMENT_IDS.MAIN_CONTENT,
    )![0];
    expect(mainUpdate.data.content).toContain('正在处理请求');
    expect(mainUpdate.data.content).not.toBe('');
    expect((controller as any).accumulatedText).toBe('');
    controller.dispose();
  });

  test('normal auxiliary flush is one idempotent batch mutation and preserves element structure', async () => {
    const { batchUpdate, controller, backend } =
      await createThinkingController();
    batchUpdate.mockClear();

    const current = (controller as any).buildRichPanelPatches();
    await backend.updateMarkdownContents([
      {
        elementId: CARD_ELEMENT_IDS.STATUS_BANNER,
        content: current.statusBanner,
      },
      {
        elementId: CARD_ELEMENT_IDS.FOOTER_NOTE,
        content: current.footerNote,
      },
    ]);
    expect(batchUpdate).not.toHaveBeenCalled();

    await backend.updateMarkdownContents([
      {
        elementId: CARD_ELEMENT_IDS.STATUS_BANNER,
        content: '调用工具 · WebSearch',
      },
      {
        elementId: CARD_ELEMENT_IDS.FOOTER_NOTE,
        content: '已用 10 秒',
      },
    ]);

    expect(batchUpdate).toHaveBeenCalledTimes(1);
    const payload = batchUpdate.mock.calls[0][0];
    expect(payload.data.sequence).toBeGreaterThan(1);
    expect(payload.data.uuid).toMatch(/^hc_[a-f0-9]{32}$/);
    expect(payload.data.uuid.length).toBeLessThanOrEqual(64);
    const actions = JSON.parse(payload.data.actions);
    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({
      action: 'partial_update_element',
      params: { element_id: CARD_ELEMENT_IDS.STATUS_BANNER },
    });
    expect(actions[0].params.partial_element).toEqual({
      content: '调用工具 · WebSearch',
    });
    expect(actions[0].params).not.toHaveProperty('element');
    controller.dispose();
  });

  test('batch transport retry reuses the exact sequence and UUID', async () => {
    const { batchUpdate, controller, backend } =
      await createThinkingController();
    batchUpdate.mockReset();
    batchUpdate
      .mockRejectedValueOnce(new Error('socket closed after write'))
      .mockResolvedValueOnce({ code: 0 });

    const result = await backend.updateMarkdownContents([
      {
        elementId: CARD_ELEMENT_IDS.STATUS_BANNER,
        content: '正在重试',
      },
    ]);

    expect(result.failed).toEqual([]);
    expect(batchUpdate).toHaveBeenCalledTimes(2);
    expect(batchUpdate.mock.calls[1][0].data.sequence).toBe(
      batchUpdate.mock.calls[0][0].data.sequence,
    );
    expect(batchUpdate.mock.calls[1][0].data.uuid).toBe(
      batchUpdate.mock.calls[0][0].data.uuid,
    );
    expect(batchUpdate.mock.calls[1][0].data.actions).toBe(
      batchUpdate.mock.calls[0][0].data.actions,
    );
    controller.dispose();
  });

  test('streaming-expired recovery re-enables first and retries with a newer sequence', async () => {
    const { elementContent, cardSettings, controller, backend } =
      await createThinkingController();
    elementContent.mockReset();
    cardSettings.mockClear();
    elementContent
      .mockRejectedValueOnce({ code: 200850 })
      .mockResolvedValueOnce({ code: 0 });

    await backend.streamContent('恢复后的正文');

    expect(elementContent).toHaveBeenCalledTimes(2);
    expect(cardSettings).toHaveBeenCalledTimes(1);
    const firstSequence = elementContent.mock.calls[0][0].data.sequence;
    const settingsSequence = cardSettings.mock.calls[0][0].data.sequence;
    const retrySequence = elementContent.mock.calls[1][0].data.sequence;
    expect(settingsSequence).toBeGreaterThan(firstSequence);
    expect(retrySequence).toBeGreaterThan(settingsSequence);
    expect(elementContent.mock.calls[0][0].data.uuid).not.toBe(
      elementContent.mock.calls[1][0].data.uuid,
    );
    controller.dispose();
  });

  test('a rejected batch isolates slots so one invalid panel cannot block status/footer', async () => {
    const { batchUpdate, elementContent, controller, backend } =
      await createThinkingController();
    batchUpdate.mockReset().mockResolvedValue({ code: 230099, msg: 'invalid' });
    elementContent.mockImplementation(async (request: any) => {
      if (request.path.element_id === CARD_ELEMENT_IDS.TASK_CONTENT) {
        return { code: 230099, msg: 'invalid task markdown' };
      }
      return { code: 0 };
    });

    const result = await backend.updateMarkdownContents([
      {
        elementId: CARD_ELEMENT_IDS.STATUS_BANNER,
        content: '仍在运行',
      },
      {
        elementId: CARD_ELEMENT_IDS.TASK_CONTENT,
        content: '<invalid>',
      },
      {
        elementId: CARD_ELEMENT_IDS.FOOTER_NOTE,
        content: '已用 15 秒',
      },
    ]);

    expect(batchUpdate).toHaveBeenCalledTimes(1);
    expect(elementContent).toHaveBeenCalledTimes(3);
    expect(result.updated).toEqual([
      CARD_ELEMENT_IDS.STATUS_BANNER,
      CARD_ELEMENT_IDS.FOOTER_NOTE,
    ]);
    expect(result.failed).toEqual([CARD_ELEMENT_IDS.TASK_CONTENT]);
    const sequences = elementContent.mock.calls.map(
      (call) => call[0].data.sequence as number,
    );
    expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
    expect(new Set(sequences).size).toBe(sequences.length);
    controller.dispose();
  });

  test('native streaming opens bounded continuation cards before completion', async () => {
    const mock = makeClient();
    const controller = new StreamingCardController({
      client: mock.client as any,
      chatId: 'oc_long',
    });
    const full = `\`\`\`typescript\n${'const value = 1;\n'.repeat(25000)}\`\`\``;
    controller.append(full);
    await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));

    const initialCard = JSON.parse(mock.cardCreate.mock.calls[0][0].data.data);
    const main = findElementContent(
      initialCard,
      CARD_ELEMENT_IDS.MAIN_CONTENT,
    )!;
    expect(Array.from(main).length).toBeLessThanOrEqual(
      CARDKIT_MARKDOWN_MAX_CHARS,
    );
    expect(main).toMatch(/```\n?$/);
    await (controller as any).nativePageChain;
    expect(mock.cardCreate.mock.calls.length).toBeGreaterThan(1);
    expect(controller.currentState).toBe('streaming');
    const tailCard = JSON.parse(
      mock.cardCreate.mock.calls.at(-1)![0].data.data,
    );
    expect(
      findElementContent(tailCard, CARD_ELEMENT_IDS.MAIN_CONTENT),
    ).toContain('const value = 1;');
    for (const call of mock.cardCreate.mock.calls) {
      expect(Buffer.byteLength(call[0].data.data)).toBeLessThan(
        CARDKIT_JSON_MAX_BYTES,
      );
    }
    expect((controller as any).accumulatedText).toBe(full);
    controller.dispose();
  });

  test('terminal finalization drains queued mutations before disabling streaming', async () => {
    const { elementContent, cardSettings, cardUpdate, controller, backend } =
      await createThinkingController();
    const order: string[] = [];
    let release!: (value: { code: number }) => void;
    const pending = new Promise<{ code: number }>((resolve) => {
      release = resolve;
    });
    elementContent.mockImplementationOnce(async () => {
      order.push('content');
      return pending;
    });
    cardSettings.mockImplementation(async () => {
      order.push('settings');
      return { code: 0 };
    });
    cardUpdate.mockImplementation(async () => {
      order.push('update');
      return { code: 0 };
    });

    const mutation = backend.updateMarkdownContent('probe_slot', 'probe');
    await vi.waitFor(() => expect(order).toEqual(['content']));
    const completing = controller.complete('最终答复');
    await Promise.resolve();
    expect(order).toEqual(['content']);
    release({ code: 0 });
    await mutation;
    await completing;

    expect(order).toEqual(['content', 'settings', 'update']);
    expect(cardSettings.mock.calls[0][0].data.uuid).toMatch(/^hc_/);
    expect(cardUpdate.mock.calls[0][0].data.sequence).toBeGreaterThan(
      cardSettings.mock.calls[0][0].data.sequence,
    );
  });

  test.each(['v1', 'legacy'] as const)(
    '%s active fallback never patches an empty main body',
    async (mode) => {
      let createCount = 0;
      const cardUpdate = vi.fn().mockResolvedValue({ code: 0 });
      const messagePatch = vi.fn().mockResolvedValue({ code: 0 });
      const cardCreate = vi.fn().mockImplementation(async () => {
        createCount++;
        if (createCount === 1 || mode === 'legacy') {
          throw new Error('CardKit mode unavailable');
        }
        return { data: { card_id: 'card_v1' } };
      });
      const client = {
        cardkit: {
          v1: {
            card: { create: cardCreate, update: cardUpdate },
            cardElement: {},
          },
        },
        im: {
          message: {},
          v1: {
            message: {
              create: vi
                .fn()
                .mockResolvedValue({ data: { message_id: 'om_fallback' } }),
              patch: messagePatch,
            },
          },
        },
      };
      const controller = new StreamingCardController({
        client: client as any,
        chatId: `oc_${mode}`,
      });
      controller.append('过程说明');
      await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));
      cardUpdate.mockClear();
      messagePatch.mockClear();

      controller.append('');
      await (controller as any).patchCard('streaming');

      const cardJson =
        mode === 'v1'
          ? JSON.parse(cardUpdate.mock.calls.at(-1)![0].data.card.data)
          : JSON.parse(messagePatch.mock.calls.at(-1)![0].data.content);
      expect(
        findElementContent(cardJson, CARD_ELEMENT_IDS.MAIN_CONTENT),
      ).toContain('正在处理请求');
      expect((controller as any).accumulatedText).toBe('');
      controller.dispose();
    },
  );

  test('accepted streaming message timeout is sticky and never creates a fallback card', async () => {
    const mock = makeClient();
    let visibleMutations = 0;
    const acceptedTimeout = Object.assign(
      new Error('message.create ACK timed out after acceptance'),
      { code: 'ETIMEDOUT' },
    );
    const messageCreate = vi.fn(async () => {
      visibleMutations += 1;
      throw acceptedTimeout;
    });
    mock.client.im.v1.message.create = messageCreate;
    const controller = new StreamingCardController({
      client: mock.client as any,
      chatId: 'oc_uncertain_create',
    });

    controller.append('answer');
    await vi.waitFor(() => expect(controller.currentState).toBe('error'));

    expect(mock.cardCreate).toHaveBeenCalledOnce();
    expect(messageCreate).toHaveBeenCalledOnce();
    expect(visibleMutations).toBe(1);
    expect(controller.isActive()).toBe(true);
    await expect(controller.complete('answer')).rejects.toMatchObject({
      deliveryPhase: 'uncertain',
      cause: acceptedTimeout,
    });
    await expect(controller.complete('answer')).rejects.toMatchObject({
      deliveryPhase: 'uncertain',
    });
    expect(messageCreate).toHaveBeenCalledOnce();
    expect(visibleMutations).toBe(1);
    const aborted = await finalizeChannelCardAfterDelivery(
      controller,
      'answer',
      false,
      'attachment prerequisite failed',
    );
    expect(aborted).toMatchObject({
      acknowledged: false,
      error: { deliveryPhase: 'uncertain' },
    });
    expect(controller.currentState).toBe('aborted');
    expect(messageCreate).toHaveBeenCalledOnce();
    controller.dispose();
  });

  test.each([
    [408, 408],
    [503, 9999],
  ])(
    'HTTP %s with numeric body code %s remains uncertain and never switches backend',
    async (status, code) => {
      const mock = makeClient();
      let visibleMutations = 0;
      const messageCreate = vi.fn(async () => {
        visibleMutations += 1;
        throw Object.assign(new Error(`HTTP ${status} after mutation`), {
          response: { status, data: { code, msg: 'ambiguous response' } },
        });
      });
      mock.client.im.v1.message.create = messageCreate;
      const controller = new StreamingCardController({
        client: mock.client as any,
        chatId: `oc_http_${status}`,
      });

      controller.append('answer');
      await vi.waitFor(() => expect(controller.currentState).toBe('error'));

      expect(mock.cardCreate).toHaveBeenCalledOnce();
      expect(messageCreate).toHaveBeenCalledOnce();
      expect(visibleMutations).toBe(1);
      await expect(controller.complete('answer')).rejects.toMatchObject({
        deliveryPhase: 'uncertain',
      });
      controller.dispose();
    },
  );

  test('a successfully aborted visible card still fences static prerequisite fallback', async () => {
    const mock = makeClient();
    const controller = new StreamingCardController({
      client: mock.client as any,
      chatId: 'oc_visible_abort_fence',
    });
    controller.append('visible preview');
    await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));

    const result = await finalizeChannelCardAfterDelivery(
      controller,
      'final answer',
      false,
      'attachment prerequisite failed',
    );

    expect(result).toMatchObject({
      acknowledged: false,
      error: {
        code: 'CHANNEL_DELIVERY_PARTIAL',
        deliveredOutputs: 1,
        totalOutputs: 2,
      },
    });
    expect(controller.currentState).toBe('aborted');
    expect(mock.client.im.v1.message.create).toHaveBeenCalledOnce();
    expect(mock.cardUpdate).toHaveBeenCalledOnce();
    controller.dispose();
  });

  test('an explicit streaming-message rejection still permits CardKit v1 fallback', async () => {
    const mock = makeClient();
    const messageCreate = vi
      .fn()
      .mockResolvedValueOnce({ code: 230001, msg: 'streaming unsupported' })
      .mockResolvedValueOnce({
        code: 0,
        data: { message_id: 'om_v1_fallback' },
      });
    mock.client.im.v1.message.create = messageCreate;
    const controller = new StreamingCardController({
      client: mock.client as any,
      chatId: 'oc_rejected_create',
    });

    controller.append('answer');
    await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));

    expect(mock.cardCreate).toHaveBeenCalledTimes(2);
    expect(messageCreate).toHaveBeenCalledTimes(2);
    expect(controller.currentMessageId).toBe('om_v1_fallback');
    expect((controller as any).backendMode).toBe('v1');
    controller.dispose();
  });

  test('a proven pre-accept streaming-message failure permits CardKit v1 fallback', async () => {
    const mock = makeClient();
    const messageCreate = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('getaddrinfo ENOTFOUND open.feishu.cn'), {
          code: 'ENOTFOUND',
        }),
      )
      .mockResolvedValueOnce({
        code: 0,
        data: { message_id: 'om_v1_after_preaccept' },
      });
    mock.client.im.v1.message.create = messageCreate;
    const controller = new StreamingCardController({
      client: mock.client as any,
      chatId: 'oc_preaccept_create',
    });

    controller.append('answer');
    await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));

    expect(mock.cardCreate).toHaveBeenCalledTimes(2);
    expect(messageCreate).toHaveBeenCalledTimes(2);
    expect(controller.currentMessageId).toBe('om_v1_after_preaccept');
    expect((controller as any).backendMode).toBe('v1');
    controller.dispose();
  });

  test('accepted CardKit v1 message timeout never falls through to legacy create', async () => {
    const mock = makeClient();
    mock.cardCreate
      .mockRejectedValueOnce(new Error('streaming resource unavailable'))
      .mockResolvedValueOnce({ code: 0, data: { card_id: 'card_v1' } });
    let visibleMutations = 0;
    const messageCreate = vi.fn(async () => {
      visibleMutations += 1;
      throw Object.assign(new Error('v1 message ACK timed out'), {
        code: 'ETIMEDOUT',
      });
    });
    mock.client.im.v1.message.create = messageCreate;
    const controller = new StreamingCardController({
      client: mock.client as any,
      chatId: 'oc_uncertain_v1',
    });

    controller.append('answer');
    await vi.waitFor(() => expect(controller.currentState).toBe('error'));

    expect(mock.cardCreate).toHaveBeenCalledTimes(2);
    expect(messageCreate).toHaveBeenCalledOnce();
    expect(visibleMutations).toBe(1);
    expect(controller.isActive()).toBe(true);
    await expect(controller.complete('answer')).rejects.toMatchObject({
      deliveryPhase: 'uncertain',
    });
    expect(messageCreate).toHaveBeenCalledOnce();
    controller.dispose();
  });

  test('unknown final update ACK is sticky and never tries a truncated second mutation', async () => {
    const mock = makeClient();
    const acceptedTimeout = Object.assign(
      new Error('card.update ACK timed out after acceptance'),
      { code: 'ETIMEDOUT' },
    );
    mock.cardUpdate.mockRejectedValue(acceptedTimeout);
    const controller = new StreamingCardController({
      client: mock.client as any,
      chatId: 'oc_uncertain_finalize',
    });
    controller.append('final answer');
    await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));

    await expect(controller.complete('final answer')).rejects.toMatchObject({
      code: 'CHANNEL_DELIVERY_PARTIAL',
      cause: acceptedTimeout,
    });

    expect(mock.cardUpdate).toHaveBeenCalledOnce();
    expect(controller.currentState).toBe('error');
    await expect(controller.complete('final answer')).rejects.toMatchObject({
      code: 'CHANNEL_DELIVERY_PARTIAL',
    });
    expect(mock.cardUpdate).toHaveBeenCalledOnce();
    controller.dispose();
  });

  test.each(['v1', 'legacy'] as const)(
    '%s unknown active-update ACK becomes sticky without a new message',
    async (mode) => {
      let cardCreates = 0;
      const cardCreate = vi.fn(async () => {
        cardCreates += 1;
        if (cardCreates === 1 || mode === 'legacy') {
          throw new Error('backend resource unavailable');
        }
        return { code: 0, data: { card_id: 'card_v1' } };
      });
      const acceptedTimeout = Object.assign(
        new Error(`${mode} update ACK timed out after acceptance`),
        { code: 'ETIMEDOUT' },
      );
      const cardUpdate = vi.fn(async () => {
        throw acceptedTimeout;
      });
      const messagePatch = vi.fn(async () => {
        throw acceptedTimeout;
      });
      const messageCreate = vi
        .fn()
        .mockResolvedValue({ code: 0, data: { message_id: `om_${mode}` } });
      const client = {
        cardkit: {
          v1: {
            card: {
              create: cardCreate,
              update: cardUpdate,
            },
            cardElement: {},
          },
        },
        im: {
          message: {},
          v1: { message: { create: messageCreate, patch: messagePatch } },
        },
      };
      const controller = new StreamingCardController({
        client: client as any,
        chatId: `oc_${mode}_sticky_update`,
      });
      controller.append('body');
      await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));
      (controller as any).accumulatedText = 'body changed';

      await expect(
        (controller as any).patchCard('streaming'),
      ).rejects.toMatchObject({
        code: 'CHANNEL_DELIVERY_PARTIAL',
        cause: acceptedTimeout,
      });

      expect(controller.currentState).toBe('error');
      expect(messageCreate).toHaveBeenCalledOnce();
      expect(mode === 'v1' ? cardUpdate : messagePatch).toHaveBeenCalledOnce();
      await expect(controller.complete('body')).rejects.toMatchObject({
        code: 'CHANNEL_DELIVERY_PARTIAL',
      });
      expect(messageCreate).toHaveBeenCalledOnce();
      controller.dispose();
    },
  );

  test('a 15K reply remains one card and patches usage in place', async () => {
    const mock = makeClient();
    const controller = new StreamingCardController({
      client: mock.client as any,
      chatId: 'oc_split_tail',
    });

    const body = Array.from(
      { length: 40 },
      (_, i) => `paragraph ${i} ${'a'.repeat(370)}`,
    ).join('\n\n');
    expect(body.length).toBeGreaterThan(15000);
    expect(Buffer.byteLength(body, 'utf-8')).toBeLessThan(16 * 1024);

    controller.append(body);
    await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));
    const backend = (controller as any).streamingBackend as {
      drain(): Promise<void>;
    };
    await backend.drain();

    await controller.complete(body);
    expect(controller.currentState).toBe('completed');
    expect((controller as any).nativeCards.length).toBe(1);

    mock.cardUpdate.mockClear();
    mock.batchUpdate.mockClear();
    await controller.patchUsageNote({
      inputTokens: 1200,
      outputTokens: 340,
      costUSD: 0.42,
      durationMs: 12000,
      numTurns: 3,
    });
    await backend.drain();

    const rendered = mock.batchUpdate.mock.calls
      .map((call) => String(call[0].data.actions))
      .join('\n');
    expect(rendered).toContain('💰');
    expect(rendered).toContain('输入 1.2K');
    expect(rendered).toContain('输出 340');
    controller.dispose();
  });

  test('usage arriving while complete() is mid-flight still lands on the final card', async () => {
    const mock = makeClient();
    const controller = new StreamingCardController({
      client: mock.client as any,
      chatId: 'oc_usage_race',
    });
    controller.append('短回复正文');
    await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));
    const backend = (controller as any).streamingBackend as {
      drain(): Promise<void>;
    };
    await backend.drain();

    const completing = controller.complete('短回复正文');
    const patching = controller.patchUsageNote({
      inputTokens: 800,
      outputTokens: 120,
      costUSD: 0.1,
      durationMs: 5000,
      numTurns: 2,
    });
    await Promise.all([completing, patching]);
    await backend.drain();

    const lastCard = String(
      mock.batchUpdate.mock.calls.at(-1)![0].data.actions,
    );
    expect(lastCard).toContain(CARD_ELEMENT_IDS.FOOTER_NOTE);
    expect(lastCard).toContain('输出 120');
    expect(lastCard).toContain('输入 800');
    controller.dispose();
  });

  test('split finalize plus usage arriving mid-complete still lands on the tail', async () => {
    const mock = makeClient();
    const controller = new StreamingCardController({
      client: mock.client as any,
      chatId: 'oc_split_race',
    });
    const body = Array.from(
      { length: 900 },
      (_, i) => `paragraph ${i} ${'a'.repeat(370)}`,
    ).join('\n\n');
    controller.append(body);
    await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));
    const backend = (controller as any).streamingBackend as {
      drain(): Promise<void>;
    };
    await backend.drain();

    const completing = controller.complete(body);
    const patching = controller.patchUsageNote({
      inputTokens: 2100,
      outputTokens: 880,
      costUSD: 0.55,
      durationMs: 18000,
      numTurns: 4,
    });
    await Promise.all([completing, patching]);
    await backend.drain();

    expect((controller as any).nativeCards.length).toBeGreaterThan(1);
    const rendered = mock.batchUpdate.mock.calls
      .map((call) => String(call[0].data.actions))
      .join('\n');
    expect(rendered).toContain('💰');
    expect(rendered).toContain('输出 880');
    controller.dispose();
  });

  test('multi-group split only patches the tail card with usage', async () => {
    const mock = makeClient();
    const controller = new StreamingCardController({
      client: mock.client as any,
      chatId: 'oc_split_groups',
    });
    const body = Array.from(
      { length: 900 },
      (_, i) => `block ${i} ${'b'.repeat(400)}`,
    ).join('\n\n');
    expect(Buffer.byteLength(body, 'utf-8')).toBeGreaterThan(16 * 1024);

    controller.append(body);
    await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));
    const backend = (controller as any).streamingBackend as {
      drain(): Promise<void>;
    };
    await backend.drain();

    await controller.complete(body);
    expect((controller as any).nativeCards.length).toBeGreaterThan(1);
    expect(mock.cardCreate.mock.calls.length).toBeGreaterThan(1);

    const updatesBeforeUsage = mock.cardUpdate.mock.calls.length;
    const batchesBeforeUsage = mock.batchUpdate.mock.calls.length;
    await controller.patchUsageNote({
      inputTokens: 900,
      outputTokens: 250,
      costUSD: 0.2,
      durationMs: 8000,
      numTurns: 2,
    });
    await backend.drain();

    expect(mock.cardUpdate.mock.calls.length).toBe(updatesBeforeUsage);
    const usageBatches = mock.batchUpdate.mock.calls.slice(batchesBeforeUsage);
    expect(usageBatches).toHaveLength(1);
    expect(usageBatches[0][0].path.card_id).toBe(
      (controller as any).streamingBackend.getCardId(),
    );
    const usageUpdates = usageBatches.map((call) =>
      String(call[0].data.actions),
    );
    expect(usageUpdates.length).toBeGreaterThan(0);
    expect(usageUpdates.some((card) => card.includes('💰'))).toBe(true);
    expect(usageUpdates.at(-1)).toContain('输出 250');
    controller.dispose();
  });

  test('aborted turns drop parked usage instead of patching later', async () => {
    const mock = makeClient();
    const controller = new StreamingCardController({
      client: mock.client as any,
      chatId: 'oc_abort_usage',
    });
    controller.append('进行中');
    await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));
    const backend = (controller as any).streamingBackend as {
      drain(): Promise<void>;
    };
    await backend.drain();

    await controller.patchUsageNote({
      inputTokens: 10,
      outputTokens: 4,
      costUSD: 0.01,
      durationMs: 100,
      numTurns: 1,
    });
    mock.cardUpdate.mockClear();
    await controller.abort('stopped');
    expect(controller.currentState).toBe('aborted');
    expect((controller as any).pendingUsage).toBeNull();
    const afterAbort = mock.cardUpdate.mock.calls
      .map((call) => String(call[0].data.card.data))
      .join('\n');
    expect(afterAbort).not.toContain('💰');
    controller.dispose();
  });

  test('completed tool duration stays fixed and cumulative totals survive display expiry', () => {
    const mock = makeClient();
    const controller = new StreamingCardController({
      client: mock.client as any,
      chatId: 'oc_tools',
    });
    const clock = vi.spyOn(Date, 'now');
    clock.mockReturnValue(1000);
    controller.startTool('old', 'Bash');
    clock.mockReturnValue(21000);
    controller.endTool('old', false);
    clock.mockReturnValue(50000);
    const view = (controller as any).buildRichPanelPatches();
    expect(view.toolsContent).toContain('20.0s');
    expect(view.toolsContent).not.toContain('49.0s');
    controller.startTool('new', 'Read');
    clock.mockReturnValue(60000);
    controller.endTool('new', false);
    expect((controller as any).toolCalls.has('old')).toBe(false);
    const finalCard = JSON.stringify(
      (controller as any).buildStructuredFinalCard('completed'),
    );
    expect(finalCard).toContain('Bash');
    expect(finalCard).toContain('Read');
    expect(finalCard).toContain('2 次');
    controller.dispose();
  });

  test('runtime details are inserted on demand, retain labels, and can be removed', async () => {
    const { controller, backend, batchUpdate, cardCreate } =
      await createThinkingController();
    expect(cardCreate.mock.calls[0][0].data.data).not.toContain(
      CARD_ELEMENT_IDS.DETAILS_PANEL,
    );
    const details = buildStreamingDetails({ toolsContent: '执行 Bash' })[0];
    await (backend as any).updateMarkdownContents(
      [{ elementId: CARD_ELEMENT_IDS.TOOLS_CONTENT, content: '执行 Bash' }],
      details,
    );
    const added = JSON.parse(batchUpdate.mock.calls.at(-1)![0].data.actions);
    expect(added[0].action).toBe('add_elements');
    expect(added[0].params.target_element_id).toBe(
      CARD_ELEMENT_IDS.INTERRUPT_BTN,
    );
    expect(added[0].params.elements[0].element_id).toBe(
      CARD_ELEMENT_IDS.DETAILS_PANEL,
    );
    await (backend as any).updateMarkdownContents(
      [{ elementId: CARD_ELEMENT_IDS.TOOLS_CONTENT, content: 'Bash 完成' }],
      details,
    );
    const patched = JSON.parse(batchUpdate.mock.calls.at(-1)![0].data.actions);
    expect(patched[0].params.partial_element.content).toContain('**');
    expect(patched[0].params.partial_element.content).toContain('Bash 完成');
    await (backend as any).updateMarkdownContents([], null);
    expect(JSON.parse(batchUpdate.mock.calls.at(-1)![0].data.actions)).toEqual([
      {
        action: 'delete_elements',
        params: { element_ids: [CARD_ELEMENT_IDS.DETAILS_PANEL] },
      },
    ]);
    controller.dispose();
  });

  test('interaction lock retries the same identity and preserves the stopped reply', async () => {
    const { controller, cardSettings, cardUpdate } =
      await createThinkingController();
    controller.append('已经生成的正文');
    cardSettings
      .mockResolvedValueOnce({ code: 200810, msg: 'ongoing interaction' })
      .mockResolvedValue({ code: 0 });
    await controller.abort('已停止');
    expect(cardSettings.mock.calls).toHaveLength(2);
    expect(cardSettings.mock.calls[0][0]).toEqual(
      cardSettings.mock.calls[1][0],
    );
    const final = String(cardUpdate.mock.calls.at(-1)![0].data.card.data);
    expect(final).toContain('已经生成的正文');
    expect(final).toContain('已停止');
    expect(final).not.toContain('interrupt_stream');
    controller.dispose();
  });

  test('degradation waits for settings ACK before transferring sequence ownership', async () => {
    const { controller, cardSettings, cardUpdate } =
      await createThinkingController();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    cardSettings.mockImplementationOnce(async () => {
      await pending;
      return { code: 0 };
    });
    (controller as any).degradeToV1();
    await vi.waitFor(() => expect(cardSettings).toHaveBeenCalledTimes(1));
    controller.append('交接中的正文');
    expect(cardUpdate).not.toHaveBeenCalled();
    release();
    await (controller as any).backendTransition;
    await controller.complete('最终正文');
    expect(cardUpdate.mock.calls[0][0].data.sequence).toBeGreaterThan(
      cardSettings.mock.calls[0][0].data.sequence,
    );
    expect(String(cardUpdate.mock.calls.at(-1)![0].data.card.data)).toContain(
      '最终正文',
    );
    controller.dispose();
  });

  test('a 12.5K reply remains one card and oversized revised text removes stale pages', async () => {
    const mock = makeClient();
    const snapshots: any[] = [];
    const controller = new StreamingCardController({
      client: mock.client as any,
      chatId: 'oc_revised_pages',
      lifecycle: { onEvent: (event) => snapshots.push(event) },
    });
    const paragraphs = Array.from({ length: 5 }, (_, i) => `${i}`.repeat(2500));
    const text = paragraphs.join('\n\n');
    controller.append(text);
    await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));
    await (controller as any).nativePageChain;
    expect((controller as any).nativeCards.length).toBe(1);
    const activeSnapshot = snapshots.at(-1).snapshot;
    expect(activeSnapshot.text).toBe(text);
    expect(streamingCardSnapshotText(activeSnapshot)).toBe(text);

    await controller.complete(text);
    const lastPerCard = new Map<string, any>();
    for (const [request] of mock.cardUpdate.mock.calls) {
      lastPerCard.set(request.path.card_id, JSON.parse(request.data.card.data));
    }
    const visible = [...lastPerCard.values()]
      .flatMap((card) => card.body.elements)
      .filter(
        (element) =>
          element.tag === 'markdown' &&
          (!element.element_id ||
            element.element_id === CARD_ELEMENT_IDS.MAIN_CONTENT ||
            String(element.element_id).startsWith('body_')),
      )
      .map((element) => element.content)
      .join('');
    for (const paragraph of paragraphs) expect(visible).toContain(paragraph);
    controller.dispose();

    const second = new StreamingCardController({
      client: mock.client as any,
      chatId: 'oc_retraction',
    });
    second.append(text.repeat(30));
    await vi.waitFor(() => expect(second.currentState).toBe('streaming'));
    await (second as any).nativePageChain;
    const createdCount = mock.cardCreate.mock.calls.length;
    await second.complete('修订后的最终答复');
    expect(mock.cardCreate.mock.calls.length).toBe(createdCount);
    expect((second as any).nativeCards[0].text).toBe('修订后的最终答复');
    expect(
      (second as any).nativeCards
        .slice(1)
        .every((page: any) => page.text === ''),
    ).toBe(true);
    const retired = String(
      mock.cardUpdate.mock.calls.at(-1)![0].data.card.data,
    );
    expect(retired).toContain('此页内容已更新');
    expect(retired).not.toContain('444444');
    expect(retired).not.toContain('interrupt_stream');
    second.dispose();
  });

  test.each(['complete', 'abort'] as const)(
    '%s fences an uncertain continuation ACK already in flight and never resends its page',
    async (terminal) => {
      const mock = makeClient();
      let sent = 0;
      let rejectContinuation!: (error: Error) => void;
      let continuationStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        continuationStarted = resolve;
      });
      mock.client.im.v1.message.create.mockImplementation(async () => {
        sent++;
        if (sent === 2) {
          continuationStarted();
          return new Promise((_resolve, reject) => {
            rejectContinuation = reject;
          });
        }
        return { data: { message_id: `om_${sent}` } };
      });
      const controller = new StreamingCardController({
        client: mock.client as any,
        chatId: `oc_native_ack_${terminal}`,
      });
      controller.append('初始正文');
      await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));
      const full = '续页正文。'.repeat(24000);
      controller.append(full);
      await started;
      const ending = (
        terminal === 'complete'
          ? controller.complete(full)
          : controller.abort('已停止')
      ).then(
        () => ({ ok: true, error: undefined }),
        (error) => ({ ok: false, error }),
      );
      await vi.waitFor(() =>
        expect(controller.currentState).toBe(
          terminal === 'complete' ? 'completed' : 'aborted',
        ),
      );
      rejectContinuation(
        new Error('timeout after provider accepted continuation'),
      );
      const result = await ending;
      expect(result.ok).toBe(false);
      expect(result.error).toMatchObject({ code: 'CHANNEL_DELIVERY_PARTIAL' });
      expect(sent).toBe(2);
      expect(mock.cardCreate).toHaveBeenCalledTimes(2);
      const creates = mock.cardCreate.mock.calls.length;
      const updates = mock.cardUpdate.mock.calls.length;
      await expect(controller.complete(full)).rejects.toBe(result.error);
      await expect(controller.abort('再次停止')).rejects.toBe(result.error);
      expect(sent).toBe(2);
      expect(mock.cardCreate.mock.calls.length).toBe(creates);
      expect(mock.cardUpdate.mock.calls.length).toBe(updates);
      controller.dispose();
    },
  );

  test.each(['v1', 'legacy'] as const)(
    '%s recovery keeps its actual long reply instead of an empty native projection',
    async (mode) => {
      const mock = makeClient();
      let creates = 0;
      mock.cardCreate.mockImplementation(async () => {
        creates++;
        if (creates === 1 || mode === 'legacy')
          throw new Error('native CardKit unavailable');
        return { code: 0, data: { card_id: `fallback_${creates}` } };
      });
      mock.client.im.v1.message.patch.mockResolvedValue({ code: 0 });
      const events: any[] = [];
      const controller = new StreamingCardController({
        client: mock.client as any,
        chatId: `oc_snapshot_${mode}`,
        lifecycle: { onEvent: (event) => events.push(event) },
      });
      const full = '恢复正文。'.repeat(1600);
      controller.append(full);
      await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));
      await (controller as any).patchCard('streaming');
      const snapshot = events.at(-1).snapshot;
      expect(snapshot.backendMode).toBe(mode);
      expect(snapshot.text).toBe(full);
      const rewrite = resolveInterruptedStreamingCardRewrite({ snapshot });
      expect(rewrite.hasBody).toBe(true);
      expect(rewrite.text).toContain('恢复正文');
      const expected =
        mode === 'v1'
          ? (controller as any).multiCard.getVisibleText(full)
          : full;
      expect(streamingCardSnapshotText(snapshot)).toBe(expected.trim());
      controller.dispose();
    },
  );

  test('a 40K live reply streams every character on one card and finalizes in place', async () => {
    const { controller, elementContent, cardCreate, cardUpdate } =
      await createThinkingController();
    const text = '完整正文'.repeat(10000);
    controller.append(text);
    await vi.waitFor(() =>
      expect(
        elementContent.mock.calls.some(
          ([request]) => request.data.content === text,
        ),
      ).toBe(true),
    );
    await (controller as any).nativePageChain;
    expect(cardCreate).toHaveBeenCalledOnce();
    await controller.complete(text);
    expect(cardCreate).toHaveBeenCalledOnce();
    const final = JSON.parse(cardUpdate.mock.calls.at(-1)![0].data.card.data);
    const contents = final.body.elements
      .filter((element: any) => element.tag === 'markdown')
      .map((element: any) => element.content)
      .join('');
    expect(contents).toContain(text);
    expect(contents).not.toContain('完成后将展示完整结果');
    controller.dispose();
  });

  test.each(['create', 'content', 'final'] as const)(
    'definite hidden-render capacity rejection during %s reduces pages without losing or resending visible text',
    async (phase) => {
      const mock = makeClient();
      const originalCreate = mock.cardCreate.getMockImplementation()!;
      const text = 'a'.repeat(90000);
      const rejected = { code: 200860, msg: 'card exceeds rendered capacity' };
      const bodySize = (card: any) =>
        card.body.elements
          .filter(
            (element: any) =>
              element.tag === 'markdown' &&
              (!element.element_id ||
                element.element_id === CARD_ELEMENT_IDS.MAIN_CONTENT ||
                element.element_id.startsWith('body_')),
          )
          .reduce(
            (sum: number, element: any) => sum + element.content.length,
            0,
          );
      let rejections = 0;
      const tooLarge = (length: number) => {
        if (length <= 65000) return false;
        rejections++;
        return true;
      };
      if (phase === 'create')
        mock.cardCreate.mockImplementation(async (request) =>
          tooLarge(bodySize(JSON.parse(request.data.data)))
            ? rejected
            : originalCreate(request),
        );
      if (phase === 'content')
        mock.elementContent.mockImplementation(async (request) =>
          request.path.element_id === CARD_ELEMENT_IDS.MAIN_CONTENT &&
          tooLarge(request.data.content.length)
            ? rejected
            : { code: 0 },
        );
      mock.cardUpdate.mockImplementation(async (request) =>
        tooLarge(bodySize(JSON.parse(request.data.card.data)))
          ? rejected
          : { code: 0 },
      );
      const controller = new StreamingCardController({
        client: mock.client as any,
        chatId: `oc_capacity_${phase}`,
      });
      controller.append(phase === 'create' ? text : 'initial');
      await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));
      if (phase !== 'create') {
        controller.append(text);
        await vi.waitFor(
          () =>
            expect((controller as any).nativeCanonicalText === text).toBe(true),
          { timeout: 5000 },
        );
      }
      await controller.complete(text);
      expect(rejections).toBeGreaterThan(0);
      expect((controller as any).backendMode).toBe('streaming');
      const pages = (controller as any).nativeCards;
      expect(pages.map((page: any) => page.text).join('')).toBe(text);
      expect(pages.every((page: any) => page.text.length <= 65000)).toBe(true);
      expect(mock.client.im.v1.message.create).toHaveBeenCalledTimes(
        pages.length,
      );
      for (const page of pages) {
        const sequences = mock.cardUpdate.mock.calls
          .filter(
            ([request]) => request.path.card_id === page.backend.getCardId(),
          )
          .map(([request]) => request.data.sequence);
        expect(sequences).toEqual([...sequences].sort((a, b) => a - b));
        expect(new Set(sequences).size).toBe(sequences.length);
      }
      const updates = mock.cardUpdate.mock.calls.length;
      await controller.patchUsageNote({
        inputTokens: 1000,
        outputTokens: 200,
        costUSD: 0.1,
        durationMs: 5000,
        numTurns: 1,
      });
      expect(mock.cardUpdate).toHaveBeenCalledTimes(updates);
      expect(mock.batchUpdate.mock.calls.at(-1)![0].path.card_id).toBe(
        pages.at(-1).backend.getCardId(),
      );
      controller.dispose();
    },
  );

  test('append freezes acknowledged prefix pages and only streams the growing tail', async () => {
    const mock = makeClient();
    const controller = new StreamingCardController({
      client: mock.client as any,
      chatId: 'oc_stable_prefix',
    });
    const text = 'prefix\n\n' + 'a'.repeat(400000);
    controller.append(text);
    await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));
    await (controller as any).nativePageChain;
    const first = (controller as any).nativeCards[0];
    const frozenText = first.text;
    const frozenEnd = first.rawEnd;
    mock.cardUpdate.mockClear();
    controller.append(text + 'TAIL'.repeat(1000));
    await vi.waitFor(() =>
      expect((controller as any).nativeCanonicalText).toBe(
        text + 'TAIL'.repeat(1000),
      ),
    );
    expect(first.text).toBe(frozenText);
    expect(first.rawEnd).toBe(frozenEnd);
    expect(
      mock.cardUpdate.mock.calls.some(
        ([request]) => request.path.card_id === first.backend.getCardId(),
      ),
    ).toBe(false);
    expect(mock.cardCreate).toHaveBeenCalledTimes(2);
    // The second page has a lower provider-rendered limit. Shrinking that
    // page must not touch the already acknowledged first card.
    const tailId = (controller as any).streamingBackend.getCardId();
    mock.elementContent.mockImplementation(async (request) =>
      request.path.card_id === tailId &&
      /^main_content/.test(request.path.element_id)
        ? { code: 200860, msg: 'rendered card over max size' }
        : { code: 0 },
    );
    mock.cardUpdate.mockImplementation(async (request) =>
      request.path.card_id === tailId &&
      JSON.stringify(request.data.card).length > 65000
        ? { code: 200860, msg: 'rendered card over max size' }
        : { code: 0 },
    );
    const grown = text + 'TAIL'.repeat(1001);
    controller.append(grown);
    await vi.waitFor(
      () =>
        expect((controller as any).nativeCanonicalText === grown).toBe(true),
      { timeout: 5000 },
    );
    expect((controller as any).nativeCapacityScale).toBeLessThan(1);
    expect(first.rawEnd).toBe(frozenEnd);
    expect(first.text).toBe(frozenText);
    expect(
      mock.cardUpdate.mock.calls.some(
        ([request]) => request.path.card_id === first.backend.getCardId(),
      ),
    ).toBe(false);
    expect(
      (controller as any).nativeCards.map((page: any) => page.text).join(''),
    ).toBe(grown);
    // Retired cards remain in the delivery ledger but cannot freeze a newly
    // shortened active page when the canonical reducer appends again.
    controller.append('small');
    await vi.waitFor(() =>
      expect((controller as any).nativeCanonicalText).toBe('small'),
    );
    controller.append('small extended');
    await vi.waitFor(() =>
      expect((controller as any).nativeCanonicalText).toBe('small extended'),
    );
    expect(
      (controller as any).nativeCards.filter((page: any) => page.text !== ''),
    ).toHaveLength(1);
    expect((controller as any).nativeCards[0].text).toBe('small extended');
    controller.dispose();
  });

  test('the real 90-item answer fits one card and retains its original tail', async () => {
    const text = readFileSync(
      new URL('./fixtures/feishu-card-long-answer.txt', import.meta.url),
      'utf8',
    );
    expect(Buffer.byteLength(text)).toBeGreaterThan(25000);
    const mock = makeClient();
    const controller = new StreamingCardController({
      client: mock.client as any,
      chatId: 'oc_real_answer',
    });
    controller.append(text);
    await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));
    await (controller as any).nativePageChain;
    expect(mock.cardCreate).toHaveBeenCalledOnce();
    expect((controller as any).nativeCards[0].text).toBe(text);
    expect(
      findElementContent(
        JSON.parse(mock.cardCreate.mock.calls[0][0].data.data),
        CARD_ELEMENT_IDS.MAIN_CONTENT,
      ),
    ).toBe(text);
    await controller.complete(text);
    expect(mock.cardCreate).toHaveBeenCalledOnce();
    expect((controller as any).nativeCards[0].text).toBe(text);
    const rendered = JSON.stringify(
      JSON.parse(mock.cardUpdate.mock.calls.at(-1)![0].data.card.data),
    );
    expect(rendered).toContain(text.trimEnd().split('\n').at(-1));
    controller.dispose();
  });

  test('200K ASCII uses native Markdown slots inside one card, adds a growing tail, and removes stale slots on revision', async () => {
    const { controller, cardCreate, elementContent, batchUpdate } =
      await createThinkingController();
    const text = 'a'.repeat(200000);
    controller.append(text);
    await vi.waitFor(
      () => expect((controller as any).nativeCanonicalText === text).toBe(true),
      { timeout: 5000 },
    );
    expect(cardCreate).toHaveBeenCalledOnce();
    const contents = elementContent.mock.calls.filter(([request]) =>
      /^main_content(?:_\d+)?$/.test(request.path.element_id),
    );
    expect(contents.map(([request]) => request.data.content).join('')).toBe(
      text,
    );
    expect(
      contents.every(
        ([request]) =>
          Array.from(request.data.content).length <= CARDKIT_MARKDOWN_MAX_CHARS,
      ),
    ).toBe(true);
    expect(contents.map(([request]) => request.path.element_id)).toEqual([
      'main_content',
      'main_content_1',
      'main_content_2',
    ]);
    expect(
      batchUpdate.mock.calls.some(([request]) =>
        JSON.parse(request.data.actions).some(
          (action: any) =>
            action.action === 'add_elements' &&
            action.params.elements.some(
              (element: any) => element.element_id === 'main_content_1',
            ),
        ),
      ),
    ).toBe(true);
    elementContent.mockClear();
    controller.append(text + 'TAIL');
    await vi.waitFor(() =>
      expect((controller as any).nativeCanonicalText).toBe(text + 'TAIL'),
    );
    expect(elementContent).toHaveBeenCalledOnce();
    expect(elementContent.mock.calls[0][0].path.element_id).toBe(
      'main_content_2',
    );
    controller.append('revised answer');
    await vi.waitFor(() =>
      expect((controller as any).nativeCanonicalText).toBe('revised answer'),
    );
    expect(
      batchUpdate.mock.calls.some(([request]) =>
        JSON.parse(request.data.actions).some(
          (action: any) =>
            action.action === 'delete_elements' &&
            action.params.element_ids.includes('main_content_2'),
        ),
      ),
    ).toBe(true);
    expect(cardCreate).toHaveBeenCalledOnce();
    await controller.complete('revised answer');
    controller.dispose();
  });

  test.each([
    ['add_elements', 'complete'],
    ['add_elements', 'abort'],
    ['delete_elements', 'complete'],
    ['delete_elements', 'abort'],
  ] as const)(
    '%s unknown ACK fences concurrent %s without publishing another body',
    async (action, terminal) => {
      const mock = makeClient();
      const controller = new StreamingCardController({
        client: mock.client as any,
        chatId: `oc_slots_ack_${action}_${terminal}`,
      });
      const long = 'a'.repeat(200000);
      controller.append(action === 'add_elements' ? 'initial' : long);
      await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));
      await (controller as any).nativePageChain;
      let release!: (error: Error) => void;
      let signal!: () => void;
      const started = new Promise<void>((resolve) => {
        signal = resolve;
      });
      mock.batchUpdate.mockImplementation(async (request) => {
        if (
          JSON.parse(request.data.actions).some(
            (entry: any) =>
              entry.action === action &&
              (entry.params.elements?.some((element: any) =>
                /^main_content_/.test(element.element_id),
              ) ||
                entry.params.element_ids?.some((id: string) =>
                  /^main_content_/.test(id),
                )),
          )
        ) {
          signal();
          return new Promise((_resolve, reject) => {
            release = reject;
          });
        }
        return { code: 0 };
      });
      const text = action === 'add_elements' ? long : 'revised';
      controller.append(text);
      await started;
      const ending = (
        terminal === 'complete'
          ? controller.complete(text)
          : controller.abort('stopped')
      ).then(
        () => ({ ok: true, error: undefined }),
        (error) => ({ ok: false, error }),
      );
      const contents = mock.elementContent.mock.calls.length;
      const updates = mock.cardUpdate.mock.calls.length;
      release(new Error('provider accepted body structure but ACK was lost'));
      const result = await ending;
      expect(result.ok).toBe(false);
      expect(result.error).toMatchObject({ code: 'CHANNEL_DELIVERY_PARTIAL' });
      expect(mock.cardCreate).toHaveBeenCalledOnce();
      expect(mock.client.im.v1.message.create).toHaveBeenCalledOnce();
      expect(mock.elementContent).toHaveBeenCalledTimes(contents);
      expect(mock.cardUpdate).toHaveBeenCalledTimes(updates);
      controller.dispose();
    },
  );
});
