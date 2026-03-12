import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { NavRail } from './NavRail';
import { BottomTabBar } from './BottomTabBar';
import { ConnectionBanner } from '../common/ConnectionBanner';
import { wsManager } from '../../api/ws';
import { useTheme } from '../../hooks/useTheme';

export function AppLayout() {
  const location = useLocation();
  const isChatRoute = location.pathname.startsWith('/chat');
  const hideMobileTabBar = /^\/chat\/.+/.test(location.pathname);
  useTheme(); // 应用并同步持久化的主题偏好

  // 应用级别建立 WebSocket 连接，确保所有页面（非仅 ChatView）都有连接
  useEffect(() => {
    wsManager.connect();
  }, []);

  return (
    <div className="h-screen supports-[height:100dvh]:h-dvh flex flex-col lg:flex-row overflow-hidden safe-area-top">
      <div className="hidden lg:block h-full">
        <NavRail />
      </div>

      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        <ConnectionBanner />
        <main
          data-app-scroll-root="true"
          className={`flex-1 min-h-0 lg:overflow-auto lg:pb-0 ${
            isChatRoute
              ? 'overflow-hidden'
              : `overflow-y-auto overflow-x-hidden overscroll-y-contain ${hideMobileTabBar ? 'pb-6' : 'pb-28'}`
          }`}
        >
          <Outlet />
        </main>
      </div>

      {!hideMobileTabBar && <BottomTabBar />}
    </div>
  );
}
