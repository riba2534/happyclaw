import { describe, expect, test } from 'vitest';

import {
  isTransientError,
  getReconnectDelay,
  classifyCloseCode,
  RECONNECT_DELAYS,
} from '../src/qq-reconnect.js';

describe('isTransientError', () => {
  test('detects each known transient code via err.code', () => {
    for (const code of [
      'EAI_AGAIN',
      'ENOTFOUND',
      'ECONNRESET',
      'ETIMEDOUT',
      'ECONNREFUSED',
      'UND_ERR_CONNECT_TIMEOUT',
    ]) {
      expect(isTransientError({ code })).toBe(true);
    }
  });

  test('detects transient code embedded in error message', () => {
    expect(
      isTransientError(new Error('getaddrinfo EAI_AGAIN api.sgroup.qq.com')),
    ).toBe(true);
    expect(
      isTransientError(new Error('connect ECONNRESET 1.2.3.4:443')),
    ).toBe(true);
  });

  test('returns false for application errors', () => {
    expect(isTransientError(new Error('QQ API failed (401): bad token'))).toBe(
      false,
    );
    expect(isTransientError({ code: 'ENOSPC' })).toBe(false);
  });

  test('returns false for non-error inputs', () => {
    expect(isTransientError(null)).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
    expect(isTransientError('EAI_AGAIN as string, not error')).toBe(false);
    expect(isTransientError(42)).toBe(false);
    expect(isTransientError({})).toBe(false);
  });

  test('ignores non-string code field', () => {
    expect(isTransientError({ code: 1234 })).toBe(false);
  });
});

describe('getReconnectDelay', () => {
  test('default delay table is the openclaw-aligned step ladder', () => {
    expect(RECONNECT_DELAYS).toEqual([
      1_000, 2_000, 5_000, 10_000, 30_000, 60_000,
    ]);
  });

  test('returns the matching step for early attempts', () => {
    expect(getReconnectDelay(0)).toBe(1_000);
    expect(getReconnectDelay(1)).toBe(2_000);
    expect(getReconnectDelay(2)).toBe(5_000);
    expect(getReconnectDelay(3)).toBe(10_000);
    expect(getReconnectDelay(4)).toBe(30_000);
    expect(getReconnectDelay(5)).toBe(60_000);
  });

  test('caps at the final step for high attempts', () => {
    expect(getReconnectDelay(6)).toBe(60_000);
    expect(getReconnectDelay(50)).toBe(60_000);
    expect(getReconnectDelay(99)).toBe(60_000);
  });

  test('clamps negative attempts to the first step', () => {
    expect(getReconnectDelay(-1)).toBe(1_000);
    expect(getReconnectDelay(-100)).toBe(1_000);
  });

  test('honors a custom delay table', () => {
    const custom = [500, 1500];
    expect(getReconnectDelay(0, custom)).toBe(500);
    expect(getReconnectDelay(1, custom)).toBe(1500);
    expect(getReconnectDelay(2, custom)).toBe(1500);
  });
});

describe('classifyCloseCode', () => {
  test('4004 → refresh-token (invalid token)', () => {
    expect(classifyCloseCode(4004)).toEqual({ kind: 'refresh-token' });
  });

  test('4008 → rate-limit', () => {
    expect(classifyCloseCode(4008)).toEqual({ kind: 'rate-limit' });
  });

  test('4900–4913 inclusive → reset-session', () => {
    expect(classifyCloseCode(4900)).toEqual({ kind: 'reset-session' });
    expect(classifyCloseCode(4906)).toEqual({ kind: 'reset-session' });
    expect(classifyCloseCode(4913)).toEqual({ kind: 'reset-session' });
  });

  test('boundaries around 4900–4913 fall back to normal', () => {
    expect(classifyCloseCode(4899)).toEqual({ kind: 'normal' });
    expect(classifyCloseCode(4914)).toEqual({ kind: 'normal' });
  });

  test('common WebSocket codes are normal', () => {
    expect(classifyCloseCode(1000)).toEqual({ kind: 'normal' });
    expect(classifyCloseCode(1001)).toEqual({ kind: 'normal' });
    expect(classifyCloseCode(1006)).toEqual({ kind: 'normal' });
    expect(classifyCloseCode(4000)).toEqual({ kind: 'normal' });
  });

  test('null / undefined → normal', () => {
    expect(classifyCloseCode(null)).toEqual({ kind: 'normal' });
    expect(classifyCloseCode(undefined)).toEqual({ kind: 'normal' });
  });
});

/**
 * Regression scenario for the production incident on 2026-05-15:
 *
 * Around 05:40 UTC the QQ gateway DNS started failing with EAI_AGAIN. The
 * old reconnect loop used exponential backoff capped at 60s with a budget
 * of only 10 attempts — meaning ~3 minutes of DNS trouble killed the bot
 * permanently. The fix has two arms:
 *   1. Transient errors don't burn the attempt budget.
 *   2. Once the budget is exhausted, fall back to a long-tail keepalive
 *      instead of a hard "give up".
 *
 * This is a documentation test that exercises the helpers with the actual
 * error shape we'd see during the incident.
 */
describe('regression: 2026-05-15 DNS outage', () => {
  test('the production EAI_AGAIN error is recognized as transient', () => {
    const err: NodeJS.ErrnoException = Object.assign(
      new Error('getaddrinfo EAI_AGAIN api.sgroup.qq.com'),
      { code: 'EAI_AGAIN', syscall: 'getaddrinfo', hostname: 'api.sgroup.qq.com' },
    );
    expect(isTransientError(err)).toBe(true);
  });

  test('1006 abnormal closure that follows the EAI_AGAIN is normal', () => {
    // The DNS failure shows up first as ws.on('error'); the close that
    // follows usually carries 1006 (no close frame). We must not treat
    // 1006 as a special case — the transient-error path drives the retry.
    expect(classifyCloseCode(1006)).toEqual({ kind: 'normal' });
  });
});
