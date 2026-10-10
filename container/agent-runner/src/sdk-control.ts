export class SdkControlTimeoutError extends Error {
  constructor(
    readonly operation: string,
    readonly timeoutMs: number,
  ) {
    super(`${operation} timed out after ${timeoutMs}ms`);
    this.name = 'SdkControlTimeoutError';
  }
}

/**
 * SDK control requests are diagnostic helpers, not part of the model stream.
 * They must never block consumption of assistant/rate-limit/result messages.
 */
export async function runSdkControlWithTimeout<T>(
  operation: string,
  request: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(request),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new SdkControlTimeoutError(operation, timeoutMs)),
          timeoutMs,
        );
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const FIRST_RESPONSE_MESSAGE_TYPES = new Set([
  'assistant',
  'result',
  'stream_event',
]);

export type SdkFirstResponseWatchdogPhase = 'first_response' | 'compaction';

/**
 * Last-resort guard for third-party CLI/provider combinations that persist an
 * API error to the transcript but never forward it through the SDK iterator.
 */
export class SdkFirstResponseWatchdog {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private activePhase: SdkFirstResponseWatchdogPhase | undefined;
  private timedOut = false;
  private compactionTimeoutMs = 0;

  constructor(
    readonly timeoutMs: number,
    private readonly onTimeout: (
      phase: SdkFirstResponseWatchdogPhase,
      timeoutMs: number,
    ) => void,
  ) {
    this.arm(timeoutMs, 'first_response');
  }

  observe(messageType: string): void {
    if (!FIRST_RESPONSE_MESSAGE_TYPES.has(messageType)) return;
    this.clear();
  }

  /**
   * Replace the short first-response deadline with one bounded allowance for
   * SDK auto-compaction. Repeated PreCompact callbacks cannot keep extending
   * the deadline indefinitely.
   */
  beginCompaction(timeoutMs: number): void {
    if (this.timedOut || this.activePhase === 'compaction') return;
    this.arm(timeoutMs, 'compaction');
  }

  /**
   * Compaction finished (PostCompact, compact_boundary or a status frame with
   * compact_result). The model call that follows gets the ordinary
   * first-response deadline again instead of the rest of the compaction
   * allowance.
   */
  endCompaction(): void {
    if (this.timedOut || this.activePhase !== 'compaction') return;
    this.arm(this.timeoutMs, 'first_response');
  }

  /**
   * An api_retry frame proves the CLI is alive and backing off. Restart the
   * active deadline after the announced delay, so a long 429/529 backoff is
   * not mistaken for a stalled transport. Retries are bounded by the CLI.
   */
  observeRetry(retryDelayMs: number): void {
    if (this.timedOut || !this.activePhase) return;
    const delay = Number.isFinite(retryDelayMs) ? Math.max(0, retryDelayMs) : 0;
    const phase = this.activePhase;
    this.arm(
      (phase === 'compaction' ? this.compactionTimeoutMs : this.timeoutMs) +
        delay,
      phase,
    );
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.activePhase = undefined;
  }

  private arm(timeoutMs: number, phase: SdkFirstResponseWatchdogPhase): void {
    this.clear();
    if (phase === 'compaction' && this.compactionTimeoutMs === 0) {
      this.compactionTimeoutMs = timeoutMs;
    }
    this.activePhase = phase;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.activePhase = undefined;
      this.timedOut = true;
      this.onTimeout(phase, timeoutMs);
    }, timeoutMs);
  }
}
