import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowLeft,
  Link,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import type { AgentInfo } from '../../types';
import { getPresentedMessageContent } from '../../lib/message-presentation';

const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

interface SessionSidebarProps {
  sessions: AgentInfo[];
  activeSessionId: string | null;
  canModify?: boolean;
  isTopicWorkspace?: boolean;
  title?: string;
  mainLabel?: string;
  mainMeta?: string;
  onClose?: () => void;
  onSelectSession: (id: string | null) => void;
  onCreateSession?: () => void;
  isCreatingSession?: boolean;
  onRenameSession?: (id: string, name: string) => void;
  onDeleteSession: (id: string) => void;
  onBindSession?: (id: string | null) => void;
}

function sessionActivityAt(session: AgentInfo): string {
  return (
    session.last_active_at ||
    session.latest_message?.timestamp ||
    session.created_at
  );
}

function timestampMs(value: string): number | null {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

function isRecentSession(session: AgentInfo): boolean {
  const timestamp = timestampMs(sessionActivityAt(session));
  if (timestamp === null) return false;
  return Date.now() - timestamp <= RECENT_WINDOW_MS;
}

function formatSessionTime(value: string): string {
  const timestamp = timestampMs(value);
  if (timestamp === null) return '';

  const elapsed = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} 天前`;

  return new Date(timestamp).toLocaleDateString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
  });
}

function messagePreview(session: AgentInfo): string {
  const content = session.latest_message?.content || '';
  return getPresentedMessageContent({
    content,
    source_kind: null,
    finalization_reason: null,
  })
    .replace(/\s+/g, ' ')
    .trim();
}

function isNativeManagedSession(session: AgentInfo): boolean {
  return (
    session.source_kind === 'native_thread' ||
    session.source_kind === 'feishu_thread' ||
    session.title_source === 'native_root' ||
    session.title_source === 'feishu_root'
  );
}

export function SessionSidebar({
  sessions,
  activeSessionId,
  canModify = false,
  isTopicWorkspace = false,
  title,
  mainLabel = '当前对话',
  mainMeta = '当前工作上下文',
  onClose,
  onSelectSession,
  onCreateSession,
  isCreatingSession = false,
  onRenameSession,
  onDeleteSession,
  onBindSession,
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
  const totalCount = sessions.length + 1;
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
      <div className="border-b border-border/80 px-3 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <div className="truncate text-[13px] font-semibold text-foreground">
                {title || '会话'}
              </div>
              <span className="rounded-md bg-brand-50 px-1.5 py-0.5 text-[10px] font-medium text-primary dark:bg-brand-700/15 dark:text-brand-300">
                {totalCount}
              </span>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {canModify && onCreateSession && (
              <button
                onClick={onCreateSession}
                disabled={isCreatingSession}
                aria-busy={isCreatingSession}
                className="grid min-h-9 min-w-9 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60 cursor-pointer"
                title={createSessionLabel}
                aria-label={
                  isCreatingSession
                    ? `正在${createSessionLabel}`
                    : createSessionLabel
                }
              >
                {isCreatingSession ? (
                  <Loader2
                    className="h-4 w-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <Plus className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            )}
            {onClose && (
              <button
                onClick={onClose}
                className="grid min-h-9 min-w-9 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
                title="返回工作区"
                aria-label="返回工作区"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {showNavigationTools && (
          <>
            <label className="mt-3 flex min-h-9 items-center gap-2 rounded-md border border-border bg-background px-2.5 focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-ring/20">
              <span className="sr-only">搜索{sessionNoun}</span>
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={`搜索 ${totalCount} 个${sessionNoun}…`}
                className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
              />
            </label>
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
        <SessionRow
          name={mainLabel}
          meta={mainMeta}
          active={activeSessionId === null}
          isMain
          canModify={canModify}
          onSelect={() => onSelectSession(null)}
          onBind={onBindSession ? () => onBindSession(null) : undefined}
        />

        {visibleSessions.length === 0 ? (
          <div className="px-3 py-8 text-center text-[11px] leading-5 text-muted-foreground">
            {sessions.length === 0
              ? `暂无其他${sessionNoun}`
              : `没有匹配的${sessionNoun}`}
            {(query || scope !== 'all') && (
              <button
                onClick={() => {
                  setQuery('');
                  setScope('all');
                }}
                className="mx-auto mt-2 block min-h-9 rounded-md px-3 text-primary hover:bg-brand-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
              >
                清除筛选
              </button>
            )}
          </div>
        ) : (
          <div
            className="relative mt-1 w-full"
            style={{ height: sessionVirtualizer.getTotalSize() }}
          >
            {sessionVirtualizer.getVirtualItems().map((virtualRow) => {
              const session = visibleSessions[virtualRow.index];
              const nativeManaged = isNativeManagedSession(session);
              return (
                <div
                  key={session.id}
                  className="absolute left-0 top-0 w-full pb-0.5"
                  style={{ transform: `translateY(${virtualRow.start}px)` }}
                >
                  <SessionRow
                    name={session.name}
                    meta={buildSessionMeta(session)}
                    active={activeSessionId === session.id}
                    running={session.status === 'running'}
                    titleGenerating={session.title_generating}
                    linkedCount={session.linked_im_groups?.length ?? 0}
                    canModify={canModify}
                    readonlyTitle={nativeManaged}
                    onSelect={() => onSelectSession(session.id)}
                    onBind={
                      onBindSession && !nativeManaged
                        ? () => onBindSession(session.id)
                        : undefined
                    }
                    onRename={
                      onRenameSession && !nativeManaged
                        ? () => onRenameSession(session.id, session.name)
                        : undefined
                    }
                    onDelete={
                      nativeManaged
                        ? undefined
                        : () => onDeleteSession(session.id)
                    }
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
        'min-h-7 rounded-md px-2 text-[11px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer',
        active
          ? 'bg-secondary font-medium text-foreground'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

function buildSessionMeta(session: AgentInfo): string {
  const time = formatSessionTime(sessionActivityAt(session));
  let detail = '';

  if (session.title_generating) detail = '正在生成标题';
  else if (session.status === 'running') detail = '正在生成回复';
  else if (isNativeManagedSession(session)) detail = '渠道原生话题';
  else if ((session.linked_im_groups?.length ?? 0) > 0)
    detail = '已绑定消息渠道';
  else detail = messagePreview(session) || '暂无消息';

  return [time, detail].filter(Boolean).join(' · ');
}

function SessionRow({
  name,
  meta,
  active,
  isMain = false,
  running = false,
  titleGenerating = false,
  linkedCount = 0,
  canModify,
  readonlyTitle = false,
  onSelect,
  onBind,
  onRename,
  onDelete,
}: {
  name: string;
  meta: string;
  active: boolean;
  isMain?: boolean;
  running?: boolean;
  titleGenerating?: boolean;
  linkedCount?: number;
  canModify: boolean;
  readonlyTitle?: boolean;
  onSelect: () => void;
  onBind?: () => void;
  onRename?: () => void;
  onDelete?: () => void;
}) {
  const showMenu =
    canModify &&
    (onBind ||
      (!isMain && !readonlyTitle && onRename) ||
      (!isMain && onDelete));

  return (
    <div
      className={cn(
        'group flex min-h-11 items-center gap-1 rounded-md transition-colors',
        active
          ? 'bg-primary/10 text-primary ring-1 ring-inset ring-primary/15'
          : 'text-foreground hover:bg-muted/70',
      )}
    >
      <button
        onClick={onSelect}
        aria-current={active ? 'page' : undefined}
        className="flex min-w-0 flex-1 items-start gap-2 px-2.5 py-1.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring cursor-pointer"
      >
        {titleGenerating ? (
          <Loader2 className="mt-1 h-3.5 w-3.5 shrink-0 animate-spin text-teal-500" />
        ) : running ? (
          <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-emerald-500" />
        ) : linkedCount > 0 ? (
          <MessageSquare className="mt-1 h-3.5 w-3.5 shrink-0 text-teal-600" />
        ) : (
          <span
            className={cn(
              'mt-1.5 h-2 w-2 shrink-0 rounded-full',
              active ? 'bg-primary' : 'bg-border',
            )}
          />
        )}
        <span className="min-w-0 flex-1">
          <span
            className={cn(
              'block truncate text-[12px] leading-4',
              active && 'font-medium',
            )}
          >
            {name}
          </span>
          <span className="mt-0.5 block truncate text-[10px] leading-4 text-muted-foreground">
            {meta}
          </span>
        </span>
      </button>

      {showMenu && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              onClick={(event) => event.stopPropagation()}
              className="mr-1 grid min-h-8 min-w-8 place-items-center rounded-md text-muted-foreground opacity-100 transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 cursor-pointer"
              title={`${name}的更多操作`}
              aria-label={`${name}的更多操作`}
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-36">
            {onBind && (
              <DropdownMenuItem
                onClick={onBind}
                className="transition-[background-color,box-shadow] duration-150 ease-out hover:bg-accent hover:text-accent-foreground hover:shadow-md focus:shadow-md data-[highlighted]:bg-accent data-[highlighted]:shadow-md active:shadow-none"
              >
                <Link className="h-4 w-4" />
                会话绑定
              </DropdownMenuItem>
            )}
            {!isMain && !readonlyTitle && onRename && (
              <DropdownMenuItem
                onClick={onRename}
                className="transition-[background-color,box-shadow] duration-150 ease-out hover:bg-accent hover:text-accent-foreground hover:shadow-md focus:shadow-md data-[highlighted]:bg-accent data-[highlighted]:shadow-md active:shadow-none"
              >
                <Pencil className="h-4 w-4" />
                重命名
              </DropdownMenuItem>
            )}
            {!isMain && onDelete && (
              <DropdownMenuItem
                variant="destructive"
                onClick={onDelete}
                className="transition-[background-color,box-shadow] duration-150 ease-out hover:bg-destructive/10 hover:text-destructive hover:shadow-md focus:shadow-md data-[highlighted]:bg-destructive/10 data-[highlighted]:shadow-md active:shadow-none"
              >
                <Trash2 className="h-4 w-4" />
                删除
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
