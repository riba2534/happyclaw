/**
 * Crash-recovery policy for Feishu streaming cards (cross-review M3):
 * a body already delivered statically is never written onto the card again,
 * recovery attempts are capped per card, and unreachable targets end failed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'feishu-card-recovery-'));
const storeDir = path.join(root, 'store');
const groupsDir = path.join(root, 'groups');
fs.mkdirSync(storeDir, { recursive: true });
fs.mkdirSync(groupsDir, { recursive: true });

vi.mock('../src/config.js', () => ({
  STORE_DIR: storeDir,
  GROUPS_DIR: groupsDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const reliability = await import('../src/channel-reliability-store.js');
const {
  reconcileChannelReliabilityOnStartup,
  MAX_STREAMING_CARD_RECOVERY_ATTEMPTS,
} = await import('../src/channel-reliability-recovery.js');
const { reconcileInterruptedStreamingCard } =
  await import('../src/feishu-streaming-card.js');

const route = {
  provider: 'feishu',
  accountId: 'bot-recovery-review',
  sourceJid: 'feishu:chat-recovery-review',
  chatId: 'chat-recovery-review',
  rootId: null,
  threadId: null,
};

beforeAll(() => db.initDatabase());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

function axiosRejection(status: number, code: number) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    code: 'ERR_BAD_REQUEST',
    response: { status, headers: {}, data: { code, msg: 'rejected' } },
  });
}

function seedCard(name: string, snapshot: Record<string, unknown>) {
  const run = reliability.createChannelTurnRun({
    ...route,
    idempotencyKey: `turn:${name}`,
  }).run;
  return reliability.createStreamingCardRecord({
    ...route,
    id: `stream-${name}`,
    turnRunId: run.id,
    messageId: `om-${name}`,
    cardId: `card-${name}`,
    version: 3,
    status: 'streaming',
    snapshot,
  }).card;
}

describe('streaming card crash recovery', () => {
  test('after static delivery recovery writes only a notice, never the body', async () => {
    const card = seedCard('static-delivered', {
      text: '已静态送达的正文 | 表格',
      state: 'completed',
      backendMode: 'streaming',
      staticFallbackDelivered: true,
    });
    const update = vi.fn(async (_request: any) => ({ code: 0 }));
    const client = {
      cardkit: {
        v1: { card: { settings: vi.fn(async () => ({ code: 0 })), update } },
      },
    } as any;
    await reconcileChannelReliabilityOnStartup({
      reconcileStreamingCard: (record) =>
        reconcileInterruptedStreamingCard(client, record),
    });
    expect(update).toHaveBeenCalledTimes(1);
    const written = String(update.mock.calls[0][0].data.card.data);
    expect(written).not.toContain('已静态送达的正文');
    expect(written).toContain('完整回复已通过下方消息发送');
    expect(reliability.getStreamingCardRecord(card.id)?.status).not.toBe(
      'streaming',
    );
  });

  test('provider-refused recovery is capped per card and then ends failed', async () => {
    const card = seedCard('capped', {
      text: '部分回答',
      state: 'streaming',
      backendMode: 'streaming',
    });
    const reconcile = vi.fn(async () => {
      throw axiosRejection(400, 300317);
    });
    for (let pass = 1; pass < MAX_STREAMING_CARD_RECOVERY_ATTEMPTS; pass++) {
      await reconcileChannelReliabilityOnStartup({
        reconcileStreamingCard: reconcile,
      });
      const current = reliability.getStreamingCardRecord(card.id)!;
      expect(current.status).toBe('streaming');
      expect((current.snapshot as any).recoveryAttempts).toBe(pass);
      expect((current.snapshot as any).text).toBe('部分回答');
    }
    await reconcileChannelReliabilityOnStartup({
      reconcileStreamingCard: reconcile,
    });
    const final = reliability.getStreamingCardRecord(card.id)!;
    expect(final.status).toBe('failed');
    expect(final.error).toContain('attempts_exhausted');
    const calls = reconcile.mock.calls.length;
    await reconcileChannelReliabilityOnStartup({
      reconcileStreamingCard: reconcile,
    });
    expect(reconcile.mock.calls.length).toBe(calls);
  });

  test('an unreachable target ends failed on the first refusal', async () => {
    const card = seedCard('recalled', {
      text: '部分回答',
      state: 'streaming',
      backendMode: 'streaming',
    });
    const reconcile = vi.fn(async () => {
      throw axiosRejection(400, 230011);
    });
    await reconcileChannelReliabilityOnStartup({
      reconcileStreamingCard: reconcile,
    });
    const final = reliability.getStreamingCardRecord(card.id)!;
    expect(final.status).toBe('failed');
    expect(final.error).toContain('target_unavailable');
  });

  test('a bot that is not connected yet does not burn the attempt budget', async () => {
    const card = seedCard('bot-not-ready', {
      text: '部分回答',
      state: 'streaming',
      backendMode: 'streaming',
    });
    const reconcile = vi.fn(async () => {
      throw new Error('Feishu channel is not connected');
    });
    for (let pass = 0; pass < MAX_STREAMING_CARD_RECOVERY_ATTEMPTS + 1; pass++)
      await reconcileChannelReliabilityOnStartup({
        reconcileStreamingCard: reconcile,
      });
    const current = reliability.getStreamingCardRecord(card.id)!;
    expect(current.status).toBe('streaming');
    expect((current.snapshot as any).recoveryAttempts ?? 0).toBe(0);
  });
});
