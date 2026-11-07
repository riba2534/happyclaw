/// <reference types="vite/client" />

declare module '*.css' {
  const content: string;
  export default content;
}

interface Window {
  __HAPPYCLAW_HASH_ROUTER__?: boolean;
}
