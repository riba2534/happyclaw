import { describe, expect, test, vi } from 'vitest';
import { createFeishuSenderNameResolver } from '../src/feishu-sender-name.js';

describe('Feishu sender name resolver', () => {
  test('resolves and caches a contact name', async () => {
    const lookup = vi.fn(async () => '浣熊');
    const resolver = createFeishuSenderNameResolver({ lookup });

    await expect(resolver.resolve('ou_a')).resolves.toBe('浣熊');
    await expect(resolver.resolve('ou_a')).resolves.toBe('浣熊');
    expect(resolver.peek('ou_a')).toBe('浣熊');
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  test('shares one request between concurrent lookups for the same sender', async () => {
    let release!: (name: string) => void;
    const lookup = vi.fn(
      () => new Promise<string>((resolve) => (release = resolve)),
    );
    const resolver = createFeishuSenderNameResolver({ lookup });

    const first = resolver.resolve('ou_a');
    const second = resolver.resolve('ou_a');
    await vi.waitFor(() => expect(lookup).toHaveBeenCalled());
    release('斐斐');

    await expect(Promise.all([first, second])).resolves.toEqual([
      '斐斐',
      '斐斐',
    ]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  test('degrades to undefined and negatively caches lookup failures', async () => {
    let clock = 0;
    const onLookupError = vi.fn();
    const lookup = vi.fn(async () => {
      throw new Error('99991672 no contact scope');
    });
    const resolver = createFeishuSenderNameResolver({
      lookup,
      now: () => clock,
      negativeTtlMs: 1_000,
      onLookupError,
    });

    await expect(resolver.resolve('ou_a')).resolves.toBeUndefined();
    await expect(resolver.resolve('ou_a')).resolves.toBeUndefined();
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(onLookupError).toHaveBeenCalledTimes(1);

    clock = 1_000;
    await resolver.resolve('ou_a');
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  test('treats blank names as missing', async () => {
    const resolver = createFeishuSenderNameResolver({
      lookup: async () => '   ',
    });
    await expect(resolver.resolve('ou_a')).resolves.toBeUndefined();
  });

  test('refreshes a positive entry after its TTL', async () => {
    let clock = 0;
    const lookup = vi
      .fn<(openId: string) => Promise<string>>()
      .mockResolvedValueOnce('旧名字')
      .mockResolvedValueOnce('新名字');
    const resolver = createFeishuSenderNameResolver({
      lookup,
      now: () => clock,
      positiveTtlMs: 1_000,
    });

    await expect(resolver.resolve('ou_a')).resolves.toBe('旧名字');
    clock = 1_000;
    expect(resolver.peek('ou_a')).toBeUndefined();
    await expect(resolver.resolve('ou_a')).resolves.toBe('新名字');
  });

  test('gives up on a hung lookup after the hard timeout', async () => {
    vi.useFakeTimers();
    try {
      const resolver = createFeishuSenderNameResolver({
        lookup: () => new Promise<string>(() => {}),
        timeoutMs: 25,
      });
      const pending = resolver.resolve('ou_a');
      await vi.advanceTimersByTimeAsync(25);
      await expect(pending).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test('evicts the oldest entries beyond the cache bound', async () => {
    const lookup = vi.fn(async (openId: string) => `name-${openId}`);
    const resolver = createFeishuSenderNameResolver({ lookup, maxEntries: 2 });

    await resolver.resolve('a');
    await resolver.resolve('b');
    await resolver.resolve('c');

    expect(resolver.peek('a')).toBeUndefined();
    expect(resolver.peek('b')).toBe('name-b');
    expect(resolver.peek('c')).toBe('name-c');
  });

  test('never looks up an empty open_id', async () => {
    const lookup = vi.fn(async () => 'x');
    const resolver = createFeishuSenderNameResolver({ lookup });
    await expect(resolver.resolve('')).resolves.toBeUndefined();
    expect(lookup).not.toHaveBeenCalled();
  });
});
