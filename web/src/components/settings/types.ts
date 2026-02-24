export interface ClaudeConfigPublic {
  anthropicBaseUrl: string;
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

export interface FeishuConfigPublic {
  appId: string;
  hasAppSecret: boolean;
  appSecretMasked: string | null;
  enabled: boolean;
  connected: boolean;
  updatedAt: string | null;
  source: 'runtime' | 'env' | 'none';
}

export interface TelegramConfigPublic {
  hasBotToken: boolean;
  botTokenMasked: string | null;
  enabled: boolean;
  connected: boolean;
  updatedAt: string | null;
  source: 'runtime' | 'env' | 'none';
}

export interface TelegramTestResult {
  success: boolean;
  bot_username?: string;
  bot_id?: number;
  bot_name?: string;
  error?: string;
}

export interface ClaudeCustomEnvResp {
  customEnv: Record<string, string>;
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

export type SettingsTab = 'channels' | 'claude' | 'registration' | 'appearance' | 'profile' | 'my-channels' | 'security' | 'groups' | 'memory' | 'skills' | 'users' | 'about';

export function getErrorMessage(err: unknown, fallback: string): string {
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const msg = (err as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.trim()) return msg;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

export function sourceLabel(source: FeishuConfigPublic['source']): string {
  if (source === 'runtime') return '来自设置页';
  if (source === 'env') return '来自环境变量';
  return '未配置';
}
