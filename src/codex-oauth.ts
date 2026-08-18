/**
 * ChatGPT Codex device-code OAuth and token refresh.
 *
 * Browser only sees a one-time user code. Access/refresh/id tokens stay on
 * the server and are sealed before they are persisted.
 */

import { createHash } from 'node:crypto';

import type { CodexCredential } from './codex-translator.js';

export const CODEX_OAUTH_ISSUER = 'https://auth.openai.com';
export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_OAUTH_TTL_MS = 15 * 60 * 1000;

export interface CodexClaims {
  email: string;
  accountId: string;
  userId: string;
  planType: string;
}

export interface CodexDeviceCode {
  deviceAuthId: string;
  userCode: string;
  interval: number;
}

export interface CodexDeviceGrant {
  authorizationCode: string;
  codeVerifier: string;
}

export function decodeCodexClaims(token: string): CodexClaims {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('invalid JWT');
  }
  const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
  const raw = JSON.parse(payload) as {
    email?: string;
    'https://api.openai.com/profile'?: { email?: string };
    'https://api.openai.com/auth'?: {
      chatgpt_account_id?: string;
      chatgpt_user_id?: string;
      user_id?: string;
      chatgpt_plan_type?: string;
    };
  };
  const auth = raw['https://api.openai.com/auth'] || {};
  return {
    email: raw.email || raw['https://api.openai.com/profile']?.email || '',
    accountId: auth.chatgpt_account_id || '',
    userId: auth.chatgpt_user_id || auth.user_id || '',
    planType: auth.chatgpt_plan_type || '',
  };
}

export function codexTokenExpiresSoon(
  token: string,
  bufferMs: number,
  now = Date.now(),
): boolean {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  try {
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    const claims = JSON.parse(payload) as { exp?: number };
    if (!claims.exp) return true;
    return now + bufferMs >= claims.exp * 1000;
  } catch {
    return true;
  }
}

export function decodeJwtExpMs(token: string): number | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const payload = Buffer.from(parts[1], 'base64url').toString('utf8');
    const claims = JSON.parse(payload) as { exp?: number };
    return typeof claims.exp === 'number' && claims.exp > 0
      ? claims.exp * 1000
      : null;
  } catch {
    return null;
  }
}

export function credentialSnapshot(credential: CodexCredential): string {
  return JSON.stringify({
    accessToken: credential.accessToken,
    refreshToken: credential.refreshToken,
    accountId: credential.accountId,
    idToken: credential.idToken || '',
    email: credential.email || '',
    planType: credential.planType || '',
  });
}

export async function requestCodexDeviceCode(
  fetchImpl: typeof fetch = fetch,
): Promise<CodexDeviceCode> {
  const res = await fetchImpl(
    `${CODEX_OAUTH_ISSUER}/api/accounts/deviceauth/usercode`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: CODEX_OAUTH_CLIENT_ID }),
    },
  );
  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      `OpenAI device authorization unavailable (HTTP ${res.status})`,
    );
  }
  const raw = (await res.json()) as {
    device_auth_id?: string;
    user_code?: string;
    interval?: string | number;
  };
  const interval =
    typeof raw.interval === 'number'
      ? raw.interval
      : Number.parseInt(String(raw.interval || ''), 10);
  if (!raw.device_auth_id || !raw.user_code) {
    throw new Error('OpenAI device authorization response is missing fields');
  }
  return {
    deviceAuthId: raw.device_auth_id,
    userCode: raw.user_code,
    interval: Number.isFinite(interval) && interval >= 1 ? interval : 5,
  };
}

export async function pollCodexDeviceGrant(
  device: CodexDeviceCode,
  options: {
    fetchImpl?: typeof fetch;
    signal?: AbortSignal;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<CodexDeviceGrant> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const endpoint = `${CODEX_OAUTH_ISSUER}/api/accounts/deviceauth/token`;
  for (;;) {
    if (options.signal?.aborted) {
      throw new Error('Codex authorization expired');
    }
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_auth_id: device.deviceAuthId,
        user_code: device.userCode,
      }),
      signal: options.signal,
    });
    if (res.status >= 200 && res.status < 300) {
      const raw = (await res.json()) as {
        authorization_code?: string;
        code_verifier?: string;
      };
      if (!raw.authorization_code || !raw.code_verifier) {
        throw new Error('OpenAI returned an invalid authorization result');
      }
      return {
        authorizationCode: raw.authorization_code,
        codeVerifier: raw.code_verifier,
      };
    }
    if (res.status !== 403 && res.status !== 404) {
      throw new Error(
        `OpenAI device authorization poll failed (HTTP ${res.status})`,
      );
    }
    await sleep(device.interval * 1000);
  }
}

export async function exchangeCodexDeviceGrant(
  grant: CodexDeviceGrant,
  fetchImpl: typeof fetch = fetch,
): Promise<CodexCredential> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: grant.authorizationCode,
    redirect_uri: `${CODEX_OAUTH_ISSUER}/deviceauth/callback`,
    client_id: CODEX_OAUTH_CLIENT_ID,
    code_verifier: grant.codeVerifier,
  });
  const res = await fetchImpl(`${CODEX_OAUTH_ISSUER}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`OpenAI token exchange failed (HTTP ${res.status})`);
  }
  return credentialFromTokenResponse(await res.json());
}

export async function refreshCodexCredential(
  stale: CodexCredential,
  fetchImpl: typeof fetch = fetch,
): Promise<CodexCredential> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: stale.refreshToken,
    client_id: CODEX_OAUTH_CLIENT_ID,
  });
  const res = await fetchImpl(`${CODEX_OAUTH_ISSUER}/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Originator: 'codex_exec',
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    },
    body: body.toString(),
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`codex token refresh HTTP ${res.status}`);
  }
  const raw = (await res.json()) as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
  };
  if (!raw.access_token) {
    throw new Error('codex token refresh returned an invalid response');
  }
  const fresh: CodexCredential = {
    ...stale,
    accessToken: raw.access_token,
  };
  if (raw.refresh_token) fresh.refreshToken = raw.refresh_token;
  if (raw.id_token) fresh.idToken = raw.id_token;
  enrichCredentialFromTokens(fresh);
  return fresh;
}

export function credentialFromTokenResponse(raw: unknown): CodexCredential {
  const token = raw as {
    access_token?: string;
    refresh_token?: string;
    id_token?: string;
  };
  if (!token.access_token || !token.refresh_token) {
    throw new Error('OpenAI token response is missing fields');
  }
  const credential: CodexCredential = {
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    accountId: '',
    idToken: token.id_token,
  };
  enrichCredentialFromTokens(credential);
  return credential;
}

export function enrichCredentialFromTokens(credential: CodexCredential): void {
  const sources = [credential.idToken, credential.accessToken].filter(
    (value): value is string => !!value,
  );
  for (const token of sources) {
    try {
      const claims = decodeCodexClaims(token);
      if (!credential.accountId && claims.accountId) {
        credential.accountId = claims.accountId;
      }
      if (!credential.email && claims.email) credential.email = claims.email;
      if (!credential.planType && claims.planType) {
        credential.planType = claims.planType;
      }
    } catch {
      // ignore malformed JWT; account id may still come from the other token
    }
  }
}

export function verificationUrl(): string {
  return `${CODEX_OAUTH_ISSUER}/codex/device`;
}

export function hashCredential(credential: CodexCredential): string {
  return createHash('sha256')
    .update(credentialSnapshot(credential))
    .digest('hex');
}
