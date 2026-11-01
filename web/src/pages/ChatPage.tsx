import { PhoneBarButton } from '../components/layout/PhonePageHeader';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import { FolderPlus, Plus, SquarePen } from 'lucide-react';
import { useChatStore } from '../stores/chat';
import { useAuthStore, useIsGuest } from '../stores/auth';
import { ChatView } from '../components/chat/ChatView';
import { DeleteWorkspaceDialog } from '../components/chat/DeleteWorkspaceDialog';
import { WorkspaceTree } from '../components/layout/sidebar/WorkspaceTree';
import {
  PhoneWorkspaceList,
  type PhoneWorkspaceActions,
} from '../components/layout/sidebar/PhoneWorkspaceList';
import { NavDrawerButton } from '../components/layout/NavDrawer';
import { NewConversationFab } from '../components/layout/NewConversationFab';
import { useIsPhone } from '../components/layout/phone';
import { ConfirmDialog } from '../components/common';
import { RenameDialog } from '../components/chat/RenameDialog';
import { lazyBugReportDialog } from '../components/common/lazy-dialogs';
import { preloadWhenIdle, useOpenedOnce } from '../lib/preloaded-component';
import { preloadMessageInput } from '../components/chat/LazyMessageInput';
import { useStableCallback } from '../hooks/useStableCallback';
import { SkeletonCardList } from '../components/common/Skeletons';
import { findRouteGroupJid } from '../lib/route-workspace';
import { EmojiAvatar } from '../components/common/EmojiAvatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { IconButton } from '../components/common/IconButton';
import { EmptyState } from '../components/common/EmptyState';
import { AccountMenuItems, GuestBadge } from '../components/layout/AccountMenu';
import { withBasePath } from '../utils/url';
import { useSwipeBack } from '../hooks/useSwipeBack';
import { useClearWorkspace } from '../hooks/useClearWorkspace';
import type { GroupEntry } from '../utils/group-utils';
import {
  hasAppEntryBefore,
  openWorkspaceSession,
} from '../lib/chat-navigation';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { resolveLanding } from '../lib/session-entry';
import { getLastOpenedSession } from '../utils/workspaceLastAgent';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { useDeleteWorkspace } from '../hooks/useDeleteWorkspace';
import { useWorkspaceTree } from '../hooks/useWorkspaceTree';
import { useNewConversation } from '../hooks/useNewConversation';
import { useShellStore } from '../stores/shell';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';

const BugReportDialog = lazyBugReportDialog.Component;

/** One landing at a time (React runs a mount effect twice in development). */
let landingInFlight = false;

export function ChatPage() {
  const { groupFolder } = useParams<{ groupFolder?: string }>();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Phones have one list (workspaces with their sessions) instead of the
  // workspace list → session list → chat levels of narrow windows.
  const isPhone = useIsPhone();
  // The phone home renders without the editor; fetch it once the list is
  // idle so the first conversation opened has its composer ready.
  useEffect(() => {
    if (!isPhone) return;
    return preloadWhenIdle(preloadMessageInput);
  }, [isPhone]);
  const phoneSessionsLink =
    isPhone && !!groupFolder && searchParams.get('sessions') === '1';
  // On a phone the home list stays mounted under an open conversation, so
  // going back finds it where it was (scroll, 显示更多) and a swipe back
  // shows it under the finger.
  const phoneChatOpen = isPhone && !!groupFolder && !phoneSessionsLink;
  // 窄 selector：整 store 订阅会让整个页面跟着流式输出每帧重渲染。
  const groups = useChatStore((s) => s.groups);
  const currentGroup = useChatStore((s) => s.currentGroup);
  const selectGroup = useChatStore((s) => s.selectGroup);
  const loadGroups = useChatStore((s) => s.loadGroups);
  const togglePin = useChatStore((s) => s.togglePin);
  const {
    clearState,
    clearMessage,
    clearLoading,
    openClear,
    closeClear,
    handleClearConfirm,
  } = useClearWorkspace();
  const [renameState, setRenameState] = useState({
    open: false,
    jid: '',
    name: '',
  });
  const {
    deleteState,
    deleteLoading,
    openDelete,
    closeDelete,
    handleDeleteConfirm,
  } = useDeleteWorkspace({
    onDeleted: () => navigate('/chat', { replace: true }),
  });
  const user = useAuthStore((s) => s.user);
  const isGuest = useIsGuest();
  const appearance = useAuthStore((s) => s.appearance);
  const appName = appearance?.appName || 'HappyClaw';
  const [showBugReport, setShowBugReport] = useState(false);
  const bugReportMounted = useOpenedOnce(showBugReport);
  const userInitial = (user?.display_name ||
    user?.username ||
    '?')[0].toUpperCase();

  const routeGroupJid = useMemo(
    () => (groupFolder ? findRouteGroupJid(groups, groupFolder) : null),
    [groupFolder, groups],
  );
  const hasGroups = Object.keys(groups).length > 0;

  // The workspace list is loaded once by AppLayout for every route and kept
  // fresh over WebSocket, so returning to /chat does not refetch it.

  // Mobile and desktop share the same Agent-first navigation contract.
  const { agentSections, agentPartitions } = useWorkspaceTree();
  const { startNewConversation, creatingSession } = useNewConversation();
  // One create-workspace dialog for the app, hosted by AppLayout.
  const setCreateOpen = useShellStore((s) => s.setCreateWorkspaceOpen);
  const revealOnPhoneHome = useShellStore((s) => s.revealOnPhoneHome);
  const hasAnyGroup = agentSections.length > 0;

  // Sync URL param to store selection.
  useEffect(() => {
    if (!groupFolder) return;
    if (routeGroupJid && currentGroup !== routeGroupJid) {
      selectGroup(routeGroupJid);
      return;
    }
    if (hasGroups && !routeGroupJid) {
      // Group not found — may be newly created (task workspace). Retry once after refresh.
      loadGroups().then(() => {
        const freshGroups = useChatStore.getState().groups;
        const found = Object.entries(freshGroups).find(
          ([jid, info]) =>
            info.folder === groupFolder && jid.startsWith('web:'),
        );
        if (found) {
          selectGroup(found[0]);
        } else {
          navigate('/chat', { replace: true });
        }
      });
    }
  }, [
    groupFolder,
    routeGroupJid,
    hasGroups,
    currentGroup,
    selectGroup,
    navigate,
    loadGroups,
  ]);

  // The session list level is the home list on phones: open the workspace
  // there instead. The list renders at once, so the redirect never shows
  // ChatView's own session list.
  useEffect(() => {
    if (!phoneSessionsLink || !groupFolder) return;
    revealOnPhoneHome(groupFolder);
    navigate('/chat', { replace: true });
  }, [phoneSessionsLink, groupFolder, navigate, revealOnPhoneHome]);

  // Opening the app (`/chat`) on a desktop lands in a session: the one last
  // opened on this device while it exists, else Home's most recently active,
  // else a new one in Home. Narrow windows and phones show their lists.
  const isDesktop = useMediaQuery('(min-width: 1024px)');
  const landing = !groupFolder && isDesktop;
  // Each visit of `/chat` lands once (it may end on the welcome screen).
  const locationKey = useLocation().key;
  const [landedAt, setLandedAt] = useState<string | null>(null);
  const landed = landedAt === locationKey;
  useEffect(() => {
    if (!landing || !hasGroups || landingInFlight || landed) return;
    landingInFlight = true;
    void (async () => {
      try {
        const state = useChatStore.getState();
        const last = getLastOpenedSession();
        const lastJid = last
          ? findRouteGroupJid(state.groups, last.folder)
          : null;
        const homeJid =
          Object.entries(state.groups).find(([, g]) => g.is_my_home)?.[0] ??
          null;
        await Promise.all(
          [...new Set([lastJid, homeJid])].flatMap((jid) =>
            jid ? [state.loadAgents(jid)] : [],
          ),
        );
        const loaded = useChatStore.getState();
        const target = resolveLanding({
          last:
            last && lastJid
              ? { jid: lastJid, sessionId: last.sessionId }
              : null,
          homeJid,
          sessionsOf: (jid) => loaded.agents[jid] ?? [],
        });
        if (target.kind === 'open') {
          openWorkspaceSession(
            navigate,
            { jid: target.jid, folder: loaded.groups[target.jid].folder },
            target.sessionId,
            { replace: true },
          );
        } else if (target.kind === 'create') {
          await startNewConversation({
            target: { jid: target.jid },
            replace: true,
          });
        }
      } finally {
        landingInFlight = false;
        setLandedAt(locationKey);
      }
    })();
  }, [landing, hasGroups, landed, locationKey, navigate, startNewConversation]);

  const activeGroupJid = groupFolder ? routeGroupJid : null;
  const chatViewRef = useRef<HTMLDivElement>(null);
  const phoneHomeRef = useRef<HTMLDivElement>(null);

  // A phone steps back to where the conversation was opened from, without
  // stacking another list entry; opened directly, it lands on the list
  // with this workspace in view. Narrow windows keep their list level.
  const handleBackToList = useStableCallback(() => {
    if (!isPhone) {
      navigate('/chat');
      return;
    }
    if (hasAppEntryBefore()) {
      navigate(-1);
      return;
    }
    if (groupFolder) revealOnPhoneHome(groupFolder);
    navigate('/chat', { replace: true });
  });

  useSwipeBack(chatViewRef, handleBackToList, {
    underlayRef: phoneHomeRef,
    enabled: phoneChatOpen && !!activeGroupJid,
  });

  const selectMobileWorkspace = (group: GroupEntry) => {
    selectGroup(group.jid);
    navigate(`/chat/${group.folder}?sessions=1`);
  };

  const renameWorkspace = useStableCallback((jid: string, name: string) =>
    setRenameState({ open: true, jid, name }),
  );
  const createAgentWorkspace = useStableCallback((agentId: string) =>
    setCreateOpen(true, agentId),
  );
  const openAgent = useStableCallback((agentId: string) =>
    navigate(`/agent-profiles?agent=${encodeURIComponent(agentId)}`),
  );
  const pinWorkspace = useStableCallback((jid: string) => void togglePin(jid));
  const clearWorkspace = useStableCallback(openClear);
  const deleteWorkspace = useStableCallback(openDelete);
  // Workspace row actions of both the phone list and the narrow-window tree.
  // Guests only browse: no rename, delete, pin, new workspace or agent links
  // (rebuild and new sessions already follow the row's can_modify).
  const workspaceActions = useMemo<PhoneWorkspaceActions>(
    () =>
      isGuest
        ? { onClearHistory: clearWorkspace }
        : {
            onRename: renameWorkspace,
            onClearHistory: clearWorkspace,
            onDelete: deleteWorkspace,
            onTogglePin: pinWorkspace,
            onCreateWorkspace: createAgentWorkspace,
            onOpenAgent: openAgent,
          },
    [
      isGuest,
      renameWorkspace,
      clearWorkspace,
      deleteWorkspace,
      pinWorkspace,
      createAgentWorkspace,
      openAgent,
    ],
  );
  const loading = useChatStore((s) => s.loading);

  const brand = appearance?.brandBannerUrl ? (
    <img
      src={withBasePath(appearance.brandBannerUrl)}
      alt={appName}
      className="h-5 max-w-[10rem] min-w-0 object-contain object-left"
    />
  ) : (
    <span className="min-w-0 truncate text-title text-foreground">
      {appName}
    </span>
  );
  const noWorkspaces = isGuest ? (
    <EmptyState
      icon={FolderPlus}
      title="暂无可查看的工作区"
      description="账户创建者授权工作区后，就会显示在这里。"
    />
  ) : (
    <EmptyState
      icon={FolderPlus}
      title="暂无智能体工作区"
      description="新建一个工作区，开始和智能体协作。"
      action={
        <Button onClick={() => setCreateOpen(true)}>
          <Plus />
          新建工作区
        </Button>
      }
    />
  );

  return (
    <div className={cn('h-full flex bg-background', isPhone && 'relative')}>
      {/* Phone home: one list of workspaces and their sessions, the drawer's
          hamburger on the left and the new-conversation button. Under an
          open conversation it is hidden and inert but keeps its layout, so
          its scroll position survives. */}
      {isPhone && (
        <div
          ref={phoneHomeRef}
          data-hc-phone-home
          inert={phoneChatOpen}
          className={cn(
            'absolute inset-0 overflow-y-auto overscroll-y-contain pb-[calc(83px+env(safe-area-inset-bottom,0px))]',
            phoneChatOpen && 'invisible',
          )}
        >
          <header className="sticky top-0 z-20 flex h-14 items-center gap-1 bg-background/85 px-2 backdrop-blur-xl">
            <NavDrawerButton />
            <div className="flex min-w-0 flex-1 items-center gap-2 px-1">
              {brand}
            </div>
            {isGuest ? (
              <GuestBadge className="mr-2" />
            ) : (
              <PhoneBarButton
                label="新建工作区"
                icon={<FolderPlus className="size-5" />}
                onClick={() => setCreateOpen(true)}
              />
            )}
          </header>
          {hasAnyGroup ? (
            <PhoneWorkspaceList
              primary={agentPartitions.primary}
              custom={agentPartitions.custom}
              actions={workspaceActions}
              paused={phoneChatOpen}
            />
          ) : loading ? (
            <div className="px-4 pt-4">
              <SkeletonCardList count={6} />
            </div>
          ) : (
            noWorkspaces
          )}
          {!isGuest && <NewConversationFab />}
        </div>
      )}

      {/* Narrow-window workspace list when no group selected */}
      {!groupFolder && !isPhone && (
        <div className="block lg:hidden w-full overflow-y-auto">
          {/* Mobile header: brand + new workspace + account menu */}
          <div className="flex h-14 items-center gap-2 px-4">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <img
                src={
                  appearance?.brandIconUrl
                    ? withBasePath(appearance.brandIconUrl)
                    : `${import.meta.env.BASE_URL}icons/icon-192.png`
                }
                alt=""
                className="size-6 shrink-0 rounded-md object-cover"
              />
              {brand}
            </div>
            {isGuest ? (
              <GuestBadge />
            ) : (
              <IconButton
                label="新建工作区"
                icon={<Plus />}
                size="icon"
                onClick={() => setCreateOpen(true)}
                className="text-muted-foreground pointer-coarse:size-10"
              />
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  aria-label="用户菜单"
                  className="grid size-10 cursor-pointer place-items-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                >
                  <EmojiAvatar
                    imageUrl={user?.avatar_url}
                    emoji={user?.avatar_emoji}
                    color={user?.avatar_color}
                    fallbackChar={userInitial}
                    size="md"
                    className="size-8"
                  />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="truncate">
                  {user?.display_name || user?.username}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <AccountMenuItems
                  inlineAppearance
                  showUsage
                  onReportBug={() => setShowBugReport(true)}
                />
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {hasAnyGroup ? (
            <div className="px-2 pb-nav-safe">
              <WorkspaceTree
                variant="mobile"
                primary={agentPartitions.primary}
                custom={agentPartitions.custom}
                currentGroupJid={currentGroup}
                onSelect={selectMobileWorkspace}
                {...workspaceActions}
              />
            </div>
          ) : (
            noWorkspaces
          )}
        </div>
      )}

      {/* Phone: the open conversation, over the home list. */}
      {phoneChatOpen && activeGroupJid && (
        <div
          ref={chatViewRef}
          className="absolute inset-0 z-10 overflow-hidden bg-background"
        >
          <ChatView groupJid={activeGroupJid} onBack={handleBackToList} />
        </div>
      )}

      {/* Chat View - Desktop: visible when active group exists, narrow
          windows: only in the detail route. */}
      {isPhone ? null : activeGroupJid ? (
        <div
          className={`${groupFolder ? 'flex-1 min-w-0 h-full overflow-hidden' : 'hidden lg:block flex-1 min-w-0 h-full overflow-hidden'}`}
        >
          <ChatView groupJid={activeGroupJid} onBack={handleBackToList} />
        </div>
      ) : landing && (!landed || loading) ? (
        <div
          role="status"
          aria-label="正在打开会话"
          className="hidden flex-1 items-center justify-center lg:flex"
        >
          <Spinner className="size-5 text-muted-foreground" />
        </div>
      ) : (
        <Empty className="hidden flex-1 lg:flex">
          <EmptyHeader>
            <EmptyMedia>
              <img
                src={`${import.meta.env.BASE_URL}icons/icon-192.png`}
                alt=""
                className="size-12 rounded-xl"
              />
            </EmptyMedia>
            <EmptyTitle className="text-title">
              欢迎使用 {appearance?.appName || 'HappyClaw'}
            </EmptyTitle>
            <EmptyDescription>
              {isGuest
                ? '从左侧选择一个工作区，查看其中的对话。'
                : '从左侧选择一个工作区，或者直接开始新的对话。'}
            </EmptyDescription>
          </EmptyHeader>
          {!isGuest && (
            <EmptyContent className="flex-row justify-center">
              <Button
                onClick={() => void startNewConversation()}
                disabled={creatingSession}
              >
                <SquarePen />
                新对话
              </Button>
              <Button variant="outline" onClick={() => setCreateOpen(true)}>
                <Plus />
                新建工作区
              </Button>
            </EmptyContent>
          )}
        </Empty>
      )}
      {bugReportMounted && (
        <BugReportDialog
          open={showBugReport}
          onClose={() => setShowBugReport(false)}
        />
      )}
      <ConfirmDialog
        open={clearState.open}
        onClose={closeClear}
        onConfirm={handleClearConfirm}
        title="重建工作区"
        message={clearMessage}
        confirmText="确认重建"
        cancelText="取消"
        confirmVariant="danger"
        loading={clearLoading}
      />
      <RenameDialog
        open={renameState.open}
        jid={renameState.jid}
        currentName={renameState.name}
        onClose={() => setRenameState({ open: false, jid: '', name: '' })}
      />
      <DeleteWorkspaceDialog
        state={deleteState}
        onClose={closeDelete}
        onConfirm={handleDeleteConfirm}
        loading={deleteLoading}
      />
    </div>
  );
}
