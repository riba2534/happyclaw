import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Titled block used across the agent editor: a SettingsSection-style heading
 * whose actions wrap under the title on narrow screens instead of squeezing it.
 */
export function AgentSection({
  id,
  title,
  description,
  actions,
  hidden,
  className,
  children,
}: {
  id?: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  hidden?: boolean;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <section
      id={id}
      hidden={hidden}
      data-slot="agent-section"
      className={cn('min-w-0 space-y-3', className)}
    >
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-64">
          <h2 className="text-title-sm text-foreground">{title}</h2>
          {description && (
            <p className="mt-0.5 text-caption leading-5 text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {actions && (
          <div className="flex shrink-0 flex-wrap items-center gap-1.5">
            {actions}
          </div>
        )}
      </div>
      {children}
    </section>
  );
}

/** Heading for a block nested inside a section's group. */
export function AgentSubheading({
  title,
  badge,
  description,
  className,
}: {
  title: ReactNode;
  badge?: ReactNode;
  description?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <div className="flex items-center gap-2">
        <h3 className="text-body font-medium text-foreground">{title}</h3>
        {badge}
      </div>
      {description && (
        <p className="mt-0.5 text-caption leading-5 text-muted-foreground">
          {description}
        </p>
      )}
    </div>
  );
}

/**
 * SettingsRow variant for wide controls (selects). It stacks by its own width
 * rather than the viewport, so the control never overflows a group that the
 * agent list column has squeezed.
 */
export function AgentControlRow({
  label,
  description,
  control,
}: {
  label: ReactNode;
  description?: ReactNode;
  control: ReactNode;
}) {
  return (
    <div data-slot="settings-row" className="@container px-4 py-3">
      <div className="flex min-h-9 flex-col gap-2 @xl:flex-row @xl:items-center @xl:justify-between @xl:gap-6">
        <div className="min-w-0">
          <div className="text-body font-medium text-foreground">{label}</div>
          {description && (
            <div className="mt-0.5 text-caption leading-5 text-muted-foreground">
              {description}
            </div>
          )}
        </div>
        <div className="flex w-full max-w-64 shrink-0 items-center @xl:w-64">
          {control}
        </div>
      </div>
    </div>
  );
}

/** Radio-style option card shared by every single-choice picker here. */
export function choiceCardClassName(checked: boolean, className?: string) {
  return cn(
    'flex items-start gap-2.5 rounded-lg px-3 py-2.5 text-left ring-1 transition-colors duration-100 outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50',
    checked
      ? 'bg-surface-selected ring-primary/60'
      : 'bg-transparent ring-surface-border hover:bg-surface-hover',
    className,
  );
}

export function ChoiceCardBody({
  checked,
  title,
  description,
  badge,
}: {
  checked: boolean;
  title: ReactNode;
  description: ReactNode;
  badge?: ReactNode;
}) {
  return (
    <>
      <span
        aria-hidden="true"
        className={cn(
          'mt-0.5 grid size-3.5 shrink-0 place-items-center rounded-full ring-1',
          checked ? 'ring-primary' : 'ring-border',
        )}
      >
        {checked && <span className="size-1.5 rounded-full bg-primary" />}
      </span>
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-label text-foreground">
          {title}
          {badge}
        </span>
        <span className="mt-0.5 block text-caption leading-5 text-muted-foreground">
          {description}
        </span>
      </span>
    </>
  );
}
