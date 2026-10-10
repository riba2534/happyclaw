import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { FolderPlus, Plus, SquarePen } from 'lucide-react';
import { useChatStore } from '../stores/chat';
import { useAuthStore } from '../stores/auth';
import { ChatView } from '../components/chat/ChatView';
import { DeleteWorkspaceDialog } from '../components/chat/DeleteWorkspaceDialog';
import { WorkspaceTree } from '../components/layout/sidebar/WorkspaceTree';
import { ConfirmDialog } from '../components/common';
import { RenameDialog } from '../components/chat/RenameDialog';
import {
  lazyBugReportDialog,
  lazyCreateContainerDialog,
} from '../components/common/lazy-dialogs';
import { useOpenedOnce } from '../lib/preloaded-component';
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
import { useSwipeBack } from '../hooks/useSwipeBack';
import { useClearWorkspace } from '../hooks/useClearWorkspace';
import type { GroupEntry } from '../utils/group-utils';
import { useDeleteWorkspace } from '../hooks/useDeleteWorkspace';
import { useWorkspaceTree } from '../hooks/useWorkspaceTree';
import { useMediaQuery } from '../hooks/useMediaQuery';
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

export function ChatPage() {
  const { groupFolder } = useParams<{ groupFolder?: string }>();
  const navigate = useNavigate();
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
  const isDesktop = useMediaQuery('(min-width: 1024px)');
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

  const activeGroupJid = groupFolder ? routeGroupJid : currentGroup;
  const chatViewRef = useRef<HTMLDivElement>(null);

  const handleBackToList = () => {
    navigate('/chat');
  };

  useSwipeBack(chatViewRef, handleBackToList);

  const selectMobileWorkspace = (group: GroupEntry) => {
    selectGroup(group.jid);
    navigate(`/chat/${group.folder}?sessions=1`);
  };

  return (
    <div className="h-full flex bg-background">
      {/* Mobile workspace list when no group selected */}
      {!groupFolder && (
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
              {appearance?.brandBannerUrl ? (
                <img
                  src={withBasePath(appearance.brandBannerUrl)}
                  alt={appName}
                  className="h-5 max-w-[10rem] min-w-0 object-contain object-left"
                />
              ) : (
                <span className="min-w-0 truncate text-title text-foreground">
                  {appName}
                </span>
              )}
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
                onRename={(jid, name) =>
                  setRenameState({ open: true, jid, name })
                }
                onClearHistory={openClear}
                onDelete={openDelete}
                onTogglePin={(jid) => void togglePin(jid)}
              />
            </div>
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
          )}
        </div>
      )}

      {/* Chat View - Desktop: visible when active group exists, Mobile: only in detail route */}
      {activeGroupJid ? (
        <div
          ref={chatViewRef}
          className={`${groupFolder ? 'flex-1 min-w-0 h-full overflow-hidden' : 'hidden lg:block flex-1 min-w-0 h-full overflow-hidden'}`}
        >
          {/* The phone list view hides this pane; skip mounting it there so
              its message polling and subscriptions don't run unseen. */}
          {(groupFolder || isDesktop) && (
            <ChatView groupJid={activeGroupJid} onBack={handleBackToList} />
          )}
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
          onClose={() => setCreateOpen(false)}
          onCreated={(jid, folder) => {
            selectGroup(jid);
            navigate(`/chat/${folder}?sessions=1`);
          }}
        />
      )}
    </div>
  );
}
