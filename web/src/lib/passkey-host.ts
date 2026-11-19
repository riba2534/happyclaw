/**
 * Whether this page can use passkeys at all: WebAuthn needs a secure
 * context, and its RP ID must be a domain, so an IPv4 or IPv6 literal
 * (127.0.0.1 included) never works, even over HTTPS.
 */
export function isIpHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(':');
}
