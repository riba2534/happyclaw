import { NavLink, useLocation } from 'react-router-dom';
import { MessageSquare, Clock, Activity, Settings } from 'lucide-react';
import { useScrollDirection } from '../../hooks/useScrollDirection';
import { lightTap } from '../../hooks/useHaptic';

export const navItems = [
  { path: '/chat', icon: MessageSquare, label: '工作台' },
  { path: '/tasks', icon: Clock, label: '任务' },
  { path: '/monitor', icon: Activity, label: '监控' },
  { path: '/settings', icon: Settings, label: '设置' },
];

export function BottomTabBar() {
  const location = useLocation();
  const scrollDir = useScrollDirection();
  const isCompact = scrollDir === 'down';

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
