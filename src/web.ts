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
import { authMiddleware } from './middleware/auth.js';

// Route modules
import authRoutes from './routes/auth.js';
import groupRoutes from './routes/groups.js';
import memoryRoutes from './routes/memory.js';
import configRoutes, { injectConfigDeps } from './routes/config.js';
import tasksRoutes from './routes/tasks.js';
import adminRoutes from './routes/admin.js';
import fileRoutes from './routes/files.js';
import monitorRoutes from './routes/monitor.js';
import skillsRoutes from './routes/skills.js';
import browseRoutes from './routes/browse.js';
import agentRoutes from './routes/agents.js';

// Database and types (only for handleWebUserMessage and broadcast)
import {
  ensureChatExists,
  getRegisteredGroup,
  getJidsByFolder,
  getSessionWithUser,
  storeMessageDirect,
  deleteUserSession,
  updateSessionLastActive,
  getGroupMembers,
  getAgent,
  isGroupShared,
} from './db.js';
import { isSessionExpired } from './auth.js';
import type { NewMessage, WsMessageOut, WsMessageIn, AuthUser, StreamEvent, UserRole } from './types.js';
import { WEB_PORT, SESSION_COOKIE_NAME } from './config.js';
import { CORS_ALLOWED_ORIGINS, CORS_ALLOW_LOCALHOST } from './environment.js';
import { logger } from './logger.js';

// --- App Setup ---

const app = new Hono<{ Variables: Variables }>();
const terminalManager = new TerminalManager();
const wsTerminals = new Map<WebSocket, string>(); // ws → groupJid
const terminalOwners = new Map<string, WebSocket>(); // groupJid → ws

function normalizeTerminalSize(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const intValue = Math.floor(value);
  if (intValue < min) return min;
  if (intValue > max) return max;
  return intValue;
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

function isAllowedOrigin(origin: string | undefined): string | null {
  if (!origin) return null; // same-origin requests
  // 环境变量设为 '*' 时允许所有来源
  if (CORS_ALLOWED_ORIGINS === '*') return origin;
  // 允许 localhost / 127.0.0.1 的任意端口（开发 & 自托管场景，可通过 CORS_ALLOW_LOCALHOST=false 关闭）
  if (CORS_ALLOW_LOCALHOST) {
    try {
      const url = new URL(origin);
      if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return origin;
    } catch { /* invalid origin */ }
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
app.route('/api/groups', agentRoutes); // Agent routes under /api/groups/:jid/agents
app.route('/api', monitorRoutes);

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

  const result = await handleWebUserMessage(chatJid, content.trim(), attachments, authUser.id, authUser.display_name || authUser.username);
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
  const attachmentsStr = attachments && attachments.length > 0 ? JSON.stringify(attachments) : undefined;
  storeMessageDirect(
    messageId,
    chatJid,
    userId,
    displayName,
    content,
    timestamp,
    false,
    attachmentsStr,
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

  const shared = !group.is_home && isGroupShared(group.folder);
  const formatted = deps.formatMessages([
    {
      id: messageId,
      chat_jid: chatJid,
      sender: userId,
      sender_name: displayName,
      content,
      timestamp,
    },
  ], shared);

  // For home chat, avoid piping into an active Feishu-driven run.
  // Force a new processing pass so reply channel can be decided correctly.
  let pipedToActive = false;
  if (group.is_home) {
    deps.queue.closeStdin(chatJid);
    deps.queue.enqueueMessageCheck(chatJid);
  } else {
    const images = attachments?.map((attachment) => ({
      data: attachment.data,
      mimeType: attachment.mimeType,
    }));
    const sent = deps.queue.sendMessage(chatJid, formatted, images);
    pipedToActive = sent;
    if (!sent) {
      deps.queue.enqueueMessageCheck(chatJid);
    }
  }

  // Only advance per-group cursor when we piped directly into a running container.
  // For queued processing, processGroupMessages must still see this message from DB.
  if (pipedToActive) {
    deps.setLastAgentTimestamp(chatJid, { timestamp, id: messageId });
  }
  deps.advanceGlobalCursor({ timestamp, id: messageId });
  return { ok: true, messageId, timestamp };
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
    logger.warn({ chatJid, agentId }, 'Agent conversation message rejected: agent not found or not a conversation');
    return;
  }

  const virtualChatJid = `${chatJid}#agent:${agentId}`;

  // Store message with virtual chat_jid
  const messageId = crypto.randomUUID();
  const timestamp = new Date().toISOString();
  const attachmentsStr = attachments && attachments.length > 0 ? JSON.stringify(attachments) : undefined;

  ensureChatExists(virtualChatJid);
  storeMessageDirect(
    messageId, virtualChatJid, userId, displayName, content, timestamp, false, attachmentsStr,
  );

  // Broadcast new_message with agentId so frontend routes to agent tab
  broadcastNewMessage(virtualChatJid, {
    id: messageId,
    chat_jid: virtualChatJid,
    sender: userId,
    sender_name: displayName,
    content,
    timestamp,
    is_from_me: false,
    attachments: attachmentsStr,
  }, agentId);

  // Format for agent
  const shared = false; // agent conversations are not shared
  const formatted = deps.formatMessages([{
    id: messageId,
    chat_jid: virtualChatJid,
    sender: userId,
    sender_name: displayName,
    content,
    timestamp,
  }], shared);

  // Try to pipe into running agent process
  const sent = deps.queue.sendMessage(virtualChatJid, formatted);
  if (!sent) {
    // No running process — start one via processAgentConversation
    if (deps.processAgentConversation) {
      const taskId = `agent-conv:${agentId}:${Date.now()}`;
      deps.queue.enqueueTask(virtualChatJid, taskId, async () => {
        await deps!.processAgentConversation!(chatJid, agentId);
      });
    }
  }
}

// --- Static Files ---

app.use('/assets/*', serveStatic({ root: './web/dist' }));
app.use(
  '/*',
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

    // Verify session cookie
    const cookies = parseCookie(request.headers.cookie);
    const token = cookies[SESSION_COOKIE_NAME];
    if (!token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const session = getSessionWithUser(token);
    if (!session) {
      lastActiveCache.delete(token);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (isSessionExpired(session.expires_at)) {
      deleteUserSession(token);
      lastActiveCache.delete(token);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (session.status !== 'active') {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (session.must_change_password) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
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
    const connSession = sessionId ? getSessionWithUser(sessionId) : undefined;
    wsClients.set(ws, {
      sessionId: sessionId || '',
      userId: connSession?.user_id || '',
      role: (connSession?.role || 'member') as UserRole,
    });

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

        const session = getSessionWithUser(sessionId);
        if (
          !session ||
          isSessionExpired(session.expires_at) ||
          session.status !== 'active' ||
          session.must_change_password
        ) {
          if (session && isSessionExpired(session.expires_at)) {
            deleteUserSession(sessionId);
          }
          lastActiveCache.delete(sessionId);
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

        if (msg.type === 'send_message') {
          const wsValidation = MessageCreateSchema.safeParse({
            chatJid: msg.chatJid,
            content: msg.content,
            attachments: msg.attachments,
          });
          if (!wsValidation.success) {
            return;
          }
          const { chatJid, content, attachments } = wsValidation.data;
          const agentId = (msg as { agentId?: string }).agentId;

          // 群组访问权限检查
          const targetGroup = getRegisteredGroup(chatJid);
          if (targetGroup) {
            if (!canAccessGroup({ id: session.user_id, role: session.role }, targetGroup)) {
              logger.warn(
                { chatJid, userId: session.user_id },
                'WebSocket send_message blocked: access denied',
              );
              return;
            }
            if (isHostExecutionGroup(targetGroup)) {
              if (session.role !== 'admin') {
                logger.warn(
                  { chatJid, userId: session.user_id },
                  'WebSocket send_message blocked: host mode requires admin',
                );
                return;
              }
            }
          }

          // Route to agent conversation handler if agentId is present
          if (agentId && deps) {
            await handleAgentConversationMessage(
              chatJid, agentId, content.trim(),
              session.user_id, session.display_name || session.username,
              attachments,
            );
            return;
          }

          const result = await handleWebUserMessage(chatJid, content.trim(), attachments, session.user_id, session.display_name || session.username);
          if (!result.ok) {
            logger.warn(
              { chatJid, status: result.status, error: result.error },
              'WebSocket message rejected',
            );
          }
        }

        else if (msg.type === 'terminal_start') {
          try {
            // Schema 验证
            const startValidation = TerminalStartSchema.safeParse(msg);
            if (!startValidation.success) {
              ws.send(JSON.stringify({ type: 'terminal_error', chatJid: msg.chatJid || '', error: '终端启动参数无效' }));
              return;
            }
            const chatJid = startValidation.data.chatJid.trim();
            if (!chatJid) {
              ws.send(JSON.stringify({ type: 'terminal_error', chatJid: '', error: 'chatJid 无效' }));
              return;
            }
            const group = deps.getRegisteredGroups()[chatJid];
            if (!group) {
              ws.send(JSON.stringify({ type: 'terminal_error', chatJid, error: '群组不存在' }));
              return;
            }
            // Permission: user must be able to access the group
            const groupWithJid = { ...group, jid: chatJid };
            if (!canAccessGroup({ id: session.user_id, role: session.role }, groupWithJid)) {
              ws.send(JSON.stringify({ type: 'terminal_error', chatJid, error: '无权访问该群组终端' }));
              return;
            }
            if ((group.executionMode || 'container') === 'host') {
              ws.send(JSON.stringify({ type: 'terminal_error', chatJid, error: '宿主机模式不支持终端' }));
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
                  ws.send(JSON.stringify({ type: 'terminal_output', chatJid, data }));
                }
              },
              (_exitCode, _signal) => {
                if (terminalOwners.get(chatJid) === ws) {
                  releaseTerminalOwnership(ws, chatJid);
                }
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: 'terminal_stopped', chatJid, reason: '终端进程已退出' }));
                }
              },
            );
            wsTerminals.set(ws, chatJid);
            terminalOwners.set(chatJid, ws);
            ws.send(JSON.stringify({ type: 'terminal_started', chatJid }));
          } catch (err) {
            logger.error({ err, chatJid: msg.chatJid }, 'Error starting terminal');
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
        }

        else if (msg.type === 'terminal_input') {
          const inputValidation = TerminalInputSchema.safeParse(msg);
          if (!inputValidation.success) {
            ws.send(JSON.stringify({ type: 'terminal_error', chatJid: msg.chatJid || '', error: '终端输入参数无效' }));
            return;
          }
          const ownerJid = wsTerminals.get(ws);
          if (ownerJid !== inputValidation.data.chatJid || terminalOwners.get(inputValidation.data.chatJid) !== ws) {
            ws.send(JSON.stringify({ type: 'terminal_error', chatJid: inputValidation.data.chatJid, error: '终端会话已失效' }));
            return;
          }
          terminalManager.write(inputValidation.data.chatJid, inputValidation.data.data);
        }

        else if (msg.type === 'terminal_resize') {
          const resizeValidation = TerminalResizeSchema.safeParse(msg);
          if (!resizeValidation.success) {
            ws.send(JSON.stringify({ type: 'terminal_error', chatJid: msg.chatJid || '', error: '终端调整参数无效' }));
            return;
          }
          const ownerJid = wsTerminals.get(ws);
          if (ownerJid !== resizeValidation.data.chatJid || terminalOwners.get(resizeValidation.data.chatJid) !== ws) {
            ws.send(JSON.stringify({ type: 'terminal_error', chatJid: resizeValidation.data.chatJid, error: '终端会话已失效' }));
            return;
          }
          const cols = normalizeTerminalSize(resizeValidation.data.cols, 80, 20, 300);
          const rows = normalizeTerminalSize(resizeValidation.data.rows, 24, 8, 120);
          terminalManager.resize(resizeValidation.data.chatJid, cols, rows);
        }

        else if (msg.type === 'terminal_stop') {
          const stopValidation = TerminalStopSchema.safeParse(msg);
          if (!stopValidation.success) {
            return;
          }
          const ownerJid = wsTerminals.get(ws);
          if (ownerJid !== stopValidation.data.chatJid || terminalOwners.get(stopValidation.data.chatJid) !== ws) {
            return;
          }
          terminalManager.stop(stopValidation.data.chatJid);
          releaseTerminalOwnership(ws, stopValidation.data.chatJid);
          ws.send(JSON.stringify({ type: 'terminal_stopped', chatJid: stopValidation.data.chatJid, reason: '用户关闭终端' }));
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
function safeBroadcast(msg: WsMessageOut, adminOnly = false, allowedUserIds?: Set<string> | null): void {
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

    const session = getSessionWithUser(clientInfo.sessionId);
    const expired = !!session && isSessionExpired(session.expires_at);
    const invalid =
      !session ||
      expired ||
      session.status !== 'active' ||
      session.must_change_password;
    if (invalid) {
      if (expired) {
        deleteUserSession(clientInfo.sessionId);
      }
      lastActiveCache.delete(clientInfo.sessionId);
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

    // Group isolation: only allowed users and admins can see this group's events
    // allowedUserIds === null means ownership unresolvable → default-deny (admin-only)
    if (allowedUserIds !== undefined && session.role !== 'admin') {
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
 * Includes the owner, all shared members, and always admins (handled in safeBroadcast).
 *
 * Returns:
 * - Set<string>: allowed user IDs (owner + shared members)
 * - null: ownership unresolvable → default-deny (admin-only)
 */
const allowedUserIdsCache = new Map<string, { ids: Set<string> | null; expiry: number }>();
const ALLOWED_CACHE_TTL = 10_000; // 10 seconds

function getGroupAllowedUserIds(chatJid: string): Set<string> | null {
  const now = Date.now();
  const cached = allowedUserIdsCache.get(chatJid);
  if (cached && cached.expiry > now) return cached.ids;

  const result = computeGroupAllowedUserIds(chatJid);
  allowedUserIdsCache.set(chatJid, { ids: result, expiry: now + ALLOWED_CACHE_TTL });
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
): void {
  // For virtual JIDs like "web:xxx#agent:yyy", extract base JID for broadcast
  const baseChatJid = chatJid.includes('#agent:') ? chatJid.split('#agent:')[0] : chatJid;
  const jid = normalizeHomeJid(baseChatJid);
  const allowedUserIds = getGroupAllowedUserIds(baseChatJid);
  const wsMsg: WsMessageOut = {
    type: 'new_message',
    chatJid: jid,
    message: { ...msg, is_from_me: msg.is_from_me ?? false },
    ...(agentId ? { agentId } : {}),
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

export function broadcastStreamEvent(chatJid: string, event: StreamEvent, agentId?: string): void {
  const jid = normalizeHomeJid(chatJid);
  const allowedUserIds = getGroupAllowedUserIds(chatJid);
  const msg: WsMessageOut = agentId
    ? { type: 'stream_event', chatJid: jid, event, agentId }
    : { type: 'stream_event', chatJid: jid, event };
  safeBroadcast(msg, isHostGroupJid(chatJid), allowedUserIds);
}

export function broadcastAgentStatus(
  chatJid: string,
  agentId: string,
  status: import('./types.js').AgentStatus,
  name: string,
  prompt: string,
  resultSummary?: string,
  kind?: import('./types.js').AgentKind,
): void {
  const jid = normalizeHomeJid(chatJid);
  const allowedUserIds = getGroupAllowedUserIds(chatJid);
  // Resolve kind from DB if not provided
  const resolvedKind = kind || getAgent(agentId)?.kind;
  const msg: WsMessageOut = { type: 'agent_status', chatJid: jid, agentId, status, kind: resolvedKind, name, prompt, resultSummary };
  safeBroadcast(msg, isHostGroupJid(chatJid), allowedUserIds);
}

function broadcastStatus(): void {
  if (!deps) return;

  const queueStatus = deps.queue.getStatus();
  // Broadcast aggregate system metrics only to admin users.
  // Non-admin users get per-user filtered metrics via REST /api/status.
  safeBroadcast({
    type: 'status_update',
    activeContainers: queueStatus.activeContainerCount,
    activeHostProcesses: queueStatus.activeHostProcessCount,
    activeTotal: queueStatus.activeCount,
    queueLength: queueStatus.waitingCount,
  }, /* adminOnly */ true);
}

// --- Server Startup ---

let statusInterval: ReturnType<typeof setInterval> | null = null;
let httpServer: ReturnType<typeof serve> | null = null;
let wss: WebSocketServer | null = null;

export function startWebServer(webDeps: WebDeps): void {
  deps = webDeps;
  setWebDeps(webDeps);
  injectConfigDeps(webDeps);

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
            JSON.stringify({ type: 'terminal_stopped', chatJid: groupJid, reason: '工作区已停止' }),
          );
        }
      }
    }
  });

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
    } catch { /* ignore */ }
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
