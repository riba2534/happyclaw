// PWA route restore: persist last visited route to localStorage so PWA reopens
// land on the user's previous location instead of the manifest start_url.
// Disabled by default; toggled from Settings → Profile.

const STORAGE_KEY_ENABLED = 'happyclaw-pwa-restore-enabled';
const STORAGE_KEY_ROUTE = 'happyclaw-pwa-last-route';
const STORAGE_KEY_TIMESTAMP = 'happyclaw-pwa-last-route-ts';

const EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

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
    ls.removeItem(STORAGE_KEY_TIMESTAMP);
  }
}

export function saveLastRoute(path: string): void {
  const ls = safeStorage();
  if (!ls) return;
  if (!path || isBlacklisted(path)) return;
  try {
    ls.setItem(STORAGE_KEY_ROUTE, path);
    ls.setItem(STORAGE_KEY_TIMESTAMP, String(Date.now()));
  } catch {
    /* quota exceeded — ignore */
  }
}

export function getLastRoute(): string | null {
  const ls = safeStorage();
  if (!ls) return null;
  const route = ls.getItem(STORAGE_KEY_ROUTE);
  const tsRaw = ls.getItem(STORAGE_KEY_TIMESTAMP);
  if (!route || !tsRaw) return null;
  const ts = Number(tsRaw);
  if (!Number.isFinite(ts) || Date.now() - ts > EXPIRY_MS) {
    ls.removeItem(STORAGE_KEY_ROUTE);
    ls.removeItem(STORAGE_KEY_TIMESTAMP);
    return null;
  }
  if (isBlacklisted(route)) return null;
  return route;
}
