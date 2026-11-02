import { describe, expect, test, vi } from 'vitest';

import { ActiveChannelOutboxScopeRegistry } from '../src/channel-outbox-runtime-scope.js';
import { resolveOutputChannelReplySource } from '../src/channel-reply-source.js';
import { channelTurnScope } from '../src/channel-turn-registry.js';
import { routeHostIpcOutput } from '../src/host-ipc-output-router.js';
import type { StreamEvent } from '../src/stream-event.types.js';
import { ActiveTurnOutputRegistry } from '../src/turn-output-coordinator.js';
import { ProactiveProgressCarry, TurnTraceTracker } from '../src/turn-trace.js';
import type { InteractionMode, ProcessVisibility } from '../src/types.js';
import {
  proactiveClosingNote,
  projectProgressForWeb,
} from '../src/workspace-interaction-runtime.js';
import { createRuntimeSourceHarness } from './helpers/runtime-source.js';

// The proactive progress path as the host runs it: each turn is bound with the
// channel its input came from, the IPC router stages a Web turn's
// send_message(delivery_role=progress) on it, and the turn's own onProgress
// handler (installed from index.ts) tells the Web and records it for turn_traces. A turn that ends
// without a reply keeps its progress on a closing note.

const LEVELS: ProcessVisibility[] = ['hidden', 'activity', 'full'];
const FOLDER = 'ws-progress';
const CHAT_JID = 'web:ws-progress';
const AGENT_ID = 'session-1';

type StoredTrace = Parameters<
  NonNullable<ConstructorParameters<typeof TurnTraceTracker>[0]['store']>
>[0];

function sessionLane(
  mode: InteractionMode,
  visibility: ProcessVisibility,
  options: { initialSource?: string | null } = {},
) {
  const activeTurnOutputs = new ActiveTurnOutputRegistry();
  const broadcast = vi.fn<(...args: unknown[]) => void>();
  const stored: StoredTrace[] = [];
  const turnTraces = new TurnTraceTracker({
    mode,
    getVisibility: () => visibility,
    store: (row) => {
      stored.push(row);
    },
  });
  const nonTerminal = new Map<string, boolean>();
  const globals: Record<string, unknown> = {
    activeTurnOutputs,
    projectProgressForWeb,
    resolveOutputChannelReplySource,
    interactionMode: mode,
    turnTraces,
    broadcastStreamEvent: broadcast,
    chatJid: CHAT_JID,
    agentId: AGENT_ID,
    activeSessionId: 'sdk-session',
    currentAgentSessionId: 'sdk-session',
    lastProcessed: { id: 'input-1' },
    initialReplySourceImJid: options.initialSource ?? null,
    initialAgentReplySourceImJid: options.initialSource ?? null,
    admittedWarmAgentInputs: new Map(),
    agentAdmissionKey: channelTurnScope(FOLDER, AGENT_ID),
    agentTurnOutputCoordinators: new Map(),
    agentStreamingSessionsByInput: new Map(),
    agentNonTerminalDeliveryAckByInput: nonTerminal,
  };
  const harness = createRuntimeSourceHarness(globals);
  harness.install('bindAgentTurnOutputCoordinator', 'processAgentConversation');
  const bind = globals.bindAgentTurnOutputCoordinator as (
    inputTurnId: string,
  ) => unknown;
  bind('input-1');
  const scope = channelTurnScope(FOLDER, AGENT_ID);
  // What the IPC watcher passes: the bound source, and whether a route is open.
  const send = (text: string, imRouteAvailable = false) =>
    routeHostIpcOutput(
      {
        sourceGroup: FOLDER,
        agentId: AGENT_ID,
        inputTurnId: 'input-1',
        text,
        deliveryRole: 'progress',
        authorized: true,
        scheduledTask: false,
        interactionMode: mode,
        turnSource: activeTurnOutputs.sourceOf(scope, 'input-1'),
        imRouteAvailable,
      },
      activeTurnOutputs,
    );
  const sent = () => broadcast.mock.calls.map((call) => call[1] as StreamEvent);
  return { send, sent, broadcast, turnTraces, stored, nonTerminal };
}

describe("a proactive Web turn's progress", () => {
  {
    test(`reaches the Web as a progress step at every level `, () => {
      for (const level of LEVELS) {
        const run = sessionLane('proactive', level);
        expect(run.send('先看一下仓库结构')).toMatchObject({
          path: 'primary_projection',
          staged: true,
          disposition: 'staged_progress',
        });
        expect(run.sent()).toEqual([
          {
            eventType: 'commentary',
            agentScope: 'main',
            text: '先看一下仓库结构',
            turnId: 'input-1',
            inputTurnId: 'input-1',
            sessionId: 'sdk-session',
            progress: true,
          },
        ]);
        // The session lane addresses its own tab.
        expect(run.broadcast.mock.calls[0][0]).toBe(CHAT_JID);
        expect(run.broadcast.mock.calls[0][2]).toBe(AGENT_ID);
        // It is non-terminal output: the turn still owes its final.
        expect(run.nonTerminal.get('input-1')).toBe(true);
      }
    });

    test(`lands on the card of a warm turn, under the Runner's own id `, () => {
      // A warm turn's events carry the Runner's id, not the input's: a step
      // under the input's id would start a new card and wipe the one shown.
      const run = sessionLane('proactive', 'hidden');
      run.turnTraces.observe('input-1', {
        eventType: 'status',
        statusText: 'requesting',
        turnId: 'runner-turn-2',
      });
      run.send('换个思路再试');
      expect(run.sent()[0]).toMatchObject({
        turnId: 'runner-turn-2',
        inputTurnId: 'input-1',
        progress: true,
      });
    });

    test(`is kept for turn_traces at every level, alone at hidden `, () => {
      for (const level of LEVELS) {
        const run = sessionLane('proactive', level);
        run.turnTraces.observe('input-1', {
          eventType: 'tool_use_start',
          toolName: 'Bash',
          toolUseId: 'bash-1',
        });
        run.send('已定位到问题');
        expect(
          run.turnTraces.persist({ chatJid: CHAT_JID, inputId: 'input-1' }),
        ).toBe(true);
        const steps = JSON.parse(run.stored[0].stepsJson!) as Array<{
          kind: string;
          text?: string;
          progress?: boolean;
        }>;
        expect(steps.filter((step) => step.progress)).toEqual([
          expect.objectContaining({ kind: 'text', text: '已定位到问题' }),
        ]);
        expect(steps.some((step) => step.kind === 'tool')).toBe(
          level !== 'hidden',
        );
      }
    });

    test(`of an IM input goes to the channel, and fails closed without a route `, () => {
      // The input's own source decides, not whether a scope happens to exist:
      // an address without its account, or a recalled input, has none.
      const run = sessionLane('proactive', 'full', {
        initialSource: 'feishu:oc_chat',
      });
      expect(run.send('在查', true)).toMatchObject({
        path: 'separate_provider',
      });
      expect(run.send('在查', false)).toMatchObject({
        path: 'rejected',
        reason: 'native_route_unavailable',
      });
      expect(run.sent()).toEqual([]);
      expect(run.turnTraces.holdsProgress('input-1')).toBe(false);
    });
  }

  test('an Assistant turn keeps its step and status line', () => {
    const run = sessionLane('assistant', 'hidden');
    run.send('正在处理');
    expect(run.sent().map((event) => event.eventType)).toEqual([
      'commentary',
      'status',
    ]);
    expect(run.sent()[0].progress).toBeUndefined();
  });
});

describe('a proactive turn that sent progress and ends without a reply', () => {
  const SESSION_JID = `${CHAT_JID}#agent:${AGENT_ID}`;
  function closingLane(options: { replied?: boolean } = {}) {
    const stored: StoredTrace[] = [];
    const turnTraces = new TurnTraceTracker({
      mode: 'proactive',
      getVisibility: () => 'hidden',
      store: (row) => {
        stored.push(row);
      },
    });
    const storeMessageDirect = vi.fn(() => 'note-s');
    const broadcastNewMessage = vi.fn();
    const announceTurnTrace = vi.fn();
    const excludeMessageFromHistoryRecovery = vi.fn();
    const globals: Record<string, unknown> = {
      turnTraces,
      virtualChatJid: SESSION_JID,
      agentId: AGENT_ID,
      currentAgentSessionId: 'sdk-session',
      getLastAgentMessageIdForTurn: (jid: string) =>
        options.replied && jid === SESSION_JID ? 'final-1' : undefined,
      announceTurnTrace,
      ensureChatExists: vi.fn(),
      storeMessageDirect,
      broadcastNewMessage,
      excludeMessageFromHistoryRecovery,
      proactiveClosingNote,
      logger: { warn: vi.fn() },
      ASSISTANT_NAME: 'HappyClaw',
      crypto: { randomUUID: () => 'uuid-1' },
      // No attempt follows: each ending here is the turn's last.
      queue: { willRetryAfterFailure: () => false },
    };
    const harness = createRuntimeSourceHarness(globals);
    harness.install('persistProactiveTurnTrace', 'processAgentConversation');
    harness.install('closeProactiveTurn', 'processAgentConversation');
    harness.install('keepProactiveProgress', 'processAgentConversation');
    const keep = globals.keepProactiveProgress as (
      inputId: string,
      ending: 'stopped' | 'steered' | 'failed',
    ) => void;
    return {
      turnTraces,
      stored,
      storeMessageDirect,
      broadcastNewMessage,
      announceTurnTrace,
      excludeMessageFromHistoryRecovery,
      keep,
    };
  }
  const progress = (turnTraces: TurnTraceTracker, inputId: string) =>
    turnTraces.observeProgress(inputId, {
      eventType: 'commentary',
      agentScope: 'main',
      text: '先看日志',
      progress: true,
    });

  test("keeps it on a closing note that becomes the turn's reply, on the session's own tab", () => {
    for (const [ending, reason] of [
      ['stopped', 'interrupted'],
      ['steered', 'interrupted'],
      ['failed', 'error'],
    ] as const) {
      const lane = closingLane();
      progress(lane.turnTraces, 'input-1');
      lane.keep('input-1', ending);
      expect(lane.storeMessageDirect).toHaveBeenCalledOnce();
      expect(lane.broadcastNewMessage).toHaveBeenCalledWith(
        SESSION_JID,
        expect.objectContaining({
          id: 'note-s',
          content: proactiveClosingNote(ending),
          has_trace: true,
          turn_id: 'input-1',
          source_kind: 'interrupt_partial',
          finalization_reason: reason,
        }),
        AGENT_ID,
      );
      // The note carries the turn's trace: the progress is kept with it.
      expect(lane.stored).toHaveLength(1);
      expect(JSON.parse(lane.stored[0].stepsJson!)).toEqual([
        expect.objectContaining({ progress: true, text: '先看日志' }),
      ]);
      expect(lane.turnTraces.inputsWithProgress()).toEqual([]);
      // Written for the reader: never replayed to the model as its words.
      expect(lane.excludeMessageFromHistoryRecovery).toHaveBeenCalledWith(
        SESSION_JID,
        'note-s',
      );
    }
  });

  test('hangs it on the reply the turn already has', () => {
    const lane = closingLane({ replied: true });
    progress(lane.turnTraces, 'input-1');
    lane.keep('input-1', 'stopped');
    expect(lane.storeMessageDirect).not.toHaveBeenCalled();
    expect(lane.stored).toHaveLength(1);
    expect(lane.announceTurnTrace).toHaveBeenCalledWith(
      SESSION_JID,
      'final-1',
      'input-1',
    );
  });

  test('writes nothing for a turn that sent no progress', () => {
    const lane = closingLane();
    lane.turnTraces.observe('input-1', {
      eventType: 'status',
      statusText: 'requesting',
      turnId: 'input-1',
    });
    lane.keep('input-1', 'failed');
    expect(lane.storeMessageDirect).not.toHaveBeenCalled();
    expect(lane.stored).toHaveLength(0);
  });
});

test('a session turn refused and retried, then given up, gets one closing note', () => {
  const carry = new ProactiveProgressCarry();
  const stored: StoredTrace[] = [];
  const storeMessageDirect = vi.fn(() => 'note-s');
  function attempt(willRetry: boolean) {
    const turnTraces = new TurnTraceTracker({
      mode: 'proactive',
      getVisibility: () => 'hidden',
      store: (row) => {
        stored.push(row);
      },
    });
    const globals: Record<string, unknown> = {
      turnTraces,
      proactiveProgressCarry: carry,
      queue: { willRetryAfterFailure: () => willRetry },
      virtualChatJid: `${CHAT_JID}#agent:${AGENT_ID}`,
      agentId: AGENT_ID,
      missedMessages: [{ id: 'm1' }],
      lastProcessed: { id: 'm1' },
      admittedWarmAgentInputs: new Map(),
      currentAgentSessionId: 'sdk-session',
      getLastAgentMessageIdForTurn: () => undefined,
      announceTurnTrace: vi.fn(),
      ensureChatExists: vi.fn(),
      storeMessageDirect,
      broadcastNewMessage: vi.fn(),
      excludeMessageFromHistoryRecovery: vi.fn(),
      proactiveClosingNote,
      logger: { warn: vi.fn() },
      ASSISTANT_NAME: 'HappyClaw',
      crypto: { randomUUID: () => 'uuid-1' },
    };
    const harness = createRuntimeSourceHarness(globals);
    for (const name of [
      'takeCarriedProgress',
      'persistProactiveTurnTrace',
      'closeProactiveTurn',
      'keepProactiveProgress',
    ]) {
      harness.install(name, 'processAgentConversation');
    }
    (globals.takeCarriedProgress as () => void)();
    return { turnTraces, globals };
  }
  const first = attempt(true);
  first.turnTraces.observeProgress(
    'm1',
    {
      eventType: 'commentary',
      agentScope: 'main',
      text: '先看',
      progress: true,
    },
    1_000,
  );
  (first.globals.keepProactiveProgress as (id: string, e: string) => void)(
    'm1',
    'failed',
  );
  expect(storeMessageDirect).not.toHaveBeenCalled();
  const last = attempt(false);
  last.turnTraces.observeProgress(
    'm1',
    {
      eventType: 'commentary',
      agentScope: 'main',
      text: '再看',
      progress: true,
    },
    2_000,
  );
  (last.globals.keepProactiveProgress as (id: string, e: string) => void)(
    'm1',
    'failed',
  );
  expect(storeMessageDirect).toHaveBeenCalledOnce();
  expect(
    (JSON.parse(stored[0].stepsJson!) as Array<{ text?: string }>).map(
      (step) => step.text,
    ),
  ).toEqual(['先看', '再看']);
});

describe('the reply route a progress statement follows', () => {
  function routeOf(bindImScope: boolean): string | null {
    const activeChannelOutboxScopes = new ActiveChannelOutboxScopeRegistry();
    if (bindImScope) {
      activeChannelOutboxScopes.bind(channelTurnScope(FOLDER, AGENT_ID), {
        provider: 'feishu',
        accountId: 'acct',
        sourceJid: 'feishu:oc_chat',
        chatId: 'oc_chat',
        rootId: null,
        threadId: null,
        turnRunId: 'run-1',
        inputTurnId: 'input-1',
        owner: 'test',
      });
    }
    const globals: Record<string, unknown> = {
      activeChannelOutboxScopes,
      channelTurnScope,
    };
    createRuntimeSourceHarness(globals).install('resolveImRoute');
    return (
      globals.resolveImRoute as (opts: Record<string, unknown>) => string | null
    )({
      ipcAgentId: AGENT_ID,
      sourceGroup: FOLDER,
      inputTurnId: 'input-1',
    });
  }

  test('an IM input has its channel route while its scope is bound', () => {
    expect(routeOf(true)).toBe('feishu:oc_chat');
    expect(routeOf(false)).toBeNull();
  });
});
