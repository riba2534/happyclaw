import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import {
  isLiveStream,
  useChatStore,
  type FollowUpMode,
  type FollowUpQueueAction,
  type Message,
  type QueuedFollowUp,
} from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';
import { MessageList } from './MessageList';
import { MessageInput, type MessageInputHandle } from './MessageInput';
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
  ChevronDown,
  ChevronRight,
  Folder,
  Link,
  PanelRightClose,
  PanelRightOpen,
  Server,
  Settings2,
  SlidersHorizontal,
  Terminal,
  Upload,
  X,
} from 'lucide-react';
import { useDisplayMode } from '../../hooks/useDisplayMode';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { IconButton } from '../common/IconButton';
import { wsManager } from '../../api/ws';
import { api } from '../../api/client';
// xterm.js is ~488KB and most sessions never open the terminal; keep it out
// of the chat chunk until the panel is actually mounted.
const TerminalPanel = lazy(() =>
  import('./TerminalPanel').then((m) => ({ default: m.TerminalPanel })),
);
// Panels and dialogs that open on demand stay out of the chat chunk (~110KB
// with the select primitives they pull in). They are fetched when the browser
// is idle and render without suspending once loaded.
const Nothing = () => null;
const lazyFilePanel = preloadedComponent(
  () => import('./FilePanel').then((m) => ({ default: m.FilePanel })),
  Nothing,
);
const lazyContainerEnvPanel = preloadedComponent(
  () =>
    import('./ContainerEnvPanel').then((m) => ({
      default: m.ContainerEnvPanel,
    })),
  Nothing,
);
const lazyImBindingDialog = preloadedComponent(
  () =>
    import('./ImBindingDialog').then((m) => ({ default: m.ImBindingDialog })),
  Nothing,
);
// Opening a workspace before the idle preload finished would otherwise show
// an empty pane while the session list downloads.
function SessionSidebarSkeleton() {
  return (
    <div
      role="status"
      aria-label="正在加载会话列表"
      className="flex h-full min-h-0 w-full flex-col"
    >
      <div className="border-b border-surface-border px-3 py-2.5">
        <div className="flex min-h-9 items-center gap-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-5 w-7 rounded-full" />
        </div>
      </div>
      <div className="flex-1 space-y-0.5 px-2 py-2">
        {[0, 1, 2, 3, 4].map((row) => (
          <div key={row} className="flex items-start gap-2 px-2.5 py-1.5">
            <Skeleton className="mt-1 size-3.5 shrink-0" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
const lazySessionSidebar = preloadedComponent(
  () => import('./SessionSidebar').then((m) => ({ default: m.SessionSidebar })),
  SessionSidebarSkeleton,
);
const lazyInteractionModeDialog = preloadedComponent(
  () =>
    import('./WorkspaceInteractionModeDialog').then((m) => ({
      default: m.WorkspaceInteractionModeDialog,
    })),
  Nothing,
);
const FilePanel = lazyFilePanel.Component;
const ContainerEnvPanel = lazyContainerEnvPanel.Component;
const ImBindingDialog = lazyImBindingDialog.Component;
const SessionSidebar = lazySessionSidebar.Component;
const WorkspaceInteractionModeDialog = lazyInteractionModeDialog.Component;
import { useFileDropZone } from '../../hooks/useFileDropZone';
import { useSessionActions } from '../../hooks/useSessionActions';
import { useStableCallback } from '../../hooks/useStableCallback';
import {
  preloadedComponent,
  preloadWhenIdle,
  useOpenedOnce,
} from '../../lib/preloaded-component';
import { useShellStore } from '../../stores/shell';
import { buildConversationSessions } from '../../lib/session-presentation';
import { showToast } from '../../utils/toast';
import {
  getWorkspaceLastAgent,
  setWorkspaceLastAgent,
} from '../../utils/workspaceLastAgent';
import { CHANNEL_LABEL } from '../settings/channel-meta';
import { getAgentProfileDisplayName } from '../../utils/agent-product';
import { normalizeInteractionMode } from '../../lib/interaction-mode';

/** Sentinel value for binding the main conversation (vs. a specific agent) */
const MAIN_BINDING = '__main__' as const;
const WORKSPACE_BINDING = '__workspace__' as const;

// New messages arrive over WebSocket; polling is only a safety net. Poll
// fast while the socket is down, slowly while it is up.
const POLL_INTERVAL_MS = 2000;
const POLL_INTERVAL_CONNECTED_MS = 30_000;
const TERMINAL_MIN_HEIGHT = 150;
const TERMINAL_DEFAULT_HEIGHT = 300;
const TERMINAL_MAX_RATIO = 0.7;

// Stable empty references to avoid infinite re-render loops in Zustand selectors
const EMPTY_AGENTS: import('../../types').AgentInfo[] = [];
const EMPTY_FOLLOW_UPS: QueuedFollowUp[] = [];
const EMPTY_MESSAGES: Message[] = [];

interface ChatViewProps {
  groupJid: string;
  onBack?: () => void;
  headerLeft?: React.ReactNode;
}

export function ChatView({ groupJid, onBack, headerLeft }: ChatViewProps) {
  const { mode: displayMode, toggle: toggleDisplayMode } = useDisplayMode();
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelEverOpened, setPanelEverOpened] = useState(false);
  useEffect(() => {
    if (panelOpen) setPanelEverOpened(true);
  }, [panelOpen]);
  const [mobileContextOpen, setMobileContextOpen] = useState(false);
  const [contextPanelView, setContextPanelView] = useState<'files' | 'env'>(
    'files',
  );

  // The nav rows eat ~11rem of an 80dvh sheet — a third of the file list on a
  // 390x844 viewport. Fold them into a single icon bar once the pane scrolls
  // down; scrolling back up or tapping the bar restores the labels.
  const [contextNavCollapsed, setContextNavCollapsed] = useState(false);
  // A callback ref, not `useRef` + `useEffect([mobileContextOpen])`. Radix's
  // `Presence` seeds its state machine from `present` and only sends MOUNT from
  // a layout effect, so on the commit where the sheet opens it still renders
  // null — an effect keyed on the open flag would look for the node one commit
  // too early, find nothing, and never run again.
  const contextPanelBodyRef = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    setContextNavCollapsed(false);
    let last = 0;
    const onScroll = (e: Event) => {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      const top = target.scrollTop;
      const delta = top - last;
      last = top;
      if (top <= 8) setContextNavCollapsed(false);
      else if (delta > 6) setContextNavCollapsed(true);
      else if (delta < -6) setContextNavCollapsed(false);
    };
    // `scroll` does not bubble, so capture it on the way down instead of
    // reaching into FilePanel for whichever element happens to be its scroller.
    node.addEventListener('scroll', onScroll, true);
    return () => node.removeEventListener('scroll', onScroll, true);
  }, []);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showInteractionModeDialog, setShowInteractionModeDialog] =
    useState(false);
  const interactionModeDialogMounted = useOpenedOnce(showInteractionModeDialog);
  useEffect(
    () =>
      preloadWhenIdle(
        lazyFilePanel.preload,
        lazyContainerEnvPanel.preload,
        lazyImBindingDialog.preload,
        lazySessionSidebar.preload,
        lazyInteractionModeDialog.preload,
      ),
    [],
  );
  const [resetLoading, setResetLoading] = useState(false);
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
  const handleWsNewMessage = useChatStore((s) => s.handleWsNewMessage);
  const updateInteractionMode = useChatStore((s) => s.updateInteractionMode);

  const agents = useChatStore((s) => s.agents[groupJid] ?? EMPTY_AGENTS);
  const activeAgentTab = useChatStore(
    (s) => s.activeAgentTab[groupJid] ?? null,
  );
  const setActiveAgentTab = useChatStore((s) => s.setActiveAgentTab);
  const followUpChatJid = activeAgentTab
    ? `${groupJid}#agent:${activeAgentTab}`
    : groupJid;

  // Files dropped anywhere on the chat canvas go to the composer; without a
  // page-level target the browser would navigate the tab to the file.
  const composerRef = useRef<MessageInputHandle>(null);
  const { isDragOver, dropZoneProps } = useFileDropZone((dataTransfer) =>
    composerRef.current?.acceptDrop(dataTransfer),
  );
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
  // Session ids with an active query, joined: streaming deltas of any session
  // must not re-render the whole view, only a start or stop does.
  // A card frozen by a stop is not a running query.
  const activeQueryIds = useChatStore((s) =>
    (s.agents[groupJid] ?? EMPTY_AGENTS)
      .filter(
        (a) => s.agentWaiting[a.id] || isLiveStream(s.agentStreaming[a.id]),
      )
      .map((a) => a.id)
      .join(','),
  );
  const { creatingSession, createSession, deleteSession } = useSessionActions();
  const renameConversation = useChatStore((s) => s.renameConversation);
  const loadAgentMessages = useChatStore((s) => s.loadAgentMessages);
  const hydrateAgentMessages = useChatStore((s) => s.hydrateAgentMessages);
  const refreshAgentMessages = useChatStore((s) => s.refreshAgentMessages);
  const sendAgentMessage = useChatStore((s) => s.sendAgentMessage);
  const activeAgentMessages = useChatStore((s) =>
    activeAgentTab ? s.agentMessages[activeAgentTab] : undefined,
  );
  const activeAgentHasMore = useChatStore((s) =>
    activeAgentTab ? !!s.agentHasMore[activeAgentTab] : false,
  );
  const activeAgentWaiting = useChatStore((s) =>
    activeAgentTab
      ? !!s.agentWaiting[activeAgentTab] ||
        isLiveStream(s.agentStreaming[activeAgentTab])
      : false,
  );
  const activeAgentInterrupted = useChatStore((s) =>
    activeAgentTab ? !!s.agentStreaming[activeAgentTab]?.interrupted : false,
  );

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
        .get<Record<string, boolean>>('/api/channel-accounts/status')
        .then((data) => {
          if (active) setImStatus(data);
        })
        .catch(() => {});
    };
    fetchStatus();
    // Refresh every 30s while the tab is visible.
    let timer: ReturnType<typeof setInterval> | undefined;
    const sync = () => {
      if (timer) clearInterval(timer);
      timer = document.hidden ? undefined : setInterval(fetchStatus, 30_000);
    };
    const onVisibility = () => {
      if (!document.hidden) fetchStatus();
      sync();
    };
    sync();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      active = false;
      if (timer) clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
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
      pollRef.current = setTimeout(
        poll,
        wsManager.isConnected() ? POLL_INTERVAL_CONNECTED_MS : POLL_INTERVAL_MS,
      );
    };

    // One poll chain only: visibility and reconnect triggers can fire while a
    // request is still in flight.
    let polling = false;
    const poll = async () => {
      if (!active || polling) return;
      polling = true;
      try {
        await refreshMessages(groupJid);
      } catch {
        /* handled in store */
      } finally {
        polling = false;
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

    // Switch cadence as soon as the socket drops or comes back. A reconnect
    // also refreshes once: rows saved while the socket was down (e.g. partial
    // replies stored during a server restart) are never broadcast.
    const reschedule = () => {
      if (pollRef.current) clearTimeout(pollRef.current);
      schedulePoll();
    };
    const offConnected = wsManager.on(
      'connected',
      (data: { reconnect?: boolean }) => {
        // The page's first open only switches cadence: the initial message
        // load is already in flight or done.
        if (!data?.reconnect) {
          reschedule();
          return;
        }
        if (pollRef.current) clearTimeout(pollRef.current);
        void poll();
      },
    );
    const offDisconnected = wsManager.on('disconnected', reschedule);

    document.addEventListener('visibilitychange', handleVisibility);
    // Returning to a workspace whose messages are cached: catch up at once.
    // Its WS events were ignored while another workspace was open, and the
    // connected cadence would otherwise wait 30s for the first refresh.
    if (useChatStore.getState().messages[groupJid]) void poll();
    else schedulePoll();

    return () => {
      active = false;
      offConnected();
      offDisconnected();
      document.removeEventListener('visibilitychange', handleVisibility);
      if (pollRef.current) clearTimeout(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupJid]);

  // WS 重连时恢复正在运行的 agent 状态（独立于 groupJid，避免切换会话时重复调用）
  // wsManager.connect() 已提升到 AppLayout 级别
  const restoreActiveState = useChatStore((s) => s.restoreActiveState);
  // Run state is global; restore it once per mount, not on every workspace
  // switch. Reconnects restore it again below.
  useEffect(() => {
    restoreActiveState();
  }, [restoreActiveState]);
  useEffect(() => {
    const unsub = wsManager.on('connected', (data: { reconnect?: boolean }) => {
      // The first open of a page follows the mount-time loads above; only a
      // reconnect can have missed events. A forced agent reload on the first
      // open fetched the whole session list a second time on every page load.
      if (!data?.reconnect) return;
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
      buildConversationSessions(agents, (id) =>
        activeQueryIds.split(',').includes(id),
      ),
    [agents, activeQueryIds],
  );
  const mainConversationLabel = group?.is_my_home ? '直接对话' : '当前对话';
  const currentContextName =
    activeAgentTab && isConversationTab && activeAgent
      ? activeAgent.name
      : mainConversationLabel;
  const currentContextWaiting =
    activeAgentTab && isConversationTab ? activeAgentWaiting : isWaiting;
  const agentProfileLabel = group?.agent_profile_name
    ? getAgentProfileDisplayName(group.agent_profile_name)
    : group?.is_home
      ? 'HappyClaw'
      : '智能体';
  const workspaceDisplayName = group?.is_my_home
    ? agentProfileLabel
    : group?.name;
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
    if (activeAgentMessages) return;
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
    activeAgentMessages,
  ]);

  // stream_event / stream_snapshot are applied for every workspace by
  // AppLayout (useGlobalStreamSubscriptions); this view only listens to the
  // events that concern the conversation it shows.
  useEffect(() => {
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
    const unsub5 = wsManager.on('follow_up_update', (data: any) => {
      if (data.chatJid !== groupJid || !Array.isArray(data.items)) return;
      const targetJid = data.agentId
        ? `${groupJid}#agent:${data.agentId}`
        : groupJid;
      handleFollowUpUpdate(targetJid, data.items, data.transition);
    });
    // agent_status 已提升到 AppLayout 全局监听
    return () => {
      unsub2();
      unsub3();
      unsub5();
    };
  }, [groupJid, handleWsNewMessage, handleFollowUpUpdate]);

  useEffect(() => {
    void loadFollowUps(followUpChatJid);
    const unsub = wsManager.on('connected', (data: { reconnect?: boolean }) => {
      if (data?.reconnect) void loadFollowUps(followUpChatJid);
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

  // Stable handlers for the memoized transcript and composer: this view also
  // re-renders for dialogs, panels and run status, which must not re-render
  // a long transcript or the composer.
  const loadMoreMain = useStableCallback(handleLoadMore);
  const loadMoreActiveAgent = useStableCallback(() => {
    if (activeAgentTab) void loadAgentMessages(groupJid, activeAgentTab, true);
  });
  const sendMain = useStableCallback(handleSend);
  const sendActiveAgent = useStableCallback(handleActiveAgentSend);
  const sendStarterMain = useStableCallback((content: string) => {
    void handleSend(content);
  });
  const sendStarterActiveAgent = useStableCallback((content: string) => {
    void handleActiveAgentSend(content);
  });
  const stopMain = useStableCallback(() => interruptQuery(groupJid));
  const stopActiveAgent = useStableCallback(() =>
    interruptQuery(`${groupJid}#agent:${activeAgentTab}`),
  );
  const handleFollowUpAction = useStableCallback(
    (item: QueuedFollowUp, action: FollowUpQueueAction, content?: string) =>
      actOnFollowUp(
        followUpChatJid,
        item.id,
        action,
        item.delivery_run_id,
        content,
      ),
  );
  const requestResetMain = useStableCallback(() => {
    setResetAgentId(null);
    setShowResetConfirm(true);
  });
  const requestResetActiveAgent = useStableCallback(() => {
    setResetAgentId(activeAgentTab);
    setShowResetConfirm(true);
  });

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
    const agent = await createSession(groupJid);
    if (agent) selectTab(agent.id);
  }, [createSession, groupJid, selectTab]);

  const handleDeleteSession = useCallback(
    (id: string) => deleteSession(groupJid, id, setBindingAgentId),
    [deleteSession, groupJid],
  );

  // The sidebar session tree asks for IM binding through the shell store
  // because the binding dialog lives here with the workspace context.
  const bindingRequest = useShellStore((s) => s.bindingRequest);
  const clearBindingRequest = useShellStore((s) => s.clearBindingRequest);
  useEffect(() => {
    if (!bindingRequest || bindingRequest.groupJid !== groupJid) return;
    setBindingAgentId(bindingRequest.target);
    clearBindingRequest();
  }, [bindingRequest, clearBindingRequest, groupJid]);

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
      // Same naming as the desktop session tree: the list is titled by its
      // workspace and the first row is the main conversation.
      title={group.is_my_home ? agentProfileLabel : group.name}
      mainLabel={mainConversationLabel}
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

  const contextNavItems: {
    key: string;
    icon: typeof Server;
    label: string;
    value?: string;
    current?: boolean;
    chevron?: boolean;
    onClick: () => void;
  }[] = [
    ...(canModifyWorkspaceConfig
      ? [
          {
            key: 'env',
            icon: Server,
            label: '工作区环境',
            value: group?.execution_mode === 'host' ? '宿主机' : 'Docker',
            current: contextPanelView === 'env',
            chevron: true,
            onClick: () => setContextPanelView('env'),
          },
        ]
      : []),
    {
      key: 'files',
      icon: Folder,
      label: '项目文件',
      current: contextPanelView === 'files',
      chevron: true,
      onClick: () => setContextPanelView('files'),
    },
    ...(canUseTerminal
      ? [
          {
            key: 'terminal',
            icon: Terminal,
            label: '终端',
            chevron: true,
            onClick: () => {
              setPanelOpen(false);
              setMobileContextOpen(false);
              handleTerminalToggle();
            },
          },
        ]
      : []),
    {
      key: 'display',
      icon: SlidersHorizontal,
      label: '显示密度',
      value: displayMode === 'chat' ? '对话' : '紧凑',
      onClick: toggleDisplayMode,
    },
  ];

  const renderContextPanel = (collapsibleNav = false) => (
    <div className="flex h-full min-h-0 w-full flex-col bg-background">
      {/* Both bands animate on the same tick — one grows as the other shrinks —
          so the pane below keeps a steady offset instead of bouncing. Fixed
          max-heights rather than a `grid-rows-[0fr]` collapse: the rows are
          `min-h-10`, so four of them plus padding never exceed 14rem, and
          max-height interpolates on every engine we target. */}
      {collapsibleNav && (
        <div
          data-testid="context-nav-collapsed"
          data-state={contextNavCollapsed ? 'open' : 'closed'}
          className={cn(
            'shrink-0 overflow-hidden transition-[max-height] duration-200 ease-out',
            contextNavCollapsed ? 'max-h-12' : 'max-h-0',
          )}
          inert={!contextNavCollapsed}
        >
          <button
            type="button"
            onClick={() => setContextNavCollapsed(false)}
            aria-expanded={false}
            aria-label="展开上下文操作"
            className="flex w-full cursor-pointer items-center gap-5 border-b border-surface-border px-4 py-3 text-muted-foreground transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none"
          >
            {contextNavItems.map((item) => (
              <item.icon
                key={item.key}
                className={cn(
                  'h-4 w-4 shrink-0',
                  item.current && 'text-foreground',
                )}
              />
            ))}
            <ChevronDown className="ml-auto h-3.5 w-3.5 shrink-0" />
          </button>
        </div>
      )}
      <div
        data-testid={collapsibleNav ? 'context-nav-expanded' : undefined}
        data-state={contextNavCollapsed ? 'closed' : 'open'}
        className={cn(
          'shrink-0 overflow-hidden',
          collapsibleNav && 'transition-[max-height] duration-200 ease-out',
          collapsibleNav && contextNavCollapsed ? 'max-h-0' : 'max-h-56',
        )}
        inert={collapsibleNav && contextNavCollapsed}
      >
        <div className="border-b border-surface-border p-1.5">
          {contextNavItems.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={item.onClick}
              aria-current={item.current ? 'page' : undefined}
              className={cn(
                'flex h-8 w-full cursor-pointer items-center gap-2.5 rounded-md px-2 text-left text-body text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none pointer-coarse:min-h-10',
                item.current &&
                  'bg-surface-selected font-medium text-foreground',
              )}
            >
              <item.icon className="size-4 shrink-0" />
              <span className="flex-1">{item.label}</span>
              {item.value && (
                <span className="text-caption text-faint-foreground">
                  {item.value}
                </span>
              )}
              {item.chevron && (
                <ChevronRight className="size-3.5 text-faint-foreground" />
              )}
            </button>
          ))}
        </div>
      </div>
      <div
        ref={collapsibleNav ? contextPanelBodyRef : undefined}
        data-testid={collapsibleNav ? 'context-panel-body' : undefined}
        className="min-h-0 flex-1 overflow-hidden"
      >
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
      className="h-full flex overflow-hidden bg-background"
      {...dropZoneProps}
    >
      <div
        className={cn(
          'min-w-0 flex-1 flex-col',
          mobileSessionsVisible ? 'hidden lg:flex' : 'flex',
        )}
      >
        {/* Header */}
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-surface-border px-4 max-lg:h-13 max-lg:bg-background/80 max-lg:backdrop-blur-xl lg:px-5">
          {onBack && (
            <IconButton
              label="返回"
              icon={<ArrowLeft />}
              onClick={handleBackAction}
              hideTooltip
              className="-ml-1.5 pointer-coarse:size-10 lg:hidden"
            />
          )}
          {headerLeft}
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <nav
              aria-label="当前对话"
              className="flex min-w-0 items-center gap-1 text-body"
            >
              {activeAgentTab && isConversationTab ? (
                <button
                  type="button"
                  onClick={() => selectTab(null)}
                  className="hidden max-w-[16rem] shrink-0 cursor-pointer truncate rounded-md px-1.5 py-0.5 font-medium text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground sm:block"
                  title={`返回${mainConversationLabel}`}
                >
                  {workspaceDisplayName}
                </button>
              ) : (
                <h2 className="truncate px-1.5 font-medium text-foreground">
                  {workspaceDisplayName}
                </h2>
              )}
              {activeAgentTab && isConversationTab && (
                <>
                  <ChevronRight
                    className="hidden size-3.5 shrink-0 text-faint-foreground sm:block"
                    aria-hidden="true"
                  />
                  <h2 className="truncate px-1 font-medium text-foreground">
                    {currentContextName}
                  </h2>
                </>
              )}
            </nav>
            <div className="hidden min-w-0 items-center gap-1.5 overflow-hidden md:flex">
              {group.execution_mode && (
                <Badge variant="outline">
                  {group.execution_mode === 'host' ? '宿主机' : 'Docker'}
                </Badge>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Badge
                    variant="outline"
                    dot={
                      interactionMode === 'proactive' ? 'primary' : undefined
                    }
                    aria-label={
                      interactionMode === 'proactive'
                        ? '当前为主动模式'
                        : '当前为 Assistant 模式'
                    }
                  >
                    {interactionMode === 'proactive' ? '主动' : 'Assistant'}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>
                  {interactionMode === 'proactive'
                    ? '主动模式：由智能体决定何时发送 0～多条独立消息'
                    : 'Assistant 模式：框架在任务完成后交付一条主回复'}
                </TooltipContent>
              </Tooltip>
              {isOwnHome &&
                imStatus &&
                Object.entries(imStatus).some(([, v]) => v) && (
                  <Badge
                    variant="outline"
                    dot="success"
                    // `body { word-break: break-word }` drops the min-content
                    // floor to a single character; keep the label on one line.
                    className="min-w-0 whitespace-nowrap"
                  >
                    {Object.entries(imStatus)
                      .filter(([, connected]) => connected)
                      .map(([channel]) => CHANNEL_LABEL[channel] ?? channel)
                      .join(' · ')}
                  </Badge>
                )}
            </div>
          </div>
          {currentContextWaiting && (
            <span
              data-testid="chat-run-indicator"
              title="运行中"
              className="inline-flex shrink-0 items-center gap-1.5 px-1 text-caption text-muted-foreground"
            >
              <Spinner className="size-3.5" aria-hidden="true" />
              {/* Phones keep the spinner only; the header has no room. */}
              <span className="max-sm:sr-only">运行中</span>
            </span>
          )}
          <div className="flex shrink-0 items-center gap-0.5">
            {canModifyWorkspaceConfig && (
              <IconButton
                label="工作区设置"
                icon={<Settings2 />}
                onClick={() => setShowInteractionModeDialog(true)}
                className="text-muted-foreground pointer-coarse:size-10"
              />
            )}
            {canModifyWorkspaceConfig && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setBindingAgentId(WORKSPACE_BINDING)}
                className="text-muted-foreground pointer-coarse:min-h-10"
                title="管理工作区话题群绑定"
                aria-label="管理工作区话题群绑定"
              >
                <Link />
                <span className="hidden sm:inline">渠道绑定</span>
              </Button>
            )}
            <IconButton
              label={panelOpen ? '收起上下文面板' : '展开上下文面板'}
              icon={panelOpen ? <PanelRightClose /> : <PanelRightOpen />}
              onClick={handleContextPanelToggle}
              className="text-muted-foreground pointer-coarse:size-10"
            />
          </div>
        </header>

        {/* Message channel setup hint for home container without channel config */}
        {isOwnHome &&
          imStatus &&
          !Object.values(imStatus).some(Boolean) &&
          !imBannerDismissed && (
            <div className="flex min-h-9 shrink-0 items-center gap-2 border-b border-surface-border bg-muted/40 px-4 py-1.5 text-caption text-muted-foreground lg:px-5">
              <Link className="size-3.5 shrink-0 text-primary-text" />
              <span className="min-w-0 flex-1">
                未配置消息渠道（飞书 / Telegram / Discord / QQ / 微信 / 钉钉 /
                WhatsApp），消息无法与 HappyClaw 的直接对话互通
              </span>
              <Button
                variant="outline"
                size="xs"
                onClick={() => navigate('/setup/channels')}
              >
                去配置
              </Button>
              <IconButton
                label="关闭"
                icon={<X />}
                size="icon-xs"
                hideTooltip
                onClick={() => {
                  setImBannerDismissed(true);
                  localStorage.setItem('im-banner-dismissed', '1');
                }}
              />
            </div>
          )}

        {/* Main conversation canvas */}
        <div className="flex-1 flex overflow-hidden min-h-0">
          {/* Messages Area */}
          <div className="relative flex-1 flex flex-col min-w-0 overflow-x-hidden">
            {isDragOver && (
              <div
                data-testid="chat-drop-overlay"
                className="pointer-events-none absolute inset-2 z-50 flex items-center justify-center rounded-xl border-2 border-dashed border-primary bg-primary/5 backdrop-blur-[2px] dark:bg-primary/10"
              >
                <div className="flex flex-col items-center gap-2 text-primary-text">
                  <Upload className="size-8" />
                  <span className="text-sm font-medium">松开上传文件</span>
                </div>
              </div>
            )}
            {activeAgentTab && isConversationTab ? (
              <>
                <MessageList
                  key={`conv-${activeAgentTab}`}
                  messages={activeAgentMessages || EMPTY_MESSAGES}
                  // Not loaded yet (first visit, or evicted from the message
                  // cache): don't flash the empty-conversation starters.
                  loading={activeAgentMessages === undefined}
                  hasMore={activeAgentHasMore}
                  onLoadMore={loadMoreActiveAgent}
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
                  onSend={sendStarterActiveAgent}
                />
                <MessageInput
                  // One instance per conversation: draft and pending
                  // attachments never carry over to another session.
                  key={followUpChatJid}
                  ref={composerRef}
                  draftKey={followUpChatJid}
                  placeholder={`向 ${agentProfileLabel} 发送消息…`}
                  onSend={sendActiveAgent}
                  groupJid={groupJid}
                  contextLabel={currentContextName}
                  isRunning={currentContextWaiting}
                  onStop={activeAgentInterrupted ? undefined : stopActiveAgent}
                  queuedFollowUps={queuedFollowUps}
                  onFollowUpAction={handleFollowUpAction}
                  onResetSession={
                    canModifyWorkspaceConfig
                      ? requestResetActiveAgent
                      : undefined
                  }
                />
              </>
            ) : (
              <>
                <MessageList
                  key={`main-${groupJid}`}
                  messages={groupMessages || EMPTY_MESSAGES}
                  loading={loading || groupMessages === undefined}
                  hasMore={hasMoreMessages}
                  onLoadMore={loadMoreMain}
                  scrollTrigger={scrollTrigger}
                  groupJid={groupJid}
                  isWaiting={isWaiting}
                  agentName={agentProfileLabel}
                  agentAvatarUrl={group?.agent_profile_avatar_url}
                  agentAvatarEmoji={group?.agent_profile_avatar_emoji}
                  agentAvatarColor={group?.agent_profile_avatar_color}
                  interactionMode={interactionMode}
                  onSend={sendStarterMain}
                />
                <MessageInput
                  key={groupJid}
                  ref={composerRef}
                  draftKey={groupJid}
                  placeholder={`向 ${agentProfileLabel} 发送消息…`}
                  onSend={sendMain}
                  groupJid={groupJid}
                  isRunning={currentContextWaiting}
                  onStop={mainInterrupted ? undefined : stopMain}
                  queuedFollowUps={queuedFollowUps}
                  onFollowUpAction={handleFollowUpAction}
                  onResetSession={
                    canModifyWorkspaceConfig ? requestResetMain : undefined
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
                className="group hidden h-1.5 cursor-row-resize items-center justify-center border-t border-surface-border transition-colors hover:bg-surface-hover lg:flex"
              >
                <div className="h-0.5 w-8 rounded-full bg-faint-foreground/60 transition-colors group-hover:bg-foreground/40" />
              </div>
            )}
            {/* Terminal panel */}
            <div
              className={`hidden lg:block flex-shrink-0 overflow-hidden transition-[height] duration-200 ${
                terminalVisible
                  ? 'border-t border-surface-border'
                  : 'border-t-0'
              }`}
              style={{ height: terminalVisible ? terminalHeight : 0 }}
            >
              <Suspense fallback={null}>
                <TerminalPanel
                  groupJid={groupJid}
                  visible={terminalVisible}
                  onHide={() => setTerminalVisible(false)}
                  onDelete={() => {
                    setTerminalVisible(false);
                    setTerminalMounted(false);
                  }}
                />
              </Suspense>
            </div>
          </>
        )}
      </div>

      <aside
        className={cn(
          'hidden h-full shrink-0 overflow-hidden transition-[width] duration-200 ease-out lg:flex',
          panelOpen ? 'w-80 border-l border-surface-border' : 'w-0',
        )}
        aria-hidden={!panelOpen}
        inert={!panelOpen}
      >
        {/* 首次打开前不挂载：面板默认关闭，w-0+inert 只是视觉隐藏，此前
            FilePanel 首屏就会发 /files 请求。打开过之后保持挂载以保留收起动画。 */}
        <div className="h-full w-80 shrink-0">
          {panelEverOpened && renderContextPanel()}
        </div>
      </aside>

      {mobileSessionsVisible && (
        <div className="flex h-full min-w-0 flex-1 bg-background pt-[env(safe-area-inset-top)] lg:hidden">
          {renderSessionSidebar(true)}
        </div>
      )}

      <Sheet open={mobileContextOpen} onOpenChange={setMobileContextOpen}>
        {/* The height must carry the same `data-[side=bottom]` variant as the
            default it replaces. An unvariated `h-[80dvh]` survives merging but
            loses on specificity, leaving the sheet at `h-auto` — it then grows
            with the file list, covers the viewport and cannot scroll. */}
        <SheetContent
          side="bottom"
          data-testid="mobile-context-sheet"
          className="gap-0 p-0 data-[side=bottom]:h-[80dvh]"
        >
          {/* A visible header keeps the sheet's close button off the
              first panel row. */}
          <SheetHeader className="shrink-0 border-b border-surface-border px-4 py-3 pr-12">
            <SheetTitle className="text-title-sm">上下文面板</SheetTitle>
            <SheetDescription className="sr-only">
              查看当前上下文的文件和运行信息。
            </SheetDescription>
          </SheetHeader>
          <div className="min-h-0 flex-1">{renderContextPanel(true)}</div>
        </SheetContent>
      </Sheet>

      {interactionModeDialogMounted && (
        <WorkspaceInteractionModeDialog
          open={showInteractionModeDialog}
          workspaceName={workspaceDisplayName}
          currentMode={interactionMode}
          onClose={() => setShowInteractionModeDialog(false)}
          onSave={(mode) => updateInteractionMode(groupJid, mode)}
        />
      )}

      {/* Mobile: Terminal sheet */}
      <Sheet
        open={mobileTerminal}
        onOpenChange={(v) => !v && setMobileTerminal(false)}
      >
        <SheetContent
          side="bottom"
          className="p-0 data-[side=bottom]:h-[85dvh]"
        >
          <SheetHeader className="px-4 pt-4 pb-2">
            <SheetTitle>终端</SheetTitle>
            <SheetDescription className="sr-only">
              使用当前工作区的终端。
            </SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-hidden h-[calc(85dvh-56px)]">
            <Suspense fallback={null}>
              <TerminalPanel
                groupJid={groupJid}
                visible
                onHide={() => setMobileTerminal(false)}
                onDelete={() => setMobileTerminal(false)}
              />
            </Suspense>
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
            : '将清除当前对话的 Claude 上下文并停止运行中的智能体进程，下次发送消息时将开始全新会话。聊天记录和其他对话不受影响。'
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
