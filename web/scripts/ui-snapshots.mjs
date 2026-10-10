#!/usr/bin/env node
// Capture a screenshot matrix of the main Web routes for visual review.
//
// Usage:
//   UI_SNAPSHOT_PASSWORD=... node scripts/ui-snapshots.mjs \
//     --base http://127.0.0.1:5173 --out test-results/ui-snapshots/baseline \
//     [--user admin] [--schemes orange,default,neutral] [--modes light,dark] \
//     [--viewports desktop,laptop,mobile] [--routes /chat,/settings] [--folder main]
//
// Output goes under web/test-results/ (gitignored). The account must already
// exist; the script logs in through the API and never mutates server state.
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}
const list = (key, fallback) =>
  (args.get(key) ?? fallback)
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);

const base = args.get('base') ?? 'http://127.0.0.1:5173';
const out = path.resolve(args.get('out') ?? 'test-results/ui-snapshots/latest');
const username = args.get('user') ?? 'admin';
const password = process.env.UI_SNAPSHOT_PASSWORD;
const folder = args.get('folder') ?? 'main';
const schemes = list('schemes', 'orange');
const modes = list('modes', 'light,dark');
const viewportNames = list('viewports', 'desktop,mobile');

const VIEWPORTS = {
  desktop: { width: 1440, height: 900 },
  laptop: { width: 1024, height: 768 },
  mobile: { width: 390, height: 844, isMobile: true, hasTouch: true },
};

const DEFAULT_ROUTES = [
  '/chat',
  `/chat/${folder}`,
  '/agent-profiles',
  '/capabilities/skills',
  '/capabilities/mcp',
  '/capabilities/plugins',
  '/tasks',
  '/usage',
  '/memory',
  '/settings?tab=profile',
  '/settings?tab=preferences',
  '/settings?tab=claude',
  '/settings?tab=system',
  '/monitor',
  '/users',
  '/login',
];
const routes = list('routes', DEFAULT_ROUTES.join(','));

if (!password) {
  console.error('UI_SNAPSHOT_PASSWORD is required');
  process.exit(1);
}

const slug = (route) =>
  route.replace(/^\//, '').replace(/[/?=&]+/g, '_') || 'root';

const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
});

const login = await browser.newContext({ baseURL: base });
const res = await login.request.post('/api/auth/login', {
  data: { username, password },
  headers: { Origin: base },
});
if (!res.ok()) {
  console.error('login failed', res.status(), await res.text());
  process.exit(1);
}
const storageState = await login.storageState();
await login.close();

let count = 0;
for (const viewportName of viewportNames) {
  const viewport = VIEWPORTS[viewportName];
  for (const scheme of schemes) {
    for (const mode of modes) {
      const dir = path.join(out, viewportName, `${scheme}-${mode}`);
      fs.mkdirSync(dir, { recursive: true });
      for (const route of routes) {
        const loggedOut = route.startsWith('/login');
        const context = await browser.newContext({
          baseURL: base,
          viewport: { width: viewport.width, height: viewport.height },
          isMobile: viewport.isMobile,
          hasTouch: viewport.hasTouch,
          colorScheme: mode,
          storageState: loggedOut ? undefined : storageState,
        });
        await context.addInitScript(
          ([s, m]) => {
            localStorage.setItem('happyclaw-theme', m);
            // orange is the implicit default: the app stores it by removing the key
            if (s === 'orange')
              localStorage.removeItem('happyclaw-color-scheme');
            else localStorage.setItem('happyclaw-color-scheme', s);
          },
          [scheme, mode],
        );
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', (err) => errors.push(err.message));
        await page.goto(route, { waitUntil: 'networkidle' }).catch(() => {});
        await page.waitForTimeout(600);
        const file = path.join(dir, `${slug(route)}.png`);
        await page.screenshot({ path: file });
        if (errors.length) console.warn(`[${route}] page errors:`, errors);
        count += 1;
        await context.close();
      }
    }
  }
}

await browser.close();
console.log(`captured ${count} screenshots → ${out}`);
