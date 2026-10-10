/**
 * Delivery policy shared by Feishu card transports: how a provider failure is
 * read across wrapper errors, how long a rate limit may be waited out inside
 * one operation, how message-create requests are made idempotent, and how a
 * definitively rejected card body is reduced to a neutral, still-complete
 * rendering before giving up on the card.
 */
import { createHash } from 'crypto';

import {
  classifyFeishuError,
  neutralizeFeishuMentions,
  type FeishuErrorClass,
} from './feishu-errors.js';
import { findMarkdownBlocks } from './feishu-cards/pagination.js';

/**
 * Classify the first concrete Feishu failure in an error's cause chain.
 * Wrappers (delivery-phase errors, capability errors) carry no provider code
 * themselves; the Feishu response that explains them sits in `cause`.
 */
export function classifyFeishuCardError(error: unknown): FeishuErrorClass {
  let current: unknown = error;
  const seen = new Set<unknown>();
  let fallback: FeishuErrorClass | undefined;
  for (
    let depth = 0;
    current && typeof current === 'object' && !seen.has(current) && depth < 8;
    depth++
  ) {
    seen.add(current);
    const classified = classifyFeishuError(current);
    if (classified.kind !== 'transient') return classified;
    fallback ??= classified;
    current = (current as { cause?: unknown }).cause;
  }
  return fallback ?? classifyFeishuError(error);
}

/**
 * Rate limits and unreachable targets are properties of the chat or the app,
 * not of the card format: switching CardKit → v1 → legacy or interactive →
 * post only multiplies requests against the same limit (or the same deleted
 * anchor). Such failures must never trigger backend or format fallbacks.
 */
export function blocksFeishuCardFallback(error: unknown): boolean {
  const kind = classifyFeishuCardError(error).kind;
  return kind === 'rate_limited' || kind === 'target_unavailable';
}

/** Retry-After values beyond this are not waited out inside one operation. */
const MAX_IN_OPERATION_RETRY_AFTER_MS = 10_000;
export const FEISHU_RATE_LIMIT_MAX_RETRIES = 3;

/**
 * Delay before retrying a rate-limited request, or undefined when the error
 * is not a rate limit (or asks for a longer wait than one operation may hold).
 * Feishu's per-chat limit (230020) uses a one-second window.
 */
export function feishuRateLimitRetryDelayMs(
  error: unknown,
  attempt: number,
): number | undefined {
  const classified = classifyFeishuCardError(error);
  if (classified.kind !== 'rate_limited') return undefined;
  if (classified.retryAfterMs !== undefined) {
    return classified.retryAfterMs > MAX_IN_OPERATION_RETRY_AFTER_MS
      ? undefined
      : Math.max(0, classified.retryAfterMs);
  }
  const base = classified.code === 230020 ? 1_000 : 250;
  return base * 2 ** Math.max(0, attempt);
}

const defaultSleep = (delayMs: number) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, delayMs);
    timer.unref?.();
  });

/**
 * Bounded backoff for explicit rate-limit rejections. The platform did not
 * accept the request, so resending the identical request (same uuid/sequence)
 * is safe; any other failure is rethrown unchanged.
 */
export async function withFeishuRateLimitRetry<T>(
  operation: () => Promise<T>,
  options: {
    maxRetries?: number;
    sleep?: (delayMs: number) => Promise<void>;
  } = {},
): Promise<T> {
  const maxRetries = options.maxRetries ?? FEISHU_RATE_LIMIT_MAX_RETRIES;
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 0; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const delayMs =
        attempt < maxRetries
          ? feishuRateLimitRetryDelayMs(error, attempt)
          : undefined;
      if (delayMs === undefined) throw error;
      await sleep(delayMs);
    }
  }
}

/**
 * Feishu `uuid` for im.message.create/reply: at most one message per uuid is
 * sent within one hour, so an ambiguous create can be replayed safely. The
 * seed must be stable for one logical message and must change whenever the
 * message content changes (Feishu requires a new uuid for new content).
 */
export function feishuMessageUuid(seed: string): string {
  return `hc${createHash('sha256').update(seed).digest('hex').slice(0, 40)}`;
}

const IMAGE_SYNTAX =
  /!\[([^\]\n]*)\]\((?:<[^>\n]*>|(?:[^()\s]|\([^()\s]*\))*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?\s*\)/g;

/** Outside inline code: drop images (keep alt text) and every HTML-like tag. */
function neutralizeProse(line: string): string {
  return line
    .split(/(`+[^`]*`+)/)
    .map((part, index) =>
      index % 2 === 1
        ? part
        : part
            .replace(IMAGE_SYNTAX, (_match, alt: string) => alt.trim())
            .replace(/</g, '&#60;'),
    )
    .join('');
}

/**
 * A neutral rendering of a card body Feishu explicitly refused: every
 * `<at>`/HTML-like tag escaped, every image removed (alt text kept) and every
 * GFM table shown as preformatted text. No source text is dropped, so the
 * card remains a complete answer when this version is accepted.
 */
export function neutralizeRejectedCardMarkdown(text: string): string {
  const blocks = findMarkdownBlocks(text);
  let out = '';
  let cursor = 0;
  const prose = (segment: string) =>
    segment.split('\n').map(neutralizeProse).join('\n');
  for (const block of blocks) {
    out += prose(text.slice(cursor, block.start));
    const source = text.slice(block.start, Math.min(block.end, text.length));
    if (block.kind === 'fence') {
      out += source;
    } else {
      const body = source.endsWith('\n') ? source : `${source}\n`;
      out += `\`\`\`text\n${body}\`\`\`\n`;
    }
    cursor = Math.min(block.end, text.length);
  }
  out += prose(text.slice(cursor));
  return neutralizeFeishuMentions(out, 'card');
}
