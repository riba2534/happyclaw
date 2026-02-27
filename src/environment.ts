/**
 * 环境变量集中管理
 *
 * 所有 process.env 读取集中在此处，其他模块通过导入此文件的具名导出获取配置值。
 * 运行时由 src/load-env.ts（通过 --import 标志）在本模块初始化前完成 .env 加载。
 */

// ─── 应用 ──────────────────────────────────────────────────────────────────────

/** AI 助手名称，显示在界面和 IM 消息中 */
export const ASSISTANT_NAME = process.env.ASSISTANT_NAME ?? 'HappyClaw';

/** Node.js 运行环境，'production' | 'development' | 'test' */
export const NODE_ENV = process.env.NODE_ENV ?? 'development';

/** 是否生产环境 */
export const IS_PRODUCTION = NODE_ENV === 'production';

// ─── Web 服务器 ────────────────────────────────────────────────────────────────

/** HTTP 监听端口 */
export const WEB_PORT = parseInt(process.env.WEB_PORT ?? '3000', 10);

/**
 * Cookie 签名密钥（可选）。
 * 若未设置，config.ts 中的 getOrCreateSessionSecret() 会从文件读取或随机生成。
 */
export const WEB_SESSION_SECRET = process.env.WEB_SESSION_SECRET ?? '';

/** 是否信任反向代理的 X-Forwarded-* 头部（nginx/Cloudflare 场景设为 true） */
export const TRUST_PROXY = process.env.TRUST_PROXY === 'true';

// ─── CORS ─────────────────────────────────────────────────────────────────────

/** 允许跨域的来源白名单，逗号分隔；设为 '*' 允许全部 */
export const CORS_ALLOWED_ORIGINS = process.env.CORS_ALLOWED_ORIGINS ?? '';

/** 是否允许 localhost / 127.0.0.1 跨域（默认 true，可设为 'false' 关闭） */
export const CORS_ALLOW_LOCALHOST = process.env.CORS_ALLOW_LOCALHOST !== 'false';

// ─── 认证限流 ──────────────────────────────────────────────────────────────────

/** 登录失败多少次后锁定账户 */
export const MAX_LOGIN_ATTEMPTS = (() => {
  const v = parseInt(process.env.MAX_LOGIN_ATTEMPTS ?? '5', 10);
  return Number.isFinite(v) ? v : 5;
})();

/** 账户锁定持续分钟数 */
export const LOGIN_LOCKOUT_MINUTES = (() => {
  const v = parseInt(process.env.LOGIN_LOCKOUT_MINUTES ?? '15', 10);
  return Number.isFinite(v) ? v : 15;
})();

// ─── 日志 ──────────────────────────────────────────────────────────────────────

/** pino 日志级别：trace / debug / info / warn / error / fatal */
export const LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';

// ─── 容器 ──────────────────────────────────────────────────────────────────────

/** Docker 镜像名称 */
export const CONTAINER_IMAGE = process.env.CONTAINER_IMAGE ?? 'happyclaw-agent:latest';

/** 容器最大运行时间（毫秒），默认 30 分钟 */
export const CONTAINER_TIMEOUT = parseInt(process.env.CONTAINER_TIMEOUT ?? '1800000', 10);

/** 单次容器输出最大字节数，默认 10MB */
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE ?? '10485760',
  10,
);

/** 容器空闲超时（毫秒）：最后一次输出后无新消息则关闭，默认 30 分钟 */
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT ?? '1800000', 10);

/** 宿主机模式最大并发进程数 */
export const MAX_CONCURRENT_HOST_PROCESSES = parseInt(
  process.env.MAX_CONCURRENT_HOST_PROCESSES ?? '5',
  10,
);

// ─── 飞书（Lark） ──────────────────────────────────────────────────────────────

/** 飞书应用 App ID */
export const FEISHU_APP_ID = process.env.FEISHU_APP_ID ?? '';

/** 飞书应用 App Secret */
export const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET ?? '';

// ─── Telegram ─────────────────────────────────────────────────────────────────

/** Telegram Bot Token */
export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? '';

// ─── Claude / Anthropic ───────────────────────────────────────────────────────

/** 自定义 Anthropic API Base URL（留空则使用官方地址） */
export const ANTHROPIC_BASE_URL = process.env.ANTHROPIC_BASE_URL ?? '';

/** Anthropic Auth Token（Bearer 认证，与 API Key 二选一） */
export const ANTHROPIC_AUTH_TOKEN = process.env.ANTHROPIC_AUTH_TOKEN ?? '';

/** Anthropic API Key */
export const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY ?? '';

/** Claude Code OAuth Token */
export const CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '';

// ─── 系统（由操作系统或容器运行时注入，通常无需在 .env 中设置） ────────────────

/** 宿主机 HOME 目录，用于 ~/.claude 路径构建等 */
export const HOME_DIR = process.env.HOME ?? '/root';

/** 定时任务时区（cron 表达式使用）；默认使用系统时区 */
export const TIMEZONE = process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

/** 终端类型（terminal-manager 非 pty 模式使用） */
export const TERM_TYPE = process.env.TERM ?? 'xterm-256color';
