import fs from 'node:fs';
import path from 'node:path';
import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { WebSocketServer, WebSocket } from 'ws';
import crypto from 'crypto';
import { TerminalManager } from './terminal-manager.js';
import { resolveFeishuCliBoundAccountId } from './feishu-cli-runtime.js';

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
  canModifyGroup,
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
import agentProfileRoutes from './routes/agent-profiles.js';
import workspaceRoutes from './routes/workspaces.js';
import { usage as usageRoutes } from './routes/usage.js';
import billingRoutes from './routes/billing.js';
import bugReportRoutes from './routes/bug-report.js';
import channelAccountRoutes, {
  injectChannelAccountDeps,
} from './routes/channel-accounts.js';
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
  getAgent,
  getUserById,
  updateAgentContextInfo,
  updateChatName,
  listQueuedFollowUps,
  setMessageFollowUp,
} from './db.js';
import { getGroupAllowedUserIds } from './group-broadcast-acl.js';
import { markdownToPlainText } from './im-utils.js';
import { isSessionExpired } from './auth.js';
import type {
  AgentStatus,
  NewMessage,
  FollowUpMode,
  FollowUpTransition,
  QueuedFollowUp,
  WsMessageOut,
  WsMessageIn,
  AuthUser,
  StreamEvent,
  UserRole,
  MessageCursor,
  RunFinishReason,
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
import { persistPluginExpansion } from './plugin-expander-store.js';
import { logger } from './logger.js';
import { recordRunContextSnapshot } from './run-context-snapshot.js';
import { RunStreamFence } from './run-stream-fence.js';
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
): ExpandContext | null {
  const deps = getWebDeps();
  const containerName = deps?.queue.getActiveContainerName(groupJid) ?? null;
  return makeExpandContext({
    chatJid: groupJid,
    groupFolder: group.folder,
    ownerId: group.created_by,
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
// 默认空（只放行 localhost / 127.0.0.1）。WebSocket upgrade 已对同源请求放行
// （origin==Host，见 setupWebSocket），公网域名访问无需配置即可用且保留 CSWSH
// 防御。如需放行跨站来源，在 .env 配置 CORS_ALLOWED_ORIGINS 为逗号分隔白名单
// 或 '*'（关闭防御）。
const CORS_ALLOWED_ORIGINS = process.env.CORS_ALLOWED_ORIGINS || '';
const CORS_ALLOW_LOCALHOST = process.env.CORS_ALLOW_LOCALHOST !== 'false'; // default: true

function completeWebOutOfBandMessage(
  webDeps: WebDeps,
  jid: string,
  cursor: MessageCursor,
): void {
  if (webDeps.completeOutOfBandMessage) {
    webDeps.completeOutOfBandMessage(jid, cursor);
    return;
  }
  // Compatibility for focused tests that predate the production chokepoint.
  if (webDeps.hasEarlierPendingMessages(jid, cursor)) {
    webDeps.advanceNextPullCursorOnly(jid, cursor);
  } else {
    webDeps.advanceCursors(jid, cursor);
  }
}

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

// Response compression for API JSON and static assets (WebSocket upgrades
// never reach the response path). The 1.74MB entry bundle previously left the
// origin uncompressed on every load; gzip brings it to ~30%. Compressible
// content types and a 1KB threshold are filtered by the middleware itself.
app.use(compress());

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
app.route('/api/agent-profiles', agentProfileRoutes);
app.route('/api/workspaces', workspaceRoutes);
app.route('/api/groups', agentRoutes); // Workspace session routes; /agents paths remain compatibility aliases
app.route('/api/groups', workspaceConfigRoutes); // Workspace config under /api/groups/:jid/workspace-config
app.route('/api', monitorRoutes);
app.route('/api/usage', usageRoutes);
app.route('/api/billing', billingRoutes);
app.route('/api/bug-report', bugReportRoutes);
app.route('/api/channel-accounts', channelAccountRoutes);

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

  const { chatJid, agentId, content, attachments, followUpBehavior } =
    validation.data;
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

  if (agentId) {
    const agent = getAgent(agentId);
    if (!agent || agent.kind !== 'conversation' || agent.chat_jid !== chatJid) {
      return c.json({ error: 'Agent not found' }, 404);
    }
  }

  // /clear: reset session without entering message pipeline.
  // Permission: owner-only (canModifyGroup) — aligned with `reset-session`
  // route, since /clear has the same destructive effect (clears agent
  // session files, stops sibling containers, drops conversation history).
  if (isClearCommand(content)) {
    if (
      !canModifyGroup(
        { id: authUser.id, role: authUser.role },
        { ...group, jid: chatJid },
      )
    ) {
      return c.json({ error: 'Only the workspace owner can run /clear' }, 403);
    }
    if (!deps) return c.json({ error: 'Server not initialized' }, 500);
    try {
      await executeSessionReset(
        chatJid,
        group.folder,
        {
          queue: deps.queue,
          sessions: deps.getSessions(),
          broadcast: broadcastNewMessage,
          setLastAgentTimestamp: deps.setLastAgentTimestamp,
        },
        agentId,
      );
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

  if (agentId) {
    const result = await handleAgentConversationMessage(
      chatJid,
      agentId,
      content.trim(),
      authUser.id,
      authUser.display_name || authUser.username,
      attachments,
      followUpBehavior,
    );
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ success: true, ...result });
  }

  const result = await handleWebUserMessage(
    chatJid,
    content.trim(),
    attachments,
    authUser.id,
    authUser.display_name || authUser.username,
    followUpBehavior,
  );
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({
    success: true,
    messageId: result.messageId,
    timestamp: result.timestamp,
    disposition: result.disposition,
    runId: result.runId,
  });
});

app.get('/api/follow-ups', authMiddleware, async (c) => {
  if (!deps) return c.json({ error: 'Server not initialized' }, 500);
  const chatJid = c.req.query('chatJid')?.trim();
  if (!chatJid) return c.json({ error: 'chatJid is required' }, 400);
  const baseJid = chatJid.includes('#agent:')
    ? chatJid.slice(0, chatJid.indexOf('#agent:'))
    : chatJid;
  const group = getRegisteredGroup(baseJid);
  if (!group) return c.json({ error: 'Group not found' }, 404);
  const authUser = c.get('user') as AuthUser;
  if (!canAccessGroup(authUser, group)) {
    return c.json({ error: 'Access denied' }, 403);
  }
  return c.json({ items: listQueuedFollowUps(chatJid) });
});

app.post('/api/follow-ups/:messageId/action', authMiddleware, async (c) => {
  if (!deps) return c.json({ error: 'Server not initialized' }, 500);
  const messageId = c.req.param('messageId');
  const body = (await c.req.json().catch(() => ({}))) as {
    chatJid?: string;
    action?:
      | 'steer'
      | 'cancel'
      | 'edit'
      | 'move_up'
      | 'move_down'
      | 'interrupt_and_run';
    expectedRunId?: string;
    content?: string;
  };
  const chatJid = body.chatJid?.trim();
  if (!chatJid || !body.action) {
    return c.json({ error: 'chatJid and action are required' }, 400);
  }
  const baseJid = chatJid.includes('#agent:')
    ? chatJid.slice(0, chatJid.indexOf('#agent:'))
    : chatJid;
  const group = getRegisteredGroup(baseJid);
  if (!group) return c.json({ error: 'Group not found' }, 404);
  const authUser = c.get('user') as AuthUser;
  if (!canAccessGroup(authUser, group)) {
    return c.json({ error: 'Access denied' }, 403);
  }

  let result;
  if (body.action === 'cancel') {
    result = deps.cancelFollowUp?.(chatJid, messageId);
  } else if (body.action === 'edit') {
    const content = body.content?.trim();
    if (!content || content.length > 64 * 1024) {
      return c.json(
        { error: 'content must be between 1 and 65536 characters' },
        400,
      );
    }
    result = deps.editFollowUp?.(chatJid, messageId, content);
  } else if (body.action === 'move_up' || body.action === 'move_down') {
    result = deps.reorderFollowUp?.(
      chatJid,
      messageId,
      body.action === 'move_up' ? 'up' : 'down',
    );
  } else if (body.action === 'steer') {
    const currentRunId = deps.queue.getActiveQueryId(chatJid);
    const targetRunId = currentRunId ?? body.expectedRunId;
    if (!targetRunId) {
      return c.json({ error: 'expectedRunId is required' }, 400);
    }
    result = await deps.promoteFollowUp?.(chatJid, messageId, targetRunId);
  } else {
    if (
      !canModifyGroup(
        { id: authUser.id, role: authUser.role },
        { ...group, jid: baseJid },
      )
    ) {
      return c.json(
        { error: 'Only the workspace owner can interrupt it' },
        403,
      );
    }
    if (!body.expectedRunId) {
      return c.json({ error: 'expectedRunId is required' }, 400);
    }
    result = deps.interruptAndRunFollowUp?.(
      chatJid,
      messageId,
      body.expectedRunId,
    );
  }
  if (!result) return c.json({ error: 'Follow-up action unavailable' }, 503);
  if (!result.ok) return c.json({ ...result, error: result.message }, 409);
  return c.json(result, 200);
});

// --- handleWebUserMessage ---

async function handleWebUserMessage(
  chatJid: string,
  content: string,
  attachments?: Array<{ type: 'image'; data: string; mimeType?: string }>,
  userId = 'web-user',
  displayName = 'Web',
  followUpBehavior: FollowUpMode = 'queue',
): Promise<
  | {
      ok: true;
      messageId: string;
      timestamp: string;
      disposition: 'started' | 'queued' | 'steered';
      runId?: string;
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
  const runtimeGroup = deps.resolveEffectiveGroup
    ? deps.resolveEffectiveGroup(group).effectiveGroup
    : group;
  const requiredFeishuCliAccountId =
    (runtimeGroup.executionMode || 'container') === 'container'
      ? resolveFeishuCliBoundAccountId({
          workspaceChannelAccountId: runtimeGroup.channel_account_id,
        })
      : null;

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
  const activeRunId = deps.queue.getActiveQueryId(chatJid);
  const effectiveFollowUpBehavior: FollowUpMode = followUpBehavior;
  // Both queue and steer remain durable until the active query reaches idle.
  // A steer requests a controlled interrupt below; it must not be released
  // early and injected into Claude as a best-effort queued_command attachment.
  const queueForLater = !!activeRunId;
  const deliveryStatus = activeRunId ? 'queued' : null;
  storeMessageDirect(
    messageId,
    chatJid,
    userId,
    displayName,
    content,
    timestamp,
    false,
    {
      attachments: attachmentsStr,
      meta: activeRunId
        ? {
            deliveryMode: effectiveFollowUpBehavior,
            deliveryStatus,
            deliveryRunId: activeRunId,
            deliveryUpdatedAt: timestamp,
          }
        : undefined,
    },
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
    delivery_mode: activeRunId ? effectiveFollowUpBehavior : null,
    delivery_status: deliveryStatus,
    delivery_run_id: activeRunId,
    delivery_updated_at: activeRunId ? timestamp : null,
  });

  if (group.created_by) {
    const owner = getUserById(group.created_by);
    if (owner && owner.role !== 'admin') {
      const accessResult = checkBillingAccess(group.created_by, owner.role);
      if (!accessResult.allowed) {
        if (queueForLater) {
          const deliveryUpdatedAt = new Date().toISOString();
          setMessageFollowUp(chatJid, messageId, {
            mode: effectiveFollowUpBehavior,
            // This input received a terminal billing response, so it belongs
            // in the transcript immediately before that response rather than
            // behaving like a user-cancelled queued message.
            status: 'released',
            runId: activeRunId,
          });
          broadcastFollowUpUpdate(chatJid, {
            id: messageId,
            delivery_status: 'released',
            delivery_run_id: activeRunId,
            delivery_updated_at: deliveryUpdatedAt,
          });
        }
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
        completeWebOutOfBandMessage(deps, chatJid, {
          timestamp,
          id: messageId,
        });
        deps.advanceGlobalCursor({ timestamp, id: messageId });
        return { ok: true, messageId, timestamp, disposition: 'started' };
      }
    }
  }

  if (queueForLater) {
    broadcastFollowUpUpdate(chatJid);
    deps.advanceGlobalCursor({ timestamp, id: messageId });
    if (effectiveFollowUpBehavior === 'steer') {
      const steerResult = await deps.promoteFollowUp?.(
        chatJid,
        messageId,
        activeRunId!,
      );
      return {
        ok: true,
        messageId,
        timestamp,
        disposition: steerResult?.ok ? 'steered' : 'queued',
        runId: activeRunId!,
      };
    }
    return {
      ok: true,
      messageId,
      timestamp,
      disposition: 'queued',
      runId: activeRunId,
    };
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
    !deps.queue.requiresFeishuCliContainerRestart(chatJid, {
      feishuCliAccountId: requiredFeishuCliAccountId,
    }) && deps.queue.hasActiveMainRunnerForMessage(chatJid);
  if (eagerExpandActive) {
    // Use the effective (sibling-resolved) group so non-home groups bound to a
    // home sibling inherit executionMode / customCwd / created_by — otherwise
    // buildWebExpandContext returns null on sibling JIDs and the active runner
    // ends up receiving the literal `/foo` slash command (#21 round-13 P2-3).
    const expandCtx = buildWebExpandContext(chatJid, runtimeGroup);
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
        completeWebOutOfBandMessage(deps, chatJid, replyCursor);
        deps.advanceGlobalCursor(replyCursor);
        return {
          ok: true,
          messageId,
          timestamp,
          disposition: activeRunId ? 'steered' : 'started',
          runId: activeRunId ?? undefined,
        };
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

  const formatted = deps.formatMessages([
    {
      id: messageId,
      chat_jid: chatJid,
      sender: userId,
      sender_name: displayName,
      content: sendContent,
      timestamp,
    },
  ]);

  // IPC-inject the message into the running agent process.  For home groups,
  // the reply route is dynamically updated via activeRouteUpdaters so we no
  // longer need to kill and restart the process (#99).
  let pipedToActive = false;
  const images = toAgentImages(normalizedAttachments);
  const updateRoute = deps.updateReplyRoute;
  const preAdmitRoute = deps.preAdmitReplyRoute;
  const sendResult = deps.queue.sendMessage(
    chatJid,
    formatted,
    images,
    (receipt) => {
      // IPC write succeeded — update reply route for home groups.
      // Web messages have no IM source, so clear the IM route.
      updateRoute?.(
        group.folder,
        null,
        receipt?.deliveryId,
        receipt?.cursor,
        receipt?.chatJid,
      );
    },
    chatJid,
    undefined,
    {
      chatJid,
      coveredCursors: [{ timestamp, id: messageId }],
      cursor: { timestamp, id: messageId },
    },
    undefined,
    (receipt) => preAdmitRoute?.(group.folder, null, receipt) ?? false,
    { feishuCliAccountId: requiredFeishuCliAccountId },
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
    deps.advanceNextPullCursorOnly(chatJid, { timestamp, id: messageId });
  }
  deps.advanceGlobalCursor({ timestamp, id: messageId });
  const startedRunId = deps.queue.getActiveQueryId(chatJid);
  return {
    ok: true,
    messageId,
    timestamp,
    disposition: activeRunId ? 'steered' : 'started',
    runId: activeRunId ?? startedRunId ?? undefined,
  };
}

// --- Auto-title for conversations ---

/** Extract a short title from the first user message content. */
function generateAutoTitle(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed || trimmed.startsWith('/')) return null;

  const text = markdownToPlainText(trimmed).replace(/\n+/g, ' ').trim();

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
  followUpBehavior: FollowUpMode = 'queue',
): Promise<
  | {
      ok: true;
      messageId: string;
      timestamp: string;
      disposition: 'started' | 'queued' | 'steered';
      runId?: string;
    }
  | { ok: false; status: 404 | 500; error: string }
> {
  if (!deps) {
    return { ok: false, status: 500, error: 'Server not initialized' };
  }

  const agent = getAgent(agentId);
  if (!agent || agent.kind !== 'conversation' || agent.chat_jid !== chatJid) {
    logger.warn(
      { chatJid, agentId },
      'Agent conversation message rejected: agent not found or not a conversation',
    );
    return { ok: false, status: 404, error: 'Agent not found' };
  }
  const parentGroup =
    deps.getRegisteredGroups()[chatJid] ?? getRegisteredGroup(chatJid);
  const runtimeParentGroup =
    parentGroup && deps.resolveEffectiveGroup
      ? deps.resolveEffectiveGroup(parentGroup).effectiveGroup
      : parentGroup;
  const requiredFeishuCliAccountId =
    runtimeParentGroup &&
    (runtimeParentGroup.executionMode || 'container') === 'container'
      ? resolveFeishuCliBoundAccountId({
          workspaceChannelAccountId: runtimeParentGroup.channel_account_id,
        })
      : null;

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
  const activeRunId = deps.queue.getActiveQueryId(virtualChatJid);
  const effectiveFollowUpBehavior: FollowUpMode = followUpBehavior;
  // Keep steering durable across the SDK interrupt boundary, exactly like the
  // workspace chat path above.
  const queueForLater = !!activeRunId;
  const deliveryStatus = activeRunId ? 'queued' : null;

  ensureChatExists(virtualChatJid);
  storeMessageDirect(
    messageId,
    virtualChatJid,
    userId,
    displayName,
    content,
    timestamp,
    false,
    {
      attachments: attachmentsStr,
      meta: activeRunId
        ? {
            deliveryMode: effectiveFollowUpBehavior,
            deliveryStatus,
            deliveryRunId: activeRunId,
            deliveryUpdatedAt: timestamp,
          }
        : undefined,
    },
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
      broadcastAgentStatus(
        chatJid,
        agentId,
        agent.status as AgentStatus,
        autoTitle,
        agent.prompt,
      );
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
      delivery_mode: activeRunId ? effectiveFollowUpBehavior : null,
      delivery_status: deliveryStatus,
      delivery_run_id: activeRunId,
      delivery_updated_at: activeRunId ? timestamp : null,
    },
    agentId,
  );

  if (queueForLater) {
    broadcastFollowUpUpdate(virtualChatJid);
    if (effectiveFollowUpBehavior === 'steer') {
      const steerResult = await deps.promoteFollowUp?.(
        virtualChatJid,
        messageId,
        activeRunId!,
      );
      return {
        ok: true,
        messageId,
        timestamp,
        disposition: steerResult?.ok ? 'steered' : 'queued',
        runId: activeRunId!,
      };
    }
    return {
      ok: true,
      messageId,
      timestamp,
      disposition: 'queued',
      runId: activeRunId,
    };
  }

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
    !deps.queue.requiresFeishuCliContainerRestart(virtualChatJid, {
      feishuCliAccountId: requiredFeishuCliAccountId,
    }) && deps.queue.hasActiveMainRunnerForMessage(virtualChatJid);
  if (eagerExpandAgentActive) {
    if (parentGroup) {
      // Use the effective (sibling-resolved) parent group so a non-home parent
      // bound to a home sibling expands plugins via the home's executionMode /
      // customCwd / created_by — otherwise buildWebExpandContext returns null
      // for the agent virtual JID and the active runner receives the raw
      // slash command (#21 round-13 P2-3).
      const expandParent = deps.resolveEffectiveGroup
        ? deps.resolveEffectiveGroup(parentGroup).effectiveGroup
        : parentGroup;
      const expandCtx = buildWebExpandContext(virtualChatJid, expandParent);
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
          completeWebOutOfBandMessage(deps, virtualChatJid, replyCursor);
          return {
            ok: true,
            messageId,
            timestamp,
            disposition: activeRunId ? 'steered' : 'started',
            runId: activeRunId ?? undefined,
          };
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
  const formatted = deps.formatMessages([
    {
      id: messageId,
      chat_jid: virtualChatJid,
      sender: userId,
      sender_name: displayName,
      content: agentSendContent,
      timestamp,
    },
  ]);

  // Try to pipe into running agent process
  const agentImages = toAgentImages(normalizedAttachments);
  const finalizeHeld = deps.finalizeHeldCard;
  const updateRoute = deps.updateReplyRoute;
  const preAdmitRoute = deps.preAdmitReplyRoute;
  const agentSendResult = deps.queue.sendMessage(
    virtualChatJid,
    formatted,
    agentImages,
    (receipt) => {
      // Route update owns both the durable warm turn and card rotation. Older
      // embedders without updateReplyRoute retain the legacy finalizer hook.
      if (updateRoute) {
        updateRoute(
          agent.group_folder,
          null,
          receipt?.deliveryId,
          receipt?.cursor,
          receipt?.chatJid,
          undefined,
          agentId,
        );
      } else {
        finalizeHeld?.(virtualChatJid);
      }
    },
    virtualChatJid,
    undefined,
    {
      chatJid: virtualChatJid,
      coveredCursors: [{ timestamp, id: messageId }],
      cursor: { timestamp, id: messageId },
    },
    undefined,
    (receipt) =>
      preAdmitRoute?.(agent.group_folder, null, receipt, agentId) ?? false,
    { feishuCliAccountId: requiredFeishuCliAccountId },
  );
  if (agentSendResult === 'sent') {
    deps.advanceNextPullCursorOnly(virtualChatJid, {
      timestamp,
      id: messageId,
    });
  }
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
        return deps!.processAgentConversation!(chatJid, agentId);
      });
    }
  }
  // 'sent' needs no further action
  const startedRunId = deps.queue.getActiveQueryId(virtualChatJid);
  return {
    ok: true,
    messageId,
    timestamp,
    disposition: activeRunId ? 'steered' : 'started',
    runId: activeRunId ?? startedRunId ?? undefined,
  };
}

// --- Static Files ---

// @hono/node-server 的 serveStatic 不支持条件请求：带 If-None-Match /
// If-Modified-Since 也永远返回 200 全量。中间反代若把响应降级为 no-cache
// （曾在生产实测发生），每次打开就要重下整个前端。这里按文件 stat 生成弱
// ETag，命中即 304 空体，作为缓存链路的兜底。
const STATIC_DIST_ROOT = path.resolve('./web/dist');
function conditionalStatic() {
  return async (
    c: Parameters<Parameters<typeof app.use>[1]>[0],
    next: () => Promise<void>,
  ) => {
    const relPath = decodeURIComponent(c.req.path);
    const filePath = path.resolve(path.join(STATIC_DIST_ROOT, relPath));
    // 防路径穿越：解析后必须仍在 dist 根内
    if (
      filePath.startsWith(STATIC_DIST_ROOT + path.sep) &&
      (c.req.method === 'GET' || c.req.method === 'HEAD')
    ) {
      try {
        const stat = fs.statSync(filePath);
        if (stat.isFile()) {
          const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
          const ifNoneMatch = c.req.header('if-none-match');
          const ifModifiedSince = c.req.header('if-modified-since');
          const notModified = ifNoneMatch
            ? ifNoneMatch === etag
            : ifModifiedSince
              ? stat.mtimeMs <= new Date(ifModifiedSince).getTime() + 999
              : false;
          if (notModified) {
            return c.body(null, 304, { ETag: etag });
          }
          await next();
          if (c.res.status === 200) c.res.headers.set('ETag', etag);
          return;
        }
      } catch {
        /* 不存在或不可读：交给 serveStatic 走正常 404 路径 */
      }
    }
    await next();
  };
}

// 带 content hash 的静态资源：长期不可变缓存
app.use(
  '/assets/*',
  async (c, next) => {
    await next();
    if (c.res.status === 200 || c.res.status === 304) {
      c.res.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
  conditionalStatic(),
  serveStatic({ root: './web/dist' }),
);

// 字体（16.2MB 中文字体族）与图标：内容事实上不可变（变更时改文件名），
// 缺缓存头曾导致每次打开全量重下。
app.use(
  '/fonts/*',
  async (c, next) => {
    await next();
    if (c.res.status === 200 || c.res.status === 304) {
      c.res.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    }
  },
  conditionalStatic(),
  serveStatic({ root: './web/dist' }),
);
app.use(
  '/icons/*',
  async (c, next) => {
    await next();
    if (c.res.status === 200 || c.res.status === 304) {
      c.res.headers.set('Cache-Control', 'public, max-age=2592000');
    }
  },
  conditionalStatic(),
  serveStatic({ root: './web/dist' }),
);

// SPA shell、manifest 和旧 Service Worker 清理脚本必须每次走网络。
app.use(
  '/*',
  async (c, next) => {
    await next();
    if (c.res.status === 200) {
      const p = c.req.path;
      // 非文件扩展名路径（SPA fallback → index.html）、SW 脚本、manifest 禁止缓存
      if (
        !p.match(/\.\w+$/) ||
        p === '/index.html' ||
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

// Origin 被 403 拒绝时，每个 origin 只 warn 一次，避免反复连接刷屏。
// 反向代理 + 公网域名场景下，管理员只能通过日志定位"为什么 WS 连不上"
// （前端只看到 onclose、后端默认静默 destroy socket），没有这行日志运维成本极高。
const warnedRejectedOrigins = new Set<string>();

function setupWebSocket(server: any): WebSocketServer {
  // 8 MiB 上限：覆盖单条消息含 10 张 5MB base64 image 的合法上限（~70MB 是
  // attachments 上限里的极端情形——通过 schema 上的 attachments.max(10) 控制
  // 而不是把 ws frame 单帧打到 100MB），也防止认证用户用单帧 OOM 服务器
  // （ws 库默认 100 MiB；详见 node_modules/ws/lib/websocket-server.js）。
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 8 * 1024 * 1024,
  });

  server.on('upgrade', (request: any, socket: any, head: any) => {
    const { pathname } = new URL(request.url, `http://${request.headers.host}`);

    if (pathname !== '/ws') {
      socket.destroy();
      return;
    }

    // Origin 校验：CORS 中间件不覆盖 WebSocket，浏览器对 WebSocket 也不发
    // CORS preflight。SameSite=Strict cookie 是当前的主防御，origin 检查
    // 是纵深防御 —— SameSite 实现不严的 UA / future SameSite=Lax 回退会
    // 直接暴露 CSWSH（跨站 WebSocket 劫持）。Origin 缺失（同源、无浏览器
    // origin）放行；同源放行；存在但不在白名单则拒绝。
    const origin = request.headers.origin as string | undefined;
    if (origin) {
      // 同源请求放行：比较 Origin 的 host 与 Host header
      const host = request.headers.host as string | undefined;
      let sameOrigin = false;
      if (host) {
        try {
          const originHost = new URL(origin).host;
          sameOrigin = originHost === host;
        } catch {
          /* invalid origin */
        }
      }
      if (!sameOrigin) {
        const allowed = isAllowedOrigin(origin);
        if (!allowed) {
          if (!warnedRejectedOrigins.has(origin)) {
            warnedRejectedOrigins.add(origin);
            logger.warn(
              {
                origin,
                hint: 'add this origin to CORS_ALLOWED_ORIGINS env var (comma-separated) or set it to "*" to allow all',
              },
              'WebSocket upgrade rejected: Origin not in allowlist (CSWSH defense)',
            );
          }
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }
      }
    }

    // Verify session cookie (HMAC signature + DB lookup).
    // WebSocket upgrade cannot return Set-Cookie, so legacy cookies are
    // accepted here but upgraded on the next HTTP request instead.
    const cookieHeader = request.headers.cookie as string | undefined;
    let allCookieValues = getAllCookieValues(
      cookieHeader,
      SESSION_COOKIE_NAME_SECURE,
    );
    if (allCookieValues.length === 0) {
      allCookieValues = getAllCookieValues(
        cookieHeader,
        SESSION_COOKIE_NAME_PLAIN,
      );
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
    // 强制改密码用户不能通过 WebSocket 发指令 / 操作终端，否则 HTTP 中
    // PASSWORD_CHANGE_REQUIRED 形同虚设——admin 重置密码后用户仍能继续与
    // agent 交互、开容器终端。HTTP 仍允许 /api/auth/me / /password / /sessions
    // 完成强制改密流程。
    if (session.must_change_password) {
      socket.write('HTTP/1.1 403 Password Change Required\r\n\r\n');
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
    const connSession = sessionId
      ? getCachedSessionWithUser(sessionId)
      : undefined;
    wsClients.set(ws, {
      sessionId: sessionId || '',
      userId: connSession?.user_id || '',
      role: (connSession?.role || 'member') as UserRole,
    });

    // Push an authoritative logical-run snapshot on every connection. A warm
    // agent process may be active while no query is running, so process
    // lifecycle (`active`) is not sufficient for restoring the composer and
    // stream card after a reconnect. This must precede stream_snapshot so the
    // client can fence each projection against its exact attempt.
    if (connSession && deps) {
      const userId = connSession.user_id;
      const queueStatus = deps.queue.getStatus();
      const runs: Array<{
        chatJid: string;
        runId: string;
        startedAt: string;
        phase: 'preparing' | 'running';
      }> = [];
      const queuedChatJids: string[] = [];
      for (const g of queueStatus.groups) {
        const baseJid = stripRuntimeJidSuffix(g.jid);
        const jid = normalizeRuntimeJid(g.jid);
        const allowed = getGroupAllowedUserIds(baseJid);
        if (allowed === null || !allowed.has(userId)) continue;
        // A pending message/retry timer has no exact attempt identity yet, so
        // it cannot be a `runs` entry: emitting runId:null would create a wait
        // state that can never receive a matching run_finished terminal. It
        // still has to reach the client, or a reload mid-queue shows an idle
        // composer and invites a duplicate send.
        if (!g.queryInFlight || !g.queryId) {
          if (g.pendingMessages) queuedChatJids.push(jid);
          continue;
        }
        const hasStreamSnapshot = streamingSnapshots.has(jid);
        runs.push({
          chatJid: jid,
          runId: g.queryId,
          startedAt: new Date(g.queryStartedAt ?? Date.now()).toISOString(),
          phase: hasStreamSnapshot ? 'running' : 'preparing',
        });
      }
      try {
        ws.send(
          JSON.stringify({
            type: 'active_run_snapshot',
            runs,
            queuedChatJids,
          } satisfies WsMessageOut),
        );
      } catch {
        /* client not ready */
      }
    }

    // Push streaming snapshots for active groups this user can access.
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
        // Skip empty or unowned snapshots. Every live query projection must
        // have a terminal-capable run identity before it can restore waiting.
        if (
          !snap.runId ||
          (!snap.partialText &&
            !snap.thinkingText &&
            snap.activeTools.length === 0 &&
            snap.recentEvents.length === 0 &&
            snap.traceEvents.length === 0 &&
            Object.keys(snap.taskStates).length === 0)
        ) {
          continue;
        }
        // Strip #agent: suffix for ACL lookup (virtual JIDs not in registered_groups)
        const baseJid = jid.includes('#agent:') ? jid.split('#agent:')[0] : jid;
        const allowed = getGroupAllowedUserIds(baseJid);
        if (allowed === null || !allowed.has(userId)) continue;
        try {
          ws.send(
            JSON.stringify({
              type: 'stream_snapshot',
              chatJid: jid,
              runId: snap.runId,
              snapshot: {
                partialText: snap.partialText,
                thinkingText: snap.thinkingText,
                activeTools: snap.activeTools,
                recentEvents: snap.recentEvents,
                traceEvents: snap.traceEvents,
                taskStates: snap.taskStates,
                todos: snap.todos,
                systemStatus: snap.systemStatus,
                isThinking: snap.isThinking,
                activeHook: snap.activeHook,
                turnId: snap.turnId,
              },
            } satisfies WsMessageOut),
          );
        } catch {
          /* client not ready */
        }
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
        // 与 upgrade 处一致：管理员重置密码后被强制改密的 session 不能继续
        // 操作 agent / 终端；ws.close(1008) 让前端收到关闭再走改密流程。
        if (session.must_change_password) {
          ws.close(1008, 'Password change required');
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
            followUpBehavior: msg.followUpBehavior,
          });
          if (!wsValidation.success) {
            sendWsError('消息格式无效', msg.chatJid);
            logger.warn(
              {
                chatJid: msg.chatJid,
                issues: wsValidation.error.issues.map((i) => i.message),
              },
              'WebSocket send_message validation failed',
            );
            return;
          }
          const { chatJid, content, attachments, followUpBehavior } =
            wsValidation.data;
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
                  userMsgId,
                  effectiveChatJid,
                  session.user_id,
                  session.display_name || session.username,
                  content.trim(),
                  userMsgTs,
                  false,
                  { meta: { sourceKind: 'user_command' } },
                );
                broadcastNewMessage(effectiveChatJid, {
                  id: userMsgId,
                  chat_jid: effectiveChatJid,
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
          // Permission: owner-only (canModifyGroup) — aligned with HTTP /clear
          // and `reset-session` route. /clear has the same destructive effect.
          // Success has no explicit ws_error/ack — the client sees the reset
          // through the broadcastNewMessage(context_reset) push from executeSessionReset.
          if (isClearCommand(content) && deps && targetGroup) {
            if (
              !canModifyGroup(
                { id: session.user_id, role: session.role },
                { ...targetGroup, jid: chatJid },
              )
            ) {
              sendWsError('Only the workspace owner can run /clear', chatJid);
              return;
            }
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
              logger.error({ chatJid, agentId, err }, '/clear command failed');
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
              followUpBehavior,
            );
            return;
          }

          const result = await handleWebUserMessage(
            chatJid,
            content.trim(),
            attachments,
            session.user_id,
            session.display_name || session.username,
            followUpBehavior,
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
 *   - null: ownership unresolvable → default-deny (drop for ALL recipients,
 *     including admin). 这是有意的硬拒绝，不区分角色，避免 ACL 解析失败时
 *     管理员意外看到本不该看的群组事件。注意先前文档说"only admin can see"
 *     与代码不一致，代码 default-deny 更安全所以保留代码、对齐注释。
 *   - Set<string>: only these workspace owners
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
    const invalid = !session || expired || session.status !== 'active';
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

    // Group isolation: only the workspace owner can see this group's events.
    // allowedUserIds === null means ownership unresolvable → default-deny EVERYONE
    // (including admin). 故意这样：解析失败时宁可不广播也不要意外泄漏。
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
 * Admin is not automatically included; the account must own the workspace.
 *
 * Returns:
 * - Set<string>: the owner user ID
 * - null: ownership unresolvable → default-deny
 */
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

function stripRuntimeJidSuffix(chatJid: string): string {
  const markerIndex = chatJid.indexOf('#agent:');
  return markerIndex >= 0 ? chatJid.slice(0, markerIndex) : chatJid;
}

/** Normalize the workspace part of a virtual conversation JID without losing
 * its #agent suffix. */
function normalizeRuntimeJid(chatJid: string): string {
  const markerIndex = chatJid.indexOf('#agent:');
  if (markerIndex < 0) return normalizeHomeJid(chatJid);
  const baseJid = chatJid.slice(0, markerIndex);
  return `${normalizeHomeJid(baseJid)}${chatJid.slice(markerIndex)}`;
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

export function broadcastFollowUpUpdate(
  chatJid: string,
  transition?: FollowUpTransition,
): void {
  let baseChatJid = chatJid;
  let agentId: string | undefined;
  if (chatJid.includes('#agent:')) {
    const parts = chatJid.split('#agent:');
    baseChatJid = parts[0];
    agentId = parts[1];
  }
  const jid = normalizeHomeJid(baseChatJid);
  const allowedUserIds = getGroupAllowedUserIds(baseChatJid);
  const items = listQueuedFollowUps(chatJid);
  const msg: WsMessageOut = {
    type: 'follow_up_update',
    chatJid: jid,
    items,
    ...(agentId ? { agentId } : {}),
    ...(transition ? { transition } : {}),
  };
  safeBroadcast(msg, isHostGroupJid(baseChatJid), allowedUserIds);
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
  thinkingText: string;
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
    kind:
      | 'tool'
      | 'skill'
      | 'hook'
      | 'status'
      | 'task'
      | 'memory'
      | 'debug'
      | 'permission';
  }>;
  traceEvents: Array<{
    id: string;
    timestamp: number;
    kind:
      | 'tool'
      | 'skill'
      | 'hook'
      | 'status'
      | 'task'
      | 'memory'
      | 'debug'
      | 'permission';
    scope?: StreamEvent['agentScope'];
    title: string;
    summary?: string;
    detail?: string;
    taskId?: string;
    toolUseId?: string;
    parentToolUseId?: string | null;
    displayLevel?: StreamEvent['displayLevel'];
  }>;
  taskStates: Record<
    string,
    {
      id: string;
      title: string;
      status: 'running' | 'completed' | 'error' | 'backgrounded';
      subagentType?: string;
      taskType?: string;
      workflowName?: string;
      workflowRun?: StreamEvent['workflowRun'];
      usage?: StreamEvent['sdkTaskUsage'];
      latestSummary?: string;
      lastToolName?: string;
      thinkingTail: string;
      textTail: string;
      activeTools: StreamingSnapshotEntry['activeTools'];
      recentTools: StreamingSnapshotEntry['recentEvents'];
      updatedAt: number;
    }
  >;
  todos?: Array<{ id: string; content: string; status: string }>;
  systemStatus: string | null;
  /** Whether the agent is mid-thinking (no text emitted yet) — kept in the
   *  snapshot so a WS reconnect restores the "思考中" indicator instead of a
   *  blank pause. */
  isThinking?: boolean;
  /** Currently-running hook, if any — restored on reconnect so the hook spinner
   *  survives the reconnect instead of silently disappearing. */
  activeHook?: { hookName: string; hookEvent: string } | null;
  turnId?: string;
  /** Exact GroupQueue attempt that owns this projection. */
  runId?: string;
  updatedAt: number;
}

const streamingSnapshots = new Map<string, StreamingSnapshotEntry>();
/** Exact query attempt currently projected for each runtime JID. This is
 * deliberately separate from process lifecycle: a conversation process may
 * stay warm while no query is active. */
const activeLogicalRuns = new Map<
  string,
  { runId: string; startedAt: number }
>();
const streamRunFence = new RunStreamFence();
/** runner idle 后的墓碑标记：阻止迟到 stream 事件重建已清理的快照。
 * key 为完整 normalizedJid（主 jid 或 `web:folder#agent:id` 虚拟 jid），
 * 与 runner/快照同粒度；下一个 run 的 'running' 状态清除。 */
const snapshotTombstones = new Map<string, number>();
const MAX_SNAPSHOT_TOMBSTONES = 500;
/** Accumulates full (non-truncated) text per group for shutdown persistence & disk buffer. */
const streamingFullTexts = new Map<string, string>();
const MAX_SNAPSHOT_TEXT = 4000;
const MAX_SNAPSHOT_THINKING = 8000;
const MAX_SNAPSHOT_EVENTS = 20;
const MAX_SNAPSHOT_TRACE_EVENTS = 200;
const MAX_SNAPSHOT_TASK_TAIL = 4000;

/** Push a recent event entry and truncate to MAX_SNAPSHOT_EVENTS. */
function pushRecentEvent(
  snap: StreamingSnapshotEntry,
  event: {
    id: string;
    timestamp: number;
    text: string;
    kind:
      | 'tool'
      | 'skill'
      | 'hook'
      | 'status'
      | 'task'
      | 'memory'
      | 'debug'
      | 'permission';
  },
): void {
  snap.recentEvents.push(event);
  if (snap.recentEvents.length > MAX_SNAPSHOT_EVENTS) {
    snap.recentEvents = snap.recentEvents.slice(-MAX_SNAPSHOT_EVENTS);
  }
}

function pushTraceEvent(
  snap: StreamingSnapshotEntry,
  event: StreamEvent,
): void {
  if (
    event.eventType === 'text_delta' ||
    event.eventType === 'thinking_delta' ||
    event.eventType === 'usage' ||
    event.eventType === 'init' ||
    event.eventType === 'context_audit' ||
    (event.eventType === 'status' &&
      isInternalLifecycleStatus(event.statusText))
  )
    return;
  const kind = event.eventType.startsWith('tool_')
    ? event.skillName
      ? 'skill'
      : 'tool'
    : event.eventType.startsWith('hook_')
      ? 'hook'
      : event.eventType.startsWith('task_')
        ? 'task'
        : event.eventType === 'memory_recall' ||
            event.eventType === 'compact_boundary'
          ? 'memory'
          : event.eventType === 'permission_denied'
            ? 'permission'
            : event.eventType === 'raw_sdk_event'
              ? 'debug'
              : 'status';
  const title =
    event.title ||
    event.summary ||
    event.taskSummary ||
    event.statusText ||
    event.toolName ||
    event.rawType ||
    event.eventType;
  snap.traceEvents.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    timestamp: Date.now(),
    kind,
    scope: event.agentScope,
    title,
    summary: event.summary || event.taskSummary || event.toolInputSummary,
    detail: event.detail,
    taskId: event.taskId,
    toolUseId: event.toolUseId,
    parentToolUseId: event.parentToolUseId,
    displayLevel: event.displayLevel,
  });
  if (snap.traceEvents.length > MAX_SNAPSHOT_TRACE_EVENTS) {
    snap.traceEvents = snap.traceEvents.slice(-MAX_SNAPSHOT_TRACE_EVENTS);
  }
}

function tailText(text: string, max: number): string {
  return text.length > max ? text.slice(-max) : text;
}

function isInternalLifecycleStatus(statusText?: string | null): boolean {
  return (
    statusText === 'requesting' ||
    statusText === 'compacting' ||
    statusText === 'idle' ||
    statusText === 'interrupted'
  );
}

function snapshotTaskId(event: StreamEvent): string | null {
  return (
    event.parentToolUseId ||
    event.taskId ||
    (event.eventType.startsWith('task_') ? event.toolUseId || null : null)
  );
}

function updateSnapshotTask(
  snap: StreamingSnapshotEntry,
  event: StreamEvent,
): void {
  const taskId = snapshotTaskId(event);
  if (!taskId) return;
  const task = snap.taskStates[taskId] || {
    id: taskId,
    title:
      event.taskDescription ||
      event.toolInputSummary ||
      event.summary ||
      'Task',
    status: 'running' as const,
    subagentType: event.subagentType,
    taskType: event.taskType,
    workflowName: event.workflowName,
    workflowRun: event.workflowRun,
    usage: event.sdkTaskUsage,
    thinkingTail: '',
    textTail: '',
    activeTools: [],
    recentTools: [],
    updatedAt: Date.now(),
  };
  task.updatedAt = Date.now();
  if (event.taskDescription && (!task.title || task.title === 'Task'))
    task.title = event.taskDescription;
  if (event.subagentType) task.subagentType = event.subagentType;
  if (event.taskType) task.taskType = event.taskType;
  if (event.workflowName) task.workflowName = event.workflowName;
  if (event.sdkTaskUsage) task.usage = event.sdkTaskUsage;
  if (event.workflowRun) {
    task.workflowRun = {
      ...(task.workflowRun ?? {}),
      ...event.workflowRun,
      phases:
        event.workflowRun.phases.length > 0
          ? event.workflowRun.phases
          : (task.workflowRun?.phases ?? []),
      agents:
        event.workflowRun.agents.length > 0
          ? event.workflowRun.agents
          : (task.workflowRun?.agents ?? []),
    };
  }
  if (event.eventType === 'text_delta') {
    task.textTail = tailText(
      task.textTail + (event.text || ''),
      MAX_SNAPSHOT_TASK_TAIL,
    );
  } else if (event.eventType === 'thinking_delta') {
    task.thinkingTail = tailText(
      task.thinkingTail + (event.text || ''),
      MAX_SNAPSHOT_TASK_TAIL,
    );
  } else if (event.eventType === 'task_progress') {
    task.latestSummary =
      event.summary ||
      event.taskSummary ||
      event.taskDescription ||
      task.latestSummary;
    task.lastToolName = event.lastToolName || task.lastToolName;
    task.status = 'running';
    if (task.workflowRun && event.sdkTaskUsage) {
      task.workflowRun = {
        ...task.workflowRun,
        status: 'running',
        totalTokens: event.sdkTaskUsage.totalTokens,
        totalToolCalls: event.sdkTaskUsage.toolUses,
        durationMs: event.sdkTaskUsage.durationMs,
      };
    }
  } else if (event.eventType === 'task_updated') {
    const patch = event.taskPatch;
    if (patch?.status === 'completed') task.status = 'completed';
    else if (patch?.status === 'failed' || patch?.status === 'killed')
      task.status = 'error';
    else if (patch?.is_backgrounded) task.status = 'backgrounded';
    task.latestSummary =
      event.summary || patch?.description || patch?.error || task.latestSummary;
  } else if (event.eventType === 'task_notification') {
    task.status = event.taskStatus === 'completed' ? 'completed' : 'error';
    task.latestSummary =
      event.taskSummary || event.summary || task.latestSummary;
    if (task.workflowRun) {
      task.workflowRun = {
        ...task.workflowRun,
        status: event.taskStatus === 'completed' ? 'completed' : 'failed',
        completedAt: task.workflowRun.completedAt ?? Date.now(),
      };
    }
  } else if (event.eventType === 'tool_use_start' && event.parentToolUseId) {
    const tool = {
      toolName: event.toolName || 'unknown',
      toolUseId: event.toolUseId || '',
      startTime: Date.now(),
      toolInputSummary: event.toolInputSummary,
      parentToolUseId: event.parentToolUseId,
    };
    task.activeTools = task.activeTools.some(
      (t) => t.toolUseId === tool.toolUseId && tool.toolUseId,
    )
      ? task.activeTools.map((t) =>
          t.toolUseId === tool.toolUseId ? { ...t, ...tool } : t,
        )
      : [...task.activeTools, tool];
  } else if (event.eventType === 'tool_use_end' && event.parentToolUseId) {
    task.activeTools = task.activeTools.filter(
      (t) => t.toolUseId !== event.toolUseId,
    );
  }
  snap.taskStates[taskId] = task;
}

function updateStreamingSnapshot(
  normalizedJid: string,
  event: StreamEvent,
  runId?: string,
): void {
  // Context audits are operator diagnostics. They must not enter user-facing
  // WebSocket snapshots, even if this helper is called outside the broadcaster.
  if (event.eventType === 'context_audit') return;

  // turn 干净结束（silent-success）：删除快照而非累积，避免 WS 重连恢复到
  // 「生成中」僵尸快照。前端收到同一 idle 事件后清 waiting/streaming。
  if (event.eventType === 'status' && event.statusText === 'idle') {
    // Legacy stream events do not carry GroupQueue's exact queryId. If another
    // query is already active for this JID, this may be a late idle from the
    // previous attempt and must not clear the new snapshot. The exact
    // run_finished event owns cleanup for the active attempt.
    if (activeLogicalRuns.has(normalizedJid)) return;
    streamingSnapshots.delete(normalizedJid);
    streamingFullTexts.delete(normalizedJid);
    return;
  }

  // 终态守卫：runner 已 idle（run 结束）后 outputChain 的迟到事件不得重建
  // 快照——重建出的「生成中」快照永远等不到清理，WS 重连/刷新会恢复出僵尸
  // 转圈。下一个 run 启动时 runner_state 'running' 会清掉 tombstone。
  // Web 客户端侧有对称的迟到守卫（chat.ts），此处补齐服务端快照的一侧。
  //
  // 键必须用完整 normalizedJid（含 #agent: 后缀），与 runner/快照同粒度：
  // 主 runner idle 只 tombstone `web:folder`，不会误杀并发 sub-agent /
  // 定时任务（虚拟 jid）的快照；agent runner idle tombstone 自己的
  // `web:folder#agent:id`，其迟到事件才能被自己的 tombstone 拦住。
  if (snapshotTombstones.has(normalizedJid)) return;

  let snap = streamingSnapshots.get(normalizedJid);

  // Reset on new turn
  if (snap?.turnId && event.turnId && snap.turnId !== event.turnId) {
    snap = undefined;
    streamingFullTexts.delete(normalizedJid);
  }

  if (!snap) {
    snap = {
      partialText: '',
      thinkingText: '',
      activeTools: [],
      recentEvents: [],
      traceEvents: [],
      taskStates: {},
      systemStatus: null,
      turnId: event.turnId,
      runId,
      updatedAt: Date.now(),
    };
  }

  snap.updatedAt = Date.now();
  if (event.turnId) snap.turnId = event.turnId;
  if (runId) snap.runId = runId;
  pushTraceEvent(snap, event);
  updateSnapshotTask(snap, event);

  switch (event.eventType) {
    case 'text_delta':
      if (event.text && !event.parentToolUseId) {
        // Real assistant text means the current thinking burst is over.
        snap.isThinking = false;
        snap.partialText += event.text;
        if (snap.partialText.length > MAX_SNAPSHOT_TEXT) {
          snap.partialText = snap.partialText.slice(-MAX_SNAPSHOT_TEXT);
        }
        // Accumulate full (non-truncated) text for shutdown persistence
        streamingFullTexts.set(
          normalizedJid,
          (streamingFullTexts.get(normalizedJid) || '') + event.text,
        );
      }
      break;

    case 'thinking_delta':
      if (event.text && !event.parentToolUseId) {
        snap.isThinking = true;
        snap.thinkingText += event.text;
        if (snap.thinkingText.length > MAX_SNAPSHOT_THINKING) {
          snap.thinkingText = snap.thinkingText.slice(-MAX_SNAPSHOT_THINKING);
        }
      }
      break;

    case 'tool_use_start':
      if (event.toolUseId && event.toolName) {
        // A tool call ends the current thinking burst.
        snap.isThinking = false;
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
        snap.activeTools = snap.activeTools.filter(
          (t) => t.toolUseId !== event.toolUseId,
        );
      }
      break;

    case 'tool_progress':
      if (event.toolUseId) {
        const tool = snap.activeTools.find(
          (t) => t.toolUseId === event.toolUseId,
        );
        if (tool) {
          if (event.toolInputSummary)
            tool.toolInputSummary = event.toolInputSummary;
        }
      }
      break;

    case 'task_start':
      pushRecentEvent(snap, {
        id: event.toolUseId || event.taskId || `task-${Date.now()}`,
        timestamp: Date.now(),
        text: `Task 启动: ${event.taskDescription || event.toolInputSummary || 'Task'}`,
        kind: 'task',
      });
      break;

    case 'task_progress':
      pushRecentEvent(snap, {
        id: `task-progress-${Date.now()}`,
        timestamp: Date.now(),
        text: `${event.lastToolName ? `Task 进度 [${event.lastToolName}]` : 'Task 进度'}: ${event.summary || event.taskDescription || ''}`,
        kind: 'task',
      });
      break;

    case 'task_notification':
      pushRecentEvent(snap, {
        id: `task-done-${event.taskId || Date.now()}`,
        timestamp: Date.now(),
        text: `Task ${event.taskStatus === 'completed' ? '完成' : '结束'}: ${event.taskSummary || event.summary || ''}`,
        kind: 'task',
      });
      break;

    case 'status':
      snap.systemStatus = event.statusText || null;
      if (event.statusText && !isInternalLifecycleStatus(event.statusText)) {
        pushRecentEvent(snap, {
          id: `status-${Date.now()}`,
          timestamp: Date.now(),
          text: event.statusText,
          kind: 'status',
        });
      }
      break;

    case 'hook_started':
      snap.activeHook = {
        hookName: event.hookName || '',
        hookEvent: event.hookEvent || '',
      };
      if (event.hookName) {
        pushRecentEvent(snap, {
          id: `hook-${Date.now()}`,
          timestamp: Date.now(),
          text: `${event.hookName} (${event.hookEvent || ''})`,
          kind: 'hook',
        });
      }
      break;

    case 'hook_progress':
      snap.activeHook = {
        hookName: event.hookName || '',
        hookEvent: event.hookEvent || '',
      };
      break;

    case 'hook_response':
      snap.activeHook = null;
      break;

    case 'memory_recall':
    case 'compact_boundary':
      pushRecentEvent(snap, {
        id: `${event.eventType}-${Date.now()}`,
        timestamp: Date.now(),
        text: event.summary || event.title || event.eventType,
        kind: 'memory',
      });
      break;

    case 'todo_update':
      if (event.todos) {
        snap.todos = event.todos.map((t) => ({
          id: t.id,
          content: t.content,
          status: t.status,
        }));
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
  // Keep runtime context audits on the server side. Sending them over the
  // user WebSocket exposes paths, prompt wiring, and framework terminology.
  if (event.eventType === 'context_audit') {
    if (event.contextAudit) {
      recordRunContextSnapshot({
        chatJid,
        agentId,
        turnId: event.turnId,
        sessionId: event.sessionId,
        audit: event.contextAudit,
      });
    }
    if (event.contextAudit?.warnings?.length) {
      logger.warn(
        { chatJid, warnings: event.contextAudit.warnings },
        'Agent context audit warning',
      );
    }
    return;
  }

  const jid = normalizeHomeJid(chatJid);
  const allowedUserIds = getGroupAllowedUserIds(chatJid);
  // Agent streams use virtual JID format (jid#agent:agentId) as the exact
  // query-lifecycle key. turnId ownership survives an A→B replacement so a
  // delayed callback from A cannot be relabelled as B.
  const snapshotJid = agentId ? `${jid}#agent:${agentId}` : jid;
  const decision = event.queryRunId
    ? streamRunFence.observeExact(snapshotJid, event.queryRunId, event.turnId)
    : streamRunFence.observe(snapshotJid, event.turnId);
  if (!decision.accepted) {
    logger.debug(
      {
        chatJid: snapshotJid,
        turnId: event.turnId,
        runId: decision.runId,
      },
      'Discarding stream event from superseded query attempt',
    );
    return;
  }
  const msg: WsMessageOut = agentId
    ? {
        type: 'stream_event',
        chatJid: jid,
        event,
        agentId,
        runId: decision.runId,
      }
    : {
        type: 'stream_event',
        chatJid: jid,
        event,
        runId: decision.runId,
      };
  safeBroadcast(msg, isHostGroupJid(chatJid), allowedUserIds);

  // Accumulate snapshot for both main and agent streams.
  updateStreamingSnapshot(snapshotJid, event, decision.runId);
}

export function broadcastGroupCreated(
  jid: string,
  folder: string,
  name: string,
  userId?: string,
): void {
  const allowedUserIds = userId ? new Set([userId]) : undefined;
  safeBroadcast(
    { type: 'group_created', jid, folder, name },
    false,
    allowedUserIds,
  );
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
  accountId: string,
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
    accountId,
    ...state,
  };
  const allowedUserIds = new Set([userId]);
  safeBroadcast(msg, false, allowedUserIds);
}

export function broadcastChannelAccountStatus(
  userId: string,
  accountId: string,
  state: {
    transportStatus: import('./types.js').ChannelTransportStatus;
    lastError?: string | null;
    connectedAt?: string | null;
    errorCode?: string;
    consecutiveFailures?: number;
    nextRetryMs?: number;
  },
): void {
  const msg: WsMessageOut = {
    type: 'channel_account_status',
    userId,
    accountId,
    ...state,
  };
  safeBroadcast(msg, false, new Set([userId]));
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
  broadcastAgentStatus(
    chatJid,
    agentId,
    'error',
    name,
    '',
    '__removed__',
    'conversation',
  );
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
  const baseJid = stripRuntimeJidSuffix(chatJid);
  const jid = normalizeRuntimeJid(chatJid);
  const allowedUserIds = getGroupAllowedUserIds(baseJid);
  const msg: WsMessageOut = {
    type: 'runner_state',
    chatJid: jid,
    state,
  };
  safeBroadcast(msg, isHostGroupJid(baseJid), allowedUserIds);
  if (state === 'idle') pruneOrphanedAgentSnapshots(jid);
}

/**
 * Drop sub-agent stream snapshots that no longer have a live run.
 *
 * `broadcastRunFinished` deletes only the exact JID whose runId matched, so a
 * sub-agent run ending without one — dropped before announceQueryStart, or a
 * runId mismatch — leaves its snapshot resident until the 30-minute staleness
 * sweep that runs on the next reconnect. Until then a reconnecting client can
 * restore a zombie "generating" card.
 *
 * Entries still in `activeLogicalRuns` are left alone: those are the live
 * sub-agents that the narrower deletion was introduced to protect.
 */
function pruneOrphanedAgentSnapshots(baseRuntimeJid: string): void {
  const prefix = `${baseRuntimeJid}#agent:`;
  for (const key of [...streamingSnapshots.keys()]) {
    if (!key.startsWith(prefix) || activeLogicalRuns.has(key)) continue;
    streamingSnapshots.delete(key);
    streamingFullTexts.delete(key);
  }
  for (const key of [...streamingFullTexts.keys()]) {
    if (!key.startsWith(prefix) || activeLogicalRuns.has(key)) continue;
    streamingFullTexts.delete(key);
  }
}

export function broadcastRunStarted(
  chatJid: string,
  runId: string,
  startedAt: number,
): void {
  const baseJid = stripRuntimeJidSuffix(chatJid);
  const jid = normalizeRuntimeJid(chatJid);
  const allowedUserIds = getGroupAllowedUserIds(baseJid);
  activeLogicalRuns.set(jid, { runId, startedAt });
  streamRunFence.start(jid, runId);
  // New exact attempt supersedes the previous attempt's late-event tombstone.
  snapshotTombstones.delete(jid);
  safeBroadcast(
    {
      type: 'run_started',
      chatJid: jid,
      runId,
      startedAt: new Date(startedAt).toISOString(),
      phase: 'preparing',
    },
    isHostGroupJid(baseJid),
    allowedUserIds,
  );
}

export function broadcastRunFinished(
  chatJid: string,
  runId: string,
  reason: RunFinishReason,
  finishedAt: number,
): void {
  const baseJid = stripRuntimeJidSuffix(chatJid);
  const jid = normalizeRuntimeJid(chatJid);
  const allowedUserIds = getGroupAllowedUserIds(baseJid);
  const current = activeLogicalRuns.get(jid);

  // Always publish the exact terminal event so clients can fence it. Only
  // mutate server-side projection when it still belongs to this attempt.
  safeBroadcast(
    {
      type: 'run_finished',
      chatJid: jid,
      runId,
      reason,
      finishedAt: new Date(finishedAt).toISOString(),
    },
    isHostGroupJid(baseJid),
    allowedUserIds,
  );

  if (current?.runId !== runId) return;
  activeLogicalRuns.delete(jid);
  streamRunFence.finish(jid, runId);
  streamingSnapshots.delete(jid);
  streamingFullTexts.delete(jid);
  snapshotTombstones.set(jid, finishedAt);
  if (snapshotTombstones.size > MAX_SNAPSHOT_TOMBSTONES) {
    for (const key of snapshotTombstones.keys()) {
      if (snapshotTombstones.size <= MAX_SNAPSHOT_TOMBSTONES) break;
      snapshotTombstones.delete(key);
    }
  }
}

export function broadcastDockerPullLog(line: string): void {
  safeBroadcast({ type: 'docker_pull_log', line }, true);
}

export function broadcastDockerPullComplete(
  success: boolean,
  error?: string,
): void {
  safeBroadcast({ type: 'docker_pull_complete', success, error }, true);
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

/**
 * Test-only factory: wires the given `WebDeps` into module + route state and
 * returns the fully-configured Hono `app` (every route is already mounted at
 * module load) so integration tests can exercise HTTP routes via
 * `app.request(...)` — most notably `POST /api/messages` and its `/clear`
 * interception — without starting the HTTP server, WebSocket server, container
 * exit callbacks, or the status-broadcast interval.
 *
 * Mirrors the dependency wiring in {@link startWebServer} minus all the
 * runtime side effects. NOT for production use.
 *
 * The supplied `webDeps` must be complete for the routes a test actually
 * drives — this only re-binds deps, it does not validate them, so a route that
 * reaches a `WebDeps` field the stub omits throws at request time (not at
 * construction). The current caller stays within the `/clear` ACL path, which
 * needs only `queue.stopGroup` / `getSessions` / `setLastAgentTimestamp`.
 */
export function createAppForTest(webDeps: WebDeps): typeof app {
  deps = webDeps;
  setWebDeps(webDeps);
  injectConfigDeps(webDeps);
  injectChannelAccountDeps(webDeps);
  injectMonitorDeps({
    broadcastDockerPullLog,
    broadcastDockerPullComplete,
  });
  return app;
}

export function startWebServer(webDeps: WebDeps): void {
  deps = webDeps;
  setWebDeps(webDeps);
  injectConfigDeps(webDeps);
  injectChannelAccountDeps(webDeps);
  injectMonitorDeps({
    broadcastDockerPullLog,
    broadcastDockerPullComplete,
  });

  httpServer = serve(
    {
      fetch: app.fetch,
      port: WEB_PORT,
      // Node HTTP server 默认 requestTimeout=300s（5min）会掐断慢速的大文件
      // 上传/下载。放宽到 10min，让大文件在一般网络下也能传完。
      // 取舍：requestTimeout 是服务器全局设置、对所有路由生效，且是"整个请求
      // 到达"的硬期限（收到数据也不重置），拉长必然同步放大 slow-POST 的连接
      // 占用窗口（此处 5min→10min，2×）。headersTimeout 仍为 60s，只挡
      // header-slowloris，挡不住慢速 body；暴露在不可信网络时应在前置反向代理
      // 上做 body 限速/超时。10min 是"支持大文件"与"限制 DoS 占用"的折中默认值。
      serverOptions: {
        requestTimeout: 10 * 60 * 1000,
        headersTimeout: 60 * 1000,
      },
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
  webDeps.queue.setOnQueryStart(broadcastRunStarted);
  webDeps.queue.setOnQueryFinish(broadcastRunFinished);

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
