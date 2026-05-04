// PWA route restore: persist last visited route to localStorage so PWA reopens
// land on the user's previous location instead of the manifest start_url.
// Disabled by default; toggled from Settings → Profile.

const STORAGE_KEY_ENABLED = 'happyclaw-pwa-restore-enabled';
const STORAGE_KEY_ROUTE = 'happyclaw-pwa-last-route';

const BLACKLIST_PATTERNS: RegExp[] = [
  /^\/login(\?|$)/,
  /^\/register(\?|$)/,
  /^\/setup($|\/|\?)/,
];

function isBlacklisted(path: string): boolean {
  return BLACKLIST_PATTERNS.some((re) => re.test(path));
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function isRouteRestoreEnabled(): boolean {
  return safeStorage()?.getItem(STORAGE_KEY_ENABLED) === '1';
}

export function setRouteRestoreEnabled(enabled: boolean): void {
  const ls = safeStorage();
  if (!ls) return;
  if (enabled) {
    ls.setItem(STORAGE_KEY_ENABLED, '1');
  } else {
    ls.removeItem(STORAGE_KEY_ENABLED);
    ls.removeItem(STORAGE_KEY_ROUTE);
  }
}

export function saveLastRoute(path: string): void {
  const ls = safeStorage();
  if (!ls) return;
  if (!path || isBlacklisted(path)) return;
  try {
    ls.setItem(STORAGE_KEY_ROUTE, path);
  } catch {
    /* quota exceeded — ignore */
  }
}

export function getLastRoute(): string | null {
  const ls = safeStorage();
  if (!ls) return null;
  const route = ls.getItem(STORAGE_KEY_ROUTE);
  if (!route) return null;
  if (isBlacklisted(route)) return null;
  return route;
}
