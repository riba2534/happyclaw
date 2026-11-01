import { describe, expect, test } from 'vitest';

import {
  applyRunFinished,
  applyRunStarted,
  hasExactQueryAttempt,
  runsFromAuthoritativeSnapshot,
  shouldApplyRunScopedPayload,
  waitKeysForQueuedChats,
} from '../web/src/stores/run-lifecycle.js';

const run = (chatJid: string, runId: string) => ({
  chatJid,
  runId,
  startedAt: '2026-07-25T00:00:00.000Z',
  phase: 'preparing' as const,
});

describe('Web exact logical-run fencing', () => {
  test('a late terminal from the old attempt cannot clear its replacement', () => {
    let runs = applyRunStarted({}, run('web:alpha', 'run-old'));
    runs = applyRunStarted(runs, run('web:alpha', 'run-new'));

    const stale = applyRunFinished(runs, 'web:alpha', 'run-old');
    expect(stale.applied).toBe(false);
    expect(stale.runs['web:alpha']?.runId).toBe('run-new');

    const current = applyRunFinished(stale.runs, 'web:alpha', 'run-new');
    expect(current.applied).toBe(true);
    expect(current.runs['web:alpha']).toBeUndefined();
  });

  test('main terminal never clears a concurrent conversation Agent run', () => {
    let runs = applyRunStarted({}, run('web:alpha', 'run-main'));
    runs = applyRunStarted(runs, run('web:alpha#agent:agent-1', 'run-agent'));

    const finished = applyRunFinished(runs, 'web:alpha', 'run-main');
    expect(finished.runs['web:alpha']).toBeUndefined();
    expect(finished.runs['web:alpha#agent:agent-1']?.runId).toBe('run-agent');
  });

  test('an authoritative reconnect snapshot removes absent stale runs', () => {
    const restored = runsFromAuthoritativeSnapshot([
      run('web:alpha#agent:agent-1', 'run-agent'),
    ]);
    expect(Object.keys(restored)).toEqual(['web:alpha#agent:agent-1']);

    expect(runsFromAuthoritativeSnapshot([])).toEqual({});
  });

  test('A-late payload is rejected while B is active', () => {
    const runs = applyRunStarted({}, run('web:alpha', 'run-b'));

    expect(shouldApplyRunScopedPayload(runs, 'web:alpha', 'run-a')).toBe(false);
    expect(shouldApplyRunScopedPayload(runs, 'web:alpha', 'run-b')).toBe(true);
    expect(shouldApplyRunScopedPayload(runs, 'web:alpha')).toBe(false);
  });

  test('retry/backoff entries without an exact run never restore waiting', () => {
    const restored = runsFromAuthoritativeSnapshot([
      {
        ...run('web:alpha', 'unused'),
        runId: null,
      } as unknown as ReturnType<typeof run>,
    ]);

    expect(restored).toEqual({});
  });

  test('warm proactive history cannot restore waiting without an exact query', () => {
    const warmIdleStatus = {
      active: true,
      pendingMessages: false,
      queryInFlight: false,
      queryId: null,
    };
    const latestMessage = {
      source_kind: 'sdk_send_message',
      is_from_me: true,
    };

    expect(latestMessage.source_kind).toBe('sdk_send_message');
    expect(hasExactQueryAttempt(warmIdleStatus)).toBe(false);
    expect(
      hasExactQueryAttempt({
        ...warmIdleStatus,
        queryInFlight: true,
        queryId: 'run-exact',
      }),
    ).toBe(true);
  });
});

describe('queued-message wait state', () => {
  test('a queued session chat restores waiting without ever entering activeRuns', () => {
    // The server cannot give a queued message a runId — it has no attempt yet,
    // so no run_finished would ever arrive to clear it. It travels outside
    // `runs` for exactly that reason, but must still surface as waiting or a
    // reload mid-queue shows an idle composer and invites a duplicate send.
    const restored = runsFromAuthoritativeSnapshot([]);
    const keys = waitKeysForQueuedChats(['web:alpha#agent:agent-1']);

    expect(restored).toEqual({});
    expect(keys).toEqual(['agent-1']);
  });

  test('a workspace JID names no conversation to wait in', () => {
    expect(
      waitKeysForQueuedChats(['web:alpha#agent:agent-1', 'web:beta']),
    ).toEqual(['agent-1']);
  });

  test('an empty queue clears nothing and adds nothing', () => {
    expect(waitKeysForQueuedChats([])).toEqual([]);
  });
});
