import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { lazy, Suspense, useMemo } from 'react';
import { NavRail } from './NavRail';
import { BottomTabBar, navItems } from './BottomTabBar';
import { SwipeablePages, type TabPageConfig } from './SwipeablePages';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { ConnectionBanner } from '../common/ConnectionBanner';

const ChatPage = lazy(() => import('../../pages/ChatPage').then(m => ({ default: m.ChatPage })));
const TasksPage = lazy(() => import('../../pages/TasksPage').then(m => ({ default: m.TasksPage })));
const MonitorPage = lazy(() => import('../../pages/MonitorPage').then(m => ({ default: m.MonitorPage })));
const SettingsPage = lazy(() => import('../../pages/SettingsPage').then(m => ({ default: m.SettingsPage })));

// Tab paths in order — must match navItems order
const TAB_PATHS = navItems.map(item => item.path);

function PageFallback() {
  return <div className="h-full flex items-center justify-center text-muted-foreground text-sm">加载中...</div>;
}

export function AppLayout() {
  const location = useLocation();
  const navigate = useNavigate();
  const isMobile = useMediaQuery('(max-width: 1023px)');
  const hideMobileTabBar = /^\/chat\/.+/.test(location.pathname);

  // In chat detail page (/chat/:folder), don't use swipeable mode
  const isInChatDetail = hideMobileTabBar;

  // Compute current tab index
  const currentTabIndex = useMemo(() => {
    const idx = TAB_PATHS.findIndex(p => location.pathname.startsWith(p));
    return idx >= 0 ? idx : 0;
  }, [location.pathname]);

  const pages: TabPageConfig[] = useMemo(() => [
    { path: '/chat', routePattern: '/chat/:groupFolder?', element: <Suspense fallback={<PageFallback />}><ChatPage /></Suspense> },
    { path: '/tasks', routePattern: '/tasks', element: <Suspense fallback={<PageFallback />}><TasksPage /></Suspense> },
    { path: '/monitor', routePattern: '/monitor', element: <Suspense fallback={<PageFallback />}><MonitorPage /></Suspense> },
    { path: '/settings', routePattern: '/settings', element: <Suspense fallback={<PageFallback />}><SettingsPage /></Suspense> },
  ], []);

  const handleTabChange = (index: number) => {
    navigate(TAB_PATHS[index], { replace: true });
  };

  // Mobile + not in chat detail → use SwipeablePages
  const showSwipeable = isMobile && !isInChatDetail;

  return (
    <div className="h-screen supports-[height:100dvh]:h-dvh flex flex-col lg:flex-row overflow-hidden safe-area-top">
      <div className="hidden lg:block h-full">
        <NavRail />
      </div>

      <div className="flex-1 flex flex-col overflow-hidden">
        <ConnectionBanner />
        <main className="flex-1 overflow-hidden lg:overflow-auto lg:pb-0">
          {showSwipeable ? (
            <SwipeablePages
              pages={pages}
              currentIndex={currentTabIndex}
              onIndexChange={handleTabChange}
            />
          ) : (
            <Outlet />
          )}
        </main>
      </div>

      {!hideMobileTabBar && <BottomTabBar />}
    </div>
  );
}
