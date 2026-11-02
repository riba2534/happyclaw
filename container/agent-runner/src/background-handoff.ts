/**
 * Hands background work over from one input to the next.
 *
 * When the main Agent has answered input A and only background tasks keep A
 * open, Claude Code is idle: a user message written to the stream starts a
 * new turn at once while the background tasks keep running, and their
 * completion notifications reach the main Agent afterwards (verified with
 * 2.1.296). The Runner therefore accepts input B instead of letting it wait
 * for every task, and must not stop the query for it: `interrupt()` and
 * `close()` would kill those tasks.
 *
 * A stays the input that owns Runner output until B actually starts in the
 * CLI. Until then any Result is still A's (a notification turn for A may run
 * first). Once B starts, A is settled without new text and B owns the output,
 * including every later notification turn: the background work is now B's to
 * report, and B is held open until it settles.
 */

/**
 * Client uuid of a user message that has just drained into a Claude Code
 * turn: `command_lifecycle` with state `started`. Claude Code 2.1.296 puts the
 * client uuid in `command_uuid`; older frames carried it in `uuid`.
 */
export function commandLifecycleStartedUuid(
  message: unknown,
): string | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const frame = message as {
    type?: unknown;
    state?: unknown;
    command_uuid?: unknown;
    uuid?: unknown;
  };
  if (frame.type !== 'command_lifecycle' || frame.state !== 'started') {
    return undefined;
  }
  if (typeof frame.command_uuid === 'string') return frame.command_uuid;
  return typeof frame.uuid === 'string' ? frame.uuid : undefined;
}

/**
 * The answered-but-background-held input, if any. Holds the data needed to
 * settle it once a later input starts.
 */
export class BackgroundHandoff<T> {
  private held: T | undefined;

  /** The current input was answered; only background tasks keep it open. */
  hold(candidate: T): void {
    this.held = candidate;
  }

  /** The held input completed, was interrupted, or produced a newer Result. */
  release(): void {
    this.held = undefined;
  }

  get isHolding(): boolean {
    return this.held !== undefined;
  }

  /**
   * Take the held input when one of `startedUuids` belongs to an accepted
   * input after it: that input has begun its own turn. A started uuid of the
   * held input itself, or of a message the Runner did not accept, changes
   * nothing.
   */
  takeForStartedInput(
    startedUuids: readonly string[],
    isLaterInput: (sdkUuid: string) => boolean,
  ): T | undefined {
    if (this.held === undefined) return undefined;
    if (!startedUuids.some(isLaterInput)) return undefined;
    const held = this.held;
    this.held = undefined;
    return held;
  }
}
