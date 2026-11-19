import { describe, expect, test } from 'vitest';

import {
  cacheHitRate,
  deepSeekPricePeriod,
  formatHitRate,
  formatTokensPerSecond,
  generationTokensPerSecond,
  isDeepSeekModel,
} from './usage-metrics';

/** An instant given as Beijing wall-clock time. */
const bj = (wall: string) => new Date(`${wall}+08:00`);

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

describe('deepSeekPricePeriod', () => {
  test('recognises DeepSeek models', () => {
    expect(isDeepSeekModel('deepseek-v4-pro')).toBe(true);
    expect(isDeepSeekModel('DeepSeek-V4.1-Flash')).toBe(true);
    expect(isDeepSeekModel('claude-opus-5-5')).toBe(false);
    expect(isDeepSeekModel(undefined)).toBe(false);
  });

  test('weekday morning peak ends at noon', () => {
    const period = deepSeekPricePeriod(bj('2026-11-16T10:30:00')); // Monday
    expect(period.peak).toBe(true);
    expect(period.until).toEqual(bj('2026-11-16T12:00:00'));
  });

  test('lunch break is off-peak until 14:00', () => {
    const period = deepSeekPricePeriod(bj('2026-11-16T12:00:00'));
    expect(period.peak).toBe(false);
    expect(period.until).toEqual(bj('2026-11-16T14:00:00'));
  });

  test('peak window end is exclusive and start inclusive', () => {
    expect(deepSeekPricePeriod(bj('2026-11-16T17:59:59')).peak).toBe(true);
    expect(deepSeekPricePeriod(bj('2026-11-16T18:00:00')).peak).toBe(false);
    expect(deepSeekPricePeriod(bj('2026-11-16T09:00:00')).peak).toBe(true);
  });

  test('Friday evening is off-peak until Monday 9:00', () => {
    const period = deepSeekPricePeriod(bj('2026-11-20T19:00:00'));
    expect(period.peak).toBe(false);
    expect(period.until).toEqual(bj('2026-11-23T09:00:00'));
  });

  test('statutory holidays are off-peak all day', () => {
    // National Day 2026: Thursday 1 October to Wednesday 7 October.
    expect(deepSeekPricePeriod(bj('2026-10-05T10:00:00')).peak).toBe(false);
    expect(deepSeekPricePeriod(bj('2026-10-05T10:00:00')).until).toEqual(
      bj('2026-10-08T09:00:00'),
    );
    // Spring Festival 2027 (5–13 February).
    expect(deepSeekPricePeriod(bj('2027-02-08T10:00:00')).peak).toBe(false);
  });

  test('a make-up workday on a weekend stays off-peak', () => {
    // Saturday 10 October 2026 is 调休上班; DeepSeek counts weekends off-peak.
    expect(deepSeekPricePeriod(bj('2026-10-10T10:00:00')).peak).toBe(false);
  });

  test('uses Beijing time whatever the instant', () => {
    // 01:30 UTC on Monday is 09:30 in Beijing.
    expect(deepSeekPricePeriod(new Date('2026-11-16T01:30:00Z')).peak).toBe(
      true,
    );
  });
});
