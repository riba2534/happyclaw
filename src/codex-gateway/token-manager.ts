// ─── ChatGPT/Codex 订阅 — 网关侧 token 管理 ────────────────────────
//
// 网关收到请求后用 provider 的 gateway token（存在 anthropicAuthToken 里，
// 与真实 ChatGPT token 无关）找到 provider，再按需刷新上游 access_token。
// 刷新沿用 Claude OAuth 的 CAS（compare-and-swap）落盘模式：只在 provider
// 仍持有发起刷新时的那份凭据快照时才写回，避免与并发的 admin 修改互相覆盖。
// 并发刷新做单飞（in-flight promise 复用）：上游会轮换 refresh_token，
// 同一时刻只允许一个网络刷新，其余请求共享同一结果，避免输家拿到
// invalid_grant 造成假 401。

import { timingSafeEqual } from 'node:crypto';
import { logger } from '../logger.js';
import {
  getProviders,
  updateProviderCodexOAuthCredentialsIfCurrent,
  type UnifiedProvider,
} from '../runtime-config.js';
import { buildCodexCredentials, refreshCodexToken } from './oauth.js';
import {
  CODEX_TOKEN_REFRESH_MARGIN_MS,
  type CodexOAuthCredentials,
} from './types.js';

export class CodexGatewayAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexGatewayAuthError';
  }
}

/** 常数时间比较 bearer token，长度不同直接不等（长度本身不是机密）。 */
function isSameSecret(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function findProviderByGatewayToken(gatewayToken: string): UnifiedProvider {
  const provider = getProviders().find(
    (candidate) =>
      candidate.enabled &&
      typeof candidate.anthropicAuthToken === 'string' &&
      candidate.anthropicAuthToken.length > 0 &&
      isSameSecret(candidate.anthropicAuthToken, gatewayToken) &&
      !!candidate.codexOAuthCredentials,
  );
  if (!provider) {
    throw new CodexGatewayAuthError('Unknown or disabled Codex gateway token');
  }
  return provider;
}

/** 单飞刷新：providerId → 正在进行的刷新 promise，并发调用共享同一结果。 */
const inFlightRefreshes = new Map<string, Promise<CodexOAuthCredentials>>();

async function refreshIfNeeded(
  providerId: string,
  credentials: CodexOAuthCredentials,
  attemptsLeft = 2,
): Promise<CodexOAuthCredentials> {
  if (Date.now() < credentials.expiresAt - CODEX_TOKEN_REFRESH_MARGIN_MS) {
    return credentials;
  }
  if (!credentials.refreshToken) {
    throw new CodexGatewayAuthError(
      'Codex OAuth credentials have no refresh_token; re-authorize in Provider settings',
    );
  }
  let inFlight = inFlightRefreshes.get(providerId);
  if (!inFlight) {
    inFlight = performRefresh(providerId, credentials).finally(() => {
      inFlightRefreshes.delete(providerId);
    });
    inFlightRefreshes.set(providerId, inFlight);
  }
  const refreshed = await inFlight;
  if (refreshed !== credentials) {
    return refreshed;
  }
  if (attemptsLeft <= 0) {
    throw new CodexGatewayAuthError(
      'Codex OAuth credentials changed concurrently during refresh',
    );
  }
  // 本请求发起的刷新在 CAS 落盘时发现凭据已被并发修改（如 admin 同时
  // 操作）：重新读取当前凭据再判断是否仍需刷新。
  const latest = getProviders().find((p) => p.id === providerId);
  if (!latest?.codexOAuthCredentials) {
    throw new CodexGatewayAuthError('Provider Codex credentials were cleared');
  }
  return refreshIfNeeded(
    providerId,
    latest.codexOAuthCredentials,
    attemptsLeft - 1,
  );
}

async function performRefresh(
  providerId: string,
  credentials: CodexOAuthCredentials,
): Promise<CodexOAuthCredentials> {
  const tokenResponse = await refreshCodexToken(credentials.refreshToken!);
  const refreshed = buildCodexCredentials(tokenResponse, credentials);
  const persisted = updateProviderCodexOAuthCredentialsIfCurrent(
    providerId,
    credentials,
    refreshed,
  );
  return persisted ? refreshed : credentials;
}

export interface CodexAccessContext {
  providerId: string;
  accessToken: string;
  accountId: string | null;
}

/** 用网关 token（provider 的 anthropicAuthToken）解析出可用的上游 access_token。 */
export async function resolveCodexAccess(
  gatewayToken: string,
): Promise<CodexAccessContext> {
  const provider = findProviderByGatewayToken(gatewayToken);
  const credentials = provider.codexOAuthCredentials;
  if (!credentials) {
    throw new CodexGatewayAuthError('Provider has no Codex OAuth credentials');
  }
  try {
    const valid = await refreshIfNeeded(provider.id, credentials);
    return {
      providerId: provider.id,
      accessToken: valid.accessToken,
      accountId: valid.accountId,
    };
  } catch (err) {
    logger.warn(
      { providerId: provider.id, err },
      'Codex gateway: failed to resolve a valid upstream access token',
    );
    throw err;
  }
}
