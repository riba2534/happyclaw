/**
 * GroupQueue lane holds and per-lane stop markers, on a real queue: holding
 * one session lane never delays the workspace's other lanes, a stop is
 * remembered for its own lane only, holds are counted, and the IPC
 * deliveries a work-keeping stop left unacknowledged are replayed when the
 * work resumes and committed when it is discarded.
 */
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

const paths = vi.hoisted(() => ({ root: '' }));
vi.mock('../src/config.js', async (importOriginal) => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  paths.root = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-hold-'));
  return {
    ...(await importOriginal<Record<string, unknown>>()),
    DATA_DIR: path.join(paths.root, 'data'),
  };
});
vi.mock('../src/logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
const settings = vi.hoisted(() => ({ maxConcurrentContainers: 10 }));
vi.mock('../src/runtime-config.js', () => ({
  getSystemSettings: () => settings,
}));
vi.mock('../src/db.js', () => ({}));

const { GroupQueue } = await import('../src/group-queue.js');

const FOLDER = 'ws';
/** The workspace and the IM group bound to it (mutation pause targets). */
const WS = 'web:ws';
const WS_IM = 'feishu:oc_ws';
/** Another session of the workspace, also reached from the IM group. */
const PEER = 'web:ws#agent:s0';
const PEER_IM = 'feishu:oc_ws#agent:s0';
const LANE = 'web:ws#agent:s1';
const OTHER = 'web:ws#agent:s2';

const settle = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** A workspace with three session lanes; each turn runs until it exits. */
function harness() {
  const queue = new GroupQueue();
  queue.setSerializationKeyResolver((jid: string) => {
    const agentSep = jid.indexOf('#agent:');
    if (agentSep >= 0) return `${FOLDER}#${jid.slice(agentSep + 7)}`;
    return jid === WS || jid === WS_IM ? FOLDER : jid;
  });
  queue.setHostModeChecker(() => true);
  queue.setIpcDeliveryCommitEligibilityChecker(() => true);
  const runs: string[] = [];
  const exits = new Map<string, ReturnType<typeof deferred>>();
  let taskSeq = 0;
  const enqueue = (jid: string) =>
    queue.enqueueTask(jid, `turn-${++taskSeq}`, async () => {
      runs.push(jid);
      const exit = deferred();
      exits.set(jid, exit);
      queue.registerProcess(jid, {} as never, {
        containerName: null,
        groupFolder: FOLDER,
        agentId: jid.split('#agent:')[1],
      });
      await exit.promise;
      return true;
    });
  vi.spyOn(queue, 'closeStdin').mockImplementation((jid: string) => {
    exits.get(jid)?.resolve();
  });
  const count = (jid: string) => runs.filter((run) => run === jid).length;
  return { queue, runs, exits, count, enqueue };
}

afterEach(() => {
  settings.maxConcurrentContainers = 10;
  fs.rmSync(path.join(paths.root, 'data'), { recursive: true, force: true });
});

describe('holding a session lane', () => {
  test.each(['releaseLane', 'discardHeldLane'] as const)(
    'another session finishing its turn during the hold runs its queued turn at once (then %s)',
    async (finish) => {
      const { queue, exits, count, enqueue } = harness();
      enqueue(PEER);
      enqueue(LANE);
      await settle();
      // A follow-up for the peer queues behind its busy runner.
      enqueue(PEER);
      queue.holdLane(LANE);
      await queue.stopGroup(LANE, { force: true, preserveQueuedWork: true });

      exits.get(PEER)!.resolve();
      await settle();
      expect(count(PEER)).toBe(2);

      queue[finish](LANE);
      await settle();
      expect(count(PEER)).toBe(2);
      // The released lane runs again; the discarded one does not.
      expect(count(LANE)).toBe(finish === 'releaseLane' ? 2 : 1);
    },
  );

  test.each(['releaseLane', 'discardHeldLane'] as const)(
    'the container slot the held lane gave up serves another session at once (then %s)',
    async (finish) => {
      const { queue, count, enqueue } = harness();
      settings.maxConcurrentContainers = 1;
      queue.setHostModeChecker(() => false);
      enqueue(LANE);
      await settle();
      // The peer waits for the only container slot.
      enqueue(PEER);
      await settle();
      expect(count(PEER)).toBe(0);

      queue.holdLane(LANE);
      await queue.stopGroup(LANE, { force: true, preserveQueuedWork: true });
      await settle();
      expect(count(PEER)).toBe(1);
      queue[finish](LANE);
      await settle();
      expect(count(PEER)).toBe(1);
    },
  );

  test('two holders: the lane stays held until both are done', async () => {
    const { queue, count, enqueue } = harness();
    queue.holdLane(LANE);
    queue.holdLane(LANE);
    enqueue(LANE);
    queue.releaseLane(LANE);
    await settle();
    expect(queue.isGroupMutationPaused(LANE)).toBe(true);
    expect(count(LANE)).toBe(0);
    queue.releaseLane(LANE);
    await settle();
    expect(queue.isGroupMutationPaused(LANE)).toBe(false);
    expect(count(LANE)).toBe(1);
  });

  test('a discard while another holder remains drops the work but keeps the hold', async () => {
    const { queue, count, enqueue } = harness();
    const discarded: string[] = [];
    queue.setOnLaneDiscarded((jid) => discarded.push(jid));
    queue.holdLane(LANE);
    queue.holdLane(LANE);
    enqueue(LANE);
    queue.discardHeldLane(LANE);
    expect(discarded).toEqual([LANE]);
    expect(queue.isGroupMutationPaused(LANE)).toBe(true);
    queue.releaseLane(LANE);
    await settle();
    expect(queue.isGroupMutationPaused(LANE)).toBe(false);
    // Its work went with the discard.
    expect(count(LANE)).toBe(0);
  });
});

describe('the end of a hold or pause', () => {
  test('a discard that throws still releases the hold', () => {
    const { queue } = harness();
    queue.holdLane(LANE);
    vi.spyOn(
      queue as unknown as { discardLaneWork: () => void },
      'discardLaneWork',
    ).mockImplementation(() => {
      throw new Error('discard hook failed');
    });
    expect(() => queue.discardHeldLane(LANE)).toThrow('discard hook failed');
    expect(queue.isGroupMutationPaused(LANE)).toBe(false);
  });

  test('deliveries left by a stop that ends after the workspace pause was released are replayed, once', async () => {
    const { queue, exits, enqueue } = harness();
    const replayed: string[][] = [];
    queue.setOnUnacknowledgedIpcDeliveries((_jid, receipts) =>
      replayed.push(receipts.map((r) => r.cursor.id)),
    );
    // The runner keeps going after the close until the test lets it exit.
    vi.mocked(queue.closeStdin).mockImplementation(() => {});
    enqueue(LANE);
    await settle();
    const cursor = { timestamp: '2026-10-29T00:00:00.000Z', id: 'om_b' };
    expect(
      queue.sendMessage(LANE, 'b', undefined, undefined, LANE, {
        chatJid: LANE,
        coveredCursors: [cursor],
        cursor,
      }),
    ).toBe('sent');
    const token = queue.pauseGroupsForMutation([WS]);
    const stopping = queue.stopGroup(LANE, {
      force: true,
      preserveQueuedWork: true,
    });
    // Another path drops the last pause while the stop is still tearing down.
    queue.resumeGroupsAfterMutation(token);
    exits.get(LANE)!.resolve();
    await stopping;
    await settle();
    expect(replayed).toEqual([['om_b']]);
  });
});

describe('a stop is remembered for its own lane', () => {
  test('a user Stop on another session during a hold stays a discard, and survives the release', async () => {
    const { queue, enqueue } = harness();
    enqueue(PEER);
    enqueue(LANE);
    enqueue(OTHER);
    await settle();
    queue.holdLane(LANE);
    await queue.stopGroup(LANE, { force: true, preserveQueuedWork: true });
    await queue.stopGroup(PEER, { force: true });

    expect(queue.getRecentStopDisposition(LANE)).toBe('preserve');
    expect(queue.getRecentStopDisposition(PEER)).toBe('discard');
    // The IM group's JID of the peer shares its runner: the same lane, the
    // same stop.
    expect(queue.getRecentStopDisposition(PEER_IM)).toBe('discard');
    expect(queue.getRecentStopDisposition(OTHER)).toBe('none');
    expect(queue.isRecentlyStopped(OTHER)).toBe(false);

    queue.releaseLane(LANE);
    expect(queue.getRecentStopDisposition(PEER)).toBe('discard');
    expect(queue.getRecentStopDisposition(LANE)).toBe('none');
  });

  test('a session stopped by the user does not run again right after its exit', async () => {
    const { queue, count, enqueue } = harness();
    enqueue(PEER);
    await settle();
    enqueue(PEER);
    await queue.stopGroup(PEER, { force: true });
    await settle();
    expect(count(PEER)).toBe(1);
  });
});

describe('deliveries a work-keeping stop left unacknowledged', () => {
  function withDelivery() {
    const h = harness();
    const replayed: string[][] = [];
    const committed: string[][] = [];
    h.queue.setOnUnacknowledgedIpcDeliveries((_jid, receipts) =>
      replayed.push(receipts.map((r) => r.cursor.id)),
    );
    h.queue.setOnAbandonedIpcDeliveries((_jid, receipts) =>
      committed.push(receipts.map((r) => r.cursor.id)),
    );
    const inject = (jid: string, id: string) => {
      const cursor = { timestamp: '2026-10-29T00:00:00.000Z', id };
      expect(
        h.queue.sendMessage(jid, id, undefined, undefined, jid, {
          chatJid: jid,
          coveredCursors: [cursor],
          cursor,
        }),
      ).toBe('sent');
    };
    return { ...h, replayed, committed, inject };
  }

  test('a deleted workspace commits them instead of replaying them', async () => {
    const { queue, replayed, committed, inject, enqueue } = withDelivery();
    enqueue(PEER_IM);
    await settle();
    inject(PEER_IM, 'om_in_flight');
    const token = queue.pauseGroupsForMutation([WS, WS_IM]);
    await queue.stopGroup(PEER_IM, { force: true, preserveQueuedWork: true });
    expect(replayed).toEqual([]);

    queue.discardGroupsAfterMutation(token);
    expect(committed).toEqual([['om_in_flight']]);
    expect(replayed).toEqual([]);
  });

  test('a mutation that resumes replays them', async () => {
    const { queue, replayed, committed, inject, enqueue } = withDelivery();
    enqueue(PEER_IM);
    await settle();
    inject(PEER_IM, 'om_in_flight');
    const token = queue.pauseGroupsForMutation([WS, WS_IM]);
    await queue.stopGroup(PEER_IM, { force: true, preserveQueuedWork: true });

    queue.resumeGroupsAfterMutation(token);
    expect(replayed).toEqual([['om_in_flight']]);
    expect(committed).toEqual([]);
  });

  test('a released session lane replays them; a discarded one commits them', async () => {
    for (const finish of ['releaseLane', 'discardHeldLane'] as const) {
      const { queue, replayed, committed, inject, enqueue } = withDelivery();
      enqueue(LANE);
      await settle();
      inject(LANE, `om_${finish}`);
      queue.holdLane(LANE);
      await queue.stopGroup(LANE, { force: true, preserveQueuedWork: true });
      expect(replayed).toEqual([]);
      queue[finish](LANE);
      expect(finish === 'releaseLane' ? replayed : committed).toEqual([
        [`om_${finish}`],
      ]);
      expect(finish === 'releaseLane' ? committed : replayed).toEqual([]);
    }
  });
});
