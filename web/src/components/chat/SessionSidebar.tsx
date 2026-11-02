import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowLeft,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Pin,
  Plus,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { IconButton } from '@/components/common/IconButton';
import { SearchInput } from '@/components/common/SearchInput';
import {
  ResponsiveMenu,
  type MenuAction,
} from '@/components/common/ResponsiveMenu';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { AgentInfo, SessionWorktreeInfo } from '../../types';
import { WorktreeBranchTag } from './WorktreeBranchTag';
import {
  buildSessionMeta,
  isRecentSession,
  messagePreview,
  sessionDisplayName,
} from '../../lib/session-presentation';

interface SessionSidebarProps {
  /** The workspace's sessions, in list order. */
  sessions: AgentInfo[];
  activeSessionId: string | null;
  canModify?: boolean;
  isTopicWorkspace?: boolean;
  title?: string;
  onClose?: () => void;
  onSelectSession: (id: string) => void;
  onCreateSession?: () => void;
  isCreatingSession?: boolean;
  /** A row's ⋯ actions, the same as the sidebar tree's. */
  menuFor: (session: AgentInfo) => MenuAction[][] | undefined;
}

export function SessionSidebar({
  sessions,
  activeSessionId,
  canModify = false,
  isTopicWorkspace = false,
  title,
  onClose,
  onSelectSession,
  onCreateSession,
  isCreatingSession = false,
  menuFor,
}: SessionSidebarProps) {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<'all' | 'recent'>('all');
  const scrollParentRef = useRef<HTMLDivElement>(null);

  const recentCount = useMemo(
    () => sessions.filter(isRecentSession).length,
    [sessions],
  );
  const visibleSessions = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return sessions.filter((session) => {
      if (scope === 'recent' && !isRecentSession(session)) return false;
      if (!normalizedQuery) return true;
      return (
        session.name.toLocaleLowerCase().includes(normalizedQuery) ||
        messagePreview(session).toLocaleLowerCase().includes(normalizedQuery)
      );
    });
  }, [query, scope, sessions]);
  const showNavigationTools = isTopicWorkspace || sessions.length >= 6;
  // “会话” is the umbrella concept in Web. Channel-native topics are one
  // source of sessions, and may coexist with manually-created Web sessions.
  const sessionNoun = '会话';
  const createSessionLabel = isTopicWorkspace ? '新建 Web 会话' : '新建会话';
  const totalCount = sessions.length;
  const sessionVirtualizer = useVirtualizer({
    count: visibleSessions.length,
    getScrollElement: () => scrollParentRef.current,
    estimateSize: () => 48,
    overscan: 10,
  });

  useEffect(() => {
    scrollParentRef.current?.scrollTo({ top: 0 });
  }, [query, scope]);

  return (
    <div
      data-hc-session-sidebar
      className="flex h-full min-h-0 w-full flex-col bg-transparent"
    >
      <div className="border-b border-surface-border px-3 py-2.5">
        <div className="flex min-h-9 items-center gap-1">
          {onClose && (
            <IconButton
              label="返回工作区"
              icon={<ArrowLeft />}
              onClick={onClose}
              hideTooltip
              className="-ml-1.5 text-muted-foreground pointer-coarse:size-9"
            />
          )}
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <div className="truncate text-title-sm text-foreground">
              {title || '会话'}
            </div>
            <Badge variant="neutral" className="tabular-nums">
              {totalCount}
            </Badge>
          </div>
          {canModify && onCreateSession && (
            <IconButton
              label={
                isCreatingSession
                  ? `正在${createSessionLabel}`
                  : createSessionLabel
              }
              icon={
                isCreatingSession ? (
                  <Loader2 className="animate-spin" aria-hidden="true" />
                ) : (
                  <Plus aria-hidden="true" />
                )
              }
              onClick={onCreateSession}
              disabled={isCreatingSession}
              aria-busy={isCreatingSession}
              className="-mr-1 text-muted-foreground pointer-coarse:size-9"
            />
          )}
        </div>

        {showNavigationTools && (
          <>
            <SearchInput
              value={query}
              onChange={setQuery}
              placeholder={`搜索 ${totalCount} 个${sessionNoun}…`}
              ariaLabel={`搜索${sessionNoun}`}
              debounce={0}
              className="mt-2.5"
            />
            <div className="mt-2 flex items-center gap-1" aria-label="会话范围">
              <FilterButton
                active={scope === 'all'}
                onClick={() => setScope('all')}
              >
                全部 {totalCount}
              </FilterButton>
              <FilterButton
                active={scope === 'recent'}
                onClick={() => setScope('recent')}
              >
                最近活跃 {recentCount}
              </FilterButton>
            </div>
          </>
        )}
      </div>

      <div ref={scrollParentRef} className="flex-1 overflow-y-auto px-2 py-2">
        {visibleSessions.length === 0 ? (
          <div className="px-3 py-8 text-center text-caption text-muted-foreground">
            {sessions.length === 0
              ? `暂无${sessionNoun}`
              : `没有匹配的${sessionNoun}`}
            {(query || scope !== 'all') && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setQuery('');
                  setScope('all');
                }}
                className="mx-auto mt-2 flex"
              >
                清除筛选
              </Button>
            )}
          </div>
        ) : (
          <div
            className="relative w-full"
            style={{ height: sessionVirtualizer.getTotalSize() }}
          >
            {sessionVirtualizer.getVirtualItems().map((virtualRow) => {
              const session = visibleSessions[virtualRow.index];
              return (
                <div
                  key={session.id}
                  className="absolute left-0 top-0 w-full pb-0.5"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  <SessionRow
                    name={sessionDisplayName(session)}
                    meta={buildSessionMeta(session)}
                    active={activeSessionId === session.id}
                    running={session.status === 'running'}
                    titleGenerating={session.title_generating}
                    pinned={!!session.pinned_at}
                    linkedCount={session.linked_im_groups?.length ?? 0}
                    worktree={session.worktree}
                    onSelect={() => onSelectSession(session.id)}
                    menu={menuFor(session)}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function FilterButton({
  active,
  children,
  onClick,
}: {
  active: boolean;
  children: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={cn(
        'min-h-8 cursor-pointer rounded-md px-2.5 text-caption transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
        active
          ? 'bg-surface-selected font-medium text-foreground'
          : 'text-muted-foreground hover:bg-surface-hover hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

function SessionRow({
  name,
  meta,
  active,
  running = false,
  titleGenerating = false,
  pinned = false,
  linkedCount = 0,
  worktree,
  onSelect,
  menu,
}: {
  name: string;
  meta: string;
  active: boolean;
  running?: boolean;
  titleGenerating?: boolean;
  pinned?: boolean;
  linkedCount?: number;
  worktree?: SessionWorktreeInfo | null;
  onSelect: () => void;
  menu?: MenuAction[][];
}) {
  const showMenu = !!menu?.some((group) => group.length > 0);

  return (
    <div
      className={cn(
        'group flex min-h-12 items-center gap-1 rounded-lg transition-colors',
        active
          ? 'bg-surface-selected text-foreground'
          : 'text-foreground hover:bg-surface-hover',
      )}
    >
      <button
        onClick={onSelect}
        aria-current={active ? 'page' : undefined}
        className="flex min-w-0 flex-1 items-start gap-2 px-2.5 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
      >
        {titleGenerating ? (
          <Loader2 className="mt-1 h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
        ) : running ? (
          <span className="mt-1.5 h-2 w-2 shrink-0 animate-pulse rounded-full bg-primary" />
        ) : linkedCount > 0 ? (
          <MessageSquare className="mt-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <span
            className={cn(
              'mt-1.5 h-2 w-2 shrink-0 rounded-full',
              active ? 'bg-foreground/60' : 'bg-border',
            )}
          />
        )}
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1">
            <span className={cn('truncate text-body', active && 'font-medium')}>
              {name}
            </span>
            {pinned && (
              <Pin
                className="size-3 shrink-0 text-faint-foreground"
                aria-label="已置顶"
              />
            )}
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-caption text-muted-foreground">
            {worktree && (
              <WorktreeBranchTag
                worktree={worktree}
                compact
                className="max-w-32"
              />
            )}
            <span className="truncate">{meta}</span>
          </span>
        </span>
      </button>

      {showMenu && (
        <ResponsiveMenu
          title={`${name}的更多操作`}
          groups={menu!}
          trigger={
            <IconButton
              label={`${name}的更多操作`}
              icon={<MoreHorizontal className="size-3.5" />}
              hideTooltip
              onClick={(event) => event.stopPropagation()}
              className="mr-1 text-muted-foreground pointer-coarse:size-9 sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100 sm:data-[state=open]:opacity-100"
            />
          }
        />
      )}
    </div>
  );
}
