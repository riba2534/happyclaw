/**
 * Shared reading of Feishu/Lark API failures. The Lark SDK throws Axios errors
 * for HTTP 4xx (`err.code` is then the string 'ERR_BAD_REQUEST' and the
 * Feishu code lives in `err.response.data.code`), while resolved envelopes and
 * some SDK paths carry the code at the top level. Every caller must read the
 * code the same way, or retries and fallbacks key off the wrong value.
 */

type Recordish = Record<string, unknown>;

function record(value: unknown): Recordish {
  return value && typeof value === 'object' ? (value as Recordish) : {};
}

function numericCode(raw: unknown): number | undefined {
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  if (typeof raw === 'string' && /^\d+$/.test(raw)) return Number(raw);
  return undefined;
}

/** The Feishu business code, preferring the HTTP response body. */
export function feishuErrorCode(error: unknown): number | undefined {
  const err = record(error);
  return (
    numericCode(record(record(err.response).data).code) ??
    numericCode(record(err.data).code) ??
    numericCode(err.code)
  );
}

export function feishuHttpStatus(error: unknown): number | undefined {
  const status = record(record(error).response).status;
  return typeof status === 'number' ? status : undefined;
}

function header(headers: unknown, name: string): string | undefined {
  const h = record(headers);
  const getter = (h as { get?: unknown }).get;
  if (typeof getter === 'function') {
    const value = (getter as (key: string) => unknown).call(h, name);
    if (value != null) return String(value);
  }
  const value = h[name] ?? h[name.toLowerCase()];
  return value == null ? undefined : String(value);
}

/**
 * How long Feishu asks us to wait: `x-ogw-ratelimit-reset` (seconds, app-level
 * limits) or `Retry-After` (seconds or an HTTP date).
 */
export function feishuRetryAfterMs(error: unknown): number | undefined {
  const headers = record(record(error).response).headers;
  const reset = Number(header(headers, 'x-ogw-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0) return Math.ceil(reset * 1000);
  const retryAfter = header(headers, 'retry-after');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }
  return undefined;
}

/** Per-chat (230020) and app-level (99991400, 11232, 11233) rate limits. */
const RATE_LIMIT_CODES = new Set([230020, 99991400, 11232, 11233]);
/**
 * The target is gone: the anchor message was recalled or deleted (230011,
 * 231003), or the bot can no longer post there (230002, 232009). Switching
 * card backends or message types cannot help.
 */
const TARGET_UNAVAILABLE_CODES = new Set([230011, 231003, 230002, 232009]);
/** CardKit closed streaming mode (10 minutes after it was enabled). */
const STREAMING_CLOSED_CODES = new Set([200850, 300309, 200510]);
/** The content itself was refused: DLP audit, invalid card content. */
const CONTENT_REJECTED_CODES = new Set([230028, 230099, 11310]);

/** The app has not been granted a scope the API requires. */
const MISSING_SCOPE_CODES = new Set([99991672]);

export function isFeishuMissingScopeError(error: unknown): boolean {
  const code = feishuErrorCode(error);
  return code !== undefined && MISSING_SCOPE_CODES.has(code);
}

export type FeishuErrorKind =
  /** Platform refused for now; the same request may be resent after a wait. */
  | 'rate_limited'
  | 'target_unavailable'
  | 'streaming_closed'
  | 'content_rejected'
  /** Any other received 4xx: authoritative, not accepted. */
  | 'definitive'
  /** No response, 5xx or 408: the request may or may not have been accepted. */
  | 'transient';

export interface FeishuErrorClass {
  kind: FeishuErrorKind;
  code?: number;
  status?: number;
  retryAfterMs?: number;
  /** Short Chinese explanation for user-facing notices, when known. */
  reason?: string;
}

export function classifyFeishuError(error: unknown): FeishuErrorClass {
  const code = feishuErrorCode(error);
  const status = feishuHttpStatus(error);
  const base = {
    ...(code !== undefined ? { code } : {}),
    ...(status !== undefined ? { status } : {}),
  };
  if (status === 429 || (code !== undefined && RATE_LIMIT_CODES.has(code))) {
    const retryAfterMs = feishuRetryAfterMs(error);
    return {
      ...base,
      kind: 'rate_limited',
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      reason: '飞书发送频率超限',
    };
  }
  if (code !== undefined && TARGET_UNAVAILABLE_CODES.has(code)) {
    return {
      ...base,
      kind: 'target_unavailable',
      reason:
        code === 230011 || code === 231003
          ? '原消息已被撤回或删除'
          : '机器人已无法在该会话发送消息',
    };
  }
  if (code !== undefined && STREAMING_CLOSED_CODES.has(code)) {
    return { ...base, kind: 'streaming_closed' };
  }
  if (code !== undefined && CONTENT_REJECTED_CODES.has(code)) {
    return {
      ...base,
      kind: 'content_rejected',
      reason:
        code === 230028
          ? '内容含邮箱等敏感信息，被飞书安全策略拦截'
          : '内容不符合飞书卡片格式要求',
    };
  }
  if (status !== undefined && status >= 400 && status < 500 && status !== 408) {
    return { ...base, kind: 'definitive' };
  }
  if (status === undefined && code !== undefined && code !== 0) {
    // A resolved envelope with a business error code: the request reached
    // Feishu and was refused.
    return { ...base, kind: 'definitive' };
  }
  return { ...base, kind: 'transient' };
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Neutralize `<at …>` outside code so model output, tool results or quoted
 * web content cannot @ everyone (or get the whole card rejected when the
 * group disallows @all). Cards decode `&#60;`; text/post messages don't, so
 * they get a full-width bracket instead. Code blocks and inline code are kept
 * verbatim. Real mentions go through dedicated capabilities, not free text.
 */
export function neutralizeFeishuMentions(
  text: string,
  target: 'card' | 'text',
): string {
  if (!/<at\b/i.test(text)) return text;
  const replacement = target === 'card' ? '&#60;at' : '＜at';
  let fence: string | null = null;
  return text
    .split('\n')
    .map((line) => {
      const marker = FENCE.exec(line)?.[1];
      if (fence) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length)
          fence = null;
        return line;
      }
      if (marker) {
        fence = marker;
        return line;
      }
      // Keep inline code spans intact.
      return line
        .split(/(`+[^`]*`+)/)
        .map((part, i) =>
          i % 2 === 1 ? part : part.replace(/<at\b/gi, replacement),
        )
        .join('');
    })
    .join('\n');
}
