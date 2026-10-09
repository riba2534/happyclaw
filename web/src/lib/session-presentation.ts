import type { AgentInfo } from '../types';
import { getPresentedMessageContent } from './message-presentation';

// Presentation helpers shared by the desktop sidebar session tree and the
// mobile session list.

const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function sessionActivityAt(session: AgentInfo): string {
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

export function messagePreview(session: AgentInfo): string {
  const content = session.latest_message?.content || '';
  return getPresentedMessageContent({
    content,
    source_kind: null,
    finalization_reason: null,
  })
    .replace(/\s+/g, ' ')
    .trim();
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

/**
 * Conversation sessions newest-first. A session whose runner is still warm
 * but has no active query is shown as idle, matching what the user can act on.
 */
export function buildConversationSessions(
  agents: AgentInfo[],
  isQueryActive: (agentId: string) => boolean,
): AgentInfo[] {
  return agents
    .filter((a) => a.kind === 'conversation')
    .map((agent) =>
      agent.status === 'running' && !isQueryActive(agent.id)
        ? { ...agent, status: 'idle' as const }
        : agent,
    )
    .sort(
      (a, b) =>
        new Date(sessionActivityAt(b)).getTime() -
        new Date(sessionActivityAt(a)).getTime(),
    );
}
