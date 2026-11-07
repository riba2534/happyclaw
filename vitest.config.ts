import { defineConfig } from 'vitest/config';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// New Host workspaces are created in the workspace root; keep tests out of
// the real ~/happyclaw, one root per run so parallel runs never share one.
const testWorkspaceRoot = path.join(
  os.tmpdir(),
  `happyclaw-vitest-workspace-root-${process.pid}`,
);

// Scope vitest's root-level discovery to project tests only.
// `data/` holds the user's agent scratch workspaces (gitignored) which can
// contain nested projects with their own test suites; vitest does not respect
// .gitignore, so we must exclude explicitly.
export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./web/src', import.meta.url)),
      react: fileURLToPath(
        new URL('./web/node_modules/react', import.meta.url),
      ),
      'react-dom': fileURLToPath(
        new URL('./web/node_modules/react-dom', import.meta.url),
      ),
      'react-router-dom': fileURLToPath(
        new URL('./web/node_modules/react-router-dom', import.meta.url),
      ),
    },
  },
  test: {
    // Runtime state that would otherwise default into the real data/ dir.
    env: {
      HAPPYCLAW_CODEX_INSTALLATION_ID_FILE: '',
      HAPPYCLAW_WORKSPACE_ROOT: testWorkspaceRoot,
    },
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'data/**',
      '.claude/**',
      'web/tests/e2e/**',
    ],
  },
});
