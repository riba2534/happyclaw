import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

const API_PROXY_TARGET = process.env.VITE_API_PROXY_TARGET || 'http://127.0.0.1:3000';
const WS_PROXY_TARGET = process.env.VITE_WS_PROXY_TARGET || 'ws://127.0.0.1:3000';
const ENABLE_DEV_PWA = process.env.VITE_PWA_DEV === 'true';
const MERMAID_RUNTIME_CHUNK_PATTERNS = [
  /(^|\/)assets\/mermaid(?:\.core)?-[^/]+\.js$/i,
  /(^|\/)assets\/(?:architectureDiagram|blockDiagram|c4Diagram|classDiagram(?:-v2)?|erDiagram|flowDiagram|ganttDiagram|gitGraphDiagram|infoDiagram|journeyDiagram|kanban-definition|mindmap-definition|pieDiagram|quadrantDiagram|requirementDiagram|sankeyDiagram|sequenceDiagram|stateDiagram(?:-v2)?|timeline-definition|xychartDiagram)-[^/]+\.js$/i,
  /(^|\/)assets\/(?:cytoscape\.esm|cose-bilkent|dagre|katex|treemap|layout|graph)-[^/]+\.js$/i,
];

function isMermaidRuntimeChunk(urlPath: string): boolean {
  return MERMAID_RUNTIME_CHUNK_PATTERNS.some((pattern) => pattern.test(urlPath));
}

const APP_BASE = (() => {
  const raw = (process.env.VITE_BASE_PATH || '/').trim();
  if (!raw) return '/';
  let base = raw;
  if (!base.startsWith('/')) base = `/${base}`;
  if (!base.endsWith('/')) base = `${base}/`;
  return base;
})();
const APP_START_URL = `${APP_BASE}chat`;

export default defineConfig(({ command }) => {
  const enablePwa = command === 'build' || ENABLE_DEV_PWA;
  return {
    base: APP_BASE,
    plugins: (() => {
      const basePlugins = [react(), tailwindcss()];
      if (!enablePwa) return basePlugins;
      return [
        ...basePlugins,
        VitePWA({
          registerType: 'autoUpdate',
          devOptions: {
            enabled: ENABLE_DEV_PWA,
            suppressWarnings: true,
            navigateFallback: `${APP_BASE}index.html`,
          },
          manifest: {
            name: 'HappyClaw',
            short_name: 'HappyClaw',
            description: 'Personal Claude Assistant',
            theme_color: '#0d9488',
            background_color: '#f8fafc',
            display: 'standalone',
            display_override: ['standalone'],
            id: APP_BASE,
            scope: APP_BASE,
            start_url: APP_START_URL,
            icons: [
              {
                src: `${APP_BASE}icons/icon-48.png`,
                sizes: '48x48',
                type: 'image/png',
              },
              {
                src: `${APP_BASE}icons/icon-72.png`,
                sizes: '72x72',
                type: 'image/png',
              },
              {
                src: `${APP_BASE}icons/icon-96.png`,
                sizes: '96x96',
                type: 'image/png',
              },
              {
                src: `${APP_BASE}icons/icon-128.png`,
                sizes: '128x128',
                type: 'image/png',
              },
              {
                src: `${APP_BASE}icons/icon-144.png`,
                sizes: '144x144',
                type: 'image/png',
              },
              {
                src: `${APP_BASE}icons/icon-152.png`,
                sizes: '152x152',
                type: 'image/png',
              },
              {
                src: `${APP_BASE}icons/icon-192.png`,
                sizes: '192x192',
                type: 'image/png',
              },
              {
                src: `${APP_BASE}icons/icon-384.png`,
                sizes: '384x384',
                type: 'image/png',
              },
              {
                src: `${APP_BASE}icons/icon-512.png`,
                sizes: '512x512',
                type: 'image/png',
              },
              {
                src: `${APP_BASE}icons/icon-512-maskable.png`,
                sizes: '512x512',
                type: 'image/png',
                purpose: 'maskable',
              },
            ],
          },
          workbox: {
            navigateFallback: null,
            manifestTransforms: [async (entries) => ({
              manifest: entries.filter((entry) => !isMermaidRuntimeChunk(entry.url)),
              warnings: [],
            })],
            runtimeCaching: [
              {
                urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
                handler: 'StaleWhileRevalidate',
                options: {
                  cacheName: 'google-fonts-cache',
                  expiration: {
                    maxEntries: 10,
                    maxAgeSeconds: 60 * 60 * 24 * 365,
                  },
                },
              },
              {
                urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
                handler: 'CacheFirst',
                options: {
                  cacheName: 'gstatic-fonts-cache',
                  expiration: {
                    maxEntries: 10,
                    maxAgeSeconds: 60 * 60 * 24 * 365,
                  },
                },
              },
              {
                urlPattern: ({ url }) => {
                  const p = url.pathname;
                  return /(^|\/)assets\/mermaid(?:\.core)?-[^/]+\.js$/i.test(p)
                    || /(^|\/)assets\/(?:architectureDiagram|blockDiagram|c4Diagram|classDiagram(?:-v2)?|erDiagram|flowDiagram|ganttDiagram|gitGraphDiagram|infoDiagram|journeyDiagram|kanban-definition|mindmap-definition|pieDiagram|quadrantDiagram|requirementDiagram|sankeyDiagram|sequenceDiagram|stateDiagram(?:-v2)?|timeline-definition|xychartDiagram)-[^/]+\.js$/i.test(p)
                    || /(^|\/)assets\/(?:cytoscape\.esm|cose-bilkent|dagre|katex|treemap|layout|graph)-[^/]+\.js$/i.test(p);
                },
                handler: 'StaleWhileRevalidate',
                options: {
                  cacheName: 'mermaid-runtime-cache',
                  expiration: {
                    maxEntries: 64,
                    maxAgeSeconds: 60 * 60 * 24 * 30,
                  },
                },
              },
            ],
          },
        }),
      ];
    })(),
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
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    build: {
      outDir: 'dist',
    },
  };
});
