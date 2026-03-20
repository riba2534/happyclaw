import { useRef, useCallback, useEffect } from 'react';
import { useMediaQuery } from './useMediaQuery';

interface SwipeBackOptions {
  edgeWidth?: number;
  threshold?: number;
}

export function useSwipeBack(
  containerRef: React.RefObject<HTMLElement | null>,
  onBack: () => void,
  options: SwipeBackOptions = {}
) {
  const { edgeWidth = 20, threshold = 0.4 } = options;
  const isMobile = useMediaQuery('(max-width: 1023px)');
  const isStandalone = useMediaQuery('(display-mode: standalone)');
  const touchRef = useRef({
    startX: 0,
    startY: 0,
    active: false,
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

  const handleTouchStart = useCallback((e: TouchEvent) => {
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest('[data-swipe-back-ignore="true"]')) return;

    const touch = e.touches[0];
    if (touch.clientX < edgeWidth) {
      touchRef.current = {
        startX: touch.clientX,
        startY: touch.clientY,
        active: true,
        currentX: 0,
        isHorizontal: null,
      };
    }
  }, [edgeWidth]);

  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (!touchRef.current.active) return;
    const touch = e.touches[0];
    const deltaX = touch.clientX - touchRef.current.startX;
    const deltaY = touch.clientY - touchRef.current.startY;

    // Direction detection after minimal movement.
    if (touchRef.current.isHorizontal === null) {
      if (Math.abs(deltaX) < 8 && Math.abs(deltaY) < 8) return;
      touchRef.current.isHorizontal = Math.abs(deltaX) > Math.abs(deltaY) * 1.2;
      if (!touchRef.current.isHorizontal) {
        touchRef.current.active = false;
        resetTransformNow();
        return;
      }
    }

    if (deltaX > 0 && containerRef.current) {
      touchRef.current.currentX = deltaX;
      containerRef.current.style.transition = 'none';
      containerRef.current.style.transform = `translateX(${deltaX}px)`;
      containerRef.current.style.willChange = 'transform';
    }
  }, [containerRef, resetTransformNow]);

  const handleTouchEnd = useCallback(() => {
    if (!touchRef.current.active) return;
    touchRef.current.active = false;
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
      el.style.transform = `translateX(${screenWidth}px)`;
      clearTimer();
      timeoutRef.current = setTimeout(() => {
        resetTransformNow();
        onBack();
      }, 250);
    } else {
      snapBack();
    }
  }, [containerRef, threshold, onBack, clearTimer, resetTransformNow, snapBack]);

  const handleTouchCancel = useCallback(() => {
    if (!touchRef.current.active && touchRef.current.currentX <= 0) return;
    touchRef.current.active = false;
    touchRef.current.currentX = 0;
    touchRef.current.isHorizontal = null;
    snapBack();
  }, [snapBack]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !isMobile || !isStandalone) return;

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
  }, [containerRef, isMobile, isStandalone, handleTouchStart, handleTouchMove, handleTouchEnd, handleTouchCancel, clearTimer, resetTransformNow]);
}
