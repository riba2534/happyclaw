/**
 * Flow control for a byte stream forwarded to one WebSocket (terminal
 * output). The source is paused once the socket's send buffer passes the
 * high-water mark and resumed when it drains below the low-water mark, so a
 * fast producer (`cat` of a large file, a noisy build) can neither grow the
 * server's buffer without bound nor trip the broadcast backpressure valve
 * that would disconnect the client.
 */
export interface StreamFlowControlOptions {
  getBufferedAmount: () => number;
  pause: () => void;
  resume: () => void;
  highWaterBytes?: number;
  lowWaterBytes?: number;
  pollMs?: number;
}

export interface StreamFlowControl {
  /** Call after each send. */
  afterSend(): void;
  readonly paused: boolean;
  dispose(): void;
}

export const TERMINAL_HIGH_WATER_BYTES = 1024 * 1024;
export const TERMINAL_LOW_WATER_BYTES = 128 * 1024;

export function createStreamFlowControl(
  options: StreamFlowControlOptions,
): StreamFlowControl {
  const high = options.highWaterBytes ?? TERMINAL_HIGH_WATER_BYTES;
  const low = options.lowWaterBytes ?? TERMINAL_LOW_WATER_BYTES;
  const pollMs = options.pollMs ?? 50;
  let paused = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  let disposed = false;

  const stopPolling = (): void => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  return {
    afterSend(): void {
      if (disposed || paused) return;
      if (options.getBufferedAmount() <= high) return;
      paused = true;
      options.pause();
      timer = setInterval(() => {
        if (disposed) return stopPolling();
        if (options.getBufferedAmount() > low) return;
        stopPolling();
        paused = false;
        options.resume();
      }, pollMs);
      timer.unref?.();
    },
    get paused(): boolean {
      return paused;
    },
    dispose(): void {
      disposed = true;
      stopPolling();
    },
  };
}

/**
 * Decide whether a client whose send buffer is over the limit should be
 * dropped. A single over-limit observation is not enough: a terminal burst
 * or one large snapshot can exceed it briefly on a healthy link. Only a
 * client that stays over the limit for `graceMs` across at least
 * `minChecks` consecutive observations is considered stalled.
 */
export function createBackpressureTracker(
  options: { graceMs?: number; minChecks?: number } = {},
) {
  const graceMs = options.graceMs ?? 10_000;
  const minChecks = options.minChecks ?? 3;
  const overSince = new WeakMap<object, { since: number; checks: number }>();
  return {
    /** Record one observation; true when the client should be dropped. */
    observe(client: object, backedUp: boolean, now: number = Date.now()) {
      if (!backedUp) {
        overSince.delete(client);
        return false;
      }
      const state = overSince.get(client);
      if (!state) {
        overSince.set(client, { since: now, checks: 1 });
        return false;
      }
      state.checks += 1;
      return state.checks >= minChecks && now - state.since >= graceMs;
    },
  };
}
