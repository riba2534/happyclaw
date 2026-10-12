/**
 * Telegram outbound policy without Bot instance state: Markdown → HTML,
 * message-sized chunking, and the bounded retry of sends Telegram refused
 * with 429.
 */
import type { Transformer } from 'grammy';

import { DefinitiveChannelDeliveryError } from './channel-outbox-delivery.js';
import { PartialChannelDeliveryError } from './im-delivery-progress.js';
import { splitMarkdownWithCodeFences } from './markdown-fence-split.js';

/** Bot API cap for the text of one message. */
export const TELEGRAM_MESSAGE_LIMIT = 4096;
/** First-pass source budget; escaping and tags can only add characters. */
const SOURCE_CHUNK_BUDGET = 3500;
const MIN_SOURCE_CHUNK_BUDGET = 256;

export function escapeTelegramHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Convert Markdown to Telegram-compatible HTML.
 * Handles: code blocks, inline code, bold, italic, strikethrough, links, headings.
 */
export function markdownToTelegramHtml(md: string): string {
  // Step 1: Extract code blocks to protect them from further processing
  const codeBlocks: string[] = [];
  let text = md.replace(/```[\s\S]*?```/g, (match) => {
    const code = match.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
    codeBlocks.push(`<pre><code>${escapeTelegramHtml(code)}</code></pre>`);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // Step 2: Extract inline code
  const inlineCodes: string[] = [];
  text = text.replace(/`([^`]+)`/g, (_, code: string) => {
    inlineCodes.push(`<code>${escapeTelegramHtml(code)}</code>`);
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  // Step 3: Escape HTML in remaining text
  text = escapeTelegramHtml(text);

  // Step 4: Convert Markdown formatting
  // Links: [text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  // Bold: **text** or __text__
  text = text.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  text = text.replace(/__(.+?)__/g, '<b>$1</b>');
  // Strikethrough: ~~text~~ (before italic to avoid conflicts)
  text = text.replace(/~~(.+?)~~/g, '<s>$1</s>');
  // Italic: *text* (not preceded/followed by word chars to avoid false matches)
  text = text.replace(/(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, '<i>$1</i>');
  // Headings: # text → bold
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

  // Step 5: Restore code blocks and inline code
  text = text.replace(/\x00CB(\d+)\x00/g, (_, i) => codeBlocks[Number(i)]);
  text = text.replace(/\x00IC(\d+)\x00/g, (_, i) => inlineCodes[Number(i)]);

  return text;
}

export interface TelegramMessageChunk {
  /** Source Markdown, sent as plain text when Telegram rejects the HTML. */
  markdown: string;
  html: string;
}

/**
 * Split Markdown into messages whose rendered HTML and plain fallback both fit
 * one Telegram message. The split happens on the source and is fence-aware
 * (a cut inside ``` closes the fence and reopens it in the next message), so
 * every chunk renders on its own; a chunk that escaping or tags push past the
 * limit is split again with a smaller budget.
 */
export function chunkTelegramMarkdown(
  markdown: string,
): TelegramMessageChunk[] {
  const chunks: TelegramMessageChunk[] = [];
  const place = (source: string, budget: number): void => {
    const html = markdownToTelegramHtml(source);
    if (
      (html.length <= TELEGRAM_MESSAGE_LIMIT &&
        source.length <= TELEGRAM_MESSAGE_LIMIT) ||
      budget <= MIN_SOURCE_CHUNK_BUDGET
    ) {
      chunks.push({ markdown: source, html });
      return;
    }
    const smaller = Math.max(MIN_SOURCE_CHUNK_BUDGET, Math.floor(budget / 2));
    for (const piece of splitMarkdownWithCodeFences(source, smaller)) {
      place(piece, smaller);
    }
  };
  for (const piece of splitMarkdownWithCodeFences(
    markdown,
    SOURCE_CHUNK_BUDGET,
  )) {
    place(piece, SOURCE_CHUNK_BUDGET);
  }
  return chunks;
}

/** New-message sends; an edit is decorative and backs off on its own. */
const RATE_LIMIT_RETRY_METHODS: ReadonlySet<string> = new Set([
  'sendMessage',
  'sendPhoto',
  'sendDocument',
  'sendVideo',
  'sendAudio',
  'sendVoice',
  'sendAnimation',
]);
export const TELEGRAM_RATE_LIMIT_MAX_RETRIES = 2;
export const TELEGRAM_RATE_LIMIT_MAX_TOTAL_WAIT_MS = 30_000;
const RETRY_AFTER_FALLBACK_MS = 1_000;

/** Wait Telegram asked for in a 429 answer, in milliseconds. */
export function telegramRetryAfterMs(response: {
  parameters?: { retry_after?: unknown };
}): number {
  const seconds = response.parameters?.retry_after;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0
    ? seconds * 1000
    : RETRY_AFTER_FALLBACK_MS;
}

/**
 * grammY API transformer that retries a send Telegram answered with 429, after
 * its `retry_after`, at most `maxRetries` times and within `maxTotalWaitMs`.
 * A 429 is a complete answer — the message was not accepted — so the retry
 * cannot duplicate it. A transport failure throws before any answer exists
 * and passes through untouched: Telegram may already have accepted that send.
 */
export function createTelegramRateLimitRetry(
  options: {
    sleep?: (ms: number) => Promise<void>;
    /** False once the connection stops: give up instead of sending late. */
    isLive?: () => boolean;
    maxRetries?: number;
    maxTotalWaitMs?: number;
  } = {},
): Transformer {
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const isLive = options.isLive ?? (() => true);
  const maxRetries = options.maxRetries ?? TELEGRAM_RATE_LIMIT_MAX_RETRIES;
  const maxTotalWaitMs =
    options.maxTotalWaitMs ?? TELEGRAM_RATE_LIMIT_MAX_TOTAL_WAIT_MS;
  return async (prev, method, payload, signal) => {
    let response = await prev(method, payload, signal);
    if (!RATE_LIMIT_RETRY_METHODS.has(method)) return response;
    let waited = 0;
    for (let retry = 0; retry < maxRetries; retry += 1) {
      if (response.ok || response.error_code !== 429) return response;
      const waitMs = telegramRetryAfterMs(response);
      if (waited + waitMs > maxTotalWaitMs || signal?.aborted) return response;
      waited += waitMs;
      await sleep(waitMs);
      if (!isLive() || signal?.aborted) return response;
      response = await prev(method, payload, signal);
    }
    return response;
  };
}

/**
 * Only real HTML parse failures should fall back to a second plain send.
 * Timeout / 5xx / 429 / other transport errors are wrapped by grammy as
 * HttpError (inner error on `.error`, not `.cause`) and must be rethrown so
 * the already-attempted chunk is not duplicated.
 */
export function isTelegramHtmlParseError(err: unknown): boolean {
  let current: unknown = err;
  const seen = new Set<unknown>();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const rec = current as Record<string, unknown>;
    const code = Number(rec.error_code);
    const description = String(rec.description ?? rec.message ?? '');
    if (
      code === 400 &&
      /parse entities|unclosed|unsupported start tag|can't find end tag|message is too long/i.test(
        description,
      )
    ) {
      return true;
    }
    current = rec.cause ?? rec.error;
  }
  return false;
}

/**
 * A Bot API rejection carries a numeric `error_code` because Telegram itself
 * answered `ok=false`: the request was received, refused, and no message
 * became visible. grammY transport failures (HttpError, timeouts) have no
 * `error_code` and must stay untyped — the provider may already have
 * accepted those.
 */
export function telegramApiRejection(
  err: unknown,
): { code: number; description: string } | null {
  let current: unknown = err;
  const seen = new Set<unknown>();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const rec = current as Record<string, unknown>;
    if (typeof rec.error_code === 'number' && Number.isFinite(rec.error_code)) {
      return {
        code: rec.error_code,
        description: String(rec.description ?? rec.message ?? ''),
      };
    }
    current = rec.cause ?? rec.error;
  }
  return null;
}

/**
 * Wait Telegram asked for when it refused a call with 429 (grammY keeps the
 * answer's `parameters` on the error), or null for any other failure.
 */
export function telegramRateLimitWaitMs(err: unknown): number | null {
  let current: unknown = err;
  const seen = new Set<unknown>();
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    const rec = current as Record<string, unknown>;
    if (rec.error_code === 429) {
      return telegramRetryAfterMs(
        rec as { parameters?: { retry_after?: unknown } },
      );
    }
    current = rec.cause ?? rec.error;
  }
  return null;
}

/**
 * Map outbound send errors onto the durable Outbox's failure taxonomy. An
 * acknowledged-prefix partial delivery must stay uncertain even when the tail
 * mutation was explicitly rejected, so it is never re-wrapped here. Only 4xx
 * answers are definitive: a 5xx `ok=false` cannot prove Telegram discarded
 * the mutation before its internal failure, and 408 is commonly synthesized
 * by an intermediary after the upstream may already have accepted it.
 *
 * 429 is a terminal failure as well. Telegram did not deliver the message,
 * and production has no worker that reclaims a `retry_wait` row, so a
 * `retryAt` would strand it; the description keeps `retry after N`.
 */
export function classifyTelegramSendError(err: unknown): unknown {
  if (err instanceof DefinitiveChannelDeliveryError) return err;
  if (err instanceof PartialChannelDeliveryError) return err;
  const rejection = telegramApiRejection(err);
  if (
    !rejection ||
    rejection.code < 400 ||
    rejection.code >= 500 ||
    rejection.code === 408
  ) {
    return err;
  }
  return new DefinitiveChannelDeliveryError(
    `Telegram Bot API rejected the send (${rejection.code}): ${rejection.description}`,
    { cause: err },
  );
}
