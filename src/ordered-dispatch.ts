/**
 * Deliver items per key in submission order even when some need async
 * preparation first (e.g. rendering a thumbnail before a WS broadcast).
 * Items that need no preparation go out synchronously while nothing is
 * pending for their key, so the common path stays zero-latency.
 */
export function createOrderedDispatcher(
  onError: (err: unknown, key: string) => void,
) {
  const pending = new Map<string, Promise<void>>();

  return function dispatch<T>(
    key: string,
    item: T,
    deliver: (item: T) => void,
    prepare?: (item: T) => Promise<T>,
  ): void {
    const previous = pending.get(key);
    if (!previous && !prepare) {
      deliver(item);
      return;
    }
    const done = (previous ?? Promise.resolve())
      .then(async () => deliver(prepare ? await prepare(item) : item))
      .catch((err) => onError(err, key));
    pending.set(key, done);
    void done.finally(() => {
      if (pending.get(key) === done) pending.delete(key);
    });
  };
}
