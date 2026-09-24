import { spawnSync } from 'node:child_process';

import { CronExpressionParser } from 'cron-parser';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { resolveSchedulerTimezone } from '../src/config.js';

// `TZ` is read by three different parsers: cron-parser (luxon) for the
// scheduler, Intl for the agent runner's clock, and libc / Node's local clock
// in every child process src/index.ts starts after exporting the resolved zone.
// The resolved value must mean the same clock to all of them, and an unusable
// value must fall back instead of failing every cron task operation.

const FROM = new Date('2026-01-01T00:00:00.000Z');

function nextNineAm(timezone: string): string {
  return CronExpressionParser.parse('0 9 * * *', {
    tz: timezone,
    currentDate: FROM,
  })
    .next()
    .toDate()
    .toISOString();
}

/** How a child process started with TZ=timezone reads a local wall time. */
function childLocalTimeToIso(timezone: string, localTime: string): string {
  const child = spawnSync(
    process.execPath,
    [
      '-e',
      `process.stdout.write(new Date(${JSON.stringify(localTime)}).toISOString())`,
    ],
    { env: { ...process.env, TZ: timezone }, encoding: 'utf8' },
  );
  expect(child.status).toBe(0);
  return child.stdout;
}

describe('scheduler timezone resolution', () => {
  test('keeps an IANA zone name from TZ', () => {
    expect(resolveSchedulerTimezone('Asia/Shanghai', 'UTC', 'UTC')).toEqual({
      timezone: 'Asia/Shanghai',
      source: 'env',
      invalidValue: null,
      libcIncompatibleValue: null,
    });
  });

  test.each([
    ['asia/shanghai', 'Asia/Shanghai'],
    ['AMERICA/NEW_YORK', 'America/New_York'],
    ['etc/gmt-8', 'Etc/GMT-8'],
    ['utc', 'UTC'],
  ])(
    'case-insensitive IANA spelling %j is exported as %j',
    (value, timezone) => {
      // glibc looks TZ up case-sensitively; a miscased name silently runs
      // child processes in UTC while the scheduler uses the real zone.
      expect(resolveSchedulerTimezone(value, 'UTC', 'UTC')).toMatchObject({
        timezone,
        source: 'env',
        invalidValue: null,
      });
    },
  );

  test('alias names are kept instead of rewritten to legacy canonical ids', () => {
    // Intl canonicalizes Asia/Kolkata to the legacy Asia/Calcutta, which some
    // zoneinfo installs no longer ship.
    expect(
      resolveSchedulerTimezone('Asia/Kolkata', 'UTC', 'UTC'),
    ).toMatchObject({
      timezone: 'Asia/Kolkata',
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
        libcIncompatibleValue: null,
      },
    );
  });

  test('an empty TZ falls back without being reported as invalid', () => {
    expect(resolveSchedulerTimezone('   ', 'Asia/Tokyo', 'UTC')).toEqual({
      timezone: 'Asia/Tokyo',
      source: 'system',
      invalidValue: null,
      libcIncompatibleValue: null,
    });
  });

  test.each([
    {
      value: 'UTC+8',
      timezone: 'Etc/GMT-8',
      nineAm: '2026-01-01T01:00:00.000Z',
    },
    {
      value: 'utc-5',
      timezone: 'Etc/GMT+5',
      nineAm: '2026-01-01T14:00:00.000Z',
    },
    {
      value: 'UTC-5',
      timezone: 'Etc/GMT+5',
      nineAm: '2026-01-01T14:00:00.000Z',
    },
    {
      value: '+08:00',
      timezone: 'Etc/GMT-8',
      nineAm: '2026-01-01T01:00:00.000Z',
    },
    { value: 'UTC+0', timezone: 'UTC', nineAm: '2026-01-01T09:00:00.000Z' },
  ])(
    'whole-hour offset $value keeps its cron clock as $timezone for every process',
    ({ value, timezone, nineAm }) => {
      // cron-parser reads UTC-5 as UTC-5, so the scheduler already fired at
      // 14:00Z; the exported value must not move it.
      expect(nextNineAm(value)).toBe(nineAm);
      const resolved = resolveSchedulerTimezone(value, 'Asia/Tokyo', 'UTC');
      expect(resolved).toEqual({
        timezone,
        source: 'env',
        invalidValue: null,
        libcIncompatibleValue: null,
      });
      expect(nextNineAm(resolved.timezone)).toBe(nineAm);
      // Child processes read the exported TZ with POSIX semantics, where the
      // raw "UTC-5" would mean UTC+5; the Etc/GMT name reads identically.
      expect(
        childLocalTimeToIso(resolved.timezone, '2026-01-01T09:00:00'),
      ).toBe(nineAm);
    },
  );

  test('a sub-hour offset keeps its cron clock and is flagged for libc', () => {
    expect(nextNineAm('UTC+05:30')).toBe('2026-01-01T03:30:00.000Z');
    const resolved = resolveSchedulerTimezone('UTC+05:30', 'Asia/Tokyo', 'UTC');
    expect(resolved).toEqual({
      timezone: '+05:30',
      source: 'env',
      invalidValue: null,
      libcIncompatibleValue: 'UTC+05:30',
    });
    expect(nextNineAm(resolved.timezone)).toBe('2026-01-01T03:30:00.000Z');
    // The agent runner formats its clock through Intl, which rejects "UTC+05:30".
    expect(
      new Intl.DateTimeFormat('en-US', {
        timeZone: resolved.timezone,
        timeZoneName: 'longOffset',
      }).format(FROM),
    ).toContain('GMT+05:30');
  });

  test.each([
    'GMT+8',
    'GMT+0800',
    'GMT+8 ',
    'CST-8',
    'Not/AZone',
    'local',
    'UTC+15',
  ])(
    'unusable TZ %j falls back to the system zone and is reported',
    (value) => {
      expect(resolveSchedulerTimezone(value, 'Asia/Tokyo', 'UTC')).toEqual({
        timezone: 'Asia/Tokyo',
        source: 'system',
        invalidValue: value.trim(),
        libcIncompatibleValue: null,
      });
    },
  );

  test('falls back to the built-in default when the system zone is unusable', () => {
    expect(resolveSchedulerTimezone('Not/AZone', 'Also/Bad', 'UTC')).toEqual({
      timezone: 'UTC',
      source: 'fallback',
      invalidValue: 'Not/AZone',
      libcIncompatibleValue: null,
    });
  });

  test('only an IANA system zone is used as a fallback target', () => {
    // An invalid TZ can make the runtime report an offset zone as the system
    // zone; exporting it would leave libc on UTC.
    expect(
      resolveSchedulerTimezone('GMT+8', '+08:00', 'Asia/Shanghai'),
    ).toEqual({
      timezone: 'Asia/Shanghai',
      source: 'fallback',
      invalidValue: 'GMT+8',
      libcIncompatibleValue: null,
    });
  });
});

describe('TIMEZONE at startup', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function loadTimezone(tz: string) {
    vi.stubEnv('TZ', tz);
    vi.resetModules();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { TIMEZONE } = await import('../src/config.js');
    return {
      TIMEZONE,
      warnings: warn.mock.calls.map((call) => String(call[0])),
    };
  }

  test('an unusable TZ does not fail startup; it falls back with a warning', async () => {
    const { TIMEZONE, warnings } = await loadTimezone('Not/AZone');
    expect(TIMEZONE).not.toBe('Not/AZone');
    expect(nextNineAm(TIMEZONE)).toMatch(/^2026-01-0[12]T/);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('TZ="Not/AZone"');
    expect(warnings[0]).toContain(`falling back to "${TIMEZONE}"`);
  });

  test('a whole-hour UTC offset is exported as its Etc/GMT zone without a warning', async () => {
    const { TIMEZONE, warnings } = await loadTimezone('UTC-5');
    expect(TIMEZONE).toBe('Etc/GMT+5');
    expect(warnings).toEqual([]);
  });

  test('a sub-hour UTC offset is kept for cron but warns about libc', async () => {
    const { TIMEZONE, warnings } = await loadTimezone('UTC+05:30');
    expect(TIMEZONE).toBe('+05:30');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('TZ="UTC+05:30"');
    expect(warnings[0]).toContain('IANA');
  });
});
