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
import { InputUsageProjection } from '../src/input-usage-projection.js';
import { hasUnfinishedProactiveOutput } from '../src/turn-outcome.js';
import { getChannelType } from '../src/im-channel.js';
import { channelTurnScope } from '../src/channel-turn-registry.js';
import { createRuntimeSourceHarness } from './helpers/runtime-source.js';
import type { NewMessage } from '../src/types.js';

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
const { stripAgentInternalTags } = await import('../src/utils.js');
const OLD_IM = 'feishu:previous';

beforeAll(() => db.initDatabase());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(paths.root, { recursive: true, force: true });
});

function makeOutputRuntime() {
  const chatJid = `web:routing-${crypto.randomUUID()}`;
  const virtualChatJid = `${chatJid}#agent:session`;
  const inputId = 'warm-web-input';
  const scopeByInput = new Map();
  const admissions = new Map([[inputId, { imJid: null }]]);
  const coordinators = new Map([[inputId, new TurnOutputCoordinator()]]);
  const sendImWithRetry = vi.fn(async () => true);
  const broadcastNewMessage = vi.fn();
  const commitCursor = vi.fn();
  const inputUsageProjection = new InputUsageProjection('initial-im-input');
  inputUsageProjection.admit(inputId);
  const agentInputUsageProjection = new InputUsageProjection(
    'initial-im-input',
  );
  agentInputUsageProjection.admit(inputId);
  const globals: Record<string, any> = {
    inputUsageProjection,
    agentInputUsageProjection,
    ...replyDelivery,
    ...interactionRuntime,
    ...replySource,
    // The Web projection and the turn traces are covered by their own tests.
    resolveProcessVisibility: () => 'full',
    turnTraces: {
      observe: vi.fn(),
      persist: vi.fn(() => false),
      discard: vi.fn(),
    },
    persistProactiveTurnTrace: vi.fn(),
    // The context ring has its own tests.
    broadcastContextUsage: vi.fn(),
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
    channelNonTerminalDeliveryAckByInput: new Map(),
    agentReplySentByInput: new Map(),
    agentAnyReplyProjectedByInput: new Map(),
    agentGenuineReplyDeliveredByInput: new Map(),
    agentPhysicalDeliveryAckByInput: new Map(),
    agentNonTerminalDeliveryAckByInput: new Map(),
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
    currentAgentChannelContext: undefined,
    getMessageChannelTurnContext: () => null,
    bindActiveChannelTurn: vi.fn(),
    getFailedChannelOutboxForTurn: () => undefined,
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
    // Web Push has its own tests (web-push.test.ts); no push here.
    pushWebTurnOutcome: vi.fn(),
    broadcastToWebClients: vi.fn(),
    clearStreamingSnapshot: vi.fn(),
    resetIdleTimer: vi.fn(),
    completeChannelRuntimesForOutput: async () => true,
    completeAgentChannelRuntimesForOutput: async () => true,
    commitCursor,
    // No recall stop in these routing fixtures.
    takeRecallStop: () => undefined,
    mainRecallSuppression: false,
    agentRecallSuppression: false,
    mainRecalledInputIds: new Set(),
    agentRecalledInputIds: new Set(),
  };
  const harness = createRuntimeSourceHarness(globals);
  harness.install('sendMessageWithOutcome');
  harness.install('sendSystemMessage');
  harness.install('deliverProactiveTailInterruptionNotice');
  harness.install(
    'notifyProactiveAgentTailInterruption',
    'processAgentConversation',
  );
  harness.install('agentScopeForOutput', 'processAgentConversation');
  harness.install(
    'activateAgentProjectionForInput',
    'processAgentConversation',
  );
  harness.install('handleAgentOutput', 'processAgentConversation');
  const emit = globals.handleAgentOutput as (
    output: Record<string, unknown>,
  ) => Promise<void>;
  return {
    globals,
    harness,
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
  test('persists a warm Web final after an IM input, without sending it to IM', async () => {
    const fixture = makeOutputRuntime();
    await fixture.emit(finalOutput(fixture.inputId));
    const rows = db.getMessagesForTurn(fixture.virtualChatJid, fixture.inputId);
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
      'session',
    );
    expect(fixture.commitCursor).toHaveBeenCalledWith(fixture.inputId);
    expect(fixture.globals.hadError).toBe(false);
    // A completed turn refreshes the session's context ring.
    expect(fixture.globals.broadcastContextUsage).toHaveBeenCalledWith(
      'routing-fixture',
      'session',
    );
  });

  test('keeps a late initial IM final on its own scope after Web admission', async () => {
    const fixture = makeOutputRuntime();
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
  });

  test('still sends the final IM answer after a held background-task progress reply', async () => {
    const fixture = makeOutputRuntime();
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
    await fixture.emit({
      status: 'success',
      result: 'Started a background search.',
      sourceKind: 'sdk_final',
      finalizationReason: 'completed',
      pendingBgTasks: 1,
      inputTurnId: inputId,
      sdkMessageUuid: 'sdk-held',
    });
    await fixture.emit(finalOutput(inputId, 'Found 16 remote roles.'));
    expect(fixture.sendImWithRetry).toHaveBeenCalledTimes(2);
    expect(fixture.sendImWithRetry).toHaveBeenLastCalledWith(
      OLD_IM,
      'Found 16 remote roles.',
      [],
      expect.objectContaining({ scopeToken: 'initial-scope' }),
    );
    expect(fixture.commitCursor).toHaveBeenCalledWith(inputId);
    expect(fixture.globals.hadError).toBe(false);
  });

  test('does not persist or acknowledge a Web input whose admission was rejected', async () => {
    const fixture = makeOutputRuntime();
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
  });

  test('persists a Proactive Web tail failure locally without notifying the previous IM', async () => {
    const fixture = makeOutputRuntime();
    const { globals, inputId } = fixture;
    globals.interactionMode = 'proactive';
    globals.channelPhysicalDeliveryAckByInput.set(inputId, true);
    globals.agentPhysicalDeliveryAckByInput.set(inputId, true);
    const notify = globals.notifyProactiveAgentTailInterruption;
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
    const jid = `web:${folder}#agent:agent-own`;
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
    db.setSession(folder, 'sdk-own', 'agent-own');
    db.setSessionInteractionMode(folder, 'agent-own', 'proactive');
    db.setSession(folder, 'sdk-agent', 'agent-sibling');
    db.setSessionInteractionMode(folder, 'agent-sibling', 'proactive');
    const globals: Record<string, any> = {
      ...db,
      ...interactionRuntime,
      ...channelInteraction,
      getWorkspaceInteractionMode: () => 'proactive',
      logger: { info: vi.fn() },
    };
    const harness = createRuntimeSourceHarness(globals);
    harness.install('resetSessionForInteractionModeMismatch');
    const reset = (mode: string) =>
      globals.resetSessionForInteractionModeMismatch(
        { folder },
        mode,
        'agent-own',
        'conversation',
      );
    expect(reset('assistant')).toBe(true);
    expect(db.getSession(folder, 'agent-own')).toBeUndefined();
    expect(db.getSession(folder, 'agent-sibling')).toBe('sdk-agent');
    expect(db.getMessagesPage(jid)[0].content).toBe('既有历史不变');
    db.setSession(folder, 'sdk-new', 'agent-own');
    db.setSessionInteractionMode(folder, 'agent-own', 'assistant');
    expect(reset('assistant')).toBe(false);
    expect(db.getSession(folder, 'agent-own')).toBe('sdk-new');
    expect(reset('proactive')).toBe(true);
    expect(db.getSession(folder, 'agent-sibling')).toBe('sdk-agent');
  });
});

test('keeps a failed final retryable after a successful held checkpoint', async () => {
  const fixture = makeOutputRuntime();
  const inputId = 'initial-im-input';
  const scopes = fixture.globals.agentChannelOutboxScopesByInput;
  const physical = fixture.globals.agentPhysicalDeliveryAckByInput;
  const progress = fixture.globals.agentNonTerminalDeliveryAckByInput;
  const genuine = fixture.globals.agentGenuineReplyDeliveredByInput;
  const replied = fixture.globals.agentReplySentByInput;
  const coordinators = fixture.globals.agentTurnOutputCoordinators;
  fixture.globals.replySourceImJid = null;
  scopes.set(inputId, {
    sourceJid: OLD_IM,
    token: 'initial-scope',
    turnRunId: 'initial-run',
  });
  coordinators.set(inputId, new TurnOutputCoordinator());
  const runtime = {
    runId: 'initial-run',
    markFinalizing: () => true,
    complete: vi.fn(() => true),
    dispose: vi.fn(),
  };
  Object.assign(fixture.globals, {
    channelTurnRuntimes: new Map([[inputId, runtime]]),
    agentChannelTurnRuntimes: new Map([[inputId, runtime]]),
    hasUnfinishedProactiveOutput,
    getUncertainChannelOutboxForTurn: () => undefined,
    getDeliveredChannelOutboxForTurn: () => undefined,
    clearProcessingIndicatorForInput: vi.fn(),
    clearAgentProcessingIndicatorForInput: vi.fn(),
    markMainOutputSettled: vi.fn(),
    markAgentOutputSettled: vi.fn(),
  });
  fixture.harness.install(
    'completeAgentChannelRuntimesForOutput',
    'processAgentConversation',
  );
  fixture.sendImWithRetry
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(false)
    .mockResolvedValueOnce(true);
  await fixture.emit({
    status: 'success',
    result: 'Search running.',
    sourceKind: 'sdk_final',
    finalizationReason: 'completed',
    pendingBgTasks: 1,
    inputTurnId: inputId,
    sdkMessageUuid: 'sdk-held',
  });
  expect(progress.get(inputId)).toBe(true);
  expect(physical.get(inputId)).not.toBe(true);
  await expect(
    fixture.emit(finalOutput(inputId, 'Final results.')),
  ).rejects.toThrow(/host_turn_settlement_failed/);
  expect(genuine.get(inputId)).not.toBe(true);
  expect(replied.get(inputId)).not.toBe(true);
  expect(fixture.commitCursor).not.toHaveBeenCalled();
  expect(runtime.complete).not.toHaveBeenCalled();
  await fixture.emit(finalOutput(inputId, 'Final results.'));
  expect(physical.get(inputId)).toBe(true);
  expect(genuine.get(inputId)).toBe(true);
  expect(runtime.complete).toHaveBeenCalledOnce();
  expect(fixture.commitCursor).toHaveBeenCalledWith(inputId);
});
