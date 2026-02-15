// --- Optional .env loader (no external dependency) ---
// Must run before any import that reads process.env at module level.
import fs from 'fs';
import path from 'path';

const dotenvPath = path.resolve(process.cwd(), '.env');
if (fs.existsSync(dotenvPath)) {
  const lines = fs.readFileSync(dotenvPath, 'utf-8').split('\n');
  for (const line of lines) {
    let trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    // Strip optional 'export ' prefix (common in .env files)
    if (trimmed.startsWith('export ')) trimmed = trimmed.slice(7);
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx <= 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // Do not overwrite existing env vars (explicit env takes priority)
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}
// --- End .env loader ---

import { ChildProcess, execFile } from 'child_process';
import crypto from 'crypto';
import { promisify } from 'util';

import { CronExpressionParser } from 'cron-parser';

import {
  ASSISTANT_NAME,
  DATA_DIR,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  IPC_POLL_INTERVAL,
  MAIN_GROUP_FOLDER,
  POLL_INTERVAL,
  TIMEZONE,
  validateConfig,
} from './config.js';
import {
  AvailableGroup,
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
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getAllTasks,
  getLastGroupSync,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  getTaskById,
  initDatabase,
  setLastGroupSync,
  setRegisteredGroup,
  setRouterState,
  setSession,
  deleteSession,
  storeMessageDirect,
  updateChatName,
  updateTask,
} from './db.js';
import {
  connectFeishu,
  isFeishuConnected,
  sendFeishuMessage,
  setFeishuTyping,
  stopFeishu,
  syncFeishuGroups,
} from './feishu.js';
import {
  getFeishuProviderConfigWithSource,
  getTelegramProviderConfigWithSource,
} from './runtime-config.js';
import {
  connectTelegram,
  sendTelegramMessage,
  disconnectTelegram,
  isTelegramConnected,
} from './telegram.js';
import { GroupQueue } from './group-queue.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { MessageCursor, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import {
  startWebServer,
  broadcastToWebClients,
  broadcastNewMessage,
  broadcastTyping,
  broadcastStreamEvent,
  shutdownTerminals,
  shutdownWebServer,
} from './web.js';

const GROUP_SYNC_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const execFileAsync = promisify(execFile);
const DEFAULT_MAIN_JID = 'web:main';
const DEFAULT_MAIN_NAME = 'Main';

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

async function setTyping(jid: string, isTyping: boolean): Promise<void> {
  const chatId = jid.replace(/^feishu:/, '');
  await setFeishuTyping(chatId, isTyping);
  broadcastTyping(jid, isTyping);
}

interface SendMessageOptions {
  sendToFeishu?: boolean;
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

  // Always ensure the web:main entry exists, even when default-groups.json is empty.
  // 必须精确检查 web:main JID 是否存在（而非仅检查 folder='main'），
  // 因为自动注册到主容器的飞书群组也有 folder='main'，会导致误判。
  if (!registeredGroups[DEFAULT_MAIN_JID]) {
    registerGroup(DEFAULT_MAIN_JID, {
      name: DEFAULT_MAIN_NAME,
      folder: MAIN_GROUP_FOLDER,
      added_at: new Date().toISOString(),
    });
  }

  // Initialize global CLAUDE.md from template if missing (cold start / reset)
  const globalDir = path.join(GROUPS_DIR, 'global');
  const globalClaudeMdPath = path.join(globalDir, 'CLAUDE.md');
  if (!fs.existsSync(globalClaudeMdPath)) {
    const templatePath = path.resolve(
      process.cwd(),
      'config',
      'global-claude-md.template.md',
    );
    if (fs.existsSync(templatePath)) {
      try {
        fs.mkdirSync(globalDir, { recursive: true });
        fs.writeFileSync(globalClaudeMdPath, fs.readFileSync(templatePath, 'utf-8'), {
          flag: 'wx',
        });
        logger.info('Initialized global CLAUDE.md from template');
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
          logger.warn({ err }, 'Failed to initialize global CLAUDE.md');
        }
      }
    }
  }

  // Main 会话默认使用宿主机模式（不设置 customCwd，使用默认 groups/main 目录，
  // 避免触发 allowlist 校验导致受限部署失败）
  // 注意：ensureColumn 给 execution_mode 设了 DEFAULT 'container'，
  // 所以必须用 !== 'host' 而非 !executionMode 来检测未迁移的记录
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (group.folder === MAIN_GROUP_FOLDER && group.executionMode !== 'host') {
      group.executionMode = 'host';
      setRegisteredGroup(jid, group);
      registeredGroups[jid] = group;
      // 清除容器时代的 session，避免宿主机模式尝试恢复不兼容的 session
      if (sessions[group.folder]) {
        logger.info(
          { folder: group.folder },
          'Clearing stale container-era session during host mode migration',
        );
        delete sessions[group.folder];
        deleteSession(group.folder);
      }
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

  await syncFeishuGroups();
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

function formatMessages(messages: NewMessage[]): string {
  const lines = messages.map(
    (m) =>
      `<message sender="${escapeXml(m.sender_name)}" time="${m.timestamp}">${escapeXml(m.content)}</message>`,
  );
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
 * The container stays alive for IDLE_TIMEOUT after each result, allowing
 * rapid-fire messages to be piped in without spawning a new container.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

  // Get all messages since last agent interaction
  const sinceCursor = lastAgentTimestamp[chatJid] || EMPTY_CURSOR;
  const missedMessages = getMessagesSince(chatJid, sinceCursor);

  if (missedMessages.length === 0) return true;

  const hasWebInput = missedMessages.some((m) => m.sender === 'web-user');
  const hasFeishuInput = missedMessages.some((m) => m.sender !== 'web-user');
  const shouldReplyToFeishu =
    chatJid.startsWith('feishu:') && (!isMainGroup || hasFeishuInput);

  const prompt = formatMessages(missedMessages);

  const images = collectMessageImages(chatJid, missedMessages);
  const imagesForAgent = images.length > 0 ? images : undefined;

  logger.info(
    {
      group: group.name,
      messageCount: missedMessages.length,
      hasWebInput,
      hasFeishuInput,
      shouldReplyToFeishu,
      imageCount: images.length,
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
    }, IDLE_TIMEOUT);
  };

  await setTyping(chatJid, true);
  let hadError = false;
  let sentReply = false;
  let lastError = '';
  let cursorCommitted = false;
  const lastProcessed = missedMessages[missedMessages.length - 1];

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
    group,
    prompt,
    chatJid,
    async (result) => {
      try {
        // 流式事件处理 - 仅广播 WebSocket，不存 DB，不发飞书，不重置 idle timer
        if (result.status === 'stream' && result.streamEvent) {
          broadcastStreamEvent(chatJid, result.streamEvent);
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
            await sendMessage(chatJid, text, {
              sendToFeishu: shouldReplyToFeishu,
            });
            sentReply = true;
            // Persist cursor as soon as a visible reply is emitted.
            // Long-lived runners may stay alive for IDLE_TIMEOUT, and waiting
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

  if ((output.status === 'error' || hadError) && !sentReply) {
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
    }, IDLE_TIMEOUT);
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
): Promise<{ status: 'success' | 'error'; error?: string }> {
  const isMain = group.folder === MAIN_GROUP_FOLDER;
  const sessionId = sessions[group.folder];

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
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

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
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
          isMain,
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
          isMain,
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
  const sendToFeishu = options.sendToFeishu ?? jid.startsWith('feishu:');
  try {
    if (sendToFeishu && jid.startsWith('feishu:')) {
      const chatId = jid.replace(/^feishu:/, '');
      try {
        await sendFeishuMessage(chatId, text);
      } catch (err) {
        logger.error({ jid, err }, 'Failed to send message to Feishu');
      }
    }

    if (jid.startsWith('telegram:')) {
      const chatId = jid.replace(/^telegram:/, '');
      try {
        await sendTelegramMessage(chatId, text);
      } catch (err) {
        logger.error({ jid, err }, 'Failed to send message to Telegram');
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
    logger.info({ jid, length: text.length, sendToFeishu }, 'Message sent');
    broadcastToWebClients(jid, text);
  } catch (err) {
    logger.error({ jid, err }, 'Failed to send message');
  }
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
      const isMain = sourceGroup === MAIN_GROUP_FOLDER;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

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
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
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
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain);
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
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    containerConfig?: RegisteredGroup['containerConfig'];
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
): Promise<void> {
  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
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

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
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
          prompt: data.prompt,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
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
        if (task && (isMain || task.group_folder === sourceGroup)) {
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
        if (task && (isMain || task.group_folder === sourceGroup)) {
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
      // Only main group can request a refresh
      if (isMain) {
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
      // Only main group can register new groups
      if (!isMain) {
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

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
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

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const isMainGroup = group.folder === MAIN_GROUP_FOLDER;

          // Pull all messages since lastAgentTimestamp to preserve full context.
          const allPending = getMessagesSince(
            chatJid,
            lastAgentTimestamp[chatJid] || EMPTY_CURSOR,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;

          // Main chat should always run as a fresh batch.
          // This avoids mixing "web-only reply mode" and "reply-to-Feishu mode"
          // inside the same long-lived container stream.
          if (isMainGroup) {
            // Force current main container (if any) to wind down quickly so
            // newly arrived Feishu/Web messages are not blocked by 30min idle hold.
            queue.closeStdin(chatJid);
            logger.debug(
              { chatJid },
              'Main group message received, forcing stdin close before enqueue',
            );
            queue.enqueueMessageCheck(chatJid);
            continue;
          }

          const formatted = formatMessages(messagesToSend);

          const images = collectMessageImages(chatJid, messagesToSend);
          const imagesForAgent = images.length > 0 ? images : undefined;

          if (queue.sendMessage(chatJid, formatted, imagesForAgent)) {
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
          } else {
            // No active container — enqueue for a new one
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

async function main(): Promise<void> {
  validateConfig();
  initDatabase();
  logger.info('Database initialized');
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
    try { await stopFeishu(); } catch (err) {
      logger.warn({ err }, 'Error stopping Feishu');
    }
    try { await disconnectTelegram(); } catch (err) {
      logger.warn({ err }, 'Error disconnecting Telegram');
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

  const doConnectFeishu = async (ignoreMessagesBefore?: number): Promise<boolean> => {
    return connectFeishu({
      onReady: () => {
        logger.info('Feishu WebSocket connected');
      },
      onNewChat: (chatJid, chatName) => {
        if (registeredGroups[chatJid]) return;
        registerGroup(chatJid, {
          name: chatName,
          folder: MAIN_GROUP_FOLDER,
          added_at: new Date().toISOString(),
          executionMode: 'host',
        });
        logger.info({ chatJid, chatName }, 'Auto-registered Feishu chat to main session');
      },
      ignoreMessagesBefore,
    });
  };

  const reloadFeishuConnection = async (config: { appId: string; appSecret: string; enabled?: boolean }): Promise<boolean> => {
    // 1. Stop existing connection
    await stopFeishu();
    if (feishuSyncInterval) { clearInterval(feishuSyncInterval); feishuSyncInterval = null; }

    // 2. Reconnect if enabled and credentials present
    //    Pass current timestamp so messages queued during disconnection are ignored
    if (config.enabled !== false && config.appId && config.appSecret) {
      const connected = await doConnectFeishu(Date.now());
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
    await disconnectTelegram();
    if (config.enabled !== false && config.botToken) {
      await connectTelegram({
        onReady: () => {
          logger.info('Telegram bot connected');
        },
        onNewChat: (chatJid, chatName) => {
          if (registeredGroups[chatJid]) return;
          registerGroup(chatJid, {
            name: chatName,
            folder: MAIN_GROUP_FOLDER,
            added_at: new Date().toISOString(),
            executionMode: 'host',
          });
          logger.info({ chatJid, chatName }, 'Auto-registered Telegram chat to main session');
        },
      });
      return isTelegramConnected();
    }
    logger.info('Telegram channel disabled via hot-reload');
    return false;
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
    isFeishuConnected: () => isFeishuConnected(),
    isTelegramConnected: () => isTelegramConnected(),
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

  await ensureDockerRunning();

  queue.setProcessMessagesFn(processGroupMessages);
  queue.setHostModeChecker((groupJid: string) => {
    const group = registeredGroups[groupJid];
    return group?.executionMode === 'host';
  });
  queue.setSerializationKeyResolver((groupJid: string) => {
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
  });
  startIpcWatcher();
  recoverPendingMessages();
  startMessageLoop();

  // Feishu integration — check enabled flag before connecting
  const feishuConfigResult = getFeishuProviderConfigWithSource();
  const feishuEnabled = feishuConfigResult.config.enabled !== false;

  let feishuConnected = false;
  if (!feishuEnabled) {
    logger.info('Feishu channel disabled by user');
  } else {
    feishuConnected = await doConnectFeishu();
  }

  if (feishuConnected) {
    syncGroupMetadata().catch((err) =>
      logger.error({ err }, 'Initial group sync failed'),
    );
    feishuSyncInterval = setInterval(() => {
      syncGroupMetadata().catch((err) =>
        logger.error({ err }, 'Periodic group sync failed'),
      );
    }, GROUP_SYNC_INTERVAL_MS);
  } else if (feishuEnabled) {
    logger.warn(
      'Feishu is not connected. Configure credentials in Settings to enable Feishu sync.',
    );
  }

  // Telegram integration — check enabled flag before connecting
  const telegramConfig = getTelegramProviderConfigWithSource();
  const telegramEnabled = telegramConfig.config.enabled !== false;

  if (!telegramEnabled) {
    logger.info('Telegram channel disabled by user');
  } else {
    await reloadTelegramConnection(telegramConfig.config);
  }
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start happyclaw');
  process.exit(1);
});
