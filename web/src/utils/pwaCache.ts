/**
 * Clear all PWA runtime API caches.
 * Called on login/register/logout to prevent cross-user data leakage on shared
 * devices: SWR strategies serve a "first frame" from the previous user's cache
 * before background revalidation overwrites it.
 *
 * Static asset caches (precache, fonts, mermaid) are user-agnostic — keep them.
 *
 * Guarantee: in the main login/logout flow there is no first-frame window —
 * caches.delete() resolves before navigation begins.
 * Theoretical edge case: a fetch intercepted during SW install/activate
 * could rebuild a cache entry, but is not reachable in practice (SW
 * lifecycle and login flow do not overlap on the same tab).
 */
// NOTE: keep these names in sync with `cacheName` values in
// web/vite.config.ts runtimeCaching (api-groups-cache / api-core-cache).
// Mismatch will silently leak stale data across users without any error.
const API_CACHE_NAMES = ['api-groups-cache', 'api-core-cache'];

export async function clearApiCaches(): Promise<void> {
  if (typeof window === 'undefined' || !('caches' in window)) return;
  await Promise.allSettled(API_CACHE_NAMES.map((name) => caches.delete(name)));
}

/**
 * Invalidate all cached entries for a specific group's messages/agents.
 * Called after destructive ops (clearHistory, deleteMessage) so the SW cache
 * doesn't serve a stale page that includes the now-deleted content.
 */
export async function invalidateGroupCache(jid: string): Promise<void> {
  if (typeof window === 'undefined' || !('caches' in window)) return;
  try {
    const cache = await caches.open('api-groups-cache');
    const keys = await cache.keys();
    const encodedJid = encodeURIComponent(jid);
    const targetPrefix = `/api/groups/${encodedJid}/`;
    await Promise.allSettled(
      keys
        .filter((req) => new URL(req.url).pathname.startsWith(targetPrefix))
        .map((req) => cache.delete(req)),
    );
  } catch {
    /* ignore */
  }
}
