import { Fragment, type ComponentProps, type ReactNode } from 'react';

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { keepFocusThatMovedOn } from '@/lib/focus';
import { cn } from '@/lib/utils';
import type { MenuAction } from './ResponsiveMenu';

interface ActionSheetProps extends Omit<
  ComponentProps<typeof SheetContent>,
  'title' | 'children'
> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  /** Rows in groups, split by a hairline; empty groups are skipped. */
  groups: MenuAction[][];
  /** The control that opens it, when the sheet owns its trigger. */
  trigger?: ReactNode;
}

/**
 * A phone's bottom sheet of actions (cindy's panel rows: 16/22, medium,
 * 48px tall). A row runs its action first, inside the tap, so a file picker
 * it opens still counts as user-started, then closes the sheet.
 */
export function ActionSheet({
  open,
  onOpenChange,
  title,
  description,
  groups,
  trigger,
  ...contentProps
}: ActionSheetProps) {
  const shown = groups.filter((group) => group.length > 0);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {trigger && <SheetTrigger asChild>{trigger}</SheetTrigger>}
      <SheetContent
        side="bottom"
        showCloseButton={false}
        className="gap-0 p-0"
        onCloseAutoFocus={keepFocusThatMovedOn}
        {...(description ? {} : { 'aria-describedby': undefined })}
        {...contentProps}
      >
        <SheetTitle className="sr-only">{title}</SheetTitle>
        {description && (
          <SheetDescription className="sr-only">{description}</SheetDescription>
        )}
        <div className="flex flex-col overflow-y-auto overscroll-contain px-2 pt-1 pb-2">
          {shown.map((group, index) => (
            <Fragment key={group[0].label}>
              {index > 0 && (
                <div
                  role="separator"
                  className="mx-3 my-1 h-px shrink-0 bg-surface-border"
                />
              )}
              {group.map(
                ({ label, icon: Icon, onSelect, disabled, destructive }) => (
                  <button
                    key={label}
                    type="button"
                    disabled={disabled}
                    data-destructive={destructive ? '' : undefined}
                    onClick={() => {
                      onSelect();
                      onOpenChange(false);
                    }}
                    className={cn(
                      'flex h-12 w-full shrink-0 cursor-pointer items-center gap-3 rounded-[12px] px-3 text-left text-base leading-[22px] font-medium text-foreground transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:outline-none active:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-45 motion-reduce:transition-none',
                      destructive &&
                        'text-destructive hover:bg-destructive/10 focus-visible:bg-destructive/10 active:bg-destructive/10',
                    )}
                  >
                    {Icon && (
                      <Icon
                        className={cn(
                          'size-[18px] shrink-0',
                          destructive
                            ? 'text-destructive'
                            : 'text-muted-foreground',
                        )}
                        aria-hidden="true"
                      />
                    )}
                    {label}
                  </button>
                ),
              )}
            </Fragment>
          ))}
        </div>
      </SheetContent>
    </Sheet>
  );
}
