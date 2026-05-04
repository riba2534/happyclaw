import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { UnifiedSidebar } from './UnifiedSidebar';
import { BottomTabBar } from './BottomTabBar';
import { ConnectionBanner } from '../common/ConnectionBanner';
import { wsManager } from '../../api/ws';
import { useTheme } from '../../hooks/useTheme';
import { useRouteRestore } from '../../hooks/useRouteRestore';
import { useBillingStore } from '../../stores/billing';
import { useGroupsStore } from '../../stores/groups';
import { useChatStore } from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';

export function AppLayout() {
  const location = useLocation();
  const isChatRoute = location.pathname.startsWith('/chat');
  const hideMobileTabBar = /^\/chat\/.+/.test(location.pathname);
  useTheme(); // 应用并同步持久化的主题偏好
  useRouteRestore(); // PWA 重启时恢复上次访问的路由（默认关闭，设置中启用）

  // Sidebar: expanded only on chat route, collapsed on other routes
  const [userCollapsed, setUserCollapsed] = useState(false);
  const sidebarCollapsed = isChatRoute ? userCollapsed : true;

  // Keyboard shortcut: Cmd+B (Mac) / Ctrl+B (Windows) to toggle sidebar
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'b') {
        e.preventDefault();
        if (isChatRoute) setUserCollapsed((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isChatRoute]);

  // 应用级别建立 WebSocket 连接，确保所有页面（非仅 ChatView）都有连接
  useEffect(() => {
    wsManager.connect();
  }, []);

  // 加载计费状态（控制导航栏是否显示账单入口）
  const loadBillingStatus = useBillingStore((s) => s.loadBillingStatus);
  useEffect(() => {
    loadBillingStatus();
  }, [loadBillingStatus]);

  // 监听 WebSocket 计费更新
  useEffect(() => {
    const unsub = wsManager.on('billing_update', (data: any) => {
      if (data.usage) {
        useBillingStore.getState().handleBillingUpdate(data.usage);
      }
    });
    return () => { unsub(); };
  }, []);

  // 监听 runner_state 更新 sidebar 运行状态指示器
  useEffect(() => {
    const unsub = wsManager.on('runner_state', (data: any) => {
      if (data.chatJid && data.state) {
        useGroupsStore.getState().setRunnerState(data.chatJid, data.state);
        useChatStore.getState().handleRunnerState(data.chatJid, data.state);
      }
    });
    return () => { unsub(); };
  }, []);

  // 监听 group_created（定时任务工作区创建），刷新侧边栏和任务列表
  useEffect(() => {
    const unsub = wsManager.on('group_created', () => {
      useGroupsStore.getState().loadGroups();
      // Also refresh tasks — workspace_folder may have been populated
      import('../../stores/tasks').then((m) => m.useTasksStore.getState().loadTasks());
    });
    return () => { unsub(); };
  }, []);

  // 更新 document.title，显示未读回复数
  const totalUnread = useChatStore((s) => Object.values(s.unreadReplies).reduce((sum, n) => sum + n, 0));
  const appearance = useAuthStore((s) => s.appearance);
  useEffect(() => {
    const appName = appearance?.appName || 'HappyClaw';
    document.title = totalUnread > 0 ? `(${totalUnread}) ${appName}` : appName;
  }, [totalUnread, appearance?.appName]);

  // 全局监听 agent_status，确保不在 ChatView 页面时也能更新 sub-agent 状态
  useEffect(() => {
    const unsub = wsManager.on('agent_status', (data: any) => {
      if (data.chatJid && data.agentId) {
        useChatStore.getState().handleAgentStatus(
          data.chatJid, data.agentId, data.status,
          data.name, data.prompt, data.resultSummary, data.kind,
          data.titleGenerating,
        );
      }
    });
    return () => { unsub(); };
  }, []);

  return (
    <div className="h-screen supports-[height:100dvh]:h-dvh flex flex-col lg:flex-row overflow-hidden safe-area-top">
      <div className="hidden lg:block h-full flex-shrink-0">
        <UnifiedSidebar
          collapsed={sidebarCollapsed}
          onToggleCollapse={() => setUserCollapsed((prev) => !prev)}
        />
      </div>

      <div className="flex-1 min-h-0 flex flex-col overflow-hidden relative">
        <ConnectionBanner />
        <main
          data-app-scroll-root="true"
          className={`flex-1 min-h-0 lg:overflow-auto lg:pb-0 ${
            isChatRoute
              ? 'overflow-hidden'
              : `overflow-y-auto overflow-x-hidden overscroll-y-none ${hideMobileTabBar ? 'pb-6' : 'pb-nav-safe'}`
          }`}
        >
          <Outlet />
        </main>
      </div>

      {!hideMobileTabBar && <BottomTabBar />}
    </div>
  );
}
