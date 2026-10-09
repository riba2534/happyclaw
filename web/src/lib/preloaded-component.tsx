import {
  useEffect,
  useState,
  type ComponentProps,
  type ComponentType,
} from 'react';

/**
 * A code-split component that can be preloaded and never suspends.
 *
 * React holds back revealing Suspense content for up to 300ms after its
 * fallback was shown. The app shell and the chat page are preloaded at entry
 * and usually finish loading within ~50ms of their fallback, yet with
 * `lazy()` they waited out that throttle on every load before the first data
 * requests could start. This renders the component synchronously once its
 * module has loaded, and otherwise shows `Fallback` until it has.
 */
export function preloadedComponent<C extends ComponentType<any>>(
  load: () => Promise<{ default: C }>,
  Fallback: ComponentType,
) {
  let loaded: C | undefined;
  let pending: Promise<C> | undefined;
  const preload = () =>
    (pending ??= load().then(
      (module) => {
        loaded = module.default;
        return module.default;
      },
      (error: unknown) => {
        pending = undefined; // let a later mount retry
        throw error;
      },
    ));

  function Preloaded(props: ComponentProps<C>) {
    const [Component, setComponent] = useState(() => loaded);
    useEffect(() => {
      if (Component) return;
      let active = true;
      preload().then(
        (next) => {
          if (active) setComponent(() => next);
        },
        (error: unknown) => {
          // Rethrow during render so the route's error boundary (and the
          // stale-chunk recovery) sees a failed chunk like it does for lazy().
          if (active)
            setComponent(() => {
              throw error;
            });
        },
      );
      return () => {
        active = false;
      };
    }, [Component]);
    return Component ? <Component {...props} /> : <Fallback />;
  }

  return { Component: Preloaded, preload };
}

/**
 * True from the first render where `open` is true. Lazily loaded dialogs mount
 * on first open and then stay mounted so they keep their close animation.
 */
export function useOpenedOnce(open: boolean): boolean {
  const [opened, setOpened] = useState(open);
  if (open && !opened) setOpened(true);
  return opened || open;
}

/** Fetch code-split chunks once the browser is idle after the first render. */
export function preloadWhenIdle(...preloads: Array<() => unknown>) {
  const run = () => preloads.forEach((preload) => void preload());
  if (typeof window === 'undefined') return () => undefined;
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(run, { timeout: 5000 });
    return () => window.cancelIdleCallback(handle);
  }
  const timer = window.setTimeout(run, 2000);
  return () => window.clearTimeout(timer);
}
