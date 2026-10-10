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
const { streamingCardSnapshotText } =
  await import('../src/feishu-streaming-card.js');

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
    TRUNCATION_EXHAUSTED_STATUS: '__truncation_exhausted__',
    agentTurnOutputCoordinators: new Map(),
    bindAgentTurnOutputCoordinator: () => ({
      reduceStreamEvent: () => ({ visibleAnswerChanged: false }),
    }),
    registeredGroups: {},
    writeUsageRecords: vi.fn(),
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

/** Persist the state a crashed process leaves: message, running Turn, card. */
function leftover(
  name: string,
  options: { recalled?: boolean; stoppedCard?: boolean },
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
  if (options.stoppedCard) {
    const lifecycle = runtime.reserveStreamingCard()!;
    lifecycle.onEvent({
      status: 'creating',
      version: 1,
      snapshot: { text: '', thinking: '', state: 'creating' },
    } as never);
    lifecycle.onEvent({
      status: 'aborted',
      version: 3,
      snapshot: { text: '\n\n---\n*已停止*', thinking: '', state: 'aborted' },
    } as never);
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
  // The process dies: heartbeats stop, the lease is left behind.
  runtime.dispose();
  const committed = db.getMessageCursor(logicalJid, `om_before_${name}`)!;
  return { inputId, logicalJid, runtime, committed };
}

function startupRepairLane() {
  const cursors: Record<string, any> = {};
  const advanceCursors = vi.fn((jid: string, cursor: any) => {
    cursors[jid] = cursor;
  });
  const globals: Record<string, unknown> = {
    logger,
    listNonterminalChannelTurnRuns: store.listNonterminalChannelTurnRuns,
    cancelChannelTurnRunById: store.cancelChannelTurnRunById,
    getPrimaryStreamingCardForTurn: store.getPrimaryStreamingCardForTurn,
    getChannelInboxByExternalMessage: store.getChannelInboxByExternalMessage,
    getUncertainChannelOutboxForTurn: store.getUncertainChannelOutboxForTurn,
    getDeliveredChannelOutboxForTurn: store.getDeliveredChannelOutboxForTurn,
    listInboundMessagesById: db.listInboundMessagesById,
    cancelPendingInboundMessage: db.cancelPendingInboundMessage,
    getMessageCursor: db.getMessageCursor,
    channelConversationJid,
    parseChannelAddress,
    streamingCardSnapshotText,
    advanceCursors,
  };
  const harness = createRuntimeSourceHarness(globals);
  harness.install('EXPLICIT_STOP_CARD_MARKER');
  harness.install('repairWithdrawnChannelTurnsOnStartup');
  return {
    cursors,
    repair: globals.repairWithdrawnChannelTurnsOnStartup as () => number,
  };
}

describe('startup repair: a withdrawn input is never re-run after a restart', () => {
  test('the prod shape: running Turn, card aborted with "已停止", cursor before the input', () => {
    const left = leftover('prod', { stoppedCard: true });
    // Without repair, recovery would replay the input from the old cursor.
    expect(
      db.getMessagesSince(left.logicalJid, left.committed).map((m) => m.id),
    ).toEqual([left.inputId]);
    const lane = startupRepairLane();
    expect(lane.repair()).toBeGreaterThanOrEqual(1);
    expect(store.getChannelTurnRun(left.runtime.runId)).toMatchObject({
      status: 'cancelled',
      error: 'Startup repair: input consumed by an explicit stop',
    });
    const advanced = lane.cursors[left.logicalJid];
    expect(advanced?.id).toBe(left.inputId);
    expect(db.getMessagesSince(left.logicalJid, advanced)).toEqual([]);
  });

  test('a recalled input: Turn cancelled and the message excluded from replay', () => {
    const left = leftover('recalled', { recalled: true });
    const lane = startupRepairLane();
    lane.repair();
    expect(store.getChannelTurnRun(left.runtime.runId)).toMatchObject({
      status: 'cancelled',
      error: 'Startup repair: input recalled by sender',
    });
    expect(
      db.getMessagesSince(left.logicalJid, left.committed).map((m) => m.id),
    ).toEqual([]);
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
    const repairAt = main.indexOf('  repairWithdrawnChannelTurnsOnStartup();');
    expect(repairAt).toBeGreaterThan(0);
    expect(repairAt).toBeLessThan(
      main.indexOf('await reconcileChannelReliabilityOnStartup(imManager);'),
    );
    expect(repairAt).toBeLessThan(main.indexOf('  recoverPendingMessages();'));
  });
});
