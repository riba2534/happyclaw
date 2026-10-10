/**
 * Pure helpers for QQ WebSocket reconnect strategy.
 *
 * Extracted to a separate module so they can be unit-tested without
 * spinning up a real WebSocket. The factory in `qq.ts` composes these
 * with closure-held state (attempt counter, keepalive mode, etc.).
 */

// Transient network errors that shouldn't burn our reconnect budget.
// Source: openclaw-qqbot/src/image-server.ts (same canonical list).
const TRANSIENT_ERROR_CODES: ReadonlySet<string> = new Set([
  'EAI_AGAIN',
  'ENOTFOUND',
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'UND_ERR_CONNECT_TIMEOUT',
]);

// Network-level failures that carry no errno: the ws client's opening
// handshake timeout (`handshakeTimeout`) is a plain Error with this message.
const TRANSIENT_ERROR_MESSAGES: readonly string[] = [
  'Opening handshake has timed out',
];

export function isTransientError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;

  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && TRANSIENT_ERROR_CODES.has(code)) {
    return true;
  }

  // Some libraries wrap the underlying errno into the message string only
  // (e.g. `getaddrinfo EAI_AGAIN api.sgroup.qq.com`).
  const msg = (err as { message?: unknown }).message;
  if (typeof msg === 'string') {
    for (const transientCode of TRANSIENT_ERROR_CODES) {
      if (msg.includes(transientCode)) return true;
    }
    for (const transientMessage of TRANSIENT_ERROR_MESSAGES) {
      if (msg.includes(transientMessage)) return true;
    }
  }

  return false;
}

export const RECONNECT_DELAYS: readonly number[] = [
  1_000, 2_000, 5_000, 10_000, 30_000, 60_000,
];

export function getReconnectDelay(
  attempt: number,
  delays: readonly number[] = RECONNECT_DELAYS,
): number {
  const idx = Math.min(Math.max(attempt, 0), delays.length - 1);
  return delays[idx]!;
}

/**
 * Spread reconnects of many accounts (or many workspaces after one network
 * blip) by up to ±20% so they do not hit the gateway in lockstep.
 */
export function withReconnectJitter(
  delayMs: number,
  random: () => number = Math.random,
): number {
  return Math.max(0, Math.round(delayMs * (0.8 + 0.4 * random())));
}

export type CloseCodeAction =
  | { kind: 'normal' }
  | { kind: 'refresh-token' }
  | { kind: 'rate-limit' }
  | { kind: 'reset-session' }
  | { kind: 'intents-rejected' };

/**
 * Map a WebSocket close code to a reconnect strategy.
 *
 * - 4004: invalid token → drop cached token, IDENTIFY fresh
 * - 4008: rate limited → wait `RATE_LIMIT_DELAY_MS` before retry
 * - 4900-4913: server internal error → drop session, IDENTIFY fresh
 * - 4914/4915: the gateway refused the requested intents → reconnecting with
 *   the same IDENTIFY can only fail the same way, so the caller has to drop
 *   an optional intent before retrying
 * - anything else: normal reconnect (RESUME if session is still valid)
 */
export function classifyCloseCode(
  code: number | undefined | null,
): CloseCodeAction {
  if (code === 4004) return { kind: 'refresh-token' };
  if (code === 4008) return { kind: 'rate-limit' };
  // 4914 INSUFFICIENT_INTENTS / 4915 DISALLOWED_INTENTS. Checked before the
  // 4900-4913 server-error range so the ranges stay disjoint and readable.
  if (code === 4914 || code === 4915) return { kind: 'intents-rejected' };
  if (typeof code === 'number' && code >= 4900 && code <= 4913) {
    return { kind: 'reset-session' };
  }
  return { kind: 'normal' };
}
