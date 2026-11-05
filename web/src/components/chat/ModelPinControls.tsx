import { Pin, PinOff } from 'lucide-react';

import { cn } from '@/lib/utils';
import { ActionSheet } from '@/components/common/ActionSheet';

/** What a model row offers for pinning; undefined when it offers nothing. */
export interface RowPinControl {
  pinned: boolean;
  /** A touch screen: a long press, no hover button. */
  touch: boolean;
  onToggle: () => void;
  onLongPress: () => void;
}

/**
 * The pin beside a model row. A desktop's shows on hover or focus and stays
 * on a pinned row (Open WebUI's model menu). A phone pins by a long press,
 * so its button is for screen readers only.
 */
export function PinToggle({
  pin,
  name,
}: {
  pin: RowPinControl;
  /** The model it names, e.g. 「Claude 官方 · opus」. */
  name: string;
}) {
  const label = `${pin.pinned ? '取消置顶' : '置顶'}「${name}」`;
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pin.pinned}
      title={pin.touch ? undefined : label}
      onClick={pin.onToggle}
      className={cn(
        pin.touch
          ? 'sr-only'
          : 'absolute top-1/2 right-8 flex size-7 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-opacity duration-100 outline-none hover:bg-surface-border/60 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50',
        !pin.touch &&
          !pin.pinned &&
          'opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100',
      )}
    >
      <Pin
        className={cn('size-3.5', pin.pinned && 'fill-current')}
        aria-hidden="true"
      />
    </button>
  );
}

/** Marks a pinned row on a phone, which has no pin button to show it. */
export function PinGlyph() {
  return (
    <Pin
      role="img"
      aria-label="已置顶"
      className="ml-1.5 inline size-3 -translate-y-px fill-current align-middle text-faint-foreground"
    />
  );
}

/** What a phone's long press on a model row offers. */
export function PinActionSheet({
  open,
  onOpenChange,
  title,
  name,
  pinned,
  onToggle,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** The model as the row names it. */
  name: string;
  pinned: boolean;
  onToggle: () => void;
}) {
  return (
    <ActionSheet
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      groups={
        name
          ? [
              [
                {
                  label: pinned ? `取消置顶「${name}」` : `置顶「${name}」`,
                  icon: pinned ? PinOff : Pin,
                  onSelect: onToggle,
                },
              ],
            ]
          : []
      }
    />
  );
}
