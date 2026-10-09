import type { ComponentType, ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface StatTileProps {
  label: string;
  value: ReactNode;
  icon?: ComponentType<{ className?: string }>;
  children?: ReactNode;
  className?: string;
}

/** Compact metric tile: caption label, large tabular value, optional detail. */
export function StatTile({
  label,
  value,
  icon: Icon,
  children,
  className,
}: StatTileProps) {
  return (
    <div
      className={cn(
        'rounded-xl bg-surface-raised p-4 ring-1 ring-surface-border',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-caption text-muted-foreground">{label}</h3>
        {Icon && <Icon className="size-4 text-faint-foreground" />}
      </div>
      <p className="mt-1 text-display-sm text-foreground tabular-nums">
        {value}
      </p>
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}
