// ─── ChatGPT/Codex 订阅网关 — 内部地址解析 ──────────────────────────
//
// Provider 落盘的 anthropicBaseUrl 只存占位值（CODEX_GATEWAY_BASE_URL_PLACEHOLDER），
// 真实地址在每次构建 Runner 环境变量时按执行模式现算：Host 模式 Runner 与主服务
// 同一进程/主机，用 127.0.0.1；Container 模式通过 --add-host 注入的
// host.docker.internal 回连宿主机。

import {
  CODEX_GATEWAY_BASE_URL_PLACEHOLDER,
  CODEX_GATEWAY_ROUTE,
} from './types.js';

export type CodexGatewayExecutionMode = 'host' | 'container';

export function resolveCodexGatewayBaseUrl(
  anthropicBaseUrl: string,
  mode: CodexGatewayExecutionMode,
): string {
  if (anthropicBaseUrl !== CODEX_GATEWAY_BASE_URL_PLACEHOLDER) {
    return anthropicBaseUrl;
  }
  const port = process.env.WEB_PORT || '3000';
  const host = mode === 'container' ? 'host.docker.internal' : '127.0.0.1';
  return `http://${host}:${port}${CODEX_GATEWAY_ROUTE}`;
}

/** true when this provider config is a ChatGPT/Codex 订阅网关占位配置。 */
export function isCodexGatewayBaseUrl(anthropicBaseUrl: string): boolean {
  return anthropicBaseUrl === CODEX_GATEWAY_BASE_URL_PLACEHOLDER;
}
