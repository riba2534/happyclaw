import { describe, expect, test } from 'vitest';

import { RunStreamFence } from '../src/run-stream-fence.js';

describe('RunStreamFence', () => {
  test('rejects a late event from A while replacement B is active', () => {
    const fence = new RunStreamFence();
    const jid = 'web:alpha';

    fence.start(jid, 'run-a');
    expect(fence.observe(jid, 'turn-a')).toEqual({
      accepted: true,
      runId: 'run-a',
    });
    expect(fence.finish(jid, 'run-a')).toBe(true);

    fence.start(jid, 'run-b');
    expect(fence.observe(jid, 'turn-a')).toEqual({
      accepted: false,
      runId: 'run-a',
    });
    expect(fence.observe(jid, 'turn-b')).toEqual({
      accepted: true,
      runId: 'run-b',
    });
  });

  test('a stale finish cannot close or relabel the replacement', () => {
    const fence = new RunStreamFence();
    const jid = 'web:alpha';

    fence.start(jid, 'run-a');
    fence.observe(jid, 'turn-a');
    fence.start(jid, 'run-b');

    expect(fence.finish(jid, 'run-a')).toBe(false);
    expect(fence.observe(jid, 'turn-b')).toEqual({
      accepted: true,
      runId: 'run-b',
    });
    expect(fence.observe(jid, 'turn-a')).toEqual({
      accepted: false,
      runId: 'run-a',
    });
  });

  test('rejects known late events after their exact run finishes', () => {
    const fence = new RunStreamFence();
    const jid = 'web:alpha#agent:agent-1';

    fence.start(jid, 'run-a');
    fence.observe(jid, 'turn-a');
    fence.finish(jid, 'run-a');

    expect(fence.observe(jid, 'turn-a')).toEqual({
      accepted: false,
      runId: 'run-a',
    });
  });

  test('fails closed for uncorrelated events while an exact run is active', () => {
    const fence = new RunStreamFence();
    const jid = 'web:alpha';

    expect(fence.observe(jid)).toEqual({ accepted: true });

    fence.start(jid, 'run-b');
    expect(fence.observe(jid)).toEqual({
      accepted: false,
      runId: 'run-b',
    });
  });

  test('accepts retry B reusing A turnId while rejecting exact A-late', () => {
    const fence = new RunStreamFence();
    const jid = 'web:retry';
    const reusedTurnId = 'durable-message-1';

    fence.start(jid, 'run-a');
    expect(fence.observeExact(jid, 'run-a', reusedTurnId).accepted).toBe(true);
    fence.finish(jid, 'run-a');

    fence.start(jid, 'run-b');
    expect(fence.observeExact(jid, 'run-b', reusedTurnId)).toEqual({
      accepted: true,
      runId: 'run-b',
    });
    expect(fence.observeExact(jid, 'run-a', reusedTurnId)).toEqual({
      accepted: false,
      runId: 'run-a',
    });
  });
});
