/**
 * Feishu `im.message.receive_v1` events identify the sender only by IDs; they
 * carry no display name. Without a lookup every inbound message is persisted
 * and shown to the Agent with the raw open_id as its sender name, which makes
 * group members indistinguishable in transcripts.
 *
 * This resolver enriches a sender open_id with the contact directory name.
 * Contact access is an optional Feishu scope, so every failure degrades to
 * "no name" instead of blocking the inbound pipeline: lookups are bounded by a
 * hard timeout, failures are negatively cached so a Bot without the scope does
 * not issue one doomed request per message, and concurrent lookups for the
 * same sender share a single request.
 */

export type FeishuSenderNameLookup = (
  openId: string,
) => Promise<string | undefined>;

export interface FeishuSenderNameResolverOptions {
  lookup: FeishuSenderNameLookup;
  now?: () => number;
  timeoutMs?: number;
  positiveTtlMs?: number;
  negativeTtlMs?: number;
  maxEntries?: number;
  onLookupError?: (openId: string, error: unknown) => void;
}

export interface FeishuSenderNameResolver {
  /** Resolve a display name, or `undefined` when none is available. */
  resolve(openId: string): Promise<string | undefined>;
  /** Return a fresh cached name without issuing a request. */
  peek(openId: string): string | undefined;
}

export const FEISHU_SENDER_NAME_TIMEOUT_MS = 3_000;
export const FEISHU_SENDER_NAME_POSITIVE_TTL_MS = 6 * 60 * 60 * 1000;
export const FEISHU_SENDER_NAME_NEGATIVE_TTL_MS = 10 * 60 * 1000;
export const FEISHU_SENDER_NAME_MAX_ENTRIES = 2_000;

interface CacheEntry {
  name: string | undefined;
  expiresAt: number;
}

export function createFeishuSenderNameResolver(
  options: FeishuSenderNameResolverOptions,
): FeishuSenderNameResolver {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? FEISHU_SENDER_NAME_TIMEOUT_MS;
  const positiveTtlMs =
    options.positiveTtlMs ?? FEISHU_SENDER_NAME_POSITIVE_TTL_MS;
  const negativeTtlMs =
    options.negativeTtlMs ?? FEISHU_SENDER_NAME_NEGATIVE_TTL_MS;
  const maxEntries = Math.max(
    1,
    options.maxEntries ?? FEISHU_SENDER_NAME_MAX_ENTRIES,
  );
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<string | undefined>>();

  function remember(openId: string, name: string | undefined): void {
    cache.delete(openId);
    cache.set(openId, {
      name,
      expiresAt: now() + (name ? positiveTtlMs : negativeTtlMs),
    });
    // Map preserves insertion order; evict the oldest entries first.
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
  }

  function fresh(openId: string): CacheEntry | undefined {
    const entry = cache.get(openId);
    if (!entry) return undefined;
    if (entry.expiresAt <= now()) {
      cache.delete(openId);
      return undefined;
    }
    return entry;
  }

  function lookupWithTimeout(openId: string): Promise<string | undefined> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(`Feishu sender name lookup timed out after ${timeoutMs}ms`),
        );
      }, timeoutMs);
      timer.unref?.();
      Promise.resolve()
        .then(() => options.lookup(openId))
        .then(
          (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          (error) => {
            clearTimeout(timer);
            reject(error);
          },
        );
    });
  }

  return {
    peek(openId) {
      return openId ? fresh(openId)?.name : undefined;
    },

    resolve(openId) {
      if (!openId) return Promise.resolve(undefined);
      const cached = fresh(openId);
      if (cached) return Promise.resolve(cached.name);
      const pending = inFlight.get(openId);
      if (pending) return pending;

      const request = lookupWithTimeout(openId)
        .then((value) => {
          const name = typeof value === 'string' ? value.trim() : '';
          remember(openId, name || undefined);
          return name || undefined;
        })
        .catch((error: unknown) => {
          remember(openId, undefined);
          options.onLookupError?.(openId, error);
          return undefined;
        })
        .finally(() => {
          inFlight.delete(openId);
        });
      inFlight.set(openId, request);
      return request;
    },
  };
}
