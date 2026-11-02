import { describe, expect, test } from 'vitest';

import {
  BackgroundHandoff,
  commandLifecycleStartedUuid,
} from '../container/agent-runner/src/background-handoff.js';
import {
  IpcTurnDeliveryTracker,
  type IpcInputMessage,
} from '../container/agent-runner/src/ipc-delivery.js';

function input(text: string, queryRunId?: string): IpcInputMessage {
  return { text, ...(queryRunId ? { queryRunId } : {}) };
}

describe('commandLifecycleStartedUuid', () => {
  test('reads the client uuid of a started command', () => {
    expect(
      commandLifecycleStartedUuid({
        type: 'command_lifecycle',
        command_uuid: 'client-b',
        state: 'started',
        uuid: 'frame-uuid',
      }),
    ).toBe('client-b');
  });

  test('falls back to uuid on frames without command_uuid', () => {
    expect(
      commandLifecycleStartedUuid({
        type: 'command_lifecycle',
        uuid: 'client-b',
        state: 'started',
      }),
    ).toBe('client-b');
  });

  test('ignores other states and frame types', () => {
    for (const state of ['queued', 'completed', 'cancelled']) {
      expect(
        commandLifecycleStartedUuid({
          type: 'command_lifecycle',
          command_uuid: 'client-b',
          state,
        }),
      ).toBeUndefined();
    }
    expect(
      commandLifecycleStartedUuid({ type: 'result', uuid: 'x' }),
    ).toBeUndefined();
    expect(commandLifecycleStartedUuid(null)).toBeUndefined();
  });
});

describe('BackgroundHandoff', () => {
  test('hands over only when a later accepted input starts', () => {
    const handoff = new BackgroundHandoff<{ text: string }>();
    const later = new Set(['b']);
    const isLater = (uuid: string) => later.has(uuid);

    expect(handoff.takeForStartedInput(['b'], isLater)).toBeUndefined();

    handoff.hold({ text: 'A answered' });
    expect(handoff.isHolding).toBe(true);
    // The held input itself, or a message the Runner never accepted.
    expect(handoff.takeForStartedInput(['a'], isLater)).toBeUndefined();
    expect(handoff.takeForStartedInput([], isLater)).toBeUndefined();
    expect(handoff.isHolding).toBe(true);

    expect(handoff.takeForStartedInput(['a', 'b'], isLater)).toEqual({
      text: 'A answered',
    });
    expect(handoff.isHolding).toBe(false);
    // Settled once only.
    expect(handoff.takeForStartedInput(['b'], isLater)).toBeUndefined();
  });

  test('a newer hold replaces the older candidate; release drops it', () => {
    const handoff = new BackgroundHandoff<string>();
    handoff.hold('first');
    handoff.hold('after a notification turn');
    expect(handoff.takeForStartedInput(['b'], () => true)).toBe(
      'after a notification turn',
    );

    handoff.hold('held');
    handoff.release();
    expect(handoff.takeForStartedInput(['b'], () => true)).toBeUndefined();
  });
});

describe('IpcTurnDeliveryTracker background hand-off helpers', () => {
  test('recognizes sdk uuids of later turns only', () => {
    const a = input('A');
    const tracker = new IpcTurnDeliveryTracker([a]);
    tracker.bindSdkMessageUuid([a], 'uuid-a');
    const b = input('B');
    tracker.acceptTurn([b]);
    tracker.bindSdkMessageUuid([b], 'uuid-b');

    expect(tracker.isLaterTurnSdkUuid('uuid-a')).toBe(false);
    expect(tracker.isLaterTurnSdkUuid('uuid-b')).toBe(true);
    expect(tracker.isLaterTurnSdkUuid('unknown')).toBe(false);

    tracker.completeNextTurn();
    // B now owns output; it is no longer "later".
    expect(tracker.isLaterTurnSdkUuid('uuid-b')).toBe(false);
  });

  test('matches host query runs of every unfinished turn', () => {
    const tracker = new IpcTurnDeliveryTracker([input('A', 'run-a')]);
    tracker.acceptTurn([input('B', 'run-b')]);

    expect(tracker.hasTurnFromQueryRun('run-a')).toBe(true);
    expect(tracker.hasTurnFromQueryRun('run-b')).toBe(true);
    expect(tracker.hasTurnFromQueryRun('run-c')).toBe(false);

    tracker.completeNextTurn();
    expect(tracker.hasTurnFromQueryRun('run-a')).toBe(false);
    expect(tracker.hasTurnFromQueryRun('run-b')).toBe(true);
  });
});
