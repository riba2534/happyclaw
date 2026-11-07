// @vitest-environment happy-dom

import fs from 'node:fs';
import path from 'node:path';
import { Navigate, matchRoutes } from 'react-router-dom';
import { afterAll, describe, expect, test } from 'vitest';
import { createAppRouter } from '../web/src/App';
import {
  isLegacyHappyClawRegistration,
  isLegacyPwaCacheName,
} from '../web/src/utils/legacyPwaCleanup';

// Importing App starts preloading the chat page and the app shell (the
// default route); let those imports settle before the environment is torn
// down, or a late module load fails the run.
afterAll(async () => {
  await Promise.all([
    import('../web/src/pages/ChatPage'),
    import('../web/src/components/layout/AppLayout'),
  ]);
});

const root = process.cwd();
const read = (relativePath: string) =>
  fs.readFileSync(path.join(root, relativePath), 'utf-8');

describe('PWA cache retirement', () => {
  test('removes Workbox generation and runtime API caching', () => {
    const viteConfig = read('web/vite.config.ts');
    const packageJson = JSON.parse(read('web/package.json')) as {
      devDependencies?: Record<string, string>;
    };

    expect(viteConfig).not.toMatch(/VitePWA|workbox|runtimeCaching/);
    expect(packageJson.devDependencies).not.toHaveProperty('vite-plugin-pwa');
  });

  test('keeps the mobile standalone manifest without registering a worker', () => {
    const html = read('web/index.html');
    const main = read('web/src/main.tsx');
    const manifest = JSON.parse(read('web/public/manifest.webmanifest')) as {
      display: string;
      start_url: string;
      scope: string;
      icons: Array<{ sizes: string; purpose?: string }>;
    };

    expect(html).toContain(
      '<link rel="manifest" href="%BASE_URL%manifest.webmanifest" />',
    );
    expect(html).toContain('apple-mobile-web-app-capable');
    expect(main).toContain('cleanupLegacyPwaArtifacts');
    expect(main).not.toMatch(/serviceWorker\.register|registerSW/);
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('./chat');
    expect(manifest.scope).toBe('./');
    expect(manifest.icons.map((icon) => icon.sizes)).toEqual(
      expect.arrayContaining(['192x192', '512x512']),
    );
    expect(manifest.icons).toContainEqual(
      expect.objectContaining({ sizes: '512x512', purpose: 'maskable' }),
    );
  });

  test('manifest shortcuts open real routes in the existing window', () => {
    const { routes } = createAppRouter(false);
    const manifest = JSON.parse(read('web/public/manifest.webmanifest')) as {
      launch_handler?: { client_mode: string | string[] };
      shortcuts?: Array<{ name: string; url: string }>;
    };

    // Not navigate-existing: useLaunchQueue routes in place (see there).
    expect([manifest.launch_handler?.client_mode].flat()[0]).toBe(
      'focus-existing',
    );
    expect(manifest.shortcuts?.length).toBeGreaterThan(0);
    for (const shortcut of manifest.shortcuts ?? []) {
      // Relative to the scope, so a sub-path deployment keeps working.
      expect(shortcut.url).toMatch(/^\.\/[a-z-]+$/);
      // The route the router would render; unknown paths hit the catch-all.
      const element = matchRoutes(routes, shortcut.url.slice(1))?.at(-1)?.route
        .element as { type?: unknown } | undefined;
      expect(
        element?.type ?? Navigate,
        `${shortcut.url} is not a page route`,
      ).not.toBe(Navigate);
    }
  });

  test('turns off iOS data detectors for dates and addresses too', () => {
    const html = read('web/index.html');
    const detection = html.match(
      /name="format-detection"\s+content="([^"]+)"/,
    )?.[1];

    expect(detection?.split(/,\s*/)).toEqual(
      expect.arrayContaining([
        'telephone=no',
        'email=no',
        'date=no',
        'address=no',
      ]),
    );
  });

  test('ships a non-caching self-destruct worker for old installations', () => {
    const worker = read('web/public/sw.js');

    expect(worker).toContain('self.skipWaiting()');
    expect(worker).toContain('self.registration.unregister()');
    expect(worker).toContain('client.navigate(client.url)');
    expect(worker).not.toMatch(/addEventListener\(['"]fetch|cache\.put|addAll/);
  });

  test('ships a push-only worker that never caches or intercepts requests', () => {
    const worker = read('web/public/push-sw.js');

    expect(worker).toMatch(/addEventListener\('push'/);
    expect(worker).toMatch(/addEventListener\('notificationclick'/);
    // No fetch handler (it would make the worker a controller of every
    // request) and no Cache Storage at all.
    expect(worker).not.toMatch(/addEventListener\(['"]fetch/);
    expect(worker).not.toMatch(/\bcaches\b|cache\.put|addAll|importScripts/);
    // The retired worker keeps its name and behavior.
    expect(read('web/public/sw.js')).toContain(
      'self.registration.unregister()',
    );
  });

  test('only Settings registers the push worker, never the app start', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(path.join(root, dir), {
        withFileTypes: true,
      })) {
        const relative = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(relative);
        else if (
          /\.tsx?$/.test(entry.name) &&
          !/\.test\.tsx?$/.test(entry.name) &&
          /serviceWorker\s*\.\s*register\(/.test(read(relative))
        ) {
          offenders.push(relative);
        }
      }
    };
    walk('web/src');

    expect(offenders).toEqual(['web/src/utils/webPush.ts']);
    expect(read('web/src/hooks/usePushNotifications.ts')).toContain(
      'ensurePushRegistration',
    );
    expect(read('web/src/hooks/useWebPushLifecycle.ts')).not.toContain(
      'ensurePushRegistration',
    );
  });

  test('recognizes only HappyClaw legacy caches and registrations', () => {
    expect(
      isLegacyPwaCacheName('workbox-precache-v2-https://example.com/'),
    ).toBe(true);
    expect(isLegacyPwaCacheName('api-groups-cache')).toBe(true);
    expect(isLegacyPwaCacheName('unrelated-product-cache')).toBe(false);

    const appScope = 'https://example.com/happyclaw/';
    const legacyUrl = `${appScope}sw.js`;
    const pushUrl = `${appScope}push-sw.js`;
    const registration = (
      active: string | null,
      installing: string | null = null,
    ) => ({
      active: active ? ({ scriptURL: active } as ServiceWorker) : null,
      waiting: null,
      installing: installing
        ? ({ scriptURL: installing } as ServiceWorker)
        : null,
    });

    // The old Workbox worker is cleaned up …
    expect(
      isLegacyHappyClawRegistration(
        registration(legacyUrl),
        legacyUrl,
        pushUrl,
      ),
    ).toBe(true);
    // … the push worker, which shares its scope, is not.
    expect(
      isLegacyHappyClawRegistration(registration(pushUrl), legacyUrl, pushUrl),
    ).toBe(false);
    // Nor is a registration mid-upgrade from the legacy worker to the push one.
    expect(
      isLegacyHappyClawRegistration(
        registration(legacyUrl, pushUrl),
        legacyUrl,
        pushUrl,
      ),
    ).toBe(false);
    // Another app's worker, and an empty registration, are left alone.
    expect(
      isLegacyHappyClawRegistration(
        registration('https://example.com/other/sw.js'),
        legacyUrl,
        pushUrl,
      ),
    ).toBe(false);
    expect(
      isLegacyHappyClawRegistration(registration(null), legacyUrl, pushUrl),
    ).toBe(false);
  });

  test('rebuild detection includes mobile manifest and cleanup worker assets', () => {
    const makefile = read('Makefile');
    const webServer = read('src/web.ts');

    expect(makefile).toContain(
      'find web/src/ web/public/ -type f -newer web/dist/index.html',
    );
    expect(webServer).toContain("p === '/index.html'");
    expect(webServer).toContain("p === '/sw.js'");
    expect(webServer).toContain("p === '/push-sw.js'");
    expect(webServer).toContain("'no-cache, no-store, must-revalidate'");
  });
});
