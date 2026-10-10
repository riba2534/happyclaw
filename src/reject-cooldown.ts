/**
 * Rate-limits "this chat is not paired" replies per chat. The previous
 * per-connector Map gained one entry per unregistered chat that ever wrote
 * to the bot and never shrank. An entry older than the cooldown carries no
 * information (a missing key behaves the same), so expired entries are
 * dropped first, then the oldest beyond the cap; losing one only allows a
 * single extra rejection reply.
 */
export function createRejectCooldown(cooldownMs: number, maxEntries = 1_000) {
  const lastReply = new Map<string, number>();
  return {
    /** True when a rejection reply may be sent now; records the reply. */
    shouldNotify(key: string, now: number = Date.now()): boolean {
      const previous = lastReply.get(key);
      if (previous !== undefined && now - previous < cooldownMs) return false;
      lastReply.delete(key);
      lastReply.set(key, now);
      if (lastReply.size > maxEntries) {
        for (const [candidate, at] of lastReply) {
          if (lastReply.size <= maxEntries && now - at < cooldownMs) break;
          lastReply.delete(candidate);
        }
      }
      return true;
    },
    get size(): number {
      return lastReply.size;
    },
  };
}
