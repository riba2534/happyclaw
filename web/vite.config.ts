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
            background_color: '#FAF9F5',
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
            // 离线化：导航请求（如从桌面图标/刷新进入）回退到 index.html，
            // 让 SPA 在无网络时也能加载、路由依然工作。
            // navigateFallbackDenylist 排除非 SPA 路由（API、WebSocket）。
            navigateFallback: `${APP_BASE}index.html`,
            navigateFallbackDenylist: [/^\/api\//, /^\/ws/],
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
                urlPattern: /\/fonts\/.+\.woff2$/i,
                handler: 'CacheFirst',
                options: {
                  cacheName: 'local-fonts-cache',
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
              // ─── 消息历史（IM 体验：local-first + 实时推送对账）───
              // 使用 StaleWhileRevalidate：cache-first 即时渲染 + 后台 fetch 刷新。
              //
              // 已评估 NetworkFirst：实时性更好，但弱网下 200-500ms 等待会
              // 破坏「切对话加速」这一核心目标（与 WeChat / Telegram / iMessage
              // 0ms 出本地缓存的标杆体验背离）。权衡后选 SWR。
              //
              // 脏数据风险（SWR 第一帧可能渲染陈旧消息）通过下列机制消化：
              //   1. WebSocket new_message / stream_event 实时推送对账
              //   2. 2s 轮询拉增量（refreshMessages）
              //   3. clearHistory / deleteMessage 后调用 invalidateGroupCache(jid)
              //      主动清掉对应 SW cache 条目，杜绝"幽灵消息"
              //   4. login/logout 调 clearApiCaches() 阻止跨用户串号
              //   5. 服务端响应头 Cache-Control: private, no-store 兜底
              // `?after=` 增量轮询（每 2s）排除以免占用 maxEntries 配额。
              // agents 列表不在此处理：store 层已 memoize，SW 介入只会增加
              // 双层缓存失效协调的复杂度。
              {
                urlPattern: ({ url, request }) => {
                  if (request.method !== 'GET') return false;
                  if (url.searchParams.has('after')) return false; // 排除轮询
                  return /^\/api\/groups\/[^/]+\/messages$/.test(url.pathname);
                },
                handler: 'StaleWhileRevalidate',
                options: {
                  cacheName: 'api-groups-cache',
                  expiration: {
                    maxEntries: 50,
                    maxAgeSeconds: 60 * 60 * 24, // 1 day
                  },
                  cacheableResponse: { statuses: [200] },
                },
              },
              // ─── 用户身份（高敏感、需强一致）───
              // NetworkFirst + 短超时：登录态切换后必须立刻反映新用户。
              // 配合 auth store 在 login/logout 主动 caches.delete() 兜底。
              {
                urlPattern: ({ url, request }) => {
                  if (request.method !== 'GET') return false;
                  return url.pathname === '/api/auth/me';
                },
                handler: 'NetworkFirst',
                options: {
                  cacheName: 'api-core-cache',
                  networkTimeoutSeconds: 2,
                  expiration: {
                    maxEntries: 5,
                    maxAgeSeconds: 60 * 60 * 24, // 1 day（不再是 7 天）
                  },
                  cacheableResponse: { statuses: [200] },
                },
              },
              // ─── 群组列表（中频变化）───
              // SWR 即可：侧边栏列表，离线启动时立即出，后台刷新即可。
              {
                urlPattern: ({ url, request }) => {
                  if (request.method !== 'GET') return false;
                  return url.pathname === '/api/groups';
                },
                handler: 'StaleWhileRevalidate',
                options: {
                  cacheName: 'api-core-cache',
                  expiration: {
                    maxEntries: 5,
                    maxAgeSeconds: 60 * 60 * 24, // 1 day
                  },
                  cacheableResponse: { statuses: [200] },
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
