import * as React from 'react';
import { Dialog as SheetPrimitive } from 'radix-ui';
import { useComposedRefs } from 'radix-ui/internal';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { XIcon } from 'lucide-react';

function Sheet({ ...props }: React.ComponentProps<typeof SheetPrimitive.Root>) {
  return <SheetPrimitive.Root data-slot="sheet" {...props} />;
}

function SheetTrigger({
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Trigger>) {
  return <SheetPrimitive.Trigger data-slot="sheet-trigger" {...props} />;
}

function SheetClose({
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Close>) {
  return <SheetPrimitive.Close data-slot="sheet-close" {...props} />;
}

function SheetPortal({
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Portal>) {
  return <SheetPrimitive.Portal data-slot="sheet-portal" {...props} />;
}

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Overlay>) {
  return (
    <SheetPrimitive.Overlay
      data-slot="sheet-overlay"
      className={cn(
        'fixed inset-0 z-50 bg-black/20 duration-100 supports-backdrop-filter:backdrop-blur-[2px] data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 motion-reduce:animate-none',
        className,
      )}
      {...props}
    />
  );
}

const SHEET_CONTENT_CLASS =
  'fixed z-50 flex flex-col gap-4 bg-surface-raised bg-clip-padding text-sm text-foreground shadow-floating transition duration-200 ease-in-out data-[side=bottom]:inset-x-0 data-[side=bottom]:bottom-0 data-[side=bottom]:h-auto data-[side=bottom]:border-t data-[side=left]:inset-y-0 data-[side=left]:left-0 data-[side=left]:h-full data-[side=left]:w-3/4 data-[side=left]:border-r data-[side=right]:inset-y-0 data-[side=right]:right-0 data-[side=right]:h-full data-[side=right]:w-3/4 data-[side=right]:border-l data-[side=top]:inset-x-0 data-[side=top]:top-0 data-[side=top]:h-auto data-[side=top]:border-b data-[side=left]:sm:max-w-sm data-[side=right]:sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-[side=bottom]:data-open:slide-in-from-bottom-10 data-[side=left]:data-open:slide-in-from-left-10 data-[side=right]:data-open:slide-in-from-right-10 data-[side=top]:data-open:slide-in-from-top-10 data-closed:animate-out data-closed:fade-out-0 data-[side=bottom]:data-closed:slide-out-to-bottom-10 data-[side=left]:data-closed:slide-out-to-left-10 data-[side=right]:data-closed:slide-out-to-right-10 data-[side=top]:data-closed:slide-out-to-top-10';

/**
 * Bottom sheet detents, after cindy's context sheet
 * (apps/mobile/src/session/contextSheetModel.ts): half shows about 56% of
 * the screen (at least 320px), full leaves 64px of the page above it.
 */
export function bottomSheetSnapHeights(screenHeight: number): {
  half: number;
  full: number;
} {
  const full = Math.max(320, Math.round(screenHeight - 64));
  const half = Math.min(Math.max(Math.round(screenHeight * 0.56), 320), full);
  return { half, full };
}

/** Released below this share of the half detent, the sheet closes. */
const DISMISS_RATIO = 0.62;
/** A downward flick this fast (px/ms) closes the sheet from anywhere. */
const DISMISS_VELOCITY = 0.6;

/**
 * Where a detented sheet settles when released at `height` (cindy's
 * settleContextSheetDrag): past the midpoint it goes full, well below half
 * it closes, otherwise it returns to half.
 */
export function settleBottomSheet(
  height: number,
  { half, full }: { half: number; full: number },
): 'half' | 'full' | 'dismiss' {
  if (height < half * DISMISS_RATIO) return 'dismiss';
  if (full <= half || height >= (half + full) / 2) return 'full';
  return 'half';
}

type Snap = 'half' | 'full';

interface DragState {
  pointerId: number;
  startY: number;
  startHeight: number;
  lastY: number;
  lastTime: number;
  /** Downward speed in px/ms, smoothed over the last moves. */
  velocity: number;
}

function SheetCloseButton() {
  return (
    <SheetPrimitive.Close data-slot="sheet-close" asChild>
      <Button variant="ghost" className="absolute top-3 right-3" size="icon-sm">
        <XIcon />
        <span className="sr-only">Close</span>
      </Button>
    </SheetPrimitive.Close>
  );
}

/**
 * The phone bottom sheet: a rounded top with a drag handle. With `detents`
 * it drags between half the screen and full, opening at half (`true`) or at
 * the detent named; without, it keeps the height its content and classes
 * give it. Dragging the handle down closes it either way.
 */
function BottomSheetContent({
  className,
  children,
  showCloseButton,
  detents,
  ref,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  showCloseButton: boolean;
  detents: boolean | Snap;
}) {
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  // A caller's ref (often present but undefined) must not replace ours.
  const setContentRef = useComposedRefs(ref, contentRef);
  const closeRef = React.useRef<HTMLButtonElement>(null);
  const dragRef = React.useRef<DragState | null>(null);
  const [snap, setSnap] = React.useState<Snap | null>(
    detents === true ? 'half' : detents || null,
  );

  // The snapped height is written here, not through React's style prop, so
  // a drag can move it frame by frame and hand it back on release. It
  // follows the window while snapped.
  React.useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element || !snap) return;
    const apply = () => {
      element.style.height = `${bottomSheetSnapHeights(window.innerHeight)[snap]}px`;
    };
    apply();
    window.addEventListener('resize', apply);
    return () => window.removeEventListener('resize', apply);
  }, [snap]);

  /** The snapped sheet's height for a drag now at `clientY`. */
  const dragHeight = (drag: DragState, clientY: number) =>
    Math.min(
      Math.max(drag.startHeight - (clientY - drag.startY), 0),
      bottomSheetSnapHeights(window.innerHeight).full,
    );

  const close = () => closeRef.current?.click();

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const element = contentRef.current;
    if (!element || (event.pointerType === 'mouse' && event.button !== 0)) {
      return;
    }
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight: element.offsetHeight,
      lastY: event.clientY,
      lastTime: event.timeStamp,
      velocity: 0,
    };
    element.dataset.dragging = '';
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const element = contentRef.current;
    if (!drag || !element || drag.pointerId !== event.pointerId) return;
    const elapsed = Math.max(1, event.timeStamp - drag.lastTime);
    drag.velocity =
      0.7 * ((event.clientY - drag.lastY) / elapsed) + 0.3 * drag.velocity;
    drag.lastY = event.clientY;
    drag.lastTime = event.timeStamp;
    if (snap) {
      element.style.height = `${dragHeight(drag, event.clientY)}px`;
    } else {
      const offset = Math.max(0, event.clientY - drag.startY);
      element.style.transform = `translateY(${offset}px)`;
    }
  };

  const onPointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const element = contentRef.current;
    if (!drag || !element || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    delete element.dataset.dragging;
    const offset = event.clientY - drag.startY;
    const flick = drag.velocity > DISMISS_VELOCITY && offset > 24;
    if (snap) {
      const heights = bottomSheetSnapHeights(window.innerHeight);
      const settled = flick
        ? 'dismiss'
        : settleBottomSheet(dragHeight(drag, event.clientY), heights);
      if (settled === 'dismiss') {
        close();
        return;
      }
      // Back to a detent, eased from where it was let go.
      element.style.height = `${heights[settled]}px`;
      setSnap(settled);
      return;
    }
    if (flick || offset > Math.max(80, element.offsetHeight * 0.3)) {
      close();
      return;
    }
    element.style.transform = '';
  };

  return (
    <SheetPrimitive.Content
      ref={setContentRef}
      data-slot="sheet-content"
      data-side="bottom"
      data-snap={snap ?? undefined}
      className={cn(
        SHEET_CONTENT_CLASS,
        // Rounded top and safe-area bottom. Height and drag offset ease into
        // place unless a finger holds it or less motion is asked for.
        'data-[side=bottom]:rounded-t-[12px] data-[side=bottom]:pb-[env(safe-area-inset-bottom)] data-[side=bottom]:transition-[height,transform,translate,opacity] data-[dragging]:transition-none motion-reduce:transition-none motion-reduce:animate-none',
        className,
      )}
      {...props}
    >
      <div
        data-sheet-handle
        aria-hidden="true"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        className="flex h-5 w-full shrink-0 cursor-grab touch-none items-end justify-center select-none active:cursor-grabbing"
      >
        <span className="h-1 w-9 rounded-full bg-muted-foreground/30" />
      </div>
      {children}
      {/* Closing by drag goes through Radix like any other close. */}
      <SheetPrimitive.Close
        ref={closeRef}
        tabIndex={-1}
        aria-hidden="true"
        className="sr-only"
      />
      {showCloseButton && <SheetCloseButton />}
    </SheetPrimitive.Content>
  );
}

function SheetContent({
  className,
  children,
  side = 'right',
  showCloseButton = true,
  detents = false,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  side?: 'top' | 'right' | 'bottom' | 'left';
  showCloseButton?: boolean;
  /**
   * A bottom sheet that drags between half the screen and full. `true` opens
   * it at half; `'full'` opens it at full, for content that needs the room.
   */
  detents?: boolean | Snap;
}) {
  return (
    <SheetPortal>
      <SheetOverlay />
      {side === 'bottom' ? (
        <BottomSheetContent
          className={className}
          showCloseButton={showCloseButton}
          detents={detents}
          {...props}
        >
          {children}
        </BottomSheetContent>
      ) : (
        <SheetPrimitive.Content
          data-slot="sheet-content"
          data-side={side}
          className={cn(SHEET_CONTENT_CLASS, className)}
          {...props}
        >
          {children}
          {showCloseButton && <SheetCloseButton />}
        </SheetPrimitive.Content>
      )}
    </SheetPortal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-header"
      className={cn('flex flex-col gap-0.5 p-4', className)}
      {...props}
    />
  );
}

function SheetFooter({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-footer"
      className={cn('mt-auto flex flex-col gap-2 p-4', className)}
      {...props}
    />
  );
}

function SheetTitle({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Title>) {
  return (
    <SheetPrimitive.Title
      data-slot="sheet-title"
      className={cn('text-title text-foreground', className)}
      {...props}
    />
  );
}

function SheetDescription({
  className,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Description>) {
  return (
    <SheetPrimitive.Description
      data-slot="sheet-description"
      className={cn('text-sm text-muted-foreground', className)}
      {...props}
    />
  );
}

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};
