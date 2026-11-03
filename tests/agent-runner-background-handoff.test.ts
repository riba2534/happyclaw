import { describe, expect, test, vi } from 'vitest';

import {
  BackgroundHandoff,
  commandLifecycleStartedUuid,
} from '../container/agent-runner/src/background-handoff.js';
import {
  IpcTurnDeliveryTracker,
  type IpcInputMessage,
} from '../container/agent-runner/src/ipc-delivery.js';
import { QuiescentResultGate } from '../container/agent-runner/src/background-task-drain.js';
import { createRuntimeSourceHarness } from './helpers/runtime-source.js';

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

  test('a later turn the host withdrew is dropped and never requeued', () => {
    const receipted = (text: string): IpcInputMessage => ({
      text,
      receipt: {
        deliveryId: `delivery-${text}`,
        chatJid: 'web:ws',
        cursor: { timestamp: '', id: text },
      },
    });
    const [a, b, c] = [receipted('A'), receipted('B'), receipted('C')];
    const tracker = new IpcTurnDeliveryTracker([a]);
    tracker.acceptTurn([b]);
    tracker.acceptTurn([c]);

    expect(tracker.cancelLaterTurns(new Set(['delivery-B']))).toEqual([b]);
    // The current turn is never a later one.
    expect(tracker.cancelLaterTurns(new Set(['delivery-A']))).toEqual([]);

    // What the Runner would put back on disk after the stop.
    expect(tracker.unacknowledgedMessages).toEqual([a, c]);
    expect(tracker.laterTurnMessages).toEqual([c]);
  });
});

describe('a later input starts while the held input waits out its summary', () => {
  const heldReply = { finalText: 'A_ANSWERED', suspectTruncated: false };
  const summary = {
    finalText: 'A_SUMMARY',
    suspectTruncated: false,
    pendingBgTasks: 0,
  };

  function runner(pendingResult: typeof summary | undefined) {
    const backgroundHandoff = new BackgroundHandoff<typeof heldReply>();
    backgroundHandoff.hold(heldReply);
    const publishResultCandidate = vi.fn(
      (_candidate: unknown, _completed: boolean, _mode?: unknown) =>
        backgroundHandoff.release(),
    );
    const commitObservedBackgroundResult = vi.fn();
    const globals: Record<string, any> = {
      backgroundHandoff,
      backgroundResultGate: new QuiescentResultGate(10),
      pendingBackgroundResult: pendingResult,
      publishResultCandidate,
      handedOverQueryRunIds: new Set<string>(),
      containerInput: { queryRunId: 'run-a' },
      ipcDeliveryTracker: {
        isLaterTurnSdkUuid: (uuid: string) => uuid === 'uuid-b',
      },
      processor: {
        canCompleteObservedBackgroundResult: () => true,
        commitObservedBackgroundResult,
        getBlockingPendingSdkTaskCount: () => 1,
      },
      log: () => {},
    };
    const harness = createRuntimeSourceHarness(
      globals,
      new URL('../container/agent-runner/src/index.ts', import.meta.url),
    );
    harness.install('scheduleBackgroundResultCompletion', 'runQueryAttempt');
    harness.install('handOffBackgroundWork', 'runQueryAttempt');
    return { globals, publishResultCandidate, commitObservedBackgroundResult };
  }

  test('its summary completes it at once: no hand-over, nothing for the later input', async () => {
    const r = runner(summary);
    r.globals.scheduleBackgroundResultCompletion();

    r.globals.handOffBackgroundWork(['uuid-b']);

    expect(r.publishResultCandidate).toHaveBeenCalledTimes(1);
    expect(r.publishResultCandidate).toHaveBeenCalledWith(
      { ...summary, pendingBgTasks: 0 },
      true,
    );
    expect(r.commitObservedBackgroundResult).toHaveBeenCalledTimes(1);
    expect(r.globals.pendingBackgroundResult).toBeUndefined();
    // A stop the host aimed at the held query still stops the lane.
    expect(r.globals.handedOverQueryRunIds.has('run-a')).toBe(true);

    // The quiet-period timer cannot publish it a second time as B's answer.
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(r.publishResultCandidate).toHaveBeenCalledTimes(1);
  });

  test('without a summary the held input is handed over without text', () => {
    const r = runner(undefined);

    r.globals.handOffBackgroundWork(['uuid-b']);

    expect(r.publishResultCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ finalText: null, pendingBgTasks: 1 }),
      true,
      { backgroundHandoff: true },
    );
  });

  test("the held input's own start changes nothing", () => {
    const r = runner(summary);

    r.globals.handOffBackgroundWork(['uuid-a']);

    expect(r.publishResultCandidate).not.toHaveBeenCalled();
    expect(r.globals.pendingBackgroundResult).toBe(summary);
  });
});
