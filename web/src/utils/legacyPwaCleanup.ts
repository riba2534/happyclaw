const LEGACY_CACHE_NAMES = new Set([
  'api-core-cache',
  'api-groups-cache',
  'google-fonts-cache',
  'gstatic-fonts-cache',
  'local-fonts-cache',
  'mermaid-runtime-cache',
]);

export function isLegacyPwaCacheName(name: string): boolean {
  return name.startsWith('workbox-') || LEGACY_CACHE_NAMES.has(name);
}

/**
 * Whether a registration is the retired Workbox worker (`/sw.js`). One scope
 * holds one registration, so the push worker (`/push-sw.js`) shares the
 * Workbox worker's scope: a registration is never judged by scope alone. One
 * that also runs the push worker (the upgrade is in flight) is not legacy.
 */
export function isLegacyHappyClawRegistration(
  registration: Pick<
    ServiceWorkerRegistration,
    'active' | 'waiting' | 'installing'
  >,
  legacyScriptUrl: string,
  pushScriptUrl: string,
): boolean {
  const scripts = [
    registration.active,
    registration.waiting,
    registration.installing,
  ].map((worker) => worker?.scriptURL);
  return scripts.includes(legacyScriptUrl) && !scripts.includes(pushScriptUrl);
}

/**
 * Remove registrations and Cache Storage left by HappyClaw releases that used
 * Workbox. The push worker's registration is kept. The cleanup is deliberately best-effort and never blocks rendering.
 */
export async function cleanupLegacyPwaArtifacts(): Promise<void> {
  if (typeof window === 'undefined') return;

  const appScope = new URL(import.meta.env.BASE_URL, window.location.origin)
    .href;
  const legacyScriptUrl = new URL('sw.js', appScope).href;
  const pushScriptUrl = new URL('push-sw.js', appScope).href;
  const tasks: Promise<unknown>[] = [];

  if ('serviceWorker' in navigator) {
    tasks.push(
      navigator.serviceWorker
        .getRegistrations()
        .then((registrations) =>
          Promise.allSettled(
            registrations
              .filter((registration) =>
                isLegacyHappyClawRegistration(
                  registration,
                  legacyScriptUrl,
                  pushScriptUrl,
                ),
              )
              .map((registration) => registration.unregister()),
          ),
        ),
    );
  }

  if ('caches' in window) {
    tasks.push(
      caches
        .keys()
        .then((names) =>
          Promise.allSettled(
            names
              .filter(isLegacyPwaCacheName)
              .map((name) => caches.delete(name)),
          ),
        ),
    );
  }

  await Promise.allSettled(tasks);
}
