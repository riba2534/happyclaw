import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ComponentProps,
  type ComponentType,
} from 'react';
import { toast } from 'sonner';
import { LoadErrorNotice } from '../components/common/LoadErrorNotice';
import { markChunkErrorHandled } from '../utils/staleChunkReload';

interface PreloadedOptions {
  /**
   * Rethrow a failed load during render, for route components: the route's
   * error element shows it and reloads a stale deployment.
   */
  rethrow?: boolean;
}

/** Lazily loaded dialogs are recognized by their `open` and `onClose` props. */
function dialogProps(
  props: object,
): { open: boolean; onClose: () => void } | null {
  const { open, onClose } = props as { open?: unknown; onClose?: unknown };
  return typeof open === 'boolean' && typeof onClose === 'function'
    ? { open, onClose: onClose as () => void }
    : null;
}

/**
 * A code-split component that can be preloaded and never suspends.
 *
 * React holds back revealing Suspense content for up to 300ms after its
 * fallback was shown. The app shell and the chat page are preloaded at entry
 * and usually finish loading within ~50ms of their fallback, yet with
 * `lazy()` they waited out that throttle on every load before the first data
 * requests could start. This renders the component synchronously once its
 * module has loaded, and otherwise shows `Fallback` until it has.
 *
 * Unless `rethrow` is set, a failed load stays local and never reloads the
 * page by itself: a dialog closes with a toast and tries again when
 * reopened, anything else shows a notice with retry and reload buttons.
 */
export function preloadedComponent<C extends ComponentType<any>>(
  load: () => Promise<{ default: C }>,
  Fallback: ComponentType,
  { rethrow = false }: PreloadedOptions = {},
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
        if (!rethrow) markChunkErrorHandled(error);
        throw error;
      },
    ));

  function Preloaded(props: ComponentProps<C>) {
    const [Component, setComponent] = useState(() => loaded);
    const [failed, setFailed] = useState(false);
    const dialog = dialogProps(props);
    const open = dialog?.open ?? false;
    const onCloseRef = useRef(dialog?.onClose);
    useLayoutEffect(() => {
      onCloseRef.current = dialog?.onClose;
    });

    // Reopening a dialog whose load failed tries again.
    const [wasOpen, setWasOpen] = useState(open);
    if (open !== wasOpen) {
      setWasOpen(open);
      if (open && failed) setFailed(false);
    }

    useEffect(() => {
      if (Component || failed) return;
      let active = true;
      preload().then(
        (next) => {
          if (active) setComponent(() => next);
        },
        (error: unknown) => {
          if (!active) return;
          if (rethrow) {
            // Rethrow during render so the route's error element (and the
            // stale-chunk recovery) sees a failed chunk like it does for lazy().
            setComponent(() => {
              throw error;
            });
          } else {
            setFailed(true);
          }
        },
      );
      return () => {
        active = false;
      };
    }, [Component, failed]);

    useEffect(() => {
      if (!failed || !open) return;
      // Browsers keep a failed module import for the rest of the page, so
      // reopening only helps when the failure happened before the fetch.
      toast.error('加载失败，请检查网络后重试', {
        action: { label: '刷新页面', onClick: () => window.location.reload() },
      });
      onCloseRef.current?.();
    }, [failed, open]);

    if (Component) return <Component {...props} />;
    if (failed && !dialog) {
      return (
        <LoadErrorNotice
          title="这部分内容加载失败"
          message="请检查网络后重试。"
          onRetry={() => setFailed(false)}
        />
      );
    }
    return <Fallback />;
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

/**
 * Fetch code-split chunks once the browser is idle after the first render. A
 * failed fetch is retried on first use and never reloads the page.
 */
export function preloadWhenIdle(...preloads: Array<() => unknown>) {
  const run = () =>
    preloads.forEach((preload) => {
      Promise.resolve()
        .then(preload)
        .catch((error: unknown) => markChunkErrorHandled(error));
    });
  if (typeof window === 'undefined') return () => undefined;
  if (typeof window.requestIdleCallback === 'function') {
    const handle = window.requestIdleCallback(run, { timeout: 5000 });
    return () => window.cancelIdleCallback(handle);
  }
  const timer = window.setTimeout(run, 2000);
  return () => window.clearTimeout(timer);
}
