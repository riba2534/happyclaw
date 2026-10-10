import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-host-guards-'));
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
const store = await import('../src/channel-reliability-store.js');
const { ChannelTurnRuntime } = await import('../src/channel-turn-runtime.js');
const { deliverChannelOutboxItem, DefinitiveChannelDeliveryError } =
  await import('../src/channel-outbox-delivery.js');
const runtimeScope = await import('../src/channel-outbox-runtime-scope.js');
const { createRuntimeSourceHarness } =
  await import('./helpers/runtime-source.js');

beforeAll(() => db.initDatabase());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;
let seq = 0;
function route(name: string) {
  seq += 1;
  const chatId = `oc_${name}_${seq}`;
  return {
    provider: 'feishu',
    accountId: `bot-${name}-${seq}`,
    sourceJid: `feishu:${chatId}`,
    chatId,
    rootId: null,
    threadId: null,
  };
}

function processedInbox(
  r: ReturnType<typeof route>,
  externalMessageId: string,
  at: Date,
) {
  const { item } = store.recordChannelInbox({
    ...r,
    externalMessageId,
    status: 'queued',
    now: at,
  });
  const claim = store.claimChannelInboxById(item.id, 'worker', 60_000, at)!;
  expect(store.completeChannelInbox(claim, at)).toBe(true);
  return item;
}

describe('inbox retention keeps backfill dedupe receipts (prod P1-1)', () => {
  test('a quiet chat keeps receipts inside its cursor lookback, others age out', () => {
    const now = Date.now();
    const quiet = route('quiet');
    const busy = route('busy');
    const old = new Date(now - 31 * DAY);
    // Quiet chat: cursor stuck 31 days ago, messages right after it.
    store.advanceChannelCursor({
      provider: quiet.provider,
      accountId: quiet.accountId,
      scope: 'chat',
      chatId: quiet.chatId,
      cursor: 'om_quiet_cursor',
      position: old.getTime() - 60_000,
    });
    const quietRow = processedInbox(quiet, 'om_quiet_1', old);
    // Busy chat: cursor moved on long after the old message.
    store.advanceChannelCursor({
      provider: busy.provider,
      accountId: busy.accountId,
      scope: 'chat',
      chatId: busy.chatId,
      cursor: 'om_busy_cursor',
      position: now - DAY,
    });
    const busyRow = processedInbox(busy, 'om_busy_1', old);

    store.cleanupChannelReliability({
      payloadsBefore: new Date(now - 7 * DAY).toISOString(),
      recordsBefore: new Date(now - 30 * DAY).toISOString(),
    });

    expect(store.getChannelInboxItem(quietRow.id)).toBeDefined();
    expect(store.getChannelInboxItem(busyRow.id)).toBeUndefined();
  });

  test('a started Turn links the inbox receipt of its input; later Turns of the same input do not conflict', () => {
    const r = route('link');
    const inbox = processedInbox(r, 'om_link_1', new Date());
    const main = ChannelTurnRuntime.start({
      ...r,
      externalMessageId: 'om_link_1',
    });
    expect(store.getChannelTurnRun(main.runId)?.inboxId).toBe(inbox.id);
    const other = ChannelTurnRuntime.start({
      ...r,
      externalMessageId: 'om_link_1',
      agentId: 'session-2',
    });
    expect(store.getChannelTurnRun(other.runId)?.inboxId).toBeNull();
    main.dispose();
    other.dispose();
  });
});

describe('retry_wait is never a dead state (prod P1-2)', () => {
  test('stale retry_wait Turns are cancelled by the sweep', () => {
    const r = route('stale');
    const runtime = ChannelTurnRuntime.start({
      ...r,
      externalMessageId: 'om_stale_1',
    });
    expect(runtime.retry('runner closed')).toBe(true);
    expect(store.getChannelTurnRun(runtime.runId)?.status).toBe('retry_wait');
    // A fresh row is inside the bound and kept.
    store.cancelStaleRetryWaitChannelTurns({
      updatedBefore: new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString(),
      reason: 'expired',
    });
    expect(store.getChannelTurnRun(runtime.runId)?.status).toBe('retry_wait');
    store.cancelStaleRetryWaitChannelTurns({
      updatedBefore: new Date(Date.now() + 1000).toISOString(),
      reason: 'expired',
    });
    expect(store.getChannelTurnRun(runtime.runId)).toMatchObject({
      status: 'cancelled',
      error: 'expired',
    });
    runtime.dispose();
  });

  test('withdrawn inputs close their retry_wait Turns', () => {
    const r = route('withdrawn');
    const runtime = ChannelTurnRuntime.start({
      ...r,
      externalMessageId: 'om_withdrawn_1',
    });
    runtime.retry('interrupted');
    expect(
      store.cancelRetryWaitChannelTurnsForInputs({
        ...runtime.channelScope,
        correlationIds: ['om_withdrawn_1', 'om_other'],
        reason: 'Input cancelled by /break',
      }),
    ).toBe(1);
    expect(store.getChannelTurnRun(runtime.runId)?.status).toBe('cancelled');
    runtime.dispose();
  });

  test('two Bots and two sessions seeing the same om_ id stay independent (M2)', () => {
    const shared = route('shared-chat');
    const botA = { ...shared, accountId: 'bot-a-shared' };
    const botB = { ...shared, accountId: 'bot-b-shared' };
    const turnA = ChannelTurnRuntime.start({
      ...botA,
      externalMessageId: 'om_same_message',
    });
    const turnB = ChannelTurnRuntime.start({
      ...botB,
      externalMessageId: 'om_same_message',
    });
    const turnBSession = ChannelTurnRuntime.start({
      ...botB,
      externalMessageId: 'om_same_message',
      agentId: 'session-x',
    });
    for (const turn of [turnA, turnB, turnBSession]) turn.retry('transient');

    // Bot A's batch covers the message: only Bot A's main-session Turn closes.
    expect(
      store.cancelRetryWaitChannelTurnsForInputs({
        provider: 'feishu',
        accountId: 'bot-a-shared',
        agentId: null,
        correlationIds: ['om_same_message'],
        reason: 'Input covered by a later batch turn',
      }),
    ).toBe(1);
    expect(store.getChannelTurnRun(turnA.runId)?.status).toBe('cancelled');
    expect(store.getChannelTurnRun(turnB.runId)?.status).toBe('retry_wait');
    expect(store.getChannelTurnRun(turnBSession.runId)?.status).toBe(
      'retry_wait',
    );
    // Bot B's session scope closes only its own session Turn.
    expect(
      store.cancelRetryWaitChannelTurnsForInputs({
        ...turnBSession.channelScope,
        correlationIds: ['om_same_message'],
        reason: 'withdrawn',
      }),
    ).toBe(1);
    expect(store.getChannelTurnRun(turnB.runId)?.status).toBe('retry_wait');
    for (const turn of [turnA, turnB, turnBSession]) turn.dispose();
  });

  test('a turn-scoped provider retry-later refusal ends failed', async () => {
    const r = route('retry-later');
    const runtime = ChannelTurnRuntime.start({
      ...r,
      externalMessageId: 'om_retry_later',
    });
    const result = await deliverChannelOutboxItem({
      ...r,
      turnRunId: runtime.runId,
      ordinal: 1,
      kind: 'text',
      payload: { text: 'hi' },
      owner: 'outbox',
      retryWaitPolicy: 'fail',
      delivery: {
        mode: 'single',
        send: async () => {
          throw new DefinitiveChannelDeliveryError('rate limited', {
            retryAt: new Date(Date.now() + 60_000).toISOString(),
            cause: { response: { status: 400, data: { code: 230020 } } },
          });
        },
      },
    });
    expect(result.status).toBe('failed');
    expect(store.getChannelOutboxItem(result.itemId)?.status).toBe('failed');
    expect(result.cause).toBeInstanceOf(DefinitiveChannelDeliveryError);
    runtime.dispose();
  });

  test('the default policy still keeps a worker-owned retry_wait row', async () => {
    const r = route('retain');
    const runtime = ChannelTurnRuntime.start({
      ...r,
      externalMessageId: 'om_retain',
    });
    const result = await deliverChannelOutboxItem({
      ...r,
      turnRunId: runtime.runId,
      ordinal: 1,
      kind: 'mutation',
      payload: { op: 'x' },
      owner: 'outbox',
      delivery: {
        mode: 'single',
        send: async () => {
          throw new DefinitiveChannelDeliveryError('429', {
            retryAt: new Date(Date.now() + 60_000).toISOString(),
          });
        },
      },
    });
    expect(result.status).toBe('retry_wait');
    runtime.dispose();
  });
});

describe('uncertain Feishu sends replay once with the same identity (outbound P1-6)', () => {
  test('an ACK-lost send converges to delivered with one replay of the same row', async () => {
    const r = route('replay');
    const runtime = ChannelTurnRuntime.start({
      ...r,
      externalMessageId: 'om_replay',
    });
    const seen: string[] = [];
    const result = await deliverChannelOutboxItem({
      ...r,
      turnRunId: runtime.runId,
      ordinal: 1,
      kind: 'text',
      payload: { text: 'hi' },
      owner: 'outbox',
      replayUncertainOnce: { delayMs: 0 },
      delivery: {
        mode: 'single',
        send: async ({ item }) => {
          seen.push(item.id);
          if (seen.length === 1) throw new Error('ETIMEDOUT after write');
          return { providerMessageId: 'om_sent' };
        },
      },
    });
    expect(result).toMatchObject({ status: 'delivered', replayed: true });
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    expect(store.getUncertainChannelOutboxForTurn(runtime.runId)).toBe(
      undefined,
    );
    runtime.dispose();
  });

  test('a send that stays ambiguous after the replay is uncertain; no third attempt', async () => {
    const r = route('replay-twice');
    const runtime = ChannelTurnRuntime.start({
      ...r,
      externalMessageId: 'om_replay_twice',
    });
    let calls = 0;
    const result = await deliverChannelOutboxItem({
      ...r,
      turnRunId: runtime.runId,
      ordinal: 1,
      kind: 'text',
      payload: { text: 'hi' },
      owner: 'outbox',
      replayUncertainOnce: { delayMs: 0 },
      delivery: {
        mode: 'single',
        send: async () => {
          calls += 1;
          throw new Error('socket hang up');
        },
      },
    });
    expect(calls).toBe(2);
    expect(result.status).toBe('uncertain');
    expect(result.error).toContain('after one idempotent replay');
    runtime.dispose();
  });

  test.each([
    ['230049 "message is being sent"', 230049, 'uncertain'],
    ['a rate limit', 230020, 'uncertain'],
    ['an unknown code', 239999, 'uncertain'],
    ['a DLP content refusal', 230028, 'failed'],
    ['a recalled anchor', 230011, 'failed'],
  ] as const)(
    'a replay refused with %s ends %s (should-fix 1)',
    async (_label, code, expected) => {
      const r = route(`replay-refused-${code}`);
      const runtime = ChannelTurnRuntime.start({
        ...r,
        externalMessageId: `om_replay_refused_${code}`,
      });
      let calls = 0;
      const result = await deliverChannelOutboxItem({
        ...r,
        turnRunId: runtime.runId,
        ordinal: 1,
        kind: 'text',
        payload: { text: 'hi' },
        owner: 'outbox',
        replayUncertainOnce: { delayMs: 0 },
        delivery: {
          mode: 'single',
          send: async () => {
            calls += 1;
            if (calls === 1) throw new Error('ETIMEDOUT after write');
            throw new DefinitiveChannelDeliveryError('Feishu refused', {
              cause: { response: { status: 400, data: { code } } },
            });
          },
        },
      });
      expect(calls).toBe(2);
      expect(result.status).toBe(expected);
      runtime.dispose();
    },
  );
});

/**
 * The provider decision lives in index.ts `deliverScopedChannelOutput`; run
 * that production function against the real store and delivery engine.
 */
function scopedDeliveryHarness(provider: 'feishu' | 'telegram', name: string) {
  const r = { ...route(name), provider };
  const runtime = ChannelTurnRuntime.start({
    ...r,
    externalMessageId: `${provider}_${name}`,
  });
  const scope = {
    ...r,
    turnRunId: runtime.runId,
    owner: `owner:${name}`,
    token: 'token',
  };
  const deliverChannelOutboxItemSpy = vi.fn(
    (input: Parameters<typeof deliverChannelOutboxItem>[0]) =>
      deliverChannelOutboxItem(input),
  );
  const globals: Record<string, unknown> = {
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    activeChannelOutboxScopes: { resolveToken: () => scope },
    getChannelTurnRun: store.getChannelTurnRun,
    getUncertainChannelOutboxForTurn: store.getUncertainChannelOutboxForTurn,
    CHANNEL_RELIABILITY_TERMINAL_STATUSES:
      store.CHANNEL_RELIABILITY_TERMINAL_STATUSES,
    semanticChannelOutboxIdentity: runtimeScope.semanticChannelOutboxIdentity,
    stableChannelOutboxOrdinal: runtimeScope.stableChannelOutboxOrdinal,
    syntheticChannelProviderAck: runtimeScope.syntheticChannelProviderAck,
    deliverChannelOutboxItem: deliverChannelOutboxItemSpy,
    rememberChannelOutboxFailure: () => ({}),
    FEISHU_UNCERTAIN_REPLAY_DELAY_MS: 0,
    FEISHU_OUTBOX_LEASE_MS: 120_000,
  };
  const harness = createRuntimeSourceHarness(globals);
  for (const fn of [
    'ScopedChannelDeliveryError',
    'isLogicalSessionSendTarget',
    'deliverScopedChannelOutput',
  ]) {
    harness.install(fn);
  }
  return {
    runtime,
    deliverChannelOutboxItemSpy,
    send: (sendFn: () => Promise<void>, failure: { error?: any } = {}) =>
      (
        globals.deliverScopedChannelOutput as (
          ...args: unknown[]
        ) => Promise<boolean | null>
      )(
        r.sourceJid,
        { scopeKey: 'scope', scopeToken: 'token', operationKey: 'reply' },
        { kind: 'text', payload: { text: 'hi' }, send: sendFn, failure },
      ),
  };
}

describe('provider-scoped replay and lease in deliverScopedChannelOutput', () => {
  test('a Feishu ACK loss is replayed once with a lease covering both attempts', async () => {
    const h = scopedDeliveryHarness('feishu', 'scoped-feishu');
    let calls = 0;
    const delivered = await h.send(async () => {
      if (++calls === 1) throw new Error('socket hang up');
    });
    expect(delivered).toBe(true);
    expect(calls).toBe(2);
    const input = h.deliverChannelOutboxItemSpy.mock.calls[0]![0];
    expect(input.leaseMs).toBeGreaterThanOrEqual(2 * 15_000 + 1_000);
    expect(input.retryWaitPolicy).toBe('fail');
    h.runtime.dispose();
  });

  test('a provider without idempotent sends is never replayed', async () => {
    const h = scopedDeliveryHarness('telegram', 'scoped-telegram');
    let calls = 0;
    const failure: { error?: any } = {};
    const delivered = await h.send(async () => {
      calls += 1;
      throw new Error('socket hang up');
    }, failure);
    expect(delivered).toBe(false);
    expect(calls).toBe(1);
    expect(failure.error.status).toBe('uncertain');
    expect(
      h.deliverChannelOutboxItemSpy.mock.calls[0]![0].replayUncertainOnce,
    ).toBeFalsy();
    h.runtime.dispose();
  });
});

describe('streaming card reservations never outlive their Turn unpublished (prod P2-9)', () => {
  test('a reservation no controller ever touched is retired when the Turn completes', () => {
    const r = route('card-retire');
    const runtime = ChannelTurnRuntime.start({
      ...r,
      externalMessageId: 'om_card_retire',
    });
    const lifecycle = runtime.reserveStreamingCard();
    expect(lifecycle).toBeDefined();
    const cardId = `stream_${crypto
      .createHash('sha256')
      .update(`${runtime.runId}:primary`)
      .digest('hex')
      .slice(0, 32)}`;
    expect(store.getStreamingCardRecord(cardId)?.status).toBe('creating');
    // The durable card id doubles as the controller's idempotency key, so
    // Feishu message uuids are stable across processes.
    expect(lifecycle?.idempotencyKey).toBe(cardId);
    expect(runtime.markFinalizing()).toBe(true);
    expect(runtime.complete({ ok: true })).toBe(true);
    expect(store.getStreamingCardRecord(cardId)).toBeUndefined();
    runtime.dispose();
  });

  test('a card whose controller started provider creation is preserved', () => {
    const r = route('card-keep');
    const runtime = ChannelTurnRuntime.start({
      ...r,
      externalMessageId: 'om_card_keep',
    });
    const lifecycle = runtime.reserveStreamingCard()!;
    lifecycle.onEvent({
      status: 'creating',
      version: 0,
      snapshot: { text: '', thinking: '', state: 'creating' },
    } as never);
    runtime.fail('provider failed');
    const cardId = `stream_${crypto
      .createHash('sha256')
      .update(`${runtime.runId}:primary`)
      .digest('hex')
      .slice(0, 32)}`;
    expect(store.getStreamingCardRecord(cardId)?.status).toBe('creating');
    runtime.dispose();
  });
});

describe('final-reply image dedupe (prod P2-8)', () => {
  test('finds an image already delivered in the same Turn by content hash', async () => {
    const r = route('image');
    const runtime = ChannelTurnRuntime.start({
      ...r,
      externalMessageId: 'om_image',
    });
    await deliverChannelOutboxItem({
      ...r,
      turnRunId: runtime.runId,
      ordinal: 7,
      kind: 'image',
      payload: { contentHash: 'abc', fileName: 'chart.png' },
      owner: 'outbox',
      delivery: {
        mode: 'single',
        send: async () => ({ providerMessageId: 'om_img' }),
      },
    });
    expect(
      store.hasDeliveredChannelImageWithContentHash(runtime.runId, 'abc'),
    ).toBe(true);
    expect(
      store.hasDeliveredChannelImageWithContentHash(runtime.runId, 'def'),
    ).toBe(false);
    runtime.dispose();
  });
});

describe('refused card bodies delivered statically are marked on the card (M3)', () => {
  test('the card snapshot records staticFallbackDelivered for recovery', () => {
    const r = route('static-marker');
    const runtime = ChannelTurnRuntime.start({
      ...r,
      externalMessageId: 'om_static_marker',
    });
    const lifecycle = runtime.reserveStreamingCard()!;
    lifecycle.onEvent({
      status: 'creating',
      version: 0,
      snapshot: { text: 'streamed body', thinking: '', state: 'creating' },
    } as never);
    expect(runtime.markStreamingCardStaticFallbackDelivered()).toBe(true);
    const card = store.getStreamingCardRecord(lifecycle.idempotencyKey!);
    expect(card?.snapshot).toMatchObject({
      text: 'streamed body',
      staticFallbackDelivered: true,
    });
    runtime.dispose();
  });
});

describe('inbound metadata helpers', () => {
  test('a private chat mode is learned once and never overwrites group/topic', () => {
    const base = {
      name: 'chat',
      folder: 'ws-learn',
      added_at: new Date().toISOString(),
    };
    db.setRegisteredGroup('feishu:oc_learn_dm', base as never);
    db.setRegisteredGroup('feishu:oc_learn_group', {
      ...base,
      feishu_chat_mode: 'group',
    } as never);
    expect(db.learnFeishuDirectChatMode('feishu:oc_learn_dm')).toBe(true);
    expect(db.getRegisteredGroup('feishu:oc_learn_dm')?.feishu_chat_mode).toBe(
      'p2p',
    );
    expect(db.learnFeishuDirectChatMode('feishu:oc_learn_dm')).toBe(false);
    expect(db.learnFeishuDirectChatMode('feishu:oc_learn_group')).toBe(false);
    expect(
      db.getRegisteredGroup('feishu:oc_learn_group')?.feishu_chat_mode,
    ).toBe('group');
  });

  test('a recalled merged-forward root waiting for its companion can be cancelled', () => {
    const chatJid = 'web:ws-recall';
    db.ensureChatExists(chatJid);
    db.storeMessageDirect(
      'om_held_root',
      chatJid,
      'ou_user',
      'User',
      'forwarded',
      new Date().toISOString(),
      false,
      { sourceJid: 'feishu:oc_recall_chat' },
    );
    db.setMessageFollowUp(chatJid, 'om_held_root', {
      mode: 'queue',
      status: 'awaiting_companion' as never,
    });
    expect(db.listInboundMessagesById('om_held_root')[0]).toMatchObject({
      delivery_status: 'awaiting_companion',
    });
    expect(db.cancelPendingInboundMessage(chatJid, 'om_held_root')).toBe(true);
    expect(db.listInboundMessagesById('om_held_root')[0]).toMatchObject({
      delivery_status: 'cancelled',
    });
  });
});
