import { useEffect, useSyncExternalStore } from 'react';

// A visual viewport this much shorter than the layout viewport is a software
// keyboard; smaller gaps are rounding or browser chrome.
const KEYBOARD_MIN_HEIGHT_PX = 50;
// The iOS keyboard slides in and out over about this long.
const KEYBOARD_SETTLE_MS = 400;
// A layout viewport this much shorter than its tallest at the same width was
// resized for a keyboard; browser toolbars change it by less.
const KEYBOARD_RESIZE_MIN_PX = 150;

export interface VisualViewportMetrics {
  /** Visible height in CSS px (the layout height while pinch-zoomed). */
  height: number;
  /** Layout-viewport pixels covered at the bottom by the software keyboard. */
  keyboardInset: number;
  /**
   * A software keyboard is up, whether it covers the page (keyboardInset) or
   * the page was resized above it. Either way the home indicator is under
   * the keyboard and the bottom safe area no longer applies.
   */
  keyboardOpen: boolean;
}

type ViewportLike = Pick<VisualViewport, 'height' | 'offsetTop' | 'scale'>;

/**
 * The single source for keyboard occlusion. iOS pans the visual viewport up
 * (offsetTop) when it focuses a low field; that pan already brings part of
 * the page into view, so only what is still covered counts. Pinch-zoom also
 * shrinks the visual viewport, and lifting UI by the zoomed-away height would
 * push it off screen, so zoom reports no keyboard and keeps the layout height.
 */
export function measureVisualViewport(
  layoutHeight: number,
  viewport: ViewportLike | null | undefined,
): VisualViewportMetrics {
  if (!viewport || viewport.scale > 1.01) {
    return {
      height: Math.round(layoutHeight),
      keyboardInset: 0,
      keyboardOpen: false,
    };
  }
  const covered = layoutHeight - viewport.height - viewport.offsetTop;
  const keyboardInset =
    covered >= KEYBOARD_MIN_HEIGHT_PX ? Math.round(covered) : 0;
  return {
    height: Math.round(viewport.height),
    keyboardInset,
    keyboardOpen: keyboardInset > 0,
  };
}

const listeners = new Set<() => void>();
let snapshot: VisualViewportMetrics = {
  height: 0,
  keyboardInset: 0,
  keyboardOpen: false,
};
// The tallest layout viewport seen at the current width, the baseline for
// telling a keyboard resize apart. A rotation or window resize starts over.
let tallest = { width: 0, height: 0 };
let detach: (() => void) | null = null;
// When a text field last lost focus. Closing the keyboard blurs the field
// before the page grows back, so for the length of the keyboard animation a
// still-short page keeps counting as a keyboard.
let blurredAt = Number.NEGATIVE_INFINITY;

/**
 * The layout viewport's height. Not window.innerHeight: an installed iOS 27
 * web app shrinks it to the visual viewport while the keyboard is up (the
 * page itself stays full height), which reads as no keyboard at all, and
 * restores it later without an event. The root's clientHeight is the layout
 * viewport in every browser and follows a real resize (Android's
 * resizes-content) too.
 */
export function layoutViewportHeight(): number {
  return document.documentElement.clientHeight || window.innerHeight;
}

/**
 * On an iPhone, iOS 27 resizes the whole layout viewport of an installed web
 * app above the keyboard, so nothing is covered (keyboardInset 0) and only
 * the drop from its full height shows the keyboard.
 */
export function resizedForKeyboard(
  layoutHeight: number,
  tallestHeight: number,
): boolean {
  return tallestHeight - layoutHeight >= KEYBOARD_RESIZE_MIN_PX;
}

const NON_TEXT_INPUT_TYPES = new Set([
  'button',
  'checkbox',
  'color',
  'file',
  'hidden',
  'image',
  'radio',
  'range',
  'reset',
  'submit',
]);

/**
 * Whether the focused element brings up a software keyboard. Only then can a
 * drop of the layout height mean a keyboard; without it the window itself got
 * shorter (Android split screen, a resized desktop window).
 */
export function editableHasFocus(): boolean {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable || el.closest('[contenteditable="true"]')) {
    return true;
  }
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) return !NON_TEXT_INPUT_TYPES.has(el.type);
  return false;
}

function read(): VisualViewportMetrics {
  const layoutHeight = layoutViewportHeight();
  const width = document.documentElement.clientWidth;
  if (width !== tallest.width) tallest = { width, height: layoutHeight };
  else if (layoutHeight > tallest.height) tallest.height = layoutHeight;
  const metrics = measureVisualViewport(layoutHeight, window.visualViewport);
  if (
    !metrics.keyboardOpen &&
    window.visualViewport &&
    window.visualViewport.scale <= 1.01 &&
    resizedForKeyboard(layoutHeight, tallest.height) &&
    (editableHasFocus() || Date.now() - blurredAt < KEYBOARD_SETTLE_MS)
  ) {
    metrics.keyboardOpen = true;
  }
  return metrics;
}

function update() {
  const next = read();
  if (
    next.height === snapshot.height &&
    next.keyboardInset === snapshot.keyboardInset &&
    next.keyboardOpen === snapshot.keyboardOpen
  ) {
    return;
  }
  snapshot = next;
  listeners.forEach((listener) => listener());
}

// One set of window listeners however many components subscribe; attached
// with the first subscriber and dropped with the last.
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!detach) {
    snapshot = read();
    const viewport = window.visualViewport;
    // vv 'scroll' carries the offsetTop pan; window 'resize' covers browsers
    // without visualViewport and the Android resizes-content case.
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    // iOS can put the keyboard away without a viewport event, when the page
    // was in the background meanwhile (switching apps). Read again when focus
    // or visibility changes, and once the keyboard animation has settled.
    let settle = 0;
    const recheck = () => {
      update();
      window.clearTimeout(settle);
      settle = window.setTimeout(update, KEYBOARD_SETTLE_MS);
    };
    const blurred = () => {
      blurredAt = Date.now();
      recheck();
    };
    document.addEventListener('focusin', recheck);
    document.addEventListener('focusout', blurred);
    document.addEventListener('visibilitychange', recheck);
    window.addEventListener('pageshow', recheck);
    detach = () => {
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      document.removeEventListener('focusin', recheck);
      document.removeEventListener('focusout', blurred);
      document.removeEventListener('visibilitychange', recheck);
      window.removeEventListener('pageshow', recheck);
      window.clearTimeout(settle);
    };
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && detach) {
      detach();
      detach = null;
    }
  };
}

function getSnapshot(): VisualViewportMetrics {
  // Before anything subscribes there is no listener keeping the cache fresh.
  if (!detach && typeof window !== 'undefined') snapshot = read();
  return snapshot;
}

export function useKeyboardInset(): number {
  return useSyncExternalStore(
    subscribe,
    () => getSnapshot().keyboardInset,
    () => 0,
  );
}

function isEditable(element: Element): boolean {
  return (
    (element instanceof HTMLElement && element.isContentEditable) ||
    element.matches('input, textarea, select')
  );
}

/**
 * iOS reveals a focused field by scrolling whatever holds it: the document
 * and overflow:hidden boxes too, which the app never scrolls. The composer
 * and bottom sheets already rise by --keyboard-inset, so that scroll counts
 * twice: the composer floats a scroll's height above the keyboard, or leaves
 * the screen together with the page around it. Undo it on the document and
 * on hidden boxes around the focused field; real scrollers keep theirs.
 */
export function undoFocusScroll(): void {
  const active = document.activeElement;
  if (!active || !isEditable(active)) return;
  for (let el = active.parentElement; el; el = el.parentElement) {
    if (el.scrollTop === 0) continue;
    const overflowY = getComputedStyle(el).overflowY;
    if (overflowY === 'hidden' || overflowY === 'clip') el.scrollTop = 0;
  }
  // html and body are overflow:hidden; the document never scrolls on purpose.
  if (window.scrollY !== 0 || window.scrollX !== 0) window.scrollTo(0, 0);
}

/**
 * Publishes `--vvh` and `--keyboard-inset` on <html>, and marks it
 * `data-keyboard="open"` while a keyboard is up (globals.css then zeroes
 * `--safe-bottom`). Mount once, from the
 * app shell; CSS everywhere reads the variables instead of measuring. Also
 * undoes the focus scroll iOS adds on top of that inset (undoFocusScroll).
 */
export function useVisualViewportVars(): void {
  useEffect(() => {
    const root = document.documentElement;
    // Root custom properties restyle the whole page; during the keyboard
    // animation only one of the two usually moves, so skip the other.
    const set = (name: string, px: number) => {
      const value = `${px}px`;
      if (root.style.getPropertyValue(name) !== value) {
        root.style.setProperty(name, value);
      }
    };
    const publish = () => {
      set('--vvh', snapshot.height);
      set('--keyboard-inset', snapshot.keyboardInset);
      if (snapshot.keyboardOpen) root.dataset.keyboard = 'open';
      else delete root.dataset.keyboard;
      undoFocusScroll();
    };
    const unsubscribe = subscribe(publish);
    publish();
    // Scroll does not bubble; capture sees the document's and every box's.
    document.addEventListener('scroll', undoFocusScroll, {
      capture: true,
      passive: true,
    });
    return () => {
      document.removeEventListener('scroll', undoFocusScroll, {
        capture: true,
      });
      unsubscribe();
      root.style.removeProperty('--vvh');
      root.style.removeProperty('--keyboard-inset');
      delete root.dataset.keyboard;
    };
  }, []);
}
