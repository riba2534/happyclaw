/**
 * Real-source regression tests for UF-1078:
 * While a claimed follow-up batch is in delivery_status='promoting',
 * getMessagesSince excludes those rows. Deferring reply cursor advances with
 * sequence >= min(toSend.sequence) until after injectPreparedFollowUp succeeds
 * prevents completeOutOfBandMessage from blindly advancing committed+next_pull
 * past earlier toSend siblings when inject returns 'no_active'.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uf-1078-oob-defer-'));
const store = path.join(tmp, 'db');
const groups = path.join(tmp, 'groups');
fs.mkdirSync(store, { recursive: true });
fs.mkdirSync(groups, { recursive: true });

vi.mock('../src/config.js', () => ({
  ASSISTANT_NAME: 'Bot',
  STORE_DIR: store,
  GROUPS_DIR: groups,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const { getChannelType } = await import('../src/im-channel.js');
const { DeferredOutOfBandCursorLedger, hasEarlierCursorMessage } =
  await import('../src/delivery-cursor.js');
const { resolveCompatibleChannelBatchAnchor, resolveForwardBundleBatchAnchor } =
  await import('../src/forward-bundle-batch.js');
const { createRuntimeSourceHarness } =
  await import('./helpers/runtime-source.js');

import type {
  MessageCursor,
  NewMessage,
  QueuedFollowUp,
} from '../src/types.js';

const EMPTY_CURSOR: MessageCursor = { timestamp: '', id: '', sequence: 0 };

beforeAll(() => {
  db.initDatabase();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

let seqCounter = 0;
function seedQueued(
  chatJid: string,
  id: string,
  content: string,
): { id: string; ts: string } {
  seqCounter += 1;
  const ts = new Date(
    Date.parse('2026-10-12T08:00:00.000Z') + seqCounter * 1000,
  ).toISOString();
  db.storeMessageDirect(id, chatJid, 'user-1', 'User', content, ts, false, {
    meta: {
      deliveryMode: 'queue',
      deliveryStatus: 'queued',
    },
  });
  return { id, ts };
}

function buildFollowUpHost(sendResult: 'sent' | 'no_active') {
  const lastAgentTimestamp: Record<string, MessageCursor> = {};
  const lastCommittedCursor: Record<string, MessageCursor> = {};
  const deferredOutOfBandCursors = new DeferredOutOfBandCursorLedger();

  const queue = {
    reserveNextQuery: vi.fn(() => 'run-1'),
    releaseQueryReservation: vi.fn(),
    setCurrentQueryCoverage: vi.fn(),
    announceReservedQuery: vi.fn(),
    sendMessage: vi.fn(() => sendResult),
  };

  const globals: Record<string, unknown> = {
    queue,
    ASSISTANT_NAME: 'Bot',
    EMPTY_CURSOR,
    lastAgentTimestamp,
    lastCommittedCursor,
    deferredOutOfBandCursors,
    routerCursorPersistence: { markDirty: vi.fn() },
    saveState: vi.fn(),
    flushAcknowledgedIpcForJid: vi.fn(),
    getChannelType,
    hasEarlierCursorMessage,
    resolveCompatibleChannelBatchAnchor,
    resolveForwardBundleBatchAnchor,
    resolveMessageCursorSequence: db.resolveMessageCursorSequence,
    getMessagesSince: (jid: string, cursor: MessageCursor) =>
      db.getMessagesSince(jid, cursor, 'Bot'),
    listQueuedFollowUps: db.listQueuedFollowUps,
    listQueuedAutomationFollowUps: db.listQueuedAutomationFollowUps,
    getQueuedFollowUp: db.getQueuedFollowUp,
    claimNextQueuedFollowUpBatch: db.claimNextQueuedFollowUpBatch,
    releaseQueuedFollowUp: db.releaseQueuedFollowUp,
    releaseQueuedFollowUpBatch: db.releaseQueuedFollowUpBatch,
    restorePromotingFollowUpBatch: db.restorePromotingFollowUpBatch,
    withdrawQueuedInput: db.withdrawQueuedInput,
    withdrawQueuedInputsOutsideAudience: vi.fn(),
    isEndedAutomationInput: () => false,
    createIpcDeliveryTarget: vi.fn(() => null),
    broadcastFollowUpUpdate: vi.fn(),
    broadcastFollowUpBatchUpdate: vi.fn(),
    selectBatchProcessingIndicatorOwners: vi.fn(() => []),
    clearTrackedProcessingIndicators: vi.fn(async () => undefined),
    clearStandaloneProcessingIndicator: vi.fn(async () => undefined),
    beginBatchAckReactions: vi.fn(async () => undefined),
    clearUntrackedBatchAckReactions: vi.fn(async () => undefined),
    resolveFollowUpRuntime: vi.fn((jid: string) => ({
      baseChatJid: jid.split('#agent:')[0],
      agentId: 'a1',
      effectiveGroup: { folder: 'main', name: 'main', executionMode: 'host' },
    })),
    sendPluginExpanderReply: vi.fn(async () => ({ acknowledged: true })),
    resolveBatchChannelContext: vi.fn(() => undefined),
    collectPersistedReferencedMessageIds: vi.fn(() => new Set<string>()),
    collectMessageImages: vi.fn(() => []),
    getAgent: vi.fn(() => ({ id: 'a1', kind: 'conversation' })),
    selectRuntimeInteractionBatch: vi.fn((messages: NewMessage[]) => ({
      interactionMode: 'assistant',
      hasDeferredMessages: false,
      messages,
    })),
    formatMessages: (messages: NewMessage[]) =>
      messages.map((m) => m.content).join('\n'),
    activeAgentBuilderTurns: { enqueueBatch: vi.fn() },
    agentBuilderTurnScope: () => 'scope-1',
    enqueueReleasedFollowUp: vi.fn(),
    prepareFollowUp: vi.fn(async (items: QueuedFollowUp[]) => ({
      messages: items
        .filter((i) => !i.content.startsWith('/'))
        .map((i) => ({
          id: i.id,
          chat_jid: i.chat_jid,
          sender: i.sender,
          sender_name: i.sender_name,
          content: i.content,
          timestamp: i.timestamp,
          ingest_sequence: i.ingest_sequence,
        })),
      replies: items
        .filter((i) => i.content.startsWith('/'))
        .map((i) => ({ item: i, text: `reply:${i.content}` })),
    })),
    crypto: globalThis.crypto,
    setTimeout,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };

  const harness = createRuntimeSourceHarness(globals);
  for (const name of [
    'isCursorAfter',
    'advanceNextPullCursorOnly',
    'advanceCursors',
    'hasEarlierPendingMessage',
    'flushDeferredOutOfBandMessages',
    'completeOutOfBandMessage',
    'completeFollowUpReply',
    'releaseFollowUpToColdReader',
    'injectPreparedFollowUp',
    'dispatchNextQueuedFollowUp',
  ]) {
    harness.install(name);
  }

  return {
    globals,
    queue,
    lastAgentTimestamp,
    lastCommittedCursor,
    dispatchNextQueuedFollowUp: globals.dispatchNextQueuedFollowUp as (
      chatJid: string,
    ) => Promise<void>,
  };
}

describe('UF-1078: defer follow-up OOB cursors past pending toSend', () => {
  test('no_active after later reply does NOT advance cursors past earlier promoting toSend', async () => {
    const chatJid = 'web:test-1078-1#agent:a1';
    db.ensureChatExists(chatJid);
    const mHello = seedQueued(chatJid, 'u1078-hello', 'hello');
    const mCmd = seedQueued(chatJid, 'u1078-cmd', '/help');

    const host = buildFollowUpHost('no_active');
    await host.dispatchNextQueuedFollowUp(chatJid);

    expect(host.queue.sendMessage).toHaveBeenCalledTimes(1);
    expect(host.globals.sendPluginExpanderReply).toHaveBeenCalledTimes(1);

    // Reply cursor must NOT advance past mHello while toSend failed with no_active.
    expect(host.lastAgentTimestamp[chatJid]).toBeUndefined();
    expect(host.lastCommittedCursor[chatJid]).toBeUndefined();

    // Cold reader & restart recovery (using committed or next_pull) still see hello!
    const visibleAfterNoActive = db.getMessagesSince(
      chatJid,
      host.lastCommittedCursor[chatJid] ?? EMPTY_CURSOR,
      'Bot',
    );
    expect(visibleAfterNoActive.map((m) => m.id)).toEqual([mHello.id, mCmd.id]);
  });

  test('earlier reply (< minToSendSeq) advances immediately, later reply (>= minToSendSeq) stays deferred on no_active', async () => {
    const chatJid = 'web:test-1078-2#agent:a1';
    db.ensureChatExists(chatJid);
    const mEarly = seedQueued(chatJid, 'u1078-early', '/ping');
    const mHello = seedQueued(chatJid, 'u1078-mid', 'hello world');
    const mLate = seedQueued(chatJid, 'u1078-late', '/pong');

    const host = buildFollowUpHost('no_active');
    await host.dispatchNextQueuedFollowUp(chatJid);

    // mEarly (< minToSendSeq) commits immediately; mLate (>= minToSendSeq) stays deferred.
    expect(host.lastCommittedCursor[chatJid]?.id).toBe(mEarly.id);
    expect(host.lastAgentTimestamp[chatJid]?.id).toBe(mEarly.id);

    const visibleAfterNoActive = db.getMessagesSince(
      chatJid,
      host.lastCommittedCursor[chatJid] ?? EMPTY_CURSOR,
      'Bot',
    );
    expect(visibleAfterNoActive.map((m) => m.id)).toEqual([
      mHello.id,
      mLate.id,
    ]);
  });

  test('sent: deferred later reply cursor flushes via completeOutOfBandMessage after inject succeeds', async () => {
    const chatJid = 'web:test-1078-3#agent:a1';
    db.ensureChatExists(chatJid);
    const mHello = seedQueued(chatJid, 'u1078-s-hello', 'hello');
    const mCmd = seedQueued(chatJid, 'u1078-s-cmd', '/help');

    const host = buildFollowUpHost('sent');
    await host.dispatchNextQueuedFollowUp(chatJid);

    expect(host.queue.sendMessage).toHaveBeenCalledTimes(1);
    // mHello was released & uncommitted, so completeOutOfBandMessage sees earlier pending
    // mHello and holds committed while advancing next_pull to mCmd.
    expect(host.lastAgentTimestamp[chatJid]?.id).toBe(mCmd.id);
    expect(host.lastCommittedCursor[chatJid]).toBeUndefined();

    // Cold reader still recovers mHello if runner crashes before IPC receipt commits mHello.
    const committedVisible = db.getMessagesSince(
      chatJid,
      host.lastCommittedCursor[chatJid] ?? EMPTY_CURSOR,
      'Bot',
    );
    expect(committedVisible.map((m) => m.id)).toEqual([mHello.id, mCmd.id]);
  });
});
