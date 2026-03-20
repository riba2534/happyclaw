/**
 * QQ Bot API v2 Connection Factory
 *
 * Implements QQ Bot connection using official API v2 protocol:
 * - OAuth Token management with auto-refresh
 * - WebSocket connection for receiving events
 * - REST API for sending messages
 * - Message deduplication (LRU 1000 / 30min TTL)
 *
 * Reference: https://github.com/sliverp/qqbot (QQ Bot API v2)
 */
import crypto from 'crypto';
import http from 'node:http';
import https from 'node:https';
import WebSocket from 'ws';
import { storeChatMetadata, storeMessageDirect, updateChatName } from './db.js';
import { broadcastNewMessage } from './web.js';
import { logger } from './logger.js';
import { saveDownloadedFile, MAX_FILE_SIZE } from './im-downloader.js';
import { detectImageMimeType } from './image-detector.js';
import { analyzeIntent } from './intent-analyzer.js';

// ─── Constants ──────────────────────────────────────────────────

const QQ_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const QQ_API_BASE = 'https://api.sgroup.qq.com';
const TOKEN_REFRESH_BUFFER_MS = 300_000; // refresh 5min before expiry
const MSG_DEDUP_MAX = 1000;
const MSG_DEDUP_TTL = 30 * 60 * 1000; // 30min
const MSG_SPLIT_LIMIT = 5000;
const RECONNECT_DELAY_MS = 5000;
const MAX_RECONNECT_ATTEMPTS = 10;

// Intents: PUBLIC_MESSAGES (C2C + group @bot)
const INTENTS = 1 << 25;

// WebSocket opcodes
const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

// ─── Types ──────────────────────────────────────────────────────

export interface QQConnectionConfig {
  appId: string;
  appSecret: string;
}

export interface QQConnectOpts {
  onReady?: () => void;
  onNewChat: (jid: string, name: string) => void;
  isChatAuthorized: (jid: string) => boolean;
  ignoreMessagesBefore?: number;
  onPairAttempt?: (
    jid: string,
    chatName: string,
    code: string,
  ) => Promise<boolean>;
  onCommand?: (chatJid: string, command: string) => Promise<string | null>;
  resolveGroupFolder?: (jid: string) => string | undefined;
  resolveEffectiveChatJid?: (
    chatJid: string,
  ) => { effectiveJid: string; agentId: string | null } | null;
  onAgentMessage?: (baseChatJid: string, agentId: string) => void;
  /** 中断 fast-path：消息到达时立即检测中断意图，绕过轮询延迟直接触发中断 */
  onInterruptRequest?: (
    chatJid: string,
    intent: 'stop' | 'correction',
  ) => void;
}

export interface QQConnection {
  connect(opts: QQConnectOpts): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(
    chatId: string,
    text: string,
    localImagePaths?: string[],
  ): Promise<void>;
  sendChatAction(chatId: string, action: 'typing'): Promise<void>;
  isConnected(): boolean;
}

interface TokenInfo {
  accessToken: string;
  expiresAt: number;
}

interface QQWsPayload {
  op: number;
  d?: any;
  s?: number;
  t?: string;
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Convert Markdown to QQ plain text.
 * QQ doesn't support Markdown natively, so strip formatting.
 */
function markdownToPlainText(md: string): string {
  let text = md;

  // Code blocks: keep content, remove fences
  text = text.replace(/```[\s\S]*?```/g, (match) => {
    return match.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
  });

  // Inline code: remove backticks
  text = text.replace(/`([^`]+)`/g, '$1');

  // Links: [text](url) → text (url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)');

  // Bold: **text** or __text__ → text
  text = text.replace(/\*\*(.+?)\*\*/g, '$1');
  text = text.replace(/__(.+?)__/g, '$1');

  // Strikethrough: ~~text~~ → text
  text = text.replace(/~~(.+?)~~/g, '$1');

  // Italic: *text* → text
  text = text.replace(/(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, '$1');

  // Headings: # text → text
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '$1');

  return text;
}

/**
 * Split text into chunks at safe boundaries.
 */
function splitTextChunks(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    let splitIdx = remaining.lastIndexOf('\n\n', limit);
    if (splitIdx < limit * 0.3) {
      splitIdx = remaining.lastIndexOf('\n', limit);
    }
    if (splitIdx < limit * 0.3) {
      splitIdx = remaining.lastIndexOf(' ', limit);
    }
    if (splitIdx < limit * 0.3) {
      splitIdx = limit;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
}

/**
 * Parse JID to determine chat type and extract openid.
 * qq:c2c:{user_openid} → { type: 'c2c', openid }
 * qq:group:{group_openid} → { type: 'group', openid }
 */
function parseQQChatId(
  chatId: string,
): { type: 'c2c' | 'group'; openid: string } | null {
  if (chatId.startsWith('c2c:')) {
    return { type: 'c2c', openid: chatId.slice(4) };
  }
  if (chatId.startsWith('group:')) {
    return { type: 'group', openid: chatId.slice(6) };
  }
  return null;
}

/** Check for interrupt intent on short messages and fire callback if matched. */
function checkInterruptFastPath(
  text: string,
  jid: string,
  onInterruptRequest: ((jid: string, intent: 'stop' | 'correction') => void) | undefined,
  source: string,
): void {
  if (!onInterruptRequest || text.length > 50) return;
  const intent = analyzeIntent(text);
  if (intent !== 'continue') {
    onInterruptRequest(jid, intent);
    logger.info({ jid, intent }, `Interrupt fast-path triggered from ${source}`);
  }
}

// ─── Factory Function ───────────────────────────────────────────

export function createQQConnection(config: QQConnectionConfig): QQConnection {
  // Token state
  let tokenInfo: TokenInfo | null = null;
  let tokenRefreshPromise: Promise<string> | null = null;

  // WebSocket state
  let ws: WebSocket | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let reconnectAttempts = 0;
  let lastSequence: number | null = null;
  let sessionId: string | null = null;
  let resumeGatewayUrl: string | null = null;
  let stopping = false;
  let readyFired = false;

  // Message deduplication
  const msgCache = new Map<string, number>();

  // Per-chat msg_seq counter for active messages
  const msgSeqCounters = new Map<string, number>();

  // Rate-limit rejection messages
  const rejectTimestamps = new Map<string, number>();
  const REJECT_COOLDOWN_MS = 5 * 60 * 1000;

  function isDuplicate(msgId: string): boolean {
    const now = Date.now();
    for (const [id, ts] of msgCache.entries()) {
      if (now - ts > MSG_DEDUP_TTL) {
        msgCache.delete(id);
      }
    }
    if (msgCache.size >= MSG_DEDUP_MAX) {
      const firstKey = msgCache.keys().next().value;
      if (firstKey) msgCache.delete(firstKey);
    }
    return msgCache.has(msgId);
  }

  function markSeen(msgId: string): void {
    msgCache.set(msgId, Date.now());
  }

  function getNextMsgSeq(chatId: string): number {
    const current = msgSeqCounters.get(chatId) ?? 0;
    const next = current + 1;
    msgSeqCounters.set(chatId, next);
    return next;
  }

  // ─── Token Management ──────────────────────────────────────

  async function getAccessToken(): Promise<string> {
    // Check cached token
    if (
      tokenInfo &&
      Date.now() < tokenInfo.expiresAt - TOKEN_REFRESH_BUFFER_MS
    ) {
      return tokenInfo.accessToken;
    }

    // Singleflight: reuse in-flight refresh
    if (tokenRefreshPromise) {
      return tokenRefreshPromise;
    }

    tokenRefreshPromise = refreshToken();
    try {
      return await tokenRefreshPromise;
    } finally {
      tokenRefreshPromise = null;
    }
  }

  async function refreshToken(): Promise<string> {
    const body = JSON.stringify({
      appId: config.appId,
      clientSecret: config.appSecret,
    });

    return new Promise<string>((resolve, reject) => {
      const url = new URL(QQ_TOKEN_URL);
      const req = https.request(
        {
          hostname: url.hostname,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            try {
              const data = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
              if (!data.access_token) {
                reject(
                  new Error(
                    `QQ token response missing access_token: ${JSON.stringify(data)}`,
                  ),
                );
                return;
              }
              const expiresIn = Number(data.expires_in) || 7200;
              tokenInfo = {
                accessToken: data.access_token,
                expiresAt: Date.now() + expiresIn * 1000,
              };
              logger.info({ expiresIn }, 'QQ access token refreshed');
              resolve(data.access_token);
            } catch (err) {
              reject(err);
            }
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  // ─── REST API ──────────────────────────────────────────────

  async function apiRequest<T = any>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const token = await getAccessToken();
    const url = new URL(path, QQ_API_BASE);
    const bodyStr = body ? JSON.stringify(body) : undefined;

    return new Promise<T>((resolve, reject) => {
      const req = https.request(
        {
          hostname: url.hostname,
          path: url.pathname + url.search,
          method,
          headers: {
            Authorization: `QQBot ${token}`,
            'Content-Type': 'application/json',
            ...(bodyStr
              ? { 'Content-Length': String(Buffer.byteLength(bodyStr)) }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf-8');
            try {
              const data = JSON.parse(text);
              if (res.statusCode && res.statusCode >= 400) {
                const errMsg = data.message || data.msg || text;
                reject(
                  new Error(
                    `QQ API ${method} ${path} failed (${res.statusCode}): ${errMsg}`,
                  ),
                );
                return;
              }
              resolve(data as T);
            } catch {
              if (res.statusCode && res.statusCode >= 400) {
                reject(
                  new Error(
                    `QQ API ${method} ${path} failed (${res.statusCode}): ${text}`,
                  ),
                );
              } else {
                // Some endpoints return empty body on success
                resolve({} as T);
              }
            }
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  async function getGatewayUrl(): Promise<string> {
    const data = await apiRequest<{ url: string }>('GET', '/gateway/bot');
    return data.url;
  }

  // ─── Message Sending ──────────────────────────────────────

  async function sendQQMessage(
    chatType: 'c2c' | 'group',
    openid: string,
    content: string,
  ): Promise<void> {
    const chatKey = `${chatType}:${openid}`;
    const msgSeq = getNextMsgSeq(chatKey);

    const endpoint =
      chatType === 'c2c'
        ? `/v2/users/${openid}/messages`
        : `/v2/groups/${openid}/messages`;

    await apiRequest('POST', endpoint, {
      content,
      msg_type: 0, // text
      msg_seq: msgSeq,
    });
  }

  // ─── File Download ─────────────────────────────────────────

  async function downloadQQImageAsBase64(
    url: string,
  ): Promise<{ base64: string; mimeType: string } | null> {
    try {
      const buffer = await new Promise<Buffer>((resolve, reject) => {
        const doRequest = (reqUrl: string, redirectCount: number = 0) => {
          if (redirectCount > 5) {
            reject(new Error('Too many redirects'));
            return;
          }
          const parsedUrl = new URL(reqUrl);
          const protocol = parsedUrl.protocol === 'https:' ? https : http;
          protocol
            .get(reqUrl, (res) => {
              if (
                res.statusCode &&
                res.statusCode >= 300 &&
                res.statusCode < 400 &&
                res.headers.location
              ) {
                doRequest(res.headers.location, redirectCount + 1);
                return;
              }
              const chunks: Buffer[] = [];
              let total = 0;
              res.on('data', (chunk: Buffer) => {
                total += chunk.length;
                if (total > MAX_FILE_SIZE) {
                  res.destroy(new Error('Image exceeds MAX_FILE_SIZE'));
                  return;
                }
                chunks.push(chunk);
              });
              res.on('end', () => resolve(Buffer.concat(chunks)));
              res.on('error', reject);
            })
            .on('error', reject);
        };
        doRequest(url);
      });

      if (buffer.length === 0) return null;
      const mimeType = detectImageMimeType(buffer);
      return { base64: buffer.toString('base64'), mimeType };
    } catch (err) {
      logger.warn({ err }, 'Failed to download QQ image as base64');
      return null;
    }
  }

  // ─── WebSocket Connection ─────────────────────────────────

  function clearTimers(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function sendWs(payload: QQWsPayload): void {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  function startHeartbeat(intervalMs: number): void {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      sendWs({ op: OP_HEARTBEAT, d: lastSequence });
    }, intervalMs);
  }

  async function connectWs(
    opts: QQConnectOpts,
    gatewayUrl: string,
    isResume: boolean = false,
  ): Promise<void> {
    if (stopping) return;

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      ws = new WebSocket(gatewayUrl);

      // Resolve once when session is ready (READY/RESUMED dispatched)
      const onSessionReady = (): void => {
        reconnectAttempts = 0;
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      ws.on('open', () => {
        logger.info(
          { gatewayUrl: gatewayUrl.slice(0, 50) },
          'QQ WebSocket connected',
        );
        // Don't reset reconnectAttempts here — wait until READY/RESUMED
      });

      ws.on('message', async (data) => {
        try {
          const payload: QQWsPayload = JSON.parse(data.toString());
          await handleWsMessage(payload, opts, gatewayUrl, onSessionReady);
        } catch (err) {
          logger.error({ err }, 'Error parsing QQ WebSocket message');
        }
      });

      ws.on('close', (code, reason) => {
        logger.info({ code, reason: reason.toString() }, 'QQ WebSocket closed');
        clearTimers();

        if (!settled) {
          settled = true;
          reject(new Error(`QQ WebSocket closed before ready: ${code}`));
        } else if (!stopping) {
          scheduleReconnect(opts);
        }
      });

      ws.on('error', (err) => {
        logger.error({ err }, 'QQ WebSocket error');
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
    });
  }

  async function handleWsMessage(
    payload: QQWsPayload,
    opts: QQConnectOpts,
    gatewayUrl: string,
    onSessionReady?: () => void,
  ): Promise<void> {
    switch (payload.op) {
      case OP_HELLO: {
        const heartbeatInterval = payload.d?.heartbeat_interval || 41250;
        startHeartbeat(heartbeatInterval);

        const token = await getAccessToken();
        if (sessionId) {
          // Resume existing session (after reconnect)
          sendWs({
            op: OP_RESUME,
            d: {
              token: `QQBot ${token}`,
              session_id: sessionId,
              seq: lastSequence,
            },
          });
        } else {
          // Fresh identify
          sendWs({
            op: OP_IDENTIFY,
            d: {
              token: `QQBot ${token}`,
              intents: INTENTS,
              shard: [0, 1],
            },
          });
        }
        break;
      }

      case OP_DISPATCH: {
        if (payload.s !== undefined) {
          lastSequence = payload.s;
        }

        const eventType = payload.t;
        const eventData = payload.d;

        if (eventType === 'READY') {
          sessionId = eventData.session_id;
          resumeGatewayUrl = gatewayUrl;
          logger.info({ sessionId }, 'QQ bot session ready');
          onSessionReady?.();
          if (!readyFired) {
            readyFired = true;
            opts.onReady?.();
          }
        } else if (eventType === 'RESUMED') {
          logger.info('QQ bot session resumed');
          onSessionReady?.();
        } else if (eventType === 'C2C_MESSAGE_CREATE') {
          await handleC2CMessage(eventData, opts);
        } else if (eventType === 'GROUP_AT_MESSAGE_CREATE') {
          await handleGroupMessage(eventData, opts);
        }
        break;
      }

      case OP_HEARTBEAT_ACK:
        // Heartbeat acknowledged, all good
        break;

      case OP_RECONNECT:
        logger.info('QQ server requested reconnect');
        ws?.close();
        break;

      case OP_INVALID_SESSION: {
        const canResume = payload.d === true;
        logger.warn({ canResume }, 'QQ invalid session');
        if (!canResume) {
          sessionId = null;
          lastSequence = null;
        }
        ws?.close();
        break;
      }

      default:
        logger.debug({ op: payload.op }, 'QQ unknown WebSocket opcode');
    }
  }

  function scheduleReconnect(opts: QQConnectOpts): void {
    if (stopping) return;
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      logger.error('QQ max reconnect attempts reached, giving up');
      return;
    }

    const delay = Math.min(
      RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempts),
      60000,
    );
    reconnectAttempts++;

    logger.info(
      { delay, attempt: reconnectAttempts },
      'QQ scheduling reconnect',
    );
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      if (stopping) return;

      try {
        if (sessionId && resumeGatewayUrl) {
          // Try to resume
          await connectWs(opts, resumeGatewayUrl, true);
        } else {
          // Fresh connection
          const url = await getGatewayUrl();
          await connectWs(opts, url, false);
        }
      } catch (err) {
        logger.error({ err }, 'QQ reconnect failed');
        scheduleReconnect(opts);
      }
    }, delay);
  }

  // ─── Event Handlers ───────────────────────────────────────

  async function handleC2CMessage(
    data: any,
    opts: QQConnectOpts,
  ): Promise<void> {
    try {
      const msgId = data.id;
      if (!msgId || isDuplicate(msgId)) return;
      markSeen(msgId);

      // Skip stale messages from before connection (hot-reload scenario)
      if (opts.ignoreMessagesBefore && data.timestamp) {
        const msgTime = new Date(data.timestamp).getTime();
        if (!isNaN(msgTime) && msgTime < opts.ignoreMessagesBefore) return;
      }

      const userOpenId = data.author?.id || data.author?.user_openid;
      if (!userOpenId) return;

      const jid = `qq:c2c:${userOpenId}`;
      const senderName = data.author?.username || `QQ用户`;
      const chatName = senderName;

      // Strip bot mention from content
      let content = (data.content || '').trim();

      // ── /pair <code> command ──
      const pairMatch = content.match(/^\/pair\s+(\S+)/i);
      if (pairMatch && opts.onPairAttempt) {
        const code = pairMatch[1];
        try {
          const success = await opts.onPairAttempt(jid, chatName, code);
          const reply = success
            ? '配对成功！此聊天已连接到你的账号。'
            : '配对码无效或已过期，请在 Web 设置页重新生成。';
          await sendQQMessage('c2c', userOpenId, reply);
        } catch (err) {
          logger.error({ err, jid }, 'QQ pair attempt error');
          await sendQQMessage('c2c', userOpenId, '配对失败，请稍后重试。');
        }
        return;
      }

      // ── Authorization check ──
      if (!opts.isChatAuthorized(jid)) {
        const now = Date.now();
        const lastReject = rejectTimestamps.get(jid) ?? 0;
        if (now - lastReject >= REJECT_COOLDOWN_MS) {
          rejectTimestamps.set(jid, now);
          await sendQQMessage(
            'c2c',
            userOpenId,
            '此聊天尚未配对。请发送 /pair <code> 进行配对。\n' +
              '你可以在 Web 设置页生成配对码。',
          );
        }
        return;
      }

      // ── Authorized: process message ──
      storeChatMetadata(jid, new Date().toISOString());
      updateChatName(jid, chatName);
      opts.onNewChat(jid, chatName);

      // Handle slash commands
      const slashMatch = content.match(/^\/(\S+)(?:\s+(.*))?$/i);
      if (slashMatch && opts.onCommand) {
        const cmdBody = (
          slashMatch[1] + (slashMatch[2] ? ' ' + slashMatch[2] : '')
        ).trim();
        try {
          const reply = await opts.onCommand(jid, cmdBody);
          if (reply) {
            await sendQQMessage('c2c', userOpenId, markdownToPlainText(reply));
            return;
          }
        } catch (err) {
          logger.error({ jid, err }, 'QQ slash command failed');
          await sendQQMessage('c2c', userOpenId, '命令执行失败，请稍后重试');
          return;
        }
      }

      // Handle attachments (images)
      let attachmentsJson: string | undefined;
      if (data.attachments?.length) {
        const attachment = data.attachments[0];
        if (attachment.url) {
          const imageUrl = attachment.url.startsWith('http')
            ? attachment.url
            : `https://${attachment.url}`;
          const imageData = await downloadQQImageAsBase64(imageUrl);

          if (imageData) {
            attachmentsJson = JSON.stringify([
              {
                type: 'image',
                data: imageData.base64,
                mimeType: imageData.mimeType,
              },
            ]);

            const groupFolder = opts.resolveGroupFolder?.(jid);
            if (groupFolder) {
              const extMap: Record<string, string> = {
                'image/jpeg': '.jpg',
                'image/png': '.png',
                'image/gif': '.gif',
                'image/webp': '.webp',
              };
              const ext = extMap[imageData.mimeType] ?? '.jpg';
              const fileName = `qq_img_${msgId.slice(-8)}${ext}`;
              try {
                const relPath = await saveDownloadedFile(
                  groupFolder,
                  'qq',
                  fileName,
                  Buffer.from(imageData.base64, 'base64'),
                );
                if (relPath) content = `[图片: ${relPath}]\n${content}`.trim();
              } catch (err) {
                logger.warn({ err }, 'Failed to save QQ image to disk');
              }
            }

            if (!content) content = '[图片]';
          }
        }
      }

      // Route and store message
      const agentRouting = opts.resolveEffectiveChatJid?.(jid);
      const targetJid = agentRouting?.effectiveJid ?? jid;

      // ── 中断 fast-path（使用路由后的 targetJid） ──
      checkInterruptFastPath(content, targetJid, opts.onInterruptRequest, 'QQ C2C');

      const id = crypto.randomUUID();
      let timestamp: string;
      try {
        timestamp = data.timestamp
          ? new Date(data.timestamp).toISOString()
          : new Date().toISOString();
      } catch {
        timestamp = new Date().toISOString();
      }
      const senderId = `qq:${userOpenId}`;
      storeChatMetadata(targetJid, timestamp);
      storeMessageDirect(
        id,
        targetJid,
        senderId,
        senderName,
        content,
        timestamp,
        false,
        { attachments: attachmentsJson, sourceJid: jid },
      );

      broadcastNewMessage(
        targetJid,
        {
          id,
          chat_jid: targetJid,
          source_jid: jid,
          sender: senderId,
          sender_name: senderName,
          content,
          timestamp,
          attachments: attachmentsJson,
          is_from_me: false,
        },
        agentRouting?.agentId ?? undefined,
      );

      if (agentRouting?.agentId) {
        opts.onAgentMessage?.(jid, agentRouting.agentId);
        logger.info(
          { jid, effectiveJid: targetJid, agentId: agentRouting.agentId },
          'QQ C2C message routed to agent',
        );
      } else {
        logger.info(
          { jid, sender: senderName, msgId },
          'QQ C2C message stored',
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error handling QQ C2C message');
    }
  }

  async function handleGroupMessage(
    data: any,
    opts: QQConnectOpts,
  ): Promise<void> {
    try {
      const msgId = data.id;
      if (!msgId || isDuplicate(msgId)) return;
      markSeen(msgId);

      // Skip stale messages from before connection (hot-reload scenario)
      if (opts.ignoreMessagesBefore && data.timestamp) {
        const msgTime = new Date(data.timestamp).getTime();
        if (!isNaN(msgTime) && msgTime < opts.ignoreMessagesBefore) return;
      }

      const groupOpenId = data.group_openid;
      if (!groupOpenId) return;

      const jid = `qq:group:${groupOpenId}`;
      const memberOpenId = data.author?.member_openid;
      const senderName = data.author?.username || `QQ群成员`;
      const chatName = `QQ群 ${groupOpenId.slice(0, 8)}`;

      // Strip bot mention text (e.g. <@!bot_id>)
      let content = (data.content || '').replace(/<@!\w+>/g, '').trim();

      // ── /pair <code> command ──
      const pairMatch = content.match(/^\/pair\s+(\S+)/i);
      if (pairMatch && opts.onPairAttempt) {
        const code = pairMatch[1];
        try {
          const success = await opts.onPairAttempt(jid, chatName, code);
          const reply = success
            ? '配对成功！此群聊已连接。'
            : '配对码无效或已过期，请在 Web 设置页重新生成。';
          await sendQQMessage('group', groupOpenId, reply);
        } catch (err) {
          logger.error({ err, jid }, 'QQ group pair attempt error');
          await sendQQMessage('group', groupOpenId, '配对失败，请稍后重试。');
        }
        return;
      }

      // ── Authorization check ──
      if (!opts.isChatAuthorized(jid)) {
        const now = Date.now();
        const lastReject = rejectTimestamps.get(jid) ?? 0;
        if (now - lastReject >= REJECT_COOLDOWN_MS) {
          rejectTimestamps.set(jid, now);
          await sendQQMessage(
            'group',
            groupOpenId,
            '此群聊尚未配对。请发送 /pair <code> 进行配对。',
          );
        }
        return;
      }

      // ── Authorized: process message ──
      storeChatMetadata(jid, new Date().toISOString());
      updateChatName(jid, chatName);
      opts.onNewChat(jid, chatName);

      // Handle slash commands
      const slashMatch = content.match(/^\/(\S+)(?:\s+(.*))?$/i);
      if (slashMatch && opts.onCommand) {
        const cmdBody = (
          slashMatch[1] + (slashMatch[2] ? ' ' + slashMatch[2] : '')
        ).trim();
        try {
          const reply = await opts.onCommand(jid, cmdBody);
          if (reply) {
            await sendQQMessage(
              'group',
              groupOpenId,
              markdownToPlainText(reply),
            );
            return;
          }
        } catch (err) {
          logger.error({ jid, err }, 'QQ group slash command failed');
          await sendQQMessage('group', groupOpenId, '命令执行失败，请稍后重试');
          return;
        }
      }

      // Handle attachments
      let attachmentsJson: string | undefined;
      if (data.attachments?.length) {
        const attachment = data.attachments[0];
        if (attachment.url) {
          const imageUrl = attachment.url.startsWith('http')
            ? attachment.url
            : `https://${attachment.url}`;
          const imageData = await downloadQQImageAsBase64(imageUrl);

          if (imageData) {
            attachmentsJson = JSON.stringify([
              {
                type: 'image',
                data: imageData.base64,
                mimeType: imageData.mimeType,
              },
            ]);

            const groupFolder = opts.resolveGroupFolder?.(jid);
            if (groupFolder) {
              const extMap: Record<string, string> = {
                'image/jpeg': '.jpg',
                'image/png': '.png',
                'image/gif': '.gif',
                'image/webp': '.webp',
              };
              const ext = extMap[imageData.mimeType] ?? '.jpg';
              const fileName = `qq_img_${msgId.slice(-8)}${ext}`;
              try {
                const relPath = await saveDownloadedFile(
                  groupFolder,
                  'qq',
                  fileName,
                  Buffer.from(imageData.base64, 'base64'),
                );
                if (relPath) content = `[图片: ${relPath}]\n${content}`.trim();
              } catch (err) {
                logger.warn({ err }, 'Failed to save QQ group image');
              }
            }

            if (!content) content = '[图片]';
          }
        }
      }

      // Route and store
      const agentRouting = opts.resolveEffectiveChatJid?.(jid);
      const targetJid = agentRouting?.effectiveJid ?? jid;

      // ── 中断 fast-path（使用路由后的 targetJid） ──
      checkInterruptFastPath(content, targetJid, opts.onInterruptRequest, 'QQ group');

      const id = crypto.randomUUID();
      let timestamp: string;
      try {
        timestamp = data.timestamp
          ? new Date(data.timestamp).toISOString()
          : new Date().toISOString();
      } catch {
        timestamp = new Date().toISOString();
      }
      const senderId = memberOpenId ? `qq:${memberOpenId}` : 'qq:unknown';
      storeChatMetadata(targetJid, timestamp);
      storeMessageDirect(
        id,
        targetJid,
        senderId,
        senderName,
        content,
        timestamp,
        false,
        { attachments: attachmentsJson, sourceJid: jid },
      );

      broadcastNewMessage(
        targetJid,
        {
          id,
          chat_jid: targetJid,
          source_jid: jid,
          sender: senderId,
          sender_name: senderName,
          content,
          timestamp,
          attachments: attachmentsJson,
          is_from_me: false,
        },
        agentRouting?.agentId ?? undefined,
      );

      if (agentRouting?.agentId) {
        opts.onAgentMessage?.(jid, agentRouting.agentId);
      }

      logger.info(
        { jid, sender: senderName, msgId },
        'QQ group message stored',
      );
    } catch (err) {
      logger.error({ err }, 'Error handling QQ group message');
    }
  }

  // ─── Connection Interface ─────────────────────────────────

  const connection: QQConnection = {
    async connect(opts: QQConnectOpts): Promise<void> {
      if (!config.appId || !config.appSecret) {
        logger.info('QQ appId/appSecret not configured, skipping');
        return;
      }

      stopping = false;
      readyFired = false;
      reconnectAttempts = 0;
      sessionId = null;
      lastSequence = null;

      try {
        // Validate token first
        await getAccessToken();

        // Get gateway and connect WebSocket
        const gatewayUrl = await getGatewayUrl();
        await connectWs(opts, gatewayUrl, false);
      } catch (err) {
        logger.error({ err }, 'QQ initial connection failed');
        scheduleReconnect(opts);
      }
    },

    async disconnect(): Promise<void> {
      stopping = true;
      clearTimers();

      if (ws) {
        try {
          ws.close(1000, 'Disconnecting');
        } catch (err) {
          logger.debug({ err }, 'Error closing QQ WebSocket');
        }
        ws = null;
      }

      tokenInfo = null;
      sessionId = null;
      lastSequence = null;
      resumeGatewayUrl = null;
      msgCache.clear();
      msgSeqCounters.clear();
      rejectTimestamps.clear();
      logger.info('QQ bot disconnected');
    },

    async sendMessage(chatId: string, text: string): Promise<void> {
      const parsed = parseQQChatId(chatId);
      if (!parsed) {
        logger.error({ chatId }, 'Invalid QQ chat ID format');
        return;
      }

      try {
        const plainText = markdownToPlainText(text);
        const chunks = splitTextChunks(plainText, MSG_SPLIT_LIMIT);

        for (const chunk of chunks) {
          await sendQQMessage(parsed.type, parsed.openid, chunk);
        }

        logger.info({ chatId }, 'QQ message sent');
      } catch (err) {
        logger.error({ err, chatId }, 'Failed to send QQ message');
        throw err;
      }
    },

    async sendChatAction(_chatId: string, _action: 'typing'): Promise<void> {
      // QQ Bot API v2 does not support typing indicators
    },

    isConnected(): boolean {
      return ws !== null && ws.readyState === WebSocket.OPEN;
    },
  };

  return connection;
}
