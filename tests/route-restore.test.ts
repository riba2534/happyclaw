import { describe, it, expect, beforeEach, vi } from 'vitest';

class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length() { return this.store.size; }
  clear() { this.store.clear(); }
  getItem(key: string) { return this.store.has(key) ? this.store.get(key)! : null; }
  setItem(key: string, value: string) { this.store.set(key, String(value)); }
  removeItem(key: string) { this.store.delete(key); }
  key(index: number) { return Array.from(this.store.keys())[index] ?? null; }
}

const memoryStorage = new MemoryStorage();
vi.stubGlobal('localStorage', memoryStorage);

const {
  isRouteRestoreEnabled,
  setRouteRestoreEnabled,
  saveLastRoute,
  getLastRoute,
} = await import('../web/src/utils/routeRestore');

describe('routeRestore', () => {
  beforeEach(() => {
    memoryStorage.clear();
  });

  describe('toggle', () => {
    it('defaults to disabled', () => {
      expect(isRouteRestoreEnabled()).toBe(false);
    });

    it('persists the enable flag', () => {
      setRouteRestoreEnabled(true);
      expect(isRouteRestoreEnabled()).toBe(true);
    });

    it('clears saved route when disabling', () => {
      setRouteRestoreEnabled(true);
      saveLastRoute('/chat/main');
      expect(getLastRoute()).toBe('/chat/main');

      setRouteRestoreEnabled(false);
      expect(isRouteRestoreEnabled()).toBe(false);
      expect(getLastRoute()).toBeNull();
    });
  });

  describe('saveLastRoute / getLastRoute', () => {
    it('round-trips a valid route', () => {
      saveLastRoute('/chat/main');
      expect(getLastRoute()).toBe('/chat/main');
    });

    it('preserves search params', () => {
      saveLastRoute('/settings?tab=groups');
      expect(getLastRoute()).toBe('/settings?tab=groups');
    });

    it('skips blacklisted login route', () => {
      saveLastRoute('/login');
      expect(getLastRoute()).toBeNull();
    });

    it('skips blacklisted register route', () => {
      saveLastRoute('/register');
      expect(getLastRoute()).toBeNull();
    });

    it('skips blacklisted setup root', () => {
      saveLastRoute('/setup');
      expect(getLastRoute()).toBeNull();
    });

    it('skips blacklisted setup subroutes', () => {
      saveLastRoute('/setup/providers');
      expect(getLastRoute()).toBeNull();

      saveLastRoute('/setup/channels');
      expect(getLastRoute()).toBeNull();
    });

    it('rejects empty path', () => {
      saveLastRoute('');
      expect(getLastRoute()).toBeNull();
    });
  });

  describe('expiry', () => {
    it('returns null and clears when expired', () => {
      saveLastRoute('/chat/main');
      // Backdate the timestamp by 8 days (exceeds 7-day expiry).
      const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
      memoryStorage.setItem('happyclaw-pwa-last-route-ts', String(eightDaysAgo));

      expect(getLastRoute()).toBeNull();
      // Subsequent reads should also be null (storage cleared).
      expect(memoryStorage.getItem('happyclaw-pwa-last-route')).toBeNull();
    });

    it('returns route when within expiry window', () => {
      saveLastRoute('/chat/main');
      const sixDaysAgo = Date.now() - 6 * 24 * 60 * 60 * 1000;
      memoryStorage.setItem('happyclaw-pwa-last-route-ts', String(sixDaysAgo));

      expect(getLastRoute()).toBe('/chat/main');
    });

    it('returns null on missing or invalid timestamp', () => {
      memoryStorage.setItem('happyclaw-pwa-last-route', '/chat/main');
      // No timestamp set.
      expect(getLastRoute()).toBeNull();

      memoryStorage.setItem('happyclaw-pwa-last-route-ts', 'not-a-number');
      expect(getLastRoute()).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('returns null when no route was saved', () => {
      expect(getLastRoute()).toBeNull();
    });
  });
});
