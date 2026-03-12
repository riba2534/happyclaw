/**
 * Pure utility functions for IM slash commands.
 * Extracted from index.ts to enable unit testing without DB/state dependencies.
 */

// ─── Types ──────────────────────────────────────────────────────

export interface AgentInfo {
  id: string;
  name: string;
  status: string;
}

export interface WorkspaceInfo {
  folder: string;
  name: string;
  agents: AgentInfo[];
}

export interface MessageForContext {
  sender: string;
  sender_name: string;
  content: string;
  is_from_me: boolean;
}

// ─── Context Formatting ─────────────────────────────────────────

/**
 * Format recent messages into a compact context summary.
 * Messages should be in chronological order (oldest first).
 *
 * @param messages  Array of messages (oldest first)
 * @param maxLen    Per-message truncation length
 * @returns         Formatted text block, or empty string if no displayable messages
 */
export function formatContextMessages(
  messages: MessageForContext[],
  maxLen = 80,
): string {
  if (messages.length === 0) return '';

  const lines: string[] = [];
  for (const msg of messages) {
    if (msg.sender === '__system__') continue;

    const who = msg.is_from_me ? '🤖' : `👤${msg.sender_name || ''}`;
    let text = msg.content || '';
    if (text.length > maxLen) text = text.slice(0, maxLen) + '…';
    text = text.replace(/\n/g, ' ');
    lines.push(`  ${who}: ${text}`);
  }

  return lines.length > 0 ? '\n\n📋 最近消息:\n' + lines.join('\n') : '';
}

// ─── List Formatting ────────────────────────────────────────────

/**
 * Format workspace list with current-position markers.
 */
export function formatWorkspaceList(
  workspaces: WorkspaceInfo[],
  currentFolder: string,
  currentAgentId: string | null,
): string {
  if (workspaces.length === 0) return '没有可用的工作区';

  const lines: string[] = ['📂 工作区列表：'];

  for (const ws of workspaces) {
    const isCurrent = ws.folder === currentFolder;
    const marker = isCurrent ? ' ▶' : '';
    lines.push(`${marker} ${ws.name} (${ws.folder})`);

    const mainMarker = isCurrent && !currentAgentId ? ' ← 当前' : '';
    lines.push(`  · 主对话${mainMarker}`);

    for (const agent of ws.agents) {
      const agentMarker =
        isCurrent && currentAgentId === agent.id ? ' ← 当前' : '';
      const statusIcon = agent.status === 'running' ? '🔄' : '';
      const shortId = agent.id.slice(0, 4);
      lines.push(`  · ${agent.name} [${shortId}] ${statusIcon}${agentMarker}`);
    }
  }

  lines.push('');
  lines.push('💡 使用 /recall 总结最近对话记录，/clear 重置上下文');
  return lines.join('\n');
}

// ─── Location Info ────────────────────────────────────────────

export interface LocationInfo {
  locationLine: string;
  folder: string;
  replyPolicy: string | null;
}

export interface RegisteredGroupLike {
  folder: string;
  name: string;
  target_agent_id?: string | null;
  target_main_jid?: string | null;
  reply_policy?: string | null;
}

export interface AgentLike {
  name: string;
  chat_jid: string;
}

/**
 * Resolve location info from a registered group.
 * Pure function — all state access goes through callbacks.
 */
export function resolveLocationInfo(
  group: RegisteredGroupLike,
  getRegisteredGroup: (jid: string) => RegisteredGroupLike | undefined,
  getAgent: (id: string) => AgentLike | undefined,
  findGroupNameByFolder: (folder: string) => string,
): LocationInfo {
  let locationLine: string;
  let folder: string;

  if (group.target_agent_id) {
    const agent = getAgent(group.target_agent_id);
    const parent = agent ? getRegisteredGroup(agent.chat_jid) : undefined;
    const workspaceName = parent?.name || parent?.folder || group.folder;
    locationLine = `${workspaceName} / ${agent?.name || group.target_agent_id}`;
    folder = parent?.folder || group.folder;
  } else if (group.target_main_jid) {
    const target = getRegisteredGroup(group.target_main_jid);
    locationLine = `${target?.name || group.target_main_jid} / 主对话`;
    folder = target?.folder || group.folder;
  } else {
    const folderName = findGroupNameByFolder(group.folder);
    locationLine = `${folderName} / 主对话`;
    folder = group.folder;
  }

  const replyPolicy = group.target_main_jid || group.target_agent_id
    ? (group.reply_policy || 'source_only')
    : null;

  return { locationLine, folder, replyPolicy };
}

// ─── System Status Formatting ─────────────────────────────────

export interface QueueStatusInfo {
  activeContainerCount: number;
  activeHostProcessCount: number;
  maxContainers: number;
  maxHostProcesses: number;
  waitingCount: number;
  waitingGroupJids: string[];
}

/**
 * Format system status output for /status command.
 */
export function formatSystemStatus(
  location: LocationInfo,
  queueStatus: QueueStatusInfo,
  isActive: boolean,
  queuePosition: number | null,
): string {
  const statusText = isActive
    ? '运行中'
    : queuePosition !== null
      ? `排队中 (#${queuePosition})`
      : '空闲';

  const lines = [
    '📊 系统状态',
    '━━━━━━━━━━',
    `📍 位置: ${location.locationLine}`,
    `⚡ 状态: ${statusText}`,
    `📦 负载: ${queueStatus.activeContainerCount}/${queueStatus.maxContainers} 容器, ${queueStatus.activeHostProcessCount}/${queueStatus.maxHostProcesses} 进程`,
    '',
    '💡 /where 查看绑定 · /list 查看全部',
  ];

  return lines.join('\n');
}
