/**
 * Regression test for the critical self-reentrancy bug in drainWaiting.
 *
 * Bug: enqueueTask adds a jid to waitingGroups even while that jid's OWN
 * runner is active (state.active=true) — e.g. a follow-up turn queued while
 * the session runner is busy. drainWaiting's guard was
 * `if (activeRunner && activeRunner !== jid) continue`, which did NOT skip a
 * self-active jid (activeRunner === jid). So when another lane finished and
 * triggered drainWaiting, it started a SECOND concurrent runner on the same
 * GroupState → duplicate replies, orphaned container handle, broken counters.
 *
 * Fix: skip whenever ANY runner for the serialization key is active
 * (`if (activeRunner) continue`), plus a defensive `if (state.active) return`
 * guard in runTask. Pending work is drained by the active runner's
 * finally → drainGroup, so nothing is starved.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../src/config.js', async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return { ...real, DATA_DIR: '/tmp/happyclaw-queue-reentrancy-test' };
});

vi.mock('../src/logger.js', () => ({
  logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
}));

vi.mock('../src/container-runner.js', () => ({
  killProcessTree: () => {},
}));

// Plenty of capacity so the bug (not capacity) is what gates concurrency.
vi.mock('../src/runtime-config.js', () => ({
  getSystemSettings: () => ({
    maxConcurrentContainers: 20,
    maxConcurrentHostProcesses: 5,
  }),
}));

vi.mock('../src/db.js', () => ({}));

const { GroupQueue } = await import('../src/group-queue.js');

const tick = () => new Promise((r) => setImmediate(r));

let queue: InstanceType<typeof GroupQueue>;
// Per-jid concurrent invocation tracking.
let inFlight: Map<string, number>;
let maxConcurrent: Map<string, number>;
const gates = new Map<string, () => void>();
let taskSeq = 0;

function enqueueTurn(jid: string): void {
  queue.enqueueTask(jid, `turn-${++taskSeq}`, async () => {
    const now = (inFlight.get(jid) ?? 0) + 1;
    inFlight.set(jid, now);
    maxConcurrent.set(jid, Math.max(maxConcurrent.get(jid) ?? 0, now));
    await new Promise<void>((resolve) => gates.set(jid, resolve));
    inFlight.set(jid, (inFlight.get(jid) ?? 1) - 1);
    return true;
  });
}

beforeEach(() => {
  queue = new GroupQueue();
  inFlight = new Map();
  maxConcurrent = new Map();
  gates.clear();
});

afterEach(async () => {
  for (const release of gates.values()) release();
  gates.clear();
  await tick();
  await tick();
});

describe('GroupQueue drainWaiting self-reentrancy', () => {
  test('does not start a second concurrent runner for a self-active lane', async () => {
    const A = 'web:group-a#agent:a';
    const B = 'web:group-b#agent:b';

    // A starts its run and blocks on the gate (active).
    enqueueTurn(A);
    await tick();
    expect(maxConcurrent.get(A)).toBe(1);

    // B starts its run and blocks too (active). Two independent runners.
    enqueueTurn(B);
    await tick();
    expect(maxConcurrent.get(B)).toBe(1);

    // A new turn arrives for A while A's runner is still active. Because A
    // is active, enqueueTask parks it in A's pendingTasks and waitingGroups
    // (and A stays active).
    enqueueTurn(A);
    await tick();

    // B finishes → its finally → drainGroup → drainWaiting. With the bug,
    // drainWaiting would launch a SECOND concurrent runner on A.
    gates.get(B)?.();
    await tick();
    await tick();

    // A must never have run two runners simultaneously.
    expect(maxConcurrent.get(A)).toBe(1);
  });

  test('drained pending turn runs once after the active runner finishes', async () => {
    const A = 'web:group-a2#agent:a';
    const B = 'web:group-b2#agent:b';

    enqueueTurn(A); // A active
    await tick();
    enqueueTurn(B); // B active
    await tick();

    // Queue a follow-up turn for A while A is active.
    enqueueTurn(A);
    await tick();

    // Finish A's first run. Its finally → drainGroup should pick up the pending
    // turn and run it exactly once (sequentially, not concurrently).
    gates.get(A)?.();
    await tick();
    await tick();

    // A second (sequential) run for A is now active for the pending turn.
    expect(maxConcurrent.get(A)).toBe(1); // never concurrent
    expect(inFlight.get(A)).toBe(1); // the follow-up run is in flight
  });
});
