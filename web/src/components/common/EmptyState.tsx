import type { ReactNode, ElementType } from 'react';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { cn } from '@/lib/utils';

/** Which line-art scene sits above the title. */
export type EmptyStateVariant = 'empty' | 'search' | 'error';

export interface EmptyStateProps {
  /** Drawn on the illustration's front card; the scene works without it. */
  icon?: ElementType;
  title: string;
  description?: string;
  action?: ReactNode;
  className?: string;
  /** `empty` (default) for nothing-here-yet, `search` for no matches, `error` for a failed load. */
  variant?: EmptyStateVariant;
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  variant = 'empty',
}: EmptyStateProps) {
  return (
    <Empty className={cn('py-12', className)}>
      <EmptyHeader>
        <EmptyMedia>
          <EmptyStateArt icon={icon} variant={variant} />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description && <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {action && <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}

/**
 * Line-drawn scene over a soft glow: a card with a second one peeking out
 * behind it, a few sparkles and a dashed ground line. Strokes use
 * `currentColor`, accents and glow use the theme tokens, so it follows every
 * colour scheme in light and dark. Static on purpose: no animation to honour
 * or disable.
 */
function EmptyStateArt({
  icon: Icon,
  variant,
}: {
  icon?: ElementType;
  variant: EmptyStateVariant;
}) {
  const accent = variant === 'error' ? 'text-error' : 'text-primary-text';
  return (
    <div
      data-slot="empty-art"
      data-variant={variant}
      aria-hidden="true"
      className="relative h-[4.5rem] w-[6.125rem] text-faint-foreground sm:h-[5.5rem] sm:w-[7.5rem]"
    >
      <div
        className={cn(
          'absolute inset-x-[22%] inset-y-[16%] rounded-full blur-xl',
          variant === 'error'
            ? 'bg-error/15 dark:bg-error/20'
            : 'bg-primary/20 dark:bg-primary/25',
        )}
      />
      <svg
        viewBox="0 0 120 88"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        className="relative size-full"
      >
        {/* Ground */}
        <path d="M30 79h60" strokeDasharray="2 5" />
        {/* Back card: only the edges not covered by the front card */}
        <path d="M42 26a8 8 0 0 1 8-8h36a8 8 0 0 1 8 8v26a8 8 0 0 1-8 8" />
        {/* Front card */}
        <rect
          x={34}
          y={26}
          width={52}
          height={42}
          rx={8}
          className="fill-primary/[0.04] text-muted-foreground"
        />
        {Icon ? (
          <>
            <Icon
              x={51}
              y={33}
              size={18}
              strokeWidth={1.75}
              className={accent}
            />
            <path d="M52 59h16" />
          </>
        ) : (
          <path d="M44 38h22M44 47h32M44 56h14" />
        )}
        {variant === 'search' && (
          <g className="text-muted-foreground">
            <circle
              cx={84}
              cy={60}
              r={11}
              className="fill-primary/[0.08] text-primary-text"
            />
            <path d="M92 68l7 7" strokeWidth={2.5} />
          </g>
        )}
        {variant === 'error' && (
          <g className="text-error">
            <circle cx={86} cy={26} r={9} className="fill-error-bg" />
            <path d="M86 22v4.5M86 30h.01" strokeWidth={2} />
          </g>
        )}
        {/* Sparkles */}
        <g className={accent}>
          <path d="M22 18v8M18 22h8" />
          <circle cx={103} cy={12} r={1.5} className="fill-current" />
          <circle cx={16} cy={54} r={2.25} />
          {variant !== 'search' && <path d="M102 42v6M99 45h6" />}
        </g>
      </svg>
    </div>
  );
}
