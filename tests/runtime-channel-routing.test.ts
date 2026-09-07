import crypto from 'node:crypto';
import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import * as replyDelivery from '../src/reply-delivery.js';
import * as interactionRuntime from '../src/workspace-interaction-runtime.js';
import * as replySource from '../src/channel-reply-source.js';
import { resolveContainerOutputInputTurnId } from '../src/channel-output-correlation.js';
import { stripRedundantCompletionPreamble } from '../src/reply-finalization.js';
import { TurnOutputCoordinator } from '../src/turn-output-coordinator.js';
import { getChannelType } from '../src/im-channel.js';
import { channelTurnScope } from '../src/channel-turn-registry.js';
import { createRuntimeSourceHarness } from './helpers/runtime-source.js';
import type { NewMessage, MessageCursor } from '../src/types.js';

const paths = vi.hoisted(() => ({ root: '' }));
vi.mock('../src/config.js', async (importOriginal) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  paths.root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'runtime-channel-routing-'),
  );
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
const delivery = await import('../src/channel-outbox-delivery.js');
const recovery = await import('../src/channel-reliability-recovery.js');
const { ChannelTurnRuntime } = await import('../src/channel-turn-runtime.js');
const { settleChannelTurnOutput } =
  await import('../src/channel-turn-settlement.js');
const { GroupQueue } = await import('../src/group-queue.js');
const { stripAgentInternalTags } = await import('../src/utils.js');
const EMPTY_CURSOR: MessageCursor = { timestamp: '', id: '' };
const OLD_IM = 'feishu:previous';

beforeAll(() => db.initDatabase());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(paths.root, { recursive: true, force: true });
});

function makeOutputRuntime(lane: 'main' | 'session') {
  const chatJid = `web:routing-${crypto.randomUUID()}`;
  const virtualChatJid = lane === 'main' ? chatJid : `${chatJid}#agent:session`;
  const inputId = 'warm-web-input';
  const scopeByInput = new Map();
  const admissions = new Map([[inputId, { imJid: null }]]);
  const coordinators = new Map([[inputId, new TurnOutputCoordinator()]]);
  const sendImWithRetry = vi.fn(async () => true);
  const broadcastNewMessage = vi.fn();
  const commitCursor = vi.fn();
  const globals: Record<string, any> = {
    ...replyDelivery,
    ...interactionRuntime,
    ...replySource,
    crypto,
    getChannelType,
    channelTurnScope,
    resolveContainerOutputInputTurnId,
    stripAgentInternalTags,
    stripRedundantCompletionPreamble,
    chatJid,
    virtualChatJid,
    virtualJid: virtualChatJid,
    agentId: 'session',
    agent: { kind: 'conversation' },
    group: { name: 'Routing fixture' },
    effectiveGroup: { folder: 'routing-fixture' },
    ASSISTANT_NAME: 'Assistant',
    lastProcessed: { id: 'initial-im-input' },
    initialReplySourceImJid: OLD_IM,
    initialAgentReplySourceImJid: OLD_IM,
    replySourceImJid: OLD_IM,
    interactionMode: 'assistant',
    directImReply: false,
    activeSessionId: 'sdk-session',
    currentAgentSessionId: 'sdk-session',
    activeAgentInputTurnId: inputId,
    admittedWarmMainInputs: admissions,
    admittedWarmAgentInputs: admissions,
    channelOutboxScopesByInput: scopeByInput,
    agentChannelOutboxScopesByInput: scopeByInput,
    rejectedChannelInputTurns: new Set(),
    rejectedAgentInputTurns: new Set(),
    healthyCompletedInputTurns: new Set(),
    healthyAgentCompletedInputTurns: new Set(),
    proactiveTailNoticesDelivered: new Set(),
    proactiveAgentTailNoticesDelivered: new Set(),
    channelStreamingSessionsByInput: new Map(),
    agentStreamingSessionsByInput: new Map(),
    sentReplyByInput: new Map(),
    genuineReplyDeliveredByInput: new Map(),
    channelPhysicalDeliveryAckByInput: new Map(),
    agentReplySentByInput: new Map(),
    agentAnyReplyProjectedByInput: new Map(),
    agentGenuineReplyDeliveredByInput: new Map(),
    agentPhysicalDeliveryAckByInput: new Map(),
    turnOutputCoordinators: coordinators,
    agentTurnOutputCoordinators: coordinators,
    scheduledGroupRunsByInput: new Map(),
    heldCardParts: [],
    heldAgentParts: [],
    heldDbTurnId: null,
    heldAgentDbTurnId: null,
    heldAgentDbMsgId: null,
    heldUsagePatchTarget: null,
    heldAgentUsagePatchPending: false,
    heldCardBaseText: () => '',
    heldAgentBaseText: () => '',
    activeWorkflowRuns: [],
    completedWorkflowRuns: [],
    activeAgentWorkflowRuns: [],
    completedAgentWorkflowRuns: [],
    streamingSession: undefined,
    streamingSessionJid: OLD_IM,
    agentStreamingSession: undefined,
    streamingAccumulatedText: '',
    streamingAccumulatedThinking: '',
    agentStreamingAccText: '',
    activeDurableCardLifecycle: undefined,
    activeAgentDurableCardLifecycle: undefined,
    lastReplyMsgId: undefined,
    lastAgentReplyMsgId: undefined,
    lastAgentReplyText: undefined,
    sentReply: false,
    runEnded: false,
    hadError: false,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    steeringTransitions: { shouldSuppressOutput: () => false },
    rememberScheduledGroupRuns: vi.fn(),
    queue: { markRunnerActivity: vi.fn() },
    bindRunnerActiveIpcCoverage: vi.fn(),
    isProviderQuotaControlOutput: () => false,
    rotateProviderAfterAgentTurn: false,
    rotatingAgentTurnCompleted: false,
    closeRunnerAfterRotatingProviderTurn: () => false,
    getAgent: () => ({ title_source: 'manual' }),
    extractLocalImImagePaths: () => [],
    ensureChatExists: db.ensureChatExists,
    storeMessageDirect: db.storeMessageDirect,
    sendImWithRetry,
    resolveDurableChannelRoute: vi.fn((sourceJid: string) => ({
      provider: 'feishu',
      accountId: 'bot',
      chatId: 'previous',
      sourceJid,
    })),
    deliverIndependentChannelSystemNotice: vi.fn(async () => true),
    broadcastNewMessage,
    broadcastToWebClients: vi.fn(),
    clearStreamingSnapshot: vi.fn(),
    resetIdleTimer: vi.fn(),
    completeChannelRuntimesForOutput: async () => true,
    completeAgentChannelRuntimesForOutput: async () => true,
    commitCursor,
  };
  const harness = createRuntimeSourceHarness(globals);
  harness.install('sendMessageWithOutcome');
  harness.install('sendSystemMessage');
  harness.install('deliverProactiveTailInterruptionNotice');
  harness.install('notifyProactiveTailInterruption', 'processGroupMessages');
  harness.install(
    'notifyProactiveAgentTailInterruption',
    'processAgentConversation',
  );
  harness.install('channelScopeForOutput', 'processGroupMessages');
  harness.install('agentScopeForOutput', 'processAgentConversation');
  harness.install('activateMainProjectionForInput', 'processGroupMessages');
  harness.install(
    'activateAgentProjectionForInput',
    'processAgentConversation',
  );
  harness.install('handleAgentOutput', 'processAgentConversation');
  harness.installMainOutput();
  const emit = globals[
    lane === 'main' ? 'handleMainOutput' : 'handleAgentOutput'
  ] as (output: Record<string, unknown>) => Promise<void>;
  return {
    globals,
    inputId,
    virtualChatJid,
    commitCursor,
    sendImWithRetry,
    broadcastNewMessage,
    emit,
  };
}

function finalOutput(
  inputTurnId: string,
  text = 'Answer to the Web follow-up.',
) {
  return {
    status: 'success',
    result: text,
    sourceKind: 'sdk_final',
    finalizationReason: 'completed',
    inputTurnId,
    inputTurnCompleted: true,
    sdkMessageUuid: `sdk-${inputTurnId}`,
  };
}

describe('actual runtime callbacks preserve per-input reply destinations', () => {
  test.each(['main', 'session'] as const)(
    '%s persists a warm Web final after an IM input, without sending it to IM',
    async (lane) => {
      const fixture = makeOutputRuntime(lane);
      await fixture.emit(finalOutput(fixture.inputId));
      const rows = db.getMessagesForTurn(
        fixture.virtualChatJid,
        fixture.inputId,
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        content: 'Answer to the Web follow-up.',
        source_kind: 'sdk_final',
        finalization_reason: 'completed',
        is_from_me: true,
      });
      expect(
        db.getMessagesForTurn(fixture.virtualChatJid, 'initial-im-input'),
      ).toEqual([]);
      expect(fixture.sendImWithRetry).not.toHaveBeenCalled();
      expect(fixture.broadcastNewMessage).toHaveBeenCalledWith(
        fixture.virtualChatJid,
        expect.objectContaining({
          content: rows[0].content,
          turn_id: fixture.inputId,
        }),
        ...(lane === 'main' ? [undefined, undefined] : ['session']),
      );
      expect(fixture.commitCursor).toHaveBeenCalledWith(fixture.inputId);
      expect(fixture.globals.hadError).toBe(false);
    },
  );

  test.each(['main', 'session'] as const)(
    '%s keeps a late initial IM final on its own scope after Web admission',
    async (lane) => {
      const fixture = makeOutputRuntime(lane);
      const inputId = 'initial-im-input';
      fixture.globals.replySourceImJid = null;
      fixture.globals.channelOutboxScopesByInput.set(inputId, {
        sourceJid: OLD_IM,
        token: 'initial-scope',
        turnRunId: 'initial-run',
      });
      fixture.globals.turnOutputCoordinators.set(
        inputId,
        new TurnOutputCoordinator(),
      );
      await fixture.emit(finalOutput(inputId, 'Delayed IM answer.'));
      expect(db.getMessagesForTurn(fixture.virtualChatJid, inputId)).toEqual([
        expect.objectContaining({ content: 'Delayed IM answer.' }),
      ]);
      expect(fixture.sendImWithRetry).toHaveBeenCalledExactlyOnceWith(
        OLD_IM,
        'Delayed IM answer.',
        [],
        expect.objectContaining({ scopeToken: 'initial-scope' }),
      );
      expect(fixture.commitCursor).toHaveBeenCalledWith(inputId);
      expect(fixture.globals.hadError).toBe(false);
    },
  );

  test.each(['main', 'session'] as const)(
    '%s does not persist or acknowledge a Web input whose admission was rejected',
    async (lane) => {
      const fixture = makeOutputRuntime(lane);
      fixture.globals.rejectedChannelInputTurns.add(fixture.inputId);
      fixture.globals.rejectedAgentInputTurns.add(fixture.inputId);
      await fixture.emit(finalOutput(fixture.inputId));
      expect(
        db.getMessagesForTurn(fixture.virtualChatJid, fixture.inputId),
      ).toEqual([]);
      expect(fixture.broadcastNewMessage).not.toHaveBeenCalled();
      expect(fixture.sendImWithRetry).not.toHaveBeenCalled();
      expect(fixture.commitCursor).not.toHaveBeenCalled();
      expect(fixture.globals.hadError).toBe(true);
    },
  );

  test.each(['main', 'session'] as const)(
    '%s persists a Proactive Web tail failure locally without notifying the previous IM',
    async (lane) => {
      const fixture = makeOutputRuntime(lane);
      const { globals, inputId } = fixture;
      globals.interactionMode = 'proactive';
      globals.channelPhysicalDeliveryAckByInput.set(inputId, true);
      globals.agentPhysicalDeliveryAckByInput.set(inputId, true);
      const notify =
        globals[
          lane === 'main'
            ? 'notifyProactiveTailInterruption'
            : 'notifyProactiveAgentTailInterruption'
        ];
      expect(await notify(inputId)).toBe(true);
      expect(await notify(inputId)).toBe(false);
      expect(db.getMessagesPage(fixture.virtualChatJid)).toEqual([
        expect.objectContaining({
          sender: '__system__',
          content: `proactive_interrupted:${interactionRuntime.PROACTIVE_TAIL_INTERRUPTION_NOTICE}`,
        }),
      ]);
      expect(globals.resolveDurableChannelRoute).not.toHaveBeenCalled();
      expect(
        globals.deliverIndependentChannelSystemNotice,
      ).not.toHaveBeenCalled();
    },
  );
});

describe('actual message loop dispatches the unconsumed channel suffix', () => {
  test('a plugin-only A prefix schedules B through GroupQueue without another arrival', async () => {
    const chatJid = `web:batch-${crypto.randomUUID()}`;
    const group = { folder: 'batch-fixture', executionMode: 'host' };
    db.ensureChatExists(chatJid);
    for (const [id, sourceJid, content] of [
      ['a', 'feishu:a', '/inline'],
      ['b', 'feishu:b', 'Question for B'],
    ]) {
      db.storeMessageDirect(
        id,
        chatJid,
        'owner',
        'Owner',
        content,
        `2026-09-06T00:00:0${id === 'a' ? 1 : 2}Z`,
        false,
        { sourceJid },
      );
    }
    const queue = new GroupQueue();
    queue.setHostModeChecker(() => true);
    let releaseWarm!: () => void;
    const warmFinished = new Promise<void>((resolve) => {
      releaseWarm = resolve;
    });
    const received: string[][] = [];
    let calls = 0;
    let polls = 0;
    const globals: Record<string, any> = {
      ...replySource,
      ...interactionRuntime,
      ...db,
      getChannelType,
      EMPTY_CURSOR,
      registeredGroups: { [chatJid]: group },
      messageLoopRunning: false,
      shuttingDown: false,
      globalMessageCursor: EMPTY_CURSOR,
      lastAgentTimestamp: {},
      lastCommittedCursor: {},
      saveState: vi.fn(),
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      resolveEffectiveGroup: () => ({ effectiveGroup: group }),
      getWorkspaceInteractionMode: () => 'assistant',
      selectInteractionModeCompatibleMessagePrefix: (
        messages: NewMessage[],
      ) => ({
        messages,
        interactionMode: 'assistant',
        hasDeferredMessages: false,
      }),
      resolveBatchChannelContext: () => null,
      queue,
      buildExpandContext: () => ({ executionMode: 'host' }),
      persistPluginExpansion: vi.fn(),
      expandMessagesIfNeeded: vi.fn(async (messages: NewMessage[]) => ({
        toSend: [],
        replies: messages.map((originalMsg) => ({
          originalMsg,
          text: 'Inline result',
        })),
      })),
      sendPluginExpanderReply: vi.fn(async () => ({ acknowledged: true })),
      clearStandaloneProcessingIndicator: vi.fn(),
      hasEarlierPendingMessage: () => false,
      flushDeferredOutOfBandMessages: vi.fn(),
      flushAcknowledgedIpcForJid: vi.fn(),
      stuckRunnerCheckCounter: 0,
      STUCK_RUNNER_CHECK_INTERVAL_POLLS: 15,
      POLL_INTERVAL: 1,
      interruptibleSleep: async () => {
        if (++polls === 2) globals.shuttingDown = true;
      },
    };
    const harness = createRuntimeSourceHarness(globals);
    for (const name of [
      'isCursorAfter',
      'createIpcDeliveryTarget',
      'advanceNextPullCursorOnly',
      'advanceCursors',
      'completeOutOfBandMessage',
      'startMessageLoop',
    ]) {
      harness.install(name);
    }
    queue.setProcessMessagesFn(async (jid) => {
      if (++calls === 1) await warmFinished;
      else
        received.push(
          db
            .getMessagesSince(
              jid,
              globals.lastAgentTimestamp[jid] ?? EMPTY_CURSOR,
            )
            .map((m) => m.id),
        );
      return true;
    });
    try {
      queue.enqueueMessageCheck(chatJid);
      await vi.waitFor(() => expect(calls).toBe(1));
      await globals.startMessageLoop();
      expect(globals.logger.error).not.toHaveBeenCalled();
      expect(globals.globalMessageCursor.id).toBe('b');
      expect(globals.lastCommittedCursor[chatJid].id).toBe('a');
      expect(
        db
          .getMessagesSince(chatJid, globals.lastAgentTimestamp[chatJid])
          .map((m) => m.id),
      ).toEqual(['b']);
      expect(
        globals.expandMessagesIfNeeded.mock.calls.map(
          ([messages]: [NewMessage[]]) => messages.map((m) => m.id),
        ),
      ).toEqual([['a']]);
      releaseWarm();
      await vi.waitFor(() => expect(received).toEqual([['b']]));
      expect(calls).toBe(2);
    } finally {
      releaseWarm();
      await queue.shutdown(0);
    }
  });
});

describe('actual channel runtime and recovery under combined failure windows', () => {
  const testRoute = {
    provider: 'feishu' as const,
    accountId: 'bot-window-test',
    sourceJid: 'feishu:bot-window-test:chat-win',
    chatId: 'chat-win',
  };

  test('reboot before lease expiry does not preempt active lease, and preserves pending cursor', async () => {
    let now = '2026-09-07T00:00:00.000Z';
    const runtime = ChannelTurnRuntime.start({
      ...testRoute,
      externalMessageId: 'msg-lease-1',
    });

    let itemId = '';
    const base = {
      ...testRoute,
      turnRunId: runtime.runId,
      ordinal: 0,
      kind: 'text' as const,
      payload: { text: 'Turn payload' },
      owner: 'worker-process-1',
      leaseMs: 60_000,
      now: () => now,
      delivery: {
        mode: 'single' as const,
        send: async () => ({ providerMessageId: 'ack-lease-1' }),
      },
    };

    // Simulate crash at claimed phase
    await expect(
      delivery.deliverChannelOutboxItem({
        ...base,
        afterPersist: (phase, item) => {
          if (phase === 'claimed') {
            itemId = item.id;
            throw new delivery.ChannelDeliveryProcessCrash();
          }
        },
      }),
    ).rejects.toBeInstanceOf(delivery.ChannelDeliveryProcessCrash);

    // 10 seconds later: simulate process restart before 60s lease expires
    now = '2026-09-07T00:00:10.000Z';
    const dummyReconciler = {
      reconcileStreamingCard: async () => ({
        version: 1,
        method: 'cardkit' as const,
      }),
    };
    const startupResult = await recovery.reconcileChannelReliabilityPass(
      dummyReconciler,
      { mode: 'startup', now, includeOutbox: true },
    );
    expect(startupResult.outbox).toEqual({ retryable: 0, uncertain: 0 });

    const itemAt10s = store.getChannelOutboxItem(itemId)!;
    expect(itemAt10s.status).toBe('claimed');
    expect(itemAt10s.leaseOwner).toBe('worker-process-1');

    // Attempt to claim with a new worker before lease expires -> must return undefined (no preemption)
    const preemptClaim = store.claimChannelOutboxById(
      itemId,
      'new-worker',
      60_000,
      now,
    );
    expect(preemptClaim).toBeUndefined();

    runtime.dispose();
  });

  test('lost ACK marks outbox uncertain, fences replay, and triggers reconciliation settlement', async () => {
    let now = '2026-09-07T01:00:00.000Z';
    const runtime = ChannelTurnRuntime.start({
      ...testRoute,
      externalMessageId: 'msg-ack-lost',
    });

    let physicalSends = 0;
    const itemInput = {
      ...testRoute,
      turnRunId: runtime.runId,
      ordinal: 0,
      kind: 'text' as const,
      payload: { text: 'Critical answer' },
      owner: 'worker-process-2',
      leaseMs: 60_000,
      now: () => now,
      delivery: {
        mode: 'single' as const,
        send: async () => {
          physicalSends++;
          // ACK lost after transmission
          throw new Error('connection closed after send before ACK');
        },
      },
    };

    const firstResult = await delivery.deliverChannelOutboxItem(itemInput);
    expect(firstResult.status).toBe('uncertain');
    expect(physicalSends).toBe(1);

    // Automatic replay must be blocked
    const replayResult = await delivery.deliverChannelOutboxItem({
      ...itemInput,
      owner: 'worker-process-3',
    });
    expect(replayResult.status).toBe('uncertain');
    expect(physicalSends).toBe(1); // Provider send was NOT repeated

    // Settlement via settleChannelTurnOutput detects uncertain and calls reconciliation notice
    const runtimes = new Map([[runtime.runId, runtime]]);
    const outboxScopesByInput = new Map([
      [
        runtime.runId,
        {
          ...testRoute,
          scopeKey: 'feishu:chat-win',
          targetJid: testRoute.sourceJid,
        },
      ],
    ]);
    let noticeSent = false;
    let manualReconCalled = false;

    const settled = await settleChannelTurnOutput(
      {
        inputTurnCompleted: true,
        inputTurnId: runtime.runId,
        status: 'success',
      },
      {
        chatJid: 'web:chat-win',
        folder: 'test-folder',
        lastProcessedId: runtime.runId,
        runtimes,
        outboxScopesByInput: outboxScopesByInput as any,
        nonTerminalDeliveryAckByInput: new Map(),
        physicalDeliveryAckByInput: new Map(),
        clearProcessingIndicator: async () => {},
        markOutputSettled: () => {},
        deliverManualReconciliationNotice: async () => {
          noticeSent = true;
          return true;
        },
        deliverDefinitiveFailureNotice: async () => false,
        onNeedsManualReconciliation: () => {
          manualReconCalled = true;
        },
      },
    );

    expect(manualReconCalled).toBe(true);
    expect(noticeSent).toBe(true);
    expect(runtimes.has(runtime.runId)).toBe(false); // Runtime disposed
  });

  test('composite turn with delivered text and definitively failed attachment settles partial delivery', async () => {
    const now = '2026-09-07T02:00:00.000Z';
    const runtime = ChannelTurnRuntime.start({
      ...testRoute,
      externalMessageId: 'msg-composite-turn',
    });

    // 1) Deliver text successfully
    const textResult = await delivery.deliverChannelOutboxItem({
      ...testRoute,
      turnRunId: runtime.runId,
      ordinal: 0,
      kind: 'text' as const,
      payload: { text: 'Here is the report text' },
      owner: 'worker-text',
      now: () => now,
      delivery: {
        mode: 'single' as const,
        send: async () => ({ providerMessageId: 'ack-text-ok' }),
      },
    });
    expect(textResult.status).toBe('delivered');

    // 2) Attachment rejected definitively
    const fileResult = await delivery.deliverChannelOutboxItem({
      ...testRoute,
      turnRunId: runtime.runId,
      ordinal: 1,
      kind: 'file' as const,
      payload: { path: 'corrupt.bin' },
      owner: 'worker-file',
      now: () => now,
      delivery: {
        mode: 'single' as const,
        send: async () => {
          throw new delivery.DefinitiveChannelDeliveryError(
            'file rejected by policy',
          );
        },
      },
    });
    expect(fileResult.status).toBe('failed');

    // 3) Settle the composite turn
    const runtimes = new Map([[runtime.runId, runtime]]);
    const outboxScopesByInput = new Map([
      [
        runtime.runId,
        {
          ...testRoute,
          scopeKey: 'feishu:chat-win',
          targetJid: testRoute.sourceJid,
        },
      ],
    ]);
    let definitiveFailureNoticeSent = false;
    let partialNoticed = false;
    let failureSettled = false;

    await settleChannelTurnOutput(
      {
        inputTurnCompleted: true,
        inputTurnId: runtime.runId,
        status: 'error',
      },
      {
        chatJid: 'web:chat-win',
        folder: 'test-folder',
        lastProcessedId: runtime.runId,
        runtimes,
        outboxScopesByInput: outboxScopesByInput as any,
        nonTerminalDeliveryAckByInput: new Map(),
        physicalDeliveryAckByInput: new Map(),
        clearProcessingIndicator: async () => {},
        markOutputSettled: () => {},
        deliverManualReconciliationNotice: async () => false,
        deliverDefinitiveFailureNotice: async (opts) => {
          definitiveFailureNoticeSent = true;
          partialNoticed = opts.partial;
          return true;
        },
        onDefinitiveFailureSettled: () => {
          failureSettled = true;
        },
      },
    );

    expect(definitiveFailureNoticeSent).toBe(true);
    expect(partialNoticed).toBe(true); // Recognizes that text was already delivered
    expect(failureSettled).toBe(true);
    expect(runtimes.has(runtime.runId)).toBe(false);
  });

  test('end-to-end multi-session harness: GroupQueue dispatch + SQLite reopen crash recovery + Outbox fencing + composite failure settlement', async () => {
    const chatJid = `web:multi-${crypto.randomUUID()}`;
    const groupFolder = `multi-folder-${Date.now()}`;
    db.ensureChatExists(chatJid);
    db.setRegisteredGroup(chatJid, {
      jid: chatJid,
      name: 'Multi Session Workspace',
      folder: groupFolder,
      added_at: new Date().toISOString(),
      created_by: 'owner-user',
      executionMode: 'host',
    });

    // 1. Two separate sessions: Main Session (msg-1) and Agent Session (msg-2)
    db.storeMessageDirect(
      'msg-1',
      chatJid,
      'user',
      'User',
      'Question for Main',
      '2026-09-07T03:00:01.000Z',
      false,
      { sourceJid: 'feishu:bot:chat-1' },
    );

    const agentChatJid = `${chatJid}#agent:sub-1`;
    db.ensureChatExists(agentChatJid);
    db.storeMessageDirect(
      'msg-2',
      agentChatJid,
      'user',
      'User',
      'Question for Agent Sub-1',
      '2026-09-07T03:00:02.000Z',
      false,
      { sourceJid: 'feishu:bot:chat-2' },
    );

    const queue = new GroupQueue();
    queue.setHostModeChecker(() => true);

    const processedJids: string[] = [];
    const lastCommittedCursor: Record<string, MessageCursor> = {};
    let mainPhysicalSends = 0;
    let mainReconNotice = false;
    let mainItemId = '';
    let agentDefinitiveFailed = false;
    let agentPartial = false;
    let mainCrashed = false;
    let now = '2026-09-07T03:00:05.000Z';

    const dummyReconciler = {
      reconcileStreamingCard: async () => ({
        version: 1,
        method: 'cardkit' as const,
      }),
    };

    // Wire real GroupQueue consumer callback driving both sessions through their failure & settlement paths
    queue.setProcessMessagesFn(async (targetJid) => {
      processedJids.push(targetJid);

      if (targetJid === chatJid) {
        // Main Session Turn
        const messages = db.getMessagesSince(
          chatJid,
          lastCommittedCursor[chatJid] ?? EMPTY_CURSOR,
        );
        expect(messages.map((m) => m.id)).toContain('msg-1');

        const mainRuntime = ChannelTurnRuntime.start({
          provider: 'feishu',
          accountId: 'bot',
          sourceJid: 'feishu:bot:chat-1',
          chatId: 'chat-1',
          externalMessageId: 'msg-1',
        });

        const mainOutboxInput = {
          provider: 'feishu' as const,
          accountId: 'bot',
          sourceJid: 'feishu:bot:chat-1',
          chatId: 'chat-1',
          turnRunId: mainRuntime.runId,
          ordinal: 0,
          kind: 'text' as const,
          payload: { text: 'Main answer' },
          owner: 'worker-crash-1',
          leaseMs: 60_000,
          now: () => now,
          delivery: {
            mode: 'single' as const,
            send: async () => {
              mainPhysicalSends++;
              throw new Error('Lost ACK on wire');
            },
          },
        };

        if (!mainCrashed) {
          mainCrashed = true;
          try {
            await delivery.deliverChannelOutboxItem({
              ...mainOutboxInput,
              afterPersist: (phase, item) => {
                if (phase === 'claimed') {
                  mainItemId = item.id;
                  throw new delivery.ChannelDeliveryProcessCrash();
                }
              },
            });
          } catch (e) {
            if (!(e instanceof delivery.ChannelDeliveryProcessCrash)) throw e;
          }
          return true;
        }

        // Recovery path after restart: claim and send
        const sendResult = await delivery.deliverChannelOutboxItem({
          ...mainOutboxInput,
          owner: 'worker-2',
          now: () => now,
        });
        expect(sendResult.status).toBe('uncertain');
        expect(mainPhysicalSends).toBe(1);

        // Subsequent retry is blocked from physical resend
        const retryResult = await delivery.deliverChannelOutboxItem({
          ...mainOutboxInput,
          owner: 'worker-3',
          now: () => now,
        });
        expect(retryResult.status).toBe('uncertain');
        expect(mainPhysicalSends).toBe(1);

        // Settle Main Session turn
        const mainRuntimes = new Map([[mainRuntime.runId, mainRuntime]]);
        await settleChannelTurnOutput(
          {
            inputTurnCompleted: true,
            inputTurnId: mainRuntime.runId,
            status: 'error',
          },
          {
            chatJid,
            folder: groupFolder,
            lastProcessedId: 'msg-1',
            runtimes: mainRuntimes,
            outboxScopesByInput: new Map([
              [
                mainRuntime.runId,
                {
                  provider: 'feishu',
                  accountId: 'bot',
                  sourceJid: 'feishu:bot:chat-1',
                  chatId: 'chat-1',
                  scopeKey: 'feishu:chat-1',
                  targetJid: 'feishu:bot:chat-1',
                },
              ],
            ]),
            nonTerminalDeliveryAckByInput: new Map(),
            physicalDeliveryAckByInput: new Map(),
            clearProcessingIndicator: async () => {},
            markOutputSettled: () => {},
            deliverManualReconciliationNotice: async () => {
              mainReconNotice = true;
              return true;
            },
            deliverDefinitiveFailureNotice: async () => false,
          },
        );

        lastCommittedCursor[chatJid] = db.getMessageCursor(chatJid, 'msg-1')!;
        return true;
      }

      if (targetJid === agentChatJid) {
        // Agent Session Turn
        const messages = db.getMessagesSince(
          agentChatJid,
          lastCommittedCursor[agentChatJid] ?? EMPTY_CURSOR,
        );
        expect(messages.map((m) => m.id)).toContain('msg-2');

        const agentRuntime = ChannelTurnRuntime.start({
          provider: 'feishu',
          accountId: 'bot',
          sourceJid: 'feishu:bot:chat-2',
          chatId: 'chat-2',
          externalMessageId: 'msg-2',
          agentId: 'sub-1',
        });

        // 1) Text delivered ok
        const agentText = await delivery.deliverChannelOutboxItem({
          provider: 'feishu',
          accountId: 'bot',
          sourceJid: 'feishu:bot:chat-2',
          chatId: 'chat-2',
          turnRunId: agentRuntime.runId,
          ordinal: 0,
          kind: 'text',
          payload: { text: 'Agent text' },
          owner: 'worker-agent',
          now: () => now,
          delivery: {
            mode: 'single',
            send: async () => ({ providerMessageId: 'ack-agent-text' }),
          },
        });
        expect(agentText.status).toBe('delivered');

        // 2) File attachment definitive failure
        const agentFile = await delivery.deliverChannelOutboxItem({
          provider: 'feishu',
          accountId: 'bot',
          sourceJid: 'feishu:bot:chat-2',
          chatId: 'chat-2',
          turnRunId: agentRuntime.runId,
          ordinal: 1,
          kind: 'file',
          payload: { path: 'fail.doc' },
          owner: 'worker-agent',
          now: () => now,
          delivery: {
            mode: 'single',
            send: async () => {
              throw new delivery.DefinitiveChannelDeliveryError('rejected');
            },
          },
        });
        expect(agentFile.status).toBe('failed');

        // 3) Settle Agent Session 2
        const agentRuntimes = new Map([[agentRuntime.runId, agentRuntime]]);
        await settleChannelTurnOutput(
          {
            inputTurnCompleted: true,
            inputTurnId: agentRuntime.runId,
            status: 'error',
          },
          {
            chatJid: agentChatJid,
            agentId: 'sub-1',
            folder: groupFolder,
            lastProcessedId: 'msg-2',
            runtimes: agentRuntimes,
            outboxScopesByInput: new Map([
              [
                agentRuntime.runId,
                {
                  provider: 'feishu',
                  accountId: 'bot',
                  sourceJid: 'feishu:bot:chat-2',
                  chatId: 'chat-2',
                  scopeKey: 'feishu:chat-2',
                  targetJid: 'feishu:bot:chat-2',
                },
              ],
            ]),
            nonTerminalDeliveryAckByInput: new Map(),
            physicalDeliveryAckByInput: new Map(),
            clearProcessingIndicator: async () => {},
            markOutputSettled: () => {},
            deliverManualReconciliationNotice: async () => false,
            deliverDefinitiveFailureNotice: async (opts) => {
              agentDefinitiveFailed = true;
              agentPartial = opts.partial;
              return true;
            },
          },
        );

        lastCommittedCursor[agentChatJid] = db.getMessageCursor(
          agentChatJid,
          'msg-2',
        )!;
        return true;
      }

      return true;
    });

    // Step A: Queue drives Main Session check -> triggers crash during claimed phase
    queue.enqueueMessageCheck(chatJid);
    await vi.waitFor(() => expect(mainCrashed).toBe(true));

    // Step B: Real restart simulation - close database and reopen
    db.closeDatabase();
    db.initDatabase();

    // Step C: 10s recovery (before 60s lease expires) -> lease protected, not preempted
    now = '2026-09-07T03:00:15.000Z';
    const recAt10s = await recovery.reconcileChannelReliabilityPass(
      dummyReconciler,
      {
        mode: 'startup',
        now,
        includeOutbox: true,
      },
    );
    expect(recAt10s.outbox).toEqual({ retryable: 0, uncertain: 0 });
    expect(store.getChannelOutboxItem(mainItemId)?.status).toBe('claimed');

    // Step D: 61s recovery (after lease expires) -> lease expires to retry_wait
    now = '2026-09-07T03:01:06.000Z';
    const recAt61s = await recovery.reconcileChannelReliabilityPass(
      dummyReconciler,
      {
        mode: 'live',
        now,
        includeOutbox: true,
      },
    );
    expect(recAt61s.outbox.retryable).toBeGreaterThanOrEqual(1);
    expect(store.getChannelOutboxItem(mainItemId)?.status).toBe('retry_wait');

    // Step E: Queue drives recovery run for Main Session -> lost ACK marks uncertain, fences replay, settles notice
    queue.enqueueMessageCheck(chatJid);
    await vi.waitFor(() => expect(mainReconNotice).toBe(true));
    expect(lastCommittedCursor[chatJid]?.id).toBe('msg-1');

    // Step F: Queue drives independent Agent Session 2 -> composite text+file partial delivery settlement
    queue.enqueueMessageCheck(agentChatJid);
    await vi.waitFor(() => expect(agentDefinitiveFailed).toBe(true));
    expect(agentPartial).toBe(true);
    expect(lastCommittedCursor[agentChatJid]?.id).toBe('msg-2');

    // Step G: Final cross-layer assertions
    expect(processedJids).toContain(chatJid);
    expect(processedJids).toContain(agentChatJid);
    expect(mainPhysicalSends).toBe(1);
    expect(db.getMessageCursor(chatJid, 'msg-1')).toBeDefined();
    expect(db.getMessageCursor(agentChatJid, 'msg-2')).toBeDefined();

    await queue.shutdown(0);
  });
});
