import { useState, useRef, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';

interface ImageLightboxProps {
  images: string[];
  initialIndex: number;
  onClose: () => void;
}

export function ImageLightbox({ images, initialIndex, onClose }: ImageLightboxProps) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [scale, setScale] = useState(1);
  const [translateY, setTranslateY] = useState(0);
  const [bgOpacity, setBgOpacity] = useState(1);
  const [isClosing, setIsClosing] = useState(false);
  const [isOpen, setIsOpen] = useState(false);

  const touchStartRef = useRef({ x: 0, y: 0 });
  const lastTapRef = useRef(0);
  const isDraggingRef = useRef(false);

  // Open animation
  useEffect(() => {
    requestAnimationFrame(() => setIsOpen(true));
  }, []);

  const handleClose = useCallback(() => {
    setIsClosing(true);
    setIsOpen(false);
    setTimeout(() => onClose(), 300);
  }, [onClose]);

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
      if (dx < 0 && currentIndex < images.length - 1) {
        setCurrentIndex(currentIndex + 1);
      } else if (dx > 0 && currentIndex > 0) {
        setCurrentIndex(currentIndex - 1);
      }
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

  const overlayStyle = {
    opacity: isOpen && !isClosing ? bgOpacity : 0,
    transition: isDraggingRef.current ? 'none' : 'opacity 300ms ease',
  };

  const imageStyle = {
    transform: `translateY(${translateY}px) scale(${scale})`,
    transition: isDraggingRef.current ? 'none' : 'transform 300ms ease',
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={handleClose}
    >
      {/* Background overlay */}
      <div
        className="absolute inset-0 bg-black/90"
        style={overlayStyle}
      />

      {/* Image */}
      <div
        className="relative z-10 w-full h-full flex items-center justify-center p-4"
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onClick={(e) => e.stopPropagation()}
      >
        <img
          src={images[currentIndex]}
          alt={`${currentIndex + 1} / ${images.length}`}
          className="max-w-full max-h-full object-contain select-none"
          style={imageStyle}
          draggable={false}
        />
      </div>

      {/* Page indicator */}
      {images.length > 1 && (
        <div
          className="absolute bottom-8 left-1/2 -translate-x-1/2 z-20 px-3 py-1 rounded-full bg-black/50 text-white text-sm"
          style={{ opacity: isOpen && !isClosing ? 1 : 0, transition: 'opacity 300ms ease' }}
        >
          {currentIndex + 1} / {images.length}
        </div>
      )}
    </div>,
    document.body
  );
}
