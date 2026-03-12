import { useState, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Plus, PanelLeftClose } from 'lucide-react';
import { useChatStore } from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';
import { Button } from '@/components/ui/button';
import { SearchInput } from '@/components/common';
import { ConfirmDialog } from '@/components/common';
import { ChatGroupItem } from './ChatGroupItem';
import { CreateContainerDialog } from './CreateContainerDialog';
import { RenameDialog } from './RenameDialog';
import { SkeletonCardList } from '@/components/common/Skeletons';
import { cn } from '@/lib/utils';
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

interface ChatSidebarProps {
  className?: string;
  onToggleCollapse?: () => void;
}

export function ChatSidebar({ className, onToggleCollapse }: ChatSidebarProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false);

  // Rename dialog state
  const [renameState, setRenameState] = useState({ open: false, jid: '', name: '' });

  // Delete confirm state
  const [deleteState, setDeleteState] = useState({ open: false, jid: '', name: '' });
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Clear history confirm state
  const [clearState, setClearState] = useState({ open: false, jid: '', name: '' });
  const [clearLoading, setClearLoading] = useState(false);

  const {
    groups,
    currentGroup,
    selectGroup,
    loadGroups,
    loading,
    deleteFlow,
    clearHistory,
    togglePin,
  } = useChatStore();
  const navigate = useNavigate();

  useEffect(() => {
    loadGroups();
  }, [loadGroups]);

  // Separate home group from others, sort by time
  const { mainGroup, otherGroups } = useMemo(() => {
    let main: (typeof groups)[string] & { jid: string } | null = null;
    const others: ((typeof groups)[string] & { jid: string })[] = [];

    for (const [jid, info] of Object.entries(groups)) {
      const entry = { jid, ...info };
      if (info.is_my_home) {
        main = entry;
      } else {
        others.push(entry);
      }
    }

    others.sort((a, b) => {
      const timeA = a.lastMessageTime || a.added_at;
      const timeB = b.lastMessageTime || b.added_at;
      return new Date(timeB).getTime() - new Date(timeA).getTime();
    });

    return { mainGroup: main, otherGroups: others };
  }, [groups]);

  // Split non-main groups into pinned / private / collaborative, then sub-group by date
  const { pinnedGroups, mySections, collabSections } = useMemo(() => {
    const filtered = searchQuery.trim()
      ? otherGroups.filter((g) => g.name.toLowerCase().includes(searchQuery.toLowerCase()))
      : otherGroups;

    const pinned: typeof otherGroups = [];
    const my: typeof otherGroups = [];
    const collab: typeof otherGroups = [];

    filtered.forEach((g) => {
      if (g.pinned_at) {
        pinned.push(g);
      } else if (g.is_shared && (g.member_count ?? 0) >= 2) {
        collab.push(g);
      } else {
        my.push(g);
      }
    });

    // Sort pinned by pinned_at ascending (earliest pinned first = stable top)
    pinned.sort((a, b) => (a.pinned_at || '').localeCompare(b.pinned_at || ''));

    return { pinnedGroups: pinned, mySections: groupByDate(my), collabSections: groupByDate(collab) };
  }, [otherGroups, searchQuery]);

  const handleGroupSelect = (jid: string, folder: string) => {
    selectGroup(jid);
    navigate(`/chat/${folder}`);
  };

  const appearance = useAuthStore((s) => s.appearance);
  const appName = appearance?.appName || 'HappyClaw';

  const handleCreated = (jid: string, folder: string) => {
    selectGroup(jid);
    navigate(`/chat/${folder}`);
  };

  const handleDeleteConfirm = async () => {
    setDeleteLoading(true);
    try {
      await deleteFlow(deleteState.jid);
      setDeleteState({ open: false, jid: '', name: '' });
      // Navigate to the auto-selected next group, or list view if none remain
      const nextJid = useChatStore.getState().currentGroup;
      const nextFolder = nextJid ? useChatStore.getState().groups[nextJid]?.folder : null;
      navigate(nextFolder ? `/chat/${nextFolder}` : '/chat');
    } catch (err: unknown) {
      const typed = err as { boundAgents?: Array<{ agentName: string; imGroups: Array<{ name: string }> }> };
      if (typed.boundAgents) {
        const details = typed.boundAgents
          .map((a) => `「${a.agentName}」→ ${a.imGroups.map((g) => g.name).join('、')}`)
          .join('\n');
        alert(`该工作区下有子对话绑定了 IM 群组，请先解绑后再删除：\n${details}`);
      } else {
        const message = err instanceof Error ? err.message : '未知错误';
        alert(`删除工作区失败：${message}`);
      }
      setDeleteState({ open: false, jid: '', name: '' });
    } finally {
      setDeleteLoading(false);
    }
  };

  const handleClearConfirm = async () => {
    setClearLoading(true);
    try {
      const ok = await clearHistory(clearState.jid);
      if (ok) setClearState({ open: false, jid: '', name: '' });
    } finally {
      setClearLoading(false);
    }
  };

  const allGroups = mainGroup ? [mainGroup, ...otherGroups] : otherGroups;

  const renderSections = (sections: DateSection[], showCollabBadge: boolean) =>
    sections.map((section) => (
      <div key={section.label} className="mb-1">
        <div className="px-2 pt-2 pb-1">
          <span className="text-[10px] text-muted-foreground/70 tracking-wide">
            {section.label}
          </span>
        </div>
        {section.items.map((g) => (
          <ChatGroupItem
            key={g.jid}
            jid={g.jid}
            name={g.name}
            folder={g.folder}
            lastMessage={g.lastMessage}
            executionMode={g.execution_mode}
            isShared={showCollabBadge ? g.is_shared : undefined}
            memberRole={showCollabBadge ? g.member_role : undefined}
            memberCount={showCollabBadge ? g.member_count : undefined}
            isActive={currentGroup === g.jid}
            isHome={false}
            editable={g.editable}
            deletable={g.deletable}
            onSelect={handleGroupSelect}
            onRename={(jid, name) => setRenameState({ open: true, jid, name })}
            onClearHistory={(jid, name) => setClearState({ open: true, jid, name })}
            onDelete={(jid, name) => setDeleteState({ open: true, jid, name })}
            onTogglePin={(jid) => togglePin(jid)}
          />
        ))}
      </div>
    ));

  return (
    <div className={cn('flex flex-col h-full bg-background border-r', className)}>
      {/* Logo Header — only on mobile (PC has NavRail logo) */}
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-1 lg:hidden">
        <img
          src={`${import.meta.env.BASE_URL}icons/icon-192.png`}
          alt={appName}
          className="w-8 h-8 rounded-lg"
        />
        <span className="text-lg font-bold text-foreground truncate">{appName}</span>
      </div>

      {/* New Chat + Search */}
      <div className="p-3 space-y-2">
        <div className="flex gap-2">
          <Button
            variant="outline"
            className="flex-1 justify-start gap-2"
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="w-4 h-4" />
            新工作区
          </Button>
          <button
            onClick={onToggleCollapse}
            className="hidden lg:flex items-center p-2 rounded-md border hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
            title="折叠侧边栏"
          >
            <PanelLeftClose className="w-4 h-4" />
          </button>
        </div>
        <SearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder="搜索工作区..."
          debounce={200}
          className="max-lg:bg-background/60 max-lg:backdrop-blur-lg max-lg:border-border/30 max-lg:rounded-lg"
        />
      </div>

      {/* Groups List */}
      <div className="flex-1 overflow-y-auto px-2">
        {loading && allGroups.length === 0 ? (
          <SkeletonCardList count={6} compact />
        ) : (
          <>
            {/* Section: Home container */}
            {mainGroup && (
              <div className="mb-1">
                <div className="px-2 pt-1 pb-1.5">
                  <span className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">
                    主工作区
                  </span>
                </div>
                <ChatGroupItem
                  jid={mainGroup.jid}
                  name={mainGroup.name}
                  folder={mainGroup.folder}
                  lastMessage={mainGroup.lastMessage}
                  executionMode={mainGroup.execution_mode}
                  isActive={currentGroup === mainGroup.jid}
                  isHome
                  editable
                  onSelect={handleGroupSelect}
                  onRename={(jid, name) => setRenameState({ open: true, jid, name })}
                  onClearHistory={(jid, name) => setClearState({ open: true, jid, name })}
                />
              </div>
            )}

            {/* Section: Pinned workspaces */}
            {pinnedGroups.length > 0 && (
              <div className="mb-1">
                <div className="px-2 pt-3 pb-1.5">
                  <span className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">
                    已固定
                  </span>
                </div>
                {pinnedGroups.map((g) => (
                  <ChatGroupItem
                    key={g.jid}
                    jid={g.jid}
                    name={g.name}
                    folder={g.folder}
                    lastMessage={g.lastMessage}
                    executionMode={g.execution_mode}
                    isShared={g.is_shared}
                    memberRole={g.member_role}
                    memberCount={g.member_count}
                    isActive={currentGroup === g.jid}
                    isHome={false}
                    isPinned
                    editable={g.editable}
                    deletable={g.deletable}
                    onSelect={handleGroupSelect}
                    onRename={(jid, name) => setRenameState({ open: true, jid, name })}
                    onClearHistory={(jid, name) => setClearState({ open: true, jid, name })}
                    onDelete={(jid, name) => setDeleteState({ open: true, jid, name })}
                    onTogglePin={(jid) => togglePin(jid)}
                  />
                ))}
              </div>
            )}

            {/* Section: My workspaces + Collaborative workspaces */}
            {mySections.length === 0 && collabSections.length === 0 && pinnedGroups.length === 0 && !mainGroup ? (
              <div className="flex flex-col items-center justify-center h-32 px-4">
                <p className="text-sm text-muted-foreground text-center">
                  {searchQuery ? '未找到匹配的工作区' : '暂无工作区'}
                </p>
              </div>
            ) : (
              <>
                {mySections.length > 0 && (
                  <div>
                    <div className="px-2 pt-3 pb-1.5">
                      <span className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">
                        我的工作区
                      </span>
                    </div>
                    {renderSections(mySections, false)}
                  </div>
                )}

                {collabSections.length > 0 && (
                  <div>
                    <div className="px-2 pt-3 pb-1.5">
                      <span className="text-[11px] font-bold text-muted-foreground uppercase tracking-wider">
                        协作工作区
                      </span>
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
      <CreateContainerDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={handleCreated}
      />

      <RenameDialog
        open={renameState.open}
        jid={renameState.jid}
        currentName={renameState.name}
        onClose={() => setRenameState({ open: false, jid: '', name: '' })}
      />

      <ConfirmDialog
        open={clearState.open}
        onClose={() => setClearState({ open: false, jid: '', name: '' })}
        onConfirm={handleClearConfirm}
        title="重建工作区"
        message={`确认重建工作区「${clearState.name}」吗？这会清除全部聊天记录、上下文，并删除工作目录中的所有文件。此操作不可撤销。`}
        confirmText="确认重建"
        cancelText="取消"
        confirmVariant="danger"
        loading={clearLoading}
      />

      <ConfirmDialog
        open={deleteState.open}
        onClose={() => setDeleteState({ open: false, jid: '', name: '' })}
        onConfirm={handleDeleteConfirm}
        title="删除工作区"
        message={`确认删除工作区「${deleteState.name}」吗？此操作会彻底删除该工作区的全部数据，包括聊天记录、工作目录文件和定时任务。此操作不可撤销。`}
        confirmText="删除"
        cancelText="取消"
        confirmVariant="danger"
        loading={deleteLoading}
      />
    </div>
  );
}
