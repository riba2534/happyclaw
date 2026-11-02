/**
 * Interrupt semantics end to end, minus the SDK: the Host's GroupQueue writes
 * the real sentinel files, the runner's reader consumes them, and the
 * runner's ActiveTurnStopper acts on a real StreamEventProcessor's task state
 * against a fake Query that records interrupt / close (and a stopTask that
 * must stay unused).
 *
 * Every interrupt calls interrupt(), which already ends Claude Code's
 * sub-agents. Only an explicit stop (/break, a stop button, a recall) adds a
 * deadline that closes the query if a sub-agent outlasts it; steer, 「发送」
 * and the runner's own interrupts (usage limit, model switch, model limit,
 * sub-agent provider error, shutdown) never close. Background shells,
 * monitors and MCP tasks never count toward that deadline.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';

import { StreamEventProcessor } from '../container/agent-runner/src/stream-processor.js';
import {
  ActiveTurnStopper,
  SUB_AGENT_STOP_CLOSE_DELAY_MS,
  consumeInterruptSentinel,
  consumeStopAfterSteer,
  type InterruptReason,
} from '../container/agent-runner/src/turn-interrupt.js';
import { createRuntimeSourceHarness } from './helpers/runtime-source.js';

const RUNNER_SOURCE = new URL(
  '../container/agent-runner/src/index.ts',
  import.meta.url,
);

const dataDir = fs.mkdtempSync(
  path.join(os.tmpdir(), 'happyclaw-turn-interrupt-'),
);

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  DATA_DIR: dataDir,
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/container-runner.js', () => ({ killProcessTree: vi.fn() }));
vi.mock('../src/runtime-config.js', () => ({
  getSystemSettings: () => ({ maxConcurrentContainers: 20 }),
}));
vi.mock('../src/db.js', () => ({}));

const { GroupQueue } = await import('../src/group-queue.js');
const { isIpcInputPayloadFilename } =
  await import('../src/ipc-delivery-recovery.js');

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

let folderSeq = 0;

/** A Host session lane whose runner is registered and running query `run-1`. */
function runningLane() {
  const folder = `lane-${++folderSeq}`;
  const agentId = `session-${folderSeq}`;
  const jid = `web:${folder}#agent:${agentId}`;
  const queue = new GroupQueue();
  const state = (queue as any).getGroup(jid);
  state.active = true;
  state.process = { pid: 4242 };
  state.groupFolder = folder;
  state.agentId = agentId;
  state.queryInFlight = true;
  state.queryId = 'run-1';
  const inputDir = path.join(
    dataDir,
    'ipc',
    folder,
    'agents',
    agentId,
    'input',
  );
  return { queue, state, jid, folder, agentId, inputDir };
}

/** A processor fed task_started frames as Claude Code 2.1.296 sends them. */
function processorWithTasks(
  tasks: Array<[taskId: string, taskType?: string, extra?: object]>,
) {
  const processor = new StreamEventProcessor(
    () => {},
    () => {},
  );
  for (const [taskId, taskType, extra] of tasks) {
    processor.processSystemMessage({
      type: 'system',
      subtype: 'task_started',
      task_id: taskId,
      description: taskId,
      ...(taskType ? { task_type: taskType } : {}),
      ...extra,
    });
  }
  return processor;
}

/**
 * Two sub-agents the main Agent launched, and everything an explicit stop
 * must not wait on: a dev server, both monitor kinds, an MCP task, a task of
 * another or of no type, and a sub-agent's own sub-agent.
 */
const TURN_TASKS: Array<[string, string?, object?]> = [
  ['agent-1', 'local_agent'],
  ['workflow-1', 'local_workflow'],
  ['dev-server', 'local_bash'],
  ['mcp-watch', 'monitor_mcp'],
  ['ws-watch', 'monitor_ws'],
  ['mcp-job', 'mcp_task'],
  ['dream-1', 'dream'],
  ['untyped-1'],
  ['nested-1', 'local_agent', { parent_task_id: 'agent-1' }],
];

/** A runner turn with one task of every kind the SDK reports. */
function runnerTurn() {
  const processor = processorWithTasks(TURN_TASKS);
  processor.processSystemMessage({
    type: 'system',
    subtype: 'task_updated',
    task_id: 'dev-server',
    patch: { is_backgrounded: true },
  });

  const calls: string[] = [];
  const query = {
    stopTask: vi.fn(async (taskId: string) => {
      calls.push(`stopTask:${taskId}`);
    }),
    interrupt: vi.fn(async () => {
      calls.push('interrupt');
      return { still_queued: [] as string[] };
    }),
    close: vi.fn(() => {
      calls.push('close');
    }),
  };
  let queryFinished = false;
  const logs: string[] = [];
  const stopper = new ActiveTurnStopper({
    activeSubAgentTaskIds: () => processor.getActiveSubAgentTaskIds(),
    isQueryFinished: () => queryFinished,
    log: (line) => logs.push(line),
  });
  const stop = (label: string, reason?: InterruptReason, queuedInCli = 0) =>
    stopper.stop(query as any, label, queuedInCli, reason);
  const settle = (taskId: string, status = 'stopped') =>
    processor.processSystemMessage({
      type: 'system',
      subtype: 'task_notification',
      task_id: taskId,
      status,
      summary: `${taskId} ${status}`,
    });
  return {
    processor,
    calls,
    logs,
    query,
    stopper,
    stop,
    settle,
    finishQuery: () => {
      queryFinished = true;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Host → runner interrupt reason', () => {
  test('an explicit stop reaches the runner as stop and is consumed with the sentinel', () => {
    const lane = runningLane();
    expect(lane.queue.interruptQuery(lane.jid, 'run-1', 'stop')).toBe(true);

    expect(consumeInterruptSentinel(lane.inputDir)).toEqual({
      queryRunId: 'run-1',
      reason: 'stop',
    });
    expect(fs.readdirSync(lane.inputDir)).toEqual([]);
    expect(consumeInterruptSentinel(lane.inputDir)).toBeNull();
  });

  test('steer and 「发送」 (no reason) reach the runner as steer', () => {
    const lane = runningLane();
    expect(lane.queue.interruptQuery(lane.jid, 'run-1')).toBe(true);
    expect(consumeInterruptSentinel(lane.inputDir)).toEqual({
      queryRunId: 'run-1',
      reason: 'steer',
    });
  });

  test('a stop keeps `_interrupt` exactly as runners that predate the reason read it', () => {
    const lane = runningLane();
    lane.queue.interruptQuery(lane.jid, 'run-1', 'stop');
    // A runner from before the reason compares the trimmed file content with
    // its query id and only scans `.json` payloads.
    expect(
      fs.readFileSync(path.join(lane.inputDir, '_interrupt'), 'utf8'),
    ).toBe('run-1');
    const extra = fs
      .readdirSync(lane.inputDir)
      .filter((name) => name !== '_interrupt');
    expect(extra).toEqual(['_interrupt_reason']);
    expect(extra.some(isIpcInputPayloadFilename)).toBe(false);
  });

  test('an interrupt from a Host that predates the reason is a steer', () => {
    const lane = runningLane();
    fs.mkdirSync(lane.inputDir, { recursive: true });
    fs.writeFileSync(path.join(lane.inputDir, '_interrupt'), 'run-1');
    expect(consumeInterruptSentinel(lane.inputDir)).toEqual({
      queryRunId: 'run-1',
      reason: 'steer',
    });
  });

  test('a steer arriving before the runner read a stop keeps the stop', () => {
    const lane = runningLane();
    lane.queue.interruptQuery(lane.jid, 'run-1', 'stop');
    lane.queue.interruptQuery(lane.jid, 'run-1');
    expect(consumeInterruptSentinel(lane.inputDir)?.reason).toBe('stop');
  });

  test('a reason written for another query is neither used nor consumed', () => {
    const lane = runningLane();
    lane.queue.interruptQuery(lane.jid, 'run-1', 'stop');
    // A runner that predates the reason consumes only `_interrupt`; the next
    // query's steer must not inherit that stop.
    fs.unlinkSync(path.join(lane.inputDir, '_interrupt'));
    lane.state.queryId = 'run-2';
    lane.queue.interruptQuery(lane.jid, 'run-2');
    expect(consumeInterruptSentinel(lane.inputDir)).toEqual({
      queryRunId: 'run-2',
      reason: 'steer',
    });
    expect(fs.existsSync(path.join(lane.inputDir, '_interrupt_reason'))).toBe(
      true,
    );
    // Runner exit clears it with the other sentinels.
    (lane.queue as any).cleanupIpcSentinels(lane.folder, lane.agentId);
    expect(fs.readdirSync(lane.inputDir)).toEqual([]);
  });

  test('a cold-boot stop is published as a stop once the runner registers, and outranks a steer', () => {
    for (const order of [
      ['stop'],
      ['stop', 'steer'],
      ['steer', 'stop'],
    ] as const) {
      const lane = runningLane();
      lane.state.groupFolder = null;
      lane.state.agentId = null;
      lane.state.process = null;
      for (const reason of order) {
        expect(lane.queue.interruptQuery(lane.jid, 'run-1', reason)).toBe(true);
      }
      expect(fs.existsSync(lane.inputDir)).toBe(false);
      lane.queue.registerProcess(lane.jid, { pid: 4243 } as any, {
        containerName: null,
        groupFolder: lane.folder,
        agentId: lane.agentId,
      });
      expect(consumeInterruptSentinel(lane.inputDir)).toEqual({
        queryRunId: 'run-1',
        reason: 'stop',
      });
    }
  });
});

describe('Runner turn stop', () => {
  test('/break interrupts and gives the sub-agents a deadline, never stopping a task itself', () => {
    const lane = runningLane();
    const turn = runnerTurn();
    lane.queue.interruptQuery(lane.jid, 'run-1', 'stop');
    const { reason } = consumeInterruptSentinel(lane.inputDir)!;

    turn.stop('Interrupt sentinel', reason);
    expect(turn.calls).toEqual(['interrupt']);
    // The sub-agent outlasts the interrupt: the query is closed.
    vi.advanceTimersByTime(SUB_AGENT_STOP_CLOSE_DELAY_MS);
    expect(turn.calls).toEqual(['interrupt', 'close']);
    expect(turn.query.stopTask).not.toHaveBeenCalled();
  });

  test('steer and 「发送」 only interrupt, whatever keeps running', () => {
    const lane = runningLane();
    const turn = runnerTurn();
    lane.queue.interruptQuery(lane.jid, 'run-1');
    const { reason } = consumeInterruptSentinel(lane.inputDir)!;

    turn.stop('Interrupt sentinel', reason);
    vi.advanceTimersByTime(10 * SUB_AGENT_STOP_CLOSE_DELAY_MS);

    expect(turn.calls).toEqual(['interrupt']);
  });

  test('an interrupt from an older Host only interrupts', () => {
    const lane = runningLane();
    const turn = runnerTurn();
    fs.mkdirSync(lane.inputDir, { recursive: true });
    fs.writeFileSync(path.join(lane.inputDir, '_interrupt'), 'run-1');
    const { reason } = consumeInterruptSentinel(lane.inputDir)!;

    turn.stop('Interrupt sentinel', reason);
    vi.advanceTimersByTime(10 * SUB_AGENT_STOP_CLOSE_DELAY_MS);

    expect(turn.calls).toEqual(['interrupt']);
  });

  test("the runner's own interrupts only interrupt", () => {
    for (const label of [
      'Rate-limit interrupt',
      'Model-fallback interrupt',
      'Model-limit interrupt',
      'Sub-agent provider-error interrupt',
      'Close sentinel detected during query (shutdown)',
    ]) {
      const turn = runnerTurn();
      turn.stop(label);
      vi.advanceTimersByTime(10 * SUB_AGENT_STOP_CLOSE_DELAY_MS);
      expect(turn.calls, label).toEqual(['interrupt']);
    }
  });

  test('one sub-agent still running at the deadline closes the query', () => {
    const turn = runnerTurn();
    turn.stop('Interrupt sentinel', 'stop');
    vi.advanceTimersByTime(SUB_AGENT_STOP_CLOSE_DELAY_MS - 1);
    // The interrupt ended the sub-agent; the workflow is still running.
    turn.settle('agent-1');
    expect(turn.query.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(turn.query.close).toHaveBeenCalledOnce();
  });

  test('ended sub-agents leave the query open for the shells still running', () => {
    const turn = runnerTurn();
    turn.stop('Interrupt sentinel', 'stop');
    turn.settle('agent-1');
    turn.settle('workflow-1');
    vi.advanceTimersByTime(10 * SUB_AGENT_STOP_CLOSE_DELAY_MS);
    expect(turn.calls).toEqual(['interrupt']);
    expect(turn.processor.getPendingSdkTaskCount()).toBe(TURN_TASKS.length - 2);
  });

  test('a stop with only shells, monitors, MCP, untyped and nested tasks running never closes', () => {
    const turn = runnerTurn();
    turn.settle('agent-1', 'completed');
    turn.settle('workflow-1', 'completed');
    turn.stop('Interrupt sentinel', 'stop');
    vi.advanceTimersByTime(10 * SUB_AGENT_STOP_CLOSE_DELAY_MS);
    expect(turn.calls).toEqual(['interrupt']);
  });

  test('a query that ends, or is disposed, before the deadline is not closed', () => {
    const ended = runnerTurn();
    ended.stop('Interrupt sentinel', 'stop');
    ended.finishQuery();
    vi.advanceTimersByTime(SUB_AGENT_STOP_CLOSE_DELAY_MS);
    expect(ended.query.close).not.toHaveBeenCalled();

    const disposed = runnerTurn();
    disposed.stop('Interrupt sentinel', 'stop');
    disposed.stopper.dispose();
    vi.advanceTimersByTime(SUB_AGENT_STOP_CLOSE_DELAY_MS);
    expect(disposed.query.close).not.toHaveBeenCalled();
  });

  test('with later turns queued in Claude Code any interrupt closes at once', () => {
    for (const reason of ['stop', 'steer', undefined] as const) {
      const turn = runnerTurn();
      turn.stop('Interrupt sentinel', reason, 1);
      vi.advanceTimersByTime(10 * SUB_AGENT_STOP_CLOSE_DELAY_MS);
      expect(turn.calls, String(reason)).toEqual(['close']);
    }
  });
});

describe('Sub-agents an explicit stop waits on', () => {
  test('only the agent types Claude Code groups as agents, launched by the main Agent', () => {
    const processor = processorWithTasks([
      ['agent', 'local_agent'],
      ['remote', 'remote_agent'],
      ['teammate', 'in_process_teammate'],
      ['workflow', 'local_workflow'],
      ['shell', 'local_bash'],
      ['mcp-monitor', 'monitor_mcp'],
      ['ws-monitor', 'monitor_ws'],
      ['mcp', 'mcp_task'],
      ['dream', 'dream'],
      ['untyped'],
      ['child-of-agent', 'local_agent', { parent_task_id: 'agent' }],
      ['owned', 'local_agent', { owned_by_subagent: true }],
      ['deep', 'local_agent', { spawn_depth: 2 }],
    ]);
    // A level update can be the first frame naming a nested sub-agent.
    processor.processSystemMessage({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [
        { task_id: 'agent', task_type: 'local_agent', description: 'agent' },
        {
          task_id: 'listed-child',
          task_type: 'local_agent',
          description: 'child',
          parent_task_id: 'agent',
        },
      ],
    });
    expect(processor.getActiveSubAgentTaskIds()).toEqual([
      'agent',
      'remote',
      'teammate',
      'workflow',
    ]);
  });
});

describe('Sentinels are never seen half written', () => {
  test('the Host publishes `_interrupt` and its reason whole', () => {
    const lane = runningLane();
    fs.mkdirSync(lane.inputDir, { recursive: true });
    const realWrite = fs.writeFileSync;
    const seenEmpty: string[] = [];
    // A file exists, empty, before its content lands; a watcher may look then.
    const write = vi.spyOn(fs, 'writeFileSync').mockImplementation(((
      file: fs.PathOrFileDescriptor,
      data: string | NodeJS.ArrayBufferView,
    ) => {
      realWrite(file, '');
      for (const name of ['_interrupt', '_interrupt_reason']) {
        const visible = path.join(lane.inputDir, name);
        if (fs.existsSync(visible) && fs.readFileSync(visible, 'utf8') === '') {
          seenEmpty.push(name);
        }
      }
      realWrite(file, data);
    }) as typeof fs.writeFileSync);
    try {
      expect(lane.queue.interruptQuery(lane.jid, 'run-1', 'stop')).toBe(true);
    } finally {
      write.mockRestore();
    }
    expect(seenEmpty).toEqual([]);
    expect(fs.readdirSync(lane.inputDir).sort()).toEqual([
      '_interrupt',
      '_interrupt_reason',
    ]);
    expect(consumeInterruptSentinel(lane.inputDir)?.reason).toBe('stop');
  });

  test('the runner waits out an empty `_interrupt` instead of taking it without its query', () => {
    const lane = runningLane();
    fs.mkdirSync(lane.inputDir, { recursive: true });
    const sentinel = path.join(lane.inputDir, '_interrupt');
    fs.writeFileSync(sentinel, '');
    expect(consumeInterruptSentinel(lane.inputDir)).toBeNull();
    vi.advanceTimersByTime(500);
    expect(consumeInterruptSentinel(lane.inputDir)).toBeNull();
    expect(fs.existsSync(sentinel)).toBe(true);
    // An older Host finished writing it in place.
    fs.writeFileSync(sentinel, 'run-1');
    expect(consumeInterruptSentinel(lane.inputDir)).toEqual({
      queryRunId: 'run-1',
      reason: 'steer',
    });

    // One that stays empty is the legacy interrupt without a query id.
    fs.writeFileSync(sentinel, '');
    expect(consumeInterruptSentinel(lane.inputDir)).toBeNull();
    vi.advanceTimersByTime(1_000);
    expect(consumeInterruptSentinel(lane.inputDir)).toEqual({
      queryRunId: '',
      reason: 'steer',
    });
  });
});

describe('A stop after a steer the runner already acted on', () => {
  test('is taken while the steered query winds down and gives its sub-agents the deadline', () => {
    const lane = runningLane();
    const turn = runnerTurn();
    lane.queue.interruptQuery(lane.jid, 'run-1');
    turn.stop(
      'Interrupt sentinel',
      consumeInterruptSentinel(lane.inputDir)!.reason,
    );
    // Another steer, and a stop meant for the next query, are left alone.
    lane.queue.interruptQuery(lane.jid, 'run-1');
    expect(consumeStopAfterSteer(lane.inputDir, 'run-1')).toBe(false);
    lane.state.queryId = 'run-2';
    lane.queue.interruptQuery(lane.jid, 'run-2', 'stop');
    expect(consumeStopAfterSteer(lane.inputDir, 'run-1')).toBe(false);

    lane.state.queryId = 'run-1';
    lane.queue.interruptQuery(lane.jid, 'run-1', 'stop');
    expect(consumeStopAfterSteer(lane.inputDir, 'run-1')).toBe(true);
    expect(fs.readdirSync(lane.inputDir)).toEqual([]);
    turn.stopper.requireSubAgentsToEnd(turn.query as any, 'Stop after steer');
    vi.advanceTimersByTime(SUB_AGENT_STOP_CLOSE_DELAY_MS);
    expect(turn.calls).toEqual(['interrupt', 'close']);
  });

  test('the runner keeps watching for it after a steer, and only after a steer', async () => {
    vi.useRealTimers();
    for (const [first, expectedLog] of [
      ['steer', 'Stop after steer: 2 sub-agent(s) must end within 3s'],
      ['stop', 'Interrupt sentinel: 2 sub-agent(s) must end within 3s'],
    ] as const) {
      const lane = runningLane();
      fs.mkdirSync(lane.inputDir, { recursive: true });
      const turn = runnerTurn();
      const runner = runnerPollHarness(lane.inputDir, turn);
      lane.queue.interruptQuery(lane.jid, 'run-1', first);
      await runner.poll();
      expect(runner.globals.ipcPolling).toBe(false);
      lane.queue.interruptQuery(lane.jid, 'run-1', 'stop');
      // Long enough for the watch to fire (it debounces by 50 ms).
      const deadline = Date.now() + 2_000;
      await new Promise((resolve) => setTimeout(resolve, 300));
      while (!turn.logs.includes(expectedLog) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(
        turn.logs.filter((line) => line.includes('must end within')),
        first,
      ).toEqual([expectedLog]);
      // After an explicit stop the second one is left for the query's end.
      expect(fs.existsSync(path.join(lane.inputDir, '_interrupt')), first).toBe(
        first === 'stop',
      );
      turn.stopper.dispose();
      runner.globals.stopAfterSteerWatcher?.close();
    }
  }, 10_000);
});

/**
 * The runner's own sentinel reader and IPC poll, run from its source against
 * the turn's real stopper; only the query's surroundings are faked.
 */
function runnerPollHarness(
  inputDir: string,
  turn: ReturnType<typeof runnerTurn>,
) {
  const globals: Record<string, any> = {
    fs,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    IPC_INPUT_DIR: inputDir,
    IPC_FALLBACK_POLL_MS: 5_000,
    log: () => {},
    consumeInterruptSentinel,
    consumeStopAfterSteer,
    activeInterruptQueryRunId: 'run-1',
    lastInterruptRequestedAt: 0,
    activeTurnStopper: turn.stopper,
    queryRef: turn.query,
    ipcPolling: true,
    shouldClose: () => false,
    cancelBackgroundResultCompletion: () => {},
    clearBackgroundProtocolDebtWatchdog: () => {},
    interruptedDuringQuery: false,
    suppressOutputAfterInterrupt: false,
    cancelledIpcReceipts: [],
    visibleOutputStarted: true,
    resultCount: 1,
    containerInput: { turnId: 'turn-1' },
    generateTurnId: () => 'turn-x',
    emitResultUsage: () => {},
    ipcDeliveryTracker: { laterTurnMessages: [], cancelCurrentTurn: () => [] },
    stream: { end: () => {} },
    ipcQueryWatcher: { close: () => {} },
    stopAfterSteerWatcher: undefined,
  };
  const harness = createRuntimeSourceHarness(globals, RUNNER_SOURCE);
  for (const name of [
    'markInterruptRequested',
    'shouldInterrupt',
    'createIpcWatcher',
  ]) {
    harness.install(name);
  }
  for (const name of [
    'stopActiveTurn',
    'watchForStopAfterSteer',
    'pollIpcDuringQuery',
  ]) {
    harness.install(name, 'runQueryAttempt');
  }
  return {
    globals,
    poll: () => globals.pollIpcDuringQuery() as Promise<void>,
  };
}
