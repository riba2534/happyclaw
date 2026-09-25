import crypto from 'node:crypto';
import fs from 'node:fs';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import {
  channelConversationJid,
  parseChannelAddress,
  scopeChannelJid,
} from '../src/channel-address.js';
import { resolveInputChannelReplySource } from '../src/channel-reply-source.js';
import { channelTurnScope } from '../src/channel-turn-registry.js';
import { getChannelType } from '../src/im-channel.js';
import {
  buildInteractionTextOutboxPayload,
  shouldSendProactiveTailInterruptionNotice,
} from '../src/workspace-interaction-runtime.js';
import { createRuntimeSourceHarness } from './helpers/runtime-source.js';

const paths = vi.hoisted(() => ({ root: '' }));
vi.mock('../src/config.js', async (importOriginal) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  paths.root = fs.mkdtempSync(
    path.join(os.tmpdir(), 'terminal-system-notice-'),
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
const reliability = await import('../src/channel-reliability-store.js');
const { ChannelTurnRuntime } = await import('../src/channel-turn-runtime.js');
const { deliverChannelOutboxItem, DefinitiveChannelDeliveryError } =
  await import('../src/channel-outbox-delivery.js');
const {
  ActiveChannelOutboxScopeRegistry,
  semanticChannelOutboxIdentity,
  stableChannelOutboxOrdinal,
  syntheticChannelProviderAck,
} = await import('../src/channel-outbox-runtime-scope.js');

beforeAll(() => db.initDatabase());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(paths.root, { recursive: true, force: true });
});

const TELEGRAM_JID = scopeChannelJid('telegram:4242', 'tg-bot');

/**
 * Real Web system record, independent notice Turn, scoped Outbox and
 * sendImWithRetry from index.ts. Only the provider connector is faked.
 */
function createNoticeRuntime(imSend: (...args: unknown[]) => Promise<void>) {
  const imManager = { sendMessage: vi.fn(imSend) };
  const advanceCursors = vi.fn();
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  const globals: Record<string, any> = {
    crypto,
    process,
    logger,
    imManager,
    advanceCursors,
    ASSISTANT_NAME: 'Assistant',
    activeChannelOutboxScopes: new ActiveChannelOutboxScopeRegistry(),
    imSendFailCounts: new Map(),
    ChannelTurnRuntime,
    CHANNEL_RELIABILITY_TERMINAL_STATUSES:
      reliability.CHANNEL_RELIABILITY_TERMINAL_STATUSES,
    getChannelTurnRun: reliability.getChannelTurnRun,
    getUncertainChannelOutboxForTurn:
      reliability.getUncertainChannelOutboxForTurn,
    deliverChannelOutboxItem,
    semanticChannelOutboxIdentity,
    stableChannelOutboxOrdinal,
    syntheticChannelProviderAck,
    buildInteractionTextOutboxPayload,
    shouldSendProactiveTailInterruptionNotice,
    resolveInputChannelReplySource,
    channelTurnScope,
    getChannelType,
    parseChannelAddress,
    channelConversationJid,
    getRegisteredGroup: db.getRegisteredGroup,
    ensureChatExists: db.ensureChatExists,
    storeMessageDirect: db.storeMessageDirect,
    broadcastNewMessage: vi.fn(),
    flushAcknowledgedIpcForJid: vi.fn(),
  };
  const harness = createRuntimeSourceHarness(globals);
  for (const name of [
    'sendSystemMessage',
    'resolveDurableChannelRoute',
    'bindChannelOutboxScope',
    'childChannelOutboxRef',
    'ScopedChannelDeliveryError',
    'deliverScopedChannelOutput',
    'sendImWithRetry',
    'deliverIndependentChannelSystemNotice',
    'deliverTerminalFailureNotice',
  ]) {
    harness.install(name);
  }
  return { harness, globals, imManager, advanceCursors, logger };
}

function webSystemMessages(chatJid: string): string[] {
  return db
    .getMessagesPage(chatJid)
    .filter((message) => message.sender === '__system__')
    .map((message) => message.content);
}

function mainLane(input: {
  imSend: (...args: unknown[]) => Promise<void>;
  replySourceImJid?: string | null;
  interactionMode?: 'assistant' | 'proactive';
}) {
  const runtime = createNoticeRuntime(input.imSend);
  const chatJid = `web:terminal-${crypto.randomUUID()}`;
  const inputTurnId = `input-${crypto.randomUUID()}`;
  Object.assign(runtime.globals, {
    chatJid,
    effectiveGroup: { folder: `folder-${crypto.randomUUID()}` },
    interactionMode: input.interactionMode ?? 'assistant',
    replySourceImJid:
      input.replySourceImJid === undefined
        ? TELEGRAM_JID
        : input.replySourceImJid,
    ipcReplyTurnTracker: { inputTurnId, delivered: false },
    lastProcessed: { id: inputTurnId, timestamp: '2026-09-25T00:00:00.000Z' },
    cursorCommittedInputTurns: new Set<string>(),
    proactiveTailNoticesDelivered: new Set<string>(),
    projectCurrentScheduledGroupTerminal: vi.fn(async () => false),
    clearProcessingIndicatorForInput: vi.fn(async () => {}),
  });
  runtime.harness.install('commitCursor', 'processGroupMessages');
  runtime.harness.install('settleDeterministicFailure', 'processGroupMessages');
  return {
    ...runtime,
    chatJid,
    inputTurnId,
    settle: runtime.globals.settleDeterministicFailure as (
      noticeKey: string,
      webType: string,
      text: string,
      scheduledError?: string,
    ) => Promise<boolean>,
  };
}

describe('processGroupMessages deterministic failure settlement', () => {
  test('commits, records Web and sends the channel notice once', async () => {
    const lane = mainLane({ imSend: async () => {} });

    await expect(
      lane.settle('context-overflow', 'context_overflow', 'Context too long'),
    ).resolves.toBe(true);

    expect(lane.advanceCursors).toHaveBeenCalledTimes(1);
    expect(webSystemMessages(lane.chatJid)).toEqual([
      'context_overflow:Context too long',
    ]);
    expect(lane.imManager.sendMessage).toHaveBeenCalledTimes(1);
    expect(lane.imManager.sendMessage).toHaveBeenCalledWith(
      TELEGRAM_JID,
      'Context too long',
      [],
      expect.not.objectContaining({ presentation: 'native' }),
    );
    expect(lane.globals.clearProcessingIndicatorForInput).toHaveBeenCalledWith(
      lane.inputTurnId,
    );
  });

  test('a rejected notice still commits the input and keeps the Web record', async () => {
    const lane = mainLane({
      imSend: async () => {
        throw new DefinitiveChannelDeliveryError('bot was blocked by the user');
      },
    });

    // true resolves the GroupQueue attempt: no backoff replay of the Agent.
    await expect(
      lane.settle(
        'agent-profile-unavailable',
        'system_error',
        'Skill foo is disabled',
      ),
    ).resolves.toBe(true);

    expect(lane.imManager.sendMessage).toHaveBeenCalledTimes(1);
    expect(lane.advanceCursors).toHaveBeenCalledTimes(1);
    expect(lane.globals.cursorCommittedInputTurns.has(lane.inputTurnId)).toBe(
      true,
    );
    expect(webSystemMessages(lane.chatJid)).toEqual([
      'system_error:Skill foo is disabled',
    ]);
    expect(lane.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ noticeKey: 'agent-profile-unavailable' }),
      expect.stringContaining('not delivered'),
    );
  });

  test('a transcript reset after a delivered reply is not replayed when the notice fails', async () => {
    const lane = mainLane({
      imSend: async () => {
        throw new DefinitiveChannelDeliveryError('message thread not found');
      },
    });
    // The input's own Turn already completed with a delivered reply; replaying
    // it would run the Agent again and send a second reply.
    const route = parseChannelAddress(TELEGRAM_JID)!;
    const replyTurn = ChannelTurnRuntime.start({
      provider: route.provider,
      accountId: route.channelAccountId!,
      sourceJid: TELEGRAM_JID,
      chatId: route.externalChatId,
      externalMessageId: lane.inputTurnId,
    });
    expect(replyTurn.markFinalizing() && replyTurn.complete()).toBe(true);
    replyTurn.dispose();

    await expect(
      lane.settle(
        'unrecoverable-transcript',
        'context_reset',
        '会话已自动重置：bad image',
        '无法恢复的会话记录错误：bad image',
      ),
    ).resolves.toBe(true);

    // The independent notice Turn is not blocked by the completed reply Turn.
    expect(lane.imManager.sendMessage).toHaveBeenCalledTimes(1);
    expect(lane.advanceCursors).toHaveBeenCalledTimes(1);
    expect(
      lane.globals.projectCurrentScheduledGroupTerminal,
    ).toHaveBeenCalledWith('failed', '无法恢复的会话记录错误：bad image');
    expect(webSystemMessages(lane.chatJid)).toEqual([
      'context_reset:会话已自动重置：bad image',
    ]);
  });

  test('an unroutable channel (unbound account) settles without a send', async () => {
    const lane = mainLane({
      imSend: async () => {},
      replySourceImJid: 'telegram:legacy-without-account',
    });

    await expect(
      lane.settle('context-budget', 'context_overflow', 'Prompt too large'),
    ).resolves.toBe(true);

    expect(lane.imManager.sendMessage).not.toHaveBeenCalled();
    expect(lane.advanceCursors).toHaveBeenCalledTimes(1);
    expect(webSystemMessages(lane.chatJid)).toEqual([
      'context_overflow:Prompt too large',
    ]);
  });

  test('proactive workspaces send the notice with native presentation', async () => {
    const lane = mainLane({
      imSend: async () => {},
      interactionMode: 'proactive',
    });

    await lane.settle('oom-context-reset', 'context_reset', 'OOM reset');

    expect(lane.imManager.sendMessage).toHaveBeenCalledWith(
      TELEGRAM_JID,
      'OOM reset',
      [],
      expect.objectContaining({ presentation: 'native' }),
    );
  });

  test('a delivered proactive tail notice is not followed by a second channel notice', async () => {
    const lane = mainLane({
      imSend: async () => {},
      interactionMode: 'proactive',
    });
    lane.globals.proactiveTailNoticesDelivered.add(lane.inputTurnId);

    await expect(
      lane.settle('unrecoverable-transcript', 'context_reset', 'reset'),
    ).resolves.toBe(true);

    expect(lane.imManager.sendMessage).not.toHaveBeenCalled();
    expect(webSystemMessages(lane.chatJid)).toEqual(['context_reset:reset']);
    expect(lane.advanceCursors).toHaveBeenCalledTimes(1);
  });
});

describe('processAgentConversation deterministic failure settlement', () => {
  function agentLane(input: {
    imSend: (...args: unknown[]) => Promise<void>;
    interactionMode?: 'assistant' | 'proactive';
  }) {
    const runtime = createNoticeRuntime(input.imSend);
    const virtualChatJid = `web:agent-${crypto.randomUUID()}#agent:session`;
    const inputTurnId = `input-${crypto.randomUUID()}`;
    Object.assign(runtime.globals, {
      virtualChatJid,
      agentId: 'session',
      effectiveGroup: { folder: `folder-${crypto.randomUUID()}` },
      interactionMode: input.interactionMode ?? 'assistant',
      replySourceImJid: TELEGRAM_JID,
      activeAgentInputTurnId: inputTurnId,
      lastProcessed: { id: inputTurnId, timestamp: '2026-09-25T00:00:00.000Z' },
      cursorCommittedInputTurns: new Set<string>(),
      agentDeterministicTerminalError: null,
      agentPhysicalDeliveryAckByInput: new Map<string, boolean>(),
      healthyAgentCompletedInputTurns: new Set<string>(),
      clearAgentProcessingIndicatorForInput: vi.fn(async () => {}),
    });
    for (const name of [
      'isCursorCommitted',
      'commitCursor',
      'settleAgentDeterministicFailure',
    ]) {
      runtime.harness.install(name, 'processAgentConversation');
    }
    return { ...runtime, virtualChatJid, inputTurnId };
  }

  test('a rejected notice still fails the Turn durably and commits', async () => {
    const lane = agentLane({
      imSend: async () => {
        throw new DefinitiveChannelDeliveryError('chat not found');
      },
    });

    await lane.globals.settleAgentDeterministicFailure(
      'unrecoverable-transcript',
      'context_reset',
      '会话已自动重置：bad image',
      'Unrecoverable transcript reset: bad image',
    );

    expect(lane.imManager.sendMessage).toHaveBeenCalledTimes(1);
    expect(lane.advanceCursors).toHaveBeenCalledWith(
      lane.virtualChatJid,
      expect.objectContaining({ id: lane.inputTurnId }),
    );
    // The finally block fails (not retries) the input Turn on this marker.
    expect(lane.globals.agentDeterministicTerminalError).toBe(
      'Unrecoverable transcript reset: bad image',
    );
    expect(webSystemMessages(lane.virtualChatJid)).toEqual([
      'context_reset:会话已自动重置：bad image',
    ]);
  });

  test('the proactive tail notice owns the channel after a delivered utterance', async () => {
    const lane = agentLane({
      imSend: async () => {},
      interactionMode: 'proactive',
    });
    lane.globals.agentPhysicalDeliveryAckByInput.set(lane.inputTurnId, true);

    await lane.globals.settleAgentDeterministicFailure(
      'unrecoverable-transcript',
      'context_reset',
      'reset',
      'Unrecoverable transcript reset: reset',
    );

    expect(lane.imManager.sendMessage).not.toHaveBeenCalled();
    expect(lane.advanceCursors).toHaveBeenCalledTimes(1);
    expect(webSystemMessages(lane.virtualChatJid)).toEqual([
      'context_reset:reset',
    ]);
  });
});

describe('message retry exhaustion notice', () => {
  function exhaustion(imSend: (...args: unknown[]) => Promise<void>) {
    const runtime = createNoticeRuntime(imSend);
    const groupJid = `web:retries-${crypto.randomUUID()}`;
    const group = {
      name: 'Retry fixture',
      folder: `folder-${crypto.randomUUID()}`,
    };
    const messageId = `msg-${crypto.randomUUID()}`;
    db.ensureChatExists(groupJid);
    db.storeMessageDirect(
      messageId,
      groupJid,
      'user-1',
      'User',
      'hello',
      '2026-09-25T00:00:00.000Z',
      false,
      { sourceJid: TELEGRAM_JID },
    );
    Object.assign(runtime.globals, {
      registeredGroups: { [groupJid]: group },
      getAgentBuilderInputMessage: db.getAgentBuilderInputMessage,
      getTaskRunById: db.getTaskRunById,
      resolveScheduledGroupRunsForOutput: () => [],
      projectTerminalScheduledGroupRuns: vi.fn(async () => false),
      resolveEffectiveGroup: (value: unknown) => ({ effectiveGroup: value }),
      resolveTrustedInteractionMode: () => 'assistant',
      clearTrackedProcessingIndicators: vi.fn(async () => {}),
    });
    runtime.harness.installCallArgument(
      'onMaxRetriesExceeded',
      'main',
      'queue.setOnMaxRetriesExceeded',
      0,
    );
    const cursor = { id: messageId, timestamp: '2026-09-25T00:00:00.000Z' };
    return {
      ...runtime,
      groupJid,
      exhaust: () =>
        runtime.globals.onMaxRetriesExceeded(groupJid, {
          coveredCursors: [cursor],
          cursor,
        }) as Promise<void>,
    };
  }

  test('every exhaustion of the same batch reaches the channel', async () => {
    const lane = exhaustion(async () => {});

    await lane.exhaust();
    // The next message can re-run and exhaust the same batch again.
    await lane.exhaust();

    expect(lane.imManager.sendMessage).toHaveBeenCalledTimes(2);
    expect(webSystemMessages(lane.groupJid)).toEqual([
      'agent_max_retries:Retry fixture 处理失败，已达最大重试次数',
      'agent_max_retries:Retry fixture 处理失败，已达最大重试次数',
    ]);
  });

  test('a rejected notice still writes the Web record', async () => {
    const lane = exhaustion(async () => {
      throw new DefinitiveChannelDeliveryError('bot was kicked');
    });

    await expect(lane.exhaust()).resolves.toBeUndefined();

    expect(lane.imManager.sendMessage).toHaveBeenCalledTimes(1);
    expect(webSystemMessages(lane.groupJid)).toEqual([
      'agent_max_retries:Retry fixture 处理失败，已达最大重试次数',
    ]);
    expect(lane.globals.clearTrackedProcessingIndicators).toHaveBeenCalledWith(
      lane.groupJid,
    );
  });
});
