// Configuration management routes

import { randomBytes, createHash } from 'node:crypto';
import { Agent as HttpsAgent } from 'node:https';
import { Hono } from 'hono';
import type { Variables } from '../web-context.js';
import { deleteRegisteredGroup, deleteChatHistory } from '../db.js';
import { authMiddleware, systemConfigMiddleware } from '../middleware/auth.js';
import {
  ClaudeConfigSchema,
  ClaudeSecretsSchema,
  ClaudeCustomEnvSchema,
  FeishuConfigSchema,
  TelegramConfigSchema,
  RegistrationConfigSchema,
  AppearanceConfigSchema,
  SystemSettingsSchema,
} from '../schemas.js';
import {
  getClaudeProviderConfig,
  toPublicClaudeProviderConfig,
  saveClaudeProviderConfig,
  appendClaudeConfigAudit,
  getGlobalClaudeCustomEnv,
  saveGlobalClaudeCustomEnv,
  getFeishuProviderConfig,
  getFeishuProviderConfigWithSource,
  toPublicFeishuProviderConfig,
  saveFeishuProviderConfig,
  getTelegramProviderConfig,
  getTelegramProviderConfigWithSource,
  toPublicTelegramProviderConfig,
  saveTelegramProviderConfig,
  getRegistrationConfig,
  saveRegistrationConfig,
  getAppearanceConfig,
  saveAppearanceConfig,
  getSystemSettings,
  saveSystemSettings,
  getUserFeishuConfig,
  saveUserFeishuConfig,
  getUserTelegramConfig,
  saveUserTelegramConfig,
  updateAllSessionCredentials,
} from '../runtime-config.js';
import type { ClaudeOAuthCredentials } from '../runtime-config.js';
import type { AuthUser } from '../types.js';
import { hasPermission } from '../permissions.js';
import { logger } from '../logger.js';

const configRoutes = new Hono<{ Variables: Variables }>();

// Inject deps at runtime
let deps: any = null;
export function injectConfigDeps(d: any) {
  deps = d;
}

// --- Routes ---

configRoutes.get('/claude', authMiddleware, systemConfigMiddleware, (c) => {
  try {
    return c.json(toPublicClaudeProviderConfig(getClaudeProviderConfig()));
  } catch (err) {
    logger.error({ err }, 'Failed to load Claude config');
    return c.json({ error: 'Failed to load Claude config' }, 500);
  }
});

configRoutes.get(
  '/claude/custom-env',
  authMiddleware,
  systemConfigMiddleware,
  (c) => {
    try {
      const user = c.get('user') as AuthUser;
      const customEnv = getGlobalClaudeCustomEnv();
      if (!hasPermission(user, 'manage_system_config')) {
        return c.json({ customEnv: {} });
      }
      return c.json({ customEnv });
    } catch (err) {
      logger.error({ err }, 'Failed to load Claude custom env');
      return c.json({ error: 'Failed to load Claude custom env' }, 500);
    }
  },
);

configRoutes.put(
  '/claude',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const validation = ClaudeConfigSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }

    const actor = (c.get('user') as AuthUser).username;
    const current = getClaudeProviderConfig();

    try {
      const saved = saveClaudeProviderConfig({
        anthropicBaseUrl: validation.data.anthropicBaseUrl,
        anthropicAuthToken: current.anthropicAuthToken,
        anthropicApiKey: current.anthropicApiKey,
        claudeCodeOauthToken: current.claudeCodeOauthToken,
        claudeOAuthCredentials: current.claudeOAuthCredentials,
      });
      appendClaudeConfigAudit(actor, 'update_base_url', ['anthropicBaseUrl']);
      return c.json(toPublicClaudeProviderConfig(saved));
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Invalid Claude config payload';
      logger.warn({ err }, 'Invalid Claude config payload');
      return c.json({ error: message }, 400);
    }
  },
);

configRoutes.put(
  '/claude/custom-env',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const validation = ClaudeCustomEnvSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }

    try {
      const saved = saveGlobalClaudeCustomEnv(validation.data.customEnv);
      return c.json({ customEnv: saved });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Invalid custom env payload';
      logger.warn({ err }, 'Invalid Claude custom env payload');
      return c.json({ error: message }, 400);
    }
  },
);

configRoutes.put(
  '/claude/secrets',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));

    const validation = ClaudeSecretsSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }

    const actor = (c.get('user') as AuthUser).username;
    const current = getClaudeProviderConfig();

    const next = { ...current };
    const changedFields: string[] = [];

    if (typeof validation.data.anthropicAuthToken === 'string') {
      next.anthropicAuthToken = validation.data.anthropicAuthToken;
      changedFields.push('anthropicAuthToken:set');
    } else if (validation.data.clearAnthropicAuthToken === true) {
      next.anthropicAuthToken = '';
      changedFields.push('anthropicAuthToken:clear');
    }

    if (typeof validation.data.anthropicApiKey === 'string') {
      next.anthropicApiKey = validation.data.anthropicApiKey;
      changedFields.push('anthropicApiKey:set');
    } else if (validation.data.clearAnthropicApiKey === true) {
      next.anthropicApiKey = '';
      changedFields.push('anthropicApiKey:clear');
    }

    if (typeof validation.data.claudeCodeOauthToken === 'string') {
      next.claudeCodeOauthToken = validation.data.claudeCodeOauthToken;
      changedFields.push('claudeCodeOauthToken:set');
    } else if (validation.data.clearClaudeCodeOauthToken === true) {
      next.claudeCodeOauthToken = '';
      changedFields.push('claudeCodeOauthToken:clear');
    }

    if (validation.data.claudeOAuthCredentials) {
      next.claudeOAuthCredentials = validation.data.claudeOAuthCredentials;
      // When setting full credentials, clear the legacy single-token field
      next.claudeCodeOauthToken = '';
      changedFields.push('claudeOAuthCredentials:set');
    } else if (validation.data.clearClaudeOAuthCredentials === true) {
      next.claudeOAuthCredentials = null;
      changedFields.push('claudeOAuthCredentials:clear');
    }

    if (changedFields.length === 0) {
      return c.json({ error: 'No secret changes provided' }, 400);
    }

    try {
      const saved = saveClaudeProviderConfig({
        anthropicBaseUrl: next.anthropicBaseUrl,
        anthropicAuthToken: next.anthropicAuthToken,
        anthropicApiKey: next.anthropicApiKey,
        claudeCodeOauthToken: next.claudeCodeOauthToken,
        claudeOAuthCredentials: next.claudeOAuthCredentials,
      });

      // Update .credentials.json in all session directories when credentials change
      if (validation.data.claudeOAuthCredentials) {
        updateAllSessionCredentials(saved);
        deps?.queue?.closeAllActiveForCredentialRefresh();
      }

      appendClaudeConfigAudit(actor, 'update_secrets', changedFields);
      return c.json(toPublicClaudeProviderConfig(saved));
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Invalid Claude config payload';
      logger.warn({ err }, 'Invalid Claude secret payload');
      return c.json({ error: message }, 400);
    }
  },
);

configRoutes.post(
  '/claude/apply',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    if (!deps) return c.json({ error: 'Server not initialized' }, 500);

    const actor = (c.get('user') as AuthUser).username;
    const groupJids = Object.keys(deps.getRegisteredGroups());
    const results = await Promise.allSettled(
      groupJids.map((jid) => deps!.queue.stopGroup(jid)),
    );
    const failedCount = results.filter((r) => r.status === 'rejected').length;
    appendClaudeConfigAudit(actor, 'apply_to_all_flows', ['queue.stopGroup'], {
      stoppedCount: groupJids.length - failedCount,
      failedCount,
    });
    if (failedCount > 0) {
      return c.json(
        {
          success: false,
          stoppedCount: groupJids.length - failedCount,
          failedCount,
          error: `${failedCount} container(s) failed to stop`,
        },
        207,
      );
    }
    return c.json({ success: true, stoppedCount: groupJids.length });
  },
);

// ─── Claude OAuth (PKCE) ─────────────────────────────────────────

const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
const OAUTH_SCOPES = 'org:create_api_key user:profile user:inference';
const OAUTH_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const OAUTH_TOKEN_URL = 'https://api.anthropic.com/v1/oauth/token';
const OAUTH_FLOW_TTL = 10 * 60 * 1000; // 10 minutes

interface OAuthFlow {
  codeVerifier: string;
  expiresAt: number;
}
const oauthFlows = new Map<string, OAuthFlow>();

// Periodic cleanup of expired flows
setInterval(() => {
  const now = Date.now();
  for (const [key, flow] of oauthFlows) {
    if (flow.expiresAt < now) oauthFlows.delete(key);
  }
}, 60_000);

configRoutes.post(
  '/claude/oauth/start',
  authMiddleware,
  systemConfigMiddleware,
  (c) => {
    const state = randomBytes(32).toString('hex');
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256').update(codeVerifier).digest('base64url');

    oauthFlows.set(state, {
      codeVerifier,
      expiresAt: Date.now() + OAUTH_FLOW_TTL,
    });

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: OAUTH_CLIENT_ID,
      redirect_uri: OAUTH_REDIRECT_URI,
      scope: OAUTH_SCOPES,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    return c.json({ authorizeUrl: `${OAUTH_AUTHORIZE_URL}?${params.toString()}`, state });
  },
);

configRoutes.post(
  '/claude/oauth/callback',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { state, code } = body as { state?: string; code?: string };

    if (!state || !code) {
      return c.json({ error: 'Missing state or code' }, 400);
    }

    // Clean up code: strip URL fragments and query params that users may accidentally copy
    const cleanedCode = code.trim().split('#')[0]?.split('&')[0] ?? code.trim();

    const flow = oauthFlows.get(state);
    if (!flow) {
      return c.json({ error: 'Invalid or expired OAuth state' }, 400);
    }
    if (flow.expiresAt < Date.now()) {
      oauthFlows.delete(state);
      return c.json({ error: 'OAuth flow expired' }, 400);
    }
    oauthFlows.delete(state);

    try {
      const tokenResp = await fetch(OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          'Accept': 'application/json, text/plain, */*',
          'Referer': 'https://claude.ai/',
          'Origin': 'https://claude.ai',
        },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: OAUTH_CLIENT_ID,
          code: cleanedCode,
          redirect_uri: OAUTH_REDIRECT_URI,
          code_verifier: flow.codeVerifier,
          state,
        }),
      });

      if (!tokenResp.ok) {
        const errText = await tokenResp.text().catch(() => '');
        logger.warn({ status: tokenResp.status, body: errText }, 'OAuth token exchange failed');
        return c.json({ error: `Token exchange failed: ${tokenResp.status}` }, 400);
      }

      const tokenData = (await tokenResp.json()) as {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
        [key: string]: unknown;
      };

      if (!tokenData.access_token) {
        return c.json({ error: 'No access_token in response' }, 400);
      }

      const actor = (c.get('user') as AuthUser).username;
      const current = getClaudeProviderConfig();

      // Build full OAuth credentials when refresh_token is available
      let oauthCredentials: ClaudeOAuthCredentials | null = null;
      if (tokenData.refresh_token) {
        // expiresAt 计算与 SDK 保持一致：Date.now() + expires_in * 1000
        const expiresAt = tokenData.expires_in
          ? Date.now() + tokenData.expires_in * 1000
          : Date.now() + 8 * 60 * 60 * 1000; // default 8h
        oauthCredentials = {
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token,
          expiresAt,
          scopes: tokenData.scope ? tokenData.scope.split(' ') : [],
        };
      }

      const saved = saveClaudeProviderConfig({
        anthropicBaseUrl: current.anthropicBaseUrl,
        anthropicAuthToken: '',
        anthropicApiKey: '',
        // When we have full credentials, clear the legacy token field
        claudeCodeOauthToken: oauthCredentials ? '' : tokenData.access_token,
        claudeOAuthCredentials: oauthCredentials,
      });

      // Write .credentials.json to all session directories
      if (oauthCredentials) {
        updateAllSessionCredentials(saved);
        deps?.queue?.closeAllActiveForCredentialRefresh();
      }

      appendClaudeConfigAudit(actor, 'oauth_login', [
        oauthCredentials ? 'claudeOAuthCredentials:set' : 'claudeCodeOauthToken:set',
        'anthropicAuthToken:clear',
        'anthropicApiKey:clear',
      ]);

      return c.json(toPublicClaudeProviderConfig(saved));
    } catch (err) {
      logger.error({ err }, 'OAuth token exchange error');
      const message = err instanceof Error ? err.message : 'OAuth token exchange failed';
      return c.json({ error: message }, 500);
    }
  },
);

configRoutes.get('/feishu', authMiddleware, systemConfigMiddleware, (c) => {
  try {
    const { config, source } = getFeishuProviderConfigWithSource();
    const pub = toPublicFeishuProviderConfig(config, source);
    const connected = deps?.isFeishuConnected?.() ?? false;
    return c.json({ ...pub, connected });
  } catch (err) {
    logger.error({ err }, 'Failed to load Feishu config');
    return c.json({ error: 'Failed to load Feishu config' }, 500);
  }
});

configRoutes.put(
  '/feishu',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const validation = FeishuConfigSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }

    const current = getFeishuProviderConfig();
    const next = { ...current };
    if (typeof validation.data.appId === 'string') {
      next.appId = validation.data.appId;
    }
    if (typeof validation.data.appSecret === 'string') {
      next.appSecret = validation.data.appSecret;
    } else if (validation.data.clearAppSecret === true) {
      next.appSecret = '';
    }
    if (typeof validation.data.enabled === 'boolean') {
      next.enabled = validation.data.enabled;
    }

    try {
      const saved = saveFeishuProviderConfig({
        appId: next.appId,
        appSecret: next.appSecret,
        enabled: next.enabled,
      });

      // Hot-reload: reconnect/disconnect Feishu channel
      let connected = false;
      if (deps?.reloadFeishuConnection) {
        try {
          connected = await deps.reloadFeishuConnection(saved);
        } catch (err: unknown) {
          logger.warn({ err }, 'Failed to reload Feishu connection');
        }
      }

      return c.json({ ...toPublicFeishuProviderConfig(saved, 'runtime'), connected });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Invalid Feishu config payload';
      logger.warn({ err }, 'Invalid Feishu config payload');
      return c.json({ error: message }, 400);
    }
  },
);

// ─── Telegram config ─────────────────────────────────────────────

configRoutes.get('/telegram', authMiddleware, systemConfigMiddleware, (c) => {
  try {
    const { config, source } = getTelegramProviderConfigWithSource();
    const pub = toPublicTelegramProviderConfig(config, source);
    const connected = deps?.isTelegramConnected?.() ?? false;
    return c.json({ ...pub, connected });
  } catch (err) {
    logger.error({ err }, 'Failed to load Telegram config');
    return c.json({ error: 'Failed to load Telegram config' }, 500);
  }
});

configRoutes.put(
  '/telegram',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const validation = TelegramConfigSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }

    const current = getTelegramProviderConfig();
    const next = { ...current };
    if (typeof validation.data.botToken === 'string') {
      next.botToken = validation.data.botToken;
    } else if (validation.data.clearBotToken === true) {
      next.botToken = '';
    }
    if (typeof validation.data.enabled === 'boolean') {
      next.enabled = validation.data.enabled;
    }

    try {
      const saved = saveTelegramProviderConfig({
        botToken: next.botToken,
        enabled: next.enabled,
      });

      // Hot-reload: reconnect/disconnect Telegram channel
      let connected = false;
      if (deps?.reloadTelegramConnection) {
        try {
          connected = await deps.reloadTelegramConnection(saved);
        } catch (err: unknown) {
          logger.warn({ err }, 'Failed to reload Telegram connection');
        }
      }

      return c.json({ ...toPublicTelegramProviderConfig(saved, 'runtime'), connected });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Invalid Telegram config payload';
      logger.warn({ err }, 'Invalid Telegram config payload');
      return c.json({ error: message }, 400);
    }
  },
);

configRoutes.post(
  '/telegram/test',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const config = getTelegramProviderConfig();
    if (!config.botToken) {
      return c.json({ error: 'Telegram bot token not configured' }, 400);
    }

    try {
      const { Bot } = await import('grammy');
      const testBot = new Bot(config.botToken, {
        client: {
          timeoutSeconds: 15,
          baseFetchConfig: {
            agent: new HttpsAgent({ keepAlive: false, family: 4 }),
          },
        },
      });

      let me: { username?: string; id: number; first_name: string } | null = null;
      let lastErr: unknown = null;
      for (let i = 0; i < 3; i++) {
        try {
          me = await testBot.api.getMe();
          break;
        } catch (err) {
          lastErr = err;
          // Small retry window for intermittent network timeouts.
          if (i < 2) await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }
      if (!me) {
        throw lastErr instanceof Error ? lastErr : new Error('Telegram API request failed');
      }

      return c.json({
        success: true,
        bot_username: me.username,
        bot_id: me.id,
        bot_name: me.first_name,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to connect to Telegram';
      logger.warn({ err }, 'Failed to test Telegram connection');
      return c.json({ error: message }, 400);
    }
  },
);

// ─── Registration config ─────────────────────────────────────────

configRoutes.get(
  '/registration',
  authMiddleware,
  systemConfigMiddleware,
  (c) => {
    try {
      return c.json(getRegistrationConfig());
    } catch (err) {
      logger.error({ err }, 'Failed to load registration config');
      return c.json({ error: 'Failed to load registration config' }, 500);
    }
  },
);

configRoutes.put(
  '/registration',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const validation = RegistrationConfigSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }

    try {
      const actor = (c.get('user') as AuthUser).username;
      const saved = saveRegistrationConfig(validation.data);
      appendClaudeConfigAudit(actor, 'update_registration_config', [
        'allowRegistration',
        'requireInviteCode',
      ]);
      return c.json(saved);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Invalid registration config payload';
      logger.warn({ err }, 'Invalid registration config payload');
      return c.json({ error: message }, 400);
    }
  },
);

// ─── Appearance config ────────────────────────────────────────────

configRoutes.get(
  '/appearance',
  authMiddleware,
  systemConfigMiddleware,
  (c) => {
    try {
      return c.json(getAppearanceConfig());
    } catch (err) {
      logger.error({ err }, 'Failed to load appearance config');
      return c.json({ error: 'Failed to load appearance config' }, 500);
    }
  },
);

configRoutes.put(
  '/appearance',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const validation = AppearanceConfigSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }

    try {
      const saved = saveAppearanceConfig(validation.data);
      return c.json(saved);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Invalid appearance config payload';
      logger.warn({ err }, 'Invalid appearance config payload');
      return c.json({ error: message }, 400);
    }
  },
);

// Public endpoint — no auth required (like /api/auth/status)
configRoutes.get('/appearance/public', (c) => {
  try {
    const config = getAppearanceConfig();
    return c.json({
      appName: config.appName,
      aiName: config.aiName,
      aiAvatarEmoji: config.aiAvatarEmoji,
      aiAvatarColor: config.aiAvatarColor,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to load public appearance config');
    return c.json({ error: 'Failed to load appearance config' }, 500);
  }
});

// ─── System settings ───────────────────────────────────────────────

configRoutes.get(
  '/system',
  authMiddleware,
  systemConfigMiddleware,
  (c) => {
    try {
      return c.json(getSystemSettings());
    } catch (err) {
      logger.error({ err }, 'Failed to load system settings');
      return c.json({ error: 'Failed to load system settings' }, 500);
    }
  },
);

configRoutes.put(
  '/system',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const validation = SystemSettingsSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }

    try {
      const saved = saveSystemSettings(validation.data);
      return c.json(saved);
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : 'Invalid system settings payload';
      logger.warn({ err }, 'Invalid system settings payload');
      return c.json({ error: message }, 400);
    }
  },
);

// ─── Per-user IM connection status ──────────────────────────────────

configRoutes.get('/user-im/status', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  return c.json({
    feishu: deps?.isUserFeishuConnected?.(user.id) ?? false,
    telegram: deps?.isUserTelegramConnected?.(user.id) ?? false,
  });
});

// ─── Per-user IM config (all logged-in users) ─────────────────────

configRoutes.get('/user-im/feishu', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  try {
    const config = getUserFeishuConfig(user.id);
    if (!config) {
      return c.json({
        appId: '',
        hasAppSecret: false,
        appSecretMasked: null,
        enabled: false,
        updatedAt: null,
      });
    }
    return c.json(toPublicFeishuProviderConfig(config, 'runtime'));
  } catch (err) {
    logger.error({ err }, 'Failed to load user Feishu config');
    return c.json({ error: 'Failed to load user Feishu config' }, 500);
  }
});

configRoutes.put('/user-im/feishu', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const validation = FeishuConfigSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }

  const current = getUserFeishuConfig(user.id);
  const next = {
    appId: current?.appId || '',
    appSecret: current?.appSecret || '',
    enabled: current?.enabled ?? true,
    updatedAt: current?.updatedAt || null,
  };
  if (typeof validation.data.appId === 'string') {
    const appId = validation.data.appId.trim();
    if (appId) next.appId = appId;
  }
  if (typeof validation.data.appSecret === 'string') {
    const appSecret = validation.data.appSecret.trim();
    if (appSecret) next.appSecret = appSecret;
  } else if (validation.data.clearAppSecret === true) {
    next.appSecret = '';
  }
  if (typeof validation.data.enabled === 'boolean') {
    next.enabled = validation.data.enabled;
  } else if (!current && (next.appId || next.appSecret)) {
    // First-time config with credentials should connect immediately.
    next.enabled = true;
  }

  try {
    const saved = saveUserFeishuConfig(user.id, {
      appId: next.appId,
      appSecret: next.appSecret,
      enabled: next.enabled,
    });

    // Hot-reload: reconnect user's Feishu channel
    if (deps?.reloadUserIMConfig) {
      try {
        await deps.reloadUserIMConfig(user.id, 'feishu');
      } catch (err) {
        logger.warn({ err, userId: user.id }, 'Failed to hot-reload user Feishu connection');
      }
    }

    return c.json(toPublicFeishuProviderConfig(saved, 'runtime'));
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Invalid Feishu config payload';
    logger.warn({ err }, 'Invalid user Feishu config payload');
    return c.json({ error: message }, 400);
  }
});

configRoutes.get('/user-im/telegram', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  try {
    const config = getUserTelegramConfig(user.id);
    if (!config) {
      return c.json({
        hasBotToken: false,
        botTokenMasked: null,
        enabled: false,
        updatedAt: null,
      });
    }
    return c.json(toPublicTelegramProviderConfig(config, 'runtime'));
  } catch (err) {
    logger.error({ err }, 'Failed to load user Telegram config');
    return c.json({ error: 'Failed to load user Telegram config' }, 500);
  }
});

configRoutes.put('/user-im/telegram', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const validation = TelegramConfigSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }

  const current = getUserTelegramConfig(user.id);
  const next = {
    botToken: current?.botToken || '',
    enabled: current?.enabled ?? true,
    updatedAt: current?.updatedAt || null,
  };
  if (typeof validation.data.botToken === 'string') {
    const botToken = validation.data.botToken.trim();
    if (botToken) next.botToken = botToken;
  } else if (validation.data.clearBotToken === true) {
    next.botToken = '';
  }
  if (typeof validation.data.enabled === 'boolean') {
    next.enabled = validation.data.enabled;
  } else if (!current && next.botToken) {
    // First-time config with token should connect immediately.
    next.enabled = true;
  }

  try {
    const saved = saveUserTelegramConfig(user.id, {
      botToken: next.botToken,
      enabled: next.enabled,
    });

    // Hot-reload: reconnect user's Telegram channel
    if (deps?.reloadUserIMConfig) {
      try {
        await deps.reloadUserIMConfig(user.id, 'telegram');
      } catch (err) {
        logger.warn({ err, userId: user.id }, 'Failed to hot-reload user Telegram connection');
      }
    }

    return c.json(toPublicTelegramProviderConfig(saved, 'runtime'));
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Invalid Telegram config payload';
    logger.warn({ err }, 'Invalid user Telegram config payload');
    return c.json({ error: message }, 400);
  }
});

configRoutes.post('/user-im/telegram/test', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const config = getUserTelegramConfig(user.id);
  if (!config?.botToken) {
    return c.json({ error: 'Telegram bot token not configured' }, 400);
  }

  try {
    const { Bot } = await import('grammy');
    const testBot = new Bot(config.botToken);
    const me = await testBot.api.getMe();
    return c.json({
      success: true,
      bot_username: me.username,
      bot_id: me.id,
      bot_name: me.first_name,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to connect to Telegram';
    logger.warn({ err }, 'Failed to test user Telegram connection');
    return c.json({ error: message }, 400);
  }
});

configRoutes.post('/user-im/telegram/pairing-code', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const config = getUserTelegramConfig(user.id);
  if (!config?.botToken) {
    return c.json({ error: 'Telegram bot token not configured' }, 400);
  }

  try {
    const { generatePairingCode } = await import('../telegram-pairing.js');
    const result = generatePairingCode(user.id);
    return c.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to generate pairing code';
    logger.warn({ err }, 'Failed to generate pairing code');
    return c.json({ error: message }, 500);
  }
});

// List Telegram paired chats for the current user
configRoutes.get('/user-im/telegram/paired-chats', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const groups = (deps?.getRegisteredGroups() ?? {}) as Record<string, { name: string; added_at: string; created_by?: string }>;
  const chats: Array<{ jid: string; name: string; addedAt: string }> = [];
  for (const [jid, group] of Object.entries(groups)) {
    if (jid.startsWith('telegram:') && group.created_by === user.id) {
      chats.push({ jid, name: group.name, addedAt: group.added_at });
    }
  }
  return c.json({ chats });
});

// Remove (unpair) a Telegram chat
configRoutes.delete('/user-im/telegram/paired-chats/:jid', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const jid = decodeURIComponent(c.req.param('jid'));

  if (!jid.startsWith('telegram:')) {
    return c.json({ error: 'Invalid Telegram chat JID' }, 400);
  }

  const groups = deps?.getRegisteredGroups() ?? {};
  const group = groups[jid];
  if (!group) {
    return c.json({ error: 'Chat not found' }, 404);
  }
  if (group.created_by !== user.id) {
    return c.json({ error: 'Not authorized to remove this chat' }, 403);
  }

  deleteRegisteredGroup(jid);
  deleteChatHistory(jid);
  delete groups[jid];
  logger.info({ jid, userId: user.id }, 'Telegram chat unpaired');
  return c.json({ success: true });
});

export default configRoutes;
