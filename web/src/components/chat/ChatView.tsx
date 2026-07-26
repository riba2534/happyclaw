import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  useChatStore,
  type FollowUpMode,
  type QueuedFollowUp,
} from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';
import { MessageList } from './MessageList';
import { MessageInput } from './MessageInput';
import { FilePanel } from './FilePanel';
import { ContainerEnvPanel } from './ContainerEnvPanel';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { PromptDialog } from '@/components/common/PromptDialog';
import {
  ArrowLeft,
  ChevronRight,
  Folder,
  Link,
  Monitor,
  Moon,
  PanelRightClose,
  PanelRightOpen,
  Server,
  Settings2,
  SlidersHorizontal,
  Sun,
  Terminal,
  X,
} from 'lucide-react';
import { useDisplayMode } from '../../hooks/useDisplayMode';
import { useTheme } from '../../hooks/useTheme';
import { cn } from '@/lib/utils';
import { wsManager } from '../../api/ws';
import { api } from '../../api/client';
import { TerminalPanel } from './TerminalPanel';
import { ImBindingDialog } from './ImBindingDialog';
import { SessionSidebar } from './SessionSidebar';
import { showToast } from '../../utils/toast';
import {
  getWorkspaceLastAgent,
  setWorkspaceLastAgent,
} from '../../utils/workspaceLastAgent';
import { CHANNEL_LABEL } from '../settings/channel-meta';
import { getAgentProfileDisplayName } from '../../utils/agent-product';
import { normalizeInteractionMode } from '../../lib/interaction-mode';
import { WorkspaceInteractionModeDialog } from './WorkspaceInteractionModeDialog';

/** Sentinel value for binding the main conversation (vs. a specific agent) */
const MAIN_BINDING = '__main__' as const;
const WORKSPACE_BINDING = '__workspace__' as const;

const POLL_INTERVAL_MS = 2000;
const TERMINAL_MIN_HEIGHT = 150;
const TERMINAL_DEFAULT_HEIGHT = 300;
const TERMINAL_MAX_RATIO = 0.7;

// Stable empty references to avoid infinite re-render loops in Zustand selectors
const EMPTY_AGENTS: import('../../types').AgentInfo[] = [];
const EMPTY_FOLLOW_UPS: QueuedFollowUp[] = [];

interface ChatViewProps {
  groupJid: string;
  onBack?: () => void;
  headerLeft?: React.ReactNode;
}

export function ChatView({ groupJid, onBack, headerLeft }: ChatViewProps) {
  const { mode: displayMode, toggle: toggleDisplayMode } = useDisplayMode();
  const { theme, toggle: toggleTheme } = useTheme();
  const [panelOpen, setPanelOpen] = useState(false);
  const [mobileContextOpen, setMobileContextOpen] = useState(false);
  const [contextPanelView, setContextPanelView] = useState<'files' | 'env'>(
    'files',
  );
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showInteractionModeDialog, setShowInteractionModeDialog] =
    useState(false);
  const [resetLoading, setResetLoading] = useState(false);
  const [creatingSession, setCreatingSession] = useState(false);
  const [resetAgentId, setResetAgentId] = useState<string | null>(null);
  // Desktop: visible controls panel height, mounted controls terminal lifecycle.
  const [terminalVisible, setTerminalVisible] = useState(false);
  const [terminalMounted, setTerminalMounted] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(TERMINAL_DEFAULT_HEIGHT);
  const [mobileTerminal, setMobileTerminal] = useState(false);
  // null = dialog closed; MAIN_BINDING = main conversation; other = agent id
  const [bindingAgentId, setBindingAgentId] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<{
    agentId: string;
    name: string;
  } | null>(null);
  const [imStatus, setImStatus] = useState<Record<string, boolean> | null>(
    null,
  );
  const [imBannerDismissed, setImBannerDismissed] = useState(
    () => localStorage.getItem('im-banner-dismissed') === '1',
  );
  const navigate = useNavigate();

  // Drag state refs (not reactive — only used in event handlers)
  const containerRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const dragStartYRef = useRef(0);
  const dragStartHeightRef = useRef(0);

  // Individual selectors: avoid re-renders from unrelated store changes (e.g. streaming)
  const group = useChatStore((s) => s.groups[groupJid]);
  const groupMessages = useChatStore((s) => s.messages[groupJid]);
  const isWaiting = useChatStore((s) => !!s.waiting[groupJid]);
  const mainInterrupted = useChatStore(
    (s) => !!s.streaming[groupJid]?.interrupted,
  );
  const hasMoreMessages = useChatStore((s) => !!s.hasMore[groupJid]);
  const loading = useChatStore((s) => s.loading);
  const loadMessages = useChatStore((s) => s.loadMessages);
  const refreshMessages = useChatStore((s) => s.refreshMessages);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const interruptQuery = useChatStore((s) => s.interruptQuery);
  const resetSession = useChatStore((s) => s.resetSession);
  const handleStreamEvent = useChatStore((s) => s.handleStreamEvent);
  const handleWsNewMessage = useChatStore((s) => s.handleWsNewMessage);
  const handleStreamSnapshot = useChatStore((s) => s.handleStreamSnapshot);
  const updateInteractionMode = useChatStore((s) => s.updateInteractionMode);

  const agents = useChatStore((s) => s.agents[groupJid] ?? EMPTY_AGENTS);
  const activeAgentTab = useChatStore(
    (s) => s.activeAgentTab[groupJid] ?? null,
  );
  const setActiveAgentTab = useChatStore((s) => s.setActiveAgentTab);
  const followUpChatJid = activeAgentTab
    ? `${groupJid}#agent:${activeAgentTab}`
    : groupJid;
  const queuedFollowUps = useChatStore(
    (s) => s.followUps[followUpChatJid] ?? EMPTY_FOLLOW_UPS,
  );
  const loadFollowUps = useChatStore((s) => s.loadFollowUps);
  const handleFollowUpUpdate = useChatStore((s) => s.handleFollowUpUpdate);
  const actOnFollowUp = useChatStore((s) => s.actOnFollowUp);

  // URL `?agent=` is the source of truth for the active sub-conversation tab.
  // Refresh, browser back/forward, route restore, and direct deep-links all
  // converge here. `selectTab` updates the URL only; an effect below mirrors
  // the URL value into the store for consumers that read it directly.
  const [searchParams, setSearchParams] = useSearchParams();
  const urlAgentId = searchParams.get('agent') || null;
  const mobileSessionsVisible = searchParams.get('sessions') === '1';
  const selectTab = useCallback(
    (id: string | null) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete('sessions');
          if (id) next.set('agent', id);
          else next.delete('agent');
          return next;
        },
        { replace: true },
      );
      setWorkspaceLastAgent(groupJid, id);
    },
    [groupJid, setSearchParams],
  );
  const loadAgents = useChatStore((s) => s.loadAgents);
  const deleteAgentAction = useChatStore((s) => s.deleteAgentAction);
  const agentStreaming = useChatStore((s) => s.agentStreaming);
  const createConversation = useChatStore((s) => s.createConversation);
  const renameConversation = useChatStore((s) => s.renameConversation);
  const loadAgentMessages = useChatStore((s) => s.loadAgentMessages);
  const hydrateAgentMessages = useChatStore((s) => s.hydrateAgentMessages);
  const refreshAgentMessages = useChatStore((s) => s.refreshAgentMessages);
  const sendAgentMessage = useChatStore((s) => s.sendAgentMessage);
  const agentMessages = useChatStore((s) => s.agentMessages);
  const agentWaiting = useChatStore((s) => s.agentWaiting);
  const agentHasMore = useChatStore((s) => s.agentHasMore);

  const markChatRead = useChatStore((s) => s.markChatRead);

  const currentUser = useAuthStore((s) => s.user);
  const canUseTerminal = group?.execution_mode !== 'host';
  const pollRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const isHome = !!group?.is_home;
  // Workspace config (skills + MCP) write permission. Backend `canModifyGroup`
  // ACL result is propagated via the `can_modify` field; trust it as the
  // single source of truth to avoid frontend/backend divergence.
  const canModifyWorkspaceConfig = !!group?.can_modify;
  const interactionMode = normalizeInteractionMode(group?.interaction_mode);

  useEffect(() => {
    if (!canModifyWorkspaceConfig && contextPanelView === 'env') {
      setContextPanelView('files');
    }
  }, [canModifyWorkspaceConfig, contextPanelView]);

  // Fetch IM connection status for home groups
  const isOwnHome =
    isHome &&
    ((!!group?.created_by && group.created_by === currentUser?.id) ||
      (currentUser?.role === 'admin' && group?.folder === 'main'));
  useEffect(() => {
    if (!isOwnHome) {
      setImStatus(null);
      return;
    }
    let active = true;
    const fetchStatus = () => {
      api
        .get<Record<string, boolean>>('/api/config/user-im/status')
        .then((data) => {
          if (active) setImStatus(data);
        })
        .catch(() => {});
    };
    fetchStatus();
    const timer = setInterval(fetchStatus, 30_000); // refresh every 30s
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [isOwnHome]);

  // 未读目前按 Workspace 聚合：进入主会话或切换到任一 Agent 会话，
  // 都表示用户已经查看当前 Workspace。
  useEffect(() => {
    markChatRead(groupJid);
    const onFocus = () => markChatRead(groupJid);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [activeAgentTab, groupJid, markChatRead]);

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
      } catch {
        /* handled in store */
      }
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
  const restoreActiveState = useChatStore((s) => s.restoreActiveState);
  useEffect(() => {
    restoreActiveState();
    const unsub = wsManager.on('connected', () => {
      restoreActiveState();
      // Reconcile agent list with backend truth — picks up any agent_status
      // events that were missed during WS disconnection.  Force-refresh
      // bypasses the per-group memoize so reconnect always hits the API.
      loadAgents(groupJid, { force: true });
      // Refresh conversation agent messages that may have been missed during WS disconnection
      const state = useChatStore.getState();
      const currentTab = state.activeAgentTab[groupJid];
      if (currentTab) {
        const agentInfo = (state.agents[groupJid] || []).find(
          (a) => a.id === currentTab,
        );
        if (agentInfo?.kind === 'conversation') {
          refreshAgentMessages(groupJid, currentTab);
        }
      }
    });
    return () => {
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupJid]);

  // Derived: active agent info and kind
  const activeAgent = activeAgentTab
    ? agents.find((a) => a.id === activeAgentTab)
    : null;
  const isConversationTab = activeAgent?.kind === 'conversation';
  const isTopicWorkspace =
    group?.conversation_nav_mode === 'vertical_threads' ||
    group?.conversation_source === 'native_thread' ||
    group?.conversation_source === 'feishu_thread' ||
    agents.some(
      (a) =>
        a.source_kind === 'native_thread' || a.source_kind === 'feishu_thread',
    );
  const conversationAgents = useMemo(
    () =>
      agents
        .filter((a) => a.kind === 'conversation')
        .map((agent) => {
          const queryActive =
            !!agentWaiting[agent.id] || !!agentStreaming[agent.id];
          return agent.status === 'running' && !queryActive
            ? { ...agent, status: 'idle' as const }
            : agent;
        })
        .slice()
        .sort((a, b) => {
          const aTs =
            a.last_active_at || a.latest_message?.timestamp || a.created_at;
          const bTs =
            b.last_active_at || b.latest_message?.timestamp || b.created_at;
          return new Date(bTs).getTime() - new Date(aTs).getTime();
        }),
    [agents, agentStreaming, agentWaiting],
  );
  const mainConversationLabel = group?.is_my_home ? '直接对话' : '当前对话';
  const currentContextName =
    activeAgentTab && isConversationTab && activeAgent
      ? activeAgent.name
      : mainConversationLabel;
  const currentContextWaiting =
    activeAgentTab && isConversationTab
      ? !!agentWaiting[activeAgentTab] || !!agentStreaming[activeAgentTab]
      : isWaiting;
  const agentProfileLabel = group?.agent_profile_name
    ? getAgentProfileDisplayName(group.agent_profile_name)
    : group?.is_home
      ? 'HappyClaw'
      : 'Agent';
  const workspaceDisplayName = group?.is_my_home
    ? agentProfileLabel
    : group?.name;
  const contextSummary = group?.is_my_home ? '直接对话' : agentProfileLabel;
  // SDK Tasks 不再创建独立标签页，事件直接显示在主对话流式卡片中

  // Load sub-agents for this group
  useEffect(() => {
    loadAgents(groupJid);
  }, [groupJid, loadAgents]);

  // Mirror URL → store so consumers reading activeAgentTab stay in sync.
  useEffect(() => {
    setActiveAgentTab(groupJid, urlAgentId);
  }, [urlAgentId, groupJid, setActiveAgentTab]);

  // If URL points to an agent that no longer exists in this workspace
  // (e.g., deleted while we were on it, or stale deep link), strip the param
  // and clear the workspace memory so we don't try to restore it again.
  useEffect(() => {
    if (!urlAgentId) return;
    if (agents.length === 0) return;
    if (agents.some((a) => a.id === urlAgentId)) return;
    setWorkspaceLastAgent(groupJid, null);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('agent');
        return next;
      },
      { replace: true },
    );
  }, [urlAgentId, agents, groupJid, setSearchParams]);

  // On entering a workspace without ?agent=, restore the last sub-tab the
  // user was on in this workspace (per-workspace memory, persisted across
  // PWA restarts via localStorage). Stale entries (agent deleted) get cleaned.
  // Guarded by `params.groupFolder` so this doesn't fire when the URL is on
  // the workspace picker (mobile back) but ChatView is still mounted with
  // a stale `currentGroup`.
  const params = useParams<{ groupFolder?: string }>();
  useEffect(() => {
    if (!params.groupFolder) return;
    if (urlAgentId) return;
    if (agents.length === 0) return;
    const remembered = getWorkspaceLastAgent(groupJid);
    if (!remembered) return;
    if (!agents.some((a) => a.id === remembered)) {
      setWorkspaceLastAgent(groupJid, null);
      return;
    }
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set('agent', remembered);
        return next;
      },
      { replace: true },
    );
  }, [groupJid, urlAgentId, agents, setSearchParams, params.groupFolder]);

  // Load messages for conversation agent tabs.
  // hydrate-then-calibrate: 先把 IndexedDB 快照灌回 store（避免首屏回退），
  // 再走网络以服务端为准。不要用 useEffect cleanup 的 cancelled flag —— hydrate
  // 的 set() 会改 agentMessages 触发 effect 重跑，cleanup 会把上一轮的 cancelled
  // 置 true，导致网络校准被自己取消。改成 hydrate 完成后直接读 store 判断
  // 「用户是否仍停留在这个 conversation tab」。
  useEffect(() => {
    if (!activeAgentTab || !isConversationTab) return;
    if (agentMessages[activeAgentTab]) return;
    const agentId = activeAgentTab;
    void (async () => {
      await hydrateAgentMessages(groupJid, agentId);
      if (useChatStore.getState().activeAgentTab[groupJid] !== agentId) return;
      await loadAgentMessages(groupJid, agentId);
    })();
  }, [
    activeAgentTab,
    isConversationTab,
    groupJid,
    hydrateAgentMessages,
    loadAgentMessages,
    agentMessages,
  ]);

  // 监听 WebSocket 流式事件
  useEffect(() => {
    const unsub1 = wsManager.on('stream_event', (data: any) => {
      if (data.chatJid === groupJid) {
        handleStreamEvent(groupJid, data.event, data.agentId, data.runId);
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
        handleStreamSnapshot(groupJid, data.snapshot, undefined, data.runId);
      } else if (
        typeof data.chatJid === 'string' &&
        data.chatJid.startsWith(agentSnapshotPrefix)
      ) {
        // Agent-specific snapshot: extract agentId and restore agentStreaming
        const snapshotAgentId = data.chatJid.slice(agentSnapshotPrefix.length);
        handleStreamSnapshot(
          groupJid,
          data.snapshot,
          snapshotAgentId,
          data.runId,
        );
      }
    });
    const unsub5 = wsManager.on('follow_up_update', (data: any) => {
      if (data.chatJid !== groupJid || !Array.isArray(data.items)) return;
      const targetJid = data.agentId
        ? `${groupJid}#agent:${data.agentId}`
        : groupJid;
      handleFollowUpUpdate(targetJid, data.items, data.transition);
    });
    // agent_status 已提升到 AppLayout 全局监听
    return () => {
      unsub1();
      unsub2();
      unsub3();
      unsub4();
      unsub5();
    };
  }, [
    groupJid,
    handleStreamEvent,
    handleWsNewMessage,
    handleStreamSnapshot,
    handleFollowUpUpdate,
  ]);

  useEffect(() => {
    void loadFollowUps(followUpChatJid);
    const unsub = wsManager.on('connected', () => {
      void loadFollowUps(followUpChatJid);
    });
    return () => {
      unsub();
    };
  }, [followUpChatJid, loadFollowUps]);

  const [scrollTrigger, setScrollTrigger] = useState(0);

  const handleSend = async (
    content: string,
    attachments?: Array<{ data: string; mimeType: string }>,
    followUpBehavior?: FollowUpMode,
  ) => {
    const ok = await sendMessage(
      groupJid,
      content,
      attachments,
      followUpBehavior,
    );
    // 只有发送成功时才触发滚动；失败时保留当前视图位置，避免用户上下文切换。
    if (ok) setScrollTrigger((n) => n + 1);
    return ok;
  };

  const handleActiveAgentSend = async (
    content: string,
    attachments?: Array<{ data: string; mimeType: string }>,
    followUpBehavior?: FollowUpMode,
  ) => {
    if (!activeAgentTab) return false;
    const ok = await sendAgentMessage(
      groupJid,
      activeAgentTab,
      content,
      attachments,
      followUpBehavior,
    );
    if (ok) setScrollTrigger((value) => value + 1);
    return ok;
  };

  const handleLoadMore = () => {
    if (hasMoreMessages && !loading) {
      loadMessages(groupJid, true);
    }
  };

  const handleResetSession = async () => {
    setResetLoading(true);
    const ok = await resetSession(groupJid, resetAgentId ?? undefined);
    setResetLoading(false);
    setShowResetConfirm(false);
    setResetAgentId(null);
    if (!ok) {
      toast.error('清除上下文失败，请稍后重试');
    }
  };

  const handleCreateSession = useCallback(async () => {
    if (creatingSession) return;
    setCreatingSession(true);
    try {
      const agent = await createConversation(groupJid, '');
      if (!agent) {
        toast.error(useChatStore.getState().error || '创建 Web 会话失败');
        return;
      }
      selectTab(agent.id);
    } finally {
      setCreatingSession(false);
    }
  }, [createConversation, creatingSession, groupJid, selectTab]);

  const handleDeleteSession = useCallback(
    (id: string) => {
      const agent = agents.find((item) => item.id === id);
      if (agent?.linked_im_groups && agent.linked_im_groups.length > 0) {
        const names = agent.linked_im_groups
          .map((item) => item.name)
          .join('、');
        setBindingAgentId(id);
        toast.error('请先解绑消息渠道', {
          description: `当前绑定：${names}`,
        });
        return;
      }
      void deleteAgentAction(groupJid, id).then((ok) => {
        if (!ok) {
          toast.error(useChatStore.getState().error || '删除会话失败');
        }
      });
    },
    [agents, deleteAgentAction, groupJid],
  );

  // --- Drag resize handlers (mouse + touch) ---
  const startDrag = useCallback(
    (startY: number) => {
      isDraggingRef.current = true;
      dragStartYRef.current = startY;
      dragStartHeightRef.current = terminalHeight;

      const calcHeight = (currentY: number) => {
        const delta = dragStartYRef.current - currentY;
        const maxHeight = containerRef.current
          ? containerRef.current.clientHeight * TERMINAL_MAX_RATIO
          : 600;
        return Math.min(
          maxHeight,
          Math.max(TERMINAL_MIN_HEIGHT, dragStartHeightRef.current + delta),
        );
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
      document.addEventListener('touchmove', handleTouchMove, {
        passive: true,
      });
      document.addEventListener('touchend', cleanup);
      document.body.style.cursor = 'row-resize';
      document.body.style.userSelect = 'none';
    },
    [terminalHeight],
  );

  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      startDrag(e.clientY);
    },
    [startDrag],
  );

  const handleTouchDragStart = useCallback(
    (e: React.TouchEvent) => {
      startDrag(e.touches[0].clientY);
    },
    [startDrag],
  );

  // Toggle terminal: desktop = bottom panel, mobile = modal
  const handleTerminalToggle = useCallback(() => {
    if (!canUseTerminal) return;
    // Use matchMedia to detect desktop vs mobile
    if (window.matchMedia('(min-width: 1024px)').matches) {
      if (!terminalMounted) {
        setTerminalMounted(true);
        setTerminalVisible(true);
      } else {
        setTerminalVisible((prev) => !prev);
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

  const handleBackAction = () => {
    if (!mobileSessionsVisible) {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete('agent');
          next.set('sessions', '1');
          return next;
        },
        { replace: true },
      );
      return;
    }
    onBack?.();
  };

  const renderSessionSidebar = (mobile = false) => (
    <SessionSidebar
      key={groupJid}
      sessions={conversationAgents}
      activeSessionId={activeAgentTab}
      canModify={canModifyWorkspaceConfig}
      isTopicWorkspace={isTopicWorkspace}
      title={group.is_my_home ? '直接对话' : group.name}
      mainLabel={
        group.is_my_home ? `${agentProfileLabel} 对话` : `${group.name} 对话`
      }
      mainMeta={group.lastMessage || '暂无消息'}
      onClose={mobile ? onBack : undefined}
      onSelectSession={(id) => {
        selectTab(id);
      }}
      onCreateSession={() => void handleCreateSession()}
      isCreatingSession={creatingSession}
      onRenameSession={(id, currentName) => {
        setRenameTarget({ agentId: id, name: currentName });
      }}
      onDeleteSession={handleDeleteSession}
      onBindSession={(id) => {
        setBindingAgentId(id ?? MAIN_BINDING);
      }}
    />
  );

  const handleContextPanelToggle = () => {
    if (window.matchMedia('(min-width: 1024px)').matches) {
      setPanelOpen((open) => !open);
    } else {
      setMobileContextOpen(true);
    }
  };

  const renderContextPanel = () => (
    <div className="flex h-full min-h-0 w-full flex-col bg-background">
      <div className="border-b border-border/70 p-2">
        {canModifyWorkspaceConfig && (
          <button
            type="button"
            onClick={() => setContextPanelView('env')}
            aria-current={contextPanelView === 'env' ? 'page' : undefined}
            className={cn(
              'flex min-h-10 w-full items-center gap-3 rounded-md px-2.5 text-left text-xs text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer',
              contextPanelView === 'env' && 'bg-accent/70',
            )}
          >
            <Server className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="flex-1">工作区环境</span>
            <span className="text-muted-foreground">
              {group?.execution_mode === 'host' ? '宿主机' : 'Docker'}
            </span>
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        )}
        <button
          type="button"
          onClick={() => setContextPanelView('files')}
          aria-current={contextPanelView === 'files' ? 'page' : undefined}
          className={cn(
            'flex min-h-10 w-full items-center gap-3 rounded-md px-2.5 text-left text-xs text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer',
            contextPanelView === 'files' && 'bg-accent/70',
          )}
        >
          <Folder className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="flex-1">项目文件</span>
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
        {canUseTerminal && (
          <button
            type="button"
            onClick={() => {
              setPanelOpen(false);
              setMobileContextOpen(false);
              handleTerminalToggle();
            }}
            className="flex min-h-10 w-full items-center gap-3 rounded-md px-2.5 text-left text-xs text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
          >
            <Terminal className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span className="flex-1">终端</span>
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        )}
        <button
          type="button"
          onClick={toggleDisplayMode}
          className="flex min-h-10 w-full items-center gap-3 rounded-md px-2.5 text-left text-xs text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
        >
          <SlidersHorizontal className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="flex-1">显示密度</span>
          <span className="text-muted-foreground">
            {displayMode === 'chat' ? '对话' : '紧凑'}
          </span>
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {contextPanelView === 'env' && canModifyWorkspaceConfig ? (
          <ContainerEnvPanel groupJid={groupJid} />
        ) : (
          <FilePanel groupJid={groupJid} />
        )}
      </div>
    </div>
  );

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
    <div
      ref={containerRef}
      data-hc-chat-view
      className="h-full flex bg-surface dark:bg-background max-lg:rounded-none lg:rounded-t-2xl lg:rounded-b-none lg:mr-5 lg:ml-3 lg:overflow-hidden"
    >
      <aside className="hidden h-full w-[17rem] shrink-0 border-r border-border/70 bg-muted/15 lg:flex">
        {renderSessionSidebar()}
      </aside>

      <div
        className={cn(
          'min-w-0 flex-1 flex-col',
          mobileSessionsVisible ? 'hidden lg:flex' : 'flex',
        )}
      >
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
            <h2 className="font-semibold text-foreground text-[15px] truncate">
              {workspaceDisplayName}
            </h2>
            <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <span className="truncate">{contextSummary}</span>
              {group.execution_mode && (
                <>
                  <span className="text-muted-foreground/40">·</span>
                  <span
                    className={`hidden shrink-0 items-center rounded-full border px-2.5 py-0.5 text-[10px] font-medium sm:inline-flex ${group.execution_mode === 'host' ? 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/30 dark:text-amber-300 dark:border-amber-800' : 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/30 dark:text-sky-300 dark:border-sky-800'}`}
                  >
                    {group.execution_mode === 'host' ? '宿主机' : 'Docker'}
                  </span>
                </>
              )}
              <span className="text-muted-foreground/40">·</span>
              <span
                className={cn(
                  'inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[10px] font-medium',
                  interactionMode === 'proactive'
                    ? 'border-primary/30 bg-primary/5 text-primary'
                    : 'border-border bg-muted/50 text-muted-foreground',
                )}
                title={
                  interactionMode === 'proactive'
                    ? '主动模式：由 Agent 决定何时发送 0～多条独立消息'
                    : 'Assistant 模式：框架在任务完成后交付一条主回复'
                }
                aria-label={
                  interactionMode === 'proactive'
                    ? '当前为主动模式'
                    : '当前为 Assistant 模式'
                }
              >
                {interactionMode === 'proactive' ? '主动' : 'Assistant'}
              </span>
              {isOwnHome &&
                imStatus &&
                Object.entries(imStatus).some(([, v]) => v) && (
                  <>
                    <span className="text-muted-foreground/40">·</span>
                    {Object.entries(imStatus)
                      .filter(([, connected]) => connected)
                      .map(([channel]) => (
                        <span
                          key={channel}
                          className="inline-flex items-center gap-0.5"
                        >
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-500" />
                          {CHANNEL_LABEL[channel] ?? channel}
                        </span>
                      ))}
                  </>
                )}
            </div>
          </div>
          {currentContextWaiting && (
            <span className="hidden h-8 shrink-0 items-center gap-1.5 rounded-md bg-emerald-50 px-2.5 text-[11px] font-medium text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 sm:inline-flex">
              <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
              运行中
            </span>
          )}
          {canModifyWorkspaceConfig && (
            <button
              type="button"
              onClick={() => setShowInteractionModeDialog(true)}
              className="inline-flex h-11 w-11 items-center justify-center gap-1.5 rounded-lg text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer sm:h-9 sm:w-auto sm:px-2.5"
              title="工作区设置"
              aria-label="工作区设置"
            >
              <Settings2 className="h-4 w-4" />
              <span className="hidden xl:inline">工作区设置</span>
            </button>
          )}
          {canModifyWorkspaceConfig && (
            <button
              type="button"
              onClick={() => setBindingAgentId(WORKSPACE_BINDING)}
              className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
              title="管理工作区群聊绑定"
              aria-label="管理工作区群聊绑定"
            >
              <Link className="h-4 w-4" />
              <span className="hidden sm:inline">渠道绑定</span>
            </button>
          )}
          <button
            onClick={toggleTheme}
            className="hidden min-h-9 min-w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:flex cursor-pointer"
            title={
              theme === 'light'
                ? '切换到暗色模式'
                : theme === 'dark'
                  ? '跟随系统'
                  : '切换到亮色模式'
            }
            aria-label={
              theme === 'light'
                ? '切换到暗色模式'
                : theme === 'dark'
                  ? '跟随系统'
                  : '切换到亮色模式'
            }
          >
            {theme === 'light' ? (
              <Moon className="w-5 h-5" />
            ) : theme === 'dark' ? (
              <Monitor className="w-5 h-5" />
            ) : (
              <Sun className="w-5 h-5" />
            )}
          </button>
          <button
            onClick={handleContextPanelToggle}
            className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
            title={panelOpen ? '收起上下文面板' : '展开上下文面板'}
            aria-label={panelOpen ? '收起上下文面板' : '展开上下文面板'}
          >
            {panelOpen ? (
              <PanelRightClose className="h-4 w-4" />
            ) : (
              <PanelRightOpen className="h-4 w-4" />
            )}
          </button>
        </div>

        {/* Message channel setup banner for home container without channel config */}
        {isOwnHome &&
          imStatus &&
          !Object.values(imStatus).some(Boolean) &&
          !imBannerDismissed && (
            <div className="flex items-center gap-2 px-4 py-2 bg-amber-50 dark:bg-amber-950/40 border-b border-amber-200 dark:border-amber-800 text-amber-800 dark:text-amber-300 text-sm">
              <Link className="w-4 h-4 flex-shrink-0" />
              <span className="flex-1 min-w-0">
                未配置消息渠道（飞书 / Telegram / Discord / QQ / 微信 / 钉钉 /
                WhatsApp），消息无法与 HappyClaw 的直接对话互通
              </span>
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

        {/* Main conversation canvas */}
        <div className="flex-1 flex overflow-hidden min-h-0">
          {/* Messages Area */}
          <div className="flex-1 flex flex-col min-w-0 overflow-x-hidden">
            {activeAgentTab && isConversationTab ? (
              <>
                <MessageList
                  key={`conv-${activeAgentTab}`}
                  messages={agentMessages[activeAgentTab] || []}
                  loading={false}
                  hasMore={!!agentHasMore[activeAgentTab]}
                  onLoadMore={() =>
                    loadAgentMessages(groupJid, activeAgentTab, true)
                  }
                  scrollTrigger={scrollTrigger}
                  groupJid={groupJid}
                  isWaiting={currentContextWaiting}
                  agentId={activeAgentTab}
                  contextLabel={currentContextName}
                  agentName={agentProfileLabel}
                  agentAvatarUrl={group?.agent_profile_avatar_url}
                  agentAvatarEmoji={group?.agent_profile_avatar_emoji}
                  agentAvatarColor={group?.agent_profile_avatar_color}
                  interactionMode={interactionMode}
                  onSend={(content) => {
                    handleActiveAgentSend(content);
                  }}
                />
                <MessageInput
                  onSend={handleActiveAgentSend}
                  groupJid={groupJid}
                  contextLabel={currentContextName}
                  isRunning={currentContextWaiting}
                  onStop={
                    agentStreaming[activeAgentTab]?.interrupted
                      ? undefined
                      : () =>
                          interruptQuery(`${groupJid}#agent:${activeAgentTab}`)
                  }
                  queuedFollowUps={queuedFollowUps}
                  onFollowUpAction={(item, action, content) =>
                    actOnFollowUp(
                      followUpChatJid,
                      item.id,
                      action,
                      item.delivery_run_id,
                      content,
                    )
                  }
                  onResetSession={
                    canModifyWorkspaceConfig
                      ? () => {
                          setResetAgentId(activeAgentTab);
                          setShowResetConfirm(true);
                        }
                      : undefined
                  }
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
                  agentName={agentProfileLabel}
                  agentAvatarUrl={group?.agent_profile_avatar_url}
                  agentAvatarEmoji={group?.agent_profile_avatar_emoji}
                  agentAvatarColor={group?.agent_profile_avatar_color}
                  interactionMode={interactionMode}
                  onSend={(content) => handleSend(content)}
                />
                <MessageInput
                  onSend={handleSend}
                  groupJid={groupJid}
                  isRunning={currentContextWaiting}
                  onStop={
                    mainInterrupted ? undefined : () => interruptQuery(groupJid)
                  }
                  queuedFollowUps={queuedFollowUps}
                  onFollowUpAction={(item, action, content) =>
                    actOnFollowUp(
                      followUpChatJid,
                      item.id,
                      action,
                      item.delivery_run_id,
                      content,
                    )
                  }
                  onResetSession={
                    canModifyWorkspaceConfig
                      ? () => {
                          setResetAgentId(null);
                          setShowResetConfirm(true);
                        }
                      : undefined
                  }
                  onToggleTerminal={
                    canUseTerminal ? handleTerminalToggle : undefined
                  }
                />
              </>
            )}
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
      </div>

      <aside
        className={cn(
          'hidden h-full shrink-0 overflow-hidden transition-[width] duration-200 ease-out lg:flex',
          panelOpen ? 'w-80 border-l border-border/70' : 'w-0',
        )}
        aria-hidden={!panelOpen}
        inert={!panelOpen}
      >
        <div className="h-full w-80 shrink-0">{renderContextPanel()}</div>
      </aside>

      {mobileSessionsVisible && (
        <div className="flex h-full min-w-0 flex-1 bg-background pt-[env(safe-area-inset-top)] lg:hidden">
          {renderSessionSidebar(true)}
        </div>
      )}

      <Sheet open={mobileContextOpen} onOpenChange={setMobileContextOpen}>
        <SheetContent side="bottom" className="h-[80dvh] gap-0 p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>上下文面板</SheetTitle>
            <SheetDescription>
              查看当前上下文的文件和运行信息。
            </SheetDescription>
          </SheetHeader>
          {renderContextPanel()}
        </SheetContent>
      </Sheet>

      <WorkspaceInteractionModeDialog
        open={showInteractionModeDialog}
        workspaceName={workspaceDisplayName}
        currentMode={interactionMode}
        onClose={() => setShowInteractionModeDialog(false)}
        onSave={(mode) => updateInteractionMode(groupJid, mode)}
      />

      {/* Mobile: Terminal sheet */}
      <Sheet
        open={mobileTerminal}
        onOpenChange={(v) => !v && setMobileTerminal(false)}
      >
        <SheetContent side="bottom" className="h-[85dvh] p-0">
          <SheetHeader className="px-4 pt-4 pb-2">
            <SheetTitle>终端</SheetTitle>
            <SheetDescription className="sr-only">
              使用当前工作区的终端。
            </SheetDescription>
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

      {/* Reset session confirm dialog */}
      <ConfirmDialog
        open={showResetConfirm}
        onClose={() => setShowResetConfirm(false)}
        onConfirm={handleResetSession}
        title="清除上下文"
        message={
          resetAgentId
            ? '将清除该子对话的 Claude 会话上下文，下次发送消息时将开始全新会话。聊天记录不受影响。'
            : '将清除当前对话的 Claude 上下文并停止运行中的 Agent 进程，下次发送消息时将开始全新会话。聊天记录和其他对话不受影响。'
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
          agentId={
            bindingAgentId === MAIN_BINDING ||
            bindingAgentId === WORKSPACE_BINDING
              ? null
              : bindingAgentId
          }
          targetMode={
            bindingAgentId === WORKSPACE_BINDING ? 'workspace' : 'session'
          }
          agent={
            bindingAgentId !== MAIN_BINDING &&
            bindingAgentId !== WORKSPACE_BINDING
              ? agents.find((a) => a.id === bindingAgentId)
              : undefined
          }
          onClose={() => {
            setBindingAgentId(null);
          }}
        />
      )}

      <PromptDialog
        open={renameTarget !== null}
        title="重命名对话"
        label="对话名称"
        placeholder="输入新名称"
        defaultValue={renameTarget?.name ?? ''}
        onConfirm={(name) => {
          if (renameTarget)
            renameConversation(groupJid, renameTarget.agentId, name);
        }}
        onClose={() => setRenameTarget(null)}
      />
    </div>
  );
}
