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
import {
  projectSdkStreamEventForWeb,
  publishesFrameworkAnswer,
} from '../src/workspace-interaction-runtime.js';
import { ProactiveCommentaryRelay } from '../src/process-commentary.js';
import { TurnTraceTracker } from '../src/turn-trace.js';
import { resolveContainerOutputInputTurnId } from '../src/channel-output-correlation.js';
import { buildSubagentCheckpointContext } from '../src/subagent-checkpoint.js';
import { StreamEventProcessor } from '../container/agent-runner/src/stream-processor.js';
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

// A started Turn heartbeats on a timer. Stop every one before the store closes:
// a tick after that throws, an unhandled error in a long run of this file.
const startedRuntimes = vi.spyOn(ChannelTurnRuntime, 'start');

beforeAll(() => db.initDatabase());
afterAll(() => {
  for (const started of startedRuntimes.mock.results) {
    if (started.type === 'return') started.value.dispose();
  }
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
      markRunnerBackgroundHold: vi.fn(),
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
    // The Web projection of the stream is covered by
    // workspace-interaction-runtime.test.ts; these runs only settle Turns.
    projectSdkStreamEventForWeb: () => null,
    resolveProcessVisibility: () => 'full',
    turnTraces: {
      observe: vi.fn(),
      persist: vi.fn(() => false),
      discard: vi.fn(),
    },
    persistProactiveTurnTrace: vi.fn(),
    commentaryRelay: new ProactiveCommentaryRelay(),
    broadcastMessageTrace: vi.fn(),
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
    broadcastContextUsage: vi.fn(),
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
    harness,
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

describe('startup order', () => {
  test('the withdrawn-turn repair runs before reconciliation and replay', () => {
    const main = fs.readFileSync('src/index.ts', 'utf8');
    const repairAt = main.indexOf(
      'const withdrawnTurnCardCleanups = repairWithdrawnChannelTurnsOnStartup();',
    );
    expect(repairAt).toBeGreaterThan(main.indexOf('  loadState();'));
    // Before follow-up recovery (which can start Runners) and replay.
    expect(repairAt).toBeLessThan(main.indexOf('  recoverDurableFollowUps('));
    expect(repairAt).toBeLessThan(
      main.indexOf('  recoverConversationAgents();'),
    );
    const discardAt = main.indexOf(
      'await discardWithdrawnTurnCardsAfterConnect(withdrawnTurnCardCleanups);',
    );
    expect(discardAt).toBeGreaterThan(repairAt);
    expect(discardAt).toBeLessThan(
      main.indexOf('await reconcileChannelReliabilityOnStartup(imManager);'),
    );
  });
});

describe('session sub-agent checkpoints (behavioural)', () => {
  /** A session run that follows its sub-agent Tasks the way production does. */
  function checkpointRun(name: string) {
    const run = agentRun(name);
    const running = new Map<string, Set<string>>();
    Object.assign(run.globals, {
      runningSubagentTasksByLane: running,
      NON_SUBAGENT_TASK_TYPES: new Set(['local_bash', 'monitor', 'mcp_task']),
      upsertSubagentCheckpoint: db.upsertSubagentCheckpoint,
      nonSubagentTaskIds: new Set<string>(),
      subagentTaskInputMessageId: () => run.inputId,
    });
    run.harness.install('trackSubagentTaskEvent');
    // The runner's processor turns the SDK frames into what the Host reads.
    const frames: unknown[] = [];
    const processor = new StreamEventProcessor(
      (output) => frames.push({ ...output, inputTurnId: run.inputId }),
      () => {},
    );
    const forward = async () => {
      for (const frame of frames.splice(0)) await run.output(frame);
    };
    const folder = run.globals.effectiveGroup.folder as string;
    const rows = () =>
      db.listSubagentCheckpointsForInputs(folder, run.virtualChatJid, [
        run.inputId,
      ]);
    return { run, running, processor, forward, rows };
  }

  test('/break: a sub-agent the stop ended is handed back as unfinished on replay', async () => {
    const { run, running, processor, forward, rows } =
      checkpointRun('break-subagent');
    processor.processSystemMessage({
      type: 'system',
      subtype: 'task_started',
      task_id: 'sdk-task-1',
      tool_use_id: 'toolu_audit',
      description: 'Audit the deploy scripts',
      task_type: 'local_agent',
    });
    await forward();
    // A running sub-agent holds the lane's idle container.
    expect([...(running.get(run.virtualChatJid) ?? [])]).toEqual([
      'toolu_audit',
    ]);
    await run.interrupted();
    // The SDK reports the sub-agent the stop ended as stopped.
    processor.processSystemMessage({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'sdk-task-1',
      tool_use_id: 'toolu_audit',
      status: 'stopped',
      summary: 'Stopped by the user',
    });
    await forward();

    expect(running.get(run.virtualChatJid)?.size ?? 0).toBe(0);
    expect(rows()).toMatchObject([
      { taskId: 'toolu_audit', status: 'stopped' },
    ]);
    const handedBack = buildSubagentCheckpointContext(rows())!;
    expect(handedBack).toMatchObject({ completed: 0, unfinished: 1 });
    expect(handedBack.context).toContain(
      '<subagent_task id="toolu_audit" state="unfinished" description="Audit the deploy scripts">\n<note>上次运行中被停止：Stopped by the user</note>',
    );
  });

  test('a finished sub-agent keeps its answer; shell tasks are no sub-agents', async () => {
    const { processor, forward, rows } = checkpointRun('done-subagent');
    processor.processSystemMessage({
      type: 'system',
      subtype: 'task_started',
      task_id: 'sdk-shell',
      tool_use_id: 'toolu_shell',
      description: 'npm test',
      task_type: 'local_bash',
    });
    processor.processSystemMessage({
      type: 'system',
      subtype: 'task_started',
      task_id: 'sdk-task-2',
      tool_use_id: 'toolu_review',
      description: 'Review the patch',
      task_type: 'local_agent',
    });
    await forward();
    processor.processSystemMessage({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'sdk-shell',
      tool_use_id: 'toolu_shell',
      status: 'completed',
      summary: 'tests passed',
    });
    processor.processSystemMessage({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'sdk-task-2',
      tool_use_id: 'toolu_review',
      status: 'completed',
      summary: 'Looks good',
    });
    await forward();
    expect(rows()).toMatchObject([
      { taskId: 'toolu_review', status: 'completed', summary: 'Looks good' },
    ]);
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

type Level = 'hidden' | 'activity' | 'full';

/** A session run with the real Web projection, narration, traces and a card. */
function sessionWith(
  name: string,
  mode: 'assistant' | 'proactive',
  level: Level,
) {
  const run = agentRun(name);
  const traceStore = vi.fn();
  Object.assign(run.globals, {
    interactionMode: mode,
    agentStreamingSession: fakeCard([`om_card_${name}`]),
    projectSdkStreamEventForWeb,
    resolveProcessVisibility: () => (mode === 'proactive' ? level : 'full'),
    commentaryRelay: new ProactiveCommentaryRelay(),
    turnTraces: new TurnTraceTracker({
      mode,
      getVisibility: () => level,
      store: traceStore,
    }),
    broadcastStreamEvent: vi.fn(),
  });
  const broadcasts = () =>
    (run.globals.broadcastStreamEvent as ReturnType<typeof vi.fn>).mock.calls
      .map(([, event]) => event)
      .filter((event) => event.eventType !== 'usage');
  return { run, traceStore, broadcasts };
}

/**
 * Process visibility at the host: the real output handlers decide, per event,
 * what the Web is told and what an IM card is fed.
 */
describe('process visibility in the real output handlers (behavioural)', () => {
  async function streamThrough(
    handler: (output: unknown) => Promise<unknown>,
    inputId: string,
    events: Array<Record<string, unknown>>,
  ): Promise<void> {
    for (const streamEvent of events) {
      await handler({
        status: 'stream',
        result: null,
        inputTurnId: inputId,
        streamEvent,
      });
    }
  }

  const PROCESS = [
    { eventType: 'status', statusText: 'requesting' },
    { eventType: 'thinking_start' },
    { eventType: 'thinking_delta', text: '先看目录' },
    { eventType: 'thinking_end', thinkingDurationMs: 800 },
    { eventType: 'text_delta', text: '这是模型的话' },
    {
      eventType: 'tool_use_start',
      toolName: 'Bash',
      toolUseId: 'tool-1',
      toolInputSummary: 'command: ls',
    },
    {
      eventType: 'tool_result',
      toolUseId: 'tool-1',
      toolResult: 'a.txt',
      detail: 'a.txt',
    },
    { eventType: 'tool_use_end', toolUseId: 'tool-1' },
    { eventType: 'memory_recall', summary: '回忆' },
    { eventType: 'context_audit', title: 'Agent Context' },
  ];

  test('a hidden proactive workspace shows the spinner and nothing of the process', async () => {
    const { run, broadcasts } = sessionWith(
      'vis-hidden',
      'proactive',
      'hidden',
    );
    await streamThrough(run.output, run.inputId, PROCESS);
    expect(broadcasts().map((e) => e.eventType)).toEqual([
      'status',
      'context_audit',
    ]);
    expect(run.globals.feedStreamEventToCard).not.toHaveBeenCalled();
  });

  test("activity adds the structure of the work, never the model's words", async () => {
    const { run, broadcasts } = sessionWith(
      'vis-activity',
      'proactive',
      'activity',
    );
    await streamThrough(run.output, run.inputId, PROCESS);
    const sent = broadcasts();
    expect(sent.map((e) => e.eventType)).toEqual([
      'status',
      'thinking_start',
      'thinking_end',
      'tool_use_start',
      'tool_result',
      'tool_use_end',
      'context_audit',
    ]);
    const result = sent.find((e) => e.eventType === 'tool_result');
    expect(result.toolResult).toBeUndefined();
    expect(result.detail).toBeUndefined();
    // a proactive turn's process never reaches an IM card, even if one exists
    expect(run.globals.feedStreamEventToCard).not.toHaveBeenCalled();
  });

  test('full also streams the reasoning summary, still not the answer text', async () => {
    const { run, broadcasts } = sessionWith('vis-full', 'proactive', 'full');
    await streamThrough(run.output, run.inputId, PROCESS);
    const types = broadcasts().map((e) => e.eventType);
    expect(types).toContain('thinking_delta');
    expect(types).not.toContain('text_delta');
    expect(types).not.toContain('memory_recall');
    expect(run.globals.feedStreamEventToCard).not.toHaveBeenCalled();
  });

  test('full adds the narration a tool call followed, ahead of that call, and no other model text', async () => {
    const { run, broadcasts } = sessionWith('vis-note', 'proactive', 'full');
    await streamThrough(run.output, run.inputId, PROCESS);
    const sent = broadcasts();
    const types = sent.map((e) => e.eventType);
    expect(sent.find((e) => e.eventType === 'commentary')).toMatchObject({
      eventType: 'commentary',
      text: '这是模型的话',
      agentScope: 'main',
    });
    // Written ahead of the call it introduces.
    expect(types.indexOf('commentary')).toBe(
      types.indexOf('tool_use_start') - 1,
    );
    // The model's text itself never goes out, nor to a provider card.
    expect(types).not.toContain('text_delta');
    expect(run.globals.feedStreamEventToCard).not.toHaveBeenCalled();
  });

  test('the text that ends a turn is never narration, at any level', async () => {
    for (const level of ['hidden', 'activity', 'full'] as const) {
      const { run, broadcasts } = sessionWith(
        `vis-end-${level}`,
        'proactive',
        level,
      );
      await streamThrough(run.output, run.inputId, [
        { eventType: 'status', statusText: 'requesting' },
        { eventType: 'text_delta', text: '我决定不回复。' },
        { eventType: 'status', statusText: 'idle' },
      ]);
      const types = broadcasts().map((e) => e.eventType);
      expect(types, level).not.toContain('commentary');
      expect(types, level).not.toContain('text_delta');
    }
  });

  test('an Assistant workspace is unchanged: all of it goes to the Web and the card', async () => {
    const { run, broadcasts } = sessionWith(
      'vis-assistant',
      'assistant',
      'hidden',
    );
    await streamThrough(run.output, run.inputId, PROCESS);
    expect(broadcasts().map((e) => e.eventType)).toEqual(
      PROCESS.map((e) => e.eventType),
    );
    expect(run.globals.feedStreamEventToCard).toHaveBeenCalled();
  });

  test("every turn's process is collected for turn_traces, in the mode's own measure", async () => {
    for (const [mode, level, expectThinking, expectTrace] of [
      ['assistant', 'hidden', true, true],
      ['proactive', 'hidden', false, false],
      ['proactive', 'activity', false, true],
      ['proactive', 'full', true, true],
    ] as const) {
      const { run, traceStore } = sessionWith(
        `trace-${mode}-${level}`,
        mode,
        level,
      );
      await streamThrough(run.output, run.inputId, PROCESS);
      const stored = run.globals.turnTraces.persist({
        chatJid: run.globals.chatJid,
        inputId: run.inputId,
      });
      expect(stored, `${mode}/${level}`).toBe(expectTrace);
      if (expectTrace) {
        expect(traceStore.mock.calls[0][0].thinking !== '').toBe(
          expectThinking,
        );
      } else {
        expect(traceStore).not.toHaveBeenCalled();
      }
    }
  });

  test('sub-agent tasks are checkpointed whatever the Web is shown', async () => {
    for (const [mode, level] of [
      ['assistant', 'hidden'],
      ['proactive', 'hidden'],
      ['proactive', 'full'],
    ] as const) {
      const { run } = sessionWith(`task-${mode}-${level}`, mode, level);
      const upsertSubagentCheckpoint = vi.fn();
      Object.assign(run.globals, {
        runningSubagentTasksByLane: new Map(),
        NON_SUBAGENT_TASK_TYPES: new Set(['local_bash']),
        upsertSubagentCheckpoint,
        nonSubagentTaskIds: new Set<string>(),
        subagentTaskInputMessageId: () => run.inputId,
      });
      run.harness.install('trackSubagentTaskEvent');
      await streamThrough(run.output, run.inputId, [
        {
          eventType: 'task_start',
          toolUseId: 'task-1',
          taskId: 'task-1',
          taskDescription: '审查',
        },
      ]);
      expect(upsertSubagentCheckpoint, `${mode}/${level}`).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: 'task-1',
          chatJid: run.virtualChatJid,
          inputMessageId: run.inputId,
          description: '审查',
        }),
      );
    }
  });

  test('the visibility is read per event, so a change reaches a running turn', async () => {
    const { run, broadcasts } = sessionWith('vis-live', 'proactive', 'hidden');
    let level: Level = 'hidden';
    run.globals.resolveProcessVisibility = () => level;
    await streamThrough(run.output, run.inputId, [
      { eventType: 'tool_use_start', toolName: 'A', toolUseId: 'a' },
    ]);
    level = 'activity';
    await streamThrough(run.output, run.inputId, [
      { eventType: 'tool_use_start', toolName: 'B', toolUseId: 'b' },
    ]);
    expect(broadcasts().map((e) => e.toolName)).toEqual(['B']);
  });

  test('a Runtime Session follows the same projection, addressed to its own session', async () => {
    for (const [mode, level, expected] of [
      ['proactive', 'hidden', ['status', 'context_audit']],
      [
        'proactive',
        'activity',
        [
          'status',
          'thinking_start',
          'thinking_end',
          'tool_use_start',
          'tool_result',
          'tool_use_end',
          'context_audit',
        ],
      ],
      [
        'proactive',
        'full',
        [
          'status',
          'thinking_start',
          'thinking_delta',
          'thinking_end',
          'commentary',
          'tool_use_start',
          'tool_result',
          'tool_use_end',
          'context_audit',
        ],
      ],
      ['assistant', 'hidden', PROCESS.map((e) => e.eventType)],
    ] as const) {
      const run = agentRun(`vis-${mode}-${level}`);
      const card = fakeCard(['om_card_vis']);
      Object.assign(run.globals, {
        interactionMode: mode,
        agentStreamingSession: card,
        projectSdkStreamEventForWeb,
        resolveProcessVisibility: () => (mode === 'proactive' ? level : 'full'),
        commentaryRelay: new ProactiveCommentaryRelay(),
        turnTraces: new TurnTraceTracker({
          mode,
          getVisibility: () => level,
          store: vi.fn(),
        }),
        broadcastStreamEvent: vi.fn(),
      });
      await streamThrough(run.output, run.inputId, PROCESS);
      const calls = (
        run.globals.broadcastStreamEvent as ReturnType<typeof vi.fn>
      ).mock.calls;
      expect(
        calls.map(([, event]) => event.eventType),
        `${mode}/${level}`,
      ).toEqual(expected);
      // every one is addressed to the session, not the workspace conversation
      for (const call of calls) expect(call[2]).toBe(run.globals.agentId);
      // a provider card only ever exists for an Assistant conversation
      expect(
        (run.globals.feedStreamEventToCard as ReturnType<typeof vi.fn>).mock
          .calls.length > 0,
        `${mode}/${level}`,
      ).toBe(mode === 'assistant');
    }
  });

  test("a Runtime Session's trace is announced for the session's own message", () => {
    const session = 'web:proactive-trace-home#agent:s1';
    const globals: Record<string, any> = {
      virtualChatJid: session,
      getLastAgentMessageIdForTurn: db.getLastAgentMessageIdForTurn,
      broadcastMessageTrace: vi.fn(),
      logger: { warn: vi.fn() },
      turnTraces: new TurnTraceTracker({
        mode: 'proactive',
        getVisibility: () => 'full',
      }),
    };
    const harness = createRuntimeSourceHarness(globals);
    harness.install('announceTurnTrace');
    harness.install('persistProactiveTurnTrace', 'processAgentConversation');
    const persist = globals.persistProactiveTurnTrace as (id: string) => void;
    db.ensureChatExists(session);
    db.storeMessageDirect(
      'utterance-s1',
      session,
      'happyclaw-agent',
      'Agent',
      '会话里的一句话',
      '2026-10-12T02:05:00.000Z',
      true,
      { meta: { turnId: 'turn-s1', sourceKind: 'sdk_send_message' } },
    );
    globals.turnTraces.observe('turn-s1', {
      eventType: 'tool_use_start',
      toolName: 'Bash',
      toolUseId: 'tool-s1',
    });
    persist('turn-s1');
    expect(globals.broadcastMessageTrace).toHaveBeenCalledWith(
      session,
      'utterance-s1',
      'turn-s1',
    );

    // no message, no announcement
    globals.turnTraces.observe('turn-s2', {
      eventType: 'tool_use_start',
      toolName: 'Bash',
      toolUseId: 'tool-s2',
    });
    persist('turn-s2');
    expect(globals.broadcastMessageTrace).toHaveBeenCalledTimes(1);
  });

  test('a failing announcement does not keep the turn from settling', () => {
    const session = 'web:proactive-trace-home#agent:s3';
    const globals: Record<string, any> = {
      virtualChatJid: session,
      getLastAgentMessageIdForTurn: db.getLastAgentMessageIdForTurn,
      broadcastMessageTrace: vi.fn(() => {
        throw new Error('socket gone');
      }),
      logger: { warn: vi.fn() },
      turnTraces: new TurnTraceTracker({
        mode: 'proactive',
        getVisibility: () => 'full',
      }),
    };
    const harness = createRuntimeSourceHarness(globals);
    harness.install('announceTurnTrace');
    harness.install('persistProactiveTurnTrace', 'processAgentConversation');
    db.ensureChatExists(session);
    db.storeMessageDirect(
      'utterance-s3',
      session,
      'happyclaw-agent',
      'Agent',
      '一句话',
      '2026-10-12T02:10:00.000Z',
      true,
      { meta: { turnId: 'turn-s3', sourceKind: 'sdk_send_message' } },
    );
    globals.turnTraces.observe('turn-s3', {
      eventType: 'tool_use_start',
      toolName: 'Bash',
      toolUseId: 'tool-s3',
    });
    expect(() => globals.persistProactiveTurnTrace('turn-s3')).not.toThrow();
    // The trace is stored all the same, and the failure is only logged.
    expect(db.getTurnTrace(session, 'turn-s3')).toBeDefined();
    expect(globals.logger.warn).toHaveBeenCalledTimes(1);
  });
});

describe('every Web stream frame names the input it answers (behavioural)', () => {
  // The final row's `turn_id` is the input a turn answers. A warm turn's
  // presentation `turnId` is the Runner's own, so the Web pairs its live card
  // with the final by `inputTurnId`, which must be that same input.
  type Broadcast = [string, Record<string, any>, string?];
  const sent = (globals: Record<string, any>) =>
    (globals.broadcastStreamEvent as ReturnType<typeof vi.fn>).mock
      .calls as Broadcast[];
  const frame = (inputTurnId: string | undefined, turnId: string) => ({
    status: 'stream',
    result: null,
    ...(inputTurnId ? { inputTurnId } : {}),
    streamEvent: { eventType: 'text_delta', text: '答案', turnId },
  });

  function session(name: string) {
    const { run } = sessionWith(name, 'assistant', 'hidden');
    Object.assign(run.globals, {
      resolveContainerOutputInputTurnId,
      rejectedAgentInputTurns: new Set<string>(),
    });
    run.harness.install('agentScopeForOutput', 'processAgentConversation');
    // Where the final row takes its `turn_id` from.
    const finalTurnId = (output: Record<string, unknown>) =>
      run.globals.agentScopeForOutput({ ...output, status: 'success' })
        .inputId as string;
    return { run, finalTurnId };
  }

  // `host` stands for the input the host gave the Runner (`lastProcessed`).
  test.each([
    {
      name: 'cold',
      label:
        'a cold start: the host input, which is also the presentation turn',
      input: 'host',
      turn: 'host',
    },
    {
      name: 'warm',
      label: "a warm turn: the delivery it answers, not the Runner's own turn",
      input: 'delivery-warm',
      turn: 'presentation-warm',
    },
    {
      name: 'legacy',
      label: 'an older Runner without an input id: the host input it was given',
      input: undefined,
      turn: 'presentation-legacy',
    },
  ])('$label', async ({ name, input, turn }) => {
    const { run, finalTurnId } = session(`input-${name}`);
    const host = (id: string | undefined) => (id === 'host' ? run.inputId : id);
    const output = frame(host(input), host(turn)!);
    await run.output(output);
    const [[, event]] = sent(run.globals);
    // The presentation turn is left as it is; the input is added beside it.
    expect(event.turnId).toBe(host(turn));
    expect(event.inputTurnId).toBe(host(input) ?? run.inputId);
    expect(event.inputTurnId).toBe(finalTurnId(output));
  });

  test("a proactive turn's narration names its input too", async () => {
    const { run } = sessionWith('input-note', 'proactive', 'full');
    for (const streamEvent of [
      { eventType: 'status', statusText: 'requesting', turnId: 'p-note' },
      { eventType: 'text_delta', text: '先看目录', turnId: 'p-note' },
      {
        eventType: 'tool_use_start',
        toolName: 'Bash',
        toolUseId: 'tool-note',
        turnId: 'p-note',
      },
    ]) {
      await run.output({
        status: 'stream',
        result: null,
        inputTurnId: 'delivery-note',
        streamEvent,
      });
    }
    const events = sent(run.globals).map(([, event]) => event);
    expect(events.map((e) => e.eventType)).toEqual([
      'status',
      'commentary',
      'tool_use_start',
    ]);
    for (const event of events) {
      expect(event.inputTurnId, event.eventType).toBe('delivery-note');
    }
  });

  test('a Runtime Session: the delivery it answers, addressed to the session', async () => {
    for (const [name, inputTurnId, turnId] of [
      ['session-cold', undefined, undefined],
      ['session-warm', 'delivery-session', 'presentation-session'],
    ] as const) {
      const run = agentRun(`input-${name}`);
      Object.assign(run.globals, {
        projectSdkStreamEventForWeb,
        resolveContainerOutputInputTurnId,
        rejectedAgentInputTurns: new Set<string>(),
        broadcastStreamEvent: vi.fn(),
      });
      run.harness.install('agentScopeForOutput', 'processAgentConversation');
      const output = frame(inputTurnId, turnId ?? run.inputId);
      await run.output(output);
      const [[, event, agentId]] = sent(run.globals);
      expect(agentId, name).toBe(run.globals.agentId);
      expect(event.inputTurnId, name).toBe(inputTurnId ?? run.inputId);
      expect(event.inputTurnId, name).toBe(
        run.globals.agentScopeForOutput({ ...output, status: 'success' })
          .inputId,
      );
    }
  });
});
