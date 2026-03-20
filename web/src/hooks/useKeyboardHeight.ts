import { useEffect, useState } from 'react';

export function useKeyboardHeight() {
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const handleResize = () => {
      const height = Math.max(0, window.innerHeight - viewport.height);
      setKeyboardHeight(height);
      document.documentElement.style.setProperty('--keyboard-height', `${height}px`);
    };

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
    };
  }, []);

  return { keyboardHeight, isKeyboardVisible: keyboardHeight > 0 };
}
