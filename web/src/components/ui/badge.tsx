import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Slot } from 'radix-ui';

import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-md border border-transparent px-1.5 text-micro font-medium whitespace-nowrap transition-colors focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground [a]:hover:bg-primary/80',
        secondary:
          'bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80',
        destructive:
          'bg-destructive/10 text-destructive focus-visible:ring-destructive/20 dark:bg-destructive/20 dark:focus-visible:ring-destructive/40 [a]:hover:bg-destructive/20',
        outline:
          'border-surface-border text-muted-foreground [a]:hover:bg-surface-hover [a]:hover:text-foreground',
        ghost: 'hover:bg-surface-hover hover:text-foreground',
        link: 'text-primary-text underline-offset-4 hover:underline',
        success: 'bg-success/10 text-success',
        warning: 'bg-warning/10 text-warning',
        error: 'bg-error/10 text-error',
        info: 'bg-primary/10 text-primary-text',
        neutral: 'bg-surface-selected text-muted-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  },
);

const badgeDotColors = {
  success: 'bg-success',
  warning: 'bg-warning',
  error: 'bg-error',
  primary: 'bg-primary',
  muted: 'bg-faint-foreground',
} as const;

type BadgeDot = keyof typeof badgeDotColors;

function Badge({
  className,
  variant = 'default',
  asChild = false,
  dot,
  children,
  ...props
}: React.ComponentProps<'span'> &
  VariantProps<typeof badgeVariants> & {
    asChild?: boolean;
    /** Leading status dot; pairs well with the outline / neutral variants. */
    dot?: BadgeDot;
  }) {
  const Comp = asChild ? Slot.Root : 'span';

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    >
      {asChild || !dot ? (
        children
      ) : (
        <>
          <span
            aria-hidden="true"
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              badgeDotColors[dot],
            )}
          />
          {children}
        </>
      )}
    </Comp>
  );
}

export { Badge, badgeVariants };
export type { BadgeDot };
