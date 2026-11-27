// ─── Gemini 订阅 — 网关侧 token 管理 ──────────────────────────────
//
// 网关用 provider 的 anthropicAuthToken 作为内部标识定位连接（该 token 同时
// 是 Runner 环境里的 ANTHROPIC_API_KEY），再按需刷新 Google access_token。
// 刷新沿用 CAS（compare-and-swap）落盘：只在 provider 仍持有发起刷新时的
// 凭据快照时才写回，避免覆盖并发的管理员修改。并发刷新做单飞。
//
// 刷新失败分两类：refresh_token 被拒（401 / invalid_grant / invalid_client）
// 落盘为 reauth_required；其余（网络、5xx/429 等）是瞬时失败，指数退避。

import { timingSafeEqual } from 'node:crypto';

import { logger } from '../logger.js';
import {
  getProviders,
  setProviderGeminiOAuthRefreshErrorIfCurrent,
  updateProviderGeminiOAuthCredentialsIfCurrent,
  type UnifiedProvider,
} from '../runtime-config.js';
import { GeminiOAuthError, refreshGeminiToken } from './oauth.js';
import {
  GEMINI_TOKEN_REFRESH_MARGIN_MS,
  type GeminiOAuthCredentials,
  type GeminiOAuthRefreshErrorState,
} from './types.js';

export class GeminiGatewayAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GeminiGatewayAuthError';
  }
}

/** refresh grant 已失效：只有重新登录 Google 能恢复。 */
export class GeminiReauthRequiredError extends GeminiGatewayAuthError {
  constructor(readonly reason: string) {
    super(
      `Gemini 订阅登录已失效：${reason}。请在「模型配置」中重新登录 Google 账号。`,
    );
    this.name = 'GeminiReauthRequiredError';
  }
}

/** 刷新暂时失败，正在退避。 */
export class GeminiRefreshUnavailableError extends Error {
  constructor(readonly retryAfterMs: number) {
    super('Gemini 令牌刷新暂时失败，网关会自动重试，请稍后再发送。');
    this.name = 'GeminiRefreshUnavailableError';
  }
}

const TRANSIENT_REFRESH_BACKOFF_BASE_MS = 30_000;
const TRANSIENT_REFRESH_BACKOFF_MAX_MS = 5 * 60_000;

function isSameSecret(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** 把 Runner 环境里的网关标识映射回 provider。 */
export function findGeminiProviderByGatewayIdentifier(
  identifier: string,
): UnifiedProvider | null {
  if (!identifier) return null;
  return (
    getProviders().find(
      (candidate) =>
        !!candidate.geminiOAuthCredentials &&
        typeof candidate.anthropicAuthToken === 'string' &&
        candidate.anthropicAuthToken.length > 0 &&
        isSameSecret(candidate.anthropicAuthToken, identifier),
    ) ?? null
  );
}

export function resolveGeminiProvider(providerId: string): UnifiedProvider {
  const provider = getProviders().find((entry) => entry.id === providerId);
  if (!provider) {
    throw new GeminiGatewayAuthError('Gemini 连接不存在');
  }
  if (!provider.geminiOAuthCredentials) {
    throw new GeminiGatewayAuthError('Gemini 连接没有登录凭据');
  }
  return provider;
}

interface RefreshBackoff {
  refreshToken: string;
  attempts: number;
  until: number;
}

/** In-memory only, keyed to the refresh token it was observed with. */
const refreshBackoffs = new Map<string, RefreshBackoff>();

function backoffRemaining(
  providerId: string,
  credentials: GeminiOAuthCredentials,
): number {
  const backoff = refreshBackoffs.get(providerId);
  if (backoff?.refreshToken !== credentials.refreshToken) {
    if (backoff) refreshBackoffs.delete(providerId);
    return 0;
  }
  return Math.max(0, backoff.until - Date.now());
}

function recordRefreshFailure(
  providerId: string,
  credentials: GeminiOAuthCredentials,
  error: GeminiOAuthRefreshErrorState,
): void {
  try {
    setProviderGeminiOAuthRefreshErrorIfCurrent(providerId, credentials, error);
  } catch (err) {
    logger.warn(
      { err, providerId },
      'Gemini gateway: failed to persist token refresh state',
    );
  }
}

interface InFlightRefresh {
  refreshToken: string;
  promise: Promise<GeminiOAuthCredentials>;
}

const inFlight = new Map<string, InFlightRefresh>();

/**
 * Perform (or join) a network refresh. Only one request per provider may be
 * in flight: Google rotates the refresh token, so a second concurrent exchange
 * would lose the grant.
 */
async function refreshCredentials(
  providerId: string,
  credentials: GeminiOAuthCredentials,
): Promise<GeminiOAuthCredentials> {
  const existing = inFlight.get(providerId);
  if (existing && existing.refreshToken === credentials.refreshToken) {
    return existing.promise;
  }
  const promise = (async () => {
    try {
      const token = await refreshGeminiToken(credentials.refreshToken);
      // Google may not return a new refresh_token; keep the old grant then.
      const refreshed: GeminiOAuthCredentials = {
        ...credentials,
        accessToken: token.accessToken,
        refreshToken: token.refreshToken ?? credentials.refreshToken,
        expiresAt: token.expiresAt,
        updatedAt: new Date().toISOString(),
      };
      const persisted = updateProviderGeminiOAuthCredentialsIfCurrent(
        providerId,
        credentials,
        refreshed,
      );
      refreshBackoffs.delete(providerId);
      if (persisted) return refreshed;
      // CAS loser: an administrator replaced or cleared the credentials during
      // the exchange. Serve what is stored now, never the snapshot we started
      // with (it may be the token the admin just replaced).
      logger.warn(
        { providerId },
        'Gemini OAuth credentials changed concurrently during refresh',
      );
      const current = getProviders().find(
        (candidate) => candidate.id === providerId,
      );
      if (!current?.geminiOAuthCredentials) {
        throw new GeminiGatewayAuthError(
          'Gemini 连接在刷新期间被移除或退出登录',
        );
      }
      return current.geminiOAuthCredentials;
    } catch (err) {
      const oauthError = err instanceof GeminiOAuthError ? err : null;
      if (oauthError?.transient === false) {
        recordRefreshFailure(providerId, credentials, {
          kind: 'reauth_required',
          message: oauthError.message,
          at: new Date().toISOString(),
        });
        throw new GeminiReauthRequiredError(oauthError.message);
      }
      const previous = refreshBackoffs.get(providerId);
      const attempts =
        previous?.refreshToken === credentials.refreshToken
          ? previous.attempts + 1
          : 1;
      const until =
        Date.now() +
        Math.min(
          TRANSIENT_REFRESH_BACKOFF_BASE_MS * 2 ** (attempts - 1),
          TRANSIENT_REFRESH_BACKOFF_MAX_MS,
        );
      refreshBackoffs.set(providerId, {
        refreshToken: credentials.refreshToken,
        attempts,
        until,
      });
      recordRefreshFailure(providerId, credentials, {
        kind: 'transient',
        message:
          oauthError?.message ??
          (err instanceof Error ? err.message : String(err)),
        at: new Date().toISOString(),
      });
      logger.warn(
        { err, providerId, attempts },
        'Gemini gateway: failed to refresh upstream access token',
      );
      throw new GeminiRefreshUnavailableError(until - Date.now());
    } finally {
      inFlight.delete(providerId);
    }
  })();
  inFlight.set(providerId, { refreshToken: credentials.refreshToken, promise });
  return promise;
}

export interface GeminiAccess {
  provider: UnifiedProvider;
  credentials: GeminiOAuthCredentials;
  accessToken: string;
}

/**
 * Resolve a provider's usable Google access token, refreshing when it is
 * within the refresh margin (or when forced by an upstream 401).
 */
export async function resolveGeminiAccess(
  providerId: string,
  options: { forceRefresh?: boolean } = {},
): Promise<GeminiAccess> {
  const provider = resolveGeminiProvider(providerId);
  const credentials = provider.geminiOAuthCredentials!;
  const refreshError = provider.geminiOAuthLastRefreshError ?? null;

  if (refreshError?.kind === 'reauth_required' && !options.forceRefresh) {
    throw new GeminiReauthRequiredError(refreshError.message);
  }

  const expired =
    credentials.expiresAt - Date.now() <= GEMINI_TOKEN_REFRESH_MARGIN_MS;
  if (!credentials.refreshToken) {
    if (expired) {
      throw new GeminiReauthRequiredError('凭据缺少 refresh_token');
    }
    return { provider, credentials, accessToken: credentials.accessToken };
  }
  if (!options.forceRefresh && !expired) {
    return { provider, credentials, accessToken: credentials.accessToken };
  }

  const remaining = backoffRemaining(providerId, credentials);
  if (!options.forceRefresh && remaining > 0) {
    if (credentials.expiresAt > Date.now()) {
      return { provider, credentials, accessToken: credentials.accessToken };
    }
    throw new GeminiRefreshUnavailableError(remaining);
  }

  const refreshed = await refreshCredentials(providerId, credentials);
  return {
    provider: resolveGeminiProvider(providerId),
    credentials: refreshed,
    accessToken: refreshed.accessToken,
  };
}

/** Test/diagnostic hooks. */
export function countGeminiRefreshBackoffs(): number {
  return refreshBackoffs.size;
}

export function resetGeminiTokenStateForTest(): void {
  refreshBackoffs.clear();
  inFlight.clear();
}
