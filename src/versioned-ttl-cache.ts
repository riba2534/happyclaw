interface Entry<T> {
  value: T;
  version: number;
  storedAt: number;
  weight: number;
}

export interface VersionedTtlCacheOptions<T> {
  maxEntries: number;
  /** Serve an entry this long while the data version is unchanged. */
  maxAgeMs: number;
  /** Serve an entry this long even after the data version moved. */
  staleGraceMs: number;
  /**
   * Optional size budget: the summed `weigh()` of all entries stays at or
   * below `maxWeight`, evicting least recently used entries first. A single
   * value heavier than the budget is not cached at all.
   */
  maxWeight?: number;
  weigh?: (value: T) => number;
}

/**
 * Small LRU for expensive read-only aggregates. An entry is reused while the
 * caller-supplied data version is unchanged (up to `maxAgeMs`), and for a
 * short grace period after it moved, so a busy writer cannot force every
 * dashboard refresh to recompute.
 */
export class VersionedTtlCache<T> {
  private readonly entries = new Map<string, Entry<T>>();
  private totalWeight = 0;

  constructor(private readonly options: VersionedTtlCacheOptions<T>) {}

  get(key: string, version: number, now = Date.now()): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const age = now - entry.storedAt;
    const fresh =
      age < this.options.staleGraceMs ||
      (entry.version === version && age < this.options.maxAgeMs);
    if (!fresh) {
      this.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, version: number, value: T, now = Date.now()): void {
    this.delete(key);
    const weight = this.options.weigh?.(value) ?? 0;
    const maxWeight = this.options.maxWeight ?? Infinity;
    if (weight > maxWeight) return;
    this.entries.set(key, { value, version, storedAt: now, weight });
    this.totalWeight += weight;
    while (
      this.entries.size > this.options.maxEntries ||
      this.totalWeight > maxWeight
    ) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
    this.totalWeight = 0;
  }

  private delete(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.totalWeight -= entry.weight;
  }

  get size(): number {
    return this.entries.size;
  }
}
