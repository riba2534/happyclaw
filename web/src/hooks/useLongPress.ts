import { useEffect, useRef, type PointerEvent, type MouseEvent } from 'react';

import { useStableCallback } from './useStableCallback';

/** A finger that wanders further than this is scrolling, not pressing. */
const MOVE_TOLERANCE = 8;
/** How long after a long press's release its click may still arrive. */
const CLICK_WINDOW_MS = 600;

/**
 * Press and hold with a finger or pen (cindy's long-press action sheets,
 * HomeSurface). Moving more than 8px or a cancelled pointer (the page
 * started scrolling) calls it off. After it fires, the click the release
 * would make is swallowed, and so is the native context menu or text
 * callout; a mouse keeps its right click. A press on an image is left to
 * the system image menu (Save Image) and starts nothing, as does one in an
 * overlay the element's children portal out.
 */
export function useLongPress(
  onLongPress: () => void,
  opts?: { ms?: number },
): {
  onPointerDown: (event: PointerEvent<Element>) => void;
  onPointerUp: (event: PointerEvent<Element>) => void;
  onPointerCancel: (event: PointerEvent<Element>) => void;
  onPointerMove: (event: PointerEvent<Element>) => void;
  onContextMenu: (event: MouseEvent<Element>) => void;
} {
  const ms = opts?.ms ?? 500;
  const fire = useStableCallback(onLongPress);
  const pressRef = useRef<{
    pointerId: number;
    x: number;
    y: number;
    timer: number;
  } | null>(null);
  // A touch press is under way or just fired: its context menu is ours.
  const touchRef = useRef(false);
  const firedRef = useRef(false);

  const cancel = () => {
    if (pressRef.current) window.clearTimeout(pressRef.current.timer);
    pressRef.current = null;
  };
  useEffect(() => cancel, []);

  /** Swallows the click that ends a long press, in the capture phase. */
  const swallowNextClick = () => {
    const swallow = (event: Event) => {
      event.preventDefault();
      event.stopPropagation();
      done();
    };
    const done = () => {
      window.removeEventListener('click', swallow, true);
      window.clearTimeout(timeout);
    };
    window.addEventListener('click', swallow, true);
    const timeout = window.setTimeout(done, CLICK_WINDOW_MS);
  };

  return {
    onPointerDown(event) {
      cancel();
      firedRef.current = false;
      const target = event.target as Element;
      touchRef.current =
        event.pointerType !== 'mouse' &&
        // React passes up the presses in a portal it renders (the image
        // viewer, a sheet): they are not on this element.
        event.currentTarget.contains(target) &&
        !target.closest('img');
      if (!touchRef.current || !event.isPrimary) return;
      // iOS shows its callout and selection on a held finger otherwise.
      const style = (event.currentTarget as HTMLElement).style;
      style.setProperty('-webkit-touch-callout', 'none');
      style.setProperty('-webkit-user-select', 'none');
      style.setProperty('user-select', 'none');
      pressRef.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        timer: window.setTimeout(() => {
          pressRef.current = null;
          firedRef.current = true;
          fire();
        }, ms),
      };
    },
    onPointerMove(event) {
      const press = pressRef.current;
      if (!press || press.pointerId !== event.pointerId) return;
      if (
        Math.hypot(event.clientX - press.x, event.clientY - press.y) >
        MOVE_TOLERANCE
      ) {
        cancel();
      }
    },
    onPointerUp() {
      cancel();
      // The click this release makes would land on whatever the press
      // opened, or act on the pressed row.
      if (firedRef.current) swallowNextClick();
    },
    onPointerCancel: cancel,
    onContextMenu(event) {
      // Android fires contextmenu for a held finger.
      if (touchRef.current) event.preventDefault();
    },
  };
}
