import {
  memo,
  useEffect,
  useId,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { AnimatePresence, m } from 'motion/react';
import {
  ChevronRight,
  MoreHorizontal,
  Pencil,
  Pin,
  RotateCcw,
  Trash2,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';
import { useAuthStore } from '../../../stores/auth';
import { useChatStore } from '../../../stores/chat';
import { useGroupsStore } from '../../../stores/groups';
import type { GroupEntry } from '../../../utils/group-utils';
import {
  type AgentWorkspaceSection,
  getAgentNavigationTargets,
  getPrimaryAgentWorkspaceRows,
  isAgentSectionCollapsible,
} from '../../../utils/agent-product';
import { sidebarRowClass } from './SidebarItem';

const COLLAPSED_AGENTS_KEY = 'happyclaw:collapsed-agent-sections';

function readCollapsedAgents(): Set<string> {
  try {
    const value = JSON.parse(
      localStorage.getItem(COLLAPSED_AGENTS_KEY) || '[]',
    );
    return new Set(
      Array.isArray(value) ? value.filter((id) => typeof id === 'string') : [],
    );
  } catch {
    return new Set();
  }
}

function persistAgentState(agentId: string, collapsed: boolean) {
  try {
    const ids = readCollapsedAgents();
    if (collapsed) ids.add(agentId);
    else ids.delete(agentId);
    localStorage.setItem(COLLAPSED_AGENTS_KEY, JSON.stringify([...ids]));
  } catch {
    // Private browsing or hardened policies may disable persistent storage.
  }
}

export type WorkspaceTreeVariant = 'sidebar' | 'mobile';

export interface WorkspaceActions {
  onSelect: (group: GroupEntry) => void;
  onRename?: (jid: string, name: string) => void;
  onClearHistory: (jid: string, name: string) => void;
  onDelete?: (jid: string, name: string) => void;
  onTogglePin?: (jid: string) => void;
}

interface WorkspaceTreeProps extends WorkspaceActions {
  variant: WorkspaceTreeVariant;
  primary: AgentWorkspaceSection | null;
  custom: AgentWorkspaceSection[];
  currentGroupJid: string | null;
  /** Session open in the canvas; passed only to the current workspace row. */
  activeSessionId?: string | null;
  /** Desktop only: whether a workspace row shows its nested sessions. */
  isExpanded?: (group: GroupEntry) => boolean;
  onToggleExpanded?: (group: GroupEntry, expanded: boolean) => void;
  renderSessions?: (
    group: GroupEntry,
    isCurrent: boolean,
    activeSessionId: string | null,
  ) => ReactNode;
}

/**
 * Agent-first workspace navigation: the primary agent's workspaces, then each
 * custom agent as a collapsible group. Desktop rows can expand to show their
 * sessions (Codex-style projects → threads).
 */
export const WorkspaceTree = memo(function WorkspaceTree({
  variant,
  primary,
  custom,
  currentGroupJid,
  activeSessionId = null,
  isExpanded,
  onToggleExpanded,
  renderSessions,
  onSelect,
  onRename,
  onClearHistory,
  onDelete,
  onTogglePin,
}: WorkspaceTreeProps) {
  // Rows are memoized and receive only primitives plus stable callbacks, so
  // switching session or workspace re-renders the rows whose state changed
  // instead of every row of a long tree.
  const actions = useMemo<WorkspaceActions>(
    () => ({ onSelect, onRename, onClearHistory, onDelete, onTogglePin }),
    [onSelect, onRename, onClearHistory, onDelete, onTogglePin],
  );
  const primaryRows = useMemo(
    () => (primary ? getPrimaryAgentWorkspaceRows(primary) : []),
    [primary],
  );
  const nested = !!renderSessions && variant !== 'mobile';
  const rowProps = (group: GroupEntry) => {
    const isActive = currentGroupJid === group.jid;
    return {
      variant,
      isActive,
      expanded: nested && !!isExpanded?.(group),
      activeSessionId: isActive ? activeSessionId : null,
      onToggleExpanded,
      renderSessions,
      actions,
    };
  };

  return (
    <div className="flex flex-col gap-3">
      {primary && (
        <section aria-labelledby={`${variant}-primary-agent-heading`}>
          <h2
            id={`${variant}-primary-agent-heading`}
            className="truncate px-2 pb-1 text-micro font-medium text-faint-foreground"
          >
            主智能体 · {primary.name}
          </h2>
          <ul data-hc-primary-agent-workspaces={primary.id}>
            {primaryRows.map((group) => (
              <WorkspaceRow
                key={group.jid}
                group={group}
                isHome={!!group.is_my_home}
                {...rowProps(group)}
              />
            ))}
          </ul>
        </section>
      )}
      {custom.length > 0 && (
        <section aria-labelledby={`${variant}-custom-agent-heading`}>
          <h2
            id={`${variant}-custom-agent-heading`}
            className="px-2 pb-1 text-micro font-medium text-faint-foreground"
          >
            自定义智能体
          </h2>
          {custom.map((section) => (
            <AgentGroup
              key={section.id}
              section={section}
              variant={variant}
              currentGroupJid={currentGroupJid}
              actions={actions}
            >
              {getAgentNavigationTargets(section).workspaces.map((group) => (
                <WorkspaceRow
                  key={group.jid}
                  group={group}
                  isHome={false}
                  indent
                  {...rowProps(group)}
                />
              ))}
            </AgentGroup>
          ))}
        </section>
      )}
    </div>
  );
});

function AgentGroup({
  section,
  variant,
  currentGroupJid,
  actions,
  children,
}: {
  section: AgentWorkspaceSection;
  variant: WorkspaceTreeVariant;
  currentGroupJid: string | null;
  actions: WorkspaceActions;
  children: ReactNode;
}) {
  const contentId = useId();
  const collapsible = isAgentSectionCollapsible(section);
  const containsActive = section.items.some(
    (item) => item.jid === currentGroupJid,
  );
  const [storedExpanded, setStoredExpanded] = useState(
    () => containsActive || !readCollapsedAgents().has(section.id),
  );
  const expanded = !collapsible || storedExpanded;
  useEffect(() => {
    if (collapsible && containsActive) setStoredExpanded(true);
  }, [collapsible, containsActive]);

  const { directGroup, workspaces } = getAgentNavigationTargets(section);
  const runningCount = useGroupsStore(
    (s) =>
      section.items.filter((item) => s.runnerStates[item.jid] === 'running')
        .length,
  );
  const isDirectActive =
    !!directGroup?.is_my_home && directGroup.jid === currentGroupJid;
  const canRebuild = !!directGroup?.is_my_home && directGroup.can_modify;
  const touch = variant === 'mobile';

  const toggle = () => {
    if (!collapsible) return;
    setStoredExpanded(!expanded);
    persistAgentState(section.id, expanded);
  };

  return (
    <div
      className="mb-0.5"
      data-hc-agent-group={section.id}
      data-collapsible={collapsible ? 'true' : 'false'}
    >
      <div
        data-active={isDirectActive || undefined}
        className={cn(
          sidebarRowClass,
          'gap-1 pr-1 pl-0.5 text-foreground',
          touch && 'h-11 text-body-lg',
        )}
      >
        <button
          type="button"
          onClick={toggle}
          disabled={!collapsible}
          aria-expanded={expanded}
          aria-controls={contentId}
          aria-label={`${expanded ? '收起' : '展开'} ${section.name} 的工作区`}
          className="grid size-6 shrink-0 cursor-pointer place-items-center rounded text-faint-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-default"
        >
          <ChevronRight
            className={cn(
              'size-3.5 transition-transform duration-150',
              expanded && 'rotate-90',
            )}
          />
        </button>
        <button
          type="button"
          onClick={() => directGroup && actions.onSelect(directGroup)}
          aria-current={isDirectActive ? 'page' : undefined}
          className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left font-medium outline-none"
        >
          <span className="truncate">{section.name}</span>
          {!expanded && workspaces.length > 0 && (
            <span className="min-w-0 truncate text-caption font-normal text-faint-foreground">
              ·{' '}
              {workspaces
                .slice(0, 2)
                .map((w) => w.name)
                .join(' · ')}
              {workspaces.length > 2 ? ` +${workspaces.length - 2}` : ''}
            </span>
          )}
        </button>
        {runningCount > 0 && (
          <Spinner
            className="size-3 text-muted-foreground"
            aria-label={`${runningCount} 个工作区运行中`}
          />
        )}
        {expanded && workspaces.length > 0 && (
          <span className="shrink-0 px-1 text-micro text-faint-foreground tabular-nums">
            {workspaces.length}
          </span>
        )}
        {canRebuild && (
          <RowMenu label={`${section.name}的更多操作`} touch={touch}>
            <DropdownMenuItem
              onClick={() =>
                actions.onClearHistory(directGroup!.jid, section.name)
              }
            >
              <RotateCcw />
              重建工作区
            </DropdownMenuItem>
          </RowMenu>
        )}
      </div>
      <AnimatePresence initial={false}>
        {expanded && (
          <m.ul
            id={contentId}
            key="workspaces"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="overflow-hidden"
          >
            {children}
          </m.ul>
        )}
      </AnimatePresence>
    </div>
  );
}

const WorkspaceRow = memo(function WorkspaceRow({
  group,
  isHome,
  indent = false,
  variant,
  isActive,
  expanded,
  activeSessionId,
  onToggleExpanded,
  renderSessions,
  actions,
}: {
  group: GroupEntry;
  isHome: boolean;
  indent?: boolean;
  variant: WorkspaceTreeVariant;
  isActive: boolean;
  expanded: boolean;
  activeSessionId: string | null;
  onToggleExpanded?: (group: GroupEntry, expanded: boolean) => void;
  renderSessions?: (
    group: GroupEntry,
    isCurrent: boolean,
    activeSessionId: string | null,
  ) => ReactNode;
  actions: WorkspaceActions;
}) {
  const currentUser = useAuthStore((s) => s.user);
  const isRunning = useGroupsStore(
    (s) => s.runnerStates[group.jid] === 'running',
  );
  const unread = useChatStore((s) => s.unreadReplies[group.jid] ?? 0);
  const touch = variant === 'mobile';
  const nested = !!renderSessions && !touch;

  // Use the real name once renamed, otherwise the friendly home default.
  const isDefaultName =
    !group.name ||
    group.name === 'Main' ||
    group.name === `${currentUser?.username} Home`;
  const displayName = isHome && isDefaultName ? '我的工作区' : group.name;
  const canModify = !!group.can_modify;
  const showMenu =
    (!isHome && !!actions.onTogglePin) ||
    (canModify && !!actions.onRename) ||
    canModify;

  return (
    <li className="list-none">
      <div
        data-active={isActive && !expanded ? true : undefined}
        className={cn(
          sidebarRowClass,
          'gap-1 pr-1 pl-0.5',
          isActive ? 'text-foreground' : 'text-sidebar-foreground/85',
          indent && !touch && 'pl-3',
          touch && 'h-11 pl-2 text-body-lg',
          // Workspaces under a custom agent sit under its chevron row.
          indent && touch && 'pl-8',
        )}
      >
        {nested ? (
          <button
            type="button"
            onClick={() => onToggleExpanded?.(group, !expanded)}
            aria-expanded={expanded}
            aria-label={`${expanded ? '收起' : '展开'} ${displayName} 的会话`}
            className="grid size-6 shrink-0 cursor-pointer place-items-center rounded text-faint-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
          >
            <ChevronRight
              className={cn(
                'size-3.5 transition-transform duration-150',
                expanded && 'rotate-90',
              )}
            />
          </button>
        ) : (
          !touch && <span className="w-1.5 shrink-0" />
        )}
        <button
          type="button"
          onClick={() => actions.onSelect(group)}
          aria-current={isActive ? 'page' : undefined}
          className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left outline-none"
        >
          <span className="truncate">{displayName}</span>
          {group.pinned_at && !isHome && (
            <Pin
              className="size-3 shrink-0 text-faint-foreground"
              aria-label="已固定"
            />
          )}
        </button>
        {isRunning ? (
          <Spinner
            className="size-3 text-muted-foreground"
            aria-label="运行中"
          />
        ) : unread > 0 && !isActive ? (
          <span className="min-w-4 shrink-0 rounded-full bg-primary/12 px-1 text-center text-micro font-medium text-primary-text tabular-nums">
            {unread > 99 ? '99+' : unread}
          </span>
        ) : null}
        {showMenu && (
          <RowMenu label={`${displayName}的更多操作`} touch={touch}>
            {!isHome && actions.onTogglePin && (
              <DropdownMenuItem onClick={() => actions.onTogglePin!(group.jid)}>
                <Pin />
                {group.pinned_at ? '取消固定' : '固定'}
              </DropdownMenuItem>
            )}
            {canModify && actions.onRename && (
              <DropdownMenuItem
                onClick={() => actions.onRename!(group.jid, group.name)}
              >
                <Pencil />
                重命名
              </DropdownMenuItem>
            )}
            {canModify && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => actions.onClearHistory(group.jid, displayName)}
                >
                  <RotateCcw />
                  重建工作区
                </DropdownMenuItem>
              </>
            )}
            {!isHome && canModify && actions.onDelete && (
              <DropdownMenuItem
                variant="destructive"
                onClick={() => actions.onDelete!(group.jid, group.name)}
              >
                <Trash2 />
                删除
              </DropdownMenuItem>
            )}
          </RowMenu>
        )}
      </div>
      {nested && (
        <AnimatePresence initial={false}>
          {expanded && (
            <m.div
              key="sessions"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              className="overflow-hidden"
            >
              {renderSessions!(group, isActive, activeSessionId)}
            </m.div>
          )}
        </AnimatePresence>
      )}
    </li>
  );
});

/**
 * Hover-revealed "more" menu; always visible on touch screens.
 *
 * The Radix menu mounts on first use. Every mounted menu root adds document
 * listeners that run on each keystroke anywhere in the app, and a long tree
 * holds one per row: with ~4,000 rows each key press in the composer cost
 * ~200ms at 4x CPU throttle. Until then a plain button stands in, opening the
 * menu from the pointer or keyboard the way the Radix trigger does.
 */
export function RowMenu({
  label,
  touch = false,
  children,
}: {
  label: string;
  touch?: boolean;
  children: ReactNode;
}) {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const className = cn(
    'grid size-6 shrink-0 cursor-pointer place-items-center rounded text-muted-foreground outline-none transition-opacity hover:bg-surface-hover hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/40 aria-expanded:opacity-100',
    touch
      ? 'size-9'
      : 'pointer-fine:opacity-0 pointer-fine:group-hover/sidebar-row:opacity-100',
  );
  const icon = <MoreHorizontal className="size-4" />;

  if (!mounted) {
    const openMenu = () => {
      setMounted(true);
      setOpen(true);
    };
    return (
      <button
        type="button"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={false}
        onClick={(event) => event.stopPropagation()}
        onPointerDown={(event) => {
          if (event.button !== 0 || event.ctrlKey) return;
          event.preventDefault();
          openMenu();
        }}
        onKeyDown={(event) => {
          if (['Enter', ' ', 'ArrowDown'].includes(event.key)) {
            event.preventDefault();
            openMenu();
          }
        }}
        className={className}
      >
        {icon}
      </button>
    );
  }

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          onClick={(event) => event.stopPropagation()}
          aria-label={label}
          className={className}
        >
          {icon}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-40">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
