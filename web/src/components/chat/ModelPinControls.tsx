import { Pin, PinOff } from 'lucide-react';

import { cn } from '@/lib/utils';
import { ActionSheet } from '@/components/common/ActionSheet';
import { IconButton } from '@/components/common/IconButton';

/** What a model row offers for pinning; undefined when it offers nothing. */
export interface RowPinControl {
  pinned: boolean;
  /**
   * How the row is pinned. `pointer`: a button beside the row that shows on
   * hover or focus. `touch` (a touch screen wider than a phone, a tablet):
   * a long press, and a button that always shows, since nothing hovers
   * there. `phone`: a long press; its button is for screen readers only.
   */
  input: 'pointer' | 'touch' | 'phone';
  onToggle: () => void;
  onLongPress: () => void;
}

/**
 * The pin beside a model row. A desktop's shows on hover or focus and stays
 * on a pinned row (Open WebUI's model menu); a tablet's always shows, with a
 * 44px target. A phone pins by a long press, so its button is for screen
 * readers only.
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
  const icon = (
    <Pin
      className={cn('size-3.5', pin.pinned && 'fill-current')}
      aria-hidden="true"
    />
  );
  if (pin.input === 'touch') {
    return (
      <IconButton
        label={label}
        icon={icon}
        hideTooltip
        aria-pressed={pin.pinned}
        onClick={pin.onToggle}
        className="size-11 shrink-0 text-muted-foreground"
      />
    );
  }
  const phone = pin.input === 'phone';
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pin.pinned}
      title={phone ? undefined : label}
      onClick={pin.onToggle}
      className={cn(
        phone
          ? 'sr-only'
          : 'absolute top-1/2 right-8 flex size-7 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-opacity duration-100 outline-none hover:bg-surface-border/60 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/50',
        !phone &&
          !pin.pinned &&
          'opacity-0 group-focus-within/row:opacity-100 group-hover/row:opacity-100',
      )}
    >
      {icon}
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

/** What a long press on a model row offers (a phone, a tablet). */
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
