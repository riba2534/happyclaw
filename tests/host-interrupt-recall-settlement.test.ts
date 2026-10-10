/**
 * E2E regressions (deployed build fa99d70c, topic group, always mode):
 *  1. A run interrupted before producing any text never settled its Turn
 *     (`running` with heartbeats while the warm runner lived), and a restart
 *     could fence or replay the consumed input.
 *  2. A recall stop left a "已停止" card created after the stop.
 *
 * The real `processAgentConversation` output handler and the startup repair
 * run against the real SQLite store; only providers and the runner are fake.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import {
  channelConversationJid,
  parseChannelAddress,
} from '../src/channel-address.js';
import { InputUsageProjection } from '../src/input-usage-projection.js';
import {
  getChannelType,
  isStreamingSessionSettled,
} from '../src/im-channel.js';
import {
  buildOverflowPartialReply,
  buildSteeredReply,
  buildStoppedReply,
} from '../src/reply-finalization.js';
import { publishesFrameworkAnswer } from '../src/workspace-interaction-runtime.js';
import { createRuntimeSourceHarness } from './helpers/runtime-source.js';

const paths = vi.hoisted(() => ({ root: '' }));
vi.mock('../src/config.js', async (importOriginal) => {
  const nodeFs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  paths.root = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'interrupt-recall-'));
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    STORE_DIR: path.join(paths.root, 'store'),
    GROUPS_DIR: path.join(paths.root, 'groups'),
    DATA_DIR: path.join(paths.root, 'data'),
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const db = await import('../src/db.js');
const store = await import('../src/channel-reliability-store.js');
const { ChannelTurnRuntime } = await import('../src/channel-turn-runtime.js');

beforeAll(() => db.initDatabase());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(paths.root, { recursive: true, force: true });
});

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function fakeCard(messageIds: string[] = []) {
  return {
    isActive: () => true,
    abort: vi.fn(async (_reason?: string) => {}),
    complete: vi.fn(async () => {}),
    dispose: vi.fn(),
    setThinking: vi.fn(),
    getAllMessageIds: () => messageIds,
  };
}

/** A conversation-agent run (topic Session) with one claimed input Turn. */
function agentRun(name: string) {
  const inputId = `om_${name}_${crypto.randomBytes(4).toString('hex')}`;
  const virtualChatJid = `web:ws-${name}#agent:session-${name}`;
  const replySourceImJid = `feishu:oc_${name}#account:bot#thread:omt_${name}`;
  const runtime = ChannelTurnRuntime.start({
    provider: 'feishu',
    accountId: 'bot',
    sourceJid: replySourceImJid,
    chatId: `oc_${name}`,
    rootId: inputId,
    threadId: `omt_${name}`,
    externalMessageId: inputId,
    agentId: `session-${name}`,
  });
  expect(runtime.executionDisposition).toBe('execute');
  const advanceCursors = vi.fn();
  const executeFeishuCapability = vi.fn(async () => ({}));
  const activateAgentProjectionForInput = vi.fn(async () => {});
  const globals: Record<string, any> = {
    crypto,
    logger,
    ASSISTANT_NAME: 'Assistant',
    lastProcessed: { id: inputId, timestamp: '2026-10-10T14:18:08.000Z' },
    activeAgentInputTurnId: inputId,
    missedMessages: [{ id: inputId }],
    chatJid: `web:ws-${name}`,
    virtualChatJid,
    virtualJid: virtualChatJid,
    agentId: `session-${name}`,
    replySourceImJid,
    streamingSessionJid: `${replySourceImJid}#agent:session-${name}`,
    agentStreamingSession: undefined,
    activeAgentDurableCardLifecycle: undefined,
    agentStreamingSessionsByInput: new Map(),
    agentChannelTurnRuntimes: new Map([[inputId, runtime]]),
    cursorCommittedInputTurns: new Set<string>(),
    agentStreamingAccText: '',
    agentStreamInterrupted: false,
    agentStreamSteered: false,
    agentInterruptFinalized: false,
    agentClosed: false,
    heldAgentParts: [],
    interactionMode: 'assistant',
    effectiveGroup: { folder: `ws-${name}` },
    agentProfile: undefined,
    currentAgentSessionId: 'sdk-session',
    agentInputUsageProjection: new InputUsageProjection(inputId),
    recallStoppedSessions: new Map(),
    RECALL_STOP_TTL_MS: 10 * 60 * 1000,
    queue: {
      markRunnerActivity: vi.fn(),
      markRunnerQueryIdle: vi.fn(),
    },
    steeringTransitions: { shouldSuppressOutput: () => false },
    resolveSteeringInterrupt: () => false,
    isProviderQuotaControlOutput: () => false,
    bindRunnerActiveIpcCoverage: vi.fn(),
    activateAgentProjectionForInput,
    publishesFrameworkAnswer,
    buildStoppedReply,
    buildSteeredReply,
    buildOverflowPartialReply,
    advanceCursors,
    flushAcknowledgedIpcForJid: vi.fn(),
    clearStreamingSnapshot: vi.fn(),
    clearAgentProcessingIndicatorForInput: vi.fn(async () => {}),
    unregisterStreamingSession: vi.fn(),
    ensureChatExists: db.ensureChatExists,
    storeMessageDirect: db.storeMessageDirect,
    updateLatestMessageTokenUsage: vi.fn(),
    broadcastNewMessage: vi.fn(),
    broadcastStreamEvent: vi.fn(),
    shouldBroadcastSdkStreamEvent: () => false,
    getChannelType,
    isStreamingSessionSettled,
    getMessageChannelTurnContext: () => ({
      provider: 'feishu',
      chat: { id: `oc_${name}` },
    }),
    imManager: { executeFeishuCapability },
    getUncertainChannelOutboxForTurn: store.getUncertainChannelOutboxForTurn,
    getFailedChannelOutboxForTurn: store.getFailedChannelOutboxForTurn,
    setSession: vi.fn(),
    setSessionInteractionMode: vi.fn(),
    resetIdleTimer: vi.fn(),
    feedStreamEventToCard: vi.fn(),
    reduceStreamEvent: vi.fn(),
    resolveContainerOutputInputTurnId: (output: any, fallback: string) =>
      output.inputTurnId ?? fallback,
    agentRecallSuppression: false,
    agentRecalledInputIds: new Set<string>(),
    agentChannelOutboxScopesByInput: new Map(),
    agentAdmissionKey: `admission-${name}`,
    activeChannelOutboxScopes: { unbind: vi.fn() },
    markAgentOutputSettled: vi.fn(),
    TRUNCATION_EXHAUSTED_STATUS: '__truncation_exhausted__',
    agentTurnOutputCoordinators: new Map(),
    bindAgentTurnOutputCoordinator: () => ({
      reduceStreamEvent: () => ({ visibleAnswerChanged: false }),
    }),
    registeredGroups: {},
    writeUsageRecords: vi.fn(() => ({ providerEstimatedCostUSD: 0.01 })),
    agentScopeForOutput: vi.fn(() => ({ rejected: true })),
    heldAgentBaseText: () => '',
    finalizeHeldAgentDbMessage: vi.fn(),
    buildWebTraceUrl: () => null,
  };
  const harness = createRuntimeSourceHarness(globals);
  for (const fn of [
    'takeRecallStop',
    'settleInterruptedChannelTurn',
    'discardRecalledStreamingCard',
  ]) {
    harness.install(fn);
  }
  for (const fn of [
    'isCursorCommitted',
    'commitCursor',
    'settleAgentRecalledInput',
    'handleAgentOutput',
  ]) {
    harness.install(fn, 'processAgentConversation');
  }
  const status = (statusText: string) => ({
    status: 'stream',
    result: null,
    inputTurnId: inputId,
    streamEvent: { eventType: 'status', statusText },
  });
  return {
    globals,
    runtime,
    inputId,
    virtualChatJid,
    advanceCursors,
    executeFeishuCapability,
    activateAgentProjectionForInput,
    output: (value: unknown) => globals.handleAgentOutput(value),
    interrupted: () => globals.handleAgentOutput(status('interrupted')),
    thinking: () =>
      globals.handleAgentOutput({
        status: 'stream',
        result: null,
        inputTurnId: inputId,
        streamEvent: { eventType: 'thinking_delta', text: 'hmm' },
      }),
  };
}

describe('a run interrupted before producing any text settles its Turn', () => {
  test('/break: the Turn closes cancelled at the interrupt, cursor committed', async () => {
    const run = agentRun('break');
    const card = fakeCard(['om_card_break']);
    run.globals.agentStreamingSession = card;
    await run.interrupted();
    expect(store.getChannelTurnRun(run.runtime.runId)).toMatchObject({
      status: 'cancelled',
      error: 'Input interrupted by explicit stop',
    });
    expect(run.globals.agentChannelTurnRuntimes.has(run.inputId)).toBe(false);
    expect(run.advanceCursors).toHaveBeenCalledWith(
      run.virtualChatJid,
      expect.objectContaining({ id: run.inputId }),
    );
    // /break keeps its stop card and writes no interrupt partial (no text).
    expect(card.abort).toHaveBeenCalledWith('已停止');
    expect(db.getMessagesForTurn(run.virtualChatJid, run.inputId)).toEqual([]);
  });
});

describe('a recall stop leaves no framework artifact', () => {
  test('trailing output after the stop never creates a card; the Turn is cancelled', async () => {
    const run = agentRun('recall-race');
    run.globals.recallStoppedSessions.set(run.virtualChatJid, {
      messageId: run.inputId,
      at: Date.now(),
    });
    // The SDK still streams thinking before the interrupt lands.
    await run.thinking();
    expect(run.activateAgentProjectionForInput).not.toHaveBeenCalled();
    expect(run.globals.feedStreamEventToCard).not.toHaveBeenCalled();
    expect(run.globals.agentStreamingSession).toBeUndefined();
    expect(store.getChannelTurnRun(run.runtime.runId)).toMatchObject({
      status: 'cancelled',
      error: 'Input recalled by sender',
    });
    expect(run.advanceCursors).toHaveBeenCalled();
    // The interrupted status then publishes nothing either.
    await run.interrupted();
    expect(run.activateAgentProjectionForInput).not.toHaveBeenCalled();
    expect(run.globals.agentStreamingSession).toBeUndefined();
    expect(db.getMessagesForTurn(run.virtualChatJid, run.inputId)).toEqual([]);
  });

  test('a card that already exists is terminalized silently and deleted', async () => {
    const run = agentRun('recall-card');
    const card = fakeCard(['om_card_1']);
    run.globals.agentStreamingSession = card;
    run.globals.recallStoppedSessions.set(run.virtualChatJid, {
      messageId: run.inputId,
      at: Date.now(),
    });
    await run.interrupted();
    expect(card.abort).toHaveBeenCalledTimes(1);
    expect(card.abort.mock.calls[0]).toEqual([]);
    expect(run.executeFeishuCapability).toHaveBeenCalledWith(
      run.globals.replySourceImJid,
      expect.objectContaining({ provider: 'feishu' }),
      { operation: 'recall_message', params: { messageId: 'om_card_1' } },
    );
    expect(run.globals.agentStreamingSession).toBeUndefined();
    expect(store.getChannelTurnRun(run.runtime.runId)?.status).toBe(
      'cancelled',
    );
  });

  test("the interrupted query's usage is still billed during the recall window (M1)", async () => {
    const run = agentRun('recall-usage');
    run.globals.recallStoppedSessions.set(run.virtualChatJid, {
      messageId: run.inputId,
      at: Date.now(),
    });
    // Runner order on an interrupt: flush usage, then the interrupted status.
    await run.output({
      status: 'stream',
      result: null,
      inputTurnId: run.inputId,
      streamEvent: {
        eventType: 'usage',
        usage: {
          eventId: 'evt-recall',
          inputTokens: 120_000,
          outputTokens: 8_000,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          reasoningTokens: 0,
          costUSD: 0.5,
          batchIndex: 0,
          batchCount: 1,
        },
      },
    });
    await run.interrupted();
    expect(run.globals.writeUsageRecords).toHaveBeenCalledTimes(1);
    expect(run.activateAgentProjectionForInput).not.toHaveBeenCalled();
    expect(run.globals.agentStreamingSession).toBeUndefined();
    expect(store.getChannelTurnRun(run.runtime.runId)?.status).toBe(
      'cancelled',
    );
  });

  test('a final that beat the recall interrupt is bookkeeping only, never delivered (S1)', async () => {
    const run = agentRun('recall-final');
    const card = fakeCard(['om_card_final']);
    run.globals.agentStreamingSession = card;
    run.globals.recallStoppedSessions.set(run.virtualChatJid, {
      messageId: run.inputId,
      at: Date.now(),
    });
    await run.output({
      status: 'success',
      result: 'The full answer to the message the user recalled.',
      inputTurnId: run.inputId,
      inputTurnCompleted: true,
      sdkMessageUuid: 'u-1',
      newSessionId: 'sdk-session-2',
    });
    expect(run.executeFeishuCapability).toHaveBeenCalled();
    expect(store.getChannelTurnRun(run.runtime.runId)?.status).toBe(
      'cancelled',
    );
    // Lifecycle bookkeeping still happens; delivery never starts.
    expect(run.globals.markAgentOutputSettled).toHaveBeenCalledTimes(1);
    expect(run.globals.setSession).toHaveBeenCalled();
    expect(run.globals.agentScopeForOutput).not.toHaveBeenCalled();
    expect(run.activateAgentProjectionForInput).not.toHaveBeenCalled();
    // A later duplicate final of the same input is dropped as well.
    await run.output({
      status: 'success',
      result: 'duplicate',
      inputTurnId: run.inputId,
      inputTurnCompleted: true,
    });
    expect(run.globals.agentScopeForOutput).not.toHaveBeenCalled();
  });

  test("another run's recall stop never settles this run's input", async () => {
    const run = agentRun('recall-foreign');
    run.globals.recallStoppedSessions.set(run.virtualChatJid, {
      messageId: 'om_some_other_input',
      at: Date.now(),
    });
    await run.thinking();
    expect(run.activateAgentProjectionForInput).toHaveBeenCalled();
    expect(store.getChannelTurnRun(run.runtime.runId)?.status).toBe('running');
    expect(run.globals.recallStoppedSessions.size).toBe(0);
    run.runtime.dispose();
  });

  test("a settled card (an earlier input's answer) is never deleted", async () => {
    const run = agentRun('recall-settled');
    const previousAnswer = {
      ...fakeCard(['om_previous_answer']),
      isActive: () => false,
      currentState: 'completed',
    };
    run.globals.agentStreamingSession = previousAnswer;
    run.globals.recallStoppedSessions.set(run.virtualChatJid, {
      messageId: run.inputId,
      at: Date.now(),
    });
    await run.interrupted();
    expect(previousAnswer.abort).not.toHaveBeenCalled();
    expect(run.executeFeishuCapability).not.toHaveBeenCalled();
    expect(store.getChannelTurnRun(run.runtime.runId)?.status).toBe(
      'cancelled',
    );
  });

  test('a stale recall stop (past its TTL) is ignored', async () => {
    const run = agentRun('recall-stale');
    run.globals.recallStoppedSessions.set(run.virtualChatJid, {
      messageId: run.inputId,
      at: Date.now() - 11 * 60 * 1000,
    });
    await run.thinking();
    expect(run.activateAgentProjectionForInput).toHaveBeenCalled();
    expect(store.getChannelTurnRun(run.runtime.runId)?.status).toBe('running');
    run.runtime.dispose();
  });
});

/** Persist the state a crashed process leaves: message, Turn, card. */
function leftover(
  name: string,
  options: {
    recalled?: boolean;
    /** Card ends aborted; `marked` sets the structured explicit-stop marker. */
    card?: 'stopped-marked' | 'aborted-unmarked' | 'live';
    cardText?: string;
    keepAlive?: boolean;
    retryWait?: boolean;
  },
) {
  const inputId = `om_left_${name}_${crypto.randomBytes(4).toString('hex')}`;
  const logicalJid = `web:ws-left-${name}#agent:session`;
  const sourceJid = `feishu:oc_left_${name}#account:bot#thread:omt_${name}`;
  db.ensureChatExists(logicalJid);
  db.storeMessageDirect(
    `om_before_${name}`,
    logicalJid,
    'ou_user',
    'User',
    'earlier, already answered',
    '2026-10-10T14:17:00.000Z',
    false,
    { sourceJid },
  );
  db.storeMessageDirect(
    inputId,
    logicalJid,
    'ou_user',
    'User',
    'please do X',
    '2026-10-10T14:18:08.000Z',
    false,
    { sourceJid },
  );
  const runtime = ChannelTurnRuntime.start({
    provider: 'feishu',
    accountId: 'bot',
    sourceJid,
    chatId: `oc_left_${name}`,
    rootId: inputId,
    threadId: `omt_${name}`,
    externalMessageId: inputId,
    agentId: 'session',
  });
  let cardId: string | undefined;
  if (options.card) {
    const lifecycle = runtime.reserveStreamingCard()!;
    cardId = lifecycle.idempotencyKey;
    lifecycle.onEvent({
      status: 'creating',
      version: 1,
      snapshot: { text: '', thinking: '', state: 'creating' },
    } as never);
    lifecycle.onEvent({
      status: 'streaming',
      version: 2,
      messageId: `om_card_${name}`,
      cardId: `card_${name}`,
      snapshot: { text: 'partial', thinking: '', state: 'streaming' },
    } as never);
    if (options.card === 'stopped-marked') runtime.markExplicitStopRequested();
    if (options.card !== 'live') {
      lifecycle.onEvent({
        status: 'aborted',
        version: 3,
        snapshot: {
          text: options.cardText ?? 'partial\n\n---\n*已停止*',
          thinking: '',
          state: 'aborted',
        },
      } as never);
    }
  }
  if (options.recalled) {
    const recorded = store.recordChannelInbox({
      provider: 'feishu',
      accountId: 'bot',
      externalMessageId: inputId,
      sourceJid,
      chatId: `oc_left_${name}`,
      status: 'received',
    });
    store.transitionChannelInbox(recorded.item.id, 'received', 'ignored', {
      error: 'recalled',
    });
  }
  if (options.retryWait) runtime.retry('runner closed');
  // The process dies: heartbeats stop and the lease is left behind.
  if (!options.keepAlive) runtime.dispose();
  const committed = db.getMessageCursor(logicalJid, `om_before_${name}`)!;
  return { inputId, logicalJid, sourceJid, runtime, committed, cardId };
}

function startupRepairLane() {
  const cursors: Record<string, any> = {};
  const advanceCursors = vi.fn((jid: string, cursor: any) => {
    cursors[jid] = cursor;
  });
  const executeFeishuCapability = vi.fn(async () => ({}));
  const globals: Record<string, unknown> = {
    logger,
    process,
    listNonterminalChannelTurnRuns: store.listNonterminalChannelTurnRuns,
    cancelChannelTurnRunById: store.cancelChannelTurnRunById,
    getPrimaryStreamingCardForTurn: store.getPrimaryStreamingCardForTurn,
    getChannelInboxByExternalMessage: store.getChannelInboxByExternalMessage,
    getUncertainChannelOutboxForTurn: store.getUncertainChannelOutboxForTurn,
    getDeliveredChannelOutboxForTurn: store.getDeliveredChannelOutboxForTurn,
    getStreamingCardRecord: store.getStreamingCardRecord,
    finalizeStreamingCardRecord: store.finalizeStreamingCardRecord,
    EXPLICIT_STOP_REASON: store.EXPLICIT_STOP_REASON,
    CHANNEL_RELIABILITY_TERMINAL_STATUSES:
      store.CHANNEL_RELIABILITY_TERMINAL_STATUSES,
    listInboundMessagesById: db.listInboundMessagesById,
    cancelPendingInboundMessage: db.cancelPendingInboundMessage,
    getMessageCursor: db.getMessageCursor,
    getMessageChannelTurnContext: () => ({
      provider: 'feishu',
      chat: { id: 'oc' },
    }),
    channelConversationJid,
    parseChannelAddress,
    getChannelType,
    imManager: { executeFeishuCapability },
    advanceCursors,
  };
  const harness = createRuntimeSourceHarness(globals);
  harness.install('repairWithdrawnChannelTurnsOnStartup');
  harness.install('discardWithdrawnTurnCardsAfterConnect');
  return {
    cursors,
    advanceCursors,
    executeFeishuCapability,
    /** Repair as a restarted process: the old process's leases have lapsed. */
    repair: () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 120_000);
      // The harness context is its own realm: hand it the faked clock.
      globals.Date = globalThis.Date;
      try {
        return (
          globals.repairWithdrawnChannelTurnsOnStartup as () => Array<{
            cardId: string;
          }>
        )();
      } finally {
        vi.useRealTimers();
        globals.Date = globalThis.Date;
      }
    },
    repairWithLiveLeases: () =>
      (globals.repairWithdrawnChannelTurnsOnStartup as () => unknown[])(),
    discardCards: (cleanups: unknown[]) =>
      (
        globals.discardWithdrawnTurnCardsAfterConnect as (
          c: unknown[],
        ) => Promise<void>
      )(cleanups),
  };
}

function deliverOutbox(
  runId: string,
  route: { sourceJid: string; inputId: string },
  outcome: 'delivered' | 'uncertain',
) {
  const queued = store.enqueueChannelOutbox({
    provider: 'feishu',
    accountId: 'bot',
    sourceJid: route.sourceJid,
    chatId: 'oc',
    turnRunId: runId,
    ordinal: 1,
    kind: 'text',
    payload: { text: 'hi' },
  });
  const claim = store.claimChannelOutboxById(queued.item.id, 'w', 60_000)!;
  store.markChannelOutboxSending(claim);
  if (outcome === 'delivered') {
    store.completeChannelOutbox(claim, { providerMessageId: 'om_sent' });
  } else {
    store.failChannelOutbox(claim, { error: 'timeout', uncertain: true });
  }
}

describe('startup repair: a withdrawn input is never re-run after a restart', () => {
  test('an explicitly stopped run (structured marker): Turn cancelled, cursor advanced', () => {
    const left = leftover('stopped', { card: 'stopped-marked' });
    // Without repair, recovery would replay the input from the old cursor.
    expect(
      db.getMessagesSince(left.logicalJid, left.committed).map((m) => m.id),
    ).toEqual([left.inputId]);
    expect(store.getStreamingCardRecord(left.cardId!)?.snapshot).toMatchObject({
      stopReason: 'explicit_stop',
    });
    const lane = startupRepairLane();
    lane.repair();
    expect(store.getChannelTurnRun(left.runtime.runId)).toMatchObject({
      status: 'cancelled',
      error: 'Startup repair: input consumed by an explicit stop',
    });
    const advanced = lane.cursors[left.logicalJid];
    expect(advanced?.id).toBe(left.inputId);
    expect(db.getMessagesSince(left.logicalJid, advanced)).toEqual([]);
  });

  test('visible text ending with *已停止* without the marker is NOT a stop (S2)', () => {
    const left = leftover('text-only', {
      card: 'aborted-unmarked',
      cardText: 'nginx 当前状态：*已停止*',
    });
    const lane = startupRepairLane();
    lane.repair();
    expect(store.getChannelTurnRun(left.runtime.runId)?.status).toBe('running');
    expect(lane.cursors[left.logicalJid]).toBeUndefined();
  });

  test('a Turn leased by a live run of this process is never touched (S3)', () => {
    const left = leftover('live-lease', {
      card: 'stopped-marked',
      keepAlive: true,
    });
    const lane = startupRepairLane();
    lane.repairWithLiveLeases();
    expect(store.getChannelTurnRun(left.runtime.runId)?.status).toBe('running');
    // The live owner keeps its fence.
    expect(left.runtime.markFinalizing()).toBe(true);
    expect(left.runtime.complete({ ok: true })).toBe(true);
    left.runtime.dispose();
  });

  test('an uncertain delivery keeps manual reconciliation; a delivered one blocks the stop rule', () => {
    const uncertain = leftover('uncertain', {
      card: 'stopped-marked',
      recalled: true,
    });
    deliverOutbox(uncertain.runtime.runId, uncertain, 'uncertain');
    const delivered = leftover('delivered', { card: 'stopped-marked' });
    deliverOutbox(delivered.runtime.runId, delivered, 'delivered');
    const lane = startupRepairLane();
    lane.repair();
    expect(store.getChannelTurnRun(uncertain.runtime.runId)?.status).toBe(
      'running',
    );
    expect(store.getChannelTurnRun(delivered.runtime.runId)?.status).toBe(
      'running',
    );
    expect(lane.cursors[delivered.logicalJid]).toBeUndefined();
  });

  test('a retry_wait Turn of a stopped run is closed too', () => {
    const left = leftover('retry-wait', {
      card: 'stopped-marked',
      retryWait: true,
    });
    expect(store.getChannelTurnRun(left.runtime.runId)?.status).toBe(
      'retry_wait',
    );
    const lane = startupRepairLane();
    lane.repair();
    expect(store.getChannelTurnRun(left.runtime.runId)?.status).toBe(
      'cancelled',
    );
    expect(lane.cursors[left.logicalJid]?.id).toBe(left.inputId);
  });

  test('the repair is idempotent', () => {
    const left = leftover('idempotent', { card: 'stopped-marked' });
    const lane = startupRepairLane();
    lane.repair();
    const calls = lane.advanceCursors.mock.calls.length;
    expect(lane.repair()).toEqual([]);
    expect(lane.advanceCursors.mock.calls.length).toBe(calls);
    expect(store.getChannelTurnRun(left.runtime.runId)?.status).toBe(
      'cancelled',
    );
  });

  test('a recalled input: Turn cancelled, message excluded, live card removed silently (S4)', async () => {
    const left = leftover('recalled', { recalled: true, card: 'live' });
    const lane = startupRepairLane();
    const cleanups = lane.repair();
    expect(store.getChannelTurnRun(left.runtime.runId)).toMatchObject({
      status: 'cancelled',
      error: 'Startup repair: input recalled by sender',
    });
    expect(
      db.getMessagesSince(left.logicalJid, left.committed).map((m) => m.id),
    ).toEqual([]);
    expect(cleanups.map((cleanup) => cleanup.cardId)).toContain(left.cardId);
    // After the channels connect: deleted through the Bot, then terminal so
    // reconciliation never rewrites it into an "interrupted" card.
    await lane.discardCards(cleanups);
    expect(lane.executeFeishuCapability).toHaveBeenCalledWith(
      left.sourceJid,
      expect.objectContaining({ provider: 'feishu' }),
      {
        operation: 'recall_message',
        params: { messageId: 'om_card_recalled' },
      },
    );
    expect(store.getStreamingCardRecord(left.cardId!)?.status).toBe('aborted');
  });

  test('batch [m1, m2] with m2 recalled while running: m1 still replays after a crash', () => {
    const logicalJid = 'web:ws-batch#agent:session';
    const sourceJid = 'feishu:oc_batch#account:bot#thread:omt_batch';
    db.ensureChatExists(logicalJid);
    for (const [id, at] of [
      ['om_b_prev', '2026-10-10T14:17:00.000Z'],
      ['om_b_1', '2026-10-10T14:18:00.000Z'],
      ['om_b_2', '2026-10-10T14:18:01.000Z'],
    ] as const) {
      db.storeMessageDirect(id, logicalJid, 'ou', 'U', id, at, false, {
        sourceJid,
      });
    }
    const committed = db.getMessageCursor(logicalJid, 'om_b_prev')!;
    // One Turn per batch, keyed on its last input.
    const runtime = ChannelTurnRuntime.start({
      provider: 'feishu',
      accountId: 'bot',
      sourceJid,
      chatId: 'oc_batch',
      rootId: 'om_b_2',
      threadId: 'omt_batch',
      externalMessageId: 'om_b_2',
      agentId: 'session',
    });
    // The recall of a two-input batch does not interrupt; it only withdraws.
    expect(db.cancelPendingInboundMessage(logicalJid, 'om_b_2')).toBe(true);
    runtime.dispose();
    const lane = startupRepairLane();
    lane.repair();
    expect(store.getChannelTurnRun(runtime.runId)?.status).toBe('cancelled');
    expect(lane.cursors[logicalJid]).toBeUndefined();
    expect(db.getMessagesSince(logicalJid, committed).map((m) => m.id)).toEqual(
      ['om_b_1'],
    );
  });

  test('an ordinary crashed Turn is left for normal recovery', () => {
    const left = leftover('ordinary', {});
    const lane = startupRepairLane();
    lane.repair();
    expect(store.getChannelTurnRun(left.runtime.runId)?.status).toBe('running');
    expect(lane.cursors[left.logicalJid]).toBeUndefined();
  });
});

describe('main Session path (processGroupMessages)', () => {
  test('a recall stop settles the input: card deleted, Turn cancelled, cursor committed', async () => {
    const inputId = `om_main_${crypto.randomBytes(4).toString('hex')}`;
    const chatJid = 'web:main-recall';
    const imJid = 'feishu:oc_main#account:bot';
    const runtime = ChannelTurnRuntime.start({
      provider: 'feishu',
      accountId: 'bot',
      sourceJid: imJid,
      chatId: 'oc_main',
      externalMessageId: inputId,
    });
    const card = fakeCard(['om_main_card']);
    const advanceCursors = vi.fn();
    const executeFeishuCapability = vi.fn(async () => ({}));
    const clearProcessingIndicatorForInput = vi.fn(async () => {});
    const globals: Record<string, any> = {
      logger,
      chatJid,
      lastProcessed: { id: inputId, timestamp: '2026-10-10T14:18:08.000Z' },
      ipcReplyTurnTracker: { inputTurnId: inputId, delivered: false },
      channelTurnRuntimes: new Map([[inputId, runtime]]),
      channelStreamingSessionsByInput: new Map(),
      mainRecalledInputIds: new Set<string>(),
      channelOutboxScopesByInput: new Map([[inputId, { token: 'scope-1' }]]),
      mainAdmissionKey: 'main-admission',
      activeChannelOutboxScopes: { unbind: vi.fn() },
      cursorCommittedInputTurns: new Set<string>(),
      streamingSession: card,
      streamingSessionJid: imJid,
      activeDurableCardLifecycle: {},
      streamingAccumulatedText: 'partial',
      streamingAccumulatedThinking: 'thinking',
      sentReply: false,
      advanceCursors,
      flushAcknowledgedIpcForJid: vi.fn(),
      clearStreamingSnapshot: vi.fn(),
      unregisterStreamingSession: vi.fn(),
      clearProcessingIndicatorForInput,
      getChannelType,
      isStreamingSessionSettled,
      getMessageChannelTurnContext: () => ({
        provider: 'feishu',
        chat: { id: 'oc_main' },
      }),
      imManager: { executeFeishuCapability },
      getUncertainChannelOutboxForTurn: store.getUncertainChannelOutboxForTurn,
      getFailedChannelOutboxForTurn: store.getFailedChannelOutboxForTurn,
    };
    const harness = createRuntimeSourceHarness(globals);
    harness.install('settleInterruptedChannelTurn');
    harness.install('discardRecalledStreamingCard');
    harness.install('commitCursor', 'processGroupMessages');
    harness.install('settleMainRecalledInput', 'processGroupMessages');
    await globals.settleMainRecalledInput(inputId);
    expect(card.abort.mock.calls).toEqual([[]]);
    expect(executeFeishuCapability).toHaveBeenCalledWith(
      imJid,
      expect.anything(),
      { operation: 'recall_message', params: { messageId: 'om_main_card' } },
    );
    expect(globals.streamingSession).toBeUndefined();
    expect(globals.sentReply).toBe(true);
    expect(store.getChannelTurnRun(runtime.runId)?.status).toBe('cancelled');
    expect(advanceCursors).toHaveBeenCalledWith(
      chatJid,
      expect.objectContaining({ id: inputId }),
    );
    expect(clearProcessingIndicatorForInput).toHaveBeenCalledWith(inputId);
    // Late side effects of the withdrawn input find no outbox scope (S1).
    expect(globals.activeChannelOutboxScopes.unbind).toHaveBeenCalledWith(
      'main-admission',
      { token: 'scope-1' },
    );
    expect(globals.channelOutboxScopesByInput.has(inputId)).toBe(false);
    expect(globals.mainRecalledInputIds.has(inputId)).toBe(true);
  });

  test('the main output handler settles recall before projecting and closes interrupted Turns (loop wiring)', () => {
    const main = fs.readFileSync('src/index.ts', 'utf8');
    const callbackStart = main.indexOf('output = await runAgent(');
    const callback = main.slice(callbackStart, callbackStart + 60_000);
    const recallAt = callback.search(/takeRecallStop\(\s*chatJid,/);
    expect(recallAt).toBeGreaterThan(0);
    expect(recallAt).toBeLessThan(
      callback.indexOf('await activateMainProjectionForInput('),
    );
    const interruptCommit = callback.indexOf(
      'commitCursor(interruptedInputId);',
    );
    expect(interruptCommit).toBeGreaterThan(0);
    expect(
      callback.indexOf('settleInterruptedChannelTurn(', interruptCommit),
    ).toBeGreaterThan(interruptCommit);
  });
});

describe('startup order', () => {
  test('the withdrawn-turn repair runs before reconciliation and replay', () => {
    const main = fs.readFileSync('src/index.ts', 'utf8');
    const repairAt = main.indexOf(
      'const withdrawnTurnCardCleanups = repairWithdrawnChannelTurnsOnStartup();',
    );
    expect(repairAt).toBeGreaterThan(main.indexOf('  loadState();'));
    // Before follow-up recovery (which can start Runners) and replay.
    expect(repairAt).toBeLessThan(main.indexOf('  recoverDurableFollowUps();'));
    expect(repairAt).toBeLessThan(main.indexOf('  recoverPendingMessages();'));
    const discardAt = main.indexOf(
      'await discardWithdrawnTurnCardsAfterConnect(withdrawnTurnCardCleanups);',
    );
    expect(discardAt).toBeGreaterThan(repairAt);
    expect(discardAt).toBeLessThan(
      main.indexOf('await reconcileChannelReliabilityOnStartup(imManager);'),
    );
  });
});

/** The real processGroupMessages output handler for one claimed input. */
function mainRun(name: string, options: { steered?: boolean } = {}) {
  const inputId = `om_mainrun_${name}_${crypto.randomBytes(4).toString('hex')}`;
  const chatJid = `web:main-run-${name}`;
  const imJid = `feishu:oc_mainrun_${name}#account:bot`;
  const runtime = ChannelTurnRuntime.start({
    provider: 'feishu',
    accountId: 'bot',
    sourceJid: imJid,
    chatId: `oc_mainrun_${name}`,
    externalMessageId: inputId,
  });
  const advanceCursors = vi.fn();
  const card = fakeCard([`om_card_${name}`]);
  const globals: Record<string, any> = {
    crypto,
    logger,
    ASSISTANT_NAME: 'Assistant',
    chatJid,
    group: { name: 'Main fixture' },
    effectiveGroup: { folder: `main-${name}`, created_by: 'user-1' },
    lastProcessed: { id: inputId, timestamp: '2026-10-10T14:18:08.000Z' },
    missedMessages: [{ id: inputId }],
    ipcReplyTurnTracker: { inputTurnId: inputId, delivered: false },
    interactionMode: 'assistant',
    channelTurnRuntimes: new Map([[inputId, runtime]]),
    channelStreamingSessionsByInput: new Map(),
    channelOutboxScopesByInput: new Map(),
    cursorCommittedInputTurns: new Set<string>(),
    mainRecalledInputIds: new Set<string>(),
    mainRecallSuppression: false,
    recallStoppedSessions: new Map(),
    RECALL_STOP_TTL_MS: 10 * 60 * 1000,
    streamingSession: card,
    streamingSessionJid: imJid,
    streamingAccumulatedText: '',
    streamingAccumulatedThinking: '',
    streamInterrupted: false,
    streamSteered: false,
    sentReply: false,
    heldCardParts: [],
    activeSessionId: 'sdk-session',
    shutdownSavedJids: new Set<string>(),
    inputUsageProjection: new InputUsageProjection(inputId),
    turnOutputCoordinators: new Map(),
    steeringTransitions: { shouldSuppressOutput: () => false },
    resolveSteeringInterrupt: () => options.steered === true,
    rememberScheduledGroupRuns: vi.fn(),
    activateMainProjectionForInput: vi.fn(async () => {}),
    publishesFrameworkAnswer,
    buildStoppedReply,
    buildSteeredReply,
    advanceCursors,
    flushAcknowledgedIpcForJid: vi.fn(),
    clearStreamingSnapshot: vi.fn(),
    clearProcessingIndicatorForInput: vi.fn(async () => {}),
    getUncertainChannelOutboxForTurn: store.getUncertainChannelOutboxForTurn,
    getFailedChannelOutboxForTurn: store.getFailedChannelOutboxForTurn,
    resolveContainerOutputInputTurnId: (output: any, fallback: string) =>
      output.inputTurnId ?? fallback,
    sendMessage: vi.fn(async () => 'msg-id'),
    bindTurnOutputCoordinator: () => ({
      reduceStreamEvent: () => ({ visibleAnswerChanged: false }),
    }),
    shouldBroadcastSdkStreamEvent: () => false,
    broadcastStreamEvent: vi.fn(),
    isStreamingSessionSettled,
    feedStreamEventToCard: vi.fn(),
    heldCardBaseText: () => '',
    buildWebTraceUrl: () => null,
    resetIdleTimer: vi.fn(),
    TRUNCATION_EXHAUSTED_STATUS: '__truncation_exhausted__',
    mainAdmissionKey: `main-admission-${name}`,
    activeChannelOutboxScopes: { unbind: vi.fn() },
    activeDurableCardLifecycle: undefined,
    unregisterStreamingSession: vi.fn(),
    getChannelType,
    getMessageChannelTurnContext: () => ({
      provider: 'feishu',
      chat: { id: `oc_mainrun_${name}` },
    }),
    imManager: { executeFeishuCapability: vi.fn(async () => ({})) },
    writeUsageRecords: vi.fn(() => ({ providerEstimatedCostUSD: 0.01 })),
    registeredGroups: {},
    markMainOutputSettled: vi.fn(),
  };
  const harness = createRuntimeSourceHarness(globals);
  for (const fn of [
    'takeRecallStop',
    'settleInterruptedChannelTurn',
    'discardRecalledStreamingCard',
  ]) {
    harness.install(fn);
  }
  harness.install('commitCursor', 'processGroupMessages');
  harness.install('settleMainRecalledInput', 'processGroupMessages');
  harness.installMainOutput();
  return {
    globals,
    runtime,
    inputId,
    card,
    advanceCursors,
    output: (value: unknown) => globals.handleMainOutput(value),
    interrupted: () =>
      globals.handleMainOutput({
        status: 'stream',
        result: null,
        inputTurnId: inputId,
        streamEvent: { eventType: 'status', statusText: 'interrupted' },
      }),
  };
}

describe('main Session interrupt settlement (behavioural)', () => {
  test('/break before any text: Turn cancelled at the interrupt, stop marker on the card', async () => {
    const run = mainRun('break');
    await run.interrupted();
    expect(store.getChannelTurnRun(run.runtime.runId)).toMatchObject({
      status: 'cancelled',
      error: 'Input interrupted by explicit stop',
    });
    expect(run.globals.channelTurnRuntimes.has(run.inputId)).toBe(false);
    expect(run.advanceCursors).toHaveBeenCalledWith(
      run.globals.chatJid,
      expect.objectContaining({ id: run.inputId }),
    );
    expect(run.card.abort).toHaveBeenCalledWith('已停止');
    expect(run.globals.sendMessage).not.toHaveBeenCalled();
  });

  test('recall: usage is billed, the card is deleted and nothing else is published', async () => {
    const run = mainRun('recall');
    run.globals.recallStoppedSessions.set(run.globals.chatJid, {
      messageId: run.inputId,
      at: Date.now(),
    });
    await run.output({
      status: 'stream',
      result: null,
      inputTurnId: run.inputId,
      streamEvent: {
        eventType: 'usage',
        usage: {
          eventId: 'evt-main-recall',
          inputTokens: 1000,
          outputTokens: 10,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          reasoningTokens: 0,
          costUSD: 0.01,
          batchIndex: 0,
          batchCount: 1,
        },
      },
    });
    expect(run.globals.writeUsageRecords).toHaveBeenCalledTimes(1);
    expect(run.globals.activateMainProjectionForInput).not.toHaveBeenCalled();
    expect(run.card.abort.mock.calls).toEqual([[]]);
    expect(run.globals.imManager.executeFeishuCapability).toHaveBeenCalled();
    expect(store.getChannelTurnRun(run.runtime.runId)?.status).toBe(
      'cancelled',
    );
    // A final that beat the interrupt is bookkeeping only.
    await run.output({
      status: 'success',
      result: 'answer to the recalled message',
      inputTurnId: run.inputId,
      inputTurnCompleted: true,
    });
    expect(run.globals.markMainOutputSettled).toHaveBeenCalledTimes(1);
    expect(run.globals.sendMessage).not.toHaveBeenCalled();
  });

  test('steer: the superseded Turn closes at the interrupt; the card completes', async () => {
    const run = mainRun('steer', { steered: true });
    await run.interrupted();
    expect(store.getChannelTurnRun(run.runtime.runId)).toMatchObject({
      status: 'cancelled',
      error: 'Input superseded by explicit steer',
    });
    expect(run.card.abort).not.toHaveBeenCalled();
    expect(run.card.complete).toHaveBeenCalled();
  });
});

describe('settleInterruptedChannelTurn', () => {
  test('a refused or uncertain delivery keeps the normal settlement path', () => {
    const globals: Record<string, unknown> = {
      logger,
      getUncertainChannelOutboxForTurn: store.getUncertainChannelOutboxForTurn,
      getFailedChannelOutboxForTurn: store.getFailedChannelOutboxForTurn,
    };
    const harness = createRuntimeSourceHarness(globals);
    harness.install('settleInterruptedChannelTurn');
    const settle = globals.settleInterruptedChannelTurn as (
      runtimes: Map<string, unknown>,
      inputId: string,
      reason: string,
    ) => boolean;
    for (const outcome of ['failed', 'uncertain'] as const) {
      const inputId = `om_settle_${outcome}`;
      const runtime = ChannelTurnRuntime.start({
        provider: 'feishu',
        accountId: 'bot',
        sourceJid: `feishu:oc_settle_${outcome}`,
        chatId: `oc_settle_${outcome}`,
        externalMessageId: inputId,
      });
      const queued = store.enqueueChannelOutbox({
        provider: 'feishu',
        accountId: 'bot',
        sourceJid: `feishu:oc_settle_${outcome}`,
        chatId: `oc_settle_${outcome}`,
        turnRunId: runtime.runId,
        ordinal: 1,
        kind: 'text',
        payload: { text: 'hi' },
      });
      const claim = store.claimChannelOutboxById(queued.item.id, 'w', 60_000)!;
      store.markChannelOutboxSending(claim);
      store.failChannelOutbox(claim, {
        error: 'refused',
        uncertain: outcome === 'uncertain',
      });
      const runtimes = new Map([[inputId, runtime]]);
      expect(
        settle(runtimes, inputId, 'Input interrupted by explicit stop'),
      ).toBe(false);
      expect(runtimes.has(inputId)).toBe(true);
      expect(store.getChannelTurnRun(runtime.runId)?.status).toBe('running');
      runtime.dispose();
    }
  });
});
