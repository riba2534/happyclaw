import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-turn-runtime-'));
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
const { ChannelTurnRuntime } = await import('../src/channel-turn-runtime.js');
const {
  reconcileChannelReliabilityOnStartup,
  startChannelReliabilityRecoveryLoop,
} = await import('../src/channel-reliability-recovery.js');
const { reconcileInterruptedStreamingCard } =
  await import('../src/feishu-streaming-card.js');

const route = {
  provider: 'feishu',
  accountId: 'bot-runtime',
  sourceJid:
    'feishu:chat-runtime#account:bot-runtime#root:root-runtime#thread:thread-runtime',
  chatId: 'chat-runtime',
  rootId: 'root-runtime',
  threadId: 'thread-runtime',
};

beforeAll(() => db.initDatabase());
afterAll(() => {
  vi.useRealTimers();
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('durable channel turn runtime', () => {
  test('retryable close keeps the deterministic run claimable instead of terminal-skipping it', () => {
    const input = {
      ...route,
      externalMessageId: 'msg-retry-wait-1',
      agentId: 'agent-retry-wait',
    };
    const first = ChannelTurnRuntime.start(input);
    expect(first.retry('connection closed before final reply')).toBe(true);
    expect(reliability.getChannelTurnRun(first.runId)).toMatchObject({
      status: 'retry_wait',
      error: 'connection closed before final reply',
    });
    first.dispose();

    const replay = ChannelTurnRuntime.start(input);
    expect(replay.executionDisposition).toBe('execute');
    expect(replay.isClaimed).toBe(true);
    expect(reliability.getChannelTurnRun(replay.runId)?.attempt).toBe(2);
    expect(replay.complete({ replayed: true })).toBe(true);
    replay.dispose();
  });

  test('manual reconciliation interrupt makes an uncertain turn terminal and non-replayable', () => {
    const input = {
      ...route,
      externalMessageId: 'msg-uncertain-manual-reconcile',
      agentId: 'agent-uncertain-manual-reconcile',
    };
    const first = ChannelTurnRuntime.start(input);
    expect(
      first.interrupt('Provider ACK uncertain; manual review required'),
    ).toBe(true);
    expect(reliability.getChannelTurnRun(first.runId)).toMatchObject({
      status: 'interrupted',
      error: expect.stringContaining(
        'Provider ACK uncertain; manual review required',
      ),
      leaseOwner: null,
    });
    first.dispose();

    const replay = ChannelTurnRuntime.start(input);
    expect(replay.executionDisposition).toBe('manual_reconciliation');
    expect(replay.isClaimed).toBe(false);
    replay.dispose();
  });

  test('cannot complete a turn while one provider side effect remains uncertain', () => {
    const runtime = ChannelTurnRuntime.start({
      ...route,
      externalMessageId: 'msg-uncertain-cannot-complete',
      agentId: 'agent-uncertain-cannot-complete',
    });
    const outbox = reliability.enqueueChannelOutbox({
      ...route,
      turnRunId: runtime.runId,
      ordinal: 0,
      kind: 'card',
      payload: { card: { schema: '2.0' } },
    }).item;
    const claim = reliability.claimChannelOutboxById(
      outbox.id,
      'uncertain-delivery-worker',
      100,
      '2099-07-25T00:00:00.000Z',
    )!;
    expect(
      reliability.markChannelOutboxSending(claim, '2099-07-25T00:00:00.001Z'),
    ).toBe(true);
    expect(
      reliability.reconcileExpiredChannelOutbox('2099-07-25T00:00:00.200Z'),
    ).toEqual({ retryable: 0, uncertain: 1 });

    expect(runtime.complete({ replyDelivered: true })).toBe(false);
    expect(reliability.getChannelTurnRun(runtime.runId)?.status).toBe(
      'running',
    );
    expect(runtime.interrupt('Provider side effect is uncertain')).toBe(true);
    runtime.dispose();
  });

  test('restart never re-executes after a delivered Outbox ACK survived the process', () => {
    const input = {
      ...route,
      externalMessageId: 'msg-crash-after-outbox-ack',
      agentId: 'agent-crash-after-outbox-ack',
    };
    const first = ChannelTurnRuntime.start(input);
    const outbox = reliability.enqueueChannelOutbox({
      ...route,
      turnRunId: first.runId,
      ordinal: 0,
      kind: 'file',
      payload: { fileName: 'already-delivered.pdf' },
    }).item;
    const claim = reliability.claimChannelOutboxById(
      outbox.id,
      'delivery-worker',
      60_000,
    )!;
    expect(reliability.markChannelOutboxSending(claim)).toBe(true);
    expect(
      reliability.completeChannelOutbox(claim, {
        providerMessageId: 'provider-file-ack',
      }),
    ).toBe(true);
    first.dispose(); // crash before runtime.complete()

    const replay = ChannelTurnRuntime.start(input);
    expect(replay.executionDisposition).toBe('manual_reconciliation');
    expect(replay.isClaimed).toBe(false);
    expect(reliability.getChannelTurnRun(first.runId)).toMatchObject({
      status: 'interrupted',
      attempt: 1,
      leaseOwner: null,
      error: expect.stringContaining('manual reconciliation required'),
    });
    expect(reliability.getChannelOutboxItem(outbox.id)).toMatchObject({
      status: 'delivered',
      providerMessageId: 'provider-file-ack',
      attempt: 1,
    });
    replay.dispose();
  });

  test('restart never creates a second card after a completed card ACK survived the process', () => {
    const input = {
      ...route,
      externalMessageId: 'msg-crash-after-card-ack',
      agentId: 'agent-crash-after-card-ack',
    };
    const first = ChannelTurnRuntime.start(input);
    const lifecycle = first.reserveStreamingCard()!;
    lifecycle.onEvent({
      status: 'completed',
      messageId: 'om_card_ack_survived',
      cardId: 'card_ack_survived',
      version: 1,
      snapshot: { text: 'visible final answer' },
    });
    first.dispose(); // crash before runtime.complete()

    const replay = ChannelTurnRuntime.start(input);
    expect(replay.executionDisposition).toBe('manual_reconciliation');
    expect(replay.isClaimed).toBe(false);
    expect(replay.reserveStreamingCard()).toBeUndefined();
    expect(reliability.getChannelTurnRun(first.runId)).toMatchObject({
      status: 'interrupted',
      attempt: 1,
      leaseOwner: null,
      error: expect.stringContaining('manual reconciliation required'),
    });
    expect(
      reliability
        .listAllNonterminalStreamingCards()
        .filter((card) => card.turnRunId === first.runId),
    ).toHaveLength(0);
    replay.dispose();
  });

  test('reloads and retries a streaming-card revision conflict without settling the turn from the card', () => {
    const runtime = ChannelTurnRuntime.start({
      ...route,
      externalMessageId: 'msg-card-cas-retry',
      agentId: 'agent-card-cas-retry',
    });
    const lifecycle = runtime.reserveStreamingCard()!;
    const card = reliability
      .scanChannelReliabilityNonterminal()
      .cards.find((item) => item.turnRunId === runtime.runId)!;
    expect(
      reliability.updateStreamingCardRecord(card.id, card.revision, {
        status: 'streaming',
        snapshot: { writer: 'concurrent' },
      }),
    ).toBeDefined();

    expect(() =>
      lifecycle.onEvent({
        status: 'streaming',
        messageId: 'om_after_conflict',
        cardId: 'card_after_conflict',
        version: 2,
        snapshot: { text: 'authoritative' },
      }),
    ).not.toThrow();
    expect(runtime.hasDurabilityFailure).toBe(false);
    expect(reliability.getStreamingCardRecord(card.id)).toMatchObject({
      revision: 2,
      messageId: 'om_after_conflict',
      snapshot: { text: 'authoritative' },
    });
    lifecycle.onEvent({
      status: 'completed',
      messageId: 'om_after_conflict',
      cardId: 'card_after_conflict',
      version: 3,
      snapshot: { text: 'authoritative' },
    });
    expect(reliability.getChannelTurnRun(runtime.runId)?.status).toBe(
      'running',
    );
    expect(runtime.markFinalizing()).toBe(true);
    expect(runtime.complete()).toBe(true);
    runtime.dispose();
  });

  test('rolls back only an unpublished card reservation before retrying admission', () => {
    const input = {
      ...route,
      externalMessageId: 'msg-admission-reservation-rollback',
      agentId: 'agent-admission-reservation-rollback',
    };
    const runtime = ChannelTurnRuntime.start(input);
    runtime.reserveStreamingCard();
    const reserved = reliability
      .listAllNonterminalStreamingCards()
      .find((item) => item.turnRunId === runtime.runId)!;
    expect(reserved).toMatchObject({
      status: 'creating',
      messageId: null,
      cardId: null,
    });

    expect(runtime.rollbackUnpublishedStreamingCardReservation()).toBe(true);
    expect(reliability.getStreamingCardRecord(reserved.id)).toBeUndefined();
    expect(runtime.retry('temporary admission persistence failure')).toBe(true);
    runtime.dispose();

    const replay = ChannelTurnRuntime.start(input);
    expect(replay.executionDisposition).toBe('execute');
    const replayLifecycle = replay.reserveStreamingCard()!;
    replayLifecycle.onEvent({
      status: 'aborted',
      version: 0,
      snapshot: { text: '' },
      error: 'test cleanup',
    });
    expect(replay.cancel('test cleanup')).toBe(true);
    replay.dispose();
  });

  test('refuses reservation rollback after provider identity is persisted', () => {
    const runtime = ChannelTurnRuntime.start({
      ...route,
      externalMessageId: 'msg-admission-provider-visible',
      agentId: 'agent-admission-provider-visible',
    });
    const lifecycle = runtime.reserveStreamingCard()!;
    lifecycle.onEvent({
      status: 'creating',
      messageId: 'om_provider_visible',
      cardId: 'card_provider_visible',
      version: 1,
      snapshot: { text: '' },
    });

    expect(runtime.rollbackUnpublishedStreamingCardReservation()).toBe(false);
    expect(
      reliability
        .listAllNonterminalStreamingCards()
        .find((item) => item.turnRunId === runtime.runId),
    ).toMatchObject({
      status: 'creating',
      messageId: 'om_provider_visible',
      cardId: 'card_provider_visible',
    });
    lifecycle.onEvent({
      status: 'aborted',
      messageId: 'om_provider_visible',
      cardId: 'card_provider_visible',
      version: 2,
      snapshot: { text: '' },
      error: 'test cleanup',
    });
    expect(runtime.interrupt('test cleanup')).toBe(true);
    runtime.dispose();
  });

  test('exposes a lost lease and refuses a false successful completion', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-23T07:00:00.000Z'));
    const runtime = ChannelTurnRuntime.start({
      ...route,
      externalMessageId: 'msg-lost-lease',
      agentId: 'agent-lost-lease',
      leaseMs: 5_000,
      heartbeatMs: 2_000,
    });
    const lifecycle = runtime.reserveStreamingCard()!;
    vi.setSystemTime(new Date('2026-07-23T07:00:06.000Z'));
    lifecycle.onEvent({
      status: 'streaming',
      messageId: 'om_lost_lease',
      cardId: 'card_lost_lease',
      version: 1,
      snapshot: { text: 'late final' },
    });
    expect(runtime.markFinalizing()).toBe(false);
    expect(runtime.hasLostFence).toBe(true);
    expect(runtime.complete()).toBe(false);
    expect(
      reliability.interruptExpiredChannelTurnRuns('2026-07-23T07:00:06.001Z'),
    ).toBeGreaterThanOrEqual(1);
    const strandedCard = reliability
      .listAllNonterminalStreamingCards()
      .find((card) => card.turnRunId === runtime.runId)!;
    expect(
      reliability.finalizeStreamingCardRecord(
        strandedCard.id,
        strandedCard.revision,
        {
          status: 'aborted',
          error: 'test cleanup after simulated lease loss',
        },
      ),
    ).toBeDefined();
    runtime.dispose();
    vi.useRealTimers();
  });

  test('persists fenced running/waiting/finalizing/complete and card snapshots', () => {
    const runtime = ChannelTurnRuntime.start({
      ...route,
      externalMessageId: 'msg-lifecycle-1',
      agentId: 'agent-lifecycle',
    });
    expect(runtime.isClaimed).toBe(true);
    const lifecycle = runtime.reserveStreamingCard();
    expect(lifecycle).toBeDefined();

    lifecycle!.onEvent({
      status: 'creating',
      messageId: null,
      cardId: null,
      version: 0,
      snapshot: {
        text: '',
        thinking: '分析中',
        state: 'creating',
        backendMode: 'v1',
      },
    });
    lifecycle!.onEvent({
      status: 'streaming',
      messageId: 'om_runtime',
      cardId: 'card_runtime',
      version: 3,
      snapshot: {
        text: '部分回答',
        thinking: '分析中',
        state: 'streaming',
        backendMode: 'streaming',
      },
    });
    lifecycle!.onEvent({
      status: 'waiting_user',
      messageId: 'om_runtime',
      cardId: 'card_runtime',
      version: 4,
      snapshot: {
        text: '请补充信息',
        thinking: '',
        state: 'streaming',
        backendMode: 'streaming',
      },
    });
    expect(reliability.getChannelTurnRun(runtime.runId)?.status).toBe(
      'waiting_user',
    );

    lifecycle!.onEvent({
      status: 'running',
      messageId: 'om_runtime',
      cardId: 'card_runtime',
      version: 5,
      snapshot: {
        text: '继续处理',
        thinking: '',
        state: 'streaming',
        backendMode: 'streaming',
      },
    });
    expect(reliability.getChannelTurnRun(runtime.runId)?.status).toBe(
      'running',
    );

    lifecycle!.onEvent({
      status: 'finalizing',
      messageId: 'om_runtime',
      cardId: 'card_runtime',
      version: 6,
      snapshot: {
        text: '最终回答',
        thinking: '',
        state: 'completed',
        backendMode: 'streaming',
      },
    });
    expect(reliability.getChannelTurnRun(runtime.runId)?.status).toBe(
      'running',
    );

    lifecycle!.onEvent({
      status: 'completed',
      messageId: 'om_runtime',
      cardId: 'card_runtime',
      version: 7,
      snapshot: {
        text: '最终回答',
        thinking: '',
        state: 'completed',
        backendMode: 'streaming',
      },
    });
    expect(reliability.getChannelTurnRun(runtime.runId)?.status).toBe(
      'running',
    );
    expect(reliability.scanChannelReliabilityNonterminal().cards).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ turnRunId: runtime.runId }),
      ]),
    );
    expect(runtime.markFinalizing()).toBe(true);
    expect(runtime.complete({ delivered: true })).toBe(true);
    expect(reliability.getChannelTurnRun(runtime.runId)?.status).toBe(
      'completed',
    );
    runtime.dispose();
  });

  test('a visible partial card completion is fenced from automatic replay', () => {
    const input = {
      ...route,
      externalMessageId: 'msg-partial-then-close',
      agentId: 'agent-partial-then-close',
    };
    const runtime = ChannelTurnRuntime.start(input);
    const lifecycle = runtime.reserveStreamingCard()!;
    lifecycle.onEvent({
      status: 'completed',
      messageId: 'om_partial_then_close',
      cardId: 'card_partial_then_close',
      version: 2,
      snapshot: { text: 'compact partial' },
    });
    expect(reliability.getChannelTurnRun(runtime.runId)?.status).toBe(
      'running',
    );
    expect(runtime.retry('runner closed before authoritative final')).toBe(
      true,
    );
    runtime.dispose();

    const replay = ChannelTurnRuntime.start(input);
    expect(replay.executionDisposition).toBe('manual_reconciliation');
    expect(reliability.getChannelTurnRun(replay.runId)).toMatchObject({
      status: 'interrupted',
      error: expect.stringContaining('manual reconciliation required'),
    });
    replay.dispose();
  });

  test('startup respects a live finalizing lease before fencing delivered effects', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-23T07:30:00.000Z'));
    const input = {
      ...route,
      externalMessageId: 'msg-finalizing-delivery-survived',
      agentId: 'agent-finalizing-delivery-survived',
      leaseMs: 5_000,
      heartbeatMs: 2_000,
    };
    const runtime = ChannelTurnRuntime.start(input);
    const lifecycle = runtime.reserveStreamingCard()!;
    lifecycle.onEvent({
      status: 'completed',
      messageId: 'om_finalizing_survived',
      cardId: 'card_finalizing_survived',
      version: 2,
      snapshot: { text: 'delivered final' },
    });
    const outbox = reliability.enqueueChannelOutbox({
      ...route,
      turnRunId: runtime.runId,
      ordinal: 0,
      kind: 'file',
      payload: { fileName: 'finalizing-delivered.pdf' },
    }).item;
    const claim = reliability.claimChannelOutboxById(
      outbox.id,
      'delivery-worker-finalizing',
      60_000,
    )!;
    expect(reliability.markChannelOutboxSending(claim)).toBe(true);
    expect(
      reliability.completeChannelOutbox(claim, {
        providerMessageId: 'provider-finalizing-ack',
      }),
    ).toBe(true);
    expect(runtime.markFinalizing()).toBe(true);
    runtime.dispose();

    vi.setSystemTime(new Date('2026-07-23T07:30:01.000Z'));
    await expect(
      reconcileChannelReliabilityOnStartup({
        reconcileStreamingCard: vi.fn(),
      }),
    ).resolves.toMatchObject({ interruptedTurns: 0 });
    expect(reliability.getChannelTurnRun(runtime.runId)?.status).toBe(
      'finalizing',
    );

    vi.setSystemTime(new Date('2026-07-23T07:30:06.000Z'));
    await expect(
      reconcileChannelReliabilityOnStartup({
        reconcileStreamingCard: vi.fn(),
      }),
    ).resolves.toMatchObject({ interruptedTurns: 1 });
    expect(reliability.getChannelTurnRun(runtime.runId)).toMatchObject({
      status: 'interrupted',
      leaseOwner: null,
      error: expect.stringContaining('manual reconciliation required'),
    });
    const replay = ChannelTurnRuntime.start(input);
    expect(replay.executionDisposition).toBe('manual_reconciliation');
    replay.dispose();
    vi.useRealTimers();
  });

  test('late completion of input A cannot mutate input B card or turn', () => {
    const first = ChannelTurnRuntime.start({
      ...route,
      externalMessageId: 'msg-warm-interleave-a',
      agentId: 'agent-warm-interleave',
    });
    const second = ChannelTurnRuntime.start({
      ...route,
      externalMessageId: 'msg-warm-interleave-b',
      agentId: 'agent-warm-interleave',
    });
    const cards = new Map([
      ['a', first.reserveStreamingCard()!],
      ['b', second.reserveStreamingCard()!],
    ]);
    cards.get('a')!.onEvent({
      status: 'streaming',
      messageId: 'om_warm_a',
      cardId: 'card_warm_a',
      version: 1,
      snapshot: { text: 'A partial' },
    });
    cards.get('b')!.onEvent({
      status: 'streaming',
      messageId: 'om_warm_b',
      cardId: 'card_warm_b',
      version: 1,
      snapshot: { text: 'B partial' },
    });

    // B has already been admitted when A's final callback arrives late.
    cards.get('a')!.onEvent({
      status: 'completed',
      messageId: 'om_warm_a',
      cardId: 'card_warm_a',
      version: 2,
      snapshot: { text: 'A final' },
    });
    const bCard = reliability
      .listAllNonterminalStreamingCards()
      .find((card) => card.turnRunId === second.runId);
    expect(bCard).toMatchObject({
      status: 'streaming',
      messageId: 'om_warm_b',
      cardId: 'card_warm_b',
      snapshot: { text: 'B partial' },
    });
    expect(reliability.getChannelTurnRun(second.runId)?.status).toBe('running');

    expect(first.markFinalizing()).toBe(true);
    expect(first.complete()).toBe(true);
    cards.get('b')!.onEvent({
      status: 'completed',
      messageId: 'om_warm_b',
      cardId: 'card_warm_b',
      version: 2,
      snapshot: { text: 'B final' },
    });
    expect(second.markFinalizing()).toBe(true);
    expect(second.complete()).toBe(true);
    first.dispose();
    second.dispose();
  });

  test('restart reconciles the original card before the turn is interrupted and suppresses duplicates', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-23T08:00:00.000Z'));
    const input = {
      ...route,
      externalMessageId: 'msg-sigkill-1',
      agentId: 'agent-sigkill',
      leaseMs: 5_000,
      heartbeatMs: 2_000,
    };
    const first = ChannelTurnRuntime.start(input);
    const lifecycle = first.reserveStreamingCard()!;
    lifecycle.onEvent({
      status: 'streaming',
      messageId: 'om_old_process',
      cardId: 'card_old_process',
      version: 9,
      snapshot: {
        text: '旧进程的部分内容',
        thinking: '',
        state: 'streaming',
        backendMode: 'streaming',
      },
    });
    first.dispose(); // SIGKILL equivalent: no terminal transition, lease remains.
    // Immediate restart must not override another possibly-live process.
    vi.setSystemTime(new Date('2026-07-23T08:00:01.000Z'));

    const reconcile = vi.fn().mockResolvedValue({
      version: 11,
      method: 'cardkit' as const,
    });
    await expect(
      reconcileChannelReliabilityOnStartup({
        reconcileStreamingCard: reconcile,
      }),
    ).resolves.toEqual({ reconciled: 0, deferred: 1, interruptedTurns: 0 });
    expect(reconcile).not.toHaveBeenCalled();
    expect(reliability.getChannelTurnRun(first.runId)?.status).toBe('running');

    // A dead process can delay recovery only until its bounded lease expires;
    // the live boot-backlog pass then owns the exact persisted card.
    const loop = startChannelReliabilityRecoveryLoop(
      { reconcileStreamingCard: reconcile },
      { intervalMs: 60_000 },
    );
    vi.setSystemTime(new Date('2026-07-23T08:00:06.000Z'));
    await loop.trigger();
    loop.stop();
    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: 'om_old_process',
        cardId: 'card_old_process',
        accountId: 'bot-runtime',
      }),
    );
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reliability.getChannelTurnRun(first.runId)?.status).toBe(
      'interrupted',
    );

    const replay = ChannelTurnRuntime.start(input);
    expect(replay.isClaimed).toBe(false);
    expect(replay.reserveStreamingCard()).toBeUndefined();
    replay.dispose();
    vi.useRealTimers();
  });

  test('startup fences a creating card whose provider identity was never persisted', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-23T08:10:00.000Z'));
    const input = {
      ...route,
      externalMessageId: 'msg-crash-before-card-id-persist',
      agentId: 'agent-crash-before-card-id-persist',
      leaseMs: 60_000,
      heartbeatMs: 5_000,
    };
    const runtime = ChannelTurnRuntime.start(input);
    runtime.reserveStreamingCard();
    const card = reliability
      .listAllNonterminalStreamingCards()
      .find((item) => item.turnRunId === runtime.runId)!;
    expect(card).toMatchObject({
      status: 'creating',
      messageId: null,
      cardId: null,
    });
    runtime.dispose(); // provider create may have succeeded, but IDs never reached SQLite.

    // A possibly-live sibling process owns the row until its lease expires.
    vi.setSystemTime(new Date('2026-07-23T08:10:01.000Z'));
    const reconcile = vi.fn();
    await expect(
      reconcileChannelReliabilityOnStartup({
        reconcileStreamingCard: reconcile,
      }),
    ).resolves.toEqual({ reconciled: 0, deferred: 1, interruptedTurns: 0 });
    expect(reconcile).not.toHaveBeenCalled();
    expect(reliability.getStreamingCardRecord(card.id)?.status).toBe(
      'creating',
    );
    expect(reliability.getChannelTurnRun(runtime.runId)?.status).toBe(
      'running',
    );

    vi.setSystemTime(new Date('2026-07-23T08:11:01.000Z'));
    await expect(
      reconcileChannelReliabilityOnStartup({
        reconcileStreamingCard: reconcile,
      }),
    ).resolves.toEqual({ reconciled: 1, deferred: 0, interruptedTurns: 1 });
    expect(reconcile).not.toHaveBeenCalled();
    expect(reliability.getStreamingCardRecord(card.id)).toMatchObject({
      status: 'failed',
      messageId: null,
      cardId: null,
      error: expect.stringContaining('manual reconciliation required'),
      snapshot: expect.objectContaining({
        recovery: {
          reason: 'missing_provider_identity',
          method: 'manual_reconciliation',
        },
      }),
    });
    expect(reliability.getChannelTurnRun(runtime.runId)).toMatchObject({
      status: 'interrupted',
      leaseOwner: null,
      error: expect.stringContaining('manual reconciliation required'),
    });

    const replay = ChannelTurnRuntime.start(input);
    expect(replay.executionDisposition).toBe('manual_reconciliation');
    expect(replay.isClaimed).toBe(false);
    expect(replay.reserveStreamingCard()).toBeUndefined();
    replay.dispose();
    vi.useRealTimers();
  });

  test('a deferred exact-bot recovery remains replayable and succeeds when the bot becomes ready', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-23T08:20:00.000Z'));
    const runtime = ChannelTurnRuntime.start({
      ...route,
      externalMessageId: 'msg-deferred-bot',
      agentId: 'agent-deferred-bot',
      leaseMs: 5_000,
      heartbeatMs: 2_000,
    });
    const lifecycle = runtime.reserveStreamingCard()!;
    lifecycle.onEvent({
      status: 'streaming',
      messageId: 'om_deferred_bot',
      cardId: 'card_deferred_bot',
      version: 3,
      snapshot: { text: 'partial' },
    });
    runtime.dispose();
    vi.setSystemTime(new Date('2026-07-23T08:20:06.000Z'));

    const unavailable = vi.fn().mockRejectedValue(new Error('bot offline'));
    await expect(
      reconcileChannelReliabilityOnStartup({
        reconcileStreamingCard: unavailable,
      }),
    ).resolves.toMatchObject({ reconciled: 0, deferred: 1 });
    const deferredCard = reliability
      .scanChannelReliabilityNonterminal()
      .cards.find((item) => item.turnRunId === runtime.runId);
    expect(deferredCard).toMatchObject({ status: 'streaming' });

    const ready = vi.fn().mockResolvedValue({
      version: 5,
      method: 'cardkit' as const,
    });
    await expect(
      reconcileChannelReliabilityOnStartup({
        reconcileStreamingCard: ready,
      }),
    ).resolves.toMatchObject({ reconciled: 1, deferred: 0 });
    expect(ready).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'bot-runtime' }),
    );
    expect(reliability.getChannelTurnRun(runtime.runId)?.status).toBe(
      'interrupted',
    );
    vi.useRealTimers();
  });

  test('reconciles every card beyond the former 1000-row startup cap', async () => {
    const run = reliability.createChannelTurnRun({
      ...route,
      idempotencyKey: 'turn:pagination-1001',
    }).run;
    for (let index = 0; index < 1_001; index++) {
      reliability.createStreamingCardRecord({
        ...route,
        id: `stream-pagination-${index}`,
        turnRunId: run.id,
        messageId: `om-pagination-${index}`,
        status: 'streaming',
      });
    }
    const reconcile = vi.fn().mockResolvedValue({
      version: 1,
      method: 'message_patch' as const,
    });
    await expect(
      reconcileChannelReliabilityOnStartup({
        reconcileStreamingCard: reconcile,
      }),
    ).resolves.toMatchObject({ reconciled: 1_001, deferred: 0 });
    expect(reconcile).toHaveBeenCalledTimes(1_001);
    expect(
      reliability
        .listAllNonterminalStreamingCards()
        .filter((card) => card.id.startsWith('stream-pagination-')),
    ).toHaveLength(0);
  });

  test('live recovery never aborts a current-process card that runs longer than its interval', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-23T09:00:00.000Z'));
    const reconcile = vi.fn().mockResolvedValue({
      version: 2,
      method: 'cardkit' as const,
    });
    const loop = startChannelReliabilityRecoveryLoop(
      { reconcileStreamingCard: reconcile },
      { intervalMs: 1_000 },
    );
    const runtime = ChannelTurnRuntime.start({
      ...route,
      externalMessageId: 'msg-live-long-running',
      agentId: 'agent-live-long-running',
      leaseMs: 45_000,
      heartbeatMs: 5_000,
    });
    const lifecycle = runtime.reserveStreamingCard()!;
    lifecycle.onEvent({
      status: 'streaming',
      messageId: 'om_live_long_running',
      cardId: 'card_live_long_running',
      version: 1,
      snapshot: { text: 'still working' },
    });

    await vi.advanceTimersByTimeAsync(20_000);
    expect(reconcile).not.toHaveBeenCalled();
    expect(reliability.getChannelTurnRun(runtime.runId)?.status).toBe(
      'running',
    );
    expect(
      reliability.getStreamingCardRecord(
        reliability
          .listAllNonterminalStreamingCards()
          .find((card) => card.turnRunId === runtime.runId)!.id,
      )?.status,
    ).toBe('streaming');

    lifecycle.onEvent({
      status: 'completed',
      messageId: 'om_live_long_running',
      cardId: 'card_live_long_running',
      version: 2,
      snapshot: { text: 'done' },
    });
    expect(runtime.markFinalizing()).toBe(true);
    expect(runtime.complete()).toBe(true);
    runtime.dispose();
    loop.stop();
    vi.useRealTimers();
  });
});

describe('provider reconciliation', () => {
  test('updates the original CardKit card instead of creating a replacement', async () => {
    const settings = vi.fn().mockResolvedValue({});
    const update = vi.fn().mockResolvedValue({});
    const create = vi.fn();
    const client = {
      cardkit: { v1: { card: { settings, update, create } } },
      im: { v1: { message: { patch: vi.fn(), create: vi.fn() } } },
    } as any;

    await expect(
      reconcileInterruptedStreamingCard(client, {
        messageId: 'om_original',
        cardId: 'card_original',
        version: 20,
        snapshot: { text: '保留的部分回答' },
      }),
    ).resolves.toEqual({ version: 22, method: 'cardkit' });
    expect(settings).toHaveBeenCalledWith(
      expect.objectContaining({ path: { card_id: 'card_original' } }),
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        path: { card_id: 'card_original' },
        data: expect.objectContaining({ sequence: 22 }),
      }),
    );
    expect(create).not.toHaveBeenCalled();
  });
});
