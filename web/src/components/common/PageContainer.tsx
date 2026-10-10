import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

const widths = {
  narrow: 'max-w-3xl',
  default: 'max-w-5xl',
  wide: 'max-w-6xl',
  full: 'max-w-none',
} as const;

export interface PageContainerProps extends ComponentProps<'div'> {
  size?: keyof typeof widths;
}

/** Centered page column with the app-wide content widths and padding. */
export function PageContainer({
  size = 'default',
  className,
  ...props
}: PageContainerProps) {
  return (
    <div
      data-slot="page-container"
      className={cn(
        'mx-auto w-full px-4 py-6 sm:px-6 lg:px-8 lg:py-8',
        widths[size],
        className,
      )}
      {...props}
    />
  );
}
