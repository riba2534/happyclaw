// ─── ChatGPT/Codex 订阅 — OAuth PKCE 流程 ────────────────────────
//
// 参数与 openai/codex 官方 CLI 源码一致：
// - authorize: codex-rs/tui/src/onboarding/auth.rs（PRODUCTION_LENGTH_AUTH_URL）
// - token 交换: form 编码；refresh: JSON 编码（codex-rs/login/src/oauth/client.rs
//   明确注释 "ChatGPT refresh uses JSON; authorization-code ... use form encoding"）
// - id_token claims: codex-rs/login/src/token_data.rs（auth.chatgpt_account_id 等）

import { createHash, randomBytes } from 'node:crypto';

import {
  CODEX_OAUTH_AUTHORIZE_URL,
  CODEX_OAUTH_CLIENT_ID,
  CODEX_OAUTH_REDIRECT_URI,
  CODEX_OAUTH_SCOPES,
  CODEX_OAUTH_TOKEN_URL,
  type CodexOAuthCredentials,
} from './types.js';

export interface CodexPkcePair {
  codeVerifier: string;
  codeChallenge: string;
}

export interface CodexTokenResponse {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  expiresAt: number;
}

/** 生成 PKCE S256 对（verifier 为 43-128 字符 base64url，与官方一致）。 */
export function generateCodexPkcePair(): CodexPkcePair {
  const codeVerifier = randomBytes(64).toString('base64url');
  const codeChallenge = createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  return { codeVerifier, codeChallenge };
}

/** 构造授权 URL。redirect_uri 固定 localhost:1455，用户把回调 URL 粘贴回来完成登录。 */
export function buildCodexAuthorizeUrl(
  state: string,
  codeChallenge: string,
): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CODEX_OAUTH_CLIENT_ID,
    redirect_uri: CODEX_OAUTH_REDIRECT_URI,
    scope: CODEX_OAUTH_SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    state,
    originator: 'codex_cli_rs',
  });
  return `${CODEX_OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

function toTokenResponse(raw: RawTokenResponse): CodexTokenResponse {
  if (!raw.access_token) {
    throw new Error('Codex OAuth response missing access_token');
  }
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token ?? null,
    idToken: raw.id_token ?? null,
    expiresAt: Date.now() + (raw.expires_in ?? 3600) * 1000,
  };
}

async function postTokenEndpoint(
  init: RequestInit,
): Promise<CodexTokenResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(CODEX_OAUTH_TOKEN_URL, {
      ...init,
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => ({}))) as RawTokenResponse;
    if (!response.ok) {
      const detail =
        typeof (body as Record<string, unknown>).error === 'string'
          ? String((body as Record<string, unknown>).error)
          : `HTTP ${response.status}`;
      throw new Error(`Codex OAuth token endpoint rejected: ${detail}`);
    }
    return toTokenResponse(body);
  } finally {
    clearTimeout(timeout);
  }
}

/** 用授权码换 token（form 编码）。 */
export async function exchangeCodexCode(
  code: string,
  codeVerifier: string,
): Promise<CodexTokenResponse> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CODEX_OAUTH_CLIENT_ID,
    code,
    redirect_uri: CODEX_OAUTH_REDIRECT_URI,
    code_verifier: codeVerifier,
  });
  return postTokenEndpoint({
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: form.toString(),
  });
}

/** 刷新 token（JSON 编码 — 官方 CLI 明确使用 JSON 而非 form）。 */
export async function refreshCodexToken(
  refreshToken: string,
): Promise<CodexTokenResponse> {
  return postTokenEndpoint({
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: CODEX_OAUTH_CLIENT_ID,
      refresh_token: refreshToken,
    }),
  });
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  try {
    return JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf-8'),
    ) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface CodexIdTokenClaims {
  accountId: string | null;
  planType: string | null;
  email: string | null;
}

/** 解析 id_token JWT 中的 ChatGPT 账号 claim。 */
export function parseCodexIdToken(idToken: string | null): CodexIdTokenClaims {
  if (!idToken) {
    return { accountId: null, planType: null, email: null };
  }
  const payload = decodeJwtPayload(idToken);
  if (!payload) {
    return { accountId: null, planType: null, email: null };
  }
  const auth = (payload.auth ?? null) as Record<string, unknown> | null;
  const profile = (payload.profile ?? null) as Record<string, unknown> | null;
  const email =
    (typeof payload.email === 'string' && payload.email) ||
    (typeof profile?.email === 'string' && profile.email) ||
    null;
  return {
    accountId:
      typeof auth?.chatgpt_account_id === 'string'
        ? auth.chatgpt_account_id
        : null,
    planType:
      typeof auth?.chatgpt_plan_type === 'string'
        ? auth.chatgpt_plan_type
        : null,
    email: typeof email === 'string' ? email : null,
  };
}

/** 把 token 响应组装成可持久化的凭据结构。 */
export function buildCodexCredentials(
  token: CodexTokenResponse,
  previous?: CodexOAuthCredentials | null,
): CodexOAuthCredentials {
  const claims = parseCodexIdToken(token.idToken);
  return {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken ?? previous?.refreshToken ?? '',
    expiresAt: token.expiresAt,
    accountId: claims.accountId ?? previous?.accountId ?? null,
    planType: claims.planType ?? previous?.planType ?? null,
    email: claims.email ?? previous?.email ?? null,
    updatedAt: new Date().toISOString(),
  };
}
