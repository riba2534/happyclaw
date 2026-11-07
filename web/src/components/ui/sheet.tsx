import * as React from 'react';
import { Dialog as SheetPrimitive } from 'radix-ui';
import { useComposedRefs, useControllableState } from 'radix-ui/internal';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useBackDismiss } from '@/hooks/useBackDismiss';
import { XIcon } from 'lucide-react';

/**
 * Controlled or not, the root knows whether it is open, so on a phone the
 * system back gesture closes it first (useBackDismiss).
 */
function Sheet({
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Root>) {
  const [open, setOpen] = useControllableState({
    prop: openProp,
    defaultProp: defaultOpen,
    onChange: onOpenChange,
    caller: 'Sheet',
  });
  useBackDismiss(open, () => setOpen(false));
  return (
    <SheetPrimitive.Root
      data-slot="sheet"
      open={open}
      onOpenChange={setOpen}
      {...props}
    />
  );
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
 * the screen (at least 320px), full leaves 64px of the page above it. A
 * half lower than `minHalf` would be too short for the content, so on such
 * a screen there is only full.
 */
export function bottomSheetSnapHeights(
  screenHeight: number,
  minHalf = 0,
): {
  half: number;
  full: number;
} {
  const full = Math.max(320, Math.round(screenHeight - 64));
  const half = Math.min(Math.max(Math.round(screenHeight * 0.56), 320), full);
  return { half: half < minHalf ? full : half, full };
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
type Side = 'top' | 'right' | 'bottom' | 'left';

interface DragState {
  pointerId: number;
  startY: number;
  startHeight: number;
  lastY: number;
  lastTime: number;
  /** Downward speed in px/ms, smoothed over the last moves. */
  velocity: number;
}

/** Pointer handlers that drag a bottom sheet, shared by handle and header. */
interface SheetDragHandlers {
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void;
}

const SheetDragContext = React.createContext<SheetDragHandlers | null>(null);

/** Header taps on these stay taps; dragging starts anywhere else. */
const NO_DRAG_TARGET =
  'button, a, input, textarea, select, [contenteditable], [role="button"], [data-no-sheet-drag]';

function SheetCloseButton({ side }: { side: Side }) {
  return (
    <SheetPrimitive.Close data-slot="sheet-close" asChild>
      <Button
        variant="ghost"
        className={cn(
          // A 44px target on phones, its icon where the 28px one was.
          'absolute top-3 right-3 phone:top-1.5 phone:right-1.5 phone:size-11',
          side !== 'bottom' &&
            'top-[calc(env(safe-area-inset-top)+0.75rem)] phone:top-[calc(env(safe-area-inset-top)+0.375rem)]',
        )}
        size="icon-sm"
      >
        <XIcon />
        <span className="sr-only">Close</span>
      </Button>
    </SheetPrimitive.Close>
  );
}

/**
 * The phone bottom sheet: a rounded top with a drag handle. With `detents`
 * it opens at half the screen and drags between half and full; without, it
 * keeps the height its content and classes give it. Dragging the handle
 * down closes it either way.
 */
function BottomSheetContent({
  className,
  children,
  showCloseButton,
  detents,
  snap: snapProp,
  onSnapChange,
  minHalf,
  ref,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  showCloseButton: boolean;
  detents: boolean;
  snap?: Snap;
  onSnapChange?: (snap: Snap) => void;
  minHalf?: number;
}) {
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  // A caller's ref (often present but undefined) must not replace ours.
  const setContentRef = useComposedRefs(ref, contentRef);
  const closeRef = React.useRef<HTMLButtonElement>(null);
  const dragRef = React.useRef<DragState | null>(null);
  const [detent, setSnap] = useControllableState<Snap>({
    prop: snapProp,
    defaultProp: 'half',
    onChange: onSnapChange,
    caller: 'SheetContent',
  });
  const snap = detents ? detent : null;

  // The snapped height is written here, not through React's style prop, so
  // a drag can move it frame by frame and hand it back on release. It
  // follows the window while snapped.
  React.useLayoutEffect(() => {
    const element = contentRef.current;
    if (!element || !snap) return;
    const apply = () => {
      element.style.height = `${bottomSheetSnapHeights(window.innerHeight, minHalf)[snap]}px`;
    };
    apply();
    window.addEventListener('resize', apply);
    return () => window.removeEventListener('resize', apply);
  }, [snap, minHalf]);

  /** The snapped sheet's height for a drag now at `clientY`. */
  const dragHeight = (drag: DragState, clientY: number) =>
    Math.min(
      Math.max(drag.startHeight - (clientY - drag.startY), 0),
      bottomSheetSnapHeights(window.innerHeight, minHalf).full,
    );

  const close = () => closeRef.current?.click();

  const onPointerDown = (event: React.PointerEvent<HTMLElement>) => {
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

  const onPointerMove = (event: React.PointerEvent<HTMLElement>) => {
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

  const onPointerEnd = (event: React.PointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    const element = contentRef.current;
    if (!drag || !element || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    delete element.dataset.dragging;
    const offset = event.clientY - drag.startY;
    const flick = drag.velocity > DISMISS_VELOCITY && offset > 24;
    if (snap) {
      const heights = bottomSheetSnapHeights(window.innerHeight, minHalf);
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

  const dragHandlers: SheetDragHandlers = {
    onPointerDown,
    onPointerMove,
    onPointerUp: onPointerEnd,
    onPointerCancel: onPointerEnd,
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
        'data-[side=bottom]:rounded-t-[12px] data-[side=bottom]:pb-[var(--safe-bottom,0px)] data-[side=bottom]:transition-[height,transform,translate,opacity] data-[dragging]:transition-none motion-reduce:transition-none motion-reduce:animate-none',
        // Above the on-screen keyboard and within the visible viewport (the
        // vars come from useVisualViewportVars; without them, the layout
        // viewport). A caller's own max-h still wins.
        'data-[side=bottom]:bottom-[var(--keyboard-inset,0px)] max-h-[calc(var(--vvh,100dvh)-4rem)]',
        className,
      )}
      {...props}
    >
      <div
        data-sheet-handle
        aria-hidden="true"
        {...dragHandlers}
        className="flex h-5 w-full shrink-0 cursor-grab touch-none items-end justify-center select-none active:cursor-grabbing"
      >
        <span className="h-1 w-9 rounded-full bg-muted-foreground/30" />
      </div>
      <SheetDragContext.Provider value={dragHandlers}>
        {children}
      </SheetDragContext.Provider>
      {/* Closing by drag goes through Radix like any other close. */}
      <SheetPrimitive.Close
        ref={closeRef}
        tabIndex={-1}
        aria-hidden="true"
        className="sr-only"
      />
      {showCloseButton && <SheetCloseButton side="bottom" />}
    </SheetPrimitive.Content>
  );
}

/** Side sheets run edge to edge, so they keep clear of notches and bars. */
const SIDE_SAFE_AREA: Record<Exclude<Side, 'bottom'>, string> = {
  left: 'pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]',
  right:
    'pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)]',
  top: 'pt-[env(safe-area-inset-top)]',
};

function SheetContent({
  className,
  children,
  side = 'right',
  showCloseButton = true,
  detents = false,
  snap,
  onSnapChange,
  minHalf,
  ...props
}: React.ComponentProps<typeof SheetPrimitive.Content> & {
  side?: Side;
  showCloseButton?: boolean;
  /** A bottom sheet that opens at half the screen and drags to full. */
  detents?: boolean;
  /** The detent, when the caller controls it (with `detents`). */
  snap?: Snap;
  /** A drag settled on another detent (with `detents`). */
  onSnapChange?: (snap: Snap) => void;
  /**
   * The least height (px) the half detent is any use at; a screen that
   * leaves less opens it full (with `detents`).
   */
  minHalf?: number;
}) {
  return (
    <SheetPortal>
      <SheetOverlay />
      {side === 'bottom' ? (
        <BottomSheetContent
          className={className}
          showCloseButton={showCloseButton}
          detents={detents}
          snap={snap}
          onSnapChange={onSnapChange}
          minHalf={minHalf}
          {...props}
        >
          {children}
        </BottomSheetContent>
      ) : (
        <SheetPrimitive.Content
          data-slot="sheet-content"
          data-side={side}
          // The safe-area padding is unvariated so a caller's padding
          // replaces it.
          className={cn(SHEET_CONTENT_CLASS, SIDE_SAFE_AREA[side], className)}
          {...props}
        >
          {children}
          {showCloseButton && <SheetCloseButton side={side} />}
        </SheetPrimitive.Content>
      )}
    </SheetPortal>
  );
}

/**
 * In a bottom sheet the whole header drags it, not only the handle (cindy's
 * SheetSurface: grabber plus header); its buttons and fields still tap.
 */
function SheetHeader({
  className,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  ...props
}: React.ComponentProps<'div'>) {
  const drag = React.useContext(SheetDragContext);
  const draggingRef = React.useRef(false);
  const onEnd =
    (
      own: React.PointerEventHandler<HTMLDivElement> | undefined,
      end: 'onPointerUp' | 'onPointerCancel',
    ) =>
    (event: React.PointerEvent<HTMLDivElement>) => {
      own?.(event);
      if (draggingRef.current) drag?.[end](event);
      draggingRef.current = false;
    };
  return (
    <div
      data-slot="sheet-header"
      className={cn(
        'flex flex-col gap-0.5 p-4',
        drag && 'touch-none select-none',
        className,
      )}
      onPointerDown={(event) => {
        onPointerDown?.(event);
        draggingRef.current =
          !!drag &&
          !event.defaultPrevented &&
          !(event.target as Element).closest?.(NO_DRAG_TARGET);
        if (draggingRef.current) drag?.onPointerDown(event);
      }}
      onPointerMove={(event) => {
        onPointerMove?.(event);
        if (draggingRef.current) drag?.onPointerMove(event);
      }}
      onPointerUp={onEnd(onPointerUp, 'onPointerUp')}
      onPointerCancel={onEnd(onPointerCancel, 'onPointerCancel')}
      {...props}
    />
  );
}

/**
 * The scrolling part of a sheet: the handle and header above it stay put
 * while it scrolls.
 */
function SheetBody({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="sheet-body"
      className={cn(
        'min-h-0 flex-1 overflow-y-auto overscroll-contain',
        className,
      )}
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
  SheetBody,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};
