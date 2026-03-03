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

export interface SwitchResult {
  folder: string;
  agentId: string | null;
  /** Human-readable label, e.g. "前端项目 / 主对话" */
  label: string;
}

export interface MessageForContext {
  sender: string;
  sender_name: string;
  content: string;
  is_from_me: boolean;
}

// ─── Switch Resolution ──────────────────────────────────────────

/**
 * Resolve a /switch target string to a folder + agentId.
 *
 * Priority order:
 *   1. "主对话" / "main" → main conversation of current folder
 *   2. Agent name/id in current folder
 *   3. Workspace folder/name match → its main conversation
 *   4. Agent name across all workspaces
 *
 * Returns null if no match found.
 */
export function resolveSwitch(
  target: string,
  currentFolder: string,
  workspaces: WorkspaceInfo[],
): SwitchResult | null {
  const t = target.toLowerCase();

  // Find the display name for a folder
  const folderName = (folder: string): string => {
    const ws = workspaces.find((w) => w.folder === folder);
    return ws?.name ?? folder;
  };

  // Find the current workspace
  const currentWs = workspaces.find((w) => w.folder === currentFolder);

  // 1. "主对话" / "main" → stay in current folder, switch to main
  if (t === '主对话' || t === 'main') {
    return {
      folder: currentFolder,
      agentId: null,
      label: `${folderName(currentFolder)} / 主对话`,
    };
  }

  // 2. Match agent in current folder (by name, full id, or short id prefix)
  if (currentWs) {
    const agent = currentWs.agents.find(
      (a) => a.name.toLowerCase() === t || a.id === target || a.id.startsWith(t),
    );
    if (agent) {
      return {
        folder: currentFolder,
        agentId: agent.id,
        label: `${currentWs.name} / ${agent.name}`,
      };
    }
  }

  // 3. Match workspace by folder or name
  const matchedWs = workspaces.find(
    (w) => w.folder.toLowerCase() === t || w.name.toLowerCase() === t,
  );
  if (matchedWs) {
    return {
      folder: matchedWs.folder,
      agentId: null,
      label: `${matchedWs.name} / 主对话`,
    };
  }

  // 4. Match agent across all workspaces (by name or short id prefix)
  for (const ws of workspaces) {
    const agent = ws.agents.find((a) => a.name.toLowerCase() === t || a.id.startsWith(t));
    if (agent) {
      return {
        folder: ws.folder,
        agentId: agent.id,
        label: `${ws.name} / ${agent.name}`,
      };
    }
  }

  return null;
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

  // Collect a concrete example for the hint at the end
  let exampleTarget = '';

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

      // Pick an agent that is NOT the current one as the example target
      if (!exampleTarget && !(isCurrent && currentAgentId === agent.id)) {
        exampleTarget = agent.name;
      }
    }

    // Pick a workspace that is NOT the current one as the example target
    if (!exampleTarget && !isCurrent) {
      exampleTarget = ws.name;
    }
  }

  lines.push('');
  lines.push('💡 使用 /sw <名称> 切换');
  if (exampleTarget) {
    lines.push(`   例: /sw ${exampleTarget}`);
  }
  return lines.join('\n');
}
