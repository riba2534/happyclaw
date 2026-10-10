import { useEffect, useState } from 'react';

// A visual viewport this much shorter than the layout viewport is a software
// keyboard; smaller gaps are rounding or browser chrome.
const KEYBOARD_MIN_HEIGHT_PX = 50;

export function useKeyboardHeight() {
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const root = document.documentElement;

    const handleResize = () => {
      // Pinch-zoom also shrinks the visual viewport; padding the composer by
      // the zoomed-away height would push it off screen.
      const gap =
        viewport.scale > 1.01 ? 0 : window.innerHeight - viewport.height;
      const height = gap >= KEYBOARD_MIN_HEIGHT_PX ? Math.round(gap) : 0;
      setKeyboardHeight(height);
      root.style.setProperty('--keyboard-height', `${height}px`);
    };

    // A composer remounted while the keyboard is up (switching sessions)
    // must not wait for the next resize to pick it up.
    handleResize();
    viewport.addEventListener('resize', handleResize);
    viewport.addEventListener('scroll', handleResize);

    // When a textarea/input gains focus, scroll it into view after a short
    // delay so the iOS keyboard animation has time to settle.
    const handleFocusIn = (e: FocusEvent) => {
      const target = e.target;
      if (
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLInputElement
      ) {
        setTimeout(() => {
          target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }, 300);
      }
    };
    document.addEventListener('focusin', handleFocusIn);

    return () => {
      viewport.removeEventListener('resize', handleResize);
      viewport.removeEventListener('scroll', handleResize);
      document.removeEventListener('focusin', handleFocusIn);
      // The padding belongs to this composer; leaving it set would keep
      // padding whatever renders next.
      root.style.removeProperty('--keyboard-height');
    };
  }, []);

  return { keyboardHeight, isKeyboardVisible: keyboardHeight > 0 };
}
