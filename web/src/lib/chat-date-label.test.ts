import { describe, expect, test } from 'vitest';
import {
  formatChatDateLabel,
  localDayKey,
  msUntilNextLocalDay,
  startOfLocalDay,
} from './chat-date-label';

// Saturday 2026-10-10, local time.
const now = new Date(2026, 9, 10, 15, 30);

describe('formatChatDateLabel', () => {
  test('names today and yesterday regardless of the time of day', () => {
    expect(formatChatDateLabel(new Date(2026, 9, 10, 0, 1), now).label).toBe(
      '今天',
    );
    expect(formatChatDateLabel(new Date(2026, 9, 9, 23, 59), now).label).toBe(
      '昨天',
    );
    expect(formatChatDateLabel(new Date(2026, 9, 9, 0, 0), now).label).toBe(
      '昨天',
    );
  });

  test('uses the weekday earlier this week and the full date before Monday', () => {
    expect(formatChatDateLabel(new Date(2026, 9, 8, 9), now).label).toBe(
      '星期四',
    );
    expect(formatChatDateLabel(new Date(2026, 9, 5, 9), now).label).toBe(
      '星期一',
    );
    expect(formatChatDateLabel(new Date(2026, 9, 4, 9), now).label).toBe(
      '2026年10月4日',
    );
  });

  test('on a Monday only today and yesterday are relative', () => {
    const monday = new Date(2026, 9, 12, 8);
    expect(formatChatDateLabel(new Date(2026, 9, 11, 8), monday).label).toBe(
      '昨天',
    );
    expect(formatChatDateLabel(new Date(2026, 9, 10, 8), monday).label).toBe(
      '2026年10月10日',
    );
  });

  test('keeps the full date with weekday as the tooltip', () => {
    expect(formatChatDateLabel(new Date(2026, 9, 10, 9), now).title).toBe(
      '2026年10月10日星期六',
    );
  });

  test('falls back to the full date for timestamps after today', () => {
    expect(formatChatDateLabel(new Date(2026, 9, 11, 9), now).label).toBe(
      '2026年10月11日',
    );
  });
});

describe('local day helpers', () => {
  test('one key per calendar day', () => {
    expect(localDayKey(new Date(2026, 9, 10, 0, 0))).toBe(
      localDayKey(new Date(2026, 9, 10, 23, 59)),
    );
    expect(localDayKey(new Date(2026, 9, 10))).not.toBe(
      localDayKey(new Date(2026, 9, 11)),
    );
  });

  test('next midnight and start of day', () => {
    expect(msUntilNextLocalDay(new Date(2026, 9, 10, 23, 59, 0))).toBe(60_000);
    expect(startOfLocalDay(now).getTime()).toBe(
      new Date(2026, 9, 10).getTime(),
    );
  });
});
