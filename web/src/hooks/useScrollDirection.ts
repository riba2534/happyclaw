import { useEffect, useState } from 'react';

/**
 * Scroll state of the app shell's floating chrome:
 * - `expanded`: near the top, the chrome shows in full.
 * - `compact`: scrolled past the top while moving down, the chrome shrinks.
 * - `revealed`: scrolled past the top while moving up, the chrome is back.
 */
export type ShellScrollState = 'expanded' | 'compact' | 'revealed';
type Direction = 'idle' | 'up' | 'down';

/** Leave `expanded` only once scrolled past this many pixels... */
export const COMPACT_ENTER_AT = 64;
/** ...and return to it only back within this many, so the edge doesn't flap. */
export const COMPACT_EXIT_BELOW = 24;
/** A direction change counts only after this much travel against it. */
export const DIRECTION_THRESHOLD = 4;

export interface ShellScrollTracker {
  state: ShellScrollState;
  direction: Direction;
  /** Furthest point reached in the current direction. */
  anchor: number;
}

export function createShellScrollTracker(
  scrollTop: number,
): ShellScrollTracker {
  return {
    state: scrollTop > COMPACT_ENTER_AT ? 'compact' : 'expanded',
    direction: 'idle',
    anchor: scrollTop,
  };
}

/** Advances the tracker to a new scroll offset (pure, for tests). */
export function stepShellScroll(
  prev: ShellScrollTracker,
  scrollTop: number,
): ShellScrollTracker {
  let { direction, anchor, state } = prev;

  // The anchor follows the scroll while it keeps going the same way, so a
  // reversal is measured from the turning point, not from the last frame.
  if (direction === 'idle') {
    if (Math.abs(scrollTop - anchor) >= DIRECTION_THRESHOLD) {
      direction = scrollTop > anchor ? 'down' : 'up';
      anchor = scrollTop;
    }
  } else if (direction === 'down') {
    if (scrollTop > anchor) anchor = scrollTop;
    else if (anchor - scrollTop >= DIRECTION_THRESHOLD) {
      direction = 'up';
      anchor = scrollTop;
    }
  } else if (scrollTop < anchor) anchor = scrollTop;
  else if (scrollTop - anchor >= DIRECTION_THRESHOLD) {
    direction = 'down';
    anchor = scrollTop;
  }

  if (scrollTop < COMPACT_EXIT_BELOW) state = 'expanded';
  else if (state === 'expanded') {
    if (scrollTop > COMPACT_ENTER_AT) state = 'compact';
  } else if (direction === 'down') state = 'compact';
  else if (direction === 'up') state = 'revealed';

  return { state, direction, anchor };
}

/** Radix (react-remove-scroll) marks the body while a dialog locks scrolling. */
function isScrollLocked(): boolean {
  return document.body.hasAttribute('data-scroll-locked');
}

/**
 * Tracks the shell scroll state of `scrollRef`, else the app scroll root
 * (`data-app-scroll-root`), else the window. Frozen while a dialog locks
 * scrolling, so the layout shift of the lock isn't read as a scroll.
 */
export function useShellScrollState(
  scrollRef?: React.RefObject<HTMLElement | null>,
): ShellScrollState {
  const [state, setState] = useState<ShellScrollState>('expanded');

  useEffect(() => {
    const el =
      scrollRef?.current ??
      document.querySelector<HTMLElement>('[data-app-scroll-root="true"]');

    // Clamp to the scrollable range so iOS rubber-banding past either end
    // doesn't read as a reversal.
    const read = () => {
      if (!el) {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        return Math.min(Math.max(0, window.scrollY), Math.max(0, max));
      }
      const max = el.scrollHeight - el.clientHeight;
      return Math.min(Math.max(0, el.scrollTop), Math.max(0, max));
    };

    let tracker = createShellScrollTracker(read());
    let wasLocked = false;
    let frame: number | null = null;
    setState(tracker.state);

    const update = () => {
      frame = null;
      if (isScrollLocked()) {
        wasLocked = true;
        return;
      }
      const top = read();
      if (wasLocked) {
        // Resume from wherever the lock left the page, without a direction.
        wasLocked = false;
        tracker = { ...tracker, direction: 'idle', anchor: top };
      }
      tracker = stepShellScroll(tracker, top);
      setState(tracker.state);
    };

    const onScroll = () => {
      if (frame === null) frame = requestAnimationFrame(update);
    };

    const target: EventTarget = el ?? window;
    target.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      target.removeEventListener('scroll', onScroll);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [scrollRef]);

  return state;
}

/**
 * Compatibility view of {@link useShellScrollState}: `down` while compact,
 * `up` once revealed, `null` near the top.
 */
export function useScrollDirection(
  scrollRef?: React.RefObject<HTMLElement | null>,
): 'up' | 'down' | null {
  const state = useShellScrollState(scrollRef);
  return state === 'compact' ? 'down' : state === 'revealed' ? 'up' : null;
}
