import { memo, useCallback, useMemo, useState, type ReactNode } from 'react';
import { AnimatePresence, m } from 'motion/react';
import {
  ChevronRight,
  Link2,
  Pin,
  Play,
  Search,
  Timer,
  Trash2,
} from 'lucide-react';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { TeamSessionTag } from '../../team/TeamSessionTag';
import { isTeamSession } from '../../../lib/team-mode';
import { useShellStore } from '../../../stores/shell';
import { useAutomationsStore } from '../../../stores/automations';
import { useIsGuest } from '../../../stores/auth';
import {
  openWorkspaceSession,
  type NavigateToPath,
} from '../../../lib/chat-navigation';
import {
  formatSessionTime,
  messagePreview,
  sessionActivityAt,
  sessionDisplayName,
  sessionListItems,
  type AutomationSessionGroup,
} from '../../../lib/session-presentation';
import type { Automation } from '../../../lib/automation';
import type { AgentInfo, SessionWorktreeInfo } from '../../../types';
import { WorktreeBranchTag } from '../../chat/WorktreeBranchTag';
import {
  AutomationMenuItems,
  BoundAutomationMark,
  UnreadDot,
  useAutomationGroup,
  useBoundAutomations,
} from '../../automations/AutomationSessionBits';
import { runAutomationNow } from '../../automations/automation-actions';
import type { GroupEntry } from '../../../utils/group-utils';
import { sidebarRowClass } from './SidebarItem';
import {
  MenuActionItems,
  RowMenu,
  revealOnRowHover,
  rowIconButtonClass,
} from './WorkspaceTree';
import {
  RenameSessionDialog,
  useSessionDelete,
  useSessionRowActions,
  useWorkspaceSessions,
} from './workspace-sessions';

const INITIAL_VISIBLE = 8;
const SEARCH_THRESHOLD = 8;
const NO_AUTOMATIONS: Automation[] = [];

interface SessionTreeListProps {
  group: GroupEntry;
  /** Whether this workspace is the one open in the canvas. */
  isCurrent: boolean;
  /** Session open in the canvas, if any. */
  activeSessionId: string | null;
  /** Nesting depth of the workspace row, so sessions align with its name. */
  depth?: number;
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
  depth = 0,
  navigate,
}: SessionTreeListProps) {
  const { containerRef, sessions } = useWorkspaceSessions<HTMLDivElement>(
    group.jid,
  );
  const requestBinding = useShellStore((s) => s.requestBinding);
  const boundTo = useBoundAutomations(group.jid);
  const deleteSession = useSessionDelete(group);
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);
  const [query, setQuery] = useState('');
  const [renameTarget, setRenameTarget] = useState<AgentInfo | null>(null);

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
  const filtered = useMemo(
    () =>
      searchText
        ? sessions.filter((session) =>
            searchText.get(session.id)?.includes(normalizedQuery),
          )
        : sessions,
    [sessions, searchText, normalizedQuery],
  );
  // Sessions an automation opened fold into its row, where its newest is.
  const items = useMemo(() => sessionListItems(filtered), [filtered]);
  const visible = items.slice(0, visibleCount);

  // Binding lives in ChatView: open the session so it can react.
  const openBinding = useCallback(
    (session: AgentInfo) => {
      openWorkspaceSession(navigate, group, session.id);
      requestBinding(group.jid, session.id);
    },
    [navigate, group, requestBinding],
  );
  const menuFor = useSessionRowActions(group, {
    onBind: openBinding,
    onRename: setRenameTarget,
  });

  const renderSession = (session: AgentInfo) => {
    const menu = menuFor(session);
    const name = sessionDisplayName(session);
    return (
      <SessionRow
        name={name}
        active={isCurrent && activeSessionId === session.id}
        running={session.status === 'running'}
        titleGenerating={session.title_generating}
        pinned={!!session.pinned_at}
        linked={(session.linked_im_groups?.length ?? 0) > 0}
        worktree={session.worktree}
        automations={boundTo(session)}
        tag={
          isTeamSession(session) && (
            <TeamSessionTag workspaceJid={group.jid} session={session} />
          )
        }
        time={formatSessionTime(sessionActivityAt(session))}
        onSelect={() => openWorkspaceSession(navigate, group, session.id)}
        onDelete={deleteSession && (() => deleteSession(session))}
        deleteLabel={`删除${name}`}
        menuLabel={`${name}的更多操作`}
        menu={menu ? <MenuActionItems groups={menu} /> : undefined}
      />
    );
  };

  return (
    <div
      ref={containerRef}
      className={cn('relative pt-0.5 pb-1', depth > 0 ? 'pl-7' : 'pl-3.5')}
    >
      {/* Tree guide line under the workspace row's icon. */}
      <span
        aria-hidden="true"
        className={cn(
          'absolute top-0 bottom-1 w-px bg-surface-border',
          depth > 0 ? 'left-[1.625rem]' : 'left-3.5',
        )}
      />
      {sessions.length >= SEARCH_THRESHOLD && (
        <label className="mb-0.5 ml-2 flex h-7 items-center gap-1.5 rounded-md px-2 text-caption text-muted-foreground focus-within:bg-surface-hover">
          <Search className="size-3.5 shrink-0" />
          <span className="sr-only">搜索会话</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={`搜索 ${sessions.length} 个会话…`}
            enterKeyHint="search"
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint-foreground phone:text-base"
          />
        </label>
      )}
      <ul>
        <AnimatePresence initial={false}>
          {visible.map((item) =>
            item.kind === 'automation' ? (
              <AutomationGroupRow
                key={`automation:${item.group.automationId}`}
                group={item.group}
                // A search shows its matches without a click.
                forceExpanded={searching}
                containsActive={
                  isCurrent &&
                  item.group.sessions.some(
                    (session) => session.id === activeSessionId,
                  )
                }
                navigate={navigate}
              >
                {item.group.sessions.map((session) => (
                  <li key={session.id} className="list-none">
                    {renderSession(session)}
                  </li>
                ))}
              </AutomationGroupRow>
            ) : (
              <m.li
                key={item.session.id}
                // Search results appear and disappear instantly: animating
                // dozens of rows in and out on every keystroke was a third of
                // the per-key cost in long lists.
                initial={searching ? false : { opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={searching ? undefined : { opacity: 0, height: 0 }}
                className="list-none overflow-hidden"
              >
                {renderSession(item.session)}
              </m.li>
            ),
          )}
        </AnimatePresence>
      </ul>
      {items.length > visibleCount && (
        <button
          type="button"
          onClick={() => setVisibleCount((n) => n + 30)}
          className={cn(sidebarRowClass, 'ml-2 h-7 w-auto text-caption')}
        >
          显示更多（{items.length - visibleCount}）
        </button>
      )}
      {normalizedQuery && filtered.length === 0 && (
        <p className="px-4 py-1.5 text-caption text-faint-foreground">
          没有匹配的会话
        </p>
      )}
      {!normalizedQuery && sessions.length === 0 && (
        <p className="px-4 py-1.5 text-caption text-faint-foreground">
          暂无会话
        </p>
      )}
      <RenameSessionDialog
        groupJid={group.jid}
        session={renameTarget}
        onClose={() => setRenameTarget(null)}
      />
    </div>
  );
});

/**
 * One automation's sessions under a collapsible row: its name, whether a
 * run goes or results wait unread, and 立即运行 / ⋯ on hover.
 */
function AutomationGroupRow({
  group,
  forceExpanded,
  containsActive,
  navigate,
  children,
}: {
  group: AutomationSessionGroup;
  forceExpanded: boolean;
  containsActive: boolean;
  navigate: NavigateToPath;
  children: ReactNode;
}) {
  const {
    automation,
    name,
    running,
    expanded: stored,
    toggle,
  } = useAutomationGroup(group);
  const busy = useAutomationsStore((s) => !!s.runBusy[group.automationId]);
  const isGuest = useIsGuest();
  const expanded = forceExpanded || stored;

  return (
    <li className="list-none">
      <div
        data-active={(!expanded && containsActive) || undefined}
        className={cn(
          sidebarRowClass,
          'ml-2 h-7 w-[calc(100%-0.5rem)] gap-1.5 pr-1',
        )}
      >
        <button
          type="button"
          aria-expanded={expanded}
          onClick={toggle}
          className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left outline-none"
        >
          <Timer
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden="true"
          />
          <span className="truncate">{name}</span>
          <span className="shrink-0 text-micro text-faint-foreground tabular-nums">
            {group.sessions.length}
          </span>
          <ChevronRight
            aria-hidden="true"
            className={cn(
              'size-3 shrink-0 text-faint-foreground transition-transform duration-150 motion-reduce:transition-none',
              expanded && 'rotate-90',
            )}
          />
        </button>
        {running ? (
          <Spinner
            className="size-3 shrink-0 text-muted-foreground"
            aria-label="自动化运行中"
          />
        ) : (
          automation && <UnreadDot automation={automation} />
        )}
        {automation && (
          <span className="flex shrink-0 items-center">
            {!isGuest && (
              <button
                type="button"
                aria-label={`立即运行「${name}」`}
                disabled={busy}
                onClick={(event) => {
                  event.stopPropagation();
                  void runAutomationNow(automation.id);
                }}
                className={cn(rowIconButtonClass, revealOnRowHover)}
              >
                <Play className="size-3.5" />
              </button>
            )}
            <RowMenu label={`${name}的更多操作`}>
              <AutomationMenuItems
                automation={automation}
                navigate={navigate}
              />
            </RowMenu>
          </span>
        )}
      </div>
      {expanded && <ul className="pl-3">{children}</ul>}
    </li>
  );
}

function SessionRow({
  name,
  active,
  running = false,
  titleGenerating = false,
  pinned = false,
  linked = false,
  worktree,
  automations = NO_AUTOMATIONS,
  tag,
  time,
  onSelect,
  onDelete,
  deleteLabel,
  menu,
  menuLabel,
}: {
  name: string;
  active: boolean;
  running?: boolean;
  titleGenerating?: boolean;
  pinned?: boolean;
  linked?: boolean;
  worktree?: SessionWorktreeInfo | null;
  /** Automations bound to this session, shown as a timer mark. */
  automations?: Automation[];
  /** Team mode's 团队路由 / #N 工作项 tag. */
  tag?: React.ReactNode;
  time?: string;
  onSelect: () => void;
  /** Shown next to the menu on hover; the handler asks for confirmation. */
  onDelete?: () => void;
  deleteLabel?: string;
  menu?: React.ReactNode;
  menuLabel: string;
}) {
  const hasActions = !!menu || !!onDelete;
  return (
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
        {pinned && (
          <Pin
            className="size-3 shrink-0 text-faint-foreground"
            aria-label="已置顶"
          />
        )}
        {worktree && (
          <WorktreeBranchTag worktree={worktree} compact className="max-w-24" />
        )}
        {linked && (
          <Link2
            className="size-3 shrink-0 text-faint-foreground"
            aria-label="已绑定消息渠道"
          />
        )}
      </button>
      {tag}
      <BoundAutomationMark automations={automations} />
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
              hasActions &&
                'pointer-fine:group-hover/sidebar-row:hidden pointer-fine:group-has-[:focus-visible]/sidebar-row:hidden pointer-fine:group-has-[[aria-expanded=true]]/sidebar-row:hidden',
            )}
          >
            {time}
          </span>
        )
      )}
      {hasActions && (
        // The time gives way to the actions on hover, keyboard focus, or
        // while the menu is open.
        <span
          className={cn(
            'flex shrink-0 items-center',
            time &&
              'pointer-fine:hidden pointer-fine:group-hover/sidebar-row:flex pointer-fine:group-has-[:focus-visible]/sidebar-row:flex pointer-fine:has-[[aria-expanded=true]]:flex',
          )}
        >
          {onDelete && (
            <button
              type="button"
              aria-label={deleteLabel}
              onClick={(event) => {
                event.stopPropagation();
                onDelete();
              }}
              className={cn(
                rowIconButtonClass,
                revealOnRowHover,
                'hover:text-destructive',
              )}
            >
              <Trash2 className="size-3.5" />
            </button>
          )}
          {menu && <RowMenu label={menuLabel}>{menu}</RowMenu>}
        </span>
      )}
    </div>
  );
}
