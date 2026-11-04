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
import { useAuthStore, useIsGuest } from '../../stores/auth';
import { GUEST_READ_ONLY_NOTICE } from '../../lib/guest';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useIsPhone } from '../layout/phone';
import { isMessageVisibleInTimeline } from '../../lib/message-timeline';
import { MessageList } from './MessageList';
import {
  ConversationStarters,
  EmptyConversationHeading,
} from './composer/EmptyConversation';
import { MessageInput } from './LazyMessageInput';
import type { MessageInputHandle } from './MessageInput';
import { ReadOnlyComposer } from './composer/ReadOnlyComposer';
import { ModelSelector } from './ModelSelector';
import { WorktreeBranchTag } from './WorktreeBranchTag';
import { useFileStore } from '../../stores/files';
import { RunStatusBar } from './RunStatusBar';
import {
  ConversationContextUsage,
  contextUsageFigures,
} from './composer/ContextUsageRing';
import { ActionSheet, type SheetAction } from './composer/ActionSheet';
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
  Cpu,
  Folder,
  Gauge,
  GitCompare,
  Link,
  MessagesSquare,
  MoreHorizontal,
  Paintbrush,
  PanelRightClose,
  PanelRightOpen,
  Server,
  Settings2,
  SlidersHorizontal,
  SquarePen,
  Terminal,
  TerminalSquare,
  Timer,
  Upload,
  X,
} from 'lucide-react';
import { SessionAutomationBadge } from '../automations/SessionAutomationBadge';
import { useAutomationsStore } from '../../stores/automations';
import { sessionJidOf } from '../../lib/session-jid';
import { useDisplayMode } from '../../hooks/useDisplayMode';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import {
  ResponsiveMenu,
  type MenuAction,
} from '@/components/common/ResponsiveMenu';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { IconButton } from '../common/IconButton';
import { lazyImBindingDialog } from '../common/lazy-dialogs';
import { InfoTip } from '../common/InfoTip';
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
const lazyReviewPanel = preloadedComponent(
  () =>
    import('../review/ReviewPanel').then((m) => ({ default: m.ReviewPanel })),
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
const ReviewPanel = lazyReviewPanel.Component;
const ImBindingDialog = lazyImBindingDialog.Component;
const SessionSidebar = lazySessionSidebar.Component;
const WorkspaceInteractionModeDialog = lazyInteractionModeDialog.Component;
import { useFileDropZone } from '../../hooks/useFileDropZone';
import { useSessionActions } from '../../hooks/useSessionActions';
import { useSessionRowActions } from '../layout/sidebar/workspace-sessions';
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
  rememberOpenedSession,
} from '../../utils/workspaceLastAgent';
import { resolveWorkspaceEntry } from '../../lib/session-entry';
import { useNewConversation } from '../../hooks/useNewConversation';
import { CHANNEL_LABEL } from '../settings/channel-meta';
import { getAgentProfileDisplayName } from '../../utils/agent-product';
import { normalizeInteractionMode } from '../../lib/interaction-mode';
import { normalizeProcessVisibility } from '../../lib/process-visibility';

/** The binding dialog opened for the workspace's topic groups (vs. a session). */
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

const IM_BANNER_TEXT =
  '未配置消息渠道（飞书 / Telegram / Discord / QQ / 微信 / 钉钉 / WhatsApp），无法在 IM 中与 HappyClaw 对话';

export function ChatView({ groupJid, onBack, headerLeft }: ChatViewProps) {
  const { mode: displayMode, toggle: toggleDisplayMode } = useDisplayMode();
  const [panelOpen, setPanelOpen] = useState(false);
  const [panelEverOpened, setPanelEverOpened] = useState(false);
  useEffect(() => {
    if (panelOpen) setPanelEverOpened(true);
  }, [panelOpen]);
  const [mobileContextOpen, setMobileContextOpen] = useState(false);
  const [contextPanelView, setContextPanelView] = useState<
    'files' | 'env' | 'review'
  >('files');

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
        lazyReviewPanel.preload,
        lazyImBindingDialog.preload,
        lazySessionSidebar.preload,
        lazyInteractionModeDialog.preload,
      ),
    [],
  );
  const [resetLoading, setResetLoading] = useState(false);
  // Desktop: visible controls panel height, mounted controls terminal lifecycle.
  const [terminalVisible, setTerminalVisible] = useState(false);
  const [terminalMounted, setTerminalMounted] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(TERMINAL_DEFAULT_HEIGHT);
  const [headerSheetOpen, setHeaderSheetOpen] = useState(false);
  const [mobileTerminal, setMobileTerminal] = useState(false);
  // null = dialog closed; WORKSPACE_BINDING = topic groups; other = session id
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
  const interruptQuery = useChatStore((s) => s.interruptQuery);
  const resetSession = useChatStore((s) => s.resetSession);
  const handleWsNewMessage = useChatStore((s) => s.handleWsNewMessage);
  const updateInteractionMode = useChatStore((s) => s.updateInteractionMode);
  const updateProcessVisibility = useChatStore(
    (s) => s.updateProcessVisibility,
  );

  const agentsLoaded = useChatStore((s) => s.agents[groupJid] !== undefined);
  const agents = useChatStore((s) => s.agents[groupJid] ?? EMPTY_AGENTS);
  const setActiveAgentTab = useChatStore((s) => s.setActiveAgentTab);

  // Files dropped anywhere on the chat canvas go to the composer; without a
  // page-level target the browser would navigate the tab to the file.
  const composerRef = useRef<MessageInputHandle>(null);
  const { isDragOver, dropZoneProps } = useFileDropZone((dataTransfer) =>
    composerRef.current?.acceptDrop(dataTransfer),
  );

  const loadFollowUps = useChatStore((s) => s.loadFollowUps);
  const handleFollowUpUpdate = useChatStore((s) => s.handleFollowUpUpdate);
  const setContextUsage = useChatStore((s) => s.setContextUsage);
  const actOnFollowUp = useChatStore((s) => s.actOnFollowUp);

  // URL `?agent=` is the source of truth for the open session. Refresh,
  // browser back/forward, route restore, and direct deep-links all converge
  // here. `selectTab` updates the URL only; an effect below mirrors the URL
  // value into the store for consumers that read it directly.
  const [searchParams, setSearchParams] = useSearchParams();
  const urlAgentId = searchParams.get('agent') || null;
  const mobileSessionsVisible = searchParams.get('sessions') === '1';
  const isPhone = useIsPhone();
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
    },
    [setSearchParams],
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
  const { createSession } = useSessionActions();
  const { startNewConversation, creatingSession } = useNewConversation();
  const renameConversation = useChatStore((s) => s.renameConversation);
  const loadAgentMessages = useChatStore((s) => s.loadAgentMessages);
  const hydrateAgentMessages = useChatStore((s) => s.hydrateAgentMessages);
  const refreshAgentMessages = useChatStore((s) => s.refreshAgentMessages);
  const sendAgentMessage = useChatStore((s) => s.sendAgentMessage);

  // The session shown: the URL's, once it is known to be one of this
  // workspace's conversations.
  const activeAgent = urlAgentId
    ? agents.find((a) => a.id === urlAgentId && a.kind === 'conversation')
    : undefined;
  const sessionId = activeAgent?.id ?? null;
  // The open session's JID: its follow-ups, context usage, composer draft,
  // automations and terminal are keyed by it ('' with none open).
  const sessionJid = sessionId ? sessionJidOf(groupJid, sessionId) : '';
  const queuedFollowUps = useChatStore((s) =>
    sessionJid
      ? (s.followUps[sessionJid] ?? EMPTY_FOLLOW_UPS)
      : EMPTY_FOLLOW_UPS,
  );
  const activeAgentMessages = useChatStore((s) =>
    sessionId ? s.agentMessages[sessionId] : undefined,
  );
  const activeAgentHasMore = useChatStore((s) =>
    sessionId ? !!s.agentHasMore[sessionId] : false,
  );
  const activeAgentWaiting = useChatStore((s) =>
    sessionId
      ? !!s.agentWaiting[sessionId] || isLiveStream(s.agentStreaming[sessionId])
      : false,
  );
  const activeAgentInterrupted = useChatStore((s) =>
    sessionId ? !!s.agentStreaming[sessionId]?.interrupted : false,
  );

  const markChatRead = useChatStore((s) => s.markChatRead);

  const currentUser = useAuthStore((s) => s.user);
  const isGuest = useIsGuest();
  // Guests view granted workspaces only: no composer, terminal, uploads,
  // session changes or workspace configuration.
  const readOnly = isGuest;
  // Each session has its own terminal (Docker workspaces only).
  const canUseTerminal =
    group?.execution_mode !== 'host' && !readOnly && !!sessionId;
  const pollRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const isHome = !!group?.is_home;
  // Workspace config (skills + MCP) write permission. Backend `canModifyGroup`
  // ACL result is propagated via the `can_modify` field; trust it as the
  // single source of truth to avoid frontend/backend divergence.
  const canModifyWorkspaceConfig = !!group?.can_modify && !readOnly;
  const interactionMode = normalizeInteractionMode(group?.interaction_mode);
  const processVisibility = normalizeProcessVisibility(
    group?.process_visibility,
  );

  useEffect(() => {
    if (!canModifyWorkspaceConfig && contextPanelView === 'env') {
      setContextPanelView('files');
    }
  }, [canModifyWorkspaceConfig, contextPanelView]);
  // Git runs only for Host workspaces (see src/routes/git-review.ts). Guests
  // never see diffs: they could show the dot files the file panel hides.
  const canReview = group?.execution_mode === 'host' && !readOnly;
  useEffect(() => {
    if (!canReview && contextPanelView === 'review') {
      setContextPanelView('files');
    }
  }, [canReview, contextPanelView]);

  // Fetch IM connection status for home groups
  const isOwnHome =
    !readOnly &&
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

  // 未读按 Workspace 聚合：打开其中任一会话，都表示用户已经查看当前 Workspace。
  useEffect(() => {
    markChatRead(groupJid);
    const onFocus = () => markChatRead(groupJid);
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [sessionId, groupJid, markChatRead]);

  // Poll the open session for new messages — use setTimeout recursion to
  // avoid request piling up. Pauses when the page is not visible to save
  // resources.
  useEffect(() => {
    if (!sessionId) return;
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
        await refreshAgentMessages(groupJid, sessionId);
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
    // Returning to a session whose messages are cached: catch up at once.
    // Its WS events were ignored while another workspace was open, and the
    // connected cadence would otherwise wait 30s for the first refresh.
    if (useChatStore.getState().agentMessages[sessionId]) void poll();
    else schedulePoll();

    return () => {
      active = false;
      offConnected();
      offDisconnected();
      document.removeEventListener('visibilitychange', handleVisibility);
      if (pollRef.current) clearTimeout(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupJid, sessionId]);

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
      // The open session's messages are caught up by its poll on reconnect.
    });
    return () => {
      unsub();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupJid]);

  // A session with its own worktree works there: files, the @ picker and
  // uploads follow it.
  const activeWorktree = activeAgent?.worktree ?? null;
  const worktreeSessionId = activeWorktree ? sessionId : null;
  const openCreateAutomation = useAutomationsStore((s) => s.openCreateForm);
  useEffect(() => {
    useFileStore.getState().setFileScopeSession(groupJid, worktreeSessionId);
  }, [groupJid, worktreeSessionId]);
  // Memoized so the memoized composer does not re-render with a fresh element.
  const modelSelector = useMemo(
    () =>
      sessionId ? (
        <ModelSelector
          key={sessionId}
          groupJid={groupJid}
          agentId={sessionId}
          canChange={canModifyWorkspaceConfig}
        />
      ) : null,
    [groupJid, sessionId, canModifyWorkspaceConfig],
  );

  // The run's phase and pace, shown above the composer while it runs.
  const statusBar = useMemo(
    () =>
      sessionId ? (
        <RunStatusBar key={sessionId} groupJid={groupJid} agentId={sessionId} />
      ) : null,
    [groupJid, sessionId],
  );
  const contextUsage = useMemo(
    () =>
      sessionId ? (
        <ConversationContextUsage jid={groupJid} agentId={sessionId} />
      ) : null,
    [groupJid, sessionId],
  );
  // A phone's composer has no room for the ring: its ⋯ sheet says how full
  // the context is, from the same store entry the ring and the model
  // sheet read (loaded when the sheet opens, kept current by turn pushes).
  const phoneContextUsage = useChatStore((s) =>
    isPhone && sessionJid ? s.contextUsage[sessionJid] : undefined,
  );
  const loadContextUsage = useChatStore((s) => s.loadContextUsage);
  useEffect(() => {
    if (!headerSheetOpen || readOnly || !sessionId) return;
    if (useChatStore.getState().contextUsage[sessionJid] !== undefined) return;
    void loadContextUsage(groupJid, sessionId);
  }, [
    headerSheetOpen,
    readOnly,
    sessionJid,
    loadContextUsage,
    groupJid,
    sessionId,
  ]);
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
  const currentContextName = activeAgent?.name || '新会话';
  // Loaded and nothing to show yet: the conversation opens on its empty
  // state, with the composer centred between heading and starters on a wide
  // screen with a mouse. A touch screen of any size (a phone, a landscape
  // phone, a tablet) keeps it docked above its software keyboard.
  const emptyConversation =
    !!sessionId &&
    !activeAgentWaiting &&
    !!activeAgentMessages &&
    !activeAgentMessages.some(isMessageVisibleInTimeline);
  const centersEmptyState = useMediaQuery(
    '(min-width: 640px) and (hover: hover) and (pointer: fine)',
  );
  // Read-only viewers have no composer to centre.
  const heroCentered = emptyConversation && centersEmptyState && !readOnly;
  const agentProfileLabel = group?.agent_profile_name
    ? getAgentProfileDisplayName(group.agent_profile_name)
    : group?.is_home
      ? 'HappyClaw'
      : '智能体';
  // Who answers, for the transcript and the empty conversation.
  const agentLook = {
    agentName: agentProfileLabel,
    agentAvatarUrl: group?.agent_profile_avatar_url,
    agentAvatarEmoji: group?.agent_profile_avatar_emoji,
    agentAvatarColor: group?.agent_profile_avatar_color,
  };
  const workspaceDisplayName = group?.is_my_home
    ? agentProfileLabel
    : group?.name;

  // Load the workspace's sessions
  useEffect(() => {
    loadAgents(groupJid);
  }, [groupJid, loadAgents]);

  // Mirror the shown session → store so consumers reading activeAgentTab stay
  // in sync.
  useEffect(() => {
    setActiveAgentTab(groupJid, sessionId);
  }, [sessionId, groupJid, setActiveAgentTab]);

  // Opening a session makes it the one this device returns to, in this
  // workspace and when the app opens.
  const groupFolder = group?.folder;
  useEffect(() => {
    if (sessionId && groupFolder) {
      rememberOpenedSession({ jid: groupJid, folder: groupFolder }, sessionId);
    }
  }, [sessionId, groupJid, groupFolder]);

  // Entering the workspace without a session (`?agent=` absent) opens the one
  // last opened here, else the most recently active one, else (for its owner)
  // a new one. A session that is gone (deleted while shown, or a stale link)
  // gives way to the most recent one, but never makes a new one: the empty
  // state offers that. Guarded by `params.groupFolder` so this doesn't fire
  // when the URL is on the workspace list (mobile back) but ChatView is still
  // mounted with a stale `currentGroup`; the narrow window's session list
  // (`?sessions=1`) picks for itself.
  const params = useParams<{ groupFolder?: string }>();
  const [entryCreating, setEntryCreating] = useState(false);
  // The workspace whose last session went away while it was shown: it stays
  // empty until the user starts a conversation or enters it again.
  const creationHeldFor = useRef<string | null>(null);
  useEffect(() => {
    if (!params.groupFolder || !agentsLoaded || mobileSessionsVisible) return;
    if (sessionId) {
      creationHeldFor.current = null;
      return;
    }
    // A `?agent=` naming no session: it was deleted, or the link is stale.
    const stale = !!urlAgentId;
    if (stale) creationHeldFor.current = groupJid;
    const entry = resolveWorkspaceEntry(
      agents,
      getWorkspaceLastAgent(groupJid),
      canModifyWorkspaceConfig && creationHeldFor.current !== groupJid,
    );
    if (entry.kind === 'open') {
      selectTab(entry.sessionId);
      return;
    }
    if (entry.kind === 'empty') {
      if (stale) selectTab(null);
      return;
    }
    // A rerun or a remount while it is being made joins the same creation.
    setEntryCreating(true);
    void createSession(groupJid)
      .then((created) => {
        if (created && useChatStore.getState().currentGroup === groupJid) {
          selectTab(created.id);
        }
      })
      .finally(() => setEntryCreating(false));
  }, [
    params.groupFolder,
    agentsLoaded,
    mobileSessionsVisible,
    sessionId,
    urlAgentId,
    agents,
    groupJid,
    canModifyWorkspaceConfig,
    createSession,
    selectTab,
  ]);

  // Load the open session's messages.
  // hydrate-then-calibrate: 先把 IndexedDB 快照灌回 store（避免首屏回退），
  // 再走网络以服务端为准。不要用 useEffect cleanup 的 cancelled flag —— hydrate
  // 的 set() 会改 agentMessages 触发 effect 重跑，cleanup 会把上一轮的 cancelled
  // 置 true，导致网络校准被自己取消。改成 hydrate 完成后直接读 store 判断
  // 「用户是否仍停留在这个会话」。
  useEffect(() => {
    if (!sessionId) return;
    if (activeAgentMessages) return;
    const agentId = sessionId;
    void (async () => {
      await hydrateAgentMessages(groupJid, agentId);
      if (useChatStore.getState().activeAgentTab[groupJid] !== agentId) return;
      await loadAgentMessages(groupJid, agentId);
    })();
  }, [
    sessionId,
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
        handleWsNewMessage(groupJid, data.message, data.agentId);
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
      if (!data.agentId) return;
      handleFollowUpUpdate(
        sessionJidOf(groupJid, data.agentId),
        data.items,
        data.transition,
      );
    });
    // How full a session's context is, after each of its turns; kept for
    // every session here, shown or not.
    const unsub6 = wsManager.on('context_usage', (data: any) => {
      if (data.chatJid !== groupJid || !data.agentId) return;
      setContextUsage(groupJid, data.agentId, data);
    });
    // agent_status 已提升到 AppLayout 全局监听
    return () => {
      unsub2();
      unsub3();
      unsub5();
      unsub6();
    };
  }, [groupJid, handleWsNewMessage, handleFollowUpUpdate, setContextUsage]);

  useEffect(() => {
    if (!sessionJid) return;
    void loadFollowUps(sessionJid);
    const unsub = wsManager.on('connected', (data: { reconnect?: boolean }) => {
      if (data?.reconnect) void loadFollowUps(sessionJid);
    });
    return () => {
      unsub();
    };
  }, [sessionJid, loadFollowUps]);

  const [scrollTrigger, setScrollTrigger] = useState(0);

  const handleActiveAgentSend = async (
    content: string,
    attachments?: Array<{ data: string; mimeType: string }>,
    followUpBehavior?: FollowUpMode,
  ) => {
    if (!sessionId) return false;
    const ok = await sendAgentMessage(
      groupJid,
      sessionId,
      content,
      attachments,
      followUpBehavior,
    );
    // 只有发送成功时才触发滚动；失败时保留当前视图位置，避免用户上下文切换。
    if (ok) setScrollTrigger((value) => value + 1);
    return ok;
  };

  // Stable handlers for the memoized transcript and composer: this view also
  // re-renders for dialogs, panels and run status, which must not re-render
  // a long transcript or the composer.
  const loadMoreActiveAgent = useStableCallback(() => {
    if (sessionId) void loadAgentMessages(groupJid, sessionId, true);
  });
  const sendActiveAgent = useStableCallback(handleActiveAgentSend);
  const stopActiveAgent = useStableCallback(() =>
    sessionJid ? interruptQuery(sessionJid) : false,
  );
  const handleFollowUpAction = useStableCallback(
    (item: QueuedFollowUp, action: FollowUpQueueAction, content?: string) =>
      actOnFollowUp(sessionJid, item.id, action, item.delivery_run_id, content),
  );
  const requestResetActiveAgent = useStableCallback(() => {
    setShowResetConfirm(true);
  });

  const handleResetSession = async () => {
    if (!sessionId) return;
    setResetLoading(true);
    const ok = await resetSession(groupJid, sessionId);
    setResetLoading(false);
    setShowResetConfirm(false);
    if (!ok) {
      toast.error('清除上下文失败，请稍后重试');
    }
  };

  // A new conversation here: the blank session it already has, or a new one.
  const startConversationHere = useCallback(
    () => startNewConversation({ target: { jid: groupJid } }),
    [startNewConversation, groupJid],
  );

  // The ⋯ actions of the narrow window's session list, the same as the
  // sidebar's; their dialogs live here.
  const sessionMenuFor = useSessionRowActions(
    { jid: groupJid, can_modify: group?.can_modify },
    {
      onBind: (session) => setBindingAgentId(session.id),
      onRename: (session) =>
        setRenameTarget({ agentId: session.id, name: session.name }),
    },
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

  // The transcript's "show the process" entry opens the workspace settings,
  // which live here with the rest of the workspace's configuration.
  const workspaceSettingsRequest = useShellStore(
    (s) => s.workspaceSettingsRequest,
  );
  const clearWorkspaceSettingsRequest = useShellStore(
    (s) => s.clearWorkspaceSettingsRequest,
  );
  useEffect(() => {
    if (
      !workspaceSettingsRequest ||
      workspaceSettingsRequest.groupJid !== groupJid
    ) {
      return;
    }
    if (canModifyWorkspaceConfig) setShowInteractionModeDialog(true);
    clearWorkspaceSettingsRequest();
  }, [
    workspaceSettingsRequest,
    clearWorkspaceSettingsRequest,
    groupJid,
    canModifyWorkspaceConfig,
  ]);

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

  // Each session has its own terminal: switching sessions or workspaces does
  // not carry the terminal UI into the next one.
  useEffect(() => {
    setTerminalVisible(false);
    setTerminalMounted(false);
    setMobileTerminal(false);
  }, [sessionJid]);

  // If current group is host mode, force-close any mounted terminal.
  useEffect(() => {
    if (canUseTerminal) return;
    setTerminalVisible(false);
    setTerminalMounted(false);
    setMobileTerminal(false);
  }, [canUseTerminal]);

  const handleBackAction = () => {
    // A phone has one list (workspaces with their sessions): back goes
    // straight there. Narrow windows step back to this workspace's sessions.
    if (isPhone && onBack) {
      onBack();
      return;
    }
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
      activeSessionId={sessionId}
      canModify={canModifyWorkspaceConfig}
      isTopicWorkspace={isTopicWorkspace}
      // Same naming as the desktop session tree: the list is titled by its
      // workspace.
      title={group.is_my_home ? agentProfileLabel : group.name}
      onClose={mobile ? onBack : undefined}
      onSelectSession={(id) => {
        selectTab(id);
      }}
      onCreateSession={() => void startConversationHere()}
      isCreatingSession={creatingSession}
      menuFor={sessionMenuFor}
    />
  );

  // Desktop docks the context panel beside the chat; narrower screens open
  // it as a sheet.
  const openContextPanel = (toggle = false) => {
    if (window.matchMedia('(min-width: 1024px)').matches) {
      setPanelOpen((open) => (toggle ? !open : true));
    } else {
      setMobileContextOpen(true);
    }
  };
  const handleContextPanelToggle = () => openContextPanel(true);

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
    ...(canReview
      ? [
          {
            key: 'review',
            icon: GitCompare,
            label: '代码改动',
            current: contextPanelView === 'review',
            chevron: true,
            onClick: () => setContextPanelView('review'),
          },
        ]
      : []),
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
        ) : contextPanelView === 'review' && canReview ? (
          <ReviewPanel groupJid={groupJid} agentId={sessionId} />
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

  const showImBanner =
    isOwnHome &&
    !!imStatus &&
    !Object.values(imStatus).some(Boolean) &&
    !imBannerDismissed;
  // This session's actions, for the composer and the phone's ⋯ sheet.
  const resetCurrent =
    canModifyWorkspaceConfig && sessionId ? requestResetActiveAgent : undefined;
  const toggleTerminal = canUseTerminal ? handleTerminalToggle : undefined;
  const newConversationAction = {
    label: '新对话',
    icon: SquarePen,
    onSelect: () => void startConversationHere(),
  };
  const openWorkspaceSettings = () => setShowInteractionModeDialog(true);
  // The phone header's ⋯ sheet: the workspace, then this session.
  const headerActions: SheetAction[][] = [
    canModifyWorkspaceConfig
      ? [
          newConversationAction,
          {
            label: '工作区设置',
            icon: Settings2,
            onSelect: openWorkspaceSettings,
          },
          {
            label: '渠道绑定',
            icon: Link,
            onSelect: () => setBindingAgentId(WORKSPACE_BINDING),
          },
        ]
      : [],
    [
      ...(canModifyWorkspaceConfig && sessionId
        ? [
            {
              label: '从此会话创建自动化…',
              icon: Timer,
              onSelect: () =>
                openCreateAutomation({
                  workspaceJid: groupJid,
                  targetSessionJid: sessionJid,
                }),
            },
          ]
        : []),
      ...(toggleTerminal
        ? [{ label: '终端', icon: TerminalSquare, onSelect: toggleTerminal }]
        : []),
      ...(resetCurrent
        ? [{ label: '清除上下文', icon: Paintbrush, onSelect: resetCurrent }]
        : []),
    ],
  ];
  // The model and the context, both in the composer's model sheet (whose
  // foot shows the usage). It opens once the ⋯ sheet has closed and given
  // back its history entry (opened alongside, the two raced over it), and
  // once the composer is there: its code may still be loading.
  const openModelSheet = () => {
    const deadline = performance.now() + 3000;
    const clickPill = () => {
      const pill =
        containerRef.current?.querySelector<HTMLElement>('[data-model-pill]');
      if (pill) pill.click();
      else if (performance.now() < deadline) requestAnimationFrame(clickPill);
    };
    const afterClose = () => {
      window.removeEventListener('popstate', afterClose);
      window.clearTimeout(fallback);
      clickPill();
    };
    window.addEventListener('popstate', afterClose);
    const fallback = window.setTimeout(afterClose, 300);
  };
  const contextFigures = contextUsageFigures(phoneContextUsage);
  // The model sheet lives in the composer, which read-only viewers lack.
  if (isPhone && !readOnly && sessionId) {
    headerActions.push([
      { label: '切换模型', icon: Cpu, onSelect: openModelSheet },
      ...(contextFigures
        ? [
            {
              label: contextFigures.label,
              icon: Gauge,
              onSelect: openModelSheet,
            },
          ]
        : []),
    ]);
  }
  const hasHeaderActions = headerActions.some((group) => group.length > 0);
  // The workspace name in the header opens the workspace's menu.
  const workspaceMenu: MenuAction[][] = [
    canModifyWorkspaceConfig ? [newConversationAction] : [],
    [
      {
        label: '文件',
        icon: Folder,
        onSelect: () => {
          setContextPanelView('files');
          openContextPanel();
        },
      },
      ...(canModifyWorkspaceConfig
        ? [{ label: '设置', icon: Settings2, onSelect: openWorkspaceSettings }]
        : []),
    ],
  ];
  // A phone's header controls sit on a translucent round capsule.
  const phoneCapsule =
    'phone:rounded-full phone:border phone:border-surface-border phone:bg-surface-raised/85';
  const phoneHeaderButton =
    'phone:size-10 phone:rounded-full phone:text-foreground';

  return (
    <div
      ref={containerRef}
      data-hc-chat-view
      className="h-full flex overflow-hidden bg-background"
      {...(readOnly ? {} : dropZoneProps)}
    >
      <div
        className={cn(
          'relative min-w-0 flex-1 flex-col phone:[--chat-header-height:3.5rem]',
          mobileSessionsVisible ? 'hidden lg:flex' : 'flex',
          // A phone's header floats over the conversation; the list keeps
          // that much room on top (a banner under it takes it instead).
          !showImBanner && 'phone:[--chat-top-inset:var(--chat-header-height)]',
        )}
      >
        {/* Header. On a phone it is transparent over the conversation, which
            scrolls under a blur that fades out toward its bottom edge. */}
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-surface-border px-4 max-lg:h-13 max-lg:bg-background/80 max-lg:backdrop-blur-xl lg:px-5 phone:absolute phone:inset-x-0 phone:top-0 phone:z-30 phone:h-(--chat-header-height) phone:border-b-0 phone:bg-transparent phone:px-3 phone:backdrop-blur-none phone:before:pointer-events-none phone:before:absolute phone:before:inset-x-0 phone:before:top-0 phone:before:-bottom-4 phone:before:-z-10 phone:before:bg-background/70 phone:before:backdrop-blur-xl phone:before:[mask-image:linear-gradient(to_bottom,black_55%,transparent)]">
          {onBack && (
            <IconButton
              label="返回"
              icon={<ArrowLeft />}
              onClick={handleBackAction}
              hideTooltip
              className={cn(
                '-ml-1.5 pointer-coarse:size-10 lg:hidden phone:ml-0',
                phoneCapsule,
                phoneHeaderButton,
              )}
            />
          )}
          {headerLeft}
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <nav
              aria-label="工作区与会话"
              className="flex min-w-0 items-center gap-1 text-body phone:absolute phone:inset-x-[5.75rem] phone:justify-center phone:text-base phone:leading-[22px] phone:font-semibold"
            >
              <ResponsiveMenu
                title={workspaceDisplayName || '工作区'}
                align="start"
                groups={workspaceMenu}
                trigger={
                  <button
                    type="button"
                    aria-label={`${workspaceDisplayName}的工作区菜单`}
                    className={cn(
                      'max-w-[16rem] shrink-0 cursor-pointer truncate rounded-md px-1.5 py-0.5 font-medium transition-colors hover:bg-surface-hover hover:text-foreground aria-expanded:bg-surface-hover',
                      sessionId
                        ? 'hidden text-muted-foreground sm:block'
                        : 'text-foreground',
                    )}
                  >
                    {workspaceDisplayName}
                  </button>
                }
              />
              {sessionId && (
                <>
                  <ChevronRight
                    className="hidden size-3.5 shrink-0 text-faint-foreground sm:block"
                    aria-hidden="true"
                  />
                  <h2 className="truncate px-1 font-medium text-foreground phone:font-semibold">
                    {currentContextName}
                  </h2>
                  {activeWorktree && (
                    <WorktreeBranchTag
                      worktree={activeWorktree}
                      className="max-w-48 phone:hidden"
                    />
                  )}
                </>
              )}
            </nav>
            <div className="hidden min-w-0 items-center gap-1.5 overflow-hidden md:flex">
              {readOnly && <Badge variant="neutral">只读</Badge>}
              {sessionId && (
                <SessionAutomationBadge
                  sessionJid={sessionJid}
                  generatedBy={activeAgent?.automation_id}
                />
              )}
              {group.execution_mode && (
                <Badge variant="outline">
                  {group.execution_mode === 'host' ? '宿主机' : 'Docker'}
                </Badge>
              )}
              <InfoTip
                content={
                  interactionMode === 'proactive'
                    ? '主动模式：由智能体决定何时发送 0～多条独立消息'
                    : 'Assistant 模式：框架在任务完成后交付一条主回复'
                }
              >
                <Badge
                  variant="outline"
                  dot={interactionMode === 'proactive' ? 'primary' : undefined}
                  aria-label={
                    interactionMode === 'proactive'
                      ? '当前为主动模式'
                      : '当前为 Assistant 模式'
                  }
                >
                  {interactionMode === 'proactive' ? '主动' : 'Assistant'}
                </Badge>
              </InfoTip>
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
          {activeAgentWaiting && (
            <span
              data-testid="chat-run-indicator"
              title="运行中"
              className="inline-flex shrink-0 items-center gap-1.5 px-1 text-caption text-muted-foreground phone:hidden"
            >
              <Spinner className="size-3.5" aria-hidden="true" />
              {/* Phones keep the spinner only; the header has no room. */}
              <span className="max-sm:sr-only">运行中</span>
            </span>
          )}
          {/* A phone keeps files/context and ⋯ in one capsule; the rest of
              the workspace actions move into the ⋯ sheet. */}
          <div
            className={cn(
              'flex shrink-0 items-center gap-0.5 phone:gap-0',
              phoneCapsule,
            )}
          >
            {canModifyWorkspaceConfig && (
              <IconButton
                label="工作区设置"
                icon={<Settings2 />}
                onClick={() => setShowInteractionModeDialog(true)}
                className="text-muted-foreground pointer-coarse:size-10 phone:hidden"
              />
            )}
            {canModifyWorkspaceConfig && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setBindingAgentId(WORKSPACE_BINDING)}
                className="text-muted-foreground pointer-coarse:min-h-10 phone:hidden"
                title="管理工作区话题群绑定"
                aria-label="管理工作区话题群绑定"
              >
                <Link />
                <span className="hidden sm:inline">渠道绑定</span>
              </Button>
            )}
            <IconButton
              label={panelOpen ? '收起上下文面板' : '展开上下文面板'}
              icon={
                <>
                  {panelOpen ? (
                    <PanelRightClose className="phone:hidden" />
                  ) : (
                    <PanelRightOpen className="phone:hidden" />
                  )}
                  <Folder className="hidden phone:block" />
                </>
              }
              onClick={handleContextPanelToggle}
              className={cn(
                'text-muted-foreground pointer-coarse:size-10',
                phoneHeaderButton,
              )}
            />
            {hasHeaderActions && (
              <IconButton
                label="更多选项"
                icon={<MoreHorizontal />}
                onClick={() => setHeaderSheetOpen(true)}
                hideTooltip
                className={cn('hidden phone:inline-flex', phoneHeaderButton)}
              />
            )}
          </div>
        </header>

        {/* Message channel setup hint for home container without channel config */}
        {showImBanner && (
          // Under a phone's floating header, not behind it.
          <div className="flex min-h-9 shrink-0 items-center gap-2 border-b border-surface-border bg-muted/40 px-4 py-1.5 text-caption text-muted-foreground lg:px-5 phone:mt-(--chat-header-height)">
            <Link className="size-3.5 shrink-0 text-primary-text" />
            {isPhone ? (
              // One line on a phone; the channels are a tap away.
              <InfoTip content={IM_BANNER_TEXT}>
                <button
                  type="button"
                  className="min-w-0 flex-1 cursor-pointer truncate text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  未配置消息渠道，无法在 IM 中对话
                </button>
              </InfoTip>
            ) : (
              <span className="min-w-0 flex-1">{IM_BANNER_TEXT}</span>
            )}
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

        {/* The open session's conversation */}
        <div className="flex-1 flex overflow-hidden min-h-0">
          {/* Messages Area */}
          {/* The phone's composer dock floats over this area and publishes
              its height here (--composer-dock-height). */}
          <div
            data-composer-dock-host
            className="relative flex min-w-0 flex-1 flex-col overflow-x-hidden"
          >
            {isDragOver && !readOnly && (
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
            {!sessionId ? (
              // No session open: the workspace has none (a guest sees that,
              // its owner can start one), or one is being chosen or made.
              agentsLoaded &&
              conversationAgents.length === 0 &&
              !entryCreating ? (
                <Empty
                  data-hc-no-session
                  className="min-h-0 flex-1 pt-(--chat-top-inset,0px)"
                >
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <MessagesSquare />
                    </EmptyMedia>
                    <EmptyTitle>暂无会话</EmptyTitle>
                    {canModifyWorkspaceConfig && (
                      <EmptyDescription>
                        开始一个新对话，与 {agentProfileLabel} 协作。
                      </EmptyDescription>
                    )}
                  </EmptyHeader>
                  {canModifyWorkspaceConfig && (
                    <EmptyContent>
                      <Button
                        onClick={() => void startConversationHere()}
                        disabled={creatingSession}
                      >
                        <SquarePen />
                        新对话
                      </Button>
                    </EmptyContent>
                  )}
                </Empty>
              ) : (
                <div
                  role="status"
                  aria-label="正在打开会话"
                  className="flex min-h-0 flex-1 items-center justify-center"
                >
                  <Spinner className="size-5 text-muted-foreground" />
                </div>
              )
            ) : emptyConversation ? (
              // An empty conversation opens on who answers and where to
              // start; on a wide screen the composer sits between them.
              <div
                data-hc-empty-state
                className={cn(
                  'flex w-full flex-col px-4',
                  heroCentered
                    ? 'flex-[2] justify-end pt-8 pb-6'
                    : 'min-h-0 flex-1 overflow-y-auto pt-[calc(1.5rem+var(--chat-top-inset,0px))] pb-[calc(1.5rem+var(--composer-dock-height,0px)+var(--composer-dock-lift,0px))]',
                )}
              >
                {/* Centred while it fits; a short screen scrolls it from
                    the top (justify-center would cut the top off). */}
                <div
                  className={cn(
                    'flex w-full flex-col items-center',
                    !heroCentered && 'my-auto',
                  )}
                >
                  <EmptyConversationHeading
                    sessionLabel={activeAgent?.name || undefined}
                    {...agentLook}
                  />
                  {!heroCentered && !readOnly && (
                    <ConversationStarters className="mt-8 max-w-3xl" />
                  )}
                </div>
              </div>
            ) : (
              <MessageList
                key={`conv-${sessionId}`}
                messages={activeAgentMessages || EMPTY_MESSAGES}
                // Not loaded yet (first visit, or evicted from the message
                // cache).
                loading={activeAgentMessages === undefined}
                hasMore={activeAgentHasMore}
                onLoadMore={loadMoreActiveAgent}
                scrollTrigger={scrollTrigger}
                groupJid={groupJid}
                isWaiting={activeAgentWaiting}
                agentId={sessionId}
                {...agentLook}
                interactionMode={interactionMode}
              />
            )}
            {/* One place in the tree for both layouts, so docking after the
                first message keeps the composer (and what it holds). */}
            {!sessionId ? null : readOnly ? (
              <ReadOnlyComposer
                key={sessionJid}
                notice={GUEST_READ_ONLY_NOTICE}
                queuedFollowUps={queuedFollowUps}
              />
            ) : (
              <MessageInput
                // One instance per conversation: draft and pending
                // attachments never carry over to another session.
                key={sessionJid}
                ref={composerRef}
                layout={heroCentered ? 'centered' : 'docked'}
                draftKey={sessionJid}
                placeholder={`向 ${agentProfileLabel} 发送消息…`}
                onSend={sendActiveAgent}
                groupJid={groupJid}
                isRunning={activeAgentWaiting}
                onStop={activeAgentInterrupted ? undefined : stopActiveAgent}
                queuedFollowUps={queuedFollowUps}
                onFollowUpAction={handleFollowUpAction}
                onResetSession={resetCurrent}
                onToggleTerminal={toggleTerminal}
                modelSelector={modelSelector}
                contextUsage={contextUsage}
                statusBar={statusBar}
              />
            )}
            {heroCentered && (
              <div
                data-hc-empty-state
                className="mx-auto w-full max-w-3xl flex-[3] px-4 pt-6 pb-8 lg:px-6"
              >
                <ConversationStarters />
              </div>
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
                  chatJid={sessionJid}
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
        {/* It opens at half the screen and drags to full (cindy's context
            sheet). Before the detent applies, the height must carry the same
            `data-[side=bottom]` variant as the default it replaces: an
            unvariated `h-[80dvh]` loses on specificity, leaving the sheet at
            `h-auto` — it then grows with the file list and cannot scroll. */}
        <SheetContent
          side="bottom"
          detents
          // Its header, view rows and file toolbar take ~370px: a lower half
          // shows no file at all (an iPhone 14 in Safari gets 372px).
          minHalf={440}
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

      {interactionModeDialogMounted && !readOnly && (
        <WorkspaceInteractionModeDialog
          open={showInteractionModeDialog}
          groupJid={groupJid}
          workspaceName={workspaceDisplayName}
          currentMode={interactionMode}
          currentVisibility={processVisibility}
          onClose={() => setShowInteractionModeDialog(false)}
          onSave={(mode) => updateInteractionMode(groupJid, mode)}
          onSaveVisibility={(visibility) =>
            updateProcessVisibility(groupJid, visibility)
          }
        />
      )}

      {/* Phone: the header's ⋯ sheet */}
      <ActionSheet
        open={headerSheetOpen}
        onOpenChange={setHeaderSheetOpen}
        title="更多选项"
        description="工作区设置与当前会话的操作"
        groups={headerActions}
        data-chat-options-sheet
      />

      {/* Mobile: Terminal sheet */}
      {canUseTerminal && (
        <Sheet
          open={mobileTerminal}
          onOpenChange={(v) => !v && setMobileTerminal(false)}
        >
          <SheetContent
            side="bottom"
            className="gap-0 p-0 data-[side=bottom]:h-[min(85dvh,calc(var(--vvh,100dvh)-3rem))]"
          >
            <SheetHeader className="px-4 pt-4 pb-2">
              <SheetTitle>终端</SheetTitle>
              <SheetDescription className="sr-only">
                使用当前工作区的终端。
              </SheetDescription>
            </SheetHeader>
            <div className="min-h-0 flex-1 overflow-hidden">
              <Suspense fallback={null}>
                <TerminalPanel
                  chatJid={sessionJid}
                  visible
                  onHide={() => setMobileTerminal(false)}
                  onDelete={() => setMobileTerminal(false)}
                />
              </Suspense>
            </div>
          </SheetContent>
        </Sheet>
      )}

      {/* Reset session confirm dialog */}
      <ConfirmDialog
        open={showResetConfirm}
        onClose={() => setShowResetConfirm(false)}
        onConfirm={handleResetSession}
        title="清除上下文"
        message="将清除这个会话的 Claude 上下文并停止它运行中的智能体进程，下次发送消息时将开始全新会话。聊天记录和其他会话不受影响。"
        confirmText="清除"
        confirmVariant="danger"
        loading={resetLoading}
      />

      {/* IM binding dialog */}
      {bindingAgentId && !readOnly && (
        <ImBindingDialog
          open={!!bindingAgentId}
          groupJid={groupJid}
          agentId={bindingAgentId === WORKSPACE_BINDING ? null : bindingAgentId}
          agent={agents.find((a) => a.id === bindingAgentId)}
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
