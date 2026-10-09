import { describe, expect, test, vi } from 'vitest';
import { createOrderedDispatcher } from '../src/ordered-dispatch';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('ordered dispatcher', () => {
  test('delivers synchronously when nothing is pending', () => {
    const dispatch = createOrderedDispatcher(() => {});
    const delivered: string[] = [];
    dispatch('chat', 'a', (item) => delivered.push(item));
    expect(delivered).toEqual(['a']);
  });

  test('keeps per-key order behind an async preparation', async () => {
    const dispatch = createOrderedDispatcher(() => {});
    const delivered: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    dispatch(
      'chat',
      'image',
      (item) => delivered.push(item),
      async (item) => {
        await gate;
        return `${item}:thumb`;
      },
    );
    dispatch('chat', 'text', (item) => delivered.push(item));
    dispatch('other', 'elsewhere', (item) => delivered.push(item));
    expect(delivered).toEqual(['elsewhere']);
    release();
    await tick();
    await tick();
    expect(delivered).toEqual(['elsewhere', 'image:thumb', 'text']);
    // Once drained, the key is synchronous again.
    dispatch('chat', 'later', (item) => delivered.push(item));
    expect(delivered.at(-1)).toBe('later');
  });

  test('reports a failed preparation and keeps delivering later items', async () => {
    const onError = vi.fn();
    const dispatch = createOrderedDispatcher(onError);
    const delivered: string[] = [];
    dispatch(
      'chat',
      'bad',
      (item) => delivered.push(item),
      async () => {
        throw new Error('boom');
      },
    );
    dispatch('chat', 'next', (item) => delivered.push(item));
    await tick();
    await tick();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'chat');
    expect(delivered).toEqual(['next']);
  });
});
