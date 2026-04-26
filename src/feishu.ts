import fs from 'fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as lark from '@larksuiteoapi/node-sdk';
import {
  setLastGroupSync,
  storeChatMetadata,
  storeMessageDirect,
  updateChatName,
} from './db.js';
import { logger } from './logger.js';
import {
  saveDownloadedFile,
  MAX_FILE_SIZE,
  FileTooLargeError,
} from './im-downloader.js';
import { notifyNewImMessage } from './message-notifier.js';
import { broadcastNewMessage } from './web.js';
import { detectImageMimeType } from './image-detector.js';
import {
  resolveJidByMessageId,
  getStreamingSession,
} from './feishu-streaming-card.js';
import { optimizeMarkdownStyle } from './feishu-markdown-style.js';
import { buildAgentReplyCard } from './feishu-cards/builder.js';
import type { FeishuMessageMeta } from './types.js';

// ─── FeishuConnection Interface ────────────────────────────────

export interface FeishuConnectionConfig {
  appId: string;
  appSecret: string;
}

/** 飞书文件信息（用于下载到工作区） */
interface FeishuFileInfo {
  fileKey: string;
  filename: string;
}

export interface ConnectOptions {
  onReady: () => void;
  /** 收到消息后调用，让调用方自动注册未知的飞书聊天 */
  onNewChat?: (chatJid: string, chatName: string) => void;
  /** 热重连时设置：丢弃 create_time 早于此时间戳（epoch ms）的消息，避免处理渠道关闭期间的堆积消息 */
  ignoreMessagesBefore?: number;
  /** 斜杠指令回调（如 /clear），返回回复文本或 null；mentions 仅飞书渠道传入，用于 /allow 等命令 */
  onCommand?: (chatJid: string, command: string, senderImId?: string, mentions?: FeishuMentionLike[]) => Promise<string | null>;
  /** 根据 chatJid 解析群组 folder，用于下载文件/图片到工作区 */
  resolveGroupFolder?: (chatJid: string) => string | undefined;
  /** 将 IM chatJid 解析为绑定目标 JID（conversation agent 或工作区主对话） */
  resolveEffectiveChatJid?: (
    chatJid: string,
    messageMeta?: FeishuMessageMeta,
  ) => { effectiveJid: string; agentId: string | null } | null;
  /** 当 IM 消息被路由到 conversation agent 后调用 */
  onAgentMessage?: (baseChatJid: string, agentId: string) => void;
  /** Bot 被添加到群聊时调用（自动注册群组） */
  onBotAddedToGroup?: (chatJid: string, chatName: string) => void;
  /** Bot 被移出群聊或群被解散时调用（自动解绑 IM 绑定） */
  onBotRemovedFromGroup?: (chatJid: string) => void;
  /** 群聊消息过滤：bot 未被 @mention 时调用，返回 true 则处理，false 则丢弃 */
  shouldProcessGroupMessage?: (chatJid: string, senderImId?: string) => boolean;
  /** owner_mentioned 模式下检查发送者是否为 owner */
  isGroupOwnerMessage?: (chatJid: string, senderImId?: string) => boolean;
  /** 发言者白名单：命令处理之后、mention 门控之前调用；返回 false 则丢弃 */
  isSenderAllowedInGroup?: (chatJid: string, senderImId?: string) => boolean;
  /** 飞书流式卡片按钮中断回调 */
  onCardInterrupt?: (chatJid: string) => void;
  /** P2P（私聊）消息到达时调用，用于自动检测 bot owner 的 open_id */
  onP2pSender?: (senderOpenId: string) => void;
}

export interface FeishuChatInfo {
  avatar?: string;
  name?: string;
  user_count?: string;
  chat_type?: string;
  chat_mode?: string; // 'p2p' | 'group' | 'topic'
  group_message_type?: string; // 'chat' | 'thread'
}

export interface FeishuConnection {
  connect(opts: ConnectOptions): Promise<boolean>;
  stop(): Promise<void>;
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
  sendFile(chatId: string, filePath: string, fileName: string): Promise<void>;
  sendReaction(chatId: string, isTyping: boolean): Promise<void>;
  /** Clear the "OnIt" ack reaction for a chat (e.g. when streaming card handled the reply). */
  clearAckReaction(chatId: string): void;
  isConnected(): boolean;
  syncGroups(): Promise<void>;
  getChatInfo(chatId: string): Promise<FeishuChatInfo | null>;
  /** Get the underlying Lark SDK client (for streaming cards) */
  getLarkClient(): lark.Client | null;
  /** Get the last received message ID for a chat (for reply threading) */
  getLastMessageId(chatId: string): string | undefined;
}

// ─── Shared Helpers (pure functions, no instance state) ────────

// Feishu card allows at most 5 markdown tables; beyond this, skip card and use post+md directly
const CARD_TABLE_LIMIT = 5;
const FEISHU_WS_READY_STATE_OPEN = 1;
const WS_HEALTH_CHECK_INTERVAL_MS = 15_000;
const WS_RECONNECT_CHECK_THRESHOLD = 4;
const WS_RECONNECT_MIN_INTERVAL_MS = 30_000;
const BACKFILL_LOOKBACK_MS = 5 * 60 * 1000;
const BACKFILL_PAGE_SIZE = 50;
const BACKFILL_MAX_PAGES_PER_CHAT = 5;

interface FeishuMentionLike {
  key?: string;
  name?: string;
  id?: { open_id?: string; user_id?: string };
}

interface IncomingMessagePayload {
  chatId: string;
  messageId: string;
  rootId?: string;
  parentId?: string;
  threadId?: string;
  createTimeMs: number;
  messageType: string;
  content: string;
  chatType?: string;
  mentions?: FeishuMentionLike[];
  senderOpenId?: string;
  senderName?: string;
}

interface WsConnectionState {
  connected: boolean;
  isConnecting: boolean;
  nextConnectTime: number;
}

function toEpochMs(value: string | number | undefined): number {
  const numeric = typeof value === 'number' ? value : Number(value ?? 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return numeric < 1e12 ? Math.trunc(numeric * 1000) : Math.trunc(numeric);
}

export interface FeishuRouteTarget {
  raw: string;
  chatId: string;
  threadId?: string;
  rootMessageId?: string;
}

export function parseFeishuRouteTarget(raw: string): FeishuRouteTarget {
  const [chatId, ...parts] = raw.split('#');
  let threadId: string | undefined;
  let rootMessageId: string | undefined;
  for (const part of parts) {
    if (part.startsWith('thread:')) {
      threadId = part.slice('thread:'.length);
    } else if (part.startsWith('root:')) {
      rootMessageId = part.slice('root:'.length);
    }
  }
  return { raw, chatId, threadId, rootMessageId };
}

/**
 * Extract message content from Feishu message.
 * Returns text content, optional image keys, and optional file infos for download.
 */
function extractMessageContent(
  messageType: string,
  content: string,
): { text: string; imageKeys?: string[]; fileInfos?: FeishuFileInfo[] } {
  // merge_forward: WebSocket 推送的内容是纯字符串 "Merged and Forwarded Message"（非 JSON），
  // 必须在 JSON.parse 之前单独处理，否则 parse 失败导致消息被丢弃
  if (messageType === 'merge_forward') {
    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch {
      return { text: '[合并转发消息]' };
    }
    const items = parsed.message_list || parsed.items || [];
    if (!Array.isArray(items) || items.length === 0) {
      return { text: '[合并转发消息]' };
    }
    const lines: string[] = ['[合并转发消息]:'];
    for (const item of items.slice(0, 20)) {
      const sender = item.sender_name || item.sender || '未知';
      const body = item.body?.content || item.content || '';
      let text = '';
      try {
        const subType = item.msg_type || item.message_type || 'text';
        const sub = extractMessageContent(subType, body);
        text = sub.text || '';
      } catch {
        text = typeof body === 'string' ? body : '';
      }
      if (text) {
        lines.push(`> ${sender}: ${text.split('\n')[0].slice(0, 200)}`);
      }
    }
    if (items.length > 20) {
      lines.push(`> ... 共 ${items.length} 条消息`);
    }
    return { text: lines.join('\n') };
  }

  try {
    const parsed = JSON.parse(content);

    if (messageType === 'text') {
      return { text: parsed.text || '' };
    }

    if (messageType === 'post') {
      // Extract text and inline images from rich post content.
      const lines: string[] = [];
      const imageKeys: string[] = [];
      // 飞书 post 消息有三种已知格式：
      // 1. 带 post + 语言包裹：{"post": {"zh_cn": {"title": "...", "content": [[...]]}}}
      // 2. 仅语言包裹：{"zh_cn": {"title": "...", "content": [[...]]}}
      // 3. 无包裹（直接 title+content）：{"title": "...", "content": [[...]]}
      const post = parsed.post || parsed;
      if (!post || typeof post !== 'object') {
        logger.warn(
          { keys: Object.keys(parsed) },
          'Empty post object in post message',
        );
        return { text: '' };
      }

      // 判断 contentData：如果 post 本身就有 content 数组，直接用；否则查找语言层
      let contentData: any;
      if (Array.isArray(post.content)) {
        // 格式 3：无包裹，post 本身就是 {title, content}
        contentData = post;
        logger.debug('Post message using flat format (no locale wrapper)');
      } else {
        // 格式 1/2：有语言层包裹
        contentData = post.zh_cn || post.en_us || Object.values(post)[0];
      }
      if (!contentData || !Array.isArray(contentData.content)) {
        logger.warn(
          { keys: Object.keys(post) },
          'Missing content array in post message',
        );
        return { text: '' };
      }

      // Include post title if present
      if (contentData.title && typeof contentData.title === 'string') {
        lines.push(contentData.title);
      }

      for (const paragraph of contentData.content) {
        // Handle both array paragraphs and flat object segments
        const segments = Array.isArray(paragraph)
          ? paragraph
          : paragraph && typeof paragraph === 'object'
            ? [paragraph]
            : null;
        if (!segments) continue;
        const parts: string[] = [];
        for (const segment of segments) {
          if (!segment || typeof segment !== 'object') continue;
          if (segment.tag === 'text' && typeof segment.text === 'string') {
            parts.push(segment.text);
          } else if (segment.tag === 'a' && typeof segment.text === 'string') {
            parts.push(segment.text);
          } else if (segment.tag === 'at') {
            const mentionName =
              typeof segment.user_name === 'string'
                ? segment.user_name
                : typeof segment.text === 'string'
                  ? segment.text
                  : typeof segment.name === 'string'
                    ? segment.name
                    : '用户';
            parts.push(`@${mentionName}`);
          } else if (
            segment.tag === 'img' &&
            typeof segment.image_key === 'string'
          ) {
            imageKeys.push(segment.image_key);
            parts.push('[图片]');
          } else if (segment.tag === 'media') {
            parts.push('[视频]');
          } else if (
            segment.tag === 'emotion' &&
            typeof segment.emoji_type === 'string'
          ) {
            parts.push(`:${segment.emoji_type}:`);
          } else if (typeof segment.text === 'string') {
            parts.push(segment.text);
          }
        }
        if (parts.length > 0) lines.push(parts.join(''));
      }

      return {
        text: lines.join('\n'),
        imageKeys: imageKeys.length > 0 ? imageKeys : undefined,
      };
    }

    if (messageType === 'image') {
      const imageKey = parsed.image_key;
      if (imageKey) {
        return { text: '', imageKeys: [imageKey] };
      }
    }

    if (messageType === 'file') {
      const fileKey = parsed.file_key;
      const filename = parsed.file_name || '';
      if (fileKey) {
        return {
          text: `[文件: ${filename || fileKey}]`,
          fileInfos: [{ fileKey, filename }],
        };
      }
    }

    if (messageType === 'sticker') {
      const stickerDesc =
        parsed.description || parsed.sticker_id || '表情包';
      return { text: `[表情包: ${stickerDesc}]` };
    }

    if (messageType === 'audio') {
      const duration = parsed.duration
        ? `${Math.round(parsed.duration / 1000)}s`
        : '';
      return { text: `[语音消息${duration ? ': ' + duration : ''}]` };
    }

    if (messageType === 'share_chat') {
      const chatName = parsed.chat_name || parsed.chat_id || '未知群聊';
      return { text: `[分享群聊: ${chatName}]` };
    }

    if (messageType === 'share_user') {
      const userName = parsed.user_name || parsed.user_id || '未知用户';
      return { text: `[分享用户: ${userName}]` };
    }

    if (messageType === 'system') {
      const body = parsed.body || parsed.content || '';
      const systemText =
        typeof body === 'string' ? body : JSON.stringify(body);
      return { text: `[系统消息: ${systemText.slice(0, 200)}]` };
    }

    if (messageType === 'interactive') {
      // Extract title and text elements from interactive card messages
      const parts: string[] = [];
      if (parsed.title) {
        parts.push(parsed.title);
      }
      if (Array.isArray(parsed.elements)) {
        for (const row of parsed.elements) {
          if (!Array.isArray(row)) continue;
          for (const el of row) {
            if (!el || typeof el !== 'object') continue;
            if (el.tag === 'text' && typeof el.text === 'string') {
              parts.push(el.text);
            } else if (el.tag === 'a' && typeof el.text === 'string') {
              parts.push(`[${el.text}](${el.href || ''})`);
            } else if (
              el.tag === 'note' &&
              Array.isArray(el.elements)
            ) {
              const noteText = el.elements
                .filter(
                  (n: any) =>
                    n.tag === 'text' && typeof n.text === 'string',
                )
                .map((n: any) => n.text)
                .join('');
              if (noteText) parts.push(noteText);
            }
            // Skip buttons, hr, select_static, img — not useful as text
          }
        }
      }
      const cardText = parts.filter(Boolean).join('\n');
      return { text: cardText || '[飞书卡片消息]' };
    }

    if (messageType === 'media') {
      return { text: '[视频消息]' };
    }

    if (messageType === 'location') {
      return {
        text: `[位置: ${parsed.name || parsed.address || '未知位置'}]`,
      };
    }

    if (messageType === 'share_calendar_event') {
      return {
        text: `[日程分享: ${parsed.summary || parsed.event_id || ''}]`,
      };
    }

    if (messageType === 'video_chat') {
      return { text: `[视频会议: ${parsed.topic || ''}]` };
    }

    if (messageType === 'todo') {
      return {
        text: `[待办: ${parsed.task_id || parsed.summary || ''}]`,
      };
    }

    if (messageType === 'hongbao') {
      return { text: '[红包消息]' };
    }

    // 未知消息类型：返回类型占位符，避免静默丢弃
    return { text: `[${messageType}]` };
  } catch (err) {
    logger.warn(
      { err, messageType, content },
      'Failed to parse message content',
    );
    return { text: `[${messageType}]` };
  }
}

/**
 * Map file extension to Feishu file type.
 */
function getFileType(
  ext: string,
): 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' {
  const map: Record<
    string,
    'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream'
  > = {
    '.pdf': 'pdf',
    '.doc': 'doc',
    '.docx': 'doc',
    '.xls': 'xls',
    '.xlsx': 'xls',
    '.ppt': 'ppt',
    '.pptx': 'ppt',
    '.mp4': 'mp4',
    '.opus': 'opus',
  };
  return map[ext.toLowerCase()] || 'stream';
}

/**
 * Build a Feishu interactive card (Schema 2.0) from markdown text.
 * Applies optimizeMarkdownStyle() for proper rendering in Feishu cards:
 * - Heading demotion (H1→H4, H2~H6→H5)
 * - Code block / table spacing with <br>
 * - Invalid image cleanup
 */
/** Build a post+md fallback content string for when interactive card send fails. */
function buildPostMdFallback(text: string): string {
  return JSON.stringify({
    zh_cn: {
      content: [[{ tag: 'md', text: optimizeMarkdownStyle(text, 1) }]],
    },
  });
}

function buildInteractiveCard(text: string): object {
  return buildAgentReplyCard({ status: 'done', text });
}

// ─── Factory Function ──────────────────────────────────────────

/**
 * Create an independent Feishu connection instance.
 * Each instance manages its own client, WebSocket, and state maps.
 */
export function createFeishuConnection(
  config: FeishuConnectionConfig,
): FeishuConnection {
  // LRU deduplication cache
  const MSG_DEDUP_MAX = 1000;
  const MSG_DEDUP_TTL = 30 * 60 * 1000; // 30min

  // Per-instance state
  const msgCache = new Map<string, number>();
  const senderNameCache = new Map<string, string>();
  const lastMessageIdByChat = new Map<string, string>();
  const ackReactionByChat = new Map<string, string>();
  const typingReactionByChat = new Map<string, string>();
  const knownChatIds = new Set<string>();
  const chatTypeById = new Map<string, string>(); // chatId → 'group' | 'p2p'
  const lastCreateTimeByChat = new Map<string, number>();

  let client: lark.Client | null = null;
  let wsClient: lark.WSClient | null = null;
  let eventDispatcher: lark.EventDispatcher | null = null;
  let connectOptions: ConnectOptions | null = null;
  let botOpenId: string = '';
  let reconnecting = false;
  let backfillRunning = false;
  let reconnectRequestedAt = 0;
  let lastWsStateConnected = false;
  let disconnectedChecks = 0;
  let disconnectedSince: number | null = null;
  let healthTimer: NodeJS.Timeout | null = null;

  function rememberChatProgress(chatId: string, createTimeMs: number, chatType?: string): void {
    knownChatIds.add(chatId);
    if (chatType) chatTypeById.set(chatId, chatType);
    const prev = lastCreateTimeByChat.get(chatId) || 0;
    if (createTimeMs > prev) {
      lastCreateTimeByChat.set(chatId, createTimeMs);
    }
  }

  /**
   * 通过访问飞书 SDK 的私有属性（wsConfig、isConnecting）获取 WebSocket 连接状态。
   *
   * 注意事项：
   * 1. 该函数依赖 @larksuiteoapi/node-sdk 内部未公开的属性结构，SDK 版本升级可能导致失效
   * 2. 失效时函数会静默降级（捕获异常后返回 null），健康检查将跳过状态判断，不会触发误重连
   * 3. 后续可考虑使用 SDK 公开 API getReconnectInfo() 替代私有属性访问
   */
  function getWsConnectionState(): WsConnectionState | null {
    const rawClient = wsClient as unknown as {
      wsConfig?: {
        getWSInstance?: () => { readyState?: number } | undefined;
      };
      getReconnectInfo?: () => { nextConnectTime?: number };
      isConnecting?: boolean;
    };
    try {
      const wsInstance = rawClient.wsConfig?.getWSInstance?.();
      const reconnectInfo = rawClient.getReconnectInfo?.() || {};
      return {
        connected: wsInstance?.readyState === FEISHU_WS_READY_STATE_OPEN,
        isConnecting: rawClient.isConnecting === true,
        nextConnectTime: Number(reconnectInfo.nextConnectTime || 0),
      };
    } catch (err) {
      logger.debug({ err }, 'Failed to inspect Feishu WebSocket state');
      return null;
    }
  }

  function stopHealthMonitor(): void {
    if (healthTimer) {
      clearInterval(healthTimer);
      healthTimer = null;
    }
  }

  function startHealthMonitor(): void {
    stopHealthMonitor();
    healthTimer = setInterval(() => {
      void checkConnectionHealth();
    }, WS_HEALTH_CHECK_INTERVAL_MS);
    healthTimer.unref?.();
  }

  function isDuplicate(msgId: string): boolean {
    const now = Date.now();
    // Map preserves insertion order; stop at first non-expired entry
    for (const [id, ts] of msgCache.entries()) {
      if (now - ts > MSG_DEDUP_TTL) {
        msgCache.delete(id);
      } else {
        break;
      }
    }
    if (msgCache.size >= MSG_DEDUP_MAX) {
      const firstKey = msgCache.keys().next().value;
      if (firstKey) msgCache.delete(firstKey);
    }
    return msgCache.has(msgId);
  }

  function markSeen(msgId: string): void {
    msgCache.delete(msgId);
    msgCache.set(msgId, Date.now());
  }

  async function downloadFeishuImage(
    messageId: string,
    fileKey: string,
  ): Promise<{ base64: string; mimeType: string } | null> {
    try {
      const res = await client!.im.messageResource.get({
        path: {
          message_id: messageId,
          file_key: fileKey,
        },
        params: {
          type: 'image',
        },
      });

      const stream = res.getReadableStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const buffer = Buffer.concat(chunks);
      if (buffer.length === 0) {
        logger.warn(
          { messageId, fileKey },
          'Empty response from image download',
        );
        return null;
      }

      const mimeType = detectImageMimeType(buffer);
      return {
        base64: buffer.toString('base64'),
        mimeType,
      };
    } catch (err) {
      logger.warn(
        { err, messageId, fileKey },
        'Failed to download Feishu image',
      );
      return null;
    }
  }

  /**
   * 下载飞书文件（type='file'）到工作区磁盘。
   * 返回工作区相对路径（如 downloads/feishu/2026-03-01/report.pdf），失败返回 null。
   */
  async function downloadFeishuFileToDisk(
    messageId: string,
    fileKey: string,
    filename: string,
    groupFolder: string,
  ): Promise<string | null> {
    try {
      const res = await client!.im.messageResource.get({
        path: {
          message_id: messageId,
          file_key: fileKey,
        },
        params: {
          type: 'file',
        },
      });

      const stream = res.getReadableStream();
      const chunks: Buffer[] = [];
      let totalSize = 0;
      for await (const chunk of stream) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalSize += buf.length;
        if (totalSize > MAX_FILE_SIZE) {
          logger.warn(
            { messageId, fileKey, totalSize },
            'File exceeds MAX_FILE_SIZE during download',
          );
          return null;
        }
        chunks.push(buf);
      }
      const buffer = Buffer.concat(chunks);
      if (buffer.length === 0) {
        logger.warn(
          { messageId, fileKey },
          'Empty response from file download',
        );
        return null;
      }

      const effectiveName = filename || `file_${fileKey}`;
      try {
        const relPath = await saveDownloadedFile(
          groupFolder,
          'feishu',
          effectiveName,
          buffer,
        );
        return relPath;
      } catch (err) {
        if (err instanceof FileTooLargeError) {
          logger.warn({ fileKey, filename }, 'Feishu file too large, skipping');
          return null;
        }
        throw err;
      }
    } catch (err) {
      logger.warn(
        { err, messageId, fileKey },
        'Failed to download Feishu file to disk',
      );
      return null;
    }
  }

  function getSenderName(openId: string): string {
    return senderNameCache.get(openId) || openId;
  }

  async function addReaction(
    messageId: string,
    emojiType: string,
  ): Promise<string | null> {
    try {
      const res = (await client!.im.messageReaction.create({
        path: { message_id: messageId },
        data: {
          reaction_type: { emoji_type: emojiType },
        },
      })) as { data?: { reaction_id?: string } };
      return res.data?.reaction_id || null;
    } catch (err) {
      logger.debug({ err, messageId, emojiType }, 'Failed to add reaction');
      return null;
    }
  }

  async function removeReaction(
    messageId: string,
    reactionId: string,
  ): Promise<void> {
    try {
      await client!.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
    } catch (err) {
      logger.debug({ err, messageId, reactionId }, 'Failed to remove reaction');
    }
  }

  /**
   * Low-level send: route to reply (thread-aware) or create, based on target.
   * Uses rootMessageId for thread routing, falls back to lastMessageIdByChat for reply context.
   */
  async function sendToFeishu(
    chatId: string,
    msgType: string,
    content: string,
  ): Promise<void> {
    if (!client) return;
    const target = parseFeishuRouteTarget(chatId);
    const receiveIdType = target.chatId.startsWith('oc_')
      ? 'chat_id'
      : 'open_id';
    const replyMsgId =
      target.rootMessageId || lastMessageIdByChat.get(target.chatId);
    if (replyMsgId) {
      await client.im.message.reply({
        path: { message_id: replyMsgId },
        data: {
          content,
          msg_type: msgType,
          ...(target.rootMessageId ? { reply_in_thread: true } : {}),
        },
      });
    } else {
      await client.im.v1.message.create({
        params: { receive_id_type: receiveIdType },
        data: {
          receive_id: target.chatId,
          msg_type: msgType,
          content,
        },
      });
    }
  }

  async function sendTextToChat(chatId: string, text: string): Promise<void> {
    if (!client) return;
    try {
      await sendToFeishu(chatId, 'text', JSON.stringify({ text }));
    } catch (err) {
      logger.error({ chatId, err }, 'Failed to send Feishu text reply');
    }
  }

  async function handleIncomingMessage(
    payload: IncomingMessagePayload,
    source: 'ws' | 'backfill',
  ): Promise<void> {
    const {
      onNewChat,
      ignoreMessagesBefore,
      onCommand,
      resolveGroupFolder,
      resolveEffectiveChatJid,
      onAgentMessage,
      shouldProcessGroupMessage,
      isGroupOwnerMessage,
      isSenderAllowedInGroup,
      onP2pSender,
    } = connectOptions || {};
    const {
      chatId,
      messageId,
      rootId,
      parentId,
      threadId,
      createTimeMs,
      messageType,
      content: rawContent,
      mentions,
      chatType,
      senderOpenId = '',
      senderName,
    } = payload;
    if (!chatId || !messageId) return;

    if (isDuplicate(messageId)) {
      logger.debug({ messageId }, 'Duplicate message, skipping');
      return;
    }
    markSeen(messageId);
    logger.info(
      { messageId, messageType, chatId, source },
      'Feishu message received',
    );

    if (
      ignoreMessagesBefore &&
      createTimeMs > 0 &&
      createTimeMs < ignoreMessagesBefore
    ) {
      logger.info(
        {
          messageId,
          createTime: createTimeMs,
          threshold: ignoreMessagesBefore,
        },
        'Skipping stale Feishu message from before reconnection',
      );
      return;
    }

    const extracted = extractMessageContent(messageType, rawContent);
    let text = extracted.text;
    if (!text?.trim() && !extracted.imageKeys && !extracted.fileInfos?.length) {
      logger.info(
        { messageId, messageType },
        'No text or image content, skipping',
      );
      return;
    }

    if (mentions && Array.isArray(mentions)) {
      for (const mention of mentions) {
        if (mention.key) {
          text = text.replace(mention.key, `@${mention.name || ''}`);
        }
      }
    }

    const chatJid = `feishu:${chatId}`;
    const resolvedSenderName = senderName || getSenderName(senderOpenId);
    const resolvedChatName = chatType === 'p2p' ? '飞书私聊' : '飞书群聊';

    // 先注册会话，确保 resolveGroupFolder 能正确解析 folder（含首条文件消息场景）
    onNewChat?.(chatJid, resolvedChatName);

    // P2P 消息：通知调用方用于自动检测 owner open_id
    if (chatType === 'p2p' && senderOpenId && onP2pSender) {
      onP2pSender(senderOpenId);
    }

    let attachmentsJson: string | undefined;

    if (extracted.imageKeys && extracted.imageKeys.length > 0) {
      // 图片消息：下载后双轨处理
      // 1. Vision 通道：base64 附件供模型看图
      // 2. 存盘通道：写入工作区文件，agent 可直接操作（压缩、发送等）
      const attachments = [];
      const groupFolder = resolveGroupFolder?.(chatJid);
      const savedPaths: string[] = [];

      for (const imageKey of extracted.imageKeys) {
        const imageData = await downloadFeishuImage(messageId, imageKey);
        if (!imageData) continue;

        // Vision 附件
        attachments.push({
          type: 'image',
          data: imageData.base64,
          mimeType: imageData.mimeType,
        });

        // 存盘：扩展名从 mimeType 推断，对齐文件消息处理逻辑
        if (groupFolder) {
          const extMap: Record<string, string> = {
            'image/jpeg': '.jpg',
            'image/png': '.png',
            'image/gif': '.gif',
            'image/webp': '.webp',
            'image/bmp': '.bmp',
            'image/tiff': '.tiff',
          };
          const ext = extMap[imageData.mimeType] ?? '.jpg';
          const fileName = `feishu_img_${imageKey.slice(-8)}${ext}`;
          try {
            const relPath = await saveDownloadedFile(
              groupFolder,
              'feishu',
              fileName,
              Buffer.from(imageData.base64, 'base64'),
            );
            if (relPath) savedPaths.push(relPath);
          } catch (err) {
            logger.warn(
              { err, imageKey },
              'Failed to save Feishu image to disk',
            );
          }
        }
      }

      // 拼接图片标记：成功下载的用路径，失败的用占位符，确保 text 不为空。
      // 否则长图/超大图片下载失败时会落入 agent 的空消息分支，回复"消息是空的"。
      const failedCount = extracted.imageKeys.length - attachments.length;
      const markers: string[] = [];
      if (attachments.length > 0) {
        attachmentsJson = JSON.stringify(attachments);
        if (savedPaths.length > 0) {
          markers.push(...savedPaths.map((p) => `[图片: ${p}]`));
        } else {
          markers.push('[图片]');
        }
      }
      if (failedCount > 0) {
        markers.push(
          `[图片下载失败: ${failedCount} 张，可能超过飞书接口限制或网络异常]`,
        );
        logger.warn(
          { chatJid, messageId, failedCount, totalKeys: extracted.imageKeys.length },
          'Feishu image download failed for some or all images',
        );
      }
      const imgMarker = markers.join('\n');
      if (imgMarker) {
        text = text ? `${imgMarker}\n${text}` : imgMarker;
      }
    } else if (extracted.fileInfos && extracted.fileInfos.length > 0) {
      // 文件消息：下载到磁盘，路径内联替换
      logger.info(
        {
          chatJid,
          messageId,
          messageType,
          fileCount: extracted.fileInfos.length,
        },
        'Processing Feishu file download',
      );
      const groupFolder = resolveGroupFolder?.(chatJid);
      if (!groupFolder) {
        logger.warn(
          { chatJid },
          'Cannot resolve group folder for file download',
        );
        for (const fi of extracted.fileInfos) {
          const placeholder = `[文件: ${fi.filename || fi.fileKey}]`;
          text = text.replace(
            placeholder,
            `[文件下载失败: ${fi.filename || fi.fileKey}]`,
          );
        }
      } else {
        for (const fi of extracted.fileInfos) {
          const relPath = await downloadFeishuFileToDisk(
            messageId,
            fi.fileKey,
            fi.filename,
            groupFolder,
          );
          const placeholder = `[文件: ${fi.filename || fi.fileKey}]`;
          text = text.replace(
            placeholder,
            relPath
              ? `[文件: ${relPath}]`
              : `[文件下载失败: ${fi.filename || fi.fileKey}]`,
          );
        }
      }
    }

    lastMessageIdByChat.set(chatId, messageId);

    const resolvedCreateTimeMs = createTimeMs > 0 ? createTimeMs : Date.now();
    const timestamp = new Date(resolvedCreateTimeMs).toISOString();
    rememberChatProgress(chatId, resolvedCreateTimeMs, chatType);

    // ── 斜杠指令：拦截已知 /xxx 命令，不进入消息流 ──
    // 群聊中 @机器人 后跟斜杠命令，mention 替换后文本为 "@botname /cmd"，
    // 需要先 strip 掉开头的 @mention 前缀再匹配
    const textForSlash = text?.trim().replace(/^@\S+\s+/, '') ?? '';
    const slashMatch = textForSlash.match(/^\/(\S+)(.*)$/);
    if (slashMatch && onCommand) {
      const cmdBody = (slashMatch[1] + slashMatch[2]).trim();
      logger.info(
        { chatJid, cmd: slashMatch[1], cmdBody },
        'Feishu slash command detected',
      );
      try {
        const reply = await onCommand(chatJid, cmdBody, senderOpenId, mentions);
        logger.info(
          {
            chatJid,
            cmd: slashMatch[1],
            hasReply: !!reply,
            replyLen: reply?.length,
          },
          'Feishu slash command processed',
        );
        if (reply) {
          await sendTextToChat(chatId, reply);
          return; // 已知命令，拦截
        }
        // reply 为 null 表示未知命令，继续作为普通消息处理
      } catch (err) {
        logger.error(
          { chatJid, cmd: slashMatch[1], err },
          'Feishu slash command failed',
        );
        try {
          await sendTextToChat(chatId, '⚠️ 命令执行失败，请稍后重试');
        } catch (sendErr) {
          logger.error(
            { chatJid, sendErr },
            'Failed to send slash command error feedback',
          );
        }
        return;
      }
    }

    // ── 群聊发言者白名单过滤（命令已处理后，非白名单发言者丢弃或软拒绝） ──
    if (chatType === 'group' && isSenderAllowedInGroup && !isSenderAllowedInGroup(chatJid, senderOpenId)) {
      // 被 @bot 时回 SILENT 表情表达「看到但故意不回复」，让发言者知道 bot 并非无响应而是被白名单挡掉；
      // 未 @bot 时静默丢弃，避免把群聊闲聊污染成一堆表情。
      const isBotMentioned = !!botOpenId && (mentions?.some((m) => m.id?.open_id === botOpenId) ?? false);
      if (isBotMentioned) {
        addReaction(messageId, 'SILENT').catch(() => {});
        logger.debug(
          { chatJid, messageId, senderOpenId },
          'Soft-rejected group message with SILENT reaction: sender not in allowlist',
        );
      } else {
        logger.debug(
          { chatJid, messageId, senderOpenId },
          'Dropped group message: sender not in allowlist',
        );
      }
      return;
    }

    // ── 群聊 Mention 过滤：require_mention / owner_mentioned 模式下过滤 ──
    if (chatType === 'group' && shouldProcessGroupMessage) {
      const isBotMentioned = botOpenId
        ? (mentions?.some((m) => m.id?.open_id === botOpenId) ?? false)
        : true; // 无 bot open_id 时默认放行（安全降级）
      if (!isBotMentioned && !shouldProcessGroupMessage(chatJid, senderOpenId)) {
        logger.debug(
          { chatJid, messageId },
          'Dropped group message: mention required but bot not mentioned',
        );
        return;
      }
      // owner_mentioned 模式：bot 被 @mention 但发送者不是 owner 时丢弃
      if (isBotMentioned && isGroupOwnerMessage && !isGroupOwnerMessage(chatJid, senderOpenId)) {
        logger.debug(
          { chatJid, messageId, senderOpenId },
          'Dropped group message: owner_mentioned mode, sender is not owner',
        );
        return;
      }
    }

    // ── Ack Reaction：确认已收到消息（在 mention 过滤之后，避免对未处理的消息加表情） ──
    if (source === 'ws') {
      addReaction(messageId, 'OnIt')
        .then((reactionId) => {
          if (reactionId) {
            ackReactionByChat.set(chatId, `${messageId}:${reactionId}`);
          }
        })
        .catch(() => {});
    }

    // Store message and broadcast to WebSocket clients
    const routeSourceJid =
      threadId && (rootId || messageId)
        ? `feishu:${chatId}#thread:${threadId}#root:${rootId || messageId}`
        : chatJid;
    const agentRouting = resolveEffectiveChatJid?.(chatJid, {
      threadId,
      rootId: rootId || messageId,
      parentId,
      text,
    });
    const targetJid = agentRouting?.effectiveJid ?? chatJid;

    const targetAgentId = agentRouting?.agentId;

    storeChatMetadata(targetJid, timestamp);
    storeMessageDirect(
      messageId,
      targetJid,
      senderOpenId,
      resolvedSenderName,
      text,
      timestamp,
      false,
      { attachments: attachmentsJson, sourceJid: routeSourceJid },
    );
    broadcastNewMessage(
      targetJid,
      {
        id: messageId,
        chat_jid: targetJid,
        source_jid: routeSourceJid,
        sender: senderOpenId,
        sender_name: resolvedSenderName,
        content: text,
        timestamp,
        attachments: attachmentsJson,
      },
      targetAgentId ?? undefined,
    );
    notifyNewImMessage();

    if (agentRouting && agentRouting.agentId) {
      onAgentMessage?.(chatJid, agentRouting.agentId);
      logger.info(
        {
          chatJid,
          effectiveJid: targetJid,
          agentId: targetAgentId,
          sender: resolvedSenderName,
          messageId,
          source,
        },
        'Feishu message routed to conversation agent',
      );
    } else if (agentRouting) {
      // Routed to workspace main conversation (no agentId)
      logger.info(
        {
          chatJid,
          effectiveJid: targetJid,
          sender: resolvedSenderName,
          messageId,
          source,
        },
        'Feishu message routed to workspace main conversation',
      );
    } else {
      logger.info(
        { chatJid, sender: resolvedSenderName, messageId, source },
        'Feishu message stored',
      );
    }
  }

  async function backfillChatMessages(
    chatId: string,
    sinceMs: number,
  ): Promise<void> {
    if (!client) return;
    const nowSec = Math.floor(Date.now() / 1000);
    const startSec = Math.max(0, Math.floor(sinceMs / 1000));
    const params: {
      container_id_type: 'chat';
      container_id: string;
      sort_type: 'ByCreateTimeDesc';
      start_time: string;
      end_time: string;
      page_size: number;
      page_token?: string;
    } = {
      container_id_type: 'chat',
      container_id: chatId,
      sort_type: 'ByCreateTimeDesc',
      start_time: String(startSec),
      end_time: String(nowSec),
      page_size: BACKFILL_PAGE_SIZE,
    };

    let pages = 0;
    while (pages < BACKFILL_MAX_PAGES_PER_CHAT) {
      const response = (await client.im.v1.message.list({ params })) as {
        data?: {
          items?: Array<{
            message_id?: string;
            create_time?: string | number;
            msg_type?: string;
            message_type?: string;
            body?: { content?: string };
            content?: string;
            chat_type?: string;
            mentions?: FeishuMentionLike[];
            deleted?: boolean;
            root_id?: string;
            parent_id?: string;
            thread_id?: string;
            sender?: {
              id?: string;
              sender_type?: string;
              sender_id?: {
                open_id?: string;
              };
            };
          }>;
          has_more?: boolean;
          page_token?: string;
        };
      };

      const list = response.data?.items || [];
      const messages = list
        .filter((item) => {
          if (item.deleted === true || !item.message_id) return false;
          // 过滤 Bot 自身发送的消息，避免 backfill 将回复当作新消息处理
          const senderType = item.sender?.sender_type;
          if (senderType === 'app') return false;
          return true;
        })
        .map((item) => {
          const senderOpenId =
            item.sender?.sender_id?.open_id || item.sender?.id || '';
          return {
            chatId,
            messageId: item.message_id as string,
            rootId: item.root_id || undefined,
            parentId: item.parent_id || undefined,
            threadId: item.thread_id || undefined,
            createTimeMs: toEpochMs(item.create_time),
            messageType: item.msg_type || item.message_type || '',
            content: item.body?.content || item.content || '',
            chatType: item.chat_type || chatTypeById.get(chatId) || 'group',
            mentions: item.mentions,
            senderOpenId,
          };
        })
        .sort((a, b) => a.createTimeMs - b.createTimeMs);

      for (const message of messages) {
        await handleIncomingMessage(message, 'backfill');
      }

      pages++;
      if (!response.data?.has_more || !response.data.page_token) {
        break;
      }
      params.page_token = response.data.page_token;
    }
  }

  async function runBackfill(reason: string): Promise<void> {
    if (!client || backfillRunning) return;
    const chatIds = Array.from(knownChatIds);
    if (chatIds.length === 0) return;

    backfillRunning = true;
    try {
      const recoveredFrom = disconnectedSince ?? Date.now();
      for (const chatId of chatIds) {
        const lastSeen = lastCreateTimeByChat.get(chatId) || 0;
        const baseTs = lastSeen > 0 ? lastSeen : recoveredFrom;
        const sinceMs = Math.max(0, baseTs - BACKFILL_LOOKBACK_MS);
        try {
          await backfillChatMessages(chatId, sinceMs);
        } catch (err) {
          logger.warn({ err, chatId, reason }, 'Feishu chat backfill failed');
        }
      }
      logger.info(
        { reason, chatCount: chatIds.length },
        'Feishu backfill finished',
      );
    } finally {
      backfillRunning = false;
    }
  }

  async function reconnectWebSocket(reason: string): Promise<void> {
    if (reconnecting || !connectOptions) return;
    reconnecting = true;
    reconnectRequestedAt = Date.now();
    disconnectedChecks = 0;

    try {
      if (!eventDispatcher) {
        logger.warn(
          { reason },
          'Skip Feishu reconnect: event dispatcher is missing',
        );
        return;
      }
      if (wsClient) {
        try {
          await wsClient.close();
        } catch (err) {
          logger.debug(
            { err },
            'Error closing stale Feishu WS client before reconnect',
          );
        }
      }

      wsClient = new lark.WSClient({
        appId: config.appId,
        appSecret: config.appSecret,
        loggerLevel: lark.LoggerLevel.info,
      });
      await wsClient.start({ eventDispatcher });

      lastWsStateConnected = true;
      logger.info({ reason }, 'Feishu WebSocket reconnected');
      connectOptions.onReady();
      // 先执行 backfill（需要读取 disconnectedSince 确定回填起点），完成后再重置
      await runBackfill('reconnect');
      disconnectedSince = null;
    } catch (err) {
      logger.error({ err, reason }, 'Feishu WebSocket reconnect failed');
    } finally {
      reconnecting = false;
    }
  }

  async function checkConnectionHealth(): Promise<void> {
    if (!wsClient || reconnecting) return;

    const state = getWsConnectionState();
    if (!state) return;

    if (state.connected) {
      disconnectedChecks = 0;
      if (!lastWsStateConnected) {
        logger.info('Feishu WebSocket is back online');
        await runBackfill('recovered');
        disconnectedSince = null;
      }
      lastWsStateConnected = true;
      return;
    }

    if (lastWsStateConnected) {
      disconnectedSince = Date.now();
      logger.warn(
        { isConnecting: state.isConnecting },
        'Feishu WebSocket appears offline',
      );
    }
    lastWsStateConnected = false;

    const now = Date.now();
    const reconnectWindowReady =
      state.nextConnectTime <= 0 || state.nextConnectTime <= now;
    if (!reconnectWindowReady) return;

    disconnectedChecks++;
    if (
      disconnectedChecks >= WS_RECONNECT_CHECK_THRESHOLD &&
      now - reconnectRequestedAt >= WS_RECONNECT_MIN_INTERVAL_MS
    ) {
      await reconnectWebSocket('health-check');
    }
  }

  const connection: FeishuConnection = {
    async connect(opts: ConnectOptions): Promise<boolean> {
      const { onReady } = opts;

      if (!config.appId || !config.appSecret) {
        logger.warn('Feishu config is empty, running in Web-only mode');
        return false;
      }
      connectOptions = opts;
      disconnectedChecks = 0;
      disconnectedSince = null;
      reconnectRequestedAt = Date.now();
      reconnecting = false;
      backfillRunning = false;

      // Initialize client
      client = new lark.Client({
        appId: config.appId,
        appSecret: config.appSecret,
        appType: lark.AppType.SelfBuild,
      });

      // Fetch bot open_id for mention detection (best-effort, non-blocking)
      try {
        const botInfoRes = await client.request({
          method: 'GET',
          url: '/open-apis/bot/v3/info/',
        });
        const info = botInfoRes as { bot?: { open_id?: string }; data?: { bot?: { open_id?: string } } };
        botOpenId = info?.bot?.open_id || info?.data?.bot?.open_id || '';
        if (botOpenId) {
          logger.info(
            { botOpenId },
            'Fetched bot open_id for mention detection',
          );
        } else {
          logger.warn(
            'Could not fetch bot open_id, mention gating will be bypassed',
          );
        }
      } catch (err) {
        logger.warn(
          { err },
          'Failed to fetch bot info, mention gating will be bypassed',
        );
        botOpenId = '';
      }

      // Create event dispatcher
      eventDispatcher = new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data) => {
          try {
            const message = data.message;
            await handleIncomingMessage(
              {
                chatId: message.chat_id,
                messageId: message.message_id,
                rootId: message.root_id,
                parentId: message.parent_id,
                threadId: message.thread_id,
                createTimeMs: toEpochMs(message.create_time),
                messageType: message.message_type,
                content: message.content,
                chatType: message.chat_type,
                mentions: message.mentions as FeishuMentionLike[] | undefined,
                senderOpenId: data.sender.sender_id?.open_id || '',
              },
              'ws',
            );
          } catch (err) {
            logger.error({ err }, 'Error handling Feishu message');
          }
        },
        'im.chat.member.bot.added_v1': async (data) => {
          try {
            const chatId = data.chat_id;
            if (!chatId) return;
            const chatJid = `feishu:${chatId}`;
            const chatName = data.name || '飞书群聊';
            logger.info({ chatJid, chatName }, 'Bot added to Feishu group');
            connectOptions?.onBotAddedToGroup?.(chatJid, chatName);
          } catch (err) {
            logger.error({ err }, 'Error handling bot added to group event');
          }
        },
        'im.chat.member.bot.deleted_v1': async (data) => {
          try {
            const chatId = data.chat_id;
            if (!chatId) return;
            const chatJid = `feishu:${chatId}`;
            logger.info({ chatJid }, 'Bot removed from Feishu group');
            connectOptions?.onBotRemovedFromGroup?.(chatJid);
          } catch (err) {
            logger.error(
              { err },
              'Error handling bot removed from group event',
            );
          }
        },
        'im.chat.disbanded_v1': async (data) => {
          try {
            const chatId = data.chat_id;
            if (!chatId) return;
            const chatJid = `feishu:${chatId}`;
            logger.info({ chatJid }, 'Feishu group disbanded');
            connectOptions?.onBotRemovedFromGroup?.(chatJid);
          } catch (err) {
            logger.error({ err }, 'Error handling group disbanded event');
          }
        },
        'card.action.trigger': async (data: any) => {
          try {
            const action = data?.action?.value?.action;
            const messageId = data?.context?.open_message_id;
            if (action !== 'interrupt_stream' || !messageId) return;

            const chatJid = resolveJidByMessageId(messageId);
            if (!chatJid) {
              logger.debug({ messageId }, 'Card action: no mapping for messageId');
              return;
            }

            const session = getStreamingSession(chatJid);
            if (!session?.isActive()) {
              logger.debug({ chatJid, messageId }, 'Card action: session not active');
              return;
            }

            logger.info({ chatJid, messageId }, 'Card action: interrupt via button');
            connectOptions?.onCardInterrupt?.(chatJid);
          } catch (err) {
            logger.error({ err }, 'Error handling card action trigger');
          }
        },
      });

      // Initialize WebSocket client
      wsClient = new lark.WSClient({
        appId: config.appId,
        appSecret: config.appSecret,
        loggerLevel: lark.LoggerLevel.info,
      });

      try {
        await wsClient.start({ eventDispatcher });
        logger.info('Feishu WebSocket client started');
        lastWsStateConnected = true;
        disconnectedSince = null;
        startHealthMonitor();
        onReady();
        return true;
      } catch (err) {
        logger.error(
          { err },
          'Failed to start Feishu client, running in Web-only mode',
        );
        // Clean up partially initialized state
        stopHealthMonitor();
        connectOptions = null;
        eventDispatcher = null;
        client = null;
        wsClient = null;
        return false;
      }
    },

    async stop(): Promise<void> {
      stopHealthMonitor();
      connectOptions = null;
      eventDispatcher = null;
      reconnecting = false;
      disconnectedSince = null;
      disconnectedChecks = 0;
      if (wsClient) {
        logger.info('Stopping Feishu client');
        try {
          await wsClient.close();
          logger.info('Feishu client stopped successfully');
        } catch (err) {
          logger.warn({ err }, 'Error stopping Feishu client');
        }
        wsClient = null;
      }
      client = null;
      lastWsStateConnected = false;
    },

    async sendMessage(
      chatId: string,
      text: string,
      localImagePaths?: string[],
    ): Promise<void> {
      if (!client) {
        logger.warn(
          { chatId },
          'Feishu client not initialized, skip sending message',
        );
        return;
      }

      const clearAckReaction = () => {
        const ackStored = ackReactionByChat.get(chatId);
        if (ackStored) {
          const [ackMsgId, ackReactionId] = ackStored.split(':');
          removeReaction(ackMsgId, ackReactionId).catch(() => {});
          ackReactionByChat.delete(chatId);
        }
      };

      try {
        // Detect pre-built Feishu interactive card JSON — send directly without wrapping
        if (text.startsWith('{"type":"interactive"')) {
          try {
            const parsed = JSON.parse(text);
            if (parsed.type === 'interactive' && parsed.card) {
              await sendToFeishu(chatId,'interactive', text);
              clearAckReaction();
              return;
            }
          } catch {
            // Not valid card JSON, fall through to normal handling
          }
        }

        // Count markdown tables to decide format upfront — Feishu cards have a table limit
        // Each table has exactly one separator row (e.g. |---|---|), so counting those = table count
        const tableCount = (text.match(/^\|[\s:-]+\|/gm) || []).length;
        const usePostMd = tableCount > CARD_TABLE_LIMIT;

        if (usePostMd) {
          // Too many tables for card format, go directly to post+md
          const postContent = buildPostMdFallback(text);
          await sendToFeishu(chatId,'post', postContent);
        } else {
          const card = buildInteractiveCard(text);
          const content = JSON.stringify(card);
          try {
            await sendToFeishu(chatId,'interactive', content);
          } catch (err) {
            logger.warn(
              { err, chatId },
              'Feishu interactive send failed, fallback to post+md',
            );
            await sendToFeishu(chatId,'post', buildPostMdFallback(text));
          }
        }
        logger.debug({ chatId }, 'Sent Feishu card message');
        clearAckReaction();

        for (const localImagePath of localImagePaths || []) {
          try {
            const uploadRes = (await client.im.v1.image.create({
              data: {
                image_type: 'message',
                image: fs.createReadStream(localImagePath),
              },
            })) as
              | { image_key?: string; data?: { image_key?: string } }
              | null
              | undefined;
            const imageKey =
              uploadRes?.image_key ?? uploadRes?.data?.image_key;
            if (!imageKey) {
              logger.warn(
                { chatId, localImagePath },
                'Feishu image upload returned no image_key',
              );
              continue;
            }
            await sendToFeishu(chatId,'image', JSON.stringify({ image_key: imageKey }));
          } catch (imageErr) {
            logger.warn(
              { chatId, localImagePath, err: imageErr },
              'Failed to send Feishu image attachment',
            );
          }
        }
      } catch (err) {
        logger.error({ err, chatId }, 'Failed to send Feishu card message');
        clearAckReaction();
      }
    },

    async sendImage(
      chatId: string,
      imageBuffer: Buffer,
      mimeType: string,
      caption?: string,
      _fileName?: string /* Feishu image API has no filename field, intentionally unused */,
    ): Promise<void> {
      if (!client) {
        logger.warn(
          { chatId },
          'Feishu client not initialized, skip sending image',
        );
        return;
      }

      try {
        // Step 1: Upload image to Feishu to get image_key
        const uploadResult = (await client.im.v1.image.create({
          data: {
            image_type: 'message',
            image: imageBuffer,
          },
        })) as
          | { image_key?: string; data?: { image_key?: string } }
          | null
          | undefined;

        const imageKey =
          uploadResult?.image_key ?? uploadResult?.data?.image_key;
        if (!imageKey) {
          logger.error(
            { chatId },
            'Feishu image upload failed: no image_key returned',
          );
          throw new Error(
            'Feishu image upload failed: no image_key in response',
          );
        }

        // Step 2: Send image message
        await sendToFeishu(chatId, 'image', JSON.stringify({ image_key: imageKey }));

        // Step 3: If caption provided, send it as a follow-up text message
        if (caption) {
          await sendToFeishu(chatId, 'text', JSON.stringify({ text: caption }));
        }

        logger.info(
          { chatId, imageKey, mimeType, size: imageBuffer.length },
          'Feishu image sent',
        );
      } catch (err) {
        logger.error({ err, chatId, mimeType }, 'Failed to send Feishu image');
        throw err;
      }
    },

    async sendFile(
      chatId: string,
      filePath: string,
      fileName: string,
    ): Promise<void> {
      if (!client) {
        logger.warn(
          { chatId },
          'Feishu client not initialized, skip sending file',
        );
        return;
      }

      try {
        const buffer = await fsPromises.readFile(filePath);

        // Check file size limit (30MB)
        const MAX_FILE_SIZE = 30 * 1024 * 1024;
        if (buffer.length > MAX_FILE_SIZE) {
          throw new Error(
            `文件大小超过 30MB 限制 (${(buffer.length / 1024 / 1024).toFixed(2)}MB)`,
          );
        }

        const ext = path.extname(fileName);
        const fileType = getFileType(ext);

        // Upload file
        const uploadResult = (await client.im.v1.file.create({
          data: {
            file_type: fileType,
            file_name: fileName,
            file: buffer,
          },
        })) as
          | { file_key?: string; data?: { file_key?: string } }
          | null
          | undefined;

        const fileKey =
          uploadResult?.file_key ?? uploadResult?.data?.file_key;
        if (!fileKey) {
          throw new Error('文件上传失败：未返回 file_key');
        }

        // Determine msg_type: Feishu requires upload file_type and send msg_type to match.
        // mp4 → media (video message), opus → audio (audio message), others → file.
        const msgType = fileType === 'mp4' ? 'media' : fileType === 'opus' ? 'audio' : 'file';

        // Send file message
        await sendToFeishu(chatId, msgType, JSON.stringify({ file_key: fileKey }));

        logger.info(
          { chatId, fileName, fileSize: buffer.length },
          'File sent to Feishu',
        );
      } catch (err) {
        logger.error(
          { err, chatId, filePath },
          'Failed to send file to Feishu',
        );
        throw err;
      }
    },

    async sendReaction(chatId: string, isTyping: boolean): Promise<void> {
      if (!client) return;
      const target = parseFeishuRouteTarget(chatId);
      const reactionKey = target.chatId;
      const lastMsgId =
        target.rootMessageId || lastMessageIdByChat.get(target.chatId);
      if (!lastMsgId) return;

      if (isTyping) {
        const reactionId = await addReaction(lastMsgId, 'OnIt');
        if (reactionId) {
          typingReactionByChat.set(reactionKey, `${lastMsgId}:${reactionId}`);
        }
      } else {
        const stored = typingReactionByChat.get(reactionKey);
        if (stored) {
          const [msgId, reactionId] = stored.split(':');
          await removeReaction(msgId, reactionId);
          typingReactionByChat.delete(reactionKey);
        }
      }
    },

    clearAckReaction(chatId: string): void {
      const target = parseFeishuRouteTarget(chatId);
      const ackStored = ackReactionByChat.get(target.chatId);
      if (ackStored) {
        const [ackMsgId, ackReactionId] = ackStored.split(':');
        removeReaction(ackMsgId, ackReactionId).catch(() => {});
        ackReactionByChat.delete(target.chatId);
      }
    },

    isConnected(): boolean {
      return wsClient != null;
    },

    async getChatInfo(chatId: string): Promise<FeishuChatInfo | null> {
      if (!client) return null;
      try {
        const target = parseFeishuRouteTarget(chatId);
        const res = await client.im.v1.chat.get({
          path: { chat_id: target.chatId },
        });
        if (!res.data) return null;
        return {
          avatar: res.data.avatar,
          name: res.data.name,
          user_count: res.data.user_count,
          chat_type: res.data.chat_type,
          chat_mode: res.data.chat_mode,
          group_message_type: (res.data as { group_message_type?: string }).group_message_type,
        };
      } catch (err) {
        logger.warn({ err, chatId }, 'Failed to get Feishu chat info');
        return null;
      }
    },

    async syncGroups(): Promise<void> {
      if (!client) {
        logger.debug('Feishu client not initialized, skip group sync');
        return;
      }
      try {
        let pageToken: string | undefined;
        let hasMore = true;

        while (hasMore) {
          const res = await client.im.v1.chat.list({
            params: {
              page_size: 100,
              page_token: pageToken,
            },
          });

          const items = res.data?.items || [];
          for (const chat of items) {
            if (chat.chat_id && chat.name) {
              updateChatName(`feishu:${chat.chat_id}`, chat.name);
              knownChatIds.add(chat.chat_id);
            }
          }

          hasMore = res.data?.has_more || false;
          pageToken = res.data?.page_token;
        }

        setLastGroupSync();
        logger.info('Feishu group sync completed');
      } catch (err) {
        logger.error({ err }, 'Failed to sync Feishu groups');
      }
    },

    getLarkClient(): lark.Client | null {
      return client;
    },

    getLastMessageId(chatId: string): string | undefined {
      const target = parseFeishuRouteTarget(chatId);
      return target.rootMessageId || lastMessageIdByChat.get(target.chatId);
    },
  };

  return connection;
}

// ─── Backward-compatible global singleton ──────────────────────
// @deprecated — 旧的顶层导出函数，内部使用一个默认全局实例。
// 后续由 imManager 替代。

let _defaultInstance: FeishuConnection | null = null;

export interface ConnectFeishuOptions {
  onReady: () => void;
  /** 收到消息后调用，让主模块自动注册未知的飞书聊天到主容器 */
  onNewChat?: (chatJid: string, chatName: string) => void;
  /** 热重连时设置：丢弃 create_time 早于此时间戳（epoch ms）的消息，避免处理渠道关闭期间的堆积消息 */
  ignoreMessagesBefore?: number;
}

/**
 * @deprecated Use createFeishuConnection() factory instead. Will be replaced by imManager.
 * Connect to Feishu via WebSocket and start receiving messages.
 */
export async function connectFeishu(
  opts: ConnectFeishuOptions,
): Promise<boolean> {
  const { getFeishuProviderConfigWithSource } =
    await import('./runtime-config.js');
  const { config, source } = getFeishuProviderConfigWithSource();
  if (!config.appId || !config.appSecret) {
    logger.warn(
      { source },
      'Feishu config is empty, running in Web-only mode (set it in Settings -> Feishu config)',
    );
    return false;
  }

  _defaultInstance = createFeishuConnection({
    appId: config.appId,
    appSecret: config.appSecret,
  });

  return _defaultInstance.connect(opts);
}

/**
 * @deprecated Use FeishuConnection.sendMessage() instead.
 */
export async function sendFeishuMessage(
  chatId: string,
  text: string,
  localImagePaths?: string[],
): Promise<void> {
  if (!_defaultInstance) {
    logger.warn(
      { chatId },
      'Feishu client not initialized, skip sending message',
    );
    return;
  }
  return _defaultInstance.sendMessage(chatId, text, localImagePaths);
}

/**
 * @deprecated Use FeishuConnection.sendReaction() instead.
 */
export async function setFeishuTyping(
  chatId: string,
  isTyping: boolean,
): Promise<void> {
  if (!_defaultInstance) return;
  return _defaultInstance.sendReaction(chatId, isTyping);
}

/**
 * @deprecated Use FeishuConnection.syncGroups() instead.
 */
export async function syncFeishuGroups(): Promise<void> {
  if (!_defaultInstance) {
    logger.debug('Feishu client not initialized, skip group sync');
    return;
  }
  return _defaultInstance.syncGroups();
}

/**
 * @deprecated Use FeishuConnection.isConnected() instead.
 */
export function isFeishuConnected(): boolean {
  return _defaultInstance?.isConnected() ?? false;
}

/**
 * @deprecated Use FeishuConnection.stop() instead.
 */
export async function stopFeishu(): Promise<void> {
  if (_defaultInstance) {
    await _defaultInstance.stop();
    _defaultInstance = null;
  }
}
