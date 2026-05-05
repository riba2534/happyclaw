import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'crypto';
import { TerminalManager } from './terminal-manager.js';

// Web context and shared utilities
import {
  type WebDeps,
  type Variables,
  type WsClientInfo,
  setWebDeps,
  getWebDeps,
  wsClients,
  lastActiveCache,
  LAST_ACTIVE_DEBOUNCE_MS,
  parseCookie,
  isHostExecutionGroup,
  hasHostExecutionPermission,
  canAccessGroup,
  getCachedSessionWithUser,
  invalidateSessionCache,
} from './web-context.js';

// Schemas
import {
  MessageCreateSchema,
  TerminalStartSchema,
  TerminalInputSchema,
  TerminalResizeSchema,
  TerminalStopSchema,
} from './schemas.js';

// Middleware
import {
  authMiddleware,
  getAllCookieValues,
  tryVerifyAny,
} from './middleware/auth.js';

// Route modules
import authRoutes from './routes/auth.js';
import groupRoutes from './routes/groups.js';
import memoryRoutes from './routes/memory.js';
import configRoutes, { injectConfigDeps } from './routes/config.js';
import tasksRoutes from './routes/tasks.js';
import adminRoutes from './routes/admin.js';
import fileRoutes from './routes/files.js';
import monitorRoutes, { injectMonitorDeps } from './routes/monitor.js';
import skillsRoutes from './routes/skills.js';
import browseRoutes from './routes/browse.js';
import agentRoutes from './routes/agents.js';
import mcpServersRoutes from './routes/mcp-servers.js';
import pluginsRoutes from './routes/plugins.js';
import workspaceConfigRoutes from './routes/workspace-config.js';
import agentDefinitionsRoutes from './routes/agent-definitions.js';
import { usage as usageRoutes } from './routes/usage.js';
import billingRoutes from './routes/billing.js';
import bugReportRoutes from './routes/bug-report.js';
import {
  checkBillingAccess,
  formatBillingAccessDeniedMessage,
} from './billing.js';

// Database and types (only for handleWebUserMessage and broadcast)
import {
  ensureChatExists,
  getRegisteredGroup,
  getJidsByFolder,
  storeMessageDirect,
  deleteUserSession,
  updateSessionLastActive,
  getGroupMembers,
  getAgent,
  isGroupShared,
  getUserById,
  updateAgentContextInfo,
  updateChatName,
} from './db.js';
import { markdownToPlainText } from './im-utils.js';
import { isSessionExpired } from './auth.js';
import type {
  AgentStatus,
  NewMessage,
  WsMessageOut,
  WsMessageIn,
  AuthUser,
  StreamEvent,
  UserRole,
} from './types.js';
import {
  WEB_PORT,
  SESSION_COOKIE_NAME_SECURE,
  SESSION_COOKIE_NAME_PLAIN,
  ASSISTANT_NAME,
  GROUPS_DIR,
} from './config.js';
import { expandPluginSlashCommandIfNeeded } from './plugin-expander-core.js';
import { makeExpandContext } from './plugin-expander-context.js';
import type { ExpandContext } from './plugin-expander-context.js';
import { PLUGIN_EXPANSION_ATTACHMENT_TYPE } from './plugin-expander-sentinel.js';
import { resolvePerMessageRuntimeOwner } from './runtime-owner.js';
import { persistPluginExpansion } from './plugin-expander-store.js';
import { logger } from './logger.js';
import {
  executeSessionReset,
  isClearCommand,
  SESSION_RESET_FAILURE_MESSAGE,
} from './commands.js';
import {
  normalizeImageAttachments,
  toAgentImages,
} from './message-attachments.js';

// --- App Setup ---

const app = new Hono<{ Variables: Variables }>();
const terminalManager = new TerminalManager();
const wsTerminals = new Map<WebSocket, string>(); // ws → groupJid
const terminalOwners = new Map<string, WebSocket>(); // groupJid → ws

function normalizeTerminalSize(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const intValue = Math.floor(value);
  if (intValue < min) return min;
  if (intValue > max) return max;
  return intValue;
}

/**
 * Build an ExpandContext for plugin-command expansion against a registered
 * group. Returns null when the group has no resolvable owner (no plugins to
 * resolve in that case).
 *
 * Plugins are per-user config. On the admin-shared `web:main + isHome`
 * workspace each admin owns a separate runtime, so the message sender wins
 * over `group.created_by` — but only when the sender is an active admin
 * (#24 round-16 P2-1). Non-admin / disabled / unknown senders fall back to
 * `created_by`, mirroring `resolvePerMessageRuntimeOwner` used by the
 * cold-start path; pre-fix the web fast-path blindly returned senderUserId
 * on `web:main + isHome`, so `/foo` from a member resolved to the member's
 * (empty) plugin runtime when the runner was active and to admin's runtime
 * when idle — same command, two different behaviors.
 *
 * Host mode honors `group.customCwd` so inline `!` commands run against the
 * user's real repo (#18 P2-bug-4).
 */
function buildWebExpandContext(
  groupJid: string,
  group: {
    folder: string;
    created_by?: string | null;
    executionMode?: string | null;
    customCwd?: string | null;
    is_home?: boolean;
  },
  senderUserId?: string | null,
): ExpandContext | null {
  const deps = getWebDeps();
  // Default getUserById: when the WebDeps wiring did not inject one (older
  // tests / partial fixtures), `resolvePerMessageRuntimeOwner` falls back to
  // `created_by` for any non-empty sender — admin gating is opt-in. The
  // production wiring in src/index.ts ALWAYS injects the lookup.
  const getUserById = deps?.getUserById ?? (() => null);
  const ownerId = resolvePerMessageRuntimeOwner({
    chatJid: groupJid,
    isHome: !!group.is_home,
    fallbackOwner: group.created_by,
    message: { sender: senderUserId ?? '' },
    getUserById,
  });
  const containerName = deps?.queue.getActiveContainerName(groupJid) ?? null;
  return makeExpandContext({
    chatJid: groupJid,
    groupFolder: group.folder,
    ownerId,
    executionMode: group.executionMode,
    customCwd: group.customCwd,
    groupsDir: GROUPS_DIR,
    containerName,
  });
}

function releaseTerminalOwnership(ws: WebSocket, groupJid: string): void {
  if (wsTerminals.get(ws) === groupJid) {
    wsTerminals.delete(ws);
  }
  if (terminalOwners.get(groupJid) === ws) {
    terminalOwners.delete(groupJid);
  }
}

// --- CORS Middleware ---
const CORS_ALLOWED_ORIGINS = process.env.CORS_ALLOWED_ORIGINS || '';
const CORS_ALLOW_LOCALHOST = process.env.CORS_ALLOW_LOCALHOST !== 'false'; // default: true

function isAllowedOrigin(origin: string | undefined): string | null {
  if (!origin) return null; // same-origin requests
  // 环境变量设为 '*' 时允许所有来源
  if (CORS_ALLOWED_ORIGINS === '*') return origin;
  // 允许 localhost / 127.0.0.1 的任意端口（开发 & 自托管场景，可通过 CORS_ALLOW_LOCALHOST=false 关闭）
  if (CORS_ALLOW_LOCALHOST) {
    try {
      const url = new URL(origin);
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
        return origin;
    } catch {
      /* invalid origin */
    }
  }
  // 自定义白名单（逗号分隔）
  if (CORS_ALLOWED_ORIGINS) {
    const allowed = CORS_ALLOWED_ORIGINS.split(',').map((s) => s.trim());
    if (allowed.includes(origin)) return origin;
  }
  return null;
}

app.use(
  '/api/*',
  cors({
    origin: (origin) => isAllowedOrigin(origin),
    credentials: true,
  }),
);

// --- Global State ---

let deps: WebDeps | null = null;

// --- Route Mounting ---

app.route('/api/auth', authRoutes);
app.route('/api/groups', groupRoutes);
app.route('/api/groups', fileRoutes); // File routes also under /api/groups
app.route('/api/memory', memoryRoutes);
app.route('/api/config', configRoutes);
app.route('/api/tasks', tasksRoutes);
app.route('/api/skills', skillsRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api/browse', browseRoutes);
app.route('/api/mcp-servers', mcpServersRoutes);
app.route('/api/plugins', pluginsRoutes);
app.route('/api/agent-definitions', agentDefinitionsRoutes);
app.route('/api/groups', agentRoutes); // Agent routes under /api/groups/:jid/agents
app.route('/api/groups', workspaceConfigRoutes); // Workspace config under /api/groups/:jid/workspace-config
app.route('/api', monitorRoutes);
app.route('/api/usage', usageRoutes);
app.route('/api/billing', billingRoutes);
app.route('/api/bug-report', bugReportRoutes);

// --- POST /api/messages ---

app.post('/api/messages', authMiddleware, async (c) => {
  const body = await c.req.json().catch(() => ({}));

  const validation = MessageCreateSchema.safeParse(body);
  if (!validation.success) {
    return c.json(
      { error: 'Invalid request body', details: validation.error.format() },
      400,
    );
  }

  const { chatJid, content, attachments } = validation.data;
  const group = getRegisteredGroup(chatJid);
  if (!group) return c.json({ error: 'Group not found' }, 404);
  const authUser = c.get('user') as AuthUser;
  if (!canAccessGroup(authUser, group)) {
    return c.json({ error: 'Access denied' }, 403);
  }
  if (isHostExecutionGroup(group) && !hasHostExecutionPermission(authUser)) {
    return c.json(
      { error: 'Insufficient permissions for host execution mode' },
      403,
    );
  }

  // /clear: reset session without entering message pipeline.
  // Permission: relies on the route-level canAccessGroup + host-mode checks above.
  // Whether to tighten /clear to owner-only is left to the follow-up ACL audit
  // (see PR description) — keeping it aligned with send-message for now.
  if (isClearCommand(content)) {
    if (!deps) return c.json({ error: 'Server not initialized' }, 500);
    try {
      await executeSessionReset(chatJid, group.folder, {
        queue: deps.queue,
        sessions: deps.getSessions(),
        broadcast: broadcastNewMessage,
        setLastAgentTimestamp: deps.setLastAgentTimestamp,
      });
      return c.json({ success: true, cleared: true });
    } catch (err) {
      logger.error({ chatJid, err }, '/clear command failed');
      const errId = crypto.randomUUID();
      const errTs = new Date().toISOString();
      ensureChatExists(chatJid);
      storeMessageDirect(
        errId,
        chatJid,
        '__system__',
        'system',
        SESSION_RESET_FAILURE_MESSAGE,
        errTs,
        true,
      );
      broadcastNewMessage(chatJid, {
        id: errId,
        chat_jid: chatJid,
        sender: '__system__',
        sender_name: 'system',
        content: SESSION_RESET_FAILURE_MESSAGE,
        timestamp: errTs,
        is_from_me: true,
      });
      return c.json({ error: '清除上下文失败' }, 500);
    }
  }

  const result = await handleWebUserMessage(
    chatJid,
    content.trim(),
    attachments,
    authUser.id,
    authUser.display_name || authUser.username,
  );
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({
    success: true,
    messageId: result.messageId,
    timestamp: result.timestamp,
  });
});

// --- handleWebUserMessage ---

async function handleWebUserMessage(
  chatJid: string,
  content: string,
  attachments?: Array<{ type: 'image'; data: string; mimeType?: string }>,
  userId = 'web-user',
  displayName = 'Web',
): Promise<
  | {
      ok: true;
      messageId: string;
      timestamp: string;
    }
  | {
      ok: false;
      status: 404 | 500;
      error: string;
    }
> {
  if (!deps) return { ok: false, status: 500, error: 'Server not initialized' };

  let group = deps.getRegisteredGroups()[chatJid];
  if (!group) {
    // Group may exist in DB but not in memory cache (created via setup/registration after loadState)
    const dbGroup = getRegisteredGroup(chatJid);
    if (!dbGroup) return { ok: false, status: 404, error: 'Group not found' };
    group = dbGroup;
  }

  ensureChatExists(chatJid);

  const messageId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const normalizedAttachments = normalizeImageAttachments(attachments, {
    onMimeMismatch: ({ declaredMime, detectedMime }) => {
      logger.warn(
        { chatJid, messageId, declaredMime, detectedMime },
        'Web attachment MIME mismatch detected, using detected MIME',
      );
    },
  });
  const attachmentsStr =
    normalizedAttachments.length > 0
      ? JSON.stringify(normalizedAttachments)
      : undefined;
  storeMessageDirect(
    messageId,
    chatJid,
    userId,
    displayName,
    content,
    timestamp,
    false,
    { attachments: attachmentsStr },
  );

  broadcastNewMessage(chatJid, {
    id: messageId,
    chat_jid: chatJid,
    sender: userId,
    sender_name: displayName,
    content,
    timestamp,
    is_from_me: false,
    attachments: attachmentsStr,
  });

  if (group.created_by) {
    const owner = getUserById(group.created_by);
    if (owner && owner.role !== 'admin') {
      const accessResult = checkBillingAccess(group.created_by, owner.role);
      if (!accessResult.allowed) {
        const sysMsg = formatBillingAccessDeniedMessage(accessResult);
        const sysMsgId = `sys_quota_${Date.now()}`;
        const sysTimestamp = new Date().toISOString();
        storeMessageDirect(
          sysMsgId,
          chatJid,
          '__billing__',
          ASSISTANT_NAME,
          sysMsg,
          sysTimestamp,
          true,
        );
        broadcastNewMessage(chatJid, {
          id: sysMsgId,
          chat_jid: chatJid,
          sender: '__billing__',
          sender_name: ASSISTANT_NAME,
          content: sysMsg,
          timestamp: sysTimestamp,
          is_from_me: true,
        });
        deps.setLastAgentTimestamp(chatJid, { timestamp, id: messageId });
        deps.advanceGlobalCursor({ timestamp, id: messageId });
        return { ok: true, messageId, timestamp };
      }
    }
  }

  // Plugin command expander (DMI commands).
  //
  // Hybrid strategy avoiding the round-11/round-12 P2-4 double-exec while
  // keeping active-runner DMI working:
  //   - Active runner: expander runs here. `reply` short-circuits with an
  //     in-band system message; `expanded` mutates `sendContent` to the
  //     prompt that's piped via `queue.sendMessage`; `miss` passes through.
  //   - Idle (no active runner): we DO NOT call the expander at all —
  //     `expandPluginSlashCommandIfNeeded` itself runs inline `!` as a side
  //     effect (not pure parse), so calling it then discarding the result
  //     would still execute inline once here AND again when cold-start
  //     re-reads the DB row and re-expands → double-fire (#20 P2-4 round 12).
  //     The `enqueueMessageCheck → cold-start → expandMessagesIfNeeded`
  //     path handles `reply`/`expanded`/`miss` uniformly with no race.
  //
  // Race window between the peek and `queue.sendMessage` is small and benign:
  // if the runner exits in that gap, sendMessage returns 'no_active' and
  // cold-start re-reads ORIGINAL from DB (we don't write `sendContent` back),
  // so cold-start re-expands and inline runs again. Lead-approved tradeoff;
  // log a warn line so we can confirm rarity in production.
  let sendContent = content;
  const eagerExpandActive =
    deps.queue.hasActiveMainRunnerForMessage(chatJid);
  if (eagerExpandActive) {
    // Use the effective (sibling-resolved) group so non-home groups bound to a
    // home sibling inherit executionMode / customCwd / created_by — otherwise
    // buildWebExpandContext returns null on sibling JIDs and the active runner
    // ends up receiving the literal `/foo` slash command (#21 round-13 P2-3).
    const expandGroup = deps.resolveEffectiveGroup
      ? deps.resolveEffectiveGroup(group).effectiveGroup
      : group;
    const expandCtx = buildWebExpandContext(chatJid, expandGroup, userId);
    if (expandCtx) {
      const expansion = await expandPluginSlashCommandIfNeeded(
        expandCtx,
        content,
      );
      if (expansion.kind === 'reply') {
        const sysMsgId = `sys_plugin_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        const sysTimestamp = new Date().toISOString();
        storeMessageDirect(
          sysMsgId,
          chatJid,
          '__plugin__',
          ASSISTANT_NAME,
          expansion.text,
          sysTimestamp,
          true,
        );
        broadcastNewMessage(chatJid, {
          id: sysMsgId,
          chat_jid: chatJid,
          sender: '__plugin__',
          sender_name: ASSISTANT_NAME,
          content: expansion.text,
          timestamp: sysTimestamp,
          is_from_me: true,
        });
        // Plugin reply is out-of-band — it does NOT consume an agent turn.
        // Mirror the cold-start cursor logic (#22 round-14 P2):
        //   - earlier pending exists → advanceNextPullCursorOnly so the
        //     next poll skips this reply but lastCommittedCursor stays put
        //     and recovery still surfaces the earlier message
        //   - no earlier pending → advanceCursors fully commits with a
        //     lex (timestamp, id) max-merge (#27 round-17 P2-2). Direct
        //     overwrite via setCursors regressed the cursor when a same-
        //     millisecond batch had a higher-UUID neighbor already
        //     committed → already-processed messages re-polled and the
        //     reply re-fired.
        const replyCursor = { timestamp, id: messageId };
        if (deps.hasEarlierPendingMessages(chatJid, replyCursor)) {
          deps.advanceNextPullCursorOnly(chatJid, replyCursor);
        } else {
          deps.advanceCursors(chatJid, replyCursor);
        }
        deps.advanceGlobalCursor(replyCursor);
        return { ok: true, messageId, timestamp };
      }
      if (expansion.kind === 'expanded') {
        sendContent = expansion.prompt;
        // Crash-safety (#23 round-15 P1-1): the cold-start path persists the
        // sentinel before the cursor advances; the web eager-expand path was
        // missing this write, so a runner crash between IPC inject and message
        // consume left the DB row holding the original `/foo` slash command.
        // Recovery's expandMessagesIfNeeded would then re-run inline `!` and
        // fire side effects twice. Mirror the cold-start contract here:
        // persist BEFORE handing the expanded prompt downstream, only when
        // every inline succeeded — failed-inline expansions intentionally
        // skip persistence so recovery legitimately retries.
        if (expansion.inlineExecuted) {
          try {
            persistPluginExpansion(messageId, chatJid, {
              type: PLUGIN_EXPANSION_ATTACHMENT_TYPE,
              expanded: true,
              prompt: expansion.prompt,
              expandedAt: new Date().toISOString(),
            });
          } catch (err) {
            // Non-fatal: prompt still reaches the agent on this run; recovery
            // worst-case re-runs inline (the original bug, no regression).
            logger.warn(
              { err, chatJid, messageId },
              'web eager expand: failed to persist expansion sentinel',
            );
          }
        }
      }
      // `miss` → sendContent already holds the original.
    }
  }
  // Idle path: skip expander entirely; cold-start will expand once from the
  // original DB row via `expandMessagesIfNeeded` (handles reply/expanded/miss).

  const shared = !group.is_home && isGroupShared(group.folder);
  const formatted = deps.formatMessages(
    [
      {
        id: messageId,
        chat_jid: chatJid,
        sender: userId,
        sender_name: displayName,
        content: sendContent,
        timestamp,
      },
    ],
    shared,
  );

  // IPC-inject the message into the running agent process.  For home groups,
  // the reply route is dynamically updated via activeRouteUpdaters so we no
  // longer need to kill and restart the process (#99).
  let pipedToActive = false;
  const images = toAgentImages(normalizedAttachments);
  const updateRoute = deps.updateReplyRoute;
  const sendResult = deps.queue.sendMessage(
    chatJid,
    formatted,
    images,
    () => {
      // IPC write succeeded — update reply route for home groups.
      // Web messages have no IM source, so clear the IM route.
      updateRoute?.(group.folder, null);
    },
    chatJid,
  );
  if (sendResult === 'sent') {
    pipedToActive = true;
  } else {
    if (eagerExpandActive && sendContent !== content) {
      // Active runner exited between peek and sendMessage → cold-start will
      // re-expand from the ORIGINAL DB content, so inline `!` runs again.
      // Rare but possible — flagged so we can quantify in production.
      logger.warn(
        {
          event: 'plugin_expander_race',
          subtype: 'user_message',
          chatJid,
          userId,
          messageId,
        },
        'Race: eager-expanded but runner exited before sendMessage; cold-start will re-expand (inline may run twice)',
      );
    }
    deps.queue.enqueueMessageCheck(chatJid);
  }

  // Only advance per-group cursor when we piped directly into a running container.
  //
  // When piped to active, we also mark the group as having pending IPC-injected
  // messages. If the agent crashes without processing them, the close handler
  // resets pendingMessages so drainGroup re-reads from DB.
  if (pipedToActive) {
    deps.setLastAgentTimestamp(chatJid, { timestamp, id: messageId });
    deps.queue.markIpcInjectedMessage(chatJid);
  }
  deps.advanceGlobalCursor({ timestamp, id: messageId });
  return { ok: true, messageId, timestamp };
}

// --- Auto-title for conversations ---

/** Extract a short title from the first user message content. */
function generateAutoTitle(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed || trimmed.startsWith('/')) return null;

  const text = markdownToPlainText(trimmed)
    .replace(/\n+/g, ' ')
    .trim();

  if (!text) return null;

  const firstLine = text.split('\n')[0].trim();
  if (!firstLine) return null;

  if (firstLine.length <= 20) return firstLine;
  return firstLine.slice(0, 20) + '…';
}

// --- Agent Conversation Message Handler ---

async function handleAgentConversationMessage(
  chatJid: string,
  agentId: string,
  content: string,
  userId: string,
  displayName: string,
  attachments?: Array<{ type: 'image'; data: string; mimeType?: string }>,
): Promise<void> {
  if (!deps) return;

  const agent = getAgent(agentId);
  if (!agent || agent.kind !== 'conversation' || agent.chat_jid !== chatJid) {
    logger.warn(
      { chatJid, agentId },
      'Agent conversation message rejected: agent not found or not a conversation',
    );
    return;
  }

  const virtualChatJid = `${chatJid}#agent:${agentId}`;

  // Store message with virtual chat_jid
  const messageId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const normalizedAttachments = normalizeImageAttachments(attachments, {
    onMimeMismatch: ({ declaredMime, detectedMime }) => {
      logger.warn(
        { chatJid, messageId, agentId, declaredMime, detectedMime },
        'Agent conversation attachment MIME mismatch detected, using detected MIME',
      );
    },
  });
  const attachmentsStr =
    normalizedAttachments.length > 0
      ? JSON.stringify(normalizedAttachments)
      : undefined;

  ensureChatExists(virtualChatJid);
  storeMessageDirect(
    messageId,
    virtualChatJid,
    userId,
    displayName,
    content,
    timestamp,
    false,
    { attachments: attachmentsStr },
  );
  updateAgentContextInfo(agentId, { last_active_at: timestamp });

  // Auto-title: show a quick placeholder derived from the first user message.
  // Keep title_source='auto_pending' so processAgentConversation() can upgrade
  // it to an LLM-generated title after the first reply finalizes.
  if (agent.title_source === 'auto_pending') {
    const autoTitle = generateAutoTitle(content);
    if (autoTitle) {
      updateAgentContextInfo(agentId, { name: autoTitle });
      updateChatName(virtualChatJid, autoTitle);
      broadcastAgentStatus(chatJid, agentId, agent.status as AgentStatus, autoTitle, agent.prompt);
    }
  }

  // Broadcast new_message with agentId so frontend routes to agent tab
  broadcastNewMessage(
    virtualChatJid,
    {
      id: messageId,
      chat_jid: virtualChatJid,
      sender: userId,
      sender_name: displayName,
      content,
      timestamp,
      is_from_me: false,
      attachments: attachmentsStr,
    },
    agentId,
  );

  // Plugin command expander (DMI commands).
  //
  // Hybrid strategy (mirrors handleWebUserMessage; #20 P2-4 round 12):
  //   - Active runner: expander runs here. `reply` short-circuits;
  //     `expanded` mutates `agentSendContent`; `miss` passes through.
  //   - Idle: skip expander entirely. Calling expander runs inline `!` as a
  //     side effect, and cold-start (`processAgentConversation` →
  //     `expandMessagesIfNeeded`) would re-expand from the original DB row
  //     → inline double-fire. Cold-start handles all three outcomes.
  let agentSendContent = content;
  const eagerExpandAgentActive =
    deps.queue.hasActiveMainRunnerForMessage(virtualChatJid);
  if (eagerExpandAgentActive) {
    const parentGroup =
      deps.getRegisteredGroups()[chatJid] ?? getRegisteredGroup(chatJid);
    if (parentGroup) {
      // Use the effective (sibling-resolved) parent group so a non-home parent
      // bound to a home sibling expands plugins via the home's executionMode /
      // customCwd / created_by — otherwise buildWebExpandContext returns null
      // for the agent virtual JID and the active runner receives the raw
      // slash command (#21 round-13 P2-3).
      const expandParent = deps.resolveEffectiveGroup
        ? deps.resolveEffectiveGroup(parentGroup).effectiveGroup
        : parentGroup;
      const expandCtx = buildWebExpandContext(
        virtualChatJid,
        expandParent,
        userId,
      );
      if (expandCtx) {
        const expansion = await expandPluginSlashCommandIfNeeded(
          expandCtx,
          content,
        );
        if (expansion.kind === 'reply') {
          const sysMsgId = `sys_plugin_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
          const sysTimestamp = new Date().toISOString();
          storeMessageDirect(
            sysMsgId,
            virtualChatJid,
            '__plugin__',
            ASSISTANT_NAME,
            expansion.text,
            sysTimestamp,
            true,
          );
          broadcastNewMessage(
            virtualChatJid,
            {
              id: sysMsgId,
              chat_jid: virtualChatJid,
              sender: '__plugin__',
              sender_name: ASSISTANT_NAME,
              content: expansion.text,
              timestamp: sysTimestamp,
              is_from_me: true,
            },
            agentId,
          );
          // Plugin reply is out-of-band — it does NOT consume an agent turn.
          // Mirror the cold-start cursor logic (#22 round-14 P2): commit
          // both cursors when no earlier pending message exists, otherwise
          // hold lastCommittedCursor so recovery still picks it up.
          //
          // Commit uses lex (timestamp, id) max-merge via `advanceCursors`
          // (#27 round-17 P2-2) — direct overwrite would regress cursor on
          // same-millisecond batches and re-fire the reply.
          const replyCursor = { timestamp, id: messageId };
          if (deps.hasEarlierPendingMessages(virtualChatJid, replyCursor)) {
            deps.advanceNextPullCursorOnly(virtualChatJid, replyCursor);
          } else {
            deps.advanceCursors(virtualChatJid, replyCursor);
          }
          return;
        }
        if (expansion.kind === 'expanded') {
          agentSendContent = expansion.prompt;
          // Crash-safety mirror of handleWebUserMessage (#23 round-15 P1-1):
          // persist the rendered prompt onto the message row BEFORE IPC
          // injection so a runner crash before consume cannot trick the
          // agent-conv cold-start into re-running inline `!` from the
          // original DB content. Sentinel keys on virtualChatJid because
          // that's the storeMessageDirect / read-back JID.
          if (expansion.inlineExecuted) {
            try {
              persistPluginExpansion(messageId, virtualChatJid, {
                type: PLUGIN_EXPANSION_ATTACHMENT_TYPE,
                expanded: true,
                prompt: expansion.prompt,
                expandedAt: new Date().toISOString(),
              });
            } catch (err) {
              logger.warn(
                { err, chatJid, virtualChatJid, agentId, messageId },
                'web eager expand (agent conv): failed to persist expansion sentinel',
              );
            }
          }
        }
        // `miss` → agentSendContent already holds the original.
      }
    }
  }
  // Idle path: skip expander entirely; cold-start owns expansion via
  // `expandMessagesIfNeeded` (handles reply/expanded/miss uniformly).

  // Format for agent
  const shared = false; // agent conversations are not shared
  const formatted = deps.formatMessages(
    [
      {
        id: messageId,
        chat_jid: virtualChatJid,
        sender: userId,
        sender_name: displayName,
        content: agentSendContent,
        timestamp,
      },
    ],
    shared,
  );

  // Try to pipe into running agent process
  const agentImages = toAgentImages(normalizedAttachments);
  const agentSendResult = deps.queue.sendMessage(
    virtualChatJid,
    formatted,
    agentImages,
    undefined,
    virtualChatJid,
  );
  if (agentSendResult === 'no_active') {
    if (eagerExpandAgentActive && agentSendContent !== content) {
      // Race: peek said active, but the runner exited before sendMessage.
      // Cold-start re-expands from the original DB row → inline `!` may
      // run twice. Lead-approved edge case; logged for telemetry.
      logger.warn(
        {
          event: 'plugin_expander_race',
          subtype: 'agent_conversation',
          chatJid,
          virtualChatJid,
          userId,
          agentId,
          messageId,
        },
        'Race: eager-expanded agent conv but runner exited before sendMessage; cold-start will re-expand',
      );
    }
    // No running process — force close any stale state and start fresh.
    // Mirrors the reliable IM path in buildOnAgentMessage() (#240).
    deps.queue.closeStdin(virtualChatJid);
    if (deps.processAgentConversation) {
      const taskId = `agent-conv:${agentId}:${Date.now()}`;
      deps.queue.enqueueTask(virtualChatJid, taskId, async () => {
        await deps!.processAgentConversation!(chatJid, agentId);
      });
    }
  }
  // 'sent' needs no further action
}

// --- Static Files ---

// 带 content hash 的静态资源：长期不可变缓存
app.use(
  '/assets/*',
  async (c, next) => {
    await next();
    if (c.res.status === 200) {
      c.res.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
  serveStatic({ root: './web/dist' }),
);

// SPA fallback：index.html / sw.js 等必须每次验证
app.use(
  '/*',
  async (c, next) => {
    await next();
    if (c.res.status === 200) {
      const p = c.req.path;
      // 非文件扩展名路径（SPA fallback → index.html）、SW 脚本、manifest 禁止缓存
      if (
        !p.match(/\.\w+$/) ||
        p === '/sw.js' ||
        p === '/registerSW.js' ||
        p === '/manifest.webmanifest'
      ) {
        c.res.headers.set(
          'Cache-Control',
          'no-cache, no-store, must-revalidate',
        );
      }
    }
  },
  serveStatic({
    root: './web/dist',
    rewriteRequestPath: (p) => {
      // SPA fallback
      if (p.startsWith('/api') || p.startsWith('/ws')) return p;
      if (p.match(/\.\w+$/)) return p; // Has file extension
      return '/index.html';
    },
  }),
);

// --- WebSocket ---

function setupWebSocket(server: any): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request: any, socket: any, head: any) => {
    const { pathname } = new URL(request.url, `http://${request.headers.host}`);

    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }

    // Verify session cookie (HMAC signature + DB lookup).
    // WebSocket upgrade cannot return Set-Cookie, so legacy cookies are
    // accepted here but upgraded on the next HTTP request instead.
    const cookieHeader = request.headers.cookie as string | undefined;
    let allCookieValues = getAllCookieValues(cookieHeader, SESSION_COOKIE_NAME_SECURE);
    if (allCookieValues.length === 0) {
      allCookieValues = getAllCookieValues(cookieHeader, SESSION_COOKIE_NAME_PLAIN);
    }
    if (allCookieValues.length === 0) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const verifyResult = tryVerifyAny(allCookieValues);
    if (!verifyResult) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    const token = verifyResult.token;

    const session = getCachedSessionWithUser(token);
    if (!session) {
      invalidateSessionCache(token);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (isSessionExpired(session.expires_at)) {
      deleteUserSession(token);
      invalidateSessionCache(token);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (session.status !== 'active') {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    request.__happyclawSessionId = token;

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws, request: any) => {
    const sessionId = request?.__happyclawSessionId as string | undefined;
    logger.info('WebSocket client connected');
    const connSession = sessionId ? getCachedSessionWithUser(sessionId) : undefined;
    wsClients.set(ws, {
      sessionId: sessionId || '',
      userId: connSession?.user_id || '',
      role: (connSession?.role || 'member') as UserRole,
    });

    // Push streaming snapshots for active groups this user can access
    if (connSession && streamingSnapshots.size > 0) {
      const userId = connSession.user_id;
      for (const [jid, snap] of streamingSnapshots) {
        // Skip stale snapshots (> 30 min)
        // Extended from 5 min to 30 min to support long-running sub-agents.
        // See GitHub issue #241.
        if (Date.now() - snap.updatedAt > 30 * 60 * 1000) {
          streamingSnapshots.delete(jid);
          continue;
        }
        // Skip empty snapshots
        if (!snap.partialText && snap.activeTools.length === 0 && snap.recentEvents.length === 0) {
          continue;
        }
        // Strip #agent: suffix for ACL lookup (virtual JIDs not in registered_groups)
        const baseJid = jid.includes('#agent:') ? jid.split('#agent:')[0] : jid;
        const allowed = getGroupAllowedUserIds(baseJid);
        if (allowed === null || !allowed.has(userId)) continue;
        try {
          ws.send(JSON.stringify({
            type: 'stream_snapshot',
            chatJid: jid,
            snapshot: {
              partialText: snap.partialText,
              activeTools: snap.activeTools,
              recentEvents: snap.recentEvents,
              todos: snap.todos,
              systemStatus: snap.systemStatus,
              turnId: snap.turnId,
            },
          } satisfies WsMessageOut));
        } catch { /* client not ready */ }
      }
    }

    // Push runner_state: 'running' for all active groups on WS connect.
    // This prevents a race where a late-arriving new_message clears
    // waiting=false after snapshot restore, blocking all subsequent
    // stream events. The runner_state event resets waiting=true.
    if (connSession && deps) {
      const userId = connSession.user_id;
      const queueStatus = deps.queue.getStatus();
      for (const g of queueStatus.groups) {
        if (!g.active) continue;
        const jid = normalizeHomeJid(g.jid);
        const allowed = getGroupAllowedUserIds(g.jid);
        if (allowed === null || !allowed.has(userId)) continue;
        try {
          ws.send(JSON.stringify({
            type: 'runner_state',
            chatJid: jid,
            state: 'running',
          } satisfies WsMessageOut));
        } catch { /* client not ready */ }
      }
    }

    const cleanupTerminalForWs = () => {
      const termJid = wsTerminals.get(ws);
      if (!termJid) return;
      terminalManager.stop(termJid);
      releaseTerminalOwnership(ws, termJid);
    };

    ws.on('message', async (data) => {
      if (!deps) return;

      try {
        if (!sessionId) {
          ws.close(1008, 'Unauthorized');
          return;
        }

        const session = getCachedSessionWithUser(sessionId);
        if (
          !session ||
          isSessionExpired(session.expires_at) ||
          session.status !== 'active'
        ) {
          if (session && isSessionExpired(session.expires_at)) {
            deleteUserSession(sessionId);
          }
          invalidateSessionCache(sessionId);
          ws.close(1008, 'Unauthorized');
          return;
        }

        const now = Date.now();
        const lastUpdate = lastActiveCache.get(sessionId) || 0;
        if (now - lastUpdate > LAST_ACTIVE_DEBOUNCE_MS) {
          lastActiveCache.set(sessionId, now);
          try {
            updateSessionLastActive(sessionId);
          } catch {
            /* best effort */
          }
        }

        const msg: WsMessageIn = JSON.parse(data.toString());

        const sendWsError = (error: string, chatJid?: string) => {
          const msg: WsMessageOut = { type: 'ws_error', error, chatJid };
          ws.send(JSON.stringify(msg));
        };

        if (msg.type === 'send_message') {
          const wsValidation = MessageCreateSchema.safeParse({
            chatJid: msg.chatJid,
            content: msg.content,
            attachments: msg.attachments,
          });
          if (!wsValidation.success) {
            sendWsError('消息格式无效', msg.chatJid);
            logger.warn(
              { chatJid: msg.chatJid, issues: wsValidation.error.issues.map(i => i.message) },
              'WebSocket send_message validation failed',
            );
            return;
          }
          const { chatJid, content, attachments } = wsValidation.data;
          const agentId = (msg as { agentId?: string }).agentId;

          // 群组访问权限检查
          const targetGroup = getRegisteredGroup(chatJid);
          if (targetGroup) {
            if (
              !canAccessGroup(
                { id: session.user_id, role: session.role },
                targetGroup,
              )
            ) {
              sendWsError('无权访问该群组', chatJid);
              logger.warn(
                { chatJid, userId: session.user_id },
                'WebSocket send_message blocked: access denied',
              );
              return;
            }
            if (isHostExecutionGroup(targetGroup)) {
              if (session.role !== 'admin') {
                sendWsError('宿主机模式需要管理员权限', chatJid);
                logger.warn(
                  { chatJid, userId: session.user_id },
                  'WebSocket send_message blocked: host mode requires admin',
                );
                return;
              }
            }
          }

          // ── /sw or /spawn command: spawn parallel task (checked before agent routing) ──
          const swMatch = content.trim().match(/^\/(sw|spawn)\s+([\s\S]+)$/i);
          if (swMatch && deps?.handleSpawnCommand) {
            const spawnMessage = swMatch[2].trim();
            if (spawnMessage) {
              try {
                // For agent tab, include agentId in chatJid so spawn resolves the right workspace
                const effectiveChatJid = agentId
                  ? `${chatJid}#agent:${agentId}`
                  : chatJid;
                // Store user's /sw message in the current chat so it's visible
                const userMsgId = crypto.randomUUID();
                const userMsgTs = new Date().toISOString();
                ensureChatExists(effectiveChatJid);
                storeMessageDirect(
                  userMsgId, effectiveChatJid,
                  session.user_id,
                  session.display_name || session.username,
                  content.trim(),
                  userMsgTs,
                  false,
                  { meta: { sourceKind: 'user_command' } },
                );
                broadcastNewMessage(effectiveChatJid, {
                  id: userMsgId, chat_jid: effectiveChatJid,
                  sender: session.user_id,
                  sender_name: session.display_name || session.username,
                  content: content.trim(),
                  timestamp: userMsgTs,
                  is_from_me: false,
                });

                await deps.handleSpawnCommand(effectiveChatJid, spawnMessage);
              } catch (err) {
                logger.error({ chatJid, err }, '/sw command failed');
              }
            }
            return;
          }

          // ── /clear command: reset session without entering message pipeline ──
          // Must run before the agentId early return so /clear in a sub-agent tab
          // resets the agent session (passing agentId) instead of being delivered
          // to the agent as plain text.
          // Permission: relies on the canAccessGroup + host-mode checks above
          // (kept aligned with send-message; ACL tightening tracked in follow-up).
          // Success has no explicit ws_error/ack — the client sees the reset
          // through the broadcastNewMessage(context_reset) push from executeSessionReset.
          if (isClearCommand(content) && deps && targetGroup) {
            // Validate agentId before passing to executeSessionReset →
            // clearSessionFiles, which interpolates agentId into a filesystem
            // path. Mirrors the reset-session route's check (routes/groups.ts).
            if (agentId) {
              const agent = getAgent(agentId);
              if (!agent || agent.chat_jid !== chatJid) {
                sendWsError('Agent not found', chatJid);
                return;
              }
            }
            const errorTargetJid = agentId
              ? `${chatJid}#agent:${agentId}`
              : chatJid;
            try {
              await executeSessionReset(
                chatJid,
                targetGroup.folder,
                {
                  queue: deps.queue,
                  sessions: deps.getSessions(),
                  broadcast: broadcastNewMessage,
                  setLastAgentTimestamp: deps.setLastAgentTimestamp,
                },
                agentId,
              );
            } catch (err) {
              logger.error(
                { chatJid, agentId, err },
                '/clear command failed',
              );
              const errId = crypto.randomUUID();
              const errTs = new Date().toISOString();
              ensureChatExists(errorTargetJid);
              storeMessageDirect(
                errId,
                errorTargetJid,
                '__system__',
                'system',
                SESSION_RESET_FAILURE_MESSAGE,
                errTs,
                true,
              );
              broadcastNewMessage(errorTargetJid, {
                id: errId,
                chat_jid: errorTargetJid,
                sender: '__system__',
                sender_name: 'system',
                content: SESSION_RESET_FAILURE_MESSAGE,
                timestamp: errTs,
                is_from_me: true,
              });
            }
            return;
          }

          // Route to agent conversation handler if agentId is present
          if (agentId && deps) {
            await handleAgentConversationMessage(
              chatJid,
              agentId,
              content.trim(),
              session.user_id,
              session.display_name || session.username,
              attachments,
            );
            return;
          }

          const result = await handleWebUserMessage(
            chatJid,
            content.trim(),
            attachments,
            session.user_id,
            session.display_name || session.username,
          );
          if (!result.ok) {
            logger.warn(
              { chatJid, status: result.status, error: result.error },
              'WebSocket message rejected',
            );
          }
        } else if (msg.type === 'terminal_start') {
          try {
            // Schema 验证
            const startValidation = TerminalStartSchema.safeParse(msg);
            if (!startValidation.success) {
              ws.send(
                JSON.stringify({
                  type: 'terminal_error',
                  chatJid: msg.chatJid || '',
                  error: '终端启动参数无效',
                }),
              );
              return;
            }
            const chatJid = startValidation.data.chatJid.trim();
            if (!chatJid) {
              ws.send(
                JSON.stringify({
                  type: 'terminal_error',
                  chatJid: '',
                  error: 'chatJid 无效',
                }),
              );
              return;
            }
            const group = deps.getRegisteredGroups()[chatJid];
            if (!group) {
              ws.send(
                JSON.stringify({
                  type: 'terminal_error',
                  chatJid,
                  error: '群组不存在',
                }),
              );
              return;
            }
            // Permission: user must be able to access the group
            const groupWithJid = { ...group, jid: chatJid };
            if (
              !canAccessGroup(
                { id: session.user_id, role: session.role },
                groupWithJid,
              )
            ) {
              ws.send(
                JSON.stringify({
                  type: 'terminal_error',
                  chatJid,
                  error: '无权访问该群组终端',
                }),
              );
              return;
            }
            if ((group.executionMode || 'container') === 'host') {
              ws.send(
                JSON.stringify({
                  type: 'terminal_error',
                  chatJid,
                  error: '宿主机模式不支持终端',
                }),
              );
              return;
            }
            // 查找活跃的容器
            const status = deps.queue.getStatus();
            const groupStatus = status.groups.find((g) => g.jid === chatJid);
            if (!groupStatus || !groupStatus.active) {
              deps.ensureTerminalContainerStarted(chatJid);
              ws.send(
                JSON.stringify({
                  type: 'terminal_error',
                  chatJid,
                  error: '工作区启动中，请稍后重试',
                }),
              );
              return;
            }
            if (!groupStatus.containerName) {
              ws.send(
                JSON.stringify({
                  type: 'terminal_error',
                  chatJid,
                  error: '工作区启动中，请稍后重试',
                }),
              );
              return;
            }
            const cols = normalizeTerminalSize(msg.cols, 80, 20, 300);
            const rows = normalizeTerminalSize(msg.rows, 24, 8, 120);
            // 停止该 ws 之前的终端
            const prevJid = wsTerminals.get(ws);
            if (prevJid && prevJid !== chatJid) {
              terminalManager.stop(prevJid);
              releaseTerminalOwnership(ws, prevJid);
            }

            // 若该 group 已被其它 ws 占用，先释放旧 owner，防止后续 close 误杀新会话
            const existingOwner = terminalOwners.get(chatJid);
            if (existingOwner && existingOwner !== ws) {
              terminalManager.stop(chatJid);
              releaseTerminalOwnership(existingOwner, chatJid);
              if (existingOwner.readyState === WebSocket.OPEN) {
                existingOwner.send(
                  JSON.stringify({
                    type: 'terminal_stopped',
                    chatJid,
                    reason: '终端被其他连接接管',
                  }),
                );
              }
            }

            terminalManager.start(
              chatJid,
              groupStatus.containerName,
              cols,
              rows,
              (data) => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(
                    JSON.stringify({ type: 'terminal_output', chatJid, data }),
                  );
                }
              },
              (_exitCode, _signal) => {
                if (terminalOwners.get(chatJid) === ws) {
                  releaseTerminalOwnership(ws, chatJid);
                }
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(
                    JSON.stringify({
                      type: 'terminal_stopped',
                      chatJid,
                      reason: '终端进程已退出',
                    }),
                  );
                }
              },
            );
            wsTerminals.set(ws, chatJid);
            terminalOwners.set(chatJid, ws);
            ws.send(JSON.stringify({ type: 'terminal_started', chatJid }));
          } catch (err) {
            logger.error(
              { err, chatJid: msg.chatJid },
              'Error starting terminal',
            );
            const detail =
              err instanceof Error && err.message
                ? err.message.slice(0, 160)
                : 'unknown';
            ws.send(
              JSON.stringify({
                type: 'terminal_error',
                chatJid: msg.chatJid,
                error: `启动终端失败 (${detail})`,
              }),
            );
          }
        } else if (msg.type === 'terminal_input') {
          const inputValidation = TerminalInputSchema.safeParse(msg);
          if (!inputValidation.success) {
            ws.send(
              JSON.stringify({
                type: 'terminal_error',
                chatJid: msg.chatJid || '',
                error: '终端输入参数无效',
              }),
            );
            return;
          }
          const ownerJid = wsTerminals.get(ws);
          if (
            ownerJid !== inputValidation.data.chatJid ||
            terminalOwners.get(inputValidation.data.chatJid) !== ws
          ) {
            ws.send(
              JSON.stringify({
                type: 'terminal_error',
                chatJid: inputValidation.data.chatJid,
                error: '终端会话已失效',
              }),
            );
            return;
          }
          terminalManager.write(
            inputValidation.data.chatJid,
            inputValidation.data.data,
          );
        } else if (msg.type === 'terminal_resize') {
          const resizeValidation = TerminalResizeSchema.safeParse(msg);
          if (!resizeValidation.success) {
            ws.send(
              JSON.stringify({
                type: 'terminal_error',
                chatJid: msg.chatJid || '',
                error: '终端调整参数无效',
              }),
            );
            return;
          }
          const ownerJid = wsTerminals.get(ws);
          if (
            ownerJid !== resizeValidation.data.chatJid ||
            terminalOwners.get(resizeValidation.data.chatJid) !== ws
          ) {
            ws.send(
              JSON.stringify({
                type: 'terminal_error',
                chatJid: resizeValidation.data.chatJid,
                error: '终端会话已失效',
              }),
            );
            return;
          }
          const cols = normalizeTerminalSize(
            resizeValidation.data.cols,
            80,
            20,
            300,
          );
          const rows = normalizeTerminalSize(
            resizeValidation.data.rows,
            24,
            8,
            120,
          );
          terminalManager.resize(resizeValidation.data.chatJid, cols, rows);
        } else if (msg.type === 'terminal_stop') {
          const stopValidation = TerminalStopSchema.safeParse(msg);
          if (!stopValidation.success) {
            return;
          }
          const ownerJid = wsTerminals.get(ws);
          if (
            ownerJid !== stopValidation.data.chatJid ||
            terminalOwners.get(stopValidation.data.chatJid) !== ws
          ) {
            return;
          }
          terminalManager.stop(stopValidation.data.chatJid);
          releaseTerminalOwnership(ws, stopValidation.data.chatJid);
          ws.send(
            JSON.stringify({
              type: 'terminal_stopped',
              chatJid: stopValidation.data.chatJid,
              reason: '用户关闭终端',
            }),
          );
        }
      } catch (err) {
        logger.error({ err }, 'Error handling WebSocket message');
      }
    });

    ws.on('close', () => {
      logger.info('WebSocket client disconnected');
      wsClients.delete(ws);
      cleanupTerminalForWs();
    });

    ws.on('error', (err) => {
      logger.error({ err }, 'WebSocket error');
      wsClients.delete(ws);
      cleanupTerminalForWs();
    });
  });

  return wss;
}

// --- Broadcast Functions ---

/**
 * Broadcast to all connected WebSocket clients.
 * If adminOnly is true, only send to clients whose session belongs to an admin user.
 * If ownerUserId is provided, only send to that user and admins (for group isolation).
 */
/**
 * Broadcast a WebSocket message with access control filtering.
 *
 * @param msg - The message to broadcast
 * @param adminOnly - If true, only admin users receive the message
 * @param allowedUserIds - Group access filtering:
 *   - undefined: no user-level filtering (e.g. system-wide admin broadcasts)
 *   - null: ownership unresolvable → default-deny, only admin can see
 *   - Set<string>: only these users + admin can see
 */
function safeBroadcast(
  msg: WsMessageOut,
  adminOnly = false,
  allowedUserIds?: Set<string> | null,
): void {
  const data = JSON.stringify(msg);
  for (const [client, clientInfo] of wsClients) {
    if (client.readyState !== WebSocket.OPEN) {
      wsClients.delete(client);
      continue;
    }

    if (!clientInfo.sessionId) {
      wsClients.delete(client);
      try {
        client.close(1008, 'Unauthorized');
      } catch {
        /* ignore */
      }
      continue;
    }

    const session = getCachedSessionWithUser(clientInfo.sessionId);
    const expired = !!session && isSessionExpired(session.expires_at);
    const invalid =
      !session ||
      expired ||
      session.status !== 'active';
    if (invalid) {
      if (expired) {
        deleteUserSession(clientInfo.sessionId);
      }
      invalidateSessionCache(clientInfo.sessionId);
      wsClients.delete(client);
      try {
        client.close(1008, 'Unauthorized');
      } catch {
        /* ignore */
      }
      continue;
    }

    if (adminOnly && session.role !== 'admin') {
      continue;
    }

    // Group isolation: only allowed users (owner + shared members) can see this group's events
    // allowedUserIds === null means ownership unresolvable → default-deny (admin-only)
    if (allowedUserIds !== undefined) {
      if (allowedUserIds === null || !allowedUserIds.has(session.user_id)) {
        continue;
      }
    }

    try {
      client.send(data);
    } catch {
      wsClients.delete(client);
    }
  }
}

/**
 * Get the set of user IDs allowed to receive broadcasts for a group.
 * Includes the owner and all shared members. Admin is NOT automatically included
 * — they must be the owner or a shared member to receive broadcasts.
 *
 * Returns:
 * - Set<string>: allowed user IDs (owner + shared members)
 * - null: ownership unresolvable → default-deny (admin-only)
 */
const allowedUserIdsCache = new Map<
  string,
  { ids: Set<string> | null; expiry: number }
>();
const ALLOWED_CACHE_TTL = 10_000; // 10 seconds

function getGroupAllowedUserIds(chatJid: string): Set<string> | null {
  const now = Date.now();
  const cached = allowedUserIdsCache.get(chatJid);
  if (cached && cached.expiry > now) return cached.ids;

  const result = computeGroupAllowedUserIds(chatJid);
  allowedUserIdsCache.set(chatJid, {
    ids: result,
    expiry: now + ALLOWED_CACHE_TTL,
  });
  return result;
}

/** Invalidate the allowed-user cache for a group and all sibling JIDs sharing the same folder. */
export function invalidateAllowedUserCache(chatJid: string): void {
  allowedUserIdsCache.delete(chatJid);
  // Also clear cache for sibling JIDs sharing the same folder,
  // since membership is per-folder, not per-JID.
  const group = getRegisteredGroup(chatJid);
  if (group) {
    const siblingJids = getJidsByFolder(group.folder);
    for (const jid of siblingJids) {
      allowedUserIdsCache.delete(jid);
    }
  }
}

function computeGroupAllowedUserIds(chatJid: string): Set<string> | null {
  const group = getRegisteredGroup(chatJid);
  if (!group) return null; // Unknown group → deny by default

  const allowed = new Set<string>();

  // Add owner
  let ownerId: string | null = group.created_by ?? null;

  // Legacy fallback: IM group without created_by, resolve by sibling home group.
  if (!ownerId && !chatJid.startsWith('web:')) {
    const siblingJids = getJidsByFolder(group.folder);
    for (const siblingJid of siblingJids) {
      if (!siblingJid.startsWith('web:')) continue;
      const siblingGroup = getRegisteredGroup(siblingJid);
      if (siblingGroup?.is_home && siblingGroup.created_by) {
        ownerId = siblingGroup.created_by;
        break;
      }
    }
  }

  if (!ownerId) {
    if (group.is_home) return null;
    if (group.folder === 'main') return null;
    return null; // Unresolvable → deny by default
  }

  allowed.add(ownerId);

  // For non-home groups, include shared members
  if (!group.is_home) {
    const members = getGroupMembers(group.folder);
    for (const m of members) {
      allowed.add(m.user_id);
    }
  }

  return allowed;
}

/** Check if a chatJid belongs to a host-mode group (for broadcast filtering) */
function isHostGroupJid(chatJid: string): boolean {
  const group = getRegisteredGroup(chatJid);
  return !!group && isHostExecutionGroup(group);
}

/**
 * Normalize chatJid for WebSocket broadcasts.
 * IM groups (Feishu/Telegram) that share a folder with an is_home group are mapped
 * to that home group's web JID so the frontend can match all home-session events.
 */
function normalizeHomeJid(chatJid: string): string {
  if (chatJid.startsWith('web:')) return chatJid;
  const group = getRegisteredGroup(chatJid);
  if (!group) return chatJid;

  // Find the web: JID that shares this folder (typically the is_home group)
  const jids = getJidsByFolder(group.folder);
  for (const jid of jids) {
    if (jid.startsWith('web:')) {
      return jid;
    }
  }
  return chatJid;
}

export function broadcastToWebClients(chatJid: string, text: string): void {
  const timestamp = new Date().toISOString();
  const jid = normalizeHomeJid(chatJid);
  const allowedUserIds = getGroupAllowedUserIds(chatJid);
  safeBroadcast(
    { type: 'agent_reply', chatJid: jid, text, timestamp },
    isHostGroupJid(chatJid),
    allowedUserIds,
  );
}

export function broadcastNewMessage(
  chatJid: string,
  msg: NewMessage & { is_from_me?: boolean },
  agentId?: string,
  source?: string,
): void {
  // For virtual JIDs like "web:xxx#agent:yyy", extract base JID and agentId
  let baseChatJid = chatJid;
  let effectiveAgentId = agentId;
  if (chatJid.includes('#agent:')) {
    const parts = chatJid.split('#agent:');
    baseChatJid = parts[0];
    if (!effectiveAgentId) effectiveAgentId = parts[1];
  }
  const jid = normalizeHomeJid(baseChatJid);
  const allowedUserIds = getGroupAllowedUserIds(baseChatJid);
  const wsMsg: WsMessageOut = {
    type: 'new_message',
    chatJid: jid,
    message: { ...msg, is_from_me: msg.is_from_me ?? false },
    ...(effectiveAgentId ? { agentId: effectiveAgentId } : {}),
    ...(source ? { source } : {}),
  };
  safeBroadcast(wsMsg, isHostGroupJid(baseChatJid), allowedUserIds);
}

export function broadcastTyping(chatJid: string, isTyping: boolean): void {
  const jid = normalizeHomeJid(chatJid);
  const allowedUserIds = getGroupAllowedUserIds(chatJid);
  safeBroadcast(
    { type: 'typing', chatJid: jid, isTyping },
    isHostGroupJid(chatJid),
    allowedUserIds,
  );
}

// ─── Streaming Snapshot Accumulation ─────────────────────────────────
// Tracks current streaming state per group so WS reconnects can recover.

interface StreamingSnapshotEntry {
  partialText: string;
  activeTools: Array<{
    toolName: string;
    toolUseId: string;
    startTime: number;
    toolInputSummary?: string;
    parentToolUseId?: string | null;
  }>;
  recentEvents: Array<{
    id: string;
    timestamp: number;
    text: string;
    kind: 'tool' | 'skill' | 'hook' | 'status';
  }>;
  todos?: Array<{ id: string; content: string; status: string }>;
  systemStatus: string | null;
  turnId?: string;
  updatedAt: number;
}

const streamingSnapshots = new Map<string, StreamingSnapshotEntry>();
/** Accumulates full (non-truncated) text per group for shutdown persistence & disk buffer. */
const streamingFullTexts = new Map<string, string>();
const MAX_SNAPSHOT_TEXT = 4000;
const MAX_SNAPSHOT_EVENTS = 20;

/** Push a recent event entry and truncate to MAX_SNAPSHOT_EVENTS. */
function pushRecentEvent(snap: StreamingSnapshotEntry, event: { id: string; timestamp: number; text: string; kind: 'tool' | 'skill' | 'hook' | 'status' }): void {
  snap.recentEvents.push(event);
  if (snap.recentEvents.length > MAX_SNAPSHOT_EVENTS) {
    snap.recentEvents = snap.recentEvents.slice(-MAX_SNAPSHOT_EVENTS);
  }
}

function updateStreamingSnapshot(normalizedJid: string, event: StreamEvent): void {
  let snap = streamingSnapshots.get(normalizedJid);

  // Reset on new turn
  if (snap?.turnId && event.turnId && snap.turnId !== event.turnId) {
    snap = undefined;
    streamingFullTexts.delete(normalizedJid);
  }

  if (!snap) {
    snap = {
      partialText: '',
      activeTools: [],
      recentEvents: [],
      systemStatus: null,
      turnId: event.turnId,
      updatedAt: Date.now(),
    };
  }

  snap.updatedAt = Date.now();
  if (event.turnId) snap.turnId = event.turnId;

  switch (event.eventType) {
    case 'text_delta':
      if (event.text) {
        snap.partialText += event.text;
        if (snap.partialText.length > MAX_SNAPSHOT_TEXT) {
          snap.partialText = snap.partialText.slice(-MAX_SNAPSHOT_TEXT);
        }
        // Accumulate full (non-truncated) text for shutdown persistence
        streamingFullTexts.set(normalizedJid, (streamingFullTexts.get(normalizedJid) || '') + event.text);
      }
      break;

    case 'tool_use_start':
      if (event.toolUseId && event.toolName) {
        snap.activeTools.push({
          toolName: event.toolName,
          toolUseId: event.toolUseId,
          startTime: Date.now(),
          toolInputSummary: event.toolInputSummary,
          parentToolUseId: event.parentToolUseId,
        });
        pushRecentEvent(snap, {
          id: event.toolUseId,
          timestamp: Date.now(),
          text: event.skillName || event.toolName,
          kind: event.skillName ? 'skill' : 'tool',
        });
      }
      break;

    case 'tool_use_end':
      if (event.toolUseId) {
        snap.activeTools = snap.activeTools.filter(t => t.toolUseId !== event.toolUseId);
      }
      break;

    case 'tool_progress':
      if (event.toolUseId) {
        const tool = snap.activeTools.find(t => t.toolUseId === event.toolUseId);
        if (tool) {
          if (event.toolInputSummary) tool.toolInputSummary = event.toolInputSummary;
        }
      }
      break;

    case 'status':
      snap.systemStatus = event.statusText || null;
      if (event.statusText) {
        pushRecentEvent(snap, {
          id: `status-${Date.now()}`,
          timestamp: Date.now(),
          text: event.statusText,
          kind: 'status',
        });
      }
      break;

    case 'hook_started':
      if (event.hookName) {
        pushRecentEvent(snap, {
          id: `hook-${Date.now()}`,
          timestamp: Date.now(),
          text: `${event.hookName} (${event.hookEvent || ''})`,
          kind: 'hook',
        });
      }
      break;

    case 'todo_update':
      if (event.todos) {
        snap.todos = event.todos.map(t => ({ id: t.id, content: t.content, status: t.status }));
      }
      break;
  }

  streamingSnapshots.set(normalizedJid, snap);
}

export function clearStreamingSnapshot(chatJid: string): void {
  const jid = normalizeHomeJid(chatJid);
  streamingSnapshots.delete(jid);
  streamingFullTexts.delete(jid);
}

/**
 * Return all active streaming texts with non-empty content.
 * Uses the full (non-truncated) text accumulator for shutdown persistence & disk buffer.
 */
export function getActiveStreamingTexts(): Map<string, string> {
  const result = new Map<string, string>();
  for (const [jid, fullText] of streamingFullTexts) {
    const text = fullText.trim();
    if (text) {
      result.set(jid, text);
    }
  }
  return result;
}

export function broadcastStreamEvent(
  chatJid: string,
  event: StreamEvent,
  agentId?: string,
): void {
  const jid = normalizeHomeJid(chatJid);
  const allowedUserIds = getGroupAllowedUserIds(chatJid);
  const msg: WsMessageOut = agentId
    ? { type: 'stream_event', chatJid: jid, event, agentId }
    : { type: 'stream_event', chatJid: jid, event };
  safeBroadcast(msg, isHostGroupJid(chatJid), allowedUserIds);

  // Accumulate snapshot for both main and agent streams.
  // Agent streams use virtual JID format (jid#agent:agentId) as the key.
  const snapshotJid = agentId ? `${jid}#agent:${agentId}` : jid;
  updateStreamingSnapshot(snapshotJid, event);
}

export function broadcastGroupCreated(
  jid: string,
  folder: string,
  name: string,
  userId?: string,
): void {
  const allowedUserIds = userId ? new Set([userId]) : undefined;
  safeBroadcast({ type: 'group_created', jid, folder, name }, false, allowedUserIds);
}

export function broadcastBillingUpdate(
  userId: string,
  usage: import('./types.js').BillingAccessResult,
): void {
  const msg: WsMessageOut = {
    type: 'billing_update',
    userId,
    usage,
  };
  // Send only to the specific user
  const allowedUserIds = new Set([userId]);
  safeBroadcast(msg, false, allowedUserIds);
}

export function broadcastWhatsAppStatus(
  userId: string,
  state: {
    status: 'connecting' | 'qr' | 'connected' | 'disconnected' | 'logged_out';
    qr?: string;
    qrDataUrl?: string;
    error?: string;
    meJid?: string;
    meName?: string;
  },
): void {
  const msg: WsMessageOut = {
    type: 'whatsapp_status',
    userId,
    ...state,
  };
  const allowedUserIds = new Set([userId]);
  safeBroadcast(msg, false, allowedUserIds);
}

export function broadcastAgentStatus(
  chatJid: string,
  agentId: string,
  status: import('./types.js').AgentStatus,
  name: string,
  prompt: string,
  resultSummary?: string,
  kind?: import('./types.js').AgentKind,
  titleGenerating?: boolean,
): void {
  const jid = normalizeHomeJid(chatJid);
  const allowedUserIds = getGroupAllowedUserIds(chatJid);
  // Resolve kind from DB if not provided
  const resolvedKind = kind || getAgent(agentId)?.kind;
  const msg: WsMessageOut = {
    type: 'agent_status',
    chatJid: jid,
    agentId,
    status,
    kind: resolvedKind,
    name,
    prompt,
    resultSummary,
    titleGenerating,
  };
  safeBroadcast(msg, isHostGroupJid(chatJid), allowedUserIds);
}

export function broadcastAgentRemoved(
  chatJid: string,
  agentId: string,
  name: string,
): void {
  broadcastAgentStatus(chatJid, agentId, 'error', name, '', '__removed__', 'conversation');
}

/**
 * Broadcast an `agent_status` message that only flips the `titleGenerating`
 * loading flag — reads `agent.status`/`name`/`prompt` fresh from DB. Used by
 * the LLM title-generation path so callers don't have to pre-fetch the agent
 * and pass undefined positional params just to reach the 8th argument.
 */
export function broadcastTitleGenerating(
  chatJid: string,
  agentId: string,
  generating: boolean,
  overrideName?: string,
): void {
  const agent = getAgent(agentId);
  if (!agent) return;
  broadcastAgentStatus(
    chatJid,
    agentId,
    agent.status as AgentStatus,
    overrideName ?? agent.name,
    agent.prompt,
    undefined,
    undefined,
    generating,
  );
}

export function broadcastRunnerState(
  chatJid: string,
  state: 'idle' | 'running',
): void {
  const jid = normalizeHomeJid(chatJid);
  const allowedUserIds = getGroupAllowedUserIds(chatJid);
  const msg: WsMessageOut = {
    type: 'runner_state',
    chatJid: jid,
    state,
  };
  safeBroadcast(msg, isHostGroupJid(chatJid), allowedUserIds);

  // Clear streaming snapshots when runner goes idle (main + all agent snapshots)
  if (state === 'idle') {
    streamingSnapshots.delete(jid);
    streamingFullTexts.delete(jid);
    // Collect keys first, then delete (avoid mutating Map during iteration)
    const agentPrefix = jid + '#agent:';
    const snapshotKeysToDelete = [...streamingSnapshots.keys()].filter(k => k.startsWith(agentPrefix));
    const fullTextKeysToDelete = [...streamingFullTexts.keys()].filter(k => k.startsWith(agentPrefix));
    for (const key of snapshotKeysToDelete) streamingSnapshots.delete(key);
    for (const key of fullTextKeysToDelete) streamingFullTexts.delete(key);
  }
}

export function broadcastDockerBuildLog(line: string): void {
  safeBroadcast({ type: 'docker_build_log', line }, true);
}

export function broadcastDockerBuildComplete(
  success: boolean,
  error?: string,
): void {
  safeBroadcast({ type: 'docker_build_complete', success, error }, true);
}

function broadcastStatus(): void {
  if (!deps) return;

  const queueStatus = deps.queue.getStatus();
  // Broadcast aggregate system metrics only to admin users.
  // Non-admin users get per-user filtered metrics via REST /api/status.
  safeBroadcast(
    {
      type: 'status_update',
      activeContainers: queueStatus.activeContainerCount,
      activeHostProcesses: queueStatus.activeHostProcessCount,
      activeTotal: queueStatus.activeCount,
      queueLength: queueStatus.waitingCount,
    },
    /* adminOnly */ true,
  );
}

// --- Server Startup ---

let statusInterval: ReturnType<typeof setInterval> | null = null;
let httpServer: ReturnType<typeof serve> | null = null;
let wss: WebSocketServer | null = null;

export function startWebServer(webDeps: WebDeps): void {
  deps = webDeps;
  setWebDeps(webDeps);
  injectConfigDeps(webDeps);
  injectMonitorDeps({
    broadcastDockerBuildLog,
    broadcastDockerBuildComplete,
  });

  httpServer = serve(
    {
      fetch: app.fetch,
      port: WEB_PORT,
    },
    (info) => {
      logger.info({ port: info.port }, 'Web server started');
    },
  );

  wss = setupWebSocket(httpServer);

  // Register container exit callback for terminal cleanup
  webDeps.queue.setOnContainerExit((groupJid: string) => {
    if (terminalManager.has(groupJid)) {
      const ownerWs = terminalOwners.get(groupJid);
      terminalManager.stop(groupJid);
      if (ownerWs) {
        releaseTerminalOwnership(ownerWs, groupJid);
        if (ownerWs.readyState === WebSocket.OPEN) {
          ownerWs.send(
            JSON.stringify({
              type: 'terminal_stopped',
              chatJid: groupJid,
              reason: '工作区已停止',
            }),
          );
        }
      }
    }
  });

  // Register runner state change callback for sidebar indicators
  webDeps.queue.setOnRunnerStateChange(broadcastRunnerState);

  // Broadcast status every 5 seconds
  if (statusInterval) clearInterval(statusInterval);
  statusInterval = setInterval(broadcastStatus, 5000);
}

// --- Exports ---

export function shutdownTerminals(): void {
  terminalManager.shutdown();
}

export async function shutdownWebServer(): Promise<void> {
  if (statusInterval) {
    clearInterval(statusInterval);
    statusInterval = null;
  }
  // Close all WebSocket connections
  for (const client of wsClients.keys()) {
    try {
      client.close(1001, 'Server shutting down');
    } catch {
      /* ignore */
    }
  }
  wsClients.clear();
  // Close WebSocket server
  if (wss) {
    wss.close();
    wss = null;
  }
  // Close HTTP server
  if (httpServer) {
    httpServer.close();
    httpServer = null;
  }
}

export type { WebDeps } from './web-context.js';
