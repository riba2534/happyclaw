import type { ComponentType, ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Shortcut } from '@/components/common/Shortcut';
import { cn } from '@/lib/utils';

/** Shared row styling for every sidebar entry (nav, actions, tree rows). */
export const sidebarRowClass =
  'group/sidebar-row relative flex h-8 w-full min-w-0 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-body text-muted-foreground outline-none transition-colors duration-100 select-none hover:bg-surface-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 data-[active=true]:bg-surface-selected data-[active=true]:font-medium data-[active=true]:text-foreground disabled:cursor-not-allowed disabled:opacity-60 [&_svg]:shrink-0';

export interface SidebarItemProps {
  icon: ComponentType<{ className?: string }>;
  label: string;
  /** Route target; the caller decides `active` from the current location. */
  to?: string;
  onClick?: () => void;
  active?: boolean;
  /** Keyboard shortcut shown on the right (and in the collapsed tooltip). */
  shortcut?: string;
  trailing?: ReactNode;
  collapsed?: boolean;
  disabled?: boolean;
}

export function SidebarItem({
  icon: Icon,
  label,
  to,
  onClick,
  active,
  shortcut,
  trailing,
  collapsed = false,
  disabled,
}: SidebarItemProps) {
  const content = (
    <>
      <Icon className="size-4" />
      {!collapsed && (
        <>
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {trailing}
          {shortcut && <Shortcut keys={shortcut} className="opacity-80" />}
        </>
      )}
    </>
  );
  const className = cn(
    sidebarRowClass,
    collapsed && 'mx-auto size-8 justify-center px-0',
  );

  const element = to ? (
    <Link
      to={to}
      onClick={onClick}
      aria-label={collapsed ? label : undefined}
      aria-current={active ? 'page' : undefined}
      data-active={active || undefined}
      className={className}
    >
      {content}
    </Link>
  ) : (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={collapsed ? label : undefined}
      data-active={active || undefined}
      className={className}
    >
      {content}
    </button>
  );

  if (!collapsed) return element;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{element}</TooltipTrigger>
      <TooltipContent side="right">
        {label}
        {shortcut && <Shortcut keys={shortcut} />}
      </TooltipContent>
    </Tooltip>
  );
}
