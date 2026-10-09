import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { Link2, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { PromptDialog } from '@/components/common/PromptDialog';
import { cn } from '@/lib/utils';
import { useChatStore } from '../../../stores/chat';
import { useShellStore } from '../../../stores/shell';
import { useSessionActions } from '../../../hooks/useSessionActions';
import {
  chatHref,
  openWorkspaceSession,
  type NavigateToPath,
} from '../../../lib/chat-navigation';
import {
  buildConversationSessions,
  formatSessionTime,
  isNativeManagedSession,
  messagePreview,
  sessionActivityAt,
} from '../../../lib/session-presentation';
import type { AgentInfo } from '../../../types';
import type { GroupEntry } from '../../../utils/group-utils';
import { sidebarRowClass } from './SidebarItem';
import { RowMenu } from './WorkspaceTree';

const EMPTY_AGENTS: AgentInfo[] = [];
const INITIAL_VISIBLE = 12;
const SEARCH_THRESHOLD = 8;
const MAIN_BINDING = '__main__';

interface SessionTreeListProps {
  group: GroupEntry;
  /** Whether this workspace is the one open in the canvas. */
  isCurrent: boolean;
  /** Session open in the canvas (null = main conversation). */
  activeSessionId: string | null;
  /**
   * Stable navigation from the sidebar. `useNavigate()` here would re-render
   * every expanded list on each route change.
   */
  navigate: NavigateToPath;
}

/** Sessions nested under an expanded workspace in the desktop sidebar. */
export const SessionTreeList = memo(function SessionTreeList({
  group,
  isCurrent,
  activeSessionId,
  navigate,
}: SessionTreeListProps) {
  const loadAgents = useChatStore((s) => s.loadAgents);
  const renameConversation = useChatStore((s) => s.renameConversation);
  const agents = useChatStore((s) => s.agents[group.jid] ?? EMPTY_AGENTS);
  // A joined id string keeps streaming deltas from re-rendering the tree:
  // it only changes when a session starts or stops answering.
  const activeQueryIds = useChatStore((s) =>
    (s.agents[group.jid] ?? EMPTY_AGENTS)
      .filter((a) => s.agentWaiting[a.id] || s.agentStreaming[a.id])
      .map((a) => a.id)
      .join(','),
  );
  const requestBinding = useShellStore((s) => s.requestBinding);
  const { creatingSession, createSession, deleteSession } = useSessionActions();
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);
  const [query, setQuery] = useState('');
  const [renameTarget, setRenameTarget] = useState<AgentInfo | null>(null);

  // Fetch the session list once the subtree scrolls into view: an expanded
  // workspace far down the tree should not cost a request on every load.
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = containerRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      void loadAgents(group.jid);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        void loadAgents(group.jid);
      },
      { rootMargin: '200px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [group.jid, loadAgents]);

  const sessions = useMemo(() => {
    const active = new Set(activeQueryIds ? activeQueryIds.split(',') : []);
    return buildConversationSessions(agents, (id) => active.has(id));
  }, [agents, activeQueryIds]);

  const isTopicWorkspace =
    group.conversation_nav_mode === 'vertical_threads' ||
    group.conversation_source === 'native_thread' ||
    group.conversation_source === 'feishu_thread' ||
    sessions.some(
      (a) =>
        a.source_kind === 'native_thread' || a.source_kind === 'feishu_thread',
    );
  const canModify = !!group.can_modify;
  const normalizedQuery = query.trim().toLocaleLowerCase();
  // Lowercased name and preview per session, built once per list while
  // searching instead of for every session on every keystroke.
  const searching = normalizedQuery.length > 0;
  const searchText = useMemo(
    () =>
      searching
        ? new Map(
            sessions.map((session) => [
              session.id,
              `${session.name}\n${messagePreview(session)}`.toLocaleLowerCase(),
            ]),
          )
        : null,
    [sessions, searching],
  );
  const filtered = searchText
    ? sessions.filter((session) =>
        searchText.get(session.id)?.includes(normalizedQuery),
      )
    : sessions;
  const visible = filtered.slice(0, visibleCount);
  const mainLabel = group.is_my_home ? '直接对话' : '当前对话';
  const createLabel = isTopicWorkspace ? '新建 Web 会话' : '新建会话';

  // Binding lives in ChatView; open the workspace first so it can react.
  const openBinding = (target: string) => {
    if (!isCurrent) navigate(chatHref(group.folder));
    requestBinding(group.jid, target);
  };

  const handleCreate = async () => {
    const agent = await createSession(group.jid);
    if (agent) openWorkspaceSession(navigate, group, agent.id);
  };

  return (
    <div ref={containerRef} className="relative pt-0.5 pb-1 pl-4">
      {/* Tree guide line aligned with the workspace chevron. */}
      <span
        aria-hidden="true"
        className="absolute top-0 bottom-1 left-[1.05rem] w-px bg-surface-border"
      />
      {sessions.length >= SEARCH_THRESHOLD && (
        <label className="mb-0.5 ml-2 flex h-7 items-center gap-1.5 rounded-md px-2 text-caption text-muted-foreground focus-within:bg-surface-hover">
          <Search className="size-3.5 shrink-0" />
          <span className="sr-only">搜索会话</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`搜索 ${sessions.length + 1} 个会话…`}
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint-foreground"
          />
        </label>
      )}
      <ul>
        <SessionRow
          name={mainLabel}
          active={isCurrent && activeSessionId === null}
          onSelect={() => openWorkspaceSession(navigate, group, null)}
          menu={
            canModify ? (
              <DropdownMenuItem onClick={() => openBinding(MAIN_BINDING)}>
                <Link2 />
                会话绑定
              </DropdownMenuItem>
            ) : undefined
          }
          menuLabel={`${mainLabel}的更多操作`}
        />
        <AnimatePresence initial={false}>
          {visible.map((session) => {
            const nativeManaged = isNativeManagedSession(session);
            return (
              <m.li
                key={session.id}
                // Search results appear and disappear instantly: animating
                // dozens of rows in and out on every keystroke was a third of
                // the per-key cost in long lists.
                initial={searching ? false : { opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={searching ? undefined : { opacity: 0, height: 0 }}
                className="list-none overflow-hidden"
              >
                <SessionRow
                  asListItem={false}
                  name={session.name || '新会话'}
                  active={isCurrent && activeSessionId === session.id}
                  running={session.status === 'running'}
                  titleGenerating={session.title_generating}
                  linked={(session.linked_im_groups?.length ?? 0) > 0}
                  time={formatSessionTime(sessionActivityAt(session))}
                  onSelect={() =>
                    openWorkspaceSession(navigate, group, session.id)
                  }
                  menuLabel={`${session.name}的更多操作`}
                  menu={
                    canModify && !nativeManaged ? (
                      <>
                        <DropdownMenuItem
                          onClick={() => openBinding(session.id)}
                        >
                          <Link2 />
                          会话绑定
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => setRenameTarget(session)}
                        >
                          <Pencil />
                          重命名
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() =>
                            deleteSession(group.jid, session.id, openBinding)
                          }
                        >
                          <Trash2 />
                          删除
                        </DropdownMenuItem>
                      </>
                    ) : undefined
                  }
                />
              </m.li>
            );
          })}
        </AnimatePresence>
      </ul>
      {filtered.length > visibleCount && (
        <button
          type="button"
          onClick={() => setVisibleCount((n) => n + 30)}
          className={cn(sidebarRowClass, 'ml-2 h-7 w-auto text-caption')}
        >
          显示更多（{filtered.length - visibleCount}）
        </button>
      )}
      {normalizedQuery && filtered.length === 0 && (
        <p className="px-4 py-1.5 text-caption text-faint-foreground">
          没有匹配的会话
        </p>
      )}
      {canModify && (
        <button
          type="button"
          onClick={() => void handleCreate()}
          disabled={creatingSession}
          aria-busy={creatingSession}
          className={cn(
            sidebarRowClass,
            'ml-2 h-7 w-[calc(100%-0.5rem)] text-caption text-faint-foreground',
          )}
        >
          {creatingSession ? (
            <Spinner className="size-3.5" />
          ) : (
            <Plus className="size-3.5" />
          )}
          {createLabel}
        </button>
      )}
      <PromptDialog
        open={renameTarget !== null}
        title="重命名对话"
        label="对话名称"
        placeholder="输入新名称"
        defaultValue={renameTarget?.name ?? ''}
        onConfirm={(name) => {
          if (renameTarget)
            void renameConversation(group.jid, renameTarget.id, name);
        }}
        onClose={() => setRenameTarget(null)}
      />
    </div>
  );
});

function SessionRow({
  name,
  active,
  running = false,
  titleGenerating = false,
  linked = false,
  time,
  onSelect,
  menu,
  menuLabel,
  asListItem = true,
}: {
  name: string;
  active: boolean;
  running?: boolean;
  titleGenerating?: boolean;
  linked?: boolean;
  time?: string;
  onSelect: () => void;
  menu?: React.ReactNode;
  menuLabel: string;
  asListItem?: boolean;
}) {
  const row = (
    <div
      data-active={active || undefined}
      className={cn(
        sidebarRowClass,
        'ml-2 h-7 w-[calc(100%-0.5rem)] gap-1.5 pr-1',
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? 'page' : undefined}
        className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left outline-none"
      >
        <span className="truncate">{name}</span>
        {linked && (
          <Link2
            className="size-3 shrink-0 text-faint-foreground"
            aria-label="已绑定消息渠道"
          />
        )}
      </button>
      {running || titleGenerating ? (
        <Spinner
          className="size-3 shrink-0 text-muted-foreground"
          aria-label={titleGenerating ? '正在生成标题' : '正在生成回复'}
        />
      ) : (
        time && (
          <span
            className={cn(
              'shrink-0 text-micro text-faint-foreground tabular-nums',
              menu &&
                'pointer-fine:group-hover/sidebar-row:hidden pointer-fine:group-has-[[aria-expanded=true]]/sidebar-row:hidden',
            )}
          >
            {time}
          </span>
        )
      )}
      {menu && (
        <span
          className={cn(
            'shrink-0',
            time &&
              'pointer-fine:hidden pointer-fine:group-hover/sidebar-row:block pointer-fine:has-[[aria-expanded=true]]:block',
          )}
        >
          <RowMenu label={menuLabel}>{menu}</RowMenu>
        </span>
      )}
    </div>
  );
  return asListItem ? <li className="list-none">{row}</li> : row;
}
