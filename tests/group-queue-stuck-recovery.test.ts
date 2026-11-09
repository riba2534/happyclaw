import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

import { GroupQueue, type IpcDeliveryReceipt } from '../src/group-queue.js';
import { DATA_DIR } from '../src/config.js';
import type { StreamEvent } from '../src/stream-event.types.js';
import {
  decideStuckRunnerRecovery,
  type RunnerCpuActivity,
} from '../src/stuck-runner-recovery.js';
import { createRuntimeSourceHarness } from './helpers/runtime-source.js';

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
  backgroundHoldQueryId?: string | null;
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
    backgroundHoldQueryId: opts.backgroundHoldQueryId ?? null,
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

  describe('the input that opens a warm query over IPC', () => {
    const FORCE_RESTART_MS = 10 * 60 * 1000;
    const MINUTE = 60 * 1000;
    let clock = 0;
    let exitRunner: (() => void) | undefined;

    beforeEach(() => {
      clock = Date.now();
      vi.spyOn(Date, 'now').mockImplementation(() => clock);
    });

    afterEach(() => {
      vi.restoreAllMocks();
      exitRunner?.();
      exitRunner = undefined;
    });

    /** A runner whose cold turn has ended: warm, between queries. */
    function warmRunner(runtime: 'host' | 'container' = 'host'): GroupQueue {
      const q = new GroupQueue();
      q.setHostModeChecker(() => runtime === 'host');
      q.enqueueTask(
        jid,
        'cold-turn',
        () => new Promise<void>((resolve) => (exitRunner = resolve)),
      );
      q.registerProcess(jid, { pid: 4300 } as never, {
        containerName: runtime === 'host' ? null : 'happyclaw-stuck-test',
        groupFolder: folder,
        agentId: AGENT_ID,
      });
      q.markRunnerQueryIdle(jid);
      return q;
    }

    function inject(q: GroupQueue, text = 'follow-up'): string {
      expect(q.sendMessage(jid, text)).toBe('sent');
      return q.getActiveQueryId(jid)!;
    }

    /** Model output the CLI streams for the query `queryRunId`. */
    function answer(queryRunId: string): StreamEvent {
      return {
        eventType: 'text_delta',
        agentScope: 'main',
        text: 'On it',
        queryRunId,
      };
    }

    /**
     * Let `ms` pass as in production: an output every 5 s when `outputs`,
     * the supervisor's check every 30 s. Returns the first restart decided,
     * with the time it came at.
     */
    function patrol(
      q: GroupQueue,
      ms: number,
      { outputs, cpu }: { outputs: boolean; cpu: RunnerCpuActivity },
    ) {
      const start = clock;
      for (let elapsed = 5_000; elapsed <= ms; elapsed += 5_000) {
        clock = start + elapsed;
        if (outputs) q.markRunnerActivity(jid);
        if (elapsed % 30_000 !== 0) continue;
        for (const candidate of q.getStuckPendingGroups(
          IDLE_THRESHOLD_MS,
          FORCE_RESTART_MS,
        )) {
          const decision = decideStuckRunnerRecovery(
            candidate,
            cpu,
            FORCE_RESTART_MS,
          );
          if (decision.action === 'restart') {
            return { atMs: elapsed, reason: decision.reason };
          }
        }
      }
      return null;
    }

    test('a query the model answers runs past the ceiling while it keeps working', () => {
      const q = warmRunner();
      const queryId = inject(q);
      clock += 2_000;
      q.markRunnerActivity(jid);
      q.markRunnerServingQuery(jid, answer(queryId));

      expect(patrol(q, 15 * MINUTE, { outputs: true, cpu: 'active' })).toBe(
        null,
      );
      expect(getState(q, jid).ipcOwedSinceAt).toBeNull();
    });

    // #618: the Runner takes the input and the CLI goes quiet for good.
    test.each([
      ['Host', 'host', 'inactive', { atMs: 3 * MINUTE, reason: 'idle' }],
      [
        'Container',
        'container',
        'unavailable',
        { atMs: FORCE_RESTART_MS, reason: 'idle_ceiling' },
      ],
    ] as const)(
      '%s: a query the model answered and then fell silent is restarted when idle',
      (_name, runtime, cpu, restart) => {
        const q = warmRunner(runtime);
        const queryId = inject(q);
        clock += 1_000;
        q.markRunnerActivity(jid);
        q.markRunnerServingQuery(jid, answer(queryId));

        expect(patrol(q, 11 * MINUTE, { outputs: false, cpu })).toEqual(
          restart,
        );
      },
    );

    test.each([
      [
        'the model message starting',
        {
          eventType: 'raw_sdk_event',
          agentScope: 'main',
          rawType: 'stream_event/message_start',
        },
      ],
      ['a tool call', { eventType: 'tool_use_start', toolName: 'Bash' }],
      ['a sub-agent starting', { eventType: 'task_start', agentScope: 'task' }],
    ] as const)('%s answers the query', (_name, event) => {
      const q = warmRunner();
      const queryId = inject(q);
      q.markRunnerServingQuery(jid, { ...event, queryRunId: queryId });
      expect(getState(q, jid).ipcOwedSinceAt).toBeNull();
    });

    // The Runner traces the memory it recalled for the input, and audits the
    // context it opens the SDK query with, before the CLI sends a request.
    test("the Runner's own events do not answer the query", () => {
      const q = warmRunner();
      const queryId = inject(q);
      const injectedAt = clock;
      clock += 1_000;
      const runnerEvents: StreamEvent[] = [
        {
          eventType: 'memory_recall',
          agentScope: 'system',
          isSynthetic: true,
        },
        { eventType: 'context_audit', agentScope: 'system' },
        { eventType: 'hook_started', agentScope: 'system' },
        { eventType: 'status', statusText: '接近 API 限流阈值' },
      ];
      for (const event of runnerEvents) {
        q.markRunnerServingQuery(jid, { ...event, queryRunId: queryId });
      }
      expect(getState(q, jid).ipcOwedSinceAt).toBe(injectedAt);

      // They keep coming; the model never answers.
      expect(patrol(q, 11 * MINUTE, { outputs: true, cpu: 'active' })).toEqual({
        atMs: FORCE_RESTART_MS,
        reason: 'absolute_ipc_ceiling',
      });
    });

    test('a query that never echoes and stays silent is restarted when idle', () => {
      const q = warmRunner();
      inject(q);
      expect(
        patrol(q, 4 * MINUTE, { outputs: false, cpu: 'inactive' }),
      ).toEqual({ atMs: 3 * MINUTE, reason: 'idle' });
    });

    test('a query that never echoes is restarted at the ceiling despite CPU', () => {
      const q = warmRunner();
      inject(q);
      expect(patrol(q, 11 * MINUTE, { outputs: false, cpu: 'active' })).toEqual(
        { atMs: FORCE_RESTART_MS, reason: 'absolute_ipc_ceiling' },
      );
    });

    test('a late event of the previous query pays nothing for the next one', () => {
      const q = warmRunner();
      const previous = inject(q, 'first');
      q.markRunnerServingQuery(jid, answer(previous));
      q.markRunnerQueryIdle(jid);
      const next = inject(q, 'second');
      const injectedAt = clock;
      expect(next).not.toBe(previous);

      clock += 1_000;
      q.markRunnerServingQuery(jid, answer(previous));
      q.markRunnerServingQuery(jid, undefined);
      expect(getState(q, jid).ipcOwedSinceAt).toBe(injectedAt);

      // Output keeps coming, none of it stamped with the new query.
      expect(patrol(q, 11 * MINUTE, { outputs: true, cpu: 'active' })).toEqual({
        atMs: FORCE_RESTART_MS,
        reason: 'absolute_ipc_ceiling',
      });
    });

    test('input appended before the echo is owed from when it arrived', () => {
      const q = warmRunner();
      const queryId = inject(q);
      clock += MINUTE;
      inject(q, 'appended');
      const appendedAt = clock;
      clock += 1_000;
      q.markRunnerServingQuery(jid, answer(queryId));

      expect(getState(q, jid).ipcOwedSinceAt).toBe(appendedAt);
      // Ten minutes after the appended input, not after the opening one.
      expect(patrol(q, 11 * MINUTE, { outputs: true, cpu: 'active' })).toEqual({
        atMs: FORCE_RESTART_MS,
        reason: 'absolute_ipc_ceiling',
      });
    });

    test('input appended after the echo starts its own clock', () => {
      const q = warmRunner();
      const queryId = inject(q);
      q.markRunnerServingQuery(jid, answer(queryId));
      clock += 5 * MINUTE;
      expect(inject(q, 'appended')).toBe(queryId);
      const appendedAt = clock;

      // More events of the same query do not pay the appended input.
      clock += 1_000;
      q.markRunnerServingQuery(jid, answer(queryId));
      expect(getState(q, jid).ipcOwedSinceAt).toBe(appendedAt);

      q.markRunnerQueryIdle(jid);
      expect(getState(q, jid).ipcOwedSinceAt).toBeNull();
    });

    test('input appended to a cold query is not paid by its echo', () => {
      const q = new GroupQueue();
      q.enqueueTask(
        jid,
        'cold-turn',
        () => new Promise<void>((resolve) => (exitRunner = resolve)),
      );
      q.registerProcess(jid, { pid: 4301 } as never, {
        containerName: null,
        groupFolder: folder,
        agentId: AGENT_ID,
      });
      const coldQuery = q.getActiveQueryId(jid)!;
      clock += MINUTE;
      expect(inject(q, 'appended')).toBe(coldQuery);
      const appendedAt = clock;

      q.markRunnerServingQuery(jid, answer(coldQuery));
      expect(getState(q, jid).ipcOwedSinceAt).toBe(appendedAt);
    });

    // A continue the Runner runs on its own (compaction or truncation) ends
    // with IPC of the query still unacknowledged or on disk, and the query
    // stays in flight. It is owed from its opening input again, as if the
    // model had never answered: restarted no later than before the echo.
    test.each([
      [
        'Host',
        'host',
        'inactive',
        9,
        { atMs: MINUTE, reason: 'absolute_ipc_ceiling' },
      ],
      [
        'Container',
        'container',
        'unavailable',
        6,
        { atMs: 4 * MINUTE, reason: 'absolute_ipc_ceiling' },
      ],
    ] as const)(
      '%s: an answered query a continue keeps in flight is owed from its opening input',
      (_name, runtime, cpu, minutes, restart) => {
        const q = warmRunner(runtime);
        const queryId = inject(q);
        const injectedAt = clock;
        q.markRunnerServingQuery(jid, answer(queryId));
        expect(patrol(q, minutes * MINUTE, { outputs: true, cpu })).toBeNull();

        // The input file is still on disk.
        q.markRunnerQueryIdle(jid, { preserveIpcDebt: true });
        expect(q.getActiveQueryId(jid)).toBe(queryId);
        expect(getState(q, jid).ipcOwedSinceAt).toBe(injectedAt);
        // Ten minutes after the input came.
        expect(patrol(q, 11 * MINUTE, { outputs: false, cpu })).toEqual(
          restart,
        );
      },
    );

    test('a continue owes the opening input before one appended later', () => {
      const q = warmRunner();
      const queryId = inject(q);
      const injectedAt = clock;
      q.markRunnerServingQuery(jid, answer(queryId));
      clock += 5 * MINUTE;
      inject(q, 'appended');
      clock += MINUTE;

      q.markRunnerQueryIdle(jid, { preserveIpcDebt: true });
      expect(getState(q, jid).ipcOwedSinceAt).toBe(injectedAt);
    });

    test('a continue after a hold owes the opening input from its end', () => {
      const q = warmRunner();
      const queryId = inject(q);
      q.markRunnerServingQuery(jid, answer(queryId));
      q.markRunnerBackgroundHold(jid, true);
      clock += 20 * MINUTE;
      q.markRunnerBackgroundHold(jid, false);
      const releasedAt = clock;
      clock += MINUTE;

      q.markRunnerQueryIdle(jid, { preserveIpcDebt: true });
      expect(getState(q, jid).ipcOwedSinceAt).toBe(releasedAt);
    });

    test('an idle report for another query leaves the one in flight alone', () => {
      const q = warmRunner();
      const queryId = inject(q);

      q.markRunnerQueryIdle(jid, { queryId: 'an-earlier-query' });
      expect(q.getActiveQueryId(jid)).toBe(queryId);
      q.markRunnerQueryIdle(jid, { queryId });
      expect(q.getActiveQueryId(jid)).toBeNull();
    });

    // The result of a continue that answers the input reports the query idle
    // and carries the input's receipt, which wrappedOnOutput acknowledges
    // only after handleAgentOutput has taken the output.
    describe("a continue's result, through wrappedOnOutput", () => {
      function host(q: GroupQueue) {
        const commit = vi.fn();
        const globals: Record<string, unknown> = {
          queue: q,
          virtualJid: jid,
          // What handleAgentOutput does with a continue's idle report.
          handleAgentOutput: async () =>
            q.markRunnerQueryIdle(jid, { preserveIpcDebt: true }),
          commitIpcDeliveryReceipts: commit,
          hadError: false,
          lastError: undefined,
          retryUnfinishedTurn: false,
        };
        createRuntimeSourceHarness(globals).install(
          'wrappedOnOutput',
          'processAgentConversation',
        );
        const emit = globals.wrappedOnOutput as (
          output: object,
        ) => Promise<void>;
        return { emit, commit };
      }

      function injectWithReceipt(q: GroupQueue, id: string) {
        let receipt: IpcDeliveryReceipt | undefined;
        const cursor = { timestamp: new Date(clock).toISOString(), id };
        expect(
          q.sendMessage(
            jid,
            id,
            undefined,
            (injected) => (receipt = injected),
            jid,
            { chatJid: jid, coveredCursors: [cursor], cursor },
          ),
        ).toBe('sent');
        return receipt!;
      }

      function continueResult(receipts: IpcDeliveryReceipt[]) {
        return {
          status: 'success',
          result: 'the rest of the answer',
          sourceKind: 'truncation_continue',
          inputTurnCompleted: true,
          queryIdle: true,
          ipcReceipts: receipts,
        };
      }

      test('ends the query once the receipt it carries is acknowledged', async () => {
        const q = warmRunner('container');
        q.setIpcDeliveryCommitEligibilityChecker(() => true);
        const receipt = injectWithReceipt(q, 'question');
        q.markRunnerServingQuery(jid, answer(q.getActiveQueryId(jid)!));
        clock += 6 * MINUTE;
        const run = host(q);

        await run.emit(continueResult([receipt]));
        expect(run.commit).toHaveBeenCalledWith([receipt]);
        expect(q.getActiveQueryId(jid)).toBeNull();
        expect(
          patrol(q, 11 * MINUTE, { outputs: false, cpu: 'unavailable' }),
        ).toBeNull();
      });

      test('keeps it in flight for input the continue did not take', async () => {
        const q = warmRunner('container');
        q.setIpcDeliveryCommitEligibilityChecker(() => true);
        const receipt = injectWithReceipt(q, 'question');
        const queryId = q.getActiveQueryId(jid)!;
        q.markRunnerServingQuery(jid, answer(queryId));
        clock += MINUTE;
        injectWithReceipt(q, 'appended');
        const run = host(q);

        await run.emit(continueResult([receipt]));
        expect(run.commit).toHaveBeenCalledWith([receipt]);
        expect(q.getActiveQueryId(jid)).toBe(queryId);
      });
    });

    test("a reservation's first input opens the query", () => {
      const q = warmRunner();
      const reservation = q.reserveNextQuery(jid)!;
      expect(inject(q)).toBe(reservation);

      q.markRunnerServingQuery(jid, answer(reservation));
      expect(getState(q, jid).ipcOwedSinceAt).toBeNull();
    });

    test('the end of a hold restarts the appended clock too', () => {
      const q = warmRunner();
      const queryId = inject(q);
      clock += MINUTE;
      inject(q, 'appended');
      q.markRunnerBackgroundHold(jid, true);
      clock += 20 * MINUTE;
      q.markRunnerBackgroundHold(jid, false);
      const releasedAt = clock;

      q.markRunnerServingQuery(jid, answer(queryId));
      expect(getState(q, jid).ipcOwedSinceAt).toBe(releasedAt);
    });
  });

  describe('background work holding the result', () => {
    const FORCE_RESTART_MS = 10 * 60 * 1000;

    function seedHeldTurn(q: GroupQueue) {
      seedRunner(q, jid, {
        groupFolder: folder,
        queryInFlight: true,
        queryId: 'held-query',
        ipcOwedSinceAt: Date.now() - FORCE_RESTART_MS - 1000,
        lastActivityAt: Date.now() - IDLE_THRESHOLD_MS - 1000,
      });
    }

    test('a held result marks the candidate, whichever rule selected it', () => {
      const q = new GroupQueue();
      seedHeldTurn(q);
      q.markRunnerBackgroundHold(jid, true);

      const [candidate] = q.getStuckPendingGroups(
        IDLE_THRESHOLD_MS,
        FORCE_RESTART_MS,
      );
      expect(candidate.reason).toBe('ipc_injected');
      expect(candidate.backgroundTasksHeld).toBe(true);
      // A later result still reporting live work keeps the hold.
      q.markRunnerBackgroundHold(jid, true);
      expect(
        q.revalidateStuckRecoveryCandidate(
          candidate,
          IDLE_THRESHOLD_MS,
          FORCE_RESTART_MS,
        )?.backgroundTasksHeld,
      ).toBe(true);
    });

    test('settling the work ends the hold and restarts the IPC debt clock', () => {
      const q = new GroupQueue();
      seedHeldTurn(q);
      q.markRunnerBackgroundHold(jid, true);
      const before = Date.now();

      q.markRunnerBackgroundHold(jid, false);

      expect(getState(q, jid).backgroundHoldQueryId).toBeNull();
      expect(getState(q, jid).ipcOwedSinceAt).toBeGreaterThanOrEqual(before);
      // Still silent past the idle threshold: judged like any other turn.
      const [candidate] = q.getStuckPendingGroups(
        IDLE_THRESHOLD_MS,
        FORCE_RESTART_MS,
      );
      expect(candidate.backgroundTasksHeld).toBe(false);
      expect(candidate.ipcOwedMs).toBeLessThan(FORCE_RESTART_MS);
    });

    test('a result without live work leaves an unheld debt clock alone', () => {
      const q = new GroupQueue();
      seedHeldTurn(q);
      const owedSince = getState(q, jid).ipcOwedSinceAt;

      q.markRunnerBackgroundHold(jid, false);

      expect(getState(q, jid).ipcOwedSinceAt).toBe(owedSince);
      const [candidate] = q.getStuckPendingGroups(
        IDLE_THRESHOLD_MS,
        FORCE_RESTART_MS,
      );
      expect(candidate.backgroundTasksHeld).toBe(false);
      expect(candidate.ipcOwedMs).toBeGreaterThanOrEqual(FORCE_RESTART_MS);
    });

    test('a hold never carries over to the next query', () => {
      const q = new GroupQueue();
      seedHeldTurn(q);
      q.markRunnerBackgroundHold(jid, true);

      q.markRunnerQueryIdle(jid);
      expect(getState(q, jid).backgroundHoldQueryId).toBeNull();

      expect(q.sendMessage(jid, 'next turn')).toBe('sent');
      getState(q, jid).ipcOwedSinceAt = Date.now() - FORCE_RESTART_MS - 1000;
      const [candidate] = q.getStuckPendingGroups(
        IDLE_THRESHOLD_MS,
        FORCE_RESTART_MS,
      );
      expect(candidate.backgroundTasksHeld).toBe(false);
    });

    test('an idle runner records no hold', () => {
      const q = new GroupQueue();
      seedRunner(q, jid, { groupFolder: folder, queryInFlight: false });

      q.markRunnerBackgroundHold(jid, true);

      expect(getState(q, jid).backgroundHoldQueryId).toBeNull();
    });

    test('a hold recorded for an earlier query does not mark the current one', () => {
      const q = new GroupQueue();
      seedRunner(q, jid, {
        groupFolder: folder,
        queryInFlight: true,
        queryId: 'held-query',
        backgroundHoldQueryId: 'earlier-query',
        ipcOwedSinceAt: Date.now() - FORCE_RESTART_MS - 1000,
        lastActivityAt: Date.now() - IDLE_THRESHOLD_MS - 1000,
      });

      const [candidate] = q.getStuckPendingGroups(
        IDLE_THRESHOLD_MS,
        FORCE_RESTART_MS,
      );
      expect(candidate.backgroundTasksHeld).toBe(false);
    });

    test('a runner that exits drops its hold', async () => {
      const q = new GroupQueue();
      let finish!: () => void;
      q.enqueueTask(
        jid,
        'held-turn',
        () => new Promise<void>((resolve) => (finish = resolve)),
      );
      q.registerProcess(jid, { pid: 4243 } as never, {
        containerName: null,
        groupFolder: folder,
        agentId: AGENT_ID,
      });
      q.markRunnerBackgroundHold(jid, true);
      // The lane state is dropped once idle; keep it to read the teardown.
      const state = getState(q, jid);
      expect(state.backgroundHoldQueryId).toBe(state.queryId);

      finish();

      await vi.waitFor(() => expect(state.active).toBe(false));
      expect(state.backgroundHoldQueryId).toBeNull();
    });
  });
});
