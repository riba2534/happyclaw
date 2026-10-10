import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * A callback whose identity never changes but always runs the latest `fn`.
 * For event handlers passed to memoized children, so a parent re-render does
 * not re-render them just because an inline closure was recreated. Do not call
 * the result during render.
 */
export function useStableCallback<Args extends unknown[], Result>(
  fn: (...args: Args) => Result,
): (...args: Args) => Result {
  const fnRef = useRef(fn);
  useLayoutEffect(() => {
    fnRef.current = fn;
  });
  return useCallback((...args: Args) => fnRef.current(...args), []);
}
