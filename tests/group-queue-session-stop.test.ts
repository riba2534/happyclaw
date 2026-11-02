/**
 * Stops reach sessions wherever they come from: an explicit stop between two
 * failed attempts ends the armed retry, and a workspace JID — which runs
 * nothing itself — stops or restarts every session lane of that workspace.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: '/tmp/happyclaw-group-queue-session-stop',
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/container-runner.js', () => ({
  killProcessTree: vi.fn((proc: { kill?: () => void }) => void proc.kill?.()),
}));
vi.mock('../src/runtime-config.js', () => ({
  getSystemSettings: () => ({
    maxConcurrentContainers: 10,
    maxConcurrentHostProcesses: 10,
  }),
}));
vi.mock('../src/db.js', () => ({}));

const { GroupQueue, setRetryJitterSourceForTesting } =
  await import('../src/group-queue.js');

const WORKSPACE = 'web:session-stop';
const LANE = `${WORKSPACE}#agent:s1`;
const SNAPSHOT = {
  coveredCursors: [{ timestamp: '2026-11-02T00:00:00.000Z', id: 'in-1' }],
  cursor: { timestamp: '2026-11-02T00:00:00.000Z', id: 'in-1' },
};
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

let queue: InstanceType<typeof GroupQueue>;

afterEach(async () => {
  await queue.shutdown(0);
  setRetryJitterSourceForTesting(null);
  vi.useRealTimers();
});

describe('a stop between failed attempts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setRetryJitterSourceForTesting(() => 0);
    queue = new GroupQueue();
  });

  /** A turn that fails once and arms a retry; returns how often it ran. */
  async function failedOnce(): Promise<() => number> {
    let runs = 0;
    queue.enqueueTask(LANE, 'turn', async () => {
      runs += 1;
      queue.setMessageRetrySnapshot(LANE, SNAPSHOT);
      return false;
    });
    await flush();
    expect(queue.getRetryCount(LANE)).toBe(1);
    return () => runs;
  }

  test('ends the armed retry and hands the failed batch to the host', async () => {
    const stopped = vi.fn();
    queue.setOnRetryStopped(stopped);
    const runs = await failedOnce();

    expect(queue.interruptQuery(LANE, undefined, 'stop')).toBe(true);
    expect(stopped).toHaveBeenCalledWith(LANE, SNAPSHOT);
    expect(queue.getRetryCount(LANE)).toBe(0);

    await vi.advanceTimersByTimeAsync(60_000);
    await flush();
    expect(runs()).toBe(1);
    // Nothing left to stop.
    expect(queue.interruptQuery(LANE, undefined, 'stop')).toBe(false);
    expect(queue.stopArmedRetry(LANE)).toBe(false);
  });

  test('ends a retry that fired and waits for a slot; later queued work stays', async () => {
    const stopped = vi.fn();
    queue.setOnRetryStopped(stopped);
    const runs = await failedOnce();
    let slot = false;
    queue.setUserConcurrentLimitChecker(() => ({
      allowed: slot,
      userId: 'owner',
    }));
    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    // The retry's timer fired; its task waits for the owner's runner slot.
    expect(runs()).toBe(1);
    let laterRuns = 0;
    queue.enqueueTask(LANE, 'later-turn', async () => {
      laterRuns += 1;
    });

    expect(queue.interruptQuery(LANE, undefined, 'stop')).toBe(true);
    expect(stopped).toHaveBeenCalledWith(LANE, SNAPSHOT);

    slot = true;
    (queue as unknown as { drainWaiting(): void }).drainWaiting();
    await flush();
    expect(runs()).toBe(1);
    expect(laterRuns).toBe(1);
    expect(queue.stopArmedRetry(LANE)).toBe(false);
  });

  test('a steer, or a stop of another named query, leaves the retry armed', async () => {
    const stopped = vi.fn();
    queue.setOnRetryStopped(stopped);
    const runs = await failedOnce();

    expect(queue.interruptQuery(LANE)).toBe(false);
    expect(queue.interruptQuery(LANE, 'an-older-query', 'stop')).toBe(false);
    expect(stopped).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5_000);
    await flush();
    expect(runs()).toBe(2);
  });
});

describe('a workspace JID', () => {
  beforeEach(() => {
    queue = new GroupQueue();
    queue.setHostModeChecker(() => true);
  });

  /** A session lane whose runner lives until it is killed. */
  async function runningLane(jid: string): Promise<void> {
    let exit!: () => void;
    const done = new Promise<void>((resolve) => (exit = resolve));
    queue.enqueueTask(jid, `turn-${jid}`, async () => {
      queue.registerProcess(
        jid,
        {
          killed: false,
          kill: () => {
            exit();
            return true;
          },
        } as never,
        {
          containerName: null,
          groupFolder: 'session-stop',
          agentId: jid.slice(jid.indexOf('#agent:') + 7),
        },
      );
      await done;
    });
    await flush();
    expect(queue.hasDirectActiveRunner(jid)).toBe(true);
  }
  const running = (jid: string) => queue.hasDirectActiveRunner(jid);

  test('stops every session lane of the workspace, and only those', async () => {
    const lanes = [
      `${WORKSPACE}#agent:s1`,
      `${WORKSPACE}#agent:s2`,
      'web:another#agent:s3',
    ];
    for (const jid of lanes) await runningLane(jid);

    await queue.stopGroup(WORKSPACE, { force: true });

    expect(lanes.map(running)).toEqual([false, false, true]);
  });

  test('restarts every running session lane and starts each again', async () => {
    const starts: string[] = [];
    queue.setLaneStarter((jid, reason) => starts.push(`${jid}:${reason}`));
    await runningLane(`${WORKSPACE}#agent:s1`);
    await runningLane('web:another#agent:s3');

    await queue.restartGroup(WORKSPACE);

    expect(running(`${WORKSPACE}#agent:s1`)).toBe(false);
    expect(running('web:another#agent:s3')).toBe(true);
    expect(starts).toEqual([`${WORKSPACE}#agent:s1:restart`]);
  });
});
