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
  shouldSkipRetryAfterLateError,
  wasGenuineReplyDeliveredForInput,
} from '../src/reply-delivery.js';
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
const { ProactiveProgressCarry, TurnTraceTracker } =
  await import('../src/turn-trace.js');
const { proactiveClosingNote } =
  await import('../src/workspace-interaction-runtime.js');
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
    FEISHU_UNCERTAIN_REPLAY_DELAY_MS: 0,
    FEISHU_OUTBOX_LEASE_MS: 120_000,
    rememberChannelOutboxFailure: () => ({}),
    hasDeliveredChannelImageWithContentHash:
      reliability.hasDeliveredChannelImageWithContentHash,
  };
  const harness = createRuntimeSourceHarness(globals);
  for (const name of [
    'sendSystemMessage',
    'resolveDurableChannelRoute',
    'bindChannelOutboxScope',
    'childChannelOutboxRef',
    'isLogicalSessionSendTarget',
    'imageAlreadyDeliveredInTurn',
    'turnInputAnchorOptions',
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
    agentConfigFailureSettled: false,
    retryUnfinishedTurn: true,
    chatJid: virtualChatJid,
    agentPhysicalDeliveryAckByInput: new Map<string, boolean>(),
    healthyAgentCompletedInputTurns: new Set<string>(),
    clearAgentProcessingIndicatorForInput: vi.fn(async () => {}),
  });
  for (const name of [
    'isCursorCommitted',
    'commitCursor',
    'settleAgentDeterministicFailure',
    'settleAgentConfigFailure',
  ]) {
    runtime.harness.install(name, 'processAgentConversation');
  }
  return { ...runtime, virtualChatJid, inputTurnId };
}

describe('processAgentConversation deterministic failure settlement', () => {
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

  test('an unavailable model connection is a configuration error: told, committed, not replayed', async () => {
    const lane = agentLane({
      imSend: async () => {},
      interactionMode: 'proactive',
    });

    expect(
      await lane.globals.settleAgentConfigFailure('upstream 529 overloaded'),
    ).toBe(false);
    expect(lane.advanceCursors).not.toHaveBeenCalled();

    expect(
      await lane.globals.settleAgentConfigFailure(
        'agent_profile_unavailable: 智能体绑定的模型连接已删除或缺少凭据，请在智能体页重新选择',
      ),
    ).toBe(true);
    expect(lane.globals.retryUnfinishedTurn).toBe(false);
    expect(lane.advanceCursors).toHaveBeenCalledTimes(1);
    expect(lane.globals.agentDeterministicTerminalError).toBe(
      '智能体绑定的模型连接已删除或缺少凭据，请在智能体页重新选择',
    );
    expect(webSystemMessages(lane.virtualChatJid)).toEqual([
      'system_error:智能体绑定的模型连接已删除或缺少凭据，请在智能体页重新选择',
    ]);
    expect(lane.imManager.sendMessage).toHaveBeenCalledTimes(1);
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
  test('proactive sessions send the notice with native presentation', async () => {
    const lane = agentLane({
      imSend: async () => {},
      interactionMode: 'proactive',
    });

    await lane.globals.settleAgentDeterministicFailure(
      'oom-context-reset',
      'context_reset',
      'OOM reset',
      'OOM reset',
    );

    expect(lane.imManager.sendMessage).toHaveBeenCalledWith(
      TELEGRAM_JID,
      'OOM reset',
      [],
      expect.objectContaining({ presentation: 'native' }),
    );
  });

  test('an unroutable channel (unbound account) settles without a send', async () => {
    const lane = agentLane({ imSend: async () => {} });
    lane.globals.replySourceImJid = 'telegram:legacy-without-account';

    await lane.globals.settleAgentDeterministicFailure(
      'context-budget',
      'context_overflow',
      'Prompt too large',
      'Prompt too large',
    );

    expect(lane.imManager.sendMessage).not.toHaveBeenCalled();
    expect(lane.advanceCursors).toHaveBeenCalledTimes(1);
    expect(webSystemMessages(lane.virtualChatJid)).toEqual([
      'context_overflow:Prompt too large',
    ]);
  });
});

describe('processAgentConversation error exits (Assistant mode)', () => {
  test('the lane takes the retry decision from the error exit', () => {
    const source = fs.readFileSync('src/index.ts', 'utf8');
    const lane = source.slice(
      source.indexOf('async function processAgentConversation('),
      source.indexOf('async function startRunnerSupervisor('),
    );
    expect(lane).toMatch(
      /\) \{\n\s+retryUnfinishedTurn = await settleAgentErrorExit\(\n\s+output\.error \|\| lastError \|\| '未知错误',\n\s+\);\n\s+\} else if \(!errorExit\) \{\n\s+clearSessionOomExits\(oomKey\);/,
    );
    // A retried turn is reported as not done, so the queue runs it again.
    expect(lane).toMatch(/\n {2}return !retryUnfinishedTurn;\n\}/);
  });

  function errorLane(options: { retryCount?: number; stopped?: boolean } = {}) {
    const lane = agentLane({ imSend: async () => {} });
    const queue = {
      isRecentlyStopped: () => options.stopped === true,
      willRetryAfterFailure: () => (options.retryCount ?? 0) < 5,
      getRetryCount: () => options.retryCount ?? 0,
    };
    Object.assign(lane.globals, {
      queue,
      virtualJid: lane.virtualChatJid,
      currentAgentSessionId: 'sdk-session',
      agentGenuineReplyDeliveredByInput: new Map<string, boolean>(),
      agentIpcReplyTracker: { inputTurnId: lane.inputTurnId, delivered: false },
      broadcastStreamEvent: vi.fn(),
      shouldSkipRetryAfterLateError,
      wasGenuineReplyDeliveredForInput,
      clearSessionRuntimeFiles: vi.fn(async () => {}),
      deleteSession: vi.fn(),
      OOM_EXIT_RE: /code 137/,
      OOM_AUTO_RESET_THRESHOLD: 2,
      consecutiveOomExits: {},
      oomKey: 'folder#session',
      setRouterState: db.setRouterState,
      deleteRouterState: db.deleteRouterState,
    });
    lane.harness.install('recordSessionOomExit');
    lane.harness.install('clearSessionOomExits');
    lane.harness.install('settleAgentErrorExit', 'processAgentConversation');
    const exit = (error: string) =>
      lane.globals.settleAgentErrorExit(error) as Promise<boolean>;
    return { ...lane, exit };
  }

  test('a failure with no reply retries quietly while retries remain', async () => {
    const lane = errorLane();

    await expect(lane.exit('upstream 500')).resolves.toBe(true);

    expect(lane.advanceCursors).not.toHaveBeenCalled();
    expect(webSystemMessages(lane.virtualChatJid)).toEqual([]);
    // The Web stops waiting during the backoff.
    expect(lane.globals.broadcastStreamEvent).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ eventType: 'status', statusText: 'idle' }),
      'session',
    );
  });

  test('the last attempt tells the session about the error and still retries', async () => {
    const lane = errorLane({ retryCount: 5 });

    await expect(lane.exit('upstream 500')).resolves.toBe(true);

    expect(webSystemMessages(lane.virtualChatJid)).toEqual([
      'agent_error:upstream 500',
    ]);
    expect(lane.advanceCursors).not.toHaveBeenCalled();
  });

  test('a late error after a delivered answer commits instead of answering twice', async () => {
    for (const via of ['final', 'send_message'] as const) {
      const lane = errorLane();
      if (via === 'final') {
        lane.globals.agentGenuineReplyDeliveredByInput.set(
          lane.inputTurnId,
          true,
        );
      } else {
        lane.globals.agentIpcReplyTracker.delivered = true;
      }

      await expect(lane.exit('runner exited'), via).resolves.toBe(false);

      expect(lane.advanceCursors, via).toHaveBeenCalledTimes(1);
      expect(webSystemMessages(lane.virtualChatJid), via).toEqual([]);
    }
  });

  test('prompt budget and context overflow settle once and never replay', async () => {
    for (const [error, notice] of [
      ['context_budget_exceeded: 提示词过大', 'context_overflow:提示词过大'],
      ['prompt_plan_invalid: 计划无效', 'context_overflow:计划无效'],
      ['context_overflow: 上下文太长', 'context_overflow:上下文太长'],
    ] as const) {
      const lane = errorLane();

      await expect(lane.exit(error), error).resolves.toBe(false);

      expect(lane.advanceCursors, error).toHaveBeenCalledTimes(1);
      expect(webSystemMessages(lane.virtualChatJid), error).toEqual([notice]);
      expect(lane.globals.agentDeterministicTerminalError, error).toBeTruthy();
    }
  });

  test('two consecutive OOM kills reset the session; a user stop does not count', async () => {
    const lane = errorLane();
    await expect(lane.exit('Container exited with code 137')).resolves.toBe(
      true,
    );
    expect(lane.globals.deleteSession).not.toHaveBeenCalled();

    await expect(lane.exit('Container exited with code 137')).resolves.toBe(
      false,
    );
    expect(lane.globals.clearSessionRuntimeFiles).toHaveBeenCalledWith(
      lane.globals.effectiveGroup.folder,
      'session',
    );
    expect(lane.globals.deleteSession).toHaveBeenCalledWith(
      lane.globals.effectiveGroup.folder,
      'session',
    );
    expect(webSystemMessages(lane.virtualChatJid)).toEqual([
      'context_reset:会话文件过大导致内存溢出（OOM），已自动重置会话。之前的对话上下文已清除，请重新描述您的需求。',
    ]);

    const stopped = errorLane({ stopped: true });
    await stopped.exit('Container exited with code 137');
    await stopped.exit('Container exited with code 137');
    expect(stopped.globals.deleteSession).not.toHaveBeenCalled();
  });
});

describe('message retry exhaustion notice', () => {
  function exhaustion(imSend: (...args: unknown[]) => Promise<void>) {
    const runtime = createNoticeRuntime(imSend);
    const workspaceJid = `web:retries-${crypto.randomUUID()}`;
    const groupJid = `${workspaceJid}#agent:retry-session`;
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
      registeredGroups: { [workspaceJid]: group },
      stripVirtualJidSuffix: (jid: string) => jid.split('#agent:')[0],
      getAgent: (id: string) =>
        id === 'retry-session'
          ? { id, name: 'Retry session', chat_jid: workspaceJid }
          : undefined,
      settleAutomationRun: vi.fn(),
      automationRunIdOf: () => null,
      getAgentBuilderInputMessage: db.getAgentBuilderInputMessage,
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
      'agent_max_retries:Retry session 处理失败，已达最大重试次数',
      'agent_max_retries:Retry session 处理失败，已达最大重试次数',
    ]);
  });

  test('a rejected notice still writes the Web record', async () => {
    const lane = exhaustion(async () => {
      throw new DefinitiveChannelDeliveryError('bot was kicked');
    });

    await expect(lane.exhaust()).resolves.toBeUndefined();

    expect(lane.imManager.sendMessage).toHaveBeenCalledTimes(1);
    expect(webSystemMessages(lane.groupJid)).toEqual([
      'agent_max_retries:Retry session 处理失败，已达最大重试次数',
    ]);
    expect(lane.globals.clearTrackedProcessingIndicators).toHaveBeenCalledWith(
      lane.groupJid,
    );
  });
});
