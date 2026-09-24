/**
 * UF-329-1: dual-name session cookie residue after logout.
 * clearSessionCookie / setSessionCookie must address BOTH
 * __Host-happyclaw_session and happyclaw_session.
 */
process.env.WEB_SESSION_SECRET =
  process.env.WEB_SESSION_SECRET ||
  'test-session-secret-for-uf329-cookie-clear';
process.env.TRUST_PROXY = 'true';

import { describe, expect, test } from 'vitest';
import {
  clearSessionCookie,
  setSessionCookie,
  headersWithSessionCookies,
  generateSessionToken,
} from '../src/auth.ts';
import {
  SESSION_COOKIE_NAME_SECURE,
  SESSION_COOKIE_NAME_PLAIN,
} from '../src/config.ts';

function plainCtx() {
  return {
    req: {
      header: (_name?: string) => undefined,
      url: 'http://localhost:3000/api/auth/logout',
    },
  };
}

function secureCtx() {
  return {
    req: {
      header: (name?: string) =>
        name?.toLowerCase() === 'x-forwarded-proto' ? 'https' : undefined,
      url: 'https://localhost:3000/api/auth/logout',
    },
  };
}

function findCookie(headers: string[], name: string): string | undefined {
  return headers.find((h) => h.startsWith(name + '='));
}

describe('UF-329-1 dual-name session cookie clear/set', () => {
  test('clearSessionCookie always Max-Age=0 BOTH names (secure request)', () => {
    const cookies = clearSessionCookie(secureCtx());
    expect(Array.isArray(cookies)).toBe(true);
    expect(cookies.length).toBeGreaterThanOrEqual(2);

    const host = findCookie(cookies, SESSION_COOKIE_NAME_SECURE);
    const plain = findCookie(cookies, SESSION_COOKIE_NAME_PLAIN);
    expect(host).toBeDefined();
    expect(plain).toBeDefined();
    expect(host!).toMatch(/Max-Age=0/);
    expect(host!).toMatch(/;\s*Secure(?:;|$)/);
    expect(plain!).toMatch(/Max-Age=0/);
    // plain clear must NOT require Secure (HTTP jar must accept the expire)
    expect(plain!).not.toMatch(/;\s*Secure(?:;|$)/);
  });

  test('clearSessionCookie always Max-Age=0 BOTH names (plain request)', () => {
    const cookies = clearSessionCookie(plainCtx());
    expect(Array.isArray(cookies)).toBe(true);
    expect(cookies.length).toBeGreaterThanOrEqual(2);

    const host = findCookie(cookies, SESSION_COOKIE_NAME_SECURE);
    const plain = findCookie(cookies, SESSION_COOKIE_NAME_PLAIN);
    expect(host).toBeDefined();
    expect(plain).toBeDefined();
    expect(host!).toMatch(/Max-Age=0/);
    expect(host!).toMatch(/;\s*Secure(?:;|$)/);
    expect(plain!).toMatch(/Max-Age=0/);
  });

  test('setSessionCookie on secure sets __Host- and clears plain', () => {
    const token = generateSessionToken();
    const cookies = setSessionCookie(secureCtx(), token);
    expect(Array.isArray(cookies)).toBe(true);

    const host = findCookie(cookies, SESSION_COOKIE_NAME_SECURE);
    const plain = findCookie(cookies, SESSION_COOKIE_NAME_PLAIN);
    expect(host).toBeDefined();
    expect(plain).toBeDefined();
    expect(host!).toMatch(new RegExp(`^${SESSION_COOKIE_NAME_SECURE}=.+;`));
    expect(host!).toMatch(/Max-Age=\d+/);
    expect(host!).toMatch(/;\s*Secure(?:;|$)/);
    expect(host!).not.toMatch(/Max-Age=0/);
    expect(plain!).toMatch(/Max-Age=0/);
  });

  test('setSessionCookie on plain sets plain and clears __Host- with Secure', () => {
    const token = generateSessionToken();
    const cookies = setSessionCookie(plainCtx(), token);
    expect(Array.isArray(cookies)).toBe(true);

    const host = findCookie(cookies, SESSION_COOKIE_NAME_SECURE);
    const plain = findCookie(cookies, SESSION_COOKIE_NAME_PLAIN);
    expect(host).toBeDefined();
    expect(plain).toBeDefined();
    expect(plain!).toMatch(new RegExp(`^${SESSION_COOKIE_NAME_PLAIN}=.+;`));
    expect(plain!).toMatch(/Max-Age=\d+/);
    expect(plain!).not.toMatch(/Max-Age=0/);
    expect(host!).toMatch(/Max-Age=0/);
    expect(host!).toMatch(/;\s*Secure(?:;|$)/);
  });

  test('headersWithSessionCookies emits multiple Set-Cookie headers', () => {
    const cookies = clearSessionCookie(secureCtx());
    const headers = headersWithSessionCookies(
      { 'Content-Type': 'application/json' },
      cookies,
    );
    const setCookies =
      typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
    expect(setCookies.length).toBe(cookies.length);
    expect(
      setCookies.some((v) => v.startsWith(SESSION_COOKIE_NAME_SECURE + '=')),
    ).toBe(true);
    expect(
      setCookies.some((v) => v.startsWith(SESSION_COOKIE_NAME_PLAIN + '=')),
    ).toBe(true);
    expect(headers.get('Content-Type')).toBe('application/json');
  });

  test('secure logout clear would prevent plain-only residue auth path', () => {
    // Simulate dual-cookie jar after plain→secure login, then secure logout.
    // Browser honors both Max-Age=0 clears → subsequent Cookie header empty
    // → middleware Unauthorized (no SECURE, no PLAIN fallback).
    const cleared = clearSessionCookie(secureCtx());
    const jar = new Map<string, string>();
    jar.set(SESSION_COOKIE_NAME_PLAIN, 'tokenA-signed');
    jar.set(SESSION_COOKIE_NAME_SECURE, 'tokenB-signed');
    for (const line of cleared) {
      const name = line.split('=')[0];
      if (/Max-Age=0/.test(line)) jar.delete(name);
    }
    expect(jar.size).toBe(0);
    // empty jar ⇒ no cookie values for middleware dual-name read
    expect(jar.has(SESSION_COOKIE_NAME_PLAIN)).toBe(false);
    expect(jar.has(SESSION_COOKIE_NAME_SECURE)).toBe(false);
  });
});
