import { useMemo } from 'react';
import { NavLink } from 'react-router-dom';
import { useAuthStore } from '../../stores/auth';
import { useBillingStore } from '../../stores/billing';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { baseNavItems } from './nav-items';

export function NavRail() {
  const user = useAuthStore((s) => s.user);
  const billingEnabled = useBillingStore((s) => s.billingEnabled);

  const navItems = useMemo(
    () => baseNavItems.filter((item) => {
      if (item.requiresBilling && !billingEnabled) return false;
      if ('requireAdmin' in item && item.requireAdmin && user?.role !== 'admin') return false;
      return true;
    }),
    [billingEnabled, user?.role],
  );

  return (
    <TooltipProvider delayDuration={200}>
      <nav className="w-16 h-full bg-muted/30 flex flex-col items-center py-4 gap-2">
        {/* Logo — decorative */}
        <div className="w-10 h-10 rounded-xl overflow-hidden mb-2 flex-shrink-0">
          <img src={`${import.meta.env.BASE_URL}icons/icon-192.png`} alt="HappyClaw" className="w-full h-full object-cover" />
        </div>

        {navItems.map(({ path, icon: Icon, label }) => (
          <Tooltip key={path}>
            <TooltipTrigger asChild>
              <NavLink
                to={path}
                className={({ isActive }) =>
                  `w-12 flex flex-col items-center justify-center gap-1 transition-all ${
                    isActive
                      ? 'text-primary font-medium'
                      : 'text-muted-foreground hover:text-foreground'
                  }`
                }
              >
                {({ isActive }) => (
                  <>
                    <span className={`w-9 h-9 rounded-xl flex items-center justify-center transition-all ${
                      isActive
                        ? 'bg-brand-100/60 dark:bg-brand-500/15 text-primary'
                        : 'hover:bg-accent'
                    }`}>
                      <Icon className="w-[18px] h-[18px]" strokeWidth={isActive ? 2 : 1.75} />
                    </span>
                    <span className="text-[10px] leading-none">{label}</span>
                  </>
                )}
              </NavLink>
            </TooltipTrigger>
            <TooltipContent side="right">
              {label}
            </TooltipContent>
          </Tooltip>
        ))}

        {/* Spacer */}
        <div className="flex-1" />
      </nav>
    </TooltipProvider>
  );
}
