import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/config.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  DATA_DIR: '/tmp/happyclaw-group-queue-close-retry',
}));
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/container-runner.js', () => ({
  killProcessTree: vi.fn(),
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

const JID = 'web:close-retry#agent:conversation';
const flushPromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

let queue: InstanceType<typeof GroupQueue>;
let taskSeq = 0;

/** One conversation turn on the lane; a false result asks for a retry. */
function enqueueTurn(fn: () => Promise<boolean>): void {
  queue.enqueueTask(JID, `turn-${++taskSeq}`, fn);
}

beforeEach(() => {
  vi.useFakeTimers();
  // Exact base backoff; jitter bounds are covered separately below.
  setRetryJitterSourceForTesting(() => 0);
  queue = new GroupQueue();
});

afterEach(async () => {
  await queue.shutdown(0);
  setRetryJitterSourceForTesting(null);
  vi.useRealTimers();
});

describe('GroupQueue close outcome retry lifecycle', () => {
  test('replays after backoff without requiring a new message', async () => {
    let runs = 0;
    enqueueTurn(async () => {
      runs += 1;
      // First result models closed + no reply + no healthy input completion;
      // the replay then models a completed turn.
      return runs > 1;
    });
    await flushPromises();
    expect(runs).toBe(1);
    expect(queue.getRetryCount(JID)).toBe(1);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(runs).toBe(1);

    // No enqueue call occurs here: expiry of the queue-owned backoff timer
    // alone must start the replay.
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(runs).toBe(2);
    expect(queue.getRetryCount(JID)).toBe(0);
  });

  test('user stop cancels a pending failed-run retry', async () => {
    let runs = 0;
    enqueueTurn(async () => {
      runs += 1;
      return false;
    });
    await flushPromises();
    expect(queue.getRetryCount(JID)).toBe(1);

    await queue.stopGroup(JID);
    await vi.advanceTimersByTimeAsync(5_000);
    await flushPromises();

    expect(runs).toBe(1);
    expect(queue.getRetryCount(JID)).toBe(0);
  });

  test('restart owns one fresh launch and leaves no duplicate retry timer', async () => {
    let runs = 0;
    let finishReplacement!: () => void;
    const replacementFinished = new Promise<void>((resolve) => {
      finishReplacement = resolve;
    });
    const turn = async () => {
      runs += 1;
      if (runs === 1) return false;
      if (runs === 2) await replacementFinished;
      return true;
    };
    const started: string[] = [];
    queue.setLaneStarter((jid) => {
      started.push(jid);
      enqueueTurn(turn);
    });

    enqueueTurn(turn);
    await flushPromises();
    expect(runs).toBe(1);
    expect(queue.getRetryCount(JID)).toBe(1);

    await queue.restartGroup(JID);
    await flushPromises();
    expect(started).toEqual([JID]);
    expect(runs).toBe(2);
    expect(queue.getRetryCount(JID)).toBe(0);

    // Keep the replacement in-flight past the old timer's deadline. A stale
    // timer would enqueue/drain it and cause a third run after completion.
    await vi.advanceTimersByTimeAsync(5_000);
    await flushPromises();
    expect(runs).toBe(2);

    finishReplacement();
    await flushPromises();
    expect(runs).toBe(2);
  });

  test('a fresh turn supersedes the pending failed-run timer', async () => {
    let runs = 0;
    let finishFreshRun!: () => void;
    const freshRunFinished = new Promise<void>((resolve) => {
      finishFreshRun = resolve;
    });
    const turn = async () => {
      runs += 1;
      if (runs === 1) return false;
      await freshRunFinished;
      return true;
    };

    enqueueTurn(turn);
    await flushPromises();
    expect(runs).toBe(1);
    expect(queue.getRetryCount(JID)).toBe(1);

    // A newly-arrived turn starts immediately and owns recovery. The old 5s
    // timer must not drain or enqueue this in-flight replacement.
    enqueueTurn(turn);
    await flushPromises();
    expect(runs).toBe(2);

    await vi.advanceTimersByTimeAsync(5_000);
    await flushPromises();
    expect(runs).toBe(2);

    finishFreshRun();
    await flushPromises();
    expect(runs).toBe(2);
  });

  test('consecutive failures exhaust the bounded exponential backoff', async () => {
    let runs = 0;
    const onMaxRetriesExceeded = vi.fn();
    queue.setOnMaxRetriesExceeded(onMaxRetriesExceeded);
    enqueueTurn(async () => {
      runs += 1;
      return false;
    });
    await flushPromises();
    expect(runs).toBe(1);
    expect(queue.getRetryCount(JID)).toBe(1);

    await vi.advanceTimersByTimeAsync(5_000);
    await flushPromises();
    expect(runs).toBe(2);
    expect(queue.getRetryCount(JID)).toBe(2);

    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();
    expect(runs).toBe(3);
    expect(queue.getRetryCount(JID)).toBe(3);

    await vi.advanceTimersByTimeAsync(20_000);
    await flushPromises();
    expect(runs).toBe(4);

    await vi.advanceTimersByTimeAsync(40_000);
    await flushPromises();
    expect(runs).toBe(5);
    expect(queue.getRetryCount(JID)).toBe(5);

    await vi.advanceTimersByTimeAsync(80_000);
    await flushPromises();
    expect(runs).toBe(6);
    expect(onMaxRetriesExceeded).toHaveBeenCalledOnce();
    // No attempt registered a batch.
    expect(onMaxRetriesExceeded).toHaveBeenCalledWith(JID, null);
    expect(queue.getRetryCount(JID)).toBe(0);

    await vi.advanceTimersByTimeAsync(60_000);
    await flushPromises();
    expect(runs).toBe(6);
  });

  test('max retry awaits the exact final-attempt snapshot and excludes later work', async () => {
    const ordinaryCursor = {
      timestamp: '2026-07-30T00:00:00.000Z',
      id: 'ordinary-before-scheduled',
    };
    const failedCursor = {
      timestamp: '2026-07-30T00:00:01.000Z',
      id: 'scheduled-task-prompt:failed-run',
    };
    const laterCursor = {
      timestamp: '2026-07-30T00:00:02.000Z',
      id: 'scheduled-task-prompt:later-run',
    };
    let runs = 0;
    let releaseTerminal!: () => void;
    const terminalReleased = new Promise<void>((resolve) => {
      releaseTerminal = resolve;
    });
    const observedSnapshots: unknown[] = [];

    const turn = async () => {
      runs += 1;
      queue.setMessageRetrySnapshot(JID, {
        coveredCursors:
          runs <= 6 ? [ordinaryCursor, failedCursor] : [laterCursor],
        cursor: runs <= 6 ? failedCursor : laterCursor,
      });
      return runs > 6;
    };
    queue.setOnMaxRetriesExceeded(async (_jid, snapshot) => {
      observedSnapshots.push(snapshot);
      await terminalReleased;
    });

    enqueueTurn(turn);
    await flushPromises();
    for (const delay of [5_000, 10_000, 20_000, 40_000, 80_000]) {
      await vi.advanceTimersByTimeAsync(delay);
      await flushPromises();
    }
    expect(runs).toBe(6);
    expect(observedSnapshots).toEqual([
      {
        coveredCursors: [ordinaryCursor, failedCursor],
        cursor: failedCursor,
      },
    ]);

    // This models a new prompt arriving after the final attempt snapshot.
    // The active max-retry callback must finish its exact terminal work before
    // the queue starts the new batch, and the old callback never sees B.
    enqueueTurn(turn);
    await flushPromises();
    expect(runs).toBe(6);

    releaseTerminal();
    await flushPromises();
    expect(runs).toBe(7);
    expect(observedSnapshots).toHaveLength(1);
  });

  test('a later attempt that registers no batch does not inherit an earlier snapshot', async () => {
    const cursor = { timestamp: '2026-07-30T00:00:00.000Z', id: 'first' };
    let runs = 0;
    const onMaxRetriesExceeded = vi.fn();
    queue.setOnMaxRetriesExceeded(onMaxRetriesExceeded);
    enqueueTurn(async () => {
      runs += 1;
      if (runs === 1) {
        queue.setMessageRetrySnapshot(JID, {
          coveredCursors: [cursor],
          cursor,
        });
      }
      return false;
    });
    await flushPromises();
    for (const delay of [5_000, 10_000, 20_000, 40_000, 80_000]) {
      await vi.advanceTimersByTimeAsync(delay);
      await flushPromises();
    }
    expect(runs).toBe(6);
    expect(onMaxRetriesExceeded).toHaveBeenCalledWith(JID, null);
  });
});

describe('GroupQueue retry jitter', () => {
  test('delays a retry by at most 20% beyond the base backoff', async () => {
    setRetryJitterSourceForTesting(() => 1);
    let runs = 0;
    enqueueTurn(async () => {
      runs += 1;
      return runs > 1;
    });
    await flushPromises();
    expect(runs).toBe(1);

    await vi.advanceTimersByTimeAsync(5_999);
    expect(runs).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await flushPromises();
    expect(runs).toBe(2);
  });
});
