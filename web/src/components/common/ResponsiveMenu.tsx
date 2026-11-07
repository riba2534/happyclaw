import {
  Fragment,
  type JSX,
  type PointerEvent,
  type ReactElement,
} from 'react';
import { useControllableState } from 'radix-ui/internal';
import type { LucideIcon } from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useIsPhone } from '@/components/layout/phone';
import { keepFocusThatMovedOn } from '@/lib/focus';
import { ActionSheet } from './ActionSheet';

export interface MenuAction {
  label: string;
  icon?: LucideIcon;
  onSelect: () => void;
  disabled?: boolean;
  destructive?: boolean;
}

/**
 * One menu, two forms: an anchored DropdownMenu on a desktop, a bottom
 * ActionSheet of 48px rows on a phone (cindy's showActionMenu). Groups are
 * split by a separator; empty ones are skipped. Open state is optional to
 * control.
 */
export function ResponsiveMenu({
  trigger,
  groups,
  title,
  description,
  align = 'end',
  open: openProp,
  onOpenChange,
}: {
  trigger: ReactElement;
  groups: MenuAction[][];
  title: string;
  description?: string;
  align?: 'start' | 'center' | 'end';
  open?: boolean;
  onOpenChange?: (o: boolean) => void;
}): JSX.Element {
  const isPhone = useIsPhone();
  const [open, setOpen] = useControllableState({
    prop: openProp,
    defaultProp: false,
    onChange: onOpenChange,
    caller: 'ResponsiveMenu',
  });

  if (isPhone) {
    return (
      <ActionSheet
        open={open}
        onOpenChange={setOpen}
        title={title}
        description={description}
        groups={groups}
        trigger={trigger}
      />
    );
  }

  // A closed menu stays on screen through its exit animation. A mouse
  // leaving or crossing one of its items then would focus the menu again,
  // taking focus from wherever the chosen action moved it (the composer a
  // quote fills), and the menu would hand it to its trigger on unmount.
  const whileClosing = open
    ? undefined
    : (event: PointerEvent) => event.preventDefault();

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent
        align={align}
        aria-label={title}
        className="w-auto"
        onCloseAutoFocus={keepFocusThatMovedOn}
      >
        {groups
          .filter((group) => group.length > 0)
          .map((group, index) => (
            <Fragment key={group[0].label}>
              {index > 0 && <DropdownMenuSeparator />}
              {group.map(
                ({ label, icon: Icon, onSelect, disabled, destructive }) => (
                  <DropdownMenuItem
                    key={label}
                    disabled={disabled}
                    variant={destructive ? 'destructive' : 'default'}
                    onSelect={onSelect}
                    onPointerMove={whileClosing}
                    onPointerLeave={whileClosing}
                  >
                    {Icon && <Icon aria-hidden="true" />}
                    {label}
                  </DropdownMenuItem>
                ),
              )}
            </Fragment>
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
