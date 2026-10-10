import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { SettingsRow, type SettingsRowProps } from './SettingsLayout';

/**
 * Shared save placement for settings forms: the primary action sits
 * right-aligned directly below the last group it saves, at the default
 * 32px button size.
 */
export function SettingsFormFooter({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="settings-form-footer"
      className={cn('flex flex-wrap items-center justify-end gap-2', className)}
    >
      {children}
    </div>
  );
}

/**
 * Save footer for long multi-field forms. It sticks to the bottom of the app
 * scroll root and stays opaque. On mobile it extends down behind the floating
 * BottomTabBar so nothing scrolls through between the bar and the capsule:
 * the offsets cancel `pb-nav-safe` (7rem + safe area) and clear
 * `.floating-nav-container` (bottom max(24px, safe area), 58px tall) from
 * globals.css.
 */
export function SettingsStickySaveBar({
  status,
  children,
}: {
  status?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      data-slot="settings-sticky-save-bar"
      className="sticky bottom-0 z-10 mt-8 -mx-4 border-t border-surface-border bg-background px-4 max-lg:bottom-[calc(-7rem_-_env(safe-area-inset-bottom,0px))] max-lg:-mb-[calc(7rem_+_env(safe-area-inset-bottom,0px))] max-lg:pb-[calc(max(24px,env(safe-area-inset-bottom,0px))_+_58px_+_0.5rem)] sm:-mx-6 sm:px-6 lg:mx-0 lg:px-0"
    >
      <div className="flex h-14 items-center justify-between gap-4">
        <div className="min-w-0">{status}</div>
        <div className="flex shrink-0 items-center gap-2">{children}</div>
      </div>
    </div>
  );
}

/**
 * SettingsRow for a Switch: keeps the control on the right on narrow
 * screens instead of stacking it under the description.
 */
export function SettingsSwitchRow(props: SettingsRowProps) {
  return <SettingsRow {...props} inline />;
}
