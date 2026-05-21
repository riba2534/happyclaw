// Vendored from @larksuiteoapi/node-sdk feature/channel
// Source: channel/safety/stale-detector.ts + types.ts @ 86c6674 (2026-04-18)
// License: MIT
// Reason: feature/channel branch not yet released to npm.

export const DEFAULT_STALE_MS = 30 * 60_000;

/**
 * Returns true when the message is older than `windowMs` (default 30min).
 * Safe against bogus timestamps (0 / NaN / non-finite → false).
 *
 * Used as a global drop-on-arrival fallback for messages that slipped
 * past the per-channel `ignoreMessagesBefore` reconnect filter (e.g.,
 * webhook retried 1h after the original send).
 */
export function isStale(
  createTimeMs: number | undefined | null,
  windowMs: number = DEFAULT_STALE_MS,
): boolean {
  if (createTimeMs == null || !createTimeMs || !Number.isFinite(createTimeMs)) {
    return false;
  }
  return Date.now() - createTimeMs > windowMs;
}
