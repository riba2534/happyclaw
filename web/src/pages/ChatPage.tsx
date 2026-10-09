import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { UserCog, LogOut, Plus, BarChart3, SquarePen } from 'lucide-react';
import { useChatStore } from '../stores/chat';
import { useAuthStore } from '../stores/auth';
import { ChatView } from '../components/chat/ChatView';
import { DeleteWorkspaceDialog } from '../components/chat/DeleteWorkspaceDialog';
import { WorkspaceTree } from '../components/layout/sidebar/WorkspaceTree';
import { ConfirmDialog } from '../components/common';
import { CreateContainerDialog } from '../components/chat/CreateContainerDialog';
import { RenameDialog } from '../components/chat/RenameDialog';
import { EmojiAvatar } from '../components/common/EmojiAvatar';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { useSwipeBack } from '../hooks/useSwipeBack';
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
  const userInitial = (user?.display_name ||
    user?.username ||
    '?')[0].toUpperCase();

  const routeGroupJid = useMemo(() => {
    if (!groupFolder) return null;
    const entry =
      Object.entries(groups).find(
        ([jid, info]) =>
          info.folder === groupFolder &&
          jid.startsWith('web:') &&
          !!info.is_home,
      ) ||
      Object.entries(groups).find(
        ([jid, info]) => info.folder === groupFolder && jid.startsWith('web:'),
      ) ||
      Object.entries(groups).find(([_, info]) => info.folder === groupFolder);
    return entry?.[0] || null;
  }, [groupFolder, groups]);
  const hasGroups = Object.keys(groups).length > 0;

  // 移动端唯一的工作区列表入口：桌面侧边栏改为条件挂载后，/chat 落地页
  // 不再有其他组件触发 loadGroups（store 内部有 in-flight 去重，桌面端
  // 与侧边栏的并发调用只会发一个请求）。
  useEffect(() => {
    void loadGroups();
  }, [loadGroups]);

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
          {/* Mobile header: horizontal logo + actions */}
          <div className="flex items-center gap-3 px-4 pt-5 pb-3">
            <img
              src={`${import.meta.env.BASE_URL}icons/logo-text.svg`}
              alt={appearance?.appName || 'HappyClaw'}
              className="h-8"
            />
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="grid h-10 w-10 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
              title="新建工作区"
              aria-label="新建工作区"
            >
              <Plus className="h-5 w-5" />
            </button>
            <Popover>
              <PopoverTrigger asChild>
                <button
                  className="rounded-full hover:ring-2 hover:ring-brand-200 transition-all cursor-pointer"
                  aria-label="用户菜单"
                >
                  <EmojiAvatar
                    imageUrl={user?.avatar_url}
                    emoji={user?.avatar_emoji}
                    color={user?.avatar_color}
                    fallbackChar={userInitial}
                    size="md"
                    className="w-8 h-8"
                  />
                </button>
              </PopoverTrigger>
              <PopoverContent side="bottom" align="end" className="w-44 p-1">
                <div className="px-3 py-2 text-xs font-medium text-muted-foreground truncate border-b border-border mb-1">
                  {user?.display_name || user?.username}
                </div>
                <button
                  onClick={() => navigate('/settings?tab=profile')}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md hover:bg-accent text-foreground cursor-pointer"
                >
                  <UserCog className="w-4 h-4" /> 个人设置
                </button>
                <button
                  onClick={() => navigate('/usage')}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md hover:bg-accent text-foreground cursor-pointer"
                >
                  <BarChart3 className="w-4 h-4" /> 用量统计
                </button>
                <button
                  onClick={async () => {
                    await useAuthStore.getState().logout();
                    navigate('/login');
                  }}
                  className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md hover:bg-destructive/10 text-destructive cursor-pointer"
                >
                  <LogOut className="w-4 h-4" /> 退出登录
                </button>
              </PopoverContent>
            </Popover>
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
            <div className="flex flex-col items-center justify-center h-64 px-4">
              <img
                src={`${import.meta.env.BASE_URL}icons/logo-text.svg`}
                alt={appearance?.appName || 'HappyClaw'}
                className="h-12 mb-6"
              />
              <p className="text-muted-foreground text-sm">暂无智能体工作区</p>
            </div>
          )}
        </div>
      )}

      {/* Chat View - Desktop: visible when active group exists, Mobile: only in detail route */}
      {activeGroupJid ? (
        <div
          ref={chatViewRef}
          className={`${groupFolder ? 'flex-1 min-w-0 h-full overflow-hidden' : 'hidden lg:block flex-1 min-w-0 h-full overflow-hidden'}`}
        >
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
      <CreateContainerDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(jid, folder) => {
          selectGroup(jid);
          navigate(`/chat/${folder}?sessions=1`);
        }}
      />
    </div>
  );
}
