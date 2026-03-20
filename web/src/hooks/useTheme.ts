import { useCallback, useEffect, useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'happyclaw-theme';
const listeners = new Set<() => void>();

function getSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function readTheme(): Theme {
  if (typeof window === 'undefined') return 'system';
  const stored = window.localStorage.getItem(STORAGE_KEY);
  if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  return 'system'; // default: follow system
}

function resolveTheme(theme: Theme): 'light' | 'dark' {
  return theme === 'system' ? getSystemTheme() : theme;
}

export function applyTheme(theme: Theme) {
  if (typeof document === 'undefined') return;
  const isDark = resolveTheme(theme) === 'dark';
  document.documentElement.classList.toggle('dark', isDark);
  // Sync theme-color meta tag for Android nav bar / iOS status bar
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute('content', isDark ? '#0f172a' : '#0d9488');
  }
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useTheme() {
  const getSnapshot = useCallback(() => readTheme(), []);
  const theme = useSyncExternalStore(subscribe, getSnapshot, () => 'system' as Theme);

  // Apply theme whenever it changes
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Listen to system preference changes — only matters when theme === 'system'
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      if (readTheme() === 'system') {
        applyTheme('system');
        listeners.forEach((cb) => cb());
      }
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const setTheme = useCallback((t: Theme) => {
    if (typeof window !== 'undefined') {
      if (t === 'system') {
        window.localStorage.removeItem(STORAGE_KEY); // no storage = follow system
      } else {
        window.localStorage.setItem(STORAGE_KEY, t);
      }
    }
    applyTheme(t);
    listeners.forEach((cb) => cb());
  }, []);

  // Cycle: light → dark → system → light
  const toggle = useCallback(() => {
    const next: Theme = theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light';
    setTheme(next);
  }, [theme, setTheme]);

  return { theme, resolvedTheme: resolveTheme(theme), toggle, setTheme };
}
