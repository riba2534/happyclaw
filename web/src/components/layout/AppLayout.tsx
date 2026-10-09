import { useEffect } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { UnifiedSidebar } from './UnifiedSidebar';
import { BottomTabBar } from './BottomTabBar';
import { ConnectionBanner } from '../common/ConnectionBanner';
import { wsManager } from '../../api/ws';
import { useTheme } from '../../hooks/useTheme';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useRouteRestore } from '../../hooks/useRouteRestore';
import { useBillingStore } from '../../stores/billing';
import { useGroupsStore } from '../../stores/groups';
import { useChatStore } from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';
import { ErrorBoundary } from '../common/ErrorBoundary';
import { TooltipProvider } from '@/components/ui/tooltip';
import { MotionProvider } from '@/lib/motion';
import { SHORTCUTS, useShortcut } from '@/lib/shortcuts';
import { useShellStore } from '../../stores/shell';
import { useNewConversation } from '../../hooks/useNewConversation';

export function AppLayout() {
  const location = useLocation();
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const isChatRoute = location.pathname.startsWith('/chat');
  const hideMobileTabBar = /^\/chat\/.+/.test(location.pathname);
  useTheme(); // 应用并同步持久化的主题偏好
  useRouteRestore(); // PWA 重启时恢复上次访问的路由（默认关闭，设置中启用）

  // ⌘B / Ctrl+B toggles the desktop sidebar between full width and icon rail.
  const toggleSidebar = useShellStore((s) => s.toggleSidebar);
  useShortcut(SHORTCUTS.toggleSidebar, toggleSidebar, { enabled: isDesktop });
  const { startNewConversation } = useNewConversation();
  useShortcut(SHORTCUTS.newConversation, () => void startNewConversation());

  // The sidebar's workspace tree is visible on every route, not just /chat.
  const loadGroups = useChatStore((s) => s.loadGroups);
  useEffect(() => {
    void loadGroups();
  }, [loadGroups]);

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
    return () => {
      unsub();
    };
  }, []);

  // Process lifecycle (legacy) plus logical query lifecycle. A conversation
  // process may stay warm between turns, so run_started/active_run_snapshot
  // are the authoritative signals for immediate and reconnect restoration.
  useEffect(() => {
    const unsubRunner = wsManager.on('runner_state', (data: any) => {
      if (data.chatJid && data.state) {
        if (!data.chatJid.includes('#agent:')) {
          useGroupsStore.getState().setRunnerState(data.chatJid, data.state);
        }
        useChatStore.getState().handleRunnerState(data.chatJid, data.state);
      }
    });
    const unsubStarted = wsManager.on('run_started', (data: any) => {
      if (!data.chatJid) return;
      if (!data.chatJid.includes('#agent:')) {
        useGroupsStore.getState().setRunnerState(data.chatJid, 'running');
      }
      useChatStore.getState().handleRunStarted(data.chatJid, data.runId);
    });
    const unsubFinished = wsManager.on('run_finished', (data: any) => {
      if (!data.chatJid || !data.runId) return;
      useChatStore.getState().handleRunFinished(data.chatJid, data.runId);
    });
    const unsubSnapshot = wsManager.on('active_run_snapshot', (data: any) => {
      const runs = Array.isArray(data.runs) ? data.runs : [];
      const queuedChatJids = Array.isArray(data.queuedChatJids)
        ? data.queuedChatJids
        : [];
      useChatStore.getState().handleActiveRunSnapshot(runs, queuedChatJids);
      for (const run of runs) {
        if (!run?.chatJid) continue;
        if (!run.chatJid.includes('#agent:')) {
          useGroupsStore.getState().setRunnerState(run.chatJid, 'running');
        }
      }
    });
    return () => {
      unsubRunner();
      unsubStarted();
      unsubFinished();
      unsubSnapshot();
    };
  }, []);

  // Message deletion is a durable server mutation. Apply it globally so a
  // second tab/device cannot retain a deleted main or Runtime Session bubble.
  useEffect(() => {
    const unsub = wsManager.on('message_deleted', (data: any) => {
      if (!data.messageChatJid || !data.messageId) return;
      void useChatStore
        .getState()
        .handleMessageDeleted(data.messageChatJid, data.messageId);
    });
    return () => {
      unsub();
    };
  }, []);

  // 监听 group_created（定时任务工作区创建），刷新侧边栏和任务列表
  useEffect(() => {
    const unsub = wsManager.on('group_created', () => {
      useGroupsStore.getState().loadGroups();
      // Also refresh tasks — workspace_folder may have been populated
      import('../../stores/tasks').then((m) =>
        m.useTasksStore.getState().loadTasks(),
      );
    });
    return () => {
      unsub();
    };
  }, []);

  // 更新 document.title，显示未读回复数
  const totalUnread = useChatStore((s) =>
    Object.values(s.unreadReplies).reduce((sum, n) => sum + n, 0),
  );
  const appearance = useAuthStore((s) => s.appearance);
  useEffect(() => {
    const appName = appearance?.appName || 'HappyClaw';
    document.title = totalUnread > 0 ? `(${totalUnread}) ${appName}` : appName;
  }, [totalUnread, appearance?.appName]);

  // 全局监听 agent_status，确保不在 ChatView 页面时也能更新 sub-agent 状态
  useEffect(() => {
    const unsub = wsManager.on('agent_status', (data: any) => {
      if (data.chatJid && data.agentId) {
        useChatStore
          .getState()
          .handleAgentStatus(
            data.chatJid,
            data.agentId,
            data.status,
            data.name,
            data.prompt,
            data.resultSummary,
            data.kind,
            data.titleGenerating,
          );
      }
    });
    return () => {
      unsub();
    };
  }, []);

  return (
    <MotionProvider>
      <TooltipProvider>
        <div className="h-screen supports-[height:100dvh]:h-dvh flex flex-col lg:flex-row overflow-hidden safe-area-top lg:bg-app-shell">
          {/* 条件挂载：手机只渲染真正可见的那份列表，不在后台挂整棵侧边栏。 */}
          {isDesktop && <UnifiedSidebar />}

          {/* Desktop: pages render on an inset canvas floating in the shell. */}
          <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden [--app-canvas-h:100dvh] lg:my-2 lg:mr-2 lg:rounded-xl lg:bg-background lg:shadow-canvas lg:ring-1 lg:ring-surface-border lg:[--app-canvas-h:calc(100dvh-1rem)]">
            <ConnectionBanner />
            <main
              data-app-scroll-root="true"
              className={`flex-1 min-h-0 lg:overflow-auto lg:pb-0 ${
                isChatRoute
                  ? 'overflow-hidden'
                  : `overflow-y-auto overflow-x-hidden overscroll-y-none ${hideMobileTabBar ? 'pb-6' : 'pb-nav-safe'}`
              }`}
            >
              <ErrorBoundary resetKeys={[location.pathname]}>
                <Outlet />
              </ErrorBoundary>
            </main>
          </div>

          {!hideMobileTabBar && <BottomTabBar />}
        </div>
      </TooltipProvider>
    </MotionProvider>
  );
}
