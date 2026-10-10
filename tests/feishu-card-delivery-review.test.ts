/**
 * Regression tests for the Feishu outbound review (streaming cards, card
 * building, delivery policy). Provider errors use the real Lark SDK shape:
 * HTTP 4xx rejects with an AxiosError whose `code` is 'ERR_BAD_REQUEST' and
 * whose Feishu business code sits in `response.data.code`.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  FeishuCardContentRejectedError,
  StreamingCardController,
  extractTitleAndBody,
  getStreamingSession,
  reconcileInterruptedStreamingCard,
  registerStreamingSession,
  splitCodeBlockSafe,
  unregisterStreamingSession,
} from '../src/feishu-streaming-card.js';
import { finalizeChannelCardAfterDelivery } from '../src/channel-card-finalization.js';
import { classifyImSendFailure } from '../src/im-send-retry-policy.js';
import { streamingCardRecoveryPageBody } from '../src/channel-reliability-recovery.js';
import {
  countMarkdownTables,
  splitCardPages,
} from '../src/feishu-cards/pagination.js';
import {
  buildAgentReplyCard,
  buildStreamingAgentCard,
} from '../src/feishu-cards/builder.js';
import {
  CARDKIT_JSON_MAX_BYTES,
  fitsCardCapacity,
} from '../src/feishu-cards/capacity.js';
import { executeFeishuCapability } from '../src/feishu-capability.js';
import { neutralizeRejectedCardMarkdown } from '../src/feishu-card-delivery.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function axiosRejection(
  status: number,
  code: number,
  headers: Record<string, string> = {},
) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    name: 'AxiosError',
    isAxiosError: true,
    code: 'ERR_BAD_REQUEST',
    response: { status, headers, data: { code, msg: 'rejected' } },
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function makeClient() {
  let cardSeq = 0;
  let messageSeq = 0;
  const cardCreate = vi.fn(
    async (_request: any): Promise<any> => ({
      code: 0,
      data: { card_id: `card_${++cardSeq}` },
    }),
  );
  const cardSettings = vi.fn(
    async (_request: any): Promise<any> => ({
      code: 0,
    }),
  );
  const cardUpdate = vi.fn(
    async (_request: any): Promise<any> => ({
      code: 0,
    }),
  );
  const batchUpdate = vi.fn(
    async (_request: any): Promise<any> => ({
      code: 0,
    }),
  );
  const elementContent = vi.fn(
    async (_request: any): Promise<any> => ({
      code: 0,
    }),
  );
  const messageCreate = vi.fn(
    async (_request: any): Promise<any> => ({
      code: 0,
      data: { message_id: `om_${++messageSeq}` },
    }),
  );
  const messageReply = vi.fn(
    async (_request: any): Promise<any> => ({
      code: 0,
      data: { message_id: `om_reply_${++messageSeq}` },
    }),
  );
  const messagePatch = vi.fn(
    async (_request: any): Promise<any> => ({
      code: 0,
    }),
  );
  const client = {
    cardkit: {
      v1: {
        card: {
          create: cardCreate,
          settings: cardSettings,
          update: cardUpdate,
          batchUpdate,
        },
        cardElement: {
          content: elementContent,
          update: vi.fn(async () => ({ code: 0 })),
        },
      },
    },
    im: {
      message: { reply: messageReply },
      v1: { message: { create: messageCreate, patch: messagePatch } },
    },
  };
  return {
    client: client as any,
    cardCreate,
    cardSettings,
    cardUpdate,
    batchUpdate,
    elementContent,
    messageCreate,
    messageReply,
    messagePatch,
  };
}

async function streamingController(
  mock: ReturnType<typeof makeClient>,
  text = '开始',
  extra: Record<string, unknown> = {},
) {
  const events: any[] = [];
  const controller = new StreamingCardController({
    client: mock.client,
    chatId: 'oc_review',
    lifecycle: { onEvent: (event) => events.push(event) },
    ...extra,
  });
  controller.append(text);
  await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));
  await (controller as any).nativePageChain;
  await (controller as any).streamingBackend?.drain();
  return { controller, events, internal: controller as any };
}

/** Last full card JSON written per card id (create, then updates). */
function lastCardPerId(
  mock: ReturnType<typeof makeClient> & { created?: Map<string, any> },
) {
  const cards = new Map<string, any>(mock.created ?? []);
  for (const [request] of mock.cardUpdate.mock.calls)
    cards.set(request.path.card_id, JSON.parse(request.data.card.data));
  return cards;
}

function markdownContents(card: unknown): string[] {
  const out: string[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      const node = value as Record<string, unknown>;
      if (node.tag === 'markdown' && typeof node.content === 'string')
        out.push(node.content);
      Object.values(node).forEach(visit);
    }
  };
  visit(card);
  return out;
}

/** `<at` anywhere outside fenced code. */
function rawMentionOutsideCode(markdown: string): boolean {
  return /<at\b/i.test(markdown.replace(/```[\s\S]*?```/g, ''));
}

describe('P0-1 CardKit streaming-mode expiry', () => {
  test.each([300309, 200850])(
    'an AxiosError %s re-enables streaming instead of degrading or splitting',
    async (code) => {
      const mock = makeClient();
      let streamingOn = true;
      mock.cardSettings.mockImplementation(async (request: any) => {
        streamingOn = /"streaming_mode":true/.test(request.data.settings);
        return { code: 0 };
      });
      mock.elementContent.mockImplementation(async () => {
        if (!streamingOn) throw axiosRejection(400, code);
        return { code: 0 };
      });
      const { controller, internal } = await streamingController(mock);
      streamingOn = false; // the 10-minute window elapsed provider-side
      let text = '开始';
      for (let i = 0; i < 3; i++) {
        text += `\n第${i}段 ${'内容'.repeat(40)}`;
        controller.append(text);
        await sleep(700);
      }
      await vi.waitFor(() =>
        expect(
          mock.cardSettings.mock.calls.some((call) =>
            /"streaming_mode":true/.test(call[0].data.settings),
          ),
        ).toBe(true),
      );
      await internal.nativePageChain;
      expect(internal.backendMode).toBe('streaming');
      expect(internal.nativeFullUpdates).toBe(false);
      expect(internal.patchFailCount).toBe(0);
      expect(mock.cardUpdate).not.toHaveBeenCalled();
      expect(
        mock.elementContent.mock.calls.some((call) =>
          String(call[0].data.content).includes('第2段'),
        ),
      ).toBe(true);
      await controller.complete(text);
      expect(mock.messageCreate).toHaveBeenCalledTimes(1);
      controller.dispose();
    },
    15_000,
  );

  test('streaming mode is renewed shortly before its 10-minute expiry', async () => {
    const mock = makeClient();
    const { controller, internal } = await streamingController(mock);
    mock.cardSettings.mockClear();
    mock.elementContent.mockClear();
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 9 * 60_000 + 1);
    await internal.streamingBackend.streamContent('续写的正文');
    expect(mock.cardSettings).toHaveBeenCalledTimes(1);
    expect(mock.cardSettings.mock.calls[0][0].data.settings).toContain(
      '"streaming_mode":true',
    );
    expect(mock.elementContent).toHaveBeenCalledTimes(1);
    expect(mock.elementContent.mock.calls[0][0].data.sequence).toBeGreaterThan(
      mock.cardSettings.mock.calls[0][0].data.sequence,
    );
    controller.dispose();
  });

  test('a forced degradation keeps native pages and sends no new messages', async () => {
    const mock = makeClient();
    const para = '长篇报告段落内容，用于模拟十分钟以上的持续输出。'.repeat(8);
    let text = '# 报告\n';
    for (let i = 0; i < 300; i++) text += `\n\n${i}. ${para}`;
    const { controller, internal } = await streamingController(mock, text);
    const sentBefore = mock.messageCreate.mock.calls.length;
    internal.degradeToV1();
    await internal.backendTransition;
    text += `\n\n追加. ${para}`;
    controller.append(text);
    await sleep(1200);
    await internal.nativePageChain;
    expect(internal.backendMode).toBe('streaming');
    expect(internal.nativeFullUpdates).toBe(true);
    await controller.complete(text);
    expect(mock.messageCreate.mock.calls.length).toBe(sentBefore);
    controller.dispose();
  });
});

function v1Client() {
  const mock = makeClient();
  let first = true;
  mock.cardCreate.mockImplementation(async (request: any) => {
    if (first) {
      first = false;
      throw new Error('streaming card unavailable');
    }
    const cardId = `card_v1_${mock.cardCreate.mock.calls.length}`;
    created.set(cardId, JSON.parse(request.data.data));
    return { code: 0, data: { card_id: cardId } };
  });
  const created = new Map<string, any>();
  return Object.assign(mock, { created });
}

describe('P1-1 v1 terminal render is idempotent', () => {
  test('a later usage patch only re-renders the last card footer', async () => {
    const mock = v1Client();
    const controller = new StreamingCardController({
      client: mock.client,
      chatId: 'oc_v1_usage',
    });
    controller.append('# 标题\n开始');
    await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));
    expect((controller as any).backendMode).toBe('v1');
    const para = '这是一个用于验证终态续卡渲染的中文段落。'.repeat(10);
    const body = Array.from({ length: 30 }, (_, i) => `${i}. ${para}`).join(
      '\n\n',
    );
    const finalText = `# 标题\n${body}`;
    await controller.complete(finalText);
    const messages = mock.messageCreate.mock.calls.length;
    expect(messages).toBe(2);
    const before = lastCardPerId(mock);
    const cardIds = [...before.keys()];

    await controller.patchUsageNote({
      inputTokens: 1,
      outputTokens: 2,
      costUSD: 0,
      durationMs: 1000,
      numTurns: 1,
    });
    expect(mock.messageCreate.mock.calls.length).toBe(messages);
    const after = lastCardPerId(mock);
    const lastId = cardIds.at(-1)!;
    for (const id of cardIds.slice(0, -1))
      expect(after.get(id)).toEqual(before.get(id));
    const paragraphs = (card: any) =>
      [
        ...markdownContents(card)
          .join('')
          .matchAll(/(\d+)\. 这是/g),
      ].map((m) => m[1]);
    expect(paragraphs(after.get(lastId))).toEqual(
      paragraphs(before.get(lastId)),
    );
    expect(markdownContents(after.get(lastId)).join('')).toContain('💰');
    const all = cardIds.flatMap((id) => paragraphs(after.get(id)));
    expect(all).toEqual(Array.from({ length: 30 }, (_, i) => String(i)));
    controller.dispose();
  });
});

describe('P1-2 <at> neutralization on every card surface', () => {
  test('answer, panels and final card never carry a raw mention outside code', async () => {
    const mock = makeClient();
    const answer =
      '提醒 <at id=all></at> 和 <at email=ceo@corp.com></at>\n\n```\n<at id=all></at>\n```';
    const { controller, internal } = await streamingController(mock, answer);
    controller.appendThinking('思考 <at user_id="all"></at>');
    controller.startTool('t1', 'Bash');
    controller.updateToolSummary('t1', 'echo "</font><at id=all></at>" | grep');
    controller.setTodos([
      { id: '1', content: '<at id=all></at> 任务', status: 'in_progress' },
    ]);
    controller.updateTask('task_1', { title: '<at id=all></at>' });
    controller.pushRecentEvent('↳ 结果 <at id=all></at>');
    controller.setSystemStatus('<at id=all></at>');
    await sleep(1800);
    await internal.nativePageChain;
    await internal.streamingBackend.drain();
    await controller.complete(answer);

    const payloads = [
      ...mock.cardCreate.mock.calls.map((call) =>
        JSON.parse(call[0].data.data),
      ),
      ...mock.cardUpdate.mock.calls.map((call) =>
        JSON.parse(call[0].data.card.data),
      ),
      ...mock.elementContent.mock.calls.map((call) => ({
        tag: 'markdown',
        content: call[0].data.content,
      })),
      ...mock.batchUpdate.mock.calls.flatMap((call) =>
        JSON.parse(call[0].data.actions),
      ),
    ];
    const contents = payloads.flatMap((payload) => [
      ...markdownContents(payload),
      ...JSON.stringify(payload).match(/"content":"[^"]*"/g)!,
    ]);
    expect(contents.length).toBeGreaterThan(0);
    for (const content of contents)
      expect(rawMentionOutsideCode(content)).toBe(false);
    const final = JSON.stringify(
      JSON.parse(mock.cardUpdate.mock.calls.at(-1)![0].data.card.data),
    );
    expect(final).toContain('&#60;at id=all');
    // Code blocks stay verbatim.
    expect(final).toContain('```\\n<at id=all></at>\\n```');
    controller.dispose();
  });

  test.each(['v1', 'legacy'] as const)(
    '%s cards neutralize mentions in body and title',
    async (mode) => {
      const mock = makeClient();
      mock.cardCreate.mockImplementation(async () => {
        if (mode === 'legacy' || mock.cardCreate.mock.calls.length === 1)
          throw new Error('CardKit unavailable');
        return { code: 0, data: { card_id: 'card_v1' } };
      });
      const controller = new StreamingCardController({
        client: mock.client,
        chatId: `oc_${mode}_mention`,
      });
      const text = '<at id=all></at> 标题行\n\n正文 <at id=all></at>';
      controller.append(text);
      await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));
      await controller.complete(text);
      const sent = [
        ...mock.messageCreate.mock.calls.map((call) => call[0].data.content),
        ...mock.cardUpdate.mock.calls.map((call) => call[0].data.card.data),
        ...mock.messagePatch.mock.calls.map((call) => call[0].data.content),
        ...mock.cardCreate.mock.calls
          .filter((call) => call[0]?.data?.data)
          .map((call) => call[0].data.data),
      ];
      expect(sent.length).toBeGreaterThan(0);
      for (const payload of sent)
        expect(/<at\b/.test(String(payload))).toBe(false);
      controller.dispose();
    },
  );
});

describe('P1-3 Markdown tables count toward card capacity', () => {
  test('v1 cards hold at most four Markdown tables each', async () => {
    const mock = v1Client();
    const controller = new StreamingCardController({
      client: mock.client,
      chatId: 'oc_v1_tables',
    });
    controller.append('开始');
    await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));
    const text = Array.from(
      { length: 10 },
      (_, i) => `### 表 ${i}\n\n| 列${i} | 值 |\n|---|---|\n| a${i} | ${i} |\n`,
    ).join('\n');
    await controller.complete(text);
    const cards = [...lastCardPerId(mock).values()];
    expect(cards.length).toBeGreaterThanOrEqual(3);
    const seen = new Set<string>();
    for (const card of cards) {
      const contents = markdownContents(card);
      expect(
        contents.reduce(
          (sum, content) => sum + countMarkdownTables(content),
          0,
        ),
      ).toBeLessThanOrEqual(4);
      for (const content of contents)
        for (const m of content.matchAll(/\| a(\d) \|/g)) seen.add(m[1]);
    }
    expect(seen.size).toBe(10);
    controller.dispose();
  });

  test('11310 / 230099 batch rejections are not resent as-is', async () => {
    const mock = makeClient();
    const { controller, internal } = await streamingController(mock);
    mock.batchUpdate.mockReset();
    mock.batchUpdate.mockRejectedValue(axiosRejection(400, 230099, {}));
    mock.elementContent.mockResolvedValue({ code: 0 });
    await internal.streamingBackend.updateMarkdownContents([
      { elementId: 'status_banner', content: '仍在运行' },
    ]);
    expect(mock.batchUpdate).toHaveBeenCalledTimes(1);
    controller.dispose();
  });
});

describe('P1-4 explicit rejection of the final card', () => {
  const tableText =
    '答复 <at id=all></at>\n\n![img](img_bad_key)\n\n' +
    Array.from(
      { length: 3 },
      (_, i) => `| h${i} | v |\n|---|---|\n| a | b |\n`,
    ).join('\n');

  test('a refused final body is retried neutrally on the same card', async () => {
    const mock = makeClient();
    const { controller, events } = await streamingController(mock, tableText);
    mock.cardUpdate.mockRejectedValueOnce(axiosRejection(400, 230099, {}));
    await expect(controller.complete(tableText)).resolves.toBeUndefined();
    const last = mock.cardUpdate.mock.calls.at(-1)![0];
    expect(last.path.card_id).toBe(
      mock.cardUpdate.mock.calls[0][0].path.card_id,
    );
    const body = markdownContents(JSON.parse(last.data.card.data)).join('\n');
    expect(body).toContain('答复');
    expect(body).not.toContain('![img]');
    expect(body).toContain('```text');
    expect(rawMentionOutsideCode(body)).toBe(false);
    expect(mock.messageCreate).toHaveBeenCalledTimes(1);
    expect(events.at(-1).status).toBe('completed');
    controller.dispose();
  });

  test('a refused neutral body closes the card with a notice and hands the reply to the host', async () => {
    const mock = makeClient();
    const { controller, events } = await streamingController(mock, tableText);
    mock.cardUpdate.mockImplementation(async (request: any) => {
      if (String(request.data.card.data).includes('答复'))
        throw axiosRejection(400, 230099, {});
      return { code: 0 };
    });
    const providerCalls = () =>
      mock.cardUpdate.mock.calls.length + mock.messageCreate.mock.calls.length;
    const result = await finalizeChannelCardAfterDelivery(
      controller,
      tableText,
      true,
      'x',
    );
    expect(result.acknowledged).toBe(false);
    expect(result.error).toBeInstanceOf(FeishuCardContentRejectedError);
    const error = result.error as FeishuCardContentRejectedError;
    expect(error.name).toBe('FeishuCardContentRejectedError');
    expect(error.undeliveredText).toBe(tableText);
    expect(error.cardTerminalized).toBe(true);
    expect(error.feishuCode).toBe(230099);
    expect(classifyImSendFailure(error)).toBe('rejected');
    expect((error.cause as any).response.data.code).toBe(230099);
    const final = JSON.parse(
      mock.cardUpdate.mock.calls.at(-1)![0].data.card.data,
    );
    const finalJson = JSON.stringify(final);
    expect(finalJson).toContain('内容无法以卡片展示');
    expect(finalJson).not.toContain('interrupt_stream');
    expect(mock.messageCreate).toHaveBeenCalledTimes(1);
    // The durable record is terminal and the card no longer shows a skeleton.
    expect(events.at(-1).status).toBe('failed');
    const calls = providerCalls();
    await expect(controller.abort('again')).rejects.toBe(error);
    await expect(controller.complete(tableText)).rejects.toBe(error);
    expect(providerCalls()).toBe(calls);
    controller.dispose();
  });

  test('when even the notice fails the record stays non-terminal for recovery', async () => {
    const mock = makeClient();
    const { controller, events } = await streamingController(mock, tableText);
    mock.cardUpdate.mockRejectedValue(axiosRejection(400, 230099, {}));
    const error = await controller.complete(tableText).then(
      () => undefined,
      (e) => e,
    );
    expect(error).toBeInstanceOf(FeishuCardContentRejectedError);
    expect(error.cardTerminalized).toBe(false);
    // The host decides how to settle an unterminalized card; the card side
    // only reports an explicit (not ambiguous) refusal.
    expect(error.deliveryPhase).toBe('rejected');
    expect(['completed', 'aborted', 'failed']).not.toContain(
      events.at(-1).status,
    );
    controller.dispose();
  });

  test.each(['v1', 'legacy'] as const)(
    '%s final rejection follows the same neutral → notice policy',
    async (mode) => {
      const mock = makeClient();
      mock.cardCreate.mockImplementation(async () => {
        if (mode === 'legacy' || mock.cardCreate.mock.calls.length === 1)
          throw new Error('CardKit unavailable');
        return { code: 0, data: { card_id: 'card_v1' } };
      });
      const rejectBody = async (payload: string) => {
        if (payload.includes('答复')) throw axiosRejection(400, 230099, {});
        return { code: 0 };
      };
      mock.cardUpdate.mockImplementation(async (request: any) =>
        rejectBody(String(request.data.card.data)),
      );
      mock.messagePatch.mockImplementation(async (request: any) =>
        rejectBody(String(request.data.content)),
      );
      const controller = new StreamingCardController({
        client: mock.client,
        chatId: `oc_${mode}_reject`,
      });
      controller.append('开始');
      await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));
      const error = await controller.complete(tableText).then(
        () => undefined,
        (e) => e,
      );
      expect(error).toBeInstanceOf(FeishuCardContentRejectedError);
      expect(error.undeliveredText).toContain('答复');
      expect(error.cardTerminalized).toBe(true);
      expect(classifyImSendFailure(error)).toBe('rejected');
      const lastPayload =
        mode === 'v1'
          ? mock.cardUpdate.mock.calls.at(-1)![0].data.card.data
          : mock.messagePatch.mock.calls.at(-1)![0].data.content;
      expect(String(lastPayload)).toContain('内容无法以卡片展示');
      expect(mock.messageCreate).toHaveBeenCalledTimes(1);
      controller.dispose();
    },
  );
});

describe('cross-review M3: only body refusals take the neutral/notice path', () => {
  const body = '答复正文\n\n| h | v |\n|---|---|\n| a | b |\n';

  test.each([
    ['300317 sequence conflict', () => axiosRejection(400, 300317, {})],
    [
      '11310 interaction lock',
      () =>
        Object.assign(axiosRejection(400, 230099, {}), {
          response: {
            status: 400,
            headers: {},
            data: {
              code: 230099,
              msg: 'Failed to create card content, ErrCode: 11310; ErrMsg: card action lock',
            },
          },
        }),
    ],
    ['300311 permission', () => axiosRejection(400, 300311, {})],
  ])(
    '%s keeps the ordinary error path without a neutral retry',
    async (_name, make) => {
      const mock = makeClient();
      const { controller } = await streamingController(mock, body);
      mock.cardUpdate.mockClear();
      mock.cardUpdate.mockImplementation(async () => {
        throw make();
      });
      const error = await controller.complete(body).then(
        () => undefined,
        (e) => e,
      );
      expect(error).not.toBeInstanceOf(FeishuCardContentRejectedError);
      expect(error).toMatchObject({ code: 'CHANNEL_DELIVERY_PARTIAL' });
      expect(mock.cardUpdate).toHaveBeenCalledTimes(1);
      const payload = String(mock.cardUpdate.mock.calls[0][0].data.card.data);
      expect(payload).not.toContain('```text');
      controller.dispose();
    },
  );

  test.each([
    [
      '230099 table limit',
      () =>
        Object.assign(axiosRejection(400, 230099, {}), {
          response: {
            status: 400,
            headers: {},
            data: {
              code: 230099,
              msg: 'Failed to create card content, ErrCode: 11310; ErrMsg: card table number over limit',
            },
          },
        }),
    ],
    ['200621 card JSON', () => axiosRejection(400, 200621, {})],
    ['200570 image key', () => axiosRejection(400, 200570, {})],
  ])('%s is retried once in the neutral rendering', async (_name, make) => {
    const mock = makeClient();
    const { controller } = await streamingController(mock, body);
    mock.cardUpdate.mockClear();
    mock.cardUpdate.mockRejectedValueOnce(make());
    await expect(controller.complete(body)).resolves.toBeUndefined();
    expect(mock.cardUpdate).toHaveBeenCalledTimes(2);
    expect(String(mock.cardUpdate.mock.calls[1][0].data.card.data)).toContain(
      '```text',
    );
    controller.dispose();
  });

  test('three refused updates never put the body on the card twice, and recovery after static delivery writes only a notice', async () => {
    const mock = makeClient();
    const { controller, events } = await streamingController(mock, body);
    mock.cardUpdate.mockClear();
    mock.cardUpdate.mockRejectedValue(axiosRejection(400, 230099, {}));
    const error = await controller.complete(body).then(
      () => undefined,
      (e) => e,
    );
    expect(error).toBeInstanceOf(FeishuCardContentRejectedError);
    expect(error.cardTerminalized).toBe(false);
    const attempts = mock.cardUpdate.mock.calls.map((call) =>
      String(call[0].data.card.data),
    );
    expect(attempts).toHaveLength(3);
    // Original body, neutral body, then a notice without the body.
    expect(attempts.filter((data) => data.includes('答复正文'))).toHaveLength(
      2,
    );
    expect(attempts[2]).not.toContain('答复正文');
    // The record stays non-terminal; the host sends the body statically and
    // marks the record. Restart recovery must then only write a notice.
    expect(['completed', 'aborted', 'failed']).not.toContain(
      events.at(-1).status,
    );
    const update = vi.fn(async (_request: any) => ({ code: 0 }));
    await reconcileInterruptedStreamingCard(
      {
        cardkit: {
          v1: { card: { settings: vi.fn(async () => ({ code: 0 })), update } },
        },
      } as any,
      {
        messageId: 'om_1',
        cardId: 'card_1',
        version: events.at(-1).version,
        snapshot: { text: body, staticFallbackDelivered: true },
      },
    );
    expect(update).toHaveBeenCalledTimes(1);
    const written = String(update.mock.calls[0][0].data.card.data);
    expect(written).not.toContain('答复正文');
    expect(written).toContain('完整回复已通过下方消息发送');
    controller.dispose();
  });
});

describe('cross-review should-fix 5/6/18', () => {
  const longCode = '```ts\n' + 'const value = 1;\n'.repeat(25000) + '```';

  async function twoPageController(mock: ReturnType<typeof makeClient>) {
    const controller = new StreamingCardController({
      client: mock.client,
      chatId: 'oc_two_pages',
    });
    controller.append(longCode);
    await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));
    await (controller as any).nativePageChain;
    expect((controller as any).nativeCards.length).toBe(2);
    return controller;
  }

  test('a refused later page hands over its self-contained page text', async () => {
    const mock = makeClient();
    const controller = await twoPageController(mock);
    mock.cardUpdate.mockImplementation(async (request: any) => {
      if (
        request.path.card_id === 'card_2' &&
        String(request.data.card.data).includes('const value')
      )
        throw axiosRejection(400, 230099, {});
      return { code: 0 };
    });
    const error = await controller.complete(longCode).then(
      () => undefined,
      (e) => e,
    );
    expect(error).toBeInstanceOf(FeishuCardContentRejectedError);
    // The page starts inside the fence; the opener is re-added.
    expect(error.undeliveredText.startsWith('```ts\n')).toBe(true);
    expect(error.undeliveredText.trimEnd().endsWith('```')).toBe(true);
    expect(error.undeliveredText.length).toBeLessThan(longCode.length);
    expect(error.cardTerminalized).toBe(true);
    controller.dispose();
  }, 20_000);

  test('page i refused and page j ambiguous still hands page i to the host', async () => {
    const mock = makeClient();
    const controller = await twoPageController(mock);
    mock.cardUpdate.mockImplementation(async (request: any) => {
      const data = String(request.data.card.data);
      if (request.path.card_id === 'card_1' && data.includes('const value'))
        throw axiosRejection(400, 230099, {});
      if (request.path.card_id === 'card_2')
        throw Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
      return { code: 0 };
    });
    const error = await controller.complete(longCode).then(
      () => undefined,
      (e) => e,
    );
    expect(error).toBeInstanceOf(FeishuCardContentRejectedError);
    expect(error.undeliveredText.startsWith('```ts\n')).toBe(true);
    expect(error.uncertainCause).toMatchObject({ code: 'ETIMEDOUT' });
    // Page i's notice was accepted, so the host may send its text.
    expect(error.cardTerminalized).toBe(true);
    controller.dispose();
  }, 20_000);

  test('an aborted reply whose body is refused points to the Web record', async () => {
    const mock = makeClient();
    const { controller } = await streamingController(mock, '答复正文');
    mock.cardUpdate.mockImplementation(async (request: any) => {
      if (String(request.data.card.data).includes('答复正文'))
        throw axiosRejection(400, 230099, {});
      return { code: 0 };
    });
    await expect(controller.abort('用户中断')).rejects.toBeInstanceOf(
      FeishuCardContentRejectedError,
    );
    const notice = String(mock.cardUpdate.mock.calls.at(-1)![0].data.card.data);
    expect(notice).toContain('Web 端');
    expect(notice).not.toContain('下方消息');
    controller.dispose();
  });

  test('streaming mode that keeps closing after re-enable escalates to full updates', async () => {
    const mock = makeClient();
    const { controller, internal } = await streamingController(mock);
    mock.elementContent.mockImplementation(async () => {
      throw axiosRejection(400, 300309, {});
    });
    mock.cardUpdate.mockClear();
    let text = '开始';
    for (let i = 0; i < 6 && !internal.nativeFullUpdates; i++) {
      text += `\n第${i}段 ${'内容'.repeat(30)}`;
      controller.append(text);
      await sleep(800);
    }
    await vi.waitFor(() => expect(internal.nativeFullUpdates).toBe(true), {
      timeout: 5000,
    });
    controller.append(`${text}\n收尾`);
    await vi.waitFor(() =>
      expect(
        mock.cardUpdate.mock.calls.some((call) =>
          String(call[0].data.card.data).includes('收尾'),
        ),
      ).toBe(true),
    );
    expect(internal.backendMode).toBe('streaming');
    expect(mock.messageCreate).toHaveBeenCalledTimes(1);
    controller.dispose();
  }, 20_000);
});

describe('P1-5 rate limits never switch backends', () => {
  const fastLimit = () =>
    axiosRejection(400, 230020, { 'x-ogw-ratelimit-reset': '0.001' });

  test('a rate-limited card send is retried with the same uuid on the same backend', async () => {
    const mock = makeClient();
    mock.messageCreate
      .mockRejectedValueOnce(fastLimit())
      .mockImplementationOnce(async () => ({
        code: 0,
        data: { message_id: 'om_after_limit' },
      }));
    const { controller, internal } = await streamingController(mock);
    expect(internal.backendMode).toBe('streaming');
    expect(mock.cardCreate).toHaveBeenCalledOnce();
    expect(mock.messageCreate).toHaveBeenCalledTimes(2);
    const uuids = mock.messageCreate.mock.calls.map((c) => c[0].data.uuid);
    expect(uuids[0]).toBe(uuids[1]);
    expect(controller.currentMessageId).toBe('om_after_limit');
    controller.dispose();
  });

  test('an exhausted rate limit fails without trying CardKit v1 or legacy', async () => {
    const mock = makeClient();
    mock.messageCreate.mockImplementation(async () => {
      throw fastLimit();
    });
    const controller = new StreamingCardController({
      client: mock.client,
      chatId: 'oc_limit',
    });
    controller.append('answer');
    await vi.waitFor(() => expect(controller.currentState).toBe('error'));
    expect(mock.cardCreate).toHaveBeenCalledOnce();
    expect(mock.messageCreate).toHaveBeenCalledTimes(4);
    await expect(controller.complete('answer')).rejects.toMatchObject({
      deliveryPhase: 'rejected',
    });
    controller.dispose();
  });

  test('a recalled reply anchor does not fall through to other backends', async () => {
    const mock = makeClient();
    mock.messageReply.mockRejectedValue(axiosRejection(400, 230011, {}));
    const controller = new StreamingCardController({
      client: mock.client,
      chatId: 'oc_recalled',
      replyToMsgId: 'om_recalled',
    });
    controller.append('answer');
    await vi.waitFor(() => expect(controller.currentState).toBe('error'));
    expect(mock.cardCreate).toHaveBeenCalledOnce();
    expect(mock.messageReply).toHaveBeenCalledOnce();
    expect(mock.messageCreate).not.toHaveBeenCalled();
    controller.dispose();
  });

  test('rate-limited live pushes are deferred, not counted toward degradation', async () => {
    const mock = makeClient();
    const { controller, internal } = await streamingController(mock);
    mock.elementContent.mockImplementation(async () => {
      throw axiosRejection(429, 99991400, { 'x-ogw-ratelimit-reset': '0.001' });
    });
    let text = '开始';
    for (let i = 0; i < 4; i++) {
      text += `\n第${i}段 ${'内容'.repeat(30)}`;
      controller.append(text);
      await sleep(700);
    }
    await internal.nativePageChain;
    expect(internal.patchFailCount).toBe(0);
    expect(internal.nativeFullUpdates).toBe(false);
    expect(internal.backendMode).toBe('streaming');
    expect(controller.currentState).toBe('streaming');
    controller.dispose();
  }, 15_000);
});

describe('P1-6 Feishu uuid idempotency', () => {
  test('card messages carry a stable uuid derived from the durable identity and page', async () => {
    const first = makeClient();
    const second = makeClient();
    const other = makeClient();
    const a = await streamingController(first, '开始', {
      idempotencyKey: 'stream_record_1',
    });
    const b = await streamingController(second, '开始', {
      idempotencyKey: 'stream_record_1',
    });
    const c = await streamingController(other, '开始', {
      idempotencyKey: 'stream_record_2',
    });
    const uuidOf = (mock: ReturnType<typeof makeClient>) =>
      mock.messageCreate.mock.calls[0][0].data.uuid as string;
    expect(uuidOf(first)).toMatch(/^hc[a-f0-9]{40}$/);
    expect(uuidOf(first).length).toBeLessThanOrEqual(50);
    expect(uuidOf(first)).toBe(uuidOf(second));
    expect(uuidOf(first)).not.toBe(uuidOf(other));
    for (const { controller } of [a, b, c]) controller.dispose();
  });

  test('replies and continuation pages use distinct per-page uuids', async () => {
    const mock = makeClient();
    const controller = new StreamingCardController({
      client: mock.client,
      chatId: 'oc_pages',
      replyToMsgId: 'om_root',
      idempotencyKey: 'stream_pages',
    });
    controller.append('首页');
    await vi.waitFor(() => expect(controller.currentState).toBe('streaming'));
    controller.append('续页正文。'.repeat(24000));
    await vi.waitFor(
      () => expect(mock.messageReply.mock.calls.length).toBeGreaterThan(1),
      { timeout: 5000 },
    );
    const uuids = mock.messageReply.mock.calls.map((c) => c[0].data.uuid);
    expect(uuids.every((uuid) => /^hc[a-f0-9]{40}$/.test(uuid))).toBe(true);
    expect(new Set(uuids).size).toBe(uuids.length);
    controller.dispose();
  });

  test('send_card uses the broker uuid and measures 30KB in UTF-8 bytes', async () => {
    const reply = vi.fn(async () => ({
      code: 0,
      data: { message_id: 'om_card' },
    }));
    const client = { im: { v1: { message: { reply } } } } as any;
    const context = {
      provider: 'feishu',
      chat: { id: 'oc_chat' },
      message: { id: 'om_in' },
    } as any;
    await executeFeishuCapability(client, context, {
      operation: 'send_card',
      params: { card: { schema: '2.0', body: { elements: [] } } },
      providerUuid: 'hc_broker_uuid',
    });
    expect((reply.mock.calls[0] as any)[0].data.uuid).toBe('hc_broker_uuid');

    const cjk = '中'.repeat(12_000); // 12K chars, 36KB of UTF-8
    await expect(
      executeFeishuCapability(client, context, {
        operation: 'send_card',
        params: {
          card: {
            schema: '2.0',
            body: { elements: [{ tag: 'markdown', content: cjk }] },
          },
        },
      }),
    ).rejects.toThrow(/30 KB/);
    expect(reply).toHaveBeenCalledOnce();
  });

  test('send_card replays an ambiguous failure once with the same uuid', async () => {
    const reply = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
      )
      .mockResolvedValueOnce({ code: 0, data: { message_id: 'om_card' } });
    const client = { im: { v1: { message: { reply } } } } as any;
    const result = await executeFeishuCapability(
      client,
      {
        provider: 'feishu',
        chat: { id: 'oc_chat' },
        message: { id: 'om_in' },
      } as any,
      {
        operation: 'send_card',
        params: { card: { schema: '2.0', body: { elements: [] } } },
      },
    );
    expect(result.data).toMatchObject({ messageId: 'om_card' });
    expect(reply).toHaveBeenCalledTimes(2);
    expect(reply.mock.calls[0][0].data.uuid).toBe(
      reply.mock.calls[1][0].data.uuid,
    );
  });
});

describe('P2-2 crash recovery', () => {
  test('recovery leaps past a stale sequence and retries 300317 with growing steps', async () => {
    const settings = vi.fn(async () => ({ code: 0 }));
    const update = vi
      .fn()
      .mockRejectedValueOnce(axiosRejection(400, 300317, {}))
      .mockResolvedValueOnce({ code: 0 });
    const client = { cardkit: { v1: { card: { settings, update } } } } as any;
    const result = await reconcileInterruptedStreamingCard(client, {
      messageId: 'om_1',
      cardId: 'card_1',
      version: 5,
      snapshot: { text: '部分回答' },
    });
    const first = (settings.mock.calls[0] as any)[0].data.sequence;
    const rejected = update.mock.calls[0][0].data.sequence;
    const accepted = update.mock.calls[1][0].data.sequence;
    expect(first).toBeGreaterThan(5 + 999);
    expect(rejected).toBeGreaterThan(first);
    expect(accepted).toBeGreaterThan(rejected + 1000);
    expect(result).toEqual({ version: accepted, method: 'cardkit' });
  });

  test('a refused recovered body is replaced by a notice instead of the skeleton', async () => {
    const update = vi.fn(async (request: any) => {
      if (String(request.data.card.data).includes('正文'))
        throw axiosRejection(400, 230099, {});
      return { code: 0 };
    });
    const client = {
      cardkit: {
        v1: { card: { settings: vi.fn(async () => ({ code: 0 })), update } },
      },
    } as any;
    await reconcileInterruptedStreamingCard(client, {
      messageId: 'om_1',
      cardId: 'card_1',
      version: 1,
      snapshot: { text: '正文 <at id=all></at>' },
    });
    expect(update).toHaveBeenCalledTimes(3);
    const final = String(update.mock.calls.at(-1)![0].data.card.data);
    expect(final).toContain('卡片内容无法展示');
    expect(final).not.toContain('interrupt_stream');
  });

  test('multi-page recovery writes only the last page slice of the persisted reply', () => {
    const page1 = 'A'.repeat(50);
    const tail = '```ts\nconst a = 1;\nconst b = 2;\n```\n结尾';
    const reply = `${page1}\n${tail}`;
    const start = page1.length + 1 + '```ts\nconst a = 1;\n'.length;
    const snapshot = {
      text: reply.slice(0, start + 5),
      visibleText: '```ts\nconst',
      visibleRawStart: start,
    };
    const body = streamingCardRecoveryPageBody(reply, snapshot, true);
    expect(body.startsWith('```ts\n')).toBe(true);
    expect(body).toContain('const b = 2;');
    expect(body).not.toContain(page1);
    // Without a verifiable prefix the page's own snapshot is used.
    expect(
      streamingCardRecoveryPageBody('different reply', snapshot, true),
    ).toBe('```ts\nconst');
    // Single-page cards keep the whole reply.
    expect(streamingCardRecoveryPageBody(reply, { text: reply }, true)).toBe(
      reply,
    );
  });
});

describe('P2-4 lifecycle write amplification', () => {
  test('streaming flushes persist the full-text snapshot at most every five seconds', async () => {
    const mock = makeClient();
    const { controller, events, internal } = await streamingController(mock);
    const startIndex = events.length;
    let text = '开始';
    for (let i = 0; i < 4; i++) {
      text += `\n第${i}段 ${'内容'.repeat(30)}`;
      controller.append(text);
      await sleep(700);
    }
    await internal.nativePageChain;
    const streaming = events
      .slice(startIndex)
      .filter((event) => event.status === 'streaming');
    expect(streaming.length).toBeGreaterThan(1);
    expect(streaming.filter((event) => event.snapshot).length).toBeLessThan(
      streaming.length,
    );
    for (const event of streaming) {
      expect(event.cardId).toBe('card_1');
      expect(event.version).toBeGreaterThan(0);
    }
    await controller.complete(text);
    const finalizing = events.find((event) => event.status === 'finalizing');
    const completed = events.at(-1);
    expect(finalizing.snapshot.text).toBe(text);
    expect(completed.status).toBe('completed');
    expect(completed.snapshot.text).toBe(text);
    controller.dispose();
  }, 15_000);
});

describe('P2-5 pagination planning cost', () => {
  test('appending to a long paginated answer measures only the tail page', () => {
    const budget = CARDKIT_JSON_MAX_BYTES - 6000;
    let calls = 0;
    const fits = (text: string) => {
      calls++;
      return (
        Buffer.byteLength(JSON.stringify(text)) <= budget &&
        fitsCardCapacity(buildStreamingAgentCard({ initialText: text })) &&
        fitsCardCapacity(buildAgentReplyCard({ status: 'done', text }))
      );
    };
    const prose = (
      '这是一段正文内容，用于填充第一页。'.repeat(30) + '\n\n'
    ).repeat(200);
    const rows = Array.from(
      { length: 1500 },
      (_, i) => `| ${i} | 名称${i} |\n`,
    ).join('');
    const text = `${prose}| id | name |\n|---|---|\n${rows}`;
    const pages = splitCardPages(text, { fits });
    expect(pages.length).toBeGreaterThan(1);
    const frozen = pages.slice(0, -1).map((page) => page.rawEnd);
    calls = 0;
    splitCardPages(`${text}| x | y |\n`, {
      fits,
      frozenBoundaries: frozen,
      preserveFrozenCapacity: true,
    });
    expect(calls).toBeLessThanOrEqual(2);
  });
});

describe('P2-6 learned CardKit capacity per account', () => {
  test('the next reply on the same Bot starts at the learned scale', async () => {
    const mock = makeClient();
    mock.cardCreate.mockRejectedValueOnce(axiosRejection(400, 200860, {}));
    const first = await streamingController(mock);
    expect(first.internal.nativeCapacityScale).toBeCloseTo(0.8);
    const second = new StreamingCardController({
      client: mock.client,
      chatId: 'oc_next',
    });
    expect((second as any).nativeCapacityScale).toBeCloseTo(0.8);
    const otherBot = new StreamingCardController({
      client: makeClient().client,
      chatId: 'oc_other',
    });
    expect((otherBot as any).nativeCapacityScale).toBe(1);
    first.controller.dispose();
  });
});

describe('P2-8 session registry', () => {
  test('unregister with an expected session is compare-and-delete', () => {
    const session = (ids: string[]) => ({
      isActive: () => false,
      abort: async () => {},
      getAllMessageIds: () => ids,
    });
    const older = session(['om_old']);
    const newer = session(['om_new']);
    registerStreamingSession('oc_registry', older);
    registerStreamingSession('oc_registry', newer);
    unregisterStreamingSession('oc_registry', older);
    expect(getStreamingSession('oc_registry')).toBe(newer);
    unregisterStreamingSession('oc_registry', newer);
    expect(getStreamingSession('oc_registry')).toBeUndefined();
  });
});

describe('P2-9 v1/legacy fence parsing and titles', () => {
  test.each([
    ['```c++', '```'],
    ['~~~python', '~~~'],
    ['````markdown', '````'],
  ])(
    '%s blocks are closed and reopened with their own fence',
    (opener, closer) => {
      const prose = '前言段落。'.repeat(300) + '\n\n';
      const code = `${opener}\n${'int x = 0; // code line\n'.repeat(400)}${closer}\n\n`;
      const text = prose + code + '普通正文，不是代码。'.repeat(50);
      const chunks = splitCodeBlockSafe(text, 4000);
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        const fenceLines = chunk
          .split('\n')
          .filter((line) => line.startsWith(closer[0].repeat(3)));
        expect(fenceLines.length % 2).toBe(0);
      }
      const reopened = chunks.filter((chunk) => chunk.startsWith(opener));
      expect(reopened.length).toBeGreaterThan(0);
      // The prose after the block is never swallowed into a code fence.
      const tail = chunks.at(-1)!;
      expect(tail).toContain('普通正文');
      expect(tail.indexOf(`\n${closer}\n`)).toBeLessThan(
        tail.indexOf('普通正文'),
      );
    },
  );

  test('splits never cut an astral character in half', () => {
    const chunks = splitCodeBlockSafe('😀'.repeat(5000), 4001);
    for (const chunk of chunks) {
      expect(/[\uD800-\uDBFF]$/.test(chunk)).toBe(false);
      expect(/^[\uDC00-\uDFFF]/.test(chunk)).toBe(false);
    }
    expect(chunks.join('')).toBe('😀'.repeat(5000));
  });

  test('a leading fence or table is not consumed as the title', () => {
    expect(
      extractTitleAndBody('```bash\nnpm ci\n```\n\n然后运行 make dev'),
    ).toEqual({
      title: 'Reply',
      body: '```bash\nnpm ci\n```\n\n然后运行 make dev',
    });
    expect(extractTitleAndBody('| 项 | 值 |\n|---|---|\n| a | 1 |').body).toBe(
      '| 项 | 值 |\n|---|---|\n| a | 1 |',
    );
    expect(extractTitleAndBody('# 标题\n正文').title).toBe('标题');
  });
});

describe('P2-12 single-column tables', () => {
  test('a split single-column table replays its header on every page', () => {
    const rows = Array.from({ length: 400 }, (_, i) => `| 行${i} |\n`).join('');
    const text = `| 单列 |\n|---|\n${rows}`;
    const pages = splitCardPages(text, { maxBytes: 1024 });
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages)
      expect(page.text.startsWith('| 单列 |\n|---|\n')).toBe(true);
    expect(countMarkdownTables(text)).toBe(1);
    expect(pages.at(-1)!.rawEnd).toBe(text.length);
  });
});

describe('neutral rendering of a refused body', () => {
  test('escapes tags, converts tables to text and removes images without dropping text', () => {
    const source =
      '前文 <at id=all></at> <font color=red>x</font>\n\n![图](https://e.com/a_(1).png "t")\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```\n<at id=all></at>\n```';
    const out = neutralizeRejectedCardMarkdown(source);
    expect(rawMentionOutsideCode(out)).toBe(false);
    expect(out).toContain('&#60;font');
    expect(out).not.toContain('![');
    expect(out).toContain('图');
    expect(out).toContain('```text\n| a | b |\n|---|---|\n| 1 | 2 |\n```');
    expect(out).toContain('```\n<at id=all></at>\n```');
    expect(countMarkdownTables(out)).toBe(0);
  });
});
