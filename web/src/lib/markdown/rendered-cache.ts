/**
 * Rendered Markdown of finished content, shared across mounts. Switching
 * sessions remounts the transcript, and every visible reply went through
 * micromark, mdast, hast and highlight.js again although its text had not
 * changed; reopening a recently viewed session reuses those trees. Replies
 * render block by block, so a finished reply also reuses the trees its
 * stream rendered as each block closed.
 *
 * Cached trees keep their hast nodes: about 70 bytes of heap per character
 * of prose and twice that for highlighted code. The budget below holds
 * roughly 15MB, several long replies, which still covers the reply that just
 * streamed and the sessions viewed last.
 */
export const RENDERED_CACHE_BUDGET = 200_000;
/** Entry cap, so many tiny blocks cannot grow the map without bound. */
export const RENDERED_CACHE_LIMIT = 600;
/** Content longer than this is rendered fresh instead of cached. */
export const RENDERED_CACHE_MAX_CHARS = 20_000;

interface Entry<T> {
  value: T;
  cost: number;
}

const cache = new Map<string, Entry<unknown>>();
let totalCost = 0;

/** Budget cost of a cached tree: highlighted code weighs twice as much. */
export function renderedCost(content: string, highlightsCode: boolean) {
  return content.length * (highlightsCode ? 2 : 1);
}

/** Look `key` up in the LRU, rendering and storing it on a miss. */
export function rememberRendered<T>(
  key: string,
  cost: number,
  render: () => T,
): T {
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit.value as T;
  }
  const value = render();
  cache.set(key, { value, cost });
  totalCost += cost;
  while (
    cache.size > RENDERED_CACHE_LIMIT ||
    totalCost > RENDERED_CACHE_BUDGET
  ) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    totalCost -= cache.get(oldest.value)?.cost ?? 0;
    cache.delete(oldest.value);
  }
  return value;
}

/** Current size, for tests. */
export function renderedCacheStats() {
  return { entries: cache.size, cost: totalCost };
}

/** Empty the cache, for tests. */
export function clearRenderedCache() {
  cache.clear();
  totalCost = 0;
}
