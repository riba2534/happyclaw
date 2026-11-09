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
  /** Age of the oldest IPC input still owed by the current logical query. */
  ipcOwedMs: number | null;
  /** The query in flight holds its result for unsettled background work
   * (sub-agent Tasks, workflows); see GroupQueue.markRunnerBackgroundHold. */
  backgroundTasksHeld: boolean;
}

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
 * A query holding its result for unsettled background work is not stuck: the
 * CLI takes owed input only after that work settles, and a sub-agent waiting
 * on the network shows neither output nor CPU. Restarting would kill it. Such
 * a runner is bounded instead by the no-output watchdog (CONTAINER_TIMEOUT),
 * which kills it after a fully silent stall; the IPC ceiling resumes, from the
 * moment the hold ends, for input still owed afterwards.
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
