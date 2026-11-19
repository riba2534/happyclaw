/**
 * Wire details of Claude's subscription OAuth: the authorize URL the consent
 * page accepts, the pasted callback input, the JSON token exchange/refresh
 * bodies and the identity fields Anthropic returns next to the tokens.
 *
 * Values mirror the Claude Code CLI bundled in node_modules (2.1.328) — the
 * same client Anthropic expects on these endpoints — so HappyClaw logs in and
 * refreshes exactly like `claude /login` does. Everything here is pure;
 * persistence and network ownership live in claude-oauth-refresh.ts.
 */
import { timingSafeEqual } from 'node:crypto';

import type {
  ClaudeOAuthAccountInfo,
  ClaudeOAuthCredentials,
} from './runtime-config.js';

export const CLAUDE_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
/** CLAUDE_AI_AUTHORIZE_URL: the claude.ai subscription consent page. */
export const CLAUDE_OAUTH_AUTHORIZE_URL =
  'https://claude.com/cai/oauth/authorize';
/** MANUAL_REDIRECT_URL: renders a copyable `code#state` for the operator. */
export const CLAUDE_OAUTH_REDIRECT_URI =
  'https://platform.claude.com/oauth/code/callback';
export const CLAUDE_OAUTH_TOKEN_URL =
  'https://platform.claude.com/v1/oauth/token';
export const CLAUDE_OAUTH_PROFILE_URL =
  'https://api.anthropic.com/api/oauth/profile';
export const CLAUDE_OAUTH_USAGE_URL =
  'https://api.anthropic.com/api/oauth/usage';
/** The beta header the OAuth-authenticated account endpoints expect. */
export const CLAUDE_OAUTH_BETA = 'oauth-2025-04-20';

/**
 * The token endpoint sees the CLI's Axios client; the CLI sets no explicit
 * User-Agent there, so Axios 1.15.2 (bundled by Claude Code 2.1.328) sends
 * its default.
 */
export const CLAUDE_OAUTH_TOKEN_USER_AGENT = 'axios/1.15.2';
/** The CLI's own User-Agent, used for its profile request. */
export const CLAUDE_CODE_USER_AGENT = 'claude-code/2.1.328';

/** Scopes the CLI requests when it refreshes a claude.ai grant. */
export const CLAUDE_OAUTH_REFRESH_SCOPES: readonly string[] = [
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
  'user:plugins',
];
/**
 * Browser consent scopes for a full login. org:create_api_key is accepted
 * only on the authorize URL and is never sent on a refresh.
 */
export const CLAUDE_OAUTH_LOGIN_SCOPES: readonly string[] = [
  'org:create_api_key',
  ...CLAUDE_OAUTH_REFRESH_SCOPES,
];
/** `claude setup-token`: inference only, asked for a one-year lifetime. */
export const CLAUDE_OAUTH_SETUP_TOKEN_SCOPES: readonly string[] = [
  'user:inference',
];
export const CLAUDE_OAUTH_SETUP_TOKEN_EXPIRES_IN = 365 * 24 * 60 * 60;
/** Stored project permissions a rebuilt refresh scope keeps. */
const CARRIED_REFRESH_SCOPES = ['user:projects:read', 'user:projects:write'];
/** Fallback lifetime when a token response omits expires_in. */
export const CLAUDE_OAUTH_DEFAULT_EXPIRES_IN = 8 * 60 * 60;

export type ClaudeOAuthLoginProfile = 'full' | 'setup_token';

export function claudeOAuthScopesForProfile(
  profile: ClaudeOAuthLoginProfile,
): readonly string[] {
  return profile === 'setup_token'
    ? CLAUDE_OAUTH_SETUP_TOKEN_SCOPES
    : CLAUDE_OAUTH_LOGIN_SCOPES;
}

/**
 * Emit the authorize URL with the CLI's parameter order. `code=true` makes
 * the hosted callback render a copyable code; URLSearchParams encodes the
 * space-delimited scope as `+`, as the CLI does.
 */
export function buildClaudeAuthorizeUrl(options: {
  codeChallenge: string;
  state: string;
  profile: ClaudeOAuthLoginProfile;
}): string {
  const url = new URL(CLAUDE_OAUTH_AUTHORIZE_URL);
  url.searchParams.append('code', 'true');
  url.searchParams.append('client_id', CLAUDE_OAUTH_CLIENT_ID);
  url.searchParams.append('response_type', 'code');
  url.searchParams.append('redirect_uri', CLAUDE_OAUTH_REDIRECT_URI);
  url.searchParams.append(
    'scope',
    claudeOAuthScopesForProfile(options.profile).join(' '),
  );
  url.searchParams.append('code_challenge', options.codeChallenge);
  url.searchParams.append('code_challenge_method', 'S256');
  url.searchParams.append('state', options.state);
  return url.toString();
}

/** Hosted callback pages whose URL may be pasted back verbatim. */
const CALLBACK_PAGES = new Set([
  CLAUDE_OAUTH_REDIRECT_URI,
  'https://console.anthropic.com/oauth/code/callback',
]);

/**
 * Accept what an operator copies after consent: the bare code, the
 * `code#state` pair the callback page shows, or the callback page URL. A URL
 * from any other page is rejected rather than mined for parameters.
 */
export function parseClaudeCallbackInput(
  input: string,
): { code: string; state: string | null } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    if (!CALLBACK_PAGES.has(`${url.origin}${url.pathname}`)) return null;
    const code = splitCodeAndState(url.searchParams.get('code') ?? '');
    if (!code.code) return null;
    return {
      code: code.code,
      state: url.searchParams.get('state') || code.state,
    };
  }
  if (/^\??code=/.test(trimmed)) {
    const params = new URLSearchParams(trimmed.replace(/^\?/, ''));
    const code = splitCodeAndState(params.get('code') ?? '');
    if (!code.code) return null;
    return { code: code.code, state: params.get('state') || code.state };
  }
  const split = splitCodeAndState(trimmed);
  return split.code ? split : null;
}

function splitCodeAndState(value: string): {
  code: string;
  state: string | null;
} {
  const index = value.indexOf('#');
  if (index < 0) return { code: value.trim(), state: null };
  return {
    code: value.slice(0, index).trim(),
    state: value.slice(index + 1).trim() || null,
  };
}

/** Constant-time state comparison; differing lengths never match. */
export function claudeOAuthStateMatches(
  expected: string,
  received: string,
): boolean {
  const left = Buffer.from(expected, 'utf8');
  const right = Buffer.from(received, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Authorization-code exchange body in the CLI's field order. Only a
 * setup-token login asks for a long lifetime; a full login takes Anthropic's
 * default so its refresh token keeps rotating normally.
 */
export function buildClaudeCodeExchangeBody(options: {
  code: string;
  codeVerifier: string;
  state: string;
  profile: ClaudeOAuthLoginProfile;
}): Record<string, string | number> {
  const body: Record<string, string | number> = {
    grant_type: 'authorization_code',
    code: options.code,
    redirect_uri: CLAUDE_OAUTH_REDIRECT_URI,
    client_id: CLAUDE_OAUTH_CLIENT_ID,
    code_verifier: options.codeVerifier,
    state: options.state,
  };
  if (options.profile === 'setup_token') {
    body.expires_in = CLAUDE_OAUTH_SETUP_TOKEN_EXPIRES_IN;
  }
  return body;
}

/**
 * The scope a CLI refresh requests for a stored grant, and the stored scope
 * it retries with when the endpoint answers invalid_scope. A claude.ai grant
 * is rebuilt from the refresh set plus its project scopes; anything else
 * replays what it holds.
 */
export function claudeOAuthRefreshScopes(credentials: {
  scopes: string[];
  subscriptionType?: string;
}): { scope: string; fallbackScope: string | null } {
  const stored = credentials.scopes.filter(Boolean);
  const claudeAiGrant =
    stored.includes('user:inference') || !!credentials.subscriptionType;
  if (!claudeAiGrant) {
    return {
      scope: (stored.length ? stored : CLAUDE_OAUTH_REFRESH_SCOPES).join(' '),
      fallbackScope: null,
    };
  }
  const rebuilt = [...CLAUDE_OAUTH_REFRESH_SCOPES];
  for (const scope of stored) {
    if (CARRIED_REFRESH_SCOPES.includes(scope) && !rebuilt.includes(scope)) {
      rebuilt.push(scope);
    }
  }
  return {
    scope: rebuilt.join(' '),
    fallbackScope: stored.includes('user:inference') ? stored.join(' ') : null,
  };
}

export function buildClaudeRefreshBody(
  refreshToken: string,
  scope: string,
): Record<string, string> {
  return {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLAUDE_OAUTH_CLIENT_ID,
    scope,
  };
}

export function claudeOAuthTokenHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/plain, */*',
    'User-Agent': CLAUDE_OAUTH_TOKEN_USER_AGENT,
  };
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Lift the account/organization block returned next to the tokens. */
export function extractClaudeOAuthAccount(
  tokenResponse: Record<string, unknown>,
): ClaudeOAuthAccountInfo | null {
  const account = record(tokenResponse.account);
  const organization = record(tokenResponse.organization);
  const info: ClaudeOAuthAccountInfo = {};
  const accountUuid = text(account?.uuid);
  const emailAddress = text(account?.email_address) ?? text(account?.email);
  const organizationUuid = text(organization?.uuid);
  const organizationName = text(organization?.name);
  if (accountUuid) info.accountUuid = accountUuid;
  if (emailAddress) info.emailAddress = emailAddress;
  if (organizationUuid) info.organizationUuid = organizationUuid;
  if (organizationName) info.organizationName = organizationName;
  return Object.keys(info).length > 0 ? info : null;
}

/** The CLI's organization_type → subscriptionType map. */
const SUBSCRIPTION_TYPES = new Map([
  ['claude_max', 'max'],
  ['claude_pro', 'pro'],
  ['claude_enterprise', 'enterprise'],
  ['claude_team', 'team'],
]);

/** Account facts from GET /api/oauth/profile. */
export function parseClaudeOAuthProfile(
  profile: Record<string, unknown>,
): ClaudeOAuthAccountInfo | null {
  const account = record(profile.account);
  const organization = record(profile.organization);
  const info: ClaudeOAuthAccountInfo = {};
  const accountUuid = text(account?.uuid);
  const emailAddress = text(account?.email) ?? text(account?.email_address);
  const organizationUuid = text(organization?.uuid);
  const organizationName = text(organization?.name);
  const organizationType = text(organization?.organization_type);
  const subscriptionType = organizationType
    ? SUBSCRIPTION_TYPES.get(organizationType)
    : undefined;
  if (accountUuid) info.accountUuid = accountUuid;
  if (emailAddress) info.emailAddress = emailAddress;
  if (organizationUuid) info.organizationUuid = organizationUuid;
  if (organizationName) info.organizationName = organizationName;
  if (subscriptionType) info.subscriptionType = subscriptionType;
  return Object.keys(info).length > 0 ? info : null;
}

/** Later facts win field by field; absent fields keep what was known. */
export function mergeClaudeOAuthAccount(
  base: ClaudeOAuthAccountInfo | null | undefined,
  next: ClaudeOAuthAccountInfo | null | undefined,
): ClaudeOAuthAccountInfo | null {
  const merged = { ...(base ?? {}), ...(next ?? {}) };
  return Object.keys(merged).length > 0 ? merged : null;
}

export function parseClaudeTokenScopes(value: unknown): string[] | null {
  if (typeof value !== 'string') return null;
  return value.split(/\s+/).filter(Boolean);
}

export function parseClaudeExpiresIn(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : CLAUDE_OAUTH_DEFAULT_EXPIRES_IN;
}

/** The OAuth `error` code of a token-endpoint rejection, if any. */
export function claudeOAuthErrorCode(body: string): string | null {
  try {
    const parsed = record(JSON.parse(body));
    if (!parsed) return null;
    if (typeof parsed.error === 'string') return parsed.error;
    const nested = record(parsed.error);
    return text(nested?.type) ?? null;
  } catch {
    return null;
  }
}

export type ClaudeRefreshFailureKind = 'invalid_grant' | 'rejected';

/**
 * Whether a failed refresh condemns the grant. invalid_grant and every 400 or
 * 401 rejection cannot succeed by replaying the same refresh token; 429, 5xx,
 * other statuses and network failures are retried with backoff.
 */
export function classifyClaudeRefreshFailure(
  status: number,
  body: string,
): { terminal: boolean; kind: ClaudeRefreshFailureKind; code: string | null } {
  const code = claudeOAuthErrorCode(body);
  if (code === 'invalid_grant') {
    return { terminal: true, kind: 'invalid_grant', code };
  }
  return {
    terminal: status === 400 || status === 401,
    kind: 'rejected',
    code,
  };
}

/** Retry-After as milliseconds, from delta-seconds or an HTTP date. */
export function parseRetryAfterMs(
  header: string | null,
  now = Date.now(),
): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

// ─── Pasted credential input ────────────────────────────────────

export class ClaudeCredentialInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClaudeCredentialInputError';
  }
}

export type ParsedClaudeCredentialInput =
  | { kind: 'oauth'; credentials: ClaudeOAuthCredentials }
  | { kind: 'setup_token'; token: string };

/**
 * Epoch milliseconds from a `.credentials.json` expiresAt: epoch ms or epoch
 * seconds (number or numeric string), or an ISO timestamp. A missing value is
 * 0 — already expired — so HappyClaw refreshes it before first use.
 */
function parseCredentialExpiresAt(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0;
  let numeric: number | null = null;
  if (typeof value === 'number') numeric = value;
  else if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim())) {
    numeric = Number(value.trim());
  }
  if (numeric !== null) {
    if (!Number.isFinite(numeric) || numeric < 0) {
      throw new ClaudeCredentialInputError('expiresAt 不是有效的时间戳');
    }
    // Seconds stay below 1e12 until the year 33658; milliseconds pass it in 2001.
    return Math.round(numeric < 1e12 ? numeric * 1000 : numeric);
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  throw new ClaudeCredentialInputError('expiresAt 不是有效的时间戳或日期');
}

function parseCredentialScopes(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') return value.split(/\s+/).filter(Boolean);
  if (Array.isArray(value)) {
    return value.filter(
      (scope): scope is string => typeof scope === 'string' && !!scope.trim(),
    );
  }
  throw new ClaudeCredentialInputError('scopes 必须是字符串数组');
}

function parseCredentialJson(input: string): ParsedClaudeCredentialInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new ClaudeCredentialInputError(
      '无法解析 .credentials.json：内容不是有效的 JSON',
    );
  }
  if (typeof parsed === 'string') return parseSetupToken(parsed);
  const root = record(parsed);
  const oauth = record(root?.claudeAiOauth) ?? root;
  const accessToken = text(oauth?.accessToken);
  const refreshToken = text(oauth?.refreshToken);
  if (!oauth || !accessToken || !refreshToken) {
    throw new ClaudeCredentialInputError(
      '.credentials.json 缺少 claudeAiOauth.accessToken 或 refreshToken',
    );
  }
  const credentials: ClaudeOAuthCredentials = {
    accessToken,
    refreshToken,
    expiresAt: parseCredentialExpiresAt(oauth.expiresAt),
    scopes: parseCredentialScopes(oauth.scopes),
  };
  const subscriptionType = text(oauth.subscriptionType);
  if (subscriptionType) credentials.subscriptionType = subscriptionType;
  return { kind: 'oauth', credentials };
}

function parseSetupToken(raw: string): ParsedClaudeCredentialInput {
  const token = raw.trim();
  if (!token) throw new ClaudeCredentialInputError('凭据内容为空');
  if (/\s/.test(token)) {
    throw new ClaudeCredentialInputError(
      'setup-token 不能包含空白字符；如需导入登录凭据请粘贴完整的 .credentials.json',
    );
  }
  if (token.startsWith('sk-ant-api')) {
    throw new ClaudeCredentialInputError(
      '这是 Anthropic API Key，请改用 API Key 认证方式',
    );
  }
  if (token.startsWith('sk-ant-ort')) {
    throw new ClaudeCredentialInputError(
      '这是 OAuth refresh token，不能单独使用；请粘贴完整的 .credentials.json',
    );
  }
  return { kind: 'setup_token', token };
}

/**
 * Parse what an operator pastes into the official-provider credential box:
 * the output of `cat ~/.claude/.credentials.json`, or a `claude setup-token`
 * token such as `sk-ant-oat01-…`. Input that looks like JSON must be a usable
 * credential file; it is never silently stored as a token.
 */
export function parseClaudeCredentialInput(
  raw: string,
): ParsedClaudeCredentialInput {
  const input = raw.trim();
  if (!input) throw new ClaudeCredentialInputError('凭据内容为空');
  if (/^[{["]/.test(input)) return parseCredentialJson(input);
  return parseSetupToken(input);
}
