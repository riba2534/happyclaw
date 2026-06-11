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
  currentOnMain = true,
): string {
  if (workspaces.length === 0) return '没有可用的工作区';

  const lines: string[] = ['📂 工作区列表：'];

  for (const ws of workspaces) {
    const isCurrent = ws.folder === currentFolder;
    const marker = isCurrent ? ' ▶' : '';
    lines.push(`${marker} ${ws.name} (${ws.folder})`);

    const mainMarker = isCurrent && currentOnMain ? ' ← 当前' : '';
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
  lines.push('💡 /sw <消息> 并行任务 · /recall 总结 · /clear 重置');
  return lines.join('\n');
}

// ─── Location Info ────────────────────────────────────────────

export interface LocationInfo {
  locationLine: string;
  folder: string;
  replyPolicy: string | null;
}

export interface BoundChatTarget {
  baseChatJid: string;
  targetChatJid: string;
  folder: string;
  agentId: string | null;
  locationLine: string;
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

/**
 * Resolve the real chat target for IM slash commands.
 *
 * Non-main workspaces use random web JIDs (`web:<uuid>`), so commands must not
 * reconstruct targets from `folder`. They need the actual bound workspace JID.
 */
export function resolveBoundChatTarget(
  sourceChatJid: string,
  group: RegisteredGroupLike,
  getRegisteredGroup: (jid: string) => RegisteredGroupLike | undefined,
  getAgent: (id: string) => AgentLike | undefined,
  findGroupNameByFolder: (folder: string) => string,
): BoundChatTarget {
  if (group.target_agent_id) {
    const agent = getAgent(group.target_agent_id);
    const parent = agent ? getRegisteredGroup(agent.chat_jid) : undefined;
    const workspaceName =
      parent?.name || findGroupNameByFolder(parent?.folder || group.folder);
    const baseChatJid = agent?.chat_jid || sourceChatJid;
    return {
      baseChatJid,
      targetChatJid: `${baseChatJid}#agent:${group.target_agent_id}`,
      folder: parent?.folder || group.folder,
      agentId: group.target_agent_id,
      locationLine: `${workspaceName} / ${agent?.name || group.target_agent_id}`,
    };
  }

  if (group.target_main_jid) {
    const target = getRegisteredGroup(group.target_main_jid);
    return {
      baseChatJid: group.target_main_jid,
      targetChatJid: group.target_main_jid,
      folder: target?.folder || group.folder,
      agentId: null,
      locationLine: `${target?.name || group.target_main_jid} / 主对话`,
    };
  }

  const workspaceName = findGroupNameByFolder(group.folder);
  return {
    baseChatJid: sourceChatJid,
    targetChatJid: sourceChatJid,
    folder: group.folder,
    agentId: null,
    locationLine: `${workspaceName} / 主对话`,
  };
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
    '💡 /sw <消息> 并行任务 · /where 绑定 · /list 全部',
  ];

  return lines.join('\n');
}

// ─── IM Owner Gate ──────────────────────────────────────────────

/**
 * IM commands that mutate workspace state (clear session, change bindings,
 * spawn agents) must be restricted to the workspace owner.
 *
 * Excluded from the gate:
 *   - owner_mention: the only bootstrap path to claim an unowned group;
 *     gating it would lock new groups out forever
 *   - require_mention: shared as a settings toggle by design (its own
 *     guard only applies when activation_mode is 'owner_mentioned')
 *   - allow / disallow / allowlist: already enforce sender === owner_im_id
 *     inside their own handlers
 *   - list / status / where / recall: read-only utilities
 */
export const OWNER_REQUIRED_IM_COMMANDS: ReadonlySet<string> = new Set([
  'clear',
  'bind',
  'unbind',
  'new',
  'sw',
  'spawn',
  // release_owner is the reclaim path: only the current owner can release;
  // gate handles the "must equal current owner_im_id" check uniformly.
  'release_owner',
]);

export interface ImOwnerCheckGroup {
  owner_im_id?: string | null;
}

/**
 * Decide whether an IM slash command should be allowed.
 * `cmd` should already be lowercased (matches the cmd name without `/`).
 * Returns `{ ok: true }` for commands outside the owner-required set or
 * when the caller is the recorded owner; otherwise an error reason that
 * can be sent back to the IM channel verbatim.
 */
export function checkImOwnerCommand(
  cmd: string,
  group: ImOwnerCheckGroup | null | undefined,
  senderImId: string | undefined,
): { ok: true } | { ok: false; reason: string } {
  if (!OWNER_REQUIRED_IM_COMMANDS.has(cmd)) return { ok: true };
  if (!senderImId) {
    return { ok: false, reason: '该通道暂不支持此命令（缺少发送者身份）' };
  }
  if (!group?.owner_im_id) {
    return {
      ok: false,
      reason:
        '工作区尚未认领 owner，请由 owner 在群内发送 /owner_mention 自我认领（仅记录身份，不会改变群组激活策略）',
    };
  }
  if (senderImId !== group.owner_im_id) {
    return { ok: false, reason: '只有工作区 owner 才能执行此命令' };
  }
  return { ok: true };
}

/**
 * Decide whether a chat JID is a 1:1 direct message (vs a group chat).
 *
 * Used by the IM owner-gate to auto-claim the sender as owner on the first
 * owner-required command in a DM — in a 1:1 chat the sender is unambiguously
 * the owner, so forcing `/owner_mention` first is pure friction. Group chats
 * must NEVER auto-claim (the first commander isn't necessarily the owner), so
 * the safe default for any ambiguous/unknown JID is `false`.
 *
 * Detection is purely structural (no channel handles needed) because every
 * channel that auto-registers DMs encodes DM-ness in the JID it builds:
 *   - qq:        `qq:c2c:{openid}`            (group → `qq:group:...`)
 *   - dingtalk:  `dingtalk:c2c:{staffId}`     (group → `dingtalk:{cid...}`)
 *   - discord:   `discord:dm:{userId}`        (guild → `discord:{channelId}`)
 *   - whatsapp:  `...@s.whatsapp.net`         (group → `...@g.us`)
 *   - wechat:    `wechat:{userId}`            (1:1 only — no group support)
 *   - telegram:  `telegram:{chatId}`          (private chat id is positive;
 *                groups/supergroups are negative — a stable Bot API guarantee)
 *   - feishu:    cannot be told apart from the JID, but Feishu auto-sets
 *                owner_im_id via the DM owner-learn path, so DM auto-claim is
 *                moot there → treat as non-DM (false).
 *
 * The failure mode is intentionally one-directional: a group can never be
 * misread as a DM (no auto-grant in a group), at worst a real DM is misread as
 * a group and the user falls back to `/owner_mention`.
 */
export function isDirectMessageJid(chatJid: string): boolean {
  if (chatJid.startsWith('qq:')) return chatJid.startsWith('qq:c2c:');
  if (chatJid.startsWith('dingtalk:')) return chatJid.startsWith('dingtalk:c2c:');
  if (chatJid.startsWith('discord:')) return chatJid.startsWith('discord:dm:');
  if (chatJid.startsWith('whatsapp:')) return chatJid.endsWith('@s.whatsapp.net');
  if (chatJid.startsWith('wechat:')) return true; // WeChat integration is 1:1 only
  if (chatJid.startsWith('telegram:')) {
    const id = Number(chatJid.slice('telegram:'.length));
    return Number.isFinite(id) && id > 0;
  }
  // feishu / web / unknown → not eligible for DM auto-claim.
  return false;
}
