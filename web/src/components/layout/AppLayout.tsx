import { Outlet, useLocation } from 'react-router-dom';
import { NavRail } from './NavRail';
import { BottomTabBar } from './BottomTabBar';
import { ConnectionBanner } from '../common/ConnectionBanner';

export function AppLayout() {
  const location = useLocation();
  const hideMobileTabBar = /^\/chat\/.+/.test(location.pathname);

  return (
    <div className="h-screen supports-[height:100dvh]:h-dvh flex flex-col lg:flex-row overflow-hidden safe-area-top">
      <div className="hidden lg:block h-full">
        <NavRail />
      </div>

      <div className="flex-1 flex flex-col overflow-hidden">
        <ConnectionBanner />
        <main className="flex-1 overflow-hidden lg:overflow-auto lg:pb-0">
          <Outlet />
        </main>
      </div>

      {!hideMobileTabBar && <BottomTabBar />}
    </div>
  );
}
