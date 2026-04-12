/**
 * WeChat iLink Bot API Connection Factory
 *
 * Implements WeChat Bot connection using iLink Bot API protocol:
 * - Long-polling message reception (getupdates)
 * - Message sending with context_token (sendmessage)
 * - Typing indicator (getconfig + sendtyping)
 * - CDN image download + AES decryption
 * - Message deduplication (LRU 1000 / 30min TTL)
 *
 * Base URL: https://ilinkai.weixin.qq.com
 * CDN URL:  https://novac2c.cdn.weixin.qq.com/c2c
 */
import crypto from 'crypto';
import {
  storeChatMetadata,
  storeMessageDirect,
  updateChatName,
} from './db.js';
import { notifyNewImMessage } from './message-notifier.js';
import { broadcastNewMessage } from './web.js';
import { logger } from './logger.js';
import { saveDownloadedFile, MAX_FILE_SIZE } from './im-downloader.js';
import { detectImageMimeType } from './image-detector.js';
import { downloadAndDecryptMedia, uploadMediaBuffer } from './wechat-crypto.js';
import { markdownToPlainText, splitTextChunks } from './im-utils.js';

// ─── Constants ──────────────────────────────────────────────────

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const DEFAULT_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

const MSG_DEDUP_MAX = 1000;
const MSG_DEDUP_TTL = 30 * 60 * 1000; // 30min
const MSG_SPLIT_LIMIT = 2000; // WeChat has stricter text limits than other channels

const LONGPOLL_EXTRA_TIMEOUT_MS = 5000;
const DEFAULT_LONGPOLL_TIMEOUT_MS = 35000;

const RECONNECT_MIN_DELAY_MS = 3000;
const RECONNECT_MAX_DELAY_MS = 60000;

const IMAGE_MAX_BASE64_SIZE = 5 * 1024 * 1024; // 5 MB for inline base64

const CHANNEL_VERSION = '0.1.0';

// iLink message types
// const MESSAGE_TYPE_USER = 1;
const MESSAGE_TYPE_BOT = 2;

// iLink message item types
const MESSAGE_ITEM_TYPE_TEXT = 1;
const MESSAGE_ITEM_TYPE_IMAGE = 2;
// const MESSAGE_ITEM_TYPE_VOICE = 3;
const MESSAGE_ITEM_TYPE_FILE = 4;
// const MESSAGE_ITEM_TYPE_VIDEO = 5;

// iLink message state
// const MESSAGE_STATE_NEW = 0;
// const MESSAGE_STATE_GENERATING = 1;
const MESSAGE_STATE_FINISH = 2;

// errcode for session expired
const ERRCODE_SESSION_EXPIRED = -14;

// ─── Types ──────────────────────────────────────────────────────

export interface WeChatConnectionConfig {
  botToken: string;
  ilinkBotId: string;
  baseUrl?: string;
  cdnBaseUrl?: string;
  getUpdatesBuf?: string;
}

export interface WeChatConnectOpts {
  onReady?: () => void;
  onNewChat: (jid: string, name: string) => void;
  ignoreMessagesBefore?: number;
  onCommand?: (chatJid: string, command: string) => Promise<string | null>;
  resolveGroupFolder?: (jid: string) => string | undefined;
  resolveEffectiveChatJid?: (
    chatJid: string,
  ) => { effectiveJid: string; agentId: string | null } | null;
  onAgentMessage?: (baseChatJid: string, agentId: string) => void;
}

export interface WeChatConnection {
  connect(opts: WeChatConnectOpts): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(
    chatId: string,
    text: string,
    localImagePaths?: string[],
  ): Promise<void>;
  sendImage(
    chatId: string,
    imageBuffer: Buffer,
    mimeType: string,
    caption?: string,
    fileName?: string,
  ): Promise<void>;
  sendTyping(chatId: string, isTyping: boolean): Promise<void>;
  isConnected(): boolean;
  getUpdatesBuf(): string;
}

interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  session_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: MessageItem[];
  context_token?: string;
}

interface MessageItem {
  type?: number;
  text_item?: { text?: string };
  image_item?: { media?: CDNMedia; aeskey?: string; url?: string };
  voice_item?: { media?: CDNMedia; text?: string };
  file_item?: { media?: CDNMedia; file_name?: string };
  video_item?: { media?: CDNMedia };
  ref_msg?: { message_item?: MessageItem; title?: string };
}

interface CDNMedia {
  encrypt_query_param?: string;
  aes_key?: string;
}

interface GetUpdatesResponse {
  ret?: number;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Generate random X-WECHAT-UIN header value.
 * A random uint32 converted to string, then base64-encoded.
 */
function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}


/**
 * Extract text content from message item_list.
 * Includes voice-to-text transcription and fallback labels for non-text items.
 */
function extractTextContent(items: MessageItem[]): string {
  const parts: string[] = [];
  for (const item of items) {
    if (item.type === MESSAGE_ITEM_TYPE_TEXT && item.text_item?.text) {
      parts.push(item.text_item.text);
    } else if (item.type === MESSAGE_ITEM_TYPE_IMAGE) {
      // Image placeholder — actual image is handled separately via CDN download
      // Only add placeholder if no CDN media to download
      if (!item.image_item?.media?.encrypt_query_param) {
        parts.push('(image)');
      }
    } else if (item.type === 3 /* VOICE */) {
      // Voice: prefer speech-to-text transcription
      if (item.voice_item?.text) {
        parts.push(item.voice_item.text);
      } else {
        parts.push('(voice)');
      }
    } else if (item.type === MESSAGE_ITEM_TYPE_FILE) {
      // Only add placeholder if no CDN media to download
      // (processFileItem will generate a [文件: ...] prefix for downloadable files)
      if (!item.file_item?.media?.encrypt_query_param) {
        parts.push(`(file: ${item.file_item?.file_name ?? 'unknown'})`);
      }
    } else if (item.type === 5 /* VIDEO */) {
      parts.push('(video)');
    }
  }
  return parts.join('\n').trim();
}

/**
 * Generate a unique dedup key from a WeixinMessage.
 */
function dedupKey(msg: WeixinMessage): string {
  if (msg.message_id !== undefined) return `mid:${msg.message_id}`;
  if (msg.seq !== undefined) return `seq:${msg.seq}`;
  // Fallback: combination of sender + timestamp + client_id
  return `fallback:${msg.from_user_id}:${msg.create_time_ms}:${msg.client_id}`;
}

// ─── Factory Function ───────────────────────────────────────────

export function createWeChatConnection(
  config: WeChatConnectionConfig,
): WeChatConnection {
  const baseUrl = config.baseUrl || DEFAULT_BASE_URL;
  const cdnBaseUrl = config.cdnBaseUrl || DEFAULT_CDN_BASE_URL;

  // Generate UIN once per connection instance (no need to regenerate per request)
  const wechatUin = randomWechatUin();

  // Polling state
  let currentGetUpdatesBuf = config.getUpdatesBuf || '';
  let longpollTimeoutMs = DEFAULT_LONGPOLL_TIMEOUT_MS;
  let stopping = false;
  let connected = false;
  let cancelSleep: (() => void) | null = null;

  // context_token cache: from_user_id -> latest context_token
  const contextTokenCache = new Map<string, string>();

  // Known JIDs — skip redundant storeChatMetadata/onNewChat for repeat messages
  const knownJids = new Set<string>();

  // Message deduplication: key -> timestamp
  const msgCache = new Map<string, number>();

  // ─── Deduplication ────────────────────────────────────────

  function isDuplicate(key: string): boolean {
    const now = Date.now();
    // Evict expired entries — Map preserves insertion order, so oldest entries
    // come first. Stop at the first non-expired entry for O(expired) instead of O(n).
    for (const [id, ts] of msgCache.entries()) {
      if (now - ts > MSG_DEDUP_TTL) {
        msgCache.delete(id);
      } else {
        break;
      }
    }
    // Evict oldest if at capacity
    if (msgCache.size >= MSG_DEDUP_MAX) {
      const firstKey = msgCache.keys().next().value;
      if (firstKey) msgCache.delete(firstKey);
    }
    return msgCache.has(key);
  }

  function markSeen(key: string): void {
    // delete + set to refresh insertion order (move to end)
    msgCache.delete(key);
    msgCache.set(key, Date.now());
  }

  // ─── HTTP Helpers ─────────────────────────────────────────

  function buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      Authorization: `Bearer ${config.botToken}`,
      'X-WECHAT-UIN': wechatUin,
    };
  }

  function baseInfo(): Record<string, string> {
    return { channel_version: CHANNEL_VERSION };
  }

  /**
   * Make an HTTPS POST request to the iLink API using fetch.
   */
  async function apiPost<T = any>(
    endpoint: string,
    body: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T> {
    const bodyStr = JSON.stringify(body);
    const url = new URL(endpoint, baseUrl);
    const headers = buildHeaders();

    const controller = new AbortController();
    const timer = timeoutMs
      ? setTimeout(() => controller.abort(), timeoutMs)
      : undefined;

    try {
      const res = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': String(Buffer.byteLength(bodyStr, 'utf-8')),
        },
        body: bodyStr,
        signal: controller.signal,
      });

      const text = await res.text();
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Error(
          `WeChat API ${endpoint} invalid JSON: ${text.slice(0, 200)}`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw new Error(`WeChat API ${endpoint} timed out`);
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // ─── API Methods ──────────────────────────────────────────

  async function getUpdates(): Promise<GetUpdatesResponse> {
    const httpTimeout = longpollTimeoutMs + LONGPOLL_EXTRA_TIMEOUT_MS;
    return apiPost<GetUpdatesResponse>(
      'ilink/bot/getupdates',
      {
        get_updates_buf: currentGetUpdatesBuf,
        base_info: baseInfo(),
      },
      httpTimeout,
    );
  }

  async function sendMessageApi(
    toUserId: string,
    contextToken: string,
    text: string,
  ): Promise<void> {
    const clientId = String(
      crypto.randomBytes(4).readUInt32BE(0),
    );

    const resp = await apiPost<{ ret?: number; errcode?: number; errmsg?: string }>(
      'ilink/bot/sendmessage',
      {
        msg: {
          to_user_id: toUserId,
          context_token: contextToken,
          item_list: [
            {
              type: MESSAGE_ITEM_TYPE_TEXT,
              text_item: { text },
            },
          ],
          message_type: MESSAGE_TYPE_BOT,
          message_state: MESSAGE_STATE_FINISH,
          client_id: clientId,
        },
        base_info: baseInfo(),
      },
    );

    if (resp.ret !== undefined && resp.ret !== 0) {
      throw new Error(
        `sendMessage failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ''}`,
      );
    }
  }

  async function getTypingTicket(
    ilinkUserId: string,
    contextToken: string,
  ): Promise<string | null> {
    try {
      const res = await apiPost<{ typing_ticket?: string }>(
        'ilink/bot/getconfig',
        {
          ilink_user_id: ilinkUserId,
          context_token: contextToken,
          base_info: baseInfo(),
        },
      );
      return res.typing_ticket || null;
    } catch (err) {
      logger.debug({ err }, 'WeChat getconfig failed');
      return null;
    }
  }

  async function sendTypingApi(
    ilinkUserId: string,
    typingTicket: string,
    status: 1 | 2,
  ): Promise<void> {
    try {
      await apiPost('ilink/bot/sendtyping', {
        ilink_user_id: ilinkUserId,
        typing_ticket: typingTicket,
        status,
        base_info: baseInfo(),
      });
    } catch (err) {
      logger.debug({ err, status }, 'WeChat sendtyping failed');
    }
  }

  // ─── CDN Media Download ────────────────────────────────────

  /**
   * Download, decrypt, and save a CDN media item (image, file, etc.).
   * `resolveFileName` receives the decrypted buffer so callers can inspect
   * content (e.g. MIME-detect for images) before choosing a name.
   */
  async function downloadCdnMediaItem(
    media: CDNMedia | undefined,
    groupFolder: string | undefined,
    label: string,
    resolveFileName: (buffer: Buffer) => string,
  ): Promise<{ buffer: Buffer; savedPath?: string } | null> {
    if (!media?.encrypt_query_param || !media?.aes_key) {
      logger.debug(`WeChat ${label} missing media or aes_key, skipping`);
      return null;
    }

    const buffer = await downloadAndDecryptMedia(
      media.encrypt_query_param,
      media.aes_key,
      cdnBaseUrl,
    );

    if (!buffer || buffer.length === 0) {
      logger.warn(`WeChat ${label} download returned empty buffer`);
      return null;
    }

    if (buffer.length > MAX_FILE_SIZE) {
      logger.warn(
        { size: buffer.length },
        `WeChat ${label} exceeds max file size, skipping`,
      );
      return null;
    }

    let savedPath: string | undefined;
    if (groupFolder) {
      try {
        const fileName = resolveFileName(buffer);
        savedPath =
          (await saveDownloadedFile(groupFolder, 'wechat', fileName, buffer)) ??
          undefined;
      } catch (err) {
        logger.warn({ err }, `Failed to save WeChat ${label} to disk`);
      }
    }

    return { buffer, savedPath };
  }

  async function processImageItem(
    item: MessageItem,
    msgIdentifier: string,
    groupFolder: string | undefined,
  ): Promise<{
    attachmentEntry?: { type: string; data: string; mimeType: string };
    textPrefix?: string;
  }> {
    try {
      const result = await downloadCdnMediaItem(
        item.image_item?.media,
        groupFolder,
        'image',
        (buffer) => {
          const mimeType = detectImageMimeType(buffer);
          const extMap: Record<string, string> = {
            'image/jpeg': '.jpg',
            'image/png': '.png',
            'image/gif': '.gif',
            'image/webp': '.webp',
          };
          return `wechat_img_${msgIdentifier}${extMap[mimeType] ?? '.jpg'}`;
        },
      );
      if (!result) return {};

      const textPrefix = result.savedPath
        ? `[图片: ${result.savedPath}]`
        : undefined;

      let attachmentEntry:
        | { type: string; data: string; mimeType: string }
        | undefined;
      if (result.buffer.length <= IMAGE_MAX_BASE64_SIZE) {
        const mimeType = detectImageMimeType(result.buffer);
        attachmentEntry = {
          type: 'image',
          data: result.buffer.toString('base64'),
          mimeType,
        };
      }

      return { attachmentEntry, textPrefix };
    } catch (err) {
      logger.warn({ err }, 'WeChat image download/decrypt failed, skipping');
      return {};
    }
  }

  async function processFileItem(
    item: MessageItem,
    groupFolder: string | undefined,
  ): Promise<string | null> {
    const fileName = item.file_item?.file_name || 'unknown_file';
    try {
      const result = await downloadCdnMediaItem(
        item.file_item?.media,
        groupFolder,
        'file',
        () => fileName,
      );
      if (result?.savedPath) return `[文件: ${result.savedPath}]`;
      // CDN media unavailable, fall back to name-only label
      return `[文件: ${fileName}]`;
    } catch (err) {
      logger.warn({ err, fileName }, 'WeChat file download/decrypt failed');
      return `[文件: ${fileName}]`;
    }
  }

  // ─── Message Processing ───────────────────────────────────

  async function processMessage(
    msg: WeixinMessage,
    opts: WeChatConnectOpts,
  ): Promise<void> {
    try {
      // Skip bot's own messages
      if (msg.message_type === MESSAGE_TYPE_BOT) return;

      const fromUserId = msg.from_user_id;
      if (!fromUserId) return;

      // Dedup
      const key = dedupKey(msg);
      if (isDuplicate(key)) return;
      markSeen(key);

      // Skip stale messages — if no timestamp available, skip as well (can't verify freshness)
      if (opts.ignoreMessagesBefore) {
        if (!msg.create_time_ms || msg.create_time_ms < opts.ignoreMessagesBefore) return;
      }

      // Cache context_token for replies
      if (msg.context_token) {
        contextTokenCache.set(fromUserId, msg.context_token);
      }

      const jid = `wechat:${fromUserId}`;
      const senderName = fromUserId.split('@')[0] || 'WeChat用户';
      const chatName = senderName;

      // Extract text content
      let content = msg.item_list ? extractTextContent(msg.item_list) : '';

      // ── Auto-register chat (WeChat is 1:1 bound, no pairing needed) ──
      const nowIso = new Date().toISOString();
      if (!knownJids.has(jid)) {
        knownJids.add(jid);
        storeChatMetadata(jid, nowIso);
        updateChatName(jid, chatName);
        opts.onNewChat(jid, chatName);
      }

      // Handle slash commands
      const slashMatch = content.match(/^\/(\S+)(?:\s+(.*))?$/i);
      if (slashMatch && opts.onCommand) {
        const cmdBody = (
          slashMatch[1] + (slashMatch[2] ? ' ' + slashMatch[2] : '')
        ).trim();
        try {
          const reply = await opts.onCommand(jid, cmdBody);
          if (reply) {
            const ct = contextTokenCache.get(fromUserId);
            if (ct) {
              await sendMessageApi(
                fromUserId,
                ct,
                markdownToPlainText(reply),
              );
            }
            return;
          }
        } catch (err) {
          logger.error({ jid, err }, 'WeChat slash command failed');
          const ct = contextTokenCache.get(fromUserId);
          if (ct) {
            await sendMessageApi(fromUserId, ct, '命令执行失败，请稍后重试');
          }
          return;
        }
      }

      // Handle image attachments
      let attachmentsJson: string | undefined;
      const groupFolder = opts.resolveGroupFolder?.(jid);
      if (msg.item_list) {
        const imageAttachments: {
          type: string;
          data: string;
          mimeType: string;
        }[] = [];
        const textPrefixes: string[] = [];

        // Note: textPrefixes order depends on CDN response time, not message item order
        // Download images and files in parallel (independent CDN requests)
        const msgId =
          msg.message_id !== undefined
            ? String(msg.message_id)
            : String(msg.seq ?? Date.now());

        const mediaPromises: Promise<void>[] = [];

        for (const item of msg.item_list) {
          if (item.type === MESSAGE_ITEM_TYPE_IMAGE) {
            mediaPromises.push(
              processImageItem(item, msgId.slice(-8), groupFolder).then((r) => {
                if (r.attachmentEntry) imageAttachments.push(r.attachmentEntry);
                if (r.textPrefix) textPrefixes.push(r.textPrefix);
              }),
            );
          } else if (item.type === MESSAGE_ITEM_TYPE_FILE) {
            mediaPromises.push(
              processFileItem(item, groupFolder).then((label) => {
                if (label) textPrefixes.push(label);
              }),
            );
          }
        }

        if (mediaPromises.length > 0) {
          await Promise.allSettled(mediaPromises);
        }

        if (imageAttachments.length > 0) {
          attachmentsJson = JSON.stringify(imageAttachments);
          if (textPrefixes.length > 0) {
            content = `${textPrefixes.join('\n')}\n${content}`.trim();
          }
        }

        if (!content && imageAttachments.length > 0) {
          content = '[图片]';
        }
      }

      if (!content) return; // No usable content

      // Route and store message
      const agentRouting = opts.resolveEffectiveChatJid?.(jid);
      const targetJid = agentRouting?.effectiveJid ?? jid;

      const id = crypto.randomUUID();
      const timestamp = msg.create_time_ms
        ? new Date(msg.create_time_ms).toISOString()
        : nowIso;
      const senderId = `wechat:${fromUserId}`;

      if (targetJid !== jid) storeChatMetadata(targetJid, timestamp);
      storeMessageDirect(id, targetJid, senderId, senderName, content, timestamp, false, {
        attachments: attachmentsJson,
        sourceJid: jid,
      });

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
      notifyNewImMessage();

      if (agentRouting?.agentId) {
        opts.onAgentMessage?.(jid, agentRouting.agentId);
        logger.info(
          { jid, effectiveJid: targetJid, agentId: agentRouting.agentId },
          'WeChat message routed to agent',
        );
      } else {
        logger.info(
          { jid, sender: senderName, msgId: msg.message_id ?? msg.seq },
          'WeChat message stored',
        );
      }
    } catch (err) {
      logger.error({ err, msgId: msg.message_id }, 'Error handling WeChat message');
    }
  }

  // ─── Long-Polling Loop ────────────────────────────────────

  async function pollLoop(opts: WeChatConnectOpts): Promise<void> {
    let reconnectDelay = RECONNECT_MIN_DELAY_MS;

    while (!stopping) {
      try {
        const response = await getUpdates();

        // Update longpoll timeout from server
        if (response.longpolling_timeout_ms) {
          longpollTimeoutMs = response.longpolling_timeout_ms;
        }

        // Check for session expiry
        if (response.ret === ERRCODE_SESSION_EXPIRED) {
          logger.warn('WeChat session expired (errcode -14), stopping poll loop');
          connected = false;
          break;
        }

        // ret is absent (undefined) when the request succeeds — treat as 0
        if (response.ret !== undefined && response.ret !== 0) {
          logger.warn(
            `WeChat getUpdates error: ret=${response.ret}, response=${JSON.stringify(response).slice(0, 500)}`,
          );
          // Back off on errors
          await sleep(reconnectDelay);
          reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY_MS);
          continue;
        }

        // Reset backoff on success
        reconnectDelay = RECONNECT_MIN_DELAY_MS;

        // Update cursor
        if (response.get_updates_buf) {
          currentGetUpdatesBuf = response.get_updates_buf;
        }

        // Process messages
        if (response.msgs && response.msgs.length > 0) {
          for (const msg of response.msgs) {
            await processMessage(msg, opts);
          }
        }
      } catch (err) {
        if (stopping) break;

        // Long-poll timeout is expected when no new messages arrive — just retry immediately.
        const isTimeout = err instanceof Error && err.message.includes('timed out');
        if (isTimeout) {
          logger.debug({ err }, 'WeChat poll timeout (normal, retrying)');
          continue;
        }

        logger.error({ err }, 'WeChat poll loop error');
        await sleep(reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY_MS);
      }
    }
  }

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      cancelSleep = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  // ─── Connection Interface ─────────────────────────────────

  const connection: WeChatConnection = {
    async connect(opts: WeChatConnectOpts): Promise<void> {
      if (!config.botToken || !config.ilinkBotId) {
        logger.info('WeChat botToken/ilinkBotId not configured, skipping');
        return;
      }

      stopping = false;
      connected = true;
      msgCache.clear();
      contextTokenCache.clear();
      knownJids.clear();

      logger.info(
        { baseUrl, ilinkBotId: config.ilinkBotId },
        'WeChat iLink bot connecting',
      );

      // Fire onReady immediately since there's no handshake
      opts.onReady?.();

      // Start poll loop in background (non-blocking)
      pollLoop(opts).catch((err) => {
        logger.error({ err }, 'WeChat poll loop exited with error');
        connected = false;
      });
    },

    async disconnect(): Promise<void> {
      stopping = true;
      connected = false;

      // Abort any pending sleep
      cancelSleep?.();
      cancelSleep = null;

      msgCache.clear();
      contextTokenCache.clear();
      knownJids.clear();
      logger.info('WeChat iLink bot disconnected');
    },

    async sendMessage(
      chatId: string,
      text: string,
      _localImagePaths?: string[],
    ): Promise<void> {
      // chatId is the raw WeChat user ID (prefix already stripped by IM manager)
      const userId = chatId;

      const contextToken = contextTokenCache.get(userId);
      if (!contextToken) {
        logger.warn(
          { chatId },
          'No context_token available for WeChat user, cannot send message',
        );
        return;
      }

      try {
        const plainText = markdownToPlainText(text);
        const chunks = splitTextChunks(plainText, MSG_SPLIT_LIMIT);

        for (const chunk of chunks) {
          await sendMessageApi(userId, contextToken, chunk);
        }

        logger.info({ chatId }, 'WeChat message sent');
      } catch (err) {
        logger.error({ err, chatId }, 'Failed to send WeChat message');
        throw err;
      }
    },

    async sendImage(
      chatId: string,
      imageBuffer: Buffer,
      mimeType: string,
      caption?: string,
      fileName?: string,
    ): Promise<void> {
      const userId = chatId;

      const contextToken = contextTokenCache.get(userId);
      if (!contextToken) {
        logger.warn(
          { chatId },
          'No context_token for WeChat user, cannot send image',
        );
        return;
      }

      if (imageBuffer.length > MAX_FILE_SIZE) {
        throw new Error(
          `WeChat image size ${imageBuffer.length} exceeds max ${MAX_FILE_SIZE}`,
        );
      }

      const extMap: Record<string, string> = {
        'image/jpeg': '.jpg',
        'image/png': '.png',
        'image/gif': '.gif',
        'image/webp': '.webp',
      };
      const ext = extMap[mimeType] ?? '.jpg';
      const resolvedFileName = fileName ?? `image_${Date.now()}${ext}`;

      try {
        // Optional caption is sent first as a separate text message — WeChat's
        // sendmessage API does not accept mixed text+image item_list payloads.
        if (caption) {
          const plain = markdownToPlainText(caption);
          for (const chunk of splitTextChunks(plain, MSG_SPLIT_LIMIT)) {
            await sendMessageApi(userId, contextToken, chunk);
          }
        }

        // Upload to WeChat CDN (getuploadurl → AES-128-ECB encrypt → PUT ciphertext).
        const upload = await uploadMediaBuffer({
          buf: imageBuffer,
          fileName: resolvedFileName,
          toUserId: userId,
          baseUrl,
          token: config.botToken,
          cdnBaseUrl,
          mediaType: 1, // MEDIA_IMAGE
        });

        const clientId = String(crypto.randomBytes(4).readUInt32BE(0));
        const resp = await apiPost<{
          ret?: number;
          errcode?: number;
          errmsg?: string;
        }>('ilink/bot/sendmessage', {
          msg: {
            to_user_id: userId,
            context_token: contextToken,
            item_list: [
              {
                type: MESSAGE_ITEM_TYPE_IMAGE,
                image_item: {
                  media: {
                    encrypt_query_param: upload.downloadEncryptedQueryParam,
                    aes_key: upload.aeskey,
                    encrypt_type: 1,
                  },
                  mid_size: upload.fileSizeCiphertext,
                },
              },
            ],
            message_type: MESSAGE_TYPE_BOT,
            message_state: MESSAGE_STATE_FINISH,
            client_id: clientId,
          },
          base_info: baseInfo(),
        });

        if (resp.ret !== undefined && resp.ret !== 0) {
          throw new Error(
            `sendImage failed: ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg ?? ''}`,
          );
        }

        logger.info(
          { chatId, size: imageBuffer.length, fileName: resolvedFileName },
          'WeChat image sent',
        );
      } catch (err) {
        logger.error({ err, chatId }, 'Failed to send WeChat image');
        throw err;
      }
    },

    async sendTyping(chatId: string, isTyping: boolean): Promise<void> {
      // chatId is the raw WeChat user ID (prefix already stripped by IM manager)
      const userId = chatId;

      const contextToken = contextTokenCache.get(userId);
      if (!contextToken) return;

      const ticket = await getTypingTicket(userId, contextToken);
      if (!ticket) return;

      await sendTypingApi(userId, ticket, isTyping ? 1 : 2);
    },

    isConnected(): boolean {
      return connected && !stopping;
    },

    getUpdatesBuf(): string {
      return currentGetUpdatesBuf;
    },
  };

  return connection;
}
