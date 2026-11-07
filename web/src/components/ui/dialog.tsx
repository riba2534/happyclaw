import * as React from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';
import { useComposedRefs, useControllableState } from 'radix-ui/internal';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { useBackDismiss } from '@/hooks/useBackDismiss';
import { XIcon } from 'lucide-react';

/** Like Sheet, it closes on a phone's system back first (useBackDismiss). */
function Dialog({
  open: openProp,
  defaultOpen = false,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Root>) {
  const [open, setOpen] = useControllableState({
    prop: openProp,
    defaultProp: defaultOpen,
    onChange: onOpenChange,
    caller: 'Dialog',
  });
  useBackDismiss(open, () => setOpen(false));
  return (
    <DialogPrimitive.Root
      data-slot="dialog"
      open={open}
      onOpenChange={setOpen}
      {...props}
    />
  );
}

function DialogTrigger({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        'fixed inset-0 isolate z-50 bg-black/20 duration-100 supports-backdrop-filter:backdrop-blur-[2px] data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0',
        className,
      )}
      {...props}
    />
  );
}

const COARSE_POINTER = '(pointer: coarse)';

const isCoarsePointer = () =>
  typeof window !== 'undefined' && window.matchMedia(COARSE_POINTER).matches;

/** A field whose focus raises the on-screen keyboard. */
const isTextEntry = (element: Element | null) =>
  !!element &&
  (element.matches(
    'input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]), textarea, select',
  ) ||
    (element as HTMLElement).isContentEditable);

/**
 * On a phone it is a bottom sheet: full width, rounded top, as tall as the
 * visible viewport allows, scrolling inside, above the keyboard, its footer
 * pinned over the home indicator. The `!` keeps callers' desktop sizing
 * (`max-h-[85vh]`, `sm:max-w-2xl`) from reaching it.
 *
 * On coarse pointers it opens without focusing a field, so the keyboard does
 * not cover the form before the user picks one (cindy autofocuses only
 * single-field sheets); `autoFocusOnPhone` restores the usual focus.
 */
function DialogContent({
  className,
  children,
  showCloseButton = true,
  autoFocusOnPhone = false,
  onOpenAutoFocus,
  ref,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  showCloseButton?: boolean;
  /** Let the first field take focus on touch devices too. */
  autoFocusOnPhone?: boolean;
}) {
  // A field's own autoFocus runs before Radix's focus scope, which then
  // sees focus inside and skips onOpenAutoFocus: undo it once, as the
  // content attaches (Radix re-attaches the ref on later renders).
  const attachedRef = React.useRef<HTMLDivElement | null>(null);
  const blurAutoFocusedField = React.useCallback(
    (node: HTMLDivElement | null) => {
      if (!node || node === attachedRef.current) return;
      attachedRef.current = node;
      if (autoFocusOnPhone || !isCoarsePointer()) return;
      const active = document.activeElement;
      if (active && node.contains(active) && isTextEntry(active)) {
        (active as HTMLElement).blur();
        node.focus();
      }
    },
    [autoFocusOnPhone],
  );
  const setRef = useComposedRefs(ref, blurAutoFocusedField);
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Content
        ref={setRef}
        data-slot="dialog-content"
        className={cn(
          'fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 overflow-y-auto overscroll-contain rounded-xl bg-surface-raised p-4 text-sm shadow-floating ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-lg data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
          // Phone: a bottom sheet (see above).
          'phone:top-auto! phone:bottom-[var(--keyboard-inset,0px)]! phone:left-0! phone:max-h-[calc(var(--vvh,100dvh)-3rem)]! phone:max-w-none! phone:translate-x-0! phone:translate-y-0! phone:rounded-t-xl! phone:rounded-b-none! phone:data-open:zoom-in-100 phone:data-open:slide-in-from-bottom-10 phone:data-closed:zoom-out-100 phone:data-closed:slide-out-to-bottom-10 motion-reduce:animate-none',
          // Without a footer to carry it, the safe area pads the content.
          'phone:not-has-[>[data-slot=dialog-footer]]:pb-[calc(1rem+var(--safe-bottom,0px))]',
          className,
        )}
        onOpenAutoFocus={(event) => {
          onOpenAutoFocus?.(event);
          if (
            event.defaultPrevented ||
            autoFocusOnPhone ||
            !isCoarsePointer()
          ) {
            return;
          }
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus();
        }}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close data-slot="dialog-close" asChild>
            <Button
              variant="ghost"
              // A 44px target on phones, its icon where the 28px one was.
              className="absolute top-2 right-2 phone:top-0.5 phone:right-0.5 phone:size-11"
              size="icon-sm"
            >
              <XIcon />
              <span className="sr-only">Close</span>
            </Button>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPortal>
  );
}

function DialogHeader({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-header"
      className={cn('flex flex-col gap-2', className)}
      {...props}
    />
  );
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  showCloseButton?: boolean;
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        'sticky -bottom-4 z-10 -mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-[color-mix(in_oklab,var(--muted)_50%,var(--surface))] p-4 sm:flex-row sm:justify-end',
        // Phone: one row of equal buttons over the home indicator.
        'phone:flex-row phone:flex-wrap phone:justify-end phone:rounded-b-none phone:pb-[calc(1rem+var(--safe-bottom,0px))] phone:*:data-[slot=button]:flex-1',
        className,
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close asChild>
          <Button variant="outline">Close</Button>
        </DialogPrimitive.Close>
      )}
    </div>
  );
}

function DialogTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('text-title leading-none', className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        'text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground',
        className,
      )}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
