/** The usage fields the metrics below read; every field is optional. */
export interface UsageMetricsInput {
  inputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  streamOutputTokens?: number;
  streamMs?: number;
}

function count(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Share of the prompt read from the provider's cache, 0–1: cache reads over
 * all input (uncached, cache reads and cache writes). `null` without input.
 */
export function cacheHitRate(usage: UsageMetricsInput): number | null {
  const read = count(usage.cacheReadInputTokens);
  const total =
    count(usage.inputTokens) + read + count(usage.cacheCreationInputTokens);
  return total > 0 ? read / total : null;
}

/**
 * Generation speed in output tokens per second over the time the streamed
 * calls spent generating; prefill, tool runs and waits are excluded. `null`
 * when no call was timed (older replies, non-streaming providers).
 */
export function generationTokensPerSecond(
  usage: UsageMetricsInput,
): number | null {
  const tokens = count(usage.streamOutputTokens);
  const ms = count(usage.streamMs);
  return tokens > 0 && ms > 0 ? (tokens * 1000) / ms : null;
}

export function formatHitRate(rate: number | null): string {
  return rate === null ? '—' : `${(rate * 100).toFixed(1)}%`;
}

export function formatTokensPerSecond(tps: number): string {
  return `${tps >= 100 ? Math.round(tps) : tps.toFixed(1)} tok/s`;
}
