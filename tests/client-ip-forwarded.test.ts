import { describe, expect, test, vi } from 'vitest';

vi.mock('../src/config.js', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  TRUST_PROXY: true,
  TRUST_PROXY_HOPS: 1,
}));

const { clientIpFromForwardedFor, getClientIp } =
  await import('../src/utils.js');

function context(headers: Record<string, string>, remote = '127.0.0.1') {
  return {
    req: { header: (name: string) => headers[name.toLowerCase()] },
    env: { incoming: { socket: { remoteAddress: remote } } },
  };
}

describe('clientIpFromForwardedFor', () => {
  test('takes the entry appended by the trusted proxy, not the spoofable first one', () => {
    expect(clientIpFromForwardedFor('203.0.113.9', 1)).toBe('203.0.113.9');
    expect(clientIpFromForwardedFor('1.2.3.4, 203.0.113.9', 1)).toBe(
      '203.0.113.9',
    );
    expect(clientIpFromForwardedFor('1.2.3.4, 5.6.7.8, 203.0.113.9', 1)).toBe(
      '203.0.113.9',
    );
  });

  test('counts trusted hops from the right', () => {
    // Cloudflare in front of Caddy: client, then the CDN edge.
    expect(
      clientIpFromForwardedFor('6.6.6.6, 198.51.100.4, 172.68.1.1', 2),
    ).toBe('198.51.100.4');
    // A chain shorter than the hop count was built by trusted proxies only.
    expect(clientIpFromForwardedFor('198.51.100.4', 3)).toBe('198.51.100.4');
  });

  test('normalizes ports and IPv6, and refuses malformed entries', () => {
    expect(clientIpFromForwardedFor('x, 203.0.113.9:51234', 1)).toBe(
      '203.0.113.9',
    );
    expect(clientIpFromForwardedFor('x, [2001:db8::7]:443', 1)).toBe(
      '2001:db8::7',
    );
    expect(clientIpFromForwardedFor('2001:db8::7', 1)).toBe('2001:db8::7');
    expect(clientIpFromForwardedFor('1.2.3.4, not-an-ip', 1)).toBeNull();
    expect(clientIpFromForwardedFor(' , ', 1)).toBeNull();
  });
});

describe('getClientIp behind a trusted proxy', () => {
  test('ignores a client-supplied leading hop', () => {
    expect(
      getClientIp(
        context({ 'x-forwarded-for': '10.0.0.1, 10.0.0.2, 198.51.100.20' }),
      ),
    ).toBe('198.51.100.20');
  });

  test('uses X-Real-IP only when there is no X-Forwarded-For', () => {
    expect(getClientIp(context({ 'x-real-ip': '198.51.100.21' }))).toBe(
      '198.51.100.21',
    );
    expect(
      getClientIp(
        context({
          'x-forwarded-for': '198.51.100.22',
          'x-real-ip': '6.6.6.6',
        }),
      ),
    ).toBe('198.51.100.22');
  });

  test('falls back to the socket address for a malformed chain', () => {
    expect(
      getClientIp(context({ 'x-forwarded-for': 'evil<script>' }, '::1')),
    ).toBe('::1');
  });
});
