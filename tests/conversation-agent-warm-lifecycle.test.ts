import { afterEach, describe, expect, test } from 'vitest';
import fs from 'fs';
import path from 'path';

import { GroupQueue } from '../src/group-queue.js';
import { DATA_DIR } from '../src/config.js';

// Regression coverage for PR #547: conversation agents must stay WARM after a
// final reply (reclaimed by IDLE_TIMEOUT), instead of being closed every turn.
// A hung post-reply tool call is handled runner-side by the post-result
// interrupt fallback — the host must NOT tear the warm runner down.
//
// These tests exercise the real GroupQueue state machine. State is seeded
// directly into the internal map (same approach as
// group-queue-descendants.test.ts) so the tests stay hermetic and don't need a
// real spawned process.

const AGENT_ID = 'conversation';

interface SeedOpts {
  active?: boolean;
  groupFolder?: string;
  agentId?: string | null;
  queryInFlight?: boolean;
  lastActivityAt?: number | null;
}

function seedRunner(q: GroupQueue, jid: string, opts: SeedOpts = {}) {
  const anyQ = q as unknown as { groups: Map<string, Record<string, unknown>> };
  anyQ.groups.set(jid, {
    active: opts.active ?? true,
    lastActivityAt: opts.lastActivityAt ?? null,
    queryInFlight: opts.queryInFlight ?? false,
    pendingTasks: [],
    process: null,
    containerName: null,
    displayName: null,
    groupFolder: opts.groupFolder ?? 'main',
    agentId: opts.agentId ?? AGENT_ID,
    retryCount: 0,
    retryTimer: null,
    restarting: false,
    selectedProviderId: null,
    drainSentinelWritten: false,
  });
}

function getState(q: GroupQueue, jid: string): Record<string, unknown> {
  const anyQ = q as unknown as { groups: Map<string, Record<string, unknown>> };
  return anyQ.groups.get(jid)!;
}

describe('PR #547: conversation agent stays warm after final reply', () => {
  // Unique folder per run so the real DATA_DIR (= worktree/data, gitignored and
  // vitest-excluded) is not polluted across runs. Cleaned up in afterEach.
  const folder = `warm-test-${process.pid}-${Date.now()}`;
  const ipcDir = path.join(DATA_DIR, 'ipc', folder);
  const jid = `web:${folder}#agent:${AGENT_ID}`;

  afterEach(() => {
    fs.rmSync(ipcDir, { recursive: true, force: true });
  });

  test('runner remains acceptable for the next message after a final reply (markRunnerQueryIdle)', () => {
    const q = new GroupQueue();
    // Active conversation runner mid-turn.
    seedRunner(q, jid, { groupFolder: folder, queryInFlight: true });

    // Host marks the query idle when the final reply is emitted (success+result).
    // This is what wrappedOnOutput does instead of closing the runner.
    q.markRunnerQueryIdle(jid);
    expect(getState(q, jid).queryInFlight).toBe(false);

    // The warm runner is still a valid target for the next user message —
    // sendMessage would route into it (no cold start).
    expect(q.hasActiveRunnerForMessage(jid)).toBe(true);
  });

  test('a hung post-reply tool call does not strand the runner: next message reuses the warm process', () => {
    const q = new GroupQueue();
    seedRunner(q, jid, { groupFolder: folder, queryInFlight: true });

    // Final reply emitted -> host marks idle (runner kept warm, NOT closed).
    q.markRunnerQueryIdle(jid);

    // The next user message is piped into the SAME warm runner via IPC.
    const result = q.sendMessage(jid, 'follow-up message');
    expect(result).toBe('sent');
    // sendMessage flips queryInFlight back to true: the warm runner picked it up.
    expect(getState(q, jid).queryInFlight).toBe(true);

    // The IPC file was written to the warm runner's input dir (reuse, not respawn).
    const inputDir = path.join(ipcDir, 'agents', AGENT_ID, 'input');
    const files = fs.readdirSync(inputDir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBe(1);
  });

  test('a new query on a warm runner is announced exactly once before streaming begins', () => {
    const q = new GroupQueue();
    seedRunner(q, jid, { groupFolder: folder, queryInFlight: false });
    const starts: Array<{ jid: string; queryId: string; startedAt: number }> =
      [];
    q.setOnQueryStart((callbackJid, queryId, startedAt) => {
      starts.push({ jid: callbackJid, queryId, startedAt });
    });

    expect(q.sendMessage(jid, 'first warm follow-up')).toBe('sent');
    expect(starts).toHaveLength(1);
    expect(starts[0].jid).toBe(jid);
    expect(starts[0].queryId).toBe(getState(q, jid).queryId);
    expect(starts[0].startedAt).toBeGreaterThan(0);

    // More input for the same in-flight query must not reopen the UI run.
    expect(q.sendMessage(jid, 'same in-flight query')).toBe('sent');
    expect(starts).toHaveLength(1);

    q.markRunnerQueryIdle(jid);
    expect(q.sendMessage(jid, 'next logical query')).toBe('sent');
    expect(starts).toHaveLength(2);
    expect(starts[1].queryId).not.toBe(starts[0].queryId);
  });

  test('markRunnerActivity refreshes lastActivityAt so IDLE_TIMEOUT reclaims the warm runner', () => {
    const q = new GroupQueue();
    seedRunner(q, jid, { groupFolder: folder, lastActivityAt: 1 });

    const before = Date.now();
    q.markRunnerActivity(jid);
    const after = Date.now();

    const last = getState(q, jid).lastActivityAt as number;
    expect(last).toBeGreaterThanOrEqual(before);
    expect(last).toBeLessThanOrEqual(after);
  });

  test('spawn-style runners are still distinguishable: closing one leaves it inactive', () => {
    // Spawn agents remain fire-and-forget (closeStdin then teardown). This guards
    // that the warm-keeping change is scoped to conversation agents only — an
    // inactive runner must not accept follow-up messages.
    const q = new GroupQueue();
    const jid = `web:${folder}#agent:spawn1`;
    seedRunner(q, jid, {
      active: false,
      groupFolder: folder,
      agentId: 'spawn1',
    });

    expect(q.hasActiveRunnerForMessage(jid)).toBe(false);
    expect(q.sendMessage(jid, 'late message')).toBe('no_active');
  });
});

describe('PR #547: cleanupIpcSentinels clears _interrupt alongside _close/_drain', () => {
  const folder = `sentinel-test-${process.pid}-${Date.now()}`;
  const inputDir = path.join(DATA_DIR, 'ipc', folder, 'agents', 's', 'input');

  afterEach(() => {
    fs.rmSync(path.join(DATA_DIR, 'ipc', folder), {
      recursive: true,
      force: true,
    });
  });

  test('removes _drain, _close and _interrupt sentinels', () => {
    fs.mkdirSync(inputDir, { recursive: true });
    for (const name of ['_drain', '_close', '_interrupt']) {
      fs.writeFileSync(path.join(inputDir, name), '');
    }

    const q = new GroupQueue();
    // cleanupIpcSentinels is private; call it the same way the finally blocks do.
    (
      q as unknown as {
        cleanupIpcSentinels(folder: string, agentId: string | null): void;
      }
    ).cleanupIpcSentinels(folder, 's');

    for (const name of ['_drain', '_close', '_interrupt']) {
      expect(fs.existsSync(path.join(inputDir, name))).toBe(false);
    }
  });
});
