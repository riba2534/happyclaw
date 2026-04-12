import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useChatStore } from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { FilePanel } from './FilePanel';
import { ContainerEnvPanel } from './ContainerEnvPanel';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { PromptDialog } from '@/components/common/PromptDialog';
import { ArrowLeft, FolderOpen, Link, MessageSquare, Monitor, Moon, MoreHorizontal, PanelRightClose, PanelRightOpen, Puzzle, Server, Sun, Terminal, Users, Variable, X } from 'lucide-react';
import { useDisplayMode } from '../../hooks/useDisplayMode';
import { useTheme } from '../../hooks/useTheme';
import { cn } from '@/lib/utils';
import { wsManager } from '../../api/ws';
import { api } from '../../api/client';
import { TerminalPanel } from './TerminalPanel';
import { GroupMembersPanel } from './GroupMembersPanel';
import { WorkspaceSkillsPanel } from './WorkspaceSkillsPanel';
import { WorkspaceMcpPanel } from './WorkspaceMcpPanel';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { AgentTabBar } from './AgentTabBar';
import { ImBindingDialog } from './ImBindingDialog';
import { TopicSidebar } from './TopicSidebar';
import { showToast } from '../../utils/toast';
import { CHANNEL_LABEL } from '../settings/channel-meta';

/** Sentinel value for binding the main conversation (vs. a specific agent) */
const MAIN_BINDING = '__main__' as const;

const SIDEBAR_TABS = [
  { id: 'files' as const, icon: FolderOpen, label: '文件管理' },
  { id: 'env' as const, icon: Variable, label: '环境变量' },
  { id: 'skills' as const, icon: Puzzle, label: '工作区 Skills' },
  { id: 'mcp' as const, icon: Server, label: '工作区 MCP' },
  { id: 'members' as const, icon: Users, label: '成员' },
];

const POLL_INTERVAL_MS = 2000;
const TERMINAL_MIN_HEIGHT = 150;
const TERMINAL_DEFAULT_HEIGHT = 300;
const TERMINAL_MAX_RATIO = 0.7;

// Stable empty references to avoid infinite re-render loops in Zustand selectors
const EMPTY_AGENTS: import('../../types').AgentInfo[] = [];

type SidebarTab = 'files' | 'env' | 'skills' | 'mcp' | 'members';

interface ChatViewProps {
  groupJid: string;
  onBack?: () => void;
  headerLeft?: React.ReactNode;
}

export function ChatView({ groupJid, onBack, headerLeft }: ChatViewProps) {
  const { mode: displayMode, toggle: toggleDisplayMode } = useDisplayMode();
  const { theme, toggle: toggleTheme } = useTheme();
  const [mobilePanel, setMobilePanel] = useState<SidebarTab | null>(null);
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('files');
  const [panelOpen, setPanelOpen] = useState(false);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);
  const [resetAgentId, setResetAgentId] = useState<string | null>(null);
  // Desktop: visible controls panel height, mounted controls terminal lifecycle.
  const [terminalVisible, setTerminalVisible] = useState(false);
  const [terminalMounted, setTerminalMounted] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(TERMINAL_DEFAULT_HEIGHT);
  const [mobileTerminal, setMobileTerminal] = useState(false);
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);
  // null = dialog closed; MAIN_BINDING = main conversation; other = agent id
  const [bindingAgentId, setBindingAgentId] = useState<string | null>(null);
  const [showNewConversation, setShowNewConversation] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{ agentId: string; name: string } | null>(null);
  const [topicFilter, setTopicFilter] = useState('');
  const [isDesktop, setIsDesktop] = useState(() =>
    typeof window !== 'undefined'
      ? window.matchMedia('(min-width: 1024px)').matches
      : true,
  );
  const [imStatus, setImStatus] = useState<Record<string, boolean> | null>(null);
  const [imBannerDismissed, setImBannerDismissed] = useState(() =>
    localStorage.getItem('im-banner-dismissed') === '1',
  );
  const navigate = useNavigate();

  // Drag state refs (not reactive — only used in event handlers)
  const containerRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const dragStartYRef = useRef(0);
  const dragStartHeightRef = useRef(0);

  // Individual selectors: avoid re-renders from unrelated store changes (e.g. streaming)
  const group = useChatStore(s => s.groups[groupJid]);
  const groupMessages = useChatStore(s => s.messages[groupJid]);
  const isWaiting = useChatStore(s => !!s.waiting[groupJid]);
  const mainInterrupted = useChatStore(s => !!s.streaming[groupJid]?.interrupted);
  const hasMoreMessages = useChatStore(s => !!s.hasMore[groupJid]);
  const loading = useChatStore(s => s.loading);
  const loadMessages = useChatStore(s => s.loadMessages);
  const refreshMessages = useChatStore(s => s.refreshMessages);
  const sendMessage = useChatStore(s => s.sendMessage);
  const interruptQuery = useChatStore(s => s.interruptQuery);
  const resetSession = useChatStore(s => s.resetSession);
  const handleStreamEvent = useChatStore(s => s.handleStreamEvent);
  const handleWsNewMessage = useChatStore(s => s.handleWsNewMessage);
  const handleStreamSnapshot = useChatStore(s => s.handleStreamSnapshot);

  const agents = useChatStore(s => s.agents[groupJid] ?? EMPTY_AGENTS);
  const activeAgentTab = useChatStore(s => s.activeAgentTab[groupJid] ?? null);
  const setActiveAgentTab = useChatStore(s => s.setActiveAgentTab);
  const loadAgents = useChatStore(s => s.loadAgents);
  const deleteAgentAction = useChatStore(s => s.deleteAgentAction);
  const agentStreaming = useChatStore(s => s.agentStreaming);
  const createConversation = useChatStore(s => s.createConversation);
  const renameConversation = useChatStore(s => s.renameConversation);
  const reorderConversations = useChatStore(s => s.reorderConversations);
  const loadAgentMessages = useChatStore(s => s.loadAgentMessages);
  const refreshAgentMessages = useChatStore(s => s.refreshAgentMessages);
  const sendAgentMessage = useChatStore(s => s.sendAgentMessage);
  const agentMessages = useChatStore(s => s.agentMessages);
  const agentWaiting = useChatStore(s => s.agentWaiting);
  const agentHasMore = useChatStore(s => s.agentHasMore);

  const markChatRead = useChatStore(s => s.markChatRead);

  const currentUser = useAuthStore(s => s.user);
  const canUseTerminal = group?.execution_mode !== 'host';
  const pollRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Sidebar: members tab visibility
  const isHome = !!group?.is_home;
  const showMembersTab = (!!group?.is_shared || group?.member_role === 'owner') && !isHome;
  const visibleTabs = SIDEBAR_TABS.filter(t => t.id !== 'members' || showMembersTab);

  // Fallback: if current tab is hidden, reset to files
  useEffect(() => {
    if (sidebarTab === 'members' && !showMembersTab) setSidebarTab('files');
  }, [sidebarTab, showMembersTab]);

  // Fetch IM connection status for home groups
  const isOwnHome =
    isHome &&
    (
      (!!group?.created_by && group.created_by === currentUser?.id) ||
      (currentUser?.role === 'admin' && group?.folder === 'main')
    );
  useEffect(() => {
    if (!isOwnHome) { setImStatus(null); return; }
    let active = true;
    const fetchStatus = () => {
      api.get<Record<string, boolean>>('/api/config/user-im/status')
        .then((data) => { if (active) setImStatus(data); })
        .catch(() => {});
    };
    fetchStatus();
    const timer = setInterval(fetchStatus, 30_000); // refresh every 30s
    return () => { active = false; clearInterval(timer); };
  }, [isOwnHome]);

  // 进入对话时清除未读计数
  useEffect(() => {
    markChatRead(groupJid);
    const onFocus = () => markChatRead(groupJid);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [groupJid, markChatRead]);

  // Load messages on group select
  const hasMessages = !!groupMessages;
  useEffect(() => {
    if (groupJid && !hasMessages) {
      loadMessages(groupJid);
    }
  }, [groupJid, hasMessages, loadMessages]);

  // Poll for new messages — use setTimeout recursion to avoid request piling up
  // Pauses when the page is not visible to save resources
  useEffect(() => {
    let active = true;

    const schedulePoll = () => {
      if (!active || document.hidden) return;
      pollRef.current = setTimeout(poll, POLL_INTERVAL_MS);
    };

    const poll = async () => {
      if (!active) return;
      try {
        await refreshMessages(groupJid);
      } catch { /* handled in store */ }
      schedulePoll();
    };

    const handleVisibility = () => {
      if (!document.hidden && active) {
        // Resume polling immediately when page becomes visible
        if (pollRef.current) clearTimeout(pollRef.current);
        poll();
      }
    };

    document.addEventListener('visibilitychange', handleVisibility);
    schedulePoll();

    return () => {
      active = false;
      document.removeEventListener('visibilitychange', handleVisibility);
      if (pollRef.current) clearTimeout(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupJid]);

  // WS 重连时恢复正在运行的 agent 状态（独立于 groupJid，避免切换会话时重复调用）
  // wsManager.connect() 已提升到 AppLayout 级别
  const restoreActiveState = useChatStore(s => s.restoreActiveState);
  useEffect(() => {
    restoreActiveState();
    const unsub = wsManager.on('connected', () => {
      restoreActiveState();
      // Reconcile agent list with backend truth — picks up any agent_status
      // events that were missed during WS disconnection.
      loadAgents(groupJid);
      // Refresh conversation agent messages that may have been missed during WS disconnection
      const state = useChatStore.getState();
      const currentTab = state.activeAgentTab[groupJid];
      if (currentTab) {
        const agentInfo = (state.agents[groupJid] || []).find(a => a.id === currentTab);
        if (agentInfo?.kind === 'conversation') {
          refreshAgentMessages(groupJid, currentTab);
        }
      }
    });
    return () => { unsub(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupJid]);

  // Derived: active agent info and kind
  const activeAgent = activeAgentTab ? agents.find(a => a.id === activeAgentTab) : null;
  const isConversationTab = activeAgent?.kind === 'conversation';
  const isTopicWorkspace =
    group?.conversation_nav_mode === 'vertical_threads' ||
    agents.some((a) => a.source_kind === 'feishu_thread');
  const topicAgents = useMemo(() =>
    agents
      .filter((a) => a.kind === 'conversation')
      .slice()
      .sort((a, b) => {
        const aTs = a.last_active_at || a.latest_message?.timestamp || a.created_at;
        const bTs = b.last_active_at || b.latest_message?.timestamp || b.created_at;
        return new Date(bTs).getTime() - new Date(aTs).getTime();
      }),
    [agents],
  );
  const filteredTopicAgents = useMemo(() =>
    topicAgents.filter((agent) => {
      const q = topicFilter.trim().toLowerCase();
      if (!q) return true;
      return (
        agent.name.toLowerCase().includes(q) ||
        (agent.latest_message?.content || '').toLowerCase().includes(q)
      );
    }),
    [topicAgents, topicFilter],
  );
  // SDK Tasks 不再创建独立标签页，事件直接显示在主对话流式卡片中

  // Load sub-agents for this group
  useEffect(() => {
    loadAgents(groupJid);
  }, [groupJid, loadAgents]);

  useEffect(() => {
    setTopicFilter('');
  }, [groupJid]);

  useEffect(() => {
    const media = window.matchMedia('(min-width: 1024px)');
    const syncDesktop = () => setIsDesktop(media.matches);
    syncDesktop();
    media.addEventListener('change', syncDesktop);
    return () => media.removeEventListener('change', syncDesktop);
  }, []);

  useEffect(() => {
    if (!isTopicWorkspace || !isDesktop || activeAgentTab || filteredTopicAgents.length === 0) return;
    setActiveAgentTab(groupJid, filteredTopicAgents[0].id);
  }, [isTopicWorkspace, isDesktop, activeAgentTab, filteredTopicAgents, groupJid, setActiveAgentTab]);

  useEffect(() => {
    if (!isTopicWorkspace || !activeAgentTab) return;
    const existsInTopics = topicAgents.some((agent) => agent.id === activeAgentTab);
    if (existsInTopics) return;
    setActiveAgentTab(groupJid, isDesktop && topicAgents[0] ? topicAgents[0].id : null);
  }, [isTopicWorkspace, activeAgentTab, topicAgents, isDesktop, groupJid, setActiveAgentTab]);

  // Load messages for conversation agent tabs
  useEffect(() => {
    if (activeAgentTab && isConversationTab) {
      const existing = agentMessages[activeAgentTab];
      if (!existing) {
        loadAgentMessages(groupJid, activeAgentTab);
      }
    }
  }, [activeAgentTab, isConversationTab, groupJid, loadAgentMessages, agentMessages]);

  // 监听 WebSocket 流式事件
  useEffect(() => {
    const unsub1 = wsManager.on('stream_event', (data: any) => {
      if (data.chatJid === groupJid) {
        handleStreamEvent(groupJid, data.event, data.agentId);
      }
    });
    // 通过 new_message 立即添加消息到本地状态（消除轮询延迟导致的消息"丢失"）
    const unsub2 = wsManager.on('new_message', (data: any) => {
      if (data.chatJid === groupJid && data.message) {
        handleWsNewMessage(groupJid, data.message, data.agentId, data.source);
      }
    });
    // WebSocket 消息校验失败时通知用户
    const unsub3 = wsManager.on('ws_error', (data: any) => {
      if (!data.chatJid || data.chatJid === groupJid) {
        showToast('发送失败', data.error || '消息格式无效', 4000);
      }
    });
    // 后端推送的流式快照（WS 重连时恢复）
    const agentSnapshotPrefix = groupJid + '#agent:';
    const unsub4 = wsManager.on('stream_snapshot', (data: any) => {
      if (!data.snapshot) return;
      if (data.chatJid === groupJid) {
        handleStreamSnapshot(groupJid, data.snapshot);
      } else if (typeof data.chatJid === 'string' && data.chatJid.startsWith(agentSnapshotPrefix)) {
        // Agent-specific snapshot: extract agentId and restore agentStreaming
        const snapshotAgentId = data.chatJid.slice(agentSnapshotPrefix.length);
        handleStreamSnapshot(groupJid, data.snapshot, snapshotAgentId);
      }
    });
    // agent_status 已提升到 AppLayout 全局监听
    return () => { unsub1(); unsub2(); unsub3(); unsub4(); };
  }, [groupJid, handleStreamEvent, handleWsNewMessage, handleStreamSnapshot]);

  const [scrollTrigger, setScrollTrigger] = useState(0);

  const handleSend = async (content: string, attachments?: Array<{ data: string; mimeType: string }>) => {
    await sendMessage(groupJid, content, attachments);
    setScrollTrigger(n => n + 1);
  };

  const handleLoadMore = () => {
    if (hasMoreMessages && !loading) {
      loadMessages(groupJid, true);
    }
  };

  const handleResetSession = async () => {
    setResetLoading(true);
    await resetSession(groupJid, resetAgentId ?? undefined);
    setResetLoading(false);
    setShowResetConfirm(false);
    setResetAgentId(null);
  };

  // --- Drag resize handlers (mouse + touch) ---
  const startDrag = useCallback((startY: number) => {
    isDraggingRef.current = true;
    dragStartYRef.current = startY;
    dragStartHeightRef.current = terminalHeight;

    const calcHeight = (currentY: number) => {
      const delta = dragStartYRef.current - currentY;
      const maxHeight = containerRef.current
        ? containerRef.current.clientHeight * TERMINAL_MAX_RATIO
        : 600;
      return Math.min(maxHeight, Math.max(TERMINAL_MIN_HEIGHT, dragStartHeightRef.current + delta));
    };

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingRef.current) return;
      setTerminalHeight(calcHeight(e.clientY));
    };
    const handleTouchMove = (e: TouchEvent) => {
      if (!isDraggingRef.current) return;
      setTerminalHeight(calcHeight(e.touches[0].clientY));
    };

    const cleanup = () => {
      isDraggingRef.current = false;
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', cleanup);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', cleanup);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', cleanup);
    document.addEventListener('touchmove', handleTouchMove, { passive: true });
    document.addEventListener('touchend', cleanup);
    document.body.style.cursor = 'row-resize';
    document.body.style.userSelect = 'none';
  }, [terminalHeight]);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    startDrag(e.clientY);
  }, [startDrag]);

  const handleTouchDragStart = useCallback((e: React.TouchEvent) => {
    startDrag(e.touches[0].clientY);
  }, [startDrag]);

  // Toggle terminal: desktop = bottom panel, mobile = modal
  const handleTerminalToggle = useCallback(() => {
    if (!canUseTerminal) return;
    // Use matchMedia to detect desktop vs mobile
    if (window.matchMedia('(min-width: 1024px)').matches) {
      if (!terminalMounted) {
        setTerminalMounted(true);
        setTerminalVisible(true);
      } else {
        setTerminalVisible(prev => !prev);
      }
    } else {
      setMobileTerminal(true);
    }
  }, [canUseTerminal, terminalMounted]);

  // Switching groups should not carry terminal UI/session into the next page.
  useEffect(() => {
    setTerminalVisible(false);
    setTerminalMounted(false);
    setMobileTerminal(false);
  }, [groupJid]);

  // If current group is host mode, force-close any mounted terminal.
  useEffect(() => {
    if (canUseTerminal) return;
    setTerminalVisible(false);
    setTerminalMounted(false);
    setMobileTerminal(false);
  }, [canUseTerminal]);

  const openMobileFiles = () => {
    setMobileActionsOpen(false);
    setMobilePanel('files');
  };

  const openMobileEnv = () => {
    setMobileActionsOpen(false);
    setMobilePanel('env');
  };

  const handleBackAction = () => {
    if (isTopicWorkspace && !isDesktop && activeAgentTab) {
      setActiveAgentTab(groupJid, null);
      return;
    }
    onBack?.();
  };
  const showTopicListOnlyMobile = isTopicWorkspace && !isDesktop && !activeAgentTab;

  if (!group) {
    return (
      <div className="h-full flex items-center justify-center bg-background">
        <div className="text-center">
          <p className="text-muted-foreground">群组不存在</p>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="h-full flex flex-col bg-surface dark:bg-background max-lg:rounded-none lg:rounded-t-2xl lg:rounded-b-none lg:mr-5 lg:ml-3 lg:overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-6 py-4 max-lg:px-4 max-lg:py-2.5 max-lg:bg-background/60 max-lg:backdrop-blur-xl max-lg:saturate-[1.8] max-lg:border-border/40">
        {onBack && (
          <button
            onClick={handleBackAction}
            className="lg:hidden p-2 -ml-2 hover:bg-muted rounded-lg transition-colors cursor-pointer"
            aria-label="返回"
          >
            <ArrowLeft className="w-5 h-5 text-foreground/70" />
          </button>
        )}
        {headerLeft}
        <div className="flex-1 min-w-0">
          <h2 className="font-semibold text-foreground text-[15px] truncate">{group.name}</h2>
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>{isWaiting ? '正在思考...' : group.is_home ? '主 Agent' : 'Agent'}</span>
            {!isWaiting && group.is_shared && (
              <>
                <span className="text-muted-foreground/40">·</span>
                <span className="inline-flex items-center gap-0.5">
                  <Users className="w-3 h-3" />
                  {group.member_count ?? 0} 人协作
                </span>
              </>
            )}
            {!isWaiting && group.execution_mode && (
              <>
                <span className="text-muted-foreground/40">·</span>
                <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-[10px] font-medium border ${group.execution_mode === 'host' ? 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800' : 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/30 dark:text-sky-300 dark:border-sky-800'}`}>
                  {group.execution_mode === 'host' ? '宿主机' : 'Docker'}
                </span>
              </>
            )}
            {isOwnHome && imStatus && Object.entries(imStatus).some(([, v]) => v) && (
              <>
                <span className="text-muted-foreground/40">·</span>
                {Object.entries(imStatus)
                  .filter(([, connected]) => connected)
                  .map(([channel]) => (
                    <span key={channel} className="inline-flex items-center gap-0.5">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                      {CHANNEL_LABEL[channel] ?? channel}
                    </span>
                  ))}
              </>
            )}
          </div>
        </div>
        {/* Desktop: toggle theme (light → dark → system) */}
        <button
          onClick={toggleTheme}
          className="hidden lg:flex p-2 rounded-lg hover:bg-accent text-muted-foreground transition-colors cursor-pointer"
          title={theme === 'light' ? '切换到暗色模式' : theme === 'dark' ? '跟随系统' : '切换到亮色模式'}
          aria-label={theme === 'light' ? '切换到暗色模式' : theme === 'dark' ? '跟随系统' : '切换到亮色模式'}
        >
          {theme === 'light' ? <Moon className="w-5 h-5" /> : theme === 'dark' ? <Monitor className="w-5 h-5" /> : <Sun className="w-5 h-5" />}
        </button>
        {/* Desktop: toggle display mode */}
        <button
          onClick={toggleDisplayMode}
          className="hidden lg:flex p-2 rounded-lg hover:bg-accent text-muted-foreground transition-colors cursor-pointer"
          title={displayMode === 'chat' ? '紧凑模式' : '对话模式'}
          aria-label={displayMode === 'chat' ? '切换到紧凑模式' : '切换到对话模式'}
        >
          {displayMode === 'chat' ? <Terminal className="w-5 h-5" /> : <MessageSquare className="w-5 h-5" />}
        </button>
        {/* Desktop: toggle side panel */}
        <button
          onClick={() => setPanelOpen((v) => !v)}
          className="hidden lg:flex p-2 rounded-lg hover:bg-accent text-muted-foreground transition-colors cursor-pointer"
          title={panelOpen ? '收起面板' : '展开面板'}
          aria-label={panelOpen ? '收起面板' : '展开面板'}
        >
          {panelOpen ? <PanelRightClose className="w-5 h-5" /> : <PanelRightOpen className="w-5 h-5" />}
        </button>
        {/* Mobile only: condensed actions */}
        <div className="lg:hidden">
          <button
            onClick={() => setMobileActionsOpen(true)}
            className="p-2 rounded-lg hover:bg-accent text-muted-foreground transition-colors cursor-pointer"
            title="更多操作"
            aria-label="更多操作"
          >
            <MoreHorizontal className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* IM channel setup banner for home container without IM */}
      {isOwnHome && imStatus && !Object.values(imStatus).some(Boolean) && !imBannerDismissed && (
        <div className="flex items-center gap-2 px-4 py-2 bg-amber-50 dark:bg-amber-950/40 border-b border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300 text-sm">
          <Link className="w-4 h-4 flex-shrink-0" />
          <span className="flex-1 min-w-0">未配置 IM 渠道（飞书 / Telegram / Discord / QQ / 微信 / 钉钉），消息无法与主工作区互通</span>
          <button
            onClick={() => navigate('/setup/channels')}
            className="flex-shrink-0 px-3 py-1 text-xs font-medium rounded-md bg-amber-600 text-white hover:bg-amber-700 transition-colors cursor-pointer"
          >
            去配置
          </button>
          <button
            onClick={() => {
              setImBannerDismissed(true);
              localStorage.setItem('im-banner-dismissed', '1');
            }}
            className="flex-shrink-0 p-0.5 rounded hover:bg-amber-200/60 transition-colors cursor-pointer"
            aria-label="关闭"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}

      {!isTopicWorkspace && (
        <AgentTabBar
          agents={agents}
          activeTab={activeAgentTab}
          onSelectTab={(id) => setActiveAgentTab(groupJid, id)}
          onDeleteAgent={(id) => {
            const agent = agents.find((a) => a.id === id);
            if (agent?.linked_im_groups && agent.linked_im_groups.length > 0) {
              const names = agent.linked_im_groups.map((g) => g.name).join('、');
              alert(`该对话已绑定 IM 渠道（${names}），请先解绑后再删除。`);
              setBindingAgentId(id);
              return;
            }
            deleteAgentAction(groupJid, id);
          }}
          onRenameAgent={(id, currentName) => setRenameTarget({ agentId: id, name: currentName })}
          onCreateConversation={() => setShowNewConversation(true)}
          onBindIm={setBindingAgentId}
          onBindMainIm={!isHome ? () => setBindingAgentId(MAIN_BINDING) : undefined}
          onReorder={(orderedIds) => reorderConversations(groupJid, orderedIds)}
        />
      )}

      {/* Main Content: Messages + Sidebar */}
      <div className="flex-1 flex overflow-hidden min-h-0">
        {/* Messages Area */}
        <div className="flex-1 flex flex-col min-w-0 overflow-x-hidden">
          {isTopicWorkspace ? (
            <div className="flex flex-1 min-h-0">
              <div className={cn(
                'border-r border-border bg-muted/20 lg:w-80 lg:flex lg:flex-col',
                showTopicListOnlyMobile ? 'flex flex-1 flex-col' : 'hidden',
              )}>
                <TopicSidebar
                  topicAgents={filteredTopicAgents}
                  activeAgentTab={activeAgentTab}
                  onSelectAgent={(id) => setActiveAgentTab(groupJid, id)}
                  onDeleteAgent={(id) => deleteAgentAction(groupJid, id)}
                  topicFilter={topicFilter}
                  onFilterChange={setTopicFilter}
                  emptyCount={topicAgents.length}
                />
              </div>

              <div className={cn('flex-1 min-w-0 flex-col', showTopicListOnlyMobile ? 'hidden' : 'flex')}>
                {activeAgentTab && isConversationTab ? (
                  <>
                    {!isDesktop && (
                      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
                        <button
                          onClick={() => setActiveAgentTab(groupJid, null)}
                          className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted cursor-pointer"
                          aria-label="返回话题列表"
                        >
                          <ArrowLeft className="h-4 w-4" />
                        </button>
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium text-foreground">{activeAgent?.name}</div>
                          <div className="text-xs text-muted-foreground">飞书话题上下文</div>
                        </div>
                      </div>
                    )}
                    <MessageList
                      key={`conv-${activeAgentTab}`}
                      messages={agentMessages[activeAgentTab] || []}
                      loading={false}
                      hasMore={!!agentHasMore[activeAgentTab]}
                      onLoadMore={() => loadAgentMessages(groupJid, activeAgentTab, true)}
                      scrollTrigger={scrollTrigger}
                      groupJid={groupJid}
                      isWaiting={!!agentWaiting[activeAgentTab] || !!agentStreaming[activeAgentTab]}
                      onInterrupt={agentStreaming[activeAgentTab]?.interrupted ? undefined : () => interruptQuery(`${groupJid}#agent:${activeAgentTab}`)}
                      agentId={activeAgentTab}
                    />
                    <MessageInput
                      onSend={async (content, attachments) => {
                        sendAgentMessage(groupJid, activeAgentTab, content, attachments);
                        setScrollTrigger(n => n + 1);
                      }}
                      groupJid={groupJid}
                      onResetSession={() => { setResetAgentId(activeAgentTab); setShowResetConfirm(true); }}
                    />
                  </>
                ) : (
                  <div className="flex flex-1 items-center justify-center bg-background px-6 text-center">
                    <div>
                      <div className="text-sm font-medium text-foreground">选择一个飞书话题</div>
                      <div className="mt-2 text-sm text-muted-foreground">
                        左侧列表按最近活跃排序，进入后可继续在对应飞书话题里同步对话。
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          ) : activeAgentTab && isConversationTab ? (
            <>
              <MessageList
                key={`conv-${activeAgentTab}`}
                messages={agentMessages[activeAgentTab] || []}
                loading={false}
                hasMore={!!agentHasMore[activeAgentTab]}
                onLoadMore={() => loadAgentMessages(groupJid, activeAgentTab, true)}
                scrollTrigger={scrollTrigger}
                groupJid={groupJid}
                isWaiting={!!agentWaiting[activeAgentTab] || !!agentStreaming[activeAgentTab]}
                onInterrupt={agentStreaming[activeAgentTab]?.interrupted ? undefined : () => interruptQuery(`${groupJid}#agent:${activeAgentTab}`)}
                agentId={activeAgentTab}
              />
              <MessageInput
                onSend={async (content, attachments) => {
                  sendAgentMessage(groupJid, activeAgentTab, content, attachments);
                  setScrollTrigger(n => n + 1);
                }}
                groupJid={groupJid}
                onResetSession={() => { setResetAgentId(activeAgentTab); setShowResetConfirm(true); }}
              />
            </>
          ) : (
            <>
              <MessageList
                key={`main-${groupJid}`}
                messages={groupMessages || []}
                loading={loading}
                hasMore={hasMoreMessages}
                onLoadMore={handleLoadMore}
                scrollTrigger={scrollTrigger}
                groupJid={groupJid}
                isWaiting={isWaiting}
                onInterrupt={mainInterrupted ? undefined : () => interruptQuery(groupJid)}
                onSend={(content) => handleSend(content)}
              />
              <MessageInput
                onSend={handleSend}
                groupJid={groupJid}
                onResetSession={() => { setResetAgentId(null); setShowResetConfirm(true); }}
                onToggleTerminal={canUseTerminal ? handleTerminalToggle : undefined}
              />
            </>
          )}
        </div>

        {/* Desktop: sidebar with icon tabs (collapsible) */}
        <div className={cn(
          "hidden lg:flex lg:flex-col flex-shrink-0 border-l border-border bg-surface dark:bg-background transition-[width] duration-200",
          panelOpen ? "w-80" : "w-0 overflow-hidden border-l-0"
        )}>
          {/* Icon tab bar */}
          <TooltipProvider delayDuration={300}>
            <div className="flex border-b border-border">
              {visibleTabs.map(tab => {
                const Icon = tab.icon;
                const active = sidebarTab === tab.id;
                return (
                  <Tooltip key={tab.id}>
                    <TooltipTrigger asChild>
                      <button
                        onClick={() => setSidebarTab(tab.id)}
                        className={cn(
                          "flex-1 flex items-center justify-center py-2.5 transition-colors cursor-pointer",
                          active
                            ? "text-primary border-b-2 border-primary"
                            : "text-muted-foreground hover:text-foreground"
                        )}
                      >
                        <Icon className="w-4 h-4" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="bottom" className="text-xs">
                      {tab.label}
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </div>
          </TooltipProvider>

          {/* Tab content */}
          <div className="flex-1 overflow-hidden min-h-0">
            {sidebarTab === 'files' ? (
              <FilePanel groupJid={groupJid} />
            ) : sidebarTab === 'env' ? (
              <ContainerEnvPanel groupJid={groupJid} />
            ) : sidebarTab === 'skills' ? (
              <WorkspaceSkillsPanel groupJid={groupJid} />
            ) : sidebarTab === 'mcp' ? (
              <WorkspaceMcpPanel groupJid={groupJid} />
            ) : (
              <GroupMembersPanel groupJid={groupJid} />
            )}
          </div>
        </div>
      </div>

      {/* Desktop: Bottom terminal panel with drag handle */}
      {canUseTerminal && terminalMounted && (
        <>
          {/* Drag handle */}
          {terminalVisible && (
            <div
              onMouseDown={handleDragStart}
              onTouchStart={handleTouchDragStart}
              className="hidden lg:flex h-1 bg-muted hover:bg-brand-400 cursor-row-resize items-center justify-center transition-colors group"
            >
              <div className="w-8 h-0.5 rounded-full bg-muted-foreground group-hover:bg-primary transition-colors" />
            </div>
          )}
          {/* Terminal panel */}
          <div
            className={`hidden lg:block flex-shrink-0 overflow-hidden transition-[height] duration-200 ${
              terminalVisible ? 'border-t border-border' : 'border-t-0'
            }`}
            style={{ height: terminalVisible ? terminalHeight : 0 }}
          >
            <TerminalPanel
              groupJid={groupJid}
              visible={terminalVisible}
              onHide={() => setTerminalVisible(false)}
              onDelete={() => {
                setTerminalVisible(false);
                setTerminalMounted(false);
              }}
            />
          </div>
        </>
      )}

      {/* Mobile: file panel sheet */}
      <Sheet open={mobilePanel === 'files'} onOpenChange={(v) => !v && setMobilePanel(null)}>
        <SheetContent side="bottom" className="h-[80dvh] p-0">
          <SheetHeader className="px-4 pt-4 pb-2">
            <SheetTitle>工作区文件管理</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-hidden h-[calc(80dvh-56px)]">
            <FilePanel
              groupJid={groupJid}
              onClose={() => setMobilePanel(null)}
            />
          </div>
        </SheetContent>
      </Sheet>

      {/* Mobile: env config sheet */}
      <Sheet open={mobilePanel === 'env'} onOpenChange={(v) => !v && setMobilePanel(null)}>
        <SheetContent side="bottom" className="h-[80dvh] p-0">
          <SheetHeader className="px-4 pt-4 pb-2">
            <SheetTitle>工作区环境变量</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-hidden h-[calc(80dvh-56px)]">
            <ContainerEnvPanel
              groupJid={groupJid}
              onClose={() => setMobilePanel(null)}
            />
          </div>
        </SheetContent>
      </Sheet>

      {/* Mobile: skills sheet */}
      <Sheet open={mobilePanel === 'skills'} onOpenChange={(v) => !v && setMobilePanel(null)}>
        <SheetContent side="bottom" className="h-[80dvh] p-0">
          <SheetHeader className="px-4 pt-4 pb-2">
            <SheetTitle>工作区 Skills</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-hidden h-[calc(80dvh-56px)]">
            <WorkspaceSkillsPanel
              groupJid={groupJid}
              onClose={() => setMobilePanel(null)}
            />
          </div>
        </SheetContent>
      </Sheet>

      {/* Mobile: MCP sheet */}
      <Sheet open={mobilePanel === 'mcp'} onOpenChange={(v) => !v && setMobilePanel(null)}>
        <SheetContent side="bottom" className="h-[80dvh] p-0">
          <SheetHeader className="px-4 pt-4 pb-2">
            <SheetTitle>工作区 MCP Servers</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-hidden h-[calc(80dvh-56px)]">
            <WorkspaceMcpPanel
              groupJid={groupJid}
              onClose={() => setMobilePanel(null)}
            />
          </div>
        </SheetContent>
      </Sheet>

      {/* Mobile: members sheet */}
      <Sheet open={mobilePanel === 'members'} onOpenChange={(v) => !v && setMobilePanel(null)}>
        <SheetContent side="bottom" className="h-[80dvh] p-0">
          <SheetHeader className="px-4 pt-4 pb-2">
            <SheetTitle>成员管理</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-hidden h-[calc(80dvh-56px)]">
            <GroupMembersPanel groupJid={groupJid} />
          </div>
        </SheetContent>
      </Sheet>

      {/* Mobile: Terminal sheet */}
      <Sheet open={mobileTerminal} onOpenChange={(v) => !v && setMobileTerminal(false)}>
        <SheetContent side="bottom" className="h-[85dvh] p-0">
          <SheetHeader className="px-4 pt-4 pb-2">
            <SheetTitle>终端</SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-hidden h-[calc(85dvh-56px)]">
            <TerminalPanel
              groupJid={groupJid}
              visible
              onHide={() => setMobileTerminal(false)}
              onDelete={() => setMobileTerminal(false)}
            />
          </div>
        </SheetContent>
      </Sheet>

      {/* Mobile: Action Sheet */}
      <Sheet open={mobileActionsOpen} onOpenChange={(v) => !v && setMobileActionsOpen(false)}>
        <SheetContent side="bottom" className="pb-[env(safe-area-inset-bottom)]">
          <SheetHeader>
            <SheetTitle>工作区操作</SheetTitle>
          </SheetHeader>
          <div className="space-y-2 pt-2">
            <button
              onClick={openMobileFiles}
              className="w-full text-left px-4 py-3 rounded-lg border border-border hover:bg-accent transition-colors cursor-pointer text-foreground text-sm"
            >
              工作区文件
            </button>
            <button
              onClick={openMobileEnv}
              className="w-full text-left px-4 py-3 rounded-lg border border-border hover:bg-accent transition-colors cursor-pointer text-foreground text-sm"
            >
              环境变量
            </button>
            <button
              onClick={() => { setMobileActionsOpen(false); setMobilePanel('skills'); }}
              className="w-full text-left px-4 py-3 rounded-lg border border-border hover:bg-accent transition-colors cursor-pointer text-foreground text-sm"
            >
              工作区 Skills
            </button>
            <button
              onClick={() => { setMobileActionsOpen(false); setMobilePanel('mcp'); }}
              className="w-full text-left px-4 py-3 rounded-lg border border-border hover:bg-accent transition-colors cursor-pointer text-foreground text-sm"
            >
              工作区 MCP
            </button>
            {showMembersTab && (
              <button
                onClick={() => { setMobileActionsOpen(false); setMobilePanel('members'); }}
                className="w-full text-left px-4 py-3 rounded-lg border border-border hover:bg-accent transition-colors cursor-pointer text-foreground text-sm"
              >
                成员管理
              </button>
            )}
            {canUseTerminal && (
              <button
                onClick={() => {
                  setMobileActionsOpen(false);
                  setMobileTerminal(true);
                }}
                className="w-full text-left px-4 py-3 rounded-lg border border-border hover:bg-accent transition-colors cursor-pointer text-foreground text-sm"
              >
                终端
              </button>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* Reset session confirm dialog */}
      <ConfirmDialog
        open={showResetConfirm}
        onClose={() => setShowResetConfirm(false)}
        onConfirm={handleResetSession}
        title="清除上下文"
        message={resetAgentId
          ? '将清除该子对话的 Claude 会话上下文，下次发送消息时将开始全新会话。聊天记录不受影响。'
          : '将清除 Claude 会话上下文并停止运行中的工作区进程，下次发送消息时将开始全新会话。聊天记录不受影响。'
        }
        confirmText="清除"
        confirmVariant="danger"
        loading={resetLoading}
      />

      {/* IM binding dialog */}
      {bindingAgentId && (
        <ImBindingDialog
          open={!!bindingAgentId}
          groupJid={groupJid}
          agentId={bindingAgentId === MAIN_BINDING ? null : bindingAgentId}
          agent={bindingAgentId !== MAIN_BINDING ? agents.find((a) => a.id === bindingAgentId) : undefined}
          onClose={() => setBindingAgentId(null)}
        />
      )}

      <PromptDialog
        open={showNewConversation}
        title="新建对话"
        label="对话名称"
        placeholder="输入对话名称"
        onConfirm={(name) => {
          createConversation(groupJid, name).then((agent) => {
            if (agent) setActiveAgentTab(groupJid, agent.id);
          });
        }}
        onClose={() => setShowNewConversation(false)}
      />

      <PromptDialog
        open={renameTarget !== null}
        title="重命名对话"
        label="对话名称"
        placeholder="输入新名称"
        defaultValue={renameTarget?.name ?? ''}
        onConfirm={(name) => {
          if (renameTarget) renameConversation(groupJid, renameTarget.agentId, name);
        }}
        onClose={() => setRenameTarget(null)}
      />
    </div>
  );
}
