import { useCallback, useSyncExternalStore } from 'react';
import { useAuthStore } from '../stores/auth';

export type DisplayMode = 'chat' | 'compact';

const DEFAULT_MODE: DisplayMode = 'chat';
const listeners = new Set<() => void>();

function getStorageKey(userId: string | null | undefined): string {
  return `happyclaw-display-mode:${userId || 'guest'}`;
}

function readMode(storageKey: string): DisplayMode {
  if (typeof window === 'undefined') return DEFAULT_MODE;
  const stored = window.localStorage.getItem(storageKey);
  return stored === 'compact' ? 'compact' : DEFAULT_MODE;
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useDisplayMode() {
  const userId = useAuthStore((s) => s.user?.id ?? null);
  const storageKey = getStorageKey(userId);
  const getSnapshot = useCallback(() => readMode(storageKey), [storageKey]);
  const setMode = useCallback(
    (mode: DisplayMode) => {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(storageKey, mode);
      }
      listeners.forEach((cb) => cb());
    },
    [storageKey],
  );
  const mode = useSyncExternalStore(subscribe, getSnapshot, () => DEFAULT_MODE);
  const toggle = useCallback(() => {
    setMode(mode === 'chat' ? 'compact' : 'chat');
  }, [mode, setMode]);
  return { mode, toggle, setMode };
}
