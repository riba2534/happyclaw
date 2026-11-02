import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Link2, Pencil, Pin, PinOff, Timer, Trash2 } from 'lucide-react';
import { PromptDialog } from '@/components/common/PromptDialog';
import { isLiveStream, useChatStore } from '../../../stores/chat';
import { useIsGuest } from '../../../stores/auth';
import { useAutomationsStore } from '../../../stores/automations';
import { useSessionActions } from '../../../hooks/useSessionActions';
import {
  buildConversationSessions,
  isBindableSession,
  isNativeManagedSession,
} from '../../../lib/session-presentation';
import { sessionJidOf } from '../../../lib/session-jid';
import type { AgentInfo } from '../../../types';
import type { MenuAction } from '../../common/ResponsiveMenu';

// Session lists shared by the desktop sidebar tree and the phone home list.

const EMPTY_AGENTS: AgentInfo[] = [];

/**
 * A workspace's sessions in list order. They are fetched once the element
 * behind `containerRef` scrolls into view: a workspace far down a long list
 * should not cost a request on every load. While `paused` (the list is
 * hidden) the running state is not recomputed per store update.
 */
export function useWorkspaceSessions<T extends Element>(
  groupJid: string,
  { paused = false }: { paused?: boolean } = {},
) {
  const loadAgents = useChatStore((s) => s.loadAgents);
  const agents = useChatStore((s) => s.agents[groupJid] ?? EMPTY_AGENTS);
  // A joined id string keeps streaming deltas from re-rendering the list:
  // it only changes when a session starts or stops answering.
  // A card frozen by a stop is not a running query.
  const lastActiveRef = useRef('');
  const activeQueryIds = useChatStore((s) => {
    if (paused) return lastActiveRef.current;
    return (lastActiveRef.current = (s.agents[groupJid] ?? EMPTY_AGENTS)
      .filter(
        (a) => s.agentWaiting[a.id] || isLiveStream(s.agentStreaming[a.id]),
      )
      .map((a) => a.id)
      .join(','));
  });

  const containerRef = useRef<T>(null);
  useEffect(() => {
    const node = containerRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      void loadAgents(groupJid);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        observer.disconnect();
        void loadAgents(groupJid);
      },
      { rootMargin: '200px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [groupJid, loadAgents]);

  const sessions = useMemo(() => {
    const active = new Set(activeQueryIds ? activeQueryIds.split(',') : []);
    return buildConversationSessions(agents, (id) => active.has(id));
  }, [agents, activeQueryIds]);

  return { containerRef, sessions };
}

interface SessionMenuHandlers {
  /** Whether the session is pinned, which names the pin action. */
  pinned: boolean;
  onRename?: () => void;
  onTogglePin?: () => void;
  onBind?: () => void;
  onCreateAutomation?: () => void;
  onDelete?: () => void;
}

/** A session row's ⋯ actions, the same in every list. */
function sessionMenuGroups({
  pinned,
  onRename,
  onTogglePin,
  onBind,
  onCreateAutomation,
  onDelete,
}: SessionMenuHandlers): MenuAction[][] {
  const organize: MenuAction[] = [];
  if (onRename) {
    organize.push({ label: '重命名', icon: Pencil, onSelect: onRename });
  }
  if (onTogglePin) {
    organize.push({
      label: pinned ? '取消置顶' : '置顶',
      icon: pinned ? PinOff : Pin,
      onSelect: onTogglePin,
    });
  }
  const connect: MenuAction[] = [];
  if (onBind) {
    connect.push({ label: '会话绑定', icon: Link2, onSelect: onBind });
  }
  if (onCreateAutomation) {
    connect.push({
      label: '从此会话创建自动化…',
      icon: Timer,
      onSelect: onCreateAutomation,
    });
  }
  const remove: MenuAction[] = onDelete
    ? [{ label: '删除', icon: Trash2, destructive: true, onSelect: onDelete }]
    : [];
  return [organize, connect, remove];
}

/**
 * Deleting a workspace's sessions (after confirmation): only for its owner,
 * never a guest; undefined when the viewer may not.
 */
export function useSessionDelete(group: { jid: string; can_modify?: boolean }) {
  const isGuest = useIsGuest();
  const { deleteSession } = useSessionActions();
  const allowed = !!group.can_modify && !isGuest;
  return useMemo(
    () =>
      allowed
        ? (session: AgentInfo) => deleteSession(group.jid, session.id)
        : undefined,
    [allowed, deleteSession, group.jid],
  );
}

/**
 * The ⋯ actions of a workspace's session rows: what the viewer may do to a
 * session. Guests may do none; pinning only needs a signed-in member, the
 * rest the workspace's owner. A channel topic's session is named by its
 * topic, so it is not renamed here. Binding and renaming open where the list
 * keeps their dialogs.
 */
export function useSessionRowActions(
  group: { jid: string; can_modify?: boolean },
  {
    onBind,
    onRename,
  }: {
    onBind: (session: AgentInfo) => void;
    onRename: (session: AgentInfo) => void;
  },
) {
  const isGuest = useIsGuest();
  const pinSession = useChatStore((s) => s.pinSession);
  const openCreateAutomation = useAutomationsStore((s) => s.openCreateForm);
  const deleteSession = useSessionDelete(group);
  const canModify = !!group.can_modify && !isGuest;

  return useCallback(
    (session: AgentInfo): MenuAction[][] | undefined => {
      if (isGuest) return undefined;
      return sessionMenuGroups({
        pinned: !!session.pinned_at,
        onRename:
          canModify && !isNativeManagedSession(session)
            ? () => onRename(session)
            : undefined,
        onTogglePin: () =>
          void pinSession(group.jid, session.id, !session.pinned_at),
        onBind:
          canModify && isBindableSession(session)
            ? () => onBind(session)
            : undefined,
        onCreateAutomation: canModify
          ? () =>
              openCreateAutomation({
                workspaceJid: group.jid,
                targetSessionJid: sessionJidOf(group.jid, session.id),
              })
          : undefined,
        onDelete: deleteSession && (() => deleteSession(session)),
      });
    },
    [
      isGuest,
      canModify,
      group.jid,
      onBind,
      onRename,
      pinSession,
      openCreateAutomation,
      deleteSession,
    ],
  );
}

/** Renames `session` (open while it is set). */
export function RenameSessionDialog({
  groupJid,
  session,
  onClose,
}: {
  groupJid: string;
  session: AgentInfo | null;
  onClose: () => void;
}) {
  const renameConversation = useChatStore((s) => s.renameConversation);
  return (
    <PromptDialog
      open={session !== null}
      title="重命名对话"
      label="对话名称"
      placeholder="输入新名称"
      defaultValue={session?.name ?? ''}
      onConfirm={(name) => {
        if (session) void renameConversation(groupJid, session.id, name);
      }}
      onClose={onClose}
    />
  );
}
