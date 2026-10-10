// @vitest-environment happy-dom
import { beforeEach, describe, expect, test, vi } from 'vitest';
import {
  installStaleChunkRecovery,
  isStaleChunkError,
  markChunkErrorHandled,
  reloadForStaleChunk,
} from './staleChunkReload';

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

describe('vite:preloadError recovery', () => {
  const reload = vi.fn();
  installStaleChunkRecovery(reload);

  beforeEach(() => {
    window.sessionStorage.clear();
    reload.mockReset();
  });

  function preloadError(payload: unknown) {
    const event = new Event('vite:preloadError', { cancelable: true });
    Object.assign(event, { payload });
    window.dispatchEvent(event);
    return event;
  }

  test('reloads for a failed import that nobody recovers from', async () => {
    const event = preloadError(new TypeError('Failed to fetch dynamically'));
    // The importer still receives the error.
    expect(event.defaultPrevented).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reload).toHaveBeenCalledTimes(1);
  });

  test('leaves the page alone when the importer recovers in place', async () => {
    const error = new TypeError('Failed to fetch dynamically');
    preloadError(error);
    await Promise.resolve().then(() => markChunkErrorHandled(error));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reload).not.toHaveBeenCalled();
  });
});
