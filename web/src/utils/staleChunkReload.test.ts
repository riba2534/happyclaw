// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { isStaleChunkError, reloadForStaleChunk } from './staleChunkReload';

describe('stale chunk recovery', () => {
  const reload = vi.fn();

  beforeEach(() => {
    window.sessionStorage.clear();
    reload.mockReset();
  });

  test('recognizes dynamic import failures only', () => {
    expect(
      isStaleChunkError(
        new TypeError(
          'Failed to fetch dynamically imported module: https://x/assets/CodeMarkdownRenderer-DzgoAf1a.js',
        ),
      ),
    ).toBe(true);
    expect(
      isStaleChunkError(new Error('Cannot read properties of undefined')),
    ).toBe(false);
    expect(isStaleChunkError(null)).toBe(false);
  });

  test('reloads once and then respects the cooldown', () => {
    expect(reloadForStaleChunk(100_000, reload)).toBe(true);
    expect(reloadForStaleChunk(110_000, reload)).toBe(false);
    expect(reloadForStaleChunk(140_001, reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });
});
