import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-reliability-'));
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

const route = {
  provider: 'feishu',
  accountId: 'bot-primary',
  sourceJid: 'feishu:bot-primary:chat-1#root:root-1#thread:thread-1',
  chatId: 'chat-1',
  rootId: 'root-1',
  threadId: 'thread-1',
};

beforeAll(() => db.initDatabase());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(root, { recursive: true, force: true });
});

describe('channel reliability schema v60', () => {
  test('creates all four ledgers and nonterminal indexes idempotently', () => {
    expect(db.getRouterState('schema_version')).toBe('60');
    db.closeDatabase();

    const probe = new Database(path.join(storeDir, 'messages.db'), {
      readonly: true,
    });
    const tables = probe
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN (
           'channel_inbox','channel_cursors','turn_runs','channel_outbox','streaming_cards'
         ) ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual([
      'channel_cursors',
      'channel_inbox',
      'channel_outbox',
      'streaming_cards',
      'turn_runs',
    ]);
    const indexes = probe
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'index' AND name LIKE '%nonterminal' ORDER BY name`,
      )
      .all() as Array<{ name: string }>;
    expect(indexes.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        'idx_channel_inbox_nonterminal',
        'idx_channel_outbox_nonterminal',
        'idx_streaming_cards_nonterminal',
        'idx_turn_runs_nonterminal',
      ]),
    );
    probe.close();

    db.initDatabase();
    expect(db.getRouterState('schema_version')).toBe('60');
  });

  test('advances provider cursors monotonically and scopes them by chat', () => {
    const initial = reliability.advanceChannelCursor({
      provider: 'feishu',
      accountId: 'bot-primary',
      scope: 'message_backfill',
      chatId: 'chat-1',
      cursor: 'cursor-100-a',
      position: 100,
      tieBreaker: 'message-a',
      now: '2026-07-23T00:00:00.000Z',
    });
    expect(initial).toMatchObject({
      advanced: true,
      cursor: { position: 100, tieBreaker: 'message-a' },
    });
    const stale = reliability.advanceChannelCursor({
      provider: 'feishu',
      accountId: 'bot-primary',
      scope: 'message_backfill',
      chatId: 'chat-1',
      cursor: 'cursor-99',
      position: 99,
      tieBreaker: 'message-z',
      now: '2026-07-23T00:00:01.000Z',
    });
    expect(stale.advanced).toBe(false);
    expect(stale.cursor.cursor).toBe('cursor-100-a');

    const samePositionForward = reliability.advanceChannelCursor({
      provider: 'feishu',
      accountId: 'bot-primary',
      scope: 'message_backfill',
      chatId: 'chat-1',
      cursor: 'cursor-100-b',
      position: 100,
      tieBreaker: 'message-b',
      now: '2026-07-23T00:00:02.000Z',
    });
    expect(samePositionForward).toMatchObject({
      advanced: true,
      cursor: { cursor: 'cursor-100-b', tieBreaker: 'message-b' },
    });
    expect(
      reliability.getChannelCursor({
        provider: 'feishu',
        accountId: 'bot-primary',
        scope: 'message_backfill',
        chatId: 'chat-1',
      }),
    ).toMatchObject({ cursor: 'cursor-100-b', position: 100 });
    expect(
      reliability.listChannelCursors({
        provider: 'feishu',
        accountId: 'bot-primary',
      }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          scope: 'message_backfill',
          chatId: 'chat-1',
        }),
      ]),
    );
    expect(
      reliability.deleteChannelCursor({
        provider: 'feishu',
        accountId: 'bot-primary',
        scope: 'message_backfill',
        chatId: 'chat-1',
        expectedPosition: 99,
        expectedTieBreaker: 'message-b',
      }),
    ).toBe(false);
    expect(
      reliability.deleteChannelCursor({
        provider: 'feishu',
        accountId: 'bot-primary',
        scope: 'message_backfill',
        chatId: 'chat-1',
        expectedPosition: 100,
        expectedTieBreaker: 'message-b',
      }),
    ).toBe(true);
  });
});

describe('durable channel inbox', () => {
  test('claims the just-recorded event without stealing another Bot message', () => {
    const first = reliability.recordChannelInbox({
      ...route,
      externalMessageId: 'msg-inbox-target-first',
      status: 'queued',
      now: '2026-07-22T23:59:00.000Z',
    }).item;
    const target = reliability.recordChannelInbox({
      ...route,
      accountId: 'bot-secondary',
      sourceJid: 'feishu:bot-secondary:chat-1',
      externalMessageId: 'msg-inbox-target-second',
      status: 'received',
      now: '2026-07-22T23:59:00.000Z',
    }).item;
    const targetClaim = reliability.claimChannelInboxById(
      target.id,
      'target-intake',
      1_000,
      '2026-07-22T23:59:00.100Z',
    )!;
    expect(targetClaim).toMatchObject({
      id: target.id,
      accountId: 'bot-secondary',
    });
    expect(reliability.getChannelInboxItem(first.id)?.status).toBe('queued');
    expect(
      reliability.updateClaimedChannelInbox(targetClaim, {
        normalizedPayload: { text: 'normalized target' },
        now: '2026-07-22T23:59:00.150Z',
      }),
    ).toBe(true);
    expect(
      reliability.ignoreChannelInbox(
        targetClaim,
        'mention gate rejected',
        '2026-07-22T23:59:00.200Z',
      ),
    ).toBe(true);
    expect(reliability.getChannelInboxItem(target.id)).toMatchObject({
      status: 'ignored',
      normalizedPayload: { text: 'normalized target' },
      error: 'mention gate rejected',
    });
    expect(
      reliability.completeChannelInbox(targetClaim, '2026-07-22T23:59:00.250Z'),
    ).toBe(false);
    const firstClaim = reliability.claimChannelInboxById(
      first.id,
      'first-intake',
      1_000,
      '2026-07-22T23:59:00.300Z',
    )!;
    reliability.completeChannelInbox(firstClaim, '2026-07-22T23:59:00.400Z');
  });

  test('deduplicates by provider/account/message and fences expired claims', () => {
    const first = reliability.recordChannelInbox({
      ...route,
      externalMessageId: 'msg-inbox-1',
      rawPayload: { event: 'first' },
      status: 'queued',
      now: '2026-07-23T00:00:00.000Z',
    });
    const duplicate = reliability.recordChannelInbox({
      ...route,
      externalMessageId: 'msg-inbox-1',
      rawPayload: { event: 'duplicate' },
      status: 'queued',
      now: '2026-07-23T00:00:01.000Z',
    });
    expect(first.created).toBe(true);
    expect(duplicate.created).toBe(false);
    expect(duplicate.item.id).toBe(first.item.id);
    expect(duplicate.item.rawPayload).toEqual({ event: 'first' });

    const claimOne = reliability.claimNextChannelInbox('worker-one', 1_000, {
      now: '2026-07-23T00:00:02.000Z',
    })!;
    expect(claimOne).toMatchObject({
      id: first.item.id,
      status: 'processing',
      leaseOwner: 'worker-one',
      leaseToken: 1,
      attempt: 1,
    });
    expect(
      reliability.claimNextChannelInbox('worker-two', 1_000, {
        now: '2026-07-23T00:00:02.500Z',
      }),
    ).toBeUndefined();

    const claimTwo = reliability.claimNextChannelInbox('worker-two', 1_000, {
      now: '2026-07-23T00:00:03.001Z',
    })!;
    expect(claimTwo).toMatchObject({
      id: first.item.id,
      leaseOwner: 'worker-two',
      leaseToken: 2,
      attempt: 2,
    });
    expect(
      reliability.completeChannelInbox(claimOne, '2026-07-23T00:00:03.100Z'),
    ).toBe(false);
    expect(
      reliability.completeChannelInbox(claimTwo, '2026-07-23T00:00:03.100Z'),
    ).toBe(true);
    expect(reliability.getChannelInboxItem(first.item.id)?.status).toBe(
      'processed',
    );
  });

  test('renews a slow inbox claim and allows reclaim only after heartbeats stop', () => {
    const recorded = reliability.recordChannelInbox({
      ...route,
      externalMessageId: 'msg-inbox-slow-download',
      status: 'queued',
      now: '2026-07-23T00:00:10.000Z',
    });
    const first = reliability.claimChannelInboxById(
      recorded.item.id,
      'downloader-one',
      100,
      '2026-07-23T00:00:10.000Z',
    )!;
    expect(
      reliability.renewChannelInboxClaim(
        first,
        100,
        '2026-07-23T00:00:10.080Z',
      ),
    ).toBe(true);
    expect(
      reliability.claimChannelInboxById(
        recorded.item.id,
        'downloader-two',
        100,
        '2026-07-23T00:00:10.150Z',
      ),
    ).toBeUndefined();

    const reclaimed = reliability.claimChannelInboxById(
      recorded.item.id,
      'downloader-two',
      100,
      '2026-07-23T00:00:10.181Z',
    )!;
    expect(reclaimed).toMatchObject({
      leaseOwner: 'downloader-two',
      leaseToken: first.leaseToken + 1,
      attempt: 2,
    });
    expect(
      reliability.renewChannelInboxClaim(
        first,
        100,
        '2026-07-23T00:00:10.190Z',
      ),
    ).toBe(false);
    expect(
      reliability.renewChannelInboxClaim(
        reclaimed,
        100,
        '2026-07-23T00:00:10.282Z',
      ),
    ).toBe(false);
    const finalClaim = reliability.claimChannelInboxById(
      recorded.item.id,
      'downloader-three',
      100,
      '2026-07-23T00:00:10.282Z',
    )!;
    expect(
      reliability.completeChannelInbox(finalClaim, '2026-07-23T00:00:10.283Z'),
    ).toBe(true);
  });

  test('supports explicit admission transitions and retry scheduling', () => {
    const recorded = reliability.recordChannelInbox({
      ...route,
      externalMessageId: 'msg-inbox-retry',
      status: 'received',
      now: '2026-07-23T00:01:00.000Z',
    });
    expect(
      reliability.transitionChannelInbox(
        recorded.item.id,
        'received',
        'admitted',
        {
          normalizedPayload: { text: 'hello' },
          now: '2026-07-23T00:01:00.100Z',
        },
      ),
    ).toBe(true);
    expect(
      reliability.transitionChannelInbox(
        recorded.item.id,
        'admitted',
        'queued',
        { now: '2026-07-23T00:01:00.200Z' },
      ),
    ).toBe(true);
    const firstClaim = reliability.claimNextChannelInbox('retry-worker', 500, {
      now: '2026-07-23T00:01:00.300Z',
    })!;
    expect(
      reliability.failChannelInbox(firstClaim, {
        error: 'temporary',
        retryAt: '2026-07-23T00:01:02.000Z',
        now: '2026-07-23T00:01:00.400Z',
      }),
    ).toBe(true);
    expect(
      reliability.claimNextChannelInbox('retry-worker', 500, {
        now: '2026-07-23T00:01:01.000Z',
      }),
    ).toBeUndefined();
    expect(
      reliability.claimNextChannelInbox('retry-worker', 500, {
        now: '2026-07-23T00:01:02.000Z',
      }),
    ).toMatchObject({ id: recorded.item.id, attempt: 2 });
  });
});

describe('durable channel turn runs', () => {
  test('explicit interrupt fences every live state and leaves terminal rows immutable', () => {
    const at = '2026-07-23T00:58:00.000Z';
    const make = (suffix: string) =>
      reliability.createChannelTurnRun({
        ...route,
        idempotencyKey: `turn:interrupt:${suffix}`,
        now: at,
      }).run;

    const queued = make('queued');
    const running = make('running');
    const runningClaim = reliability.claimChannelTurnRunById(
      running.id,
      'interrupt-running',
      60_000,
      '2026-07-23T00:58:00.100Z',
    )!;
    const finalizing = make('finalizing');
    const finalizingClaim = reliability.claimChannelTurnRunById(
      finalizing.id,
      'interrupt-finalizing',
      60_000,
      '2026-07-23T00:58:00.100Z',
    )!;
    reliability.markChannelTurnFinalizing(
      finalizingClaim,
      '2026-07-23T00:58:00.200Z',
    );
    const waiting = make('waiting');
    const waitingClaim = reliability.claimChannelTurnRunById(
      waiting.id,
      'interrupt-waiting',
      60_000,
      '2026-07-23T00:58:00.100Z',
    )!;
    reliability.waitChannelTurnForUser(
      waitingClaim,
      { question: 'continue?' },
      '2026-07-23T00:58:00.200Z',
    );
    const retry = make('retry');
    const retryClaim = reliability.claimChannelTurnRunById(
      retry.id,
      'interrupt-retry',
      60_000,
      '2026-07-23T00:58:00.100Z',
    )!;
    reliability.retryChannelTurnRun(retryClaim, {
      availableAt: '2026-07-23T01:00:00.000Z',
      error: 'temporary',
      now: '2026-07-23T00:58:00.200Z',
    });
    const completed = make('completed');
    const completedClaim = reliability.claimChannelTurnRunById(
      completed.id,
      'interrupt-completed',
      60_000,
      '2026-07-23T00:58:00.100Z',
    )!;
    reliability.completeChannelTurnRun(completedClaim, {
      now: '2026-07-23T00:58:00.200Z',
    });

    const liveRuns = [queued, running, finalizing, waiting, retry];
    const before = new Map(
      liveRuns.map((run) => [run.id, reliability.getChannelTurnRun(run.id)!]),
    );
    for (const run of liveRuns) {
      expect(
        reliability.interruptChannelTurnRunById(
          run.id,
          'operator stopped response',
          '2026-07-23T00:58:01.000Z',
        ),
      ).toBe(true);
      const interrupted = reliability.getChannelTurnRun(run.id)!;
      expect(interrupted).toMatchObject({
        status: 'interrupted',
        error: 'operator stopped response',
        leaseOwner: null,
        leaseExpiresAt: null,
        completedAt: '2026-07-23T00:58:01.000Z',
        leaseToken: before.get(run.id)!.leaseToken + 1,
        revision: before.get(run.id)!.revision + 1,
      });
      const terminalRevision = interrupted.revision;
      expect(
        reliability.interruptChannelTurnRunById(
          run.id,
          'duplicate interrupt',
          '2026-07-23T00:58:02.000Z',
        ),
      ).toBe(false);
      expect(reliability.getChannelTurnRun(run.id)?.revision).toBe(
        terminalRevision,
      );
    }
    expect(
      reliability.completeChannelTurnRun(runningClaim, {
        now: '2026-07-23T00:58:01.100Z',
      }),
    ).toBe(false);

    const completedBefore = reliability.getChannelTurnRun(completed.id)!;
    expect(
      reliability.interruptChannelTurnRunById(
        completed.id,
        'late interrupt',
        '2026-07-23T00:58:01.000Z',
      ),
    ).toBe(false);
    expect(reliability.getChannelTurnRun(completed.id)).toEqual(
      completedBefore,
    );
    expect(() =>
      reliability.interruptChannelTurnRunById(queued.id, '   '),
    ).toThrow('interrupt reason is required');
  });

  test('claims an explicitly selected run without stealing another session', () => {
    const first = reliability.createChannelTurnRun({
      ...route,
      idempotencyKey: 'turn:target-first',
      now: '2026-07-23T00:59:00.000Z',
    }).run;
    const target = reliability.createChannelTurnRun({
      ...route,
      sourceJid: `${route.sourceJid}-target`,
      idempotencyKey: 'turn:target-second',
      now: '2026-07-23T00:59:00.000Z',
    }).run;
    const claimedTarget = reliability.claimChannelTurnRunById(
      target.id,
      'target-worker',
      1_000,
      '2026-07-23T00:59:00.100Z',
    )!;
    expect(claimedTarget.id).toBe(target.id);
    expect(reliability.getChannelTurnRun(first.id)?.status).toBe('queued');
    reliability.completeChannelTurnRun(claimedTarget, {
      now: '2026-07-23T00:59:00.200Z',
    });
    const claimedFirst = reliability.claimChannelTurnRunById(
      first.id,
      'first-worker',
      1_000,
      '2026-07-23T00:59:00.300Z',
    )!;
    expect(claimedFirst.id).toBe(first.id);
    reliability.completeChannelTurnRun(claimedFirst, {
      now: '2026-07-23T00:59:00.400Z',
    });
  });

  test('deduplicates, leases, waits/resumes with CAS, and completes', () => {
    const inbox = reliability.recordChannelInbox({
      ...route,
      externalMessageId: 'msg-turn-1',
      status: 'processed',
      now: '2026-07-23T01:00:00.000Z',
    });
    const created = reliability.createChannelTurnRun({
      ...route,
      inboxId: inbox.item.id,
      idempotencyKey: 'turn:msg-turn-1',
      agentId: 'agent-1',
      sessionId: 'session-1',
      correlationId: 'correlation-1',
      now: '2026-07-23T01:00:00.000Z',
    });
    const duplicate = reliability.createChannelTurnRun({
      ...route,
      inboxId: inbox.item.id,
      idempotencyKey: 'turn:msg-turn-1',
      now: '2026-07-23T01:00:00.100Z',
    });
    expect(created.created).toBe(true);
    expect(duplicate).toMatchObject({
      created: false,
      run: { id: created.run.id },
    });

    const firstClaim = reliability.claimNextChannelTurnRun(
      'turn-worker',
      1_000,
      { now: '2026-07-23T01:00:01.000Z' },
    )!;
    expect(firstClaim).toMatchObject({
      id: created.run.id,
      leaseToken: 1,
      status: 'running',
    });
    expect(
      reliability.heartbeatChannelTurnRun(
        firstClaim,
        2_000,
        '2026-07-23T01:00:01.500Z',
      ),
    ).toBe(true);
    expect(
      reliability.waitChannelTurnForUser(
        firstClaim,
        { question: 'confirm' },
        '2026-07-23T01:00:01.600Z',
      ),
    ).toBe(true);
    const waiting = reliability.getChannelTurnRun(created.run.id)!;
    expect(waiting).toMatchObject({
      status: 'waiting_user',
      result: { question: 'confirm' },
    });
    expect(
      reliability.resumeWaitingChannelTurn(
        waiting.id,
        waiting.revision - 1,
        undefined,
        '2026-07-23T01:00:02.000Z',
      ),
    ).toBe(false);
    expect(
      reliability.resumeWaitingChannelTurn(
        waiting.id,
        waiting.revision,
        undefined,
        '2026-07-23T01:00:02.000Z',
      ),
    ).toBe(true);
    const secondClaim = reliability.claimNextChannelTurnRun(
      'turn-worker-two',
      1_000,
      { now: '2026-07-23T01:00:02.100Z' },
    )!;
    expect(secondClaim.leaseToken).toBe(2);
    expect(
      reliability.markChannelTurnFinalizing(
        secondClaim,
        '2026-07-23T01:00:02.200Z',
      ),
    ).toBe(true);
    expect(
      reliability.completeChannelTurnRun(secondClaim, {
        result: { answer: 'done' },
        now: '2026-07-23T01:00:02.300Z',
      }),
    ).toBe(true);
    expect(reliability.getChannelTurnRun(created.run.id)).toMatchObject({
      status: 'completed',
      result: { answer: 'done' },
      leaseOwner: null,
    });
  });

  test('interrupts expired executions instead of blindly replaying them', () => {
    const run = reliability.createChannelTurnRun({
      ...route,
      idempotencyKey: 'turn:expired',
      now: '2026-07-23T01:01:00.000Z',
    });
    reliability.claimNextChannelTurnRun('crashed-worker', 1_000, {
      now: '2026-07-23T01:01:00.100Z',
    });
    expect(
      reliability.interruptExpiredChannelTurnRuns('2026-07-23T01:01:01.101Z'),
    ).toBe(1);
    expect(reliability.getChannelTurnRun(run.run.id)).toMatchObject({
      status: 'interrupted',
      leaseOwner: null,
    });
  });
});

describe('per-artifact durable channel outbox', () => {
  function createOutboxRun(suffix: string) {
    return reliability.createChannelTurnRun({
      ...route,
      idempotencyKey: `outbox-turn:${suffix}`,
      now: '2026-07-23T02:00:00.000Z',
    }).run;
  }

  test('claims an explicitly selected item without stealing another route', () => {
    const run = createOutboxRun('targeted');
    const first = reliability.enqueueChannelOutbox({
      ...route,
      turnRunId: run.id,
      ordinal: 0,
      kind: 'text',
      payload: { text: 'first' },
      now: '2026-07-23T01:59:00.000Z',
    }).item;
    const target = reliability.enqueueChannelOutbox({
      ...route,
      turnRunId: run.id,
      ordinal: 1,
      kind: 'file',
      payload: { path: 'target.pdf' },
      now: '2026-07-23T01:59:00.000Z',
    }).item;
    const targetClaim = reliability.claimChannelOutboxById(
      target.id,
      'target-sender',
      1_000,
      '2026-07-23T01:59:00.100Z',
    )!;
    expect(targetClaim.id).toBe(target.id);
    expect(reliability.getChannelOutboxItem(first.id)?.status).toBe('pending');
    reliability.completeChannelOutbox(targetClaim, {
      providerMessageId: 'target-message',
      now: '2026-07-23T01:59:00.200Z',
    });
    const firstClaim = reliability.claimChannelOutboxById(
      first.id,
      'first-sender',
      1_000,
      '2026-07-23T01:59:00.300Z',
    )!;
    reliability.completeChannelOutbox(firstClaim, {
      providerMessageId: 'first-message',
      now: '2026-07-23T01:59:00.400Z',
    });
  });

  test('enforces payload idempotency and fences an unknown send outcome', () => {
    const run = createOutboxRun('uncertain');
    const created = reliability.enqueueChannelOutbox({
      ...route,
      turnRunId: run.id,
      ordinal: 0,
      kind: 'text',
      idempotencyKey: 'delivery:uncertain:text',
      payload: { text: 'hello' },
      now: '2026-07-23T02:00:00.000Z',
    });
    const duplicate = reliability.enqueueChannelOutbox({
      ...route,
      turnRunId: run.id,
      ordinal: 0,
      kind: 'text',
      idempotencyKey: 'delivery:uncertain:text',
      payload: { text: 'hello' },
      now: '2026-07-23T02:00:00.100Z',
    });
    expect(created.created).toBe(true);
    expect(duplicate).toMatchObject({
      created: false,
      item: { id: created.item.id },
    });
    expect(() =>
      reliability.enqueueChannelOutbox({
        ...route,
        turnRunId: run.id,
        ordinal: 0,
        kind: 'text',
        idempotencyKey: 'delivery:uncertain:text',
        payload: { text: 'different' },
      }),
    ).toThrow('Outbox idempotency conflict');

    const claim = reliability.claimNextChannelOutbox('sender-one', 1_000, {
      now: '2026-07-23T02:00:00.200Z',
    })!;
    expect(
      reliability.markChannelOutboxSending(claim, '2026-07-23T02:00:00.300Z'),
    ).toBe(true);
    expect(
      reliability.reconcileExpiredChannelOutbox('2026-07-23T02:00:01.201Z'),
    ).toEqual({ retryable: 0, uncertain: 1 });
    const uncertain = reliability.getChannelOutboxItem(created.item.id)!;
    expect(uncertain.status).toBe('uncertain');
    expect(
      reliability.completeChannelOutbox(claim, {
        providerMessageId: 'late-message',
        now: '2026-07-23T02:00:01.300Z',
      }),
    ).toBe(false);
    expect(
      reliability.resolveUncertainChannelOutbox(
        uncertain.id,
        uncertain.revision,
        {
          resolution: 'delivered',
          providerMessageId: 'provider-message-confirmed-manually',
          now: '2026-07-23T02:00:01.400Z',
        },
      ),
    ).toBe(true);
    expect(reliability.getChannelOutboxItem(created.item.id)).toMatchObject({
      status: 'delivered',
      providerMessageId: 'provider-message-confirmed-manually',
      attempt: 1,
    });
    expect(
      reliability.claimNextChannelOutbox('sender-two', 1_000, {
        now: '2026-07-23T02:00:02.000Z',
      }),
    ).toBeUndefined();

    const failedCreated = reliability.enqueueChannelOutbox({
      ...route,
      turnRunId: run.id,
      ordinal: 1,
      kind: 'file',
      idempotencyKey: 'delivery:uncertain:file',
      payload: { path: 'failed.pdf' },
      now: '2026-07-23T02:00:02.100Z',
    });
    const failedClaim = reliability.claimNextChannelOutbox(
      'sender-three',
      1_000,
      { now: '2026-07-23T02:00:02.200Z' },
    )!;
    expect(
      reliability.markChannelOutboxSending(
        failedClaim,
        '2026-07-23T02:00:02.300Z',
      ),
    ).toBe(true);
    expect(
      reliability.reconcileExpiredChannelOutbox('2026-07-23T02:00:03.301Z'),
    ).toEqual({ retryable: 0, uncertain: 1 });
    const failedUncertain = reliability.getChannelOutboxItem(
      failedCreated.item.id,
    )!;
    expect(
      reliability.resolveUncertainChannelOutbox(
        failedUncertain.id,
        failedUncertain.revision,
        {
          resolution: 'failed',
          error: 'Provider confirmed rejection',
          now: '2026-07-23T02:00:03.400Z',
        },
      ),
    ).toBe(true);
    expect(
      reliability.getChannelOutboxItem(failedCreated.item.id),
    ).toMatchObject({
      status: 'failed',
      error: 'Provider confirmed rejection',
      attempt: 1,
    });
    expect(
      reliability.claimNextChannelOutbox('sender-four', 1_000, {
        now: '2026-07-23T02:00:04.000Z',
      }),
    ).toBeUndefined();
  });

  test('persists upload receipt independently before visible delivery', () => {
    const run = createOutboxRun('file');
    const queued = reliability.enqueueChannelOutbox({
      ...route,
      turnRunId: run.id,
      ordinal: 1,
      kind: 'file',
      payload: { path: 'deliverables/report.pdf' },
      now: '2026-07-23T02:01:00.000Z',
    });
    const claim = reliability.claimNextChannelOutbox('file-sender', 2_000, {
      now: '2026-07-23T02:01:00.100Z',
    })!;
    expect(
      reliability.markChannelOutboxUploading(claim, '2026-07-23T02:01:00.200Z'),
    ).toBe(true);
    expect(
      reliability.markChannelOutboxUploaded(
        claim,
        'file-key-1',
        '2026-07-23T02:01:00.300Z',
      ),
    ).toBe(true);
    expect(reliability.getChannelOutboxItem(queued.item.id)).toMatchObject({
      status: 'uploaded',
      providerUploadKey: 'file-key-1',
    });
    expect(
      reliability.markChannelOutboxSending(claim, '2026-07-23T02:01:00.400Z'),
    ).toBe(true);
    expect(
      reliability.completeChannelOutbox(claim, {
        providerMessageId: 'file-message-1',
        now: '2026-07-23T02:01:00.500Z',
      }),
    ).toBe(true);
  });

  test('retries expired pre-send claims and does not duplicate delivered items', () => {
    const run = createOutboxRun('presend');
    const queued = reliability.enqueueChannelOutbox({
      ...route,
      turnRunId: run.id,
      ordinal: 0,
      kind: 'image',
      payload: { path: 'image.png' },
      now: '2026-07-23T02:02:00.000Z',
    });
    reliability.claimNextChannelOutbox('image-sender', 100, {
      now: '2026-07-23T02:02:00.000Z',
    });
    expect(
      reliability.reconcileExpiredChannelOutbox('2026-07-23T02:02:00.101Z'),
    ).toEqual({ retryable: 1, uncertain: 0 });
    expect(reliability.getChannelOutboxItem(queued.item.id)?.status).toBe(
      'retry_wait',
    );
  });
});

describe('durable streaming card state and cleanup', () => {
  test('reservation rollback requires the exact lease and rejects visible Outbox state', () => {
    const run = reliability.createChannelTurnRun({
      ...route,
      idempotencyKey: 'turn:card-reservation-rollback-fence',
      now: '2026-07-23T03:59:00.000Z',
    }).run;
    const claim = reliability.claimChannelTurnRunById(
      run.id,
      'card-reservation-owner',
      60_000,
      '2026-07-23T03:59:00.100Z',
    )!;
    const first = reliability.createStreamingCardRecord({
      ...route,
      id: 'card-reservation-wrong-owner',
      turnRunId: run.id,
      status: 'creating',
      now: '2026-07-23T03:59:00.200Z',
    }).card;
    expect(
      reliability.rollbackUnpublishedStreamingCardReservation(
        { ...claim, leaseOwner: 'wrong-owner' },
        first,
        '2026-07-23T03:59:00.300Z',
      ),
    ).toBe(false);
    expect(reliability.getStreamingCardRecord(first.id)).toBeDefined();
    expect(
      reliability.rollbackUnpublishedStreamingCardReservation(
        claim,
        { ...first, revision: first.revision + 1 },
        '2026-07-23T03:59:00.300Z',
      ),
    ).toBe(false);
    expect(
      reliability.rollbackUnpublishedStreamingCardReservation(
        claim,
        first,
        '2026-07-23T03:59:00.300Z',
      ),
    ).toBe(true);

    const second = reliability.createStreamingCardRecord({
      ...route,
      id: 'card-reservation-visible-outbox',
      turnRunId: run.id,
      status: 'creating',
      now: '2026-07-23T03:59:00.400Z',
    }).card;
    const outbox = reliability.enqueueChannelOutbox({
      ...route,
      turnRunId: run.id,
      ordinal: 0,
      kind: 'file',
      payload: { path: 'possibly-visible.pdf' },
      now: '2026-07-23T03:59:00.500Z',
    }).item;
    const outboxClaim = reliability.claimChannelOutboxById(
      outbox.id,
      'outbox-owner',
      60_000,
      '2026-07-23T03:59:00.600Z',
    )!;
    expect(
      reliability.markChannelOutboxSending(
        outboxClaim,
        '2026-07-23T03:59:00.650Z',
      ),
    ).toBe(true);
    expect(
      reliability.rollbackUnpublishedStreamingCardReservation(
        claim,
        second,
        '2026-07-23T03:59:00.700Z',
      ),
    ).toBe(false);
    expect(reliability.getStreamingCardRecord(second.id)).toBeDefined();
  });

  test('uses revision CAS and exposes orphan cards in recovery scan', () => {
    const run = reliability.createChannelTurnRun({
      ...route,
      idempotencyKey: 'card-turn:one',
      now: '2026-07-23T03:00:00.000Z',
    }).run;
    const created = reliability.createStreamingCardRecord({
      ...route,
      id: 'stream-card-1',
      turnRunId: run.id,
      snapshot: { title: 'starting' },
      now: '2026-07-23T03:00:00.000Z',
    });
    expect(created.created).toBe(true);
    const streaming = reliability.updateStreamingCardRecord(
      created.card.id,
      0,
      {
        status: 'streaming',
        messageId: 'feishu-message-1',
        cardId: 'feishu-card-1',
        version: 1,
        snapshot: { title: 'working' },
        now: '2026-07-23T03:00:00.100Z',
      },
    )!;
    expect(streaming).toMatchObject({
      revision: 1,
      messageId: 'feishu-message-1',
      cardId: 'feishu-card-1',
      snapshot: { title: 'working' },
    });
    expect(
      reliability.updateStreamingCardRecord(created.card.id, 0, {
        status: 'completed',
      }),
    ).toBeUndefined();
    expect(reliability.scanChannelReliabilityNonterminal().cards).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: created.card.id }),
      ]),
    );

    const completed = reliability.updateStreamingCardRecord(
      created.card.id,
      streaming.revision,
      {
        status: 'completed',
        version: 2,
        snapshot: { title: 'done' },
        now: '2026-07-23T03:00:00.200Z',
      },
    );
    expect(completed).toMatchObject({ status: 'completed', revision: 2 });
    expect(
      reliability
        .scanChannelReliabilityNonterminal()
        .cards.some((card) => card.id === created.card.id),
    ).toBe(false);

    // Long responses may roll over into more than one physical Feishu card.
    const rollover = reliability.createStreamingCardRecord({
      ...route,
      id: 'stream-card-1-rollover',
      turnRunId: run.id,
      snapshot: { title: 'continued' },
      now: '2026-07-23T03:00:00.300Z',
    });
    expect(rollover.created).toBe(true);
    expect(
      reliability.finalizeStreamingCardRecord(rollover.card.id, 0, {
        status: 'aborted',
        error: 'test cleanup',
        now: '2026-07-23T03:00:00.400Z',
      }),
    ).toMatchObject({ status: 'aborted' });
  });

  test('redacts payloads before eventually purging terminal receipts', () => {
    const inbox = reliability.recordChannelInbox({
      ...route,
      externalMessageId: 'old-inbox',
      rawPayload: { secret: 'raw' },
      normalizedPayload: { text: 'normalized' },
      status: 'queued',
      now: '2020-01-01T00:00:00.000Z',
    });
    const inboxClaim = reliability.claimNextChannelInbox('old-worker', 1_000, {
      now: '2020-01-01T00:00:00.100Z',
    })!;
    reliability.completeChannelInbox(inboxClaim, '2020-01-01T00:00:00.200Z');
    const turn = reliability.createChannelTurnRun({
      ...route,
      inboxId: inbox.item.id,
      idempotencyKey: 'old-turn',
      now: '2020-01-01T00:00:00.000Z',
    }).run;
    const turnClaim = reliability.claimNextChannelTurnRun(
      'old-turn-worker',
      1_000,
      { now: '2020-01-01T00:00:00.100Z' },
    )!;
    reliability.completeChannelTurnRun(turnClaim, {
      now: '2020-01-01T00:00:00.200Z',
    });
    const outbox = reliability.enqueueChannelOutbox({
      ...route,
      turnRunId: turn.id,
      ordinal: 0,
      kind: 'text',
      payload: { large: 'payload' },
      now: '2020-01-01T00:00:00.000Z',
    });
    const outboxClaim = reliability.claimNextChannelOutbox(
      'old-outbox-worker',
      1_000,
      { now: '2020-01-01T00:00:00.100Z' },
    )!;
    reliability.completeChannelOutbox(outboxClaim, {
      providerMessageId: 'old-provider-message',
      now: '2020-01-01T00:00:00.200Z',
    });
    const card = reliability.createStreamingCardRecord({
      ...route,
      turnRunId: turn.id,
      snapshot: { large: 'snapshot' },
      now: '2020-01-01T00:00:00.000Z',
    }).card;
    reliability.updateStreamingCardRecord(card.id, 0, {
      status: 'completed',
      now: '2020-01-01T00:00:00.200Z',
    });
    reliability.advanceChannelCursor({
      provider: 'feishu',
      accountId: 'old-account',
      scope: 'decommissioned',
      cursor: 'old-cursor',
      position: 1,
      now: '2020-01-01T00:00:00.000Z',
    });

    expect(
      reliability.cleanupChannelReliability({
        payloadsBefore: '2021-01-01T00:00:00.000Z',
      }),
    ).toMatchObject({
      inboxPayloadsCleared: 1,
      outboxPayloadsCleared: 1,
      cardSnapshotsCleared: 1,
      inboxDeleted: 0,
      turnsDeleted: 0,
    });
    expect(reliability.getChannelInboxItem(inbox.item.id)).toMatchObject({
      rawPayload: null,
      normalizedPayload: null,
    });
    expect(
      reliability.getChannelOutboxItem(outbox.item.id)?.payload,
    ).toBeNull();
    expect(reliability.getStreamingCardRecord(card.id)?.snapshot).toBeNull();

    expect(
      reliability.cleanupChannelReliability({
        payloadsBefore: '2021-01-01T00:00:00.000Z',
        recordsBefore: '2021-01-01T00:00:00.000Z',
        cursorsBefore: '2021-01-01T00:00:00.000Z',
      }),
    ).toMatchObject({ inboxDeleted: 1, turnsDeleted: 1, cursorsDeleted: 1 });
    expect(reliability.getChannelTurnRun(turn.id)).toBeUndefined();
    expect(reliability.getChannelOutboxItem(outbox.item.id)).toBeUndefined();
    expect(reliability.getStreamingCardRecord(card.id)).toBeUndefined();
  });
});
