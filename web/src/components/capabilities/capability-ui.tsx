import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CircleCheck, CircleX, Info } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { ListGroup } from '@/components/common/ListRow';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/**
 * Top-bar action slot owned by CapabilitiesPage. `undefined` means the
 * section is rendered standalone, so its actions stay inline.
 */
export const CapabilityActionsSlotContext = createContext<
  HTMLElement | null | undefined
>(undefined);

/** Renders a section's actions into the capabilities top bar. */
export function CapabilitySectionActions({
  children,
}: {
  children: ReactNode;
}) {
  const slot = useContext(CapabilityActionsSlotContext);
  if (slot === undefined) {
    return <div className="flex items-center gap-1.5">{children}</div>;
  }
  return slot ? createPortal(children, slot) : null;
}

const calloutTones = {
  muted: { className: 'bg-muted/50 text-muted-foreground', icon: Info },
  warning: { className: 'bg-warning/10 text-warning', icon: AlertTriangle },
  error: { className: 'bg-error/10 text-error', icon: CircleX },
  success: { className: 'bg-success/10 text-success', icon: CircleCheck },
} as const;

export function Callout({
  tone = 'muted',
  icon,
  role,
  className,
  children,
}: {
  tone?: keyof typeof calloutTones;
  /** Pass `false` to hide the leading icon. */
  icon?: LucideIcon | false;
  role?: 'alert' | 'status';
  className?: string;
  children: ReactNode;
}) {
  const Icon = icon === false ? null : (icon ?? calloutTones[tone].icon);
  return (
    <div
      role={role}
      className={cn(
        'flex gap-2 rounded-lg px-3 py-2 text-caption leading-5',
        calloutTones[tone].className,
        className,
      )}
    >
      {Icon && (
        <Icon
          aria-hidden="true"
          className={cn(
            'mt-0.5 size-3.5 shrink-0',
            tone === 'muted' && 'text-faint-foreground',
          )}
        />
      )}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

/** Captioned group of rows, e.g. "我的 Skills (3)". */
export function CapabilityListSection({
  title,
  description,
  actions,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex min-h-7 items-center justify-between gap-3 px-1">
        <h2 className="text-caption font-medium text-muted-foreground">
          {title}
        </h2>
        {actions && <div className="flex shrink-0 items-center">{actions}</div>}
      </div>
      {description && (
        <p className="px-1 text-caption leading-5 text-muted-foreground">
          {description}
        </p>
      )}
      <ListGroup>{children}</ListGroup>
    </section>
  );
}

/** Row shell shared by Skill and MCP rows: a select button plus trailing controls. */
export function capabilityRowClass(selected: boolean) {
  return cn(
    'relative flex items-center gap-2 pr-4 transition-colors duration-100',
    selected
      ? 'bg-surface-selected'
      : 'hover:bg-surface-hover focus-within:bg-surface-hover',
  );
}

export const capabilityRowButtonClass =
  'flex min-w-0 flex-1 items-start gap-3 py-3 pl-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset';

export function CapabilityMedia({
  icon: Icon,
  className,
}: {
  icon: LucideIcon;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground',
        className,
      )}
    >
      <Icon className="size-4" />
    </span>
  );
}

/** Bordered surface used for the desktop detail column. */
export function DetailPanel({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      data-slot="detail-panel"
      className={cn(
        'overflow-hidden rounded-xl bg-surface-raised ring-1 ring-surface-border',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function DetailSection({
  title,
  actions,
  className,
  children,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        'space-y-3 border-t border-surface-border px-5 py-4',
        className,
      )}
    >
      {(title || actions) && (
        <div className="flex items-center justify-between gap-3">
          {title && <h3 className="text-title-sm text-foreground">{title}</h3>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

/** Two-option card picker (scope, member access) with a radio dot. */
export function ChoiceCard({
  selected,
  title,
  description,
  disabled,
  onSelect,
}: {
  selected: boolean;
  title: string;
  description: string;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'flex items-start gap-2.5 rounded-lg px-3 py-2.5 text-left ring-1 transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-50',
        selected
          ? 'bg-surface-selected ring-foreground/25'
          : 'bg-background ring-surface-border hover:bg-surface-hover',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'mt-0.5 grid size-3.5 shrink-0 place-items-center rounded-full ring-1',
          selected ? 'ring-primary' : 'ring-border',
        )}
      >
        {selected && <span className="size-1.5 rounded-full bg-primary" />}
      </span>
      <span className="min-w-0">
        <span className="block text-label text-foreground">{title}</span>
        <span className="mt-0.5 block text-caption text-muted-foreground">
          {description}
        </span>
      </span>
    </button>
  );
}

export function CapabilityListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <ListGroup aria-busy="true">
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          role="listitem"
          className="flex items-center gap-3 px-4 py-3"
        >
          <Skeleton className="size-8 rounded-lg" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-2/5" />
            <Skeleton className="h-3 w-3/4" />
          </div>
        </div>
      ))}
    </ListGroup>
  );
}
