import { useState, useCallback, useEffect, useRef } from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { ChevronLeft, ChevronRight, Download, X } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import {
  CrossOriginImageError,
  fetchImageFile,
  isAbortError,
  prefersShareSheet,
  saveImageFile,
} from '../../utils/download';
import { ZoomPanSurface } from './ZoomPanSurface';

interface ImageLightboxProps {
  images: string[];
  /** File names to save each image under, where known. */
  names?: (string | undefined)[];
  initialIndex: number;
  onClose: () => void;
}

const viewerButtonClass =
  'flex size-10 cursor-pointer items-center justify-center rounded-full bg-white/10 text-white backdrop-blur-sm transition-colors outline-none hover:bg-white/20 focus-visible:ring-2 focus-visible:ring-white/60 disabled:cursor-default disabled:opacity-30';

/** How far a pull down goes before the backdrop is gone. */
const PULL_FADE_DISTANCE = 400;

/** The shown image's file on its way, and once it is here. */
interface PreparedFile {
  file: Promise<File>;
  ready?: File;
}

function reportSaveError(err: unknown) {
  // A switch or close cancelled the fetch.
  if (isAbortError(err)) return;
  if (err instanceof CrossOriginImageError) {
    toast.error('长按图片保存，或在新标签页打开原图');
    return;
  }
  console.error('Save image failed:', err);
  toast.error('图片保存失败');
}

/**
 * Full-screen image viewer. A Radix dialog, so it traps focus, closes on Esc,
 * locks page scroll and returns focus to the thumbnail. ←/→ and the side
 * buttons switch images. On touch (ZoomPanSurface) two fingers zoom about
 * their midpoint and pan, one finger pans the zoomed image, a double tap
 * zooms in or out, and at 1× a swipe switches images and a pull down closes.
 * At 1× a long press opens the system image menu; the save button hands
 * the file to the share sheet on iOS ("Save Image") and downloads it
 * elsewhere.
 */
export function ImageLightbox({
  images,
  names,
  initialIndex,
  onClose,
}: ImageLightboxProps) {
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [pull, setPull] = useState(0);
  const [isClosing, setIsClosing] = useState(false);
  const [isOpen, setIsOpen] = useState(false);

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
    },
    [images.length],
  );

  const src = images[currentIndex];
  const name = names?.[currentIndex];
  // The share sheet opens only within the tap's user activation, which an
  // `await fetch()` of a large image outlasts. Where saving goes through it,
  // the image on screen is fetched once it has loaded (so from the cache)
  // and the tap hands the file over at once. One image at a time: a switch
  // or close cancels the fetch and lets the file go.
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  const prepared = useRef<PreparedFile | null>(null);
  useEffect(() => {
    if (loadedSrc !== src || !prefersShareSheet()) return;
    const controller = new AbortController();
    const entry: PreparedFile = {
      file: fetchImageFile(src, name, controller.signal),
    };
    prepared.current = entry;
    const forget = () => {
      if (prepared.current === entry) prepared.current = null;
    };
    entry.file.then((file) => {
      entry.ready = file;
    }, forget);
    return () => {
      controller.abort();
      forget();
    };
  }, [loadedSrc, src, name]);

  const [saving, setSaving] = useState(false);
  const handleSave = () => {
    const entry = prepared.current;
    if (entry?.ready) {
      saveImageFile(entry.ready).catch(reportSaveError);
      return;
    }
    setSaving(true);
    (entry?.file ?? fetchImageFile(src, name))
      .then(saveImageFile)
      .catch(reportSaveError)
      .finally(() => setSaving(false));
  };

  const visible = isOpen && !isClosing;
  const chromeStyle = {
    opacity: visible ? 1 : 0,
    transition: 'opacity 300ms ease',
  };
  const overlayStyle = {
    opacity: visible ? Math.max(0, 1 - pull / PULL_FADE_DISTANCE) : 0,
    transition: pull > 0 ? 'none' : 'opacity 300ms ease',
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

          <div
            // Clear of the notch and the status bar, and 44px to the finger.
            className="absolute top-[calc(1rem+env(safe-area-inset-top))] right-[calc(1rem+env(safe-area-inset-right))] z-30 flex gap-2"
            style={chromeStyle}
          >
            <button
              type="button"
              aria-label="保存图片"
              disabled={saving}
              onClick={(e) => {
                e.stopPropagation();
                handleSave();
              }}
              className={cn(viewerButtonClass, 'pointer-coarse:size-11')}
            >
              <Download className="size-5" />
            </button>
            <DialogPrimitive.Close
              onClick={(e) => e.stopPropagation()}
              className={cn(viewerButtonClass, 'pointer-coarse:size-11')}
              aria-label="关闭"
            >
              <X className="size-6" />
            </DialogPrimitive.Close>
          </div>

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
          <ZoomPanSurface
            resetKey={currentIndex}
            className="z-10 flex h-full w-full items-center justify-center"
            contentClassName="flex"
            onSwipe={(direction) => show(currentIndex + direction)}
            onPull={setPull}
            onPullClose={handleClose}
          >
            <img
              src={src}
              alt={`${currentIndex + 1} / ${images.length}`}
              // The system image menu at 1× only: zoomed, a held finger pans.
              className="max-h-[calc(var(--vvh,100dvh)-2rem)] max-w-[calc(100vw-2rem)] object-contain select-none in-data-[zoomed=false]:touch-callout-default sm:max-w-[calc(100vw-8rem)]"
              draggable={false}
              onLoad={() => setLoadedSrc(src)}
              onClick={(e) => e.stopPropagation()}
            />
          </ZoomPanSurface>

          {/* Page indicator */}
          {multiple && (
            <div
              aria-hidden="true"
              className="absolute bottom-[calc(2rem+env(safe-area-inset-bottom))] left-1/2 z-20 -translate-x-1/2 rounded-full bg-black/50 px-3 py-1 text-sm text-white"
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
