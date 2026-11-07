import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useBillingStore } from '../../stores/billing';
import { useIsGuest } from '../../stores/auth';
import { useShellScrollState } from '../../hooks/useScrollDirection';
import { lightTap } from '../../hooks/useHaptic';
import { filterNavItems } from './nav-items';

interface IndicatorBox {
  left: number;
  top: number;
  width: number;
  height: number;
  /** False for the first placement, so it appears in place instead of sliding in. */
  slide: boolean;
}

export function BottomTabBar() {
  const location = useLocation();
  const isCompact = useShellScrollState() === 'compact';
  const billingEnabled = useBillingStore((s) => s.billingEnabled);
  const isGuest = useIsGuest();
  const navRef = useRef<HTMLElement>(null);
  const [indicator, setIndicator] = useState<IndicatorBox | null>(null);

  const navItems = useMemo(
    () =>
      // Guests have few pages, so their 记忆 tab fits on phones too.
      filterNavItems(billingEnabled, isGuest).filter(
        (item) => isGuest || !item.hideOnMobile,
      ),
    [billingEnabled, isGuest],
  );
  const activeIndex = navItems.findIndex((item) =>
    location.pathname.startsWith(item.path),
  );

  // The selected pill is one element that slides between tabs. Layout
  // offsets ignore the compact scale transform, so it only needs measuring
  // when the selection or the bar's own size changes.
  useLayoutEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    const measure = () => {
      const item =
        activeIndex >= 0
          ? nav.querySelectorAll<HTMLElement>('.floating-nav-item')[activeIndex]
          : undefined;
      if (!item) {
        setIndicator(null);
        return;
      }
      setIndicator((prev) => ({
        left: item.offsetLeft,
        top: item.offsetTop,
        width: item.offsetWidth,
        height: item.offsetHeight,
        slide: prev !== null,
      }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(nav);
    return () => observer.disconnect();
  }, [activeIndex, navItems]);

  return (
    <>
      <div className="pwa-bottom-guard" aria-hidden="true" />
      <div className={`floating-nav-container ${isCompact ? 'compact' : ''}`}>
        <nav ref={navRef} className="floating-nav">
          {indicator && (
            <span
              aria-hidden="true"
              data-testid="floating-nav-indicator"
              className={`floating-nav-indicator ${indicator.slide ? 'slide' : ''}`}
              style={{
                width: indicator.width,
                height: indicator.height,
                transform: `translate(${indicator.left}px, ${indicator.top}px)`,
              }}
            />
          )}
          {navItems.map(({ path, icon: Icon, label }, index) => {
            const isActive = index === activeIndex;
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
                <span
                  className={`text-[10px] leading-tight mt-0.5 transition-all duration-200 ${isActive ? 'font-medium text-foreground' : ''} ${isCompact ? 'max-h-0 opacity-0 overflow-hidden' : 'max-h-4 opacity-100'}`}
                >
                  {label}
                </span>
              </NavLink>
            );
          })}
        </nav>
      </div>
    </>
  );
}
