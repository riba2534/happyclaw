import { useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Plus, UserCog, LogOut } from 'lucide-react';
import { useChatStore } from '../stores/chat';
import { useAuthStore } from '../stores/auth';
import { useGroupsStore } from '../stores/groups';
import { ChatView } from '../components/chat/ChatView';
import { ChatGroupItem } from '../components/chat/ChatGroupItem';
import { ConfirmDialog } from '../components/common';
import { CreateContainerDialog } from '../components/chat/CreateContainerDialog';
import { EmojiAvatar } from '../components/common/EmojiAvatar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useSwipeBack } from '../hooks/useSwipeBack';
import { useClearWorkspace } from '../hooks/useClearWorkspace';
import { type GroupEntry, compareByLastActivity, groupByDate } from '../utils/group-utils';

export function ChatPage() {
  const { groupFolder } = useParams<{ groupFolder?: string }>();
  const navigate = useNavigate();
  const { groups, currentGroup, selectGroup, loadGroups } = useChatStore();
  const { clearState, clearLoading, openClear, closeClear, handleClearConfirm } = useClearWorkspace();
  const [createOpen, setCreateOpen] = useState(false);
  const user = useAuthStore((s) => s.user);
  const appearance = useAuthStore((s) => s.appearance);
  const userInitial = (user?.display_name || user?.username || '?')[0].toUpperCase();

  const routeGroupJid = useMemo(() => {
    if (!groupFolder) return null;
    const entry =
      Object.entries(groups).find(
        ([jid, info]) =>
          info.folder === groupFolder && jid.startsWith('web:') && !!info.is_home,
      ) ||
      Object.entries(groups).find(
        ([jid, info]) => info.folder === groupFolder && jid.startsWith('web:'),
      ) ||
      Object.entries(groups).find(([_, info]) => info.folder === groupFolder);
    return entry?.[0] || null;
  }, [groupFolder, groups]);
  const runnerStates = useGroupsStore((s) => s.runnerStates);
  const hasGroups = Object.keys(groups).length > 0;

  // Build categorized group lists for mobile view (mirrors UnifiedSidebar)
  const { mainGroup, pinnedGroups, mySections, collabSections } = useMemo(() => {
    let main: GroupEntry | null = null;
    const others: GroupEntry[] = [];
    for (const [jid, info] of Object.entries(groups)) {
      const entry = { jid, ...info };
      if (info.is_my_home) main = entry;
      else others.push(entry);
    }
    others.sort(compareByLastActivity);
    const pinned: GroupEntry[] = [];
    const my: GroupEntry[] = [];
    const collab: GroupEntry[] = [];
    others.forEach((g) => {
      if (g.pinned_at) pinned.push(g);
      else if (g.is_shared && (g.member_count ?? 0) >= 2) collab.push(g);
      else my.push(g);
    });
    pinned.sort((a, b) => (a.pinned_at || '').localeCompare(b.pinned_at || ''));
    return { mainGroup: main, pinnedGroups: pinned, mySections: groupByDate(my), collabSections: groupByDate(collab) };
  }, [groups]);
  const hasAnyGroup = mainGroup || pinnedGroups.length > 0 || mySections.length > 0 || collabSections.length > 0;

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
          ([jid, info]) => info.folder === groupFolder && jid.startsWith('web:'),
        );
        if (found) {
          selectGroup(found[0]);
        } else {
          navigate('/chat', { replace: true });
        }
      });
    }
  }, [groupFolder, routeGroupJid, hasGroups, currentGroup, selectGroup, navigate, loadGroups]);

  const activeGroupJid = groupFolder ? routeGroupJid : currentGroup;
  const chatViewRef = useRef<HTMLDivElement>(null);

  const handleBackToList = () => {
    navigate('/chat');
  };

  useSwipeBack(chatViewRef, handleBackToList);

  return (
    <div className="h-full flex bg-muted/30">
      {/* Mobile workspace list when no group selected */}
      {!groupFolder && (
        <div className="block lg:hidden w-full overflow-y-auto">
          {/* Mobile header: horizontal logo + actions */}
          <div className="flex items-center gap-3 px-4 pt-5 pb-3">
            <img src={`${import.meta.env.BASE_URL}icons/logo-text.svg`} alt={appearance?.appName || 'HappyClaw'} className="h-8" />
            <div className="flex-1" />
            <button
              onClick={() => setCreateOpen(true)}
              className="w-9 h-9 rounded-lg flex items-center justify-center hover:bg-accent text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
              aria-label="新工作区"
            >
              <Plus className="w-5 h-5" />
            </button>
            <Popover>
              <PopoverTrigger asChild>
                <button className="rounded-full hover:ring-2 hover:ring-brand-200 transition-all cursor-pointer" aria-label="用户菜单">
                  <EmojiAvatar emoji={user?.avatar_emoji} color={user?.avatar_color} fallbackChar={userInitial} size="md" className="w-8 h-8" />
                </button>
              </PopoverTrigger>
              <PopoverContent side="bottom" align="end" className="w-44 p-1">
                <div className="px-3 py-2 text-xs font-medium text-muted-foreground truncate border-b border-border mb-1">{user?.display_name || user?.username}</div>
                <button onClick={() => navigate('/settings?tab=profile')} className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md hover:bg-accent text-foreground cursor-pointer">
                  <UserCog className="w-4 h-4" /> 个人设置
                </button>
                <button onClick={async () => { await useAuthStore.getState().logout(); navigate('/login'); }} className="w-full flex items-center gap-2 px-3 py-2 text-sm rounded-md hover:bg-destructive/10 text-destructive cursor-pointer">
                  <LogOut className="w-4 h-4" /> 退出登录
                </button>
              </PopoverContent>
            </Popover>
          </div>
          {hasAnyGroup ? (
            <div className="px-2 pb-nav-safe">
              {/* 主工作区 */}
              {mainGroup && (
                <div className="mb-1">
                  <div className="px-2 pt-1 pb-1">
                    <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">主工作区</span>
                  </div>
                  <ChatGroupItem
                    jid={mainGroup.jid} name={mainGroup.name} folder={mainGroup.folder}
                    lastMessage={mainGroup.lastMessage}
                    isActive={currentGroup === mainGroup.jid} isHome
                    isRunning={runnerStates[mainGroup.jid] === 'running'} canModify={mainGroup.can_modify}
                    onSelect={(jid, folder) => { selectGroup(jid); navigate(`/chat/${folder}`); }}
                    onClearHistory={openClear}
                  />
                </div>
              )}
              {/* 已固定 */}
              {pinnedGroups.length > 0 && (
                <div className="mb-1">
                  <div className="px-2 pt-2 pb-1">
                    <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">已固定</span>
                  </div>
                  {pinnedGroups.map((g) => (
                    <ChatGroupItem
                      key={g.jid} jid={g.jid} name={g.name} folder={g.folder}
                      lastMessage={g.lastMessage}
                      isActive={currentGroup === g.jid} isHome={false} isPinned
                      isRunning={runnerStates[g.jid] === 'running'}
                      canModify={g.can_modify}
                      onSelect={(jid, folder) => { selectGroup(jid); navigate(`/chat/${folder}`); }}
                      onClearHistory={openClear}
                    />
                  ))}
                </div>
              )}
              {/* 我的工作区 */}
              {mySections.length > 0 && (
                <div className="mb-1">
                  <div className="px-2 pt-2 pb-1">
                    <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">我的工作区</span>
                  </div>
                  {mySections.map((section) => (
                    <div key={section.label} className="mb-1">
                      <div className="px-2 pt-1 pb-1">
                        <span className="text-[10px] text-muted-foreground/70 tracking-wide">{section.label}</span>
                      </div>
                      {section.items.map((g) => (
                        <ChatGroupItem
                          key={g.jid} jid={g.jid} name={g.name} folder={g.folder}
                          lastMessage={g.lastMessage}
                          isActive={currentGroup === g.jid} isHome={false}
                          isRunning={runnerStates[g.jid] === 'running'}
                          canModify={g.can_modify}
                          onSelect={(jid, folder) => { selectGroup(jid); navigate(`/chat/${folder}`); }}
                          onClearHistory={openClear}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              )}
              {/* 协作工作区 */}
              {collabSections.length > 0 && (
                <div className="mb-1">
                  <div className="px-2 pt-2 pb-1">
                    <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">协作工作区</span>
                  </div>
                  {collabSections.map((section) => (
                    <div key={section.label} className="mb-1">
                      <div className="px-2 pt-1 pb-1">
                        <span className="text-[10px] text-muted-foreground/70 tracking-wide">{section.label}</span>
                      </div>
                      {section.items.map((g) => (
                        <ChatGroupItem
                          key={g.jid} jid={g.jid} name={g.name} folder={g.folder}
                          lastMessage={g.lastMessage}
                          isShared={g.is_shared} memberRole={g.member_role} memberCount={g.member_count}
                          isActive={currentGroup === g.jid} isHome={false}
                          isRunning={runnerStates[g.jid] === 'running'}
                          canModify={g.can_modify}
                          onSelect={(jid, folder) => { selectGroup(jid); navigate(`/chat/${folder}`); }}
                          onClearHistory={openClear}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-64 px-4">
              <img src={`${import.meta.env.BASE_URL}icons/logo-text.svg`} alt={appearance?.appName || 'HappyClaw'} className="h-12 mb-6" />
              <p className="text-muted-foreground text-sm">暂无工作区</p>
            </div>
          )}
        </div>
      )}

      {/* Chat View - Desktop: visible when active group exists, Mobile: only in detail route */}
      {activeGroupJid ? (
        <div ref={chatViewRef} className={`${groupFolder ? 'flex-1 min-w-0 h-full overflow-hidden lg:pt-4' : 'hidden lg:block flex-1 min-w-0 h-full overflow-hidden lg:pt-4'}`}>
          <ChatView
            groupJid={activeGroupJid}
            onBack={handleBackToList}
          />
        </div>
      ) : (
        <div className="hidden lg:flex flex-1 items-center justify-center bg-background rounded-t-3xl rounded-b-none mt-5 mr-5 mb-0 ml-3 relative">
          <div className="text-center max-w-sm">
            {/* Logo */}
            <div className="w-16 h-16 rounded-2xl overflow-hidden mx-auto mb-6">
              <img src={`${import.meta.env.BASE_URL}icons/icon-192.png`} alt="HappyClaw" className="w-full h-full object-cover" />
            </div>
            <h2 className="text-xl font-semibold text-foreground mb-2">
              欢迎使用 {appearance?.appName || 'HappyClaw'}
            </h2>
            <p className="text-muted-foreground text-sm">
              从左侧选择一个工作区开始对话
            </p>
          </div>
        </div>
      )}
      <ConfirmDialog
        open={clearState.open}
        onClose={closeClear}
        onConfirm={handleClearConfirm}
        title="重建工作区"
        message={`确认重建工作区「${clearState.name}」吗？这会清除全部聊天记录、上下文、所有子对话及其消息，并删除工作目录中的所有文件。持久化目录 (data/extra/) 保留；定时任务本身保留但与本工作区的绑定会断开。此操作不可撤销。`}
        confirmText="确认重建"
        cancelText="取消"
        confirmVariant="danger"
        loading={clearLoading}
      />
      <CreateContainerDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(jid, folder) => { selectGroup(jid); navigate(`/chat/${folder}`); }}
      />
    </div>
  );
}
