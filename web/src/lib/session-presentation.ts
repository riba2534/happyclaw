import type { AgentInfo } from '../types';
import { getPresentedMessageContent } from './message-presentation';
import { sessionActivityAt, sortSessionsForList } from './session-order';

export { sessionActivityAt };

/** A session's name as lists and titles show it. */
export function sessionDisplayName(session: Pick<AgentInfo, 'name'>): string {
  return session.name || '新会话';
}

/** Sessions the host uses itself: a chat can never be bound to one. */
const UNBINDABLE_SOURCES: ReadonlySet<string> = new Set([
  'team_router',
  'work_item',
  'automation',
  'native_thread',
  'feishu_thread',
]);

/**
 * Whether a chat can be bound to the session: a conversation, not a team
 * lane, an automation run or a native topic's own session (the server's
 * rule for every bind and for a deleted session's rebind).
 */
export function isBindableSession(
  session: Pick<AgentInfo, 'kind' | 'source_kind'>,
): boolean {
  return (
    session.kind === 'conversation' &&
    !(session.source_kind && UNBINDABLE_SOURCES.has(session.source_kind))
  );
}

/** A workspace's sessions a chat can be bound to, in list order. */
export function bindableSessions<T extends AgentInfo>(
  agents: readonly T[],
): T[] {
  return listedSessions(agents).filter(isBindableSession);
}

/** A workspace's conversations in the session lists' order (pinned first). */
export function listedSessions<T extends AgentInfo>(agents: readonly T[]): T[] {
  return sortSessionsForList(
    agents.filter((agent) => agent.kind === 'conversation'),
  );
}

// Presentation helpers shared by the desktop sidebar session tree and the
// mobile session list.

const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function timestampMs(value: string): number | null {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
}

export function isRecentSession(session: AgentInfo): boolean {
  const timestamp = timestampMs(sessionActivityAt(session));
  if (timestamp === null) return false;
  return Date.now() - timestamp <= RECENT_WINDOW_MS;
}

export function formatSessionTime(value: string): string {
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

/** A message's content as one line of list preview. */
function previewText(content: string | null | undefined): string {
  return getPresentedMessageContent({
    content: content || '',
    source_kind: null,
    finalization_reason: null,
  })
    .replace(/\s+/g, ' ')
    .trim();
}

export function messagePreview(session: AgentInfo): string {
  return previewText(session.latest_message?.content);
}

export function isNativeManagedSession(session: AgentInfo): boolean {
  return (
    session.source_kind === 'native_thread' ||
    session.source_kind === 'feishu_thread' ||
    session.title_source === 'native_root' ||
    session.title_source === 'feishu_root'
  );
}

export function buildSessionMeta(session: AgentInfo): string {
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

/** The sessions one automation opened, shown as a group in the tree. */
export interface AutomationSessionGroup {
  automationId: string;
  /** The name the session list carries, for when the automation is gone. */
  name: string;
  sessions: AgentInfo[];
}

/** A row of a session list: a session, or one automation's sessions. */
export type SessionListItem =
  | { kind: 'session'; session: AgentInfo }
  | { kind: 'automation'; group: AutomationSessionGroup };

/**
 * A list's rows from its ordered sessions. The sessions an automation opened
 * fold into one row, placed where its most recent one would be; a pinned
 * session stays a row of its own, with the other pinned ones on top.
 */
export function sessionListItems(sessions: AgentInfo[]): SessionListItem[] {
  const items: SessionListItem[] = [];
  const groups = new Map<string, AutomationSessionGroup>();
  for (const session of sessions) {
    const id = session.automation_id;
    if (!id || session.pinned_at) {
      items.push({ kind: 'session', session });
      continue;
    }
    const group = groups.get(id);
    if (group) {
      group.sessions.push(session);
      continue;
    }
    const created: AutomationSessionGroup = {
      automationId: id,
      name: session.automation_name || session.name,
      sessions: [session],
    };
    groups.set(id, created);
    items.push({ kind: 'automation', group: created });
  }
  return items;
}

/**
 * A workspace's sessions in list order (pinned first, then by activity). A
 * session whose runner is still warm but has no active query is shown as
 * idle, matching what the user can act on.
 */
export function buildConversationSessions(
  agents: AgentInfo[],
  isQueryActive: (agentId: string) => boolean,
): AgentInfo[] {
  return listedSessions(agents).map((agent) =>
    agent.status === 'running' && !isQueryActive(agent.id)
      ? { ...agent, status: 'idle' as const }
      : agent,
  );
}
