import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));
vi.mock('../src/container-runner.js', () => ({ killProcessTree: () => {} }));
const settings = vi.hoisted(() => ({ maxConcurrentContainers: 1 }));
vi.mock('../src/runtime-config.js', () => ({
  getSystemSettings: () => settings,
}));
vi.mock('../src/db.js', () => ({}));

const { GroupQueue } = await import('../src/group-queue.js');
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function tick(): Promise<void> {
  for (let index = 0; index < 4; index++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

const releases: Array<() => void> = [];
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  await tick();
  settings.maxConcurrentContainers = 1;
});

/**
 * A queue whose session runs stay alive until released, like a warm runner
 * that went idle after its query. `exits` resolves a lane's run; `enqueue`
 * queues a turn on a lane.
 */
function harness(host: boolean | ((jid: string) => boolean) = false) {
  const isHost = typeof host === 'function' ? host : () => host;
  const queue = new GroupQueue();
  queue.setHostModeChecker(isHost);
  const exits = new Map<string, () => void>();
  const started: string[] = [];
  let taskSeq = 0;
  const enqueue = (jid: string) =>
    queue.enqueueTask(jid, `turn-${++taskSeq}`, async () => {
      started.push(jid);
      queue.registerProcess(jid, {} as never, {
        containerName: isHost(jid) ? null : `c-${jid}`,
        groupFolder: jid.slice('web:'.length).split('#')[0],
        agentId: 's',
      });
      const exit = deferred();
      exits.set(jid, exit.resolve);
      releases.push(exit.resolve);
      await exit.promise;
      return true;
    });
  const closed = vi
    .spyOn(queue, 'closeStdin')
    .mockImplementation((jid: string) => {
      // The runner honours _close by exiting.
      exits.get(jid)?.();
    });
  /** Start a turn on `jid` and let its query go idle, runner kept warm. */
  const idle = async (jid: string) => {
    enqueue(jid);
    await tick();
    queue.markRunnerQueryIdle(jid);
  };
  return { queue, started, closed, exits, enqueue, idle };
}

describe('reclaiming idle warm container runners', () => {
  test('waiting work takes the slot of the idle runner', async () => {
    const { queue, started, closed, enqueue, idle } = harness();
    await idle('web:a#agent:s');
    expect(closed).not.toHaveBeenCalled();

    enqueue('web:b#agent:s');
    expect(closed).toHaveBeenCalledWith('web:a#agent:s');
    await tick();
    expect(started).toEqual(['web:a#agent:s', 'web:b#agent:s']);
    expect(queue.getStatus().activeContainerCount).toBe(1);
  });

  test('a runner going idle while work waits is reclaimed at once', async () => {
    const { queue, started, closed, enqueue } = harness();
    enqueue('web:a#agent:s');
    await tick();
    enqueue('web:b#agent:s');
    // Mid-query: never reclaimed.
    expect(closed).not.toHaveBeenCalled();
    expect(queue.getStatus().waitingCount).toBe(1);

    queue.markRunnerQueryIdle('web:a#agent:s');
    expect(closed).toHaveBeenCalledWith('web:a#agent:s');
    await tick();
    expect(started).toEqual(['web:a#agent:s', 'web:b#agent:s']);
  });

  test('a runner whose lane has queued input or background work keeps its slot', async () => {
    const { queue, started, closed, enqueue, idle } = harness();
    const owesWork = new Set(['web:a#agent:s']);
    queue.setIdleRunnerReclaimBlocker((jid) => owesWork.has(jid));
    await idle('web:a#agent:s');

    enqueue('web:b#agent:s');
    await tick();
    expect(closed).not.toHaveBeenCalled();
    expect(started).toEqual(['web:a#agent:s']);

    // Once the queue drained, the next idle reclaims it.
    owesWork.clear();
    queue.markRunnerQueryIdle('web:a#agent:s');
    expect(closed).not.toHaveBeenCalled(); // no query was in flight
    enqueue('web:c#agent:s');
    expect(closed).toHaveBeenCalledWith('web:a#agent:s');
  });

  test('the longest-idle runner goes first, and only as many as are needed', async () => {
    settings.maxConcurrentContainers = 2;
    const { closed, enqueue, idle } = harness();
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000);
    await idle('web:old#agent:s');
    now.mockReturnValue(5_000);
    await idle('web:recent#agent:s');
    now.mockRestore();

    enqueue('web:new#agent:s');
    expect(closed.mock.calls.map(([jid]) => jid)).toEqual(['web:old#agent:s']);
  });

  test('an idle Host runner never gives up its process for a container lane', async () => {
    const { queue, started, closed, enqueue, idle } = harness((jid) =>
      jid.startsWith('web:host'),
    );
    await idle('web:host-idle#agent:s');
    enqueue('web:busy#agent:s');
    await tick();
    enqueue('web:waiting#agent:s');
    expect(closed).not.toHaveBeenCalled();
    expect(started).toEqual(['web:host-idle#agent:s', 'web:busy#agent:s']);
    expect(queue.getStatus().waitingCount).toBe(1);
  });

  test('Host runners are never reclaimed and never wait for a slot', async () => {
    const { queue, started, closed, enqueue, idle } = harness(true);
    await idle('web:a#agent:s');
    enqueue('web:b#agent:s');
    await tick();
    expect(closed).not.toHaveBeenCalled();
    expect(started).toEqual(['web:a#agent:s', 'web:b#agent:s']);
    expect(queue.getStatus().activeHostProcessCount).toBe(2);
  });

  test('reclaims the same user’s idle container when per-user container limit is reached below global limit', async () => {
    settings.maxConcurrentContainers = 5;
    const { queue, started, closed, enqueue, idle } = harness();
    const userOf = (jid: string) => (jid.startsWith('web:u1-') ? 'u1' : 'u2');
    const activeByUser = new Map<string, number>();
    queue.setUserConcurrentLimitChecker((jid) => {
      const userId = userOf(jid);
      return {
        allowed: (activeByUser.get(userId) ?? 0) < 1,
        userId,
      };
    });

    // u2 has an older idle container; u1 has a newer idle container
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValue(1_000);
    await idle('web:u2-idle#agent:s');
    activeByUser.set('u2', 1);
    now.mockReturnValue(2_000);
    await idle('web:u1-idle#agent:s');
    activeByUser.set('u1', 1);
    now.mockRestore();

    // u1 enqueues a second workspace: u1 is at per-user limit (1), global is 2 < 5
    closed.mockImplementationOnce((jid: string) => {
      activeByUser.set(userOf(jid), 0);
      queue.stopGroup(jid);
    });
    enqueue('web:u1-next#agent:s');
    expect(closed).toHaveBeenCalledWith('web:u1-idle#agent:s');
    expect(closed).not.toHaveBeenCalledWith('web:u2-idle#agent:s');
    expect(started).toContain('web:u1-idle#agent:s');
  });

  test('picking a runner for a user at their limit checks each lane’s owner once', async () => {
    settings.maxConcurrentContainers = 20;
    const { queue, closed, enqueue, idle } = harness();
    const userOf = (jid: string) => (jid.startsWith('web:u1-') ? 'u1' : 'u2');
    const active = { u1: 0 };
    // Like the real checker, every call walks all workspaces of the owner.
    const calls = new Map<string, number>();
    queue.setUserConcurrentLimitChecker((jid) => {
      calls.set(jid, (calls.get(jid) ?? 0) + 1);
      const userId = userOf(jid);
      return { allowed: userId === 'u2' || active.u1 < 2, userId };
    });
    const now = vi.spyOn(Date, 'now');
    const idleJids = [
      'web:u2-a#agent:s',
      'web:u1-old#agent:s',
      'web:u2-b#agent:s',
      'web:u2-c#agent:s',
      'web:u1-new#agent:s',
      'web:u2-d#agent:s',
      'web:u2-e#agent:s',
    ];
    for (const [index, jid] of idleJids.entries()) {
      now.mockReturnValue(1_000 * (index + 1));
      await idle(jid);
      if (userOf(jid) === 'u1') active.u1++;
    }
    now.mockRestore();
    calls.clear();

    enqueue('web:u1-next#agent:s');

    expect(closed.mock.calls.map(([jid]) => jid)).toEqual([
      'web:u1-old#agent:s',
    ]);
    for (const jid of idleJids) {
      expect(calls.get(jid) ?? 0, jid).toBeLessThanOrEqual(1);
    }
  });

  test('hasActiveRunnerForMessage returns false while a runner is closing', async () => {
    settings.maxConcurrentContainers = 1;
    const { queue, closed, enqueue, idle } = harness();
    // Do not auto-exit on closeStdin so state.closing stays set
    closed.mockImplementation(() => {});
    await idle('web:closing-test#agent:s');
    expect(queue.hasActiveRunnerForMessage('web:closing-test#agent:s')).toBe(
      true,
    );

    enqueue('web:waiting-peer#agent:s');
    expect(closed).toHaveBeenCalledWith('web:closing-test#agent:s');
    expect(queue.hasActiveRunnerForMessage('web:closing-test#agent:s')).toBe(
      false,
    );
  });
});

describe('deferring a mutation stop to the end of the current query', () => {
  test('the runner that committed the change finishes its turn, then closes and settles', async () => {
    const { queue, closed, exits, enqueue } = harness();
    enqueue('web:self#agent:s');
    await tick();
    const settled: string[] = [];

    const token = queue.pauseGroupsForMutation(['web:self#agent:s']);
    await queue.deferStopsToQueryEnd(
      'web:self#agent:s',
      (jid) => settled.push(jid),
      async () => {
        await queue.stopGroup('web:self#agent:s', {
          force: true,
          preserveQueuedWork: true,
        });
      },
    );
    queue.resumeGroupsAfterMutation(token);
    // Not killed mid-turn.
    expect(closed).not.toHaveBeenCalled();
    expect(queue.getStatus().activeContainerCount).toBe(1);

    // The turn ends: no further query is accepted, the runner closes.
    queue.markRunnerQueryIdle('web:self#agent:s');
    expect(queue.reserveNextQuery('web:self#agent:s')).toBeNull();
    expect(queue.sendMessage('web:self#agent:s', 'next')).toBe('no_active');
    expect(closed).toHaveBeenCalledWith('web:self#agent:s');
    expect(exits.has('web:self#agent:s')).toBe(true);
    await tick();
    expect(settled).toEqual(['web:self#agent:s']);
    expect(queue.getStatus().activeContainerCount).toBe(0);
  });

  test('outside the deferral, a mutation stop still stops the runner', async () => {
    const { queue, started, closed, enqueue } = harness();
    enqueue('web:other#agent:s');
    await tick();
    const token = queue.pauseGroupsForMutation(['web:other#agent:s']);
    await queue.stopGroup('web:other#agent:s', {
      force: true,
      preserveQueuedWork: true,
    });
    expect(closed).toHaveBeenCalledWith('web:other#agent:s');
    queue.resumeGroupsAfterMutation(token);
    await tick();
    // The preserved work replays on a fresh runner.
    expect(started).toEqual(['web:other#agent:s', 'web:other#agent:s']);
  });
});

describe('an ordinary stop discards lane work kept outside GroupQueue', () => {
  test('stop, reset and delete report the lane; a mutation stop does not', async () => {
    const { queue, enqueue } = harness();
    const discarded: string[] = [];
    queue.setOnLaneDiscarded((jid) => discarded.push(jid));

    await queue.stopGroup('web:idle-lane#agent:s');
    expect(discarded).toEqual(['web:idle-lane#agent:s']);

    enqueue('web:busy#agent:s');
    await tick();
    const token = queue.pauseGroupsForMutation(['web:busy#agent:s']);
    await queue.stopGroup('web:busy#agent:s', {
      force: true,
      preserveQueuedWork: true,
    });
    queue.resumeGroupsAfterMutation(token);
    expect(discarded).toEqual(['web:idle-lane#agent:s']);
  });
});
