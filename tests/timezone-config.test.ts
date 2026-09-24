import { describe, expect, test } from 'vitest';

import { resolveSchedulerTimezone } from '../src/config.js';

// `TZ` is a documented environment variable, but only a subset of the values
// users write there are valid IANA zone names. Node accepts any TZ string and
// silently falls back to UTC for unknown ones, while the cron parser used by
// the scheduler throws `CronDate: unhandled timestamp` for them. Resolving the
// value once keeps every downstream consumer on a zone name that cron parsing
// actually supports.
describe('scheduler timezone resolution', () => {
  test('keeps an IANA zone name from TZ', () => {
    expect(resolveSchedulerTimezone('Asia/Shanghai', 'UTC', 'UTC')).toEqual({
      timezone: 'Asia/Shanghai',
      source: 'env',
      invalidValue: null,
    });
  });

  test('case-insensitive IANA spellings are accepted', () => {
    expect(resolveSchedulerTimezone('asia/shanghai', 'UTC', 'UTC')).toEqual({
      timezone: 'asia/shanghai',
      source: 'env',
      invalidValue: null,
    });
  });

  test('surrounding whitespace is normalized instead of rejected', () => {
    expect(resolveSchedulerTimezone('  Asia/Shanghai\n', 'UTC', 'UTC')).toEqual(
      {
        timezone: 'Asia/Shanghai',
        source: 'env',
        invalidValue: null,
      },
    );
  });

  test('an empty TZ falls back without being reported as invalid', () => {
    expect(resolveSchedulerTimezone('   ', 'Asia/Tokyo', 'UTC')).toEqual({
      timezone: 'Asia/Tokyo',
      source: 'system',
      invalidValue: null,
    });
  });

  test('a non-IANA fixed-offset TZ falls back to the system zone', () => {
    // The zone users most often copy from container examples: Node ignores it
    // and cron parsing cannot interpret it.
    expect(resolveSchedulerTimezone('GMT+8', 'Asia/Tokyo', 'UTC')).toEqual({
      timezone: 'Asia/Tokyo',
      source: 'system',
      invalidValue: 'GMT+8',
    });
    expect(resolveSchedulerTimezone('GMT+0800', 'Asia/Tokyo', 'UTC')).toEqual({
      timezone: 'Asia/Tokyo',
      source: 'system',
      invalidValue: 'GMT+0800',
    });
  });

  test('falls back to the built-in default when the system zone is unusable', () => {
    expect(resolveSchedulerTimezone('Not/AZone', 'Also/Bad', 'UTC')).toEqual({
      timezone: 'UTC',
      source: 'fallback',
      invalidValue: 'Not/AZone',
    });
  });
});
