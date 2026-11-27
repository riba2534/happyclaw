// ─── Gemini 订阅网关 — 内部地址解析 ──────────────────────────────
//
// Provider 落盘的 anthropicBaseUrl 只存占位值，真实地址在每次构建 Runner
// 环境变量时按执行模式现算：Host 模式 Runner 与主服务同一进程/主机，用
// 127.0.0.1；Container 模式通过 --add-host 注入的 host.docker.internal 回连。
//
// 与 Codex 网关不同，这里不需要为每次启动签发临时 token：provider 的
// anthropicAuthToken 本身就是网关标识（随机生成、随连接加密保存），网关
// 用 timing-safe 比较把它映射回 provider。

import {
  GEMINI_GATEWAY_BASE_URL_PLACEHOLDER,
  GEMINI_GATEWAY_ROUTE,
} from './types.js';

export type GeminiGatewayExecutionMode = 'host' | 'container';

export function resolveGeminiGatewayBaseUrl(
  anthropicBaseUrl: string,
  mode: GeminiGatewayExecutionMode,
): string {
  if (anthropicBaseUrl !== GEMINI_GATEWAY_BASE_URL_PLACEHOLDER) {
    return anthropicBaseUrl;
  }
  const port = process.env.WEB_PORT || '3000';
  const host = mode === 'container' ? 'host.docker.internal' : '127.0.0.1';
  return `http://${host}:${port}${GEMINI_GATEWAY_ROUTE}`;
}

/** true when this provider config is a Gemini 订阅网关占位配置。 */
export function isGeminiGatewayBaseUrl(anthropicBaseUrl: string): boolean {
  return anthropicBaseUrl === GEMINI_GATEWAY_BASE_URL_PLACEHOLDER;
}

/** The placeholder, or the local gateway URL it resolves to at launch. */
export function isGeminiGatewayEndpoint(baseUrl: string): boolean {
  if (isGeminiGatewayBaseUrl(baseUrl)) return true;
  try {
    const url = new URL(baseUrl);
    return (
      ['127.0.0.1', 'localhost', 'host.docker.internal'].includes(
        url.hostname,
      ) && url.pathname.replace(/\/+$/, '') === GEMINI_GATEWAY_ROUTE
    );
  } catch {
    return false;
  }
}

/**
 * Rewrite a stored Gemini subscription config for one launch. Everything else
 * (including the gateway identifier token) is kept as saved.
 */
export function resolveGeminiGatewayLaunchConfig<
  T extends { anthropicBaseUrl: string },
>(config: T, mode: GeminiGatewayExecutionMode): T {
  if (!isGeminiGatewayBaseUrl(config.anthropicBaseUrl)) return config;
  return {
    ...config,
    anthropicBaseUrl: resolveGeminiGatewayBaseUrl(
      config.anthropicBaseUrl,
      mode,
    ),
  };
}
