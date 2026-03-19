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

export interface ClaudeThirdPartyProfileItem {
  id: string;
  name: string;
  anthropicBaseUrl: string;
  anthropicModel: string;
  updatedAt: string | null;
  hasAnthropicAuthToken: boolean;
  anthropicAuthTokenMasked: string | null;
  customEnv: Record<string, string>;
}

export interface ClaudeThirdPartyProfilesResp {
  activeProfileId: string;
  profiles: ClaudeThirdPartyProfileItem[];
}

export interface ClaudeThirdPartyActivateResult {
  success: boolean;
  alreadyActive?: boolean;
  activeProfileId: string;
  profile: ClaudeThirdPartyProfileItem | null;
  stoppedCount: number;
  failedCount: number;
  error?: string;
}

export interface ClaudeApplyResult {
  success: boolean;
  stoppedCount: number;
  failedCount?: number;
  error?: string;
}

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

export interface SettingsNotification {
  setNotice: (msg: string | null) => void;
  setError: (msg: string | null) => void;
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
}

export type SettingsTab = 'claude' | 'registration' | 'appearance' | 'system' | 'profile' | 'my-channels' | 'security' | 'groups' | 'memory' | 'skills' | 'mcp-servers' | 'agent-definitions' | 'users' | 'about' | 'bindings';

// ─── Provider Pool Types ──────────────────────────────────────────

export interface ProviderPoolHealthStatus {
  profileId: string;
  healthy: boolean;
  consecutiveErrors: number;
  lastErrorAt: number | null;
  lastSuccessAt: number | null;
  unhealthySince: number | null;
  activeSessionCount: number;
}

export interface ProviderPoolMemberWithHealth {
  profileId: string;
  profileName: string;
  isOfficial: boolean;
  weight: number;
  enabled: boolean;
  health: ProviderPoolHealthStatus;
}

export interface ProviderPoolAvailableProfile {
  id: string;
  name: string;
  isOfficial: boolean;
  inPool: boolean;
}

export interface ProviderPoolResponse {
  mode: 'fixed' | 'pool';
  strategy: 'round-robin' | 'weighted-round-robin' | 'failover';
  members: ProviderPoolMemberWithHealth[];
  unhealthyThreshold: number;
  recoveryIntervalMs: number;
  updatedAt: string;
  availableProfiles: ProviderPoolAvailableProfile[];
}

export function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.trim()) return msg;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}
