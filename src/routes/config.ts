// Configuration management routes

import { randomBytes, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Agent as HttpsAgent } from 'node:https';
import { ProxyAgent } from 'proxy-agent';
import QRCode from 'qrcode';
import { Hono, type Context } from 'hono';
import {
  listStorageSources,
  listStorageSourceUsers,
  planStorageSourceDelete,
  planStorageSourceSave,
  StorageSourceAdminError,
  withStorageSourceWriteLock,
} from '../storage-source-admin.js';
import { DATA_DIR } from '../config.js';
import { bindSystemMainIfUnbound } from '../model-binding-backfill.js';
import {
  avatarUploadBodyLimit,
  AVATAR_MAX_FILE_BYTES,
} from '../http-upload-policy.js';
import type { Variables } from '../web-context.js';
import { getWebDeps } from '../web-context.js';
import { canAccessGroup, canModifyGroup } from '../group-acl.js';
import { recordLegacyUserImRoute } from '../legacy-route-telemetry.js';
import { getChannelType } from '../im-channel.js';
import {
  deleteRegisteredGroup,
  deleteChatHistory,
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
  getRouterState,
  getRouterStateByPrefix,
  setRouterState,
  deleteRouterState,
  isDatabaseInitialized,
  getDefaultChannelAccount,
  getLegacyChannelAccount,
  clearSessionModelSelectionsForModelConfig,
  countAgentProfilesByModelConfigId,
  countSessionModelSelectionsForModelConfig,
  listAgentProfilesUsingModels,
  listSessionNamespacesForProviderId,
} from '../db.js';
import { parseChannelAddress } from '../channel-address.js';
import { conversationBindingPolicyError } from '../channel-conversation-kind.js';
import {
  FEISHU_P2P_MENTION_ACTIVATION_ERROR,
  feishuP2pRejectsMentionActivation,
  fetchLiveChatInfo,
  getConversationKind,
  hasConsistentChannelAccount,
  parseBindingResponsePolicy,
  refreshAgentLastImJid,
} from '../channel-binding-helpers.js';
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
  StorageSourceSaveSchema,
  UnifiedProviderCreateSchema,
  UnifiedProviderPatchSchema,
  UnifiedProviderSecretsSchema,
  ProviderConnectivityTestSchema,
  ProviderDiscoverModelsSchema,
  type ProviderConnectivityTestInput,
} from '../schemas.js';
import {
  getClaudeProviderConfig,
  toPublicClaudeProviderConfig,
  appendClaudeConfigAudit,
  getProviders,
  getProviderById,
  getGlobalProvider,
  createProvider,
  nextProviderModelList,
  providerModels,
  recordProviderTest,
  updateProvider,
  updateProviderSecrets,
  duplicateProvider,
  reservedConnectionEnvError,
  validateProviderCustomEnv,
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
  buildClaudeAiOauthPayload,
  assertSingleClaudeAuthKind,
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
  appendImConfigAudit,
} from '../runtime-config.js';
import type {
  ClaudeOAuthAccountInfo,
  ClaudeOAuthCredentials,
  CachedOAuthUsage,
  ProviderAuthMode,
  UnifiedProvider,
} from '../runtime-config.js';
import {
  buildClaudeAuthorizeUrl,
  buildClaudeCodeExchangeBody,
  ClaudeCredentialInputError,
  CLAUDE_CODE_USER_AGENT,
  CLAUDE_OAUTH_BETA,
  CLAUDE_OAUTH_PROFILE_URL,
  CLAUDE_OAUTH_TOKEN_URL,
  CLAUDE_OAUTH_USAGE_URL,
  claudeOAuthErrorCode,
  claudeOAuthScopesForProfile,
  claudeOAuthStateMatches,
  claudeOAuthTokenHeaders,
  extractClaudeOAuthAccount,
  mergeClaudeOAuthAccount,
  parseClaudeCallbackInput,
  parseClaudeCredentialInput,
  parseClaudeExpiresIn,
  parseClaudeOAuthProfile,
  parseClaudeTokenScopes,
  type ClaudeOAuthLoginProfile,
} from '../claude-oauth.js';
import {
  isClaudeOAuthRefreshDue,
  onClaudeOAuthCredentialsRefreshed,
  refreshClaudeProviderOAuth,
  type ClaudeOAuthRefreshOutcome,
} from '../claude-oauth-refresh.js';
import {
  generateCodexPkcePair,
  buildCodexAuthorizeUrl,
  exchangeCodexCode,
  buildCodexCredentials,
  CodexOAuthTokenError,
  revokeCodexTokenInBackground,
} from '../codex-gateway/oauth.js';
import { forgetCodexTransportState } from '../codex-gateway/transport-state.js';
import {
  codexProviderCreationDefaults,
  extractCodexCallbackParams,
  planCodexReauthorization,
} from '../codex-gateway/provider-authorization.js';
import {
  CODEX_GATEWAY_BASE_URL_PLACEHOLDER,
  CODEX_OAUTH_FLOW_TTL_MS,
} from '../codex-gateway/types.js';
import {
  clearCodexProviderRateLimits,
  getCodexProviderRateLimits,
} from '../codex-gateway/rate-limit-snapshot.js';
import {
  CODEX_DEFAULT_MODEL,
  filterCodexCatalogByPlan,
  resolveCodexDefaultEffort,
} from '../codex-gateway/model-catalog.js';
import {
  codexProviderCatalogFailure,
  ensureCodexProviderCatalog,
  getResolvedCodexCatalog,
  listCodexModelsForProvider,
  maybeRefreshCodexCatalog,
  refreshCodexProviderCatalog,
  type ProviderCodexCatalog,
} from '../codex-gateway/model-catalog-sync.js';
import {
  hasOAuthUsageSignals,
  parseOAuthUsageResponse,
} from '../runtime-config.js';
import type { AuthUser, RegisteredGroup } from '../types.js';
import { logger } from '../logger.js';
import brandAssetRoutes from './brand-assets.js';
import { testFeishuAppCredentials } from '../channel-account-connectivity.js';
import {
  ANTHROPIC_API_ORIGIN,
  checkClaudeAccount,
  CLAUDE_SUBSCRIPTION_MODELS,
  connectionTestResult,
  discoverAnthropicModels,
  discoverEndpointModels,
  redact,
  testAnthropicApiKey,
  testProviderConnectivity,
  testThirdPartyConnection,
  type ConnectionTestResult,
  type ModelDiscoveryResult,
} from '../provider-connectivity.js';
import {
  classifyProviderError,
  CONNECTION_ENV_PREFILL,
  findPresetsByBaseUrl,
  getModelPreset,
  modelsUrlFor,
  normalizeProviderBaseUrl,
  presetModelEntry,
  splitOneMillionSuffix,
  type ModelPreset,
  type ProviderErrorCode,
  type ProviderModelEntry,
} from '../model-providers.js';
import { isCodexGatewayBaseUrl } from '../codex-gateway/resolve-gateway-url.js';
import {
  buildSessionMountUpdate,
  buildDetachedWorkspaceUpdate,
  buildWorkspaceMountUpdate,
  commitChannelMountUpdate,
  hasRemainingThreadMapMount,
  hasSessionMountConflict,
  hasWorkspaceMountConflict,
  isBindableSession,
  isNativeContextContainer,
  SESSION_NOT_BINDABLE,
  unbindChannelMount,
} from '../channel-mount-service.js';
import { checkImChannelLimit, isBillingEnabled } from '../billing.js';
import { providerPool } from '../provider-pool.js';
import { getProviderQuotaObservation } from '../provider-quota-observation.js';
import { updateProviderSessionCredentials } from '../provider-session-credentials.js';
import { getClientIp } from '../utils.js';
import {
  collectWorkspaceRuntimeJids,
  quiesceWorkspaceRunnersAroundCommit,
  resolveEffectiveAgentProfile,
  withAgentProfileLocks,
  WorkspaceRuntimeQuiesceError,
} from '../agent-profile-runtime.js';
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

configRoutes.use('/user-im/*', async (c, next) => {
  recordLegacyUserImRoute(c.req.method, new URL(c.req.url).pathname);
  await next();
});

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
    /**
     * Set when the default model's change is the only reason: sessions on
     * another model of the provider keep running it and are kept.
     */
    previousDefaultModel?: string;
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
      deleteSessionsByProviderIdAroundCommit(
        providerId,
        undefined,
        () => undefined,
      );
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
  const runtimeJids = collectWorkspaceRuntimeJids(
    deps,
    getClaudeRuntimeTargets(),
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
): { includeUnboundFolders: string[]; previousDefaultModel?: string } {
  return {
    includeUnboundFolders: getSafeLegacyUnboundFolders(
      providerId,
      invalidation,
    ),
    ...(invalidation?.previousDefaultModel !== undefined
      ? { previousDefaultModel: invalidation.previousDefaultModel }
      : {}),
  };
}

/** The models a connection offers once an edit is saved. */
function providerModelsAfterEdit(
  previous: UnifiedProvider,
  patch: {
    anthropicBaseUrl?: string;
    anthropicModel?: string;
    models?: ProviderModelEntry[];
  },
): ProviderModelEntry[] {
  const anthropicModel =
    patch.anthropicModel !== undefined
      ? patch.anthropicModel.trim()
      : previous.anthropicModel;
  return providerModels({
    anthropicBaseUrl: patch.anthropicBaseUrl ?? previous.anthropicBaseUrl,
    anthropicModel: splitOneMillionSuffix(anthropicModel).model,
    models: nextProviderModelList(previous, {
      anthropicModel,
      models: patch.models,
    }),
  });
}

/**
 * Whether runners may be using this provider: a stored session ran on it, an
 * Agent binds it (directly or as the main Agent others follow), a
 * conversation picked it, or it is the connection host-side calls and unbound
 * launches fall back to.
 */
function providerMayHaveRunners(provider: UnifiedProvider): boolean {
  return (
    getGlobalProvider()?.id === provider.id ||
    listSessionNamespacesForProviderId(provider.id).length > 0 ||
    countAgentProfilesByModelConfigId(provider.id) > 0 ||
    countSessionModelSelectionsForModelConfig(provider.id) > 0
  );
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
  return collectWorkspaceRuntimeJids(deps, getClaudeRuntimeTargets());
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

const OAUTH_FLOW_TTL = 10 * 60 * 1000; // 10 minutes
const OAUTH_TOKEN_EXCHANGE_TIMEOUT_MS = 30_000;
const OAUTH_PROFILE_TIMEOUT_MS = 5_000;

interface OAuthFlow {
  codeVerifier: string;
  expiresAt: number;
  targetProviderId?: string; // 空 = 创建新供应商
  userId: string; // 发起者绑定：防止同权限的其他管理员消费他人挂起的流程
  profile: ClaudeOAuthLoginProfile;
}
const oauthFlows = new Map<string, OAuthFlow>();

// Periodic cleanup of expired flows
setInterval(() => {
  const now = Date.now();
  for (const [key, flow] of oauthFlows) {
    if (flow.expiresAt < now) oauthFlows.delete(key);
  }
}, 60_000);

interface CodexOAuthFlow {
  codeVerifier: string;
  expiresAt: number;
  targetProviderId?: string; // 空 = 创建新供应商
  userId: string; // 发起者绑定：防止同权限的其他管理员消费他人挂起的流程
}
const codexOauthFlows = new Map<string, CodexOAuthFlow>();

setInterval(() => {
  const now = Date.now();
  for (const [key, flow] of codexOauthFlows) {
    if (flow.expiresAt < now) codexOauthFlows.delete(key);
  }
}, 60_000);

// --- OAuth Usage Cache ---

const USAGE_CACHE_TTL_MS = 3 * 60 * 1000; // 3 minutes
const OAUTH_USAGE_TIMEOUT_MS = 5_000;
const usageCache = new Map<string, CachedOAuthUsage>();
const inFlightUsageRequests = new Map<string, Promise<CachedOAuthUsage>>();
const usageCacheEpochs = new Map<string, number>();
const MAX_USAGE_CACHE_EPOCHS = 256;
let nextUsageCacheEpoch = 1;

function enforceUsageEpochCapacity(): void {
  while (usageCacheEpochs.size > MAX_USAGE_CACHE_EPOCHS) {
    const oldestProviderId = usageCacheEpochs.keys().next().value as
      | string
      | undefined;
    if (oldestProviderId === undefined) break;
    usageCacheEpochs.delete(oldestProviderId);
  }
}

function getProviderUsageEpoch(providerId: string): number {
  const existing = usageCacheEpochs.get(providerId);
  if (existing !== undefined) return existing;
  const epoch = nextUsageCacheEpoch++;
  usageCacheEpochs.set(providerId, epoch);
  enforceUsageEpochCapacity();
  return epoch;
}

function advanceProviderUsageEpoch(providerId: string): number {
  const epoch = nextUsageCacheEpoch++;
  usageCacheEpochs.delete(providerId);
  usageCacheEpochs.set(providerId, epoch);
  enforceUsageEpochCapacity();
  return epoch;
}

function invalidateProviderUsageCache(providerId: string): void {
  usageCache.delete(providerId);
  inFlightUsageRequests.delete(providerId);
  advanceProviderUsageEpoch(providerId);
}

async function fetchOAuthEndpoint(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ response: Response; release: () => void }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearTimeout(timeout);
  };
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    });
    // Keep the abort timer alive until the caller finishes consuming the
    // response body. Receiving headers alone is not a completed request.
    return { response, release };
  } catch (err) {
    release();
    throw err;
  }
}

function usageFailureFallback(
  providerId: string,
  cached: CachedOAuthUsage | undefined,
  error: string,
): CachedOAuthUsage | null {
  const observation = getProviderQuotaObservation(providerId);
  if (cached) return { ...cached, error, observation };
  if (!observation) return null;
  return {
    data: parseOAuthUsageResponse({}),
    fetchedAt: observation.observedAt,
    error,
    observation,
  };
}

// Host-side rotations (usage polls, runner launches) make the cached usage
// body stale and leave this Provider's warm runners holding the previous token
// in memory. Drain only those runners after their current query; a
// settings-page GET must never interrupt active work.
onClaudeOAuthCredentialsRefreshed((providerId) => {
  invalidateProviderUsageCache(providerId);
  try {
    deps?.queue?.drainProviderRunnersForCredentialRefresh?.(providerId);
  } catch (err) {
    logger.warn(
      { err, providerId },
      'Failed to drain runners after OAuth credential refresh',
    );
  }
});

/** The usage endpoint needs user:profile; a grant without it gets 403. */
function isInferenceOnlyGrant(scopes: string[]): boolean {
  return scopes.length > 0 && !scopes.includes('user:profile');
}

function unsupportedUsage(
  providerId: string,
  reason: NonNullable<CachedOAuthUsage['unsupportedReason']>,
  fetchedAt?: number,
): CachedOAuthUsage {
  const observation = getProviderQuotaObservation(providerId);
  return {
    data: parseOAuthUsageResponse({}),
    fetchedAt: fetchedAt ?? observation?.observedAt ?? Date.now(),
    status: 'unsupported',
    unsupportedReason: reason,
    observation,
  };
}

function needsReloginUsage(
  providerId: string,
  cached: CachedOAuthUsage | undefined,
  message: string,
): CachedOAuthUsage {
  const observation = getProviderQuotaObservation(providerId);
  return {
    data: cached?.data ?? parseOAuthUsageResponse({}),
    fetchedAt: cached?.fetchedAt ?? observation?.observedAt ?? Date.now(),
    error: message,
    status: 'needs_relogin',
    observation,
  };
}

function providerReloginMessage(providerId: string): string {
  return (
    getProviders().find((provider) => provider.id === providerId)
      ?.claudeOAuthLastRefreshError?.message ??
    'Claude OAuth credentials were rejected; log in again'
  );
}

async function fetchOAuthUsage(
  providerId: string,
  refreshAttempted = false,
  inheritedFallback?: CachedOAuthUsage,
): Promise<CachedOAuthUsage> {
  const storedCached = usageCache.get(providerId);
  if (
    storedCached &&
    Date.now() - storedCached.fetchedAt < USAGE_CACHE_TTL_MS
  ) {
    return {
      ...storedCached,
      observation: getProviderQuotaObservation(providerId),
    };
  }
  const cached = storedCached ?? inheritedFallback;

  // Deduplicate concurrent requests for the same provider
  const inFlight = inFlightUsageRequests.get(providerId);
  if (inFlight) return inFlight;

  const providers = getProviders();
  const provider = providers.find((p) => p.id === providerId);
  if (!provider) {
    throw new Error('Provider not found');
  }
  const oauthCredentials = buildClaudeAiOauthPayload(
    providerToConfig(provider),
  );
  if (!oauthCredentials) {
    return unsupportedUsage(
      providerId,
      provider.claudeCodeOauthToken ? 'setup_token' : 'no_oauth',
    );
  }
  if (provider.claudeOAuthLastRefreshError) {
    return needsReloginUsage(
      providerId,
      cached,
      provider.claudeOAuthLastRefreshError.message,
    );
  }
  if (isInferenceOnlyGrant(oauthCredentials.scopes)) {
    return unsupportedUsage(providerId, 'inference_only');
  }

  const requestEpoch = getProviderUsageEpoch(providerId);

  let requestPromise!: Promise<CachedOAuthUsage>;
  // Leave the in-flight slot before re-reading credentials, so the retry
  // cannot join this very promise.
  const detachAndRetry = (attempted: boolean): Promise<CachedOAuthUsage> => {
    if (inFlightUsageRequests.get(providerId) === requestPromise) {
      inFlightUsageRequests.delete(providerId);
      advanceProviderUsageEpoch(providerId);
    }
    return fetchOAuthUsage(providerId, attempted, cached);
  };
  // Shared by the proactive and the 401 refresh: retry with whatever the
  // Provider holds now, report a rejected grant, or fail this request.
  const settleRefresh = async (
    outcome: ClaudeOAuthRefreshOutcome,
  ): Promise<CachedOAuthUsage> => {
    switch (outcome.status) {
      case 'refreshed':
      case 'not_due':
        return detachAndRetry(true);
      case 'superseded':
        // Credentials changed outside this request; keep the full snapshot
        // because a token refresh stays within one account.
        return detachAndRetry(false);
      case 'needs_relogin':
        return needsReloginUsage(providerId, cached, outcome.error.message);
      case 'failed':
        if (outcome.terminal) {
          return needsReloginUsage(
            providerId,
            cached,
            providerReloginMessage(providerId),
          );
        }
        throw new Error(outcome.message);
      case 'backoff':
        throw new Error(outcome.message);
      case 'no_credentials':
        return detachAndRetry(false);
    }
  };
  requestPromise = (async () => {
    try {
      if (
        !refreshAttempted &&
        isClaudeOAuthRefreshDue(providerId, oauthCredentials)
      ) {
        const outcome = await refreshClaudeProviderOAuth(providerId);
        // A token inside the renewal window but not yet expired stays usable
        // when the refresh fails transiently.
        const unexpired = oauthCredentials.expiresAt > Date.now();
        const transient =
          outcome.status === 'backoff' ||
          (outcome.status === 'failed' && !outcome.terminal);
        // Awaited so a failure reaches the snapshot fallback below.
        if (!(transient && unexpired)) return await settleRefresh(outcome);
      }

      const endpoint = await fetchOAuthEndpoint(
        CLAUDE_OAUTH_USAGE_URL,
        {
          headers: {
            Authorization: `Bearer ${oauthCredentials.accessToken}`,
            'anthropic-beta': CLAUDE_OAUTH_BETA,
            'Content-Type': 'application/json',
          },
        },
        OAUTH_USAGE_TIMEOUT_MS,
      );
      let raw: Record<string, unknown>;
      try {
        // A credential update/delete invalidates the request that was started
        // with the old token. Join (or start) the current epoch's request so
        // the original caller cannot receive a stale account's usage body.
        if (getProviderUsageEpoch(providerId) !== requestEpoch) {
          return fetchOAuthUsage(providerId);
        }

        if (endpoint.response.status === 401 && !refreshAttempted) {
          endpoint.release();
          return await settleRefresh(
            await refreshClaudeProviderOAuth(providerId, { force: true }),
          );
        }
        if (endpoint.response.status === 403) {
          const body = await endpoint.response.text().catch(() => '');
          // An inference-only grant (setup-token scope) is answered with a
          // scope/permission 403: report it as unsupported, not as a failure.
          if (/scope|permission/i.test(body)) {
            const result = unsupportedUsage(
              providerId,
              'inference_only',
              Date.now(),
            );
            if (getProviderUsageEpoch(providerId) === requestEpoch) {
              usageCache.set(providerId, result);
            }
            return result;
          }
          throw new Error('Usage API returned 403');
        }
        if (!endpoint.response.ok) {
          throw new Error(`Usage API returned ${endpoint.response.status}`);
        }
        raw = (await endpoint.response.json()) as Record<string, unknown>;
      } finally {
        endpoint.release();
      }
      if (getProviderUsageEpoch(providerId) !== requestEpoch) {
        return fetchOAuthUsage(providerId);
      }
      if (!hasOAuthUsageSignals(raw)) {
        throw new Error('Usage API returned no recognized quota data');
      }
      const data = parseOAuthUsageResponse(raw);

      const result: CachedOAuthUsage = {
        data,
        fetchedAt: Date.now(),
        observation: getProviderQuotaObservation(providerId),
      };
      if (getProviderUsageEpoch(providerId) === requestEpoch) {
        usageCache.set(providerId, result);
      }
      return result;
    } catch (err) {
      if (getProviderUsageEpoch(providerId) !== requestEpoch) {
        return fetchOAuthUsage(providerId);
      }
      const message = err instanceof Error ? err.message : 'Usage API failed';
      const fallback = usageFailureFallback(providerId, cached, message);
      if (fallback) {
        if (cached) usageCache.set(providerId, fallback);
        return fallback;
      }
      throw err;
    } finally {
      if (inFlightUsageRequests.get(providerId) === requestPromise) {
        inFlightUsageRequests.delete(providerId);
      }
    }
  })();

  inFlightUsageRequests.set(providerId, requestPromise);
  return requestPromise;
}

// --- Claude credential writes ---

type ProviderSecretsUpdate = Parameters<typeof updateProviderSecrets>[1];

/**
 * Map a raw `claudeCredentialInput` paste (`.credentials.json` or a
 * setup-token) onto the structured credential fields. Combining it with
 * another credential field would make the selected auth kind ambiguous.
 */
function claudeCredentialInputFields(
  input: string | undefined,
  type: UnifiedProvider['type'],
  others: {
    claudeOAuthCredentials?: unknown;
    claudeCodeOauthToken?: string;
    anthropicApiKey?: string;
    anthropicAuthToken?: string;
  },
): Pick<
  ProviderSecretsUpdate,
  'claudeOAuthCredentials' | 'claudeCodeOauthToken'
> {
  if (input === undefined) return {};
  if (type !== 'official') {
    throw new ClaudeCredentialInputError(
      'claudeCredentialInput 仅适用于官方供应商',
    );
  }
  if (
    others.claudeOAuthCredentials ||
    others.claudeCodeOauthToken?.trim() ||
    others.anthropicApiKey?.trim() ||
    others.anthropicAuthToken?.trim()
  ) {
    throw new ClaudeCredentialInputError(
      'claudeCredentialInput 不能与其他凭据字段同时提交',
    );
  }
  const parsed = parseClaudeCredentialInput(input);
  return parsed.kind === 'oauth'
    ? { claudeOAuthCredentials: parsed.credentials }
    : { claudeCodeOauthToken: parsed.token };
}

/**
 * Persist one provider's credential change. Callers hold the config mutation
 * lock.
 *
 * A change that may switch Claude accounts drops the sessions bound to the
 * provider, because thinking-block signatures do not survive an account
 * switch; for an enabled provider that runs inside the workspace quiesce,
 * which is what keeps a finishing runner from re-binding a dropped session. A
 * re-login of the same account keeps its sessions and quiesces nothing. In
 * every case only this provider's runners are retired, after their current
 * query.
 */
async function commitProviderCredentialUpdate(
  actor: string,
  previous: UnifiedProvider,
  secrets: ProviderSecretsUpdate,
  audit: { action: string; changedFields: string[]; trigger: string },
): Promise<ClaudeMutationResult<UnifiedProvider>> {
  const id = previous.id;
  const previousAccount = previous.claudeOAuthAccount?.accountUuid;
  const sameAccount =
    !!previousAccount &&
    previousAccount === secrets.claudeOAuthAccount?.accountUuid;
  const commit = () => {
    const updated = updateProviderSecrets(id, secrets);
    invalidateProviderUsageCache(id);
    appendClaudeConfigAuditBestEffort(actor, audit.action, audit.changedFields);
    return runAfterProviderPersistence(updated, () => {
      if (updated.claudeOAuthCredentials) {
        updateProviderSessionCredentials(id, providerToConfig(updated));
      }
      try {
        deps?.queue?.drainProviderRunnersForCredentialRefresh?.(id);
      } catch (err) {
        logger.warn(
          { err, providerId: id },
          'Failed to drain runners after provider credential update',
        );
      }
    });
  };
  if (providerMayHaveRunners(previous) && !sameAccount) {
    return mutateClaudeConfigForAllGroups(
      actor,
      { trigger: audit.trigger, providerId: id },
      commit,
      {
        clearSessionsForProviderId: id,
        sessionInvalidation: { modelChanged: true, baseUrlChanged: true },
      },
    );
  }
  return {
    value: commit(),
    applied: {
      success: true,
      stoppedCount: 0,
      failedCount: 0,
      persisted: true,
    },
  };
}

type ClaudeCodeExchange =
  | { ok: true; data: Record<string, unknown> }
  /** status is null for a network failure, timeout or unreadable body. */
  | { ok: false; status: number | null; body: string };

async function exchangeClaudeAuthorizationCode(
  options: Parameters<typeof buildClaudeCodeExchangeBody>[0],
): Promise<ClaudeCodeExchange> {
  try {
    const endpoint = await fetchOAuthEndpoint(
      CLAUDE_OAUTH_TOKEN_URL,
      {
        method: 'POST',
        headers: claudeOAuthTokenHeaders(),
        body: JSON.stringify(buildClaudeCodeExchangeBody(options)),
      },
      OAUTH_TOKEN_EXCHANGE_TIMEOUT_MS,
    );
    try {
      const body = await endpoint.response.text();
      if (!endpoint.response.ok) {
        return { ok: false, status: endpoint.response.status, body };
      }
      const data: unknown = JSON.parse(body);
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { ok: false, status: null, body: 'non-object token response' };
      }
      return { ok: true, data: data as Record<string, unknown> };
    } finally {
      endpoint.release();
    }
  } catch (err) {
    return {
      ok: false,
      status: null,
      body: err instanceof Error ? err.message : 'network error',
    };
  }
}

/** Best effort: login still succeeds when the profile cannot be read. */
async function fetchClaudeOAuthProfile(
  accessToken: string,
): Promise<ClaudeOAuthAccountInfo | null> {
  try {
    const endpoint = await fetchOAuthEndpoint(
      CLAUDE_OAUTH_PROFILE_URL,
      {
        headers: {
          'User-Agent': CLAUDE_CODE_USER_AGENT,
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
        },
      },
      OAUTH_PROFILE_TIMEOUT_MS,
    );
    try {
      if (!endpoint.response.ok) return null;
      const raw: unknown = await endpoint.response.json();
      return raw && typeof raw === 'object' && !Array.isArray(raw)
        ? parseClaudeOAuthProfile(raw as Record<string, unknown>)
        : null;
    } finally {
      endpoint.release();
    }
  } catch {
    return null;
  }
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

// ─── GET /claude/providers — 列出所有模型连接 ─────
configRoutes.get(
  '/claude/providers',
  authMiddleware,
  systemConfigMiddleware,
  (c) => {
    try {
      return c.json({ providers: getProviders().map(toPublicProvider) });
    } catch (err) {
      logger.error({ err }, 'Failed to list providers');
      return c.json({ error: 'Failed to list providers' }, 500);
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

    const reserved = reservedConnectionEnvError(validation.data.customEnv);
    if (reserved) return c.json(reserved, 400);
    const envError = validateProviderCustomEnv(validation.data.customEnv ?? {});
    if (envError) return c.json({ error: envError }, 400);
    // A connection without a credential could neither be tested nor run.
    const draft = validation.data;
    const hasCredential = !!(
      draft.anthropicAuthToken?.trim() ||
      draft.anthropicApiKey?.trim() ||
      (draft.type === 'official' &&
        (draft.claudeCodeOauthToken?.trim() ||
          draft.claudeOAuthCredentials ||
          draft.claudeCredentialInput?.trim()))
    );
    if (!hasCredential) {
      return c.json({ error: '新建模型配置需要凭据' }, 400);
    }

    const actor = (c.get('user') as AuthUser).username;
    const {
      claudeCredentialInput,
      enabled: _enabled,
      weight: _weight,
      ...createInput
    } = validation.data;
    let pasted: ReturnType<typeof claudeCredentialInputFields>;
    try {
      pasted = claudeCredentialInputFields(
        claudeCredentialInput,
        createInput.type,
        createInput,
      );
    } catch (err) {
      if (err instanceof ClaudeCredentialInputError) {
        return c.json({ error: err.message }, 400);
      }
      throw err;
    }

    try {
      const provider = createProvider({
        ...createInput,
        ...pasted,
        // A preset connection may leave its address to the preset.
        anthropicBaseUrl:
          createInput.anthropicBaseUrl?.trim() ||
          (createInput.type === 'third_party'
            ? getModelPreset(createInput.presetId)?.baseUrl
            : undefined),
      });
      appendClaudeConfigAudit(actor, 'create_provider', [
        `id:${provider.id}`,
        `type:${provider.type}`,
        `name:${provider.name}`,
      ]);
      bindSystemMainIfUnbound(provider.id);
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
    if (validation.data.customEnv) {
      const reserved = reservedConnectionEnvError(validation.data.customEnv);
      if (reserved) return c.json(reserved, 400);
      const envError = validateProviderCustomEnv(validation.data.customEnv);
      if (envError) return c.json({ error: envError }, 400);
    }

    const actor = (c.get('user') as AuthUser).username;
    const {
      anthropicAuthToken,
      clearAnthropicAuthToken,
      weight: _weight,
      ...providerPatch
    } = validation.data;
    const tokenChange =
      anthropicAuthToken !== undefined
        ? { anthropicAuthToken }
        : clearAnthropicAuthToken
          ? { clearAnthropicAuthToken: true }
          : null;

    try {
      return await withClaudeConfigMutationLock(async () => {
        const previous = getProviders().find((p) => p.id === id);
        if (!previous) throw new Error('未找到指定供应商');
        if (tokenChange && previous.type !== 'third_party') {
          throw new Error('只有第三方模型配置可以在这里修改 API 密钥');
        }
        if (tokenChange && previous.codexOAuthCredentials) {
          throw new Error('ChatGPT 订阅配置的网关凭据由系统管理');
        }
        const changedFields = Object.keys(validation.data).map(
          (k) => `${k}:updated`,
        );
        const baseUrlChanged = !!(
          validation.data.anthropicBaseUrl !== undefined &&
          validation.data.anthropicBaseUrl !== previous.anthropicBaseUrl
        );
        // `[1m]` from an older client only sets the model's window, which
        // is not a model change.
        const modelChanged = !!(
          validation.data.anthropicModel !== undefined &&
          splitOneMillionSuffix(validation.data.anthropicModel).model !==
            previous.anthropicModel
        );
        const customEnvChanged = !!(
          validation.data.customEnv !== undefined &&
          JSON.stringify(validation.data.customEnv) !==
            JSON.stringify(previous.customEnv)
        );
        // A different key can mean a different upstream account, whose
        // thinking signatures the old session would replay; the auth header
        // style changes the protocol the endpoint sees.
        const tokenChanged = !!(
          tokenChange &&
          (anthropicAuthToken !== undefined
            ? anthropicAuthToken.trim() !== previous.anthropicAuthToken
            : !!previous.anthropicAuthToken)
        );
        // Null clears the style: a change only when there was one.
        const authModeChanged =
          providerPatch.anthropicAuthMode !== undefined &&
          (providerPatch.anthropicAuthMode ?? undefined) !==
            previous.anthropicAuthMode;
        const protocolFieldChanged =
          baseUrlChanged ||
          modelChanged ||
          customEnvChanged ||
          tokenChanged ||
          authModeChanged;
        const nextModels = providerModelsAfterEdit(previous, providerPatch);
        const removedModels = providerModels(previous)
          .map((entry) => entry.id)
          .filter((model) => !nextModels.some((entry) => entry.id === model));
        const agentsUsingRemoved = listAgentProfilesUsingModels(
          id,
          removedModels,
        );
        if (agentsUsingRemoved.length > 0) {
          return c.json(
            {
              error: `${agentsUsingRemoved.map((agent) => agent.name).join('、')} 正在使用要移除的模型，请先为这些智能体改选模型`,
              code: 'MODEL_IN_USE',
              agents: agentsUsingRemoved,
            },
            409,
          );
        }
        const pendingInvalidation = getPendingProviderSessionInvalidation(id);
        const sessionsInvalidated =
          baseUrlChanged ||
          modelChanged ||
          customEnvChanged ||
          tokenChanged ||
          authModeChanged;
        const onlyDefaultModelChanged =
          modelChanged &&
          !baseUrlChanged &&
          !customEnvChanged &&
          !tokenChanged &&
          !authModeChanged &&
          !pendingInvalidation;
        const sessionInvalidation = {
          modelChanged:
            modelChanged || pendingInvalidation?.modelChanged === true,
          baseUrlChanged:
            baseUrlChanged ||
            tokenChanged ||
            pendingInvalidation?.baseUrlChanged === true,
          ...(onlyDefaultModelChanged
            ? { previousDefaultModel: previous.anthropicModel }
            : {}),
        };
        const shouldClearSessions =
          !!pendingInvalidation || sessionsInvalidated;
        const metadata = {
          trigger: 'provider_update',
          providerId: id,
          protocolFieldChanged,
          baseUrlChanged,
          modelChanged,
          customEnvChanged,
          tokenChanged,
          authModeChanged,
        };
        const commit = () => {
          let updated = updateProvider(id, providerPatch);
          if (tokenChange) {
            updated = updateProviderSecrets(id, tokenChange);
            invalidateProviderUsageCache(id);
          }
          appendClaudeConfigAuditBestEffort(actor, 'update_provider', [
            `id:${id}`,
            ...changedFields,
            ...(protocolFieldChanged ? ['protocolFieldChanged'] : []),
          ]);
          return updated;
        };

        // Only what a running runner was launched with stops it: the endpoint,
        // the key and its header style, the env, the connection's model, or a
        // model a session may be running. A name, a model's window or
        // efforts, the roles, an added model or the preset reach the next
        // launch by themselves.
        const runnerEnvironmentChanged =
          protocolFieldChanged || removedModels.length > 0;

        let mutation: ClaudeMutationResult<ReturnType<typeof updateProvider>>;
        if (
          providerMayHaveRunners(previous) &&
          (runnerEnvironmentChanged || !!pendingInvalidation)
        ) {
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
          // The WebFetch policy is fixed at launch too, but needs no stop:
          // this connection's runners exit after their current query.
          if (
            updated.webFetchPreflightPolicy !== previous.webFetchPreflightPolicy
          ) {
            deps?.queue?.drainProviderRunnersForCredentialRefresh?.(id);
          }
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
        const { claudeCredentialInput, ...structured } = validation.data;
        let secrets: ProviderSecretsUpdate;
        try {
          secrets = {
            ...structured,
            ...claudeCredentialInputFields(
              claudeCredentialInput,
              previous.type,
              structured,
            ),
          };
        } catch (err) {
          if (err instanceof ClaudeCredentialInputError) {
            return c.json({ error: err.message }, 400);
          }
          throw err;
        }
        // Reject an ambiguous write before any runtime is quiesced.
        assertSingleClaudeAuthKind(previous.type, secrets);
        const changedFields: string[] = [];
        if (secrets.anthropicAuthToken !== undefined)
          changedFields.push('anthropicAuthToken:set');
        if (secrets.clearAnthropicAuthToken)
          changedFields.push('anthropicAuthToken:clear');
        if (secrets.anthropicApiKey !== undefined)
          changedFields.push('anthropicApiKey:set');
        if (secrets.clearAnthropicApiKey)
          changedFields.push('anthropicApiKey:clear');
        if (secrets.claudeCodeOauthToken !== undefined)
          changedFields.push('claudeCodeOauthToken:set');
        if (secrets.clearClaudeCodeOauthToken)
          changedFields.push('claudeCodeOauthToken:clear');
        if (secrets.claudeOAuthCredentials)
          changedFields.push('claudeOAuthCredentials:set');
        if (secrets.clearClaudeOAuthCredentials)
          changedFields.push('claudeOAuthCredentials:clear');
        if (claudeCredentialInput !== undefined)
          changedFields.push('claudeCredentialInput:parsed');

        const mutation = await commitProviderCredentialUpdate(
          actor,
          previous,
          secrets,
          {
            action: 'update_provider_secrets',
            changedFields: [`id:${id}`, ...changedFields],
            trigger: 'provider_secrets_update',
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
              clearSessionModelSelectionsForModelConfig(id);
              invalidateProviderUsageCache(id);
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
        if (
          previous?.codexOAuthCredentials &&
          !getProviders().some((provider) => provider.id === id)
        ) {
          // Like the official logout, end the ChatGPT grant HappyClaw no
          // longer holds; deletion never waits for or fails on this.
          forgetCodexTransportState(id);
          clearCodexProviderRateLimits(id);
          revokeCodexTokenInBackground(previous.codexOAuthCredentials, {
            providerId: id,
            reason: 'provider_deleted',
          });
        }
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

// ─── POST /claude/providers/:id/duplicate — 复制供应商（含密钥，默认停用）─────
configRoutes.post(
  '/claude/providers/:id/duplicate',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const { id } = c.req.param();
    const actor = (c.get('user') as AuthUser).username;
    try {
      return await withClaudeConfigMutationLock(async () => {
        const provider = duplicateProvider(id);
        appendClaudeConfigAuditBestEffort(actor, 'duplicate_provider', [
          `source:${id}`,
          `id:${provider.id}`,
        ]);
        return c.json(toPublicProvider(provider), 201);
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Failed to duplicate provider';
      logger.warn({ err }, 'Failed to duplicate provider');
      return c.json({ error: message }, 400);
    }
  },
);

// ─── 模型连接的测试与模型列表 ─────
const CONNECTIVITY_TEST_WINDOW_MS = 60_000;
const CONNECTIVITY_TEST_LIMIT = 10;
const connectivityTestHits = new Map<string, number[]>();

/** Spend one of an admin's upstream checks (tests and model lists) per minute. */
function takeConnectivityCheck(userId: string): boolean {
  const now = Date.now();
  const recent = (connectivityTestHits.get(userId) ?? []).filter(
    (at) => now - at < CONNECTIVITY_TEST_WINDOW_MS,
  );
  if (recent.length >= CONNECTIVITY_TEST_LIMIT) return false;
  recent.push(now);
  connectivityTestHits.set(userId, recent);
  return true;
}

/** The upstream a test or a model list reaches, and what it sends there. */
type CheckedConnection =
  | { kind: 'chatgpt'; stored: UnifiedProvider }
  | {
      kind: 'third_party';
      baseUrl: string;
      token: string;
      /** The style tried first: the explicit one, else the runtime's. */
      authMode: ProviderAuthMode;
      explicitAuthMode: boolean;
      preset: ModelPreset | null;
      model: string;
      /** The background (haiku-tier) model, probed besides `model`. */
      smallFastModel: string;
      customEnv: Record<string, string>;
    }
  | {
      kind: 'api_key';
      credential: string;
      authMode: ProviderAuthMode;
      model: string;
    }
  | {
      kind: 'account';
      /** Set for a saved grant, which may be renewed before the check. */
      providerId: string | null;
      oauth: ClaudeOAuthCredentials | null;
      token: string;
    };

/**
 * Read the connection a request describes: a draft, or a saved connection
 * whose blank fields fall back to what is stored.
 */
function resolveCheckedConnection(
  draft: ProviderConnectivityTestInput,
):
  | { connection: CheckedConnection; stored: UnifiedProvider | undefined }
  | { error: string; status: 400 | 404 } {
  const stored = draft.providerId
    ? (getProviderById(draft.providerId) ?? undefined)
    : undefined;
  if (draft.providerId && !stored) {
    return { error: '未找到指定供应商', status: 404 };
  }
  if (stored?.codexOAuthCredentials) {
    return { connection: { kind: 'chatgpt', stored }, stored };
  }
  const type = stored?.type ?? draft.type ?? 'third_party';
  const model = draft.anthropicModel ?? stored?.anthropicModel;

  if (type === 'third_party') {
    const named = getModelPreset(draft.presetId ?? stored?.presetId);
    const baseUrl =
      draft.anthropicBaseUrl?.trim() ||
      stored?.anthropicBaseUrl ||
      named?.baseUrl ||
      '';
    // A preset only speaks for its own endpoint.
    const preset =
      named &&
      normalizeProviderBaseUrl(baseUrl) ===
        normalizeProviderBaseUrl(named.baseUrl)
        ? named
        : null;
    const draftToken = draft.anthropicAuthToken?.trim();
    const token =
      draftToken || stored?.anthropicAuthToken || stored?.anthropicApiKey || '';
    if (!baseUrl) return { error: '请填写 API 端点', status: 400 };
    if (isCodexGatewayBaseUrl(baseUrl)) {
      return { error: 'ChatGPT 订阅请先完成登录', status: 400 };
    }
    if (!token) return { error: '请填写 API 密钥', status: 400 };
    // A key the runtime sends as ANTHROPIC_API_KEY has no other style.
    const apiKeyOnly =
      !draftToken && !stored?.anthropicAuthToken && !!stored?.anthropicApiKey;
    const explicit =
      draft.anthropicAuthMode ??
      (apiKeyOnly ? 'x-api-key' : stored?.anthropicAuthMode);
    return {
      stored,
      connection: {
        kind: 'third_party',
        baseUrl,
        token,
        // A saved connection without a style is probed with the header its
        // runtime infers (bare token → x-api-key, `Bearer …` → Authorization);
        // a new one with Bearer, which every preset takes.
        authMode:
          explicit ??
          (stored && !/^Bearer\s/i.test(token) ? 'x-api-key' : 'bearer'),
        explicitAuthMode: !!explicit,
        preset,
        model:
          model ??
          (preset?.models[0] ? presetModelEntry(preset.models[0]).id : ''),
        smallFastModel:
          ('roles' in draft ? draft.roles?.smallFast : undefined) ??
          stored?.roles?.smallFast ??
          '',
        customEnv: draft.customEnv ?? stored?.customEnv ?? {},
      },
    };
  }

  let pasted: ReturnType<typeof claudeCredentialInputFields>;
  try {
    pasted = claudeCredentialInputFields(
      draft.claudeCredentialInput,
      'official',
      draft,
    );
  } catch (err) {
    if (err instanceof ClaudeCredentialInputError) {
      return { error: err.message, status: 400 };
    }
    throw err;
  }
  // A credential in the request replaces the saved one as a whole.
  const draftCredential: Partial<
    Pick<
      UnifiedProvider,
      | 'anthropicApiKey'
      | 'anthropicAuthToken'
      | 'claudeOAuthCredentials'
      | 'claudeCodeOauthToken'
    >
  > = {
    anthropicApiKey: draft.anthropicApiKey?.trim(),
    anthropicAuthToken: draft.anthropicAuthToken?.trim(),
    ...pasted,
  };
  const fromDraft = Object.values(draftCredential).some(Boolean);
  const credential = fromDraft ? draftCredential : (stored ?? draftCredential);
  const { claudeOAuthCredentials: oauth, claudeCodeOauthToken: setupToken } =
    credential;
  const apiKey = credential.anthropicApiKey || credential.anthropicAuthToken;
  let connection: CheckedConnection | null = null;
  if (oauth || setupToken) {
    connection = {
      kind: 'account',
      providerId: fromDraft || !oauth ? null : stored!.id,
      oauth: oauth ?? null,
      token: oauth?.accessToken ?? setupToken!,
    };
  } else if (apiKey) {
    connection = {
      kind: 'api_key',
      credential: apiKey,
      // Claude Code sends ANTHROPIC_API_KEY as x-api-key and an auth token
      // as Authorization, unless the connection chose otherwise.
      authMode: credential.anthropicApiKey
        ? 'x-api-key'
        : (draft.anthropicAuthMode ?? stored?.anthropicAuthMode ?? 'bearer'),
      model: model ?? '',
    };
  }
  return connection
    ? { connection, stored }
    : { error: '请填写凭据', status: 400 };
}

/** Whether a request tests something other than the saved connection. */
function draftChangesConnection(
  draft: ProviderConnectivityTestInput,
  stored: UnifiedProvider,
): boolean {
  const differs = (value: string | undefined, current: string) =>
    !!value?.trim() && value.trim() !== current;
  return (
    differs(draft.anthropicBaseUrl, stored.anthropicBaseUrl) ||
    differs(draft.anthropicAuthToken, stored.anthropicAuthToken) ||
    differs(draft.anthropicApiKey, stored.anthropicApiKey) ||
    draft.claudeCredentialInput !== undefined ||
    (draft.anthropicAuthMode !== undefined &&
      draft.anthropicAuthMode !== stored.anthropicAuthMode) ||
    (draft.customEnv !== undefined &&
      JSON.stringify(draft.customEnv) !== JSON.stringify(stored.customEnv)) ||
    (draft.roles?.smallFast !== undefined &&
      draft.roles.smallFast !== (stored.roles?.smallFast ?? ''))
  );
}

/** Where a check goes, for logs: never a path, a query or a key. */
function connectionOrigin(connection: CheckedConnection): string {
  switch (connection.kind) {
    case 'third_party':
      try {
        return new URL(connection.baseUrl).origin;
      } catch {
        return 'invalid';
      }
    case 'api_key':
    case 'account':
      return ANTHROPIC_API_ORIGIN;
    case 'chatgpt':
      return 'chatgpt';
  }
}

/** A failed check that never reached the upstream. */
function unreachedTest(
  code: ProviderErrorCode,
  message: string,
): ConnectionTestResult {
  return connectionTestResult(
    {
      ok: false,
      probes: [
        { model: '', ok: false, status: null, latencyMs: 0, message, code },
      ],
    },
    { model: null },
  );
}

/**
 * Claude subscription: a saved grant due for renewal is renewed first, as a
 * runner launch would; a pasted one is never renewed here, because renewing
 * rotates the refresh token the admin is about to save.
 */
async function checkSubscriptionAccount(
  connection: Extract<CheckedConnection, { kind: 'account' }>,
): Promise<ConnectionTestResult> {
  let token = connection.token;
  if (connection.oauth && connection.providerId) {
    const current = getProviderById(connection.providerId);
    if (current?.claudeOAuthLastRefreshError) {
      return unreachedTest(
        'AUTH_INVALID',
        current.claudeOAuthLastRefreshError.message,
      );
    }
    if (isClaudeOAuthRefreshDue(connection.providerId, connection.oauth)) {
      const outcome = await refreshClaudeProviderOAuth(connection.providerId);
      if (
        outcome.status === 'needs_relogin' ||
        (outcome.status === 'failed' && outcome.terminal)
      ) {
        return unreachedTest('AUTH_INVALID', 'Claude 登录已失效，请重新登录');
      }
      const renewed = getProviderById(
        connection.providerId,
      )?.claudeOAuthCredentials;
      // A renewal that failed for now (network, 5xx, backoff) says nothing
      // about the login; an expired token would only be refused for age.
      if (!renewed || renewed.expiresAt <= Date.now()) {
        return unreachedTest('UPSTREAM_ERROR', '续期失败，稍后再试');
      }
      token = renewed.accessToken;
    }
  } else if (connection.oauth && connection.oauth.expiresAt <= Date.now()) {
    return unreachedTest(
      'UNKNOWN',
      '访问令牌已过期，保存后会自动续期；现在无法验证',
    );
  }
  return checkClaudeAccount(token);
}

/** ChatGPT subscription: fetch the account's live model catalog. */
async function checkChatGptAccount(
  provider: UnifiedProvider,
): Promise<ConnectionTestResult> {
  const startedAt = Date.now();
  const ok = await refreshCodexProviderCatalog(provider.id);
  const latencyMs = Date.now() - startedAt;
  if (ok) {
    return connectionTestResult(
      { ok: true, probes: [{ model: '', ok: true, status: 200, latencyMs }] },
      { model: null },
    );
  }
  const failure = codexProviderCatalogFailure(provider.id);
  const reauth =
    getProviderById(provider.id)?.codexOAuthLastRefreshError?.kind ===
    'reauth_required';
  return connectionTestResult(
    {
      ok: false,
      probes: [
        {
          model: '',
          ok: false,
          status: failure?.status ?? null,
          latencyMs,
          message: redact(failure?.message ?? 'ChatGPT 模型目录获取失败', []),
          code: reauth
            ? 'AUTH_INVALID'
            : failure?.status
              ? classifyProviderError({ status: failure.status }).code
              : 'UNKNOWN',
        },
      ],
    },
    { model: null },
  );
}

function testConnection(
  connection: CheckedConnection,
): Promise<ConnectionTestResult> {
  switch (connection.kind) {
    case 'third_party':
      return testThirdPartyConnection(
        {
          baseUrl: connection.baseUrl,
          token: connection.token,
          authMode: connection.authMode,
          explicitAuthMode: connection.explicitAuthMode,
          model: connection.model,
          haikuModel: connection.smallFastModel,
          customHeaders: connection.customEnv.ANTHROPIC_CUSTOM_HEADERS,
        },
        testProviderConnectivity,
      );
    case 'api_key':
      return testAnthropicApiKey(connection);
    case 'account':
      return checkSubscriptionAccount(connection);
    case 'chatgpt':
      return checkChatGptAccount(connection.stored);
  }
}

async function discoverModels(
  connection: CheckedConnection,
): Promise<ModelDiscoveryResult> {
  switch (connection.kind) {
    case 'third_party': {
      // A custom address that is exactly one vendor's lists models where
      // that vendor does.
      const matches = findPresetsByBaseUrl(connection.baseUrl);
      const url = modelsUrlFor(
        connection.baseUrl,
        connection.preset ?? (matches.length === 1 ? matches[0] : null),
      );
      if (!url) {
        return {
          ok: false,
          code: 'ENDPOINT_NOT_FOUND',
          status: null,
          message: '地址无效',
        };
      }
      return discoverEndpointModels({
        url,
        credential: connection.token,
        authMode: connection.authMode,
        explicitAuthMode: connection.explicitAuthMode,
        customHeaders: connection.customEnv.ANTHROPIC_CUSTOM_HEADERS,
      });
    }
    case 'api_key':
      return discoverAnthropicModels(connection);
    case 'account':
      return {
        ok: true,
        models: [...CLAUDE_SUBSCRIPTION_MODELS],
        source: 'builtin',
      };
    case 'chatgpt': {
      await ensureCodexProviderCatalog(connection.stored.id);
      return {
        ok: true,
        source: 'catalog',
        models: listCodexModelsForProvider(connection.stored).models.map(
          (entry) => ({
            id: entry.value,
            ...(entry.label && entry.label !== entry.value
              ? { name: entry.label }
              : {}),
          }),
        ),
      };
    }
  }
}

// ─── POST /claude/providers/discover-models — 获取模型连接的模型列表 ─────
configRoutes.post(
  '/claude/providers/discover-models',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const user = c.get('user') as AuthUser;
    if (!takeConnectivityCheck(user.id)) {
      return c.json({ error: '测试过于频繁，请稍后再试' }, 429);
    }
    const body = await c.req.json().catch(() => ({}));
    const validation = ProviderDiscoverModelsSchema.safeParse(body);
    if (!validation.success) {
      return c.json({ error: 'Invalid request body' }, 400);
    }
    // A saved connection lists models with its own env.
    const { customEnv, ...draft } = validation.data;
    const resolved = resolveCheckedConnection(
      draft.providerId ? draft : { ...draft, customEnv },
    );
    if ('error' in resolved) {
      return c.json({ error: resolved.error }, resolved.status);
    }
    const result = await discoverModels(resolved.connection);
    logger.info(
      {
        providerId: validation.data.providerId ?? null,
        kind: resolved.connection.kind,
        origin: connectionOrigin(resolved.connection),
        ok: result.ok,
        ...(result.ok
          ? { count: result.models.length }
          : { code: result.code, status: result.status }),
      },
      'Provider model discovery finished',
    );
    return c.json(result);
  },
);

// ─── POST /claude/providers/test — 测试模型连接 ─────
// 带 providerId 且测的就是已保存的连接时，结果存为该连接的 lastTest；
// 没有认证方式的连接同时记下端点接受的那一种。不停 Runner，不清会话。
configRoutes.post(
  '/claude/providers/test',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const user = c.get('user') as AuthUser;
    if (!takeConnectivityCheck(user.id)) {
      return c.json({ error: '测试过于频繁，请稍后再试' }, 429);
    }
    const body = await c.req.json().catch(() => ({}));
    const validation = ProviderConnectivityTestSchema.safeParse(body);
    if (!validation.success) {
      return c.json({ error: 'Invalid request body' }, 400);
    }
    const draft = validation.data;
    const resolved = resolveCheckedConnection(draft);
    if ('error' in resolved) {
      return c.json({ error: resolved.error }, resolved.status);
    }
    const { connection, stored } = resolved;
    const result = await testConnection(connection);

    if (stored && !draftChangesConnection(draft, stored)) {
      const foundAuthMode =
        connection.kind === 'third_party' && !connection.explicitAuthMode
          ? result.authMode
          : undefined;
      const recorded = recordProviderTest(
        stored.id,
        stored,
        result.record,
        foundAuthMode,
      );
      if (recorded) {
        appendClaudeConfigAuditBestEffort(user.username, 'test_provider', [
          `id:${stored.id}`,
          `ok:${result.ok}`,
          ...(result.code ? [`code:${result.code}`] : []),
          ...(foundAuthMode ? [`anthropicAuthMode:${foundAuthMode}`] : []),
        ]);
        // A saved connection whose inferred header was refused now sends the
        // one that worked; runners still sending the old one retire after
        // their current query.
        if (
          connection.kind === 'third_party' &&
          foundAuthMode &&
          foundAuthMode !== connection.authMode
        ) {
          getWebDeps()?.queue.drainProviderRunnersForCredentialRefresh(
            stored.id,
          );
        }
      }
    }
    logger.info(
      {
        providerId: draft.providerId ?? null,
        kind: connection.kind,
        origin: connectionOrigin(connection),
        ok: result.ok,
        code: result.code,
        statuses: result.probes.map((probe) => probe.status),
      },
      'Provider connectivity test finished',
    );
    return c.json(result);
  },
);

// ─── GET /claude/providers/:id/impact — 修改协议字段会停掉多少 Runner ─────
// activeRunners：正在使用这个连接的 Runner；stoppedRunners：修改端点、密钥、
// 连接模型等协议字段时实际会停掉的 Runner（当前实现会停掉全部工作区的 Runner，
// 连接既没被绑定或选用、也不是全局兜底连接时则一个都不停）。
configRoutes.get(
  '/claude/providers/:id/impact',
  authMiddleware,
  systemConfigMiddleware,
  (c) => {
    const { id } = c.req.param();
    const provider = getProviderById(id);
    if (!provider) return c.json({ error: '未找到指定供应商' }, 404);
    const status = getWebDeps()?.queue.getStatus();
    const live = status?.groups.filter((group) => group.active) ?? [];
    return c.json({
      activeRunners: live.filter((group) => group.selectedProviderId === id)
        .length,
      stoppedRunners: providerMayHaveRunners(provider) ? live.length : 0,
    });
  },
);

// ─── GET /claude/providers/:id/usage — OAuth 用量数据 ─────
// ChatGPT 订阅 provider 没有用量接口：返回网关从上游 x-codex-* 响应头记下的
// 最近一次用量窗口快照（kind: 'codex_rate_limits'，见 rate-limit-snapshot.ts）。
configRoutes.get(
  '/claude/providers/:id/usage',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const { id } = c.req.param();
    if (
      getProviders().some(
        (provider) =>
          provider.id === id &&
          provider.anthropicBaseUrl === CODEX_GATEWAY_BASE_URL_PLACEHOLDER,
      )
    ) {
      return c.json(getCodexProviderRateLimits(id));
    }
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
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    const targetProviderId =
      typeof body.targetProviderId === 'string' && body.targetProviderId
        ? body.targetProviderId
        : undefined;
    if (targetProviderId) {
      const target = getProviders().find(
        (provider) => provider.id === targetProviderId,
      );
      if (!target) return c.json({ error: 'Provider not found' }, 404);
      if (target.type !== 'official') {
        return c.json(
          { error: 'Claude OAuth login requires an official provider' },
          400,
        );
      }
    }
    if (
      body.profile !== undefined &&
      body.profile !== 'full' &&
      body.profile !== 'setup_token'
    ) {
      return c.json({ error: 'profile must be full or setup_token' }, 400);
    }
    const profile: ClaudeOAuthLoginProfile =
      body.profile === 'setup_token' ? 'setup_token' : 'full';

    const state = randomBytes(32).toString('hex');
    const codeVerifier = randomBytes(32).toString('base64url');
    const codeChallenge = createHash('sha256')
      .update(codeVerifier)
      .digest('base64url');

    oauthFlows.set(state, {
      codeVerifier,
      expiresAt: Date.now() + OAUTH_FLOW_TTL,
      targetProviderId,
      userId: (c.get('user') as AuthUser).id,
      profile,
    });

    return c.json({
      authorizeUrl: buildClaudeAuthorizeUrl({ codeChallenge, state, profile }),
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
    const body = (await c.req.json().catch(() => ({}))) as Record<
      string,
      unknown
    >;
    // `code` may be the bare code, the `code#state` pair the callback page
    // shows, or the callback page URL.
    const parsed =
      typeof body.code === 'string'
        ? parseClaudeCallbackInput(body.code)
        : null;
    const bodyState =
      typeof body.state === 'string' && body.state ? body.state : null;
    const state = bodyState ?? parsed?.state ?? null;
    if (typeof body.code !== 'string' || !body.code.trim() || !state) {
      return c.json({ error: 'Missing state or code' }, 400);
    }
    if (!parsed) {
      return c.json({ error: 'Invalid code/callback URL' }, 400);
    }

    const flow = oauthFlows.get(state);
    if (!flow) {
      return c.json({ error: 'Invalid or expired OAuth state' }, 400);
    }
    const user = c.get('user') as AuthUser;
    if (flow.userId !== user.id) {
      oauthFlows.delete(state);
      return c.json({ error: 'OAuth flow was started by another user' }, 403);
    }
    if (flow.expiresAt < Date.now()) {
      oauthFlows.delete(state);
      return c.json({ error: 'OAuth flow expired' }, 400);
    }
    // A pasted state belongs to whichever login produced the code; it must be
    // this flow's. The flow stays so the right code can still be pasted.
    if (parsed.state && !claudeOAuthStateMatches(state, parsed.state)) {
      return c.json({ error: 'State mismatch' }, 400);
    }
    if (
      flow.targetProviderId &&
      !getProviders().some(
        (provider) =>
          provider.id === flow.targetProviderId && provider.type === 'official',
      )
    ) {
      oauthFlows.delete(state);
      return c.json({ error: 'Provider not found' }, 404);
    }

    const exchange = await exchangeClaudeAuthorizationCode({
      code: parsed.code,
      codeVerifier: flow.codeVerifier,
      state,
      profile: flow.profile,
    });
    if (!exchange.ok) {
      // A 4xx rejection is definitive for this code; a network failure, 429
      // or 5xx keeps the flow so the operator can retry the same code.
      const definitive =
        exchange.status !== null &&
        exchange.status >= 400 &&
        exchange.status < 500 &&
        exchange.status !== 429;
      if (definitive) oauthFlows.delete(state);
      logger.warn(
        {
          status: exchange.status,
          oauthError:
            exchange.status !== null
              ? claudeOAuthErrorCode(exchange.body)
              : null,
        },
        'OAuth token exchange failed',
      );
      return c.json(
        {
          error: `Token exchange failed: ${exchange.status ?? 'network error'}`,
          retryable: !definitive,
        },
        definitive ? 400 : 502,
      );
    }
    oauthFlows.delete(state);

    const tokenData = exchange.data;
    const accessToken =
      typeof tokenData.access_token === 'string'
        ? tokenData.access_token.trim()
        : '';
    if (!accessToken) {
      return c.json({ error: 'No access_token in response' }, 400);
    }
    const refreshToken =
      typeof tokenData.refresh_token === 'string'
        ? tokenData.refresh_token.trim()
        : '';
    const scopes = parseClaudeTokenScopes(tokenData.scope) ?? [
      ...claudeOAuthScopesForProfile(flow.profile),
    ];
    let account = extractClaudeOAuthAccount(tokenData);
    if (scopes.includes('user:profile')) {
      account = mergeClaudeOAuthAccount(
        account,
        await fetchClaudeOAuthProfile(accessToken),
      );
    }

    // A setup-token login (or a full login answered without a refresh token)
    // yields a long-lived inference token rather than a rotating grant.
    const oauthCredentials: ClaudeOAuthCredentials | null =
      flow.profile === 'full' && refreshToken
        ? {
            accessToken,
            refreshToken,
            expiresAt:
              Date.now() + parseClaudeExpiresIn(tokenData.expires_in) * 1000,
            scopes,
            ...(account?.subscriptionType
              ? { subscriptionType: account.subscriptionType }
              : {}),
          }
        : null;
    const secrets: ProviderSecretsUpdate = oauthCredentials
      ? {
          claudeOAuthCredentials: oauthCredentials,
          claudeOAuthAccount: account,
        }
      : { claudeCodeOauthToken: accessToken, claudeOAuthAccount: account };
    const credentialField = oauthCredentials
      ? 'claudeOAuthCredentials:set'
      : 'claudeCodeOauthToken:set';

    try {
      return await withClaudeConfigMutationLock(async () => {
        if (flow.targetProviderId) {
          const previous = getProviders().find(
            (provider) => provider.id === flow.targetProviderId,
          );
          if (!previous) return c.json({ error: 'Provider not found' }, 404);
          const mutation = await commitProviderCredentialUpdate(
            user.username,
            previous,
            secrets,
            {
              action: 'oauth_login',
              changedFields: [`providerId:${previous.id}`, credentialField],
              trigger: 'provider_oauth_login',
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
          return c.json(toPublicProvider(mutation.value!));
        }

        const provider = createProvider({
          name: account?.emailAddress
            ? `官方 Claude (${account.emailAddress})`
            : '官方 Claude (OAuth)',
          type: 'official',
          ...secrets,
        });
        appendClaudeConfigAuditBestEffort(user.username, 'oauth_login', [
          `providerId:${provider.id}`,
          credentialField,
        ]);
        bindSystemMainIfUnbound(provider.id);
        return c.json(toPublicProvider(provider));
      });
    } catch (err) {
      logger.error({ err }, 'Failed to persist Claude OAuth login');
      const message =
        err instanceof Error ? err.message : 'Failed to persist OAuth login';
      return c.json({ error: message }, 500);
    }
  },
);

// ─── GET /codex/model-catalog — Codex 模型目录（UI 下拉数据源）──────────
// 目录真相源是上游 openai/codex 的 models.json，由 model-catalog-sync
// 定期同步（baked-in 目录兜底）；前端不再硬编码。带 ?providerId= 时改用该
// 账号的实时目录（/backend-api/codex/models，首次等待一次拉取），并按其
// ChatGPT 套餐过滤 available_in_plans。
configRoutes.get(
  '/codex/model-catalog',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    // TTL 过期时触发后台刷新：响应不等待网络，目录在流量中自愈。
    maybeRefreshCodexCatalog();
    const providerId = c.req.query('providerId')?.trim();
    let resolved: ProviderCodexCatalog = getResolvedCodexCatalog();
    let planType: string | null = null;
    if (providerId) {
      const provider = getProviders().find(
        (candidate) =>
          candidate.id === providerId && !!candidate.codexOAuthCredentials,
      );
      if (!provider) return c.json({ error: 'Codex provider not found' }, 404);
      planType = provider.codexOAuthCredentials?.planType ?? null;
      resolved = await ensureCodexProviderCatalog(provider.id);
    }
    const models = filterCodexCatalogByPlan(resolved.models, planType);
    const defaultModel = models.some(
      (entry) => entry.value === CODEX_DEFAULT_MODEL,
    )
      ? CODEX_DEFAULT_MODEL
      : (models[0]?.value ?? CODEX_DEFAULT_MODEL);
    return c.json({
      models,
      defaultModel,
      // The default model's own default level, as new providers are created.
      defaultEffort: resolveCodexDefaultEffort(models, defaultModel),
      source: resolved.source,
      fetchedAt: resolved.fetchedAt,
      ...(providerId ? { providerId, planType } : {}),
    });
  },
);

// ─── POST /codex/oauth/start — 启动 ChatGPT/Codex 订阅 OAuth PKCE 流程 ─────
configRoutes.post(
  '/codex/oauth/start',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const targetProviderId =
      typeof (body as Record<string, unknown>).targetProviderId === 'string'
        ? ((body as Record<string, unknown>).targetProviderId as string)
        : undefined;

    const state = randomBytes(32).toString('hex');
    const { codeVerifier, codeChallenge } = generateCodexPkcePair();

    codexOauthFlows.set(state, {
      codeVerifier,
      expiresAt: Date.now() + CODEX_OAUTH_FLOW_TTL_MS,
      targetProviderId,
      userId: (c.get('user') as AuthUser).id,
    });

    return c.json({
      authorizeUrl: buildCodexAuthorizeUrl(state, codeChallenge),
      state,
      // 登录成功后浏览器会跳去 http://localhost:1455/auth/callback（本机通常没有
      // 进程监听，页面会加载失败）——把失败页地址栏的完整 URL 粘贴回来即可。
      redirectHint: 'http://localhost:1455/auth/callback',
    });
  },
);

// ─── POST /codex/oauth/callback — ChatGPT/Codex 订阅 OAuth 回调 ─────
configRoutes.post(
  '/codex/oauth/callback',
  authMiddleware,
  systemConfigMiddleware,
  async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const { state, code: rawCode } = body as { state?: string; code?: string };
    if (!state || !rawCode) {
      return c.json({ error: 'Missing state or code' }, 400);
    }

    const flow = codexOauthFlows.get(state);
    if (!flow) {
      return c.json({ error: 'Invalid or expired OAuth state' }, 400);
    }
    if (flow.userId !== (c.get('user') as AuthUser).id) {
      codexOauthFlows.delete(state);
      return c.json({ error: 'OAuth flow was started by another user' }, 403);
    }
    if (flow.expiresAt < Date.now()) {
      codexOauthFlows.delete(state);
      return c.json({ error: 'OAuth flow expired' }, 400);
    }

    // Input problems keep the flow: the user can paste the right URL again.
    const parsed = extractCodexCallbackParams(rawCode);
    if (!parsed) {
      return c.json({ error: 'Invalid code/callback URL' }, 400);
    }
    // 粘贴的是完整回调 URL 时优先用其中的 state 做一次一致性校验；裸 code 没有可比对项。
    if (parsed.state && parsed.state !== state) {
      return c.json({ error: 'State mismatch' }, 400);
    }
    if (parsed.kind === 'error') {
      return c.json(
        {
          error: `ChatGPT 授权未完成：${parsed.error}${
            parsed.description ? `（${parsed.description}）` : ''
          }。请重新打开授权链接完成登录。`,
          retryable: true,
        },
        400,
      );
    }

    // Claim the flow so one code is exchanged at a time. Like the official
    // login server, a code is never sent twice once a request may have reached
    // the token endpoint (a response timeout may hide a consumed code); only a
    // connection that never opened restores the flow for the same code.
    codexOauthFlows.delete(state);
    let codexCredentials;
    try {
      codexCredentials = buildCodexCredentials(
        await exchangeCodexCode(parsed.code, flow.codeVerifier),
      );
    } catch (err) {
      const tokenError = err instanceof CodexOAuthTokenError ? err : null;
      const reusable = !!tokenError && !tokenError.requestDelivered;
      const transient = !tokenError || tokenError.transient;
      if (reusable && flow.expiresAt > Date.now()) {
        codexOauthFlows.set(state, flow);
      }
      logger.warn(
        { err, transient, reusable },
        'Codex OAuth token exchange error',
      );
      const message =
        err instanceof Error
          ? err.message
          : 'Codex OAuth token exchange failed';
      return c.json(
        {
          error: reusable
            ? `${message}；可以直接重试，无需重新授权`
            : transient
              ? `${message}；授权码可能已被使用，请重新登录 ChatGPT`
              : `${message}；授权码已失效，请重新登录 ChatGPT`,
          retryable: reusable,
        },
        transient ? 502 : 400,
      );
    }

    const actor = (c.get('user') as AuthUser).username;
    const catalog = getResolvedCodexCatalog().models;
    try {
      return await withClaudeConfigMutationLock(async () => {
        if (!flow.targetProviderId) {
          const defaults = codexProviderCreationDefaults(catalog);
          const provider = createProvider({
            name: `ChatGPT 订阅${codexCredentials.email ? ` (${codexCredentials.email})` : ''}`,
            type: 'third_party',
            anthropicBaseUrl: CODEX_GATEWAY_BASE_URL_PLACEHOLDER,
            // Internal identifier only; runners receive per-launch tokens.
            anthropicAuthToken: randomBytes(32).toString('hex'),
            anthropicModel: defaults.anthropicModel,
            // The runtime defaults a third-party endpoint used to get
            // implicitly; the add wizard offers the same to the others.
            customEnv: { ...CONNECTION_ENV_PREFILL, ...defaults.customEnv },
            codexOAuthCredentials: codexCredentials,
          });
          appendClaudeConfigAuditBestEffort(actor, 'codex_oauth_login', [
            `providerId:${provider.id}`,
            'codexOAuthCredentials:set',
          ]);
          bindSystemMainIfUnbound(provider.id);
          return c.json(toPublicProvider(provider));
        }

        const id = flow.targetProviderId;
        const previous = getProviders().find((provider) => provider.id === id);
        if (!previous) {
          return c.json({ error: '未找到指定供应商' }, 404);
        }
        const plan = planCodexReauthorization(
          previous,
          codexCredentials,
          catalog,
        );
        const commit = () => {
          updateProvider(id, {
            anthropicBaseUrl: CODEX_GATEWAY_BASE_URL_PLACEHOLDER,
            ...(plan.anthropicModel !== previous.anthropicModel
              ? { anthropicModel: plan.anthropicModel }
              : {}),
            ...(plan.customEnv ? { customEnv: plan.customEnv } : {}),
          });
          const updated = updateProviderSecrets(id, {
            codexOAuthCredentials: codexCredentials,
            ...(plan.rotateGatewayIdentifier
              ? { anthropicAuthToken: randomBytes(32).toString('hex') }
              : {}),
            clearAnthropicApiKey: true,
            clearClaudeOAuthCredentials: true,
            clearClaudeCodeOauthToken: true,
          });
          appendClaudeConfigAuditBestEffort(actor, 'codex_oauth_login', [
            `providerId:${id}`,
            'codexOAuthCredentials:set',
            ...(plan.converted ? ['converted'] : []),
            ...(plan.accountChanged ? ['accountChanged'] : []),
          ]);
          return updated;
        };

        // Encrypted reasoning from another account (or another protocol) must
        // never be replayed: quiesce runners and drop this provider's sessions.
        // The same account keeps its sessions; its runners only need to drain.
        const mutation: ClaudeMutationResult<ReturnType<typeof commit>> =
          plan.accountChanged
            ? await mutateClaudeConfigForAllGroups(
                actor,
                {
                  trigger: 'codex_oauth_reauthorize',
                  providerId: id,
                  converted: plan.converted,
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
        if (mutation.value) {
          if (plan.accountChanged && previous.codexOAuthCredentials) {
            // The replaced account's grant is no longer reachable from
            // HappyClaw; revoke it best-effort without delaying the login.
            forgetCodexTransportState(id);
            // The old account's windows and credits say nothing about the new one.
            clearCodexProviderRateLimits(id);
            revokeCodexTokenInBackground(previous.codexOAuthCredentials, {
              providerId: id,
              reason: 'account_replaced',
            });
          }
          // A new login settles any account verdict held against the old one.
          providerPool.resetHealth(id);
          try {
            deps?.queue?.drainProviderRunnersForCredentialRefresh?.(id);
          } catch (err) {
            logger.warn(
              { err, providerId: id },
              'Failed to drain runners after ChatGPT re-authorization',
            );
          }
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
        return c.json(toPublicProvider(mutation.value!));
      });
    } catch (err) {
      logger.error({ err }, 'Codex OAuth provider update error');
      const message =
        err instanceof Error
          ? err.message
          : 'Codex OAuth provider update failed';
      return c.json({ error: message }, 500);
    }
  },
);

// ─── PUT /claude/custom-env — 兼容：更新全局兜底连接的自定义环境变量 ─────
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

    const reserved = reservedConnectionEnvError(validation.data.customEnv);
    if (reserved) return c.json(reserved, 400);

    try {
      const target = getGlobalProvider();
      if (!target) return c.json({ error: '还没有模型连接' }, 400);

      const updated = updateProvider(target.id, {
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
    allowMemberGuests: settings.allowMemberGuests,
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
        const value = saveSystemSettings(validation.data);
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
                }
              : {}),
          },
        });
      }

      return c.json(response);
    });
  },
);

// ─── Storage sources (admin only) ───────────────────────────────────
// NFS exports and SMB shares workspaces can mount. Sources added here live
// under data/config/ and are merged with the mount allowlist's own, which
// stay read-only; an SMB password is write-only and kept in a 0600 file.

const STORAGE_SOURCE_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

/**
 * Sources whose change persisted while a runner using them could not be
 * stopped, with the runtimes blocked since. They stay blocked until the same
 * request is retried.
 */
const storageSourceCleanupPending = new Map<string, string[]>();

function storageSourceSafetySource(id: string): string {
  return `storage_source:${id}`;
}

class StorageSourceRuntimeError extends Error {
  constructor(readonly persisted: boolean) {
    super('storage source runtime cleanup failed');
  }
}

/**
 * Commits a storage source change with every runner that mounts the source
 * stopped (CLAUDE.md §8): Docker fixes a mount when the container is created,
 * so a warm runner would keep the old share, credentials or write access.
 */
async function commitStorageSourceChange<T>(
  id: string,
  quiesce: boolean,
  reason: string,
  commit: () => T,
): Promise<T> {
  const needsQuiesce = quiesce || storageSourceCleanupPending.has(id);
  const targets = needsQuiesce
    ? listStorageSourceUsers(id).map(({ jid, folder }) => ({
        folder,
        primaryJid: jid,
      }))
    : [];
  const safetySource = storageSourceSafetySource(id);
  const releaseBlocked = (runtimeJids: string[]) => {
    const blocked = storageSourceCleanupPending.get(id) ?? [];
    storageSourceCleanupPending.delete(id);
    const jids = [...new Set([...blocked, ...runtimeJids])];
    if (deps && jids.length > 0) {
      deps.queue.unblockGroupsForRuntimeSafety?.(jids, safetySource);
    }
  };
  if (!deps || targets.length === 0) {
    const value = commit();
    releaseBlocked([]);
    return value;
  }
  try {
    const result = await quiesceWorkspaceRunnersAroundCommit(
      deps,
      targets,
      {
        reason,
        onPostCommitFailure: (runtimeJids) => {
          storageSourceCleanupPending.set(id, [
            ...new Set([
              ...(storageSourceCleanupPending.get(id) ?? []),
              ...runtimeJids,
            ]),
          ]);
          deps.queue.blockGroupsForRuntimeSafety?.(
            runtimeJids,
            `${reason}: runtime cleanup failed after commit`,
            safetySource,
          );
        },
      },
      commit,
    );
    releaseBlocked(result.runtimeJids);
    return result.value;
  } catch (err) {
    if (err instanceof WorkspaceRuntimeQuiesceError) {
      throw new StorageSourceRuntimeError(err.persisted);
    }
    throw err;
  }
}

function storageSourceRuntimeErrorResponse(
  c: Context<{ Variables: Variables }>,
  err: StorageSourceRuntimeError,
) {
  return c.json(
    {
      error: err.persisted
        ? '存储源已保存，但没能停下使用它的工作区，请重试同一请求'
        : '没能停下使用该存储源的工作区，存储源未修改',
      persisted: err.persisted,
      retryable: true,
    },
    503,
  );
}

function storageSourceAdminErrorResponse(
  c: Context<{ Variables: Variables }>,
  err: StorageSourceAdminError,
) {
  return c.json(
    {
      error: err.message,
      ...(err.code ? { code: err.code } : {}),
      ...err.details,
    },
    err.status,
  );
}

function logStorageSourceAudit(
  c: Context<{ Variables: Variables }>,
  eventType: 'storage_source_saved' | 'storage_source_deleted',
  details: Record<string, unknown>,
): void {
  const actor = c.get('user') as AuthUser;
  logAuthEvent({
    event_type: eventType,
    username: actor.username,
    actor_username: actor.username,
    ip_address: getClientIp(c),
    user_agent: c.req.header('user-agent') ?? null,
    // The server and share are deployment details; record only the shape.
    details,
  });
}

configRoutes.get(
  '/storage-sources',
  authMiddleware,
  adminRoleMiddleware,
  (c) => {
    try {
      return c.json(listStorageSources());
    } catch (err) {
      logger.error({ err }, 'Failed to list storage sources');
      return c.json({ error: 'Failed to list storage sources' }, 500);
    }
  },
);

async function saveStorageSourceRoute(
  c: Context<{ Variables: Variables }>,
  creating: boolean,
) {
  const id = c.req.param('id') ?? '';
  if (!STORAGE_SOURCE_ID_RE.test(id)) {
    return c.json(
      { error: '标识只能用小写字母、数字和连字符，最长 63 个字符' },
      400,
    );
  }
  const body = await c.req.json().catch(() => ({}));
  const validation = StorageSourceSaveSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }
  const { force, ...input } = validation.data;
  let audit: Record<string, unknown> | undefined;
  try {
    const source = await withStorageSourceWriteLock(async () => {
      const plan = planStorageSourceSave(id, input, creating);
      if (plan.revokedReadWriteUsers > 0 && !force) {
        throw new StorageSourceAdminError(
          `有 ${plan.revokedReadWriteUsers} 个工作区以读写方式挂载了 ${id}，关闭读写后它们将无法启动`,
          409,
          'STORAGE_SOURCE_READ_WRITE_IN_USE',
          { readWriteUsedBy: plan.revokedReadWriteUsers },
        );
      }
      return commitStorageSourceChange(
        id,
        plan.changesMounts,
        `Storage source ${id} updated`,
        () => {
          const view = plan.commit();
          audit = {
            source_id: id,
            type: view.type,
            created: creating,
            password_changed:
              plan.passwordAction === 'set' ||
              plan.passwordAction === 'removed',
          };
          return view;
        },
      );
    });
    return c.json({ source }, creating ? 201 : 200);
  } catch (err) {
    if (err instanceof StorageSourceRuntimeError) {
      return storageSourceRuntimeErrorResponse(c, err);
    }
    if (err instanceof StorageSourceAdminError) {
      return storageSourceAdminErrorResponse(c, err);
    }
    logger.error({ err, sourceId: id }, 'Failed to save storage source');
    return c.json({ error: 'Failed to save storage source' }, 500);
  } finally {
    // Recorded whenever the change persisted, including a 503 after it.
    if (audit) logStorageSourceAudit(c, 'storage_source_saved', audit);
  }
}

configRoutes.post(
  '/storage-sources/:id',
  authMiddleware,
  adminRoleMiddleware,
  (c) => saveStorageSourceRoute(c, true),
);

configRoutes.put(
  '/storage-sources/:id',
  authMiddleware,
  adminRoleMiddleware,
  (c) => saveStorageSourceRoute(c, false),
);

configRoutes.delete(
  '/storage-sources/:id',
  authMiddleware,
  adminRoleMiddleware,
  async (c) => {
    const id = c.req.param('id');
    let audit: Record<string, unknown> | undefined;
    try {
      await withStorageSourceWriteLock(async () => {
        let plan: ReturnType<typeof planStorageSourceDelete> | undefined;
        try {
          plan = planStorageSourceDelete(id);
        } catch (err) {
          // A retry after a 503 finds the source gone: finish stopping the
          // runners that still use it instead of answering 404.
          if (
            !(err instanceof StorageSourceAdminError) ||
            err.status !== 404 ||
            !storageSourceCleanupPending.has(id)
          ) {
            throw err;
          }
        }
        await commitStorageSourceChange(
          id,
          true,
          `Storage source ${id} deleted`,
          () => {
            if (!plan) return;
            plan.commit();
            audit = { source_id: id, type: plan.source.type };
          },
        );
      });
    } catch (err) {
      if (err instanceof StorageSourceRuntimeError) {
        return storageSourceRuntimeErrorResponse(c, err);
      }
      if (err instanceof StorageSourceAdminError) {
        return storageSourceAdminErrorResponse(c, err);
      }
      logger.error({ err, sourceId: id }, 'Failed to delete storage source');
      return c.json({ error: 'Failed to delete storage source' }, 500);
    } finally {
      if (audit) logStorageSourceAudit(c, 'storage_source_deleted', audit);
    }
    return c.json({ success: true });
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
    const test = await testFeishuAppCredentials(
      next.appId as string,
      next.appSecret as string,
      current?.domain,
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
      // The legacy form has no brand field; a Lark account stays on Lark.
      domain: current?.domain,
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
    // JSON parsing yields; re-check ownership before committing the unbind.
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
    unbindChannelMount(imJid, freshImGroup);
    if (wasThreadMap) {
      detachThreadMapWorkspaceIfLast(previousTargetMainJid, imJid);
    }
    if (previousTargetAgentId) refreshAgentLastImJid(previousTargetAgentId);
    logger.info({ imJid, userId: user.id }, 'IM channel unbound');
    return c.json({ success: true, target_main_jid: null });
  }

  const targetSessionId =
    typeof body.target_session_id === 'string' && body.target_session_id.trim()
      ? body.target_session_id.trim()
      : typeof body.target_agent_id === 'string' && body.target_agent_id.trim()
        ? body.target_agent_id.trim()
        : '';

  // Parse once for session binds, topic workspace binds, and policy-only updates.
  const { activationMode, audienceMode } = parseBindingResponsePolicy(
    imJid,
    body,
  );

  // Bind to workspace session. Stored in target_agent_id for backward compatibility.
  if (targetSessionId) {
    const sessionId = targetSessionId;
    const agent = getAgent(sessionId);
    if (!agent) {
      return c.json({ error: 'Session not found' }, 404);
    }
    if (!isBindableSession(agent)) {
      return c.json(SESSION_NOT_BINDABLE, 400);
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
    if (!isBindableSession(freshAgent)) {
      return c.json(SESSION_NOT_BINDABLE, 400);
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
    const replyPolicy = 'source_only' as const;
    const hasConflict = hasSessionMountConflict(freshImGroup, sessionId);
    if (hasConflict && !force) {
      return c.json({ error: 'IM group is already bound elsewhere' }, 409);
    }

    if (
      feishuP2pRejectsMentionActivation(
        imJid,
        chatInfo?.chat_mode ?? freshImGroup.feishu_chat_mode,
        activationMode,
      )
    ) {
      return c.json({ error: FEISHU_P2P_MENTION_ACTIVATION_ERROR }, 400);
    }

    const updated: RegisteredGroup = buildSessionMountUpdate(
      freshImGroup,
      sessionId,
      {
        replyPolicy,
        activationMode,
        audienceMode,
      },
    );
    commitChannelMountUpdate(imJid, updated);
    if (freshImGroup.binding_mode === 'thread_map') {
      detachThreadMapWorkspaceIfLast(freshImGroup.target_main_jid, imJid);
    }
    logger.info(
      { imJid, sessionId, userId: user.id },
      'IM group bound to workspace session (bindings page)',
    );
    return c.json({ success: true });
  }

  // Parse owner_im_id for owner_mentioned mode
  const ownerImId =
    typeof body.owner_im_id === 'string' && body.owner_im_id.trim()
      ? body.owner_im_id.trim()
      : undefined;

  // Bind a native topic group to a workspace (each topic its own session)
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
      feishuP2pRejectsMentionActivation(
        imJid,
        chatInfo?.chat_mode ?? freshImGroup.feishu_chat_mode,
        activationMode,
      )
    ) {
      return c.json({ error: FEISHU_P2P_MENTION_ACTIVATION_ERROR }, 400);
    }
    const force = body.force === true;
    const replyPolicy = 'source_only' as const;
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
      ...buildWorkspaceMountUpdate(freshImGroup, targetMainJid, 'thread_map', {
        replyPolicy,
        ...(activationMode !== undefined ? { activationMode } : {}),
        ...(audienceMode !== undefined ? { audienceMode } : {}),
        ...(ownerImId !== undefined ? { ownerImId } : {}),
      }),
      feishu_chat_mode: chatInfo?.chat_mode ?? freshImGroup.feishu_chat_mode,
      feishu_group_message_type:
        chatInfo?.group_message_type ?? freshImGroup.feishu_group_message_type,
      ...(ownerImId !== undefined
        ? { owner_claim_source: 'configured' as const }
        : {}),
    };
    commitChannelMountUpdate(imJid, updated);
    if (freshImGroup.binding_mode === 'thread_map') {
      detachThreadMapWorkspaceIfLast(
        freshImGroup.target_main_jid,
        imJid,
        targetMainJid,
        'thread_map',
      );
    }
    markNativeContextWorkspace(targetMainJid);
    logger.info(
      { imJid, targetMainJid, userId: user.id },
      'IM topic group bound to workspace (bindings page)',
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
      feishuP2pRejectsMentionActivation(
        imJid,
        imGroup.feishu_chat_mode,
        activationMode,
      )
    ) {
      return c.json({ error: FEISHU_P2P_MENTION_ACTIVATION_ERROR }, 400);
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
            'Native topic groups must bind to a workspace, not a fixed session',
        },
        400,
      );
    }
    if (candidate.target_main_jid && !threadCapable) {
      return c.json(
        { error: 'Workspace bindings only accept native topic groups' },
        400,
      );
    }
    const updated = candidate.target_main_jid
      ? buildWorkspaceMountUpdate(
          candidate,
          candidate.target_main_jid,
          'thread_map',
          {
            activationMode: candidate.activation_mode,
            audienceMode: candidate.audience_mode,
            ownerImId: candidate.owner_im_id ?? null,
          },
        )
      : candidate;
    commitChannelMountUpdate(imJid, updated);
    if (updated.target_main_jid) {
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
    commitChannelMountUpdate(imJid, updated);

    logger.info(
      { imJid, userId: user.id },
      'Feishu response audience reset to everyone (bindings page)',
    );
    return c.json({ success: true });
  },
);

export default configRoutes;
