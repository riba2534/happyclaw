import { useEffect, useRef } from 'react';

/**
 * Poll `callback` every `intervalMs` while `enabled` and the tab is visible.
 * Hidden tabs stop polling; becoming visible again polls once immediately and
 * resumes the schedule. Calls never overlap: the next tick is scheduled only
 * after the previous callback settles.
 */
export function useVisibleInterval(
  callback: () => unknown,
  intervalMs: number,
  enabled = true,
): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let active = true;

    const schedule = () => {
      if (!active || document.hidden) return;
      timer = setTimeout(tick, intervalMs);
    };
    const tick = async () => {
      timer = undefined;
      running = true;
      try {
        await callbackRef.current();
      } catch {
        /* callers surface their own errors */
      } finally {
        running = false;
      }
      schedule();
    };
    const onVisibility = () => {
      if (document.hidden) {
        if (timer) clearTimeout(timer);
        timer = undefined;
      } else if (!timer && !running) {
        void tick();
      }
    };

    document.addEventListener('visibilitychange', onVisibility);
    schedule();
    return () => {
      active = false;
      document.removeEventListener('visibilitychange', onVisibility);
      if (timer) clearTimeout(timer);
    };
  }, [enabled, intervalMs]);
}
