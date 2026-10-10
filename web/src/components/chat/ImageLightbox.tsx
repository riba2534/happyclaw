import { useState, useRef, useCallback, useEffect } from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface ImageLightboxProps {
  images: string[];
  initialIndex: number;
  onClose: () => void;
}

const viewerButtonClass =
  'flex size-10 cursor-pointer items-center justify-center rounded-full bg-white/10 text-white backdrop-blur-sm transition-colors outline-none hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-white/60 disabled:cursor-default disabled:opacity-30';

/**
 * Full-screen image viewer. A Radix dialog, so it traps focus, closes on Esc,
 * locks page scroll and returns focus to the thumbnail. ←/→ and the side
 * buttons switch images; on touch, swipe to switch, pull down to close and
 * double-tap to zoom.
 */
export function ImageLightbox({
  images,
  initialIndex,
  onClose,
}: ImageLightboxProps) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [scale, setScale] = useState(1);
  const [translateY, setTranslateY] = useState(0);
  const [bgOpacity, setBgOpacity] = useState(1);
  const [isClosing, setIsClosing] = useState(false);
  const [isOpen, setIsOpen] = useState(false);

  const touchStartRef = useRef({ x: 0, y: 0 });
  const lastTapRef = useRef(0);
  const isDraggingRef = useRef(false);
  // Without a Radix Trigger, focus has nowhere to return to on close; hand it
  // back to whatever opened the viewer (the thumbnail).
  const [returnFocusTo] = useState(
    () => document.activeElement as HTMLElement | null,
  );
  const multiple = images.length > 1;

  // Open animation
  useEffect(() => {
    requestAnimationFrame(() => setIsOpen(true));
  }, []);

  const handleClose = useCallback(() => {
    setIsClosing(true);
    setIsOpen(false);
    setTimeout(() => onClose(), 300);
  }, [onClose]);

  const show = useCallback(
    (index: number) => {
      if (index < 0 || index >= images.length) return;
      setCurrentIndex(index);
      setScale(1);
    },
    [images.length],
  );

  const handleTouchStart = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    touchStartRef.current = { x: touch.clientX, y: touch.clientY };
    isDraggingRef.current = false;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    const dy = touch.clientY - touchStartRef.current.y;

    // Pull-down to close only when not zoomed
    if (scale === 1 && dy > 0) {
      isDraggingRef.current = true;
      setTranslateY(dy);
      setBgOpacity(Math.max(0, 1 - dy / 400));
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    const touch = e.changedTouches[0];
    const dx = touch.clientX - touchStartRef.current.x;
    const dy = touch.clientY - touchStartRef.current.y;

    // Pull-down close
    if (isDraggingRef.current && translateY > 150) {
      handleClose();
      return;
    }

    // Reset pull-down state
    if (isDraggingRef.current) {
      setTranslateY(0);
      setBgOpacity(1);
      isDraggingRef.current = false;
      return;
    }

    // Swipe left/right to switch images
    if (Math.abs(dx) > 50 && Math.abs(dy) < 50 && scale === 1) {
      show(dx < 0 ? currentIndex + 1 : currentIndex - 1);
      return;
    }

    // Double-tap zoom
    const now = Date.now();
    if (now - lastTapRef.current < 300) {
      setScale(scale === 1 ? 2 : 1);
      lastTapRef.current = 0;
    } else {
      lastTapRef.current = now;
    }
  };

  const visible = isOpen && !isClosing;
  const chromeStyle = {
    opacity: visible ? 1 : 0,
    transition: 'opacity 300ms ease',
  };
  const overlayStyle = {
    opacity: visible ? bgOpacity : 0,
    transition: isDraggingRef.current ? 'none' : 'opacity 300ms ease',
  };
  const imageStyle = {
    transform: `translateY(${translateY}px) scale(${scale})`,
    transition: isDraggingRef.current ? 'none' : 'transform 300ms ease',
  };

  return (
    // Stays open while the close animation runs; the parent unmounts it.
    <DialogPrimitive.Root open onOpenChange={(open) => !open && handleClose()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-[70] bg-black/90"
          style={overlayStyle}
        />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            returnFocusTo?.focus({ preventScroll: true });
          }}
          className="fixed inset-0 z-[70] flex items-center justify-center outline-none"
          onClick={handleClose}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft') show(currentIndex - 1);
            else if (e.key === 'ArrowRight') show(currentIndex + 1);
          }}
        >
          <DialogPrimitive.Title className="sr-only">
            图片预览 {currentIndex + 1} / {images.length}
          </DialogPrimitive.Title>

          <DialogPrimitive.Close
            onClick={(e) => e.stopPropagation()}
            className={cn(viewerButtonClass, 'absolute top-4 right-4 z-30')}
            aria-label="关闭"
            style={chromeStyle}
          >
            <X className="size-6" />
          </DialogPrimitive.Close>

          {multiple && (
            <>
              <button
                type="button"
                aria-label="上一张"
                disabled={currentIndex === 0}
                onClick={(e) => {
                  e.stopPropagation();
                  show(currentIndex - 1);
                }}
                className={cn(
                  viewerButtonClass,
                  'absolute top-1/2 left-4 z-30 -translate-y-1/2 max-sm:hidden',
                )}
                style={chromeStyle}
              >
                <ChevronLeft className="size-6" />
              </button>
              <button
                type="button"
                aria-label="下一张"
                disabled={currentIndex === images.length - 1}
                onClick={(e) => {
                  e.stopPropagation();
                  show(currentIndex + 1);
                }}
                className={cn(
                  viewerButtonClass,
                  'absolute top-1/2 right-4 z-30 -translate-y-1/2 max-sm:hidden',
                )}
                style={chromeStyle}
              >
                <ChevronRight className="size-6" />
              </button>
            </>
          )}

          {/* Image container */}
          <div
            className="relative z-10 flex h-full w-full items-center justify-center p-4 sm:px-16"
            onTouchStart={handleTouchStart}
            onTouchMove={handleTouchMove}
            onTouchEnd={handleTouchEnd}
          >
            <img
              src={images[currentIndex]}
              alt={`${currentIndex + 1} / ${images.length}`}
              className="max-h-full max-w-full object-contain select-none"
              style={imageStyle}
              draggable={false}
              onClick={(e) => e.stopPropagation()}
            />
          </div>

          {/* Page indicator */}
          {multiple && (
            <div
              aria-hidden="true"
              className="absolute bottom-8 left-1/2 z-20 -translate-x-1/2 rounded-full bg-black/50 px-3 py-1 text-sm text-white"
              style={chromeStyle}
            >
              {currentIndex + 1} / {images.length}
            </div>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
