// ─── ChatGPT/Codex 订阅网关 — 共享类型 ───────────────────────────
//
// 网关把 Anthropic Messages API 翻译成 ChatGPT 订阅后端
// (chatgpt.com/backend-api/codex/responses，OpenAI Responses API 方言)，
// 让 Claude Agent SDK 通过 ANTHROPIC_BASE_URL 直接使用 ChatGPT 订阅额度。

/** 存储在 provider secrets 中的 Codex OAuth 凭据（AES-256-GCM 加密落盘）。 */
export interface CodexOAuthCredentials {
  accessToken: string;
  refreshToken: string;
  /** epoch ms；由 expires_in 换算。 */
  expiresAt: number;
  /** id_token JWT `auth.chatgpt_account_id` claim，上游请求头必需。 */
  accountId: string | null;
  /** id_token JWT `auth.chatgpt_plan_type` claim（plus/pro/...）。 */
  planType: string | null;
  email: string | null;
  updatedAt: string;
}

/**
 * ChatGPT 订阅型 provider 的 anthropicBaseUrl 存储占位值。
 * 保留 http(s) 形式以通过 URL 校验并复用第三方 endpoint 的运行时默认值；
 * 在 env 构建时按执行模式改写为实际网关地址（127.0.0.1 / host.docker.internal）。
 */
export const CODEX_GATEWAY_BASE_URL_PLACEHOLDER =
  'http://happyclaw-codex-gateway.internal';

/** 网关挂载路径（主服务内）。 */
export const CODEX_GATEWAY_ROUTE = '/gateway/chatgpt';

/** Codex OAuth 的 OpenAI 官方 CLI 公共客户端参数（openai/codex 官方确认允许第三方使用）。 */
export const CODEX_OAUTH_AUTHORIZE_URL =
  'https://auth.openai.com/oauth/authorize';
export const CODEX_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
export const CODEX_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_OAUTH_REDIRECT_URI = 'http://localhost:1455/auth/callback';
export const CODEX_OAUTH_SCOPES =
  'openid profile email offline_access api.connectors.read api.connectors.invoke';

/** ChatGPT 订阅后端。 */
export const CODEX_BACKEND_RESPONSES_URL =
  'https://chatgpt.com/backend-api/codex/responses';

/** OAuth 流程在内存中的有效期。 */
export const CODEX_OAUTH_FLOW_TTL_MS = 10 * 60 * 1000;

/** 上游 access_token 提前刷新余量。 */
export const CODEX_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
