// ─── Gemini 订阅 — Google/Antigravity OAuth 流程 ─────────────────
//
// 参数与 Antigravity 桌面客户端一致（参考 CLIProxyAPI，MIT）：
// - 授权：accounts.google.com，offline + consent，本机 51121 回调
// - token：oauth2.googleapis.com，form 编码，带 client_secret
// - 项目：v1internal:loadCodeAssist，缺项目时 v1internal:onboardUser 轮询
// - 模型：v1internal:fetchAvailableModels

import { logger } from '../logger.js';
import {
  GEMINI_API_BASE,
  GEMINI_API_VERSION,
  GEMINI_CLIENT_VERSION,
  GEMINI_GOOG_API_CLIENT,
  GEMINI_OAUTH_AUTH_URL,
  GEMINI_OAUTH_CLIENT_ID,
  GEMINI_OAUTH_CLIENT_SECRET,
  GEMINI_OAUTH_REDIRECT_URI,
  GEMINI_OAUTH_SCOPES,
  GEMINI_OAUTH_TOKEN_URL,
  GEMINI_OAUTH_USERINFO_URL,
  GEMINI_ONBOARD_USER_AGENT,
  GEMINI_REQUEST_USER_AGENT,
  geminiOAuthClientConfigured,
  type GeminiModelInfo,
  type GeminiOAuthCredentials,
} from './types.js';

export interface GeminiTokenResponse {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  /** 授权时实际获得的 scope（空格分隔）。 */
  scope: string | null;
  expiresAt: number;
}

export class GeminiOAuthError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string | null,
    readonly transient: boolean,
    readonly requestDelivered = true,
  ) {
    super(message);
    this.name = 'GeminiOAuthError';
  }
}

/** 未配置 OAuth 客户端时给出可操作的错误，而不是向 Google 发空凭据。 */
function assertOAuthClientConfigured(): void {
  if (geminiOAuthClientConfigured()) return;
  throw new GeminiOAuthError(
    'Gemini 订阅未配置 Google OAuth 客户端：请设置 GEMINI_OAUTH_CLIENT_ID 与 GEMINI_OAUTH_CLIENT_SECRET',
    null,
    'client_not_configured',
    false,
    false,
  );
}

const PERMANENT_REFRESH_CODES = new Set([
  'invalid_grant',
  'invalid_client',
  'unauthorized_client',
]);

/** refresh_token 被拒时只能重新登录；其余按瞬时失败退避。 */
export function isPermanentGeminiTokenRejection(
  status: number,
  code: string | null,
): boolean {
  const normalized = code?.toLowerCase() ?? null;
  return (
    status === 401 ||
    (normalized !== null && PERMANENT_REFRESH_CODES.has(normalized))
  );
}

function oauthErrorCode(body: Record<string, unknown>): string | null {
  const candidate = body.error;
  return typeof candidate === 'string' &&
    /^[A-Za-z0-9_.-]{1,64}$/.test(candidate)
    ? candidate
    : null;
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf-8'),
    );
    return payload && typeof payload === 'object' && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** 构造授权 URL。redirect_uri 固定 localhost:51121，用户把回调 URL 粘贴回来。 */
export function buildGeminiAuthorizeUrl(state: string): string {
  assertOAuthClientConfigured();
  const params = new URLSearchParams({
    access_type: 'offline',
    client_id: GEMINI_OAUTH_CLIENT_ID,
    prompt: 'consent',
    redirect_uri: GEMINI_OAUTH_REDIRECT_URI,
    response_type: 'code',
    scope: GEMINI_OAUTH_SCOPES.join(' '),
    state,
  });
  return `${GEMINI_OAUTH_AUTH_URL}?${params.toString()}`;
}

interface RawTokenResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
}

const DEFAULT_ACCESS_TOKEN_TTL_MS = 3600 * 1000;

function toTokenResponse(raw: RawTokenResponse): GeminiTokenResponse {
  if (typeof raw.access_token !== 'string' || !raw.access_token.trim()) {
    throw new GeminiOAuthError(
      'Gemini OAuth response missing access_token',
      null,
      null,
      true,
    );
  }
  return {
    accessToken: raw.access_token,
    refreshToken: raw.refresh_token ?? null,
    idToken: raw.id_token ?? null,
    scope: typeof raw.scope === 'string' ? raw.scope : null,
    expiresAt:
      typeof raw.expires_in === 'number' && raw.expires_in > 0
        ? Date.now() + raw.expires_in * 1000
        : Date.now() + DEFAULT_ACCESS_TOKEN_TTL_MS,
  };
}

async function postTokenEndpoint(
  init: RequestInit,
  timeoutMs = 30_000,
): Promise<GeminiTokenResponse> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response: Response;
    try {
      response = await fetch(GEMINI_OAUTH_TOKEN_URL, {
        ...init,
        signal: controller.signal,
      });
    } catch {
      throw new GeminiOAuthError(
        controller.signal.aborted
          ? 'Gemini OAuth token endpoint timed out'
          : 'Gemini OAuth token endpoint unreachable',
        null,
        null,
        true,
      );
    }
    const body = (await response.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    if (!response.ok) {
      const code = oauthErrorCode(body);
      throw new GeminiOAuthError(
        `Gemini OAuth token endpoint rejected: ${code ?? `HTTP ${response.status}`}`,
        response.status,
        code,
        !isPermanentGeminiTokenRejection(response.status, code),
        true,
      );
    }
    return toTokenResponse(body as RawTokenResponse);
  } finally {
    clearTimeout(timeout);
  }
}

/** 用授权码换 token（form 编码）。 */
export async function exchangeGeminiCode(
  code: string,
): Promise<GeminiTokenResponse> {
  assertOAuthClientConfigured();
  const form = new URLSearchParams({
    code,
    client_id: GEMINI_OAUTH_CLIENT_ID,
    client_secret: GEMINI_OAUTH_CLIENT_SECRET,
    redirect_uri: GEMINI_OAUTH_REDIRECT_URI,
    grant_type: 'authorization_code',
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

/** 用 refresh_token 换新的 access_token。Google 会轮换 refresh_token。 */
export async function refreshGeminiToken(
  refreshToken: string,
): Promise<GeminiTokenResponse> {
  assertOAuthClientConfigured();
  const form = new URLSearchParams({
    client_id: GEMINI_OAUTH_CLIENT_ID,
    client_secret: GEMINI_OAUTH_CLIENT_SECRET,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
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

export interface GeminiUserInfo {
  id: string | null;
  email: string | null;
}

export async function fetchGeminiUserInfo(
  accessToken: string,
): Promise<GeminiUserInfo> {
  const response = await fetch(GEMINI_OAUTH_USERINFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': GEMINI_REQUEST_USER_AGENT,
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new GeminiOAuthError(
      `Google userinfo failed: HTTP ${response.status}`,
      response.status,
      null,
      response.status >= 500 || response.status === 429,
    );
  }
  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  return {
    id: typeof body.id === 'string' ? body.id : null,
    email: typeof body.email === 'string' ? body.email : null,
  };
}

const AUTH_BODY_LIMIT = 64 * 1024;

async function postAntigravityControlPlane(
  path: string,
  accessToken: string,
  body: unknown,
  userAgent: string,
  extraHeaders: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const response = await fetch(
    `${GEMINI_API_BASE}/${GEMINI_API_VERSION}:${path}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'User-Agent': userAgent,
        ...extraHeaders,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    },
  );
  const raw = await response.text();
  const bounded =
    raw.length > AUTH_BODY_LIMIT ? raw.slice(0, AUTH_BODY_LIMIT) : raw;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(bounded);
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    throw new GeminiOAuthError(
      `Antigravity ${path} failed: HTTP ${response.status}${
        parsed && typeof parsed === 'object'
          ? ` ${describeUpstreamMessage(parsed)}`
          : ''
      }`,
      response.status,
      null,
      response.status >= 500 || response.status === 429,
    );
  }
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function describeUpstreamMessage(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const record = body as Record<string, unknown>;
  const error = record.error;
  if (error && typeof error === 'object') {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === 'string') return message.slice(0, 300);
  }
  return '';
}

function extractProjectId(data: Record<string, unknown>): string {
  for (const key of ['cloudaicompanionProject', 'projectId', 'project']) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const id = (value as Record<string, unknown>).id;
      if (typeof id === 'string' && id.trim()) return id.trim();
    }
  }
  return '';
}

function defaultTierId(loadResponse: Record<string, unknown>): string {
  const tiers = loadResponse.allowedTiers;
  if (Array.isArray(tiers)) {
    for (const rawTier of tiers) {
      if (!rawTier || typeof rawTier !== 'object') continue;
      const tier = rawTier as Record<string, unknown>;
      if (tier.isDefault !== true) continue;
      if (typeof tier.id === 'string' && tier.id.trim()) return tier.id.trim();
    }
  }
  const current = loadResponse.currentTier;
  if (current && typeof current === 'object') {
    const id = (current as Record<string, unknown>).id;
    if (typeof id === 'string' && id.trim()) return id.trim();
  }
  return 'free-tier';
}

async function onboardGeminiUser(
  accessToken: string,
  tierId: string,
): Promise<string> {
  const body = {
    tier_id: tierId,
    metadata: {
      ide_type: 'ANTIGRAVITY',
      ide_version: GEMINI_CLIENT_VERSION,
      ide_name: 'antigravity',
    },
  };
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const data = await postAntigravityControlPlane(
      'onboardUser',
      accessToken,
      body,
      GEMINI_ONBOARD_USER_AGENT,
      { 'X-Goog-Api-Client': GEMINI_GOOG_API_CLIENT, Accept: '*/*' },
    );
    if (data.done === true) {
      const response = data.response;
      const project =
        response && typeof response === 'object'
          ? extractProjectId(response as Record<string, unknown>)
          : '';
      if (project) return project;
      throw new GeminiOAuthError(
        'Antigravity 账号初始化完成，但没有返回项目 ID',
        null,
        null,
        false,
      );
    }
    if (attempt < 5) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
  }
  throw new GeminiOAuthError(
    'Antigravity 账号初始化超时，请稍后重试',
    null,
    null,
    true,
  );
}

/** 解析（必要时初始化）Cloud AI Companion 项目。 */
export async function fetchGeminiProjectId(
  accessToken: string,
): Promise<string> {
  const data = await postAntigravityControlPlane(
    'loadCodeAssist',
    accessToken,
    { metadata: { ideType: 'ANTIGRAVITY' } },
    GEMINI_REQUEST_USER_AGENT,
  );
  const project = extractProjectId(data);
  if (project) return project;
  logger.info(
    { tier: defaultTierId(data) },
    'Gemini OAuth: onboarding Antigravity project',
  );
  return onboardGeminiUser(accessToken, defaultTierId(data));
}

interface RawAvailableModel {
  displayName?: unknown;
  maxTokens?: unknown;
  maxOutputTokens?: unknown;
  supportsThinking?: unknown;
  supportsImages?: unknown;
  thinkingBudget?: unknown;
  minThinkingBudget?: unknown;
}

function positiveInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : null;
}

function isUsableModelId(id: string): boolean {
  return (
    /^[a-z0-9][a-z0-9._-]{1,100}$/i.test(id) &&
    !id.startsWith('tab_') &&
    !id.startsWith('chat_')
  );
}

/** 拉取上游可用模型，裁剪成连接可用的条目。 */
export async function fetchGeminiModels(
  accessToken: string,
  projectId: string,
): Promise<GeminiModelInfo[]> {
  const data = await postAntigravityControlPlane(
    'fetchAvailableModels',
    accessToken,
    { project: projectId },
    GEMINI_REQUEST_USER_AGENT,
  );
  const models = data.models;
  if (!models || typeof models !== 'object' || Array.isArray(models)) return [];
  const result: GeminiModelInfo[] = [];
  for (const [id, raw] of Object.entries(models as Record<string, unknown>)) {
    if (!isUsableModelId(id)) continue;
    const info = (raw ?? {}) as RawAvailableModel;
    const displayName =
      typeof info.displayName === 'string' && info.displayName.trim()
        ? info.displayName.trim()
        : '';
    if (!displayName) continue;
    result.push({
      id,
      displayName,
      contextWindow: positiveInt(info.maxTokens),
      maxOutputTokens: positiveInt(info.maxOutputTokens),
      supportsThinking: info.supportsThinking === true,
      supportsImages: info.supportsImages === true,
      thinkingBudget: positiveInt(info.thinkingBudget),
      minThinkingBudget: positiveInt(info.minThinkingBudget),
    });
  }
  result.sort((a, b) => a.displayName.localeCompare(b.displayName));
  return result;
}

export interface GeminiIdentity {
  id: string | null;
  email: string | null;
}

/** 把 token 响应组装成可持久化的凭据结构。 */
export function buildGeminiCredentials(
  token: GeminiTokenResponse,
  identity: GeminiIdentity,
  projectId: string,
  previous?: GeminiOAuthCredentials | null,
): GeminiOAuthCredentials {
  return {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken ?? previous?.refreshToken ?? '',
    expiresAt: token.expiresAt,
    email: identity.email ?? previous?.email ?? null,
    accountId: identity.id ?? previous?.accountId ?? null,
    projectId: projectId || previous?.projectId || null,
    scopes: token.scope
      ? token.scope.split(/\s+/).filter(Boolean)
      : (previous?.scopes ?? [...GEMINI_OAUTH_SCOPES]),
    updatedAt: new Date().toISOString(),
  };
}

/** id_token 里有时带 email；userinfo 不可用时作为兜底。 */
export function emailFromIdToken(idToken: string | null): string | null {
  if (!idToken) return null;
  const payload = decodeJwtPayload(idToken);
  return typeof payload?.email === 'string' ? payload.email : null;
}
