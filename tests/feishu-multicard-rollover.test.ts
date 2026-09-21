import { afterEach, describe, expect, test, vi } from 'vitest';
import { StreamingCardController } from '../src/feishu-streaming-card.js';

/**
 * 回归测试：v1 降级模式下 MultiCardManager 的拆卡（rollover）行为。
 *
 * 历史 bug：commitContent 每次 flush 用全量文本重算大小，文本一旦超过 25KB
 * JSON 上限，每次 flush 都会再次拆卡并新建一条飞书消息 —— 一条回复变成
 * 每秒一张的重复卡片洪流（用户报告的「出现很多很多消息」）。
 *
 * 现在拆卡按未冻结尾部（frozen-prefix 增量模型）计算：同样的内容只拆一次，
 * 后续 flush 只更新当前卡片。
 */

function buildMockClient() {
  let cardSeq = 0;
  let msgSeq = 0;
  const cardUpdate = vi.fn().mockResolvedValue({ code: 0 });
  const messageCreate = vi
    .fn()
    .mockImplementation(() =>
      Promise.resolve({ data: { message_id: `om_${++msgSeq}` } }),
    );
  const cardCreate = vi.fn().mockImplementation(() => {
    cardSeq++;
    // 第一次 create 是 Level 0（streaming mode）尝试 —— 拒绝，强制走 v1 路径
    if (cardSeq === 1) {
      return Promise.reject(new Error('streaming mode unavailable'));
    }
    return Promise.resolve({
      code: 0,
      data: { card_id: `card_${cardSeq}` },
    });
  });
  return {
    client: {
      cardkit: {
        v1: {
          card: { create: cardCreate, update: cardUpdate },
          cardElement: {},
        },
      },
      im: {
        message: { reply: vi.fn() },
        v1: { message: { create: messageCreate } },
      },
    },
    cardCreate,
    cardUpdate,
    messageCreate,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('MultiCardManager rollover (v1 degraded mode)', () => {
  test('超限后只拆一次卡，后续 flush 不再重复新建消息', async () => {
    const { client, cardUpdate, messageCreate } = buildMockClient();
    const controller = new StreamingCardController({
      client: client as any,
      chatId: 'oc_test',
    });

    // 触发创建：Level 0 失败 → Level 1 (v1 multi-card) 成功
    controller.append('# 标题\n正文开始');
    await vi.waitFor(() => expect(messageCreate).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect((controller as any).state).toBe('streaming'));

    vi.useFakeTimers();

    // 一段超过 25KB JSON 上限的长文本 → 第一次 flush 触发 rollover
    const bigText = '# 标题\n' + 'A'.repeat(30000);
    controller.append(bigText);
    await vi.advanceTimersByTimeAsync(1200);
    await vi.waitFor(() => expect(messageCreate).toHaveBeenCalledTimes(2), {
      timeout: 1000,
    });

    // 继续追加增量文本并多次 flush —— 不应再新建任何消息
    for (let i = 1; i <= 5; i++) {
      controller.append(bigText + '\n' + `追加段落 ${i} `.repeat(20));
      await vi.advanceTimersByTimeAsync(1200);
    }
    // 留出微任务收尾
    await vi.advanceTimersByTimeAsync(2000);

    expect(messageCreate).toHaveBeenCalledTimes(2);

    // 冻结更新发生在第一张卡（card_2），后续更新落在续卡（card_3）
    const updatedCardIds = cardUpdate.mock.calls.map(
      (c: any[]) => c[0]?.path?.card_id,
    );
    expect(updatedCardIds).toContain('card_2');
    expect(updatedCardIds).toContain('card_3');
    // 续卡建立后不应再更新第一张卡
    const lastCard2Idx = updatedCardIds.lastIndexOf('card_2');
    const firstCard3Idx = updatedCardIds.indexOf('card_3');
    expect(firstCard3Idx).toBeGreaterThan(-1);
    expect(lastCard2Idx).toBeLessThan(firstCard3Idx + 1);
  });

  test('完成时续卡渲染未冻结尾部，正文首行不被当作标题吞掉', async () => {
    const { client, cardUpdate, messageCreate } = buildMockClient();
    const controller = new StreamingCardController({
      client: client as any,
      chatId: 'oc_test',
    });

    controller.append('# 标题\n正文开始');
    await vi.waitFor(() => expect(messageCreate).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect((controller as any).state).toBe('streaming'));

    vi.useFakeTimers();
    const bigText = '# 标题\n' + 'B'.repeat(30000) + '\n尾部独立行内容\n结束语';
    controller.append(bigText);
    await vi.advanceTimersByTimeAsync(1200);
    await vi.waitFor(() => expect(messageCreate).toHaveBeenCalledTimes(2), {
      timeout: 1000,
    });
    vi.useRealTimers();

    await controller.complete(bigText);

    // 最后一次 update 是续卡的 completed 渲染
    const lastUpdate = cardUpdate.mock.calls.at(-1)?.[0];
    expect(lastUpdate?.path?.card_id).toBe('card_3');
    const cardJson = JSON.parse(lastUpdate.data.card.data);
    const allContent = JSON.stringify(cardJson);
    // 续卡承载的是冻结点之后的尾部内容
    expect(allContent).toContain('尾部独立行内容');
    expect(allContent).toContain('结束语');
  });

  test('CJK 长回复每张卡 JSON 不超过字节上限（字节预算而非字符预算）', async () => {
    // 回归 C4 真根因：拆卡预算曾按 UTF-16 字符数计，CJK 3 字节/字，1.8 万字
    // 中文 ≈ 54KB > 飞书 ~30KB 上限 → 终态多卡渲染必败、僵尸「生成中」卡。
    const { client, cardUpdate, cardCreate } = buildMockClient();
    const controller = new StreamingCardController({
      client: client as any,
      chatId: 'oc_test',
    });

    controller.append('# 中文标题\n正文');
    await vi.waitFor(() => expect((controller as any).state).toBe('streaming'));

    // ~12000 个中文字符，UTF-8 约 36KB——字符数没超 18000，但字节数远超单卡上限
    const cjk = '一二三四五六七八九十'.repeat(1200); // 12000 字
    const bigCjk = `# 中文标题\n${cjk}\n收尾段落`;
    await controller.complete(bigCjk);

    // 校验每一次写入飞书的卡片 JSON（update + create）字节数都 <= 25KB
    const CARD_SIZE_LIMIT = 25 * 1024;
    const updateSizes = cardUpdate.mock.calls.map((c: any[]) =>
      Buffer.byteLength(c[0]?.data?.card?.data || '', 'utf-8'),
    );
    const createSizes = cardCreate.mock.calls
      .map((c: any[]) => c[0]?.data?.data || '')
      .filter(Boolean)
      .map((d: string) => Buffer.byteLength(d, 'utf-8'));
    const allSizes = [...updateSizes, ...createSizes];
    expect(allSizes.length).toBeGreaterThan(0);
    for (const sz of allSizes) {
      expect(sz).toBeLessThanOrEqual(CARD_SIZE_LIMIT);
    }
    // 必然拆成多张卡（12000 中文字 ~36KB > 单卡上限）
    expect(cardCreate.mock.calls.length).toBeGreaterThan(2);
  });
});
