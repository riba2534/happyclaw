import * as React from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

interface PreviewDialogProps extends Omit<
  React.ComponentProps<typeof DialogPrimitive.Content>,
  'title'
> {
  title: string;
  onClose: () => void;
  overlayClassName?: string;
  layer?: 'preview' | 'nested';
}

/**
 * A modal preview that can safely be opened from another Radix dialog/sheet.
 *
 * Keeping previews as nested Dialog roots lets Radix pause the parent focus
 * scope and place the body portal in the active modal layer. It also ensures
 * that Escape is handled by the top-most preview only.
 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'TEXTAREA' || tag === 'INPUT';
}

function selectPreviewContents(root: HTMLElement): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  range.selectNodeContents(root);
  selection.removeAllRanges();
  selection.addRange(range);
}

export function PreviewDialog({
  title,
  onClose,
  overlayClassName,
  layer = 'preview',
  className,
  children,
  onCloseAutoFocus,
  onKeyDown,
  ...props
}: PreviewDialogProps) {
  const layerClass = layer === 'nested' ? 'z-[70]' : 'z-[60]';
  const returnFocusRef = React.useRef<HTMLElement | null>(null);

  React.useLayoutEffect(() => {
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
  }, []);

  return (
    <DialogPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            'pointer-events-auto fixed inset-0 bg-black/80',
            layerClass,
            overlayClassName,
          )}
        />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            onCloseAutoFocus?.(event);
            const returnTarget = returnFocusRef.current;
            if (event.defaultPrevented || !returnTarget) return;
            event.preventDefault();
            requestAnimationFrame(() => {
              if (returnTarget.isConnected) returnTarget.focus();
            });
          }}
          onKeyDown={(event) => {
            onKeyDown?.(event);
            if (event.defaultPrevented) return;
            if (
              !(event.metaKey || event.ctrlKey) ||
              event.key.toLowerCase() !== 'a'
            ) {
              return;
            }
            if (isEditableTarget(event.target)) return;
            const root = event.currentTarget.querySelector<HTMLElement>(
              '[data-preview-select-root]',
            );
            if (!root) return;
            event.preventDefault();
            selectPreviewContents(root);
          }}
          className={cn(
            'pointer-events-auto fixed outline-none',
            layerClass,
            className,
          )}
          {...props}
        >
          <DialogPrimitive.Title className="sr-only">
            {title}
          </DialogPrimitive.Title>
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
