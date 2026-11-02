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
});
