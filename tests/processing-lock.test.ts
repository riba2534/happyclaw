import { afterEach, describe, expect, test } from 'vitest';

import { ProcessingLock } from '../src/im-safety/processing-lock.js';

describe('ProcessingLock', () => {
  let lock: ProcessingLock | undefined;
  afterEach(() => lock?.dispose());

  test('first acquire succeeds, second fails until release', () => {
    lock = new ProcessingLock();
    expect(lock.acquire('m1')).toBe(true);
    expect(lock.acquire('m1')).toBe(false);
    lock.release('m1');
    expect(lock.acquire('m1')).toBe(true);
  });

  test('different ids are independent', () => {
    lock = new ProcessingLock();
    expect(lock.acquire('m1')).toBe(true);
    expect(lock.acquire('m2')).toBe(true);
    expect(lock.acquire('m1')).toBe(false);
    expect(lock.acquire('m2')).toBe(false);
  });

  test('expires after ttl', async () => {
    lock = new ProcessingLock(50);
    expect(lock.acquire('m1')).toBe(true);
    expect(lock.acquire('m1')).toBe(false);
    await new Promise((r) => setTimeout(r, 80));
    expect(lock.acquire('m1')).toBe(true);
  });

  test('release of non-held id is a no-op', () => {
    lock = new ProcessingLock();
    expect(() => lock!.release('unknown')).not.toThrow();
  });
});
