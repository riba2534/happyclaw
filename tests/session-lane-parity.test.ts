/**
 * What only the old main session used to get now holds for every session,
 * and a migrated main session (an `agents` row with source_kind
 * `legacy_main`) runs like any other: billing gates, the per-user runner
 * limit, /sw origins, plugin replies, IM reply routing, Agent Builder in Home
 * and startup recovery, all through the production functions.
 */
import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';

import { getAgentBuilderRuntimeRejection } from '../src/agent-builder-turn-auth.js';
import {
  buildWorkspaceMountUpdate,
  isNativeContextContainer,
} from '../src/channel-mount-service.js';
import {
  buildNativeThreadRouteJid,
  resolveNativeThreadContext,
} from '../src/channel-native-context.js';
import { ActiveChannelOutboxScopeRegistry } from '../src/channel-outbox-runtime-scope.js';
import { channelTurnScope } from '../src/channel-turn-registry.js';
import {
  resolveBoundChatTarget,
  resolveSessionTarget,
} from '../src/im-command-utils.js';
import { agentIdOfJid, stripVirtualJidSuffix } from '../src/utils.js';
import type { NewMessage, SubAgent } from '../src/types.js';
import { createConversationLoop } from './helpers/conversation-loop.js';
import { createRuntimeSourceHarness } from './helpers/runtime-source.js';

const paths = vi.hoisted(() => ({ root: '' }));
vi.mock('../src/config.js', async (importOriginal) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  paths.root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-lane-parity-'));
  for (const dir of ['store', 'groups', 'data']) {
    fs.mkdirSync(path.join(paths.root, dir), { recursive: true });
  }
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

const HOME = 'web:parity-home';
const FOLDER = 'parity-home';
const OWNER = 'parity-owner';
/** The session the migration made from the old main session. */
const LEGACY = '0b9e8f7a-6d5c-4b4a-9c3d-2e1f0a9b8c7d';
const LANE = `${HOME}#agent:${LEGACY}`;
const UNBOUND = '本聊天未绑定会话。';
const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

const legacyRow = (): SubAgent => ({
  id: LEGACY,
  group_folder: FOLDER,
  chat_jid: HOME,
  name: '主会话',
  prompt: '',
  status: 'idle',
  kind: 'conversation',
  created_by: OWNER,
  created_at: '2026-10-01T00:00:00.000Z',
  completed_at: null,
  result_summary: null,
  last_im_jid: null,
  spawned_from_jid: null,
  source_kind: 'legacy_main',
  title_source: 'auto',
});
const home = {
  name: 'Home',
  folder: FOLDER,
  is_home: true,
  created_by: OWNER,
  executionMode: 'host',
};

beforeAll(() => db.initDatabase());
afterAll(() => {
  db.closeDatabase();
  fs.rmSync(paths.root, { recursive: true, force: true });
});

function inbound(id: string, content: string, sourceJid?: string): void {
  db.ensureChatExists(LANE);
  db.storeMessageDirect(
    id,
    LANE,
    'owner',
    'Owner',
    content,
    new Date().toISOString(),
    false,
    sourceJid ? { sourceJid } : undefined,
  );
}

/** Thrown where a turn would start running: everything before it is gating. */
const TURN_STARTS = Symbol('turn-starts');

/** The production session lane up to where its turn would start. */
function coldLane(overrides: Record<string, unknown>) {
  const trackers: Array<{ settleAll: ReturnType<typeof vi.fn> }> = [];
  const loop = createConversationLoop({
    chatJid: HOME,
    agentId: LEGACY,
    folder: FOLDER,
    globals: {
      getMessagesSinceBounded: db.getMessagesSinceBounded,
      releaseUsageLimitWaitForNewInput: () => false,
      getUsageLimitWait: () => null,
      getMessagesSince: db.getMessagesSince,
      resolveMessageCursorSequence: db.resolveMessageCursorSequence,
      routerCursorPersistence: { markDirty: vi.fn() },
      saveState: vi.fn(),
      flushAcknowledgedIpcForJid: vi.fn(),
      getAgent: (id: string) => (id === LEGACY ? legacyRow() : undefined),
      registeredGroups: { [HOME]: home },
      getUserById: (id: string) => ({ id, role: 'member', status: 'active' }),
      checkOwnerActive: () => ({ allowed: true }),
      buildExpandContext: () => null,
      learnDirectMessageOwners: vi.fn(),
      billingDeniedNoticeOf: () => null,
      answerSessionBatchWithBillingNotice: vi.fn(async () => true),
      resolveBatchChannelReplySource: () => null,
      // The production lane makes one tracker per run.
      AutomationTurnTracker: class {
        settleAll = vi.fn();
        remember = vi.fn();
        constructor() {
          trackers.push(this);
        }
        holdReplyRoute(_id: string, _messages: unknown, route: unknown) {
          return route ?? null;
        }
      },
      UNSETTLED_RUN_OUTCOME: { status: 'failed', error: 'unsettled' },
      activeAgentBuilderTurns: {
        startBatch: vi.fn(() => {
          throw TURN_STARTS;
        }),
      },
      updateAgentStatus: vi.fn(),
      broadcastAgentStatus: vi.fn(),
      ...overrides,
    },
  });
  // Past input selection: no IPC coverage to record for a cold start.
  loop.globals.createIpcDeliveryTarget = () => null;
  return {
    ...loop,
    trackers,
    async run(): Promise<'answered' | 'turn' | unknown> {
      try {
        return await loop.globals.processAgentConversation(HOME, LEGACY);
      } catch (err) {
        if (err === TURN_STARTS) return 'turn';
        throw err;
      }
    },
  };
}

describe('a migrated main session in Home, cold', () => {
  test('an owner out of quota gets the billing notice and no turn', async () => {
    inbound('quota-1', 'hello', 'feishu:oc_parity');
    const lane = coldLane({
      billingDeniedNoticeOf: (owner: string) =>
        owner === OWNER ? '余额不足' : null,
      resolveBatchChannelReplySource: () => 'feishu:oc_parity',
    });
    expect(await lane.run()).toBe(true);
    const g = lane.globals;
    expect(g.answerSessionBatchWithBillingNotice).toHaveBeenCalledWith(
      expect.objectContaining({
        laneJid: LANE,
        folder: FOLDER,
        agentId: LEGACY,
        text: '余额不足',
        replySourceImJid: 'feishu:oc_parity',
        messages: [expect.objectContaining({ id: 'quota-1' })],
      }),
    );
    expect(g.learnDirectMessageOwners).toHaveBeenCalledWith(OWNER, [
      expect.objectContaining({ id: 'quota-1' }),
    ]);
    // Automation runs the batch carried end with it.
    expect(lane.trackers[0].settleAll).toHaveBeenCalledOnce();
    expect(g.activeAgentBuilderTurns.startBatch).not.toHaveBeenCalled();
    expect(g.updateAgentStatus).not.toHaveBeenCalledWith(LEGACY, 'running');
  });

  test('a notice the channel did not take keeps the input for a retry', async () => {
    const lane = coldLane({
      billingDeniedNoticeOf: () => '余额不足',
      answerSessionBatchWithBillingNotice: vi.fn(async () => false),
    });
    expect(await lane.run()).toBe(false);
    expect(lane.trackers[0].settleAll).not.toHaveBeenCalled();
  });

  test('with quota the turn starts', async () => {
    const lane = coldLane({});
    expect(await lane.run()).toBe('turn');
    expect(
      lane.globals.answerSessionBatchWithBillingNotice,
    ).not.toHaveBeenCalled();
  });

  test('a plugin command is answered on the session lane', async () => {
    db.ensureChatExists(LANE);
    const commandId = 'plugin-1';
    inbound(commandId, '/inline', 'feishu:oc_parity');
    const sent: unknown[][] = [];
    const lane = coldLane({
      buildExpandContext: (
        jid: string,
        _g: unknown,
        _u: unknown,
        agentId: string,
      ) => ({ jid, agentId }),
      expandMessagesIfNeeded: async (messages: NewMessage[]) => ({
        toSend: [],
        replies: messages
          .filter((m) => m.content === '/inline')
          .map((originalMsg) => ({ originalMsg, text: 'Inline result' })),
      }),
      persistPluginExpansion: vi.fn(),
      getChannelType: (jid: string) =>
        jid.startsWith('feishu:') ? 'feishu' : null,
      sendPluginExpanderReply: vi.fn(async (...args: unknown[]) => {
        sent.push(args);
        return { acknowledged: true };
      }),
      clearStandaloneProcessingIndicator: vi.fn(async () => {}),
      completeOutOfBandMessage: vi.fn(),
      advanceNextPullCursorOnly: vi.fn(),
    });
    await lane.run();
    expect(sent).toContainEqual([
      LANE,
      'Inline result',
      expect.objectContaining({
        agentId: LEGACY,
        groupFolder: FOLDER,
        imRouteJid: 'feishu:oc_parity',
        originalMessageId: commandId,
      }),
    ]);
    expect(lane.globals.completeOutOfBandMessage).toHaveBeenCalledWith(
      LANE,
      expect.objectContaining({ id: commandId }),
    );
  });
});

describe('a warm session admits input the way a cold one does', () => {
  function admission(overrides: Record<string, unknown> = {}) {
    const globals: Record<string, any> = {
      logger,
      getUserById: (id: string) => ({ id, status: 'active' }),
      checkOwnerActive: (user: { status: string }) => ({
        allowed: user?.status === 'active',
      }),
      completeOutOfBandMessages: vi.fn(),
      clearStandaloneProcessingIndicatorsForMessages: vi.fn(async () => {}),
      learnDirectMessageOwners: vi.fn(),
      billingDeniedNoticeOf: () => null,
      answerSessionBatchWithBillingNotice: vi.fn(async () => false),
      resolveBatchChannelReplySource: () => 'feishu:oc_parity',
      queue: { enqueueTask: vi.fn() },
      processAgentConversation: vi.fn(),
      agentIdOfJid,
      getAgent: (id: string) => (id === LEGACY ? legacyRow() : undefined),
      ...overrides,
    };
    const harness = createRuntimeSourceHarness(globals);
    harness.install('admitWarmSessionInputs');
    harness.install('enqueueSessionLane');
    const messages = [{ id: 'warm-1' }] as NewMessage[];
    const admit = () =>
      globals.admitWarmSessionInputs({
        workspaceJid: HOME,
        agentId: LEGACY,
        folder: FOLDER,
        ownerId: OWNER,
        teamLane: false,
        messages,
      });
    return { globals, admit, messages };
  }

  test('with quota the input joins the running turn', () => {
    const { globals, admit, messages } = admission();
    expect(admit()).toBe(true);
    expect(globals.learnDirectMessageOwners).toHaveBeenCalledWith(
      OWNER,
      messages,
    );
  });

  test('out of quota it is answered with the notice, and retried when the notice did not land', async () => {
    const { globals, admit, messages } = admission({
      billingDeniedNoticeOf: () => '余额不足',
    });
    expect(admit()).toBe(false);
    expect(globals.answerSessionBatchWithBillingNotice).toHaveBeenCalledWith({
      laneJid: LANE,
      folder: FOLDER,
      agentId: LEGACY,
      text: '余额不足',
      messages,
      replySourceImJid: 'feishu:oc_parity',
    });
    await vi.waitFor(() =>
      expect(globals.queue.enqueueTask).toHaveBeenCalledWith(
        LANE,
        `agent-channel-next:${LEGACY}`,
        expect.any(Function),
      ),
    );
  });

  test("an inactive owner's input is dropped", () => {
    const { globals, admit, messages } = admission({
      getUserById: (id: string) => ({ id, status: 'disabled' }),
    });
    expect(admit()).toBe(false);
    expect(globals.completeOutOfBandMessages).toHaveBeenCalledWith(
      LANE,
      messages,
    );
    expect(globals.answerSessionBatchWithBillingNotice).not.toHaveBeenCalled();
  });
});

describe("billing's per-user runner limit", () => {
  function limit(perUser: number) {
    const globals: Record<string, any> = {
      stripVirtualJidSuffix,
      registeredGroups: {
        'web:a': { created_by: 'u1' },
        'web:b': { created_by: 'u1' },
        'web:c': { created_by: 'u2' },
      },
      getRegisteredGroup: () => undefined,
      isBillingEnabled: () => true,
      getUserById: (id: string) => ({ id, role: 'member' }),
      getUserConcurrentContainerLimit: () => perUser,
      // web:b#agent:s3 is idle: not counted.
      queue: {
        activeLaneJids: () =>
          ['web:a#agent:s1', 'web:a#agent:s2', 'web:c#agent:s4'].values(),
      },
    };
    createRuntimeSourceHarness(globals).install('checkOwnerConcurrentLimit');
    return globals.checkOwnerConcurrentLimit as (jid: string) => {
      allowed: boolean;
      userId: string | null;
    };
  }

  test('counts every running session of the owner, two in one workspace included', () => {
    expect(limit(2)('web:b#agent:s5')).toEqual({
      allowed: false,
      userId: 'u1',
    });
    expect(limit(3)('web:b#agent:s5')).toEqual({ allowed: true, userId: 'u1' });
    // Another owner's sessions are not counted against u1, nor u1's against u2.
    expect(limit(2)('web:c#agent:s6')).toEqual({ allowed: true, userId: 'u2' });
  });
});

describe('/sw starts from the session the command came from', () => {
  const sessions: Record<string, Partial<SubAgent>> = {
    [LEGACY]: legacyRow(),
    topic1: { id: 'topic1', chat_jid: HOME, kind: 'conversation' },
  };
  function origin() {
    const groups: Record<string, any> = {
      [HOME]: home,
      'feishu:oc_bound': {
        name: 'bound',
        folder: 'owner-home',
        target_agent_id: LEGACY,
        feishu_chat_mode: 'group',
      },
      'feishu:oc_topics': {
        name: 'topics',
        folder: 'owner-home',
        target_main_jid: HOME,
        binding_mode: 'thread_map',
        feishu_chat_mode: 'topic',
      },
      'feishu:oc_unbound': {
        name: 'unbound',
        folder: 'owner-home',
        feishu_chat_mode: 'group',
      },
    };
    const globals: Record<string, any> = {
      agentIdOfJid,
      registeredGroups: groups,
      getRegisteredGroup: (jid: string) => groups[jid],
      getAgent: (id: string) => sessions[id],
      isNativeContextContainer,
      resolveNativeThreadContext,
      buildNativeThreadRouteJid,
      resolveBoundChatTarget,
      resolveSessionTarget,
      getImContextBinding: (_jid: string, _type: string, contextId: string) =>
        contextId === 'omt_1' ? { agent_id: 'topic1' } : undefined,
      resolveEffectiveGroup: (group: unknown) => ({ effectiveGroup: group }),
      UNBOUND_CHAT_REPLY: UNBOUND,
    };
    const harness = createRuntimeSourceHarness(globals);
    harness.install('resolveCommandSession');
    harness.install('resolveSpawnOrigin');
    return globals.resolveSpawnOrigin as (
      chatJid: string,
      meta?: Record<string, unknown>,
    ) => unknown;
  }

  test('a Web session, a bound chat, a topic, and an unbound chat', () => {
    const resolve = origin();
    expect(resolve(LANE)).toMatchObject({
      originJid: LANE,
      workspaceJid: HOME,
      imRouteJid: LANE,
    });
    expect(resolve('feishu:oc_bound')).toMatchObject({
      originJid: LANE,
      imRouteJid: 'feishu:oc_bound',
    });
    expect(
      resolve('feishu:oc_topics', {
        nativeContextType: 'thread',
        threadId: 'omt_1',
        rootId: 'om_1',
      }),
    ).toMatchObject({
      originJid: `${HOME}#agent:topic1`,
      imRouteJid: 'feishu:oc_topics#thread:omt_1#root:om_1',
    });
    expect(resolve('feishu:oc_unbound')).toBe(UNBOUND);
  });
});

describe('an activation change keeps ordinary chats bound to a session', () => {
  function persist() {
    const written: Record<string, any> = {};
    const globals: Record<string, any> = {
      isNativeContextContainer,
      buildWorkspaceMountUpdate,
      registeredGroups: {},
      persistGroupUpdate: (jid: string, group: unknown) => {
        written[jid] = group;
      },
      detachThreadMapWorkspace: vi.fn(),
      markThreadMapWorkspace: vi.fn(),
    };
    createRuntimeSourceHarness(globals).install(
      'persistActivationAwareGroupUpdate',
    );
    const update = (jid: string, group: Record<string, unknown>) => {
      expect(
        globals.persistActivationAwareGroupUpdate(jid, group, {
          ...group,
          activation_mode: 'when_mentioned',
        }),
      ).toBe(true);
      return written[jid];
    };
    return { update, globals };
  }

  test('a leftover workspace target is dropped, never written without a session', () => {
    const { update } = persist();
    expect(
      update('feishu:oc_stale', {
        folder: 'f',
        feishu_chat_mode: 'group',
        target_main_jid: HOME,
      }),
    ).toMatchObject({
      target_main_jid: undefined,
      binding_mode: 'single_context',
      activation_mode: 'when_mentioned',
    });
    expect(
      update('feishu:oc_session', {
        folder: 'f',
        feishu_chat_mode: 'group',
        target_agent_id: LEGACY,
        target_main_jid: HOME,
      }),
    ).toMatchObject({
      target_agent_id: LEGACY,
      target_main_jid: undefined,
    });
  });

  test('a topic group keeps its workspace mount', () => {
    const { update, globals } = persist();
    expect(
      update('feishu:oc_topic', {
        folder: 'f',
        feishu_chat_mode: 'topic',
        target_main_jid: HOME,
        binding_mode: 'thread_map',
      }),
    ).toMatchObject({
      target_main_jid: HOME,
      binding_mode: 'thread_map',
      activation_mode: 'when_mentioned',
    });
    expect(globals.markThreadMapWorkspace).toHaveBeenCalledWith(HOME);
  });
});

describe('a migrated main session elsewhere in the runtime', () => {
  test('its IPC replies go to the IM input of its own turn', () => {
    const scopes = new ActiveChannelOutboxScopeRegistry();
    const globals: Record<string, any> = {
      activeChannelOutboxScopes: scopes,
      channelTurnScope,
    };
    createRuntimeSourceHarness(globals).install('resolveImRoute');
    scopes.bind(channelTurnScope(FOLDER, LEGACY), {
      provider: 'feishu',
      accountId: 'bot',
      sourceJid: 'feishu:oc_parity',
      chatId: 'oc_parity',
      turnRunId: 'run-1',
      inputTurnId: 'in-1',
      owner: 'test',
    });
    const route = (ipcAgentId: string, inputTurnId?: string) =>
      globals.resolveImRoute({ ipcAgentId, sourceGroup: FOLDER, inputTurnId });
    expect(route(LEGACY, 'in-1')).toBe('feishu:oc_parity');
    expect(route('another-session', 'in-1')).toBeNull();
    expect(route(LEGACY)).toBeNull();
  });

  test('Agent Builder accepts it in its Home', () => {
    const row = legacyRow();
    expect(
      getAgentBuilderRuntimeRejection({
        runtimeAgentKind: row.kind,
        runtimeAgentFolder: row.group_folder,
        sourceFolder: FOLDER,
        sourceProfileIsDefault: true,
      }),
    ).toBeNull();
  });

  test('a restart resumes it when it still has input', () => {
    const recovered = '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
    db.createAgent({ ...legacyRow(), id: recovered, status: 'running' });
    const lane = `${HOME}#agent:${recovered}`;
    db.ensureChatExists(lane);
    db.storeMessageDirect(
      'recover-1',
      lane,
      'owner',
      'Owner',
      'unfinished',
      new Date().toISOString(),
      false,
    );
    const globals: Record<string, any> = {
      logger,
      archiveInactiveConversationAgents: () => 0,
      CONVERSATION_AGENT_ARCHIVE_DAYS: 30,
      listActiveConversationAgents: () =>
        db.listActiveConversationAgents().filter((a) => a.id === recovered),
      updateAgentStatus: db.updateAgentStatus,
      broadcastAgentStatus: vi.fn(),
      lastCommittedCursor: {},
      lastAgentTimestamp: {},
      clearPersistedIpcDeliveriesForChats: vi.fn(),
      rewindNextPullCursorToCommitted: vi.fn(),
      EMPTY_CURSOR: { timestamp: '', id: '' },
      getMessagesSince: db.getMessagesSince,
      storeMessageDirect: db.storeMessageDirect,
      broadcastNewMessage: vi.fn(),
      ASSISTANT_NAME: 'HappyClaw',
      queue: { enqueueTask: vi.fn() },
      processAgentConversation: vi.fn(),
    };
    const harness = createRuntimeSourceHarness(globals);
    harness.install('isCursorAfter');
    harness.install('recoverConversationAgents');
    globals.recoverConversationAgents();
    expect(db.getAgent(recovered)?.status).toBe('idle');
    expect(globals.queue.enqueueTask).toHaveBeenCalledWith(
      lane,
      expect.stringMatching(new RegExp(`^agent-recover:${recovered}:`)),
      expect.any(Function),
    );
  });
});

describe('a stop while a failed turn waits for its retry', () => {
  test('/break answers that it stopped the task, and only when a retry was armed', async () => {
    const globals: Record<string, any> = {
      logger,
      learnFeishuDirectChat: vi.fn(),
      resolveRuntimeControlTarget: () => LANE,
      UNBOUND_CHAT_REPLY: UNBOUND,
      cancelQueuedFollowUpsAtCutoff: () => [],
      cancelAutomationInputs: vi.fn(),
      closeRetryWaitTurnsOfInputs: vi.fn(),
      endUsageLimitWait: vi.fn(),
      interruptActiveSessionRun: () => ({
        activeRunId: null,
        interrupted: false,
      }),
      queue: { stopArmedRetry: vi.fn(() => true) },
    };
    const harness = createRuntimeSourceHarness(globals);
    harness.install('breakLane');
    harness.install('handleSessionBreak');
    const brk = () =>
      globals.handleSessionBreak({
        sourceJid: 'feishu:oc_p',
        senderImId: 'ou',
      });

    expect(await brk()).toBe('Current task stopped.');
    expect(globals.queue.stopArmedRetry).toHaveBeenCalledWith(LANE);
    globals.queue.stopArmedRetry = vi.fn(() => false);
    expect(await brk()).toBe('No active task to stop.');
  });

  test('the failed batch is settled as stopped: committed, its runs and turns closed', () => {
    const lane = `${HOME}#agent:retry-stop`;
    db.ensureChatExists(lane);
    db.storeMessageDirect(
      'retry-in-1',
      lane,
      'owner',
      'Owner',
      'first',
      '2026-11-02T00:00:01.000Z',
      false,
      { sourceJid: 'feishu:oc_retry', meta: { automationRunId: 'run-r1' } },
    );
    db.storeMessageDirect(
      'retry-in-2',
      lane,
      'owner',
      'Owner',
      'second',
      '2026-11-02T00:00:02.000Z',
      false,
      { sourceJid: 'feishu:oc_retry' },
    );
    const globals: Record<string, any> = {
      getAgentBuilderInputMessage: db.getAgentBuilderInputMessage,
      cancelAutomationInputs: vi.fn(),
      advanceCursors: vi.fn(),
      channelTurnScopeForInput: (jid: string, source: string) => ({
        jid,
        source,
      }),
      closeRetryWaitTurnsForWithdrawnInputs: vi.fn(),
      clearTrackedProcessingIndicators: vi.fn(async () => {}),
    };
    const harness = createRuntimeSourceHarness(globals);
    for (const name of [
      'retrySnapshotInputs',
      'closeRetryWaitTurnsOfInputs',
      'settleStoppedRetryBatch',
    ]) {
      harness.install(name);
    }
    const cursor = { timestamp: '2026-11-02T00:00:02.000Z', id: 'retry-in-2' };
    globals.settleStoppedRetryBatch(lane, {
      coveredCursors: [
        { timestamp: '2026-11-02T00:00:01.000Z', id: 'retry-in-1' },
        cursor,
      ],
      cursor,
    });

    expect(globals.advanceCursors).toHaveBeenCalledWith(lane, cursor);
    expect(globals.cancelAutomationInputs).toHaveBeenCalledWith(
      [
        expect.objectContaining({ id: 'retry-in-1' }),
        expect.objectContaining({ id: 'retry-in-2' }),
      ],
      'break',
    );
    expect(
      globals.closeRetryWaitTurnsForWithdrawnInputs.mock.calls.map(
        ([scope, ids]: [unknown, string[]]) => [scope, ids],
      ),
    ).toEqual([
      [{ jid: lane, source: 'feishu:oc_retry' }, ['retry-in-1']],
      [{ jid: lane, source: 'feishu:oc_retry' }, ['retry-in-2']],
    ]);
    expect(globals.clearTrackedProcessingIndicators).toHaveBeenCalledWith(lane);
  });
});
