import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const {
  decideStuckRunnerRecovery,
  probeHostRunnerCpu,
  resolveRunnerCpuActivity,
} = await import('../src/stuck-runner-recovery.js');
const { logger } = await import('../src/logger.js');
const { createRuntimeSourceHarness } =
  await import('./helpers/runtime-source.js');

type Candidate =
  import('../src/stuck-runner-recovery.js').StuckRecoveryCandidate;

const FORCE_RESTART_MS = 10 * 60 * 1000;

function ipcCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    jid: 'web:stuck-policy',
    idleMs: 3 * 60 * 1000,
    reason: 'ipc_injected',
    runtime: 'host',
    runnerGeneration: 1,
    queryId: 'query-1',
    runnerPid: 4242,
    ipcOwedSinceAt: 1,
    ipcOwedMs: 3 * 60 * 1000,
    backgroundTasksHeld: false,
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('stuck runner recovery policy', () => {
  test('host CPU activity defers at 3m but the absolute IPC ceiling forces at 10m', () => {
    expect(
      decideStuckRunnerRecovery(ipcCandidate(), 'active', FORCE_RESTART_MS),
    ).toEqual({ action: 'defer', reason: 'cpu_active' });

    expect(
      decideStuckRunnerRecovery(
        ipcCandidate({ ipcOwedMs: FORCE_RESTART_MS }),
        'active',
        FORCE_RESTART_MS,
      ),
    ).toEqual({ action: 'restart', reason: 'absolute_ipc_ceiling' });

    expect(
      decideStuckRunnerRecovery(
        ipcCandidate({
          reason: 'pending_tasks',
          idleMs: FORCE_RESTART_MS,
          ipcOwedMs: null,
        }),
        'active',
        FORCE_RESTART_MS,
      ),
    ).toEqual({ action: 'restart', reason: 'idle_ceiling' });
  });

  test('container work is never inferred from the host docker CLI process tree', () => {
    expect(
      decideStuckRunnerRecovery(
        ipcCandidate({ runtime: 'container' }),
        'unavailable',
        FORCE_RESTART_MS,
      ),
    ).toEqual({ action: 'defer', reason: 'container_grace' });

    expect(
      decideStuckRunnerRecovery(
        ipcCandidate({
          runtime: 'container',
          idleMs: 30_000,
          ipcOwedMs: FORCE_RESTART_MS,
        }),
        'unavailable',
        FORCE_RESTART_MS,
      ),
    ).toEqual({ action: 'restart', reason: 'absolute_ipc_ceiling' });

    expect(
      decideStuckRunnerRecovery(
        ipcCandidate({
          reason: 'pending_tasks',
          runtime: 'container',
          idleMs: FORCE_RESTART_MS,
          ipcOwedMs: null,
        }),
        'unavailable',
        FORCE_RESTART_MS,
      ),
    ).toEqual({ action: 'restart', reason: 'idle_ceiling' });
  });

  test('container runtime never invokes the host process-tree probe', async () => {
    const hostProbe = vi.fn().mockResolvedValue('active');

    await expect(
      resolveRunnerCpuActivity(
        ipcCandidate({ runtime: 'container', runnerPid: 4242 }),
        hostProbe,
      ),
    ).resolves.toBe('unavailable');
    expect(hostProbe).not.toHaveBeenCalled();
  });

  test('host CPU probe failures log context and conservatively defer', async () => {
    const candidate = ipcCandidate();
    const cpuActivity = await probeHostRunnerCpu(4242, candidate, async () => {
      throw new Error('ps unavailable');
    });

    expect(cpuActivity).toBe('unknown');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        chatJid: candidate.jid,
        pid: 4242,
        idleMs: candidate.idleMs,
        reason: candidate.reason,
        runtime: candidate.runtime,
        ipcOwedMs: candidate.ipcOwedMs,
      }),
      'Failed to inspect host runner descendant CPU; deferring stuck restart',
    );
    expect(
      decideStuckRunnerRecovery(candidate, cpuActivity, FORCE_RESTART_MS),
    ).toEqual({ action: 'defer', reason: 'cpu_unknown' });

    expect(
      decideStuckRunnerRecovery(
        { ...candidate, idleMs: FORCE_RESTART_MS },
        cpuActivity,
        FORCE_RESTART_MS,
      ),
    ).toEqual({ action: 'restart', reason: 'idle_ceiling' });
  });

  test('host CPU probe detects active nested descendants', async () => {
    const cpuActivity = await probeHostRunnerCpu(
      100,
      ipcCandidate(),
      async () => ['100 1 0.0', '200 100 0.0', '300 200 1.5'].join('\n'),
    );

    expect(cpuActivity).toBe('active');
  });

  test('container pending-message recovery gets the same 3m grace', () => {
    const pending: Candidate = {
      ...ipcCandidate(),
      reason: 'pending_tasks',
      runtime: 'container',
      ipcOwedMs: null,
    };

    expect(
      decideStuckRunnerRecovery(pending, 'unavailable', FORCE_RESTART_MS),
    ).toEqual({ action: 'defer', reason: 'container_grace' });
  });

  test('a result held for background work defers every restart rule', () => {
    const held = { backgroundTasksHeld: true };
    const deferred = { action: 'defer', reason: 'background_tasks' };

    // absolute_ipc_ceiling: owed IPC past the ceiling with fresh output.
    expect(
      decideStuckRunnerRecovery(
        ipcCandidate({ ...held, idleMs: 400, ipcOwedMs: FORCE_RESTART_MS }),
        'active',
        FORCE_RESTART_MS,
      ),
    ).toEqual(deferred);
    // idle: a sub-agent waiting on the network shows no CPU.
    expect(
      decideStuckRunnerRecovery(
        ipcCandidate(held),
        'inactive',
        FORCE_RESTART_MS,
      ),
    ).toEqual(deferred);
    // idle_ceiling: silent past the ceiling, left to the no-output watchdog.
    expect(
      decideStuckRunnerRecovery(
        ipcCandidate({
          ...held,
          idleMs: FORCE_RESTART_MS,
          ipcOwedMs: FORCE_RESTART_MS,
        }),
        'inactive',
        FORCE_RESTART_MS,
      ),
    ).toEqual(deferred);
    expect(
      decideStuckRunnerRecovery(
        ipcCandidate({
          ...held,
          runtime: 'container',
          ipcOwedMs: FORCE_RESTART_MS,
        }),
        'unavailable',
        FORCE_RESTART_MS,
      ),
    ).toEqual(deferred);
  });

  test('once background work settles the original rules apply again', () => {
    expect(
      decideStuckRunnerRecovery(
        ipcCandidate({ ipcOwedMs: FORCE_RESTART_MS }),
        'active',
        FORCE_RESTART_MS,
      ),
    ).toEqual({ action: 'restart', reason: 'absolute_ipc_ceiling' });
    expect(
      decideStuckRunnerRecovery(ipcCandidate(), 'inactive', FORCE_RESTART_MS),
    ).toEqual({ action: 'restart', reason: 'idle' });
    expect(
      decideStuckRunnerRecovery(
        ipcCandidate({ idleMs: FORCE_RESTART_MS, ipcOwedMs: null }),
        'active',
        FORCE_RESTART_MS,
      ),
    ).toEqual({ action: 'restart', reason: 'idle_ceiling' });
  });
});

describe('the recovery patrol', () => {
  // recoverStuckPendingGroups from index.ts, over a queue that reports the
  // given candidates as they stand at each patrol.
  function patrol(candidates: () => Candidate[]) {
    const queue = {
      getStuckPendingGroups: vi.fn(candidates),
      revalidateStuckRecoveryCandidate: vi.fn((candidate: Candidate) =>
        candidates().find((current) => current.jid === candidate.jid),
      ),
      getActiveQueryId: vi.fn(
        (jid: string) =>
          candidates().find((current) => current.jid === jid)?.queryId ?? null,
      ),
      restartGroup: vi.fn(async () => {}),
    };
    const log = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const globals: Record<string, unknown> = {
      queue,
      logger: log,
      resolveRunnerCpuActivity: vi.fn(async () => 'inactive'),
      decideStuckRunnerRecovery,
      STUCK_RUNNER_IDLE_MS: 3 * 60 * 1000,
      STUCK_RUNNER_FORCE_RESTART_MS: FORCE_RESTART_MS,
      loggedBackgroundHoldQueries: new Map(),
    };
    createRuntimeSourceHarness(globals).install('recoverStuckPendingGroups');
    return {
      run: globals.recoverStuckPendingGroups as () => Promise<void>,
      probe: globals.resolveRunnerCpuActivity,
      queue,
      log,
    };
  }

  const deferredForBackground = (log: { info: unknown; debug: unknown }) =>
    [log.info, log.debug].map(
      (fn) =>
        (fn as ReturnType<typeof vi.fn>).mock.calls.filter(
          ([fields]) => fields?.deferReason === 'background_tasks',
        ).length,
    );

  test('a held query is left alone without a CPU probe, logged once per query', async () => {
    let held = ipcCandidate({
      backgroundTasksHeld: true,
      ipcOwedMs: FORCE_RESTART_MS,
    });
    const run = patrol(() => [held]);

    await run.run();
    await run.run();
    expect(run.probe).not.toHaveBeenCalled();
    expect(run.queue.restartGroup).not.toHaveBeenCalled();
    expect(deferredForBackground(run.log)).toEqual([1, 1]);

    // The next query held on the same runner is a new hold.
    held = { ...held, queryId: 'query-2' };
    await run.run();
    expect(run.probe).not.toHaveBeenCalled();
    expect(deferredForBackground(run.log)).toEqual([2, 1]);
  });

  test('a query that is not held is probed and judged as before', async () => {
    const run = patrol(() => [ipcCandidate()]);

    await run.run();

    expect(run.probe).toHaveBeenCalledTimes(1);
    expect(run.queue.restartGroup).toHaveBeenCalledWith('web:stuck-policy');
  });
});
