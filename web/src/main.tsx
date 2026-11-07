import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import '@fontsource-variable/inter';
import '@fontsource-variable/geist-mono';
import './styles/globals.css';
import { shouldUseHashRouter } from './utils/url';
import { cleanupLegacyPwaArtifacts } from './utils/legacyPwaCleanup';
import { installStaleChunkRecovery } from './utils/staleChunkReload';
import { startAppUpdateCheck } from './utils/appUpdatePrompt';

if (typeof window !== 'undefined') {
  window.__HAPPYCLAW_HASH_ROUTER__ = shouldUseHashRouter();
}

if (typeof window !== 'undefined') {
  // HappyClaw caches nothing in a Service Worker. Clean up the Workbox
  // registrations and Cache Storage left by older releases without delaying
  // the first render. The push-only worker (push-sw.js) is registered from
  // Settings, never here, and is kept by this cleanup.
  void cleanupLegacyPwaArtifacts();
  installStaleChunkRecovery();
  startAppUpdateCheck();
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
