import { afterEach, describe, expect, test, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

import { GroupQueue } from '../src/group-queue.js';
import { DATA_DIR } from '../src/config.js';

// Regression coverage for #618: warm-path IPC follow-ups must be visible to
// stuck-runner recovery. Follow-ups injected into a live runner establish a
// dedicated IPC-debt timestamp, so a wedged in-flight turn remains visible
// even when ordinary output refreshes activity. Turns queued behind a silent
// runner are owed work too.
//
// State is seeded directly into the internal map (same approach as
// conversation-agent-warm-lifecycle.test.ts) so the tests stay hermetic.

const IDLE_THRESHOLD_MS = 3 * 60 * 1000;
const AGENT_ID = 'session';

interface SeedOpts {
  active?: boolean;
  groupFolder?: string;
  agentId?: string | null;
  runnerRuntime?: 'host' | 'container' | null;
  runnerGeneration?: number;
  runnerPid?: number | null;
  queryInFlight?: boolean;
  queryId?: string | null;
  lastActivityAt?: number | null;
  /** Number of turns queued behind the runner. */
  pendingTasks?: number;
  ipcOwedSinceAt?: number | null;
}

function queuedTask(id: string) {
  return { id, fn: async () => {}, acceptsInput: true };
}

function seedRunner(q: GroupQueue, jid: string, opts: SeedOpts = {}) {
  const anyQ = q as unknown as { groups: Map<string, Record<string, unknown>> };
  anyQ.groups.set(jid, {
    active: opts.active ?? true,
    runnerGeneration: opts.runnerGeneration ?? 1,
    runnerRuntime: opts.runnerRuntime ?? 'host',
    lastActivityAt: opts.lastActivityAt ?? null,
    queryInFlight: opts.queryInFlight ?? false,
    queryId:
      opts.queryId !== undefined
        ? opts.queryId
        : opts.queryInFlight
          ? 'query-1'
          : null,
    pendingTasks: Array.from({ length: opts.pendingTasks ?? 0 }, (_, index) =>
      queuedTask(`queued-${index}`),
    ),
    process:
      opts.runnerPid === undefined || opts.runnerPid === null
        ? null
        : { pid: opts.runnerPid },
    containerName: null,
    displayName: null,
    groupFolder: opts.groupFolder ?? 'main',
    agentId: opts.agentId ?? AGENT_ID,
    retryCount: 0,
    retryTimer: null,
    restarting: false,
    selectedProviderId: null,
    drainSentinelWritten: false,
    ipcOwedSinceAt: opts.ipcOwedSinceAt ?? null,
    pendingIpcDeliveries: new Map(),
    acknowledgedIpcDeliveryIds: new Set(),
  });
}

function getState(q: GroupQueue, jid: string): Record<string, unknown> {
  const anyQ = q as unknown as { groups: Map<string, Record<string, unknown>> };
  return anyQ.groups.get(jid)!;
}

describe('#618: IPC-injected follow-ups are visible to stuck recovery', () => {
  const folder = `stuck-test-${process.pid}-${Date.now()}`;
  const ipcDir = path.join(DATA_DIR, 'ipc', folder);
  const inputDir = path.join(ipcDir, 'agents', AGENT_ID, 'input');
  const jid = `web:${folder}#agent:${AGENT_ID}`;

  afterEach(() => {
    fs.rmSync(ipcDir, { recursive: true, force: true });
  });

  test('wedged in-flight turn with injected input is reported as stuck (ipc_injected)', () => {
    const q = new GroupQueue();
    seedRunner(q, jid, {
      groupFolder: folder,
      queryInFlight: true,
      ipcOwedSinceAt: Date.now() - IDLE_THRESHOLD_MS - 1000,
      lastActivityAt: Date.now() - IDLE_THRESHOLD_MS - 1000,
    });

    const stuck = q.getStuckPendingGroups(IDLE_THRESHOLD_MS);
    expect(stuck).toHaveLength(1);
    expect(stuck[0].jid).toBe(jid);
    expect(stuck[0].reason).toBe('ipc_injected');
    expect(stuck[0].idleMs).toBeGreaterThanOrEqual(IDLE_THRESHOLD_MS);
  });

  test('warm runner idle between turns is NOT stuck: turn completed, no owed work', () => {
    const q = new GroupQueue();
    // queryInFlight=false means the runner reported the turn idle and nothing
    // is queued behind it. IDLE_TIMEOUT owns this runner, not stuck recovery.
    seedRunner(q, jid, {
      groupFolder: folder,
      queryInFlight: false,
      ipcOwedSinceAt: Date.now() - IDLE_THRESHOLD_MS - 1000,
      lastActivityAt: Date.now() - IDLE_THRESHOLD_MS - 1000,
    });

    expect(q.getStuckPendingGroups(IDLE_THRESHOLD_MS)).toHaveLength(0);
  });

  test('a turn queued behind a silent runner reports stuck with pending_tasks reason', () => {
    const q = new GroupQueue();
    seedRunner(q, jid, {
      groupFolder: folder,
      pendingTasks: 1,
      lastActivityAt: Date.now() - IDLE_THRESHOLD_MS - 1000,
    });

    const stuck = q.getStuckPendingGroups(IDLE_THRESHOLD_MS);
    expect(stuck).toHaveLength(1);
    expect(stuck[0].jid).toBe(jid);
    expect(stuck[0].reason).toBe('pending_tasks');
  });

  test('a silent in-flight query with work queued behind it is not stuck; owed IPC is', () => {
    const q = new GroupQueue();
    // A five-minute build in one tool call: no output, a turn queued behind.
    seedRunner(q, jid, {
      groupFolder: folder,
      queryInFlight: true,
      pendingTasks: 1,
      lastActivityAt: Date.now() - IDLE_THRESHOLD_MS - 120_000,
    });
    expect(q.getStuckPendingGroups(IDLE_THRESHOLD_MS)).toEqual([]);

    // Input injected into that query and never read is owed by it.
    getState(q, jid).ipcOwedSinceAt = Date.now() - IDLE_THRESHOLD_MS - 120_000;
    expect(
      q.getStuckPendingGroups(IDLE_THRESHOLD_MS).map((c) => [c.jid, c.reason]),
    ).toEqual([[jid, 'ipc_injected']]);
  });

  test('a turn queued on a sibling JID of the same lane is owed by its runner', () => {
    const q = new GroupQueue();
    const sibling = `feishu:${folder}#agent:${AGENT_ID}`;
    q.setSerializationKeyResolver((groupJid) =>
      groupJid === jid || groupJid === sibling
        ? `${folder}#${AGENT_ID}`
        : groupJid,
    );
    seedRunner(q, jid, {
      groupFolder: folder,
      lastActivityAt: Date.now() - IDLE_THRESHOLD_MS - 1000,
    });
    expect(q.getStuckPendingGroups(IDLE_THRESHOLD_MS)).toHaveLength(0);

    seedRunner(q, sibling, { active: false, pendingTasks: 1 });
    const stuck = q.getStuckPendingGroups(IDLE_THRESHOLD_MS);
    expect(stuck.map((candidate) => [candidate.jid, candidate.reason])).toEqual(
      [[jid, 'pending_tasks']],
    );
  });

  test('a session lane whose runner went silent with a turn queued is picked up', async () => {
    const q = new GroupQueue();
    let finish!: () => void;
    q.enqueueTask(
      jid,
      'silent-turn',
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    q.registerProcess(jid, { pid: 4242 } as never, {
      containerName: null,
      groupFolder: folder,
      agentId: AGENT_ID,
    });
    q.markRunnerQueryIdle(jid);
    q.enqueueTask(jid, 'queued-turn', async () => {});
    expect(q.getStuckPendingGroups(IDLE_THRESHOLD_MS)).toHaveLength(0);

    const later = Date.now() + IDLE_THRESHOLD_MS + 1000;
    const now = vi.spyOn(Date, 'now').mockReturnValue(later);
    try {
      const [candidate] = q.getStuckPendingGroups(IDLE_THRESHOLD_MS);
      expect(candidate).toMatchObject({
        jid,
        reason: 'pending_tasks',
        runnerPid: 4242,
        queryId: null,
      });
      expect(
        q.revalidateStuckRecoveryCandidate(candidate, IDLE_THRESHOLD_MS),
      ).toMatchObject({ jid, reason: 'pending_tasks' });
    } finally {
      now.mockRestore();
      finish();
    }
  });

  test('probe result is rejected once the queued turn is gone', () => {
    const q = new GroupQueue();
    seedRunner(q, jid, {
      groupFolder: folder,
      runnerPid: 107,
      pendingTasks: 1,
      lastActivityAt: Date.now() - IDLE_THRESHOLD_MS - 1000,
    });
    const [candidate] = q.getStuckPendingGroups(IDLE_THRESHOLD_MS);
    expect(candidate.reason).toBe('pending_tasks');

    getState(q, jid).pendingTasks = [];
    expect(
      q.revalidateStuckRecoveryCandidate(candidate, IDLE_THRESHOLD_MS),
    ).toBeNull();
  });

  test('a recently injected follow-up is not stuck: sendMessage restarts the idle window', () => {
    const q = new GroupQueue();
    // Warm runner sitting idle long past the threshold when the user's
    // follow-up arrives. Without the lastActivityAt refresh at inject time,
    // the runner would look instantly stuck and get restarted before it had
    // any chance to answer.
    seedRunner(q, jid, {
      groupFolder: folder,
      queryInFlight: false,
      lastActivityAt: Date.now() - IDLE_THRESHOLD_MS - 1000,
    });

    expect(q.sendMessage(jid, 'follow-up message')).toBe('sent');
    expect(getState(q, jid).lastActivityAt).toBeGreaterThan(
      Date.now() - IDLE_THRESHOLD_MS,
    );
    expect(getState(q, jid).queryInFlight).toBe(true);
    expect(getState(q, jid).ipcOwedSinceAt).toEqual(expect.any(Number));
    expect(q.getStuckPendingGroups(IDLE_THRESHOLD_MS)).toHaveLength(0);
  });

  test('ordinary runner output refreshes idle activity without moving the absolute IPC debt clock', () => {
    const q = new GroupQueue();
    seedRunner(q, jid, {
      groupFolder: folder,
      queryInFlight: true,
      ipcOwedSinceAt: 1,
      lastActivityAt: 1,
    });

    q.markRunnerActivity(jid);

    expect(getState(q, jid).lastActivityAt).toBeGreaterThan(1);
    expect(getState(q, jid).ipcOwedSinceAt).toBe(1);
  });

  test('absolute IPC ceiling remains visible despite recent runner output', () => {
    const q = new GroupQueue();
    const forceRestartMs = 10 * 60 * 1000;
    seedRunner(q, jid, {
      groupFolder: folder,
      queryInFlight: true,
      ipcOwedSinceAt: Date.now() - forceRestartMs - 1000,
      lastActivityAt: Date.now() - 30_000,
    });

    const stuck = q.getStuckPendingGroups(IDLE_THRESHOLD_MS, forceRestartMs);
    expect(stuck).toHaveLength(1);
    expect(stuck[0].reason).toBe('ipc_injected');
    expect(stuck[0].idleMs).toBeLessThan(IDLE_THRESHOLD_MS);
    expect(stuck[0].ipcOwedMs).toBeGreaterThanOrEqual(forceRestartMs);
  });

  test('probe result is rejected when the old turn becomes idle', () => {
    const q = new GroupQueue();
    seedRunner(q, jid, {
      groupFolder: folder,
      runnerPid: 101,
      queryInFlight: true,
      queryId: 'old-query',
      ipcOwedSinceAt: Date.now() - IDLE_THRESHOLD_MS - 1000,
      lastActivityAt: Date.now() - IDLE_THRESHOLD_MS - 1000,
    });
    const [candidate] = q.getStuckPendingGroups(IDLE_THRESHOLD_MS);

    q.markRunnerQueryIdle(jid);

    expect(
      q.revalidateStuckRecoveryCandidate(candidate, IDLE_THRESHOLD_MS),
    ).toBeNull();
  });

  test('probe result is rejected when fresh activity drops below the idle threshold', () => {
    const q = new GroupQueue();
    seedRunner(q, jid, {
      groupFolder: folder,
      runnerPid: 106,
      queryInFlight: true,
      queryId: 'recovering-query',
      ipcOwedSinceAt: Date.now() - IDLE_THRESHOLD_MS - 1000,
      lastActivityAt: Date.now() - IDLE_THRESHOLD_MS - 1000,
    });
    const [candidate] = q.getStuckPendingGroups(IDLE_THRESHOLD_MS);

    q.markRunnerActivity(jid);

    expect(
      q.revalidateStuckRecoveryCandidate(candidate, IDLE_THRESHOLD_MS),
    ).toBeNull();
  });

  test('probe result cannot restart a new healthy query on the same warm runner', () => {
    const q = new GroupQueue();
    seedRunner(q, jid, {
      groupFolder: folder,
      runnerPid: 102,
      queryInFlight: true,
      queryId: 'old-query',
      ipcOwedSinceAt: Date.now() - IDLE_THRESHOLD_MS - 1000,
      lastActivityAt: Date.now() - IDLE_THRESHOLD_MS - 1000,
    });
    const [candidate] = q.getStuckPendingGroups(IDLE_THRESHOLD_MS);

    q.markRunnerQueryIdle(jid);
    expect(q.sendMessage(jid, 'new healthy turn')).toBe('sent');
    expect(getState(q, jid).queryId).not.toBe(candidate.queryId);

    expect(
      q.revalidateStuckRecoveryCandidate(candidate, IDLE_THRESHOLD_MS),
    ).toBeNull();
  });

  test('probe result is rejected when the query, PID, or generation changes', () => {
    const q = new GroupQueue();
    seedRunner(q, jid, {
      groupFolder: folder,
      runnerPid: 103,
      queryInFlight: true,
      queryId: 'same-query',
      ipcOwedSinceAt: Date.now() - IDLE_THRESHOLD_MS - 1000,
      lastActivityAt: Date.now() - IDLE_THRESHOLD_MS - 1000,
    });
    const [candidate] = q.getStuckPendingGroups(IDLE_THRESHOLD_MS);
    const state = getState(q, jid);

    state.queryId = 'replacement-query';
    expect(
      q.revalidateStuckRecoveryCandidate(candidate, IDLE_THRESHOLD_MS),
    ).toBeNull();

    state.queryId = 'same-query';
    state.process = { pid: 104 };
    expect(
      q.revalidateStuckRecoveryCandidate(candidate, IDLE_THRESHOLD_MS),
    ).toBeNull();

    state.process = { pid: 103 };
    state.runnerGeneration = 2;
    expect(
      q.revalidateStuckRecoveryCandidate(candidate, IDLE_THRESHOLD_MS),
    ).toBeNull();
  });

  test('probe result is accepted only while the same IPC debt remains owed', () => {
    const q = new GroupQueue();
    seedRunner(q, jid, {
      groupFolder: folder,
      runnerPid: 105,
      queryInFlight: true,
      queryId: 'same-query',
      ipcOwedSinceAt: Date.now() - IDLE_THRESHOLD_MS - 2000,
      lastActivityAt: Date.now() - IDLE_THRESHOLD_MS - 2000,
    });
    const [candidate] = q.getStuckPendingGroups(IDLE_THRESHOLD_MS);

    expect(
      q.revalidateStuckRecoveryCandidate(candidate, IDLE_THRESHOLD_MS),
    ).toMatchObject({
      runnerGeneration: candidate.runnerGeneration,
      queryId: candidate.queryId,
      runnerPid: candidate.runnerPid,
      ipcOwedSinceAt: candidate.ipcOwedSinceAt,
    });

    getState(q, jid).ipcOwedSinceAt = Date.now() - IDLE_THRESHOLD_MS - 1000;
    expect(
      q.revalidateStuckRecoveryCandidate(candidate, IDLE_THRESHOLD_MS),
    ).toBeNull();
  });

  test('in-flight injected turn below the idle threshold is not stuck', () => {
    const q = new GroupQueue();
    seedRunner(q, jid, {
      groupFolder: folder,
      queryInFlight: true,
      ipcOwedSinceAt: Date.now() - 30_000,
      lastActivityAt: Date.now() - 30_000,
    });

    expect(q.getStuckPendingGroups(IDLE_THRESHOLD_MS)).toHaveLength(0);
  });

  test('a session runner started by a task is judged like any runner', () => {
    const q = new GroupQueue();
    const jid = `web:${folder}#agent:sess1`;
    seedRunner(q, jid, {
      groupFolder: folder,
      agentId: 'sess1',
      queryInFlight: true,
      ipcOwedSinceAt: Date.now() - IDLE_THRESHOLD_MS - 1000,
      lastActivityAt: Date.now() - IDLE_THRESHOLD_MS - 1000,
    });
    getState(q, jid).activeTask = queuedTask('agent-conversation');

    const stuck = q.getStuckPendingGroups(IDLE_THRESHOLD_MS);
    expect(stuck).toHaveLength(1);
    expect(stuck[0]).toMatchObject({ jid, reason: 'ipc_injected' });
  });
  test('internal-continue idle does not wipe unpaid IPC debt', () => {
    const q = new GroupQueue();
    const owedAt = Date.now() - IDLE_THRESHOLD_MS - 1000;
    seedRunner(q, jid, {
      groupFolder: folder,
      queryInFlight: true,
      ipcOwedSinceAt: owedAt,
      lastActivityAt: owedAt,
    });
    const receipt = {
      deliveryId: 'pending-delivery',
      chatJid: jid,
      cursor: { timestamp: '2026-08-27T00:00:00.000Z', id: 'message-1' },
    };
    (getState(q, jid).pendingIpcDeliveries as Map<string, typeof receipt>).set(
      receipt.deliveryId,
      receipt,
    );

    q.markRunnerQueryIdle(jid, { preserveIpcDebt: true });

    expect(getState(q, jid).queryInFlight).toBe(true);
    expect(getState(q, jid).ipcOwedSinceAt).toBe(owedAt);
    const stuck = q.getStuckPendingGroups(IDLE_THRESHOLD_MS);
    expect(stuck).toHaveLength(1);
    expect(stuck[0].reason).toBe('ipc_injected');

    q.setIpcDeliveryCommitEligibilityChecker(() => true);
    q.acknowledgeIpcDeliveries(jid, [receipt], () => {});
    q.markRunnerQueryIdle(jid, { preserveIpcDebt: true });
    expect(getState(q, jid).queryInFlight).toBe(false);
  });

  test('disk IPC preserves continue debt even before receipt bookkeeping exists', () => {
    const q = new GroupQueue();
    const owedAt = Date.now() - IDLE_THRESHOLD_MS - 1000;
    seedRunner(q, jid, {
      groupFolder: folder,
      queryInFlight: true,
      ipcOwedSinceAt: owedAt,
      lastActivityAt: owedAt,
    });
    fs.mkdirSync(inputDir, { recursive: true });
    fs.writeFileSync(path.join(inputDir, 'pending.json'), '{}');

    q.markRunnerQueryIdle(jid, { preserveIpcDebt: true });
    expect(getState(q, jid).queryInFlight).toBe(true);

    fs.unlinkSync(path.join(inputDir, 'pending.json'));
    q.markRunnerQueryIdle(jid, { preserveIpcDebt: true });
    expect(getState(q, jid).queryInFlight).toBe(false);
  });

  test('runner claim files preserve IPC debt after a crash', () => {
    const q = new GroupQueue();
    seedRunner(q, jid, {
      groupFolder: folder,
      queryInFlight: true,
      ipcOwedSinceAt: Date.now() - IDLE_THRESHOLD_MS - 1000,
      lastActivityAt: Date.now() - IDLE_THRESHOLD_MS - 1000,
    });
    fs.mkdirSync(inputDir, { recursive: true });
    const claim = path.join(
      inputDir,
      'pending.json.happyclaw-claimed-123-1-test',
    );
    fs.writeFileSync(claim, '{}');

    q.markRunnerQueryIdle(jid, { preserveIpcDebt: true });
    expect(getState(q, jid).queryInFlight).toBe(true);

    fs.unlinkSync(claim);
    q.markRunnerQueryIdle(jid, { preserveIpcDebt: true });
    expect(getState(q, jid).queryInFlight).toBe(false);
  });

  test('unacknowledged recovery removes the Runner claim before DB replay', () => {
    const q = new GroupQueue();
    seedRunner(q, jid, { groupFolder: folder, queryInFlight: true });
    const receipt = {
      deliveryId: 'delivery-claim',
      chatJid: jid,
      cursor: {
        timestamp: '2026-08-31T00:00:00.000Z',
        id: 'message-claim',
        sequence: 42,
      },
    };
    const state = getState(q, jid);
    (state.pendingIpcDeliveries as Map<string, typeof receipt>).set(
      receipt.deliveryId,
      receipt,
    );
    fs.mkdirSync(inputDir, { recursive: true });
    const claim = path.join(
      inputDir,
      'pending.json.happyclaw-claimed-123-1-test',
    );
    fs.writeFileSync(
      claim,
      JSON.stringify({ type: 'message', text: 'pending', receipt }),
    );
    const rewind = vi.fn();
    q.setOnUnacknowledgedIpcDeliveries(rewind);

    (
      q as unknown as {
        recoverUnacknowledgedIpcDeliveries: (
          groupJid: string,
          groupState: Record<string, unknown>,
        ) => void;
      }
    ).recoverUnacknowledgedIpcDeliveries(jid, state);

    expect(fs.existsSync(claim)).toBe(false);
    expect(rewind).toHaveBeenCalledWith(jid, [receipt]);
  });

  test('internal-continue preserve hint still closes a query with no real IPC debt', () => {
    const q = new GroupQueue();
    seedRunner(q, jid, {
      groupFolder: folder,
      queryInFlight: true,
      ipcOwedSinceAt: null,
      lastActivityAt: Date.now() - 1000,
    });

    q.markRunnerQueryIdle(jid, { preserveIpcDebt: true });

    expect(getState(q, jid).queryInFlight).toBe(false);
    expect(getState(q, jid).queryId).toBeNull();
    expect(q.getStuckPendingGroups(IDLE_THRESHOLD_MS)).toHaveLength(0);
  });

  test('ordinary query idle still clears IPC debt', () => {
    const q = new GroupQueue();
    seedRunner(q, jid, {
      groupFolder: folder,
      queryInFlight: true,
      ipcOwedSinceAt: Date.now() - 1000,
      lastActivityAt: Date.now() - 1000,
    });

    q.markRunnerQueryIdle(jid);

    expect(getState(q, jid).queryInFlight).toBe(false);
    expect(getState(q, jid).ipcOwedSinceAt).toBeNull();
    expect(q.getStuckPendingGroups(IDLE_THRESHOLD_MS)).toHaveLength(0);
  });
});
