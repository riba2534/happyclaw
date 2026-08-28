import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';

import { isLocalInitialSetupAllowed, isLoopbackAddress } from '../src/auth.js';

afterEach(() => {
  delete process.env.ALLOW_REMOTE_SETUP;
});

function setupRequest(options: {
  remoteAddress?: string;
  remoteAddr?: string;
  forwardedFor?: string;
}): Parameters<typeof isLocalInitialSetupAllowed>[0] {
  const headers: Record<string, string> = {};
  if (options.forwardedFor !== undefined) {
    headers['x-forwarded-for'] = options.forwardedFor;
  }
  return {
    req: {
      header: (name: string) => headers[name.toLowerCase()],
      raw:
        options.remoteAddress !== undefined
          ? { socket: { remoteAddress: options.remoteAddress } }
          : undefined,
    },
    env:
      options.remoteAddress !== undefined || options.remoteAddr !== undefined
        ? {
            incoming:
              options.remoteAddress !== undefined
                ? { socket: { remoteAddress: options.remoteAddress } }
                : undefined,
            remoteAddr: options.remoteAddr,
          }
        : undefined,
  };
}

describe('isLoopbackAddress', () => {
  test.each([
    ['127.0.0.1', true, 'IPv4 loopback'],
    ['127.255.255.254', true, '127/8 boundary'],
    ['::1', true, 'IPv6 loopback'],
    ['[::1]', true, 'bracketed IPv6 loopback'],
    ['::1%lo0', true, 'IPv6 loopback with zone id'],
    ['::ffff:127.0.0.1', true, 'IPv4-mapped dotted loopback'],
    ['::ffff:7f00:1', true, 'IPv4-mapped hex loopback'],
    ['localhost', true, 'localhost name'],
    ['8.8.8.8', false, 'public IPv4'],
    ['10.0.0.1', false, 'RFC1918 is not loopback'],
    ['192.168.1.10', false, 'LAN is not loopback'],
    ['::ffff:8.8.8.8', false, 'IPv4-mapped public'],
    ['2001:db8::1', false, 'public IPv6'],
    ['', false, 'empty'],
    [null, false, 'null'],
    ['not-an-ip', false, 'garbage'],
    ['127.0.0.256', false, 'invalid IPv4 octet'],
  ])('%s → %s (%s)', (ip, expected) => {
    expect(isLoopbackAddress(ip)).toBe(expected);
  });
});

describe('isLocalInitialSetupAllowed', () => {
  test('allows a direct loopback client', () => {
    expect(
      isLocalInitialSetupAllowed(setupRequest({ remoteAddress: '127.0.0.1' })),
    ).toBe(true);
    expect(
      isLocalInitialSetupAllowed(setupRequest({ remoteAddress: '::1' })),
    ).toBe(true);
  });

  test('rejects a remote TCP peer even if X-Forwarded-For claims loopback', () => {
    expect(
      isLocalInitialSetupAllowed(
        setupRequest({
          remoteAddress: '203.0.113.10',
          forwardedFor: '127.0.0.1',
        }),
      ),
    ).toBe(false);
  });

  test('rejects a remote client forwarded by a local proxy', () => {
    expect(
      isLocalInitialSetupAllowed(
        setupRequest({
          remoteAddress: '127.0.0.1',
          forwardedFor: '203.0.113.10',
        }),
      ),
    ).toBe(false);
  });

  test('allows a loopback client forwarded by a local proxy', () => {
    expect(
      isLocalInitialSetupAllowed(
        setupRequest({
          remoteAddress: '127.0.0.1',
          forwardedFor: '::1, 127.0.0.1',
        }),
      ),
    ).toBe(true);
  });

  test('rejects an unknown or missing peer address', () => {
    expect(isLocalInitialSetupAllowed(setupRequest({}))).toBe(false);
  });

  test('ALLOW_REMOTE_SETUP=1 allows a remote peer', () => {
    process.env.ALLOW_REMOTE_SETUP = '1';
    expect(
      isLocalInitialSetupAllowed(
        setupRequest({ remoteAddress: '203.0.113.10' }),
      ),
    ).toBe(true);
  });

  test('ALLOW_REMOTE_SETUP=true allows a remote peer', () => {
    process.env.ALLOW_REMOTE_SETUP = 'true';
    expect(
      isLocalInitialSetupAllowed(
        setupRequest({ remoteAddress: '203.0.113.10' }),
      ),
    ).toBe(true);
  });

  test('ALLOW_REMOTE_SETUP=yes is not an escape hatch', () => {
    process.env.ALLOW_REMOTE_SETUP = 'yes';
    expect(
      isLocalInitialSetupAllowed(
        setupRequest({ remoteAddress: '203.0.113.10' }),
      ),
    ).toBe(false);
  });
});

describe('POST /api/auth/setup origin guard', () => {
  test('setup handler refuses remote first-admin unless the request is loopback', () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), 'src/routes/auth.ts'),
      'utf8',
    );
    const setupIdx = source.indexOf("authRoutes.post('/setup'");
    const helperIdx = source.indexOf('isLocalInitialSetupAllowed(c)', setupIdx);
    const createIdx = source.indexOf('createInitialAdminUser(', setupIdx);

    expect(setupIdx).toBeGreaterThan(-1);
    expect(helperIdx).toBeGreaterThan(setupIdx);
    expect(createIdx).toBeGreaterThan(helperIdx);
    expect(source).toContain('ALLOW_REMOTE_SETUP');
  });
});
