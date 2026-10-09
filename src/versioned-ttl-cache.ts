interface Entry<T> {
  value: T;
  version: number;
  storedAt: number;
}

export interface VersionedTtlCacheOptions {
  maxEntries: number;
  /** Serve an entry this long while the data version is unchanged. */
  maxAgeMs: number;
  /** Serve an entry this long even after the data version moved. */
  staleGraceMs: number;
}

/**
 * Small LRU for expensive read-only aggregates. An entry is reused while the
 * caller-supplied data version is unchanged (up to `maxAgeMs`), and for a
 * short grace period after it moved, so a busy writer cannot force every
 * dashboard refresh to recompute.
 */
export class VersionedTtlCache<T> {
  private readonly entries = new Map<string, Entry<T>>();

  constructor(private readonly options: VersionedTtlCacheOptions) {}

  get(key: string, version: number, now = Date.now()): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    const age = now - entry.storedAt;
    const fresh =
      age < this.options.staleGraceMs ||
      (entry.version === version && age < this.options.maxAgeMs);
    if (!fresh) {
      this.entries.delete(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, version: number, value: T, now = Date.now()): void {
    this.entries.delete(key);
    this.entries.set(key, { value, version, storedAt: now });
    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
