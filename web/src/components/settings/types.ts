import type {
  ConnectionModelRoles,
  ProviderModelEntry,
  ProviderTestRecord,
} from '@/lib/model-providers';
import type { DeploymentMode } from '../../stores/auth';

// ─── 统一供应商类型 (V4) ─────────────────────────────────────

export type WebFetchPreflightPolicy = 'check' | 'skip';

export interface UnifiedProviderPublic {
  id: string;
  name: string;
  type: 'official' | 'third_party';
  anthropicBaseUrl: string;
  anthropicModel: string;
  /** null for third-party providers saved before the explicit choice. */
  anthropicAuthMode: 'bearer' | 'x-api-key' | null;
  /** `skip` skips WebFetch's domain check; `check` follows Claude Code's settings. */
  webFetchPreflightPolicy?: WebFetchPreflightPolicy;
  hasAnthropicAuthToken: boolean;
  anthropicAuthTokenMasked: string | null;
  hasAnthropicApiKey: boolean;
  anthropicApiKeyMasked: string | null;
  hasClaudeCodeOauthToken: boolean;
  claudeCodeOauthTokenMasked: string | null;
  hasClaudeOAuthCredentials: boolean;
  claudeOAuthCredentialsExpiresAt: number | null;
  claudeOAuthCredentialsAccessTokenMasked: string | null;
  /** Which official credential is active; null for third-party providers. */
  claudeAuthKind?: 'oauth' | 'setup_token' | 'api_key' | null;
  claudeOAuthAccountEmail?: string | null;
  claudeOAuthOrganizationName?: string | null;
  claudeOAuthSubscriptionType?: string | null;
  claudeOAuthScopes?: string[];
  claudeOAuthLastRefreshAt?: number | null;
  claudeOAuthNeedsReLogin?: boolean;
  claudeOAuthLastRefreshError?: {
    kind: 'invalid_grant' | 'rejected' | 'account_mismatch';
    message: string;
    at: number;
  } | null;
  hasCodexOAuthCredentials: boolean;
  codexOAuthCredentialsExpiresAt: number | null;
  codexOAuthCredentialsEmail: string | null;
  codexOAuthCredentialsPlanType: string | null;
  /** ChatGPT login was refused on refresh; the user must log in again. */
  codexOAuthNeedsReauth?: boolean;
  codexOAuthLastRefreshError?: {
    kind: 'reauth_required' | 'transient';
    message: string;
    at: string;
  } | null;
  /** Effort the gateway applies when the Agent does not choose one. */
  codexDefaultEffort?: string | null;
  customEnv: Record<string, string>;
  /** The connection's effective model list; [] for ChatGPT (it uses its catalog). */
  models: ProviderModelEntry[];
  /** Which of its models Claude Code uses for sub-agents and background calls. */
  roles?: ConnectionModelRoles;
  /** The MODEL_PRESETS id the connection started from. */
  presetId: string | null;
  /** The outcome of the last connection test. */
  lastTest: ProviderTestRecord | null;
  updatedAt: string;
}

export interface ProvidersListResponse {
  providers: UnifiedProviderPublic[];
}

// ─── 通用类型 ────────────────────────────────────────────────

export interface EnvRow {
  key: string;
  value: string;
}

export interface SessionInfo {
  shortId: string;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
  last_active_at: string;
  is_current: boolean;
}

export interface SystemSettings {
  containerTimeout: number;
  idleTimeout: number;
  containerMaxOutputSize: number;
  maxConcurrentContainers: number;
  maxLoginAttempts: number;
  loginLockoutMinutes: number;
  fallbackModel: string;
  allowMemberGuests: boolean;
}

export interface HostIntegrationSettings {
  adminHostOnlyMode: boolean;
  mainAgentContextSource: 'managed' | 'host_claude';
  mainAgentAutoCompactWindow: number;
  mainAgentAutoCompactPercentage: number;
  externalClaudeDir: string;
  pluginAutoScan: boolean;
  // The rest are absent on servers older than the workspace root setting.
  /** Stored root of new Host workspaces; '' = unset. */
  workspaceRoot?: string;
  /** Where new Host workspaces go; null: no usable root, so data/groups/<folder>. */
  workspaceRootEffective?: string | null;
  workspaceRootSource?: SettingSource;
  /** Why the requested root is not used (a problem code), or null. */
  workspaceRootFallbackReason?: string | null;
  workspaceRootFallbackWarning?: string | null;
  /** Effective mode. */
  deploymentMode?: DeploymentMode;
  /** Stored mode; '' = unset. */
  deploymentModeConfigured?: '' | DeploymentMode;
  deploymentModeSource?: SettingSource;
}

export type SettingSource = 'settings' | 'env' | 'default';

/** The user list of a 409 `SINGLE_USER_HOST_OTHER_USERS`. */
export interface OtherActiveUser {
  id: string;
  username: string;
  role: string;
}

// ─── OAuth Usage ────────────────────────────────────────────

export interface OAuthUsageBucket {
  utilization: number | null;
  resets_at: string | null;
}

export interface OAuthModelUsageBucket extends OAuthUsageBucket {
  display_name: string;
}

export interface OAuthExtraUsage {
  is_enabled: boolean;
  monthly_limit: number | null;
  used_credits: number | null;
  utilization: number | null;
  currency: string | null;
}

export interface ProviderQuotaObservation {
  source: 'sdk_rate_limit_event';
  observedAt: number;
  status: 'allowed' | 'allowed_warning' | 'rejected';
  rateLimitType?: string;
  /** SDK/header fraction in the 0..1 unit, unlike OAuth buckets. */
  utilization?: number;
  /** Unix epoch seconds. */
  resetsAt?: number;
  overageStatus?: 'allowed' | 'allowed_warning' | 'rejected';
  overageResetsAt?: number;
  overageDisabledReason?: string;
  isUsingOverage?: boolean;
  overageInUse?: boolean;
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

/** One ChatGPT usage window, from the backend's x-codex-* headers. */
export interface CodexRateLimitWindow {
  /** 0..100 */
  usedPercent: number;
  windowMinutes: number | null;
  /** Unix epoch seconds. */
  resetsAt: number | null;
}

/** GET /claude/providers/:id/usage for a ChatGPT-subscription provider. */
export interface CodexRateLimitsUsage {
  kind: 'codex_rate_limits';
  observedAt: number | null;
  activeLimit: string | null;
  rateLimitReachedType: string | null;
  limits: Array<{
    limitId: string;
    limitName: string | null;
    primary: CodexRateLimitWindow | null;
    secondary: CodexRateLimitWindow | null;
    credits: {
      hasCredits: boolean;
      unlimited: boolean;
      balance: string | null;
    } | null;
  }>;
}

export interface CachedOAuthUsage {
  data: OAuthUsageResponse;
  fetchedAt: number;
  /** Set when the grant cannot read usage or needs a new login. */
  status?: 'unsupported' | 'needs_relogin';
  unsupportedReason?: 'inference_only' | 'setup_token' | 'no_oauth';
  error?: string;
  observation?: ProviderQuotaObservation | null;
}

export type SettingsTab =
  | 'claude'
  | 'registration'
  | 'appearance'
  | 'system'
  | 'main-agent'
  | 'host-integration'
  | 'billing'
  | 'profile'
  | 'preferences'
  | 'my-channels'
  | 'security'
  | 'guests'
  | 'groups'
  | 'agent-profiles'
  | 'memory'
  | 'skills'
  | 'mcp-servers'
  | 'plugins'
  | 'users'
  | 'about'
  | 'bindings'
  | 'usage'
  | 'monitor';

export function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.trim()) return msg;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
