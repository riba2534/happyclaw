import { describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BackgroundHoldKeepalive,
  backgroundHoldKeepaliveIntervalMs,
  BackgroundProtocolDebtWatchdog,
  BackgroundTaskDrainTracker,
  DurableInputTurnCompletion,
  QuiescentResultGate,
  shouldFailIncompleteQueryExit,
} from '../src/background-task-drain.js';
import { StreamEventProcessor } from '../src/stream-processor.js';

describe('BackgroundTaskDrainTracker', () => {
  test('an old result after task_notification cannot complete before notification-driven activity', () => {
    const tracker = new BackgroundTaskDrainTracker();
    tracker.taskStarted('agent-a');
    tracker.taskNotification('agent-a');

    expect(tracker.completionDebtCount).toBe(1);
    expect(tracker.resultObserved()).toBe(false);
    expect(tracker.completionDebtCount).toBe(1);

    tracker.notificationActivityObserved('agent-a');
    expect(tracker.resultObserved()).toBe(true);
    expect(tracker.completionDebtCount).toBe(0);
  });

  test('level disappearance and notification edge may arrive in either order', () => {
    const levelFirst = new BackgroundTaskDrainTracker();
    levelFirst.replaceBackgroundTasks(['agent-a']);
    levelFirst.replaceBackgroundTasks([]);
    levelFirst.taskNotification('agent-a');
    levelFirst.notificationActivityObserved();
    expect(levelFirst.resultObserved()).toBe(true);

    const edgeFirst = new BackgroundTaskDrainTracker();
    edgeFirst.replaceBackgroundTasks(['agent-a']);
    edgeFirst.taskNotification('agent-a');
    edgeFirst.notificationActivityObserved('agent-a');
    expect(edgeFirst.resultObserved()).toBe(false);
    expect(edgeFirst.pendingBlockingCount).toBe(1);
    expect(edgeFirst.replaceBackgroundTasks([])).toBe(true);
  });

  test('one notification-driven result can repay a merged multi-task completion turn', () => {
    const tracker = new BackgroundTaskDrainTracker();
    tracker.replaceBackgroundTasks(['agent-a', 'agent-b']);
    tracker.replaceBackgroundTasks([]);
    tracker.taskNotification('agent-a');
    tracker.taskNotification('agent-b');

    tracker.notificationActivityObserved();
    expect(tracker.resultObserved()).toBe(true);
    expect(tracker.completionDebtCount).toBe(0);
  });

  test('an activity snapshot cannot repay a task which completed afterwards', () => {
    const tracker = new BackgroundTaskDrainTracker();
    tracker.replaceBackgroundTasks(['agent-a', 'agent-b']);
    tracker.taskNotification('agent-a');
    tracker.notificationActivityObserved('agent-a');
    tracker.taskNotification('agent-b');

    expect(tracker.resultObserved()).toBe(false);
    expect(tracker.completionDebtCount).toBe(1);
    tracker.notificationActivityObserved('agent-b');
    expect(tracker.resultObserved()).toBe(false);
    tracker.replaceBackgroundTasks([]);
    expect(tracker.canCompleteObservedResult()).toBe(true);
  });

  test('detached nonblocking work is excluded from debt and completion gating', () => {
    const tracker = new BackgroundTaskDrainTracker();
    tracker.taskStarted('dev-server');
    tracker.markNonBlocking('dev-server');
    tracker.replaceBackgroundTasks(['dev-server']);
    tracker.taskNotification('dev-server');

    expect(tracker.pendingBlockingCount).toBe(0);
    expect(tracker.completionDebtCount).toBe(0);
    expect(tracker.requiresQuiescence).toBe(false);
    expect(tracker.resultObserved()).toBe(true);
  });

  test('first level does not mistake a foreground task_started edge for vanished background work', () => {
    const tracker = new BackgroundTaskDrainTracker();
    tracker.taskStarted('foreground-task');
    tracker.replaceBackgroundTasks([]);
    tracker.taskTerminal('foreground-task');

    expect(tracker.completionDebtCount).toBe(0);
    expect(tracker.resultObserved()).toBe(true);
  });

  test('an unclassified terminal result waits for late background identity', () => {
    vi.useFakeTimers();
    try {
      const tracker = new BackgroundTaskDrainTracker();
      const gate = new QuiescentResultGate(100);
      const completed = vi.fn();

      tracker.taskStarted('agent-late');
      tracker.taskTerminal('agent-late');
      expect(tracker.resultObserved()).toBe(true);
      expect(tracker.requiresQuiescence).toBe(true);

      gate.schedule(completed);
      vi.advanceTimersByTime(50);
      gate.activityObserved();
      tracker.taskNotification('agent-late');
      expect(tracker.completionDebtCount).toBe(1);
      vi.advanceTimersByTime(100);
      expect(completed).not.toHaveBeenCalled();

      tracker.notificationActivityObserved('agent-late');
      expect(tracker.resultObserved()).toBe(true);
      gate.schedule(() => {
        tracker.commitObservedResult();
        completed();
      });
      vi.advanceTimersByTime(100);
      expect(completed).toHaveBeenCalledTimes(1);
      expect(tracker.requiresQuiescence).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a transcript-only notification repays debt without an assistant query', () => {
    const tracker = new BackgroundTaskDrainTracker();
    tracker.taskStarted('agent-no-query');
    tracker.taskTerminal('agent-no-query');
    expect(tracker.resultObserved()).toBe(true);

    tracker.taskNotification('agent-no-query');
    expect(tracker.completionDebtCount).toBe(1);
    tracker.notificationWillNotQuery();

    expect(tracker.completionDebtCount).toBe(0);
    expect(tracker.canCompleteObservedResult()).toBe(true);
  });
});

describe('QuiescentResultGate', () => {
  test('new SDK activity cancels an early drain-ready result', () => {
    vi.useFakeTimers();
    try {
      const gate = new QuiescentResultGate(100);
      const completed = vi.fn();

      gate.schedule(completed);
      vi.advanceTimersByTime(50);
      gate.activityObserved();
      vi.advanceTimersByTime(100);
      expect(completed).not.toHaveBeenCalled();

      gate.schedule(completed);
      vi.advanceTimersByTime(100);
      expect(completed).toHaveBeenCalledTimes(1);
      gate.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('BackgroundProtocolDebtWatchdog', () => {
  test('uses a hard first-withheld deadline which later frames cannot extend', () => {
    const watchdog = new BackgroundProtocolDebtWatchdog();
    expect(watchdog.arm(1_000)).toBe(1_000);
    expect(watchdog.arm(9_000)).toBe(1_000);
    expect(watchdog.remainingMs(10_000, 9_000)).toBe(2_000);
    expect(watchdog.isExpired(10_000, 10_999)).toBe(false);
    expect(watchdog.isExpired(10_000, 11_000)).toBe(true);
  });

  test('clearing a repaid debt permits a fresh later deadline', () => {
    const watchdog = new BackgroundProtocolDebtWatchdog();
    watchdog.arm(1_000);
    watchdog.clear();
    expect(watchdog.isArmed).toBe(false);
    expect(watchdog.arm(20_000)).toBe(20_000);
    expect(watchdog.isExpired(10_000, 25_000)).toBe(false);
  });
});

describe('durable input terminal recovery', () => {
  test('withheld result followed by an SDK throw is not a completed terminal', () => {
    const completion = new DurableInputTurnCompletion();
    completion.publishResult(false, true);

    expect(completion.isCompleted).toBe(false);
  });

  test('withheld result followed by clean EOF must recover instead of waiting for new IPC', () => {
    expect(
      shouldFailIncompleteQueryExit({
        emitOutput: true,
        closedDuringQuery: false,
        interruptedDuringQuery: false,
        hasPendingTurns: true,
        durableInputTurnCompleted: false,
      }),
    ).toBe(true);
  });

  test('A completion does not make newly admitted B durable', () => {
    const completion = new DurableInputTurnCompletion();
    completion.publishResult(true, false);
    expect(completion.isCompleted).toBe(true);

    completion.activateInput();
    expect(completion.isCompleted).toBe(false);
    expect(
      shouldFailIncompleteQueryExit({
        emitOutput: true,
        closedDuringQuery: false,
        interruptedDuringQuery: false,
        hasPendingTurns: true,
        durableInputTurnCompleted: completion.isCompleted,
      }),
    ).toBe(true);
  });

  test('explicit close and interrupt retain their dedicated terminal paths', () => {
    for (const state of [
      { closedDuringQuery: true, interruptedDuringQuery: false },
      { closedDuringQuery: false, interruptedDuringQuery: true },
    ]) {
      expect(
        shouldFailIncompleteQueryExit({
          emitOutput: true,
          ...state,
          hasPendingTurns: true,
          durableInputTurnCompleted: false,
        }),
      ).toBe(false);
    }
  });
});

describe('StreamEventProcessor background protocol integration', () => {
  test('replace-level disappearance contributes completion debt after live count reaches zero', () => {
    const processor = new StreamEventProcessor(
      () => {},
      () => {},
    );
    processor.processSystemMessage({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [
        {
          task_id: 'agent-a',
          task_type: 'local_agent',
          description: 'review',
        },
      ],
    });
    expect(processor.getBlockingBackgroundProtocolCount()).toBe(1);

    processor.processSystemMessage({
      type: 'system',
      subtype: 'background_tasks_changed',
      tasks: [],
    });
    expect(processor.getPendingSdkTaskCount()).toBe(0);
    expect(processor.getBlockingBackgroundCompletionDebtCount()).toBe(1);
    expect(processor.observeBackgroundResult()).toBe(false);

    processor.observeBackgroundNotificationActivity();
    expect(processor.observeBackgroundResult()).toBe(true);
  });

  test('detached local bash remains visible but does not block input completion', () => {
    const processor = new StreamEventProcessor(
      () => {},
      () => {},
    );
    processor.processSystemMessage({
      type: 'system',
      subtype: 'task_started',
      task_id: 'bash-a',
      task_type: 'local_bash',
      description: 'npm run dev',
    });
    processor.processSystemMessage({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'bash-a',
      patch: { status: 'running', is_backgrounded: true },
    });

    expect(processor.getPendingSdkTaskCount()).toBe(1);
    expect(processor.getBlockingBackgroundProtocolCount()).toBe(0);
    expect(processor.requiresBackgroundResultQuiescence()).toBe(false);
  });

  test('runner post-result hold uses the blocking count, not visible detached tasks', () => {
    const testDir = path.dirname(fileURLToPath(import.meta.url));
    const source = fs.readFileSync(
      path.join(testDir, '../src/index.ts'),
      'utf8',
    );
    expect(source).toMatch(
      /const pendingBgTasks = emitOutput\s*\?\s*processor\.getBlockingPendingSdkTaskCount\(\)/,
    );
  });

  test('runner recovery is gated by durable completion rather than observed result count', () => {
    const testDir = path.dirname(fileURLToPath(import.meta.url));
    const source = fs.readFileSync(
      path.join(testDir, '../src/index.ts'),
      'utf8',
    );
    const recovery = source.slice(
      source.indexOf('// SDK 在 durable result 后可能再抛异常'),
      source.indexOf('// 其他错误：记录完整堆栈后继续抛出'),
    );
    expect(recovery).toContain('if (durableInputCompletion.isCompleted)');
    expect(recovery).not.toContain('if (resultCount > 0)');
    expect(source).toMatch(
      /const becomesCurrentTurn[\s\S]*if \(becomesCurrentTurn\) \{\s*durableInputCompletion\.activateInput\(\)/,
    );
    expect(source.indexOf('shouldFailIncompleteQueryExit({')).toBeLessThan(
      source.indexOf('// Cleanup residual state'),
    );
  });

  test('is_backgrounded classifies a terminal Agent before a late level signal', () => {
    const processor = new StreamEventProcessor(
      () => {},
      () => {},
    );
    processor.processSystemMessage({
      type: 'system',
      subtype: 'task_started',
      task_id: 'agent-backgrounded',
      task_type: 'local_agent',
      description: 'review',
    });
    processor.processSystemMessage({
      type: 'system',
      subtype: 'task_updated',
      task_id: 'agent-backgrounded',
      patch: { status: 'completed', is_backgrounded: true },
    });

    expect(processor.getPendingSdkTaskCount()).toBe(0);
    expect(processor.getBlockingBackgroundCompletionDebtCount()).toBe(1);
    expect(processor.observeBackgroundResult()).toBe(false);
  });
});

describe('BackgroundHoldKeepalive', () => {
  const MINUTE = 60_000;

  function keepalive(options: { pending?: () => number; maxMs?: number } = {}) {
    let ticks = 0;
    const keeper = new BackgroundHoldKeepalive({
      intervalMs: MINUTE,
      maxMs: options.maxMs ?? 10 * MINUTE,
      pendingCount: options.pending ?? (() => 1),
      onTick: () => ticks++,
    });
    return { keeper, ticks: () => ticks };
  }

  function withFakeTimers(run: () => void): void {
    vi.useFakeTimers();
    try {
      run();
    } finally {
      vi.useRealTimers();
    }
  }

  test('ticks while a result is held and the work is live', () => {
    withFakeTimers(() => {
      const run = keepalive();
      run.keeper.hold();
      run.keeper.hold();
      vi.advanceTimersByTime(3 * MINUTE);
      expect(run.ticks()).toBe(3);

      run.keeper.release();
      vi.advanceTimersByTime(3 * MINUTE);
      expect(run.ticks()).toBe(3);
      expect(run.keeper.running).toBe(false);
    });
  });

  test('stops at the bound, and later held results of the hold do not restart it', () => {
    withFakeTimers(() => {
      const run = keepalive({ maxMs: 5 * MINUTE });
      run.keeper.hold();
      vi.advanceTimersByTime(4 * MINUTE);
      // An answer to input injected meanwhile is a held result too.
      run.keeper.hold();
      vi.advanceTimersByTime(10 * MINUTE);
      expect(run.ticks()).toBe(4);
      expect(run.keeper.running).toBe(false);

      run.keeper.hold();
      vi.advanceTimersByTime(10 * MINUTE);
      expect(run.ticks()).toBe(4);
    });
  });

  test('a hold that ends and comes back counts from its own start', () => {
    withFakeTimers(() => {
      const run = keepalive({ maxMs: 5 * MINUTE });
      run.keeper.hold();
      vi.advanceTimersByTime(4 * MINUTE);
      // A result that holds nothing ends the hold.
      run.keeper.release();
      run.keeper.hold();
      vi.advanceTimersByTime(10 * MINUTE);
      expect(run.ticks()).toBe(4 + 4);
    });
  });

  test('ticks pause once no work is live, without ending the hold', () => {
    withFakeTimers(() => {
      let pending = 1;
      const run = keepalive({ pending: () => pending, maxMs: 5 * MINUTE });
      run.keeper.hold();
      vi.advanceTimersByTime(2 * MINUTE);
      pending = 0;
      vi.advanceTimersByTime(MINUTE);
      expect(run.keeper.running).toBe(false);

      // New work before any result reports the hold over: still the same
      // hold, with the bound counted from its first result.
      pending = 1;
      run.keeper.hold();
      vi.advanceTimersByTime(10 * MINUTE);
      expect(run.ticks()).toBe(2 + 1);
    });
  });

  test('an older host, which sent no idle close, gets no keepalive', () => {
    withFakeTimers(() => {
      let ticks = 0;
      const keeper = new BackgroundHoldKeepalive({
        intervalMs: backgroundHoldKeepaliveIntervalMs(undefined),
        maxMs: 10 * MINUTE,
        pendingCount: () => 1,
        onTick: () => ticks++,
      });
      keeper.hold();
      vi.advanceTimersByTime(10 * MINUTE);
      expect(ticks).toBe(0);
      expect(keeper.running).toBe(false);
    });
  });

  test("the interval is a third of the host's idle close, at most five minutes", () => {
    // The 30-minute default, and the 60-second minimum of the settings.
    expect(backgroundHoldKeepaliveIntervalMs(30 * MINUTE)).toBe(5 * MINUTE);
    expect(backgroundHoldKeepaliveIntervalMs(9 * MINUTE)).toBe(3 * MINUTE);
    expect(backgroundHoldKeepaliveIntervalMs(MINUTE)).toBe(20_000);
    expect(backgroundHoldKeepaliveIntervalMs(undefined)).toBeNull();
    expect(backgroundHoldKeepaliveIntervalMs(0)).toBeNull();
  });
});
