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
  // HappyClaw no longer uses a Service Worker. Clean up registrations and
  // Cache Storage left by older releases without delaying the first render.
  void cleanupLegacyPwaArtifacts();
  installStaleChunkRecovery();
  startAppUpdateCheck();
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
