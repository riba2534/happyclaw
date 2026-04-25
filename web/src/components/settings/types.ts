// ─── 统一供应商类型 (V4) ─────────────────────────────────────

export interface UnifiedProviderPublic {
  id: string;
  name: string;
  type: 'official' | 'third_party';
  runtime: 'claude' | 'codex';
  providerFamily: 'claude' | 'gpt';
  providerPoolId: string;
  authMode: 'api_key' | 'oauth' | 'setup_token' | 'third_party' | 'chatgpt_oauth';
  authProfileGeneration: number;
  enabled: boolean;
  weight: number;
  anthropicBaseUrl: string;
  anthropicModel: string;
  hasAnthropicAuthToken: boolean;
  anthropicAuthTokenMasked: string | null;
  hasAnthropicApiKey: boolean;
  anthropicApiKeyMasked: string | null;
  hasClaudeCodeOauthToken: boolean;
  claudeCodeOauthTokenMasked: string | null;
  hasClaudeOAuthCredentials: boolean;
  claudeOAuthCredentialsExpiresAt: number | null;
  claudeOAuthCredentialsAccessTokenMasked: string | null;
  hasOpenaiApiKey: boolean;
  openaiApiKeyMasked: string | null;
  hasCodexAuthJson: boolean;
  customEnv: Record<string, string>;
  updatedAt: string;
}

export interface ProviderHealthStatus {
  profileId: string;
  healthy: boolean;
  consecutiveErrors: number;
  lastErrorAt: number | null;
  lastSuccessAt: number | null;
  unhealthySince: number | null;
  activeSessionCount: number;
}

export interface ProviderWithHealth extends UnifiedProviderPublic {
  health: ProviderHealthStatus | null;
}

export interface BalancingConfig {
  strategy: 'round-robin' | 'weighted-round-robin' | 'failover';
  unhealthyThreshold: number;
  recoveryIntervalMs: number;
}

export interface ProvidersListResponse {
  providers: ProviderWithHealth[];
  balancing: BalancingConfig;
  enabledCount: number;
}

export interface ClaudeApplyResult {
  success: boolean;
  stoppedCount: number;
  failedCount?: number;
  error?: string;
}

// ─── 兼容旧类型（仍被 GET /claude 返回） ────────────────────

export interface ClaudeConfigPublic {
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

// ─── 通用类型 ────────────────────────────────────────────────

export interface EnvRow {
  key: string;
  value: string;
}

export interface SessionInfo {
  id: string;
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
  maxConcurrentHostProcesses: number;
  maxLoginAttempts: number;
  loginLockoutMinutes: number;
  maxConcurrentScripts: number;
  scriptTimeout: number;
  billingEnabled: boolean;
  billingMode: 'wallet_first';
  billingMinStartBalanceUsd: number;
  billingCurrency: string;
  billingCurrencyRate: number;
  externalClaudeDir: string;
  autoCompactWindow: number;
  disableMemoryLayerForAdminHost: boolean;
}

// ─── OAuth Usage ────────────────────────────────────────────

export interface OAuthUsageBucket {
  utilization: number;
  resets_at: string;
}

export interface OAuthUsageResponse {
  five_hour: OAuthUsageBucket | null;
  seven_day: OAuthUsageBucket | null;
  seven_day_opus: OAuthUsageBucket | null;
  seven_day_sonnet: OAuthUsageBucket | null;
}

export interface CachedOAuthUsage {
  data: OAuthUsageResponse;
  fetchedAt: number;
  error?: string;
}

export interface ProviderPoolModelOption {
  runtime: 'claude' | 'codex';
  provider_family: 'claude' | 'gpt';
  provider_pool_id: string;
  model_id: string;
  model_kind: 'provider_default' | 'runtime_default' | 'alias' | 'explicit_version' | 'custom';
  display_name: string | null;
  source: string;
  status: 'available' | 'unverified' | 'unsupported' | 'stale' | 'hidden';
  updated_at: string;
}

export interface ProviderPool {
  provider_pool_id: string;
  runtime: 'claude' | 'codex';
  provider_family: 'claude' | 'gpt';
  display_name: string;
  enabled: boolean;
}

export interface ConversationRuntimeState {
  runtime: 'claude' | 'codex';
  provider_pool_id: string;
  selected_model: string | null;
  model_kind: ProviderPoolModelOption['model_kind'];
  resolved_model: string | null;
  binding_source: 'system_default' | 'workspace_default' | 'copied_workspace_default' | 'user_pinned';
}

export type SettingsTab = 'models' | 'claude' | 'gpt' | 'registration' | 'appearance' | 'system' | 'profile' | 'my-channels' | 'security' | 'groups' | 'memory' | 'skills' | 'mcp-servers' | 'agent-definitions' | 'users' | 'about' | 'bindings' | 'usage' | 'monitor';

export function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.trim()) return msg;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
