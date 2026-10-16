import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  acknowledgeTaskRunKey,
  clearTaskRunKeysForTest,
  getPendingTaskRunKey,
} from '../web/src/utils/task-run-idempotency.js';

afterEach(() => {
  clearTaskRunKeysForTest();
  delete (globalThis as any).localStorage;
  vi.restoreAllMocks();
});

describe('Run Now idempotency key lifecycle', () => {
  test('reuses an unacknowledged key and rotates only after success', () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000);
    const values = new Map<string, string>();
    (globalThis as any).localStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222')
      .mockReturnValueOnce('33333333-3333-4333-8333-333333333333');

    const first = getPendingTaskRunKey('user-1', 'task-1', 1_000);
    clearTaskRunKeysForTest(); // simulate a page refresh
    expect(getPendingTaskRunKey('user-1', 'task-1', 2_000)).toBe(first);
    expect(getPendingTaskRunKey('user-2', 'task-1', 2_000)).not.toBe(first);
    acknowledgeTaskRunKey('user-1', 'task-1', 'a-stale-key');
    expect(getPendingTaskRunKey('user-1', 'task-1', 2_000)).toBe(first);

    acknowledgeTaskRunKey('user-1', 'task-1', first);
    expect(getPendingTaskRunKey('user-1', 'task-1', 2_000)).toBe(
      '33333333-3333-4333-8333-333333333333',
    );
  });

  test('expires stale persisted keys after 24 hours', () => {
    const values = new Map<string, string>();
    (globalThis as any).localStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222');
    expect(getPendingTaskRunKey('user-1', 'task-1', 0)).toContain('11111111');
    clearTaskRunKeysForTest();
    expect(
      getPendingTaskRunKey('user-1', 'task-1', 24 * 60 * 60 * 1000),
    ).toContain('22222222');
    const repaired = JSON.parse(
      values.get('happyclaw:task-run-idempotency:user-1')!,
    );
    expect(repaired['task-1']).toEqual({
      key: '22222222-2222-4222-8222-222222222222',
      createdAt: 24 * 60 * 60 * 1000,
    });
  });

  test.each([
    ['null', 'null'],
    ['array', '[]'],
    ['string', '"invalid"'],
  ])('repairs a persisted %s root without throwing', (_label, raw) => {
    const values = new Map<string, string>([
      ['happyclaw:task-run-idempotency:user-1', raw],
      [
        'happyclaw:task-run-idempotency:user-2',
        JSON.stringify({
          untouched: { key: 'other-user-key', createdAt: 900 },
        }),
      ],
    ]);
    (globalThis as any).localStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      '11111111-1111-4111-8111-111111111111',
    );

    expect(getPendingTaskRunKey('user-1', 'task-1', 1_000)).toBe(
      '11111111-1111-4111-8111-111111111111',
    );
    expect(
      JSON.parse(values.get('happyclaw:task-run-idempotency:user-1')!),
    ).toEqual({
      'task-1': {
        key: '11111111-1111-4111-8111-111111111111',
        createdAt: 1_000,
      },
    });
    expect(
      JSON.parse(values.get('happyclaw:task-run-idempotency:user-2')!),
    ).toEqual({
      untouched: { key: 'other-user-key', createdAt: 900 },
    });
  });

  test('keeps valid entries while removing malformed and expired siblings', () => {
    const storage = 'happyclaw:task-run-idempotency:user-1';
    const values = new Map<string, string>([
      [
        storage,
        JSON.stringify({
          valid: { key: 'valid-key', createdAt: 900 },
          missingKey: { createdAt: 900 },
          emptyKey: { key: '   ', createdAt: 900 },
          badTimestamp: { key: 'bad-time', createdAt: '900' },
          nonFiniteTimestamp: { key: 'not-finite', createdAt: null },
          notAnEntry: 'invalid',
          expired: { key: 'expired-key', createdAt: -86_399_001 },
        }),
      ],
    ]);
    (globalThis as any).localStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    expect(getPendingTaskRunKey('user-1', 'valid', 1_000)).toBe('valid-key');
    expect(JSON.parse(values.get(storage)!)).toEqual({
      valid: { key: 'valid-key', createdAt: 900 },
    });
  });

  test('rejects a timestamp in the future after a local clock correction', () => {
    const storage = 'happyclaw:task-run-idempotency:user-1';
    const values = new Map<string, string>([
      [
        storage,
        JSON.stringify({
          'task-1': { key: 'future-key', createdAt: 1_001 },
        }),
      ],
    ]);
    (globalThis as any).localStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };
    vi.spyOn(crypto, 'randomUUID').mockReturnValue(
      '22222222-2222-4222-8222-222222222222',
    );

    expect(getPendingTaskRunKey('user-1', 'task-1', 1_000)).toBe(
      '22222222-2222-4222-8222-222222222222',
    );
    expect(JSON.parse(values.get(storage)!)).toEqual({
      'task-1': {
        key: '22222222-2222-4222-8222-222222222222',
        createdAt: 1_000,
      },
    });
  });

  test('mints and reuses a valid v4 UUID in an insecure context without crypto.randomUUID', () => {
    const values = new Map<string, string>();
    (globalThis as any).localStorage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    const originalDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'crypto',
    );
    const originalCrypto = globalThis.crypto;

    try {
      Object.defineProperty(globalThis, 'crypto', {
        value: {
          getRandomValues: <T extends ArrayBufferView | null>(array: T): T =>
            originalCrypto.getRandomValues(array),
        },
        configurable: true,
        writable: true,
      });

      const first = getPendingTaskRunKey('user-1', 'task-1');
      expect(first).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(getPendingTaskRunKey('user-1', 'task-1')).toBe(first);
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(globalThis, 'crypto', originalDescriptor);
      } else {
        Object.defineProperty(globalThis, 'crypto', {
          value: originalCrypto,
          configurable: true,
          writable: true,
        });
      }
    }
  });
});
