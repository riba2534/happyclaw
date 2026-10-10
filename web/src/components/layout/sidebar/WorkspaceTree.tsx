import {
  memo,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { AnimatePresence, m } from 'motion/react';
import {
  Bot,
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  MoreHorizontal,
  Pencil,
  Pin,
  Plus,
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
import { EmojiAvatar } from '../../common/EmojiAvatar';
import { useAuthStore, type AppearanceConfig } from '../../../stores/auth';
import { useChatStore } from '../../../stores/chat';
import { useGroupsStore } from '../../../stores/groups';
import type { GroupEntry } from '../../../utils/group-utils';
import {
  type AgentWorkspaceSection,
  getAgentNavigationTargets,
  getPrimaryAgentWorkspaceRows,
  isAgentSectionCollapsible,
} from '../../../utils/agent-product';
import {
  type AgentDisplayIdentity,
  resolveAgentDisplayIdentity,
} from '../../../utils/agent-identity';
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

/**
 * The avatar shown for an agent. The primary agent falls back to the main
 * assistant avatar exactly like chat messages do; a custom agent without its
 * own avatar shows its initial so agents stay distinguishable in the tree.
 */
function sectionIdentity(
  section: AgentWorkspaceSection,
  appearance: AppearanceConfig | null,
  primary: boolean,
): AgentDisplayIdentity {
  const lead =
    section.items.find(
      (item) =>
        item.agent_profile_avatar_url ||
        item.agent_profile_avatar_emoji ||
        item.agent_profile_avatar_color,
    ) ?? section.items[0];
  const identity = resolveAgentDisplayIdentity({
    agentName: section.name,
    avatarUrl: lead?.agent_profile_avatar_url,
    avatarEmoji: lead?.agent_profile_avatar_emoji,
    avatarColor: lead?.agent_profile_avatar_color,
    mainAvatarUrl: primary ? appearance?.aiAvatarUrl : undefined,
    mainAvatarEmoji:
      primary && appearance?.aiAvatarMode === 'emoji'
        ? appearance.aiAvatarEmoji
        : undefined,
    mainAvatarColor:
      primary && appearance?.aiAvatarMode === 'emoji'
        ? appearance.aiAvatarColor
        : undefined,
  });
  const ownAvatar = !!(
    lead?.agent_profile_avatar_url || lead?.agent_profile_avatar_emoji
  );
  return primary || ownAvatar ? identity : { ...identity, imageUrl: undefined };
}

/** Workspaces without an agent profile are grouped under a synthetic id. */
function profileIdOf(section: AgentWorkspaceSection): string | undefined {
  return section.id === '__default__' ? undefined : section.id;
}

export type WorkspaceTreeVariant = 'sidebar' | 'mobile';

export interface WorkspaceActions {
  onSelect: (group: GroupEntry) => void;
  onRename?: (jid: string, name: string) => void;
  onClearHistory: (jid: string, name: string) => void;
  onDelete?: (jid: string, name: string) => void;
  onTogglePin?: (jid: string) => void;
  /** Create a session in the workspace and open it (desktop tree). */
  onCreateSession?: (group: GroupEntry) => Promise<void>;
  /** Open the create-workspace dialog with this agent preselected. */
  onCreateWorkspace?: (agentProfileId: string) => void;
  /** Open the agent's settings. */
  onOpenAgent?: (agentProfileId: string) => void;
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
    depth: number,
  ) => ReactNode;
}

/**
 * Agent-first workspace navigation: the primary agent's workspaces, then each
 * custom agent. Desktop rows expand to show their sessions (Codex-style
 * projects → threads). An agent with a single workspace is one row, so its
 * sessions sit directly under the agent; the workspace level only appears
 * once an agent has several.
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
  onCreateSession,
  onCreateWorkspace,
  onOpenAgent,
}: WorkspaceTreeProps) {
  // Rows are memoized and receive only primitives plus stable callbacks, so
  // switching session or workspace re-renders the rows whose state changed
  // instead of every row of a long tree.
  const actions = useMemo<WorkspaceActions>(
    () => ({
      onSelect,
      onRename,
      onClearHistory,
      onDelete,
      onTogglePin,
      onCreateSession,
      onCreateWorkspace,
      onOpenAgent,
    }),
    [
      onSelect,
      onRename,
      onClearHistory,
      onDelete,
      onTogglePin,
      onCreateSession,
      onCreateWorkspace,
      onOpenAgent,
    ],
  );
  const appearance = useAuthStore((s) => s.appearance);
  const primaryIdentity = useMemo(
    () => (primary ? sectionIdentity(primary, appearance, true) : null),
    [primary, appearance],
  );
  const customIdentities = useMemo(
    () =>
      new Map(
        custom.map((section) => [
          section.id,
          sectionIdentity(section, appearance, false),
        ]),
      ),
    [custom, appearance],
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
            className="px-2 pb-1 text-micro font-medium text-faint-foreground"
          >
            主智能体
          </h2>
          <ul data-hc-primary-agent-workspaces={primary.id}>
            {primaryRows.map((group) => (
              <WorkspaceRow
                key={group.jid}
                group={group}
                isHome={!!group.is_my_home}
                identity={group.is_my_home ? primaryIdentity : null}
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
          <ul>
            {custom.map((section) => {
              const identity = customIdentities.get(section.id)!;
              if (section.items.length === 1) {
                const group = section.items[0];
                return (
                  <WorkspaceRow
                    key={group.jid}
                    group={group}
                    label={section.name}
                    agentId={profileIdOf(section)}
                    isHome={!!group.is_my_home}
                    identity={identity}
                    {...rowProps(group)}
                  />
                );
              }
              return (
                <AgentGroup
                  key={section.id}
                  section={section}
                  identity={identity}
                  variant={variant}
                  currentGroupJid={currentGroupJid}
                  actions={actions}
                >
                  {getAgentNavigationTargets(section).workspaces.map(
                    (group) => (
                      <WorkspaceRow
                        key={group.jid}
                        group={group}
                        isHome={false}
                        identity={null}
                        depth={1}
                        {...rowProps(group)}
                      />
                    ),
                  )}
                </AgentGroup>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
});

function AgentAvatar({
  identity,
  touch,
}: {
  identity: AgentDisplayIdentity;
  touch: boolean;
}) {
  return (
    <EmojiAvatar
      imageUrl={identity.imageUrl}
      emoji={identity.emoji}
      color={identity.color}
      fallbackChar={identity.fallbackChar}
      size="sm"
      className={touch ? 'size-6 text-sm' : 'size-5 text-xs'}
    />
  );
}

/**
 * Leading icon of a tree row. With `chevron`, hovering the row swaps the icon
 * for a disclosure chevron (Codex-style), so rows need no separate chevron
 * column; `onToggle` makes the slot its own expand/collapse button.
 */
function LeadingSlot({
  icon,
  chevron,
  expanded,
  label,
  onToggle,
  touch,
}: {
  icon: ReactNode;
  chevron: boolean;
  expanded: boolean;
  label?: string;
  onToggle?: () => void;
  touch: boolean;
}) {
  const content = chevron ? (
    <>
      <span className="grid place-items-center pointer-fine:group-hover/sidebar-row:hidden group-focus-visible/toggle:hidden">
        {icon}
      </span>
      <ChevronRight
        aria-hidden="true"
        className={cn(
          'hidden size-3.5 transition-transform duration-150 pointer-fine:group-hover/sidebar-row:block group-focus-visible/toggle:block',
          expanded && 'rotate-90',
        )}
      />
    </>
  ) : (
    icon
  );
  const className = cn(
    'grid shrink-0 place-items-center rounded text-faint-foreground',
    touch ? 'size-7' : 'size-6',
  );
  if (!onToggle) {
    return (
      <span aria-hidden="true" className={className}>
        {content}
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-label={label}
      className={cn(
        className,
        'group/toggle cursor-pointer outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40',
      )}
    >
      {content}
    </button>
  );
}

/** A custom agent with several workspaces: its row, then the workspaces. */
function AgentGroup({
  section,
  identity,
  variant,
  currentGroupJid,
  actions,
  children,
}: {
  section: AgentWorkspaceSection;
  identity: AgentDisplayIdentity;
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
  // An agent that owns the home workspace opens it from its own row, like
  // the primary agent; otherwise the row only expands and collapses.
  const homeGroup = directGroup?.is_my_home ? directGroup : null;
  const isDirectActive = !!homeGroup && homeGroup.jid === currentGroupJid;
  const canRebuild = !!homeGroup?.can_modify;
  const touch = variant === 'mobile';
  const profileId = profileIdOf(section);
  const hasAgentItems =
    !!profileId && (!!actions.onCreateWorkspace || !!actions.onOpenAgent);
  const hasMenu = canRebuild || hasAgentItems;

  const toggle = () => {
    if (!collapsible) return;
    setStoredExpanded(!expanded);
    persistAgentState(section.id, expanded);
  };
  const toggleLabel = `${expanded ? '收起' : '展开'} ${section.name} 的工作区`;

  return (
    <li
      className="mb-0.5 list-none"
      data-hc-agent-group={section.id}
      data-collapsible={collapsible ? 'true' : 'false'}
    >
      <div
        data-active={isDirectActive || undefined}
        className={cn(
          sidebarRowClass,
          'gap-1 pr-1 pl-0.5 text-foreground',
          touch && 'h-11 pl-2 text-body-lg',
        )}
      >
        <LeadingSlot
          icon={<AgentAvatar identity={identity} touch={touch} />}
          chevron={collapsible && !touch}
          expanded={expanded}
          label={toggleLabel}
          onToggle={homeGroup && collapsible && !touch ? toggle : undefined}
          touch={touch}
        />
        <button
          type="button"
          onClick={() => (homeGroup ? actions.onSelect(homeGroup) : toggle())}
          aria-current={isDirectActive ? 'page' : undefined}
          aria-expanded={homeGroup || !collapsible ? undefined : expanded}
          aria-controls={homeGroup || !collapsible ? undefined : contentId}
          aria-label={homeGroup ? undefined : toggleLabel}
          className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-left font-medium outline-none"
        >
          <span className="truncate">{section.name}</span>
        </button>
        {runningCount > 0 && (
          <Spinner
            className="size-3 text-muted-foreground"
            aria-label={`${runningCount} 个工作区运行中`}
          />
        )}
        <span
          className="shrink-0 px-1 text-micro text-faint-foreground tabular-nums"
          aria-label={`${workspaces.length} 个工作区`}
        >
          {workspaces.length}
        </span>
        {touch && collapsible && (
          <ChevronRight
            aria-hidden="true"
            className={cn(
              'size-4 text-faint-foreground transition-transform duration-150',
              expanded && 'rotate-90',
            )}
          />
        )}
        {hasMenu && (
          <RowMenu label={`${section.name}的更多操作`} touch={touch}>
            {profileId && actions.onCreateWorkspace && (
              <DropdownMenuItem
                onClick={() => actions.onCreateWorkspace!(profileId)}
              >
                <FolderPlus />
                新建工作区
              </DropdownMenuItem>
            )}
            {profileId && actions.onOpenAgent && (
              <DropdownMenuItem onClick={() => actions.onOpenAgent!(profileId)}>
                <Bot />
                智能体设置
              </DropdownMenuItem>
            )}
            {canRebuild && (
              <>
                {hasAgentItems && <DropdownMenuSeparator />}
                <DropdownMenuItem
                  onClick={() =>
                    actions.onClearHistory(homeGroup!.jid, section.name)
                  }
                >
                  <RotateCcw />
                  重建工作区
                </DropdownMenuItem>
              </>
            )}
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
    </li>
  );
}

const WorkspaceRow = memo(function WorkspaceRow({
  group,
  label,
  agentId,
  isHome,
  identity,
  depth = 0,
  variant,
  isActive,
  expanded,
  activeSessionId,
  onToggleExpanded,
  renderSessions,
  actions,
}: {
  group: GroupEntry;
  /** Shown instead of the workspace name (an agent's single workspace). */
  label?: string;
  /** Set when the row stands for a whole agent with one workspace. */
  agentId?: string;
  isHome: boolean;
  /** Agent avatar for rows named after their agent; others show a folder. */
  identity: AgentDisplayIdentity | null;
  depth?: number;
  variant: WorkspaceTreeVariant;
  isActive: boolean;
  expanded: boolean;
  activeSessionId: string | null;
  onToggleExpanded?: (group: GroupEntry, expanded: boolean) => void;
  renderSessions?: (
    group: GroupEntry,
    isCurrent: boolean,
    activeSessionId: string | null,
    depth: number,
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
  const displayName =
    label ?? (isHome && isDefaultName ? '我的工作区' : group.name);
  const canModify = !!group.can_modify;
  const canPin = !isHome && !!actions.onTogglePin;
  const hasWorkspaceItems = canPin || canModify;
  const hasAgentItems =
    !!agentId && (!!actions.onCreateWorkspace || !!actions.onOpenAgent);
  // Topic workspaces get their sessions from the channel; a session created
  // here is an extra Web-only one, and the label says so.
  const isTopicWorkspace =
    group.conversation_nav_mode === 'vertical_threads' ||
    group.conversation_source === 'native_thread' ||
    group.conversation_source === 'feishu_thread';
  const createLabel = isTopicWorkspace ? '新建 Web 会话' : '新建会话';
  // The row stands for its agent, so name the workspace in its actions.
  const noun = agentId ? '工作区' : '';
  const icon = identity ? (
    <AgentAvatar identity={identity} touch={touch} />
  ) : expanded ? (
    <FolderOpen className="size-4" />
  ) : (
    <Folder className="size-4" />
  );

  return (
    <li className="list-none" data-hc-agent-group={agentId}>
      <div
        data-active={isActive && !expanded ? true : undefined}
        className={cn(
          sidebarRowClass,
          'gap-1 pr-1 pl-0.5',
          isActive ? 'text-foreground' : 'text-sidebar-foreground/85',
          !!identity && 'font-medium',
          depth > 0 && !touch && 'pl-3.5',
          touch && 'h-11 pl-2 text-body-lg',
          // Workspaces under a multi-workspace agent sit under its avatar.
          depth > 0 && touch && 'pl-8',
        )}
      >
        <LeadingSlot
          icon={icon}
          chevron={nested}
          expanded={expanded}
          label={`${expanded ? '收起' : '展开'} ${displayName} 的会话`}
          onToggle={
            nested ? () => onToggleExpanded?.(group, !expanded) : undefined
          }
          touch={touch}
        />
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
        {nested && canModify && actions.onCreateSession && (
          <CreateSessionButton
            label={`${createLabel}（${displayName}）`}
            onCreate={() => actions.onCreateSession!(group)}
          />
        )}
        {(hasWorkspaceItems || hasAgentItems) && (
          <RowMenu label={`${displayName}的更多操作`} touch={touch}>
            {canPin && (
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
                重命名{noun}
              </DropdownMenuItem>
            )}
            {canModify && (
              <>
                {(canPin || actions.onRename) && <DropdownMenuSeparator />}
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
                删除{noun}
              </DropdownMenuItem>
            )}
            {hasAgentItems && (
              <>
                {hasWorkspaceItems && <DropdownMenuSeparator />}
                {actions.onCreateWorkspace && (
                  <DropdownMenuItem
                    onClick={() => actions.onCreateWorkspace!(agentId!)}
                  >
                    <FolderPlus />
                    新建工作区
                  </DropdownMenuItem>
                )}
                {actions.onOpenAgent && (
                  <DropdownMenuItem
                    onClick={() => actions.onOpenAgent!(agentId!)}
                  >
                    <Bot />
                    智能体设置
                  </DropdownMenuItem>
                )}
              </>
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
              {renderSessions!(group, isActive, activeSessionId, depth)}
            </m.div>
          )}
        </AnimatePresence>
      )}
    </li>
  );
});

/** Hover-revealed icon buttons at the end of a row (+, delete and ⋯). */
export const rowIconButtonClass =
  'grid size-6 shrink-0 cursor-pointer place-items-center rounded text-muted-foreground outline-none transition-opacity hover:bg-surface-hover hover:text-foreground focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-ring/40 aria-expanded:opacity-100 disabled:cursor-default';
export const revealOnRowHover =
  'pointer-fine:opacity-0 pointer-fine:group-hover/sidebar-row:opacity-100';

/** "+" at the end of a workspace row: a new session, opened right away. */
function CreateSessionButton({
  label,
  onCreate,
}: {
  label: string;
  onCreate: () => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  return (
    <button
      type="button"
      aria-label={label}
      aria-busy={pending || undefined}
      disabled={pending}
      onClick={async (event) => {
        event.stopPropagation();
        setPending(true);
        try {
          await onCreate();
        } finally {
          setPending(false);
        }
      }}
      className={cn(rowIconButtonClass, !pending && revealOnRowHover)}
    >
      {pending ? <Spinner className="size-3.5" /> : <Plus className="size-4" />}
    </button>
  );
}

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
  // Radix notices keyboard use through a document listener that only exists
  // once the menu is mounted, so on the first keyboard open it focused the
  // menu itself instead of its first item. Move focus on once the content has
  // mounted and Radix has focused it.
  const openedByKeyboardRef = useRef(false);
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!content || !openedByKeyboardRef.current) return;
    openedByKeyboardRef.current = false;
    content
      .querySelector<HTMLElement>('[role="menuitem"]:not([data-disabled])')
      ?.focus({ preventScroll: true });
  }, [content]);
  const className = cn(rowIconButtonClass, touch ? 'size-9' : revealOnRowHover);
  const icon = <MoreHorizontal className="size-4" />;

  if (!mounted) {
    const openMenu = (byKeyboard: boolean) => {
      openedByKeyboardRef.current = byKeyboard;
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
          openMenu(false);
        }}
        onKeyDown={(event) => {
          if (['Enter', ' ', 'ArrowDown'].includes(event.key)) {
            event.preventDefault();
            openMenu(true);
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
      <DropdownMenuContent ref={setContent} align="end" className="w-40">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
