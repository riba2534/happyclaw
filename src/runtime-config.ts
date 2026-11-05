import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  fileSignatureSettled,
  sameFileSignature,
  statFileSignature,
  type FileSignature,
} from './file-signature.js';
import { ASSISTANT_NAME, DATA_DIR } from './config.js';
import type { FeishuBrand } from './feishu-domain.js';
import { logger } from './logger.js';
import { HAPPYCLAW_OWNED_CLAUDE_ENV_KEYS } from './claude-provider-env.js';
import { clearProviderQuotaObservation } from './provider-quota-observation.js';
import {
  CODEX_GATEWAY_BASE_URL_PLACEHOLDER,
  CODEX_GATEWAY_ROUTE,
  type CodexOAuthCredentials,
  type CodexOAuthRefreshErrorState,
} from './codex-gateway/types.js';
import { isCodexGatewayBaseUrl } from './codex-gateway/resolve-gateway-url.js';
import { resolveCodexDefaultEffort } from './codex-gateway/model-catalog.js';
import { getResolvedCodexCatalog } from './codex-gateway/model-catalog-sync.js';
import { normalizeLegacyCodexModel } from './codex-gateway/convert-request.js';
import { retiredCodexReauthReason } from './codex-gateway/oauth.js';
import {
  buildConnectionModelEnv,
  CONNECTION_ENV_PREFILL,
  CONNECTION_MODEL_ENV_KEYS,
  effectiveProviderModels,
  findModelEntry,
  getModelPreset,
  isModelEffort,
  isValidModelId,
  launchModelName,
  MAX_PROVIDER_MODEL_ID_LENGTH,
  MAX_PROVIDER_MODELS,
  MODEL_EFFORTS,
  normalizeConnectionModelRoles,
  normalizeContextWindow,
  normalizeProviderBaseUrl,
  normalizeProviderModels,
  ONE_MILLION_CONTEXT,
  PROVIDER_ERROR_CODES,
  resolveModelCapabilities,
  splitOneMillionSuffix,
  windowOf,
  type ConnectionModelRoles,
  type ModelEffort,
  type ProviderErrorCode,
  type ProviderModelEntry,
  type ProviderTestRecord,
} from './model-providers.js';

const MAX_FIELD_LENGTH = 2000;
const DEFAULT_THIRD_PARTY_PROFILE_ID = 'default';
const DEFAULT_THIRD_PARTY_PROFILE_NAME = '默认第三方';
const OFFICIAL_CLAUDE_PROFILE_ID = '__official__';

/**
 * 写加密 / OAuth / IM 凭据等含敏感数据的 JSON 配置文件。
 * 即便外层 AES-256-GCM 已加密 ciphertext，密文 + IV + auth tag 仍不应让
 * 同主机其他本地账号读到（旧版默认 0o644 在多租户场景下泄漏整套 IM/OAuth 凭据
 * 的 ciphertext，配合 key 文件泄漏即可解密）。统一走该 helper：tmp 文件以
 * 0o600 创建，rename 后再次 chmod 防御 APFS 上 mode 不跟随 inode 的边角情况。
 */
export function writeSecretFile(targetPath: string, data: string): void {
  const tmp = `${targetPath}.tmp`;
  // 先 unlink stale tmp，避免 fs.writeFileSync 在文件已存在时复用旧 mode
  // (Node 文档：mode 仅在 on-create 时应用)。残留 0o644 会让我们这次写入
  // 落到 0o644 ciphertext，rename 后即便 chmod 0o600 也有 race 窗口。
  try {
    fs.unlinkSync(tmp);
  } catch (err: any) {
    if (err && err.code !== 'ENOENT') {
      // 罕见路径权限错：让外层捕捉到，避免静默把 secret 落到 0o644。
      throw err;
    }
  }
  // 用 fd 路径强制 0o600 创建：fs.openSync 的 mode 在 O_CREAT 时一定生效，
  // fs.writeFileSync(fd, ...) 内部循环处理 short-write。
  const fd = fs.openSync(
    tmp,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC,
    0o600,
  );
  try {
    fs.writeFileSync(fd, data);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
  fs.renameSync(tmp, targetPath);
  try {
    fs.chmodSync(targetPath, 0o600);
  } catch {
    /* best effort */
  }
}

const CLAUDE_CONFIG_DIR = path.join(DATA_DIR, 'config');
const CLAUDE_CONFIG_FILE = path.join(CLAUDE_CONFIG_DIR, 'claude-provider.json');
const CLAUDE_CONFIG_KEY_FILE = path.join(
  CLAUDE_CONFIG_DIR,
  'claude-provider.key',
);
const CLAUDE_CONFIG_AUDIT_FILE = path.join(
  CLAUDE_CONFIG_DIR,
  'claude-provider.audit.log',
);
const CLAUDE_CUSTOM_ENV_FILE = path.join(
  CLAUDE_CONFIG_DIR,
  'claude-custom-env.json',
);
const FEISHU_CONFIG_FILE = path.join(CLAUDE_CONFIG_DIR, 'feishu-provider.json');
const TELEGRAM_CONFIG_FILE = path.join(
  CLAUDE_CONFIG_DIR,
  'telegram-provider.json',
);
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_CLAUDE_ENV_KEYS = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL',
  'HAPPYCLAW_CLAUDE_ENDPOINT_KIND',
  'HAPPYCLAW_FALLBACK_MODEL',
]);

const CLAUDE_ENDPOINT_KIND_ENV = 'HAPPYCLAW_CLAUDE_ENDPOINT_KIND';

/**
 * Every Claude environment key HappyClaw owns (shared/claude-provider-env.ts),
 * plus the provider tuning a connection sets and the endpoint kind marker.
 */
const INHERITED_CLAUDE_PROVIDER_ENV_KEYS: readonly string[] = [
  ...HAPPYCLAW_OWNED_CLAUDE_ENV_KEYS,
  CLAUDE_ENDPOINT_KIND_ENV,
  'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
  'CLAUDE_CODE_NO_FLICKER',
  'ANTHROPIC_BETAS',
  'API_TIMEOUT_MS',
];

/**
 * Remove provider-owned values inherited from the HappyClaw parent process.
 * The selected provider is reapplied afterwards from buildContainerEnvLines().
 * Without this reset, switching to an official provider in host mode can retain
 * a previous ANTHROPIC_BASE_URL/model/token and silently use the wrong endpoint.
 */
export function clearInheritedClaudeProviderEnv(
  env: Record<string, string | undefined>,
): void {
  for (const key of INHERITED_CLAUDE_PROVIDER_ENV_KEYS) {
    delete env[key];
  }
}

/** Keys a connection's models and roles decide; never free env. */
const CONNECTION_MODEL_ENV_KEY_SET: ReadonlySet<string> = new Set(
  CONNECTION_MODEL_ENV_KEYS,
);

/**
 * Keys a workspace override may not set on a third-party endpoint: the model
 * environment and the connection's runtime tuning belong to the connection,
 * so one workspace cannot silently change provider behavior.
 */
const THIRD_PARTY_CONFIGURABLE_ENV_KEYS: ReadonlySet<string> = new Set([
  ...CONNECTION_MODEL_ENV_KEYS,
  ...Object.keys(CONNECTION_ENV_PREFILL),
]);

/**
 * Haiku tier behind the ChatGPT subscription gateway: Claude Code's own
 * small-fast model id (2.1.x first-party default). The gateway maps every
 * claude-* model to the provider's Codex model and recognizes haiku-tier
 * calls as background requests that run at low effort.
 */
const CODEX_GATEWAY_HAIKU_MODEL = 'claude-haiku-5-5';

/** The gateway placeholder, or the local gateway URL it resolves to at launch. */
function isCodexGatewayEndpoint(baseUrl: string): boolean {
  if (isCodexGatewayBaseUrl(baseUrl)) return true;
  try {
    const url = new URL(baseUrl);
    return (
      ['127.0.0.1', 'localhost', 'host.docker.internal'].includes(
        url.hostname,
      ) && url.pathname.replace(/\/+$/, '') === CODEX_GATEWAY_ROUTE
    );
  } catch {
    return false;
  }
}

/** Provider env values that Claude Code parses as positive integers. */
const POSITIVE_INTEGER_PROVIDER_ENV_KEYS = new Set([
  'CLAUDE_CODE_MAX_CONTEXT_TOKENS',
  'API_TIMEOUT_MS',
]);

/**
 * How a third-party token is sent. `bearer` matches the usual
 * `ANTHROPIC_AUTH_TOKEN=...` shell setup (`Authorization: Bearer`);
 * `x-api-key` matches `ANTHROPIC_API_KEY`. Providers saved before the choice
 * existed have no mode and keep the legacy inference in buildClaudeEnvLines.
 */
export type ProviderAuthMode = 'bearer' | 'x-api-key';

export type WebFetchPreflightPolicy = 'check' | 'skip';

/**
 * Reject provider env the runtime would otherwise drop or misread, so the
 * admin sees why instead of a silent "saved". Returns a user-facing message,
 * or null when the map is acceptable. Write paths only: stored maps are still
 * read leniently so an old file never fails to load.
 */
export function validateProviderCustomEnv(
  customEnv: Record<string, string>,
): string | null {
  const dangerous = Object.keys(customEnv).filter(isDangerousEnvKey);
  if (dangerous.length > 0) {
    return `以下环境变量出于安全原因不允许配置：${dangerous.join(', ')}`;
  }
  const reserved = Object.keys(customEnv).filter(
    (key) => RESERVED_CLAUDE_ENV_KEYS.has(key) || key === 'ANTHROPIC_API_KEY',
  );
  if (reserved.length > 0) {
    return `${reserved.join(', ')} 由端点、密钥或模型字段管理，请在对应字段中填写`;
  }
  for (const [key, value] of Object.entries(customEnv)) {
    const trimmed = value.trim();
    if (POSITIVE_INTEGER_PROVIDER_ENV_KEYS.has(key) && trimmed) {
      if (!/^[1-9]\d*$/.test(trimmed)) {
        return `${key} 必须是正整数`;
      }
    }
  }
  return null;
}

/**
 * The keys of a connection env that the launch derives from the connection's
 * models and roles (CONNECTION_MODEL_ENV_KEYS). A write naming one is refused
 * with RESERVED_ENV_KEY rather than saved and silently ignored.
 */
export function reservedConnectionEnvKeys(
  customEnv: Record<string, string>,
): string[] {
  return Object.keys(customEnv).filter((key) =>
    CONNECTION_MODEL_ENV_KEY_SET.has(key),
  );
}

/** The 400 body for a connection env naming such a key, or null. */
export function reservedConnectionEnvError(
  customEnv: Record<string, string> | undefined,
): { error: string; code: 'RESERVED_ENV_KEY'; keys: string[] } | null {
  const keys = reservedConnectionEnvKeys(customEnv ?? {});
  return keys.length > 0
    ? {
        error: `${keys.join(', ')} 由模型设置决定，请在模型列表里配置`,
        code: 'RESERVED_ENV_KEY',
        keys,
      }
    : null;
}

const DANGEROUS_ENV_VARS = new Set([
  // Code execution / preload attacks
  'LD_PRELOAD',
  'LD_LIBRARY_PATH',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'DYLD_FRAMEWORK_PATH',
  'NODE_OPTIONS',
  'JAVA_TOOL_OPTIONS',
  'PERL5OPT',
  // Path manipulation
  'PATH',
  'PYTHONPATH',
  'RUBYLIB',
  'PERL5LIB',
  'GIT_EXEC_PATH',
  'CDPATH',
  // Shell behavior
  'BASH_ENV',
  'ENV',
  'PROMPT_COMMAND',
  'ZDOTDIR',
  // Editor / terminal (可被利用执行命令)
  'EDITOR',
  'VISUAL',
  'PAGER',
  // SSH / Git（防止凭据泄露或命令注入）
  'SSH_AUTH_SOCK',
  'SSH_AGENT_PID',
  'GIT_SSH',
  'GIT_SSH_COMMAND',
  'GIT_ASKPASS',
  // Sensitive directories
  'HOME',
  'TMPDIR',
  'TEMP',
  'TMP',
  // HappyClaw 内部路径映射
  'HAPPYCLAW_WORKSPACE_GROUP',
  // Legacy internal names remain blocked for rollback/old-runner safety even
  // though the current runtime no longer reads or mounts these paths.
  'HAPPYCLAW_WORKSPACE_GLOBAL',
  'HAPPYCLAW_WORKSPACE_MEMORY',
  'HAPPYCLAW_WORKSPACE_IPC',
  'CLAUDE_CONFIG_DIR',
]);

function isDangerousEnvKey(key: string): boolean {
  return (
    DANGEROUS_ENV_VARS.has(key) ||
    key.startsWith('HAPPYCLAW_SESSION_') ||
    key.startsWith('HAPPYCLAW_INTERNAL_') ||
    key === 'HAPPYCLAW_HOST_IDENTITY_MODE' ||
    key === 'HAPPYCLAW_HOST_UID' ||
    key === 'HAPPYCLAW_HOST_GID' ||
    key === 'HAPPYCLAW_PASSWD_FILE' ||
    key === 'HAPPYCLAW_RECONCILE_SESSION_PERMISSIONS' ||
    key === 'HAPPYCLAW_MOUNT_PREPARE_MODE' ||
    key === 'HAPPYCLAW_RUNTIME_USER'
  );
}
const MAX_CUSTOM_ENV_ENTRIES = 50;
const MAX_THIRD_PARTY_PROFILES = 20;

// Fallback scopes for .credentials.json when stored credentials lack scopes.
// Differs from CLAUDE_OAUTH_LOGIN_SCOPES in claude-oauth.ts (the authorize
// request): only the browser consent carries org:create_api_key.
const DEFAULT_CREDENTIAL_SCOPES = [
  'user:inference',
  'user:profile',
  'user:sessions:claude_code',
];

export interface ClaudeOAuthCredentials {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp (ms)
  scopes: string[];
  subscriptionType?: string; // e.g. 'max', 'pro' — written to .credentials.json if present
}

/** Account facts Anthropic returns with a Claude token or its profile. */
export interface ClaudeOAuthAccountInfo {
  accountUuid?: string;
  emailAddress?: string;
  organizationUuid?: string;
  organizationName?: string;
  /** Known even for a setup-token grant, which has no credential file. */
  subscriptionType?: string;
}

/**
 * A refresh rejection that replaying the same refresh token cannot fix. It
 * stays on the provider (stopping automatic refresh) until its Claude
 * credentials change.
 */
export interface ClaudeOAuthRefreshError {
  kind: 'invalid_grant' | 'rejected' | 'account_mismatch';
  message: string;
  at: number;
}

export interface OAuthUsageBucket {
  /** Percentage reported by the OAuth usage endpoint, in the 0..100 unit. */
  utilization: number | null;
  resets_at: string | null;
}

export interface OAuthModelUsageBucket extends OAuthUsageBucket {
  /** Server-supplied label. Do not infer model buckets from fixed field names. */
  display_name: string;
}

export interface OAuthExtraUsage {
  is_enabled: boolean;
  monthly_limit: number | null;
  used_credits: number | null;
  /** Percentage reported by the OAuth usage endpoint, in the 0..100 unit. */
  utilization: number | null;
  currency: string | null;
}

export interface OAuthUsageResponse {
  five_hour: OAuthUsageBucket | null;
  seven_day: OAuthUsageBucket | null;
  seven_day_oauth_apps: OAuthUsageBucket | null;
  seven_day_opus: OAuthUsageBucket | null;
  seven_day_sonnet: OAuthUsageBucket | null;
  model_scoped: OAuthModelUsageBucket[];
  extra_usage: OAuthExtraUsage | null;
}

export interface CachedOAuthUsage {
  data: OAuthUsageResponse;
  fetchedAt: number; // Unix timestamp ms
  error?: string;
  /**
   * Set when no usage can be read: the credential cannot reach the usage
   * endpoint (`unsupported`), or the grant was rejected and needs a new login.
   */
  status?: 'unsupported' | 'needs_relogin';
  unsupportedReason?: 'inference_only' | 'setup_token' | 'no_oauth';
  /** Latest bounded SDK rate_limit_event snapshot for this provider. */
  observation?:
    | import('./provider-quota-observation.js').ProviderQuotaSnapshot
    | null;
}

export interface ClaudeProviderConfig {
  anthropicBaseUrl: string;
  anthropicAuthToken: string;
  /** Unset for legacy providers: buildClaudeEnvLines infers the header. */
  anthropicAuthMode?: ProviderAuthMode;
  anthropicApiKey: string;
  claudeCodeOauthToken: string;
  claudeOAuthCredentials: ClaudeOAuthCredentials | null;
  anthropicModel: string;
  /**
   * The connection's model list and roles, from which a third-party launch
   * derives its tiers, `[1m]` and compact window (buildClaudeEnvLines).
   * Absent for configurations that are not a saved connection.
   */
  models?: ProviderModelEntry[];
  roles?: ConnectionModelRoles;
  updatedAt: string | null;
}

export interface ClaudeProviderPublicConfig {
  anthropicBaseUrl: string;
  anthropicModel: string;
  updatedAt: string | null;
  hasAnthropicAuthToken: boolean;
  hasAnthropicApiKey: boolean;
  hasClaudeCodeOauthToken: boolean;
  anthropicAuthTokenMasked: string | null;
  anthropicApiKeyMasked: string | null;
  claudeCodeOauthTokenMasked: string | null;
  hasClaudeOAuthCredentials: boolean;
  claudeOAuthCredentialsExpiresAt: number | null;
  claudeOAuthCredentialsAccessTokenMasked: string | null;
}

export interface ClaudeThirdPartyProfile {
  id: string;
  name: string;
  anthropicBaseUrl: string;
  anthropicAuthToken: string;
  anthropicModel: string;
  updatedAt: string | null;
  customEnv: Record<string, string>;
}

export interface FeishuProviderConfig {
  appId: string;
  appSecret: string;
  enabled?: boolean;
  updatedAt: string | null;
}

export type FeishuConfigSource = 'runtime' | 'env' | 'none';

export interface FeishuProviderPublicConfig {
  appId: string;
  hasAppSecret: boolean;
  appSecretMasked: string | null;
  enabled: boolean;
  updatedAt: string | null;
  source: FeishuConfigSource;
}

export interface TelegramProviderConfig {
  botToken: string;
  proxyUrl?: string;
  enabled?: boolean;
  updatedAt: string | null;
}

export type TelegramConfigSource = 'runtime' | 'env' | 'none';

export interface TelegramProviderPublicConfig {
  hasBotToken: boolean;
  botTokenMasked: string | null;
  proxyUrl: string;
  enabled: boolean;
  updatedAt: string | null;
  source: TelegramConfigSource;
}

interface SecretPayload {
  anthropicAuthToken: string;
  anthropicApiKey: string;
  claudeCodeOauthToken: string;
  claudeOAuthCredentials?: ClaudeOAuthCredentials | null;
  codexOAuthCredentials?: CodexOAuthCredentials | null;
  claudeOAuthAccount?: ClaudeOAuthAccountInfo | null;
  claudeOAuthLastRefreshAt?: number | null;
  claudeOAuthLastRefreshError?: ClaudeOAuthRefreshError | null;
}

interface EncryptedSecrets {
  iv: string;
  tag: string;
  data: string;
}

interface FeishuSecretPayload {
  appSecret: string;
}

interface TelegramSecretPayload {
  botToken: string;
}

interface StoredFeishuProviderConfigV1 {
  version: 1;
  appId: string;
  enabled?: boolean;
  updatedAt: string;
  ownerOpenId?: string;
  autoIsolateContext?: boolean;
  domain?: FeishuBrand;
  secret: EncryptedSecrets;
}

interface StoredTelegramProviderConfigV1 {
  version: 1;
  proxyUrl?: string;
  enabled?: boolean;
  updatedAt: string;
  secret: EncryptedSecrets;
}

interface StoredClaudeProviderConfigV2 {
  version: 2;
  anthropicBaseUrl: string;
  updatedAt: string;
  secrets: EncryptedSecrets;
}

interface StoredClaudeThirdPartyProfileV1 {
  id: string;
  name: string;
  anthropicBaseUrl: string;
  anthropicModel: string;
  updatedAt: string;
  secrets: EncryptedSecrets;
  customEnv?: Record<string, string>;
}

interface StoredClaudeProviderConfigV3 {
  version: 3;
  activeProfileId: string;
  profiles: StoredClaudeThirdPartyProfileV1[];
  official: {
    updatedAt: string;
    secrets: EncryptedSecrets;
    customEnv?: Record<string, string>;
  };
}

interface StoredClaudeProviderConfigLegacy {
  anthropicBaseUrl?: string;
  anthropicAuthToken?: string;
  anthropicApiKey?: string;
  claudeCodeOauthToken?: string;
  updatedAt?: string;
}

interface ClaudeStoredStateV3Resolved {
  activeProfileId: string;
  profiles: StoredClaudeThirdPartyProfileV1[];
  officialSecrets: SecretPayload;
  officialUpdatedAt: string | null;
  officialCustomEnv: Record<string, string>;
}

// ─── V5 模型配置（每项都是一套完整 Provider 运行环境）──────────

/**
 * The automatic pool's settings as older releases store them. This release
 * reads nothing from them; they are kept as found (or written as the old
 * defaults) so a rollback reads a complete file.
 */
type StoredBalancing = Record<string, unknown>;

const LEGACY_BALANCING: StoredBalancing = {
  strategy: 'round-robin',
  unhealthyThreshold: 3,
  recoveryIntervalMs: 300_000,
};

/** V4 磁盘格式 — 每个供应商的 secrets 独立加密 */
interface StoredProviderV4 {
  id: string;
  name: string;
  type: 'official' | 'third_party';
  /**
   * Legacy pool membership and weight, for older releases and the one-time
   * binding backfill (readLegacyModelDefaults). This release decides nothing
   * by them: membership is carried through as read, new connections are out.
   */
  enabled: boolean;
  weight: number;
  anthropicBaseUrl: string;
  anthropicModel: string;
  anthropicAuthMode?: ProviderAuthMode;
  /** Stored only for skip; absent follows Claude Code's own settings. */
  webFetchPreflightPolicy?: 'skip';
  secrets: EncryptedSecrets;
  customEnv?: Record<string, string>;
  /** ChatGPT/Codex 订阅：最近一次 token 刷新失败（非机密运行态，凭据写入时清除）。 */
  codexOAuthLastRefreshError?: CodexOAuthRefreshErrorState;
  /**
   * The models the connection offers. Absent: just `anthropicModel`. Not kept
   * for ChatGPT subscriptions, whose live catalog is their list. Optional
   * fields like this one are ignored by older releases, so a rollback keeps
   * every credential; the file version stays 5.
   */
  models?: ProviderModelEntry[];
  /** The vendor preset (MODEL_PRESETS id) the connection started from. */
  presetId?: string;
  /** The last connection test; written only by the test route. */
  lastTest?: ProviderTestRecord;
  /** Which of the connection's models Claude Code uses besides the turn's. */
  roles?: ConnectionModelRoles;
  /**
   * Set once CONNECTION_ENV_PREFILL has been given to the connection (by the
   * add wizard, or by the read-time migration for older connections), so a
   * key the user deleted afterwards stays deleted.
   */
  envPrefill?: 1;
  /**
   * Which Claude login the OAuth credentials come from: a new one on every
   * login or pasted credential, kept through token renewals. Random, so it
   * says nothing about the tokens.
   */
  claudeOAuthGrantId?: string;
  updatedAt: string;
}

interface StoredClaudeProviderConfigV4 {
  version: 4;
  providers: StoredProviderV4[];
  balancing?: StoredBalancing;
  updatedAt: string;
}

interface StoredClaudeProviderConfigV5 {
  version: 5;
  providers: StoredProviderV4[];
  /** Legacy V5 field. Read only so older files can be normalized in place. */
  defaultProviderId?: string | null;
  /**
   * The retired global default model, read once by the binding backfill and
   * then cleared. A separate key from the legacy pointer above, which every
   * installation once had and which must never be read as a choice.
   */
  defaultModelConfigId?: string | null;
  balancing?: StoredBalancing;
  updatedAt: string;
}

/** 解密后的统一供应商运行时结构 */
export interface UnifiedProvider {
  id: string;
  name: string;
  type: 'official' | 'third_party';
  anthropicBaseUrl: string;
  anthropicAuthToken: string;
  anthropicAuthMode?: ProviderAuthMode;
  /** Set only when the connection skips WebFetch's domain check. */
  webFetchPreflightPolicy?: 'skip';
  anthropicModel: string;
  anthropicApiKey: string;
  claudeCodeOauthToken: string;
  claudeOAuthCredentials: ClaudeOAuthCredentials | null;
  codexOAuthCredentials: CodexOAuthCredentials | null;
  /** Reset whenever the Claude credentials change; kept across refreshes. */
  claudeOAuthAccount?: ClaudeOAuthAccountInfo | null;
  claudeOAuthLastRefreshAt?: number | null;
  claudeOAuthLastRefreshError?: ClaudeOAuthRefreshError | null;
  /** 缺省视为无刷新失败；存量配置没有这个字段。 */
  codexOAuthLastRefreshError?: CodexOAuthRefreshErrorState | null;
  /** See StoredProviderV4.models; read through effectiveProviderModels. */
  models?: ProviderModelEntry[];
  /** Only roles naming one of `models`; absent when none is set. */
  roles?: ConnectionModelRoles;
  envPrefill?: 1;
  presetId?: string;
  lastTest?: ProviderTestRecord | null;
  claudeOAuthGrantId?: string;
  customEnv: Record<string, string>;
  updatedAt: string;
}

/** UnifiedProvider 的公开（脱敏）版本 */
export interface UnifiedProviderPublic {
  id: string;
  name: string;
  type: 'official' | 'third_party';
  anthropicBaseUrl: string;
  anthropicModel: string;
  /** null for providers saved before the explicit choice existed. */
  anthropicAuthMode: ProviderAuthMode | null;
  webFetchPreflightPolicy: WebFetchPreflightPolicy;
  hasAnthropicAuthToken: boolean;
  anthropicAuthTokenMasked: string | null;
  hasAnthropicApiKey: boolean;
  anthropicApiKeyMasked: string | null;
  hasClaudeCodeOauthToken: boolean;
  claudeCodeOauthTokenMasked: string | null;
  hasClaudeOAuthCredentials: boolean;
  claudeOAuthCredentialsExpiresAt: number | null;
  claudeOAuthCredentialsAccessTokenMasked: string | null;
  hasCodexOAuthCredentials: boolean;
  codexOAuthCredentialsExpiresAt: number | null;
  codexOAuthCredentialsEmail: string | null;
  codexOAuthCredentialsPlanType: string | null;
  /** Official providers only; null for third-party or no credential. */
  claudeAuthKind: 'oauth' | 'setup_token' | 'api_key' | null;
  claudeOAuthAccountEmail: string | null;
  claudeOAuthOrganizationName: string | null;
  claudeOAuthOrganizationUuid: string | null;
  claudeOAuthSubscriptionType: string | null;
  claudeOAuthScopes: string[];
  claudeOAuthLastRefreshAt: number | null;
  claudeOAuthNeedsReLogin: boolean;
  claudeOAuthLastRefreshError: ClaudeOAuthRefreshError | null;
  /** ChatGPT 订阅登录已失效，需要在模型配置里重新登录。 */
  codexOAuthNeedsReauth: boolean;
  /** 最近一次上游 token 刷新失败；成功刷新或重新登录后为 null。 */
  codexOAuthLastRefreshError: {
    kind: CodexOAuthRefreshErrorState['kind'];
    message: string;
    at: string;
  } | null;
  /**
   * Codex provider 在 Agent 未显式指定推理力度时实际使用的默认档：
   * CODEX_REASONING_EFFORT 按模型目录钳制后的值，未配置时取该模型的目录默认档。
   * 非 Codex provider 为 null。网关请求侧使用同一个解析函数。
   */
  codexDefaultEffort: string | null;
  /**
   * What the connection offers: the connection's own model first when the
   * list does not name it. Empty for ChatGPT subscriptions (the Web reads
   * their catalog) and for a pass-through relay without models.
   */
  models: ProviderModelEntry[];
  roles: ConnectionModelRoles;
  presetId: string | null;
  lastTest: ProviderTestRecord | null;
  customEnv: Record<string, string>;
  updatedAt: string;
}

const MAX_PROVIDERS = 20;
const POOL_CONFIG_FILE = path.join(CLAUDE_CONFIG_DIR, 'provider-pool.json');

interface ClaudeConfigAuditEntry {
  timestamp: string;
  actor: string;
  action: string;
  changedFields: string[];
  metadata?: Record<string, unknown>;
}

function normalizeSecret(input: unknown, fieldName: string): string {
  if (typeof input !== 'string') {
    throw new Error(`Invalid field: ${fieldName}`);
  }
  // eslint-disable-next-line no-control-regex
  const ascii = input.replace(/[^\x00-\x7F]/g, '').trim();
  // An ANTHROPIC_AUTH_TOKEN may intentionally be an Authorization header value
  // ("Bearer <token>"); collapse internal whitespace to a single space so the
  // prefix survives. Every other secret — API keys, OAuth tokens, and bare
  // auth tokens — stays compact so an accidental pasted space can't break auth.
  const value =
    fieldName === 'anthropicAuthToken' && /^Bearer\s/i.test(ascii)
      ? ascii.replace(/\s+/g, ' ')
      : ascii.replace(/\s+/g, '');
  if (value.length > MAX_FIELD_LENGTH) {
    throw new Error(`Field too long: ${fieldName}`);
  }
  return value;
}

function normalizeBaseUrl(input: unknown): string {
  if (typeof input !== 'string') {
    throw new Error('Invalid field: anthropicBaseUrl');
  }
  const value = input.trim();
  if (!value) return '';
  if (value.length > MAX_FIELD_LENGTH) {
    throw new Error('Field too long: anthropicBaseUrl');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Invalid field: anthropicBaseUrl');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Invalid field: anthropicBaseUrl');
  }
  return value;
}

function normalizeProviderAuthMode(
  input: unknown,
): ProviderAuthMode | undefined {
  return input === 'bearer' || input === 'x-api-key' ? input : undefined;
}

function normalizeModel(input: unknown): string {
  if (typeof input !== 'string') {
    throw new Error('Invalid field: anthropicModel');
  }
  const value = input.trim();
  if (!value) return '';
  if (value.length > MAX_PROVIDER_MODEL_ID_LENGTH) {
    throw new Error('Field too long: anthropicModel');
  }
  return value;
}

function normalizeFeishuAppId(input: unknown): string {
  if (typeof input !== 'string') {
    throw new Error('Invalid field: appId');
  }
  const value = input.trim();
  if (!value) return '';
  if (value.length > MAX_FIELD_LENGTH) {
    throw new Error('Field too long: appId');
  }
  return value;
}

function normalizeTelegramProxyUrl(input: unknown): string {
  if (input === undefined || input === null) return '';
  if (typeof input !== 'string') {
    throw new Error('Invalid field: proxyUrl');
  }
  const value = input.trim();
  if (!value) return '';
  if (value.length > MAX_FIELD_LENGTH) {
    throw new Error('Field too long: proxyUrl');
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Invalid field: proxyUrl');
  }
  const protocol = parsed.protocol.toLowerCase();
  if (!['http:', 'https:', 'socks:', 'socks5:'].includes(protocol)) {
    throw new Error('Invalid field: proxyUrl');
  }
  return value;
}

function normalizeProfileName(input: unknown): string {
  if (typeof input !== 'string') {
    throw new Error('Invalid field: name');
  }
  const value = input.trim();
  if (!value) {
    throw new Error('Invalid field: name');
  }
  if (value.length > 64) {
    throw new Error('Field too long: name');
  }
  return value;
}

function normalizeProfileId(input: unknown): string {
  if (typeof input !== 'string') {
    throw new Error('Invalid field: id');
  }
  const value = input.trim();
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(value)) {
    throw new Error('Invalid field: id');
  }
  return value;
}

/**
 * A stored or submitted env map with invalid keys refused and dangerous ones
 * dropped. An empty value is dropped too: a key the user left blank is not
 * injected. `skipConnectionModelKeys` also drops the keys a connection's
 * models decide; reads keep them until migrateConnectionModelFields moves
 * them into the model list.
 */
function sanitizeCustomEnvMap(
  input: Record<string, string>,
  options?: {
    skipReservedClaudeKeys?: boolean;
    skipConnectionModelKeys?: boolean;
  },
): Record<string, string> {
  const entries = Object.entries(input);
  if (entries.length > MAX_CUSTOM_ENV_ENTRIES) {
    throw new Error(
      `customEnv must have at most ${MAX_CUSTOM_ENV_ENTRIES} entries`,
    );
  }

  const out: Record<string, string> = {};
  for (const [key, rawValue] of entries) {
    if (!ENV_KEY_RE.test(key)) {
      throw new Error(`Invalid env key: ${key}`);
    }
    if (options?.skipReservedClaudeKeys && RESERVED_CLAUDE_ENV_KEYS.has(key)) {
      continue;
    }
    if (
      options?.skipConnectionModelKeys &&
      CONNECTION_MODEL_ENV_KEY_SET.has(key)
    ) {
      continue;
    }
    if (isDangerousEnvKey(key)) continue;
    const value = sanitizeCustomEnvValue(
      key,
      typeof rawValue === 'string' ? rawValue : String(rawValue),
    );
    if (value.trim()) out[key] = value;
  }
  return out;
}

/** The env options every write of a connection's own env uses. */
const CONNECTION_ENV_WRITE = {
  skipReservedClaudeKeys: true,
  skipConnectionModelKeys: true,
} as const;

/** Whether a launch leaves a connection env key out (see CONNECTION_ENV_WRITE). */
function isSkippedConnectionEnvKey(key: string): boolean {
  return (
    RESERVED_CLAUDE_ENV_KEYS.has(key) ||
    CONNECTION_MODEL_ENV_KEY_SET.has(key) ||
    isDangerousEnvKey(key)
  );
}

function normalizeConfig(
  input: Omit<ClaudeProviderConfig, 'updatedAt'>,
): Omit<ClaudeProviderConfig, 'updatedAt'> {
  return {
    anthropicBaseUrl: normalizeBaseUrl(input.anthropicBaseUrl),
    anthropicAuthToken: normalizeSecret(
      input.anthropicAuthToken,
      'anthropicAuthToken',
    ),
    anthropicApiKey: normalizeSecret(input.anthropicApiKey, 'anthropicApiKey'),
    claudeCodeOauthToken: normalizeSecret(
      input.claudeCodeOauthToken,
      'claudeCodeOauthToken',
    ),
    claudeOAuthCredentials: input.claudeOAuthCredentials ?? null,
    anthropicModel: normalizeModel(input.anthropicModel),
  };
}

function buildConfig(
  input: Omit<ClaudeProviderConfig, 'updatedAt'>,
  updatedAt: string | null,
): ClaudeProviderConfig {
  return {
    ...normalizeConfig(input),
    updatedAt,
  };
}

// The key never rotates in-process, but channel-account-secrets or another
// process may create it and an operator may restore it, so a cached key is
// revalidated by one stat instead of mkdir + exists + read on every crypto op.
let encryptionKeyCache: {
  sig: FileSignature;
  observedAt: number;
  key: Buffer;
} | null = null;

function getOrCreateEncryptionKey(): Buffer {
  const observedAt = Date.now();
  const sig = statFileSignature(CLAUDE_CONFIG_KEY_FILE);
  const cached = encryptionKeyCache;
  if (
    cached &&
    sig &&
    sameFileSignature(cached.sig, sig) &&
    fileSignatureSettled(sig, cached.observedAt)
  ) {
    return cached.key;
  }
  encryptionKeyCache = null;

  fs.mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });

  if (fs.existsSync(CLAUDE_CONFIG_KEY_FILE)) {
    const raw = fs.readFileSync(CLAUDE_CONFIG_KEY_FILE, 'utf-8').trim();
    const key = Buffer.from(raw, 'hex');
    if (key.length === 32) {
      // `sig` predates the read, so a concurrent rewrite only forces a re-read.
      if (sig) encryptionKeyCache = { sig, observedAt, key };
      return key;
    }
    throw new Error('Invalid encryption key file');
  }

  const key = crypto.randomBytes(32);
  fs.writeFileSync(CLAUDE_CONFIG_KEY_FILE, key.toString('hex') + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
  return key;
}

function encryptSecrets(payload: SecretPayload): EncryptedSecrets {
  const key = getOrCreateEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);

  const plaintext = Buffer.from(JSON.stringify(payload), 'utf-8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();

  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
  };
}

function decryptSecrets(secrets: EncryptedSecrets): SecretPayload {
  const key = getOrCreateEncryptionKey();
  const iv = Buffer.from(secrets.iv, 'base64');
  const tag = Buffer.from(secrets.tag, 'base64');
  const encrypted = Buffer.from(secrets.data, 'base64');

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString('utf-8');

  const parsed = JSON.parse(decrypted) as Record<string, unknown>;
  const result: SecretPayload = {
    anthropicAuthToken: normalizeSecret(
      parsed.anthropicAuthToken ?? '',
      'anthropicAuthToken',
    ),
    anthropicApiKey: normalizeSecret(
      parsed.anthropicApiKey ?? '',
      'anthropicApiKey',
    ),
    claudeCodeOauthToken: normalizeSecret(
      parsed.claudeCodeOauthToken ?? '',
      'claudeCodeOauthToken',
    ),
  };
  // Restore OAuth credentials if present
  if (
    parsed.claudeOAuthCredentials &&
    typeof parsed.claudeOAuthCredentials === 'object'
  ) {
    const creds = parsed.claudeOAuthCredentials as Record<string, unknown>;
    if (
      typeof creds.accessToken === 'string' &&
      typeof creds.refreshToken === 'string'
    ) {
      result.claudeOAuthCredentials = {
        accessToken: creds.accessToken,
        refreshToken: creds.refreshToken,
        expiresAt: typeof creds.expiresAt === 'number' ? creds.expiresAt : 0,
        scopes: Array.isArray(creds.scopes) ? (creds.scopes as string[]) : [],
        ...(typeof creds.subscriptionType === 'string'
          ? { subscriptionType: creds.subscriptionType }
          : {}),
      };
    }
  }
  // Restore Codex (ChatGPT 订阅) OAuth credentials if present
  if (
    parsed.codexOAuthCredentials &&
    typeof parsed.codexOAuthCredentials === 'object'
  ) {
    const creds = parsed.codexOAuthCredentials as Record<string, unknown>;
    if (
      typeof creds.accessToken === 'string' &&
      typeof creds.refreshToken === 'string'
    ) {
      result.codexOAuthCredentials = {
        accessToken: creds.accessToken,
        refreshToken: creds.refreshToken,
        expiresAt: typeof creds.expiresAt === 'number' ? creds.expiresAt : 0,
        accountId: typeof creds.accountId === 'string' ? creds.accountId : null,
        planType: typeof creds.planType === 'string' ? creds.planType : null,
        email: typeof creds.email === 'string' ? creds.email : null,
        ...(creds.isFedramp === true ? { isFedramp: true } : {}),
        updatedAt:
          typeof creds.updatedAt === 'string'
            ? creds.updatedAt
            : new Date(0).toISOString(),
      };
    }
  }
  const account = decodeClaudeOAuthAccount(parsed.claudeOAuthAccount);
  if (account) result.claudeOAuthAccount = account;
  if (
    typeof parsed.claudeOAuthLastRefreshAt === 'number' &&
    Number.isFinite(parsed.claudeOAuthLastRefreshAt)
  ) {
    result.claudeOAuthLastRefreshAt = parsed.claudeOAuthLastRefreshAt;
  }
  const refreshError = decodeClaudeOAuthRefreshError(
    parsed.claudeOAuthLastRefreshError,
  );
  if (refreshError) result.claudeOAuthLastRefreshError = refreshError;
  return result;
}

const CLAUDE_OAUTH_ACCOUNT_FIELDS = [
  'accountUuid',
  'emailAddress',
  'organizationUuid',
  'organizationName',
  'subscriptionType',
] as const;

function decodeClaudeOAuthAccount(
  value: unknown,
): ClaudeOAuthAccountInfo | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const account: ClaudeOAuthAccountInfo = {};
  for (const field of CLAUDE_OAUTH_ACCOUNT_FIELDS) {
    if (typeof raw[field] === 'string' && raw[field]) {
      account[field] = raw[field] as string;
    }
  }
  return Object.keys(account).length > 0 ? account : null;
}

const CLAUDE_OAUTH_REFRESH_ERROR_KINDS = new Set<
  ClaudeOAuthRefreshError['kind']
>(['invalid_grant', 'rejected', 'account_mismatch']);

function decodeClaudeOAuthRefreshError(
  value: unknown,
): ClaudeOAuthRefreshError | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (
    !CLAUDE_OAUTH_REFRESH_ERROR_KINDS.has(
      raw.kind as ClaudeOAuthRefreshError['kind'],
    ) ||
    typeof raw.message !== 'string' ||
    typeof raw.at !== 'number'
  ) {
    return null;
  }
  return {
    kind: raw.kind as ClaudeOAuthRefreshError['kind'],
    message: raw.message,
    at: raw.at,
  };
}

function encryptChannelSecret<T>(payload: T): EncryptedSecrets {
  const key = getOrCreateEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf-8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
  };
}

function decryptChannelSecret<T>(secrets: EncryptedSecrets): T {
  const key = getOrCreateEncryptionKey();
  const iv = Buffer.from(secrets.iv, 'base64');
  const tag = Buffer.from(secrets.tag, 'base64');
  const encrypted = Buffer.from(secrets.data, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString('utf-8');
  return JSON.parse(decrypted) as T;
}

function readLegacyConfig(
  raw: StoredClaudeProviderConfigLegacy,
): ClaudeProviderConfig {
  return buildConfig(
    {
      anthropicBaseUrl: raw.anthropicBaseUrl ?? '',
      anthropicAuthToken: raw.anthropicAuthToken ?? '',
      anthropicApiKey: raw.anthropicApiKey ?? '',
      claudeCodeOauthToken: raw.claudeCodeOauthToken ?? '',
      claudeOAuthCredentials: null,
      anthropicModel: process.env.ANTHROPIC_MODEL || '',
    },
    typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  );
}

function toStoredProfile(
  profile: ClaudeThirdPartyProfile,
): StoredClaudeThirdPartyProfileV1 {
  const sanitizedEnv = sanitizeCustomEnvMap(profile.customEnv || {}, {
    skipReservedClaudeKeys: true,
  });
  return {
    id: normalizeProfileId(profile.id),
    name: normalizeProfileName(profile.name),
    anthropicBaseUrl: normalizeBaseUrl(profile.anthropicBaseUrl),
    anthropicModel: normalizeModel(profile.anthropicModel),
    updatedAt: profile.updatedAt || new Date().toISOString(),
    secrets: encryptSecrets({
      anthropicAuthToken: normalizeSecret(
        profile.anthropicAuthToken,
        'anthropicAuthToken',
      ),
      anthropicApiKey: '',
      claudeCodeOauthToken: '',
      claudeOAuthCredentials: null,
    }),
    ...(Object.keys(sanitizedEnv).length > 0
      ? { customEnv: sanitizedEnv }
      : {}),
  };
}

function fromStoredProfile(
  stored: StoredClaudeThirdPartyProfileV1,
): ClaudeThirdPartyProfile {
  const secrets = decryptSecrets(stored.secrets);
  return {
    id: normalizeProfileId(stored.id),
    name: normalizeProfileName(stored.name),
    anthropicBaseUrl: normalizeBaseUrl(stored.anthropicBaseUrl),
    anthropicAuthToken: secrets.anthropicAuthToken,
    anthropicModel: normalizeModel(
      stored.anthropicModel ?? (stored as any).happyclawModel ?? '',
    ),
    updatedAt: stored.updatedAt || null,
    customEnv: sanitizeCustomEnvMap(stored.customEnv || {}, {
      skipReservedClaudeKeys: true,
    }),
  };
}

function makeDefaultThirdPartyProfile(
  config: ClaudeProviderConfig,
): ClaudeThirdPartyProfile {
  return {
    id: DEFAULT_THIRD_PARTY_PROFILE_ID,
    name: DEFAULT_THIRD_PARTY_PROFILE_NAME,
    anthropicBaseUrl: config.anthropicBaseUrl,
    anthropicAuthToken: config.anthropicAuthToken,
    anthropicModel: normalizeModel(
      config.anthropicModel || process.env.ANTHROPIC_MODEL || '',
    ),
    updatedAt: config.updatedAt || new Date().toISOString(),
    customEnv: {},
  };
}

function normalizeOfficialSecrets(input: SecretPayload): SecretPayload {
  return {
    anthropicAuthToken: '',
    anthropicApiKey: normalizeSecret(
      input.anthropicApiKey ?? '',
      'anthropicApiKey',
    ),
    claudeCodeOauthToken: normalizeSecret(
      input.claudeCodeOauthToken ?? '',
      'claudeCodeOauthToken',
    ),
    claudeOAuthCredentials: input.claudeOAuthCredentials ?? null,
  };
}

function isOfficialClaudeMode(activeProfileId: string): boolean {
  return activeProfileId === OFFICIAL_CLAUDE_PROFILE_ID;
}

function normalizeStoredState(
  state: ClaudeStoredStateV3Resolved,
): ClaudeStoredStateV3Resolved {
  const normalizedProfiles = state.profiles
    .map((item) => fromStoredProfile(item))
    .slice(0, MAX_THIRD_PARTY_PROFILES)
    .map((profile) => toStoredProfile(profile));

  const officialSecrets = normalizeOfficialSecrets(state.officialSecrets);
  const officialMode = isOfficialClaudeMode(state.activeProfileId);
  let officialCustomEnv = sanitizeCustomEnvMap(state.officialCustomEnv || {}, {
    skipReservedClaudeKeys: true,
  });

  // Lazy migration: if all profiles have empty customEnv, migrate from legacy global file
  const allEmpty =
    Object.keys(officialCustomEnv).length === 0 &&
    normalizedProfiles.every(
      (p) => !p.customEnv || Object.keys(p.customEnv).length === 0,
    );
  if (allEmpty) {
    try {
      if (fs.existsSync(CLAUDE_CUSTOM_ENV_FILE)) {
        const parsed = JSON.parse(
          fs.readFileSync(CLAUDE_CUSTOM_ENV_FILE, 'utf-8'),
        ) as { customEnv?: Record<string, string> };
        const legacyEnv = sanitizeCustomEnvMap(parsed.customEnv || {}, {
          skipReservedClaudeKeys: true,
        });
        if (Object.keys(legacyEnv).length > 0) {
          if (officialMode) {
            officialCustomEnv = legacyEnv;
          } else {
            // Assign to the active profile
            const activeIdx = normalizedProfiles.findIndex(
              (p) => p.id === state.activeProfileId,
            );
            if (activeIdx >= 0) {
              normalizedProfiles[activeIdx] = {
                ...normalizedProfiles[activeIdx],
                customEnv: legacyEnv,
              };
            }
          }
          logger.info('Migrated legacy global customEnv to active profile');
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to migrate legacy global customEnv');
    }
  }

  if (normalizedProfiles.length === 0) {
    if (officialMode) {
      return {
        activeProfileId: OFFICIAL_CLAUDE_PROFILE_ID,
        profiles: [],
        officialSecrets,
        officialUpdatedAt: state.officialUpdatedAt,
        officialCustomEnv,
      };
    }

    const defaultProfile = toStoredProfile(
      makeDefaultThirdPartyProfile({
        anthropicBaseUrl: '',
        anthropicAuthToken: '',
        anthropicApiKey: '',
        claudeCodeOauthToken: '',
        claudeOAuthCredentials: null,
        anthropicModel: process.env.ANTHROPIC_MODEL || '',
        updatedAt: null,
      }),
    );
    return {
      activeProfileId: defaultProfile.id,
      profiles: [defaultProfile],
      officialSecrets,
      officialUpdatedAt: state.officialUpdatedAt,
      officialCustomEnv,
    };
  }

  const hasActive = normalizedProfiles.some(
    (item) => item.id === state.activeProfileId,
  );
  const activeProfileId = officialMode
    ? OFFICIAL_CLAUDE_PROFILE_ID
    : hasActive
      ? state.activeProfileId
      : normalizedProfiles[0].id;

  return {
    activeProfileId,
    profiles: normalizedProfiles,
    officialSecrets,
    officialUpdatedAt: state.officialUpdatedAt,
    officialCustomEnv,
  };
}

function readStoredState(): ClaudeStoredStateV3Resolved | null {
  if (!fs.existsSync(CLAUDE_CONFIG_FILE)) return null;
  try {
    const content = fs.readFileSync(CLAUDE_CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;

    if (parsed.version === 3) {
      const v3 = parsed as unknown as StoredClaudeProviderConfigV3;
      const profiles = Array.isArray(v3.profiles) ? v3.profiles : [];
      const officialSecrets = v3.official
        ? decryptSecrets(v3.official.secrets)
        : {
            anthropicAuthToken: '',
            anthropicApiKey: '',
            claudeCodeOauthToken: '',
            claudeOAuthCredentials: null,
          };
      return normalizeStoredState({
        activeProfileId:
          typeof v3.activeProfileId === 'string'
            ? isOfficialClaudeMode(v3.activeProfileId)
              ? OFFICIAL_CLAUDE_PROFILE_ID
              : normalizeProfileId(v3.activeProfileId)
            : DEFAULT_THIRD_PARTY_PROFILE_ID,
        profiles: profiles as StoredClaudeThirdPartyProfileV1[],
        officialSecrets,
        officialUpdatedAt: v3.official?.updatedAt || null,
        officialCustomEnv: v3.official?.customEnv || {},
      });
    }

    if (parsed.version === 2) {
      const v2 = parsed as unknown as StoredClaudeProviderConfigV2;
      const secrets = decryptSecrets(v2.secrets);
      const legacyConfig = buildConfig(
        {
          anthropicBaseUrl: v2.anthropicBaseUrl,
          anthropicAuthToken: secrets.anthropicAuthToken,
          anthropicApiKey: secrets.anthropicApiKey,
          claudeCodeOauthToken: secrets.claudeCodeOauthToken,
          claudeOAuthCredentials: secrets.claudeOAuthCredentials ?? null,
          anthropicModel: process.env.ANTHROPIC_MODEL || '',
        },
        v2.updatedAt || null,
      );
      const profile = toStoredProfile(
        makeDefaultThirdPartyProfile(legacyConfig),
      );
      return normalizeStoredState({
        activeProfileId: profile.id,
        profiles: [profile],
        officialSecrets: {
          anthropicAuthToken: '',
          anthropicApiKey: legacyConfig.anthropicApiKey,
          claudeCodeOauthToken: legacyConfig.claudeCodeOauthToken,
          claudeOAuthCredentials: legacyConfig.claudeOAuthCredentials,
        },
        officialUpdatedAt: legacyConfig.updatedAt,
        officialCustomEnv: {},
      });
    }

    const legacy = readLegacyConfig(parsed as StoredClaudeProviderConfigLegacy);
    const profile = toStoredProfile(makeDefaultThirdPartyProfile(legacy));
    return normalizeStoredState({
      activeProfileId: profile.id,
      profiles: [profile],
      officialSecrets: {
        anthropicAuthToken: '',
        anthropicApiKey: legacy.anthropicApiKey,
        claudeCodeOauthToken: legacy.claudeCodeOauthToken,
        claudeOAuthCredentials: legacy.claudeOAuthCredentials,
      },
      officialUpdatedAt: legacy.updatedAt,
      officialCustomEnv: {},
    });
  } catch (err) {
    logger.error(
      { err, file: CLAUDE_CONFIG_FILE },
      'Failed to read Claude provider config, falling back to defaults',
    );
    return null;
  }
}

// ─── V5 模型配置 Read / Write / CRUD ───────────────────────────

function toStoredProviderV4(
  provider: UnifiedProvider,
  enabled: boolean,
): StoredProviderV4 {
  const secrets: SecretPayload = {
    anthropicAuthToken: provider.anthropicAuthToken || '',
    anthropicApiKey: provider.anthropicApiKey || '',
    claudeCodeOauthToken: provider.claudeCodeOauthToken || '',
    claudeOAuthCredentials: provider.claudeOAuthCredentials ?? null,
    codexOAuthCredentials: provider.codexOAuthCredentials ?? null,
    claudeOAuthAccount: provider.claudeOAuthAccount ?? null,
    claudeOAuthLastRefreshAt: provider.claudeOAuthLastRefreshAt ?? null,
    claudeOAuthLastRefreshError: provider.claudeOAuthLastRefreshError ?? null,
  };
  // Writes from the API are sanitized on the way in; this keeps what the
  // read-time migration deliberately left in place.
  const sanitizedEnv = sanitizeCustomEnvMap(provider.customEnv || {}, {
    skipReservedClaudeKeys: true,
  });
  return {
    id: provider.id,
    name: provider.name,
    type: provider.type,
    enabled,
    weight: 1,
    anthropicBaseUrl: provider.anthropicBaseUrl || '',
    anthropicModel: provider.anthropicModel || '',
    ...(provider.anthropicAuthMode
      ? { anthropicAuthMode: provider.anthropicAuthMode }
      : {}),
    ...(provider.webFetchPreflightPolicy
      ? { webFetchPreflightPolicy: provider.webFetchPreflightPolicy }
      : {}),
    secrets: encryptSecrets(secrets),
    ...(Object.keys(sanitizedEnv).length > 0
      ? { customEnv: sanitizedEnv }
      : {}),
    ...(provider.codexOAuthLastRefreshError
      ? { codexOAuthLastRefreshError: provider.codexOAuthLastRefreshError }
      : {}),
    ...connectionListFields(provider),
    ...(provider.envPrefill === 1 ? { envPrefill: 1 as const } : {}),
    ...(provider.claudeOAuthCredentials && provider.claudeOAuthGrantId
      ? { claudeOAuthGrantId: provider.claudeOAuthGrantId }
      : {}),
    updatedAt: provider.updatedAt || new Date().toISOString(),
  };
}

/**
 * The non-secret model fields of a provider as they are stored and read: a
 * well-formed model list and a preset id this release knows whose endpoint
 * the provider uses (neither for ChatGPT subscriptions), a complete test
 * record. Anything else is dropped, so a
 * hand-edited or newer file never fails to load.
 */
function connectionListFields(provider: {
  anthropicBaseUrl: string;
  anthropicModel: string;
  models?: unknown;
  roles?: unknown;
  presetId?: unknown;
  lastTest?: unknown;
}): Pick<StoredProviderV4, 'models' | 'roles' | 'presetId' | 'lastTest'> {
  const chatGpt = isCodexGatewayProvider(provider);
  const models = chatGpt ? null : normalizeProviderModels(provider.models);
  // Roles name models of this connection; one whose model left the list
  // follows the turn's model again.
  const roles = chatGpt
    ? {}
    : normalizeConnectionModelRoles(
        provider.roles,
        effectiveProviderModels({
          anthropicModel: provider.anthropicModel,
          models: models ?? undefined,
        }),
      );
  // A preset describes one vendor endpoint; moved elsewhere, it no longer
  // applies (its model list address, its models).
  const preset =
    !chatGpt && typeof provider.presetId === 'string'
      ? getModelPreset(provider.presetId)
      : null;
  const presetId =
    preset &&
    normalizeProviderBaseUrl(provider.anthropicBaseUrl) ===
      normalizeProviderBaseUrl(preset.baseUrl)
      ? preset.id
      : null;
  // Absent fields stay undefined, which JSON leaves out of the file.
  return {
    models: models ?? undefined,
    roles: Object.keys(roles).length > 0 ? roles : undefined,
    presetId: presetId ?? undefined,
    lastTest: normalizeProviderTestRecord(provider.lastTest) ?? undefined,
  };
}

function nullableNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

/** A stored test record, or null when any field is missing or malformed. */
export function normalizeProviderTestRecord(
  raw: unknown,
): ProviderTestRecord | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const status = nullableNumber(record.status);
  const latencyMs = nullableNumber(record.latencyMs);
  if (
    typeof record.ok !== 'boolean' ||
    typeof record.at !== 'string' ||
    Number.isNaN(Date.parse(record.at)) ||
    status === undefined ||
    latencyMs === undefined ||
    (record.model !== null && typeof record.model !== 'string')
  ) {
    return null;
  }
  // A code from a newer release reads as UNKNOWN rather than dropping the test.
  const code: ProviderErrorCode | null = record.ok
    ? null
    : (PROVIDER_ERROR_CODES as readonly unknown[]).includes(record.code)
      ? (record.code as ProviderErrorCode)
      : 'UNKNOWN';
  return {
    ok: record.ok,
    code,
    status,
    model: record.model as string | null,
    latencyMs,
    at: record.at,
  };
}

const MAX_REFRESH_ERROR_MESSAGE_LENGTH = 300;

/** 只接受结构完整的刷新失败记录；手改或损坏的字段视为没有失败。 */
function normalizeCodexRefreshErrorState(
  raw: unknown,
): CodexOAuthRefreshErrorState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (record.kind !== 'reauth_required' && record.kind !== 'transient') {
    return null;
  }
  if (typeof record.message !== 'string' || typeof record.at !== 'string') {
    return null;
  }
  // Earlier releases also saved other 4xx answers (e.g. a Cloudflare 403) as
  // needing re-login; the official classification retries those.
  const retired =
    record.kind === 'reauth_required'
      ? retiredCodexReauthReason(record.message)
      : null;
  if (retired) return { kind: 'transient', message: retired, at: record.at };
  return {
    kind: record.kind,
    message: record.message.slice(0, MAX_REFRESH_ERROR_MESSAGE_LENGTH),
    at: record.at,
    ...(record.accessTokenRejected === true
      ? { accessTokenRejected: true }
      : {}),
  };
}

function fromStoredProviderV4(stored: StoredProviderV4): UnifiedProvider {
  const secrets = decryptSecrets(stored.secrets);
  return {
    id: stored.id,
    name: stored.name,
    type: stored.type,
    anthropicBaseUrl: stored.anthropicBaseUrl || '',
    anthropicAuthToken: secrets.anthropicAuthToken || '',
    ...(stored.webFetchPreflightPolicy === 'skip'
      ? { webFetchPreflightPolicy: 'skip' as const }
      : {}),
    ...(normalizeProviderAuthMode(stored.anthropicAuthMode)
      ? {
          anthropicAuthMode: normalizeProviderAuthMode(
            stored.anthropicAuthMode,
          ),
        }
      : {}),
    anthropicModel: stored.anthropicModel || '',
    anthropicApiKey: secrets.anthropicApiKey || '',
    claudeCodeOauthToken: secrets.claudeCodeOauthToken || '',
    claudeOAuthCredentials: secrets.claudeOAuthCredentials ?? null,
    codexOAuthCredentials: secrets.codexOAuthCredentials ?? null,
    claudeOAuthAccount: secrets.claudeOAuthAccount ?? null,
    claudeOAuthLastRefreshAt: secrets.claudeOAuthLastRefreshAt ?? null,
    claudeOAuthLastRefreshError: secrets.claudeOAuthLastRefreshError ?? null,
    codexOAuthLastRefreshError: normalizeCodexRefreshErrorState(
      stored.codexOAuthLastRefreshError,
    ),
    customEnv: sanitizeCustomEnvMap(stored.customEnv || {}, {
      skipReservedClaudeKeys: true,
    }),
    ...connectionListFields({
      ...stored,
      anthropicBaseUrl: stored.anthropicBaseUrl || '',
      anthropicModel: stored.anthropicModel || '',
    }),
    ...(stored.envPrefill === 1 ? { envPrefill: 1 as const } : {}),
    ...(typeof stored.claudeOAuthGrantId === 'string'
      ? { claudeOAuthGrantId: stored.claudeOAuthGrantId }
      : {}),
    updatedAt: stored.updatedAt || '',
  };
}

/** Legacy env keys that named a role, and the role each becomes. */
const LEGACY_ROLE_ENV_KEYS: ReadonlyArray<
  readonly [string, keyof ConnectionModelRoles]
> = [
  ['ANTHROPIC_DEFAULT_HAIKU_MODEL', 'smallFast'],
  ['CLAUDE_CODE_SUBAGENT_MODEL', 'subagent'],
  ['ANTHROPIC_DEFAULT_OPUS_MODEL', 'opus'],
  ['ANTHROPIC_DEFAULT_SONNET_MODEL', 'sonnet'],
];

/**
 * Legacy model keys a connection without a model of its own keeps in its env
 * when it has no entry to carry them: they are not injected (the launch
 * derives these keys), but they are not dropped either.
 */
const UNATTACHED_LEGACY_KEYS = [
  'CLAUDE_CODE_AUTO_COMPACT_WINDOW',
  'CLAUDE_CODE_EFFORT_LEVEL',
] as const;

/** The legacy keys a connection's env still keeps (see above). */
function keptLegacyEnv(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    UNATTACHED_LEGACY_KEYS.filter((key) => env[key]?.trim()).map((key) => [
      key,
      env[key],
    ]),
  );
}

/** Connections whose kept legacy keys were already logged this process. */
const loggedUnattachedLegacyKeys = new Set<string>();

/**
 * Moves what a connection saved before models carried their window and
 * efforts into the structured fields, in place; true when anything changed.
 * Run again on its own output it changes nothing.
 *
 * - `[1m]` on a model name becomes that entry's 1M window.
 * - A legacy haiku/sub-agent/opus/sonnet key becomes a role; a model the
 *   connection does not list yet is added for it.
 * - CLAUDE_CODE_AUTO_COMPACT_WINDOW and CLAUDE_CODE_EFFORT_LEVEL applied to
 *   every launch, so they go to every entry that declares no window or
 *   default effort. A compact window below 1M replaces a 1M that only came
 *   from `[1m]` (it lowered that ceiling). An effort the registry knows
 *   nothing about declares every effort, so the default stays usable.
 * - A connection with an endpoint gets CONNECTION_ENV_PREFILL once, where its
 *   env has no value, so the runtime defaults it ran with keep applying.
 */
function migrateConnectionModelFields(
  provider: UnifiedProvider,
  storedModelIds: readonly unknown[] = [],
): boolean {
  const env = provider.customEnv;
  const legacyKeys = CONNECTION_MODEL_ENV_KEYS.filter((key) =>
    Object.hasOwn(env, key),
  );
  const { model, oneMillion } = splitOneMillionSuffix(provider.anthropicModel);
  const needsPrefill = provider.envPrefill !== 1;
  if (!oneMillion && legacyKeys.length === 0 && !needsPrefill) return false;
  const before = JSON.stringify([
    provider.anthropicModel,
    provider.models,
    provider.roles,
    env,
    provider.envPrefill,
  ]);

  if (!isCodexGatewayProvider(provider)) {
    let models = model
      ? effectiveProviderModels({
          anthropicModel: model,
          models: provider.models,
        })
      : [...(provider.models ?? [])];
    /**
     * Ids named with `[1m]` (the connection's model, a role key, or the
     * stored list): their 1M is a ceiling a compact window lowers. A 1M the
     * user declared as a window is theirs and stays.
     */
    const oneMillionIds = new Set<string>(oneMillion ? [model] : []);
    for (const id of storedModelIds) {
      if (typeof id !== 'string') continue;
      const named = splitOneMillionSuffix(id);
      if (named.oneMillion) oneMillionIds.add(named.model);
    }
    const legacyRoles: Record<string, string> = {};
    for (const [key, role] of LEGACY_ROLE_ENV_KEYS) {
      const named = splitOneMillionSuffix(env[key]?.trim() ?? '');
      if (!named.model || named.model === model) continue;
      if (!isValidModelId(named.model)) continue;
      if (!models.some((entry) => entry.id === named.model)) {
        if (models.length >= MAX_PROVIDER_MODELS) continue;
        models.push({ id: named.model });
      }
      legacyRoles[role] = named.model;
      if (named.oneMillion) oneMillionIds.add(named.model);
    }
    models = models.map((entry) =>
      oneMillionIds.has(entry.id) && !entry.contextWindow
        ? { ...entry, contextWindow: ONE_MILLION_CONTEXT }
        : entry,
    );

    const compact = normalizeContextWindow(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
    const effort = env.CLAUDE_CODE_EFFORT_LEVEL?.trim();
    const attached = models.length > 0;
    if (attached && compact) {
      models = models.map((entry) =>
        !entry.contextWindow ||
        (oneMillionIds.has(entry.id) &&
          entry.contextWindow === ONE_MILLION_CONTEXT &&
          compact < ONE_MILLION_CONTEXT)
          ? { ...entry, contextWindow: compact }
          : entry,
      );
    }
    if (attached && isModelEffort(effort)) {
      models = models.map((entry) => {
        if (entry.defaultEffort) return entry;
        const { efforts } = resolveModelCapabilities(entry);
        if (efforts.length === 0) {
          return {
            ...entry,
            efforts: [...MODEL_EFFORTS],
            defaultEffort: effort,
          };
        }
        return efforts.includes(effort)
          ? { ...entry, defaultEffort: effort }
          : entry;
      });
    }
    const roles = {
      ...normalizeConnectionModelRoles(legacyRoles, models),
      ...(provider.roles ?? {}),
    };
    // A connection without a list keeps none unless the migration added to
    // what its one model implies.
    const implied = model ? [{ id: model }] : [];
    if (provider.models || JSON.stringify(models) !== JSON.stringify(implied)) {
      provider.models = models;
    }
    provider.roles = Object.keys(roles).length > 0 ? roles : undefined;

    const kept = attached
      ? []
      : UNATTACHED_LEGACY_KEYS.filter((key) => env[key]?.trim());
    for (const key of legacyKeys) {
      if (!(kept as readonly string[]).includes(key)) delete env[key];
    }
    if (kept.length > 0 && !loggedUnattachedLegacyKeys.has(provider.id)) {
      loggedUnattachedLegacyKeys.add(provider.id);
      logger.warn(
        { providerId: provider.id, keys: kept },
        'Model connection without models keeps legacy env keys it can no longer inject',
      );
    }
  } else {
    for (const key of legacyKeys) delete env[key];
  }
  provider.anthropicModel = model;
  if (needsPrefill) {
    if (provider.anthropicBaseUrl) {
      for (const [key, value] of Object.entries(CONNECTION_ENV_PREFILL)) {
        if (!env[key]?.trim()) env[key] = value;
      }
    }
    provider.envPrefill = 1;
  }
  return (
    JSON.stringify([
      provider.anthropicModel,
      provider.models,
      provider.roles,
      env,
      provider.envPrefill,
    ]) !== before
  );
}

/**
 * Runs migrateConnectionModelFields over every provider; true when the file
 * should be rewritten: a provider changed, or a stored model list or roles
 * were in an older shape than they read as (`[1m]` ids, `hidden`, `effort`).
 */
function migrateConnectionsInPlace(
  providers: UnifiedProvider[],
  stored?: ReadonlyArray<StoredProviderV4>,
): boolean {
  let changed = false;
  providers.forEach((provider, index) => {
    const raw = stored?.[index];
    if (
      raw &&
      (JSON.stringify(raw.models) !== JSON.stringify(provider.models) ||
        JSON.stringify(raw.roles) !== JSON.stringify(provider.roles))
    ) {
      changed = true;
    }
    const storedIds = Array.isArray(raw?.models)
      ? raw.models.map((entry: unknown) =>
          typeof entry === 'string'
            ? entry
            : (entry as { id?: unknown } | null)?.id,
        )
      : [];
    if (migrateConnectionModelFields(provider, storedIds)) changed = true;
  });
  return changed;
}

/** Migrate V3 stored state to V4 unified provider list */
function migrateV3toV4(v3: ClaudeStoredStateV3Resolved): StoredStateV5 {
  const providers: UnifiedProvider[] = [];
  const enabled = new Set<string>();
  const now = new Date().toISOString();

  // 1. Official credentials → official provider (if any secret present)
  const hasOfficial =
    !!v3.officialSecrets.anthropicApiKey ||
    !!v3.officialSecrets.claudeCodeOauthToken ||
    !!v3.officialSecrets.claudeOAuthCredentials;
  if (hasOfficial) {
    providers.push({
      id: OFFICIAL_CLAUDE_PROFILE_ID,
      name: '官方 Claude',
      type: 'official',
      anthropicBaseUrl: '',
      anthropicAuthToken: '',
      anthropicModel: '',
      anthropicApiKey: v3.officialSecrets.anthropicApiKey,
      claudeCodeOauthToken: v3.officialSecrets.claudeCodeOauthToken,
      claudeOAuthCredentials: v3.officialSecrets.claudeOAuthCredentials ?? null,
      codexOAuthCredentials: null,
      customEnv: v3.officialCustomEnv || {},
      updatedAt: v3.officialUpdatedAt || now,
    });
    if (isOfficialClaudeMode(v3.activeProfileId)) {
      enabled.add(OFFICIAL_CLAUDE_PROFILE_ID);
    }
  }

  // 2. Each third-party profile → third_party provider
  for (const stored of v3.profiles) {
    const profile = fromStoredProfile(stored);
    providers.push({
      id: profile.id,
      name: profile.name,
      type: 'third_party',
      anthropicBaseUrl: profile.anthropicBaseUrl,
      anthropicAuthToken: profile.anthropicAuthToken,
      anthropicModel: profile.anthropicModel,
      anthropicApiKey: '',
      claudeCodeOauthToken: '',
      claudeOAuthCredentials: null,
      codexOAuthCredentials: null,
      customEnv: profile.customEnv || {},
      updatedAt: profile.updatedAt || now,
    });
    if (profile.id === v3.activeProfileId) enabled.add(profile.id);
  }

  // 3. A provider-pool.json in pool mode says which members were enabled.
  let balancing: StoredBalancing = { ...LEGACY_BALANCING };
  try {
    if (fs.existsSync(POOL_CONFIG_FILE)) {
      const poolContent = fs.readFileSync(POOL_CONFIG_FILE, 'utf-8');
      const pool = JSON.parse(poolContent) as Record<string, unknown>;
      if (pool.version === 1 && pool.mode === 'pool') {
        const members = pool.members as Array<{
          profileId: string;
          enabled: boolean;
        }>;
        if (Array.isArray(members)) {
          for (const member of members) {
            if (!providers.some((p) => p.id === member.profileId)) continue;
            if (member.enabled) enabled.add(member.profileId);
            else enabled.delete(member.profileId);
          }
        }
        balancing = {
          ...balancing,
          ...(typeof pool.strategy === 'string'
            ? { strategy: pool.strategy }
            : {}),
          ...(typeof pool.unhealthyThreshold === 'number'
            ? { unhealthyThreshold: pool.unhealthyThreshold }
            : {}),
          ...(typeof pool.recoveryIntervalMs === 'number'
            ? { recoveryIntervalMs: pool.recoveryIntervalMs }
            : {}),
        };
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to read provider-pool.json during migration');
  }

  // 4. Older releases need at least one enabled provider.
  if (providers.length > 0 && enabled.size === 0) enabled.add(providers[0].id);

  return {
    providers,
    legacy: {
      balancing,
      defaultModelConfigId: null,
      enabledIds: providers.map((p) => p.id).filter((id) => enabled.has(id)),
    },
  };
}

/**
 * What the file keeps from the retired default model and automatic pool:
 * nothing reads it but readLegacyModelDefaults, and saves carry it through
 * so the one-time binding backfill and older releases still find it.
 */
interface LegacyPoolFields {
  balancing: StoredBalancing;
  /** Always the id of an existing provider with a credential, or null. */
  defaultModelConfigId: string | null;
  /** The providers that were enabled, in file order. */
  enabledIds: string[];
}

interface StoredStateV5 {
  providers: UnifiedProvider[];
  legacy: LegacyPoolFields;
}

/** The legacy fields as a V4/V5 file stores them. */
function readLegacyPoolFields(
  file: Pick<StoredClaudeProviderConfigV5, 'providers' | 'balancing'> & {
    defaultModelConfigId?: unknown;
  },
  providers: ReadonlyArray<UnifiedProvider>,
): LegacyPoolFields {
  return {
    balancing:
      file.balancing && typeof file.balancing === 'object'
        ? file.balancing
        : { ...LEGACY_BALANCING },
    defaultModelConfigId: normalizeDefaultModelConfigId(
      providers,
      file.defaultModelConfigId,
    ),
    enabledIds: file.providers
      .filter((stored) => stored.enabled === true)
      .map((stored) => stored.id),
  };
}

/**
 * A pointer is only kept while it names a configuration that exists and holds
 * a credential: a default that was deleted or lost its key stops being one,
 * everywhere at once (the settings page, the guards and the runtime), and is
 * not resurrected by restoring the key.
 */
function normalizeDefaultModelConfigId(
  providers: ReadonlyArray<UnifiedProvider>,
  candidate: unknown,
): string | null {
  if (typeof candidate !== 'string') return null;
  const named = providers.find((provider) => provider.id === candidate);
  return named && providerHasCredentials(named) ? candidate : null;
}

/**
 * Identifiers assigned but not yet saved, by provider id. While the disk
 * refuses the save, every read re-derives the state from the same file, so a
 * fresh random identifier per read would make a grant minted from one read
 * unresolvable through the next. Emptied by the next successful save.
 */
const unsavedGatewayIdentifiers = new Map<string, string>();
/** Reason of the last unsaved-repair warning; null once a save succeeds. */
let unsavedRepairWarning: string | null = null;

/**
 * Legacy subscriptions can predate the internal identifier used to mint grants,
 * and the secrets route can clear it. Fills the gap in place, so callers that
 * pass a provider list to be saved get the identifier saved with it.
 */
function ensureCodexGatewayIdentifiers(providers: UnifiedProvider[]): boolean {
  const created: string[] = [];
  let filled = false;
  for (const provider of providers) {
    if (
      provider.codexOAuthCredentials &&
      isCodexGatewayBaseUrl(provider.anthropicBaseUrl) &&
      !provider.anthropicAuthToken
    ) {
      // This stays encrypted with the provider. Only per-runner grants, never
      // this identifier, authenticate requests to the embedded gateway.
      let identifier = unsavedGatewayIdentifiers.get(provider.id);
      if (!identifier) {
        identifier = crypto.randomBytes(32).toString('hex');
        unsavedGatewayIdentifiers.set(provider.id, identifier);
        created.push(provider.id);
      }
      provider.anthropicAuthToken = identifier;
      filled = true;
    }
  }
  if (created.length > 0) {
    logger.info(
      { providerIds: created },
      'Assigned missing ChatGPT gateway identifiers',
    );
  }
  return filled;
}

/**
 * Decrypted V5 state, valid while the config and key files keep the
 * signatures observed before they were read. The Codex gateway, container
 * launches, status polling and settings routes read the model configuration
 * many times per request; each uncached read re-parsed the file and decrypted
 * every provider.
 */
let storedStateCache: {
  configSig: FileSignature;
  keySig: FileSignature | null;
  observedAt: number;
  state: StoredStateV5;
} | null = null;
/** Bumped by every save, so a read that migrated the file caches nothing. */
let storedStateWriteGeneration = 0;

/**
 * Read V5 config, with automatic V3/V4 migration. Returns a private copy:
 * callers modify the result in place before saving it.
 */
function readStoredStateV4(): StoredStateV5 | null {
  const observedAt = Date.now();
  const configSig = statFileSignature(CLAUDE_CONFIG_FILE);
  if (!configSig) {
    storedStateCache = null;
    return null;
  }
  const keySig = statFileSignature(CLAUDE_CONFIG_KEY_FILE);
  const cached = storedStateCache;
  if (
    cached &&
    sameFileSignature(cached.configSig, configSig) &&
    sameFileSignature(cached.keySig, keySig) &&
    fileSignatureSettled(configSig, cached.observedAt) &&
    fileSignatureSettled(keySig, cached.observedAt)
  ) {
    return structuredClone(cached.state);
  }
  storedStateCache = null;

  const generation = storedStateWriteGeneration;
  const state = readStoredStateV4FromDisk();
  // Migration paths rewrite the file (new signature) and return null on
  // failure; only a plain V5 read is cached, keyed by the pre-read stats.
  if (state && storedStateWriteGeneration === generation) {
    storedStateCache = {
      configSig,
      keySig,
      observedAt,
      state: structuredClone(state),
    };
  }
  return state;
}

function readStoredStateV4FromDisk(): StoredStateV5 | null {
  if (!fs.existsSync(CLAUDE_CONFIG_FILE)) return null;
  try {
    const content = fs.readFileSync(CLAUDE_CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;

    if (parsed.version === 5) {
      const v5 = parsed as unknown as StoredClaudeProviderConfigV5;
      const providers = v5.providers.map(fromStoredProviderV4);
      const modelFieldsMigrated = migrateConnectionsInPlace(
        providers,
        v5.providers,
      );
      const state: StoredStateV5 = {
        providers,
        legacy: readLegacyPoolFields(v5, providers),
      };
      const repairedGatewayIdentifiers =
        ensureCodexGatewayIdentifiers(providers);
      if (
        repairedGatewayIdentifiers ||
        modelFieldsMigrated ||
        Object.hasOwn(v5, 'defaultProviderId')
      ) {
        // Tidying a readable file must not make the whole configuration
        // unreadable: if the disk refuses the write, serve what was read and
        // retry on the next read.
        try {
          writeStoredStateV4(state);
        } catch (err) {
          // Reads are frequent: say so once per distinct failure, not once
          // per read, until a save goes through.
          const reason = err instanceof Error ? err.message : String(err);
          if (reason !== unsavedRepairWarning) {
            unsavedRepairWarning = reason;
            logger.warn(
              { err, file: CLAUDE_CONFIG_FILE },
              'Could not persist the repaired Claude model configuration; using it unsaved',
            );
          }
          return state;
        }
      }
      if (Object.hasOwn(v5, 'defaultProviderId')) {
        logger.info(
          'Removed legacy default model pointer from Claude model configuration',
        );
      }
      if (modelFieldsMigrated) {
        logger.info(
          'Moved model settings of Claude model connections into their model lists',
        );
      }
      return state;
    }

    if (parsed.version === 4) {
      const v4 = parsed as unknown as StoredClaudeProviderConfigV4;
      const providers = v4.providers.map(fromStoredProviderV4);
      migrateConnectionsInPlace(providers, v4.providers);
      const migrated: StoredStateV5 = {
        providers,
        legacy: {
          ...readLegacyPoolFields(v4, providers),
          defaultModelConfigId: null,
        },
      };
      writeStoredStateV4(migrated);
      logger.info('Migrated Claude model configuration from V4 to V5');
      return migrated;
    }

    // V3 or older → read as V3, then migrate
    const v3 = readStoredState();
    if (!v3) return null;

    const migrated = migrateV3toV4(v3);
    migrateConnectionsInPlace(migrated.providers);

    // Auto-save as V5 on first read (lazy migration)
    writeStoredStateV4(migrated);
    logger.info(
      { providerCount: migrated.providers.length },
      'Migrated Claude provider config from V3 to V5',
    );

    return migrated;
  } catch (err) {
    logger.error(
      { err, file: CLAUDE_CONFIG_FILE },
      'Failed to read Claude model configuration V5',
    );
    return null;
  }
}

function writeStoredStateV4({ providers, legacy }: StoredStateV5): void {
  // Fills in place: a subscription created without an identifier, or one whose
  // identifier the secrets route cleared, is saved with a fresh one.
  ensureCodexGatewayIdentifiers(providers);
  // Every save goes through here: drop the decrypted cache first, so the next
  // read decrypts what was actually persisted.
  storedStateCache = null;
  storedStateWriteGeneration++;
  const defaultId = normalizeDefaultModelConfigId(
    providers,
    legacy.defaultModelConfigId,
  );
  const enabled = new Set(legacy.enabledIds);
  const payload: StoredClaudeProviderConfigV5 = {
    version: 5,
    providers: providers.map((provider) =>
      toStoredProviderV4(provider, enabled.has(provider.id)),
    ),
    ...(defaultId ? { defaultModelConfigId: defaultId } : {}),
    balancing: legacy.balancing,
    updatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
  writeSecretFile(CLAUDE_CONFIG_FILE, JSON.stringify(payload, null, 2) + '\n');
  unsavedGatewayIdentifiers.clear();
  unsavedRepairWarning = null;
}

// ─── V5 公开 API ─────────────────────────────────────────────

export function getProviders(): UnifiedProvider[] {
  const state = readStoredStateV4();
  return state?.providers ?? [];
}

/**
 * What the file still says about the retired global default and pool, for
 * the one-time binding backfill: the legacy default (only while it names a
 * connection with a credential) and the connections that were enabled, in
 * file order. Nothing else reads these.
 */
export function readLegacyModelDefaults(): {
  defaultModelConfigId: string | null;
  enabledIds: string[];
} {
  const legacy = readStoredStateV4()?.legacy;
  return {
    defaultModelConfigId: legacy?.defaultModelConfigId ?? null,
    enabledIds: legacy?.enabledIds ?? [],
  };
}

/** Drops the legacy default pointer from the file once it has been backfilled. */
export function clearLegacyDefaultModelConfigId(): void {
  const state = readStoredStateV4();
  if (!state || state.legacy.defaultModelConfigId === null) return;
  writeStoredStateV4({
    ...state,
    legacy: { ...state.legacy, defaultModelConfigId: null },
  });
}

type ClaudeAuthKind = 'oauth' | 'setup_token' | 'api_key';

function hasSecretValue(value: string | undefined, fieldName: string): boolean {
  return typeof value === 'string' && normalizeSecret(value, fieldName) !== '';
}

/**
 * The official authentication kind a write selects. Claude Code silently
 * prefers one credential when several are present, so a provider holds at
 * most one kind and supplying two in one write is rejected.
 */
function selectedClaudeAuthKind(
  type: UnifiedProvider['type'],
  input: {
    claudeOAuthCredentials?: ClaudeOAuthCredentials | null;
    claudeCodeOauthToken?: string;
    anthropicApiKey?: string;
    anthropicAuthToken?: string;
  },
): ClaudeAuthKind | null {
  const kinds: ClaudeAuthKind[] = [];
  if (input.claudeOAuthCredentials) kinds.push('oauth');
  if (hasSecretValue(input.claudeCodeOauthToken, 'claudeCodeOauthToken')) {
    kinds.push('setup_token');
  }
  if (
    type === 'official' &&
    (hasSecretValue(input.anthropicApiKey, 'anthropicApiKey') ||
      hasSecretValue(input.anthropicAuthToken, 'anthropicAuthToken'))
  ) {
    kinds.push('api_key');
  }
  if (kinds.length > 1) {
    throw new Error(
      '一次只能设置一种官方认证方式（OAuth 登录凭据、setup-token 或 API Key）',
    );
  }
  return kinds[0] ?? null;
}

/** Validate a credential write before any runtime is touched. */
export function assertSingleClaudeAuthKind(
  type: UnifiedProvider['type'],
  input: Parameters<typeof selectedClaudeAuthKind>[1],
): void {
  selectedClaudeAuthKind(type, input);
}

/** Drop every credential of the kinds the write did not select. */
function applyClaudeAuthKind(
  provider: UnifiedProvider,
  kind: ClaudeAuthKind | null,
): void {
  if (!kind) return;
  if (kind !== 'oauth') provider.claudeOAuthCredentials = null;
  if (kind !== 'setup_token') provider.claudeCodeOauthToken = '';
  if (provider.type === 'official' && kind !== 'api_key') {
    provider.anthropicApiKey = '';
    provider.anthropicAuthToken = '';
  }
}

/**
 * The model list a write leaves a connection with, the connection's own
 * model first. Without a new list, a new connection model joins the current
 * list instead of replacing the old one, so changing it never drops a model
 * by itself. A `[1m]` on the model (an older client) gives its entry the 1M
 * window. Undefined leaves a connection without a list (`anthropicModel`
 * alone), as connections saved before lists existed are.
 */
export function nextProviderModelList(
  current: Pick<
    UnifiedProvider,
    'anthropicBaseUrl' | 'anthropicModel' | 'models'
  > | null,
  next: { anthropicModel: string; models?: readonly ProviderModelEntry[] },
): ProviderModelEntry[] | undefined {
  const { model, oneMillion } = splitOneMillionSuffix(next.anthropicModel);
  const list =
    next.models !== undefined
      ? next.models
      : current && splitOneMillionSuffix(current.anthropicModel).model !== model
        ? effectiveProviderModels(current)
        : current?.models;
  if (!list && !oneMillion) return undefined;
  let models = effectiveProviderModels({
    anthropicModel: model,
    models: list ?? [],
  });
  if (oneMillion) {
    models = models.map((entry) =>
      entry.id === model && !entry.contextWindow
        ? { ...entry, contextWindow: ONE_MILLION_CONTEXT }
        : entry,
    );
  }
  if (models.length > MAX_PROVIDER_MODELS) {
    throw new Error(
      `一个模型配置最多 ${MAX_PROVIDER_MODELS} 个模型，请先移除不用的模型`,
    );
  }
  return models;
}

/** A connection's model as submitted: '' or a valid id, `[1m]` still on. */
function normalizeDefaultModel(input: unknown): string {
  const model = normalizeModel(input);
  if (model && !isValidModelId(model)) {
    throw new Error(`模型名无效：${model}`);
  }
  return model;
}

/** What a connection test sends or probes with besides the endpoint and key. */
function testedConnectionExtras(
  provider: Pick<UnifiedProvider, 'customEnv' | 'roles'>,
): [string, string] {
  return [
    provider.customEnv?.ANTHROPIC_CUSTOM_HEADERS ?? '',
    provider.roles?.smallFast ?? '',
  ];
}

/**
 * What a connection test checks. A renewed OAuth token is the same login; a
 * new login (even into the same account) is not.
 */
function testedConnectionIdentity(provider: UnifiedProvider): string {
  return JSON.stringify([
    provider.type,
    provider.anthropicBaseUrl,
    provider.anthropicAuthMode ?? null,
    provider.anthropicAuthToken,
    provider.anthropicApiKey,
    provider.claudeCodeOauthToken,
    provider.claudeOAuthCredentials
      ? [
          provider.claudeOAuthGrantId ?? null,
          provider.claudeOAuthAccount?.accountUuid ?? null,
        ]
      : null,
    provider.codexOAuthCredentials?.accountId ?? null,
    testedConnectionExtras(provider),
  ]);
}

/**
 * Keep a connection test's outcome with the connection, together with the
 * auth header style the test found for a connection that had none. Nothing
 * is written when the connection's endpoint or credential changed while the
 * test ran, since the outcome describes the old one. Runtime state like a
 * refresh error: `updatedAt` stays.
 */
export function recordProviderTest(
  id: string,
  tested: UnifiedProvider,
  record: ProviderTestRecord,
  authMode?: ProviderAuthMode,
): UnifiedProvider | null {
  const state = readStoredStateV4();
  if (!state) return null;
  const idx = state.providers.findIndex((provider) => provider.id === id);
  if (idx < 0) return null;
  const current = state.providers[idx];
  if (testedConnectionIdentity(current) !== testedConnectionIdentity(tested)) {
    return null;
  }
  state.providers[idx] = {
    ...current,
    lastTest: record,
    ...(authMode && !current.anthropicAuthMode
      ? { anthropicAuthMode: authMode }
      : {}),
  };
  writeStoredStateV4(state);
  return state.providers[idx];
}

export function createProvider(input: {
  name: string;
  type: 'official' | 'third_party';
  anthropicBaseUrl?: string;
  anthropicAuthToken?: string;
  anthropicAuthMode?: ProviderAuthMode;
  webFetchPreflightPolicy?: WebFetchPreflightPolicy;
  anthropicModel?: string;
  anthropicApiKey?: string;
  claudeCodeOauthToken?: string;
  claudeOAuthCredentials?: ClaudeOAuthCredentials | null;
  claudeOAuthAccount?: ClaudeOAuthAccountInfo | null;
  codexOAuthCredentials?: CodexOAuthCredentials | null;
  customEnv?: Record<string, string>;
  models?: ProviderModelEntry[];
  /** Raw roles; those not naming one of the connection's models are dropped. */
  roles?: unknown;
  presetId?: string;
}): UnifiedProvider {
  const authKind = selectedClaudeAuthKind(input.type, input);
  const requestedModel = normalizeDefaultModel(input.anthropicModel ?? '');
  const anthropicModel = splitOneMillionSuffix(requestedModel).model;
  const state: StoredStateV5 = readStoredStateV4() || {
    providers: [],
    legacy: {
      balancing: { ...LEGACY_BALANCING },
      defaultModelConfigId: null,
      enabledIds: [],
    },
  };

  if (state.providers.length >= MAX_PROVIDERS) {
    throw new Error(`最多只能创建 ${MAX_PROVIDERS} 个供应商`);
  }

  const now = new Date().toISOString();
  const provider: UnifiedProvider = {
    id: crypto.randomBytes(8).toString('hex'),
    name: normalizeProfileName(input.name),
    type: input.type,
    ...(input.webFetchPreflightPolicy === 'skip'
      ? { webFetchPreflightPolicy: 'skip' as const }
      : {}),
    anthropicBaseUrl: input.anthropicBaseUrl
      ? normalizeBaseUrl(input.anthropicBaseUrl)
      : '',
    anthropicAuthToken: input.anthropicAuthToken
      ? normalizeSecret(input.anthropicAuthToken, 'anthropicAuthToken')
      : '',
    ...(input.anthropicAuthMode
      ? { anthropicAuthMode: input.anthropicAuthMode }
      : {}),
    anthropicModel,
    anthropicApiKey: input.anthropicApiKey
      ? normalizeSecret(input.anthropicApiKey, 'anthropicApiKey')
      : '',
    claudeCodeOauthToken: input.claudeCodeOauthToken
      ? normalizeSecret(input.claudeCodeOauthToken, 'claudeCodeOauthToken')
      : '',
    claudeOAuthCredentials: input.claudeOAuthCredentials ?? null,
    codexOAuthCredentials: input.codexOAuthCredentials ?? null,
    claudeOAuthAccount: input.claudeOAuthAccount ?? null,
    claudeOAuthLastRefreshAt: null,
    claudeOAuthLastRefreshError: null,
    customEnv: sanitizeCustomEnvMap(
      input.customEnv || {},
      CONNECTION_ENV_WRITE,
    ),
    // The caller's env is the whole env: the prefill is the wizard's to offer.
    envPrefill: 1,
    updatedAt: now,
  };
  Object.assign(
    provider,
    connectionListFields({
      anthropicBaseUrl: provider.anthropicBaseUrl,
      anthropicModel,
      models: nextProviderModelList(null, {
        anthropicModel: requestedModel,
        models: input.models,
      }),
      roles: input.roles,
      presetId: input.presetId,
    }),
  );
  applyClaudeAuthKind(provider, authKind);
  if (provider.claudeOAuthCredentials) {
    provider.claudeOAuthGrantId = crypto.randomBytes(8).toString('hex');
  }

  state.providers.push(provider);
  writeStoredStateV4(state);
  return provider;
}

export function updateProvider(
  id: string,
  patch: {
    name?: string;
    anthropicBaseUrl?: string;
    /** Null forgets the style, so it is inferred from the token again. */
    anthropicAuthMode?: ProviderAuthMode | null;
    webFetchPreflightPolicy?: WebFetchPreflightPolicy;
    anthropicModel?: string;
    customEnv?: Record<string, string>;
    models?: ProviderModelEntry[];
    /** Raw roles replacing the current ones; absent keeps them. */
    roles?: unknown;
    /** Null forgets the preset (the endpoint no longer is the vendor's). */
    presetId?: string | null;
  },
): UnifiedProvider {
  const state = readStoredStateV4();
  if (!state) throw new Error('Claude 配置不存在');

  const idx = state.providers.findIndex((p) => p.id === id);
  if (idx < 0) throw new Error('未找到指定供应商');

  const current = state.providers[idx];
  const requestedModel =
    patch.anthropicModel !== undefined
      ? normalizeDefaultModel(patch.anthropicModel)
      : current.anthropicModel;
  const anthropicModel = splitOneMillionSuffix(requestedModel).model;
  const updated: UnifiedProvider = {
    ...current,
    ...(patch.name !== undefined
      ? { name: normalizeProfileName(patch.name) }
      : {}),
    ...(patch.anthropicBaseUrl !== undefined
      ? { anthropicBaseUrl: normalizeBaseUrl(patch.anthropicBaseUrl) }
      : {}),
    ...(patch.anthropicAuthMode !== undefined
      ? { anthropicAuthMode: patch.anthropicAuthMode ?? undefined }
      : {}),
    // check is the default, kept as an absent field like a stored one.
    ...(patch.webFetchPreflightPolicy !== undefined
      ? {
          webFetchPreflightPolicy:
            patch.webFetchPreflightPolicy === 'skip'
              ? ('skip' as const)
              : undefined,
        }
      : {}),
    anthropicModel,
    ...(patch.customEnv !== undefined
      ? {
          customEnv: {
            ...sanitizeCustomEnvMap(patch.customEnv, CONNECTION_ENV_WRITE),
            // The API never shows these, so a new env cannot mean to drop them.
            ...keptLegacyEnv(current.customEnv),
          },
        }
      : {}),
    updatedAt: new Date().toISOString(),
  };
  Object.assign(
    updated,
    connectionListFields({
      anthropicBaseUrl: updated.anthropicBaseUrl,
      anthropicModel,
      models: nextProviderModelList(current, {
        anthropicModel: requestedModel,
        models: patch.models,
      }),
      roles: patch.roles === undefined ? current.roles : patch.roles,
      presetId:
        patch.presetId === undefined ? current.presetId : patch.presetId,
    }),
  );
  // A test describes the endpoint, header, env and probe it ran against.
  updated.lastTest =
    updated.anthropicBaseUrl === current.anthropicBaseUrl &&
    updated.anthropicAuthMode === current.anthropicAuthMode &&
    JSON.stringify(testedConnectionExtras(updated)) ===
      JSON.stringify(testedConnectionExtras(current))
      ? current.lastTest
      : undefined;

  state.providers[idx] = updated;
  writeStoredStateV4(state);
  return updated;
}

export function updateProviderSecrets(
  id: string,
  secrets: {
    anthropicAuthToken?: string;
    clearAnthropicAuthToken?: boolean;
    anthropicApiKey?: string;
    clearAnthropicApiKey?: boolean;
    claudeCodeOauthToken?: string;
    clearClaudeCodeOauthToken?: boolean;
    claudeOAuthCredentials?: ClaudeOAuthCredentials;
    clearClaudeOAuthCredentials?: boolean;
    /** Account facts for the credentials set by this write. */
    claudeOAuthAccount?: ClaudeOAuthAccountInfo | null;
    codexOAuthCredentials?: CodexOAuthCredentials;
    clearCodexOAuthCredentials?: boolean;
  },
): UnifiedProvider {
  const state = readStoredStateV4();
  if (!state) throw new Error('Claude 配置不存在');

  const idx = state.providers.findIndex((p) => p.id === id);
  if (idx < 0) throw new Error('未找到指定供应商');

  const current = state.providers[idx];
  const authKind = selectedClaudeAuthKind(current.type, secrets);
  const updated = { ...current, updatedAt: new Date().toISOString() };

  if (typeof secrets.anthropicAuthToken === 'string') {
    updated.anthropicAuthToken = normalizeSecret(
      secrets.anthropicAuthToken,
      'anthropicAuthToken',
    );
  } else if (secrets.clearAnthropicAuthToken) {
    updated.anthropicAuthToken = '';
  }

  if (typeof secrets.anthropicApiKey === 'string') {
    updated.anthropicApiKey = normalizeSecret(
      secrets.anthropicApiKey,
      'anthropicApiKey',
    );
  } else if (secrets.clearAnthropicApiKey) {
    updated.anthropicApiKey = '';
  }

  if (typeof secrets.claudeCodeOauthToken === 'string') {
    updated.claudeCodeOauthToken = normalizeSecret(
      secrets.claudeCodeOauthToken,
      'claudeCodeOauthToken',
    );
  } else if (secrets.clearClaudeCodeOauthToken) {
    updated.claudeCodeOauthToken = '';
  }

  if (secrets.claudeOAuthCredentials) {
    updated.claudeOAuthCredentials = secrets.claudeOAuthCredentials;
  } else if (secrets.clearClaudeOAuthCredentials) {
    updated.claudeOAuthCredentials = null;
  }
  applyClaudeAuthKind(updated, authKind);

  if (secrets.codexOAuthCredentials) {
    updated.codexOAuthCredentials = secrets.codexOAuthCredentials;
    // New credentials end any refresh backoff or re-login requirement.
    updated.codexOAuthLastRefreshError = null;
  } else if (secrets.clearCodexOAuthCredentials) {
    updated.codexOAuthCredentials = null;
    updated.codexOAuthLastRefreshError = null;
  }

  // Account facts and refresh state describe one Claude grant. A new or
  // removed credential starts over, which also lifts a needs-re-login state.
  const claudeGrantChanged =
    current.claudeCodeOauthToken !== updated.claudeCodeOauthToken ||
    !sameOAuthCredentials(
      current.claudeOAuthCredentials,
      updated.claudeOAuthCredentials,
    );
  if (claudeGrantChanged || secrets.claudeOAuthAccount !== undefined) {
    updated.claudeOAuthAccount = secrets.claudeOAuthAccount ?? null;
    updated.claudeOAuthLastRefreshAt = null;
    updated.claudeOAuthLastRefreshError = null;
  }
  if (claudeGrantChanged) {
    updated.claudeOAuthGrantId = updated.claudeOAuthCredentials
      ? crypto.randomBytes(8).toString('hex')
      : undefined;
  }
  // The last test vouched for the old credential.
  if (
    claudeGrantChanged ||
    current.anthropicAuthToken !== updated.anthropicAuthToken ||
    current.anthropicApiKey !== updated.anthropicApiKey ||
    !!secrets.codexOAuthCredentials ||
    !!secrets.clearCodexOAuthCredentials
  ) {
    delete updated.lastTest;
  }

  state.providers[idx] = updated;
  writeStoredStateV4(state);
  clearProviderQuotaObservation(id);
  return updated;
}

function oauthCredentialsSnapshot(credentials: ClaudeOAuthCredentials): string {
  return JSON.stringify({
    accessToken: credentials.accessToken,
    refreshToken: credentials.refreshToken,
    expiresAt: credentials.expiresAt,
    scopes: [...new Set(credentials.scopes)].sort(),
    ...(credentials.subscriptionType
      ? { subscriptionType: credentials.subscriptionType }
      : {}),
  });
}

function sameOAuthCredentials(
  left: ClaudeOAuthCredentials | null,
  right: ClaudeOAuthCredentials | null,
): boolean {
  if (!left || !right) return left === right;
  return oauthCredentialsSnapshot(left) === oauthCredentialsSnapshot(right);
}

/** Index of the provider still holding exactly `expected`, or -1. */
function findProviderHoldingOAuth(
  providers: UnifiedProvider[],
  id: string,
  expected: ClaudeOAuthCredentials,
): number {
  const idx = providers.findIndex((provider) => provider.id === id);
  if (idx < 0) throw new Error('未找到指定供应商');
  const currentOauth = buildClaudeAiOauthPayload(
    providerToConfig(providers[idx]),
  );
  if (
    !currentOauth ||
    oauthCredentialsSnapshot(currentOauth) !==
      oauthCredentialsSnapshot(expected)
  ) {
    return -1;
  }
  return idx;
}

/**
 * Persist an SDK-refreshed OAuth credential only if the provider still holds
 * the exact credential snapshot used to start reconciliation. The synchronous
 * read/modify/write is a compare-and-swap boundary inside the Node process, so
 * an admin update or another session refresh cannot be silently overwritten.
 * A successful rotation proves the grant is alive, so it also clears a
 * recorded refresh rejection.
 */
export function updateProviderOAuthCredentialsIfCurrent(
  id: string,
  expected: ClaudeOAuthCredentials,
  refreshed: ClaudeOAuthCredentials,
  options?: { account?: ClaudeOAuthAccountInfo | null },
): boolean {
  const state = readStoredStateV4();
  if (!state) throw new Error('Claude 配置不存在');
  const idx = findProviderHoldingOAuth(state.providers, id, expected);
  if (idx < 0) return false;

  const current = state.providers[idx];
  state.providers[idx] = {
    ...current,
    claudeOAuthCredentials: {
      ...refreshed,
      scopes: [...new Set(refreshed.scopes)].sort(),
    },
    claudeOAuthAccount: options?.account
      ? { ...(current.claudeOAuthAccount ?? {}), ...options.account }
      : (current.claudeOAuthAccount ?? null),
    claudeOAuthLastRefreshAt: Date.now(),
    claudeOAuthLastRefreshError: null,
    updatedAt: new Date().toISOString(),
  };
  writeStoredStateV4(state);
  return true;
}

/**
 * Record a terminal refresh rejection, but only while the provider still
 * holds the credential that was rejected: after a concurrent rotation or an
 * administrator update the old token is expected to fail.
 */
export function markProviderOAuthRefreshFailureIfCurrent(
  id: string,
  expected: ClaudeOAuthCredentials,
  error: ClaudeOAuthRefreshError,
): boolean {
  const state = readStoredStateV4();
  if (!state) throw new Error('Claude 配置不存在');
  const idx = findProviderHoldingOAuth(state.providers, id, expected);
  if (idx < 0) return false;
  state.providers[idx] = {
    ...state.providers[idx],
    claudeOAuthLastRefreshError: error,
  };
  writeStoredStateV4(state);
  return true;
}

function codexOAuthCredentialsSnapshot(
  credentials: CodexOAuthCredentials,
): string {
  return JSON.stringify({
    accessToken: credentials.accessToken,
    refreshToken: credentials.refreshToken,
    expiresAt: credentials.expiresAt,
    accountId: credentials.accountId,
  });
}

/**
 * Persist a gateway-refreshed Codex (ChatGPT 订阅) OAuth credential only if the
 * provider still holds the exact credential snapshot used to start the
 * refresh. Same compare-and-swap boundary as
 * updateProviderOAuthCredentialsIfCurrent above.
 */
export function updateProviderCodexOAuthCredentialsIfCurrent(
  id: string,
  expected: CodexOAuthCredentials,
  refreshed: CodexOAuthCredentials,
): boolean {
  const state = readStoredStateV4();
  if (!state) throw new Error('Claude 配置不存在');
  const idx = state.providers.findIndex((provider) => provider.id === id);
  if (idx < 0) throw new Error('未找到指定供应商');

  const current = state.providers[idx];
  const currentCodexOauth = current.codexOAuthCredentials;
  if (
    !currentCodexOauth ||
    codexOAuthCredentialsSnapshot(currentCodexOauth) !==
      codexOAuthCredentialsSnapshot(expected)
  ) {
    return false;
  }

  state.providers[idx] = {
    ...current,
    codexOAuthCredentials: refreshed,
    codexOAuthLastRefreshError: null,
    updatedAt: new Date().toISOString(),
  };
  writeStoredStateV4(state);
  return true;
}

/**
 * Record (or clear, with null) the gateway's last Codex token refresh failure,
 * guarded by the same credential snapshot as the refresh itself: a failure
 * observed for credentials an admin has since replaced must not mark the new
 * login as needing re-authorization. This is runtime state, so updatedAt and
 * the provider's configuration fields are left untouched.
 */
export function setProviderCodexOAuthRefreshErrorIfCurrent(
  id: string,
  expected: CodexOAuthCredentials,
  error: CodexOAuthRefreshErrorState | null,
): boolean {
  const state = readStoredStateV4();
  if (!state) return false;
  const idx = state.providers.findIndex((provider) => provider.id === id);
  if (idx < 0) return false;
  const current = state.providers[idx];
  if (
    !current.codexOAuthCredentials ||
    codexOAuthCredentialsSnapshot(current.codexOAuthCredentials) !==
      codexOAuthCredentialsSnapshot(expected)
  ) {
    return false;
  }
  const normalized = error ? normalizeCodexRefreshErrorState(error) : null;
  if (
    JSON.stringify(current.codexOAuthLastRefreshError ?? null) ===
    JSON.stringify(normalized)
  ) {
    return true;
  }
  state.providers[idx] = {
    ...current,
    codexOAuthLastRefreshError: normalized,
  };
  writeStoredStateV4(state);
  return true;
}

/** Whether a stored provider routes through the embedded ChatGPT/Codex gateway. */
export function isCodexGatewayProvider(
  provider: Pick<UnifiedProvider, 'anthropicBaseUrl'>,
): boolean {
  return provider.anthropicBaseUrl === CODEX_GATEWAY_BASE_URL_PLACEHOLDER;
}

/**
 * The reasoning effort a Codex provider uses when the Agent does not set one.
 * Shared by the settings payload and the gateway so both always agree.
 */
export function resolveCodexProviderDefaultEffort(
  provider: Pick<UnifiedProvider, 'anthropicModel' | 'customEnv'>,
): string {
  return resolveCodexDefaultEffort(
    getResolvedCodexCatalog().models,
    normalizeLegacyCodexModel(provider.anthropicModel || ''),
    provider.customEnv?.CODEX_REASONING_EFFORT,
  );
}

export function getProviderById(id: string): UnifiedProvider | null {
  return getProviders().find((provider) => provider.id === id) ?? null;
}

/** Whether a provider holds a credential its runtime can authenticate with. */
export function providerHasCredentials(provider: UnifiedProvider): boolean {
  if (provider.codexOAuthCredentials) return true;
  if (provider.type === 'third_party') {
    return !!(provider.anthropicAuthToken || provider.anthropicApiKey);
  }
  return !!(
    provider.anthropicApiKey ||
    provider.anthropicAuthToken ||
    provider.claudeCodeOauthToken ||
    provider.claudeOAuthCredentials
  );
}

/**
 * Copy a provider together with its encrypted secrets right after the
 * original. OAuth providers are refused: two configurations rotating one
 * refresh token would invalidate each other on the first refresh.
 */
export function duplicateProvider(id: string): UnifiedProvider {
  const state = readStoredStateV4();
  if (!state) throw new Error('Claude 配置不存在');

  const idx = state.providers.findIndex((p) => p.id === id);
  if (idx < 0) throw new Error('未找到指定供应商');
  if (state.providers.length >= MAX_PROVIDERS) {
    throw new Error(`最多只能创建 ${MAX_PROVIDERS} 个供应商`);
  }

  const source = state.providers[idx];
  if (source.codexOAuthCredentials || source.claudeOAuthCredentials) {
    throw new Error(
      'OAuth 授权的模型配置不能复制：两份配置轮换同一个刷新令牌会互相失效，请新建后重新授权',
    );
  }
  const suffix = ' (副本)';
  const copy: UnifiedProvider = {
    ...structuredClone(source),
    id: crypto.randomBytes(8).toString('hex'),
    name: `${source.name.slice(0, 64 - suffix.length)}${suffix}`,
    updatedAt: new Date().toISOString(),
  };
  state.providers.splice(idx + 1, 0, copy);
  writeStoredStateV4(state);
  return copy;
}

export function deleteProvider(id: string): void {
  const state = readStoredStateV4();
  if (!state) throw new Error('Claude 配置不存在');

  const idx = state.providers.findIndex((p) => p.id === id);
  if (idx < 0) throw new Error('未找到指定供应商');

  state.providers.splice(idx, 1);
  writeStoredStateV4(state);
  clearProviderQuotaObservation(id);
}

/** Convert a UnifiedProvider to the flat ClaudeProviderConfig used by container runner */
export function providerToConfig(
  provider: UnifiedProvider,
): ClaudeProviderConfig {
  return {
    anthropicBaseUrl: provider.anthropicBaseUrl,
    anthropicAuthToken: provider.anthropicAuthToken,
    ...(provider.anthropicAuthMode
      ? { anthropicAuthMode: provider.anthropicAuthMode }
      : {}),
    anthropicApiKey: provider.anthropicApiKey,
    claudeCodeOauthToken: provider.claudeCodeOauthToken,
    claudeOAuthCredentials: provider.claudeOAuthCredentials,
    anthropicModel: provider.anthropicModel,
    ...(provider.models ? { models: provider.models } : {}),
    ...(provider.roles ? { roles: provider.roles } : {}),
    updatedAt: provider.updatedAt,
  };
}

/** Convert UnifiedProvider to public (masked) representation */
export function toPublicProvider(
  provider: UnifiedProvider,
): UnifiedProviderPublic {
  return {
    id: provider.id,
    name: provider.name,
    type: provider.type,
    anthropicBaseUrl: provider.anthropicBaseUrl,
    anthropicModel: provider.anthropicModel,
    anthropicAuthMode: provider.anthropicAuthMode ?? null,
    webFetchPreflightPolicy: provider.webFetchPreflightPolicy ?? 'check',
    hasAnthropicAuthToken: !!provider.anthropicAuthToken,
    anthropicAuthTokenMasked: maskSecret(provider.anthropicAuthToken),
    hasAnthropicApiKey: !!provider.anthropicApiKey,
    anthropicApiKeyMasked: maskSecret(provider.anthropicApiKey),
    hasClaudeCodeOauthToken: !!provider.claudeCodeOauthToken,
    claudeCodeOauthTokenMasked: maskSecret(provider.claudeCodeOauthToken),
    hasClaudeOAuthCredentials: !!provider.claudeOAuthCredentials,
    claudeOAuthCredentialsExpiresAt:
      provider.claudeOAuthCredentials?.expiresAt ?? null,
    claudeOAuthCredentialsAccessTokenMasked: provider.claudeOAuthCredentials
      ? maskSecret(provider.claudeOAuthCredentials.accessToken)
      : null,
    hasCodexOAuthCredentials: !!provider.codexOAuthCredentials,
    codexOAuthCredentialsExpiresAt:
      provider.codexOAuthCredentials?.expiresAt ?? null,
    codexOAuthCredentialsEmail: provider.codexOAuthCredentials?.email ?? null,
    codexOAuthCredentialsPlanType:
      provider.codexOAuthCredentials?.planType ?? null,
    claudeAuthKind: claudeAuthKindOf(provider),
    claudeOAuthAccountEmail: provider.claudeOAuthAccount?.emailAddress ?? null,
    claudeOAuthOrganizationName:
      provider.claudeOAuthAccount?.organizationName ?? null,
    claudeOAuthOrganizationUuid:
      provider.claudeOAuthAccount?.organizationUuid ?? null,
    claudeOAuthSubscriptionType:
      provider.claudeOAuthCredentials?.subscriptionType ??
      provider.claudeOAuthAccount?.subscriptionType ??
      null,
    claudeOAuthScopes: provider.claudeOAuthCredentials
      ? [...provider.claudeOAuthCredentials.scopes]
      : [],
    claudeOAuthLastRefreshAt: provider.claudeOAuthLastRefreshAt ?? null,
    claudeOAuthNeedsReLogin: !!provider.claudeOAuthLastRefreshError,
    claudeOAuthLastRefreshError: provider.claudeOAuthLastRefreshError ?? null,
    codexOAuthNeedsReauth:
      provider.codexOAuthLastRefreshError?.kind === 'reauth_required',
    codexOAuthLastRefreshError: provider.codexOAuthLastRefreshError
      ? {
          kind: provider.codexOAuthLastRefreshError.kind,
          message: provider.codexOAuthLastRefreshError.message,
          at: provider.codexOAuthLastRefreshError.at,
        }
      : null,
    codexDefaultEffort: isCodexGatewayProvider(provider)
      ? resolveCodexProviderDefaultEffort(provider)
      : null,
    models: providerModels(provider),
    roles: provider.roles ?? {},
    presetId: provider.presetId ?? null,
    lastTest: provider.lastTest ?? null,
    customEnv: sanitizeCustomEnvMap(
      provider.customEnv || {},
      CONNECTION_ENV_WRITE,
    ),
    updatedAt: provider.updatedAt,
  };
}

/**
 * The default effort the connection declares for its own model, or null when
 * it declares none (the model's registry default then applies, if any).
 * Nothing is implied by the endpoint: a third-party connection no longer runs
 * at max unless asked to.
 */
export function providerEffortLevel(
  provider: Pick<
    UnifiedProvider,
    'anthropicBaseUrl' | 'anthropicModel' | 'models'
  >,
): ModelEffort | null {
  if (!provider.anthropicModel) return null;
  return (
    findProviderModel(provider, provider.anthropicModel)?.defaultEffort ?? null
  );
}

/**
 * The models a connection offers a conversation or an Agent. ChatGPT
 * subscriptions offer their live catalog instead, which callers read from
 * the catalog.
 */
export function providerModels(
  provider: Pick<
    UnifiedProvider,
    'anthropicBaseUrl' | 'anthropicModel' | 'models'
  >,
): ProviderModelEntry[] {
  return isCodexGatewayProvider(provider)
    ? []
    : effectiveProviderModels(provider);
}

/** The entry for `model` (with or without `[1m]`) in a connection's list. */
export function findProviderModel(
  provider: Pick<
    UnifiedProvider,
    'anthropicBaseUrl' | 'anthropicModel' | 'models'
  >,
  model: string,
): ProviderModelEntry | null {
  return findModelEntry(providerModels(provider), model) ?? null;
}

function claudeAuthKindOf(
  provider: UnifiedProvider,
): UnifiedProviderPublic['claudeAuthKind'] {
  if (provider.type !== 'official') return null;
  if (provider.claudeOAuthCredentials) return 'oauth';
  if (provider.claudeCodeOauthToken) return 'setup_token';
  if (provider.anthropicApiKey || provider.anthropicAuthToken) return 'api_key';
  return null;
}

/**
 * Resolve a provider by ID to { config, customEnv } in a single disk read.
 * Used by container-runner for pool-selected providers.
 */
export function resolveProviderById(providerId: string): {
  config: ClaudeProviderConfig;
  customEnv: Record<string, string>;
} {
  const state = readStoredStateV4();
  if (!state) return { config: defaultsFromEnv(), customEnv: {} };

  const provider = state.providers.find((p) => p.id === providerId);
  if (!provider) {
    logger.warn(
      { providerId },
      'resolveProviderById: provider not found, falling back to the global connection',
    );
    const fallback = selectGlobalProvider(state) || state.providers[0];
    if (!fallback) return { config: defaultsFromEnv(), customEnv: {} };
    return {
      config: providerToConfig(fallback),
      customEnv: fallback.customEnv,
    };
  }

  return {
    config: providerToConfig(provider),
    customEnv: provider.customEnv,
  };
}

function defaultsFromEnv(): ClaudeProviderConfig {
  const raw = {
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || '',
    anthropicAuthToken: process.env.ANTHROPIC_AUTH_TOKEN || '',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    claudeCodeOauthToken: process.env.CLAUDE_CODE_OAUTH_TOKEN || '',
    claudeOAuthCredentials: null,
    anthropicModel: process.env.ANTHROPIC_MODEL || '',
  };

  try {
    return buildConfig(raw, null);
  } catch {
    return {
      anthropicBaseUrl: '',
      anthropicAuthToken: raw.anthropicAuthToken.trim(),
      anthropicApiKey: raw.anthropicApiKey.trim(),
      claudeCodeOauthToken: raw.claudeCodeOauthToken.trim(),
      claudeOAuthCredentials: null,
      anthropicModel: raw.anthropicModel.trim(),
      updatedAt: null,
    };
  }
}

function readStoredFeishuConfig(): FeishuProviderConfig | null {
  if (!fs.existsSync(FEISHU_CONFIG_FILE)) return null;
  const content = fs.readFileSync(FEISHU_CONFIG_FILE, 'utf-8');
  const parsed = JSON.parse(content) as Record<string, unknown>;
  if (parsed.version !== 1) return null;

  const stored = parsed as unknown as StoredFeishuProviderConfigV1;
  const secret = decryptChannelSecret<FeishuSecretPayload>(stored.secret);
  return {
    appId: normalizeFeishuAppId(stored.appId ?? ''),
    appSecret: secret.appSecret,
    enabled: stored.enabled,
    updatedAt: stored.updatedAt || null,
  };
}

function defaultsFeishuFromEnv(): FeishuProviderConfig {
  const raw = {
    appId: process.env.FEISHU_APP_ID || '',
    appSecret: process.env.FEISHU_APP_SECRET || '',
  };
  return {
    appId: raw.appId.trim(),
    appSecret: raw.appSecret.trim(),
    updatedAt: null,
  };
}

export function getFeishuProviderConfigWithSource(): {
  config: FeishuProviderConfig;
  source: FeishuConfigSource;
} {
  try {
    const stored = readStoredFeishuConfig();
    if (stored) return { config: stored, source: 'runtime' };
  } catch (err) {
    logger.warn(
      { err },
      'Failed to read runtime Feishu config, falling back to env',
    );
  }

  const fromEnv = defaultsFeishuFromEnv();
  if (fromEnv.appId || fromEnv.appSecret) {
    return { config: fromEnv, source: 'env' };
  }

  return { config: fromEnv, source: 'none' };
}

export function getFeishuProviderConfig(): FeishuProviderConfig {
  return getFeishuProviderConfigWithSource().config;
}

export function saveFeishuProviderConfig(
  next: Omit<FeishuProviderConfig, 'updatedAt'>,
): FeishuProviderConfig {
  const normalized: FeishuProviderConfig = {
    appId: normalizeFeishuAppId(next.appId),
    appSecret: normalizeSecret(next.appSecret, 'appSecret'),
    enabled: next.enabled,
    updatedAt: new Date().toISOString(),
  };

  const payload: StoredFeishuProviderConfigV1 = {
    version: 1,
    appId: normalized.appId,
    enabled: normalized.enabled,
    updatedAt: normalized.updatedAt || new Date().toISOString(),
    secret: encryptChannelSecret<FeishuSecretPayload>({
      appSecret: normalized.appSecret,
    }),
  };

  fs.mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
  writeSecretFile(FEISHU_CONFIG_FILE, JSON.stringify(payload, null, 2) + '\n');
  return normalized;
}

export function toPublicFeishuProviderConfig(
  config: FeishuProviderConfig,
  source: FeishuConfigSource,
): FeishuProviderPublicConfig {
  return {
    appId: config.appId,
    hasAppSecret: !!config.appSecret,
    appSecretMasked: maskSecret(config.appSecret),
    enabled: config.enabled !== false,
    updatedAt: config.updatedAt,
    source,
  };
}

// ========== Telegram Provider Config ==========

function readStoredTelegramConfig(): TelegramProviderConfig | null {
  if (!fs.existsSync(TELEGRAM_CONFIG_FILE)) return null;
  const content = fs.readFileSync(TELEGRAM_CONFIG_FILE, 'utf-8');
  const parsed = JSON.parse(content) as Record<string, unknown>;
  if (parsed.version !== 1) return null;

  const stored = parsed as unknown as StoredTelegramProviderConfigV1;
  const secret = decryptChannelSecret<TelegramSecretPayload>(stored.secret);
  return {
    botToken: secret.botToken,
    proxyUrl: normalizeTelegramProxyUrl(stored.proxyUrl ?? ''),
    enabled: stored.enabled,
    updatedAt: stored.updatedAt || null,
  };
}

function defaultsTelegramFromEnv(): TelegramProviderConfig {
  const raw = {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    proxyUrl: process.env.TELEGRAM_PROXY_URL || '',
  };
  return {
    botToken: raw.botToken.trim(),
    proxyUrl: normalizeTelegramProxyUrl(raw.proxyUrl),
    updatedAt: null,
  };
}

export function getTelegramProviderConfigWithSource(): {
  config: TelegramProviderConfig;
  source: TelegramConfigSource;
} {
  try {
    const stored = readStoredTelegramConfig();
    if (stored) return { config: stored, source: 'runtime' };
  } catch (err) {
    logger.warn(
      { err },
      'Failed to read runtime Telegram config, falling back to env',
    );
  }

  const fromEnv = defaultsTelegramFromEnv();
  if (fromEnv.botToken) {
    return { config: fromEnv, source: 'env' };
  }

  return { config: fromEnv, source: 'none' };
}

export function getTelegramProviderConfig(): TelegramProviderConfig {
  return getTelegramProviderConfigWithSource().config;
}

export function saveTelegramProviderConfig(
  next: Omit<TelegramProviderConfig, 'updatedAt'>,
): TelegramProviderConfig {
  const normalized: TelegramProviderConfig = {
    botToken: normalizeSecret(next.botToken, 'botToken'),
    proxyUrl: normalizeTelegramProxyUrl(next.proxyUrl),
    enabled: next.enabled,
    updatedAt: new Date().toISOString(),
  };

  const payload: StoredTelegramProviderConfigV1 = {
    version: 1,
    proxyUrl: normalized.proxyUrl,
    enabled: normalized.enabled,
    updatedAt: normalized.updatedAt || new Date().toISOString(),
    secret: encryptChannelSecret<TelegramSecretPayload>({
      botToken: normalized.botToken,
    }),
  };

  fs.mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
  writeSecretFile(
    TELEGRAM_CONFIG_FILE,
    JSON.stringify(payload, null, 2) + '\n',
  );
  return normalized;
}

export function toPublicTelegramProviderConfig(
  config: TelegramProviderConfig,
  source: TelegramConfigSource,
): TelegramProviderPublicConfig {
  return {
    hasBotToken: !!config.botToken,
    botTokenMasked: maskSecret(config.botToken),
    proxyUrl: config.proxyUrl ?? '',
    enabled: config.enabled !== false,
    updatedAt: config.updatedAt,
    source,
  };
}

function maskSecret(value: string): string | null {
  if (!value) return null;
  if (value.length <= 8)
    return `${'*'.repeat(Math.max(value.length - 2, 1))}${value.slice(-2)}`;
  return `${value.slice(0, 3)}${'*'.repeat(Math.max(value.length - 7, 4))}${value.slice(-4)}`;
}

export function toPublicClaudeProviderConfig(
  config: ClaudeProviderConfig,
): ClaudeProviderPublicConfig {
  return {
    anthropicBaseUrl: config.anthropicBaseUrl,
    anthropicModel: config.anthropicModel,
    updatedAt: config.updatedAt,
    hasAnthropicAuthToken: !!config.anthropicAuthToken,
    hasAnthropicApiKey: !!config.anthropicApiKey,
    hasClaudeCodeOauthToken: !!config.claudeCodeOauthToken,
    anthropicAuthTokenMasked: maskSecret(config.anthropicAuthToken),
    anthropicApiKeyMasked: maskSecret(config.anthropicApiKey),
    claudeCodeOauthTokenMasked: maskSecret(config.claudeCodeOauthToken),
    hasClaudeOAuthCredentials: !!config.claudeOAuthCredentials,
    claudeOAuthCredentialsExpiresAt:
      config.claudeOAuthCredentials?.expiresAt ?? null,
    claudeOAuthCredentialsAccessTokenMasked: config.claudeOAuthCredentials
      ? maskSecret(config.claudeOAuthCredentials.accessToken)
      : null,
  };
}

/** Picks the connection host-side calls use; see setGlobalModelConfigResolver. */
let globalModelConfigResolver: (() => string | null) | null = null;

/**
 * Tell the configuration which connection the host's own, non-conversation
 * Claude calls (titles, recall, bug reports, a launch nothing else chose a
 * connection for) run on, e.g. the system main HappyClaw's binding. Without
 * one, or when it names a connection that is gone or has no credential, the
 * first connection holding a credential is used.
 */
export function setGlobalModelConfigResolver(
  resolver: (() => string | null) | null,
): void {
  globalModelConfigResolver = resolver;
}

function selectGlobalProvider(
  state: StoredStateV5,
): UnifiedProvider | undefined {
  let wanted: string | null = null;
  try {
    wanted = globalModelConfigResolver?.() ?? null;
  } catch (err) {
    logger.warn({ err }, 'Global model connection resolver failed');
  }
  const usable = state.providers.filter(providerHasCredentials);
  return (
    usable.find((provider) => provider.id === wanted) ??
    usable[0] ??
    state.providers[0]
  );
}

/** The connection getClaudeProviderConfig() describes, if there is one. */
export function getGlobalProvider(): UnifiedProvider | null {
  const state = readStoredStateV4();
  return (state && selectGlobalProvider(state)) ?? null;
}

class NoModelConnectionError extends Error {
  constructor() {
    super('还没有模型连接，请先在设置里添加模型');
  }
}

export function getClaudeProviderConfig(): ClaudeProviderConfig {
  try {
    const state = readStoredStateV4();
    if (state) {
      const selected = selectGlobalProvider(state);
      if (selected) return providerToConfig(selected);
      throw new NoModelConnectionError();
    }
  } catch (err) {
    if (err instanceof NoModelConnectionError) throw err;
    // Ignore corrupted files and use the legacy environment fallback.
  }
  return defaultsFromEnv();
}

/** Strip control characters from a value before writing to env file (defense-in-depth) */
function sanitizeEnvValue(value: string): string {
  return value.replace(/[\r\n\0]/g, '');
}

function sanitizeCustomEnvValue(key: string, value: string): string {
  if (key === 'ANTHROPIC_CUSTOM_HEADERS') {
    return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\0/g, '');
  }
  return sanitizeEnvValue(value);
}

/** Convert KEY=value lines to shell-safe format by single-quoting values.
 *  Used when writing env files that are `source`d by bash. */
export function shellQuoteEnvLines(lines: string[]): string[] {
  return lines.map((line) => {
    const eqIdx = line.indexOf('=');
    if (eqIdx <= 0) return line;
    const key = line.slice(0, eqIdx);
    const value = line.slice(eqIdx + 1);
    // Escape embedded single quotes: ' → '\''
    const quoted = "'" + value.replace(/'/g, "'\\''") + "'";
    return `${key}=${quoted}`;
  });
}

/**
 * The Claude environment of one launch on `config`. `config.anthropicModel`
 * is the model this launch runs on (callers replace it with a conversation's
 * or an Agent's pick); `config.models` and `config.roles` are the
 * connection's.
 *
 * A third-party endpoint gets the model environment buildConnectionModelEnv
 * derives (tiers, sub-agent model, `[1m]`, compact window) and nothing else
 * implicitly. The official endpoint gets `[1m]` only for an entry that
 * declares a window above 200K: there the suffix is the billed 1M opt-in,
 * which a registry window must not turn on. The connection's env follows,
 * minus empty values, reserved keys and the keys the models decide;
 * CLAUDE_CODE_EFFORT_LEVEL is the effort logic's to add.
 */
export function buildClaudeEnvLines(
  config: ClaudeProviderConfig,
  profileCustomEnv?: Record<string, string>,
): string[] {
  const lines: string[] = [];

  // When full OAuth credentials exist, authentication is handled by .credentials.json file.
  // Only fall back to CLAUDE_CODE_OAUTH_TOKEN env var for legacy single-token mode.
  if (!config.claudeOAuthCredentials && config.claudeCodeOauthToken) {
    lines.push(
      `CLAUDE_CODE_OAUTH_TOKEN=${sanitizeEnvValue(config.claudeCodeOauthToken)}`,
    );
  }
  if (config.anthropicApiKey) {
    lines.push(`ANTHROPIC_API_KEY=${sanitizeEnvValue(config.anthropicApiKey)}`);
  }
  if (config.anthropicBaseUrl) {
    lines.push(
      `ANTHROPIC_BASE_URL=${sanitizeEnvValue(config.anthropicBaseUrl)}`,
    );
  }
  if (config.anthropicAuthToken) {
    const bearerMatch = /^Bearer\s+(.+)$/i.exec(config.anthropicAuthToken);
    // The SDK adds the `Bearer ` prefix itself, so strip a user-supplied one
    // to avoid a doubled `Authorization: Bearer Bearer <token>`.
    const token = bearerMatch ? bearerMatch[1] : config.anthropicAuthToken;
    // An explicit mode wins. Legacy providers keep the old inference: a bare
    // token behind a custom endpoint is sent as `X-Api-Key`, an explicit
    // `Bearer <token>` (or first-party usage) as `Authorization: Bearer`.
    const sendAsApiKey = config.anthropicAuthMode
      ? config.anthropicAuthMode === 'x-api-key'
      : !!config.anthropicBaseUrl && !bearerMatch;
    lines.push(
      sendAsApiKey
        ? `ANTHROPIC_API_KEY=${sanitizeEnvValue(token)}`
        : `ANTHROPIC_AUTH_TOKEN=${sanitizeEnvValue(token)}`,
    );
  }

  const models = effectiveProviderModels({
    anthropicModel: config.anthropicModel,
    models: config.models,
  });
  if (isCodexGatewayEndpoint(config.anthropicBaseUrl)) {
    // A ChatGPT subscription keeps no model list: every tier runs the turn's
    // Codex model as named, except a Claude haiku id that lets the gateway
    // tell Claude Code's background calls apart from agent turns.
    const model = sanitizeEnvValue(config.anthropicModel);
    if (model) {
      lines.push(
        `ANTHROPIC_MODEL=${model}`,
        `ANTHROPIC_DEFAULT_OPUS_MODEL=${model}`,
        `ANTHROPIC_DEFAULT_SONNET_MODEL=${model}`,
        `CLAUDE_CODE_SUBAGENT_MODEL=${model}`,
      );
    }
    lines.push(`ANTHROPIC_DEFAULT_HAIKU_MODEL=${CODEX_GATEWAY_HAIKU_MODEL}`);
  } else if (config.anthropicBaseUrl) {
    const modelEnv = buildConnectionModelEnv({
      model: config.anthropicModel,
      models,
      roles: config.roles,
    });
    for (const [key, value] of Object.entries(modelEnv)) {
      lines.push(`${key}=${sanitizeEnvValue(value)}`);
    }
  } else if (config.anthropicModel) {
    // Declared or `[1m]`-named windows only: on the official endpoint `[1m]`
    // is the billed 1M opt-in, which a registry window must not turn on.
    lines.push(
      `ANTHROPIC_MODEL=${sanitizeEnvValue(
        launchModelName(
          config.anthropicModel,
          windowOf(models, config.anthropicModel),
        ),
      )}`,
    );
  }

  // The selected connection's env when given, else the global connection's.
  const customEnv = profileCustomEnv ?? getActiveProfileCustomEnv();
  for (const [key, value] of Object.entries(customEnv)) {
    if (!value.trim() || isSkippedConnectionEnvKey(key)) continue;
    lines.push(`${key}=${sanitizeCustomEnvValue(key, value)}`);
  }

  return lines;
}

export function getActiveProfileCustomEnv(): Record<string, string> {
  const state = readStoredStateV4();
  if (!state) return {};

  const selected = selectGlobalProvider(state);
  if (!selected) return {};

  return sanitizeCustomEnvMap(selected.customEnv || {}, CONNECTION_ENV_WRITE);
}

export function appendClaudeConfigAudit(
  actor: string,
  action: string,
  changedFields: string[],
  metadata?: Record<string, unknown>,
): void {
  const entry: ClaudeConfigAuditEntry = {
    timestamp: new Date().toISOString(),
    actor,
    action,
    changedFields,
    metadata,
  };
  fs.mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
  // 用 fd + O_APPEND 路径强制 0o600 创建：fs.appendFileSync 不接受 mode 参数，
  // 首次落盘 mode = 0o666 & ~umask（实测 0o644），同主机其他本地账号能读
  // 管理员审计轨迹（用户名 / OAuth 登录时点 / IM 凭据轮换时间窗 = 暴力破解
  // 窗口枚举素材）。和 writeSecretFile 同形态强 0o600。
  const flags =
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_APPEND;
  const fd = fs.openSync(CLAUDE_CONFIG_AUDIT_FILE, flags, 0o600);
  try {
    fs.writeSync(fd, `${JSON.stringify(entry)}\n`);
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* ignore */
    }
  }
  // 自愈历史 0o644 文件：appendFileSync 在升级前已经创建过，单纯切到 fd 路径
  // 只对新文件生效；显式 chmod 保证存量也收紧。
  try {
    fs.chmodSync(CLAUDE_CONFIG_AUDIT_FILE, 0o600);
  } catch {
    /* best effort */
  }
}

/**
 * 记录 IM 通道密钥/配置轮换。复用 claude-provider.audit.log 文件以集中
 * 审计；调用方需提供 channel ('feishu'|'telegram'|...) 和 changedFields
 * （如 ['appSecret','encryptKey']）。同 appendClaudeConfigAudit 一样不抛错。
 */
export function appendImConfigAudit(
  actor: string,
  channel: string,
  action: string,
  changedFields: string[],
  metadata?: Record<string, unknown>,
): void {
  appendClaudeConfigAudit(
    actor,
    `im_${channel}_${action}`,
    changedFields,
    metadata,
  );
}

// ─── Per-container environment config ───────────────────────────

const CONTAINER_ENV_DIR = path.join(DATA_DIR, 'config', 'container-env');

export interface ContainerEnvConfig {
  /** Claude provider overrides — empty string means "use global" */
  anthropicBaseUrl?: string;
  anthropicAuthToken?: string;
  anthropicApiKey?: string;
  claudeCodeOauthToken?: string;
  claudeOAuthCredentials?: ClaudeOAuthCredentials | null;
  anthropicModel?: string;
  /** Arbitrary extra env vars injected into the container */
  customEnv?: Record<string, string>;
}

export interface ContainerEnvPublicConfig {
  anthropicBaseUrl: string;
  anthropicAuthTokenMasked: string | null;
  anthropicApiKeyMasked: string | null;
  claudeCodeOauthTokenMasked: string | null;
  hasAnthropicAuthToken: boolean;
  hasAnthropicApiKey: boolean;
  hasClaudeCodeOauthToken: boolean;
  anthropicModel: string;
  customEnv: Record<string, string>;
}

function containerEnvPath(folder: string): string {
  if (folder.includes('..') || folder.includes('/')) {
    throw new Error('Invalid folder name');
  }
  return path.join(CONTAINER_ENV_DIR, `${folder}.json`);
}

export function getContainerEnvConfig(folder: string): ContainerEnvConfig {
  const filePath = containerEnvPath(folder);
  try {
    if (fs.existsSync(filePath)) {
      const stored = JSON.parse(
        fs.readFileSync(filePath, 'utf-8'),
      ) as ContainerEnvConfig & { happyclawModel?: string };
      // Backward compat: migrate old field name
      if (
        stored.anthropicModel === undefined &&
        stored.happyclawModel !== undefined
      ) {
        stored.anthropicModel = stored.happyclawModel;
        delete stored.happyclawModel;
      }
      return stored;
    }
  } catch (err) {
    logger.warn(
      { err, folder },
      'Failed to read container env config, returning defaults',
    );
  }
  return {};
}

export function saveContainerEnvConfig(
  folder: string,
  config: ContainerEnvConfig,
): void {
  // Sanitize all string fields to prevent env injection
  const sanitized: ContainerEnvConfig = { ...config };
  if (sanitized.anthropicBaseUrl)
    sanitized.anthropicBaseUrl = sanitizeEnvValue(sanitized.anthropicBaseUrl);
  if (sanitized.anthropicAuthToken)
    sanitized.anthropicAuthToken = sanitizeEnvValue(
      sanitized.anthropicAuthToken,
    );
  if (sanitized.anthropicApiKey)
    sanitized.anthropicApiKey = sanitizeEnvValue(sanitized.anthropicApiKey);
  if (sanitized.claudeCodeOauthToken)
    sanitized.claudeCodeOauthToken = sanitizeEnvValue(
      sanitized.claudeCodeOauthToken,
    );
  if (sanitized.anthropicModel)
    sanitized.anthropicModel = sanitizeEnvValue(sanitized.anthropicModel);
  if (sanitized.customEnv) {
    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(sanitized.customEnv)) {
      if (isDangerousEnvKey(k)) {
        logger.warn(
          { key: k },
          'Rejected dangerous env variable in saveContainerEnvConfig',
        );
        continue;
      }
      cleanEnv[k] = sanitizeEnvValue(v);
    }
    sanitized.customEnv = cleanEnv;
  }

  fs.mkdirSync(CONTAINER_ENV_DIR, { recursive: true });
  writeSecretFile(
    containerEnvPath(folder),
    JSON.stringify(sanitized, null, 2) + '\n',
  );
}

export function deleteContainerEnvConfig(folder: string): void {
  const filePath = containerEnvPath(folder);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // ignore
  }
}

export function toPublicContainerEnvConfig(
  config: ContainerEnvConfig,
): ContainerEnvPublicConfig {
  return {
    anthropicBaseUrl: config.anthropicBaseUrl || '',
    hasAnthropicAuthToken: !!config.anthropicAuthToken,
    hasAnthropicApiKey: !!config.anthropicApiKey,
    hasClaudeCodeOauthToken: !!config.claudeCodeOauthToken,
    anthropicAuthTokenMasked: maskSecret(config.anthropicAuthToken || ''),
    anthropicApiKeyMasked: maskSecret(config.anthropicApiKey || ''),
    claudeCodeOauthTokenMasked: maskSecret(config.claudeCodeOauthToken || ''),
    anthropicModel: config.anthropicModel || '',
    customEnv: config.customEnv || {},
  };
}

/**
 * Merge global config with per-container overrides.
 * Non-empty per-container fields override the global value.
 */
export function hasExplicitWorkspaceClaudeAuth(
  override: ContainerEnvConfig,
): boolean {
  return !!(override.anthropicApiKey || override.anthropicAuthToken);
}

export function mergeClaudeEnvConfig(
  global: ClaudeProviderConfig,
  override: ContainerEnvConfig,
): ClaudeProviderConfig {
  const hasExplicitAuth = hasExplicitWorkspaceClaudeAuth(override);
  const merged: ClaudeProviderConfig = {
    anthropicBaseUrl: override.anthropicBaseUrl || global.anthropicBaseUrl,
    // A workspace key/token is an authentication-mode selection, not an
    // independent field overlay. Never combine it with a global credential of
    // another kind or with an inherited Claude OAuth session.
    anthropicAuthToken: hasExplicitAuth
      ? override.anthropicAuthToken || ''
      : override.anthropicAuthToken || global.anthropicAuthToken,
    // The header style belongs to the provider's own token; a workspace token
    // brings no mode and keeps the legacy inference.
    ...(!hasExplicitAuth &&
    !override.anthropicAuthToken &&
    global.anthropicAuthMode
      ? { anthropicAuthMode: global.anthropicAuthMode }
      : {}),
    anthropicApiKey: hasExplicitAuth
      ? override.anthropicApiKey || ''
      : override.anthropicApiKey || global.anthropicApiKey,
    claudeCodeOauthToken: hasExplicitAuth
      ? ''
      : override.claudeCodeOauthToken || global.claudeCodeOauthToken,
    claudeOAuthCredentials: hasExplicitAuth
      ? null
      : (override.claudeOAuthCredentials ?? global.claudeOAuthCredentials),
    anthropicModel: override.anthropicModel || global.anthropicModel,
    // The connection's models and roles describe its own endpoint only.
    ...(!override.anthropicBaseUrl && global.models
      ? { models: global.models }
      : {}),
    ...(!override.anthropicBaseUrl && global.roles
      ? { roles: global.roles }
      : {}),
    updatedAt: global.updatedAt,
  };

  // Third-party provider: strip OAuth credentials so the SDK does not try
  // the OAuth auth path (which skips the standard Bearer header and causes
  // 404 on non-Anthropic endpoints like Kimi).
  if (merged.anthropicBaseUrl) {
    merged.claudeOAuthCredentials = null;
    merged.claudeCodeOauthToken = '';
  }

  return merged;
}

// ─── Registration config (plain JSON, no encryption) ─────────────

const REGISTRATION_CONFIG_FILE = path.join(
  CLAUDE_CONFIG_DIR,
  'registration.json',
);

export interface RegistrationConfig {
  allowRegistration: boolean;
  requireInviteCode: boolean;
  updatedAt: string | null;
}

const DEFAULT_REGISTRATION_CONFIG: RegistrationConfig = {
  allowRegistration: true,
  requireInviteCode: true,
  updatedAt: null,
};

export function getRegistrationConfig(): RegistrationConfig {
  try {
    if (!fs.existsSync(REGISTRATION_CONFIG_FILE)) {
      return { ...DEFAULT_REGISTRATION_CONFIG };
    }
    const raw = JSON.parse(
      fs.readFileSync(REGISTRATION_CONFIG_FILE, 'utf-8'),
    ) as Record<string, unknown>;
    return {
      allowRegistration:
        typeof raw.allowRegistration === 'boolean'
          ? raw.allowRegistration
          : true,
      requireInviteCode:
        typeof raw.requireInviteCode === 'boolean'
          ? raw.requireInviteCode
          : true,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
    };
  } catch (err) {
    logger.warn(
      { err },
      'Failed to read registration config, returning defaults',
    );
    return { ...DEFAULT_REGISTRATION_CONFIG };
  }
}

export function saveRegistrationConfig(
  next: Pick<RegistrationConfig, 'allowRegistration' | 'requireInviteCode'>,
): RegistrationConfig {
  const config: RegistrationConfig = {
    allowRegistration: next.allowRegistration,
    requireInviteCode: next.requireInviteCode,
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
  const tmp = `${REGISTRATION_CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, REGISTRATION_CONFIG_FILE);
  return config;
}

/**
 * Build full env lines: merged Claude config + custom env vars.
 */
export function buildContainerEnvLines(
  global: ClaudeProviderConfig,
  override: ContainerEnvConfig,
  profileCustomEnv?: Record<string, string>,
): string[] {
  const merged = mergeClaudeEnvConfig(global, override);
  const lines = [
    `${CLAUDE_ENDPOINT_KIND_ENV}=${merged.anthropicBaseUrl ? 'custom' : 'official'}`,
    ...buildClaudeEnvLines(merged, profileCustomEnv),
  ];

  // Append custom env vars (with safety sanitization as defense-in-depth)
  if (override.customEnv) {
    for (const [key, value] of Object.entries(override.customEnv)) {
      if (!key || value === undefined) continue;
      if (!ENV_KEY_RE.test(key)) {
        logger.warn(
          { key },
          'Skipping invalid env key in buildContainerEnvLines',
        );
        continue;
      }
      // Block dangerous environment variables
      if (isDangerousEnvKey(key)) {
        logger.warn(
          { key },
          'Blocked dangerous env variable in buildContainerEnvLines',
        );
        continue;
      }
      if (
        RESERVED_CLAUDE_ENV_KEYS.has(key) ||
        (merged.anthropicBaseUrl && THIRD_PARTY_CONFIGURABLE_ENV_KEYS.has(key))
      ) {
        logger.warn(
          { key },
          'Skipping managed Claude environment variable in workspace override',
        );
        continue;
      }
      // Strip control characters to prevent env injection
      const sanitized = sanitizeCustomEnvValue(key, value);
      lines.push(`${key}=${sanitized}`);
    }
  }

  return lines;
}

// ─── OAuth credentials file management ────────────────────────────

/**
 * Build the claudeAiOauth object in the exact shape Claude Code CLI reads,
 * shared by the .credentials.json file and the macOS Keychain entry so the
 * two credential stores can never disagree on content.
 */
export function buildClaudeAiOauthPayload(config: ClaudeProviderConfig): {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  subscriptionType?: string;
} | null {
  const creds = config.claudeOAuthCredentials;
  if (!creds) return null;

  // Claude CLI requires scopes to recognize the token as valid.
  // Fall back to a sensible default when the stored credentials lack scopes
  // (e.g. tokens imported before scopes were captured).
  const scopes = creds.scopes?.length
    ? creds.scopes
    : DEFAULT_CREDENTIAL_SCOPES;

  const claudeAiOauth: ReturnType<typeof buildClaudeAiOauthPayload> = {
    accessToken: creds.accessToken,
    refreshToken: creds.refreshToken,
    expiresAt: creds.expiresAt,
    scopes,
  };
  // Only include subscriptionType when explicitly configured — avoids
  // misleading Claude CLI when the actual subscription tier is unknown.
  if (creds.subscriptionType) {
    claudeAiOauth!.subscriptionType = creds.subscriptionType;
  }
  return claudeAiOauth;
}

/**
 * Write .credentials.json to a Claude session directory.
 * Format matches what Claude Code CLI/Agent SDK natively reads.
 */
export function writeCredentialsFile(
  sessionDir: string,
  config: ClaudeProviderConfig,
): void {
  const claudeAiOauth = buildClaudeAiOauthPayload(config);
  if (!claudeAiOauth) return;

  const credentialsData = { claudeAiOauth };

  const filePath = path.join(sessionDir, '.credentials.json');
  const tmp = `${filePath}.tmp`;
  // 0o600 — credentials 是 plaintext OAuth access/refresh token，
  // 不能让同主机其他本地账号读取（旧版用 0o644 是泄漏）。
  fs.writeFileSync(tmp, JSON.stringify(credentialsData, null, 2) + '\n', {
    encoding: 'utf-8',
    mode: 0o600,
  });
  fs.renameSync(tmp, filePath);
  // 防御性 chmod：rename 在 macOS APFS 上有时会保留旧 inode 的 mode；
  // 显式再 chmod 一次确保最终落地权限严格。
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* ignore — best effort */
  }
}

// ─── Appearance config (plain JSON, no encryption) ────────────────

const APPEARANCE_CONFIG_FILE = path.join(CLAUDE_CONFIG_DIR, 'appearance.json');

export interface AppearanceConfig {
  appName: string;
  aiName: string;
  aiAvatarEmoji: string;
  aiAvatarColor: string;
  aiAvatarUrl: string | null;
  aiAvatarMode: 'brand' | 'emoji';
  // 400x400 square mark shown in the collapsed sidebar rail.
  brandIconUrl: string | null;
  // 600x200 left-aligned wordmark shown above the workspace list.
  brandBannerUrl: string | null;
}

const DEFAULT_APPEARANCE_CONFIG: AppearanceConfig = {
  appName: ASSISTANT_NAME,
  aiName: ASSISTANT_NAME,
  aiAvatarEmoji: '\u{1F431}',
  aiAvatarColor: '#0d9488',
  aiAvatarUrl: null,
  aiAvatarMode: 'brand',
  brandIconUrl: null,
  brandBannerUrl: null,
};

export function getAppearanceConfig(): AppearanceConfig {
  try {
    if (!fs.existsSync(APPEARANCE_CONFIG_FILE)) {
      return { ...DEFAULT_APPEARANCE_CONFIG };
    }
    const raw = JSON.parse(
      fs.readFileSync(APPEARANCE_CONFIG_FILE, 'utf-8'),
    ) as Record<string, unknown>;
    return {
      appName:
        typeof raw.appName === 'string' && raw.appName
          ? raw.appName
          : DEFAULT_APPEARANCE_CONFIG.appName,
      aiName:
        typeof raw.aiName === 'string' && raw.aiName
          ? raw.aiName
          : DEFAULT_APPEARANCE_CONFIG.aiName,
      aiAvatarEmoji:
        typeof raw.aiAvatarEmoji === 'string' && raw.aiAvatarEmoji
          ? raw.aiAvatarEmoji
          : DEFAULT_APPEARANCE_CONFIG.aiAvatarEmoji,
      aiAvatarColor:
        typeof raw.aiAvatarColor === 'string' && raw.aiAvatarColor
          ? raw.aiAvatarColor
          : DEFAULT_APPEARANCE_CONFIG.aiAvatarColor,
      aiAvatarUrl:
        typeof raw.aiAvatarUrl === 'string' && raw.aiAvatarUrl
          ? raw.aiAvatarUrl
          : null,
      aiAvatarMode: raw.aiAvatarMode === 'emoji' ? 'emoji' : 'brand',
      brandIconUrl:
        typeof raw.brandIconUrl === 'string' && raw.brandIconUrl
          ? raw.brandIconUrl
          : null,
      brandBannerUrl:
        typeof raw.brandBannerUrl === 'string' && raw.brandBannerUrl
          ? raw.brandBannerUrl
          : null,
    };
  } catch (err) {
    logger.warn(
      { err },
      'Failed to read appearance config, returning defaults',
    );
    return { ...DEFAULT_APPEARANCE_CONFIG };
  }
}

export function saveAppearanceConfig(
  next: Partial<AppearanceConfig>,
): AppearanceConfig {
  const existing = getAppearanceConfig();
  const config = {
    appName: next.appName || existing.appName,
    aiName: next.aiName || existing.aiName,
    aiAvatarEmoji: next.aiAvatarEmoji || existing.aiAvatarEmoji,
    aiAvatarColor: next.aiAvatarColor || existing.aiAvatarColor,
    aiAvatarUrl:
      next.aiAvatarUrl === undefined ? existing.aiAvatarUrl : next.aiAvatarUrl,
    aiAvatarMode: next.aiAvatarMode ?? existing.aiAvatarMode,
    brandIconUrl:
      next.brandIconUrl === undefined
        ? existing.brandIconUrl
        : next.brandIconUrl,
    brandBannerUrl:
      next.brandBannerUrl === undefined
        ? existing.brandBannerUrl
        : next.brandBannerUrl,
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
  const tmp = `${APPEARANCE_CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, APPEARANCE_CONFIG_FILE);
  return {
    appName: config.appName,
    aiName: config.aiName,
    aiAvatarEmoji: config.aiAvatarEmoji,
    aiAvatarColor: config.aiAvatarColor,
    aiAvatarUrl: config.aiAvatarUrl,
    aiAvatarMode: config.aiAvatarMode,
    brandIconUrl: config.brandIconUrl,
    brandBannerUrl: config.brandBannerUrl,
  };
}

// ─── Per-user IM config (AES-256-GCM encrypted) ─────────────────

const USER_IM_CONFIG_DIR = path.join(DATA_DIR, 'config', 'user-im');

export interface UserFeishuConfig {
  appId: string;
  appSecret: string;
  enabled?: boolean;
  updatedAt: string | null;
  ownerOpenId?: string; // auto-detected from first DM; used as sender_allowlist seed for new groups
  autoIsolateContext?: boolean; // auto-create isolated conversation for each new IM chat
  domain?: FeishuBrand; // Feishu (default) or Lark; picks the platform hosts
}

export interface UserTelegramConfig {
  botToken: string;
  proxyUrl?: string;
  enabled?: boolean;
  updatedAt: string | null;
}

export interface UserQQConfig {
  appId: string;
  appSecret: string;
  enabled?: boolean;
  updatedAt: string | null;
}

export interface UserDingTalkConfig {
  clientId: string;
  clientSecret: string;
  enabled?: boolean;
  streamingMode?: 'card' | 'text';
  updatedAt: string | null;
}

interface StoredDingTalkProviderConfigV1 {
  version: 1;
  clientId: string;
  enabled?: boolean;
  streamingMode?: 'card' | 'text';
  updatedAt: string;
  secret: EncryptedSecrets;
}

interface DingTalkSecretPayload {
  clientSecret: string;
}

export interface UserDiscordConfig {
  botToken: string;
  enabled?: boolean;
  streamingMode?: 'edit' | 'off';
  updatedAt: string | null;
}

interface StoredDiscordProviderConfigV1 {
  version: 1;
  enabled?: boolean;
  streamingMode?: 'edit' | 'off';
  updatedAt: string;
  secret: EncryptedSecrets;
}

interface DiscordSecretPayload {
  botToken: string;
}

interface StoredQQProviderConfigV1 {
  version: 1;
  appId: string;
  enabled?: boolean;
  updatedAt: string;
  secret: EncryptedSecrets;
}

interface QQSecretPayload {
  appSecret: string;
}

function userImDir(userId: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(userId)) {
    throw new Error('Invalid userId');
  }
  return path.join(USER_IM_CONFIG_DIR, userId);
}

export function getUserFeishuConfig(userId: string): UserFeishuConfig | null {
  const filePath = path.join(userImDir(userId), 'feishu.json');
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed.version !== 1) return null;

    const stored = parsed as unknown as StoredFeishuProviderConfigV1;
    const secret = decryptChannelSecret<FeishuSecretPayload>(stored.secret);
    return {
      appId: normalizeFeishuAppId(stored.appId ?? ''),
      appSecret: secret.appSecret,
      enabled: stored.enabled,
      updatedAt: stored.updatedAt || null,
      ownerOpenId: stored.ownerOpenId || undefined,
      autoIsolateContext: stored.autoIsolateContext ?? false,
      domain: stored.domain === 'lark' ? 'lark' : undefined,
    };
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to read user Feishu config');
    return null;
  }
}

export function saveUserFeishuConfig(
  userId: string,
  next: Omit<UserFeishuConfig, 'updatedAt'>,
): UserFeishuConfig {
  const normalized: UserFeishuConfig = {
    appId: normalizeFeishuAppId(next.appId),
    appSecret: normalizeSecret(next.appSecret, 'appSecret'),
    enabled: next.enabled,
    updatedAt: new Date().toISOString(),
    ownerOpenId: next.ownerOpenId,
    autoIsolateContext: next.autoIsolateContext,
    domain: next.domain === 'lark' ? 'lark' : undefined,
  };

  const payload: StoredFeishuProviderConfigV1 = {
    version: 1,
    appId: normalized.appId,
    enabled: normalized.enabled,
    updatedAt: normalized.updatedAt || new Date().toISOString(),
    ownerOpenId: normalized.ownerOpenId,
    autoIsolateContext: normalized.autoIsolateContext,
    domain: normalized.domain,
    secret: encryptChannelSecret<FeishuSecretPayload>({
      appSecret: normalized.appSecret,
    }),
  };

  const dir = userImDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'feishu.json');
  writeSecretFile(filePath, JSON.stringify(payload, null, 2) + '\n');
  return normalized;
}

/**
 * Update only the ownerOpenId in an existing Feishu config file, preserving the encrypted secret.
 */
export function saveFeishuOwnerOpenId(userId: string, openId: string): void {
  const filePath = path.join(userImDir(userId), 'feishu.json');
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    parsed.ownerOpenId = openId;
    writeSecretFile(filePath, JSON.stringify(parsed, null, 2) + '\n');
    logger.info({ userId, openId }, 'Feishu owner open_id saved');
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to save Feishu owner open_id');
  }
}

export function getUserTelegramConfig(
  userId: string,
): UserTelegramConfig | null {
  const filePath = path.join(userImDir(userId), 'telegram.json');
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed.version !== 1) return null;

    const stored = parsed as unknown as StoredTelegramProviderConfigV1;
    const secret = decryptChannelSecret<TelegramSecretPayload>(stored.secret);
    return {
      botToken: secret.botToken,
      proxyUrl: normalizeTelegramProxyUrl(stored.proxyUrl ?? ''),
      enabled: stored.enabled,
      updatedAt: stored.updatedAt || null,
    };
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to read user Telegram config');
    return null;
  }
}

export function saveUserTelegramConfig(
  userId: string,
  next: Omit<UserTelegramConfig, 'updatedAt'>,
): UserTelegramConfig {
  const normalizedProxyUrl = next.proxyUrl
    ? normalizeTelegramProxyUrl(next.proxyUrl)
    : '';
  const normalized: UserTelegramConfig = {
    botToken: normalizeSecret(next.botToken, 'botToken'),
    proxyUrl: normalizedProxyUrl || undefined,
    enabled: next.enabled,
    updatedAt: new Date().toISOString(),
  };

  const payload: StoredTelegramProviderConfigV1 = {
    version: 1,
    proxyUrl: normalizedProxyUrl || undefined,
    enabled: normalized.enabled,
    updatedAt: normalized.updatedAt || new Date().toISOString(),
    secret: encryptChannelSecret<TelegramSecretPayload>({
      botToken: normalized.botToken,
    }),
  };

  const dir = userImDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'telegram.json');
  writeSecretFile(filePath, JSON.stringify(payload, null, 2) + '\n');
  return normalized;
}

// ========== QQ User IM Config ==========

export function getUserQQConfig(userId: string): UserQQConfig | null {
  const filePath = path.join(userImDir(userId), 'qq.json');
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed.version !== 1) return null;

    const stored = parsed as unknown as StoredQQProviderConfigV1;
    const secret = decryptChannelSecret<QQSecretPayload>(stored.secret);
    return {
      appId: normalizeFeishuAppId(stored.appId ?? ''),
      appSecret: secret.appSecret,
      enabled: stored.enabled,
      updatedAt: stored.updatedAt || null,
    };
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to read user QQ config');
    return null;
  }
}

export function saveUserQQConfig(
  userId: string,
  next: Omit<UserQQConfig, 'updatedAt'>,
): UserQQConfig {
  const normalized: UserQQConfig = {
    appId: normalizeFeishuAppId(next.appId),
    appSecret: normalizeSecret(next.appSecret, 'appSecret'),
    enabled: next.enabled,
    updatedAt: new Date().toISOString(),
  };

  const payload: StoredQQProviderConfigV1 = {
    version: 1,
    appId: normalized.appId,
    enabled: normalized.enabled,
    updatedAt: normalized.updatedAt || new Date().toISOString(),
    secret: encryptChannelSecret<QQSecretPayload>({
      appSecret: normalized.appSecret,
    }),
  };

  const dir = userImDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'qq.json');
  writeSecretFile(filePath, JSON.stringify(payload, null, 2) + '\n');
  return normalized;
}

// ========== WeChat User IM Config ==========

export interface UserWeChatConfig {
  botToken: string; // iLink bot_token
  ilinkBotId: string; // bot ID (xxx@im.bot)
  baseUrl?: string; // 默认 https://ilinkai.weixin.qq.com
  cdnBaseUrl?: string; // 默认 https://novac2c.cdn.weixin.qq.com/c2c
  getUpdatesBuf?: string; // 长轮询游标
  bypassProxy?: boolean; // 直连模式：绕过 HTTP 代理（默认 true）
  enabled?: boolean;
  updatedAt: string | null;
}

interface StoredWeChatProviderConfigV1 {
  version: 1;
  ilinkBotId: string;
  baseUrl?: string;
  cdnBaseUrl?: string;
  getUpdatesBuf?: string;
  bypassProxy?: boolean;
  enabled?: boolean;
  updatedAt: string;
  secret: EncryptedSecrets;
}

interface WeChatSecretPayload {
  botToken: string;
}

export function getUserWeChatConfig(userId: string): UserWeChatConfig | null {
  const filePath = path.join(userImDir(userId), 'wechat.json');
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed.version !== 1) return null;

    const stored = parsed as unknown as StoredWeChatProviderConfigV1;
    const secret = decryptChannelSecret<WeChatSecretPayload>(stored.secret);
    return {
      botToken: secret.botToken,
      ilinkBotId: ((stored.ilinkBotId as string) ?? '').trim(),
      baseUrl: stored.baseUrl,
      cdnBaseUrl: stored.cdnBaseUrl,
      getUpdatesBuf: stored.getUpdatesBuf,
      bypassProxy: stored.bypassProxy ?? true, // 默认直连
      enabled: stored.enabled,
      updatedAt: stored.updatedAt || null,
    };
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to read user WeChat config');
    return null;
  }
}

export function saveUserWeChatConfig(
  userId: string,
  next: Omit<UserWeChatConfig, 'updatedAt'>,
): UserWeChatConfig {
  const normalized: UserWeChatConfig = {
    botToken: normalizeSecret(next.botToken, 'botToken'),
    ilinkBotId: (next.ilinkBotId ?? '').trim(),
    baseUrl: next.baseUrl?.trim() || undefined,
    cdnBaseUrl: next.cdnBaseUrl?.trim() || undefined,
    getUpdatesBuf: next.getUpdatesBuf,
    bypassProxy: next.bypassProxy ?? true,
    enabled: next.enabled,
    updatedAt: new Date().toISOString(),
  };

  const payload: StoredWeChatProviderConfigV1 = {
    version: 1,
    ilinkBotId: normalized.ilinkBotId,
    baseUrl: normalized.baseUrl,
    cdnBaseUrl: normalized.cdnBaseUrl,
    getUpdatesBuf: normalized.getUpdatesBuf,
    bypassProxy: normalized.bypassProxy,
    enabled: normalized.enabled,
    updatedAt: normalized.updatedAt || new Date().toISOString(),
    secret: encryptChannelSecret<WeChatSecretPayload>({
      botToken: normalized.botToken,
    }),
  };

  const dir = userImDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'wechat.json');
  writeSecretFile(filePath, JSON.stringify(payload, null, 2) + '\n');
  return normalized;
}

// ========== WhatsApp User IM Config ==========

export interface UserWhatsAppConfig {
  accountId: string;
  phoneNumber: string;
  enabled?: boolean;
  /** Whether the user has completed Baileys QR pairing (set by future PR) */
  paired?: boolean;
  updatedAt: string | null;
}

interface StoredWhatsAppProviderConfigV1 {
  version: 1;
  accountId: string;
  phoneNumber: string;
  enabled?: boolean;
  paired?: boolean;
  updatedAt: string;
}

export function getUserWhatsAppConfig(
  userId: string,
): UserWhatsAppConfig | null {
  const filePath = path.join(userImDir(userId), 'whatsapp.json');
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed.version !== 1) return null;

    const stored = parsed as unknown as StoredWhatsAppProviderConfigV1;
    return {
      accountId: ((stored.accountId as string) ?? 'default').trim(),
      phoneNumber: ((stored.phoneNumber as string) ?? '').trim(),
      enabled: stored.enabled,
      paired: stored.paired,
      updatedAt: stored.updatedAt || null,
    };
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to read user WhatsApp config');
    return null;
  }
}

export function saveUserWhatsAppConfig(
  userId: string,
  next: Omit<UserWhatsAppConfig, 'updatedAt'>,
): UserWhatsAppConfig {
  const normalized: UserWhatsAppConfig = {
    accountId: (next.accountId ?? 'default').trim() || 'default',
    phoneNumber: (next.phoneNumber ?? '').trim(),
    enabled: next.enabled,
    paired: next.paired,
    updatedAt: new Date().toISOString(),
  };

  const payload: StoredWhatsAppProviderConfigV1 = {
    version: 1,
    accountId: normalized.accountId,
    phoneNumber: normalized.phoneNumber,
    enabled: normalized.enabled,
    paired: normalized.paired,
    updatedAt: normalized.updatedAt || new Date().toISOString(),
  };

  const dir = userImDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'whatsapp.json');
  writeSecretFile(filePath, JSON.stringify(payload, null, 2) + '\n');
  return normalized;
}

// ========== DingTalk User IM Config ==========

export function getUserDingTalkConfig(
  userId: string,
): UserDingTalkConfig | null {
  const filePath = path.join(userImDir(userId), 'dingtalk.json');
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed.version !== 1) return null;

    const stored = parsed as unknown as StoredDingTalkProviderConfigV1;
    const secret = decryptChannelSecret<DingTalkSecretPayload>(stored.secret);
    return {
      clientId: ((stored.clientId as string) ?? '').trim(),
      clientSecret: secret.clientSecret,
      enabled: stored.enabled,
      streamingMode: stored.streamingMode === 'text' ? 'text' : 'card',
      updatedAt: stored.updatedAt || null,
    };
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to read user DingTalk config');
    return null;
  }
}

export function saveUserDingTalkConfig(
  userId: string,
  next: Omit<UserDingTalkConfig, 'updatedAt'>,
): UserDingTalkConfig {
  const normalized: UserDingTalkConfig = {
    clientId: ((next.clientId as string) ?? '').trim(),
    clientSecret: normalizeSecret(next.clientSecret, 'clientSecret'),
    enabled: next.enabled,
    streamingMode: next.streamingMode === 'text' ? 'text' : 'card',
    updatedAt: new Date().toISOString(),
  };

  const payload: StoredDingTalkProviderConfigV1 = {
    version: 1,
    clientId: normalized.clientId,
    enabled: normalized.enabled,
    streamingMode: normalized.streamingMode === 'text' ? 'text' : 'card',
    updatedAt: normalized.updatedAt || new Date().toISOString(),
    secret: encryptChannelSecret<DingTalkSecretPayload>({
      clientSecret: normalized.clientSecret,
    }),
  };

  const dir = userImDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'dingtalk.json');
  writeSecretFile(filePath, JSON.stringify(payload, null, 2) + '\n');
  return normalized;
}

// ========== Discord User IM Config ==========

export function getUserDiscordConfig(userId: string): UserDiscordConfig | null {
  const filePath = path.join(userImDir(userId), 'discord.json');
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content) as Record<string, unknown>;
    if (parsed.version !== 1) return null;

    const stored = parsed as unknown as StoredDiscordProviderConfigV1;
    const secret = decryptChannelSecret<DiscordSecretPayload>(stored.secret);
    return {
      botToken: secret.botToken,
      enabled: stored.enabled,
      streamingMode: stored.streamingMode === 'edit' ? 'edit' : 'off',
      updatedAt: stored.updatedAt || null,
    };
  } catch (err) {
    logger.warn({ err, userId }, 'Failed to read user Discord config');
    return null;
  }
}

export function saveUserDiscordConfig(
  userId: string,
  next: Omit<UserDiscordConfig, 'updatedAt'>,
): UserDiscordConfig {
  const normalized: UserDiscordConfig = {
    botToken: normalizeSecret(next.botToken, 'botToken'),
    enabled: next.enabled,
    streamingMode: next.streamingMode === 'edit' ? 'edit' : 'off',
    updatedAt: new Date().toISOString(),
  };

  const payload: StoredDiscordProviderConfigV1 = {
    version: 1,
    enabled: normalized.enabled,
    streamingMode: normalized.streamingMode,
    updatedAt: normalized.updatedAt || new Date().toISOString(),
    secret: encryptChannelSecret<DiscordSecretPayload>({
      botToken: normalized.botToken,
    }),
  };

  const dir = userImDir(userId);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, 'discord.json');
  writeSecretFile(filePath, JSON.stringify(payload, null, 2) + '\n');
  return normalized;
}

// ─── System settings (plain JSON, no encryption) ─────────────────

const SYSTEM_SETTINGS_FILE = path.join(
  CLAUDE_CONFIG_DIR,
  'system-settings.json',
);

export interface SystemSettings {
  containerTimeout: number;
  idleTimeout: number;
  containerMaxOutputSize: number;
  maxConcurrentContainers: number;
  maxLoginAttempts: number;
  loginLockoutMinutes: number;
  // Billing
  billingEnabled: boolean;
  billingMode: 'wallet_first';
  billingMinStartBalanceUsd: number;
  billingCurrency: string;
  billingCurrencyRate: number;
  // External Claude directory (admin only)
  externalClaudeDir: string;
  // 管理员纯宿主机模式：开启后，所有 active admin 拥有的 Workspace/任务
  // 都必须使用 host；普通成员仍保持 container 隔离。
  adminHostOnlyMode: boolean;
  // 默认主 Agent 是否继承宿主机 Claude 配置（仅 admin 生效）。
  mainAgentContextSource: 'managed' | 'host_claude';
  // 兼容旧版固定 token 阈值；新配置使用模型感知的百分比策略。
  mainAgentAutoCompactWindow: number;
  // 0 = 交给 SDK；50-90 = 按当前模型上下文窗口的百分比压缩。
  mainAgentAutoCompactPercentage: number;
  // 撞额度墙自动切模型：主模型在一轮里返回账号用量上限通知（如「You've reached
  // your Fable 5 limit」）时，用该模型（别名或完整 ID）在同一轮无缝重跑一次。
  // 空 = 关闭（保留原行为：把上限通知直接回给用户）。同一 OAuth 账号下不同模型有
  // 独立额度桶，因此 fable→opus 这类回退无需再配置第二个 provider。
  fallbackModel: string;
  // Plugin catalog 自动扫描：true（默认）= 启动 5s 后扫一次 + 每小时一次；
  // false = 关闭定时扫描，admin 仍可手点 POST /api/plugins/catalog/scan。
  // 适用于不希望本机私有 plugin 自动入共享 catalog 的环境。
  pluginAutoScan: boolean;
  // 普通成员能否创建只读访客账号。默认关闭：访客由所有者直接建号，不经过邀请码，
  // 开放给成员等于绕过邀请制注册。关闭时成员已有的访客也一并失效；admin 不受限。
  allowMemberGuests: boolean;
}

// Upper bound for the login lockout window. auth.ts reclaims login-attempt
// records on a fixed 24h TTL (its authoritative window check assumes the
// configured lockout never exceeds this); a larger value would let the cleanup
// timer drop a record mid-lockout, resetting the per-ip counter and letting an
// attacker resume brute-forcing by pausing ~24h. Every read path clamps to it,
// not just saveSystemSettings, so the env/file fallbacks can't bypass the cap.
const MAX_LOGIN_LOCKOUT_MINUTES = 1440;

const DEFAULT_SYSTEM_SETTINGS: SystemSettings = {
  containerTimeout: 1800000,
  idleTimeout: 1800000,
  containerMaxOutputSize: 10485760,
  maxConcurrentContainers: 20,
  maxLoginAttempts: 5,
  loginLockoutMinutes: 15,
  billingEnabled: false,
  billingMode: 'wallet_first',
  billingMinStartBalanceUsd: 0.01,
  billingCurrency: 'USD',
  billingCurrencyRate: 1,
  externalClaudeDir: '',
  adminHostOnlyMode: false,
  mainAgentContextSource: 'host_claude',
  mainAgentAutoCompactWindow: 0,
  mainAgentAutoCompactPercentage: 0,
  fallbackModel: '',
  pluginAutoScan: true,
  allowMemberGuests: false,
};

type SystemSettingsSource = 'file' | 'env' | 'api';

function normalizeSystemSettings(
  raw: Record<string, unknown>,
  source: SystemSettingsSource,
): SystemSettings {
  const invalidFields = new Set<string>();
  const allowStringNumbers = source === 'env';

  const numberField = (
    key: keyof SystemSettings,
    fallback: number,
    min: number,
    max: number,
    integer = true,
  ): number => {
    const value = raw[key];
    if (value === undefined) return fallback;
    const parsed =
      typeof value === 'number'
        ? value
        : allowStringNumbers && typeof value === 'string' && value.trim()
          ? Number(value)
          : NaN;
    if (!Number.isFinite(parsed)) {
      invalidFields.add(String(key));
      return fallback;
    }
    const normalized = integer ? Math.floor(parsed) : parsed;
    const clamped = Math.min(max, Math.max(min, normalized));
    if (clamped !== parsed) invalidFields.add(String(key));
    return clamped;
  };

  const booleanField = (
    key: keyof SystemSettings,
    fallback: boolean,
  ): boolean => {
    const value = raw[key];
    if (value === undefined) return fallback;
    if (typeof value === 'boolean') return value;
    if (source === 'env' && value === 'true') return true;
    if (source === 'env' && value === 'false') return false;
    invalidFields.add(String(key));
    return fallback;
  };

  // Accept the former system-wide key as the main Agent default during upgrade.
  if (
    raw.mainAgentAutoCompactWindow === undefined &&
    raw.autoCompactWindow !== undefined
  ) {
    raw.mainAgentAutoCompactWindow = raw.autoCompactWindow;
  }
  const mainAgentAutoCompactRaw = numberField(
    'mainAgentAutoCompactWindow',
    DEFAULT_SYSTEM_SETTINGS.mainAgentAutoCompactWindow,
    0,
    1_000_000,
  );
  const mainAgentAutoCompactWindow =
    mainAgentAutoCompactRaw === 0
      ? 0
      : Math.max(100_000, mainAgentAutoCompactRaw);
  if (mainAgentAutoCompactWindow !== mainAgentAutoCompactRaw) {
    invalidFields.add('mainAgentAutoCompactWindow');
  }
  const mainAgentAutoCompactPercentageRaw = numberField(
    'mainAgentAutoCompactPercentage',
    DEFAULT_SYSTEM_SETTINGS.mainAgentAutoCompactPercentage,
    0,
    90,
  );
  const mainAgentAutoCompactPercentage =
    mainAgentAutoCompactPercentageRaw === 0
      ? 0
      : Math.max(50, mainAgentAutoCompactPercentageRaw);
  if (mainAgentAutoCompactPercentage !== mainAgentAutoCompactPercentageRaw) {
    invalidFields.add('mainAgentAutoCompactPercentage');
  }

  let fallbackModel = DEFAULT_SYSTEM_SETTINGS.fallbackModel;
  if (raw.fallbackModel !== undefined) {
    if (typeof raw.fallbackModel === 'string') {
      // 空字符串合法（= 关闭撞墙自动切模型），仅去空白并限长。
      fallbackModel = raw.fallbackModel.trim().slice(0, 64);
    } else {
      invalidFields.add('fallbackModel');
    }
  }

  let billingCurrency = DEFAULT_SYSTEM_SETTINGS.billingCurrency;
  if (raw.billingCurrency !== undefined) {
    if (
      typeof raw.billingCurrency === 'string' &&
      raw.billingCurrency.trim().length >= 1 &&
      raw.billingCurrency.trim().length <= 10
    ) {
      billingCurrency = raw.billingCurrency.trim();
    } else {
      invalidFields.add('billingCurrency');
    }
  }

  let externalClaudeDir = DEFAULT_SYSTEM_SETTINGS.externalClaudeDir;
  if (raw.externalClaudeDir !== undefined) {
    if (typeof raw.externalClaudeDir !== 'string') {
      invalidFields.add('externalClaudeDir');
    } else {
      const candidate = raw.externalClaudeDir.trim();
      if (candidate) {
        try {
          const resolved = fs.realpathSync(candidate);
          if (
            !path.isAbsolute(candidate) ||
            !fs.statSync(resolved).isDirectory()
          ) {
            invalidFields.add('externalClaudeDir');
          } else {
            externalClaudeDir = resolved;
          }
        } catch {
          invalidFields.add('externalClaudeDir');
        }
      }
    }
  }

  let mainAgentContextSource = DEFAULT_SYSTEM_SETTINGS.mainAgentContextSource;
  if (raw.mainAgentContextSource !== undefined) {
    if (
      raw.mainAgentContextSource === 'managed' ||
      raw.mainAgentContextSource === 'host_claude'
    ) {
      mainAgentContextSource = raw.mainAgentContextSource;
    } else {
      invalidFields.add('mainAgentContextSource');
    }
  }

  const normalized: SystemSettings = {
    containerTimeout: numberField(
      'containerTimeout',
      DEFAULT_SYSTEM_SETTINGS.containerTimeout,
      60_000,
      86_400_000,
    ),
    idleTimeout: numberField(
      'idleTimeout',
      DEFAULT_SYSTEM_SETTINGS.idleTimeout,
      60_000,
      86_400_000,
    ),
    containerMaxOutputSize: numberField(
      'containerMaxOutputSize',
      DEFAULT_SYSTEM_SETTINGS.containerMaxOutputSize,
      1_048_576,
      104_857_600,
    ),
    maxConcurrentContainers: numberField(
      'maxConcurrentContainers',
      DEFAULT_SYSTEM_SETTINGS.maxConcurrentContainers,
      1,
      100,
    ),
    maxLoginAttempts: numberField(
      'maxLoginAttempts',
      DEFAULT_SYSTEM_SETTINGS.maxLoginAttempts,
      1,
      100,
    ),
    loginLockoutMinutes: numberField(
      'loginLockoutMinutes',
      DEFAULT_SYSTEM_SETTINGS.loginLockoutMinutes,
      1,
      MAX_LOGIN_LOCKOUT_MINUTES,
    ),
    billingEnabled: booleanField(
      'billingEnabled',
      DEFAULT_SYSTEM_SETTINGS.billingEnabled,
    ),
    billingMode: 'wallet_first',
    billingMinStartBalanceUsd: numberField(
      'billingMinStartBalanceUsd',
      DEFAULT_SYSTEM_SETTINGS.billingMinStartBalanceUsd,
      0,
      1_000_000,
      false,
    ),
    billingCurrency,
    billingCurrencyRate: numberField(
      'billingCurrencyRate',
      DEFAULT_SYSTEM_SETTINGS.billingCurrencyRate,
      0.0001,
      1_000_000,
      false,
    ),
    externalClaudeDir,
    adminHostOnlyMode: booleanField(
      'adminHostOnlyMode',
      DEFAULT_SYSTEM_SETTINGS.adminHostOnlyMode,
    ),
    mainAgentContextSource,
    mainAgentAutoCompactWindow:
      mainAgentAutoCompactPercentage > 0 ? 0 : mainAgentAutoCompactWindow,
    mainAgentAutoCompactPercentage,
    fallbackModel,
    pluginAutoScan: booleanField(
      'pluginAutoScan',
      DEFAULT_SYSTEM_SETTINGS.pluginAutoScan,
    ),
    allowMemberGuests: booleanField(
      'allowMemberGuests',
      DEFAULT_SYSTEM_SETTINGS.allowMemberGuests,
    ),
  };

  if (invalidFields.size > 0) {
    logger.warn(
      { source, invalidFields: Array.from(invalidFields).sort() },
      'Normalized invalid system settings',
    );
  }
  return normalized;
}

// In-memory cache: avoid synchronous file I/O on hot paths (stdout data handler, queue capacity check)
let _settingsCache: SystemSettings | null = null;
let _settingsMtimeMs = 0;

function readSystemSettingsFromFile(): SystemSettings | null {
  if (!fs.existsSync(SYSTEM_SETTINGS_FILE)) return null;
  const raw = JSON.parse(
    fs.readFileSync(SYSTEM_SETTINGS_FILE, 'utf-8'),
  ) as Record<string, unknown>;
  return normalizeSystemSettings(raw, 'file');
}

function buildEnvFallbackSettings(): SystemSettings {
  return normalizeSystemSettings(
    {
      containerTimeout: process.env.CONTAINER_TIMEOUT,
      idleTimeout: process.env.IDLE_TIMEOUT,
      containerMaxOutputSize: process.env.CONTAINER_MAX_OUTPUT_SIZE,
      maxConcurrentContainers: process.env.MAX_CONCURRENT_CONTAINERS,
      maxLoginAttempts: process.env.MAX_LOGIN_ATTEMPTS,
      loginLockoutMinutes: process.env.LOGIN_LOCKOUT_MINUTES,
      billingEnabled: process.env.BILLING_ENABLED,
      billingMinStartBalanceUsd: process.env.BILLING_MIN_START_BALANCE_USD,
      billingCurrency: process.env.BILLING_CURRENCY,
      billingCurrencyRate: process.env.BILLING_CURRENCY_RATE,
      externalClaudeDir: process.env.EXTERNAL_CLAUDE_DIR,
      adminHostOnlyMode: process.env.ADMIN_HOST_ONLY_MODE,
      mainAgentContextSource: process.env.MAIN_AGENT_CONTEXT_SOURCE,
      mainAgentAutoCompactWindow:
        process.env.MAIN_AGENT_AUTO_COMPACT_WINDOW ??
        process.env.AUTO_COMPACT_WINDOW,
      mainAgentAutoCompactPercentage:
        process.env.MAIN_AGENT_AUTO_COMPACT_PERCENTAGE ??
        process.env.AUTO_COMPACT_PERCENTAGE,
      fallbackModel: process.env.FALLBACK_MODEL,
      pluginAutoScan: process.env.PLUGIN_AUTO_SCAN,
      allowMemberGuests: process.env.ALLOW_MEMBER_GUESTS,
    },
    'env',
  );
}

export function getSystemSettings(): SystemSettings {
  // Fast path: return cached value if file hasn't changed (single stat)
  if (_settingsCache) {
    try {
      const mtimeMs = fs.statSync(SYSTEM_SETTINGS_FILE).mtimeMs;
      if (mtimeMs === _settingsMtimeMs) return _settingsCache;
    } catch {
      return _settingsCache; // file gone or stat failed — cached value is still valid
    }
  }

  // 1. Try reading from file
  try {
    const settings = readSystemSettingsFromFile();
    if (settings) {
      _settingsCache = settings;
      try {
        _settingsMtimeMs = fs.statSync(SYSTEM_SETTINGS_FILE).mtimeMs;
      } catch {
        /* ignore */
      }
      return settings;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      logger.warn(
        { err },
        'Failed to read system settings, falling back to env/defaults',
      );
    }
  }

  // 2. Fall back to env vars, then hardcoded defaults
  const settings = buildEnvFallbackSettings();
  _settingsCache = settings;
  _settingsMtimeMs = 0; // no file — will re-check on next call
  return settings;
}

/**
 * One-time compatibility input for migrating the former system-wide compact
 * threshold into Agent profiles. New runtime reads must use Agent policy.
 */
export function getLegacySystemAutoCompactWindow(): number | undefined {
  let value: unknown = process.env.AUTO_COMPACT_WINDOW;
  try {
    if (fs.existsSync(SYSTEM_SETTINGS_FILE)) {
      const raw = JSON.parse(
        fs.readFileSync(SYSTEM_SETTINGS_FILE, 'utf-8'),
      ) as Record<string, unknown>;
      if (raw.autoCompactWindow !== undefined) value = raw.autoCompactWindow;
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to read legacy auto compact setting');
  }
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.min(1_000_000, Math.max(100_000, Math.floor(parsed)));
}

/** 获取生效的外部 Claude 目录（externalClaudeDir 空时 fallback 到 ~/.claude） */
export function getEffectiveExternalDir(): string {
  const settings = getSystemSettings();
  return settings.externalClaudeDir || path.join(os.homedir(), '.claude');
}

export function saveSystemSettings(
  partial: Partial<SystemSettings>,
): SystemSettings {
  const existing = getSystemSettings();
  const merged = normalizeSystemSettings({ ...existing, ...partial }, 'api');

  fs.mkdirSync(CLAUDE_CONFIG_DIR, { recursive: true });
  const tmp = `${SYSTEM_SETTINGS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, SYSTEM_SETTINGS_FILE);

  // Update in-memory cache immediately
  _settingsCache = merged;
  try {
    _settingsMtimeMs = fs.statSync(SYSTEM_SETTINGS_FILE).mtimeMs;
  } catch {
    /* ignore */
  }

  return merged;
}

// ─── OAuth Usage Types ─────────────────────────────────────────────────────

const MAX_OAUTH_MODEL_WINDOWS = 32;
const MAX_OAUTH_MODEL_LABEL_LENGTH = 100;

function parseNullableFiniteNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function parseNullableResetAt(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const milliseconds = value < 1e11 ? value * 1000 : value;
    const parsed = new Date(milliseconds);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return undefined;
}

/**
 * 解析 OAuth usage bucket 对象
 * 运行时类型守卫，验证 API 响应结构
 */
export function parseOAuthUsageBucket(v: unknown): OAuthUsageBucket | null {
  if (!v || typeof v !== 'object') return null;
  const obj = v as Record<string, unknown>;
  const utilization = parseNullableFiniteNumber(obj.utilization);
  const resetsAt = parseNullableResetAt(obj.resets_at);
  if (utilization === undefined && resetsAt === undefined) return null;
  return {
    utilization: utilization === undefined ? null : utilization,
    resets_at: resetsAt === undefined ? null : resetsAt,
  };
}

export function parseOAuthExtraUsage(v: unknown): OAuthExtraUsage | null {
  if (!v || typeof v !== 'object') return null;
  const obj = v as Record<string, unknown>;
  if (typeof obj.is_enabled !== 'boolean') return null;
  const monthlyLimit = parseNullableFiniteNumber(obj.monthly_limit);
  const usedCredits = parseNullableFiniteNumber(obj.used_credits);
  const utilization = parseNullableFiniteNumber(obj.utilization);
  const currency =
    obj.currency === null
      ? null
      : typeof obj.currency === 'string' && obj.currency.trim().length <= 16
        ? obj.currency.trim()
        : null;
  return {
    is_enabled: obj.is_enabled,
    monthly_limit: monthlyLimit === undefined ? null : monthlyLimit,
    used_credits: usedCredits === undefined ? null : usedCredits,
    utilization: utilization === undefined ? null : utilization,
    currency,
  };
}

function parseOAuthModelWindow(v: unknown): OAuthModelUsageBucket | null {
  if (!v || typeof v !== 'object') return null;
  const obj = v as Record<string, unknown>;
  const displayName =
    typeof obj.display_name === 'string' ? obj.display_name.trim() : '';
  if (!displayName || displayName.length > MAX_OAUTH_MODEL_LABEL_LENGTH)
    return null;
  const bucket = parseOAuthUsageBucket(obj);
  return bucket ? { display_name: displayName, ...bucket } : null;
}

/**
 * Project dynamic weekly model windows from either the current SDK shape
 * (`model_scoped`) or the raw OAuth endpoint's `limits[]` shape. The endpoint
 * owns the labels; HappyClaw deliberately does not invent fields such as
 * `seven_day_sonnet_max`.
 */
export function parseOAuthModelWindows(raw: unknown): OAuthModelUsageBucket[] {
  if (!raw || typeof raw !== 'object') return [];
  const obj = raw as Record<string, unknown>;
  const projected: OAuthModelUsageBucket[] = [];

  if (Array.isArray(obj.model_scoped)) {
    for (const candidate of obj.model_scoped) {
      const bucket = parseOAuthModelWindow(candidate);
      if (bucket) projected.push(bucket);
      if (projected.length >= MAX_OAUTH_MODEL_WINDOWS) break;
    }
  } else if (Array.isArray(obj.limits)) {
    for (const candidate of obj.limits) {
      if (!candidate || typeof candidate !== 'object') continue;
      const limit = candidate as Record<string, unknown>;
      if (limit.kind !== 'weekly_scoped') continue;
      const scope = limit.scope;
      if (!scope || typeof scope !== 'object') continue;
      const model = (scope as Record<string, unknown>).model;
      if (!model || typeof model !== 'object') continue;
      const displayName = (model as Record<string, unknown>).display_name;
      const bucket = parseOAuthModelWindow({
        display_name: displayName,
        utilization: limit.percent,
        resets_at: limit.resets_at,
      });
      if (bucket) projected.push(bucket);
      if (projected.length >= MAX_OAUTH_MODEL_WINDOWS) break;
    }
  }

  const unique = new Map<string, OAuthModelUsageBucket>();
  for (const bucket of projected) {
    const key = bucket.display_name.toLowerCase();
    if (!unique.has(key)) unique.set(key, bucket);
  }
  return [...unique.values()];
}

/**
 * Whether an upstream body contains a recognized usage snapshot. A 200 body
 * can still be an in-band error (`{ error: ... }`) or an unrelated object;
 * those responses must not replace the last known snapshot with empty data.
 */
export function hasOAuthUsageSignals(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const obj = raw as Record<string, unknown>;
  for (const key of [
    'five_hour',
    'seven_day',
    'seven_day_oauth_apps',
    'seven_day_opus',
    'seven_day_sonnet',
  ]) {
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    if (obj[key] === null || parseOAuthUsageBucket(obj[key]) !== null) {
      return true;
    }
  }
  if (Object.prototype.hasOwnProperty.call(obj, 'extra_usage')) {
    if (
      obj.extra_usage === null ||
      parseOAuthExtraUsage(obj.extra_usage) !== null
    ) {
      return true;
    }
  }
  if (
    Object.prototype.hasOwnProperty.call(obj, 'model_scoped') &&
    Array.isArray(obj.model_scoped)
  ) {
    return true;
  }
  return (
    Object.prototype.hasOwnProperty.call(obj, 'limits') &&
    Array.isArray(obj.limits)
  );
}

export function parseOAuthUsageResponse(raw: unknown): OAuthUsageResponse {
  const obj =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    five_hour: parseOAuthUsageBucket(obj.five_hour),
    seven_day: parseOAuthUsageBucket(obj.seven_day),
    seven_day_oauth_apps: parseOAuthUsageBucket(obj.seven_day_oauth_apps),
    seven_day_opus: parseOAuthUsageBucket(obj.seven_day_opus),
    seven_day_sonnet: parseOAuthUsageBucket(obj.seven_day_sonnet),
    model_scoped: parseOAuthModelWindows(obj),
    extra_usage: parseOAuthExtraUsage(obj.extra_usage),
  };
}
