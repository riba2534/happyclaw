export function processingIndicatorKey(
  route: string,
  inputMessageId: string,
): string {
  return `${route}\0${inputMessageId}`;
}

interface AsyncIndicatorEntry<Handle> {
  ready: Promise<Handle | null>;
  release: (handle: Handle) => Promise<void>;
  clearPromise?: Promise<void>;
}

/**
 * Owns provider resources by an exact logical input.
 *
 * The entry is installed before `acquire` starts. Consequently a terminal
 * clear that races an in-flight provider attach waits for that attach and
 * releases the resulting handle exactly once.
 */
export class ExactAsyncIndicatorRegistry<Handle> {
  private readonly entries = new Map<string, AsyncIndicatorEntry<Handle>>();

  /**
   * Entries are keyed per inbound message, not per chat, so the map grows with
   * message volume rather than with the number of conversations. A turn that
   * dies before its terminal — runner crash, an exception between attach and
   * clear — never clears its entry, and `clear`'s failure path deliberately
   * retains one. Both are unbounded without a cap.
   *
   * Eviction releases the provider handle instead of dropping it, so an
   * evicted indicator does not survive on the provider side either.
   */
  constructor(private readonly maxEntries = 512) {}

  attach(
    key: string,
    acquire: () => Promise<Handle | null>,
    release: (handle: Handle) => Promise<void>,
  ): Promise<void> {
    const existing = this.entries.get(key);
    if (existing) return existing.ready.then(() => undefined);

    const entry: AsyncIndicatorEntry<Handle> = {
      ready: Promise.resolve().then(acquire),
      release,
    };
    this.entries.set(key, entry);
    this.evictOverflow(key);

    return entry.ready
      .then(() => undefined)
      .catch((error) => {
        // Acquisition failed, so there is no provider handle to retain even
        // when a racing clear is already waiting on this promise.
        if (this.entries.get(key) === entry) {
          this.entries.delete(key);
        }
        throw error;
      });
  }

  clear(key: string): Promise<void> {
    const entry = this.entries.get(key);
    if (!entry) return Promise.resolve();
    if (entry.clearPromise) return entry.clearPromise;

    entry.clearPromise = entry.ready
      .then(async (handle) => {
        if (handle) await entry.release(handle);
      })
      .then(() => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      })
      .catch((error) => {
        // A provider delete can fail transiently. Retain ownership and allow a
        // later terminal/shutdown cleanup to retry instead of orphaning the
        // reaction handle permanently.
        entry.clearPromise = undefined;
        throw error;
      });
    return entry.clearPromise;
  }

  /**
   * Drop the oldest entries once the cap is exceeded, releasing each handle on
   * the way out. Map iteration is insertion-ordered, so the oldest attach goes
   * first. The entry just installed is never evicted.
   */
  private evictOverflow(protectedKey: string): void {
    if (this.entries.size <= this.maxEntries) return;
    for (const key of [...this.entries.keys()]) {
      if (this.entries.size <= this.maxEntries) break;
      if (key === protectedKey) continue;
      // Start the release, then drop the entry whether or not it succeeds.
      // This entry is already older than `maxEntries` turns; keeping it
      // forever in the hope of a later retry is the worse failure.
      void this.clear(key).catch(() => undefined);
      this.entries.delete(key);
    }
  }

  async clearAll(): Promise<void> {
    await Promise.allSettled(
      [...this.entries.keys()].map((key) => this.clear(key)),
    );
  }

  has(key: string): boolean {
    return this.entries.has(key);
  }

  get size(): number {
    return this.entries.size;
  }
}
