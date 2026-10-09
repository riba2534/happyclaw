import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ChevronsUpDown,
  PanelLeft,
  Plus,
  Search,
  SquarePen,
} from 'lucide-react';
import { useChatStore } from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';
import { useBillingStore } from '../../stores/billing';
import { useShellStore } from '../../stores/shell';
import { useClearWorkspace } from '../../hooks/useClearWorkspace';
import { useDeleteWorkspace } from '../../hooks/useDeleteWorkspace';
import { useNewConversation } from '../../hooks/useNewConversation';
import { useWorkspaceTree } from '../../hooks/useWorkspaceTree';
import { useStableCallback } from '../../hooks/useStableCallback';
import { ConfirmDialog } from '@/components/common';
import { EmojiAvatar } from '../common/EmojiAvatar';
import { BugReportDialog } from '../common/BugReportDialog';
import { IconButton } from '../common/IconButton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { AccountMenuItems } from './AccountMenu';
import { DeleteWorkspaceDialog } from '../chat/DeleteWorkspaceDialog';
import { CreateContainerDialog } from '../chat/CreateContainerDialog';
import { RenameDialog } from '../chat/RenameDialog';
import { SkeletonCardList } from '@/components/common/Skeletons';
import { cn } from '@/lib/utils';
import { SHORTCUTS } from '@/lib/shortcuts';
import { chatHref } from '../../lib/chat-navigation';
import { filterNavItems } from './nav-items';
import { withBasePath } from '../../utils/url';
import { SidebarItem } from './sidebar/SidebarItem';
import { WorkspaceTree } from './sidebar/WorkspaceTree';
import { SessionTreeList } from './sidebar/SessionTreeList';
import { SidebarResizeHandle } from './sidebar/SidebarResizeHandle';
import type { GroupEntry } from '../../utils/group-utils';

/**
 * Desktop app sidebar: brand/account menu, primary actions, page navigation
 * and the workspace → session tree. Collapses to an icon rail (⌘B) and can be
 * resized by dragging its edge.
 */
export function UnifiedSidebar() {
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const asideRef = useRef<HTMLElement>(null);

  const user = useAuthStore((s) => s.user);
  const appearance = useAuthStore((s) => s.appearance);
  const billingEnabled = useBillingStore((s) => s.billingEnabled);
  const width = useShellStore((s) => s.sidebarWidth);
  const collapsed = useShellStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useShellStore((s) => s.toggleSidebar);
  const expandedWorkspaces = useShellStore((s) => s.expandedWorkspaces);
  const setWorkspaceExpanded = useShellStore((s) => s.setWorkspaceExpanded);
  const revealWorkspace = useShellStore((s) => s.revealWorkspace);
  const createOpen = useShellStore((s) => s.createWorkspaceOpen);
  const setCreateOpen = useShellStore((s) => s.setCreateWorkspaceOpen);
  const setPaletteOpen = useShellStore((s) => s.setPaletteOpen);
  const { startNewConversation, creatingSession } = useNewConversation();
  const [showBugReport, setShowBugReport] = useState(false);
  const [renameState, setRenameState] = useState({
    open: false,
    jid: '',
    name: '',
  });

  const appName = appearance?.appName || 'HappyClaw';
  const userInitial = (user?.display_name ||
    user?.username ||
    '?')[0].toUpperCase();
  const navItems = useMemo(
    () => filterNavItems(billingEnabled),
    [billingEnabled],
  );

  // 窄 selector：整 store 订阅会让侧边栏跟着流式输出每帧重渲染。
  const currentGroup = useChatStore((s) => s.currentGroup);
  const selectGroup = useChatStore((s) => s.selectGroup);
  const loading = useChatStore((s) => s.loading);
  const togglePin = useChatStore((s) => s.togglePin);
  const { allGroups, agentSections, agentPartitions } = useWorkspaceTree();
  const {
    clearState,
    clearLoading,
    openClear,
    closeClear,
    handleClearConfirm,
  } = useClearWorkspace();
  const {
    deleteState,
    deleteLoading,
    openDelete,
    closeDelete,
    handleDeleteConfirm,
  } = useDeleteWorkspace({
    onDeleted: () => {
      const nextJid = useChatStore.getState().currentGroup;
      const nextFolder = nextJid
        ? useChatStore.getState().groups[nextJid]?.folder
        : null;
      navigate(nextFolder ? `/chat/${nextFolder}` : '/chat');
    },
  });

  const isChatRoute = location.pathname.startsWith('/chat');
  const activeSessionId = isChatRoute ? searchParams.get('agent') : null;
  const currentGroupJid = isChatRoute ? currentGroup : null;

  // The tree and its rows are memoized; hand them stable callbacks. Opening
  // a workspace expands it because it becomes current, without persisting.
  const selectWorkspace = useStableCallback((group: GroupEntry) => {
    selectGroup(group.jid);
    revealWorkspace(group.jid);
    navigate(chatHref(group.folder));
  });
  const isExpanded = useCallback(
    (group: GroupEntry) =>
      expandedWorkspaces[group.jid] ?? group.jid === currentGroupJid,
    [expandedWorkspaces, currentGroupJid],
  );
  const renameWorkspace = useStableCallback((jid: string, name: string) =>
    setRenameState({ open: true, jid, name }),
  );
  const clearWorkspace = useStableCallback(openClear);
  const deleteWorkspace = useStableCallback(openDelete);
  const pinWorkspace = useStableCallback((jid: string) => togglePin(jid));
  const toggleExpanded = useStableCallback(
    (group: GroupEntry, expanded: boolean) =>
      setWorkspaceExpanded(group.jid, expanded),
  );
  const navigateTo = useStableCallback((to: string) => navigate(to));
  const renderSessions = useStableCallback(
    (group: GroupEntry, sessionId: string | null) => (
      <SessionTreeList
        group={group}
        isCurrent={group.jid === currentGroupJid}
        activeSessionId={sessionId}
        navigate={navigateTo}
      />
    ),
  );

  return (
    <>
      <nav
        ref={asideRef}
        aria-label="主导航"
        data-collapsed={collapsed || undefined}
        style={{ '--sidebar-width': `${width}px` } as CSSProperties}
        className="group/sidebar relative flex h-full w-(--sidebar-width) shrink-0 flex-col bg-sidebar text-sidebar-foreground transition-[width] duration-200 ease-snappy data-[collapsed=true]:w-13 data-[resizing=true]:transition-none"
      >
        {/* Brand / account */}
        <div
          className={cn(
            'flex h-12 shrink-0 items-center gap-1 px-2',
            collapsed && 'justify-center px-0',
          )}
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className={cn(
                  'flex h-8 min-w-0 cursor-pointer items-center gap-2 rounded-md px-1.5 text-left outline-none transition-colors hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/40 aria-expanded:bg-surface-hover',
                  collapsed ? 'w-8 justify-center px-0' : 'flex-1',
                )}
                aria-label={`${appName} 账户菜单`}
              >
                <img
                  src={
                    appearance?.brandIconUrl
                      ? withBasePath(appearance.brandIconUrl)
                      : `${import.meta.env.BASE_URL}icons/icon-192.png`
                  }
                  alt={appName}
                  className="size-5 shrink-0 rounded-[5px] object-cover"
                />
                {!collapsed &&
                  (appearance?.brandBannerUrl ? (
                    <img
                      src={withBasePath(appearance.brandBannerUrl)}
                      alt=""
                      className="h-4.5 max-w-[9rem] min-w-0 object-contain object-left"
                    />
                  ) : (
                    <span className="min-w-0 truncate text-body font-semibold text-foreground">
                      {appName}
                    </span>
                  ))}
                {!collapsed && (
                  <ChevronsUpDown className="ml-auto size-3.5 shrink-0 text-faint-foreground" />
                )}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-60">
              <DropdownMenuLabel className="flex items-center gap-2.5 py-1.5">
                <EmojiAvatar
                  imageUrl={user?.avatar_url}
                  emoji={user?.avatar_emoji}
                  color={user?.avatar_color}
                  fallbackChar={userInitial}
                  size="sm"
                  className="size-7"
                />
                <span className="min-w-0">
                  <span className="block truncate text-body font-medium text-foreground">
                    {user?.display_name || user?.username}
                  </span>
                  <span className="block truncate text-caption font-normal">
                    @{user?.username}
                  </span>
                </span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <AccountMenuItems onReportBug={() => setShowBugReport(true)} />
            </DropdownMenuContent>
          </DropdownMenu>
          {!collapsed && (
            <IconButton
              label="收起侧边栏"
              shortcut={SHORTCUTS.toggleSidebar}
              icon={<PanelLeft />}
              onClick={toggleSidebar}
              className="text-muted-foreground"
            />
          )}
        </div>

        {/* Primary actions + pages */}
        <div className={cn('flex flex-col gap-px px-2', collapsed && 'px-0')}>
          {collapsed && (
            <SidebarItem
              icon={PanelLeft}
              label="展开侧边栏"
              shortcut={SHORTCUTS.toggleSidebar}
              onClick={toggleSidebar}
              collapsed
            />
          )}
          <SidebarItem
            icon={Search}
            label="搜索"
            shortcut={SHORTCUTS.commandPalette}
            shortcutAlwaysVisible
            onClick={() => setPaletteOpen(true)}
            collapsed={collapsed}
          />
          <SidebarItem
            icon={SquarePen}
            label="新对话"
            shortcut={SHORTCUTS.newConversation}
            onClick={() => void startNewConversation()}
            disabled={creatingSession}
            collapsed={collapsed}
          />
          <div className="my-1.5" />
          {navItems.map(({ path, icon, label }) => (
            <SidebarItem
              key={path}
              icon={icon}
              label={label}
              to={path}
              active={location.pathname.startsWith(path)}
              collapsed={collapsed}
            />
          ))}
        </div>

        {/* Workspace tree */}
        <div
          className={cn(
            'mt-4 flex min-h-0 flex-1 flex-col',
            collapsed && 'invisible',
          )}
          aria-hidden={collapsed || undefined}
          inert={collapsed || undefined}
        >
          <div className="flex h-7 shrink-0 items-center justify-between pr-2 pl-4">
            <span className="text-caption font-medium text-muted-foreground">
              工作区
            </span>
            <IconButton
              label="新建工作区"
              icon={<Plus />}
              size="icon-xs"
              onClick={() => setCreateOpen(true)}
              className="text-muted-foreground"
            />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-3">
            {loading && allGroups.length === 0 ? (
              <SkeletonCardList count={6} compact />
            ) : agentSections.length === 0 ? (
              <p className="px-2 py-6 text-center text-caption text-muted-foreground">
                暂无智能体工作区
              </p>
            ) : (
              <WorkspaceTree
                variant="sidebar"
                primary={agentPartitions.primary}
                custom={agentPartitions.custom}
                currentGroupJid={currentGroupJid}
                activeSessionId={activeSessionId}
                onSelect={selectWorkspace}
                onRename={renameWorkspace}
                onClearHistory={clearWorkspace}
                onDelete={deleteWorkspace}
                onTogglePin={pinWorkspace}
                isExpanded={isExpanded}
                onToggleExpanded={toggleExpanded}
                renderSessions={renderSessions}
              />
            )}
          </div>
        </div>

        <SidebarResizeHandle targetRef={asideRef} />
      </nav>

      <BugReportDialog
        open={showBugReport}
        onClose={() => setShowBugReport(false)}
      />
      <CreateContainerDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(jid, folder) => {
          selectGroup(jid);
          revealWorkspace(jid);
          navigate(`/chat/${folder}`);
        }}
      />
      <RenameDialog
        open={renameState.open}
        jid={renameState.jid}
        currentName={renameState.name}
        onClose={() => setRenameState({ open: false, jid: '', name: '' })}
      />
      <ConfirmDialog
        open={clearState.open}
        onClose={closeClear}
        onConfirm={handleClearConfirm}
        title="重建工作区"
        message={`确认重建「${clearState.name}」？会永久删除全部聊天记录、上下文、所有子对话及其消息、工作目录文件，以及该工作区的全部 Memory（含版本历史、遗忘记录和 HappyClaw 称呼偏好）；Home 还会重置首次唤醒状态。关联定时任务会停止并移入回收站，运行历史与持久化目录 (data/extra/) 保留。不可撤销。`}
        confirmText="确认重建"
        confirmVariant="danger"
        loading={clearLoading}
      />
      <DeleteWorkspaceDialog
        state={deleteState}
        onClose={closeDelete}
        onConfirm={handleDeleteConfirm}
        loading={deleteLoading}
      />
    </>
  );
}
