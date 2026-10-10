import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@fontsource-variable/inter';
import '@fontsource-variable/geist-mono';
import './styles/globals.css';
import { shouldUseHashRouter } from './utils/url';
import { cleanupLegacyPwaArtifacts } from './utils/legacyPwaCleanup';
import { installStaleChunkRecovery } from './utils/staleChunkReload';

if (typeof window !== 'undefined') {
  window.__HAPPYCLAW_HASH_ROUTER__ = shouldUseHashRouter();

  // Prevent pinch-to-zoom on iOS (iOS 10+ ignores user-scalable=no).
  // 多指缩放由 globals.css 的 `touch-action: pan-x pan-y` 声明式拦截；这里只保留
  // iOS Safari 专有的 gesture 事件兜底。此前全局非 passive touchmove 会让每次
  // 触摸滚动都同步等待 JS，直接拖慢移动端滚动。
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('gesturechange', (e) => e.preventDefault());
}

if (typeof window !== 'undefined') {
  // HappyClaw no longer uses a Service Worker. Clean up registrations and
  // Cache Storage left by older releases without delaying the first render.
  void cleanupLegacyPwaArtifacts();
  installStaleChunkRecovery();
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
