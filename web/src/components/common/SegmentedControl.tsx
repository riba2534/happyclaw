import type { ComponentType } from 'react';
import { cn } from '@/lib/utils';

export interface SegmentedOption<V extends string = string> {
  value: V;
  label: string;
  icon?: ComponentType<{ className?: string }>;
}

export interface SegmentedControlProps<V extends string = string> {
  /** Accessible group label. */
  label: string;
  value: V;
  options: SegmentedOption<V>[];
  onChange: (value: V) => void;
  size?: 'sm' | 'default';
  className?: string;
}

/** Compact single-choice switcher (pressed-button group). */
export function SegmentedControl<V extends string = string>({
  label,
  value,
  options,
  onChange,
  size = 'default',
  className,
}: SegmentedControlProps<V>) {
  return (
    <div
      role="group"
      aria-label={label}
      data-slot="segmented-control"
      className={cn(
        'inline-flex min-w-0 max-w-full gap-0.5 overflow-x-auto rounded-lg bg-muted p-0.5',
        className,
      )}
    >
      {options.map((option) => {
        const Icon = option.icon;
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(option.value)}
            className={cn(
              'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md px-2.5 font-medium whitespace-nowrap transition-colors duration-100 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 pointer-coarse:min-h-11',
              size === 'sm' ? 'h-6 text-caption' : 'h-7 text-label',
              active
                ? 'bg-background text-foreground shadow-xs ring-1 ring-surface-border dark:bg-surface-selected'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {Icon && <Icon className="size-3.5" />}
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
