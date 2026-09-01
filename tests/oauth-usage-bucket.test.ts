import { describe, expect, test } from 'vitest';

import {
  parseOAuthUsageBucket,
  type OAuthUsageResponse,
} from '../src/runtime-config.js';

const RESETS_AT = '2026-09-08T00:00:00.000Z';

function parseResponse(raw: Record<string, unknown>): OAuthUsageResponse {
  return {
    five_hour: parseOAuthUsageBucket(raw.five_hour),
    seven_day: parseOAuthUsageBucket(raw.seven_day),
    seven_day_opus: parseOAuthUsageBucket(raw.seven_day_opus),
    seven_day_sonnet: parseOAuthUsageBucket(raw.seven_day_sonnet),
    seven_day_sonnet_max: parseOAuthUsageBucket(raw.seven_day_sonnet_max),
    extra_usage: parseOAuthUsageBucket(raw.extra_usage),
  };
}

describe('parseOAuthUsageBucket', () => {
  test('clamps utilization to the 0–100 integer percent range', () => {
    expect(
      parseOAuthUsageBucket({ utilization: 150, resets_at: RESETS_AT }),
    ).toEqual({ utilization: 100, resets_at: RESETS_AT });
    expect(
      parseOAuthUsageBucket({ utilization: -8, resets_at: RESETS_AT }),
    ).toEqual({ utilization: 0, resets_at: RESETS_AT });
    expect(
      parseOAuthUsageBucket({ utilization: 49.6, resets_at: RESETS_AT }),
    ).toEqual({ utilization: 50, resets_at: RESETS_AT });
  });

  test('falls back to used/usage/credits_used over limit/credits_limit', () => {
    expect(
      parseOAuthUsageBucket({
        used: 25,
        limit: 50,
        resets_at: RESETS_AT,
      }),
    ).toEqual({ utilization: 50, resets_at: RESETS_AT });
    expect(
      parseOAuthUsageBucket({
        usage: 1,
        credits_limit: 4,
        resets_at: RESETS_AT,
      }),
    ).toEqual({ utilization: 25, resets_at: RESETS_AT });
    expect(
      parseOAuthUsageBucket({
        credits_used: 80,
        limit: 100,
        resets_at: RESETS_AT,
      }),
    ).toEqual({ utilization: 80, resets_at: RESETS_AT });
    expect(
      parseOAuthUsageBucket({
        used: 200,
        limit: 100,
        resets_at: RESETS_AT,
      }),
    ).toEqual({ utilization: 100, resets_at: RESETS_AT });
    expect(
      parseOAuthUsageBucket({
        used: 10,
        limit: 0,
        resets_at: RESETS_AT,
      }),
    ).toBeNull();
  });

  test('does not invent 0% for an is_enabled-only bucket', () => {
    expect(parseOAuthUsageBucket({ is_enabled: true })).toBeNull();
    expect(
      parseOAuthUsageBucket({ is_enabled: true, resets_at: RESETS_AT }),
    ).toBeNull();
    expect(
      parseOAuthUsageBucket({
        is_enabled: false,
        resets_at: RESETS_AT,
      }),
    ).toBeNull();
  });

  test('still requires resets_at', () => {
    expect(parseOAuthUsageBucket({ utilization: 12 })).toBeNull();
    expect(parseOAuthUsageBucket({ used: 1, limit: 2 })).toBeNull();
  });

  test('parses seven_day_sonnet_max and extra_usage keys', () => {
    const data = parseResponse({
      seven_day_sonnet_max: {
        utilization: 41,
        resets_at: RESETS_AT,
      },
      extra_usage: {
        is_enabled: true,
        used_credits: 15,
        monthly_limit: 50,
        resets_at: RESETS_AT,
      },
    });

    expect(data.seven_day_sonnet_max).toEqual({
      utilization: 41,
      resets_at: RESETS_AT,
    });
    expect(data.extra_usage).toEqual({
      utilization: 30,
      resets_at: RESETS_AT,
    });
    expect(data.five_hour).toBeNull();
    expect(data.seven_day).toBeNull();
    expect(data.seven_day_opus).toBeNull();
    expect(data.seven_day_sonnet).toBeNull();
  });
});
