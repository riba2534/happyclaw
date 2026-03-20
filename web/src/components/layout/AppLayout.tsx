import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { NavRail } from './NavRail';
import { BottomTabBar } from './BottomTabBar';
import { ConnectionBanner } from '../common/ConnectionBanner';
import { wsManager } from '../../api/ws';
import { useTheme } from '../../hooks/useTheme';
import { useBillingStore } from '../../stores/billing';
import { useGroupsStore } from '../../stores/groups';
import { useChatStore } from '../../stores/chat';

export function AppLayout() {
  const location = useLocation();
  const isChatRoute = location.pathname.startsWith('/chat');
  const hideMobileTabBar = /^\/chat\/.+/.test(location.pathname);
  useTheme(); // 应用并同步持久化的主题偏好

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

  // 全局监听 agent_status，确保不在 ChatView 页面时也能更新 sub-agent 状态
  useEffect(() => {
    const unsub = wsManager.on('agent_status', (data: any) => {
      if (data.chatJid && data.agentId) {
        useChatStore.getState().handleAgentStatus(
          data.chatJid, data.agentId, data.status,
          data.name, data.prompt, data.resultSummary, data.kind,
        );
      }
    });
    return () => { unsub(); };
  }, []);

  return (
    <div className="h-screen supports-[height:100dvh]:h-dvh flex flex-col lg:flex-row overflow-hidden safe-area-top">
      <div className="hidden lg:block h-full">
        <NavRail />
      </div>

      <div className="flex-1 min-h-0 flex flex-col overflow-hidden relative">
        <ConnectionBanner />
        <main
          data-app-scroll-root="true"
          className={`flex-1 min-h-0 lg:overflow-auto lg:pb-0 ${
            isChatRoute
              ? 'overflow-hidden'
              : `overflow-y-auto overflow-x-hidden overscroll-y-none ${hideMobileTabBar ? 'pb-6' : 'pb-28'}`
          }`}
        >
          <Outlet />
        </main>
      </div>

      {!hideMobileTabBar && <BottomTabBar />}
    </div>
  );
}
