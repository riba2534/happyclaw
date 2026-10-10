import { useEffect, useRef, useState } from 'react';

/**
 * Follow `value` at most once per `intervalMs`, always ending on the latest
 * value. Used for streamed text whose every update would otherwise re-parse
 * and re-render the whole Markdown reply at frame rate.
 */
export function useThrottledValue<T>(value: T, intervalMs: number): T {
  const [shown, setShown] = useState(value);
  const shownAtRef = useRef(0);

  useEffect(() => {
    const wait = shownAtRef.current + intervalMs - performance.now();
    if (wait <= 0) {
      shownAtRef.current = performance.now();
      setShown(value);
      return;
    }
    const timer = window.setTimeout(() => {
      shownAtRef.current = performance.now();
      setShown(value);
    }, wait);
    return () => window.clearTimeout(timer);
  }, [value, intervalMs]);

  return shown;
}
