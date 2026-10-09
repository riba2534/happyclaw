import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Settings building blocks (multica-style): a titled section holding a
 * bordered group of rows — label + description on the left, control on the
 * right. Use SettingsField for stacked inputs that need full width.
 */

export interface SettingsSectionProps {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

export function SettingsSection({
  title,
  description,
  actions,
  children,
  className,
}: SettingsSectionProps) {
  return (
    <section
      data-slot="settings-section"
      className={cn('space-y-3', className)}
    >
      {(title || actions) && (
        <div className="flex items-end justify-between gap-4">
          <div className="min-w-0">
            {title && (
              <h3 className="text-title-sm text-foreground">{title}</h3>
            )}
            {description && (
              <p className="mt-0.5 text-caption text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          {actions && (
            <div className="flex shrink-0 items-center gap-2">{actions}</div>
          )}
        </div>
      )}
      {children}
    </section>
  );
}

/** Bordered container whose children are separated by hairlines. */
export function SettingsGroup({ className, ...props }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="settings-group"
      className={cn(
        'divide-y divide-surface-border overflow-hidden rounded-xl bg-surface-raised ring-1 ring-surface-border',
        className,
      )}
      {...props}
    />
  );
}

export interface SettingsRowProps {
  label: ReactNode;
  description?: ReactNode;
  /** Control rendered on the right (switch, select, button…). */
  control?: ReactNode;
  /** Extra content under the row, e.g. an expanded editor. */
  children?: ReactNode;
  htmlFor?: string;
  className?: string;
  /** Keep a compact control (e.g. a Switch) on the right on phones too. */
  inline?: boolean;
}

export function SettingsRow({
  label,
  description,
  control,
  children,
  htmlFor,
  className,
  inline = false,
}: SettingsRowProps) {
  const Label = htmlFor ? 'label' : 'div';
  return (
    <div data-slot="settings-row" className={cn('px-4 py-3', className)}>
      <div
        className={cn(
          'flex min-h-9 sm:gap-6',
          inline
            ? 'flex-row items-center justify-between gap-4'
            : 'flex-col gap-2 sm:flex-row sm:items-center sm:justify-between',
        )}
      >
        <div className="min-w-0">
          <Label
            htmlFor={htmlFor}
            className="block text-body font-medium text-foreground"
          >
            {label}
          </Label>
          {description && (
            <div className="mt-0.5 text-caption leading-5 text-muted-foreground">
              {description}
            </div>
          )}
        </div>
        {control && (
          <div className="flex shrink-0 items-center gap-2 sm:max-w-[56%]">
            {control}
          </div>
        )}
      </div>
      {children && <div className="mt-3">{children}</div>}
    </div>
  );
}

export interface SettingsFieldProps {
  label: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}

/** Stacked label + full-width control, for inputs inside a group. */
export function SettingsField({
  label,
  description,
  htmlFor,
  children,
  className,
}: SettingsFieldProps) {
  return (
    <div data-slot="settings-field" className={cn('space-y-1.5', className)}>
      <label
        htmlFor={htmlFor}
        className="block text-label font-medium text-foreground"
      >
        {label}
      </label>
      {children}
      {description && (
        <p className="text-caption text-muted-foreground">{description}</p>
      )}
    </div>
  );
}
