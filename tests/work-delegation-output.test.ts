/**
 * A delegated worker's terminal outputs, run through the production
 * handleAgentOutput of processAgentConversation: a finished turn asks whether
 * the worker handed back a result, and a run whose connections all failed
 * fails the item. Every output also tells stuck recovery which query the
 * Runner serves and whether it still holds its result for background work.
 * Each hook is a spy that stops the run where it is called.
 */
import { describe, expect, test, vi } from 'vitest';

import { AutomationTurnTracker } from '../src/automation-run-ledger.js';
import { resolveContainerOutputInputTurnId } from '../src/channel-output-correlation.js';
import { accountFailureNotice } from '../src/provider-failure.js';
import * as interactionRuntime from '../src/workspace-interaction-runtime.js';
import { createRuntimeSourceHarness } from './helpers/runtime-source.js';

const LANE = 'web:mt-ws#agent:worker-1';
const STOP = new Error('reached the hook');

function host(teamRole: Record<string, unknown>) {
  const settleDelegatedWorkerTurn = vi.fn(() => {
    throw STOP;
  });
  const failDelegatedWorkerRun = vi.fn(() => {
    throw STOP;
  });
  const globals: Record<string, unknown> = {
    ...interactionRuntime,
    resolveContainerOutputInputTurnId,
    teamRole,
    settleDelegatedWorkerTurn,
    failDelegatedWorkerRun,
    automationTurns: new AutomationTurnTracker(),
    queue: {
      markRunnerActivity: vi.fn(),
      markRunnerBackgroundHold: vi.fn(),
      markRunnerServingQuery: vi.fn(),
      markRunnerQueryIdle: vi.fn(),
    },
    virtualJid: LANE,
    virtualChatJid: LANE,
    chatJid: 'web:mt-ws',
    agentId: 'worker-1',
    effectiveGroup: { folder: 'mt-ws' },
    agentProfile: undefined,
    lastProcessed: { id: 'in-1' },
    missedMessages: [],
    activeAgentInputTurnId: 'in-1',
    interactionMode: 'proactive',
    isProviderQuotaControlOutput: () => false,
    bindRunnerActiveIpcCoverage: vi.fn(),
    steeringTransitions: { shouldSuppressOutput: () => false },
    takeRecallStop: () => undefined,
    agentRecallSuppression: false,
    agentRecalledInputIds: new Set(),
    agentChannelTurnRuntimes: new Map(),
    activateAgentProjectionForInput: vi.fn(async () => {}),
    resolveProviderFailureClass: () => 'quota',
    accountFailureNotice,
    broadcastContextUsage: vi.fn(async () => {}),
    rollbackIdleAgentCardReservation: vi.fn(),
    admittedWarmAgentInputs: new Map(),
    healthyAgentCompletedInputTurns: new Set(),
    agentProviderFailoverPending: false,
    retryUnfinishedTurn: true,
    logSuppressedProactiveFinal: vi.fn(),
    completeAgentChannelRuntimesForOutput: vi.fn(async () => true),
    commitCursor: vi.fn(),
    finalizeProactiveAgentOutputCoordinators: vi.fn(),
    persistProactiveTurnTrace: vi.fn(),
    broadcastStreamEvent: vi.fn(),
    resetIdleTimer: vi.fn(),
    currentAgentSessionId: undefined,
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
  createRuntimeSourceHarness(globals).install(
    'handleAgentOutput',
    'processAgentConversation',
  );
  const emit = globals.handleAgentOutput as (
    output: Record<string, unknown>,
  ) => Promise<void>;
  return { emit, settleDelegatedWorkerTurn, failDelegatedWorkerRun, globals };
}

const DELEGATED = {
  role: 'worker',
  workItemId: 'w1',
  writable: true,
  origin: 'delegated',
};
const TEAM = { role: 'worker', workItemId: 't1', writable: true };

describe("a delegated worker's finished turn", () => {
  test('asks whether it handed back a result, with the inputs it answered', async () => {
    const run = host(DELEGATED);
    const output = {
      status: 'success',
      result: null,
      inputTurnId: 'in-1',
      inputTurnCompleted: true,
      ipcReceipts: [
        {
          deliveryId: 'd-1',
          chatJid: LANE,
          cursor: { timestamp: 't', id: 'followup-1' },
        },
      ],
    };
    await expect(run.emit(output)).rejects.toBe(STOP);
    expect(run.settleDelegatedWorkerTurn).toHaveBeenCalledWith(
      LANE,
      'worker-1',
      output,
    );
  });

  test("a team worker's turn is not asked", async () => {
    const run = host(TEAM);
    await run.emit({
      status: 'success',
      result: null,
      inputTurnId: 'in-1',
      inputTurnCompleted: true,
    });
    expect(run.settleDelegatedWorkerTurn).not.toHaveBeenCalled();
  });

  test('a turn the runner still holds (background work) is not asked', async () => {
    const run = host(DELEGATED);
    await run.emit({
      status: 'success',
      result: null,
      inputTurnId: 'in-1',
      inputTurnCompleted: false,
    });
    expect(run.settleDelegatedWorkerTurn).not.toHaveBeenCalled();
  });
});

describe('the background hold each output reports to stuck recovery', () => {
  const HELD = {
    status: 'success',
    result: null,
    inputTurnId: 'in-1',
    inputTurnCompleted: false,
    pendingBgTasks: 2,
  };

  // The hold is booked before anything else looks at the output; each run
  // stops at the next hook.
  function heldHost() {
    const run = host(DELEGATED);
    run.globals.bindRunnerActiveIpcCoverage = vi.fn(() => {
      throw STOP;
    });
    const hold = (
      run.globals.queue as {
        markRunnerBackgroundHold: ReturnType<typeof vi.fn>;
      }
    ).markRunnerBackgroundHold;
    const emit = (output: object) =>
      expect(run.emit(output)).rejects.toBe(STOP);
    return { emit, hold };
  }

  test('each result says whether background work still holds the turn', async () => {
    const run = heldHost();
    await run.emit(HELD);
    expect(run.hold).toHaveBeenLastCalledWith(LANE, true);

    await run.emit({
      status: 'success',
      result: null,
      inputTurnId: 'in-1',
      inputTurnCompleted: true,
      pendingBgTasks: 0,
    });
    expect(run.hold).toHaveBeenLastCalledWith(LANE, false);
  });

  test('a notice between results leaves the hold alone', async () => {
    const run = heldHost();
    await run.emit(HELD);

    // An oversized image in input taken while held, a compaction partial,
    // and the session update after a query: none of them is a result.
    await run.emit({
      status: 'success',
      result: '⚠️ 图片尺寸 1179×12000 超过 8000 像素上限，已跳过',
      newSessionId: undefined,
    });
    await run.emit({
      status: 'success',
      result: 'partial answer',
      sourceKind: 'compact_partial',
      finalizationReason: 'completed',
    });
    await run.emit({ status: 'success', result: null, newSessionId: 's-1' });

    expect(run.hold).toHaveBeenCalledTimes(1);
    expect(run.hold).toHaveBeenLastCalledWith(LANE, true);
  });

  test.each([
    [
      'an interrupt whose next turn starts at once',
      {
        status: 'stream',
        result: null,
        streamEvent: { eventType: 'status', statusText: 'interrupted' },
        queryIdle: false,
      },
    ],
    [
      'a model-fallback retry',
      {
        status: 'success',
        result: '⚠️ 主模型已达用量上限，本轮起改用备用模型回复。',
        sourceKind: 'provider_fallback_notice',
      },
    ],
    [
      'a context overflow',
      {
        status: 'success',
        result: 'partial answer',
        sourceKind: 'overflow_partial',
        finalizationReason: 'error',
      },
    ],
    [
      'a provider failure',
      {
        status: 'success',
        result: null,
        inputTurnId: 'in-1',
        providerFailure: true,
        providerFailureClass: 'account',
      },
    ],
  ])('%s ends the SDK query and the hold', async (_name, output) => {
    const run = heldHost();
    await run.emit(HELD);

    await run.emit(output);

    expect(run.hold).toHaveBeenLastCalledWith(LANE, false);
  });
});

describe('the stream event each output shows stuck recovery', () => {
  test('a stream event is passed on; other outputs pass none', async () => {
    const run = host(DELEGATED);
    run.globals.bindRunnerActiveIpcCoverage = vi.fn(() => {
      throw STOP;
    });
    const serving = (
      run.globals.queue as { markRunnerServingQuery: ReturnType<typeof vi.fn> }
    ).markRunnerServingQuery;

    const streamEvent = {
      eventType: 'text_delta',
      agentScope: 'main',
      text: 'On it',
      queryRunId: 'query-2',
      turnId: 't-1',
    };
    await expect(
      run.emit({ status: 'stream', result: null, streamEvent }),
    ).rejects.toBe(STOP);
    expect(serving).toHaveBeenLastCalledWith(LANE, streamEvent);

    await expect(
      run.emit({ status: 'success', result: null, newSessionId: 's-1' }),
    ).rejects.toBe(STOP);
    expect(serving).toHaveBeenLastCalledWith(LANE, undefined);
  });
});

describe('a delegated worker whose connections all failed', () => {
  test('fails its item with the notice', async () => {
    const run = host(DELEGATED);
    await expect(
      run.emit({
        status: 'error',
        result: null,
        inputTurnId: 'in-1',
        providerFailure: true,
        providerFailureTerminal: true,
        providerFailureNotice: '所有模型连接都不可用',
      }),
    ).rejects.toBe(STOP);
    expect(run.failDelegatedWorkerRun).toHaveBeenCalledWith(
      'worker-1',
      '所有模型连接都不可用',
    );
  });

  test('a failure another connection may still take is not the end', async () => {
    const run = host(DELEGATED);
    await run.emit({
      status: 'error',
      result: null,
      inputTurnId: 'in-1',
      providerFailure: true,
      providerFailureTerminal: false,
    });
    expect(run.failDelegatedWorkerRun).not.toHaveBeenCalled();
    expect(run.globals.agentProviderFailoverPending).toBe(true);
  });
});
