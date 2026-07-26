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

/**
 * Last-resort guard for third-party CLI/provider combinations that persist an
 * API error to the transcript but never forward it through the SDK iterator.
 */
export class SdkFirstResponseWatchdog {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private observed = false;

  constructor(
    readonly timeoutMs: number,
    onTimeout: () => void,
  ) {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.observed) return;
      this.observed = true;
      onTimeout();
    }, timeoutMs);
  }

  observe(messageType: string): void {
    if (!FIRST_RESPONSE_MESSAGE_TYPES.has(messageType)) return;
    this.observed = true;
    this.clear();
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
