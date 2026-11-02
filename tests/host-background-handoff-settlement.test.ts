/**
 * The real hand-off settlement of `processAgentConversation` against the real
 * SQLite store; only providers and the runner are fake.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import { backgroundHandoffRefusal } from '../src/background-handoff-policy.js';
import { buildSubagentCheckpointContext } from '../src/subagent-checkpoint.js';
import { hasUnfinishedProactiveOutput } from '../src/turn-outcome.js';
import { publishesFrameworkAnswer } from '../src/workspace-interaction-runtime.js';
import { createRuntimeSourceHarness } from './helpers/runtime-source.js';

const paths = vi.hoisted(() => ({ root: '' }));
vi.mock('../src/config.js', async (importOriginal) => {
  const nodeFs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  paths.root = nodeFs.mkdtempSync(path.join(os.tmpdir(), 'bg-handoff-'));
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
const { finalizeChannelCardAfterDelivery } =
  await import('../src/channel-card-finalization.js');

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

function fakeCard() {
  return {
    isActive: () => true,
    abort: vi.fn(async (_reason?: string) => {}),
    complete: vi.fn(async (_text: string) => {}),
    dispose: vi.fn(),
  };
}

/** A session held on input A, with later input B already started. */
function heldRun(name: string, interactionMode = 'assistant') {
  const inputId = `om_${name}_${crypto.randomBytes(4).toString('hex')}`;
  const nextId = `om_next_${name}_${crypto.randomBytes(4).toString('hex')}`;
  const virtualChatJid = `web:ws-${name}#agent:session-${name}`;
  const folder = `ws-${name}`;
  const replySourceImJid = `feishu:oc_${name}#account:bot`;
  const runtime = ChannelTurnRuntime.start({
    provider: 'feishu',
    accountId: 'bot',
    sourceJid: replySourceImJid,
    chatId: `oc_${name}`,
    externalMessageId: inputId,
    agentId: `session-${name}`,
  });
  const advanceCursors = vi.fn();
  const heldMsgId = `held-${name}`;
  db.ensureChatExists(virtualChatJid);
  db.storeMessageDirect(
    heldMsgId,
    virtualChatJid,
    'happyclaw-agent',
    'Assistant',
    'A_ANSWERED\n\n> ⏳ 1 个后台任务运行中，完成后将继续汇总',
    '2026-11-01T00:00:00.000Z',
    true,
  );
  const sendImWithRetry = vi.fn(async () => true);
  const globals: Record<string, any> = {
    crypto,
    logger,
    ASSISTANT_NAME: 'Assistant',
    HELD_TURN_DIVIDER: '\n\n',
    lastProcessed: { id: inputId, timestamp: '2026-11-01T00:00:00.000Z' },
    activeAgentInputTurnId: nextId,
    missedMessages: [{ id: inputId }],
    chatJid: `web:ws-${name}`,
    virtualChatJid,
    virtualJid: virtualChatJid,
    agentId: `session-${name}`,
    replySourceImJid,
    agentStreamingSession: undefined,
    activeAgentDurableCardLifecycle: undefined,
    agentStreamingSessionsByInput: new Map(),
    agentChannelTurnRuntimes: new Map([[inputId, runtime]]),
    agentChannelOutboxScopesByInput: new Map(),
    agentPhysicalDeliveryAckByInput: new Map([[inputId, false]]),
    agentNonTerminalDeliveryAckByInput: new Map([[inputId, false]]),
    agentGenuineReplyDeliveredByInput: new Map([[inputId, false]]),
    cursorCommittedInputTurns: new Set<string>(),
    agentStreamingAccText: 'stale',
    heldAgentParts: ['A_ANSWERED'],
    heldAgentDbMsgId: heldMsgId,
    heldAgentDbTurnId: inputId,
    interactionMode,
    effectiveGroup: { folder },
    currentAgentSessionId: 'sdk-session',
    agentInputUsageProjection: {
      snapshot: () => undefined,
    },
    agentDeliveryNeedsManualReconciliation: false,
    agentDefinitiveFailureSettled: false,
    agentTurnOutputCoordinators: new Map(),
    queue: { finishBackgroundHold: vi.fn() },
    finalizeChannelCardAfterDelivery,
    publishesFrameworkAnswer,
    hasUnfinishedProactiveOutput,
    backgroundHandoffRefusal,
    classifyImSendFailure: (error: any) =>
      error?.uncertain ? 'uncertain' : 'definitive',
    feishuCardStaticFallbackText: () => undefined,
    persistUncertainStreamingDelivery: vi.fn(async () => ({
      status: 'uncertain',
    })),
    sendImWithRetry,
    channelTurnScope: (f: string, a: string) => `${f}#${a}`,
    unregisterStreamingSession: vi.fn(),
    reassignSubagentCheckpoints: db.reassignSubagentCheckpoints,
    storeMessageDirect: db.storeMessageDirect,
    updateLatestMessageTokenUsage: vi.fn(),
    broadcastNewMessage: vi.fn(),
    advanceCursors,
    flushAcknowledgedIpcForJid: vi.fn(),
    clearAgentProcessingIndicatorForInput: vi.fn(async () => {}),
    keepProactiveProgress: vi.fn(),
    markAgentOutputSettled: vi.fn(),
    finalizeProactiveAgentOutputCoordinators: vi.fn(),
    persistProactiveTurnTrace: vi.fn(),
    getUncertainChannelOutboxForTurn: store.getUncertainChannelOutboxForTurn,
    getFailedChannelOutboxForTurn: store.getFailedChannelOutboxForTurn,
    resolveContainerOutputInputTurnId: (output: any, fallback: string) =>
      output.inputTurnId ?? fallback,
  };
  const harness = createRuntimeSourceHarness(globals);
  for (const fn of [
    'isCursorCommitted',
    'commitCursor',
    'finalizeHeldAgentDbMessage',
    'completeAgentChannelRuntimesForOutput',
    'settleAgentBackgroundHandoff',
  ]) {
    harness.install(fn, 'processAgentConversation');
  }
  const handoff = {
    status: 'success',
    result: null,
    inputTurnId: inputId,
    inputTurnCompleted: true,
    backgroundHandoff: true,
    pendingBgTasks: 1,
    activeIpcReceipts: [{ deliveryId: 'delivery-b', cursor: { id: nextId } }],
  };
  return {
    globals,
    runtime,
    inputId,
    nextId,
    heldMsgId,
    folder,
    virtualChatJid,
    advanceCursors,
    sendImWithRetry,
    settle: (output: any = handoff) =>
      globals.settleAgentBackgroundHandoff(output),
  };
}

function storedText(jid: string, id: string): string | undefined {
  return db
    .getMessagesForTurn(jid, id)
    .concat(db.getMessagesPage(jid, undefined, 50) as any)
    .find((message: any) => message.id === id)?.content;
}

describe('settling a background hand-off', () => {
  test('finalizes the held card and message, then commits the cursor', async () => {
    const run = heldRun('card');
    const card = fakeCard();
    run.globals.agentStreamingSessionsByInput.set(run.inputId, {
      session: card,
      jid: 'card-jid',
    });
    run.globals.agentStreamingSession = card;

    await run.settle();

    expect(run.globals.queue.finishBackgroundHold).toHaveBeenCalledWith(
      run.virtualChatJid,
      run.inputId,
    );
    expect(card.complete).toHaveBeenCalledWith('A_ANSWERED');
    expect(store.getChannelTurnRun(run.runtime.runId)?.status).toBe(
      'completed',
    );
    expect(run.advanceCursors).toHaveBeenCalledTimes(1);
    expect(run.globals.agentStreamingSession).toBeUndefined();
    expect(run.globals.heldAgentParts).toEqual([]);
    // The stale "will summarize" notice is replaced, no longer promising it here.
    const text = storedText(run.virtualChatJid, run.heldMsgId);
    expect(text).toContain('后台任务已转交给下一条消息');
    expect(text).not.toContain('⏳');
  });

  test("the held input's sub-agents replay with the later input after a restart", async () => {
    const run = heldRun('checkpoint');
    run.globals.agentNonTerminalDeliveryAckByInput.set(run.inputId, true);
    const base = {
      groupFolder: run.folder,
      chatJid: run.virtualChatJid,
      inputMessageId: run.inputId,
    };
    db.upsertSubagentCheckpoint({
      ...base,
      taskId: 'toolu_running',
      description: 'deploy to staging',
    });
    db.upsertSubagentCheckpoint({
      ...base,
      taskId: 'toolu_done',
      description: 'read the logs',
      status: 'completed',
      resultText: 'logs are clean',
    });

    await run.settle();

    expect(run.advanceCursors).toHaveBeenCalledTimes(1);
    expect(
      db.listSubagentCheckpointsForInputs(run.folder, run.virtualChatJid, [
        run.inputId,
      ]),
    ).toEqual([]);
    // What a replay of the later input reads back.
    const context = buildSubagentCheckpointContext(
      db.listSubagentCheckpointsForInputs(run.folder, run.virtualChatJid, [
        run.nextId,
      ]),
    );
    expect(context).toMatchObject({ completed: 1, unfinished: 1 });
    expect(context?.context).toContain('logs are clean');
    expect(context?.context).toContain('deploy to staging');
    // A task's later terminal keeps pointing at the input that replays it.
    db.upsertSubagentCheckpoint({
      ...base,
      taskId: 'toolu_running',
      status: 'completed',
    });
    expect(
      db.listSubagentCheckpointsForInputs(run.folder, run.virtualChatJid, [
        run.nextId,
      ]),
    ).toHaveLength(2);
  });

  test('without a later input to replay with, the cursor stays behind', async () => {
    const run = heldRun('no-next');
    run.globals.agentNonTerminalDeliveryAckByInput.set(run.inputId, true);
    db.upsertSubagentCheckpoint({
      groupFolder: run.folder,
      chatJid: run.virtualChatJid,
      inputMessageId: run.inputId,
      taskId: 'toolu_kept',
    });

    await run.settle({
      status: 'success',
      inputTurnId: run.inputId,
      inputTurnCompleted: true,
      backgroundHandoff: true,
    });

    expect(run.advanceCursors).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
    expect(
      db.listSubagentCheckpointsForInputs(run.folder, run.virtualChatJid, [
        run.inputId,
      ]),
    ).toHaveLength(1);
  });

  test('an uncertain card final is fenced, not resent or reported delivered', async () => {
    const run = heldRun('uncertain');
    const shared = fakeCard();
    const card = fakeCard();
    const error = Object.assign(new Error('ack lost'), { uncertain: true });
    card.complete.mockRejectedValueOnce(error);
    run.globals.agentStreamingSessionsByInput.set(run.inputId, {
      session: card,
      jid: 'card-jid',
    });
    run.globals.agentStreamingSession = shared;
    run.globals.agentChannelOutboxScopesByInput.set(run.inputId, {
      token: 'token',
      sourceJid: run.globals.replySourceImJid,
    });

    await expect(run.settle()).rejects.toThrow('host_turn_settlement_failed');

    expect(run.globals.persistUncertainStreamingDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ error }),
    );
    expect(run.sendImWithRetry).not.toHaveBeenCalled();
    expect(run.globals.agentGenuineReplyDeliveredByInput.get(run.inputId)).toBe(
      false,
    );
    expect(run.advanceCursors).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
    expect(shared.complete).not.toHaveBeenCalled();
  });

  test('a card final refused outright falls back to exact static delivery', async () => {
    const run = heldRun('refused');
    const card = fakeCard();
    card.complete.mockRejectedValueOnce(new Error('card refused'));
    run.globals.agentStreamingSessionsByInput.set(run.inputId, {
      session: card,
      jid: 'card-jid',
    });
    run.globals.agentChannelOutboxScopesByInput.set(run.inputId, {
      token: 'token',
      sourceJid: run.globals.replySourceImJid,
    });

    await run.settle();

    expect(run.sendImWithRetry).toHaveBeenCalledWith(
      run.globals.replySourceImJid,
      'A_ANSWERED',
      [],
      expect.objectContaining({ scopeToken: 'token' }),
    );
    expect(run.advanceCursors).toHaveBeenCalledTimes(1);
  });

  test('a card that exists for no input is never borrowed from the shared slot', async () => {
    const run = heldRun('shared');
    const shared = fakeCard();
    run.globals.agentStreamingSession = shared;
    run.globals.agentNonTerminalDeliveryAckByInput.set(run.inputId, true);

    await run.settle();

    expect(shared.complete).not.toHaveBeenCalled();
    expect(run.globals.agentStreamingSession).toBe(shared);
  });

  test('proactive progress is never acknowledged as the final reply', async () => {
    const run = heldRun('proactive', 'proactive');
    run.globals.heldAgentParts = [];
    run.globals.agentNonTerminalDeliveryAckByInput.set(run.inputId, true);

    await expect(run.settle()).rejects.toThrow('host_turn_settlement_failed');

    expect(run.globals.agentPhysicalDeliveryAckByInput.get(run.inputId)).toBe(
      false,
    );
    expect(run.globals.agentGenuineReplyDeliveredByInput.get(run.inputId)).toBe(
      false,
    );
    expect(run.advanceCursors).not.toHaveBeenCalled();
  });
});

describe('whether the queue head may take over', () => {
  /** A held Web or IM input with one owner, gated on real input rows. */
  function gate(heldRoute: string | null, heldMessage: Record<string, any>) {
    const ownerUserId = 'user-owner';
    const held = { id: 'held', sender: ownerUserId, ...heldMessage };
    const globals: Record<string, any> = {
      teamRole: null,
      agent: { kind: 'conversation' },
      effectiveGroup: { folder: 'ws', created_by: ownerUserId },
      interactionMode: 'assistant',
      lastProcessed: { id: 'held' },
      initialAgentReplySourceImJid: heldRoute,
      admittedWarmAgentInputs: new Map(),
      agentInputMessagesByTurn: new Map([['held', [held]]]),
      agentPhysicalDeliveryAckByInput: new Map(),
      agentNonTerminalDeliveryAckByInput: new Map([['held', true]]),
      agentStreamingSessionsByInput: new Map(),
      heldAgentParts: ['A_ANSWERED'],
      registeredGroups: {},
      getRegisteredGroup: () => undefined,
      getJidsByFolder: () => [],
      getChannelType: () => null,
      workspaceOwnerImIds: () => [],
      isOwnerProfileOwnerInput: (message: any, owner: string) =>
        message.sender === owner,
      publishesFrameworkAnswer,
      hasUnfinishedProactiveOutput,
      backgroundHandoffRefusal,
      // The real batch routing is covered by its own tests.
      resolveBatchChannelReplySource: (next: any[]) =>
        next[0].source_jid?.startsWith('web:') ? null : next[0].source_jid,
    };
    const harness = createRuntimeSourceHarness(globals);
    harness.install('isUnattendedInput');
    for (const fn of [
      'heldAgentReplySettleable',
      'inputsAreOwnersAlone',
      'agentBackgroundHandoffRefusal',
    ]) {
      harness.install(fn, 'processAgentConversation');
    }
    return {
      globals,
      refusal: (next: Record<string, any>) =>
        globals.agentBackgroundHandoffRefusal('held', [
          { id: 'next', sender: ownerUserId, ...next },
        ]),
    };
  }
  const web = { source_jid: 'web:ws' };
  const feishu = { source_jid: 'feishu:oc_a#account:bot' };

  test('the same person on the same route takes over', () => {
    expect(gate(null, web).refusal(web)).toBeNull();
    expect(gate(feishu.source_jid, feishu).refusal(feishu)).toBeNull();
  });

  test('a summary owed to Feishu never moves to a Web input', () => {
    expect(gate(feishu.source_jid, feishu).refusal(web)).toBe(
      'different_route',
    );
  });

  test('an automation input neither hands over nor takes over', () => {
    const automation = { ...web, automation_run_id: 'run-1' };
    expect(gate(null, automation).refusal(web)).toBe('held_unattended');
    expect(gate(null, web).refusal(automation)).toBe('next_unattended');
  });

  test('a work-item input neither hands over nor takes over', () => {
    const workItem = { ...web, source_kind: 'work_item_input' };
    expect(gate(null, workItem).refusal(web)).toBe('held_unattended');
    expect(gate(null, web).refusal(workItem)).toBe('next_unattended');
  });

  test("a member's held input is not taken over by the owner", () => {
    expect(gate(null, { ...web, sender: 'member' }).refusal(web)).toBe(
      'different_authority',
    );
  });

  test('an IM input with no delivered reply keeps the queue waiting', () => {
    const run = gate(feishu.source_jid, feishu);
    run.globals.agentNonTerminalDeliveryAckByInput.set('held', false);
    expect(run.refusal(feishu)).toBe('held_reply_not_delivered');
  });

  test('proactive progress without a final keeps the queue waiting', () => {
    const run = gate(feishu.source_jid, feishu);
    run.globals.interactionMode = 'proactive';
    expect(run.refusal(feishu)).toBe('held_reply_not_delivered');
  });
});

describe('steering while only background tasks hold the lane', () => {
  function steerLane(options: { awaitingNext: boolean; gate: boolean }) {
    const item = { id: 'next', chat_jid: 'web:ws#agent:s1' };
    const gateFn = vi.fn(() => options.gate);
    const queue = {
      hasBackgroundHold: vi.fn(() => true),
      backgroundHoldAwaitingNext: vi.fn(() =>
        options.awaitingNext ? 'held' : null,
      ),
      reserveNextQuery: vi.fn(() => null),
      reserveBackgroundHandoffQuery: vi.fn(() => null),
      getActiveQueryId: vi.fn(() => 'run-a'),
      interruptQuery: vi.fn(() => true),
    };
    const globals: Record<string, any> = {
      queue,
      activeBackgroundHandoffGates: new Map([[item.chat_jid, gateFn]]),
      getQueuedFollowUp: () => item,
      peekNextQueuedFollowUpBatch: () => [item],
      listQueuedAutomationFollowUps: () => [],
      withdrawQueuedInputsOutsideAudience: vi.fn(),
      withdrawQueuedInputsOfEndedRuns: vi.fn(),
      broadcastFollowUpUpdate: vi.fn(),
      markSteeringInterrupt: vi.fn(),
      clearSteeringInterrupt: vi.fn(),
      clearTrackedProcessingIndicators: vi.fn(async () => {}),
      dispatchQueuedFollowUpFamily: vi.fn(),
    };
    const harness = createRuntimeSourceHarness(globals);
    for (const fn of [
      'canHandOffBackgroundWork',
      'deliverWithoutInterruptingBackgroundWork',
      'dispatchNextQueuedFollowUp',
      'steerQueuedFollowUpBatch',
    ]) {
      harness.install(fn);
    }
    return { globals, queue, item };
  }

  test('a head that may take over goes through without an interrupt', () => {
    const { globals, queue, item } = steerLane({
      awaitingNext: true,
      gate: true,
    });
    const result = globals.steerQueuedFollowUpBatch(item.chat_jid, item.id);
    expect(result).toMatchObject({ ok: true, state: 'queued' });
    expect(queue.interruptQuery).not.toHaveBeenCalled();
    expect(queue.reserveBackgroundHandoffQuery).toHaveBeenCalledWith(
      item.chat_jid,
    );
  });

  test('while another input is taking over, the steer waits instead of stopping it', () => {
    const { globals, queue, item } = steerLane({
      awaitingNext: false,
      gate: true,
    });
    const result = globals.steerQueuedFollowUpBatch(item.chat_jid, item.id);
    expect(result).toMatchObject({ ok: true, state: 'queued' });
    expect(queue.interruptQuery).not.toHaveBeenCalled();
  });

  test('a head that may not take over keeps the ordinary steer', () => {
    const { globals, queue, item } = steerLane({
      awaitingNext: true,
      gate: false,
    });
    const result = globals.steerQueuedFollowUpBatch(item.chat_jid, item.id);
    expect(result).toMatchObject({ ok: true, state: 'interrupting' });
    expect(queue.interruptQuery).toHaveBeenCalledWith(item.chat_jid, 'run-a');
  });
});
