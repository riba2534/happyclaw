import { execFile } from 'child_process';
import { promisify } from 'util';

import { logger } from './logger.js';

export type RunnerRuntime = 'host' | 'container';
export type RunnerCpuActivity =
  | 'active'
  | 'inactive'
  | 'unknown'
  | 'unavailable';

export interface StuckRecoveryCandidate {
  jid: string;
  idleMs: number;
  reason: 'pending_tasks' | 'ipc_injected';
  runtime: RunnerRuntime;
  /** Monotonic identity of the concrete GroupQueue runner lifecycle. */
  runnerGeneration: number;
  /** Exact logical query observed when the candidate was selected. */
  queryId: string | null;
  /** Host-side process identity used by the CPU probe, if registered. */
  runnerPid: number | null;
  /** Absolute debt clock used to reject a later query's fresh IPC work. */
  ipcOwedSinceAt: number | null;
  /** Age of the oldest IPC input still owed by the current logical query;
   * null for an `ipc_injected` candidate whose opening input the model has
   * answered, which only the idle rule can restart. */
  ipcOwedMs: number | null;
  /** How long the query in flight has held its result for unsettled
   * background work (see GroupQueue.markRunnerBackgroundHold); null when it
   * holds none. */
  backgroundHoldMs: number | null;
  /** The hold defers recovery: it is younger than BACKGROUND_HOLD_MAX_MS. */
  backgroundTasksHeld: boolean;
}

/**
 * How long a result held for background work keeps stuck recovery off, from
 * the hold's first result; a hold that ends and comes back starts again. The
 * Runner's keepalive for the host's idle close and process watchdog stops at
 * the same bound (BACKGROUND_HOLD_KEEPALIVE_MAX_MS in the agent-runner).
 */
export const BACKGROUND_HOLD_MAX_MS = 2 * 60 * 60 * 1000;

export type StuckRecoveryDecision =
  | {
      action: 'restart';
      reason: 'idle' | 'idle_ceiling' | 'absolute_ipc_ceiling';
    }
  | {
      action: 'defer';
      reason:
        | 'background_tasks'
        | 'container_grace'
        | 'cpu_active'
        | 'cpu_unknown';
    };

export type HostProcessTableReader = () => Promise<string>;
export type HostRunnerCpuProbe = (
  pid: number,
  context: StuckRecoveryCandidate,
) => Promise<RunnerCpuActivity>;

const execFileAsync = promisify(execFile);

async function readHostProcessTable(): Promise<string> {
  const { stdout } = await execFileAsync('ps', ['-eo', 'pid=,ppid=,pcpu='], {
    timeout: 3000,
    encoding: 'utf8',
  });
  return stdout;
}

/**
 * Inspect a host runner's real descendant process tree. Docker workloads are
 * deliberately excluded: container processes belong to Docker/containerd,
 * not to the host-side `docker` CLI process tree.
 */
export async function probeHostRunnerCpu(
  pid: number,
  context: Pick<
    StuckRecoveryCandidate,
    'jid' | 'idleMs' | 'reason' | 'runtime' | 'ipcOwedMs'
  >,
  readProcessTable: HostProcessTableReader = readHostProcessTable,
): Promise<RunnerCpuActivity> {
  try {
    const stdout = await readProcessTable();
    const children = new Map<number, number[]>();
    const cpuByPid = new Map<number, number>();
    for (const line of stdout.trim().split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 3) continue;
      const processPid = Number.parseInt(parts[0], 10);
      const parentPid = Number.parseInt(parts[1], 10);
      const cpu = Number.parseFloat(parts[2]);
      if (
        Number.isNaN(processPid) ||
        Number.isNaN(parentPid) ||
        Number.isNaN(cpu)
      ) {
        continue;
      }
      const siblings = children.get(parentPid) ?? [];
      siblings.push(processPid);
      children.set(parentPid, siblings);
      cpuByPid.set(processPid, cpu);
    }

    const visited = new Set<number>();
    const stack = [pid];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (visited.has(current)) continue;
      visited.add(current);
      const descendants = children.get(current);
      if (!descendants) continue;
      for (const descendant of descendants) {
        if ((cpuByPid.get(descendant) ?? 0) > 0.5) return 'active';
        stack.push(descendant);
      }
    }
    return 'inactive';
  } catch (err) {
    logger.warn(
      {
        err,
        chatJid: context.jid,
        pid,
        idleMs: context.idleMs,
        reason: context.reason,
        runtime: context.runtime,
        ipcOwedMs: context.ipcOwedMs,
      },
      'Failed to inspect host runner descendant CPU; deferring stuck restart',
    );
    return 'unknown';
  }
}

/**
 * Resolve observable CPU activity without crossing runtime boundaries. The
 * host-side Docker CLI PID is lifecycle plumbing, not the container workload.
 */
export async function resolveRunnerCpuActivity(
  candidate: StuckRecoveryCandidate,
  probe: HostRunnerCpuProbe = probeHostRunnerCpu,
): Promise<RunnerCpuActivity> {
  const pid = candidate.runnerPid;
  if (candidate.runtime !== 'host' || !pid) return 'unavailable';
  return probe(pid, candidate);
}

/**
 * Decide whether an already-idle candidate should restart now. IPC work uses
 * an absolute debt age that ordinary output cannot refresh. Before that
 * ceiling, container work is conservatively preserved because host `ps`
 * cannot observe CPU inside Docker; host probe failures are likewise deferred.
 *
 * A query holding its result for unsettled background work is deferred: the
 * Runner sends no completion receipt until that work settles, so its IPC debt
 * cannot be paid, and a sub-agent waiting on the network shows neither output
 * nor CPU. Restarting would kill it. The Runner keeps the host's idle close
 * and process watchdog off meanwhile, so the hold itself is the bound: past
 * BACKGROUND_HOLD_MAX_MS the deferral lapses and the rules below judge the
 * query on its original clocks (input owed since before then meets the IPC
 * ceiling at once), and the keepalive has stopped, so silence closes the
 * runner as before. The IPC ceiling resumes, from the moment the hold ends,
 * for input still owed.
 */
export function decideStuckRunnerRecovery(
  candidate: StuckRecoveryCandidate,
  cpuActivity: RunnerCpuActivity,
  forceRestartMs: number,
): StuckRecoveryDecision {
  if (candidate.backgroundTasksHeld) {
    return { action: 'defer', reason: 'background_tasks' };
  }

  if (
    candidate.reason === 'ipc_injected' &&
    candidate.ipcOwedMs !== null &&
    candidate.ipcOwedMs >= forceRestartMs
  ) {
    return { action: 'restart', reason: 'absolute_ipc_ceiling' };
  }

  // CPU activity and unobservable container work are grace signals, not an
  // unlimited veto. Pending-task recovery still needs a hard upper bound.
  if (candidate.idleMs >= forceRestartMs) {
    return { action: 'restart', reason: 'idle_ceiling' };
  }

  if (candidate.runtime === 'container') {
    return { action: 'defer', reason: 'container_grace' };
  }

  if (cpuActivity === 'active') {
    return { action: 'defer', reason: 'cpu_active' };
  }
  if (cpuActivity === 'unknown') {
    return { action: 'defer', reason: 'cpu_unknown' };
  }
  return { action: 'restart', reason: 'idle' };
}
