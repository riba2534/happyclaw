import { describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
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
