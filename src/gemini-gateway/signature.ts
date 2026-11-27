// ─── Gemini 订阅 — thought signature 往返 ─────────────────────────
//
// Gemini 3/4 要求历史里的 functionCall 携带 thoughtSignature，缺失时上游
// 直接 400。Anthropic Messages 的 tool_use 块没有签名字段，因此把签名放进
// 相邻的 thinking 块的 signature 里一起往返；另外在进程内按 tool_use id
// 缓存一份，以防 CLI 在后续请求里丢掉 thinking 块（例如压缩或重放）。

import { createHash } from 'node:crypto';

import { GEMINI_SIGNATURE_PREFIX } from './types.js';

export interface SignatureCarrier {
  /** 上游原始 thoughtSignature。 */
  signature: string;
  /** 签名属于文本 part 还是函数调用 part。 */
  kind: 'text' | 'tool';
  /** 函数调用时上游给的 call id，用于和 tool_use 对齐。 */
  callId?: string;
}

export function encodeSignatureCarrier(carrier: SignatureCarrier): string {
  const payload = JSON.stringify({
    s: carrier.signature,
    k: carrier.kind,
    ...(carrier.callId ? { i: carrier.callId } : {}),
  });
  return `${GEMINI_SIGNATURE_PREFIX}${Buffer.from(payload, 'utf8').toString('base64url')}`;
}

export function decodeSignatureCarrier(
  value: string | null | undefined,
): SignatureCarrier | null {
  if (!value || !value.startsWith(GEMINI_SIGNATURE_PREFIX)) return null;
  try {
    const raw = JSON.parse(
      Buffer.from(
        value.slice(GEMINI_SIGNATURE_PREFIX.length),
        'base64url',
      ).toString('utf8'),
    ) as Record<string, unknown>;
    if (typeof raw.s !== 'string' || !raw.s) return null;
    const kind = raw.k === 'tool' ? 'tool' : 'text';
    return {
      signature: raw.s,
      kind,
      ...(typeof raw.i === 'string' && raw.i ? { callId: raw.i } : {}),
    };
  } catch {
    return null;
  }
}

/** Anthropic tool_use 的 id：稳定、看起来像 Anthropic 生成的。 */
export function geminiToolUseId(callId: string | null, name: string): string {
  const digest = createHash('sha256')
    .update(callId ?? name)
    .digest('base64url')
    .slice(0, 24);
  return `toolu_${digest}`;
}

interface CachedSignature {
  signature: string;
  callId: string | null;
  name: string;
}

/** Bounded LRU: conversations are long, but a turn only needs recent calls. */
const MAX_CACHED_SIGNATURES = 2_000;
const cache = new Map<string, CachedSignature>();

export function rememberToolSignature(
  toolUseId: string,
  entry: CachedSignature,
): void {
  cache.delete(toolUseId);
  cache.set(toolUseId, entry);
  while (cache.size > MAX_CACHED_SIGNATURES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function recallToolSignature(toolUseId: string): CachedSignature | null {
  const entry = cache.get(toolUseId);
  if (!entry) return null;
  // Refresh recency.
  cache.delete(toolUseId);
  cache.set(toolUseId, entry);
  return entry;
}

export function clearGeminiSignatureCacheForTest(): void {
  cache.clear();
}
