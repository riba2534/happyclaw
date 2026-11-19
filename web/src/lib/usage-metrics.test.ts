import { describe, expect, test } from 'vitest';

import {
  cacheHitRate,
  formatHitRate,
  formatTokensPerSecond,
  generationTokensPerSecond,
} from './usage-metrics';

describe('cacheHitRate', () => {
  test('cache reads over all input', () => {
    expect(
      cacheHitRate({
        inputTokens: 100,
        cacheReadInputTokens: 800,
        cacheCreationInputTokens: 100,
      }),
    ).toBe(0.8);
  });

  test('null without input', () => {
    expect(cacheHitRate({})).toBeNull();
    expect(cacheHitRate({ inputTokens: 0 })).toBeNull();
  });

  test('formats with one decimal', () => {
    expect(formatHitRate(0.8734)).toBe('87.3%');
    expect(formatHitRate(null)).toBe('—');
  });
});

describe('generationTokensPerSecond', () => {
  test('streamed output over streaming time', () => {
    expect(
      generationTokensPerSecond({ streamOutputTokens: 500, streamMs: 10_000 }),
    ).toBe(50);
  });

  test('null when nothing was timed', () => {
    expect(generationTokensPerSecond({})).toBeNull();
    expect(
      generationTokensPerSecond({ streamOutputTokens: 5, streamMs: 0 }),
    ).toBeNull();
  });

  test('formats', () => {
    expect(formatTokensPerSecond(42.26)).toBe('42.3 tok/s');
    expect(formatTokensPerSecond(123.6)).toBe('124 tok/s');
  });
});
