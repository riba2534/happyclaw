/**
 * Tracks the protocol gap between "a background task is no longer live" and
 * "the main Agent has consumed that completion notification and finished its
 * follow-up turn".
 *
 * The SDK exposes both edge signals (task_started/task_notification) and a
 * replace-semantics background_tasks_changed level. Their relative ordering is
 * deliberately unspecified. A vanished task therefore creates a completion
 * debt; only notification-driven main-Agent activity followed by a result may
 * repay it.
 */
export class BackgroundTaskDrainTracker {
  private readonly pending = new Set<string>();
  private readonly completionDebts = new Set<string>();
  private readonly settledBeforeLevel = new Set<string>();
  private readonly notifiedTasks = new Set<string>();
  private readonly nonBlockingTasks = new Set<string>();
  private readonly knownBackgroundTasks = new Set<string>();
  private readonly quiescenceTaskIds = new Set<string>();
  private readonly notificationActivityTaskIds = new Set<string>();
  /**
   * Terminal edges which have not yet been classified as foreground or
   * background. They do not create durable debt by themselves, but force the
   * observed Result through the quiet-period gate so a late notification/level
   * can still classify the task before the input is committed.
   */
  private readonly provisionalTerminalTasks = new Set<string>();
  private hasLevelSignal = false;
  private notificationTurnActivity = false;
  private observedResult = false;

  taskStarted(taskId: string, blocking = true): void {
    if (!taskId) return;
    if (!blocking) {
      this.markNonBlocking(taskId);
      return;
    }
    if (!this.hasLevelSignal) this.pending.add(taskId);
    this.observedResult = false;
  }

  markNonBlocking(taskId: string): void {
    if (!taskId) return;
    this.nonBlockingTasks.add(taskId);
    this.pending.delete(taskId);
    this.completionDebts.delete(taskId);
    this.settledBeforeLevel.delete(taskId);
    this.notifiedTasks.delete(taskId);
    this.notificationActivityTaskIds.delete(taskId);
    this.quiescenceTaskIds.delete(taskId);
    this.provisionalTerminalTasks.delete(taskId);
  }

  markBackground(taskId: string): void {
    if (!taskId || this.nonBlockingTasks.has(taskId)) return;
    this.knownBackgroundTasks.add(taskId);
    this.quiescenceTaskIds.add(taskId);
    if (this.provisionalTerminalTasks.has(taskId)) {
      this.establishCompletionDebt(taskId);
    }
  }

  /**
   * A terminal task_updated is sufficient to remove a foreground task from
   * the live set. It creates a completion debt only when a level signal has
   * already proven that this was background work.
   */
  taskTerminal(taskId: string): void {
    if (!taskId || this.nonBlockingTasks.has(taskId)) {
      this.pending.delete(taskId);
      return;
    }
    this.pending.delete(taskId);
    if (this.knownBackgroundTasks.has(taskId)) {
      this.establishCompletionDebt(taskId);
    } else {
      this.provisionalTerminalTasks.add(taskId);
      this.quiescenceTaskIds.add(taskId);
    }
  }

  taskNotification(taskId: string): void {
    if (!taskId || this.nonBlockingTasks.has(taskId)) {
      this.pending.delete(taskId);
      return;
    }
    this.quiescenceTaskIds.add(taskId);
    this.knownBackgroundTasks.add(taskId);
    this.provisionalTerminalTasks.delete(taskId);
    if (!this.hasLevelSignal) this.pending.delete(taskId);
    if (!this.settledBeforeLevel.has(taskId)) {
      this.establishCompletionDebt(taskId);
    }
    this.notifiedTasks.add(taskId);
  }

  /**
   * Replace-semantics level update. The first level establishes authority and
   * intentionally does not infer disappearance from earlier task_started
   * edges, because those edges also include foreground Tasks.
   */
  replaceBackgroundTasks(taskIds: readonly string[]): boolean {
    const next = new Set(
      taskIds.filter((taskId) => !this.nonBlockingTasks.has(taskId)),
    );
    for (const taskId of next) {
      this.markBackground(taskId);
    }

    if (!this.hasLevelSignal) {
      this.pending.clear();
      for (const taskId of next) this.pending.add(taskId);
      this.hasLevelSignal = true;
      this.observedResult = false;
      return this.canCompleteObservedResult();
    }

    for (const taskId of this.pending) {
      if (next.has(taskId)) continue;
      if (this.settledBeforeLevel.delete(taskId)) continue;
      this.establishCompletionDebt(taskId);
    }
    this.pending.clear();
    for (const taskId of next) this.pending.add(taskId);
    return this.canCompleteObservedResult();
  }

  /**
   * Records activity belonging to the notification-driven main-Agent turn.
   * An unscoped activity snapshot may repay several task debts with one result.
   */
  notificationActivityObserved(taskId?: string): void {
    if (taskId !== undefined) {
      if (this.notifiedTasks.has(taskId) && this.completionDebts.has(taskId)) {
        this.notificationTurnActivity = true;
        this.notificationActivityTaskIds.add(taskId);
      }
      return;
    }
    if (this.completionDebts.size === 0) return;
    this.notificationTurnActivity = true;
    for (const pendingDebt of this.completionDebts) {
      this.notificationActivityTaskIds.add(pendingDebt);
    }
  }

  /**
   * Consume a result boundary. A result without notification activity cannot
   * repay completion debt, which prevents an older result racing with
   * task_notification from prematurely completing the user input.
   */
  resultObserved(originKind?: string): boolean {
    if (originKind === 'task-notification' || this.notificationTurnActivity) {
      const observed = [...this.notificationActivityTaskIds].filter((taskId) =>
        this.completionDebts.has(taskId),
      );
      const repaid =
        observed.length > 0
          ? observed
          : originKind === 'task-notification'
            ? [
                this.completionDebts.values().next().value as
                  | string
                  | undefined,
              ].filter((taskId): taskId is string => taskId !== undefined)
            : [];
      for (const taskId of repaid) {
        this.completionDebts.delete(taskId);
        this.notifiedTasks.delete(taskId);
        if (this.pending.has(taskId)) this.settledBeforeLevel.add(taskId);
      }
    }
    this.notificationTurnActivity = false;
    this.notificationActivityTaskIds.clear();
    this.observedResult = true;
    return this.canCompleteObservedResult();
  }

  /**
   * Any main-Agent/notification activity after a candidate result invalidates
   * that boundary. A later result must establish a fresh completion candidate.
   */
  invalidateObservedResult(): void {
    this.observedResult = false;
  }

  /**
   * `shouldQuery:false` means the notification is transcript-only: no
   * assistant Result will follow to repay its debt. Accept the already
   * observed boundary and let an authoritative empty level (if one exists)
   * perform the remaining live-set reconciliation.
   */
  notificationWillNotQuery(): void {
    for (const taskId of this.notifiedTasks) {
      this.completionDebts.delete(taskId);
      if (this.pending.has(taskId)) this.settledBeforeLevel.add(taskId);
      this.notificationActivityTaskIds.delete(taskId);
      if (!this.pending.has(taskId)) this.quiescenceTaskIds.delete(taskId);
    }
    this.notifiedTasks.clear();
    this.notificationTurnActivity = false;
    this.observedResult = true;
  }

  /** Forget quiet-period-only classifications after the candidate is sealed. */
  commitObservedResult(): void {
    if (!this.canCompleteObservedResult()) return;
    for (const taskId of [...this.quiescenceTaskIds]) {
      if (
        this.pending.has(taskId) ||
        this.completionDebts.has(taskId) ||
        this.notifiedTasks.has(taskId)
      ) {
        continue;
      }
      this.quiescenceTaskIds.delete(taskId);
      this.provisionalTerminalTasks.delete(taskId);
      this.knownBackgroundTasks.delete(taskId);
      this.settledBeforeLevel.delete(taskId);
    }
  }

  canCompleteObservedResult(): boolean {
    return (
      this.observedResult &&
      this.pending.size === 0 &&
      this.completionDebts.size === 0
    );
  }

  get pendingBlockingCount(): number {
    return this.pending.size;
  }

  get completionDebtCount(): number {
    return this.completionDebts.size;
  }

  get requiresQuiescence(): boolean {
    return this.quiescenceTaskIds.size > 0;
  }

  private establishCompletionDebt(taskId: string): void {
    if (this.nonBlockingTasks.has(taskId)) return;
    this.provisionalTerminalTasks.delete(taskId);
    this.quiescenceTaskIds.add(taskId);
    this.completionDebts.add(taskId);
    this.observedResult = false;
  }
}

/**
 * Delays a drain-ready result for a short quiet period. Every later SDK frame
 * cancels the candidate; callers must schedule again at a newer result (or a
 * late authoritative empty level).
 */
export class QuiescentResultGate {
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly quiescenceMs: number) {}

  schedule(onQuiescent: () => void): void {
    this.activityObserved();
    this.timer = setTimeout(() => {
      this.timer = undefined;
      onQuiescent();
    }, this.quiescenceMs);
  }

  activityObserved(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  dispose(): void {
    this.activityObserved();
  }
}

/**
 * Tracks whether the input currently owning Runner output has crossed a
 * healthy, durable result boundary.
 *
 * A warm query can publish A and then admit B without restarting the SDK
 * stream. The state must return to false as soon as B becomes current; an
 * exception after that point belongs to B and cannot be downgraded merely
 * because A emitted a result earlier.
 */
export class DurableInputTurnCompletion {
  private completed = false;

  activateInput(): void {
    this.completed = false;
  }

  publishResult(inputTurnCompleted: boolean, hasPendingTurns: boolean): void {
    this.completed = inputTurnCompleted && !hasPendingTurns;
  }

  get isCompleted(): boolean {
    return this.completed;
  }
}

export interface IncompleteQueryExitState {
  emitOutput: boolean;
  closedDuringQuery: boolean;
  interruptedDuringQuery: boolean;
  hasPendingTurns: boolean;
  durableInputTurnCompleted: boolean;
}

/**
 * A clean SDK iterator EOF is not a healthy Runner terminal while an accepted
 * input still lacks a durable result. Escalating it lets the host replay from
 * its durable cursor instead of leaving the query warm and silently replacing
 * the unacknowledged input when the next IPC message arrives.
 */
export function shouldFailIncompleteQueryExit(
  state: IncompleteQueryExitState,
): boolean {
  return (
    state.emitOutput &&
    !state.closedDuringQuery &&
    !state.interruptedDuringQuery &&
    state.hasPendingTurns &&
    !state.durableInputTurnCompleted
  );
}
