import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface PageTopBarProps {
  title?: ReactNode;
  /** Inline content after the title, e.g. line tabs. */
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

/** Sticky 48px bar for pages that switch sections with tabs. */
export function PageTopBar({
  title,
  children,
  actions,
  className,
}: PageTopBarProps) {
  return (
    <div
      data-slot="page-top-bar"
      className={cn(
        'sticky top-0 z-10 flex h-12 shrink-0 items-center gap-4 border-b border-surface-border bg-background px-4 lg:px-6',
        className,
      )}
    >
      {title && (
        <h1 className="shrink-0 truncate text-title-sm text-foreground">
          {title}
        </h1>
      )}
      {children && (
        <div className="flex min-w-0 flex-1 items-center self-stretch">
          {children}
        </div>
      )}
      {actions && (
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {actions}
        </div>
      )}
    </div>
  );
}
