/**
 * Real-source regression tests for UF-1085:
 * injectPreparedFollowUp cancelled early-return must restore remaining
 * promoting siblings back to 'queued' so they stay claimable live.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uf-1085-inject-cancel-'));
const store = path.join(tmp, 'db');
const groups = path.join(tmp, 'groups');
fs.mkdirSync(store, { recursive: true });
fs.mkdirSync(groups, { recursive: true });

vi.mock('../src/config.js', () => ({ STORE_DIR: store, GROUPS_DIR: groups }));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const { getChannelType } = await import('../src/im-channel.js');
const { createRuntimeSourceHarness } =
  await import('./helpers/runtime-source.js');

import type { NewMessage, QueuedFollowUp } from '../src/types.js';

const CHAT_JID = 'web:test-1085';

beforeAll(() => {
  db.initDatabase();
  db.ensureChatExists(CHAT_JID);
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

beforeEach(() => {
  for (const jid of db.getQueuedFollowUpChatJids()) {
    db.cancelQueuedFollowUpsAtCutoff(jid);
  }
});

let seqCounter = 0;
function seedQueuedMessage(id: string, content: string) {
  seqCounter += 1;
  const ts = new Date(
    Date.parse('2026-10-12T07:00:00.000Z') + seqCounter * 1000,
  ).toISOString();
  db.storeMessageDirect(id, CHAT_JID, 'user-1', 'User', content, ts, false, {
    meta: {
      deliveryMode: 'queue',
      deliveryStatus: 'queued',
    },
  });
  return { id, ts };
}

function buildInjectHarness() {
  const queue = {
    reserveNextQuery: vi.fn(() => 'run-1'),
    releaseQueryReservation: vi.fn(),
    setCurrentQueryCoverage: vi.fn(),
    announceReservedQuery: vi.fn(),
    sendMessage: vi.fn(() => 'sent' as const),
  };
  const globals: Record<string, unknown> = {
    queue,
    getChannelType,
    listQueuedFollowUps: db.listQueuedFollowUps,
    listQueuedAutomationFollowUps: db.listQueuedAutomationFollowUps,
    getQueuedFollowUp: db.getQueuedFollowUp,
    claimNextQueuedFollowUpBatch: db.claimNextQueuedFollowUpBatch,
    restorePromotingFollowUpBatch: vi.fn(db.restorePromotingFollowUpBatch),
    withdrawQueuedInput: db.withdrawQueuedInput,
    withdrawQueuedInputsOutsideAudience: vi.fn(),
    isEndedAutomationInput: () => false,
    createIpcDeliveryTarget: vi.fn(() => null),
    broadcastFollowUpUpdate: vi.fn(),
    selectBatchProcessingIndicatorOwners: vi.fn(() => []),
    clearTrackedProcessingIndicators: vi.fn(async () => undefined),
    beginBatchAckReactions: vi.fn(async () => undefined),
    clearUntrackedBatchAckReactions: vi.fn(async () => undefined),
    resolveForwardBundleBatchAnchor: vi.fn(() => null),
    resolveFollowUpRuntime: vi.fn(() => null),
    resolveBatchChannelContext: vi.fn(() => undefined),
    collectPersistedReferencedMessageIds: vi.fn(() => new Set<string>()),
    collectMessageImages: vi.fn(() => []),
    releaseFollowUpToColdReader: vi.fn(() => 'no_active' as const),
    prepareFollowUp: vi.fn(),
    completeFollowUpReply: vi.fn(),
    crypto: globalThis.crypto,
    setTimeout,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  const harness = createRuntimeSourceHarness(globals);
  harness.install('injectPreparedFollowUp');
  harness.install('dispatchNextQueuedFollowUp');
  return {
    globals,
    queue,
    injectPreparedFollowUp: globals.injectPreparedFollowUp as (
      items: QueuedFollowUp[],
      prepared: { messages: NewMessage[]; replies: unknown[] },
      runId: string,
    ) => 'sent' | 'no_active' | 'cancelled',
    dispatchNextQueuedFollowUp: globals.dispatchNextQueuedFollowUp as (
      chatJid: string,
    ) => Promise<void>,
  };
}

describe('UF-1085: injectPreparedFollowUp restores promoting siblings on cancel', () => {
  test('restores surviving promoting sibling to queued when another sibling was cancelled before inject', () => {
    seedQueuedMessage('m-keep', 'hello');
    seedQueuedMessage('m-drop', 'world');
    const claimed = db.claimNextQueuedFollowUpBatch(CHAT_JID, 'run-1');
    expect(claimed.map((c) => c.id)).toEqual(['m-keep', 'm-drop']);
    expect(db.getQueuedFollowUp(CHAT_JID, 'm-keep')?.delivery_status).toBe(
      'promoting',
    );

    // Cancel m-drop after prepareFollowUp / during reply await.
    db.cancelQueuedFollowUp(CHAT_JID, 'm-drop', '2026-10-12T07:05:00.000Z');
    expect(db.getQueuedFollowUp(CHAT_JID, 'm-drop')).toBeNull();

    const { injectPreparedFollowUp, globals } = buildInjectHarness();
    const verdict = injectPreparedFollowUp(
      claimed,
      {
        messages: claimed.map((c) => ({
          id: c.id,
          chat_jid: c.chat_jid,
          sender: c.sender,
          sender_name: c.sender_name,
          content: c.content,
          timestamp: c.timestamp,
        })),
        replies: [],
      },
      'run-1',
    );

    expect(verdict).toBe('cancelled');
    expect(globals.restorePromotingFollowUpBatch).toHaveBeenCalledTimes(1);
    expect(db.getQueuedFollowUp(CHAT_JID, 'm-keep')?.delivery_status).toBe(
      'queued',
    );

    // Live claimNextQueuedFollowUpBatch can now claim m-keep again without restart.
    const reclaimed = db.claimNextQueuedFollowUpBatch(CHAT_JID, 'run-2');
    expect(reclaimed.map((r) => r.id)).toEqual(['m-keep']);
  });

  test('dispatchNextQueuedFollowUp: sibling cancelled during completeFollowUpReply await is restored by injectPreparedFollowUp', async () => {
    seedQueuedMessage('d-keep', 'first');
    seedQueuedMessage('d-cancel', 'second');
    seedQueuedMessage('d-cmd', '/help');

    const { dispatchNextQueuedFollowUp, globals, queue } = buildInjectHarness();
    (globals.prepareFollowUp as ReturnType<typeof vi.fn>).mockImplementation(
      async (items: QueuedFollowUp[]) => ({
        messages: items
          .filter((i) => i.id !== 'd-cmd')
          .map((i) => ({
            id: i.id,
            chat_jid: i.chat_jid,
            sender: i.sender,
            sender_name: i.sender_name,
            content: i.content,
            timestamp: i.timestamp,
          })),
        replies: [
          {
            item: items.find((i) => i.id === 'd-cmd')!,
            text: 'help text',
          },
        ],
      }),
    );
    (
      globals.completeFollowUpReply as ReturnType<typeof vi.fn>
    ).mockImplementation(async (replyItem: QueuedFollowUp) => {
      db.releaseQueuedFollowUpBatch(
        [replyItem],
        'run-1',
        '2026-10-12T07:06:00.000Z',
      );
      // User cancels d-cancel while completeFollowUpReply is awaiting.
      db.cancelQueuedFollowUp(CHAT_JID, 'd-cancel', '2026-10-12T07:06:01.000Z');
      return true;
    });

    await dispatchNextQueuedFollowUp(CHAT_JID);

    expect(queue.sendMessage).not.toHaveBeenCalled();
    expect(db.getQueuedFollowUp(CHAT_JID, 'd-keep')?.delivery_status).toBe(
      'queued',
    );
    const nextClaim = db.claimNextQueuedFollowUpBatch(CHAT_JID, 'run-2');
    expect(nextClaim.map((r) => r.id)).toEqual(['d-keep']);
  });

  test('when all siblings were cancelled, does not call restorePromotingFollowUpBatch', () => {
    seedQueuedMessage('a-1', 'one');
    seedQueuedMessage('a-2', 'two');
    const claimed = db.claimNextQueuedFollowUpBatch(CHAT_JID, 'run-1');
    db.cancelQueuedFollowUp(CHAT_JID, 'a-1', '2026-10-12T07:07:00.000Z');
    db.cancelQueuedFollowUp(CHAT_JID, 'a-2', '2026-10-12T07:07:01.000Z');

    const { injectPreparedFollowUp, globals } = buildInjectHarness();
    const verdict = injectPreparedFollowUp(
      claimed,
      { messages: [], replies: [] },
      'run-1',
    );

    expect(verdict).toBe('cancelled');
    expect(globals.restorePromotingFollowUpBatch).not.toHaveBeenCalled();
  });
});
