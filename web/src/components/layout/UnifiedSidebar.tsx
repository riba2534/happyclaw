import { useState, useMemo, useEffect } from 'react';
import { NavLink, useNavigate, useLocation } from 'react-router-dom';
import { Plus, PanelLeftClose, Bug } from 'lucide-react';
import { useChatStore } from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';
import { useBillingStore } from '../../stores/billing';
import { useGroupsStore } from '../../stores/groups';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/common';
import { EmojiAvatar } from '../common/EmojiAvatar';
import { BugReportDialog } from '../common/BugReportDialog';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { ChatGroupItem } from '../chat/ChatGroupItem';
import { CreateContainerDialog } from '../chat/CreateContainerDialog';
import { RenameDialog } from '../chat/RenameDialog';
import { SkeletonCardList } from '@/components/common/Skeletons';
import { cn } from '@/lib/utils';
import { baseNavItems } from './nav-items';
import type { GroupInfo } from '../../types';

type GroupEntry = GroupInfo & { jid: string };
type DateSection = { label: string; items: GroupEntry[] };

function groupByDate(items: GroupEntry[]): DateSection[] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const weekAgo = new Date(today.getTime() - 7 * 86400000);
  const sections: DateSection[] = [
    { label: '今天', items: [] },
    { label: '最近 7 天', items: [] },
    { label: '更早', items: [] },
  ];
  items.forEach((g) => {
    const time = new Date(g.lastMessageTime || g.added_at);
    if (time >= today) sections[0].items.push(g);
    else if (time >= weekAgo) sections[1].items.push(g);
    else sections[2].items.push(g);
  });
  return sections.filter((s) => s.items.length > 0);
}

interface UnifiedSidebarProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
}

export function UnifiedSidebar({ collapsed, onToggleCollapse }: UnifiedSidebarProps) {
  const location = useLocation();
  const navigate = useNavigate();
  const isChatRoute = location.pathname.startsWith('/chat');
  const showWorkspaceList = isChatRoute && !collapsed;

  const user = useAuthStore((s) => s.user);
  const appearance = useAuthStore((s) => s.appearance);
  const billingEnabled = useBillingStore((s) => s.billingEnabled);
  const [showBugReport, setShowBugReport] = useState(false);
  const userInitial = (user?.display_name || user?.username || '?')[0].toUpperCase();

  const navItems = useMemo(
    () =>
      baseNavItems.filter((item) => {
        if (item.requiresBilling && !billingEnabled) return false;
        if ('requireAdmin' in item && item.requireAdmin && user?.role !== 'admin') return false;
        return true;
      }),
    [billingEnabled, user?.role],
  );

  // ── Chat sidebar state ──
  const [createOpen, setCreateOpen] = useState(false);
  const [renameState, setRenameState] = useState({ open: false, jid: '', name: '' });
  const [deleteState, setDeleteState] = useState({ open: false, jid: '', name: '' });
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [clearState, setClearState] = useState({ open: false, jid: '', name: '' });
  const [clearLoading, setClearLoading] = useState(false);

  const {
    groups, currentGroup, selectGroup, loadGroups, loading,
    deleteFlow, clearHistory, togglePin,
  } = useChatStore();
  const runnerStates = useGroupsStore((s) => s.runnerStates);

  useEffect(() => {
    if (isChatRoute) loadGroups();
  }, [isChatRoute, loadGroups]);

  const { mainGroup, otherGroups } = useMemo(() => {
    let main: GroupEntry | null = null;
    const others: GroupEntry[] = [];
    for (const [jid, info] of Object.entries(groups)) {
      const entry = { jid, ...info };
      if (info.is_my_home) main = entry;
      else others.push(entry);
    }
    others.sort((a, b) => new Date(b.lastMessageTime || b.added_at).getTime() - new Date(a.lastMessageTime || a.added_at).getTime());
    return { mainGroup: main, otherGroups: others };
  }, [groups]);

  const { pinnedGroups, mySections, collabSections } = useMemo(() => {
    const pinned: GroupEntry[] = [];
    const my: GroupEntry[] = [];
    const collab: GroupEntry[] = [];
    otherGroups.forEach((g) => {
      if (g.pinned_at) pinned.push(g);
      else if (g.is_shared && (g.member_count ?? 0) >= 2) collab.push(g);
      else my.push(g);
    });
    pinned.sort((a, b) => (a.pinned_at || '').localeCompare(b.pinned_at || ''));
    return { pinnedGroups: pinned, mySections: groupByDate(my), collabSections: groupByDate(collab) };
  }, [otherGroups]);

  const handleGroupSelect = (jid: string, folder: string) => { selectGroup(jid); navigate(`/chat/${folder}`); };
  const handleCreated = (jid: string, folder: string) => { selectGroup(jid); navigate(`/chat/${folder}`); };

  const handleDeleteConfirm = async () => {
    setDeleteLoading(true);
    try {
      await deleteFlow(deleteState.jid);
      setDeleteState({ open: false, jid: '', name: '' });
      const nextJid = useChatStore.getState().currentGroup;
      const nextFolder = nextJid ? useChatStore.getState().groups[nextJid]?.folder : null;
      navigate(nextFolder ? `/chat/${nextFolder}` : '/chat');
    } catch (err: unknown) {
      const typed = err as { boundAgents?: Array<{ agentName: string; imGroups: Array<{ name: string }> }> };
      if (typed.boundAgents) {
        const details = typed.boundAgents.map((a) => `「${a.agentName}」→ ${a.imGroups.map((g) => g.name).join('、')}`).join('\n');
        alert(`该工作区下有子对话绑定了 IM 渠道，请先解绑后再删除：\n${details}`);
      } else {
        alert(`删除工作区失败：${err instanceof Error ? err.message : '未知错误'}`);
      }
      setDeleteState({ open: false, jid: '', name: '' });
    } finally { setDeleteLoading(false); }
  };

  const handleClearConfirm = async () => {
    setClearLoading(true);
    try { const ok = await clearHistory(clearState.jid); if (ok) setClearState({ open: false, jid: '', name: '' }); }
    finally { setClearLoading(false); }
  };

  const allGroups = mainGroup ? [mainGroup, ...otherGroups] : otherGroups;

  const renderSections = (sections: DateSection[], showCollabBadge: boolean) =>
    sections.map((section) => (
      <div key={section.label} className="mb-1">
        <div className="px-2 pt-2 pb-1">
          <span className="text-[10px] text-muted-foreground/70 tracking-wide">{section.label}</span>
        </div>
        {section.items.map((g) => (
          <ChatGroupItem
            key={g.jid} jid={g.jid} name={g.name} folder={g.folder}
            lastMessage={g.lastMessage} executionMode={g.execution_mode}
            isShared={showCollabBadge ? g.is_shared : undefined}
            memberRole={showCollabBadge ? g.member_role : undefined}
            memberCount={showCollabBadge ? g.member_count : undefined}
            isActive={currentGroup === g.jid} isHome={false}
            isRunning={runnerStates[g.jid] === 'running'}
            editable={g.editable} deletable={g.deletable}
            onSelect={handleGroupSelect}
            onRename={(jid, name) => setRenameState({ open: true, jid, name })}
            onClearHistory={(jid, name) => setClearState({ open: true, jid, name })}
            onDelete={(jid, name) => setDeleteState({ open: true, jid, name })}
            onTogglePin={(jid) => togglePin(jid)}
          />
        ))}
      </div>
    ));

  // Compute width based on state
  const sidebarWidth = collapsed ? '4.5rem' : (isChatRoute ? '21rem' : '13rem');

  return (
    <div
      className="h-full bg-muted/30 flex flex-col overflow-hidden transition-[width] duration-300 ease-in-out"
      style={{ width: sidebarWidth }}
    >
      {/* Header: Logo + collapse/expand */}
      <div className={cn('flex items-center pt-4 pb-3 flex-shrink-0', collapsed ? 'px-2 justify-center' : 'px-3')}>
        {collapsed ? (
          <button
            onClick={isChatRoute ? () => { onToggleCollapse(); window.dispatchEvent(new Event('expand-sidebar')); } : undefined}
            className={cn(
              'w-10 h-10 rounded-xl overflow-hidden flex-shrink-0 transition-opacity',
              isChatRoute ? 'cursor-pointer hover:opacity-80' : 'cursor-default',
            )}
            title={isChatRoute ? '展开侧边栏' : undefined}
          >
            <img src={`${import.meta.env.BASE_URL}icons/icon-192.png`} alt="HappyClaw" className="w-full h-full object-cover" />
          </button>
        ) : (
          <>
            <img
              src={`${import.meta.env.BASE_URL}icons/icon-192.png`}
              alt="HappyClaw"
              className="w-11 h-11 rounded-xl flex-shrink-0"
            />
            <img
              src={`${import.meta.env.BASE_URL}icons/logo-text.svg`}
              alt={appearance?.appName || 'HappyClaw'}
              className="h-[22px] max-w-[130px] ml-2 mb-0.5 self-end"
            />
            <div className="flex-1" />
            <button
              onClick={onToggleCollapse}
              className="flex items-center justify-center w-8 h-8 rounded-lg hover:bg-accent text-muted-foreground hover:text-foreground transition-colors cursor-pointer flex-shrink-0 ml-4"
              title="收起侧边栏"
            >
              <PanelLeftClose className="w-4 h-4" />
            </button>
          </>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 flex min-h-0 overflow-hidden">
        {/* Navigation column */}
        <nav
          className="flex flex-col gap-1.5 px-2 py-1 flex-shrink-0 transition-[width] duration-300 ease-in-out"
          style={{ width: showWorkspaceList ? '4.5rem' : '100%' }}
        >
          {navItems.map(({ path, icon: Icon, label }) => (
            <NavLink
              key={path} to={path}
              className={({ isActive }) => cn(
                'flex items-center gap-2.5 transition-all rounded-xl whitespace-nowrap',
                (collapsed || showWorkspaceList)
                  ? 'flex-col justify-center py-2 px-1 text-center'
                  : 'py-2.5 px-3',
                isActive
                  ? 'bg-brand-100/60 dark:bg-brand-500/15 text-primary font-medium'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              {({ isActive }) => (
                <>
                  <Icon className="w-[18px] h-[18px] flex-shrink-0" strokeWidth={isActive ? 2 : 1.75} />
                  <span className={(collapsed || showWorkspaceList) ? 'text-[10px] leading-none' : 'text-sm'}>{label}</span>
                </>
              )}
            </NavLink>
          ))}

          {/* Spacer */}
          <div className="flex-1" />

          {/* Bug report + User avatar */}
          <TooltipProvider delayDuration={200}>
            <div className={cn('flex flex-col items-center gap-1.5 mb-4', (collapsed || showWorkspaceList) ? '' : 'px-3')}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => setShowBugReport(true)}
                    className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-amber-600 hover:bg-amber-50 dark:hover:bg-amber-950/30 transition-colors cursor-pointer"
                  >
                    <Bug className="w-4 h-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">报告问题</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => navigate('/settings?tab=profile')}
                    className="rounded-full hover:ring-2 hover:ring-brand-200 transition-all cursor-pointer"
                  >
                    <EmojiAvatar
                      emoji={user?.avatar_emoji}
                      color={user?.avatar_color}
                      fallbackChar={userInitial}
                      size="md"
                      className="w-8 h-8"
                    />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="right">{user?.display_name || user?.username}</TooltipContent>
              </Tooltip>
            </div>
          </TooltipProvider>
          <BugReportDialog open={showBugReport} onClose={() => setShowBugReport(false)} />
        </nav>

        {/* Workspace list (chat route, expanded only) */}
        <div
          className="flex flex-col min-w-0 overflow-hidden transition-[opacity,width] duration-300 ease-in-out"
          style={{
            width: showWorkspaceList ? 'calc(100% - 4.5rem)' : '0',
            opacity: showWorkspaceList ? 1 : 0,
          }}
        >
          {showWorkspaceList && (
            <>
              {/* Header area — aligned with first nav item */}
              <div className="px-2 pt-1 pb-1 flex-shrink-0">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full justify-start gap-2 text-xs"
                  onClick={() => setCreateOpen(true)}
                >
                  <Plus className="w-3.5 h-3.5" />
                  新工作区
                </Button>
              </div>

              {/* Workspace list */}
              <div className="flex-1 overflow-y-auto px-1.5">
                {loading && allGroups.length === 0 ? (
                  <SkeletonCardList count={6} compact />
                ) : (
                  <>
                    {mainGroup && (
                      <div className="mb-1">
                        <div className="px-2 pt-1 pb-1">
                          <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">主工作区</span>
                        </div>
                        <ChatGroupItem
                          jid={mainGroup.jid} name={mainGroup.name} folder={mainGroup.folder}
                          lastMessage={mainGroup.lastMessage} executionMode={mainGroup.execution_mode}
                          isActive={currentGroup === mainGroup.jid} isHome
                          isRunning={runnerStates[mainGroup.jid] === 'running'} editable
                          onSelect={handleGroupSelect}
                          onRename={(jid, name) => setRenameState({ open: true, jid, name })}
                          onClearHistory={(jid, name) => setClearState({ open: true, jid, name })}
                        />
                      </div>
                    )}

                    {pinnedGroups.length > 0 && (
                      <div className="mb-1">
                        <div className="mt-1" />
                        <div className="px-2 pt-2 pb-1">
                          <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">已固定</span>
                        </div>
                        {pinnedGroups.map((g) => (
                          <ChatGroupItem
                            key={g.jid} jid={g.jid} name={g.name} folder={g.folder}
                            lastMessage={g.lastMessage} executionMode={g.execution_mode}
                            isShared={g.is_shared} memberRole={g.member_role} memberCount={g.member_count}
                            isActive={currentGroup === g.jid} isHome={false} isPinned
                            isRunning={runnerStates[g.jid] === 'running'}
                            editable={g.editable} deletable={g.deletable}
                            onSelect={handleGroupSelect}
                            onRename={(jid, name) => setRenameState({ open: true, jid, name })}
                            onClearHistory={(jid, name) => setClearState({ open: true, jid, name })}
                            onDelete={(jid, name) => setDeleteState({ open: true, jid, name })}
                            onTogglePin={(jid) => togglePin(jid)}
                          />
                        ))}
                      </div>
                    )}

                    {mySections.length === 0 && collabSections.length === 0 && pinnedGroups.length === 0 && !mainGroup ? (
                      <div className="flex flex-col items-center justify-center h-32 px-4">
                        <p className="text-xs text-muted-foreground text-center">暂无工作区</p>
                      </div>
                    ) : (
                      <>
                        {mySections.length > 0 && (
                          <div>
                            <div className="mt-1" />
                            <div className="px-2 pt-2 pb-1">
                              <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">我的工作区</span>
                            </div>
                            {renderSections(mySections, false)}
                          </div>
                        )}
                        {collabSections.length > 0 && (
                          <div>
                            <div className="mt-1" />
                            <div className="px-2 pt-2 pb-1">
                              <span className="text-[10px] font-bold text-muted-foreground uppercase tracking-wider">协作工作区</span>
                            </div>
                            {renderSections(collabSections, true)}
                          </div>
                        )}
                      </>
                    )}
                  </>
                )}
              </div>

              {/* Dialogs */}
              <CreateContainerDialog open={createOpen} onClose={() => setCreateOpen(false)} onCreated={handleCreated} />
              <RenameDialog open={renameState.open} jid={renameState.jid} currentName={renameState.name} onClose={() => setRenameState({ open: false, jid: '', name: '' })} />
              <ConfirmDialog
                open={clearState.open} onClose={() => setClearState({ open: false, jid: '', name: '' })}
                onConfirm={handleClearConfirm} title="重建工作区"
                message={`确认重建工作区「${clearState.name}」吗？这会清除全部聊天记录、上下文，并删除工作目录中的所有文件。此操作不可撤销。`}
                confirmText="确认重建" cancelText="取消" confirmVariant="danger" loading={clearLoading}
              />
              <ConfirmDialog
                open={deleteState.open} onClose={() => setDeleteState({ open: false, jid: '', name: '' })}
                onConfirm={handleDeleteConfirm} title="删除工作区"
                message={`确认删除工作区「${deleteState.name}」吗？此操作会彻底删除该工作区的全部数据，包括聊天记录、工作目录文件和定时任务。此操作不可撤销。`}
                confirmText="删除" cancelText="取消" confirmVariant="danger" loading={deleteLoading}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}
