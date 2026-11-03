import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

const DATA_DIR = '/tmp/happyclaw-background-only-test';

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return { ...real, DATA_DIR: '/tmp/happyclaw-background-only-test' };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../src/container-runner.js', () => ({ killProcessTree: vi.fn() }));
vi.mock('../src/runtime-config.js', () => ({
  getSystemSettings: () => ({ maxConcurrentContainers: 20 }),
}));
vi.mock('../src/db.js', () => ({}));

const { GroupQueue } = await import('../src/group-queue.js');
const { RunStreamFence } = await import('../src/run-stream-fence.js');

afterEach(() => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
});

const FOLDER = 'ws';
const AGENT = 's1';
const JID = `web:${FOLDER}#agent:${AGENT}`;
const INPUT_DIR = path.join(DATA_DIR, 'ipc', FOLDER, 'agents', AGENT, 'input');

/**
 * A session lane whose warm runner is in query `run-a` for input `input-a`,
 * with the Web fence wired the way web.ts wires it.
 */
function lane() {
  const queue = new GroupQueue();
  const state = (queue as any).getGroup(JID);
  state.active = true;
  state.process = { pid: 4242 };
  state.groupFolder = FOLDER;
  state.agentId = AGENT;
  state.runnerRuntime = 'container';
  state.queryInFlight = true;
  state.queryId = 'run-a';
  state.announcedQueryId = 'run-a';
  state.queryStartedAt = 1;
  const fence = new RunStreamFence();
  fence.start(JID, 'run-a');
  const web: string[] = [];
  queue.setOnQueryStart((_jid, runId) => {
    web.push(`start ${runId}`);
    fence.start(JID, runId);
  });
  queue.setOnQueryFinish((_jid, runId, reason) => {
    web.push(`finish ${runId} ${reason}`);
    fence.finish(JID, runId);
  });
  const idle: string[] = [];
  queue.setOnQueryIdle((_jid, runId) => {
    idle.push(runId);
  });
  return { queue, state, fence, web, idle };
}

function sentinel(name: string): string | null {
  const file = path.join(INPUT_DIR, name);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
}

describe('background-only hold', () => {
  test('keeps the run live for Web and takes no input until one can take over', () => {
    const { queue, state, fence, web, idle } = lane();

    expect(queue.markRunnerBackgroundOnly(JID, 'input-a', 'run-a')).toBe(true);

    expect(state.queryInFlight).toBe(true);
    expect(queue.getActiveQueryId(JID)).toBe('run-a');
    expect(queue.reserveNextQuery(JID)).toBeNull();
    expect(web).toEqual([]);
    expect(idle).toEqual([]);
    // The sub-agent's progress and the notification turn still reach Web.
    expect(fence.observeExact(JID, 'run-a').accepted).toBe(true);
  });

  test('a long background task is not an IPC input still owed', () => {
    const { queue, state } = lane();
    state.ipcOwedSinceAt = 1;
    queue.markRunnerBackgroundOnly(JID, 'input-a', 'run-a');
    expect(state.ipcOwedSinceAt).toBeNull();
  });

  test("is judged by the input's own query, not whichever query is current", () => {
    const { queue, state } = lane();
    state.queryId = 'run-b-reserved';
    expect(queue.markRunnerBackgroundOnly(JID, 'input-a', 'run-a')).toBe(false);
    expect(queue.hasBackgroundHold(JID)).toBe(false);
  });

  test('is refused while a later input is published under the same query', () => {
    const { queue, state } = lane();
    state.pendingIpcDeliveries.set('delivery-b', {});
    state.pendingIpcQueryIds = new Map([['delivery-b', 'run-a']]);
    expect(queue.markRunnerBackgroundOnly(JID, 'input-a', 'run-a')).toBe(false);
    // Its own delivery is not a later input.
    expect(queue.markRunnerBackgroundOnly(JID, 'delivery-b', 'run-a')).toBe(
      true,
    );
  });

  test('the real terminal clears the hold and frees the runner', () => {
    const { queue, state, web, idle } = lane();
    state.closing = 'after_query';
    const closeStdin = vi.spyOn(queue, 'closeStdin');
    queue.markRunnerBackgroundOnly(JID, 'input-a', 'run-a');
    expect(closeStdin).not.toHaveBeenCalled();

    queue.markRunnerQueryIdle(JID);

    expect(queue.hasBackgroundHold(JID)).toBe(false);
    expect(state.queryInFlight).toBe(false);
    expect(queue.getActiveQueryId(JID)).toBeNull();
    expect(closeStdin).toHaveBeenCalledWith(JID);
    expect(web).toEqual(['finish run-a completed']);
    expect(idle).toEqual(['run-a']);
  });

  test('a held container is not reclaimed; after its terminal it is', () => {
    const { queue, state } = lane();
    queue.markRunnerBackgroundOnly(JID, 'input-a', 'run-a');
    expect((queue as any).isIdleContainerRunner(JID, state)).toBe(false);
    queue.markRunnerQueryIdle(JID);
    expect((queue as any).isIdleContainerRunner(JID, state)).toBe(true);
  });

  test('retiring a held runner waits for its background tasks', () => {
    const { queue, state } = lane();
    const closeStdin = vi.spyOn(queue, 'closeStdin');
    queue.markRunnerBackgroundOnly(JID, 'input-a', 'run-a');

    expect(queue.retireRunnerAfterQuery(JID)).toBe(true);

    expect(closeStdin).not.toHaveBeenCalled();
    expect(queue.reserveBackgroundHandoffQuery(JID)).toBeNull();
    queue.markRunnerQueryIdle(JID);
    expect(closeStdin).toHaveBeenCalledWith(JID);
    expect(state.queryInFlight).toBe(false);
  });

  test('a stop reaches the held query; nothing stays to stop after its terminal', () => {
    const { queue } = lane();
    queue.markRunnerBackgroundOnly(JID, 'input-a', 'run-a');

    expect(queue.interruptQuery(JID, 'run-a', 'stop')).toBe(true);
    expect(sentinel('_interrupt')).toBe('run-a');

    queue.markRunnerQueryIdle(JID);
    expect(queue.getActiveQueryId(JID)).toBeNull();
    expect(queue.interruptQuery(JID, 'run-a', 'stop')).toBe(false);
  });
});

describe('a runner exiting before the hand-over', () => {
  test('ends the held run and announces nothing for the next input', async () => {
    const queue = new GroupQueue();
    queue.setHostModeChecker(() => true);
    const web: string[] = [];
    queue.setOnQueryStart((_jid, runId) => {
      web.push(`start ${runId}`);
    });
    queue.setOnQueryFinish((_jid, runId, reason) => {
      web.push(`finish ${runId} ${reason}`);
    });
    let exitRunner!: () => void;
    const ended = new Promise<boolean>((resolve) => {
      exitRunner = () => resolve(true);
    });
    queue.enqueueTask(JID, 'warm-runner', () => ended);
    queue.registerProcess(JID, { kill: vi.fn() } as never, {
      containerName: null,
      groupFolder: FOLDER,
      agentId: AGENT,
    });
    queue.markRunnerQueryIdle(JID);
    const runA = queue.reserveNextQuery(JID)!;
    queue.announceReservedQuery(JID, runA);
    web.length = 0;
    expect(queue.markRunnerBackgroundOnly(JID, 'input-a', runA)).toBe(true);
    const runB = queue.reserveBackgroundHandoffQuery(JID)!;

    exitRunner();
    await vi.waitFor(() => expect(web).toHaveLength(1));

    expect(web).toEqual([`finish ${runA} runner_exit`]);
    expect(web.join()).not.toContain(runB);
  });
});

describe('taking over from a held input', () => {
  function held() {
    const context = lane();
    context.queue.markRunnerBackgroundOnly(JID, 'input-a', 'run-a');
    const runB = context.queue.reserveBackgroundHandoffQuery(JID)!;
    return { ...context, runB };
  }

  test('the run changes hands only when the Runner hands over', () => {
    const { queue, fence, web, runB } = held();
    expect(queue.getActiveQueryId(JID)).toBe(runB);
    expect(queue.announceReservedQuery(JID, runB)).toBe(false);
    expect(web).toEqual([]);
    expect(fence.observeExact(JID, 'run-a').accepted).toBe(true);

    queue.finishBackgroundHold(JID, 'input-a');

    expect(web).toEqual(['finish run-a completed', `start ${runB}`]);
    expect(fence.observeExact(JID, 'run-a').accepted).toBe(false);
    expect(fence.observeExact(JID, runB).accepted).toBe(true);
    expect(queue.hasBackgroundHold(JID)).toBe(false);
    expect(queue.getActiveQueryId(JID)).toBe(runB);
  });

  test('takes over once: a later input waits for the next hold', () => {
    const { queue } = held();
    expect(queue.reserveBackgroundHandoffQuery(JID)).toBeNull();
    expect(queue.backgroundHoldAwaitingNext(JID)).toBeNull();
    expect(queue.hasBackgroundHold(JID)).toBe(true);
  });

  test('an input never published gives the lane back to the held query', () => {
    const { queue, state, web, idle, runB } = held();

    expect(queue.releaseQueryReservation(JID, runB, true)).toBe(true);

    expect(queue.getActiveQueryId(JID)).toBe('run-a');
    expect(state.announcedQueryId).toBe('run-a');
    expect(state.queryStartedAt).toBe(1);
    expect(web).toEqual([]);
    expect(queue.backgroundHoldAwaitingNext(JID)).toBe('input-a');
    // The dispatcher is called again for what is left in the queue.
    expect(idle).toEqual([runB]);
  });

  test('the held input ending first leaves the query with the next input', () => {
    const { queue, state, web, idle, runB } = held();

    queue.markRunnerQueryIdle(JID);

    expect(web).toEqual(['finish run-a completed', `start ${runB}`]);
    expect(idle).toEqual([]);
    expect(state.queryInFlight).toBe(true);
    expect(queue.getActiveQueryId(JID)).toBe(runB);

    queue.markRunnerQueryIdle(JID);
    expect(state.queryInFlight).toBe(false);
    expect(idle).toEqual([runB]);
  });

  function published() {
    const context = held();
    const { state, runB } = context;
    fs.mkdirSync(INPUT_DIR, { recursive: true });
    const file = path.join(INPUT_DIR, 'b.json');
    fs.writeFileSync(
      file,
      JSON.stringify({ receipt: { deliveryId: 'delivery-b' } }),
    );
    state.pendingIpcDeliveries.set('delivery-b', {
      deliveryId: 'delivery-b',
      chatJid: JID,
      cursor: { timestamp: '', id: 'input-b' },
    });
    state.pendingIpcQueryIds = new Map([['delivery-b', runB]]);
    state.ipcOwedSinceAt = 1;
    state.backgroundHold.next.published = true;
    return { ...context, file };
  }

  test('a published next input keeps its query when the held input ends alone', () => {
    const { queue, state, web, idle, runB } = published();

    queue.markRunnerQueryIdle(JID, { completedDeliveryIds: ['delivery-a'] });

    expect(web).toEqual(['finish run-a completed', `start ${runB}`]);
    expect(idle).toEqual([]);
    expect(state.queryInFlight).toBe(true);
    expect(queue.getActiveQueryId(JID)).toBe(runB);
  });

  test('a next input merged into the terminal does not leave the lane stuck', () => {
    const { queue, state, web, idle } = published();

    queue.markRunnerQueryIdle(JID, {
      completedDeliveryIds: ['delivery-a', 'delivery-b'],
    });

    // No run for it was ever shown: only the held run ends.
    expect(web).toEqual(['finish run-a completed']);
    expect(idle).toEqual(['run-a']);
    expect(state.queryInFlight).toBe(false);
    expect(queue.getActiveQueryId(JID)).toBeNull();
    expect(queue.hasBackgroundHold(JID)).toBe(false);
  });

  test('/break withdraws a published next input and the stop names it', () => {
    const { queue, state, web, idle, file, runB } = published();

    const receipts = queue.withdrawBackgroundHandoffInput(JID);
    expect(receipts.map((receipt: any) => receipt.deliveryId)).toEqual([
      'delivery-b',
    ]);
    expect(fs.existsSync(file)).toBe(false);
    expect(state.pendingIpcDeliveries.has('delivery-b')).toBe(false);
    expect(state.ipcOwedSinceAt).toBeNull();

    expect(queue.interruptQuery(JID, runB, 'stop', ['delivery-b'])).toBe(true);
    expect(JSON.parse(sentinel('_interrupt_reason')!)).toEqual({
      queryId: 'run-a',
      reason: 'stop',
      withdrawDeliveryIds: ['delivery-b'],
    });

    // The Runner's interrupted status then ends the lane for good.
    queue.markRunnerQueryIdle(JID);
    expect(web).toEqual(['finish run-a completed']);
    expect(idle).toEqual(['run-a']);
    expect(state.queryInFlight).toBe(false);
  });

  test('nothing to withdraw before anything is published or after the hand-over', () => {
    const { queue } = held();
    expect(queue.withdrawBackgroundHandoffInput(JID)).toEqual([]);

    const taken = published();
    taken.queue.finishBackgroundHold(JID, 'input-a');
    expect(taken.queue.withdrawBackgroundHandoffInput(JID)).toEqual([]);
    expect(taken.state.pendingIpcDeliveries.has('delivery-b')).toBe(true);
  });

  test('an interrupt without a withdrawal moves the run to what the Runner runs next', () => {
    const { queue, web, runB } = published();

    queue.finishInterruptedBackgroundHold(JID);

    expect(web).toEqual(['finish run-a completed', `start ${runB}`]);
    expect(queue.hasBackgroundHold(JID)).toBe(false);
  });

  test('the taker of background work is known until its terminal', () => {
    const { queue } = published();
    queue.finishBackgroundHold(JID, 'input-a');
    queue.setInheritedBackgroundWork(JID, true);
    expect(queue.hasInheritedBackgroundWork(JID)).toBe(true);

    queue.markRunnerQueryIdle(JID, { completedDeliveryIds: ['delivery-b'] });
    expect(queue.hasInheritedBackgroundWork(JID)).toBe(false);
  });

  test('a stop before the hand-over names the query the Runner still runs', () => {
    const { queue, runB } = held();
    expect(queue.interruptQuery(JID, undefined, 'stop')).toBe(true);
    expect(sentinel('_interrupt')).toBe('run-a');
    expect(queue.interruptQuery(JID, runB, 'stop')).toBe(true);
    expect(queue.interruptQuery(JID, 'run-a', 'stop')).toBe(true);
    expect(queue.interruptQuery(JID, 'run-other', 'stop')).toBe(false);

    queue.finishBackgroundHold(JID, 'input-a');
    expect(queue.interruptQuery(JID, undefined, 'stop')).toBe(true);
    expect(sentinel('_interrupt')).toBe(runB);
  });
});
