/**
 * xAI Grok PKCE OIDC (auth.x.ai public Grok CLI client).
 *
 * Browser sees only the authorize URL / pasted callback. Access and refresh
 * tokens stay on the server and are sealed before persist.
 */

import { createHash, randomBytes } from 'node:crypto';

import { WEB_PORT } from './config.js';
import { codexTokenExpiresSoon } from './codex-oauth.js';
import type { GrokCredential } from './grok-translator.js';

export const GROK_OAUTH_ISSUER = 'https://auth.x.ai';
export const GROK_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
export const GROK_OAUTH_SCOPES =
  'openid profile email offline_access grok-cli:access api:access';
export const GROK_OAUTH_TTL_MS = 10 * 60 * 1000;

export { codexTokenExpiresSoon as grokTokenExpiresSoon };

export function grokCredentialExpiresSoon(
  credential: GrokCredential,
  bufferMs: number,
  now = Date.now(),
): boolean {
  if (credential.expiresAt) {
    const expires = Date.parse(credential.expiresAt);
    if (Number.isFinite(expires)) return now + bufferMs >= expires;
  }
  return codexTokenExpiresSoon(credential.accessToken, bufferMs, now);
}

export function grokRedirectUri(port = WEB_PORT): string {
  return `http://127.0.0.1:${port}/callback`;
}

export function generateGrokPkce(): {
  state: string;
  verifier: string;
  challenge: string;
} {
  const state = randomBytes(16).toString('hex');
  const verifier = randomBytes(32).toString('hex');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { state, verifier, challenge };
}

export function grokAuthorizeUrl(
  state: string,
  redirectUri: string,
  challenge: string,
): string {
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: GROK_OAUTH_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: GROK_OAUTH_SCOPES,
    state,
    nonce: state,
    plan: 'generic',
    referrer: 'cli-proxy-api',
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${GROK_OAUTH_ISSUER}/oauth2/authorize?${q.toString().replace(/%20/g, '+')}`;
}

export function decodeGrokEmail(token: string): string {
  const parts = token.split('.');
  if (parts.length !== 3) return '';
  try {
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    const claims = JSON.parse(payload) as {
      email?: string;
      preferred_username?: string;
    };
    return claims.email || claims.preferred_username || '';
  } catch {
    return '';
  }
}

export function grokCredentialSnapshot(credential: GrokCredential): string {
  return JSON.stringify({
    accessToken: credential.accessToken,
    refreshToken: credential.refreshToken,
    idToken: credential.idToken || '',
    expiresAt: credential.expiresAt || '',
    email: credential.email || '',
  });
}

export function enrichGrokCredential(credential: GrokCredential): void {
  if (credential.email) return;
  const sources = [credential.idToken, credential.accessToken].filter(
    (value): value is string => !!value,
  );
  for (const token of sources) {
    const email = decodeGrokEmail(token);
    if (email) {
      credential.email = email;
      return;
    }
  }
}

export function credentialFromGrokTokenResponse(
  raw: unknown,
  previous?: GrokCredential,
): GrokCredential {
  const token = raw as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
    expires_in?: number;
  };
  if (!token.access_token) {
    throw new Error('xAI token response is missing access_token');
  }
  const credential: GrokCredential = {
    accessToken: token.access_token,
    refreshToken: token.refresh_token || previous?.refreshToken || '',
    idToken: token.id_token || previous?.idToken,
    email: previous?.email,
    expiresAt: previous?.expiresAt,
  };
  if (typeof token.expires_in === 'number' && token.expires_in > 0) {
    credential.expiresAt = new Date(
      Date.now() + token.expires_in * 1000,
    ).toISOString();
  }
  enrichGrokCredential(credential);
  return credential;
}

export async function exchangeGrokCode(
  code: string,
  redirectUri: string,
  verifier: string,
  fetchImpl: typeof fetch = fetch,
): Promise<GrokCredential> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: GROK_OAUTH_CLIENT_ID,
    code_verifier: verifier,
  });
  const res = await fetchImpl(`${GROK_OAUTH_ISSUER}/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    },
    body: body.toString(),
  });
  if (res.status < 200 || res.status >= 300) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `xAI token exchange failed (HTTP ${res.status})${text ? `: ${text.slice(0, 200)}` : ''}`,
    );
  }
  return credentialFromGrokTokenResponse(await res.json());
}

export async function refreshGrokCredential(
  stale: GrokCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<GrokCredential> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: stale.refreshToken,
    client_id: GROK_OAUTH_CLIENT_ID,
  });
  const res = await fetchImpl(`${GROK_OAUTH_ISSUER}/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    },
    body: body.toString(),
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`grok token refresh HTTP ${res.status}`);
  }
  const raw = (await res.json()) as unknown;
  return credentialFromGrokTokenResponse(raw, stale);
}
