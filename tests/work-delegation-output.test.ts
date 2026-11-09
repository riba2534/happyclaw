/**
 * A delegated worker's terminal outputs, run through the production
 * handleAgentOutput of processAgentConversation: a finished turn asks whether
 * the worker handed back a result, and a run whose connections all failed
 * fails the item. Each hook is a spy that stops the run where it is called.
 */
import { describe, expect, test, vi } from 'vitest';

import { AutomationTurnTracker } from '../src/automation-run-ledger.js';
import { resolveContainerOutputInputTurnId } from '../src/channel-output-correlation.js';
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

  test('each result tells stuck recovery whether background work holds the turn', async () => {
    const run = host(DELEGATED);
    const queue = run.globals.queue as {
      markRunnerBackgroundHold: ReturnType<typeof vi.fn>;
    };
    await run.emit({
      status: 'success',
      result: null,
      inputTurnId: 'in-1',
      inputTurnCompleted: false,
      pendingBgTasks: 2,
    });
    expect(queue.markRunnerBackgroundHold).toHaveBeenLastCalledWith(LANE, true);

    await run
      .emit({
        status: 'success',
        result: null,
        inputTurnId: 'in-1',
        inputTurnCompleted: true,
      })
      .catch((err) => {
        if (err !== STOP) throw err;
      });
    expect(queue.markRunnerBackgroundHold).toHaveBeenLastCalledWith(
      LANE,
      false,
    );
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
