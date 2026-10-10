import path from 'path';
import fs from 'node:fs';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const API_PROXY_TARGET =
  process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:3000';
const WS_PROXY_TARGET =
  process.env.VITE_WS_PROXY_TARGET || 'ws://127.0.0.1:3000';

const APP_BASE = (() => {
  const raw = (process.env.VITE_BASE_PATH || '/').trim();
  if (!raw) return '/';
  let base = raw;
  if (!base.startsWith('/')) base = `/${base}`;
  if (!base.endsWith('/')) base = `${base}/`;
  return base;
})();

function katexWoff2Only(): Plugin {
  return {
    name: 'happyclaw-katex-woff2-only',
    enforce: 'pre',
    transform(source, id) {
      if (!id.includes('/katex/dist/katex.min.css')) return null;
      return source.replace(
        /,url\([^)]*\.woff\) format\("woff"\),url\([^)]*\.ttf\) format\("truetype"\)/g,
        '',
      );
    },
  };
}

function lucideDirectImports(): Plugin {
  const iconIndex = fs.readFileSync(
    path.resolve(
      __dirname,
      'node_modules/lucide-react/dist/esm/lucide-react.js',
    ),
    'utf8',
  );
  const iconPaths = new Map<string, string>();
  for (const match of iconIndex.matchAll(
    /export \{([^}]+)\} from '\.\/icons\/([^']+)'/g,
  )) {
    for (const alias of match[1].matchAll(/default as (\w+)/g)) {
      iconPaths.set(alias[1], match[2]);
    }
  }

  return {
    name: 'happyclaw-lucide-direct-imports',
    // Build only. In dev every rewritten icon path is a dependency the
    // optimizer only meets on first use, and each discovery re-bundles and
    // reloads every open page (mid-test in e2e runs on a cold cache). The
    // dev server pre-bundles the lucide-react barrel once instead.
    apply: 'build',
    enforce: 'pre',
    transform(source, id) {
      if (!id.includes('/src/') || !/\.[jt]sx?(?:\?|$)/.test(id)) return null;
      const rewritten = source.replace(
        /import\s*\{([^}]*)\}\s*from\s*['"]lucide-react['"]\s*;?/g,
        (_statement, rawSpecifiers: string) =>
          rawSpecifiers
            .split(',')
            .map((specifier) => specifier.trim())
            .filter(Boolean)
            .map((specifier) => {
              const [imported, local = imported] = specifier.split(/\s+as\s+/);
              const iconPath = iconPaths.get(imported);
              if (!iconPath) {
                throw new Error(
                  `Unknown lucide-react icon export: ${imported}`,
                );
              }
              return `import ${local} from 'lucide-react/dist/esm/icons/${iconPath}';`;
            })
            .join('\n'),
      );
      return rewritten === source ? null : rewritten;
    },
  };
}

export default defineConfig({
  base: APP_BASE,
  plugins: [katexWoff2Only(), lucideDirectImports(), react(), tailwindcss()],
  server: {
    port: 5173,
    host: '0.0.0.0',
    strictPort: true,
    allowedHosts: true,
    hmr: {
      // VS Code Remote port forwarding requires explicit HMR client config
      clientPort: 5173,
    },
    proxy: {
      '/api': API_PROXY_TARGET,
      '/ws': {
        target: WS_PROXY_TARGET,
        ws: true,
      },
    },
  },
  optimizeDeps: {
    // Crawl the e2e harness pages too, so a dependency only they import is
    // pre-bundled at startup instead of reloading pages when first requested.
    entries: ['index.html', 'tests/e2e/*.html'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: 'dist',
  },
});
