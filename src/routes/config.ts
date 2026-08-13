// Configuration management routes

import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Agent as HttpsAgent } from 'node:https';
import { ProxyAgent } from 'proxy-agent';
import QRCode from 'qrcode';
import { Hono } from 'hono';
import { DATA_DIR } from '../config.js';
import {
  avatarUploadBodyLimit,
  AVATAR_MAX_FILE_BYTES,
} from '../http-upload-policy.js';
import type { Variables } from '../web-context.js';
import { canAccessGroup, canModifyGroup, getWebDeps } from '../web-context.js';
import { extractChatId, getChannelType } from '../im-channel.js';
import {
  deleteRegisteredGroup,
  deleteChatHistory,
  deleteAgent,
  getRegisteredGroup,
  getAllRegisteredGroups,
  forceActiveAdminRuntimesToHost,
  setRegisteredGroup,
  updateChatName,
  getAgent,
  getAgentProfileForWorkspace,
  getUserById,
  logAuthEvent,
  deleteWorkspaceSessions,
  deleteSessionsByProviderIdAroundCommit,
  getSession,
  getRouterState,
  getRouterStateByPrefix,
  setRouterState,
  deleteRouterState,
  isDatabaseInitialized,
  VALID_ACTIVATION_MODES,
  getDefaultChannelAccount,
  getLegacyChannelAccount,
  getChannelAccount,
  getGroupsByTargetAgent,
  updateAgentLastImJid,
  countAgentProfilesByModelConfigId,
} from '../db.js';
import {
  channelConversationJid,
  parseChannelAddress,
} from '../channel-address.js';
import { isMentionActivationMode } from '../feishu-conversation-policy.js';
import { normalizeLegacyOwnerMention } from '../im-audience-policy.js';
import {
  conversationBindingPolicyError,
  resolveChannelConversationKind,
  type ChannelConversationKind,
} from '../channel-conversation-kind.js';
import {
  adminRoleMiddleware,
  authMiddleware,
  systemConfigMiddleware,
} from '../middleware/auth.js';
import {
  ClaudeCustomEnvSchema,
  FeishuConfigSchema,
  TelegramConfigSchema,
  QQConfigSchema,
  WeChatConfigSchema,
  DingTalkConfigSchema,
  DiscordConfigSchema,
  WhatsAppConfigSchema,
  RegistrationConfigSchema,
  AppearanceConfigSchema,
  HostIntegrationSettingsSchema,
  SystemSettingsSchema,
  UnifiedProviderCreateSchema,
  UnifiedProviderPatchSchema,
  UnifiedProviderSecretsSchema,
  BalancingConfigSchema,
} from '../schemas.js';
import {
  getClaudeProviderConfig,
  toPublicClaudeProviderConfig,
  appendClaudeConfigAudit,
  getProviders,
  getEnabledProviders,
  getDefaultProviderId,
  setDefaultProvider,
  getBalancingConfig,
  saveBalancingConfig,
  createProvider,
  updateProvider,
  updateProviderSecrets,
  setProviderEnabled,
  deleteProvider,
  providerToConfig,
  toPublicProvider,
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
  getEffectiveExternalDir,
  getContainerEnvConfig,
  saveSystemSettings,
  getUserFeishuConfig,
  saveUserFeishuConfig,
  getUserTelegramConfig,
  saveUserTelegramConfig,
  getUserQQConfig,
  saveUserQQConfig,
  getUserWeChatConfig,
  saveUserWeChatConfig,
  getUserDingTalkConfig,
  saveUserDingTalkConfig,
  getUserDiscordConfig,
  saveUserDiscordConfig,
  getUserWhatsAppConfig,
  saveUserWhatsAppConfig,
  updateAllSessionCredentials,
  appendImConfigAudit,
} from '../runtime-config.js';
import type {
  ClaudeOAuthCredentials,
  CachedOAuthUsage,
  OAuthUsageResponse,
  OAuthUsageBucket,
} from '../runtime-config.js';
import { parseOAuthUsageBucket } from '../runtime-config.js';
import type { AudienceMode, AuthUser, RegisteredGroup } from '../types.js';
import { hasPermission } from '../permissions.js';
import { logger } from '../logger.js';
import brandAssetRoutes from './brand-assets.js';
import { testFeishuCredentials } from '../feishu-connectivity.js';
import {
  buildSessionMountUpdate,
  buildDetachedWorkspaceUpdate,
  buildWorkspaceMountUpdate,
  commitChannelMountUpdate,
  hasRemainingThreadMapMount,
  hasSessionMountConflict,
  hasWorkspaceMountConflict,
  isNativeContextContainer,
  restoreDefaultChannelMount,
  type NativeContextMetadata,
} from '../channel-mount-service.js';
import { checkImChannelLimit, isBillingEnabled } from '../billing.js';
import { providerPool } from '../provider-pool.js';
import { getClientIp } from '../utils.js';
import {
  getWorkspaceRuntimeJids,
  quiesceWorkspaceRunnersAroundCommit,
  resolveEffectiveAgentProfile,
  withAgentProfileLocks,
  WorkspaceRuntimeQuiesceError,
} from '../agent-profile-runtime.js';
import { notifyTaskSchedulerChanged } from '../task-scheduler.js';
import {
  SYSTEM_CAPABILITY_LOCK_KEY,
  withCapabilityScopeLocks,
} from '../capability-lock.js';
import {
  ADMIN_HOST_ONLY_RUNTIME_SAFETY_SOURCE,
  clearAdminHostOnlyCleanupPending,
  getPendingAdminHostOnlyCleanupFolders,
  markAdminHostOnlyCleanupPending,
  restorePendingAdminHostOnlyRuntimeSafetyBlocks,
} from '../admin-host-only-runtime.js';
const configRoutes = new Hono<{ Variables: Variables }>();

/**
 * Count how many IM channels are currently enabled for a user, excluding the given channel.
 * Used for billing limit checks when enabling a new channel.
 */
function countOtherEnabledImChannels(
  userId: string,
  excludeChannel:
    | 'feishu'
    | 'telegram'
    | 'qq'
    | 'wechat'
    | 'dingtalk'
    | 'discord'
    | 'whatsapp',
): number {
  let count = 0;
  if (excludeChannel !== 'feishu' && getUserFeishuConfig(userId)?.enabled)
    count++;
  if (excludeChannel !== 'telegram' && getUserTelegramConfig(userId)?.enabled)
    count++;
  if (excludeChannel !== 'wechat' && getUserWeChatConfig(userId)?.enabled)
    count++;
  if (excludeChannel !== 'qq' && getUserQQConfig(userId)?.enabled) count++;
  if (excludeChannel !== 'dingtalk' && getUserDingTalkConfig(userId)?.enabled)
    count++;
  if (excludeChannel !== 'discord' && getUserDiscordConfig(userId)?.enabled)
    count++;
  if (excludeChannel !== 'whatsapp' && getUserWhatsAppConfig(userId)?.enabled)
    count++;
  return count;
}

// Inject deps at runtime
let deps: any = null;
export function injectConfigDeps(d: any) {
  deps = d;
  restorePendingProviderRuntimeSafetyBlocks();
  restorePendingAdminHostOnlyRuntimeSafetyBlocks(d);
}

function createTelegramApiAgent(proxyUrl?: string): HttpsAgent | ProxyAgent {
  if (proxyUrl && proxyUrl.trim()) {
    const fixedProxyUrl = proxyUrl.trim();
    return new ProxyAgent({
      getProxyForUrl: () => fixedProxyUrl,
    });
  }
  return new HttpsAgent({ keepAlive: false, family: 4 });
}

function destroyTelegramApiAgent(agent: HttpsAgent | ProxyAgent): void {
  agent.destroy();
}

interface ClaudeApplyResultPayload {
  success: boolean;
  stoppedCount: number;
  failedCount: number;
  clearedSessionsCount?: number;
  /** Whether the config mutation itself was durably written. */
  persisted?: boolean;
  phase?: 'pre_commit' | 'post_commit';
  error?: string;
}

interface ApplyOptions {
  /**
   * If set, drop only sticky session bindings that point to this provider —
   * preserves bindings to unrelated providers. Used when a provider's
   * protocol-level fields (anthropicBaseUrl / anthropicModel) change.
   */
  clearSessionsForProviderId?: string;
  sessionInvalidation?: {
    modelChanged: boolean;
    baseUrlChanged: boolean;
  };
}

interface PendingProviderSessionInvalidation {
  providerId: string;
  modelChanged: boolean;
  baseUrlChanged: boolean;
}

const PROVIDER_INVALIDATION_STATE_PREFIX =
  'provider_session_invalidation_pending:';
const PROVIDER_RUNTIME_SAFETY_SOURCE = 'provider-config-mutation';
const volatilePendingProviderSessionInvalidations = new Map<
  string,
  PendingProviderSessionInvalidation
>();

function providerInvalidationStateKey(providerId: string): string {
  return `${PROVIDER_INVALIDATION_STATE_PREFIX}${providerId}`;
}

function getPendingProviderSessionInvalidation(
  providerId: string,
): PendingProviderSessionInvalidation | undefined {
  const raw = getRouterState(providerInvalidationStateKey(providerId));
  const volatile = volatilePendingProviderSessionInvalidations.get(providerId);
  let durable: PendingProviderSessionInvalidation | undefined;
  if (raw) {
    try {
      const parsed = JSON.parse(
        raw,
      ) as Partial<PendingProviderSessionInvalidation>;
      if (parsed.providerId === providerId) {
        durable = {
          providerId,
          modelChanged: parsed.modelChanged === true,
          baseUrlChanged: parsed.baseUrlChanged === true,
        };
      } else {
        durable = {
          providerId,
          modelChanged: true,
          baseUrlChanged: true,
        };
      }
    } catch {
      // A corrupt marker must remain repairable rather than becoming a
      // permanent global gate. Conservatively replay both invalidations when
      // this provider is next PATCHed.
      durable = {
        providerId,
        modelChanged: true,
        baseUrlChanged: true,
      };
    }
  }
  if (!durable) return volatile;
  if (!volatile) return durable;
  return {
    providerId,
    modelChanged: durable.modelChanged || volatile.modelChanged,
    baseUrlChanged: durable.baseUrlChanged || volatile.baseUrlChanged,
  };
}

function setPendingProviderSessionInvalidation(
  pending: PendingProviderSessionInvalidation,
): void {
  const previous = getPendingProviderSessionInvalidation(pending.providerId);
  const merged = {
    providerId: pending.providerId,
    modelChanged: pending.modelChanged || previous?.modelChanged === true,
    baseUrlChanged: pending.baseUrlChanged || previous?.baseUrlChanged === true,
  };
  // Keep an in-process repair path even if durable state persistence fails.
  volatilePendingProviderSessionInvalidations.set(pending.providerId, merged);
  setRouterState(
    providerInvalidationStateKey(pending.providerId),
    JSON.stringify(merged),
  );
}

function clearPendingProviderSessionInvalidation(providerId: string): void {
  deleteRouterState(providerInvalidationStateKey(providerId));
  volatilePendingProviderSessionInvalidations.delete(providerId);
}

function hasPendingProviderSessionInvalidations(): boolean {
  return (
    volatilePendingProviderSessionInvalidations.size > 0 ||
    getRouterStateByPrefix(PROVIDER_INVALIDATION_STATE_PREFIX).length > 0
  );
}

/**
 * Runtime-safety blocks live in memory, while incomplete provider session
 * invalidations are durable. Rebuild the gate when web dependencies are
 * injected after a process restart so no stale session can resume before an
 * exact provider PATCH repairs the pending cleanup.
 */
function restorePendingProviderRuntimeSafetyBlocks(): void {
  if (!deps || !isDatabaseInitialized()) return;
  const durableRows = getRouterStateByPrefix(
    PROVIDER_INVALIDATION_STATE_PREFIX,
  );
  const configuredProviderIds = new Set(
    getProviders().map((provider) => provider.id),
  );
  const pendingProviderIds = new Set([
    ...durableRows.map((row) =>
      row.key.slice(PROVIDER_INVALIDATION_STATE_PREFIX.length),
    ),
    ...volatilePendingProviderSessionInvalidations.keys(),
  ]);
  for (const providerId of pendingProviderIds) {
    if (providerId && configuredProviderIds.has(providerId)) continue;
    if (providerId) {
      const cleanup = deleteSessionsByProviderIdAroundCommit(
        providerId,
        undefined,
        () => undefined,
      );
      syncProviderSessionCaches(cleanup.affectedFolders);
    }
    deleteRouterState(providerInvalidationStateKey(providerId));
    volatilePendingProviderSessionInvalidations.delete(providerId);
    pendingProviderIds.delete(providerId);
    logger.warn(
      { providerId },
      'Removed orphaned provider session invalidation marker during startup',
    );
  }
  if (pendingProviderIds.size === 0) return;
  const runtimeJids = Array.from(
    new Set(
      getClaudeRuntimeTargets().flatMap((target) =>
        getWorkspaceRuntimeJids(deps, target.folder, target.primaryJid),
      ),
    ),
  );
  deps.queue.blockGroupsForRuntimeSafety(
    runtimeJids,
    `provider session invalidation pending after restart: ${pendingProviderIds.size}`,
    PROVIDER_RUNTIME_SAFETY_SOURCE,
  );
}

interface ClaudeMutationResult<T> {
  value?: T;
  applied: ClaudeApplyResultPayload;
}

class ClaudeConfigPersistedError<T> extends Error {
  constructor(
    public readonly persistedValue: T,
    public readonly cause: unknown,
  ) {
    super(
      cause instanceof Error
        ? cause.message
        : 'Provider configuration was persisted but a follow-up action failed',
    );
    this.name = 'ClaudeConfigPersistedError';
  }
}

function runAfterProviderPersistence<T>(
  persistedValue: T,
  followUp: () => void,
): T {
  try {
    followUp();
    return persistedValue;
  } catch (error) {
    throw new ClaudeConfigPersistedError(persistedValue, error);
  }
}

function appendClaudeConfigAuditBestEffort(
  actor: string,
  action: string,
  changedFields: string[],
  metadata?: Record<string, unknown>,
): void {
  try {
    appendClaudeConfigAudit(actor, action, changedFields, metadata);
  } catch (error) {
    logger.error(
      { error, actor, action },
      'Provider configuration audit append failed after persistence',
    );
  }
}

let claudeConfigMutationTail: Promise<void> = Promise.resolve();

async function withClaudeConfigMutationLock<T>(
  fn: () => Promise<T>,
): Promise<T> {
  const previous = claudeConfigMutationTail;
  let release!: () => void;
  claudeConfigMutationTail = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

function hasWorkspaceProviderOverride(
  folder: string,
  invalidation?: ApplyOptions['sessionInvalidation'],
): boolean {
  if (!invalidation) return false;
  const override = getContainerEnvConfig(folder);
  // Shadowing is field-specific. Credentials do not protect a workspace from
  // inheriting a changed global model or Base URL, and when both fields change
  // the workspace must override both before its legacy NULL-bound session is
  // safe to preserve.
  const modelChangeIsShadowed =
    !invalidation.modelChanged || !!override.anthropicModel;
  const baseUrlChangeIsShadowed =
    !invalidation.baseUrlChanged || !!override.anthropicBaseUrl;
  return modelChangeIsShadowed && baseUrlChangeIsShadowed;
}

function getSafeLegacyUnboundFolders(
  providerId: string,
  invalidation?: ApplyOptions['sessionInvalidation'],
): string[] {
  if (!deps) return [];
  const configuredProviders = getProviders();
  if (
    configuredProviders.length !== 1 ||
    configuredProviders[0]?.id !== providerId
  ) {
    return [];
  }
  return Array.from(
    new Set(
      Object.values(
        deps.getRegisteredGroups() as Record<string, RegisteredGroup>,
      )
        .map((group) => group.folder)
        .filter(
          (folder) => !hasWorkspaceProviderOverride(folder, invalidation),
        ),
    ),
  );
}

function getProviderSessionCleanupOptions(
  providerId: string,
  invalidation?: ApplyOptions['sessionInvalidation'],
): { includeUnboundFolders: string[] } {
  return {
    includeUnboundFolders: getSafeLegacyUnboundFolders(
      providerId,
      invalidation,
    ),
  };
}

function syncProviderSessionCaches(affectedFolders: string[]): void {
  if (!deps) return;
  for (const folder of affectedFolders) {
    const remainingMainSession = getSession(folder);
    if (remainingMainSession !== undefined) {
      deps.sessions[folder] = remainingMainSession;
    } else {
      delete deps.sessions[folder];
    }
  }
}

function commitProviderConfigWithSessionInvalidation<T>(
  providerId: string,
  invalidation: ApplyOptions['sessionInvalidation'],
  commit: () => T,
): { value: T; clearedSessionsCount: number } {
  const result = deleteSessionsByProviderIdAroundCommit(
    providerId,
    getProviderSessionCleanupOptions(providerId, invalidation),
    commit,
  );
  syncProviderSessionCaches(result.affectedFolders);
  return { value: result.value, clearedSessionsCount: result.deletedCount };
}

function getClaudeRuntimeTargets(): Array<{
  folder: string;
  primaryJid: string;
}> {
  if (!deps) return [];
  const targets = new Map<string, { folder: string; primaryJid: string }>();
  for (const [jid, group] of Object.entries(
    deps.getRegisteredGroups() as Record<string, RegisteredGroup>,
  )) {
    if (!targets.has(group.folder)) {
      targets.set(group.folder, { folder: group.folder, primaryJid: jid });
    }
  }
  return [...targets.values()];
}

function getKnownClaudeRuntimeJids(): string[] {
  if (!deps) return [];
  return Array.from(
    new Set(
      getClaudeRuntimeTargets().flatMap((target) =>
        getWorkspaceRuntimeJids(deps, target.folder, target.primaryJid),
      ),
    ),
  );
}

async function mutateClaudeConfigForAllGroups<T>(
  actor: string,
  metadata: Record<string, unknown> | undefined,
  commit: () => T,
  options?: ApplyOptions,
): Promise<ClaudeMutationResult<T>> {
  if (!deps) throw new Error('Server not initialized');

  const targets = getClaudeRuntimeTargets();
  const reason = String(metadata?.trigger ?? 'claude_config_apply');
  const knownRuntimeJids = getKnownClaudeRuntimeJids();
  try {
    const result = await quiesceWorkspaceRunnersAroundCommit(
      deps,
      targets,
      {
        reason,
        onPostCommitFailure: (runtimeJids) => {
          // Establish the in-memory fail-closed gate before any durable marker
          // I/O. Focused test fixtures may omit the optional method, while the
          // production WebDeps queue is a concrete GroupQueue that implements
          // it and startup restoration below requires it when pending exists.
          deps.queue.blockGroupsForRuntimeSafety?.(
            runtimeJids,
            `${reason}: post-commit provider runtime cleanup failed`,
            PROVIDER_RUNTIME_SAFETY_SOURCE,
          );
          if (
            options?.clearSessionsForProviderId &&
            options.sessionInvalidation
          ) {
            try {
              setPendingProviderSessionInvalidation({
                providerId: options.clearSessionsForProviderId,
                ...options.sessionInvalidation,
              });
            } catch (error) {
              // The volatile marker was set before SQLite persistence, so an
              // exact retry in this process can still repair and unblock.
              logger.error(
                { error, providerId: options.clearSessionsForProviderId },
                'Failed to persist pending provider session invalidation',
              );
            }
          }
        },
      },
      async () => {
        let value: T;
        let clearedSessionsCount: number | undefined;
        try {
          if (options?.clearSessionsForProviderId) {
            const committed = commitProviderConfigWithSessionInvalidation(
              options.clearSessionsForProviderId,
              options.sessionInvalidation,
              commit,
            );
            value = committed.value;
            clearedSessionsCount = committed.clearedSessionsCount;
          } else {
            value = commit();
          }
        } catch (error) {
          if (error instanceof ClaudeConfigPersistedError) {
            deps.queue.blockGroupsForRuntimeSafety?.(
              knownRuntimeJids,
              `${reason}: provider config persisted but follow-up failed`,
              PROVIDER_RUNTIME_SAFETY_SOURCE,
            );
          }
          throw error;
        }
        return { value, clearedSessionsCount };
      },
    );
    // A successful retry proves every runtime now observes the persisted
    // provider config, so it may repair a fail-closed gate left by an earlier
    // post-commit teardown failure.
    if (options?.clearSessionsForProviderId) {
      clearPendingProviderSessionInvalidation(
        options.clearSessionsForProviderId,
      );
    }
    if (!hasPendingProviderSessionInvalidations()) {
      deps.queue.unblockGroupsForRuntimeSafety?.(
        result.runtimeJids,
        PROVIDER_RUNTIME_SAFETY_SOURCE,
      );
    }
    const applied: ClaudeApplyResultPayload = {
      success: true,
      stoppedCount: result.runtimeJids.length,
      failedCount: 0,
      persisted: true,
      ...(result.value.clearedSessionsCount !== undefined
        ? { clearedSessionsCount: result.value.clearedSessionsCount }
        : {}),
    };
    appendClaudeConfigAuditBestEffort(
      actor,
      'apply_to_all_flows',
      ['queue.stopGroup'],
      {
        ...applied,
        ...(metadata || {}),
      },
    );
    return { value: result.value.value, applied };
  } catch (err) {
    if (err instanceof ClaudeConfigPersistedError) {
      const applied: ClaudeApplyResultPayload = {
        success: false,
        stoppedCount: 0,
        failedCount: 1,
        persisted: true,
        phase: 'post_commit',
        error:
          'Configuration was saved, but provider runtime cleanup did not complete safely',
      };
      appendClaudeConfigAuditBestEffort(
        actor,
        'apply_to_all_flows',
        ['queue.stopGroup'],
        { ...applied, ...(metadata || {}) },
      );
      return { value: err.persistedValue as T, applied };
    }
    if (!(err instanceof WorkspaceRuntimeQuiesceError)) throw err;
    const committed = err.committedValue as
      | { value: T; clearedSessionsCount?: number }
      | undefined;
    const persisted = err.persisted;
    const applied: ClaudeApplyResultPayload = {
      success: false,
      stoppedCount: 0,
      failedCount: err.failures.length,
      persisted,
      phase: err.phase,
      ...(committed?.clearedSessionsCount !== undefined
        ? { clearedSessionsCount: committed.clearedSessionsCount }
        : {}),
      error: persisted
        ? 'Configuration was saved, but one or more runtimes failed to restart safely'
        : 'Configuration was not updated because one or more runtimes failed to stop safely',
    };
    appendClaudeConfigAuditBestEffort(
      actor,
      'apply_to_all_flows',
      ['queue.stopGroup'],
      { ...applied, ...(metadata || {}) },
    );
    return { value: committed?.value, applied };
  }
}

async function applyClaudeConfigToAllGroups(
  actor: string,
  metadata?: Record<string, unknown>,
  options?: ApplyOptions,
): Promise<ClaudeApplyResultPayload> {
  const result = await mutateClaudeConfigForAllGroups(
    actor,
    metadata,
    () => undefined,
    options,
  );
  return result.applied;
}

// --- OAuth 常量 ---

const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const OAUTH_REDIRECT_URI = 'https://console.anthropic.com/oauth/code/callback';
const OAUTH_SCOPES = 'org:create_api_key user:profile user:inference';
const OAUTH_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const OAUTH_TOKEN_URL = 'https://api.anthropic.com/v1/oauth/token';
const OAUTH_FLOW_TTL = 10 * 60 * 1000; // 10 minutes

interface OAuthFlow {
  codeVerifier: string;
  expiresAt: number;
  targetProviderId?: string; // 空 = 创建新供应商
}
const oauthFlows = new Map<string, OAuthFlow>();

// Periodic cleanup of expired flows
setInterval(() => {
  const now = Date.now();
  for (const [key, flow] of oauthFlows) {
    if (flow.expiresAt < now) oauthFlows.delete(key);
  }
}, 60_000);

// --- OAuth Usage Cache ---

const OAUTH_USAGE_API = 'https://api.anthropic.com/api/oauth/usage';
const USAGE_CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes
const usageCache = new Map<string, CachedOAuthUsage>();
const inFlightUsageRequests = new Map<string, Promise<CachedOAuthUsage>>();

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of usageCache) {
    if (now - entry.fetchedAt >= USAGE_CACHE_TTL_MS) {
      usageCache.delete(key);
    }
  }
}, 5 * 60_000);

async function fetchOAuthUsage(providerId: string): Promise<CachedOAuthUsage> {
  const cached = usageCache.get(providerId);
  if (cached && Date.now() - cached.fetchedAt < USAGE_CACHE_TTL_MS) {
    return cached;
  }

  // Deduplicate concurrent requests for the same provider
  const inFlight = inFlightUsageRequests.get(providerId);
  if (inFlight) return inFlight;

  const providers = getProviders();
  const provider = providers.find((p) => p.id === providerId);
  if (!provider) {
    throw new Error('Provider not found');
  }
  if (!provider.claudeOAuthCredentials) {
    throw new Error('Provider has no OAuth credentials');
  }

  const requestPromise = (async () => {
    try {
      const resp = await fetch(OAUTH_USAGE_API, {
        headers: {
          Authorization: `Bearer ${provider.claudeOAuthCredentials!.accessToken}`,
          'anthropic-beta': 'oauth-2025-04-20',
        },
      });

      if (!resp.ok) {
        // Return stale cache if available, otherwise throw
        if (cached) {
          const stale: CachedOAuthUsage = {
            ...cached,
            error: `HTTP ${resp.status}`,
          };
          usageCache.set(providerId, stale);
          return stale;
        }
        throw new Error(`Usage API returned ${resp.status}`);
      }

      const raw = (await resp.json()) as Record<string, unknown>;
      const data: OAuthUsageResponse = {
        five_hour: parseOAuthUsageBucket(raw.five_hour),
        seven_day: parseOAuthUsageBucket(raw.seven_day),
        seven_day_opus: parseOAuthUsageBucket(raw.seven_day_opus),
        seven_day_sonnet: parseOAuthUsageBucket(raw.seven_day_sonnet),
      };

      const result: CachedOAuthUsage = { data, fetchedAt: Date.now() };
      usageCache.set(providerId, result);
      return result;
    } finally {
      inFlightUsageRequests.delete(providerId);
    }
  })();

  inFlightUsageRequests.set(providerId, requestPromise);
  return requestPromise;
}

// --- Routes ---

// ─── GET /claude — 兼容：返回第一个启用供应商的公开配置 ─────
configRoutes.get('/claude', authMiddleware, systemConfigMiddleware, (c) => {
  try {
    return c.json(toPublicClaudeProviderConfig(getClaudeProviderConfig()));
  } catch (err) {
    logger.error({ err }, 'Failed to load Claude config');
    return c.json({ error: 'Failed to load Claude config' }, 500);
  }
});

// ─── GET /claude/providers — 列出所有供应商 + 健康 + 负载均衡配置 ─────
configRoutes.get(
  '/claude/providers',
  authMiddleware,
  systemConfigMiddleware,
  (c) => {
    try {
      const providers = getProviders();
      const balancing = getBalancingConfig();
      const enabledProviders = getEnabledProviders();

      // Refresh pool state for health info
      providerPool.refreshFromConfig(enabledProviders, balancing);
      const healthStatuses = providerPool.getHealthStatuses();

      return c.json({
        providers: providers.map((p) => ({
          ...toPublicProvider(p),
          health: healthStatuses.find((h) => h.profileId === p.id) || null,
        })),
        balancing,
        enabledCount: enabledProviders.length,
        defaultProviderId: getDefaultProviderId(),
      });
    } catch (err) {
      logger.error({ err }, 'Failed to list providers');
      return c.json({ error: 'Failed to list providers' }, 500);
    }
  },
);

// ─── PUT /claude/default — 设置所有继承型 Agent 使用的默认模型配置 ─────
configRoutes.put(
  '/claude/default',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const providerId =
      typeof body.providerId === 'string' ? body.providerId.trim() : '';
    if (!providerId) {
      return c.json({ error: 'providerId (string) is required' }, 400);
    }
    const actor = (c.get('user') as AuthUser).username;

    try {
      return await withClaudeConfigMutationLock(async () => {
        const previousProviderId = getDefaultProviderId();
        if (previousProviderId === providerId) {
          const provider = getProviders().find(
            (item) => item.id === providerId,
          );
          if (!provider) throw new Error('未找到指定模型配置');
          return c.json({
            provider: toPublicProvider(provider),
            defaultProviderId: provider.id,
            applied: {
              success: true,
              stoppedCount: 0,
              failedCount: 0,
              persisted: true,
            },
          });
        }
        const mutation = await mutateClaudeConfigForAllGroups(
          actor,
          {
            trigger: 'default_model_update',
            previousProviderId,
            providerId,
          },
          () => {
            const provider = setDefaultProvider(providerId);
            appendClaudeConfigAuditBestEffort(actor, 'set_default_model', [
              `id:${provider.id}`,
            ]);
            return provider;
          },
        );
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
        return c.json({
          provider: toPublicProvider(mutation.value!),
          defaultProviderId: mutation.value!.id,
          applied: mutation.applied,
        });
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to set default model';
      logger.warn({ err, providerId }, 'Failed to set default model');
      return c.json({ error: message }, 400);
    }
  },
);

// ─── POST /claude/providers — 创建供应商 ─────
configRoutes.post(
  '/claude/providers',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const validation = UnifiedProviderCreateSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }

    const actor = (c.get('user') as AuthUser).username;

    try {
      const provider = createProvider(validation.data);
      appendClaudeConfigAudit(actor, 'create_provider', [
        `id:${provider.id}`,
        `type:${provider.type}`,
        `name:${provider.name}`,
      ]);
      return c.json(toPublicProvider(provider), 201);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to create provider';
      logger.warn({ err }, 'Failed to create provider');
      return c.json({ error: message }, 400);
    }
  },
);

// ─── PATCH /claude/providers/:id — 更新供应商非密钥字段 ─────
configRoutes.patch(
  '/claude/providers/:id',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const { id } = c.req.param();
    const body = await c.req.json().catch(() => ({}));
    const validation = UnifiedProviderPatchSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }

    const actor = (c.get('user') as AuthUser).username;

    try {
      return await withClaudeConfigMutationLock(async () => {
        const previous = getProviders().find((p) => p.id === id);
        if (!previous) throw new Error('未找到指定供应商');
        const changedFields = Object.keys(validation.data).map(
          (k) => `${k}:updated`,
        );
        const baseUrlChanged = !!(
          validation.data.anthropicBaseUrl !== undefined &&
          validation.data.anthropicBaseUrl !== previous.anthropicBaseUrl
        );
        const modelChanged = !!(
          validation.data.anthropicModel !== undefined &&
          validation.data.anthropicModel !== previous.anthropicModel
        );
        const customEnvChanged = !!(
          validation.data.customEnv !== undefined &&
          JSON.stringify(validation.data.customEnv) !==
            JSON.stringify(previous.customEnv)
        );
        const protocolFieldChanged =
          baseUrlChanged || modelChanged || customEnvChanged;
        const pendingInvalidation = getPendingProviderSessionInvalidation(id);
        const sessionInvalidation = {
          modelChanged:
            modelChanged || pendingInvalidation?.modelChanged === true,
          baseUrlChanged:
            baseUrlChanged || pendingInvalidation?.baseUrlChanged === true,
        };
        const shouldClearSessions =
          !!pendingInvalidation || protocolFieldChanged;
        const metadata = {
          trigger: 'provider_update',
          providerId: id,
          protocolFieldChanged,
          baseUrlChanged,
          modelChanged,
          customEnvChanged,
        };
        const commit = () => {
          const updated = updateProvider(id, validation.data);
          appendClaudeConfigAuditBestEffort(actor, 'update_provider', [
            `id:${id}`,
            ...changedFields,
            ...(protocolFieldChanged ? ['protocolFieldChanged'] : []),
          ]);
          return updated;
        };

        let mutation: ClaudeMutationResult<ReturnType<typeof updateProvider>>;
        if (previous.enabled) {
          mutation = await mutateClaudeConfigForAllGroups(
            actor,
            metadata,
            commit,
            shouldClearSessions
              ? {
                  clearSessionsForProviderId: id,
                  sessionInvalidation,
                }
              : undefined,
          );
        } else {
          const committed = shouldClearSessions
            ? commitProviderConfigWithSessionInvalidation(
                id,
                sessionInvalidation,
                commit,
              )
            : { value: commit(), clearedSessionsCount: undefined };
          const updated = committed.value;
          const clearedSessionsCount = committed.clearedSessionsCount;
          if (shouldClearSessions) {
            clearPendingProviderSessionInvalidation(id);
            if (!hasPendingProviderSessionInvalidations()) {
              deps?.queue?.unblockGroupsForRuntimeSafety?.(
                getKnownClaudeRuntimeJids(),
                PROVIDER_RUNTIME_SAFETY_SOURCE,
              );
            }
          }
          mutation = {
            value: updated,
            applied: {
              success: true,
              stoppedCount: 0,
              failedCount: 0,
              persisted: true,
              ...(clearedSessionsCount !== undefined
                ? { clearedSessionsCount }
                : {}),
            },
          };
        }

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
        return c.json({
          provider: toPublicProvider(mutation.value!),
          applied: mutation.applied,
        });
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to update provider';
      logger.warn({ err }, 'Failed to update provider');
      return c.json({ error: message }, 400);
    }
  },
);

// ─── PUT /claude/providers/:id/secrets — 更新密钥 ─────
configRoutes.put(
  '/claude/providers/:id/secrets',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const { id } = c.req.param();
    const body = await c.req.json().catch(() => ({}));
    const validation = UnifiedProviderSecretsSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }

    const actor = (c.get('user') as AuthUser).username;

    try {
      return await withClaudeConfigMutationLock(async () => {
        const previous = getProviders().find((provider) => provider.id === id);
        if (!previous) throw new Error('未找到指定供应商');
        const changedFields: string[] = [];
        if (validation.data.anthropicAuthToken !== undefined)
          changedFields.push('anthropicAuthToken:set');
        if (validation.data.clearAnthropicAuthToken)
          changedFields.push('anthropicAuthToken:clear');
        if (validation.data.anthropicApiKey !== undefined)
          changedFields.push('anthropicApiKey:set');
        if (validation.data.clearAnthropicApiKey)
          changedFields.push('anthropicApiKey:clear');
        if (validation.data.claudeCodeOauthToken !== undefined)
          changedFields.push('claudeCodeOauthToken:set');
        if (validation.data.clearClaudeCodeOauthToken)
          changedFields.push('claudeCodeOauthToken:clear');
        if (validation.data.claudeOAuthCredentials)
          changedFields.push('claudeOAuthCredentials:set');
        if (validation.data.clearClaudeOAuthCredentials)
          changedFields.push('claudeOAuthCredentials:clear');

        const commit = () => {
          const updated = updateProviderSecrets(id, validation.data);
          appendClaudeConfigAuditBestEffort(actor, 'update_provider_secrets', [
            `id:${id}`,
            ...changedFields,
          ]);
          return runAfterProviderPersistence(updated, () => {
            if (validation.data.claudeOAuthCredentials && updated.enabled) {
              updateAllSessionCredentials(providerToConfig(updated));
              deps?.queue?.closeAllActiveForCredentialRefresh();
            }
          });
        };

        const mutation = previous.enabled
          ? await mutateClaudeConfigForAllGroups(
              actor,
              {
                trigger: 'provider_secrets_update',
                providerId: id,
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
              } satisfies ClaudeApplyResultPayload,
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
        return c.json({
          provider: toPublicProvider(mutation.value!),
          applied: mutation.applied,
        });
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to update secrets';
      logger.warn({ err }, 'Failed to update provider secrets');
      return c.json({ error: message }, 400);
    }
  },
);

// ─── DELETE /claude/providers/:id — 删除供应商 ─────
configRoutes.delete(
  '/claude/providers/:id',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const { id } = c.req.param();
    const actor = (c.get('user') as AuthUser).username;

    try {
      return await withClaudeConfigMutationLock(async () => {
        const previous = getProviders().find((provider) => provider.id === id);
        const pendingInvalidation = getPendingProviderSessionInvalidation(id);
        if (!previous && !pendingInvalidation) {
          throw new Error('未找到指定供应商');
        }
        const referencedAgentCount = countAgentProfilesByModelConfigId(id);
        if (referencedAgentCount > 0) {
          throw new Error(
            `该模型配置仍被 ${referencedAgentCount} 个智能体使用，请先重新分配`,
          );
        }
        const sessionInvalidation = pendingInvalidation ?? {
          modelChanged: true,
          baseUrlChanged: true,
        };
        const mutation = await mutateClaudeConfigForAllGroups(
          actor,
          { trigger: 'provider_delete', providerId: id },
          () => {
            if (previous) {
              deleteProvider(id);
              appendClaudeConfigAuditBestEffort(actor, 'delete_provider', [
                `id:${id}`,
              ]);
            }
            return { id };
          },
          {
            clearSessionsForProviderId: id,
            sessionInvalidation,
          },
        );
        if (!mutation.applied.success) {
          return c.json(
            {
              error: mutation.applied.error,
              applied: mutation.applied,
            },
            503,
          );
        }
        return c.json({ ok: true, applied: mutation.applied });
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to delete provider';
      logger.warn({ err }, 'Failed to delete provider');
      return c.json({ error: message }, 400);
    }
  },
);

// ─── POST /claude/providers/:id/toggle — 切换 enabled ─────
configRoutes.post(
  '/claude/providers/:id/toggle',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const { id } = c.req.param();
    const actor = (c.get('user') as AuthUser).username;
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.enabled !== 'boolean') {
      return c.json({ error: 'enabled must be a boolean' }, 400);
    }

    try {
      return await withClaudeConfigMutationLock(async () => {
        const mutation = await mutateClaudeConfigForAllGroups(
          actor,
          { trigger: 'provider_toggle', providerId: id },
          () => {
            const updated = setProviderEnabled(id, body.enabled);
            appendClaudeConfigAuditBestEffort(actor, 'toggle_provider', [
              `id:${id}`,
              `enabled:${updated.enabled}`,
            ]);
            return updated;
          },
        );
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
        return c.json({
          provider: toPublicProvider(mutation.value!),
          applied: mutation.applied,
        });
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to toggle provider';
      logger.warn({ err }, 'Failed to toggle provider');
      return c.json({ error: message }, 400);
    }
  },
);

// ─── POST /claude/providers/:id/reset-health — 重置健康状态 ─────
configRoutes.post(
  '/claude/providers/:id/reset-health',
  authMiddleware,
  systemConfigMiddleware,
  (c) => {
    const { id } = c.req.param();
    providerPool.resetHealth(id);
    return c.json({ ok: true });
  },
);

// ─── GET /claude/providers/health — 健康状态轮询 ─────
configRoutes.get(
  '/claude/providers/health',
  authMiddleware,
  systemConfigMiddleware,
  (c) => {
    // Refresh pool state
    const enabledProviders = getEnabledProviders();
    const balancing = getBalancingConfig();
    providerPool.refreshFromConfig(enabledProviders, balancing);
    return c.json({ statuses: providerPool.getHealthStatuses() });
  },
);

// ─── GET /claude/providers/:id/usage — OAuth 用量数据 ─────
configRoutes.get(
  '/claude/providers/:id/usage',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const { id } = c.req.param();
    try {
      const usage = await fetchOAuthUsage(id);
      return c.json(usage);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      logger.warn({ err, providerId: id }, 'Failed to fetch OAuth usage');
      return c.json({ error: msg }, 400);
    }
  },
);

// ─── PUT /claude/balancing — 更新负载均衡参数 ─────
configRoutes.put(
  '/claude/balancing',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const validation = BalancingConfigSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }

    const actor = (c.get('user') as AuthUser).username;

    try {
      const saved = saveBalancingConfig(validation.data);
      appendClaudeConfigAudit(actor, 'update_balancing', [
        ...Object.keys(validation.data),
      ]);
      return c.json(saved);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to update balancing';
      return c.json({ error: message }, 400);
    }
  },
);

// ─── POST /claude/apply — 应用配置到所有容器 ─────
configRoutes.post(
  '/claude/apply',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const actor = (c.get('user') as AuthUser).username;
    try {
      return await withClaudeConfigMutationLock(async () => {
        const result = await applyClaudeConfigToAllGroups(actor, {
          trigger: 'manual_provider_apply',
        });
        if (!result.success) {
          return c.json(result, 503);
        }
        return c.json(result);
      });
    } catch (err) {
      logger.error({ err }, 'Failed to apply Claude config to all groups');
      return c.json({ error: 'Server not initialized' }, 500);
    }
  },
);

// ─── POST /claude/oauth/start — 启动 OAuth PKCE 流程 ─────
configRoutes.post(
  '/claude/oauth/start',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const targetProviderId =
      typeof (body as Record<string, unknown>).targetProviderId === 'string'
        ? ((body as Record<string, unknown>).targetProviderId as string)
        : undefined;

    const state = randomBytes(32).toString('hex');
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');

    oauthFlows.set(state, {
      codeVerifier,
      expiresAt: Date.now() + OAUTH_FLOW_TTL,
      targetProviderId,
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

    return c.json({
      authorizeUrl: `${OAUTH_AUTHORIZE_URL}?${params.toString()}`,
      state,
    });
  },
);

// ─── POST /claude/oauth/callback — OAuth 回调 ─────
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
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
          Accept: 'application/json, text/plain, */*',
          Referer: 'https://claude.ai/',
          Origin: 'https://claude.ai',
        },
        body: JSON.stringify({
          grant_type: 'authorization_code',
          client_id: OAUTH_CLIENT_ID,
          code: cleanedCode,
          redirect_uri: OAUTH_REDIRECT_URI,
          code_verifier: flow.codeVerifier,
          state,
          expires_in: 31536000, // 1 year
        }),
      });

      if (!tokenResp.ok) {
        const errText = await tokenResp.text().catch(() => '');
        logger.warn(
          { status: tokenResp.status, body: errText },
          'OAuth token exchange failed',
        );
        return c.json(
          { error: `Token exchange failed: ${tokenResp.status}` },
          400,
        );
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

      let oauthCredentials: ClaudeOAuthCredentials | null = null;
      if (tokenData.refresh_token) {
        const expiresAt = tokenData.expires_in
          ? Date.now() + tokenData.expires_in * 1000
          : Date.now() + 8 * 60 * 60 * 1000;
        oauthCredentials = {
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token,
          expiresAt,
          scopes: tokenData.scope ? tokenData.scope.split(' ') : [],
        };
      }

      let provider;
      if (flow.targetProviderId) {
        // Update existing provider's OAuth credentials
        provider = updateProviderSecrets(flow.targetProviderId, {
          claudeOAuthCredentials: oauthCredentials ?? undefined,
          claudeCodeOauthToken: oauthCredentials
            ? undefined
            : tokenData.access_token,
          clearAnthropicApiKey: true,
        });
      } else {
        // Create new official provider
        provider = createProvider({
          name: '官方 Claude (OAuth)',
          type: 'official',
          claudeOAuthCredentials: oauthCredentials,
          claudeCodeOauthToken: oauthCredentials ? '' : tokenData.access_token,
          enabled: true,
        });
      }

      // Write .credentials.json to all sessions
      if (oauthCredentials) {
        updateAllSessionCredentials(providerToConfig(provider));
        deps?.queue?.closeAllActiveForCredentialRefresh();
      }

      appendClaudeConfigAudit(actor, 'oauth_login', [
        `providerId:${provider.id}`,
        oauthCredentials
          ? 'claudeOAuthCredentials:set'
          : 'claudeCodeOauthToken:set',
      ]);

      return c.json(toPublicProvider(provider));
    } catch (err) {
      logger.error({ err }, 'OAuth token exchange error');
      const message =
        err instanceof Error ? err.message : 'OAuth token exchange failed';
      return c.json({ error: message }, 500);
    }
  },
);

// ─── PUT /claude/custom-env — 更新当前启用供应商的自定义环境变量 ─────
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
      // Find first enabled provider and update its customEnv
      const enabled = getEnabledProviders();
      if (enabled.length === 0) {
        return c.json({ error: '没有启用的供应商' }, 400);
      }

      const updated = updateProvider(enabled[0].id, {
        customEnv: validation.data.customEnv,
      });
      return c.json({ customEnv: updated.customEnv });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Invalid custom env payload';
      logger.warn({ err }, 'Invalid Claude custom env payload');
      return c.json({ error: message }, 400);
    }
  },
);

// ─── Helpers ────────────────────────────────────────────────────

const _deprecationLogged = new Set<string>();
function logDeprecationOnce(endpoint: string, replacement: string): void {
  if (_deprecationLogged.has(endpoint)) return;
  logger.warn(`Deprecated: ${endpoint} — use ${replacement} instead`);
  _deprecationLogged.add(endpoint);
}

function resolveProxyInfo(
  userProxy: string,
  sysProxy: string,
): { effectiveProxyUrl: string; proxySource: 'user' | 'system' | 'none' } {
  return {
    effectiveProxyUrl: userProxy || sysProxy,
    proxySource: userProxy ? 'user' : sysProxy ? 'system' : 'none',
  };
}

/** Persist a RegisteredGroup update and sync to the in-memory cache. */
function applyBindingUpdate(imJid: string, updated: RegisteredGroup): void {
  commitChannelMountUpdate(imJid, updated);
}

function applyRegisteredGroupUpdate(
  jid: string,
  updated: RegisteredGroup,
): void {
  setRegisteredGroup(jid, updated);
  const webDeps = getWebDeps();
  if (webDeps) {
    const groups = webDeps.getRegisteredGroups();
    if (groups[jid]) groups[jid] = updated;
  }
}

function hasConsistentChannelAccount(
  userId: string,
  imJid: string,
  group: RegisteredGroup,
): boolean {
  const encodedAccountId = parseChannelAddress(imJid)?.channelAccountId ?? null;
  const storedAccountId = group.channel_account_id ?? null;
  if (encodedAccountId !== storedAccountId) {
    if (!encodedAccountId && storedAccountId) {
      const account = getChannelAccount(storedAccountId);
      return (
        account?.is_legacy_default === true && account.owner_user_id === userId
      );
    }
    return false;
  }
  if (!storedAccountId) return true;
  return getChannelAccount(storedAccountId)?.owner_user_id === userId;
}

function refreshAgentLastImJid(agentId: string): void {
  const agent = getAgent(agentId);
  if (!agent) return;
  const remaining = getGroupsByTargetAgent(agentId);
  const current = agent.last_im_jid
    ? channelConversationJid(agent.last_im_jid)
    : null;
  if (current && remaining.some(({ jid }) => jid === current)) return;
  remaining.sort((a, b) => {
    const dateDiff =
      Date.parse(b.group.added_at) - Date.parse(a.group.added_at);
    if (Number.isFinite(dateDiff) && dateDiff !== 0) return dateDiff;
    return a.jid.localeCompare(b.jid);
  });
  updateAgentLastImJid(agentId, remaining[0]?.jid ?? null);
}

type ChannelChatInfo = NativeContextMetadata & {
  avatar?: string;
  name?: string;
  user_count?: string;
};

function getConversationKind(
  imJid: string,
  group: Pick<RegisteredGroup, 'feishu_chat_mode'>,
  chatInfo?: ChannelChatInfo | null,
): ChannelConversationKind {
  return resolveChannelConversationKind(imJid, {
    feishu_chat_mode: group.feishu_chat_mode,
    chat_mode: chatInfo?.chat_mode,
  });
}

// Only fetches live chat metadata — does NOT compute threadCapable. That
// decision must be (re-)computed by the caller against a freshly re-read
// imGroup taken AFTER this await, never against the pre-await snapshot —
// see the identical helper's doc comment in routes/agents.ts for why.
async function fetchLiveChatInfo(
  userId: string,
  imJid: string,
): Promise<{ chatInfo?: ChannelChatInfo | null }> {
  const channelType = getChannelType(imJid);
  if (!channelType) return {};
  const webDeps = getWebDeps();
  const chatInfo = webDeps?.getChannelChatInfo
    ? ((await webDeps.getChannelChatInfo(imJid)) as ChannelChatInfo | null)
    : channelType === 'feishu' && webDeps?.getFeishuChatInfo
      ? await webDeps.getFeishuChatInfo(userId, extractChatId(imJid))
      : null;
  return { chatInfo };
}

function resolveWorkspaceForBinding(
  targetMainJid: string,
): { jid: string; group: RegisteredGroup } | null {
  const direct = getRegisteredGroup(targetMainJid);
  if (direct) return { jid: targetMainJid, group: direct };
  if (!targetMainJid.startsWith('web:')) return null;

  const folder = targetMainJid.slice(4);
  for (const [jid, group] of Object.entries(getAllRegisteredGroups())) {
    if (jid.startsWith('web:') && group.folder === folder) {
      return { jid, group };
    }
  }
  return null;
}

function detachThreadMapWorkspaceIfLast(
  targetMainJid: string | undefined,
  excludingImJid: string,
  nextWorkspaceJid?: string,
  nextRoutingMode?: 'single_session' | 'thread_map',
): void {
  if (!targetMainJid) return;
  const workspace = resolveWorkspaceForBinding(targetMainJid);
  if (!workspace) return;
  const nextWorkspace =
    nextRoutingMode === 'thread_map' && nextWorkspaceJid
      ? resolveWorkspaceForBinding(nextWorkspaceJid)
      : null;
  if (nextWorkspace?.jid === workspace.jid) return;
  if (hasRemainingThreadMapMount(workspace.jid, excludingImJid)) return;

  applyRegisteredGroupUpdate(
    workspace.jid,
    buildDetachedWorkspaceUpdate(workspace.group),
  );
}

function markNativeContextWorkspace(targetMainJid: string): void {
  const workspace = resolveWorkspaceForBinding(targetMainJid);
  if (!workspace) return;
  applyRegisteredGroupUpdate(workspace.jid, {
    ...workspace.group,
    conversation_source: 'native_thread',
    conversation_nav_mode: 'vertical_threads',
  });
}

function restoreDefaultChannelError(restored: { reason: string }): string {
  if (restored.reason === 'account_mismatch') {
    return 'Channel account does not match this chat or owner';
  }
  return 'Channel account has no default or owner home workspace';
}

configRoutes.get('/feishu', authMiddleware, systemConfigMiddleware, (c) => {
  logDeprecationOnce(
    'GET /api/config/feishu',
    'GET /api/config/user-im/feishu',
  );
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

      return c.json({
        ...toPublicFeishuProviderConfig(saved, 'runtime'),
        connected,
      });
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
  logDeprecationOnce(
    'GET /api/config/telegram',
    'GET /api/config/user-im/telegram',
  );
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
    if (typeof validation.data.proxyUrl === 'string') {
      next.proxyUrl = validation.data.proxyUrl;
    } else if (validation.data.clearProxyUrl === true) {
      next.proxyUrl = '';
    }
    if (typeof validation.data.enabled === 'boolean') {
      next.enabled = validation.data.enabled;
    }

    try {
      const saved = saveTelegramProviderConfig({
        botToken: next.botToken,
        proxyUrl: next.proxyUrl,
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

      return c.json({
        ...toPublicTelegramProviderConfig(saved, 'runtime'),
        connected,
      });
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

    const agent = createTelegramApiAgent(config.proxyUrl);
    try {
      const { Bot } = await import('grammy');
      const testBot = new Bot(config.botToken, {
        client: {
          timeoutSeconds: 15,
          baseFetchConfig: {
            agent,
          },
        },
      });

      let me: { username?: string; id: number; first_name: string } | null =
        null;
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
        throw lastErr instanceof Error
          ? lastErr
          : new Error('Telegram API request failed');
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
    } finally {
      destroyTelegramApiAgent(agent);
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

const SYSTEM_AGENT_AVATARS_DIR = path.join(DATA_DIR, 'avatars');
const SYSTEM_AGENT_AVATAR_PREFIX = 'system-agent-';
const SYSTEM_AGENT_AVATAR_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

function removeStaleSystemAgentAvatars(keep?: string): void {
  if (!fs.existsSync(SYSTEM_AGENT_AVATARS_DIR)) return;
  for (const filename of fs.readdirSync(SYSTEM_AGENT_AVATARS_DIR)) {
    if (!filename.startsWith(SYSTEM_AGENT_AVATAR_PREFIX) || filename === keep)
      continue;
    fs.rmSync(path.join(SYSTEM_AGENT_AVATARS_DIR, filename), { force: true });
  }
}

configRoutes.get('/appearance', authMiddleware, systemConfigMiddleware, (c) => {
  try {
    return c.json(getAppearanceConfig());
  } catch (err) {
    logger.error({ err }, 'Failed to load appearance config');
    return c.json({ error: 'Failed to load appearance config' }, 500);
  }
});

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

configRoutes.post(
  '/appearance/avatar',
  authMiddleware,
  adminRoleMiddleware,
  avatarUploadBodyLimit,
  async (c) => {
    if (!(c.req.header('content-type') || '').includes('multipart/form-data')) {
      return c.json({ error: 'Expected multipart/form-data' }, 400);
    }
    const formData = await c.req.formData();
    const file = formData.get('avatar');
    if (!file || !(file instanceof File)) {
      return c.json({ error: 'No avatar file provided' }, 400);
    }
    if (file.size > AVATAR_MAX_FILE_BYTES) {
      return c.json({ error: 'File too large (max 3MB)' }, 413);
    }
    const extension = SYSTEM_AGENT_AVATAR_EXTENSIONS[file.type];
    if (!extension) {
      return c.json(
        { error: 'Unsupported image type. Use jpg, png, gif or webp' },
        400,
      );
    }

    fs.mkdirSync(SYSTEM_AGENT_AVATARS_DIR, { recursive: true });
    const filename = `${SYSTEM_AGENT_AVATAR_PREFIX}${randomBytes(4).toString('hex')}${extension}`;
    const destination = path.join(SYSTEM_AGENT_AVATARS_DIR, filename);
    const temporary = `${destination}.tmp`;
    fs.writeFileSync(temporary, Buffer.from(await file.arrayBuffer()));
    fs.renameSync(temporary, destination);
    const aiAvatarUrl = `/api/auth/avatars/${filename}`;
    const appearance = saveAppearanceConfig({ aiAvatarUrl });
    removeStaleSystemAgentAvatars(filename);
    return c.json({ appearance, avatarUrl: aiAvatarUrl });
  },
);

configRoutes.delete(
  '/appearance/avatar',
  authMiddleware,
  adminRoleMiddleware,
  (c) => {
    const appearance = saveAppearanceConfig({
      aiAvatarUrl: null,
      aiAvatarMode: 'emoji',
    });
    removeStaleSystemAgentAvatars();
    return c.json({ appearance });
  },
);

configRoutes.route('/', brandAssetRoutes);

// Public endpoint — no auth required (like /api/auth/status)
configRoutes.get('/appearance/public', (c) => {
  try {
    const config = getAppearanceConfig();
    return c.json({
      appName: config.appName,
      aiName: config.aiName,
      aiAvatarEmoji: config.aiAvatarEmoji,
      aiAvatarColor: config.aiAvatarColor,
      aiAvatarUrl: config.aiAvatarUrl,
      aiAvatarMode: config.aiAvatarMode,
      brandIconUrl: config.brandIconUrl,
      brandBannerUrl: config.brandBannerUrl,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to load public appearance config');
    return c.json({ error: 'Failed to load appearance config' }, 500);
  }
});

// ─── System settings ───────────────────────────────────────────────

function toSystemSettingsResponse(
  settings: ReturnType<typeof getSystemSettings>,
) {
  return {
    containerTimeout: settings.containerTimeout,
    idleTimeout: settings.idleTimeout,
    containerMaxOutputSize: settings.containerMaxOutputSize,
    maxConcurrentContainers: settings.maxConcurrentContainers,
    maxLoginAttempts: settings.maxLoginAttempts,
    loginLockoutMinutes: settings.loginLockoutMinutes,
    fallbackModel: settings.fallbackModel,
  };
}

function changedSettingFields(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  submitted: Record<string, unknown>,
): string[] {
  return Object.keys(submitted)
    .filter((key) => !Object.is(before[key], after[key]))
    .sort();
}

configRoutes.get('/system', authMiddleware, systemConfigMiddleware, (c) => {
  try {
    return c.json(toSystemSettingsResponse(getSystemSettings()));
  } catch (err) {
    logger.error({ err }, 'Failed to load system settings');
    return c.json({ error: 'Failed to load system settings' }, 500);
  }
});

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
      const before = toSystemSettingsResponse(getSystemSettings());
      // Deprecated compatibility inputs. Accept them so stale Web clients do
      // not fail the whole request, but never persist or apply them.
      const effectiveSettings = { ...validation.data };
      for (const key of [
        'maxConcurrentHostProcesses',
        'maxConcurrentScripts',
        'scriptTimeout',
        'taskBackfillGraceMs',
        'maxRepliesPerTurn',
        'maxTasksPerUser',
      ] as const) {
        delete effectiveSettings[key];
      }
      const saved = saveSystemSettings(effectiveSettings);
      const response = toSystemSettingsResponse(saved);
      const changedFields = changedSettingFields(
        before,
        response,
        effectiveSettings,
      );
      if (changedFields.length > 0) {
        const actor = c.get('user') as AuthUser;
        logAuthEvent({
          event_type: 'system_settings_updated',
          username: actor.username,
          actor_username: actor.username,
          ip_address: getClientIp(c),
          user_agent: c.req.header('user-agent') ?? null,
          details: { changed_fields: changedFields },
        });
      }
      return c.json(response);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Invalid system settings payload';
      logger.warn({ err }, 'Invalid system settings payload');
      return c.json({ error: message }, 400);
    }
  },
);

// ─── Host integration settings (admin role only) ───────────────────

function toHostIntegrationResponse(
  settings: ReturnType<typeof getSystemSettings>,
) {
  return {
    externalClaudeDir: settings.externalClaudeDir,
    pluginAutoScan: settings.pluginAutoScan,
    adminHostOnlyMode: settings.adminHostOnlyMode,
    mainAgentContextSource: settings.mainAgentContextSource,
    mainAgentAutoCompactWindow: settings.mainAgentAutoCompactWindow,
    mainAgentAutoCompactPercentage: settings.mainAgentAutoCompactPercentage,
  };
}

configRoutes.get(
  '/host-integration',
  authMiddleware,
  adminRoleMiddleware,
  (c) => c.json(toHostIntegrationResponse(getSystemSettings())),
);

configRoutes.put(
  '/host-integration',
  authMiddleware,
  adminRoleMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const validation = HostIntegrationSettingsSchema.safeParse(body);
    if (!validation.success) {
      return c.json(
        { error: 'Invalid request body', details: validation.error.format() },
        400,
      );
    }
    const requestedDir = validation.data.externalClaudeDir?.trim();
    if (requestedDir) {
      try {
        const resolved = fs.realpathSync(requestedDir);
        if (
          !path.isAbsolute(requestedDir) ||
          !fs.statSync(resolved).isDirectory()
        ) {
          throw new Error('not an absolute directory');
        }
      } catch {
        return c.json(
          { error: 'externalClaudeDir must be an existing absolute directory' },
          400,
        );
      }
    }

    return withCapabilityScopeLocks([SYSTEM_CAPABILITY_LOCK_KEY], async () => {
      const before = toHostIntegrationResponse(getSystemSettings());
      const mainContextSourceChanged =
        validation.data.mainAgentContextSource !== undefined &&
        validation.data.mainAgentContextSource !==
          before.mainAgentContextSource;
      const externalClaudeDirChanged =
        validation.data.externalClaudeDir !== undefined &&
        validation.data.externalClaudeDir !== before.externalClaudeDir;
      const hostContextChanged =
        mainContextSourceChanged || externalClaudeDirChanged;
      const adminHostOnlyModeChanged =
        validation.data.adminHostOnlyMode !== undefined &&
        validation.data.adminHostOnlyMode !== before.adminHostOnlyMode;
      const enablingAdminHostOnlyMode =
        adminHostOnlyModeChanged && validation.data.adminHostOnlyMode === true;
      const pendingRuntimeCleanupFolders =
        getPendingAdminHostOnlyCleanupFolders();
      const repairingRuntimeCleanup = pendingRuntimeCleanupFolders.length > 0;
      const enforcingAdminHostOnlyMode =
        enablingAdminHostOnlyMode ||
        (repairingRuntimeCleanup &&
          before.adminHostOnlyMode &&
          validation.data.adminHostOnlyMode !== false);
      const defaultCompactChanged =
        (validation.data.mainAgentAutoCompactWindow !== undefined &&
          validation.data.mainAgentAutoCompactWindow !==
            before.mainAgentAutoCompactWindow) ||
        (validation.data.mainAgentAutoCompactPercentage !== undefined &&
          validation.data.mainAgentAutoCompactPercentage !==
            before.mainAgentAutoCompactPercentage);
      const contextMutationRequested =
        hostContextChanged ||
        defaultCompactChanged ||
        enablingAdminHostOnlyMode ||
        repairingRuntimeCleanup;
      const contextWorkspaces =
        hostContextChanged || defaultCompactChanged
          ? Object.entries(getAllRegisteredGroups())
              .map(([jid, group]) => ({
                jid,
                group,
                profile: group.created_by
                  ? getAgentProfileForWorkspace(group.folder, group.created_by)
                  : undefined,
              }))
              .filter(({ group, profile }) => {
                if (!group.created_by || !profile) return false;
                const isActiveAdmin =
                  getUserById(group.created_by)?.role === 'admin';
                const currentContextSource =
                  resolveEffectiveAgentProfile(profile)?.runtime_policy.context
                    .source ?? 'managed';
                const nextContextSource = profile.is_default
                  ? (validation.data.mainAgentContextSource ??
                    before.mainAgentContextSource)
                  : profile.runtime_policy.context.source;
                return (
                  (defaultCompactChanged && profile.is_default) ||
                  (mainContextSourceChanged &&
                    profile.is_default &&
                    isActiveAdmin) ||
                  (externalClaudeDirChanged &&
                    isActiveAdmin &&
                    (currentContextSource === 'host_claude' ||
                      nextContextSource === 'host_claude'))
                );
              })
          : [];
      const allGroups =
        enablingAdminHostOnlyMode || repairingRuntimeCleanup
          ? getAllRegisteredGroups()
          : {};
      const activeAdminFolders = enablingAdminHostOnlyMode
        ? new Set(
            Object.values(allGroups)
              .filter((group) => {
                const owner = group.created_by
                  ? getUserById(group.created_by)
                  : undefined;
                return owner?.role === 'admin' && owner.status === 'active';
              })
              .map((group) => group.folder),
          )
        : new Set<string>();
      for (const folder of pendingRuntimeCleanupFolders) {
        activeAdminFolders.add(folder);
      }
      const policyWorkspaces = Array.from(activeAdminFolders)
        .map((folder) => {
          const entries = Object.entries(allGroups).filter(
            ([, group]) => group.folder === folder,
          );
          const preferred =
            entries.find(([jid]) => jid.startsWith('web:')) ?? entries[0];
          if (!preferred) return null;
          const [jid, group] = preferred;
          return {
            jid,
            group,
            profile: group.created_by
              ? getAgentProfileForWorkspace(group.folder, group.created_by)
              : undefined,
          };
        })
        .filter(
          (workspace): workspace is NonNullable<typeof workspace> =>
            workspace !== null,
        );
      const workspaceByFolder = new Map<
        string,
        (typeof contextWorkspaces)[number] | (typeof policyWorkspaces)[number]
      >();
      for (const workspace of [...contextWorkspaces, ...policyWorkspaces]) {
        workspaceByFolder.set(workspace.group.folder, workspace);
      }
      const workspaces = Array.from(workspaceByFolder.values());
      const sessionResetFolders = Array.from(
        new Set([
          ...workspaces.map(({ group }) => group.folder),
          ...pendingRuntimeCleanupFolders,
        ]),
      );
      let hostOnlyMigration:
        | ReturnType<typeof forceActiveAdminRuntimesToHost>
        | undefined;
      const commit = () => {
        if (enforcingAdminHostOnlyMode) {
          hostOnlyMigration = forceActiveAdminRuntimesToHost();
          if (deps) {
            const liveGroups = deps.getRegisteredGroups();
            for (const { jid } of hostOnlyMigration.affectedGroups) {
              const fresh = getRegisteredGroup(jid);
              if (fresh) liveGroups[jid] = fresh;
            }
          }
        }
        for (const folder of sessionResetFolders)
          deleteWorkspaceSessions(folder);
        if (deps?.sessions) {
          for (const folder of sessionResetFolders)
            delete deps.sessions[folder];
        }
        const value = saveSystemSettings(validation.data);
        if (hostOnlyMigration?.migratedTaskIds.length) {
          notifyTaskSchedulerChanged();
        }
        return value;
      };
      let saved: ReturnType<typeof saveSystemSettings>;
      if (contextMutationRequested && deps) {
        const profileIds = Array.from(
          new Set(
            workspaces
              .map(({ profile }) => profile)
              .filter((profile) => !!profile)
              .map((profile) => profile.id),
          ),
        );
        try {
          const targets = workspaces.map(({ jid, group }) => ({
            folder: group.folder,
            primaryJid: jid,
          }));
          const result = await withAgentProfileLocks(profileIds, () =>
            quiesceWorkspaceRunnersAroundCommit(
              deps,
              targets,
              {
                reason: 'Host integration context updated',
                onPostCommitFailure: (runtimeJids) => {
                  markAdminHostOnlyCleanupPending(sessionResetFolders);
                  deps.queue.blockGroupsForRuntimeSafety?.(
                    runtimeJids,
                    'Host integration runtime cleanup failed after settings commit',
                    ADMIN_HOST_ONLY_RUNTIME_SAFETY_SOURCE,
                  );
                },
              },
              commit,
            ),
          );
          saved = result.value;
          clearAdminHostOnlyCleanupPending(sessionResetFolders);
          deps.queue.unblockGroupsForRuntimeSafety?.(
            result.runtimeJids,
            ADMIN_HOST_ONLY_RUNTIME_SAFETY_SOURCE,
          );
        } catch (err) {
          if (!(err instanceof WorkspaceRuntimeQuiesceError)) throw err;
          return c.json(
            {
              error: err.persisted
                ? 'Host integration was updated, but runtime cleanup failed; retry the same request'
                : 'Failed to quiesce active workspaces; host integration was not updated',
              persisted: err.persisted,
              retryable: true,
            },
            503,
          );
        }
      } else {
        saved = commit();
      }
      const response = toHostIntegrationResponse(saved);
      const changedFields = changedSettingFields(
        before,
        response,
        validation.data,
      );
      const actor = c.get('user') as AuthUser;
      if (changedFields.length > 0) {
        logAuthEvent({
          event_type: 'host_integration_updated',
          username: actor.username,
          actor_username: actor.username,
          ip_address: getClientIp(c),
          user_agent: c.req.header('user-agent') ?? null,
          // Only names and a boolean are recorded; the host path is never logged.
          details: {
            changed_fields: changedFields,
            external_claude_dir_configured: Boolean(response.externalClaudeDir),
            ...(hostOnlyMigration
              ? {
                  host_only_migrated_groups:
                    hostOnlyMigration.affectedGroups.length,
                  host_only_migrated_tasks:
                    hostOnlyMigration.migratedTaskIds.length,
                }
              : {}),
          },
        });
      }

      return c.json(response);
    });
  },
);

// ─── External Claude resources (admin only) ─────────────────────────

configRoutes.get(
  '/external-resources',
  authMiddleware,
  adminRoleMiddleware,
  (c) => {
    const effectiveDir = getEffectiveExternalDir();

    const result: {
      dir: string;
      rules: Array<{ name: string; size: number }>;
      claudeMd: string | null;
    } = { dir: effectiveDir, rules: [], claudeMd: null };

    // Rules
    const rulesDir = path.join(effectiveDir, 'rules');
    try {
      if (fs.existsSync(rulesDir)) {
        for (const entry of fs.readdirSync(rulesDir, { withFileTypes: true })) {
          if (!entry.isFile() && !entry.isSymbolicLink()) continue;
          try {
            const st = fs.statSync(path.join(rulesDir, entry.name));
            result.rules.push({ name: entry.name, size: st.size });
          } catch {
            /* skip */
          }
        }
      }
    } catch {
      /* ignore */
    }

    // CLAUDE.md
    const claudeMdPath = path.join(effectiveDir, 'CLAUDE.md');
    try {
      if (fs.existsSync(claudeMdPath)) {
        const content = fs.readFileSync(claudeMdPath, 'utf-8');
        result.claudeMd =
          content.length > 10000
            ? content.slice(0, 10000) + '\n...(截断)'
            : content;
      }
    } catch {
      /* ignore */
    }

    return c.json(result);
  },
);

// Read a single rule file content (admin only)
configRoutes.get(
  '/external-resources/rule',
  authMiddleware,
  systemConfigMiddleware,
  (c) => {
    const user = c.get('user') as AuthUser;
    if (user.role !== 'admin') {
      return c.text('Forbidden', 403);
    }
    const name = c.req.query('name');
    if (!name || name.includes('/') || name.includes('..')) {
      return c.text('Invalid name', 400);
    }
    const effectiveDir = getEffectiveExternalDir();
    const filePath = path.join(effectiveDir, 'rules', name);
    try {
      const resolved = fs.realpathSync(filePath);
      // 确保解析后的路径仍在 rules 目录内
      if (
        !resolved.startsWith(fs.realpathSync(path.join(effectiveDir, 'rules')))
      ) {
        return c.text('Forbidden', 403);
      }
      const content = fs.readFileSync(resolved, 'utf-8');
      return c.text(content);
    } catch {
      return c.text('Not found', 404);
    }
  },
);

// ─── Per-user IM connection status ──────────────────────────────────

configRoutes.get('/user-im/status', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  return c.json({
    feishu: deps?.isUserFeishuConnected?.(user.id) ?? false,
    telegram: deps?.isUserTelegramConnected?.(user.id) ?? false,
    qq: deps?.isUserQQConnected?.(user.id) ?? false,
    wechat: deps?.isUserWeChatConnected?.(user.id) ?? false,
    dingtalk: deps?.isUserDingTalkConnected?.(user.id) ?? false,
    discord: deps?.isUserDiscordConnected?.(user.id) ?? false,
    whatsapp: deps?.isUserWhatsAppConnected?.(user.id) ?? false,
  });
});

// ─── Per-user IM config (all logged-in users) ─────────────────────

configRoutes.get('/user-im/feishu', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  try {
    const config = getUserFeishuConfig(user.id);
    const connected = deps?.isUserFeishuConnected?.(user.id) ?? false;
    if (!config) {
      return c.json({
        appId: '',
        hasAppSecret: false,
        appSecretMasked: null,
        enabled: false,
        updatedAt: null,
        connected,
        autoIsolateContext: false,
      });
    }
    return c.json({
      ...toPublicFeishuProviderConfig(config, 'runtime'),
      connected,
      autoIsolateContext: config.autoIsolateContext ?? false,
    });
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

  // Billing: check IM channel limit when enabling
  if (validation.data.enabled === true && isBillingEnabled()) {
    const currentFeishu = getUserFeishuConfig(user.id);
    if (!currentFeishu?.enabled) {
      const limit = checkImChannelLimit(
        user.id,
        user.role,
        countOtherEnabledImChannels(user.id, 'feishu'),
      );
      if (!limit.allowed) {
        return c.json({ error: limit.reason }, 403);
      }
    }
  }

  const current = getUserFeishuConfig(user.id);
  const next: Record<string, unknown> = {
    appId: current?.appId || '',
    appSecret: current?.appSecret || '',
    enabled: current?.enabled ?? true,
    updatedAt: current?.updatedAt || null,
    autoIsolateContext: current?.autoIsolateContext ?? false,
    // Preserve the auto-learned owner open_id — saveUserFeishuConfig does a full
    // rewrite, so omitting it here would wipe the owner_mentioned activation and
    // sender_allowlist seed on every settings save.
    ownerOpenId: current?.ownerOpenId,
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
  if (typeof validation.data.autoIsolateContext === 'boolean') {
    next.autoIsolateContext = validation.data.autoIsolateContext;
  }

  // Pre-save connectivity test: 启用且有完整凭据,且 (appId 或 appSecret 跟当前
  // 持久化值不一致) 时,先调一次 tenant_access_token 接口验证凭据真能换出 token。
  //
  // 凭据变更守卫(per PR #572 review):仅 autoIsolateContext / enabled 这类与
  // 凭据无关的设置变更不应触发 8s 飞书 API 测试;否则飞书抖动期间用户改个无关
  // 开关都会被 400 阻塞。current 在上方已 decrypt 持有明文 appSecret,可直接比较。
  //
  // 不可达 / timeout 不强行阻塞:既然连飞书都连不上,自动重连阶段也会失败,
  // 此时把错误暴露给用户比"成功保存但实际拿不到 token"更体面。
  const credentialsChanged =
    next.appId !== (current?.appId ?? '') ||
    next.appSecret !== (current?.appSecret ?? '');
  if (
    next.enabled === true &&
    typeof next.appId === 'string' &&
    typeof next.appSecret === 'string' &&
    next.appId &&
    next.appSecret &&
    credentialsChanged
  ) {
    const test = await testFeishuCredentials(
      next.appId as string,
      next.appSecret as string,
    );
    if (!test.ok) {
      logger.warn(
        {
          userId: user.id,
          appId: next.appId,
          errorCode: test.errorCode,
          errorMessage: test.errorMessage,
        },
        'Feishu credentials verification failed before save',
      );
      return c.json(
        {
          error: 'Feishu credentials verification failed',
          details: {
            code: test.errorCode,
            message: test.errorMessage,
            hint: 'Check appId/appSecret on the Lark/Feishu developer console',
          },
        },
        400,
      );
    }
  }

  try {
    const saved = saveUserFeishuConfig(user.id, {
      appId: next.appId as string,
      appSecret: next.appSecret as string,
      enabled: next.enabled as boolean | undefined,
      autoIsolateContext: next.autoIsolateContext as boolean | undefined,
      ownerOpenId: next.ownerOpenId as string | undefined,
    });
    appendImConfigAudit(
      user.username,
      'feishu',
      'update',
      Object.keys(validation.data),
      {
        userId: user.id,
      },
    );

    // Migrate existing Feishu chats when autoIsolateContext toggle changes
    const oldAutoIsolate = current?.autoIsolateContext ?? false;
    const newAutoIsolate = saved.autoIsolateContext ?? false;
    if (oldAutoIsolate !== newAutoIsolate && deps?.applyAutoIsolateContext) {
      const migrated = deps.applyAutoIsolateContext(user.id, newAutoIsolate);
      logger.info(
        { userId: user.id, enable: newAutoIsolate, migrated },
        'Applied autoIsolateContext to existing Feishu chats',
      );
    }

    // Hot-reload: reconnect user's Feishu channel
    if (deps?.reloadUserIMConfig) {
      try {
        await deps.reloadUserIMConfig(user.id, 'feishu');
      } catch (err) {
        logger.warn(
          { err, userId: user.id },
          'Failed to hot-reload user Feishu connection',
        );
      }
    }

    const connected = deps?.isUserFeishuConnected?.(user.id) ?? false;
    return c.json({
      ...toPublicFeishuProviderConfig(saved, 'runtime'),
      connected,
      autoIsolateContext: saved.autoIsolateContext ?? false,
    });
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
    const connected = deps?.isUserTelegramConnected?.(user.id) ?? false;
    const globalConfig = getTelegramProviderConfig();
    const userProxy = config?.proxyUrl || '';
    const sysProxy = globalConfig.proxyUrl || '';
    const proxy = resolveProxyInfo(userProxy, sysProxy);
    if (!config) {
      return c.json({
        hasBotToken: false,
        botTokenMasked: null,
        enabled: false,
        updatedAt: null,
        connected,
        proxyUrl: '',
        ...proxy,
      });
    }
    return c.json({
      ...toPublicTelegramProviderConfig(config, 'runtime'),
      connected,
      proxyUrl: userProxy,
      ...proxy,
    });
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

  // Billing: check IM channel limit when enabling
  if (validation.data.enabled === true && isBillingEnabled()) {
    const currentTg = getUserTelegramConfig(user.id);
    if (!currentTg?.enabled) {
      const limit = checkImChannelLimit(
        user.id,
        user.role,
        countOtherEnabledImChannels(user.id, 'telegram'),
      );
      if (!limit.allowed) {
        return c.json({ error: limit.reason }, 403);
      }
    }
  }

  const current = getUserTelegramConfig(user.id);
  const next = {
    botToken: current?.botToken || '',
    proxyUrl: current?.proxyUrl || '',
    enabled: current?.enabled ?? true,
    updatedAt: current?.updatedAt || null,
  };
  if (typeof validation.data.botToken === 'string') {
    const botToken = validation.data.botToken.trim();
    if (botToken) next.botToken = botToken;
  } else if (validation.data.clearBotToken === true) {
    next.botToken = '';
  }
  if (typeof validation.data.proxyUrl === 'string') {
    next.proxyUrl = validation.data.proxyUrl.trim();
  } else if (validation.data.clearProxyUrl === true) {
    next.proxyUrl = '';
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
      proxyUrl: next.proxyUrl || undefined,
      enabled: next.enabled,
    });
    appendImConfigAudit(
      user.username,
      'telegram',
      'update',
      Object.keys(validation.data),
      { userId: user.id },
    );

    // Hot-reload: reconnect user's Telegram channel
    if (deps?.reloadUserIMConfig) {
      try {
        await deps.reloadUserIMConfig(user.id, 'telegram');
      } catch (err) {
        logger.warn(
          { err, userId: user.id },
          'Failed to hot-reload user Telegram connection',
        );
      }
    }

    const connected = deps?.isUserTelegramConnected?.(user.id) ?? false;
    const userProxy = saved.proxyUrl || '';
    const sysProxy = getTelegramProviderConfig().proxyUrl || '';
    return c.json({
      ...toPublicTelegramProviderConfig(saved, 'runtime'),
      connected,
      proxyUrl: userProxy,
      ...resolveProxyInfo(userProxy, sysProxy),
    });
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

  const globalTelegramConfig = getTelegramProviderConfig();
  const effectiveProxy = config.proxyUrl || globalTelegramConfig.proxyUrl;
  const agent = createTelegramApiAgent(effectiveProxy);
  try {
    const { Bot } = await import('grammy');
    const testBot = new Bot(config.botToken, {
      client: {
        timeoutSeconds: 15,
        baseFetchConfig: {
          agent,
        },
      },
    });
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
  } finally {
    destroyTelegramApiAgent(agent);
  }
});

configRoutes.post(
  '/user-im/telegram/pairing-code',
  authMiddleware,
  async (c) => {
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
      const message =
        err instanceof Error ? err.message : 'Failed to generate pairing code';
      logger.warn({ err }, 'Failed to generate pairing code');
      return c.json({ error: message }, 500);
    }
  },
);

// List Telegram paired chats for the current user
configRoutes.get('/user-im/telegram/paired-chats', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const groups = (deps?.getRegisteredGroups() ?? {}) as Record<
    string,
    {
      name: string;
      added_at: string;
      created_by?: string;
      channel_account_id?: string | null;
    }
  >;
  const legacy = getLegacyChannelAccount(user.id, 'telegram');
  const chats: Array<{ jid: string; name: string; addedAt: string }> = [];
  for (const [jid, group] of Object.entries(groups)) {
    const address = parseChannelAddress(jid);
    if (
      address?.provider === 'telegram' &&
      group.created_by === user.id &&
      (address.legacy || group.channel_account_id === legacy?.id)
    ) {
      chats.push({ jid, name: group.name, addedAt: group.added_at });
    }
  }
  return c.json({ chats });
});

// Remove (unpair) a Telegram chat
configRoutes.delete(
  '/user-im/telegram/paired-chats/:jid',
  authMiddleware,
  (c) => {
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
    const legacy = getLegacyChannelAccount(user.id, 'telegram');
    const address = parseChannelAddress(jid);
    if (!address?.legacy && group.channel_account_id !== legacy?.id) {
      return c.json({ error: 'Not authorized to remove this chat' }, 403);
    }

    deleteRegisteredGroup(jid);
    deleteChatHistory(jid);
    delete groups[jid];
    logger.info({ jid, userId: user.id }, 'Telegram chat unpaired');
    return c.json({ success: true });
  },
);

// ─── QQ User IM Config ──────────────────────────────────────────

function maskQQAppSecret(secret: string): string | null {
  if (!secret) return null;
  if (secret.length <= 8) return '***';
  return secret.slice(0, 4) + '***' + secret.slice(-4);
}

configRoutes.get('/user-im/qq', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  try {
    const config = getUserQQConfig(user.id);
    const connected = deps?.isUserQQConnected?.(user.id) ?? false;
    if (!config) {
      return c.json({
        appId: '',
        hasAppSecret: false,
        appSecretMasked: null,
        enabled: false,
        updatedAt: null,
        connected,
      });
    }
    return c.json({
      appId: config.appId,
      hasAppSecret: !!config.appSecret,
      appSecretMasked: maskQQAppSecret(config.appSecret),
      enabled: config.enabled ?? false,
      updatedAt: config.updatedAt,
      connected,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to load user QQ config');
    return c.json({ error: 'Failed to load user QQ config' }, 500);
  }
});

configRoutes.put('/user-im/qq', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const validation = QQConfigSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }

  // Billing: check IM channel limit when enabling
  if (validation.data.enabled === true && isBillingEnabled()) {
    const currentQQ = getUserQQConfig(user.id);
    if (!currentQQ?.enabled) {
      const limit = checkImChannelLimit(
        user.id,
        user.role,
        countOtherEnabledImChannels(user.id, 'qq'),
      );
      if (!limit.allowed) {
        return c.json({ error: limit.reason }, 403);
      }
    }
  }

  const current = getUserQQConfig(user.id);
  const next = {
    appId: current?.appId || '',
    appSecret: current?.appSecret || '',
    enabled: current?.enabled ?? true,
  };
  if (typeof validation.data.appId === 'string') {
    next.appId = validation.data.appId.trim();
  }
  if (typeof validation.data.appSecret === 'string') {
    const appSecret = validation.data.appSecret.trim();
    if (appSecret) next.appSecret = appSecret;
  } else if (validation.data.clearAppSecret === true) {
    next.appSecret = '';
  }
  if (typeof validation.data.enabled === 'boolean') {
    next.enabled = validation.data.enabled;
  } else if (!current && next.appId && next.appSecret) {
    next.enabled = true;
  }

  try {
    const saved = saveUserQQConfig(user.id, {
      appId: next.appId,
      appSecret: next.appSecret,
      enabled: next.enabled,
    });
    appendImConfigAudit(
      user.username,
      'qq',
      'update',
      Object.keys(validation.data),
      { userId: user.id },
    );

    // Hot-reload: reconnect user's QQ channel
    if (deps?.reloadUserIMConfig) {
      try {
        await deps.reloadUserIMConfig(user.id, 'qq');
      } catch (err) {
        logger.warn(
          { err, userId: user.id },
          'Failed to hot-reload user QQ connection',
        );
      }
    }

    const connected = deps?.isUserQQConnected?.(user.id) ?? false;
    return c.json({
      appId: saved.appId,
      hasAppSecret: !!saved.appSecret,
      appSecretMasked: maskQQAppSecret(saved.appSecret),
      enabled: saved.enabled ?? false,
      updatedAt: saved.updatedAt,
      connected,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Invalid QQ config payload';
    logger.warn({ err }, 'Invalid user QQ config payload');
    return c.json({ error: message }, 400);
  }
});

configRoutes.post('/user-im/qq/test', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const config = getUserQQConfig(user.id);
  if (!config?.appId || !config?.appSecret) {
    return c.json({ error: 'QQ App ID and App Secret not configured' }, 400);
  }

  try {
    // Test by fetching access token
    const https = await import('node:https');
    const body = JSON.stringify({
      appId: config.appId,
      clientSecret: config.appSecret,
    });

    const result = await new Promise<{
      access_token?: string;
      expires_in?: number;
    }>((resolve, reject) => {
      const url = new URL('https://bots.qq.com/app/getAppAccessToken');
      const req = https.request(
        {
          hostname: url.hostname,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': String(Buffer.byteLength(body)),
          },
          timeout: 15000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
            } catch (err) {
              reject(err);
            }
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy(new Error('Request timeout'));
      });
      req.write(body);
      req.end();
    });

    if (!result.access_token) {
      return c.json(
        {
          error:
            'Failed to obtain access token. Please check App ID and App Secret.',
        },
        400,
      );
    }

    return c.json({
      success: true,
      expires_in: result.expires_in,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to connect to QQ';
    logger.warn({ err }, 'Failed to test user QQ connection');
    return c.json({ error: message }, 400);
  }
});

configRoutes.post('/user-im/qq/pairing-code', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const config = getUserQQConfig(user.id);
  if (!config?.appId || !config?.appSecret) {
    return c.json({ error: 'QQ App ID and App Secret not configured' }, 400);
  }

  try {
    const { generatePairingCode } = await import('../telegram-pairing.js');
    const result = generatePairingCode(user.id);
    return c.json(result);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to generate pairing code';
    logger.warn({ err }, 'Failed to generate QQ pairing code');
    return c.json({ error: message }, 500);
  }
});

// List QQ paired chats for the current user
configRoutes.get('/user-im/qq/paired-chats', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const groups = (deps?.getRegisteredGroups() ?? {}) as Record<
    string,
    {
      name: string;
      added_at: string;
      created_by?: string;
      channel_account_id?: string | null;
    }
  >;
  const legacy = getLegacyChannelAccount(user.id, 'qq');
  const chats: Array<{ jid: string; name: string; addedAt: string }> = [];
  for (const [jid, group] of Object.entries(groups)) {
    const address = parseChannelAddress(jid);
    if (
      address?.provider === 'qq' &&
      group.created_by === user.id &&
      (address.legacy || group.channel_account_id === legacy?.id)
    ) {
      chats.push({ jid, name: group.name, addedAt: group.added_at });
    }
  }
  return c.json({ chats });
});

// Rename a QQ paired chat
configRoutes.put('/user-im/qq/paired-chats/:jid', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const jid = decodeURIComponent(c.req.param('jid'));

  if (!jid.startsWith('qq:')) {
    return c.json({ error: 'Invalid QQ chat JID' }, 400);
  }

  const groups = deps?.getRegisteredGroups() ?? {};
  const group = groups[jid];
  if (!group) {
    return c.json({ error: 'Chat not found' }, 404);
  }
  if (group.created_by !== user.id) {
    return c.json({ error: 'Not authorized to rename this chat' }, 403);
  }
  const legacy = getLegacyChannelAccount(user.id, 'qq');
  const address = parseChannelAddress(jid);
  if (!address?.legacy && group.channel_account_id !== legacy?.id) {
    return c.json({ error: 'Not authorized to rename this chat' }, 403);
  }

  const body = await c.req
    .json<{ name?: unknown }>()
    .catch(() => ({}) as { name?: unknown });
  const rawName = typeof body.name === 'string' ? body.name : '';
  const name = rawName.trim();
  if (!name) {
    return c.json({ error: 'Name is required' }, 400);
  }
  if (name.length > 256) {
    return c.json({ error: 'Name too long (max 256 chars)' }, 400);
  }

  group.name = name;
  setRegisteredGroup(jid, group);
  updateChatName(jid, name);
  logger.info({ jid, name, userId: user.id }, 'QQ chat renamed');
  return c.json({ success: true });
});

// Remove (unpair) a QQ chat
configRoutes.delete('/user-im/qq/paired-chats/:jid', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  const jid = decodeURIComponent(c.req.param('jid'));

  if (!jid.startsWith('qq:')) {
    return c.json({ error: 'Invalid QQ chat JID' }, 400);
  }

  const groups = deps?.getRegisteredGroups() ?? {};
  const group = groups[jid];
  if (!group) {
    return c.json({ error: 'Chat not found' }, 404);
  }
  if (group.created_by !== user.id) {
    return c.json({ error: 'Not authorized to remove this chat' }, 403);
  }
  const legacy = getLegacyChannelAccount(user.id, 'qq');
  const address = parseChannelAddress(jid);
  if (!address?.legacy && group.channel_account_id !== legacy?.id) {
    return c.json({ error: 'Not authorized to remove this chat' }, 403);
  }

  deleteRegisteredGroup(jid);
  deleteChatHistory(jid);
  delete groups[jid];
  logger.info({ jid, userId: user.id }, 'QQ chat unpaired');
  return c.json({ success: true });
});

// ─── Per-user DingTalk IM config ──────────────────────────────────

configRoutes.get('/user-im/dingtalk', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  try {
    const config = getUserDingTalkConfig(user.id);
    const connected = deps?.isUserDingTalkConnected?.(user.id) ?? false;
    if (!config) {
      return c.json({
        clientId: '',
        hasClientSecret: false,
        clientSecretMasked: null,
        enabled: false,
        streamingMode: 'card',
        updatedAt: null,
        connected,
      });
    }
    return c.json({
      clientId: config.clientId,
      hasClientSecret: !!config.clientSecret,
      clientSecretMasked: config.clientSecret
        ? config.clientSecret.slice(0, 4) +
          '***' +
          config.clientSecret.slice(-4)
        : null,
      enabled: config.enabled ?? false,
      streamingMode: config.streamingMode ?? 'card',
      updatedAt: config.updatedAt,
      connected,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to load user DingTalk config');
    return c.json({ error: 'Failed to load DingTalk config' }, 500);
  }
});

configRoutes.put('/user-im/dingtalk', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const validation = DingTalkConfigSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }

  // Billing: check IM channel limit when enabling
  if (validation.data.enabled === true && isBillingEnabled()) {
    const current = getUserDingTalkConfig(user.id);
    if (!current?.enabled) {
      const limit = checkImChannelLimit(
        user.id,
        user.role,
        countOtherEnabledImChannels(user.id, 'dingtalk'),
      );
      if (!limit.allowed) {
        return c.json({ error: limit.reason }, 403);
      }
    }
  }

  const current = getUserDingTalkConfig(user.id);
  const next = {
    clientId: current?.clientId || '',
    clientSecret: current?.clientSecret || '',
    enabled: current?.enabled ?? true,
    streamingMode: current?.streamingMode ?? 'card',
  };

  if (typeof validation.data.clientId === 'string') {
    next.clientId = validation.data.clientId.trim();
  }
  if (typeof validation.data.clientSecret === 'string') {
    const secret = validation.data.clientSecret.trim();
    if (secret) next.clientSecret = secret;
  } else if (validation.data.clearClientSecret === true) {
    next.clientSecret = '';
  }
  if (typeof validation.data.enabled === 'boolean') {
    next.enabled = validation.data.enabled;
  } else if (!current && (next.clientId || next.clientSecret)) {
    next.enabled = true;
  }
  if (typeof validation.data.streamingMode === 'string') {
    next.streamingMode = validation.data.streamingMode;
  }

  try {
    const saved = saveUserDingTalkConfig(user.id, next);
    appendImConfigAudit(
      user.username,
      'dingtalk',
      'update',
      Object.keys(validation.data),
      { userId: user.id },
    );

    // Hot-reload: reconnect user's DingTalk channel
    if (deps?.reloadUserIMConfig) {
      try {
        await deps.reloadUserIMConfig(user.id, 'dingtalk');
      } catch (err) {
        logger.warn({ err, userId: user.id }, 'Failed to hot-reload DingTalk');
      }
    }

    const connected = deps?.isUserDingTalkConnected?.(user.id) ?? false;
    return c.json({
      clientId: saved.clientId,
      hasClientSecret: !!saved.clientSecret,
      clientSecretMasked: saved.clientSecret
        ? saved.clientSecret.slice(0, 4) + '***' + saved.clientSecret.slice(-4)
        : null,
      enabled: saved.enabled ?? false,
      streamingMode: saved.streamingMode ?? 'card',
      updatedAt: saved.updatedAt,
      connected,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid config';
    logger.warn({ err }, 'Invalid DingTalk config');
    return c.json({ error: message }, 400);
  }
});

configRoutes.post('/user-im/dingtalk/test', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const config = getUserDingTalkConfig(user.id);

  if (!config?.clientId || !config?.clientSecret) {
    return c.json({ error: 'DingTalk credentials not configured' }, 400);
  }

  try {
    // Test by initializing a client and getting access token
    const { DWClient } = await import('dingtalk-stream');
    const testClient = new DWClient({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    });

    // Try to get access token
    const token = await testClient.getAccessToken();
    if (!token) {
      testClient.disconnect?.();
      return c.json({ error: 'Failed to obtain access token' }, 400);
    }

    testClient.disconnect?.();
    return c.json({ success: true });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Connection test failed';
    logger.warn({ err }, 'DingTalk connection test failed');
    return c.json({ error: message }, 400);
  }
});

// ─── Per-user Discord IM config ──────────────────────────────────

configRoutes.get('/user-im/discord', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  try {
    const config = getUserDiscordConfig(user.id);
    const connected = deps?.isUserDiscordConnected?.(user.id) ?? false;
    if (!config) {
      return c.json({
        hasBotToken: false,
        botTokenMasked: null,
        enabled: false,
        streamingMode: 'off',
        updatedAt: null,
        connected,
      });
    }
    return c.json({
      hasBotToken: !!config.botToken,
      botTokenMasked: config.botToken
        ? config.botToken.slice(0, 4) + '***' + config.botToken.slice(-4)
        : null,
      enabled: config.enabled ?? false,
      streamingMode: config.streamingMode ?? 'off',
      updatedAt: config.updatedAt,
      connected,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to load user Discord config');
    return c.json({ error: 'Failed to load Discord config' }, 500);
  }
});

configRoutes.put('/user-im/discord', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const validation = DiscordConfigSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }

  // Billing: check IM channel limit when enabling
  if (validation.data.enabled === true && isBillingEnabled()) {
    const current = getUserDiscordConfig(user.id);
    if (!current?.enabled) {
      const limit = checkImChannelLimit(
        user.id,
        user.role,
        countOtherEnabledImChannels(user.id, 'discord'),
      );
      if (!limit.allowed) {
        return c.json({ error: limit.reason }, 403);
      }
    }
  }

  const current = getUserDiscordConfig(user.id);
  const next = {
    botToken: current?.botToken || '',
    enabled: current?.enabled ?? true,
    streamingMode: current?.streamingMode ?? ('off' as const),
  };

  if (typeof validation.data.botToken === 'string') {
    const token = validation.data.botToken.trim();
    if (token) next.botToken = token;
  } else if (validation.data.clearBotToken === true) {
    next.botToken = '';
  }
  if (typeof validation.data.enabled === 'boolean') {
    next.enabled = validation.data.enabled;
  } else if (!current && next.botToken) {
    next.enabled = true;
  }
  if (typeof validation.data.streamingMode === 'string') {
    next.streamingMode = validation.data.streamingMode;
  }

  try {
    const saved = saveUserDiscordConfig(user.id, next);
    appendImConfigAudit(
      user.username,
      'discord',
      'update',
      Object.keys(validation.data),
      { userId: user.id },
    );

    // Hot-reload: reconnect user's Discord channel
    if (deps?.reloadUserIMConfig) {
      try {
        await deps.reloadUserIMConfig(user.id, 'discord');
      } catch (err) {
        logger.warn({ err, userId: user.id }, 'Failed to hot-reload Discord');
      }
    }

    const connected = deps?.isUserDiscordConnected?.(user.id) ?? false;
    return c.json({
      hasBotToken: !!saved.botToken,
      botTokenMasked: saved.botToken
        ? saved.botToken.slice(0, 4) + '***' + saved.botToken.slice(-4)
        : null,
      enabled: saved.enabled ?? false,
      streamingMode: saved.streamingMode ?? 'off',
      updatedAt: saved.updatedAt,
      connected,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid config';
    logger.warn({ err }, 'Invalid Discord config');
    return c.json({ error: message }, 400);
  }
});

configRoutes.post('/user-im/discord/test', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const config = getUserDiscordConfig(user.id);

  if (!config?.botToken) {
    return c.json({ error: 'Discord Bot Token not configured' }, 400);
  }

  let timeoutId: NodeJS.Timeout | undefined;
  try {
    // Test by creating a temporary Client and logging in
    const { Client, GatewayIntentBits } = await import('discord.js');
    const testClient = new Client({ intents: [GatewayIntentBits.Guilds] });

    const result = await Promise.race([
      new Promise<{ success: true; bot_username: string; bot_name: string }>(
        (resolve, reject) => {
          testClient.once('ready', () => {
            const username = testClient.user?.username || 'unknown';
            const name = testClient.user?.displayName || username;
            testClient.destroy();
            resolve({ success: true, bot_username: username, bot_name: name });
          });
          testClient.once('error', (err) => {
            testClient.destroy();
            reject(err);
          });
          testClient.login(config.botToken).catch((err) => {
            testClient.destroy();
            reject(err);
          });
        },
      ),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          testClient.destroy();
          reject(new Error('Connection test timed out (10s)'));
        }, 10000);
      }),
    ]);

    return c.json(result);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Connection test failed';
    logger.warn({ err }, 'Discord connection test failed');
    return c.json({ error: message }, 400);
  } finally {
    // Defense-in-depth: clear the race timer in both success and failure paths
    // so the process doesn't keep an active handle for up to 10s after the test.
    if (timeoutId) clearTimeout(timeoutId);
  }
});

// ─── Per-user WeChat IM config ──────────────────────────────────

const WECHAT_API_BASE = 'https://ilinkai.weixin.qq.com';
const WECHAT_QR_BOT_TYPE = '3';

function randomWechatUin(): string {
  const uint32 = randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

function maskBotToken(token: string | undefined): string | null {
  if (!token) return null;
  if (token.length <= 8) return '***';
  return token.slice(0, 4) + '***' + token.slice(-4);
}

configRoutes.get('/user-im/wechat', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  try {
    const config = getUserWeChatConfig(user.id);
    const connected = deps?.isUserWeChatConnected?.(user.id) ?? false;
    if (!config) {
      return c.json({
        ilinkBotId: '',
        hasBotToken: false,
        botTokenMasked: null,
        bypassProxy: true,
        enabled: false,
        updatedAt: null,
        connected,
      });
    }
    return c.json({
      ilinkBotId: config.ilinkBotId || '',
      hasBotToken: !!config.botToken,
      botTokenMasked: maskBotToken(config.botToken),
      bypassProxy: config.bypassProxy ?? true,
      enabled: config.enabled ?? false,
      updatedAt: config.updatedAt,
      connected,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to load user WeChat config');
    return c.json({ error: 'Failed to load user WeChat config' }, 500);
  }
});

configRoutes.put('/user-im/wechat', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const validation = WeChatConfigSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }

  // Billing: check IM channel limit when enabling
  if (validation.data.enabled === true && isBillingEnabled()) {
    const currentWc = getUserWeChatConfig(user.id);
    if (!currentWc?.enabled) {
      const limit = checkImChannelLimit(
        user.id,
        user.role,
        countOtherEnabledImChannels(user.id, 'wechat'),
      );
      if (!limit.allowed) {
        return c.json({ error: limit.reason }, 403);
      }
    }
  }

  const current = getUserWeChatConfig(user.id);
  const next = {
    botToken: current?.botToken || '',
    ilinkBotId: current?.ilinkBotId || '',
    baseUrl: current?.baseUrl,
    cdnBaseUrl: current?.cdnBaseUrl,
    getUpdatesBuf: current?.getUpdatesBuf,
    bypassProxy: current?.bypassProxy ?? true,
    enabled: current?.enabled ?? false,
  };

  if (validation.data.clearBotToken === true) {
    next.botToken = '';
    next.ilinkBotId = '';
  }
  if (typeof validation.data.enabled === 'boolean') {
    next.enabled = validation.data.enabled;
  }
  if (typeof validation.data.bypassProxy === 'boolean') {
    next.bypassProxy = validation.data.bypassProxy;
  }

  try {
    const saved = saveUserWeChatConfig(user.id, next);
    appendImConfigAudit(
      user.username,
      'wechat',
      'update',
      Object.keys(validation.data),
      { userId: user.id },
    );

    // Hot-reload: reconnect user's WeChat channel
    if (deps?.reloadUserIMConfig) {
      try {
        await deps.reloadUserIMConfig(user.id, 'wechat');
      } catch (err) {
        logger.warn(
          { err, userId: user.id },
          'Failed to hot-reload user WeChat connection',
        );
      }
    }

    const connected = deps?.isUserWeChatConnected?.(user.id) ?? false;
    return c.json({
      ilinkBotId: saved.ilinkBotId || '',
      hasBotToken: !!saved.botToken,
      botTokenMasked: maskBotToken(saved.botToken),
      bypassProxy: saved.bypassProxy ?? true,
      enabled: saved.enabled ?? false,
      updatedAt: saved.updatedAt,
      connected,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Invalid WeChat config payload';
    logger.warn({ err }, 'Invalid user WeChat config payload');
    return c.json({ error: message }, 400);
  }
});

// Generate QR code for WeChat iLink login
configRoutes.post('/user-im/wechat/qrcode', authMiddleware, async (c) => {
  try {
    const url = `${WECHAT_API_BASE}/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(WECHAT_QR_BOT_TYPE)}`;
    const res = await fetch(url);
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.error({ status: res.status, body }, 'WeChat QR code fetch failed');
      return c.json({ error: `Failed to fetch QR code: ${res.status}` }, 502);
    }
    const data = (await res.json()) as {
      qrcode?: string;
      qrcode_img_content?: string;
    };
    if (!data.qrcode) {
      return c.json({ error: 'No QR code in response' }, 502);
    }

    // qrcode_img_content is a URL string (WeChat deep link) to be encoded
    // INTO a QR code image, not an image URL itself.
    let qrcodeDataUri = '';
    if (data.qrcode_img_content) {
      try {
        qrcodeDataUri = await QRCode.toDataURL(data.qrcode_img_content, {
          width: 512,
          margin: 2,
          color: { dark: '#000000', light: '#ffffff' },
        });
      } catch (qrErr) {
        logger.warn({ err: qrErr }, 'Failed to generate QR code image');
      }
    }

    return c.json({
      qrcode: data.qrcode,
      qrcodeUrl: qrcodeDataUri,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to generate QR code';
    logger.error({ err }, 'WeChat QR code generation failed');
    return c.json({ error: message }, 500);
  }
});

// Poll QR code scan status
configRoutes.get('/user-im/wechat/qrcode-status', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const qrcode = c.req.query('qrcode');
  if (!qrcode) {
    return c.json({ error: 'qrcode query parameter required' }, 400);
  }

  try {
    const url = `${WECHAT_API_BASE}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
    const headers: Record<string, string> = {
      'iLink-App-ClientVersion': '1',
    };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 35000);
    let res: Response;
    try {
      res = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timer);
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') {
        return c.json({ status: 'wait' });
      }
      throw err;
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return c.json(
        { error: `QR status poll failed: ${res.status}`, body },
        502,
      );
    }

    const data = (await res.json()) as {
      status?: 'wait' | 'scaned' | 'confirmed' | 'expired';
      bot_token?: string;
      ilink_bot_id?: string;
      baseurl?: string;
      ilink_user_id?: string;
    };

    if (data.status === 'confirmed' && data.bot_token && data.ilink_bot_id) {
      // Auto-save credentials and connect
      const saved = saveUserWeChatConfig(user.id, {
        botToken: data.bot_token,
        ilinkBotId: data.ilink_bot_id.replace(/[^a-zA-Z0-9@._-]/g, ''),
        baseUrl: data.baseurl || undefined,
        enabled: true,
      });
      appendImConfigAudit(
        user.username,
        'wechat',
        'oauth_qr_confirmed',
        ['botToken', 'ilinkBotId', 'baseUrl', 'enabled'],
        { userId: user.id },
      );

      // Note: ilink_user_id (the QR scanner) is NOT auto-paired here.
      // The scanner needs to send a message to the bot and use /pair <code>
      // to complete pairing, same as QQ/Telegram flow.
      // This ensures proper group registration via buildOnNewChat/registerGroup.

      // Hot-reload: connect WeChat
      if (deps?.reloadUserIMConfig) {
        try {
          await deps.reloadUserIMConfig(user.id, 'wechat');
        } catch (err) {
          logger.warn(
            { err, userId: user.id },
            'Failed to hot-reload WeChat after QR login',
          );
        }
      }

      return c.json({
        status: 'confirmed',
        ilinkBotId: saved.ilinkBotId,
      });
    }

    return c.json({
      status: data.status || 'wait',
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'QR status poll failed';
    logger.error({ err }, 'WeChat QR status poll failed');
    return c.json({ error: message }, 500);
  }
});

// Disconnect WeChat and clear token
configRoutes.post('/user-im/wechat/disconnect', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  try {
    const current = getUserWeChatConfig(user.id);
    if (current) {
      saveUserWeChatConfig(user.id, {
        botToken: '',
        ilinkBotId: '',
        enabled: false,
        getUpdatesBuf: current.getUpdatesBuf,
      });
    }

    // Disconnect
    if (deps?.reloadUserIMConfig) {
      try {
        await deps.reloadUserIMConfig(user.id, 'wechat');
      } catch (err) {
        logger.warn({ err, userId: user.id }, 'Failed to disconnect WeChat');
      }
    }

    return c.json({ success: true });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Failed to disconnect WeChat';
    logger.error({ err }, 'WeChat disconnect failed');
    return c.json({ error: message }, 500);
  }
});

// ─── WhatsApp (Baileys-based, M1: QR login + connection state) ──

configRoutes.get('/user-im/whatsapp', authMiddleware, (c) => {
  const user = c.get('user') as AuthUser;
  try {
    const config = getUserWhatsAppConfig(user.id);
    const connected = deps?.isUserWhatsAppConnected?.(user.id) ?? false;
    const state = deps?.getUserWhatsAppState?.(user.id) ?? {
      status: 'disconnected' as const,
    };
    if (!config) {
      return c.json({
        accountId: 'default',
        phoneNumber: '',
        enabled: false,
        paired: false,
        updatedAt: null,
        connected,
        state,
      });
    }
    return c.json({
      accountId: config.accountId || 'default',
      phoneNumber: config.phoneNumber || '',
      enabled: config.enabled ?? false,
      paired: config.paired ?? false,
      updatedAt: config.updatedAt,
      connected,
      state,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to load user WhatsApp config');
    return c.json({ error: 'Failed to load user WhatsApp config' }, 500);
  }
});

configRoutes.put('/user-im/whatsapp', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const body = await c.req.json().catch(() => ({}));
  const validation = WhatsAppConfigSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }

  // Billing: check IM channel limit when enabling
  if (validation.data.enabled === true && isBillingEnabled()) {
    const currentWa = getUserWhatsAppConfig(user.id);
    if (!currentWa?.enabled) {
      const limit = checkImChannelLimit(
        user.id,
        user.role,
        countOtherEnabledImChannels(user.id, 'whatsapp'),
      );
      if (!limit.allowed) {
        return c.json({ error: limit.reason }, 403);
      }
    }
  }

  const current = getUserWhatsAppConfig(user.id);
  const next = {
    accountId: current?.accountId || 'default',
    phoneNumber: current?.phoneNumber || '',
    enabled: current?.enabled ?? false,
    paired: current?.paired ?? false,
  };

  if (typeof validation.data.accountId === 'string') {
    next.accountId = validation.data.accountId.trim() || 'default';
  }
  if (typeof validation.data.phoneNumber === 'string') {
    next.phoneNumber = validation.data.phoneNumber.trim();
  }
  if (typeof validation.data.enabled === 'boolean') {
    next.enabled = validation.data.enabled;
  }
  // paired 已从 schema 移除：由 saveUserWhatsAppConfig 在 Baileys 登录回调
  // 中写入，前端 PUT 不再接受该字段（防止用户伪装扫码完成）。

  try {
    const saved = saveUserWhatsAppConfig(user.id, next);
    appendImConfigAudit(
      user.username,
      'whatsapp',
      'update',
      Object.keys(validation.data),
      { userId: user.id },
    );

    // Hot-reload: reconnect user's WhatsApp channel (skeleton always returns false)
    if (deps?.reloadUserIMConfig) {
      try {
        await deps.reloadUserIMConfig(user.id, 'whatsapp');
      } catch (err) {
        logger.warn(
          { err, userId: user.id },
          'Failed to hot-reload user WhatsApp connection',
        );
      }
    }

    const connected = deps?.isUserWhatsAppConnected?.(user.id) ?? false;
    const state = deps?.getUserWhatsAppState?.(user.id) ?? {
      status: 'disconnected' as const,
    };
    return c.json({
      accountId: saved.accountId,
      phoneNumber: saved.phoneNumber,
      enabled: saved.enabled ?? false,
      paired: saved.paired ?? false,
      updatedAt: saved.updatedAt,
      connected,
      state,
    });
  } catch (err) {
    const message =
      err instanceof Error ? err.message : 'Invalid WhatsApp config payload';
    logger.warn({ err }, 'Invalid WhatsApp config');
    return c.json({ error: message }, 400);
  }
});

/**
 * Hard logout: tell WhatsApp servers, drop the socket, wipe local auth state,
 * and persist `enabled=false`/`paired=false`. Next enable forces a fresh QR.
 *
 * Distinct from PUT /user-im/whatsapp { enabled: false }, which only stops the
 * socket but keeps the noise/Signal pre-keys on disk for silent reconnect.
 */
configRoutes.post('/user-im/whatsapp/logout', authMiddleware, async (c) => {
  const user = c.get('user') as AuthUser;
  const current = getUserWhatsAppConfig(user.id);
  // Compatibility facade: the first-class default account owns the actual
  // Baileys connection/authDir. Never use the user-editable legacy label as
  // an auth directory key.
  const accountId =
    getDefaultChannelAccount(user.id, 'whatsapp')?.id ??
    current?.accountId ??
    'default';

  if (deps?.logoutUserWhatsApp) {
    try {
      await deps.logoutUserWhatsApp(user.id, accountId);
    } catch (err) {
      logger.warn({ err, userId: user.id }, 'WhatsApp logout deps call failed');
    }
  }

  try {
    const saved = saveUserWhatsAppConfig(user.id, {
      accountId,
      phoneNumber: current?.phoneNumber || '',
      enabled: false,
      paired: false,
    });
    appendImConfigAudit(
      user.username,
      'whatsapp',
      'logout',
      ['enabled', 'paired'],
      { userId: user.id, accountId },
    );
    const state = deps?.getUserWhatsAppState?.(user.id) ?? {
      status: 'logged_out' as const,
    };
    return c.json({
      accountId: saved.accountId,
      phoneNumber: saved.phoneNumber,
      enabled: saved.enabled ?? false,
      paired: saved.paired ?? false,
      updatedAt: saved.updatedAt,
      connected: false,
      state,
    });
  } catch (err) {
    logger.error({ err }, 'Failed to persist WhatsApp logout state');
    return c.json({ error: 'Failed to save logout state' }, 500);
  }
});

// ─── IM Binding management (bindings panoramic page) ────────────

configRoutes.put('/user-im/bindings/:imJid', authMiddleware, async (c) => {
  const imJid = decodeURIComponent(c.req.param('imJid'));
  const user = c.get('user') as AuthUser;

  // Validate IM JID
  const channelType = getChannelType(imJid);
  if (!channelType) {
    return c.json({ error: 'Invalid IM JID' }, 400);
  }

  const imGroup = getRegisteredGroup(imJid);
  if (!imGroup) {
    return c.json({ error: 'IM group not found' }, 404);
  }
  // IM-binding 改的是 imGroup 行（target_agent_id / target_main_jid /
  // activation_mode 等），与 agents.ts 的 4 个 IM-binding 路由对齐：
  // 非成员用 access 检查隐藏存在性（404），成员但非 owner 拒绝写（403）。
  // IM 路由变更必须由对应工作区所有者执行。
  if (!canAccessGroup(user, { ...imGroup, jid: imJid })) {
    return c.json({ error: 'IM group not found' }, 404);
  }
  if (!canModifyGroup(user, { ...imGroup, jid: imJid })) {
    return c.json({ error: 'Forbidden' }, 403);
  }
  if (!hasConsistentChannelAccount(user.id, imJid, imGroup)) {
    return c.json({ error: 'Invalid or inaccessible channel account' }, 400);
  }

  const body = await c.req.json().catch(() => ({}));

  // Unbind mode
  if (body.unbind === true) {
    const { chatInfo } = await fetchLiveChatInfo(user.id, imJid);
    // Re-read + re-authorize after the await — fetchLiveChatInfo
    // yields the event loop on a live network call, during which ownership
    // or binding state may have changed. restoreDefaultChannelMount commits
    // whatever `group` it's given, so building it from the stale pre-await
    // snapshot would silently clobber a concurrent write and could cross
    // the original authorization boundary.
    const freshImGroup = getRegisteredGroup(imJid);
    if (!freshImGroup) {
      return c.json({ error: 'IM group not found' }, 404);
    }
    if (!canAccessGroup(user, { ...freshImGroup, jid: imJid })) {
      return c.json({ error: 'IM group not found' }, 404);
    }
    if (!canModifyGroup(user, { ...freshImGroup, jid: imJid })) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    if (!hasConsistentChannelAccount(user.id, imJid, freshImGroup)) {
      return c.json({ error: 'Invalid or inaccessible channel account' }, 400);
    }
    const previousTargetAgentId = freshImGroup.target_agent_id;
    const previousTargetMainJid = freshImGroup.target_main_jid;
    const wasThreadMap = freshImGroup.binding_mode === 'thread_map';
    const restored = restoreDefaultChannelMount(
      imJid,
      freshImGroup,
      user.id,
      chatInfo ?? {},
    );
    if (restored.status !== 'resolved') {
      return c.json({ error: restoreDefaultChannelError(restored) }, 409);
    }
    if (wasThreadMap) {
      detachThreadMapWorkspaceIfLast(
        previousTargetMainJid,
        imJid,
        restored.workspaceJid,
        restored.routingMode,
      );
    }
    if (restored.routingMode === 'thread_map') {
      markNativeContextWorkspace(restored.workspaceJid);
    }
    if (previousTargetAgentId) {
      refreshAgentLastImJid(previousTargetAgentId);
    }
    logger.info(
      {
        imJid,
        defaultWorkspaceJid: restored.workspaceJid,
        userId: user.id,
      },
      'IM group restored to channel account default workspace (bindings page)',
    );
    return c.json({ success: true, target_main_jid: restored.workspaceJid });
  }

  const targetSessionId =
    typeof body.target_session_id === 'string' && body.target_session_id.trim()
      ? body.target_session_id.trim()
      : typeof body.target_agent_id === 'string' && body.target_agent_id.trim()
        ? body.target_agent_id.trim()
        : '';

  // Bind to workspace session. Stored in target_agent_id for backward compatibility.
  if (targetSessionId) {
    const sessionId = targetSessionId;
    const agent = getAgent(sessionId);
    if (!agent) {
      return c.json({ error: 'Session not found' }, 404);
    }
    if (agent.kind !== 'conversation') {
      return c.json(
        { error: 'Only workspace sessions can bind IM groups' },
        400,
      );
    }
    if (!agent.chat_jid.startsWith('web:')) {
      return c.json(
        { error: 'Session target must belong to a workspace' },
        400,
      );
    }
    // Check user can access the workspace that owns this session.
    const ownerGroup = getRegisteredGroup(agent.chat_jid);
    if (
      !ownerGroup ||
      !canModifyGroup(user, { ...ownerGroup, jid: agent.chat_jid })
    ) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const { chatInfo } = await fetchLiveChatInfo(user.id, imJid);
    // Re-read after the await: fetchLiveChatInfo makes a live network call
    // that yields the event loop, during which a concurrent bind request or
    // the message router's owner-learning path can commit a new mount for
    // this exact imJid, or upgrade native_context_type from 'none' to
    // 'thread'. Building the update, or computing threadCapable, from the
    // pre-await snapshot would silently clobber that write or bind a
    // now-thread-capable container as a fixed single session.
    const freshImGroup = getRegisteredGroup(imJid);
    if (!freshImGroup) {
      return c.json({ error: 'IM group not found' }, 404);
    }
    // Re-run authorization against the fresh row — the handler's top-level
    // checks only proved it against the stale imGroup read before the await.
    if (!canAccessGroup(user, { ...freshImGroup, jid: imJid })) {
      return c.json({ error: 'IM group not found' }, 404);
    }
    if (!canModifyGroup(user, { ...freshImGroup, jid: imJid })) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    if (!hasConsistentChannelAccount(user.id, imJid, freshImGroup)) {
      return c.json({ error: 'Invalid or inaccessible channel account' }, 400);
    }
    const freshAgent = getAgent(sessionId);
    if (
      !freshAgent ||
      freshAgent.kind !== 'conversation' ||
      !freshAgent.chat_jid.startsWith('web:')
    ) {
      return c.json({ error: 'Session not found' }, 404);
    }
    const freshOwnerGroup = getRegisteredGroup(freshAgent.chat_jid);
    if (
      !freshOwnerGroup ||
      !canModifyGroup(user, {
        ...freshOwnerGroup,
        jid: freshAgent.chat_jid,
      })
    ) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    // Compute against freshImGroup, not the pre-await snapshot — see
    // fetchLiveChatInfo's doc comment.
    if (isNativeContextContainer(imJid, freshImGroup, chatInfo ?? {})) {
      return c.json(
        {
          error:
            'Native thread containers can only bind to a workspace, not a single session',
        },
        400,
      );
    }
    const bindingPolicyError = conversationBindingPolicyError(
      getConversationKind(imJid, freshImGroup, chatInfo),
      'session',
    );
    if (bindingPolicyError) {
      return c.json({ error: bindingPolicyError }, 400);
    }

    const force = body.force === true;
    const replyPolicy =
      body.reply_policy === 'mirror' ? 'mirror' : 'source_only';
    const hasConflict = hasSessionMountConflict(freshImGroup, sessionId);
    if (hasConflict && !force) {
      return c.json({ error: 'IM group is already bound elsewhere' }, 409);
    }

    const updated: RegisteredGroup = buildSessionMountUpdate(
      freshImGroup,
      sessionId,
      {
        replyPolicy,
      },
    );
    applyBindingUpdate(imJid, updated);
    if (freshImGroup.binding_mode === 'thread_map') {
      detachThreadMapWorkspaceIfLast(freshImGroup.target_main_jid, imJid);
    }
    logger.info(
      { imJid, sessionId, userId: user.id },
      'IM group bound to workspace session (bindings page)',
    );
    return c.json({ success: true });
  }

  // Parse activation_mode for activation-only update
  const rawActivationMode = body.activation_mode;
  let activationMode =
    typeof rawActivationMode === 'string' &&
    VALID_ACTIVATION_MODES.has(rawActivationMode)
      ? (rawActivationMode as
          | (typeof rawActivationMode & 'auto')
          | 'always'
          | 'when_mentioned'
          | 'owner_mentioned'
          | 'disabled')
      : undefined;
  let audienceMode: AudienceMode | undefined =
    body.audience_mode === 'everyone' || body.audience_mode === 'owner_only'
      ? body.audience_mode
      : undefined;
  if (channelType === 'feishu') {
    const normalized = normalizeLegacyOwnerMention({
      activationMode,
      audienceMode,
    });
    activationMode = normalized.activationMode;
    audienceMode = normalized.audienceMode;
  }

  // Parse owner_im_id for owner_mentioned mode
  const ownerImId =
    typeof body.owner_im_id === 'string' && body.owner_im_id.trim()
      ? body.owner_im_id.trim()
      : undefined;

  // Bind to workspace main conversation
  if (typeof body.target_main_jid === 'string' && body.target_main_jid.trim()) {
    const targetMainJid = body.target_main_jid.trim();
    if (!targetMainJid.startsWith('web:')) {
      return c.json({ error: 'Target must be a workspace' }, 400);
    }
    const targetGroup = getRegisteredGroup(targetMainJid);
    if (!targetGroup) {
      return c.json({ error: 'Target workspace not found' }, 404);
    }
    if (!canModifyGroup(user, { ...targetGroup, jid: targetMainJid })) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const { chatInfo } = await fetchLiveChatInfo(user.id, imJid);
    // Re-read + re-authorize after the await — see the analogous comment
    // in the session-bind branch above.
    const freshImGroup = getRegisteredGroup(imJid);
    if (!freshImGroup) {
      return c.json({ error: 'IM group not found' }, 404);
    }
    if (!canAccessGroup(user, { ...freshImGroup, jid: imJid })) {
      return c.json({ error: 'IM group not found' }, 404);
    }
    if (!canModifyGroup(user, { ...freshImGroup, jid: imJid })) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    if (!hasConsistentChannelAccount(user.id, imJid, freshImGroup)) {
      return c.json({ error: 'Invalid or inaccessible channel account' }, 400);
    }
    const freshTargetGroup = getRegisteredGroup(targetMainJid);
    if (!freshTargetGroup) {
      return c.json({ error: 'Target workspace not found' }, 404);
    }
    if (!canModifyGroup(user, { ...freshTargetGroup, jid: targetMainJid })) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    const bindingPolicyError = conversationBindingPolicyError(
      getConversationKind(imJid, freshImGroup, chatInfo),
      'workspace',
    );
    if (bindingPolicyError) {
      return c.json({ error: bindingPolicyError }, 400);
    }
    if (
      getChannelType(imJid) === 'feishu' &&
      (chatInfo?.chat_mode ?? freshImGroup.feishu_chat_mode) === 'p2p' &&
      isMentionActivationMode(activationMode)
    ) {
      return c.json(
        { error: 'Feishu private chats do not support mention activation' },
        400,
      );
    }
    // Compute against freshImGroup, not the pre-await snapshot — see
    // fetchLiveChatInfo's doc comment.
    const threadCapable = isNativeContextContainer(imJid, freshImGroup, {
      ...(chatInfo ?? {}),
      activation_mode: activationMode ?? freshImGroup.activation_mode,
    });
    const force = body.force === true;
    const replyPolicy =
      body.reply_policy === 'mirror' ? 'mirror' : 'source_only';
    const legacyMainJid = `web:${freshTargetGroup.folder}`;
    const hasConflict = hasWorkspaceMountConflict(
      freshImGroup,
      targetMainJid,
      legacyMainJid,
    );
    if (hasConflict && !force) {
      return c.json({ error: 'IM group is already bound elsewhere' }, 409);
    }
    const updated: RegisteredGroup = {
      ...buildWorkspaceMountUpdate(
        freshImGroup,
        targetMainJid,
        threadCapable ? 'thread_map' : 'single_session',
        {
          replyPolicy,
          ...(activationMode !== undefined ? { activationMode } : {}),
          ...(audienceMode !== undefined ? { audienceMode } : {}),
          ...(ownerImId !== undefined ? { ownerImId } : {}),
        },
      ),
      feishu_chat_mode: chatInfo?.chat_mode ?? freshImGroup.feishu_chat_mode,
      feishu_group_message_type:
        chatInfo?.group_message_type ?? freshImGroup.feishu_group_message_type,
      ...(ownerImId !== undefined
        ? { owner_claim_source: 'configured' as const }
        : {}),
    };
    applyBindingUpdate(imJid, updated);
    if (freshImGroup.binding_mode === 'thread_map') {
      detachThreadMapWorkspaceIfLast(
        freshImGroup.target_main_jid,
        imJid,
        targetMainJid,
        threadCapable ? 'thread_map' : 'single_session',
      );
    }
    if (threadCapable) markNativeContextWorkspace(targetMainJid);
    logger.info(
      { imJid, targetMainJid, threadCapable, userId: user.id },
      'IM group bound to workspace (bindings page)',
    );
    return c.json({ success: true });
  }

  // Activation-only update (no target, just update activation_mode and/or owner_im_id)
  if (
    activationMode !== undefined ||
    audienceMode !== undefined ||
    ownerImId !== undefined
  ) {
    if (
      getChannelType(imJid) === 'feishu' &&
      imGroup.feishu_chat_mode === 'p2p' &&
      isMentionActivationMode(activationMode)
    ) {
      return c.json(
        { error: 'Feishu private chats do not support mention activation' },
        400,
      );
    }
    const candidate: RegisteredGroup = {
      ...imGroup,
      ...(activationMode !== undefined
        ? { activation_mode: activationMode }
        : {}),
      ...(audienceMode !== undefined ? { audience_mode: audienceMode } : {}),
      ...(ownerImId !== undefined ? { owner_im_id: ownerImId } : {}),
      ...(ownerImId !== undefined
        ? { owner_claim_source: 'configured' as const }
        : {}),
    };
    const threadCapable = isNativeContextContainer(imJid, candidate, {
      activation_mode: candidate.activation_mode,
    });
    if (threadCapable && candidate.target_agent_id) {
      return c.json(
        {
          error:
            'Mention-activated and native-topic Feishu chats must bind to a workspace, not a fixed session',
        },
        400,
      );
    }
    const updated = candidate.target_main_jid
      ? buildWorkspaceMountUpdate(
          candidate,
          candidate.target_main_jid,
          threadCapable ? 'thread_map' : 'single_session',
          {
            activationMode: candidate.activation_mode,
            audienceMode: candidate.audience_mode,
            ownerImId: candidate.owner_im_id ?? null,
          },
        )
      : candidate;
    applyBindingUpdate(imJid, updated);
    if (imGroup.binding_mode === 'thread_map' && !threadCapable) {
      detachThreadMapWorkspaceIfLast(imGroup.target_main_jid, imJid);
    }
    if (threadCapable && updated.target_main_jid) {
      markNativeContextWorkspace(updated.target_main_jid);
    }
    logger.info(
      { imJid, activationMode, audienceMode, ownerImId, userId: user.id },
      'IM group response policies updated (bindings page)',
    );
    return c.json({ success: true });
  }

  return c.json(
    {
      error:
        'Must provide target_main_jid, target_session_id, target_agent_id, activation_mode, audience_mode, or unbind',
    },
    400,
  );
});

// Escape hatch for the pre-owner Feishu lock. Reset both the legacy allowlist
// and the v58 audience policy so the visible "解除限制" action truly allows
// everyone to trigger the bot.
configRoutes.post(
  '/user-im/bindings/:imJid/reset-allowlist',
  authMiddleware,
  (c) => {
    const imJid = decodeURIComponent(c.req.param('imJid'));
    const user = c.get('user') as AuthUser;

    const channelType = getChannelType(imJid);
    if (!channelType) {
      return c.json({ error: 'Invalid IM JID' }, 400);
    }
    if (channelType !== 'feishu') {
      return c.json({ error: 'Only Feishu groups are supported' }, 400);
    }

    const imGroup = getRegisteredGroup(imJid);
    if (!imGroup) {
      return c.json({ error: 'IM group not found' }, 404);
    }
    if (!canAccessGroup(user, { ...imGroup, jid: imJid })) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    if (imGroup.created_by !== user.id) {
      return c.json({ error: 'Forbidden' }, 403);
    }
    if (
      !Array.isArray(imGroup.sender_allowlist) ||
      imGroup.sender_allowlist.length !== 0
    ) {
      return c.json({ error: 'Group is not in locked allowlist state' }, 400);
    }

    const updated: RegisteredGroup = {
      ...imGroup,
      sender_allowlist: undefined,
      audience_mode: 'everyone',
    };
    applyBindingUpdate(imJid, updated);

    logger.info(
      { imJid, userId: user.id },
      'Feishu response audience reset to everyone (bindings page)',
    );
    return c.json({ success: true });
  },
);

export default configRoutes;
