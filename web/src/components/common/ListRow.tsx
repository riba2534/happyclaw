import type { ComponentProps, KeyboardEvent, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Bordered container that stacks ListRows with hairline dividers. */
export function ListGroup({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="list-group"
      role="list"
      className={cn(
        'divide-y divide-surface-border overflow-hidden rounded-xl bg-surface-raised ring-1 ring-surface-border',
        className,
      )}
      {...props}
    />
  );
}

export interface ListRowProps extends Omit<
  ComponentProps<'div'>,
  'title' | 'onClick'
> {
  media?: ReactNode;
  title: ReactNode;
  /** Inline content after the title, e.g. badges. */
  badges?: ReactNode;
  description?: ReactNode;
  /** Right-aligned secondary text such as a timestamp. */
  meta?: ReactNode;
  actions?: ReactNode;
  /** Only show actions on hover / focus (always visible on touch screens). */
  actionsOnHover?: boolean;
  selected?: boolean;
  disabled?: boolean;
  onClick?: () => void;
}

/**
 * Dense list row: media · title/description · meta · actions. Becomes an
 * accessible button when `onClick` is set; nested action buttons stay valid
 * because the row itself is a div with role="button".
 */
export function ListRow({
  media,
  title,
  badges,
  description,
  meta,
  actions,
  actionsOnHover = false,
  selected = false,
  disabled = false,
  onClick,
  className,
  ...props
}: ListRowProps) {
  const interactive = !!onClick && !disabled;
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!interactive || event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onClick?.();
    }
  };

  return (
    <div
      data-slot="list-row"
      role={interactive ? 'button' : 'listitem'}
      tabIndex={interactive ? 0 : undefined}
      aria-pressed={interactive && selected ? true : undefined}
      aria-disabled={disabled || undefined}
      data-selected={selected || undefined}
      onClick={interactive ? onClick : undefined}
      onKeyDown={handleKeyDown}
      className={cn(
        'group/list-row relative flex min-h-14 items-center gap-3 px-4 py-3 outline-none transition-colors duration-100',
        interactive &&
          'cursor-pointer hover:bg-surface-hover focus-visible:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset',
        selected && 'bg-surface-selected hover:bg-surface-selected',
        disabled && 'opacity-60',
        className,
      )}
      {...props}
    >
      {media && <div className="flex shrink-0 items-center">{media}</div>}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-body font-medium text-foreground">
            {title}
          </span>
          {badges && (
            <span className="flex shrink-0 items-center gap-1">{badges}</span>
          )}
        </div>
        {description && (
          <div className="mt-0.5 line-clamp-2 text-caption text-muted-foreground">
            {description}
          </div>
        )}
      </div>
      {meta && (
        <div className="shrink-0 text-caption text-muted-foreground tabular-nums">
          {meta}
        </div>
      )}
      {actions && (
        <div
          className={cn(
            'flex shrink-0 items-center gap-0.5',
            actionsOnHover &&
              'pointer-fine:opacity-0 pointer-fine:group-hover/list-row:opacity-100 pointer-fine:group-focus-within/list-row:opacity-100 transition-opacity',
          )}
          onClick={(event) => event.stopPropagation()}
        >
          {actions}
        </div>
      )}
    </div>
  );
}
