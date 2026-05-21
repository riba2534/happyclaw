import { describe, expect, test } from 'vitest';

import { DEFAULT_STALE_MS, isStale } from '../src/im-safety/stale-detector.js';

describe('isStale', () => {
  test('fresh message returns false', () => {
    expect(isStale(Date.now())).toBe(false);
  });

  test('boundary at exactly windowMs returns false (strict >)', () => {
    const now = Date.now();
    expect(isStale(now - DEFAULT_STALE_MS)).toBe(false);
  });

  test('1ms past windowMs returns true', () => {
    const now = Date.now();
    expect(isStale(now - DEFAULT_STALE_MS - 1)).toBe(true);
  });

  test('createTimeMs=0 returns false (safe fallback)', () => {
    expect(isStale(0)).toBe(false);
  });

  test('NaN returns false', () => {
    expect(isStale(Number.NaN)).toBe(false);
  });

  test('Infinity returns false', () => {
    expect(isStale(Number.POSITIVE_INFINITY)).toBe(false);
  });

  test('undefined / null returns false (channel may not provide createTime)', () => {
    expect(isStale(undefined)).toBe(false);
    expect(isStale(null)).toBe(false);
  });

  test('custom windowMs of 1000 with 2s-old message returns true', () => {
    expect(isStale(Date.now() - 2000, 1000)).toBe(true);
  });

  test('DEFAULT_STALE_MS equals 30 minutes', () => {
    expect(DEFAULT_STALE_MS).toBe(30 * 60_000);
  });
});
