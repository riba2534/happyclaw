import crypto from 'node:crypto';
import fs from 'node:fs';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import { resolveOutputChannelReplySource } from '../src/channel-reply-source.js';
import { channelTurnScope } from '../src/channel-turn-registry.js';
import {
  buildInterruptedReply,
  buildSteeredReply,
  buildStoppedReply,
} from '../src/reply-finalization.js';
import {
  publishesFrameworkAnswer,
  shouldSendProactiveTailInterruptionNotice,
} from '../src/workspace-interaction-runtime.js';
import { createRuntimeSourceHarness } from './helpers/runtime-source.js';

const paths = vi.hoisted(() => ({ root: '' }));
vi.mock('../src/config.js', async (importOriginal) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  paths.root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-steer-persist-'));
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

beforeAll(() => db.initDatabase());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(paths.root, { recursive: true, force: true });
});

/**
 * Runs the real processAgentConversation finally block against the state a
 * conversation-agent run leaves behind (Web-only session, no card).
 */
function agentRunEnd(streamedText: string) {
  const inputTurnId = `input-${crypto.randomUUID()}`;
  const virtualChatJid = `web:steer-${crypto.randomUUID()}#agent:session`;
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const globals: Record<string, any> = {
    crypto,
    logger,
    clearTimeout,
    ASSISTANT_NAME: 'Assistant',
    buildInterruptedReply,
    buildSteeredReply,
    buildStoppedReply,
    publishesFrameworkAnswer,
    shouldSendProactiveTailInterruptionNotice,
    resolveOutputChannelReplySource,
    channelTurnScope,
    ensureChatExists: db.ensureChatExists,
    storeMessageDirect: db.storeMessageDirect,
    broadcastNewMessage: vi.fn(),
    advanceCursors: vi.fn(),
    flushAcknowledgedIpcForJid: vi.fn(),
    updateAgentStatus: vi.fn(),
    broadcastAgentStatus: vi.fn(),
    sendImWithRetry: vi.fn(async () => true),
    extractLocalImImagePaths: () => [],
    unregisterStreamingSession: vi.fn(),
    chatJid: 'web:steer-home',
    virtualChatJid,
    agentId: 'session',
    agent: { kind: 'conversation', name: 'Session', prompt: '' },
    effectiveGroup: { folder: 'steer-fixture' },
    interactionMode: 'assistant',
    lastProcessed: { id: inputTurnId, timestamp: '2026-09-25T00:00:00.000Z' },
    activeAgentInputTurnId: inputTurnId,
    currentAgentSessionId: 'sdk-session',
    initialAgentReplySourceImJid: null,
    idleTimer: null,
    hadError: false,
    lastError: '',
    agentClosed: false,
    runnerClosedBySteer: false,
    agentStreamInterrupted: false,
    agentStreamSteered: false,
    agentInterruptFinalized: false,
    agentStreamingAccText: streamedText,
    agentStreamingSession: undefined,
    streamingSessionJid: undefined,
    agentProviderFailoverPending: false,
    agentDeliveryNeedsManualReconciliation: false,
    agentDefinitiveFailureSettled: false,
    agentDeterministicTerminalError: null,
    retryUnfinishedTurn: false,
    lastAgentReplyText: undefined,
    heldAgentParts: [],
    heldAgentUsage: null,
    cursorCommittedInputTurns: new Set<string>(),
    agentReplySentByInput: new Map<string, boolean>(),
    agentPhysicalDeliveryAckByInput: new Map<string, boolean>(),
    healthyAgentCompletedInputTurns: new Set<string>(),
    admittedWarmAgentInputs: new Map(),
    agentChannelOutboxScopesByInput: new Map(),
    agentChannelTurnRuntimes: new Map(),
    agentTurnOutputCoordinators: new Map(),
    agentAdmissionKey: 'steer-admission',
    agentBuilderScope: 'steer-builder',
    activeHeldCardFinalizers: new Map(),
    activeRouteAdmissions: new Map(),
    activeImReplyRoutes: new Map(),
    activeAgentBuilderTurns: new Map(),
    activeChannelTurns: new Map(),
    ipcWatcherManager: undefined,
  };
  const harness = createRuntimeSourceHarness(globals);
  harness.install('isCursorCommitted', 'processAgentConversation');
  harness.install('commitCursor', 'processAgentConversation');
  harness.installFinally('finishAgentRun', 'processAgentConversation');
  return {
    globals,
    inputTurnId,
    virtualChatJid,
    finish: globals.finishAgentRun as () => Promise<void>,
    partials: () =>
      db
        .getMessagesForTurn(virtualChatJid, inputTurnId)
        .filter((row) => row.source_kind === 'interrupt_partial'),
  };
}

function activeCard(run: ReturnType<typeof agentRunEnd>) {
  const card = {
    isActive: () => true,
    complete: vi.fn(async () => {}),
    abort: vi.fn(async () => {}),
    dispose: vi.fn(),
  };
  run.globals.agentStreamingSession = card;
  run.globals.streamingSessionJid = 'feishu:oc_steer';
  return card;
}

/** State after `Conversation agent close resolved as a clean steer transition`. */
function closeAsSteer(run: ReturnType<typeof agentRunEnd>): void {
  run.globals.runnerClosedBySteer = true;
  run.globals.agentStreamInterrupted = true;
  run.globals.agentStreamSteered = true;
  run.globals.commitCursor(run.inputTurnId);
}

describe('conversation agent steer close persists the superseded partial', () => {
  test('saves the steered partial exactly once', async () => {
    const run = agentRunEnd('Partial answer before the steer');
    const card = activeCard(run);
    closeAsSteer(run);

    await run.finish();

    expect(card.complete).toHaveBeenCalledWith(
      'Partial answer before the steer',
    );
    expect(card.abort).not.toHaveBeenCalled();

    const partials = run.partials();
    expect(partials).toHaveLength(1);
    expect(partials[0]).toMatchObject({
      content: buildSteeredReply('Partial answer before the steer'),
      finalization_reason: 'interrupted',
    });
    expect(run.globals.agentInterruptFinalized).toBe(true);
  });

  test('does not save again when the interrupted status event already did', async () => {
    const run = agentRunEnd('Partial answer before the steer');
    closeAsSteer(run);
    run.globals.agentInterruptFinalized = true;

    await run.finish();

    expect(run.partials()).toEqual([]);
  });

  test('does not duplicate a reply delivered before the steer close', async () => {
    const run = agentRunEnd('Delivered answer');
    run.globals.agentReplySentByInput.set(run.inputTurnId, true);
    closeAsSteer(run);

    await run.finish();

    expect(run.partials()).toEqual([]);
  });
});

describe('conversation agent interrupt after a settled input', () => {
  test('a stop after the reply was delivered and committed saves nothing', async () => {
    // The reply was persisted and delivered; the status-event handler skipped
    // the late interrupt because the cursor was already committed.
    const run = agentRunEnd('Delivered answer');
    const card = activeCard(run);
    run.globals.agentReplySentByInput.set(run.inputTurnId, true);
    run.globals.commitCursor(run.inputTurnId);
    run.globals.agentStreamInterrupted = true;

    await run.finish();

    expect(run.partials()).toEqual([]);
    // A settled input's leftover card is disposed, not restyled as stopped.
    expect(card.abort).not.toHaveBeenCalled();
    expect(card.dispose).toHaveBeenCalled();
  });

  test('an unsettled stop is saved once, not again by the crash fallback', async () => {
    const run = agentRunEnd('Partial answer before the stop');
    run.globals.agentStreamInterrupted = true;

    await run.finish();

    const partials = run.partials();
    expect(partials).toHaveLength(1);
    expect(partials[0]).toMatchObject({
      content: buildStoppedReply('Partial answer before the stop'),
      finalization_reason: 'interrupted',
    });
  });
});
