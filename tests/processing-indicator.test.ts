import { describe, expect, it, vi } from 'vitest';
import {
  ExactAsyncIndicatorRegistry,
  processingIndicatorKey,
} from '../src/processing-indicator.js';

describe('ExactAsyncIndicatorRegistry', () => {
  it('waits for a racing async attach before it clears', async () => {
    let finishAttach!: (handle: string) => void;
    const registry = new ExactAsyncIndicatorRegistry<string>();
    const release = vi.fn(async () => {});
    const key = processingIndicatorKey('group:one', 'input-a');

    const attaching = registry.attach(
      key,
      () =>
        new Promise<string>((resolve) => {
          finishAttach = resolve;
        }),
      release,
    );
    const clearing = registry.clear(key);
    await Promise.resolve();

    expect(release).not.toHaveBeenCalled();
    finishAttach('provider-handle');
    await Promise.all([attaching, clearing]);

    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith('provider-handle');
    expect(registry.has(key)).toBe(false);
  });

  it('makes duplicate clears await the same release exactly once', async () => {
    const registry = new ExactAsyncIndicatorRegistry<string>();
    const release = vi.fn(async () => {});
    const key = processingIndicatorKey('group:one', 'input-a');
    await registry.attach(key, async () => 'handle-a', release);

    await Promise.all([registry.clear(key), registry.clear(key)]);

    expect(release).toHaveBeenCalledTimes(1);
  });

  it('does not let input B clear input A in the same chat', async () => {
    const registry = new ExactAsyncIndicatorRegistry<string>();
    const release = vi.fn(async () => {});
    const inputA = processingIndicatorKey('group:one', 'input-a');
    const inputB = processingIndicatorKey('group:one', 'input-b');
    await registry.attach(inputA, async () => 'handle-a', release);
    await registry.attach(inputB, async () => 'handle-b', release);

    await registry.clear(inputB);

    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith('handle-b');
    expect(registry.has(inputA)).toBe(true);
    expect(registry.has(inputB)).toBe(false);
  });

  it('deduplicates duplicate attach attempts for the same input', async () => {
    const registry = new ExactAsyncIndicatorRegistry<string>();
    const acquire = vi.fn(async () => 'handle-a');
    const release = vi.fn(async () => {});
    const key = processingIndicatorKey('group:one', 'input-a');

    await Promise.all([
      registry.attach(key, acquire, release),
      registry.attach(key, acquire, release),
    ]);
    await registry.clear(key);

    expect(acquire).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('retains ownership when provider removal fails and retries later', async () => {
    const registry = new ExactAsyncIndicatorRegistry<string>();
    const release = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('temporary provider failure'))
      .mockResolvedValueOnce();
    const key = processingIndicatorKey('group:one', 'input-a');
    await registry.attach(key, async () => 'handle-a', release);

    await expect(registry.clear(key)).rejects.toThrow(
      'temporary provider failure',
    );
    expect(registry.has(key)).toBe(true);

    await registry.clear(key);
    expect(release).toHaveBeenCalledTimes(2);
    expect(registry.has(key)).toBe(false);
  });
});

describe('ExactAsyncIndicatorRegistry capacity', () => {
  it('evicts the oldest entry and releases its handle once capacity is exceeded', async () => {
    // Entries are keyed per inbound message, so a turn that dies before its
    // terminal never clears one. Without a cap those accumulate for the
    // process lifetime; eviction must also release the provider handle, or
    // the reaction survives on the provider side with no owner left.
    const released: string[] = [];
    const registry = new ExactAsyncIndicatorRegistry<string>(2);

    for (const id of ['a', 'b', 'c']) {
      await registry.attach(
        processingIndicatorKey('group:one', id),
        async () => `handle-${id}`,
        async (handle) => {
          released.push(handle);
        },
      );
    }
    await Promise.resolve();
    await Promise.resolve();

    expect(registry.size).toBe(2);
    expect(registry.has(processingIndicatorKey('group:one', 'a'))).toBe(false);
    expect(registry.has(processingIndicatorKey('group:one', 'c'))).toBe(true);
    expect(released).toEqual(['handle-a']);
  });

  it('never evicts the entry being attached', async () => {
    const registry = new ExactAsyncIndicatorRegistry<string>(1);
    await registry.attach(
      processingIndicatorKey('group:one', 'first'),
      async () => 'handle-first',
      async () => {},
    );
    await registry.attach(
      processingIndicatorKey('group:one', 'second'),
      async () => 'handle-second',
      async () => {},
    );

    expect(registry.size).toBe(1);
    expect(registry.has(processingIndicatorKey('group:one', 'second'))).toBe(
      true,
    );
  });
});
