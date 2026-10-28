import { useRef, useCallback, useEffect } from 'react';
import { useMediaQuery } from './useMediaQuery';

interface EdgeSwipeHandlers {
  /** Swipe right from the left edge. */
  onBack?: () => void;
  /** Swipe left from the right edge. */
  onForward?: () => void;
}

interface EdgeSwipeOptions {
  edgeWidth?: number;
  threshold?: number;
  /** Re-attach when the container element mounts or unmounts. */
  enabled?: boolean;
}

type Direction = 'back' | 'forward';

/**
 * Edge swipes for the installed PWA on phones, where iOS offers no history
 * gestures of its own: from the left edge goes back, from the right edge goes
 * forward. Safari tabs keep the system gestures, so this stays off there.
 * Targets inside `[data-swipe-back-ignore="true"]` (horizontally scrolling
 * code blocks, tables, diagrams) never start a swipe.
 */
export function useEdgeSwipe(
  containerRef: React.RefObject<HTMLElement | null>,
  handlers: EdgeSwipeHandlers,
  options: EdgeSwipeOptions = {},
) {
  const { edgeWidth = 20, threshold = 0.4, enabled = true } = options;
  const isMobile = useMediaQuery('(max-width: 1023px)');
  const isStandalone = useMediaQuery('(display-mode: standalone)');
  // Read at gesture time so new callbacks every render do not re-subscribe.
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const touchRef = useRef({
    startX: 0,
    startY: 0,
    direction: null as Direction | null,
    currentX: 0,
    isHorizontal: null as boolean | null,
  });
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const resetTransformNow = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    el.style.transform = '';
    el.style.transition = '';
    el.style.willChange = '';
  }, [containerRef]);

  const snapBack = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    el.style.transition = 'transform 250ms cubic-bezier(0.4, 0, 0.2, 1)';
    el.style.transform = 'translateX(0)';
    clearTimer();
    timeoutRef.current = setTimeout(() => {
      resetTransformNow();
    }, 250);
  }, [containerRef, clearTimer, resetTransformNow]);

  const handleTouchStart = useCallback(
    (e: TouchEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest('[data-swipe-back-ignore="true"]')) return;

      const touch = e.touches[0];
      const { onBack, onForward } = handlersRef.current;
      let direction: Direction | null = null;
      if (onBack && touch.clientX < edgeWidth) direction = 'back';
      else if (onForward && touch.clientX > window.innerWidth - edgeWidth)
        direction = 'forward';
      if (!direction) return;
      touchRef.current = {
        startX: touch.clientX,
        startY: touch.clientY,
        direction,
        currentX: 0,
        isHorizontal: null,
      };
    },
    [edgeWidth],
  );

  const handleTouchMove = useCallback(
    (e: TouchEvent) => {
      const { direction } = touchRef.current;
      if (!direction) return;
      const touch = e.touches[0];
      const deltaX = touch.clientX - touchRef.current.startX;
      const deltaY = touch.clientY - touchRef.current.startY;

      // Direction detection after minimal movement.
      if (touchRef.current.isHorizontal === null) {
        if (Math.abs(deltaX) < 8 && Math.abs(deltaY) < 8) return;
        touchRef.current.isHorizontal =
          Math.abs(deltaX) > Math.abs(deltaY) * 1.2;
        if (!touchRef.current.isHorizontal) {
          touchRef.current.direction = null;
          resetTransformNow();
          return;
        }
      }

      // Back follows the finger to the right, forward to the left.
      const distance = direction === 'back' ? deltaX : -deltaX;
      if (distance > 0 && containerRef.current) {
        touchRef.current.currentX = distance;
        containerRef.current.style.transition = 'none';
        containerRef.current.style.transform = `translateX(${direction === 'back' ? distance : -distance}px)`;
        containerRef.current.style.willChange = 'transform';
      }
    },
    [containerRef, resetTransformNow],
  );

  const handleTouchEnd = useCallback(() => {
    const { direction } = touchRef.current;
    if (!direction) return;
    touchRef.current.direction = null;
    const isHorizontal = touchRef.current.isHorizontal === true;
    touchRef.current.isHorizontal = null;

    const el = containerRef.current;
    if (!el) return;
    if (!isHorizontal) {
      resetTransformNow();
      return;
    }

    const swipeDistance = touchRef.current.currentX;
    const screenWidth = window.innerWidth;

    if (swipeDistance > screenWidth * threshold) {
      // Swipe out
      el.style.transition = 'transform 250ms cubic-bezier(0.4, 0, 0.2, 1)';
      el.style.transform = `translateX(${direction === 'back' ? screenWidth : -screenWidth}px)`;
      clearTimer();
      timeoutRef.current = setTimeout(() => {
        resetTransformNow();
        const { onBack, onForward } = handlersRef.current;
        (direction === 'back' ? onBack : onForward)?.();
      }, 250);
    } else {
      snapBack();
    }
  }, [containerRef, threshold, clearTimer, resetTransformNow, snapBack]);

  const handleTouchCancel = useCallback(() => {
    if (!touchRef.current.direction && touchRef.current.currentX <= 0) return;
    touchRef.current.direction = null;
    touchRef.current.currentX = 0;
    touchRef.current.isHorizontal = null;
    snapBack();
  }, [snapBack]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !enabled || !isMobile || !isStandalone) return;

    el.addEventListener('touchstart', handleTouchStart, { passive: true });
    el.addEventListener('touchmove', handleTouchMove, { passive: true });
    el.addEventListener('touchend', handleTouchEnd);
    el.addEventListener('touchcancel', handleTouchCancel);

    return () => {
      el.removeEventListener('touchstart', handleTouchStart);
      el.removeEventListener('touchmove', handleTouchMove);
      el.removeEventListener('touchend', handleTouchEnd);
      el.removeEventListener('touchcancel', handleTouchCancel);
      clearTimer();
      resetTransformNow();
    };
  }, [
    containerRef,
    enabled,
    isMobile,
    isStandalone,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
    handleTouchCancel,
    clearTimer,
    resetTransformNow,
  ]);
}
