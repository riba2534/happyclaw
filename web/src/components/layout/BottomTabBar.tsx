import { useMemo } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useAuthStore } from '../../stores/auth';
import { useBillingStore } from '../../stores/billing';
import { useScrollDirection } from '../../hooks/useScrollDirection';
import { lightTap } from '../../hooks/useHaptic';
import { baseNavItems } from './nav-items';

export function BottomTabBar() {
  const location = useLocation();
  const scrollDir = useScrollDirection();
  const isCompact = scrollDir === 'down';
  const user = useAuthStore((s) => s.user);
  const billingEnabled = useBillingStore((s) => s.billingEnabled);

  const navItems = useMemo(
    () => baseNavItems.filter((item) => {
      if (item.requiresBilling && !billingEnabled) return false;
      if (item.requireAdmin && user?.role !== 'admin') return false;
      return true;
    }),
    [billingEnabled, user?.role],
  );

  return (
    <>
      <div className="pwa-bottom-guard" aria-hidden="true" />
      <div className={`floating-nav-container ${isCompact ? 'compact' : ''}`}>
        <nav className="floating-nav">
          {navItems.map(({ path, icon: Icon, label }) => {
            const isActive = location.pathname.startsWith(path);
            return (
              <NavLink
                key={path}
                to={path}
                replace
                className={`floating-nav-item flex-col items-center justify-center ${isActive ? 'active' : ''}`}
                aria-label={label}
                onClick={() => lightTap()}
              >
                <Icon className="w-5 h-5" />
                <span className={`text-[10px] leading-tight mt-0.5 transition-all duration-200 ${isActive ? 'text-primary' : ''} ${isCompact ? 'max-h-0 opacity-0 overflow-hidden' : 'max-h-4 opacity-100'}`}>{label}</span>
              </NavLink>
            );
          })}
        </nav>
      </div>
    </>
  );
}
