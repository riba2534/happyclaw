/**
 * Real-source regression tests for UF-1076:
 * In processAgentConversation (cold start), while toSend still has pending work,
 * advancing next_pull for a later plugin reply (sequence >= min(toSend.sequence))
 * pushes getMessagesSince past an earlier undelivered user message if the turn
 * fails before committing. Defer those reply cursors until after toSend settles.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'uf-1076-cold-cursor-'));
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
const { agentBuilderTurnScope } =
  await import('../src/agent-builder-turn-auth.js');
const { channelConversationJid } = await import('../src/channel-address.js');
const channelInteraction = await import('../src/channel-interaction-mode.js');
const { selectChannelReplyBatch } =
  await import('../src/channel-reply-source.js');
const { resolveScheduledGroupDeliveryContract } =
  await import('../src/reply-delivery.js');
const interactionRuntime =
  await import('../src/workspace-interaction-runtime.js');
const { DeferredOutOfBandCursorLedger, hasEarlierCursorMessage } =
  await import('../src/delivery-cursor.js');
const { createRuntimeSourceHarness } =
  await import('./helpers/runtime-source.js');

import type { MessageCursor, NewMessage } from '../src/types.js';

const EMPTY_CURSOR: MessageCursor = { timestamp: '', id: '', sequence: 0 };

beforeAll(() => {
  db.initDatabase();
});

afterAll(() => {
  db.closeDatabase();
  fs.rmSync(tmp, { recursive: true, force: true });
});

let seqCounter = 0;
function seedInbound(chatJid: string, id: string, content: string): NewMessage {
  seqCounter += 1;
  const ts = new Date(
    Date.parse('2026-10-12T09:00:00.000Z') + seqCounter * 1000,
  ).toISOString();
  db.storeMessageDirect(id, chatJid, 'user-1', 'User', content, ts, false);
  const rows = db.getMessagesSince(
    chatJid,
    { timestamp: '', id: '', sequence: 0 },
    'Bot',
  );
  return rows.find((m) => m.id === id)!;
}

function buildColdStartHost(opts: {
  baseChatJid: string;
  agentId: string;
  billingAnswered: boolean;
}) {
  const virtualChatJid = `${opts.baseChatJid}#agent:${opts.agentId}`;
  const lastAgentTimestamp: Record<string, MessageCursor> = {};
  const lastCommittedCursor: Record<string, MessageCursor> = {};
  const deferredOutOfBandCursors = new DeferredOutOfBandCursorLedger();

  const queue = {
    enqueueTask: vi.fn(),
    setMessageRetrySnapshot: vi.fn(),
    getActiveQueryId: vi.fn(() => 'run-cold-1'),
    setCurrentQueryCoverage: vi.fn(),
  };

  const globals: Record<string, unknown> = {
    ...interactionRuntime,
    ...channelInteraction,
    channelConversationJid,
    selectChannelReplyBatch,
    resolveScheduledGroupDeliveryContract,
    agentBuilderTurnScope,
    ASSISTANT_NAME: 'Bot',
    EMPTY_CURSOR,
    queue,
    lastAgentTimestamp,
    lastCommittedCursor,
    deferredOutOfBandCursors,
    routerCursorPersistence: { markDirty: vi.fn() },
    saveState: vi.fn(),
    flushAcknowledgedIpcForJid: vi.fn(),
    getChannelType,
    hasEarlierCursorMessage,
    resolveMessageCursorSequence: db.resolveMessageCursorSequence,
    getMessagesSince: (jid: string, cursor: MessageCursor) =>
      db.getMessagesSince(jid, cursor, 'Bot'),
    getMessagesSinceBounded: db.getMessagesSinceBounded,
    registeredGroups: {
      [opts.baseChatJid]: {
        folder: 'main',
        name: 'main',
        executionMode: 'host',
      },
    },
    resolveEffectiveGroup: (group: unknown) => ({ effectiveGroup: group }),
    getRegisteredGroup: () => undefined,
    getAgent: (id: string) =>
      id === opts.agentId
        ? { id, kind: 'conversation', status: 'idle', name: id }
        : undefined,
    getUserById: () => undefined,
    getWorkspaceInteractionMode: () => 'assistant',
    getChannelMount: () => undefined,
    releaseUsageLimitWaitForNewInput: () => false,
    getUsageLimitWait: () => null,
    buildExpandContext: vi.fn(() => ({ groupFolder: 'main' })),
    persistPluginExpansion: vi.fn(),
    expandMessagesIfNeeded: vi.fn(async (messages: NewMessage[]) => ({
      toSend: messages.filter((m) => !m.content.startsWith('/')),
      replies: messages
        .filter((m) => m.content.startsWith('/'))
        .map((m) => ({ originalMsg: m, text: `reply:${m.content}` })),
    })),
    sendPluginExpanderReply: vi.fn(async () => ({ acknowledged: true })),
    clearStandaloneProcessingIndicator: vi.fn(async () => undefined),
    clearStandaloneProcessingIndicatorsForMessages: vi.fn(
      async () => undefined,
    ),
    learnDirectMessageOwners: vi.fn(),
    billingDeniedNoticeOf: vi.fn(() => 'quota exceeded'),
    resolveBatchChannelReplySource: vi.fn(() => null),
    answerSessionBatchWithBillingNotice: vi.fn(
      async () => opts.billingAnswered,
    ),
    updateAgentStatus: vi.fn(),
    broadcastAgentStatus: vi.fn(),
    activeAgentBuilderTurns: { startBatch: vi.fn() },
    automationRunIdOf: () => undefined,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };

  const harness = createRuntimeSourceHarness(globals);
  for (const name of [
    'isCursorAfter',
    'resolveTrustedInteractionMode',
    'selectRuntimeInteractionBatch',
    'advanceNextPullCursorOnly',
    'advanceCursors',
    'hasEarlierPendingMessage',
    'flushDeferredOutOfBandMessages',
    'completeOutOfBandMessage',
    'completeOutOfBandMessages',
    'createIpcDeliveryTarget',
    'processAgentConversation',
  ]) {
    harness.install(name);
  }

  return {
    virtualChatJid,
    globals,
    lastAgentTimestamp,
    lastCommittedCursor,
    runColdStart: () =>
      (
        globals.processAgentConversation as (
          chatJid: string,
          agentId: string,
        ) => Promise<boolean | undefined>
      )(opts.baseChatJid, opts.agentId),
  };
}

describe('UF-1076: defer cold-start plugin-reply next_pull past pending toSend', () => {
  test('unsettled turn after later plugin reply keeps next_pull before earlier toSend message', async () => {
    const baseChatJid = 'web:test-1076-1';
    const agentId = 'a1';
    const virtualChatJid = `${baseChatJid}#agent:${agentId}`;
    db.ensureChatExists(virtualChatJid);
    const mUser = seedInbound(virtualChatJid, 'u1076-user', 'hello');
    seedInbound(virtualChatJid, 'u1076-cmd', '/help');

    const host = buildColdStartHost({
      baseChatJid,
      agentId,
      billingAnswered: false,
    });
    const ok = await host.runColdStart();

    expect(ok).toBe(false);
    expect(host.globals.sendPluginExpanderReply).toHaveBeenCalledTimes(1);
    // Critical invariant: next_pull must NOT jump to /help past undelivered mUser!
    expect(host.lastAgentTimestamp[virtualChatJid]).toBeUndefined();

    // Subsequent warm or cold pull using lastAgentTimestamp still sees mUser.
    const nextPull = db.getMessagesSince(
      virtualChatJid,
      host.lastAgentTimestamp[virtualChatJid] ?? EMPTY_CURSOR,
      'Bot',
    );
    expect(nextPull.map((m) => m.id)).toContain(mUser.id);
  });

  test('earlier reply (< minToSendSeq) advances next_pull immediately, later reply (>= minToSendSeq) stays deferred until settled', async () => {
    const baseChatJid = 'web:test-1076-2';
    const agentId = 'a1';
    const virtualChatJid = `${baseChatJid}#agent:${agentId}`;
    db.ensureChatExists(virtualChatJid);
    const mEarly = seedInbound(virtualChatJid, 'u1076-early', '/ping');
    const mUser = seedInbound(virtualChatJid, 'u1076-mid', 'hello');
    seedInbound(virtualChatJid, 'u1076-late', '/pong');

    const host = buildColdStartHost({
      baseChatJid,
      agentId,
      billingAnswered: false,
    });
    const ok = await host.runColdStart();

    expect(ok).toBe(false);
    // Earlier reply (seq < minToSendSeq) advanced next_pull to mEarly,
    // while later reply (seq >= minToSendSeq) stayed deferred.
    expect(host.lastAgentTimestamp[virtualChatJid]?.id).toBe(mEarly.id);

    const nextPull = db.getMessagesSince(
      virtualChatJid,
      host.lastAgentTimestamp[virtualChatJid] ?? EMPTY_CURSOR,
      'Bot',
    );
    expect(nextPull.map((m) => m.id)).toContain(mUser.id);
    expect(nextPull.map((m) => m.id)).not.toContain(mEarly.id);
  });

  test('settled turn flushes deferred reply next_pull cursor after toSend is answered', async () => {
    const baseChatJid = 'web:test-1076-3';
    const agentId = 'a1';
    const virtualChatJid = `${baseChatJid}#agent:${agentId}`;
    db.ensureChatExists(virtualChatJid);
    seedInbound(virtualChatJid, 'u1076-s-user', 'hello');
    const mCmd = seedInbound(virtualChatJid, 'u1076-s-cmd', '/help');

    const host = buildColdStartHost({
      baseChatJid,
      agentId,
      billingAnswered: true,
    });
    const ok = await host.runColdStart();

    expect(ok).toBe(true);
    expect(host.lastAgentTimestamp[virtualChatJid]?.id).toBe(mCmd.id);
  });

  test('toSend empty: reply completes immediately via completeOutOfBandMessage', async () => {
    const baseChatJid = 'web:test-1076-4';
    const agentId = 'a1';
    const virtualChatJid = `${baseChatJid}#agent:${agentId}`;
    db.ensureChatExists(virtualChatJid);
    const mOnlyCmd = seedInbound(virtualChatJid, 'u1076-only-cmd', '/status');

    const host = buildColdStartHost({
      baseChatJid,
      agentId,
      billingAnswered: false,
    });
    await host.runColdStart();

    expect(host.lastAgentTimestamp[virtualChatJid]?.id).toBe(mOnlyCmd.id);
    expect(host.lastCommittedCursor[virtualChatJid]?.id).toBe(mOnlyCmd.id);
  });
});
