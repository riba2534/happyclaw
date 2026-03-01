import { ChildProcess, execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

import { CronExpressionParser } from 'cron-parser';

import {
  ASSISTANT_NAME,
  CONTAINER_IMAGE,
  DATA_DIR,
  GROUPS_DIR,
  STORE_DIR,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import {
  AvailableGroup,
  ContainerInput,
  ContainerOutput,
  runContainerAgent,
  runHostAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  closeDatabase,
  createTask,
  deleteExpiredSessions,
  deleteTask,
  ensureChatExists,
  ensureUserHomeGroup,
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getJidsByFolder,
  getLastGroupSync,
  getRegisteredGroup,
  getUserById,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  getTaskById,
  getUserHomeGroup,
  initDatabase,
  isGroupShared,
  listUsers,
  setLastGroupSync,
  setRegisteredGroup,
  setRouterState,
  setSession,
  deleteAllSessionsForFolder,
  deleteSession,
  storeMessageDirect,
  updateChatName,
  updateTask,
  createAgent,
  getAgent,
  updateAgentStatus,
  updateAgentInfo,
  deleteCompletedTaskAgents,
  markRunningTaskAgentsAsError,
  markAllRunningTaskAgentsAsError,
  getSession,
  listAgentsByJid,
} from './db.js';
// feishu.js deprecated exports are no longer needed; imManager handles all connections
import { imManager } from './im-manager.js';
import { getChannelType } from './im-channel.js';
import { analyzeIntent } from './intent-analyzer.js';
import {
  getClaudeProviderConfig as getClaudeProviderConfigForRefresh,
  getFeishuProviderConfigWithSource,
  getTelegramProviderConfigWithSource,
  getUserFeishuConfig,
  getUserTelegramConfig,
  getSystemSettings,
  refreshOAuthCredentials,
  saveClaudeProviderConfig as saveClaudeProviderConfigForRefresh,
  updateAllSessionCredentials,
} from './runtime-config.js';
import type { FeishuConnectConfig, TelegramConnectConfig } from './im-manager.js';
import { GroupQueue } from './group-queue.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { AgentStatus, MessageCursor, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import {
  startWebServer,
  broadcastToWebClients,
  broadcastNewMessage,
  broadcastTyping,
  broadcastStreamEvent,
  broadcastAgentStatus,
  shutdownTerminals,
  shutdownWebServer,
} from './web.js';
import { installSkillForUser, deleteSkillForUser } from './routes/skills.js';
import { verifyPairingCode } from './telegram-pairing.js';
import { executeSessionReset } from './commands.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const execFileAsync = promisify(execFile);
const DEFAULT_MAIN_JID = 'web:main';
const DEFAULT_MAIN_NAME = 'Main';
const SAFE_REQUEST_ID_RE = /^[A-Za-z0-9_-]+$/;

let globalMessageCursor: MessageCursor = { timestamp: '', id: '' };
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, MessageCursor> = {};
let messageLoopRunning = false;
let ipcWatcherRunning = false;
let shuttingDown = false;

const queue = new GroupQueue();
const EMPTY_CURSOR: MessageCursor = { timestamp: '', id: '' };
const terminalWarmupInFlight = new Set<string>();

function isCursorAfter(candidate: MessageCursor, base: MessageCursor): boolean {
  if (candidate.timestamp > base.timestamp) return true;
  if (candidate.timestamp < base.timestamp) return false;
  return candidate.id > base.id;
}

function normalizeCursor(value: unknown): MessageCursor {
  if (typeof value === 'string') {
    return { timestamp: value, id: '' };
  }
  if (
    value &&
    typeof value === 'object' &&
    typeof (value as { timestamp?: unknown }).timestamp === 'string'
  ) {
    const maybeId = (value as { id?: unknown }).id;
    return {
      timestamp: (value as { timestamp: string }).timestamp,
      id: typeof maybeId === 'string' ? maybeId : '',
    };
  }
  return { ...EMPTY_CURSOR };
}

function sendSystemMessage(jid: string, type: string, detail: string): void {
  const msgId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  ensureChatExists(jid);
  storeMessageDirect(msgId, jid, '__system__', 'system', `${type}:${detail}`, timestamp, true);
  broadcastNewMessage(jid, {
    id: msgId,
    chat_jid: jid,
    sender: '__system__',
    sender_name: 'system',
    content: `${type}:${detail}`,
    timestamp,
    is_from_me: true,
  });
}

/**
 * Slash command handler for IM channels (Feishu/Telegram).
 * Returns a reply string on success, or null if command not recognized.
 */
async function handleCommand(chatJid: string, command: string): Promise<string | null> {
  if (command !== 'clear') return null;

  const group = registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
  if (!group) return null;

  try {
    await executeSessionReset(chatJid, group.folder, {
      queue,
      sessions,
      broadcast: broadcastNewMessage,
    });
    return '已清除对话上下文 ✓';
  } catch (err) {
    logger.error({ chatJid, err }, 'handleCommand /clear failed');
    return '清除上下文失败，请稍后重试';
  }
}

async function setTyping(jid: string, isTyping: boolean): Promise<void> {
  await imManager.setTyping(jid, isTyping);
  broadcastTyping(jid, isTyping);
}

interface SendMessageOptions {
  /** Whether to forward the reply to the IM channel (Feishu/Telegram). Defaults to true for IM JIDs. */
  sendToIM?: boolean;
}

function loadState(): void {
  // Load from SQLite
  const persistedTimestamp = getRouterState('last_timestamp') || '';
  const lastTimestampId = getRouterState('last_timestamp_id') || '';
  globalMessageCursor = {
    timestamp: persistedTimestamp,
    id: lastTimestampId,
  };
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    const parsed = agentTs ? (JSON.parse(agentTs) as Record<string, unknown>) : {};
    const normalized: Record<string, MessageCursor> = {};
    for (const [jid, raw] of Object.entries(parsed)) {
      normalized[jid] = normalizeCursor(raw);
    }
    lastAgentTimestamp = normalized;
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();

  // Auto-register default groups from config/default-groups.json
  const defaultGroupsPath = path.resolve(
    process.cwd(),
    'config',
    'default-groups.json',
  );
  if (fs.existsSync(defaultGroupsPath)) {
    try {
      const defaults = JSON.parse(
        fs.readFileSync(defaultGroupsPath, 'utf-8'),
      ) as Array<{
        jid: string;
        name: string;
        folder: string;
      }>;
      for (const g of defaults) {
        if (!registeredGroups[g.jid]) {
          registerGroup(g.jid, {
            name: g.name,
            folder: g.folder,
            added_at: new Date().toISOString(),
          });
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to load default groups config');
    }
  }

  // Ensure every active user has a home group (is_home=true).
  // Admin → folder='main', executionMode='host'
  // Member → folder='home-{userId}', executionMode='container'
  try {
    // Paginate through all active users
    const activeUsers: Array<{ id: string; role: string; username: string }> = [];
    {
      let page = 1;
      while (true) {
        const result = listUsers({ status: 'active', page, pageSize: 200 });
        activeUsers.push(...result.users);
        if (activeUsers.length >= result.total) break;
        page++;
      }
    }
    for (const user of activeUsers) {
      const homeJid = ensureUserHomeGroup(user.id, user.role as 'admin' | 'member', user.username);
      // Always refresh this entry from DB to pick up any patches (is_home, executionMode, etc.)
      const freshGroup = getRegisteredGroup(homeJid);
      if (freshGroup) {
        registeredGroups[homeJid] = freshGroup;
      } else if (!registeredGroups[homeJid]) {
        registeredGroups = getAllRegisteredGroups();
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to ensure user home groups');
  }

  // Enforce execution mode on all is_home groups:
  // - admin home → host mode
  // - member home → container mode
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (!group.is_home) continue;

    // Determine expected mode based on the owner's role
    // Admin home groups use host mode, member home groups use container mode
    const isAdminHome = group.folder === MAIN_GROUP_FOLDER;
    const expectedMode = isAdminHome ? 'host' : 'container';

    if (group.executionMode !== expectedMode) {
      group.executionMode = expectedMode;
      setRegisteredGroup(jid, group);
      registeredGroups[jid] = group;
      // 清除旧 session，避免恢复不兼容的 session
      if (sessions[group.folder]) {
        logger.info(
          { folder: group.folder, expectedMode },
          'Clearing stale session during execution mode migration',
        );
        delete sessions[group.folder];
        deleteSession(group.folder);
      }
    }
  }

  // Migrate shared global CLAUDE.md → per-user user-global directories
  migrateGlobalMemoryToPerUser();

  // Initialize per-user global CLAUDE.md from template for users missing it
  const templatePath = path.resolve(
    process.cwd(),
    'config',
    'global-claude-md.template.md',
  );
  if (fs.existsSync(templatePath)) {
    const template = fs.readFileSync(templatePath, 'utf-8');
    const userGlobalBase = path.join(GROUPS_DIR, 'user-global');
    // Ensure every active user has a user-global dir
    try {
      let page = 1;
      const allUsers: Array<{ id: string }> = [];
      while (true) {
        const result = listUsers({ status: 'active', page, pageSize: 200 });
        allUsers.push(...result.users);
        if (allUsers.length >= result.total) break;
        page++;
      }
      for (const u of allUsers) {
        const userDir = path.join(userGlobalBase, u.id);
        fs.mkdirSync(userDir, { recursive: true });
        const userClaudeMd = path.join(userDir, 'CLAUDE.md');
        if (!fs.existsSync(userClaudeMd)) {
          try {
            fs.writeFileSync(userClaudeMd, template, { flag: 'wx' });
            logger.info({ userId: u.id }, 'Initialized user-global CLAUDE.md from template');
          } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
              logger.warn({ userId: u.id, err }, 'Failed to initialize user-global CLAUDE.md');
            }
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to initialize user-global CLAUDE.md files');
    }
  }

  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

function saveState(): void {
  setRouterState('last_timestamp', globalMessageCursor.timestamp);
  setRouterState('last_timestamp_id', globalMessageCursor.id);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  const groupDir = path.join(GROUPS_DIR, group.folder);
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Sync group metadata from Feishu.
 * Fetches all bot groups and stores their names in the database.
 * Called on startup, daily, and on-demand via IPC.
 */
async function syncGroupMetadata(force = false): Promise<void> {
  // Check if we need to sync (skip if synced recently, unless forced)
  if (!force) {
    const lastSync = getLastGroupSync();
    if (lastSync) {
      const lastSyncTime = new Date(lastSync).getTime();
      const now = Date.now();
      if (now - lastSyncTime < GROUP_SYNC_INTERVAL_MS) {
        logger.debug({ lastSync }, 'Skipping group sync - synced recently');
        return;
      }
    }
  }

  // Sync groups via any connected user's Feishu instance
  const connectedUserIds = imManager.getConnectedUserIds();
  for (const uid of connectedUserIds) {
    if (imManager.isFeishuConnected(uid)) {
      await imManager.syncFeishuGroups(uid);
      break; // Only need one sync
    }
  }
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
function getAvailableGroups(): AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.jid.startsWith('feishu:'))
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatMessages(messages: NewMessage[], isShared = false): string {
  const lines = messages.map((m) => {
    const content = isShared ? `[${m.sender_name}] ${m.content}` : m.content;
    return `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(content)}</message>`;
  });
  return `<messages>\n${lines.join('\n')}\n</messages>`;
}

function collectMessageImages(
  chatJid: string,
  messages: NewMessage[],
): Array<{ data: string; mimeType?: string }> {
  const images: Array<{ data: string; mimeType?: string }> = [];
  for (const msg of messages) {
    if (!msg.attachments) continue;
    try {
      const parsed = JSON.parse(msg.attachments);
      if (!Array.isArray(parsed)) continue;
      for (const item of parsed) {
        if (!item || typeof item !== 'object') continue;
        if ((item as { type?: unknown }).type !== 'image') continue;
        const data = (item as { data?: unknown }).data;
        if (typeof data !== 'string' || data.length === 0) continue;
        const maybeMime = (item as { mimeType?: unknown }).mimeType;
        images.push({
          data,
          mimeType: typeof maybeMime === 'string' ? maybeMime : undefined,
        });
      }
    } catch (err) {
      logger.warn(
        { chatJid, messageId: msg.id },
        'Failed to parse message attachments',
      );
    }
  }
  return images;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 *
 * Uses streaming output: agent results are sent to Feishu as they arrive.
 * The container stays alive for idleTimeout after each result, allowing
 * rapid-fire messages to be piped in without spawning a new container.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  let group = registeredGroups[chatJid];
  if (!group) {
    // Group may have been created after loadState (e.g., during setup/registration)
    registeredGroups = getAllRegisteredGroups();
    group = registeredGroups[chatJid];
  }
  if (!group) return true;

  let isHome = !!group.is_home;

  // IM groups (feishu/telegram) sharing a folder with a home group inherit
  // the home group's execution mode and permissions. This ensures agents run
  // in the correct mode (e.g., host instead of container) and have access
  // to home-level capabilities (memory, admin privileges).
  let effectiveGroup = group;
  if (!isHome) {
    const siblingJids = getJidsByFolder(group.folder);
    for (const jid of siblingJids) {
      const sibling = registeredGroups[jid] ?? getRegisteredGroup(jid);
      if (sibling && !registeredGroups[jid]) {
        registeredGroups[jid] = sibling;
      }
      if (sibling?.is_home) {
        effectiveGroup = {
          ...group,
          executionMode: sibling.executionMode,
          customCwd: sibling.customCwd || group.customCwd,
          // Preserve explicit IM owner first (critical for per-user global memory).
          created_by: group.created_by || sibling.created_by,
          is_home: true,
        };
        isHome = true;
        break;
      }
    }
  }

  // Get all messages since last agent interaction
  const sinceCursor = lastAgentTimestamp[chatJid] || EMPTY_CURSOR;
  const missedMessages = getMessagesSince(chatJid, sinceCursor);

  if (missedMessages.length === 0) return true;

  // Admin home is shared as web:main, so select runtime owner from the latest
  // active admin sender to avoid writing global memory into another admin's
  // user-global directory.
  if (chatJid === 'web:main' && effectiveGroup.is_home) {
    for (let i = missedMessages.length - 1; i >= 0; i--) {
      const sender = missedMessages[i]?.sender;
      if (!sender || sender === 'happyclaw-agent' || sender === '__system__') continue;
      const senderUser = getUserById(sender);
      if (senderUser?.status === 'active' && senderUser.role === 'admin') {
        effectiveGroup = { ...effectiveGroup, created_by: senderUser.id };
        break;
      }
    }
  }

  // Reply routing: IM JIDs reply to their respective IM channel.
  // With the home-folder forced restart in the message loop, each JID gets its
  // own processGroupMessages call, so JID-based routing is always correct.
  const shouldReplyToIM = getChannelType(chatJid) !== null;

  const shared = isGroupShared(group.folder);
  const prompt = formatMessages(missedMessages, shared);

  const images = collectMessageImages(chatJid, missedMessages);
  const imagesForAgent = images.length > 0 ? images : undefined;

  logger.info(
    {
      group: group.name,
      messageCount: missedMessages.length,
      shouldReplyToIM,
      imageCount: images.length,
      shared,
    },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, getSystemSettings().idleTimeout);
  };

  await setTyping(chatJid, true);
  let hadError = false;
  let sentReply = false;
  let lastError = '';
  let cursorCommitted = false;
  const queryTaskIds = new Set<string>();
  const lastProcessed = missedMessages[missedMessages.length - 1];

  const pickRunningTaskForNotification = (): string | null => {
    const runningInQuery = Array.from(queryTaskIds)
      .map((id) => getAgent(id))
      .filter((a): a is NonNullable<ReturnType<typeof getAgent>> =>
        !!a && a.kind === 'task' && a.chat_jid === chatJid && a.status === 'running',
      )
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (runningInQuery.length > 0) {
      return runningInQuery[0].id;
    }
    const runningInChat = listAgentsByJid(chatJid)
      .filter((a) => a.kind === 'task' && a.status === 'running')
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    return runningInChat[0]?.id || null;
  };

  const commitCursor = (): void => {
    if (cursorCommitted) return;
    lastAgentTimestamp[chatJid] = {
      timestamp: lastProcessed.timestamp,
      id: lastProcessed.id,
    };
    saveState();
    cursorCommitted = true;
  };

  const output = await runAgent(
    effectiveGroup,
    prompt,
    chatJid,
    async (result) => {
      try {
        // 流式事件处理 - 广播 WebSocket + 持久化 SDK Task 生命周期到 DB
        if (result.status === 'stream' && result.streamEvent) {
          broadcastStreamEvent(chatJid, result.streamEvent);

          // Persist SDK Task lifecycle to DB so tabs survive page refresh
          const se = result.streamEvent;
          if (
            (se.eventType === 'task_start' && se.toolUseId)
            || (se.eventType === 'tool_use_start' && se.toolName === 'Task' && se.toolUseId)
          ) {
            try {
              const taskId = se.toolUseId;
              queryTaskIds.add(taskId);
              const existing = getAgent(taskId);
              const desc = se.taskDescription || se.toolInputSummary || '';
              if (!existing) {
                createAgent({
                  id: taskId,
                  group_folder: group.folder,
                  chat_jid: chatJid,
                  name: desc.slice(0, 40) || 'Task',
                  prompt: desc,
                  status: 'running',
                  kind: 'task',
                  created_by: null,
                  created_at: new Date().toISOString(),
                  completed_at: null,
                  result_summary: null,
                });
              } else if (se.taskDescription) {
                updateAgentInfo(taskId, se.taskDescription.slice(0, 40), se.taskDescription);
              }
            } catch (err) {
              logger.warn({ err, toolUseId: se.toolUseId }, 'Failed to persist task_start to DB');
            }
          }
          if (se.eventType === 'tool_use_end' && se.toolUseId) {
            try {
              const existing = getAgent(se.toolUseId);
              if (existing && existing.kind === 'task' && existing.status === 'running') {
                updateAgentStatus(se.toolUseId, 'completed');
              }
            } catch (err) {
              logger.warn({ err, toolUseId: se.toolUseId }, 'Failed to persist tool_use_end to DB');
            }
          }
          if (se.eventType === 'task_notification' && se.taskId) {
            try {
              const status = se.taskStatus === 'completed' ? 'completed' : 'error';
              const summary = se.taskSummary?.slice(0, 2000);
              let targetTaskId = se.taskId;
              let existing = getAgent(targetTaskId);
              if (!existing || existing.kind !== 'task') {
                const fallbackTaskId = pickRunningTaskForNotification();
                if (fallbackTaskId) {
                  targetTaskId = fallbackTaskId;
                  existing = getAgent(fallbackTaskId);
                  logger.warn(
                    { chatJid, sdkTaskId: se.taskId, mappedTaskId: fallbackTaskId },
                    'Task notification ID mismatch, mapped to running task',
                  );
                }
              }

              if (!existing) {
                createAgent({
                  id: targetTaskId,
                  group_folder: group.folder,
                  chat_jid: chatJid,
                  name: 'Task',
                  prompt: '',
                  status,
                  kind: 'task',
                  created_by: null,
                  created_at: new Date().toISOString(),
                  completed_at: new Date().toISOString(),
                  result_summary: summary || null,
                });
              } else if (existing.kind === 'task') {
                updateAgentStatus(existing.id, status, summary);
                queryTaskIds.delete(existing.id);
              }
            } catch (err) {
              logger.warn({ err, taskId: se.taskId }, 'Failed to persist task_notification to DB');
            }
          }

          return;
        }

        // Streaming output callback — called for each agent result
        if (result.result) {
          const raw =
            typeof result.result === 'string'
              ? result.result
              : JSON.stringify(result.result);
          // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
          const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
          logger.info(
            { group: group.name },
            `Agent output: ${raw.slice(0, 200)}`,
          );
          if (text) {
            // Stop typing indicator before sending — clears the 4s refresh timer
            // so it doesn't keep firing while the agent stays alive in idle state.
            await setTyping(chatJid, false);
            await sendMessage(chatJid, text, {
              sendToIM: shouldReplyToIM,
            });
            sentReply = true;
            // Persist cursor as soon as a visible reply is emitted.
            // Long-lived runners may stay alive for idleTimeout, and waiting
            // until process exit would cause duplicate replay after restart.
            commitCursor();
          }
          // Only reset idle timer on actual results, not session-update markers (result: null)
          resetIdleTimer();
        }

        if (result.status === 'error') {
          hadError = true;
          if (result.error) lastError = result.error;
        }
      } catch (err) {
        logger.error({ group: group.name, err }, 'onOutput callback failed');
        hadError = true;
      }
    },
    imagesForAgent,
  );

  await setTyping(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  // 不可恢复的转录错误（如超大图片被固化在会话历史中）：无论是否已有回复，都必须重置会话
  const errorForReset = [lastError, output.error].filter(Boolean).join(' ');
  if ((output.status === 'error' || hadError) && errorForReset.includes('unrecoverable_transcript:')) {
    const detail = (lastError || output.error || '').replace(/.*unrecoverable_transcript:\s*/, '');
    logger.warn(
      { group: group.name, folder: group.folder, error: detail },
      'Unrecoverable transcript error, auto-resetting session',
    );

    // 清除会话文件（保留 settings.json）
    // 容器创建的文件可能归属 node(1000)，先尝试直接删除，失败则用 Docker 清理
    const claudeDir = path.join(DATA_DIR, 'sessions', group.folder, '.claude');
    if (fs.existsSync(claudeDir)) {
      let cleared = false;
      try {
        for (const entry of fs.readdirSync(claudeDir)) {
          if (entry === 'settings.json') continue;
          fs.rmSync(path.join(claudeDir, entry), { recursive: true, force: true });
        }
        cleared = true;
      } catch {
        logger.info({ folder: group.folder }, 'Direct cleanup failed, using Docker fallback');
      }
      if (!cleared) {
        try {
          await execFileAsync('docker', [
            'run', '--rm', '-v', `${claudeDir}:/target`, CONTAINER_IMAGE,
            'sh', '-c', 'find /target -mindepth 1 -not -name settings.json -exec rm -rf {} + 2>/dev/null; exit 0',
          ], { timeout: 15_000 });
        } catch (err) {
          logger.error({ folder: group.folder, err }, 'Docker fallback cleanup also failed');
        }
      }
    }

    // 清除 DB 和内存中的 session 记录
    try {
      deleteAllSessionsForFolder(group.folder);
      delete sessions[group.folder];
    } catch (err) {
      logger.error({ folder: group.folder, err }, 'Failed to clear session state during auto-reset');
    }

    sendSystemMessage(chatJid, 'context_reset', `会话已自动重置：${detail}`);
    commitCursor();
    return true;
  }

  // Container closed during query (e.g. home folder drain) without sending a reply:
  // don't commit cursor so the message gets retried on the next poll cycle.
  // If sentReply is true the cursor was already committed at line 722, no action needed.
  if (output.status === 'closed' && !sentReply) {
    logger.warn(
      { group: group.name, chatJid },
      'Container closed during query without reply, keeping cursor for retry',
    );
    return true;
  }

  // Query 出错时，将残留 running task 标记为 error，避免长期僵尸状态。
  // 正常退出不做强制 completed，避免把未确认完成的任务误判为已完成。
  const isErrorExit = output.status === 'error' || hadError;
  if (isErrorExit) {
    try {
      const marked = markRunningTaskAgentsAsError(chatJid);
      if (marked > 0) {
        logger.info({ chatJid, marked }, 'Marked remaining running task agents as error');
      }
    } catch (err) {
      logger.warn({ chatJid, err }, 'Failed to mark running task agents');
    }
  } else {
    // Safety net: if query already ended successfully but some task agents are still
    // running (usually due SDK event ID mismatch), force-complete them to avoid stale tabs.
    try {
      let completed = 0;
      for (const taskId of queryTaskIds) {
        const agent = getAgent(taskId);
        if (!agent || agent.kind !== 'task' || agent.chat_jid !== chatJid || agent.status !== 'running') continue;
        updateAgentStatus(taskId, 'completed', agent.result_summary || '任务已完成');
        broadcastAgentStatus(chatJid, taskId, 'completed', agent.name, agent.prompt, agent.result_summary || '任务已完成', agent.kind);
        completed += 1;
      }
      if (completed > 0) {
        logger.warn({ chatJid, completed }, 'Force-completed stale running task agents after successful query');
      }
    } catch (err) {
      logger.warn({ chatJid, err }, 'Failed to force-complete stale running task agents');
    }
  }

  if (isErrorExit && !sentReply) {
    // Only roll back cursor if no reply was sent — if the agent already
    // replied successfully, a subsequent timeout is not a real error and
    // rolling back would cause the same messages to be re-processed,
    // leading to duplicate replies.
    const errorDetail = output.error || lastError || '未知错误';

    // 上下文溢出错误：跳过重试，提交游标，通知用户
    if (errorDetail.startsWith('context_overflow:')) {
      const overflowMsg = errorDetail.replace(/^context_overflow:\s*/, '');
      sendSystemMessage(chatJid, 'context_overflow', overflowMsg);
      logger.warn(
        { group: group.name, error: overflowMsg },
        'Context overflow detected, skipping retry',
      );
      commitCursor();
      return true;
    }

    sendSystemMessage(chatJid, 'agent_error', errorDetail);
    logger.warn(
      { group: group.name, error: errorDetail },
      'Agent error (no reply sent), keeping cursor at previous position for retry',
    );
    return false;
  }

  // Final fallback for silent-success paths (no visible reply).
  commitCursor();

  return true;
}

async function runTerminalWarmup(chatJid: string): Promise<void> {
  const group = registeredGroups[chatJid];
  if (!group) return;
  if ((group.executionMode || 'container') === 'host') return;

  logger.info({ chatJid, group: group.name }, 'Starting terminal warmup run');

  const warmupReadyToken = '<terminal_ready>';
  const warmupPrompt = [
    '这是系统触发的终端预热请求。',
    `请只回复 ${warmupReadyToken}，不要回复其它内容，也不要调用工具。`,
  ].join(' ');

  let bootstrapCompleted = false;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ chatJid, group: group.name }, 'Terminal warmup idle timeout, closing stdin');
      queue.closeStdin(chatJid);
    }, getSystemSettings().idleTimeout);
  };

  try {
    const output = await runAgent(
      group,
      warmupPrompt,
      chatJid,
      async (result) => {
        if (result.status === 'stream' && result.streamEvent) {
          broadcastStreamEvent(chatJid, result.streamEvent);
          return;
        }

        if (result.status === 'error') return;

        // During warmup query, NEVER emit assistant text to chat.
        // Only mark bootstrap complete after the session update marker.
        if (result.result === null) {
          if (!bootstrapCompleted) {
            bootstrapCompleted = true;
            resetIdleTimer();
          }
          return;
        }

        if (!bootstrapCompleted) return;

        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        if (!text || text === warmupReadyToken) return;
        await sendMessage(chatJid, text);
        resetIdleTimer();
      },
    );

    if (output.status === 'error') {
      logger.warn(
        { chatJid, group: group.name, error: output.error },
        'Terminal warmup run ended with error',
      );
    } else {
      logger.info({ chatJid, group: group.name }, 'Terminal warmup run completed');
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }
}

function ensureTerminalContainerStarted(chatJid: string): boolean {
  const group = registeredGroups[chatJid];
  if (!group) return false;
  if ((group.executionMode || 'container') === 'host') return false;

  const status = queue.getStatus();
  const groupStatus = status.groups.find((g) => g.jid === chatJid);
  if (groupStatus?.active) return true;
  if (terminalWarmupInFlight.has(chatJid)) return true;

  terminalWarmupInFlight.add(chatJid);
  const taskId = `terminal-warmup:${chatJid}`;
  queue.enqueueTask(chatJid, taskId, async () => {
    try {
      await runTerminalWarmup(chatJid);
    } finally {
      terminalWarmupInFlight.delete(chatJid);
    }
  });
  return true;
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  images?: Array<{ data: string; mimeType?: string }>,
): Promise<{ status: 'success' | 'error' | 'closed'; error?: string }> {
  const isHome = !!group.is_home;
  // For the agent-runner: isMain means this is an admin home container (full privileges)
  const isAdminHome = isHome && group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isAdminHome,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (admin home only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isAdminHome,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        // 仅从成功的输出中更新 session ID；
        // error 输出可能携带 stale ID，会覆盖流式传递的有效 session
        if (output.newSessionId && output.status !== 'error') {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const executionMode = group.executionMode || 'container';

    const onProcessCb = (proc: ChildProcess, identifier: string) => {
      // 宿主机模式：containerName 传 null，走 process.kill() 路径
      const containerName = executionMode === 'container' ? identifier : null;
      queue.registerProcess(chatJid, proc, containerName, group.folder, identifier);
    };

    let output: ContainerOutput;

    if (executionMode === 'host') {
      output = await runHostAgent(
        group,
        {
          prompt,
          sessionId,
          groupFolder: group.folder,
          chatJid,
          isMain: isAdminHome,
          isHome,
          isAdminHome,
          images,
        },
        onProcessCb,
        wrappedOnOutput,
      );
    } else {
      output = await runContainerAgent(
        group,
        {
          prompt,
          sessionId,
          groupFolder: group.folder,
          chatJid,
          isMain: isAdminHome,
          isHome,
          isAdminHome,
          images,
        },
        onProcessCb,
        wrappedOnOutput,
      );
    }

    // 仅从成功的最终输出中更新 session ID；
    // error 状态的输出可能携带 stale ID，覆盖流式阶段已写入的有效 session
    if (output.newSessionId && output.status !== 'error') {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    // Agent was interrupted by _close sentinel (home folder drain).
    // Propagate so processGroupMessages can skip cursor commit.
    if (output.status === 'closed') {
      return { status: 'closed' };
    }

    if (output.status === 'error') {
      logger.error(
        { group: group.name, error: output.error },
        'Agent error',
      );
      if (output.result && wrappedOnOutput) {
        try {
          await wrappedOnOutput(output);
        } catch (err) {
          logger.error(
            { group: group.name, err },
            'Failed to emit agent error output',
          );
        }
      }
      return { status: 'error', error: output.error };
    }

    return { status: 'success' };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.error({ group: group.name, err }, 'Agent error');
    return { status: 'error', error: errorMsg };
  }
}

async function sendMessage(
  jid: string,
  text: string,
  options: SendMessageOptions = {},
): Promise<void> {
  const isIMChannel = getChannelType(jid) !== null;
  const sendToIM = options.sendToIM ?? isIMChannel;
  try {
    if (sendToIM && isIMChannel) {
      try {
        await imManager.sendMessage(jid, text);
      } catch (err) {
        logger.error({ jid, err }, 'Failed to send message to IM channel');
      }
    }

    // Persist assistant reply so Web polling can render it and clear waiting state.
    const msgId = crypto.randomUUID();
    const timestamp = new Date().toISOString();
    ensureChatExists(jid);
    storeMessageDirect(
      msgId,
      jid,
      'happyclaw-agent',
      ASSISTANT_NAME,
      text,
      timestamp,
      true,
    );

    broadcastNewMessage(jid, {
      id: msgId,
      chat_jid: jid,
      sender: 'happyclaw-agent',
      sender_name: ASSISTANT_NAME,
      content: text,
      timestamp,
      is_from_me: true,
    });
    logger.info({ jid, length: text.length, sendToIM }, 'Message sent');
    broadcastToWebClients(jid, text);
  } catch (err) {
    logger.error({ jid, err }, 'Failed to send message');
  }
}

/**
 * Check if a source group is authorized to send IPC messages to a target group.
 * - Admin home can send to any group.
 * - Non-home groups can only send to groups sharing the same folder.
 * - Member home groups can send to groups created by the same user.
 */
function canSendCrossGroupMessage(
  isAdminHome: boolean,
  isHome: boolean,
  sourceFolder: string,
  sourceGroupEntry: RegisteredGroup | undefined,
  targetGroup: RegisteredGroup | undefined,
): boolean {
  if (isAdminHome) return true;
  if (targetGroup && targetGroup.folder === sourceFolder) return true;
  if (isHome && targetGroup && sourceGroupEntry?.created_by != null && targetGroup.created_by === sourceGroupEntry.created_by) return true;
  return false;
}

function startIpcWatcher(): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    if (shuttingDown) return;
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      if (!shuttingDown) setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    for (const sourceGroup of groupFolders) {
      // Determine if this IPC directory belongs to an admin home group
      const sourceGroupEntry = Object.values(registeredGroups).find(
        (g) => g.folder === sourceGroup,
      );
      const isAdminHome = !!(sourceGroupEntry?.is_home && sourceGroup === MAIN_GROUP_FOLDER);
      const isHome = !!sourceGroupEntry?.is_home;

      // Collect all IPC roots: main group dir + agents/*/
      const groupIpcRoot = path.join(ipcBaseDir, sourceGroup);
      const ipcRoots = [groupIpcRoot];
      try {
        const agentsDir = path.join(groupIpcRoot, 'agents');
        if (fs.existsSync(agentsDir)) {
          for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
              ipcRoots.push(path.join(agentsDir, entry.name));
            }
          }
        }
      } catch { /* ignore */ }

      for (const ipcRoot of ipcRoots) {
      const messagesDir = path.join(ipcRoot, 'messages');
      const tasksDir = path.join(ipcRoot, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              if (data.type === 'message' && data.chatJid && data.text) {
                const targetGroup = registeredGroups[data.chatJid];
                if (canSendCrossGroupMessage(isAdminHome, isHome, sourceGroup, sourceGroupEntry, targetGroup)) {
                  await sendMessage(data.chatJid, data.text);
                  logger.info(
                    { chatJid: data.chatJid, sourceGroup },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC message attempt blocked',
                  );
                }
              }
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              try {
                fs.renameSync(
                  filePath,
                  path.join(errorDir, `${sourceGroup}-${file}`),
                );
              } catch (renameErr) {
                logger.error(
                  { file, sourceGroup, renameErr },
                  'Failed to move IPC message to error directory, deleting',
                );
                try {
                  fs.unlinkSync(filePath);
                } catch {
                  /* ignore */
                }
              }
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const allEntries = fs.readdirSync(tasksDir, { withFileTypes: true });

          // 清理孤儿结果文件（容器崩溃或超时后残留，超过 10 分钟自动删除）
          for (const entry of allEntries) {
            if (
              entry.isFile() &&
              entry.name.endsWith('.json') &&
              (entry.name.startsWith('install_skill_result_') || entry.name.startsWith('uninstall_skill_result_'))
            ) {
              try {
                const filePath = path.join(tasksDir, entry.name);
                const stat = fs.statSync(filePath);
                if (Date.now() - stat.mtimeMs > 10 * 60 * 1000) {
                  fs.unlinkSync(filePath);
                  logger.debug({ sourceGroup, file: entry.name }, 'Cleaned up stale skill result file');
                }
              } catch { /* ignore */ }
            }
          }

          const taskFiles = allEntries
            .filter((entry) =>
              entry.isFile() &&
              entry.name.endsWith('.json') &&
              !entry.name.startsWith('install_skill_result_') &&
              !entry.name.startsWith('uninstall_skill_result_')
            )
            .map((entry) => entry.name);
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isAdminHome);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              try {
                fs.renameSync(
                  filePath,
                  path.join(errorDir, `${sourceGroup}-${file}`),
                );
              } catch (renameErr) {
                logger.error(
                  { file, sourceGroup, renameErr },
                  'Failed to move IPC task to error directory, deleting',
                );
                try {
                  fs.unlinkSync(filePath);
                } catch {
                  /* ignore */
                }
              }
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }

      } // end for (const ipcRoot of ipcRoots)

    }

    if (!shuttingDown) setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    execution_type?: string;
    script_command?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For install_skill / uninstall_skill
    package?: string;
    requestId?: string;
    skillId?: string;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isAdminHome: boolean, // Whether source is admin home container
): Promise<void> {
  switch (data.type) {
    case 'schedule_task':
      if (
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        const execType = data.execution_type === 'script' ? 'script' as const : 'agent' as const;

        // Script tasks require prompt OR script_command; agent tasks require prompt
        if (execType === 'agent' && !data.prompt) {
          logger.warn('schedule_task: agent mode requires prompt');
          break;
        }
        if (execType === 'script' && !data.script_command) {
          logger.warn('schedule_task: script mode requires script_command');
          break;
        }

        // Only admin home can create script tasks
        if (execType === 'script' && !isAdminHome) {
          logger.warn(
            { sourceGroup },
            'Non-admin container attempted to create script task',
          );
          break;
        }

        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-admin-home groups can only schedule for themselves
        if (!isAdminHome && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const scheduled = new Date(data.schedule_value);
          if (isNaN(scheduled.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = scheduled.toISOString();
        }

        const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt || '',
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          execution_type: execType,
          script_command: data.script_command ?? null,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode, execType },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isAdminHome || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isAdminHome || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isAdminHome || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'refresh_groups':
      // Only admin home group can request a refresh
      if (isAdminHome) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await syncGroupMetadata(true);
        // Write updated snapshot immediately
        const availableGroups = getAvailableGroups();
        writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only admin home group can register new groups
      if (!isAdminHome) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder) {
        registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'install_skill':
      if (data.package && data.requestId) {
        const pkg = data.package;
        const requestId = data.requestId;
        if (!SAFE_REQUEST_ID_RE.test(requestId)) {
          logger.warn({ sourceGroup, requestId }, 'Rejected install_skill request with invalid requestId');
          break;
        }
        const tasksDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'tasks');
        const tasksDirResolved = path.resolve(tasksDir);
        const resultFileName = `install_skill_result_${requestId}.json`;
        const resultFilePath = path.resolve(tasksDir, resultFileName);
        if (!resultFilePath.startsWith(`${tasksDirResolved}${path.sep}`)) {
          logger.warn(
            { sourceGroup, requestId, resultFilePath },
            'Rejected install_skill request with unsafe result file path',
          );
          break;
        }

        // Find the user who owns this group
        const sourceGroupForSkill = Object.values(registeredGroups).find(
          (g) => g.folder === sourceGroup,
        );
        const userId = sourceGroupForSkill?.created_by;

        if (!userId) {
          logger.warn({ sourceGroup }, 'Cannot install skill: no user associated with group');
          const errorResult = JSON.stringify({ success: false, error: 'No user associated with this group' });
          const tmpPath = `${resultFilePath}.tmp`;
          fs.mkdirSync(path.dirname(resultFilePath), { recursive: true });
          fs.writeFileSync(tmpPath, errorResult);
          fs.renameSync(tmpPath, resultFilePath);
          break;
        }

        try {
          const result = await installSkillForUser(userId, pkg);
          const tmpPath = `${resultFilePath}.tmp`;
          fs.mkdirSync(path.dirname(resultFilePath), { recursive: true });
          fs.writeFileSync(tmpPath, JSON.stringify(result));
          fs.renameSync(tmpPath, resultFilePath);
          logger.info(
            { sourceGroup, userId, pkg, success: result.success },
            'Skill installation via IPC completed',
          );
        } catch (err) {
          const errorResult = JSON.stringify({
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
          const tmpPath = `${resultFilePath}.tmp`;
          fs.mkdirSync(path.dirname(resultFilePath), { recursive: true });
          fs.writeFileSync(tmpPath, errorResult);
          fs.renameSync(tmpPath, resultFilePath);
          logger.error({ sourceGroup, userId, pkg, err }, 'Skill installation via IPC failed');
        }
      } else {
        logger.warn({ data }, 'Invalid install_skill request - missing required fields');
      }
      break;

    case 'uninstall_skill':
      if (data.skillId && data.requestId) {
        const skillId = data.skillId;
        const requestId = data.requestId;
        if (!SAFE_REQUEST_ID_RE.test(requestId)) {
          logger.warn({ sourceGroup, requestId }, 'Rejected uninstall_skill request with invalid requestId');
          break;
        }
        const tasksDir = path.join(DATA_DIR, 'ipc', sourceGroup, 'tasks');
        const tasksDirResolved = path.resolve(tasksDir);
        const resultFileName = `uninstall_skill_result_${requestId}.json`;
        const resultFilePath = path.resolve(tasksDir, resultFileName);
        if (!resultFilePath.startsWith(`${tasksDirResolved}${path.sep}`)) {
          logger.warn(
            { sourceGroup, requestId, resultFilePath },
            'Rejected uninstall_skill request with unsafe result file path',
          );
          break;
        }

        const sourceGroupForUninstall = Object.values(registeredGroups).find(
          (g) => g.folder === sourceGroup,
        );
        const userId = sourceGroupForUninstall?.created_by;

        if (!userId) {
          logger.warn({ sourceGroup }, 'Cannot uninstall skill: no user associated with group');
          const errorResult = JSON.stringify({ success: false, error: 'No user associated with this group' });
          const tmpPath = `${resultFilePath}.tmp`;
          fs.mkdirSync(path.dirname(resultFilePath), { recursive: true });
          fs.writeFileSync(tmpPath, errorResult);
          fs.renameSync(tmpPath, resultFilePath);
          break;
        }

        const result = deleteSkillForUser(userId, skillId);
        const tmpPath = `${resultFilePath}.tmp`;
        fs.mkdirSync(path.dirname(resultFilePath), { recursive: true });
        fs.writeFileSync(tmpPath, JSON.stringify(result));
        fs.renameSync(tmpPath, resultFilePath);
        logger.info(
          { sourceGroup, userId, skillId, success: result.success },
          'Skill uninstall via IPC completed',
        );
      } else {
        logger.warn({ data }, 'Invalid uninstall_skill request - missing required fields');
      }
      break;

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}


/**
 * Process messages for a user-created conversation agent.
 * Similar to processGroupMessages but uses agent-specific session/IPC and virtual JID.
 * The agent process stays alive for idleTimeout, cycling idle→running.
 */
async function processAgentConversation(chatJid: string, agentId: string): Promise<void> {
  const agent = getAgent(agentId);
  if (!agent || agent.kind !== 'conversation') {
    logger.warn({ chatJid, agentId }, 'processAgentConversation: agent not found or not a conversation');
    return;
  }

  let group = registeredGroups[chatJid];
  if (!group) {
    registeredGroups = getAllRegisteredGroups();
    group = registeredGroups[chatJid];
  }
  if (!group) return;

  // Inherit home group properties (same as processGroupMessages)
  let effectiveGroup = group;
  if (!group.is_home) {
    const siblingJids = getJidsByFolder(group.folder);
    for (const jid of siblingJids) {
      const sibling = registeredGroups[jid] ?? getRegisteredGroup(jid);
      if (sibling && !registeredGroups[jid]) registeredGroups[jid] = sibling;
      if (sibling?.is_home) {
        effectiveGroup = {
          ...group,
          executionMode: sibling.executionMode,
          customCwd: sibling.customCwd || group.customCwd,
          created_by: group.created_by || sibling.created_by,
          is_home: true,
        };
        break;
      }
    }
  }

  const virtualChatJid = `${chatJid}#agent:${agentId}`;
  const virtualJid = virtualChatJid; // used as queue key

  // Get pending messages
  const sinceCursor = lastAgentTimestamp[virtualChatJid] || EMPTY_CURSOR;
  const missedMessages = getMessagesSince(virtualChatJid, sinceCursor);
  if (missedMessages.length === 0) return;

  const isHome = !!effectiveGroup.is_home;
  const isAdminHome = isHome && effectiveGroup.folder === MAIN_GROUP_FOLDER;

  // Update agent status → running
  updateAgentStatus(agentId, 'running');
  broadcastAgentStatus(chatJid, agentId, 'running', agent.name, agent.prompt);

  const prompt = formatMessages(missedMessages, false);
  const images = collectMessageImages(virtualChatJid, missedMessages);
  const imagesForAgent = images.length > 0 ? images : undefined;

  // Track idle timer
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug({ agentId, chatJid }, 'Agent conversation idle timeout, closing stdin');
      queue.closeStdin(virtualJid);
    }, getSystemSettings().idleTimeout);
  };

  let cursorCommitted = false;
  const lastProcessed = missedMessages[missedMessages.length - 1];
  const commitCursor = (): void => {
    if (cursorCommitted) return;
    lastAgentTimestamp[virtualChatJid] = {
      timestamp: lastProcessed.timestamp,
      id: lastProcessed.id,
    };
    saveState();
    cursorCommitted = true;
  };

  // Get or use agent-specific session
  const sessionId = getSession(effectiveGroup.folder, agentId) || undefined;

  const wrappedOnOutput = async (output: ContainerOutput) => {
    // Track session
    if (output.newSessionId && output.status !== 'error') {
      setSession(effectiveGroup.folder, output.newSessionId, agentId);
    }

    // Stream events
    if (output.status === 'stream' && output.streamEvent) {
      broadcastStreamEvent(chatJid, output.streamEvent, agentId);
      return;
    }

    // Agent reply
    if (output.result) {
      const raw = typeof output.result === 'string' ? output.result : JSON.stringify(output.result);
      const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
      if (text) {
        const msgId = crypto.randomUUID();
        const timestamp = new Date().toISOString();
        ensureChatExists(virtualChatJid);
        storeMessageDirect(
          msgId, virtualChatJid, 'happyclaw-agent', ASSISTANT_NAME, text, timestamp, true,
        );
        broadcastNewMessage(virtualChatJid, {
          id: msgId,
          chat_jid: virtualChatJid,
          sender: 'happyclaw-agent',
          sender_name: ASSISTANT_NAME,
          content: text,
          timestamp,
          is_from_me: true,
        }, agentId);
        commitCursor();
        resetIdleTimer();
      }
    }

    if (output.status === 'error') {
      // Error handling
    }
  };

  try {
    const executionMode = effectiveGroup.executionMode || 'container';
    const onProcessCb = (proc: ChildProcess, identifier: string) => {
      const containerName = executionMode === 'container' ? identifier : null;
      queue.registerProcess(virtualJid, proc, containerName, effectiveGroup.folder, identifier, agentId);
    };

    const containerInput: ContainerInput = {
      prompt,
      sessionId,
      groupFolder: effectiveGroup.folder,
      chatJid,
      isMain: isAdminHome,
      isHome,
      isAdminHome,
      agentId,
      agentName: agent.name,
      images: imagesForAgent,
    };

    // Write tasks/groups snapshots
    const tasks = getAllTasks();
    writeTasksSnapshot(effectiveGroup.folder, isAdminHome, tasks.map((t) => ({
      id: t.id, groupFolder: t.group_folder, prompt: t.prompt,
      schedule_type: t.schedule_type, schedule_value: t.schedule_value,
      status: t.status, next_run: t.next_run,
    })));
    const availableGroups = getAvailableGroups();
    writeGroupsSnapshot(effectiveGroup.folder, isAdminHome, availableGroups, new Set(Object.keys(registeredGroups)));

    let output: ContainerOutput;
    if (executionMode === 'host') {
      output = await runHostAgent(effectiveGroup, containerInput, onProcessCb, wrappedOnOutput);
    } else {
      output = await runContainerAgent(effectiveGroup, containerInput, onProcessCb, wrappedOnOutput);
    }

    // Finalize session
    if (output.newSessionId && output.status !== 'error') {
      setSession(effectiveGroup.folder, output.newSessionId, agentId);
    }

    commitCursor();
  } catch (err) {
    logger.error({ agentId, chatJid, err }, 'Agent conversation error');
  } finally {
    if (idleTimer) clearTimeout(idleTimer);
  }

  // Process ended → set status back to idle (conversation agents persist)
  updateAgentStatus(agentId, 'idle');
  broadcastAgentStatus(chatJid, agentId, 'idle', agent.name, agent.prompt);
}


async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  logger.info('happyclaw running');

  while (!shuttingDown) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newCursor } = getNewMessages(jids, globalMessageCursor);

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        globalMessageCursor = newCursor;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        // Build set of home folders: IM messages sharing a home folder must
        // force-restart the container so reply routing is correct (e.g., feishu
        // messages get feishu replies instead of being silently absorbed by web:main).
        const homeFolders = new Set<string>();
        for (const g of Object.values(registeredGroups)) {
          if (g.is_home) homeFolders.add(g.folder);
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          let group = registeredGroups[chatJid];
          if (!group) {
            const dbGroup = getRegisteredGroup(chatJid);
            if (dbGroup) {
              registeredGroups[chatJid] = dbGroup;
              group = dbGroup;
            }
          }
          if (!group) continue;
          if (group.is_home) homeFolders.add(group.folder);

          // Handle cold-cache/newly-added groups: detect home folders from DB
          // even if the in-memory map has not been fully refreshed yet.
          if (!homeFolders.has(group.folder)) {
            const siblingJids = getJidsByFolder(group.folder);
            for (const siblingJid of siblingJids) {
              const sibling =
                registeredGroups[siblingJid] ?? getRegisteredGroup(siblingJid);
              if (sibling && !registeredGroups[siblingJid]) {
                registeredGroups[siblingJid] = sibling;
              }
              if (sibling?.is_home) {
                homeFolders.add(group.folder);
                break;
              }
            }
          }

          // Pull all messages since lastAgentTimestamp to preserve full context.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || EMPTY_CURSOR,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;

          // Groups sharing a home folder always run as a fresh batch.
          // This prevents IM messages from being piped into an active web:main
          // container (whose onOutput callback wouldn't route replies to IM).
          if (homeFolders.has(group.folder)) {
            queue.closeStdin(chatJid);
            logger.debug(
              { chatJid },
              'Home-folder message received, forcing stdin close before enqueue',
            );
            queue.enqueueMessageCheck(chatJid);
            continue;
          }

          const shared = !group.is_home && isGroupShared(group.folder);
          const formatted = formatMessages(messagesToSend, shared);

          const images = collectMessageImages(chatJid, messagesToSend);
          const imagesForAgent = images.length > 0 ? images : undefined;

          const lastRawText = messagesToSend[messagesToSend.length - 1].content;
          const intent = analyzeIntent(lastRawText);
          const sendResult = queue.sendMessage(chatJid, formatted, imagesForAgent, intent);
          if (sendResult === 'sent') {
            logger.debug(
              { chatJid, count: messagesToSend.length, imageCount: images.length },
              'Piped messages to active container',
            );
            const lastProcessed = messagesToSend[messagesToSend.length - 1];
            lastAgentTimestamp[chatJid] = {
              timestamp: lastProcessed.timestamp,
              id: lastProcessed.id,
            };
            saveState();
          } else if (sendResult === 'interrupted_stop') {
            // Stop intent: update cursor, don't enqueue (agent stops)
            const lastProcessed = messagesToSend[messagesToSend.length - 1];
            lastAgentTimestamp[chatJid] = {
              timestamp: lastProcessed.timestamp,
              id: lastProcessed.id,
            };
            saveState();
          } else if (sendResult === 'interrupted_correction') {
            // Correction intent: update cursor; the IPC message was written so the
            // interrupted agent will pick it up in its session loop after the abort.
            // No enqueueMessageCheck needed — the existing agent handles it.
            const lastProcessed = messagesToSend[messagesToSend.length - 1];
            lastAgentTimestamp[chatJid] = {
              timestamp: lastProcessed.timestamp,
              id: lastProcessed.id,
            };
            saveState();
          } else {
            // no_active — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing global cursor and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const sinceCursor = lastAgentTimestamp[chatJid] || EMPTY_CURSOR;
    const pending = getMessagesSince(chatJid, sinceCursor);
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

async function ensureDockerRunning(): Promise<void> {
  try {
    await execFileAsync('docker', ['info'], { timeout: 10000 });
    logger.debug('Docker daemon is running');
  } catch {
    // 如果有容器模式的 group，Docker 必须运行
    const hasContainerGroups = Object.values(registeredGroups).some(
      (g) => (g.executionMode || 'container') === 'container',
    );
    if (hasContainerGroups) {
      logger.error('Docker daemon is not running');
      console.error(
        '\n╔════════════════════════════════════════════════════════════════╗',
      );
      console.error(
        '║  FATAL: Docker is not running                                  ║',
      );
      console.error(
        '║                                                                ║',
      );
      console.error(
        '║  Agents cannot run without Docker. To fix:                     ║',
      );
      console.error(
        '║  macOS: Start Docker Desktop                                   ║',
      );
      console.error(
        '║  Linux: sudo systemctl start docker                            ║',
      );
      console.error(
        '║                                                                ║',
      );
      console.error(
        '║  Install from: https://docker.com/products/docker-desktop      ║',
      );
      console.error(
        '╚════════════════════════════════════════════════════════════════╝\n',
      );
      throw new Error('Docker is required but not running');
    } else {
      logger.warn(
        'Docker is not running, but all groups use host execution mode',
      );
    }
  }

  // Kill and clean up orphaned happyclaw containers from previous runs
  try {
    const { stdout } = await execFileAsync(
      'docker',
      ['ps', '--filter', 'name=happyclaw-', '--format', '{{.Names}}'],
      { timeout: 10000 },
    );
    const output = typeof stdout === 'string' ? stdout : String(stdout);
    const orphans = output.trim().split('\n').filter(Boolean);
    for (const name of orphans) {
      try {
        await execFileAsync('docker', ['stop', name], { timeout: 10000 });
      } catch {
        /* already stopped */
      }
    }
    if (orphans.length > 0) {
      logger.info(
        { count: orphans.length, names: orphans },
        'Stopped orphaned containers',
      );
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned containers');
  }
}

/**
 * Build the onNewChat callback for IM connections.
 * Feishu/Telegram chats auto-register to the user's home group folder.
 *
 * When the same Feishu app is transferred between users (e.g., admin disables
 * their channel and a member enables the same credentials), existing chats
 * are re-routed to the new user's home folder on first message receipt.
 */
function buildOnNewChat(userId: string, homeFolder: string): (chatJid: string, chatName: string) => void {
  return (chatJid, chatName) => {
    const existing = registeredGroups[chatJid];
    if (existing) {
      // Already owned by this user — nothing to do
      if (existing.created_by === userId) return;

      // Different user's connection now owns this IM app.
      // Re-route the chat to the current user's home folder.
      // This handles the common case where the same Feishu app credentials
      // are moved from one user to another (e.g., admin → member for testing).
      if (!existing.is_home) {
        const previousFolder = existing.folder;
        const previousOwner = existing.created_by;
        existing.folder = homeFolder;
        existing.created_by = userId;
        setRegisteredGroup(chatJid, existing);
        registeredGroups[chatJid] = existing;
        logger.info(
          { chatJid, chatName, userId, homeFolder, previousFolder, previousOwner },
          'Re-routed IM chat to new user (IM credentials transferred)',
        );
      }
      return;
    }
    registerGroup(chatJid, {
      name: chatName,
      folder: homeFolder,
      added_at: new Date().toISOString(),
      created_by: userId,
    });
    logger.info({ chatJid, chatName, userId, homeFolder }, 'Auto-registered IM chat');
  };
}

function buildIsChatAuthorized(userId: string): (jid: string) => boolean {
  return (jid) => {
    const group = registeredGroups[jid];
    return !!group && group.created_by === userId;
  };
}

function buildOnPairAttempt(userId: string): (jid: string, chatName: string, code: string) => Promise<boolean> {
  return async (jid, chatName, code) => {
    const result = verifyPairingCode(code);
    if (!result) return false;
    if (result.userId !== userId) return false;
    const pairingUserHome = getUserHomeGroup(result.userId);
    if (!pairingUserHome) return false;
    buildOnNewChat(result.userId, pairingUserHome.folder)(jid, chatName);
    return true;
  };
}

/**
 * Connect IM channels for a specific user via imManager.
 * Reads the user's IM config and connects if enabled.
 */
async function connectUserIMChannels(
  userId: string,
  homeFolder: string,
  feishuConfig?: FeishuConnectConfig | null,
  telegramConfig?: TelegramConnectConfig | null,
  ignoreMessagesBefore?: number,
): Promise<{ feishu: boolean; telegram: boolean }> {
  const onNewChat = buildOnNewChat(userId, homeFolder);
  const resolveGroupFolder = (chatJid: string): string | undefined => {
    const group = registeredGroups[chatJid] ?? getRegisteredGroup(chatJid);
    return group?.folder;
  };
  let feishu = false;
  let telegram = false;

  if (feishuConfig && feishuConfig.enabled !== false && feishuConfig.appId && feishuConfig.appSecret) {
    feishu = await imManager.connectUserFeishu(userId, feishuConfig, onNewChat, ignoreMessagesBefore, handleCommand, resolveGroupFolder);
  }

  if (telegramConfig && telegramConfig.enabled !== false && telegramConfig.botToken) {
    telegram = await imManager.connectUserTelegram(userId, telegramConfig, onNewChat, buildIsChatAuthorized(userId), buildOnPairAttempt(userId), handleCommand, resolveGroupFolder);
  }

  return { feishu, telegram };
}

function movePathWithFallback(src: string, dst: string): void {
  try {
    fs.renameSync(src, dst);
  } catch (err: unknown) {
    // Cross-device rename fallback.
    if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
      fs.cpSync(src, dst, { recursive: true });
      fs.rmSync(src, { recursive: true, force: true });
      return;
    }
    throw err;
  }
}

/**
 * One-shot migration: move legacy top-level directories into data/.
 * - store/messages.db* → data/db/messages.db*
 * - groups/            → data/groups/
 * Also supports partial migrations (old+new paths both exist).
 */
function migrateDataDirectories(): void {
  const projectRoot = process.cwd();

  // 1. Migrate store/ → data/db/
  const oldStoreDir = path.join(projectRoot, 'store');
  if (fs.existsSync(oldStoreDir)) {
    fs.mkdirSync(STORE_DIR, { recursive: true });
    // Move messages.db and WAL files
    for (const file of ['messages.db', 'messages.db-wal', 'messages.db-shm']) {
      const src = path.join(oldStoreDir, file);
      const dst = path.join(STORE_DIR, file);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        movePathWithFallback(src, dst);
        logger.info({ src, dst }, 'Migrated database file');
      }
    }
    // Remove old store/ if empty
    try {
      fs.rmdirSync(oldStoreDir);
    } catch {
      // Not empty — leave it
    }
  }

  // 2. Migrate groups/ → data/groups/
  const oldGroupsDir = path.join(projectRoot, 'groups');
  if (fs.existsSync(oldGroupsDir)) {
    fs.mkdirSync(path.dirname(GROUPS_DIR), { recursive: true });
    if (!fs.existsSync(GROUPS_DIR)) {
      movePathWithFallback(oldGroupsDir, GROUPS_DIR);
      logger.info(
        { src: oldGroupsDir, dst: GROUPS_DIR },
        'Migrated groups directory',
      );
    } else {
      // Partial migration: move missing entries one-by-one.
      const entries = fs.readdirSync(oldGroupsDir, { withFileTypes: true });
      for (const entry of entries) {
        const src = path.join(oldGroupsDir, entry.name);
        const dst = path.join(GROUPS_DIR, entry.name);
        if (!fs.existsSync(dst)) {
          movePathWithFallback(src, dst);
          logger.info({ src, dst }, 'Migrated legacy group entry');
        }
      }
      try {
        fs.rmdirSync(oldGroupsDir);
      } catch {
        // Not empty — leave it
      }
    }
  }
}

/**
 * One-shot migration: copy shared global CLAUDE.md → first admin's user-global dir.
 * Creates user-global directories for all existing users.
 * Idempotent via flag file.
 */
function migrateGlobalMemoryToPerUser(): void {
  const flagFile = path.join(DATA_DIR, 'config', '.memory-migration-v1-done');
  if (fs.existsSync(flagFile)) return;

  const oldGlobalMd = path.join(GROUPS_DIR, 'global', 'CLAUDE.md');
  const userGlobalBase = path.join(GROUPS_DIR, 'user-global');

  let migrationSucceeded = true;
  let copiedLegacyGlobal = !fs.existsSync(oldGlobalMd);

  // Find first admin user
  try {
    const result = listUsers({ role: 'admin', status: 'active', page: 1, pageSize: 1 });
    const firstAdmin = result.users[0];

    if (firstAdmin && fs.existsSync(oldGlobalMd)) {
      const adminDir = path.join(userGlobalBase, firstAdmin.id);
      fs.mkdirSync(adminDir, { recursive: true });
      const target = path.join(adminDir, 'CLAUDE.md');
      if (!fs.existsSync(target)) {
        fs.copyFileSync(oldGlobalMd, target);
        logger.info(
          { userId: firstAdmin.id, src: oldGlobalMd, dst: target },
          'Migrated global CLAUDE.md to admin user-global',
        );
      }
      copiedLegacyGlobal = true;
    } else if (!firstAdmin && fs.existsSync(oldGlobalMd)) {
      migrationSucceeded = false;
      logger.warn(
        'No active admin found for legacy global memory migration; will retry on next startup',
      );
    }

    // Create user-global dirs for all users
    let page = 1;
    const allUsers: Array<{ id: string }> = [];
    while (true) {
      const r = listUsers({ status: 'active', page, pageSize: 200 });
      allUsers.push(...r.users);
      if (allUsers.length >= r.total) break;
      page++;
    }
    for (const u of allUsers) {
      fs.mkdirSync(path.join(userGlobalBase, u.id), { recursive: true });
    }
  } catch (err) {
    migrationSucceeded = false;
    logger.warn({ err }, 'Global memory migration encountered an error');
  }

  if (!migrationSucceeded) {
    logger.warn('Global memory migration incomplete; will retry on next startup');
    return;
  }

  if (!copiedLegacyGlobal) {
    logger.warn('Legacy global memory has not been copied; will retry on next startup');
    return;
  }

  try {
    fs.mkdirSync(path.dirname(flagFile), { recursive: true });
    fs.writeFileSync(flagFile, new Date().toISOString());
    logger.info('Global memory migration to per-user completed');
  } catch (err) {
    logger.warn({ err }, 'Failed to persist global memory migration flag');
  }
}

async function main(): Promise<void> {
  migrateDataDirectories();
  initDatabase();
  logger.info('Database initialized');

  // Clean up stale completed task agents (older than 1 hour) to prevent DB bloat
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const cleaned = deleteCompletedTaskAgents(oneHourAgo);
    if (cleaned > 0) {
      logger.info({ cleaned }, 'Cleaned up stale completed task agents');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up stale task agents');
  }

  // After process restart there cannot be truly running SDK tasks.
  // Mark all persisted running tasks as error to avoid stale "running" tabs.
  try {
    const marked = markAllRunningTaskAgentsAsError();
    if (marked > 0) {
      logger.warn({ marked }, 'Marked stale running task agents as error at startup');
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to mark stale running tasks at startup');
  }

  loadState();

  // --- Channel reload helpers (hot-reload on config save) ---

  let feishuSyncInterval: ReturnType<typeof setInterval> | null = null;

  // Graceful shutdown handlers
  let shutdownInProgress = false;
  const shutdown = async (signal: string) => {
    if (shutdownInProgress) {
      logger.warn('Force exit (second signal)');
      process.exit(1);
    }
    shutdownInProgress = true;
    shuttingDown = true;
    logger.info({ signal }, 'Shutdown signal received, cleaning up...');

    if (feishuSyncInterval) {
      clearInterval(feishuSyncInterval);
      feishuSyncInterval = null;
    }

    try { shutdownTerminals(); } catch (err) {
      logger.warn({ err }, 'Error shutting down terminals');
    }
    try { await imManager.disconnectAll(); } catch (err) {
      logger.warn({ err }, 'Error disconnecting IM connections');
    }
    try { await shutdownWebServer(); } catch (err) {
      logger.warn({ err }, 'Error shutting down web server');
    }
    try { await queue.shutdown(10000); } catch (err) {
      logger.warn({ err }, 'Error shutting down queue');
    }
    try { closeDatabase(); } catch (err) {
      logger.warn({ err }, 'Error closing database');
    }

    logger.info('Shutdown complete');
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Reload Feishu connection for a specific user (hot-reload on config save)
  const reloadFeishuConnection = async (config: { appId: string; appSecret: string; enabled?: boolean }): Promise<boolean> => {
    // Find admin user's home folder (legacy global config routes to admin)
    const adminUsers = listUsers({ status: 'active', role: 'admin', page: 1, pageSize: 1 }).users;
    const adminUser = adminUsers[0];
    if (!adminUser) {
      logger.warn('No admin user found for Feishu reload');
      return false;
    }

    // Disconnect existing admin Feishu connection
    await imManager.disconnectUserFeishu(adminUser.id);
    if (feishuSyncInterval) { clearInterval(feishuSyncInterval); feishuSyncInterval = null; }

    if (config.enabled !== false && config.appId && config.appSecret) {
      const homeGroup = getUserHomeGroup(adminUser.id);
      const homeFolder = homeGroup?.folder || MAIN_GROUP_FOLDER;
      const onNewChat = buildOnNewChat(adminUser.id, homeFolder);
      const connected = await imManager.connectUserFeishu(adminUser.id, config, onNewChat, Date.now(), handleCommand);
      if (connected) {
        syncGroupMetadata().catch((err) =>
          logger.error({ err }, 'Group sync after Feishu reconnect failed'),
        );
        feishuSyncInterval = setInterval(() => {
          syncGroupMetadata().catch((err) =>
            logger.error({ err }, 'Periodic group sync failed'),
          );
        }, GROUP_SYNC_INTERVAL_MS);
      }
      return connected;
    }
    logger.info('Feishu channel disabled via hot-reload');
    return false;
  };

  const reloadTelegramConnection = async (config: { botToken: string; enabled?: boolean }): Promise<boolean> => {
    // Find admin user
    const adminUsers = listUsers({ status: 'active', role: 'admin', page: 1, pageSize: 1 }).users;
    const adminUser = adminUsers[0];
    if (!adminUser) {
      logger.warn('No admin user found for Telegram reload');
      return false;
    }

    await imManager.disconnectUserTelegram(adminUser.id);

    if (config.enabled !== false && config.botToken) {
      const homeGroup = getUserHomeGroup(adminUser.id);
      const homeFolder = homeGroup?.folder || MAIN_GROUP_FOLDER;
      const onNewChat = buildOnNewChat(adminUser.id, homeFolder);
      const connected = await imManager.connectUserTelegram(adminUser.id, config, onNewChat, buildIsChatAuthorized(adminUser.id), buildOnPairAttempt(adminUser.id), handleCommand);
      return connected;
    }
    logger.info('Telegram channel disabled via hot-reload');
    return false;
  };

  // Reload a per-user IM channel (hot-reload on user-im config save)
  const reloadUserIMConfig = async (userId: string, channel: 'feishu' | 'telegram'): Promise<boolean> => {
    const homeGroup = getUserHomeGroup(userId);
    if (!homeGroup) {
      logger.warn({ userId, channel }, 'No home group found for user IM reload');
      return false;
    }
    const homeFolder = homeGroup.folder;
    const onNewChat = buildOnNewChat(userId, homeFolder);
    const ignoreMessagesBefore = Date.now();

    if (channel === 'feishu') {
      await imManager.disconnectUserFeishu(userId);
      const config = getUserFeishuConfig(userId);
      if (config && config.enabled !== false && config.appId && config.appSecret) {
        const connected = await imManager.connectUserFeishu(userId, config, onNewChat, ignoreMessagesBefore, handleCommand);
        logger.info({ userId, connected }, 'User Feishu connection hot-reloaded');
        return connected;
      }
      logger.info({ userId }, 'User Feishu channel disabled via hot-reload');
      return false;
    } else {
      await imManager.disconnectUserTelegram(userId);
      const config = getUserTelegramConfig(userId);
      if (config && config.enabled !== false && config.botToken) {
        const connected = await imManager.connectUserTelegram(userId, config, onNewChat, buildIsChatAuthorized(userId), buildOnPairAttempt(userId), handleCommand);
        logger.info({ userId, connected }, 'User Telegram connection hot-reloaded');
        return connected;
      }
      logger.info({ userId }, 'User Telegram channel disabled via hot-reload');
      return false;
    }
  };

  // Start Web server early so frontend auth/API isn't blocked by Feishu readiness.
  startWebServer({
    queue,
    getRegisteredGroups: () => registeredGroups,
    getSessions: () => sessions,
    processGroupMessages,
    ensureTerminalContainerStarted,
    formatMessages,
    getLastAgentTimestamp: () => lastAgentTimestamp,
    setLastAgentTimestamp: (jid: string, cursor: MessageCursor) => {
      lastAgentTimestamp[jid] = cursor;
      saveState();
    },
    advanceGlobalCursor: (cursor: MessageCursor) => {
      if (isCursorAfter(cursor, globalMessageCursor)) {
        globalMessageCursor = cursor;
        saveState();
      }
    },
    reloadFeishuConnection,
    reloadTelegramConnection,
    reloadUserIMConfig,
    isFeishuConnected: () => imManager.isAnyFeishuConnected(),
    isTelegramConnected: () => imManager.isAnyTelegramConnected(),
    isUserFeishuConnected: (userId: string) => imManager.isFeishuConnected(userId),
    isUserTelegramConnected: (userId: string) => imManager.isTelegramConnected(userId),
    processAgentConversation,
  });

  // Clean expired sessions every hour
  setInterval(
    () => {
      try {
        const deleted = deleteExpiredSessions();
        if (deleted > 0) {
          logger.info({ deleted }, 'Cleaned expired user sessions');
        }
      } catch (err) {
        logger.error({ err }, 'Failed to clean expired sessions');
      }
    },
    60 * 60 * 1000,
  );

  // OAuth token auto-refresh (every 5 minutes)
  setInterval(async () => {
    try {
      const config = getClaudeProviderConfigForRefresh();
      const creds = config.claudeOAuthCredentials;
      if (!creds) return;

      const timeToExpiry = creds.expiresAt - Date.now();
      if (timeToExpiry > 30 * 60 * 1000) return; // >30min to expiry, skip

      logger.info(
        { expiresIn: Math.round(timeToExpiry / 1000) },
        'OAuth token expiring soon, refreshing...',
      );
      const refreshed = await refreshOAuthCredentials(creds);
      if (refreshed) {
        const current = getClaudeProviderConfigForRefresh();
        const saved = saveClaudeProviderConfigForRefresh({
          ...current,
          claudeOAuthCredentials: refreshed,
        });
        updateAllSessionCredentials(saved);
        const closed = queue.closeAllActiveForCredentialRefresh();
        logger.info({ closedContainers: closed }, 'OAuth token refreshed successfully');
      } else {
        logger.warn('OAuth token refresh failed');
      }
    } catch (err) {
      logger.error({ err }, 'OAuth auto-refresh error');
    }
  }, 5 * 60 * 1000);

  await ensureDockerRunning();

  queue.setProcessMessagesFn(processGroupMessages);
  queue.setHostModeChecker((groupJid: string) => {
    let group = registeredGroups[groupJid];
    if (!group) {
      const dbGroup = getRegisteredGroup(groupJid);
      if (dbGroup) {
        registeredGroups[groupJid] = dbGroup;
        group = dbGroup;
      }
    }
    if (!group) return false;

    if (group.is_home) return group.executionMode === 'host';

    const siblingJids = getJidsByFolder(group.folder);
    for (const jid of siblingJids) {
      const sibling = registeredGroups[jid] ?? getRegisteredGroup(jid);
      if (sibling && !registeredGroups[jid]) {
        registeredGroups[jid] = sibling;
      }
      if (sibling?.is_home) return sibling.executionMode === 'host';
    }

    return group.executionMode === 'host';
  });
  queue.setSerializationKeyResolver((groupJid: string) => {
    // Agent virtual JIDs: {chatJid}#agent:{agentId} → separate serialization key
    const agentSep = groupJid.indexOf('#agent:');
    if (agentSep >= 0) {
      const baseJid = groupJid.slice(0, agentSep);
      const agentId = groupJid.slice(agentSep + 7);
      const group = registeredGroups[baseJid];
      const folder = group?.folder || baseJid;
      return `${folder}#${agentId}`;
    }
    const group = registeredGroups[groupJid];
    return group?.folder || groupJid;
  });
  queue.setOnMaxRetriesExceeded((groupJid: string) => {
    const group = registeredGroups[groupJid];
    const name = group?.name || groupJid;
    sendSystemMessage(groupJid, 'agent_max_retries', `${name} 处理失败，已达最大重试次数`);
    setTyping(groupJid, false);
  });
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder, displayName) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder, displayName),
    sendMessage,
    assistantName: ASSISTANT_NAME,
    dailySummaryDeps: {
      logger,
      dataDir: DATA_DIR,
    },
  });
  startIpcWatcher();
  recoverPendingMessages();
  startMessageLoop();

  // --- IM Connection Pool: connect per-user IM channels ---
  // Load global IM config (backward compat: used for admin if no per-user config exists)
  const globalFeishuConfig = getFeishuProviderConfigWithSource();
  const globalTelegramConfig = getTelegramProviderConfigWithSource();

  // Paginate through all active users (listUsers caps at 200 per page)
  let allActiveUsers: typeof listUsers extends (...args: any) => { users: infer U } ? U : never = [];
  {
    let page = 1;
    while (true) {
      const result = listUsers({ status: 'active', page, pageSize: 200 });
      allActiveUsers = allActiveUsers.concat(result.users);
      if (allActiveUsers.length >= result.total) break;
      page++;
    }
  }

  // Register admin users for fallback IM routing
  for (const user of allActiveUsers) {
    if (user.role === 'admin') imManager.registerAdminUser(user.id);
  }

  let anyFeishuConnected = false;

  for (const user of allActiveUsers) {
    const homeGroup = getUserHomeGroup(user.id);
    if (!homeGroup) continue;

    // Per-user IM config takes precedence; fall back to global config for admin
    const userFeishu = getUserFeishuConfig(user.id);
    const userTelegram = getUserTelegramConfig(user.id);

    // Determine effective Feishu config: per-user > global (admin only)
    let effectiveFeishu: FeishuConnectConfig | null = null;
    if (userFeishu && userFeishu.appId && userFeishu.appSecret) {
      effectiveFeishu = { appId: userFeishu.appId, appSecret: userFeishu.appSecret, enabled: userFeishu.enabled };
    } else if (user.role === 'admin' && globalFeishuConfig.source !== 'none') {
      const gc = globalFeishuConfig.config;
      effectiveFeishu = { appId: gc.appId, appSecret: gc.appSecret, enabled: gc.enabled };
    }

    // Determine effective Telegram config: per-user > global (admin only)
    let effectiveTelegram: TelegramConnectConfig | null = null;
    if (userTelegram && userTelegram.botToken) {
      effectiveTelegram = { botToken: userTelegram.botToken, enabled: userTelegram.enabled };
    } else if (user.role === 'admin' && globalTelegramConfig.source !== 'none') {
      const gc = globalTelegramConfig.config;
      effectiveTelegram = { botToken: gc.botToken, enabled: gc.enabled };
    }

    if (!effectiveFeishu && !effectiveTelegram) continue;

    try {
      const result = await connectUserIMChannels(
        user.id,
        homeGroup.folder,
        effectiveFeishu,
        effectiveTelegram,
      );
      if (result.feishu) anyFeishuConnected = true;
      logger.info(
        { userId: user.id, feishu: result.feishu, telegram: result.telegram },
        'User IM channels connected',
      );
    } catch (err) {
      logger.error({ userId: user.id, err }, 'Failed to connect user IM channels');
    }
  }

  // Start Feishu group sync if any connection is active
  if (anyFeishuConnected) {
    syncGroupMetadata().catch((err) =>
      logger.error({ err }, 'Initial group sync failed'),
    );
    feishuSyncInterval = setInterval(() => {
      syncGroupMetadata().catch((err) =>
        logger.error({ err }, 'Periodic group sync failed'),
      );
    }, GROUP_SYNC_INTERVAL_MS);
  } else if (globalFeishuConfig.config.enabled !== false && globalFeishuConfig.source !== 'none') {
    logger.warn(
      'Feishu is not connected. Configure credentials in Settings to enable Feishu sync.',
    );
  }
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start happyclaw');
  process.exit(1);
});
