import type * as React from 'react';

import { cn } from '@/lib/utils';

function Kbd({ className, ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        "pointer-events-none inline-flex h-5 w-fit min-w-5 items-center justify-center gap-1 rounded-sm border border-border/70 bg-muted/70 px-1 font-sans text-micro font-medium text-muted-foreground shadow-[0_1px_0_0_var(--border)] select-none in-data-[slot=tooltip-content]:border-transparent in-data-[slot=tooltip-content]:bg-background/15 in-data-[slot=tooltip-content]:text-background in-data-[slot=tooltip-content]:shadow-none [&_svg:not([class*='size-'])]:size-3",
        className,
      )}
      {...props}
    />
  );
}

function KbdGroup({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <kbd
      data-slot="kbd-group"
      className={cn('inline-flex items-center gap-0.5', className)}
      {...props}
    />
  );
}

export { Kbd, KbdGroup };
