// ─── Gemini 订阅网关 — 共享类型与常量 ─────────────────────────────
//
// 网关把 Anthropic Messages API 翻译成 Google Antigravity（Cloud Code）
// 的 v1internal generateContent 方言，让 Claude Agent SDK 通过
// ANTHROPIC_BASE_URL 使用 Google 账号订阅额度。
//
// 上游协议参考 CLIProxyAPI（MIT）的 antigravity 实现，见 THIRD_PARTY_NOTICES.md。

/** 存储在 provider secrets 中的 Google/Antigravity 凭据（AES-256-GCM 加密落盘）。 */
export interface GeminiOAuthCredentials {
  accessToken: string;
  refreshToken: string;
  /** epoch ms。 */
  expiresAt: number;
  /** Google 账号邮箱（userinfo）。 */
  email: string | null;
  /** Google 账号稳定标识（userinfo.id），用于判断是否换了账号。 */
  accountId: string | null;
  /** loadCodeAssist/onboardUser 得到的 Cloud AI Companion 项目。 */
  projectId: string | null;
  /** 授权时获得的 scope；缺少时按默认值展示。 */
  scopes?: string[];
  updatedAt: string;
}

/**
 * 最近一次上游 token 刷新失败的状态，落在 provider 的非机密配置里。
 * reauth_required：refresh_token 被 Google 拒绝，只能重新登录；
 * transient：网络、超时、5xx/429 等，按退避自动重试。
 */
export interface GeminiOAuthRefreshErrorState {
  kind: 'reauth_required' | 'transient';
  message: string;
  /** ISO 时间。 */
  at: string;
}

/**
 * Gemini 订阅型 provider 的 anthropicBaseUrl 存储占位值。
 * 真实地址在每次构建 Runner 环境变量时按执行模式现算。
 */
export const GEMINI_GATEWAY_BASE_URL_PLACEHOLDER =
  'http://happyclaw-gemini-gateway.internal';

/** 网关挂载路径（主服务内）。 */
export const GEMINI_GATEWAY_ROUTE = '/gateway/gemini';

/**
 * Google OAuth 客户端参数（Antigravity 桌面客户端，参考 CLIProxyAPI）。
 *
 * 不在代码里内置任何凭据。使用 Gemini 订阅需要在环境（`.env`）中配置
 * `GEMINI_OAUTH_CLIENT_ID` 与 `GEMINI_OAUTH_CLIENT_SECRET`：它们来自 Google
 * Cloud Console 的 OAuth「桌面应用」客户端，也可以沿用 Antigravity 桌面客户端
 * 或 CLIProxyAPI 部署里使用的那一对。两者必须成对配置。
 */
export const GEMINI_OAUTH_AUTH_URL =
  'https://accounts.google.com/o/oauth2/v2/auth';
export const GEMINI_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
export const GEMINI_OAUTH_USERINFO_URL =
  'https://www.googleapis.com/oauth2/v2/userinfo?alt=json';
export const GEMINI_OAUTH_CLIENT_ID =
  process.env.GEMINI_OAUTH_CLIENT_ID?.trim() ?? '';
export const GEMINI_OAUTH_CLIENT_SECRET =
  process.env.GEMINI_OAUTH_CLIENT_SECRET?.trim() ?? '';

/** 未配置客户端凭据时，Gemini 订阅的登录入口返回明确错误而不是伪造请求。 */
export function geminiOAuthClientConfigured(): boolean {
  return (
    GEMINI_OAUTH_CLIENT_ID.length > 0 && GEMINI_OAUTH_CLIENT_SECRET.length > 0
  );
}
/** 桌面客户端的本机回调端口；用户把地址栏里的完整 URL 粘贴回来。 */
export const GEMINI_OAUTH_REDIRECT_URI =
  'http://localhost:51121/oauth-callback';
export const GEMINI_OAUTH_CALLBACK_ORIGINS: readonly string[] = [
  'http://localhost:51121',
  'http://127.0.0.1:51121',
];
export const GEMINI_OAUTH_SCOPES: readonly string[] = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/cloud-platform',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/cclog',
  'https://www.googleapis.com/auth/experimentsandconfigs',
];

/** 消费级账号走 daily 端点；生产端点对这类凭据返回 429。 */
export const GEMINI_API_BASE = 'https://daily-cloudcode-pa.googleapis.com';
export const GEMINI_API_VERSION = 'v1internal';
/** Antigravity 客户端版本；低于 2.23.0 会被上游拒绝新模型。 */
export const GEMINI_CLIENT_VERSION = '2.35.2';
export const GEMINI_CLIENT_CHANGELIST = '1029311855';
export const GEMINI_REQUEST_USER_AGENT = `antigravity/hub/${GEMINI_CLIENT_VERSION} (aidev_client; os_type=darwin; arch=arm64; cl=${GEMINI_CLIENT_CHANGELIST})`;
export const GEMINI_ONBOARD_USER_AGENT = `${GEMINI_REQUEST_USER_AGENT} google-api-nodejs-client/10.3.0`;
export const GEMINI_GOOG_API_CLIENT = 'gl-node/22.21.1';

/** OAuth 流程在内存中的有效期。 */
export const GEMINI_OAUTH_FLOW_TTL_MS = 10 * 60 * 1000;
/** 上游 access_token 提前刷新余量。 */
export const GEMINI_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** 新连接默认模型。 */
export const GEMINI_DEFAULT_MODEL = 'gemini-4-argon-medium';

/** 每次请求的生成上限兜底，避免上游按模型默认值超时。 */
export const GEMINI_DEFAULT_MAX_OUTPUT_TOKENS = 32_000;

/** thinking 签名载体前缀（Anthropic signature 字段里往返）。 */
export const GEMINI_SIGNATURE_PREFIX = 'hcgsig1.';

/** 上游模型目录条目（fetchAvailableModels 的裁剪结果）。 */
export interface GeminiModelInfo {
  /** 请求时使用的模型 id，例如 gemini-4-argon-medium。 */
  id: string;
  displayName: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
  supportsThinking: boolean;
  supportsImages: boolean;
  /** 上游给的默认 thinking budget；没有时按请求决定。 */
  thinkingBudget: number | null;
  minThinkingBudget: number | null;
}
