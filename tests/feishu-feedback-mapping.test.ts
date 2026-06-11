/**
 * 用户反馈链路测试（PR #558）：
 * 1. messageId → chatJid/rootMessageId/dbMessageId 映射注册表
 * 2. 秒回竞争回归：complete() 必须等待在途的卡片创建，确保 onCardCreated
 *    先触发（否则映射永不注册，reaction 落子消息、反馈关联错误）
 * 3. 卡片创建失败时 complete() 抛错，上层据此 fallback 到静态消息
 */
import { describe, expect, test } from 'vitest';
import {
  StreamingCardController,
  registerMessageIdMapping,
  registerDbMessageIdForCard,
  resolveJidByMessageId,
  resolveRootMessageId,
  resolveDbMessageIdByCard,
  unregisterMessageId,
} from '../src/feishu-streaming-card.js';
import type * as lark from '@larksuiteoapi/node-sdk';

// ─── 映射注册表 ───────────────────────────────────────────────

describe('messageId mapping registry', () => {
  test('register + resolve chatJid and rootMessageId', () => {
    registerMessageIdMapping('om_map_1', 'feishu:oc_x#thread:t1#root:om_root_1', 'om_root_1');
    expect(resolveJidByMessageId('om_map_1')).toBe('feishu:oc_x#thread:t1#root:om_root_1');
    expect(resolveRootMessageId('om_map_1')).toBe('om_root_1');
    unregisterMessageId('om_map_1');
  });

  test('rootMessageId is optional (non-thread chats)', () => {
    registerMessageIdMapping('om_map_2', 'feishu:oc_plain');
    expect(resolveJidByMessageId('om_map_2')).toBe('feishu:oc_plain');
    expect(resolveRootMessageId('om_map_2')).toBeUndefined();
    unregisterMessageId('om_map_2');
  });

  test('registerDbMessageIdForCard attaches to existing mapping', () => {
    registerMessageIdMapping('om_map_3', 'feishu:oc_x');
    expect(resolveDbMessageIdByCard('om_map_3')).toBeUndefined();
    registerDbMessageIdForCard('om_map_3', 'db-uuid-1');
    expect(resolveDbMessageIdByCard('om_map_3')).toBe('db-uuid-1');
    unregisterMessageId('om_map_3');
  });

  test('registerDbMessageIdForCard is a no-op without prior mapping', () => {
    registerDbMessageIdForCard('om_map_unknown', 'db-uuid-2');
    expect(resolveDbMessageIdByCard('om_map_unknown')).toBeUndefined();
  });

  test('unregister clears everything', () => {
    registerMessageIdMapping('om_map_4', 'feishu:oc_x', 'om_root_4');
    registerDbMessageIdForCard('om_map_4', 'db-uuid-4');
    unregisterMessageId('om_map_4');
    expect(resolveJidByMessageId('om_map_4')).toBeUndefined();
    expect(resolveRootMessageId('om_map_4')).toBeUndefined();
    expect(resolveDbMessageIdByCard('om_map_4')).toBeUndefined();
  });
});

// ─── 秒回竞争回归 ─────────────────────────────────────────────

/**
 * 递归 Proxy 假 lark client：任意深层方法调用都可解析。
 * cardkit.v1.card.create → card_id；im 消息发送 → message_id（带延迟模拟在途 API）。
 * fail=true 时所有创建调用 reject（覆盖 streaming/CardKit/legacy 三级降级）。
 */
function makeFakeClient(opts: { sendDelayMs?: number; fail?: boolean } = {}): lark.Client {
  const { sendDelayMs = 0, fail = false } = opts;
  const node = (path: string[]): unknown =>
    new Proxy(function () {}, {
      get: (_t, prop) => node([...path, String(prop)]),
      apply: async () => {
        const name = path.join('.');
        if (fail) throw new Error(`fake ${name} failure`);
        if (name.endsWith('cardkit.v1.card.create')) {
          return { data: { card_id: 'card_test_1' } };
        }
        if (name.endsWith('im.v1.message.create') || name.endsWith('im.message.reply')) {
          if (sendDelayMs > 0) await new Promise((r) => setTimeout(r, sendDelayMs));
          return { data: { message_id: 'om_race_test_1' } };
        }
        return { data: {} };
      },
    });
  return node([]) as lark.Client;
}

describe('StreamingCardController fast-reply race', () => {
  test('complete() during in-flight creation waits for onCardCreated', async () => {
    const events: string[] = [];
    const ctrl = new StreamingCardController({
      client: makeFakeClient({ sendDelayMs: 30 }),
      chatId: 'oc_race_test',
      onCardCreated: (messageId) => events.push(`cardCreated:${messageId}`),
    });

    // 第一个 delta 触发创建（API 在途 30ms），紧接着 complete —— 复现秒回时序
    ctrl.append('hello');
    expect(ctrl.currentState).toBe('creating');
    await ctrl.complete('hello world');
    events.push('completeResolved');

    // 关键断言：onCardCreated 必须先于 complete 返回触发
    expect(events).toEqual(['cardCreated:om_race_test_1', 'completeResolved']);
    expect(ctrl.currentState).toBe('completed');
    unregisterMessageId('om_race_test_1');
  });

  test('complete() throws when creation failed, so caller falls back to static send', async () => {
    let fallback = false;
    const ctrl = new StreamingCardController({
      client: makeFakeClient({ fail: true }),
      chatId: 'oc_race_test',
      onFallback: () => {
        fallback = true;
      },
    });

    ctrl.append('hello');
    await expect(ctrl.complete('hello world')).rejects.toThrow(
      /creation failed/,
    );
    expect(fallback).toBe(true);
    expect(ctrl.currentState).toBe('error');
  });

  test('normal flow (creation settles before complete) still works', async () => {
    const events: string[] = [];
    const ctrl = new StreamingCardController({
      client: makeFakeClient(),
      chatId: 'oc_race_test',
      onCardCreated: (messageId) => events.push(`cardCreated:${messageId}`),
    });

    ctrl.append('hello');
    // 等创建完成（无延迟，给事件循环几拍）
    await new Promise((r) => setTimeout(r, 10));
    expect(ctrl.currentState).toBe('streaming');
    await ctrl.complete('hello world');
    expect(events).toEqual(['cardCreated:om_race_test_1']);
    expect(ctrl.currentState).toBe('completed');
    unregisterMessageId('om_race_test_1');
  });
});
