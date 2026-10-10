import { describe, expect, test } from 'vitest';

import { VersionedTtlCache } from '../src/versioned-ttl-cache.js';

describe('VersionedTtlCache', () => {
  test('serves while the version is unchanged and the entry is young', () => {
    const cache = new VersionedTtlCache<string>({
      maxEntries: 4,
      maxAgeMs: 1_000,
      staleGraceMs: 0,
    });
    cache.set('k', 7, 'v', 0);
    expect(cache.get('k', 7, 999)).toBe('v');
    expect(cache.get('k', 8, 10)).toBeUndefined();
    cache.set('k', 7, 'v', 0);
    expect(cache.get('k', 7, 1_000)).toBeUndefined();
  });

  test('honors the stale grace after the version moved', () => {
    const cache = new VersionedTtlCache<string>({
      maxEntries: 4,
      maxAgeMs: 1_000,
      staleGraceMs: 100,
    });
    cache.set('k', 1, 'v', 0);
    expect(cache.get('k', 2, 50)).toBe('v');
    expect(cache.get('k', 2, 150)).toBeUndefined();
  });

  test('evicts the least recently used entry beyond the cap', () => {
    const cache = new VersionedTtlCache<number>({
      maxEntries: 2,
      maxAgeMs: 1_000,
      staleGraceMs: 0,
    });
    cache.set('a', 1, 1, 0);
    cache.set('b', 1, 2, 0);
    expect(cache.get('a', 1, 1)).toBe(1);
    cache.set('c', 1, 3, 2);
    expect(cache.get('b', 1, 3)).toBeUndefined();
    expect(cache.get('a', 1, 3)).toBe(1);
    expect(cache.get('c', 1, 3)).toBe(3);
    expect(cache.size).toBe(2);
  });

  test('keeps the summed weight within the budget', () => {
    const cache = new VersionedTtlCache<number[]>({
      maxEntries: 8,
      maxAgeMs: 1_000,
      staleGraceMs: 0,
      maxWeight: 10,
      weigh: (rows) => rows.length,
    });
    cache.set('a', 1, new Array(4).fill(0), 0);
    cache.set('b', 1, new Array(4).fill(0), 0);
    expect(cache.size).toBe(2);
    // 4 + 4 + 4 > 10: the least recently used entry goes.
    cache.set('c', 1, new Array(4).fill(0), 0);
    expect(cache.get('a', 1, 1)).toBeUndefined();
    expect(cache.size).toBe(2);
    // A value heavier than the whole budget is not cached and evicts nothing.
    cache.set('huge', 1, new Array(11).fill(0), 0);
    expect(cache.get('huge', 1, 1)).toBeUndefined();
    expect(cache.size).toBe(2);
    // Replacing a key releases its old weight.
    cache.set('b', 1, [], 0);
    cache.set('d', 1, new Array(6).fill(0), 0);
    expect(cache.size).toBe(3);
    cache.clear();
    cache.set('e', 1, new Array(10).fill(0), 0);
    expect(cache.get('e', 1, 1)).toHaveLength(10);
  });
});
