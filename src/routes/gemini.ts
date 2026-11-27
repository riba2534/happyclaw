// ─── Gemini 订阅 — 授权与模型目录路由 ─────────────────────────────
//
// 挂在 /api/config 下（浏览器 Cookie 会话 + 系统配置权限），与 Runner 使用的
// /gateway/gemini 分开：前者管理 Google 登录，后者代理模型请求。
//
// 授权沿用 Antigravity 桌面客户端参数：固定回调 http://localhost:51121/
// oauth-callback。本机通常没有进程监听该端口，浏览器会显示加载失败，用户把
// 地址栏里的完整 URL 粘贴回来即可（与 ChatGPT 订阅登录的交互一致）。

import { randomBytes } from 'node:crypto';

import { Hono } from 'hono';

import { bindSystemMainIfUnbound } from '../model-binding-backfill.js';
import { authMiddleware, systemConfigMiddleware } from '../middleware/auth.js';
import {
  createProvider,
  getProviderById,
  getProviders,
  setProviderGeminiModels,
  toPublicProvider,
  updateProvider,
  updateProviderSecrets,
  type UnifiedProvider,
} from '../runtime-config.js';
import { CONNECTION_ENV_PREFILL } from '../model-providers.js';
import { logger } from '../logger.js';
import { providerPool } from '../provider-pool.js';
import type { AuthUser } from '../types.js';
import type { Variables } from '../web-context.js';
import {
  appendClaudeConfigAuditBestEffort,
  mutateClaudeConfigForAllGroups,
  withClaudeConfigMutationLock,
  type ClaudeMutationResult,
} from './config.js';
import {
  GeminiOAuthError,
  buildGeminiAuthorizeUrl,
  buildGeminiCredentials,
  emailFromIdToken,
  exchangeGeminiCode,
  fetchGeminiModels,
  fetchGeminiProjectId,
  fetchGeminiUserInfo,
} from '../gemini-gateway/oauth.js';
import { resolveGeminiAccess } from '../gemini-gateway/token-manager.js';
import {
  GEMINI_DEFAULT_MODEL,
  GEMINI_GATEWAY_BASE_URL_PLACEHOLDER,
  GEMINI_OAUTH_FLOW_TTL_MS,
  GEMINI_OAUTH_REDIRECT_URI,
  geminiOAuthClientConfigured,
  type GeminiModelInfo,
  type GeminiOAuthCredentials,
} from '../gemini-gateway/types.js';

interface GeminiOAuthFlow {
  userId: string;
  targetProviderId?: string;
  expiresAt: number;
}

const geminiOauthFlows = new Map<string, GeminiOAuthFlow>();

function pruneExpiredFlows(now: number): void {
  for (const [key, flow] of geminiOauthFlows) {
    if (flow.expiresAt < now) geminiOauthFlows.delete(key);
  }
}

/** The default model a fresh connection starts on, from the live catalog. */
export function pickGeminiDefaultModel(
  catalog: readonly GeminiModelInfo[],
): string {
  if (catalog.length === 0) return GEMINI_DEFAULT_MODEL;
  if (catalog.some((model) => model.id === GEMINI_DEFAULT_MODEL)) {
    return GEMINI_DEFAULT_MODEL;
  }
  const medium = catalog.find(
    (model) => model.id.includes('argon') && model.id.includes('medium'),
  );
  return medium?.id ?? catalog[0].id;
}

function toProviderModels(
  catalog: readonly GeminiModelInfo[],
): Array<{ id: string; contextWindow?: number }> {
  return catalog.map((model) => ({
    id: model.id,
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
  }));
}

function providerLabel(credentials: GeminiOAuthCredentials): string {
  return credentials.email
    ? `Gemini 订阅 (${credentials.email})`
    : 'Gemini 订阅';
}

/** Whether a re-login replaced the Google account behind a connection. */
export function geminiAccountChanged(
  previous: GeminiOAuthCredentials | null | undefined,
  next: GeminiOAuthCredentials,
): boolean {
  if (!previous) return false;
  if (previous.accountId && next.accountId) {
    return previous.accountId !== next.accountId;
  }
  if (previous.email && next.email) {
    return previous.email.toLowerCase() !== next.email.toLowerCase();
  }
  // Without a comparable identity, assume the same account: clearing sessions
  // is the costlier mistake.
  return false;
}

function logConfiguredGemini(
  providerId: string,
  login: { credentials: GeminiOAuthCredentials; catalog: GeminiModelInfo[] },
): void {
  if (login.catalog.length === 0) {
    logger.warn(
      { providerId },
      'Gemini OAuth: login succeeded without a model catalog; refresh later',
    );
  }
  logger.info(
    {
      providerId,
      account: login.credentials.email,
      models: login.catalog.length,
    },
    'Gemini OAuth: login completed',
  );
}

interface ParsedCallback {
  code?: string;
  state?: string;
  error?: string;
  description?: string;
}

function parseQueryParams(raw: string): URLSearchParams {
  return new URLSearchParams(raw.replace(/^\?/, ''));
}

/**
 * Accept either a bare authorization code or the full callback URL the
 * browser shows after Google redirects to localhost:51121.
 */
export function parseGeminiCallbackInput(input: string): ParsedCallback | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  let params: URLSearchParams;
  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    params = url.searchParams;
  } else if (/^(?:code|error|state|scope)=/.test(trimmed)) {
    params = parseQueryParams(trimmed);
  } else {
    // A bare code: Google codes look like "4/0A..."; no whitespace allowed.
    if (/\s/.test(trimmed) || trimmed.length < 8 || trimmed.length > 4096) {
      return null;
    }
    return { code: trimmed };
  }
  const code = params.get('code') ?? '';
  const state = params.get('state') ?? '';
  const error = params.get('error') ?? '';
  const description = params.get('error_description') ?? '';
  if (!code && !error) return null;
  return {
    ...(code ? { code } : {}),
    ...(state ? { state } : {}),
    ...(error ? { error } : {}),
    ...(description ? { description } : {}),
  };
}

/** Identity + project + catalog, best effort on the optional parts. */
async function resolveGeminiLogin(
  token: Awaited<ReturnType<typeof exchangeGeminiCode>>,
): Promise<{
  credentials: GeminiOAuthCredentials;
  catalog: GeminiModelInfo[];
}> {
  let email: string | null = emailFromIdToken(token.idToken);
  let accountId: string | null = null;
  try {
    const info = await fetchGeminiUserInfo(token.accessToken);
    email = info.email ?? email;
    accountId = info.id;
  } catch (err) {
    logger.warn({ err }, 'Gemini OAuth: userinfo lookup failed');
  }

  let projectId: string | null = null;
  try {
    projectId = await fetchGeminiProjectId(token.accessToken);
  } catch (err) {
    logger.warn(
      { err },
      'Gemini OAuth: Cloud AI Companion project lookup failed',
    );
  }

  let catalog: GeminiModelInfo[] = [];
  if (projectId) {
    try {
      catalog = await fetchGeminiModels(token.accessToken, projectId);
    } catch (err) {
      logger.warn({ err }, 'Gemini OAuth: model catalog lookup failed');
    }
  }

  return {
    credentials: buildGeminiCredentials(
      token,
      { id: accountId, email },
      projectId ?? '',
    ),
    catalog,
  };
}

const geminiRoutes = new Hono<{ Variables: Variables }>();

// ─── POST /gemini/oauth/start — 打开 Google 授权页 ──────────────────
geminiRoutes.post(
  '/gemini/oauth/start',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const target =
      typeof (body as Record<string, unknown>).targetProviderId === 'string'
        ? ((body as Record<string, unknown>).targetProviderId as string).trim()
        : '';
    if (target && !getProviderById(target)) {
      return c.json({ error: '未找到指定供应商' }, 404);
    }
    if (!geminiOAuthClientConfigured()) {
      return c.json(
        {
          error:
            'Gemini 订阅需要先配置 Google OAuth 客户端：设置 GEMINI_OAUTH_CLIENT_ID 与 GEMINI_OAUTH_CLIENT_SECRET 后重启服务',
          code: 'GEMINI_OAUTH_CLIENT_NOT_CONFIGURED',
        },
        503,
      );
    }

    const now = Date.now();
    pruneExpiredFlows(now);
    const state = randomBytes(32).toString('hex');
    geminiOauthFlows.set(state, {
      userId: (c.get('user') as AuthUser).id,
      ...(target ? { targetProviderId: target } : {}),
      expiresAt: now + GEMINI_OAUTH_FLOW_TTL_MS,
    });

    return c.json({
      authorizeUrl: buildGeminiAuthorizeUrl(state),
      state,
      redirectHint: GEMINI_OAUTH_REDIRECT_URI,
    });
  },
);

// ─── POST /gemini/oauth/callback — 粘贴回调 URL / 授权码 ───────────
geminiRoutes.post(
  '/gemini/oauth/callback',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const record = body as Record<string, unknown>;
    const state = typeof record.state === 'string' ? record.state : '';
    const rawInput =
      typeof record.code === 'string'
        ? record.code
        : typeof record.callbackUrl === 'string'
          ? record.callbackUrl
          : '';
    if (!state || !rawInput) {
      return c.json({ error: 'Missing state or code' }, 400);
    }

    const flow = geminiOauthFlows.get(state);
    if (!flow) {
      return c.json({ error: 'Invalid or expired OAuth state' }, 400);
    }
    if (flow.userId !== (c.get('user') as AuthUser).id) {
      geminiOauthFlows.delete(state);
      return c.json({ error: 'OAuth flow was started by another user' }, 403);
    }
    if (flow.expiresAt < Date.now()) {
      geminiOauthFlows.delete(state);
      return c.json({ error: 'OAuth flow expired' }, 400);
    }

    // Input problems keep the flow: the user can paste the right URL again.
    const parsed = parseGeminiCallbackInput(rawInput);
    if (!parsed) {
      return c.json({ error: 'Invalid code/callback URL' }, 400);
    }
    if (parsed.state && parsed.state !== state) {
      return c.json({ error: 'State mismatch' }, 400);
    }
    if (parsed.error) {
      return c.json(
        {
          error: `Google 授权未完成：${parsed.error}${
            parsed.description ? `（${parsed.description}）` : ''
          }。请重新打开授权链接完成登录。`,
          retryable: true,
        },
        400,
      );
    }
    if (!parsed.code) {
      return c.json({ error: 'Missing authorization code' }, 400);
    }

    // Claim the flow so one code is exchanged exactly once.
    geminiOauthFlows.delete(state);
    let login: Awaited<ReturnType<typeof resolveGeminiLogin>>;
    try {
      const token = await exchangeGeminiCode(parsed.code);
      login = await resolveGeminiLogin(token);
    } catch (err) {
      const oauthError = err instanceof GeminiOAuthError ? err : null;
      const reusable = !!oauthError && !oauthError.requestDelivered;
      const transient = !oauthError || oauthError.transient;
      if (reusable && flow.expiresAt > Date.now()) {
        geminiOauthFlows.set(state, flow);
      }
      logger.warn(
        { err, transient, reusable },
        'Gemini OAuth token exchange error',
      );
      const message =
        err instanceof Error ? err.message : 'Gemini OAuth 授权失败';
      return c.json(
        {
          error: reusable
            ? `${message}；可以直接重试，无需重新授权`
            : transient
              ? `${message}；授权码可能已被使用，请重新登录 Google 账号`
              : `${message}；授权码已失效，请重新登录 Google 账号`,
          retryable: reusable,
        },
        transient ? 502 : 400,
      );
    }

    const actor = (c.get('user') as AuthUser).username;
    const defaultModel = pickGeminiDefaultModel(login.catalog);
    const models = toProviderModels(login.catalog);
    try {
      return await withClaudeConfigMutationLock(async () => {
        if (!flow.targetProviderId) {
          const provider = createProvider({
            name: providerLabel(login.credentials),
            type: 'third_party',
            anthropicBaseUrl: GEMINI_GATEWAY_BASE_URL_PLACEHOLDER,
            // Internal gateway credential; Google tokens never leave the server.
            anthropicAuthToken: randomBytes(32).toString('hex'),
            anthropicModel: defaultModel,
            models,
            customEnv: { ...CONNECTION_ENV_PREFILL },
            geminiOAuthCredentials: login.credentials,
            geminiModels: login.catalog,
          });
          appendClaudeConfigAuditBestEffort(actor, 'gemini_oauth_login', [
            `providerId:${provider.id}`,
            'geminiOAuthCredentials:set',
          ]);
          bindSystemMainIfUnbound(provider.id);
          logConfiguredGemini(provider.id, login);
          return c.json(toPublicProvider(provider));
        }

        const id = flow.targetProviderId;
        const previous = getProviderById(id);
        if (!previous) return c.json({ error: '未找到指定供应商' }, 404);
        const previousAccount = previous.geminiOAuthCredentials;
        const converted = !previousAccount;
        const accountChanged = geminiAccountChanged(
          previousAccount,
          login.credentials,
        );
        // Keep the session's model when the new account still offers it.
        const keepCurrent =
          !!previous.anthropicModel &&
          login.catalog.some((model) => model.id === previous.anthropicModel);
        const commit = () => {
          updateProvider(id, {
            anthropicBaseUrl: GEMINI_GATEWAY_BASE_URL_PLACEHOLDER,
            anthropicModel: keepCurrent
              ? previous.anthropicModel
              : defaultModel,
            models,
          });
          return updateProviderSecrets(id, {
            geminiOAuthCredentials: login.credentials,
            clearAnthropicApiKey: true,
            clearClaudeOAuthCredentials: true,
            clearClaudeCodeOauthToken: true,
            // A connection converted from a relay needs a fresh identifier.
            ...(converted
              ? { anthropicAuthToken: randomBytes(32).toString('hex') }
              : {}),
          });
        };

        // Thought signatures are bound to the account that produced them and
        // the transcript may name models the new account lacks: quiesce
        // runners and drop this provider's sessions when the account changed.
        const mutation: ClaudeMutationResult<UnifiedProvider> = accountChanged
          ? await mutateClaudeConfigForAllGroups(
              actor,
              {
                trigger: 'gemini_oauth_reauthorize',
                providerId: id,
                converted,
              },
              commit,
              {
                clearSessionsForProviderId: id,
                sessionInvalidation: {
                  modelChanged: true,
                  baseUrlChanged: true,
                },
              },
            )
          : {
              value: commit(),
              applied: {
                success: true,
                stoppedCount: 0,
                failedCount: 0,
                persisted: true,
              },
            };
        if (!mutation.applied.success) {
          return c.json(
            {
              error: mutation.applied.error,
              applied: mutation.applied,
              ...(mutation.value
                ? { provider: toPublicProvider(mutation.value) }
                : {}),
            },
            503,
          );
        }
        appendClaudeConfigAuditBestEffort(actor, 'gemini_oauth_login', [
          `providerId:${id}`,
          'geminiOAuthCredentials:set',
          ...(converted ? ['converted'] : []),
          ...(accountChanged ? ['accountChanged'] : []),
        ]);
        if (mutation.value) providerPool.resetHealth(id);
        logConfiguredGemini(id, login);
        return c.json(toPublicProvider(mutation.value!));
      });
    } catch (err) {
      logger.error({ err }, 'Gemini OAuth provider update error');
      return c.json(
        {
          error:
            err instanceof Error
              ? err.message
              : 'Gemini OAuth provider update failed',
        },
        500,
      );
    }
  },
);

// ─── POST /gemini/models/refresh — 重新拉取上游模型目录 ─────────────
geminiRoutes.post(
  '/gemini/models/refresh',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const providerId =
      typeof (body as Record<string, unknown>).providerId === 'string'
        ? ((body as Record<string, unknown>).providerId as string)
        : '';
    const provider = providerId ? getProviderById(providerId) : null;
    if (!provider || !provider.geminiOAuthCredentials) {
      return c.json({ error: 'Gemini provider not found' }, 404);
    }
    if (!provider.geminiOAuthCredentials.projectId) {
      return c.json(
        { error: '该连接缺少项目 ID，请重新登录 Google 账号' },
        400,
      );
    }
    try {
      const access = await resolveGeminiAccess(providerId);
      const projectId = access.credentials.projectId;
      if (!projectId) {
        return c.json(
          { error: '该连接缺少项目 ID，请重新登录 Google 账号' },
          400,
        );
      }
      const catalog = await fetchGeminiModels(access.accessToken, projectId);
      if (catalog.length === 0) {
        return c.json({ error: '上游没有返回可用模型' }, 502);
      }
      const updated = setProviderGeminiModels(providerId, catalog);
      // Keep the connection's model list (context windows) in sync so the
      // model picker and launch env see the same catalog.
      const defaultModel = pickGeminiDefaultModel(catalog);
      const keepCurrent = catalog.some(
        (model) => model.id === updated.anthropicModel,
      );
      const withModels = updateProvider(providerId, {
        models: toProviderModels(catalog),
        ...(keepCurrent ? {} : { anthropicModel: defaultModel }),
      });
      return c.json(toPublicProvider(withModels));
    } catch (err) {
      logger.warn({ err, providerId }, 'Gemini model catalog refresh failed');
      return c.json(
        {
          error: err instanceof Error ? err.message : 'Gemini 模型目录刷新失败',
        },
        502,
      );
    }
  },
);

// ─── POST /gemini/disconnect — 退出 Google 账号 ────────────────────
geminiRoutes.post(
  '/gemini/disconnect',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const providerId =
      typeof (body as Record<string, unknown>).providerId === 'string'
        ? ((body as Record<string, unknown>).providerId as string)
        : '';
    const provider = getProviders().find((entry) => entry.id === providerId);
    if (!provider || !provider.geminiOAuthCredentials) {
      return c.json({ error: 'Gemini provider not found' }, 404);
    }
    try {
      const updated = updateProviderSecrets(providerId, {
        clearGeminiOAuthCredentials: true,
        clearAnthropicAuthToken: true,
      });
      logger.info({ providerId }, 'Gemini OAuth: disconnected');
      return c.json(toPublicProvider(updated));
    } catch (err) {
      logger.error({ err, providerId }, 'Gemini disconnect failed');
      return c.json(
        {
          error: err instanceof Error ? err.message : 'Gemini 退出登录失败',
        },
        500,
      );
    }
  },
);

export default geminiRoutes;
