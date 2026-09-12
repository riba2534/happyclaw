import crypto from 'node:crypto';
import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import * as replyDelivery from '../src/reply-delivery.js';
import * as interactionRuntime from '../src/workspace-interaction-runtime.js';
import * as channelInteraction from '../src/channel-interaction-mode.js';
import { channelConversationJid } from '../src/channel-address.js';
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
      ...channelInteraction,
      channelConversationJid,
      resolveScheduledGroupPromptInteractionMode: () => null,
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
      'resolveTrustedInteractionMode',
      'selectRuntimeInteractionBatch',
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

describe('actual runtime mount-mode admission and resume safety', () => {
  test('cold source batch freezes one mode and leaves a different Home source behind', () => {
    const homeJid = 'web:mode-home';
    const group = { folder: 'mode-home' };
    const research = 'feishu:mode-research';
    const globals: Record<string, any> = {
      ...interactionRuntime,
      ...channelInteraction,
      channelConversationJid,
      registeredGroups: { [homeJid]: group },
      getRegisteredGroup: () => undefined,
      getWorkspaceInteractionMode: () => 'proactive',
      getChannelMount: (jid: string) =>
        jid === research
          ? { workspace_jid: homeJid, interaction_mode_override: 'assistant' }
          : undefined,
      getTaskRunById: () => undefined,
      resolveScheduledGroupPromptInteractionMode: (message: NewMessage) =>
        message.task_id ? 'proactive' : null,
    };
    const harness = createRuntimeSourceHarness(globals);
    harness.install('resolveTrustedInteractionMode');
    harness.install('selectRuntimeInteractionBatch');
    const messages = [
      { id: 'a', chat_jid: homeJid, source_jid: research },
      { id: 'b', chat_jid: homeJid, source_jid: 'feishu:mode-other' },
      { id: 'c', chat_jid: homeJid, source_jid: research },
    ];
    const selected = globals.selectRuntimeInteractionBatch(
      messages,
      group,
      homeJid,
    );
    expect(selected.interactionMode).toBe('assistant');
    expect(selected.messages.map((message: NewMessage) => message.id)).toEqual([
      'a',
    ]);
    expect(selected.hasDeferredMessages).toBe(true);
    const next = globals.selectRuntimeInteractionBatch(
      messages.slice(1),
      group,
      homeJid,
    );
    expect(next.interactionMode).toBe('proactive');
    expect(next.messages.map((message: NewMessage) => message.id)).toEqual([
      'b',
    ]);
    const frozen = globals.selectRuntimeInteractionBatch(
      [
        {
          ...messages[0],
          task_id: 'frozen-task',
          source_kind: 'scheduled_task_prompt',
        },
        messages[2],
      ],
      group,
      homeJid,
    );
    expect(frozen.interactionMode).toBe('proactive');
    expect(frozen.messages).toHaveLength(1);
    const spawned = globals.selectRuntimeInteractionBatch(
      messages,
      group,
      homeJid,
      'spawn',
    );
    expect(spawned.interactionMode).toBe('assistant');
    expect(spawned.messages).toHaveLength(3);
  });

  test('a source-mode switch resets only its SDK namespace and preserves stored conversation history', () => {
    const folder = `resume-mode-${crypto.randomUUID()}`;
    const jid = `web:${folder}`;
    db.ensureChatExists(jid);
    db.storeMessageDirect(
      'history',
      jid,
      'owner',
      'Owner',
      '既有历史不变',
      '2026-09-13T00:00:00Z',
      false,
    );
    db.setSession(folder, 'sdk-main');
    db.setSessionInteractionMode(folder, undefined, 'proactive');
    db.setSession(folder, 'sdk-agent', 'agent-sibling');
    db.setSessionInteractionMode(folder, 'agent-sibling', 'proactive');
    const globals: Record<string, any> = {
      ...db,
      ...interactionRuntime,
      ...channelInteraction,
      sessions: { [folder]: 'sdk-main' },
      getWorkspaceInteractionMode: () => 'proactive',
      logger: { info: vi.fn() },
    };
    const harness = createRuntimeSourceHarness(globals);
    harness.install('resetSessionForInteractionModeMismatch');
    expect(
      globals.resetSessionForInteractionModeMismatch({ folder }, 'assistant'),
    ).toBe(true);
    expect(db.getSession(folder)).toBeUndefined();
    expect(globals.sessions[folder]).toBeUndefined();
    expect(db.getSession(folder, 'agent-sibling')).toBe('sdk-agent');
    expect(db.getMessagesPage(jid)[0].content).toBe('既有历史不变');
    db.setSession(folder, 'sdk-new');
    db.setSessionInteractionMode(folder, undefined, 'assistant');
    expect(
      globals.resetSessionForInteractionModeMismatch({ folder }, 'assistant'),
    ).toBe(false);
    expect(db.getSession(folder)).toBe('sdk-new');
    expect(
      globals.resetSessionForInteractionModeMismatch({ folder }, 'proactive'),
    ).toBe(true);
    expect(db.getSession(folder, 'agent-sibling')).toBe('sdk-agent');
  });
});
