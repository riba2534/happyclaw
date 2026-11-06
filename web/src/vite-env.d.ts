/// <reference types="vite/client" />

declare module '*.css' {
  const content: string;
  export default content;
}

interface Window {
  __HAPPYCLAW_HASH_ROUTER__?: boolean;
}

/** 本次构建的标识，由 vite.config.ts 注入；vitest 等未经 vite 构建的环境里不存在。 */
declare const __APP_BUILD__: { id: string; builtAt: number } | undefined;
