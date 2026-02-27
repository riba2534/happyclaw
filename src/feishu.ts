import * as lark from '@larksuiteoapi/node-sdk';
import {
  setLastGroupSync,
  storeChatMetadata,
  storeMessageDirect,
  updateChatName,
} from './db.js';
import { logger } from './logger.js';
import { broadcastNewMessage } from './web.js';

// ─── FeishuConnection Interface ────────────────────────────────

export interface FeishuConnectionConfig {
  appId: string;
  appSecret: string;
}

export interface ConnectOptions {
  onReady: () => void;
  /** 收到消息后调用，让调用方自动注册未知的飞书聊天 */
  onNewChat?: (chatJid: string, chatName: string) => void;
  /** 热重连时设置：丢弃 create_time 早于此时间戳（epoch ms）的消息，避免处理渠道关闭期间的堆积消息 */
  ignoreMessagesBefore?: number;
}

export interface FeishuConnection {
  connect(opts: ConnectOptions): Promise<boolean>;
  stop(): Promise<void>;
  sendMessage(chatId: string, text: string): Promise<void>;
  sendReaction(chatId: string, isTyping: boolean): Promise<void>;
  isConnected(): boolean;
  syncGroups(): Promise<void>;
}

// ─── Shared Helpers (pure functions, no instance state) ────────

// Max characters per markdown element in Feishu cards
const CARD_MD_LIMIT = 4000;
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
}

interface IncomingMessagePayload {
  chatId: string;
  messageId: string;
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

/**
 * Extract message content from Feishu message.
 * Returns text content and optional image keys.
 */
function extractMessageContent(
  messageType: string,
  content: string,
): { text: string; imageKeys?: string[] } {
  try {
    const parsed = JSON.parse(content);

    if (messageType === 'text') {
      return { text: parsed.text || '' };
    }

    if (messageType === 'post') {
      // Recursively extract text from post content
      const lines: string[] = [];
      const post = parsed.post;
      if (!post) return { text: '' };

      // Try zh_cn first, then en_us, then other languages
      const contentData = post.zh_cn || post.en_us || Object.values(post)[0];
      if (!contentData || !Array.isArray(contentData.content)) return { text: '' };

      for (const paragraph of contentData.content) {
        if (!Array.isArray(paragraph)) continue;
        for (const segment of paragraph) {
          if (segment.tag === 'text' && segment.text) {
            lines.push(segment.text);
          }
        }
      }

      return { text: lines.join('\n') };
    }

    if (messageType === 'image') {
      const imageKey = parsed.image_key;
      if (imageKey) {
        return { text: '[图片]', imageKeys: [imageKey] };
      }
    }

    // Ignore other message types (file, audio, etc.)
    return { text: '' };
  } catch (err) {
    logger.warn(
      { err, messageType, content },
      'Failed to parse message content',
    );
    return { text: '' };
  }
}

/**
 * Split long text at paragraph boundaries to fit within card element limits.
 */
function splitAtParagraphs(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    // Prefer splitting at double newline (paragraph break)
    let idx = remaining.lastIndexOf('\n\n', maxLen);
    if (idx < maxLen * 0.3) {
      // Fallback to single newline
      idx = remaining.lastIndexOf('\n', maxLen);
    }
    if (idx < maxLen * 0.3) {
      // Hard split as last resort
      idx = maxLen;
    }
    chunks.push(remaining.slice(0, idx).trim());
    remaining = remaining.slice(idx).trim();
  }
  if (remaining) chunks.push(remaining);

  return chunks;
}

/**
 * Build a Feishu interactive card from markdown text.
 * Extracts headings as card title, splits content into visual sections.
 */
function buildInteractiveCard(text: string): object {
  const lines = text.split('\n');
  let title = '';
  let bodyStartIdx = 0;

  // Extract title from first heading if present
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    if (/^#{1,3}\s+/.test(lines[i])) {
      title = lines[i].replace(/^#+\s*/, '').trim();
      bodyStartIdx = i + 1;
    }
    break;
  }

  const body = lines.slice(bodyStartIdx).join('\n').trim();

  // Generate title if no heading found — use first line preview
  if (!title) {
    const firstLine = (lines.find((l) => l.trim()) || '')
      .replace(/[*_`#\[\]]/g, '')
      .trim();
    title =
      firstLine.length > 40
        ? firstLine.slice(0, 37) + '...'
        : firstLine || 'Reply';
  }

  // Build card elements
  const elements: Array<Record<string, unknown>> = [];
  const contentToRender = body || text.trim();

  if (contentToRender.length > CARD_MD_LIMIT) {
    // Long content: split into multiple markdown elements
    const chunks = splitAtParagraphs(contentToRender, CARD_MD_LIMIT);
    for (const chunk of chunks) {
      elements.push({ tag: 'markdown', content: chunk });
    }
  } else if (contentToRender) {
    // Split by horizontal rules for visual sections
    const sections = contentToRender.split(/\n-{3,}\n/);
    for (let i = 0; i < sections.length; i++) {
      if (i > 0) elements.push({ tag: 'hr' });
      const s = sections[i].trim();
      if (s) elements.push({ tag: 'markdown', content: s });
    }
  }

  // Ensure at least one element
  if (elements.length === 0) {
    elements.push({ tag: 'markdown', content: text.trim() });
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: 'plain_text', content: title },
      template: 'indigo',
    },
    elements,
  };
}

// ─── Factory Function ──────────────────────────────────────────

/**
 * Create an independent Feishu connection instance.
 * Each instance manages its own client, WebSocket, and state maps.
 */
export function createFeishuConnection(config: FeishuConnectionConfig): FeishuConnection {
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
  const lastCreateTimeByChat = new Map<string, number>();

  let client: lark.Client | null = null;
  let wsClient: lark.WSClient | null = null;
  let eventDispatcher: lark.EventDispatcher | null = null;
  let connectOptions: ConnectOptions | null = null;
  let reconnecting = false;
  let backfillRunning = false;
  let reconnectRequestedAt = 0;
  let lastWsStateConnected = false;
  let disconnectedChecks = 0;
  let disconnectedSince: number | null = null;
  let healthTimer: NodeJS.Timeout | null = null;

  function rememberChatProgress(chatId: string, createTimeMs: number): void {
    knownChatIds.add(chatId);
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
    msgCache.delete(msgId);
    msgCache.set(msgId, Date.now());
  }

  async function downloadFeishuImage(
    messageId: string,
    fileKey: string,
  ): Promise<string | null> {
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
        logger.warn({ messageId, fileKey }, 'Empty response from image download');
        return null;
      }

      return buffer.toString('base64');
    } catch (err) {
      logger.warn({ err, messageId, fileKey }, 'Failed to download Feishu image');
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

  async function handleIncomingMessage(
    payload: IncomingMessagePayload,
    source: 'ws' | 'backfill',
  ): Promise<void> {
    const { onNewChat, ignoreMessagesBefore } = connectOptions || {};
    const {
      chatId,
      messageId,
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

    if (ignoreMessagesBefore && createTimeMs > 0 && createTimeMs < ignoreMessagesBefore) {
      logger.info(
        { messageId, createTime: createTimeMs, threshold: ignoreMessagesBefore },
        'Skipping stale Feishu message from before reconnection',
      );
      return;
    }

    const extracted = extractMessageContent(messageType, rawContent);
    let text = extracted.text;
    if (!text && !extracted.imageKeys) {
      logger.debug(
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

    let attachmentsJson: string | undefined;
    if (extracted.imageKeys && extracted.imageKeys.length > 0) {
      const attachments = [];
      for (const imageKey of extracted.imageKeys) {
        const base64Data = await downloadFeishuImage(messageId, imageKey);
        if (base64Data) {
          attachments.push({
            type: 'image',
            data: base64Data,
            mimeType: 'image/png',
          });
        }
      }
      if (attachments.length > 0) {
        attachmentsJson = JSON.stringify(attachments);
      }
    }

    if (source === 'ws') {
      addReaction(messageId, 'OnIt')
        .then((reactionId) => {
          if (reactionId) {
            ackReactionByChat.set(chatId, `${messageId}:${reactionId}`);
          }
        })
        .catch(() => {});
    }
    lastMessageIdByChat.set(chatId, messageId);

    const resolvedCreateTimeMs = createTimeMs > 0 ? createTimeMs : Date.now();
    const timestamp = new Date(resolvedCreateTimeMs).toISOString();
    rememberChatProgress(chatId, resolvedCreateTimeMs);

    const chatJid = `feishu:${chatId}`;
    const resolvedSenderName = senderName || getSenderName(senderOpenId);
    const resolvedChatName = chatType === 'p2p' ? '飞书私聊' : '飞书群聊';
    onNewChat?.(chatJid, resolvedChatName);

    storeChatMetadata(chatJid, timestamp);
    storeMessageDirect(
      messageId,
      chatJid,
      senderOpenId,
      resolvedSenderName,
      text,
      timestamp,
      false,
      attachmentsJson,
    );

    broadcastNewMessage(chatJid, {
      id: messageId,
      chat_jid: chatJid,
      sender: senderOpenId,
      sender_name: resolvedSenderName,
      content: text,
      timestamp,
      attachments: attachmentsJson,
    });

    logger.info(
      { chatJid, sender: resolvedSenderName, messageId, source },
      'Feishu message stored',
    );
  }

  async function backfillChatMessages(chatId: string, sinceMs: number): Promise<void> {
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
            sender?: {
              id?: string;
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
          const senderType = (item as any).sender?.sender_type;
          if (senderType === 'app') return false;
          return true;
        })
        .map((item) => {
          const senderOpenId = item.sender?.sender_id?.open_id || item.sender?.id || '';
          return {
            chatId,
            messageId: item.message_id as string,
            createTimeMs: toEpochMs(item.create_time),
            messageType: item.msg_type || item.message_type || '',
            content: item.body?.content || item.content || '',
            chatType: item.chat_type,
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
      logger.info({ reason, chatCount: chatIds.length }, 'Feishu backfill finished');
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
        logger.warn({ reason }, 'Skip Feishu reconnect: event dispatcher is missing');
        return;
      }
      if (wsClient) {
        try {
          await wsClient.close();
        } catch (err) {
          logger.debug({ err }, 'Error closing stale Feishu WS client before reconnect');
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
      logger.warn({ isConnecting: state.isConnecting }, 'Feishu WebSocket appears offline');
    }
    lastWsStateConnected = false;

    const now = Date.now();
    const reconnectWindowReady = state.nextConnectTime <= 0 || state.nextConnectTime <= now;
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
        logger.warn(
          'Feishu config is empty, running in Web-only mode',
        );
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

      // Create event dispatcher
      eventDispatcher = new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data) => {
          try {
            const message = data.message;
            await handleIncomingMessage(
              {
                chatId: message.chat_id,
                messageId: message.message_id,
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

    async sendMessage(chatId: string, text: string): Promise<void> {
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
        const card = buildInteractiveCard(text);
        const content = JSON.stringify(card);

        const lastMsgId = lastMessageIdByChat.get(chatId);
        if (lastMsgId) {
          try {
            await client.im.message.reply({
              path: { message_id: lastMsgId },
              data: { content, msg_type: 'interactive' },
            });
          } catch (err) {
            logger.warn(
              { err, chatId },
              'Feishu interactive reply failed, fallback to plain text',
            );
            await client.im.message.reply({
              path: { message_id: lastMsgId },
              data: {
                content: JSON.stringify({ text }),
                msg_type: 'text',
              },
            });
          }
        } else {
          try {
            await client.im.v1.message.create({
              params: { receive_id_type: 'chat_id' },
              data: {
                receive_id: chatId,
                msg_type: 'interactive',
                content,
              },
            });
          } catch (err) {
            logger.warn(
              { err, chatId },
              'Feishu interactive create failed, fallback to plain text',
            );
            await client.im.v1.message.create({
              params: { receive_id_type: 'chat_id' },
              data: {
                receive_id: chatId,
                msg_type: 'text',
                content: JSON.stringify({ text }),
              },
            });
          }
        }
        logger.debug({ chatId }, 'Sent Feishu card message');
        clearAckReaction();
      } catch (err) {
        logger.error({ err, chatId }, 'Failed to send Feishu card message');
        clearAckReaction();
      }
    },

    async sendReaction(chatId: string, isTyping: boolean): Promise<void> {
      if (!client) return;
      const lastMsgId = lastMessageIdByChat.get(chatId);
      if (!lastMsgId) return;

      if (isTyping) {
        const reactionId = await addReaction(lastMsgId, 'OnIt');
        if (reactionId) {
          typingReactionByChat.set(chatId, `${lastMsgId}:${reactionId}`);
        }
      } else {
        const stored = typingReactionByChat.get(chatId);
        if (stored) {
          const [msgId, reactionId] = stored.split(':');
          await removeReaction(msgId, reactionId);
          typingReactionByChat.delete(chatId);
        }
      }
    },

    isConnected(): boolean {
      return wsClient != null;
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
export async function connectFeishu(opts: ConnectFeishuOptions): Promise<boolean> {
  const { getFeishuProviderConfigWithSource } = await import('./runtime-config.js');
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
): Promise<void> {
  if (!_defaultInstance) {
    logger.warn(
      { chatId },
      'Feishu client not initialized, skip sending message',
    );
    return;
  }
  return _defaultInstance.sendMessage(chatId, text);
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
