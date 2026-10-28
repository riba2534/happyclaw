import { useEffect, useMemo, useRef, useState } from 'react';
import {
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import { FolderPlus, Plus, SquarePen } from 'lucide-react';
import { useChatStore } from '../stores/chat';
import { useAuthStore } from '../stores/auth';
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
import {
  lazyBugReportDialog,
  lazyCreateContainerDialog,
} from '../components/common/lazy-dialogs';
import { useOpenedOnce } from '../lib/preloaded-component';
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
import { AccountMenuItems } from '../components/layout/AccountMenu';
import { withBasePath } from '../utils/url';
import { useEdgeSwipe } from '../hooks/useEdgeSwipe';
import { useClearWorkspace } from '../hooks/useClearWorkspace';
import type { GroupEntry } from '../utils/group-utils';
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
const CreateContainerDialog = lazyCreateContainerDialog.Component;

/** Where the phone home list opens a workspace (the `?sessions=1` redirect). */
interface PhoneHomeState {
  revealWorkspace?: string;
}

function revealState(folder: string | undefined): PhoneHomeState {
  return { revealWorkspace: folder };
}

export function ChatPage() {
  const { groupFolder } = useParams<{ groupFolder?: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  // Phones have one list (workspaces with their sessions) instead of the
  // workspace list → session list → chat levels of narrow windows.
  const isPhone = useIsPhone();
  const phoneSessionsLink =
    isPhone && !!groupFolder && searchParams.get('sessions') === '1';
  const showPhoneHome = isPhone && (!groupFolder || phoneSessionsLink);
  // 窄 selector：整 store 订阅会让整个页面跟着流式输出每帧重渲染。
  const groups = useChatStore((s) => s.groups);
  const currentGroup = useChatStore((s) => s.currentGroup);
  const selectGroup = useChatStore((s) => s.selectGroup);
  const loadGroups = useChatStore((s) => s.loadGroups);
  const togglePin = useChatStore((s) => s.togglePin);
  const {
    clearState,
    clearLoading,
    openClear,
    closeClear,
    handleClearConfirm,
  } = useClearWorkspace();
  const [createOpen, setCreateOpen] = useState(false);
  const [createAgentId, setCreateAgentId] = useState<string | null>(null);
  const createMounted = useOpenedOnce(createOpen);
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
  const setDesktopCreateOpen = useShellStore((s) => s.setCreateWorkspaceOpen);
  const hasAnyGroup = agentSections.length > 0;

  // Sync URL param to store selection. No auto-redirect to home container —
  // users land on the welcome screen and choose a container manually.
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
    navigate('/chat', { replace: true, state: revealState(groupFolder) });
  }, [phoneSessionsLink, groupFolder, navigate]);
  const revealFolder = (location.state as PhoneHomeState | null)
    ?.revealWorkspace;

  const activeGroupJid = groupFolder ? routeGroupJid : currentGroup;
  const chatViewRef = useRef<HTMLDivElement>(null);
  const phoneHomeRef = useRef<HTMLDivElement>(null);
  // The conversation just left for the list: the right-edge swipe returns
  // to it, like a browser's forward. Opening anything else replaces it.
  const [forwardFolder, setForwardFolder] = useState<string | null>(null);

  const handleBackToList = () => {
    setForwardFolder(groupFolder ?? null);
    navigate('/chat', { state: revealState(groupFolder) });
  };

  useEdgeSwipe(chatViewRef, { onBack: handleBackToList });
  useEdgeSwipe(
    phoneHomeRef,
    {
      onForward: forwardFolder
        ? () => navigate(`/chat/${forwardFolder}`)
        : undefined,
    },
    { enabled: showPhoneHome },
  );
  useEffect(() => {
    // Forward is only meaningful straight after going back.
    if (groupFolder && !phoneSessionsLink) setForwardFolder(null);
  }, [groupFolder, phoneSessionsLink]);

  const selectMobileWorkspace = (group: GroupEntry) => {
    selectGroup(group.jid);
    navigate(`/chat/${group.folder}?sessions=1`);
  };

  const renameWorkspace = useStableCallback((jid: string, name: string) =>
    setRenameState({ open: true, jid, name }),
  );
  const createAgentWorkspace = useStableCallback((agentId: string) => {
    setCreateAgentId(agentId);
    setCreateOpen(true);
  });
  const openAgent = useStableCallback((agentId: string) =>
    navigate(`/agent-profiles?agent=${encodeURIComponent(agentId)}`),
  );
  const pinWorkspace = useStableCallback((jid: string) => void togglePin(jid));
  const clearWorkspace = useStableCallback(openClear);
  const deleteWorkspace = useStableCallback(openDelete);
  // Workspace row actions of both the phone list and the narrow-window tree.
  const workspaceActions = useMemo<PhoneWorkspaceActions>(
    () => ({
      onRename: renameWorkspace,
      onClearHistory: clearWorkspace,
      onDelete: deleteWorkspace,
      onTogglePin: pinWorkspace,
      onCreateWorkspace: createAgentWorkspace,
      onOpenAgent: openAgent,
    }),
    [
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
  const noWorkspaces = (
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
    <div className="h-full flex bg-background">
      {/* Phone home: one list of workspaces and their sessions, the drawer's
          hamburger on the left and the new-conversation button. */}
      {showPhoneHome && (
        <div
          ref={phoneHomeRef}
          data-hc-phone-home
          className="w-full overflow-y-auto overscroll-y-contain pb-[calc(83px+env(safe-area-inset-bottom,0px))]"
        >
          <header className="glass sticky top-0 z-20 flex h-14 items-center gap-1 px-2">
            <NavDrawerButton />
            <div className="flex min-w-0 flex-1 items-center gap-2 px-1">
              {brand}
            </div>
            <IconButton
              label="新建工作区"
              icon={<FolderPlus className="size-5" />}
              size="icon"
              hideTooltip
              onClick={() => setCreateOpen(true)}
              className="size-11 rounded-full text-foreground"
            />
          </header>
          {hasAnyGroup ? (
            <PhoneWorkspaceList
              primary={agentPartitions.primary}
              custom={agentPartitions.custom}
              actions={workspaceActions}
              reveal={
                revealFolder
                  ? { folder: revealFolder, key: location.key }
                  : null
              }
            />
          ) : loading ? (
            <div className="px-4 pt-4">
              <SkeletonCardList count={6} />
            </div>
          ) : (
            noWorkspaces
          )}
          <NewConversationFab />
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
            <IconButton
              label="新建工作区"
              icon={<Plus />}
              size="icon"
              onClick={() => setCreateOpen(true)}
              className="text-muted-foreground pointer-coarse:size-10"
            />
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

      {/* Chat View - Desktop: visible when active group exists, Mobile: only in detail route */}
      {activeGroupJid ? (
        <div
          ref={chatViewRef}
          className={`${groupFolder && !showPhoneHome ? 'flex-1 min-w-0 h-full overflow-hidden' : 'hidden lg:block flex-1 min-w-0 h-full overflow-hidden'}`}
        >
          {/* Stays mounted behind the phone list so the composer draft,
              pending attachments and scroll position survive going back;
              with the WebSocket up it only polls every 30s. */}
          <ChatView groupJid={activeGroupJid} onBack={handleBackToList} />
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
              从左侧选择一个工作区，或者直接开始新的对话。
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent className="flex-row justify-center">
            <Button
              onClick={() => void startNewConversation()}
              disabled={creatingSession}
            >
              <SquarePen />
              新对话
            </Button>
            <Button
              variant="outline"
              onClick={() => setDesktopCreateOpen(true)}
            >
              <Plus />
              新建工作区
            </Button>
          </EmptyContent>
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
        message={`确认重建工作区「${clearState.name}」吗？这会永久删除全部聊天记录、上下文、所有子对话及其消息、工作目录文件，以及该工作区的全部 Memory（含版本历史、遗忘记录和 HappyClaw 称呼偏好）；Home 还会重置首次唤醒状态。关联定时任务会停止并移入回收站，运行历史保留；持久化目录 (data/extra/) 保留。此操作不可撤销。`}
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
      {createMounted && (
        <CreateContainerDialog
          open={createOpen}
          defaultAgentProfileId={createAgentId}
          onClose={() => {
            setCreateOpen(false);
            setCreateAgentId(null);
          }}
          onCreated={(jid, folder) => {
            selectGroup(jid);
            if (isPhone) navigate('/chat', { state: revealState(folder) });
            else navigate(`/chat/${folder}?sessions=1`);
          }}
        />
      )}
    </div>
  );
}
