/**
 * Unified IM Channel Interface
 *
 * Defines a standard interface for all IM integrations (Feishu, Telegram, etc.)
 * and provides adapter factories that wrap existing connection implementations.
 */
import {
  createFeishuConnection,
  type FeishuConnection,
  type FeishuConnectionConfig,
} from './feishu.js';
import {
  createTelegramConnection,
  type TelegramConnection,
  type TelegramConnectionConfig,
} from './telegram.js';
import {
  createQQConnection,
  type QQConnection,
  type QQConnectionConfig,
} from './qq.js';
import {
  createWeChatConnection,
  type WeChatConnection,
  type WeChatConnectionConfig,
} from './wechat.js';
import {
  createDingTalkConnection,
  type DingTalkConnection,
  type DingTalkConnectionConfig,
} from './dingtalk.js';
import {
  createDiscordConnection,
  type DiscordConnection,
  type DiscordConnectionConfig,
  type DiscordHistoryMessage,
  type DiscordHistoryOpts,
  type DiscordChannelInfo,
  type DiscordGuildInfo,
} from './discord.js';
import {
  createWhatsAppConnection,
  type WhatsAppConnection,
  type WhatsAppConnectionConfig,
  type WhatsAppConnectionState,
} from './whatsapp.js';
import { logger } from './logger.js';
import type { FeishuMessageMeta } from './types.js';
import {
  StreamingCardController,
  type StreamingCardOptions,
} from './feishu-streaming-card.js';
import type { DingTalkStreamingCardController } from './dingtalk-streaming-card.js';
import type { DiscordStreamingEditController } from './discord-streaming-edit.js';
import type { QQStreamingController } from './qq-streaming-card.js';
import { CHANNEL_PREFIXES } from './channel-prefixes.js';

/** Union type for any streaming card controller (Feishu, DingTalk, Discord, or QQ) */
export type StreamingSession =
  | StreamingCardController
  | DingTalkStreamingCardController
  | DiscordStreamingEditController
  | QQStreamingController;

// ─── Unified Interface ──────────────────────────────────────────

export interface IMChannelConnectOpts {
  onReady: () => void;
  onNewChat: (chatJid: string, chatName: string) => void;
  onMessage?: (chatJid: string, text: string, senderName: string) => void;
  ignoreMessagesBefore?: number;
  isChatAuthorized?: (jid: string) => boolean;
  onPairAttempt?: (
    jid: string,
    chatName: string,
    code: string,
  ) => Promise<boolean>;
  /** Slash command callback (e.g. /clear). Returns reply text or null.
   *  senderImId is the channel-specific user ID (e.g. Discord user.id, Telegram from.id);
   *  channels that don't have a stable per-user ID may pass undefined. */
  onCommand?: (
    chatJid: string,
    command: string,
    senderImId?: string,
  ) => Promise<string | null>;
  /** 根据 jid 解析群组 folder，用于下载文件/图片到工作区 */
  resolveGroupFolder?: (jid: string) => string | undefined;
  /** 将 IM chatJid 解析为绑定目标 JID（conversation agent 或工作区主对话） */
  resolveEffectiveChatJid?: (
    chatJid: string,
    messageMeta?: FeishuMessageMeta,
  ) => { effectiveJid: string; agentId: string | null } | null;
  /** 当 IM 消息被路由到 conversation agent 后调用，触发 agent 处理 */
  onAgentMessage?: (baseChatJid: string, agentId: string) => void;
  /** Bot 被添加到群聊时调用 */
  onBotAddedToGroup?: (chatJid: string, chatName: string) => void;
  /** Bot 被移出群聊或群被解散时调用 */
  onBotRemovedFromGroup?: (chatJid: string) => void;
  /** 群聊消息过滤：bot 未被 @mention 时调用，返回 true 则处理，false 则丢弃 */
  shouldProcessGroupMessage?: (chatJid: string, senderImId?: string) => boolean;
  /** owner_mentioned 模式下检查发送者是否为 owner */
  isGroupOwnerMessage?: (chatJid: string, senderImId?: string) => boolean;
  /** 发言者白名单：返回 false 则丢弃（命令处理后、mention 门控前调用） */
  isSenderAllowedInGroup?: (chatJid: string, senderImId?: string) => boolean;
  /** Resolve registered group for a jid */
  resolveRegisteredGroup?: (jid: string) => { activation_mode?: string } | undefined;
  /** 飞书流式卡片按钮中断回调 */
  onCardInterrupt?: (chatJid: string) => void;
  /** P2P（私聊）消息到达时调用，用于自动检测 owner open_id（仅飞书） */
  onP2pSender?: (senderOpenId: string) => void;
}

export interface IMChannel {
  readonly channelType: string;
  connect(opts: IMChannelConnectOpts): Promise<boolean>;
  disconnect(): Promise<void>;
  sendMessage(
    chatId: string,
    text: string,
    localImagePaths?: string[],
  ): Promise<void>;
  /** Send file to chat (if supported) */
  sendFile?(chatId: string, filePath: string, fileName: string): Promise<void>;
  sendImage?(
    chatId: string,
    imageBuffer: Buffer,
    mimeType: string,
    caption?: string,
    fileName?: string,
  ): Promise<void>;
  setTyping(chatId: string, isTyping: boolean): Promise<void>;
  /** Clear the ack reaction for a chat (e.g. when streaming card handled the reply) */
  clearAckReaction?(chatId: string): void;
  isConnected(): boolean;
  syncGroups?(): Promise<void>;
  /** Create a streaming card session for real-time card updates (Feishu or DingTalk) */
  createStreamingSession?(
    chatId: string,
    onCardCreated?: (messageId: string) => void,
  ): Promise<StreamingSession | undefined>;
  getChatInfo?(chatId: string): Promise<{
    avatar?: string;
    name?: string;
    user_count?: string;
    chat_type?: string;
    chat_mode?: string;
    group_message_type?: string;
  } | null>;
}

// ─── Channel Registry ───────────────────────────────────────────

/** Backward-compatible registry derived from the shared CHANNEL_PREFIXES. */
export const CHANNEL_REGISTRY: Record<string, { prefix: string }> =
  Object.fromEntries(
    Object.entries(CHANNEL_PREFIXES).map(([type, prefix]) => [
      type,
      { prefix },
    ]),
  );

/**
 * Determine the channel type from a JID string.
 * Returns the matching channelType key or null if no prefix matches.
 */
export function getChannelType(jid: string): string | null {
  for (const [type, prefix] of Object.entries(CHANNEL_PREFIXES)) {
    if (jid.startsWith(prefix)) return type;
  }
  return null;
}

/**
 * Strip the channel prefix from a JID, returning the raw chat ID.
 */
export function extractChatId(jid: string): string {
  for (const prefix of Object.values(CHANNEL_PREFIXES)) {
    if (jid.startsWith(prefix)) return jid.slice(prefix.length);
  }
  return jid;
}

// ─── Feishu Adapter ─────────────────────────────────────────────

export function createFeishuChannel(config: FeishuConnectionConfig): IMChannel {
  let inner: FeishuConnection | null = null;

  const channel: IMChannel = {
    channelType: 'feishu',

    async connect(opts: IMChannelConnectOpts): Promise<boolean> {
      inner = createFeishuConnection(config);
      const connected = await inner.connect({
        onReady: opts.onReady,
        onNewChat: opts.onNewChat,
        ignoreMessagesBefore: opts.ignoreMessagesBefore,
        onCommand: opts.onCommand,
        resolveGroupFolder: opts.resolveGroupFolder,
        resolveEffectiveChatJid: opts.resolveEffectiveChatJid,
        onAgentMessage: opts.onAgentMessage,
        onBotAddedToGroup: opts.onBotAddedToGroup,
        onBotRemovedFromGroup: opts.onBotRemovedFromGroup,
        shouldProcessGroupMessage: opts.shouldProcessGroupMessage,
        isGroupOwnerMessage: opts.isGroupOwnerMessage,
        isSenderAllowedInGroup: opts.isSenderAllowedInGroup,
        onCardInterrupt: opts.onCardInterrupt,
        onP2pSender: opts.onP2pSender,
      });
      if (!connected) {
        inner = null;
      }
      return connected;
    },

    async disconnect(): Promise<void> {
      if (inner) {
        await inner.stop();
        inner = null;
      }
    },

    async sendMessage(
      chatId: string,
      text: string,
      localImagePaths?: string[],
    ): Promise<void> {
      if (!inner) {
        logger.warn(
          { chatId },
          'Feishu channel not connected, skip sending message',
        );
        return;
      }
      await inner.sendMessage(chatId, text, localImagePaths);
    },

    async sendImage(
      chatId: string,
      imageBuffer: Buffer,
      mimeType: string,
      caption?: string,
      fileName?: string,
    ): Promise<void> {
      if (!inner) {
        logger.warn(
          { chatId },
          'Feishu channel not connected, skip sending image',
        );
        return;
      }
      await inner.sendImage(chatId, imageBuffer, mimeType, caption, fileName);
    },

    async setTyping(chatId: string, isTyping: boolean): Promise<void> {
      if (!inner) return;
      await inner.sendReaction(chatId, isTyping);
    },

    clearAckReaction(chatId: string): void {
      if (!inner) return;
      inner.clearAckReaction(chatId);
    },

    isConnected(): boolean {
      return inner?.isConnected() ?? false;
    },

    async syncGroups(): Promise<void> {
      if (!inner) return;
      await inner.syncGroups();
    },

    async sendFile(
      chatId: string,
      filePath: string,
      fileName: string,
    ): Promise<void> {
      if (!inner) {
        logger.warn(
          { chatId },
          'Feishu channel not connected, skip sending file',
        );
        return;
      }
      await inner.sendFile(chatId, filePath, fileName);
    },

    async getChatInfo(chatId: string) {
      if (!inner) return null;
      return inner.getChatInfo(chatId);
    },

    async createStreamingSession(
      chatId: string,
      onCardCreated?: (messageId: string) => void,
    ): Promise<StreamingSession | undefined> {
      if (!inner) return undefined;
      const larkClient = inner.getLarkClient();
      if (!larkClient) return undefined;
      const opts: StreamingCardOptions = {
        client: larkClient,
        chatId,
        replyToMsgId: inner.getLastMessageId(chatId),
        onCardCreated,
      };
      return new StreamingCardController(opts);
    },
  };

  return channel;
}

// ─── Telegram Adapter ───────────────────────────────────────────

export function createTelegramChannel(
  config: TelegramConnectionConfig,
): IMChannel {
  let inner: TelegramConnection | null = null;
  // Telegram typing indicator expires after ~5s; resend every 4s while active.
  let typingTimer: NodeJS.Timeout | null = null;

  function clearTypingTimer(): void {
    if (typingTimer) {
      clearInterval(typingTimer);
      typingTimer = null;
    }
  }

  const channel: IMChannel = {
    channelType: 'telegram',

    async connect(opts: IMChannelConnectOpts): Promise<boolean> {
      inner = createTelegramConnection(config);
      try {
        await inner.connect({
          onReady: opts.onReady,
          onNewChat: opts.onNewChat,
          isChatAuthorized: opts.isChatAuthorized ?? (() => true),
          onPairAttempt: opts.onPairAttempt,
          onCommand: opts.onCommand,
          ignoreMessagesBefore: opts.ignoreMessagesBefore,
          resolveGroupFolder: opts.resolveGroupFolder,
          resolveEffectiveChatJid: opts.resolveEffectiveChatJid,
          onAgentMessage: opts.onAgentMessage,
          onBotAddedToGroup: opts.onBotAddedToGroup,
          onBotRemovedFromGroup: opts.onBotRemovedFromGroup,
        });
        return inner.isConnected();
      } catch (err) {
        logger.error({ err }, 'Telegram channel connect failed');
        inner = null;
        return false;
      }
    },

    async disconnect(): Promise<void> {
      clearTypingTimer();
      if (inner) {
        await inner.disconnect();
        inner = null;
      }
    },

    async sendMessage(
      chatId: string,
      text: string,
      localImagePaths?: string[],
    ): Promise<void> {
      if (!inner) {
        logger.warn(
          { chatId },
          'Telegram channel not connected, skip sending message',
        );
        return;
      }
      await inner.sendMessage(chatId, text, localImagePaths);
    },

    async sendImage(
      chatId: string,
      imageBuffer: Buffer,
      mimeType: string,
      caption?: string,
      fileName?: string,
    ): Promise<void> {
      if (!inner) {
        logger.warn(
          { chatId },
          'Telegram channel not connected, skip sending image',
        );
        return;
      }
      await inner.sendImage(chatId, imageBuffer, mimeType, caption, fileName);
    },

    async sendFile(
      chatId: string,
      filePath: string,
      fileName: string,
    ): Promise<void> {
      if (!inner) {
        logger.warn(
          { chatId },
          'Telegram channel not connected, skip sending file',
        );
        return;
      }
      await inner.sendFile(chatId, filePath, fileName);
    },

    async setTyping(chatId: string, isTyping: boolean): Promise<void> {
      // Always clear existing timer first
      clearTypingTimer();
      if (!isTyping || !inner) return;

      const sendAction = async (): Promise<void> => {
        if (!inner) return;
        await inner.sendChatAction(chatId, 'typing');
      };

      // Send immediately, then repeat every 4s to keep indicator alive
      void sendAction();
      typingTimer = setInterval(() => {
        void sendAction();
      }, 4000);
    },

    isConnected(): boolean {
      return inner?.isConnected() ?? false;
    },
  };

  return channel;
}

// ─── QQ Adapter ─────────────────────────────────────────────────

export function createQQChannel(config: QQConnectionConfig): IMChannel {
  let inner: QQConnection | null = null;

  const channel: IMChannel = {
    channelType: 'qq',

    async connect(opts: IMChannelConnectOpts): Promise<boolean> {
      inner = createQQConnection(config);
      try {
        await inner.connect({
          onReady: opts.onReady,
          onNewChat: opts.onNewChat,
          isChatAuthorized: opts.isChatAuthorized ?? (() => true),
          onPairAttempt: opts.onPairAttempt,
          onCommand: opts.onCommand,
          ignoreMessagesBefore: opts.ignoreMessagesBefore,
          resolveGroupFolder: opts.resolveGroupFolder,
          resolveEffectiveChatJid: opts.resolveEffectiveChatJid,
          onAgentMessage: opts.onAgentMessage,
        });
        return inner.isConnected();
      } catch (err) {
        logger.error({ err }, 'QQ channel connect failed');
        inner = null;
        return false;
      }
    },

    async disconnect(): Promise<void> {
      if (inner) {
        await inner.disconnect();
        inner = null;
      }
    },

    async sendMessage(
      chatId: string,
      text: string,
      localImagePaths?: string[],
    ): Promise<void> {
      if (!inner) {
        logger.warn(
          { chatId },
          'QQ channel not connected, skip sending message',
        );
        return;
      }
      await inner.sendMessage(chatId, text, localImagePaths);
    },

    async sendImage(
      chatId: string,
      imageBuffer: Buffer,
      mimeType: string,
      caption?: string,
      fileName?: string,
    ): Promise<void> {
      if (!inner) {
        logger.warn(
          { chatId },
          'QQ channel not connected, skip sending image',
        );
        return;
      }
      await inner.sendImage(chatId, imageBuffer, mimeType, caption, fileName);
    },

    async sendFile(
      chatId: string,
      filePath: string,
      fileName: string,
    ): Promise<void> {
      if (!inner) {
        logger.warn(
          { chatId },
          'QQ channel not connected, skip sending file',
        );
        return;
      }
      await inner.sendFile(chatId, filePath, fileName);
    },

    async setTyping(_chatId: string, _isTyping: boolean): Promise<void> {
      // QQ Bot API v2 does not support typing indicators
    },

    isConnected(): boolean {
      return inner?.isConnected() ?? false;
    },

    async createStreamingSession(
      chatId: string,
      _onCardCreated?: (messageId: string) => void,
    ): Promise<StreamingSession | undefined> {
      if (!inner) return undefined;
      // Stream messages only work for C2C (private chat)
      if (chatId.startsWith('group:')) return undefined;

      const { QQStreamingController } = await import('./qq-streaming-card.js');
      const openid = chatId.startsWith('c2c:') ? chatId.slice(4) : chatId;
      const chatKey = `c2c:${openid}`;
      const msgSeq = inner.getNextMsgSeq(chatKey);
      const passiveMsgId = inner.getLastIncomingMsgId(openid);
      const conn = inner;

      if (!passiveMsgId) {
        // QQ stream_messages endpoint rejects requests without a passive
        // msg_id reference. Without it there's no point starting a session.
        logger.debug(
          { openid },
          'QQ streaming session skipped: no incoming msg_id yet',
        );
        return undefined;
      }

      return new QQStreamingController({
        openid,
        msgSeq,
        sendStreamChunk: (oid, params) => conn.sendStreamMessage(oid, params),
        fallbackSend: (text) => conn.sendMessage(chatKey, text),
        passiveMsgId,
      });
    },
  };

  return channel;
}

// ─── WeChat Adapter ─────────────────────────────────────────────

export function createWeChatChannel(config: WeChatConnectionConfig): IMChannel {
  let inner: WeChatConnection | null = null;

  const channel: IMChannel = {
    channelType: 'wechat',

    async connect(opts: IMChannelConnectOpts): Promise<boolean> {
      inner = createWeChatConnection(config);
      try {
        await inner.connect({
          onReady: opts.onReady,
          onNewChat: opts.onNewChat,
          onCommand: opts.onCommand,
          ignoreMessagesBefore: opts.ignoreMessagesBefore,
          resolveGroupFolder: opts.resolveGroupFolder,
          resolveEffectiveChatJid: opts.resolveEffectiveChatJid,
          onAgentMessage: opts.onAgentMessage,
        });
        return inner.isConnected();
      } catch (err) {
        logger.error({ err }, 'WeChat channel connect failed');
        inner = null;
        return false;
      }
    },

    async disconnect(): Promise<void> {
      if (inner) {
        await inner.disconnect();
        inner = null;
      }
    },

    async sendMessage(chatId: string, text: string): Promise<void> {
      if (!inner) {
        logger.warn(
          { chatId },
          'WeChat channel not connected, skip sending message',
        );
        return;
      }
      await inner.sendMessage(chatId, text);
    },

    async sendImage(
      chatId: string,
      imageBuffer: Buffer,
      mimeType: string,
      caption?: string,
      fileName?: string,
    ): Promise<void> {
      if (!inner) {
        logger.warn(
          { chatId },
          'WeChat channel not connected, skip sending image',
        );
        return;
      }
      await inner.sendImage(chatId, imageBuffer, mimeType, caption, fileName);
    },

    async sendFile(
      chatId: string,
      filePath: string,
      fileName: string,
    ): Promise<void> {
      if (!inner) {
        logger.warn(
          { chatId },
          'WeChat channel not connected, skip sending file',
        );
        return;
      }
      await inner.sendFile(chatId, filePath, fileName);
    },

    async setTyping(chatId: string, isTyping: boolean): Promise<void> {
      if (!inner) return;
      await inner.sendTyping(chatId, isTyping);
    },

    isConnected(): boolean {
      return inner?.isConnected() ?? false;
    },
  };

  return channel;
}

// ─── DingTalk Adapter ────────────────────────────────────────────

export function createDingTalkChannel(
  config: DingTalkConnectionConfig,
): IMChannel {
  let inner: DingTalkConnection | null = null;

  const channel: IMChannel = {
    channelType: 'dingtalk',

    async connect(opts: IMChannelConnectOpts): Promise<boolean> {
      inner = createDingTalkConnection(config);
      try {
        await inner.connect({
          onReady: opts.onReady,
          onNewChat: opts.onNewChat,
          isChatAuthorized: opts.isChatAuthorized ?? (() => true),
          onPairAttempt: opts.onPairAttempt,
          onCommand: opts.onCommand,
          ignoreMessagesBefore: opts.ignoreMessagesBefore,
          resolveGroupFolder: opts.resolveGroupFolder,
          resolveEffectiveChatJid: opts.resolveEffectiveChatJid,
          onAgentMessage: opts.onAgentMessage,
          onBotAddedToGroup: opts.onBotAddedToGroup,
          onBotRemovedFromGroup: opts.onBotRemovedFromGroup,
          shouldProcessGroupMessage: opts.shouldProcessGroupMessage,
          isGroupOwnerMessage: opts.isGroupOwnerMessage,
          resolveRegisteredGroup: opts.resolveRegisteredGroup,
        });
        return inner.isConnected();
      } catch (err) {
        logger.error({ err }, 'DingTalk channel connect failed');
        inner = null;
        return false;
      }
    },

    async disconnect(): Promise<void> {
      if (inner) {
        await inner.disconnect();
        inner = null;
      }
    },

    async sendMessage(chatId: string, text: string): Promise<void> {
      if (!inner) {
        logger.warn(
          { chatId },
          'DingTalk channel not connected, skip sending message',
        );
        return;
      }
      await inner.sendMessage(chatId, text);
    },

    async setTyping(_chatId: string, _isTyping: boolean): Promise<void> {
      // DingTalk Stream SDK does not support typing indicators
    },

    async sendImage(
      chatId: string,
      imageBuffer: Buffer,
      mimeType: string,
      caption?: string,
      fileName?: string,
    ): Promise<void> {
      if (!inner) {
        logger.warn(
          { chatId },
          'DingTalk channel not connected, skip sending image',
        );
        return;
      }
      await inner.sendImage(chatId, imageBuffer, mimeType, caption, fileName);
    },

    async sendFile(
      chatId: string,
      filePath: string,
      fileName: string,
    ): Promise<void> {
      if (!inner) {
        logger.warn(
          { chatId },
          'DingTalk channel not connected, skip sending file',
        );
        return;
      }
      await inner.sendFile(chatId, filePath, fileName);
    },

    clearAckReaction(chatId: string): void {
      if (!inner) return;
      inner.clearAckReaction(chatId);
    },

    isConnected(): boolean {
      return inner?.isConnected() ?? false;
    },

    async createStreamingSession(
      chatId: string,
      onCardCreated?: (messageId: string) => void,
    ): Promise<StreamingSession | undefined> {
      if (!inner?.createStreamingSession) return undefined;
      return inner.createStreamingSession(chatId, onCardCreated);
    },
  };

  return channel;
}

// ─── Discord Adapter ────────────────────────────────────────────

/**
 * Discord-specific extensions on top of the unified IMChannel interface.
 * Used by im-manager to route Discord-only capabilities (history, channel/guild metadata).
 */
export interface DiscordChannelExtensions {
  getDiscordHistory(
    chatId: string,
    opts?: DiscordHistoryOpts,
  ): Promise<DiscordHistoryMessage[]>;
  getDiscordChannelInfo(chatId: string): Promise<DiscordChannelInfo>;
  getDiscordGuildInfo(chatId: string): Promise<DiscordGuildInfo | null>;
}

/** Type guard: does this IMChannel expose Discord-specific extensions? */
export function isDiscordChannel(
  ch: IMChannel,
): ch is IMChannel & DiscordChannelExtensions {
  return (
    ch.channelType === 'discord' &&
    typeof (ch as Partial<DiscordChannelExtensions>).getDiscordHistory ===
      'function'
  );
}

export function createDiscordChannel(
  config: DiscordConnectionConfig,
  opts?: { streamingMode?: 'edit' | 'off' },
): IMChannel & DiscordChannelExtensions {
  const streamingEnabled = opts?.streamingMode === 'edit';
  let inner: DiscordConnection | null = null;
  let typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  const channel: IMChannel & DiscordChannelExtensions = {
    channelType: 'discord',

    async connect(opts: IMChannelConnectOpts): Promise<boolean> {
      inner = createDiscordConnection(config);
      try {
        const ok = await inner.connect({
          onReady: opts.onReady,
          onNewChat: opts.onNewChat,
          isChatAuthorized: opts.isChatAuthorized,
          ignoreMessagesBefore: opts.ignoreMessagesBefore,
          onCommand: opts.onCommand,
          resolveGroupFolder: opts.resolveGroupFolder,
          resolveEffectiveChatJid: opts.resolveEffectiveChatJid,
          onAgentMessage: opts.onAgentMessage,
          onBotAddedToGroup: opts.onBotAddedToGroup,
          onBotRemovedFromGroup: opts.onBotRemovedFromGroup,
          shouldProcessGroupMessage: opts.shouldProcessGroupMessage,
          isGroupOwnerMessage: opts.isGroupOwnerMessage,
        });
        return ok;
      } catch (err) {
        logger.warn({ err }, 'Discord channel connect failed');
        inner = null;
        return false;
      }
    },

    async disconnect(): Promise<void> {
      // Clear all typing intervals
      for (const [, interval] of typingIntervals) clearInterval(interval);
      typingIntervals.clear();
      if (inner) {
        await inner.disconnect();
        inner = null;
      }
    },

    async sendMessage(chatId, text, localImagePaths?) {
      if (!inner) return;
      await inner.sendMessage(chatId, text, localImagePaths);
    },

    async sendFile(chatId, filePath, fileName) {
      if (!inner) return;
      await inner.sendFile(chatId, filePath, fileName);
    },

    async sendImage(chatId, imageBuffer, mimeType, caption?, fileName?) {
      if (!inner) return;
      await inner.sendImage(chatId, imageBuffer, mimeType, caption, fileName);
    },

    async setTyping(chatId, isTyping) {
      if (!inner) return;
      if (isTyping) {
        // Discord typing indicator lasts 10s, repeat every 9s
        if (!typingIntervals.has(chatId)) {
          await inner.setTyping(chatId, true);
          const interval = setInterval(async () => {
            try { if (inner) await inner.setTyping(chatId, true); } catch {}
          }, 9000);
          typingIntervals.set(chatId, interval);
        }
      } else {
        const interval = typingIntervals.get(chatId);
        if (interval) {
          clearInterval(interval);
          typingIntervals.delete(chatId);
        }
      }
    },

    clearAckReaction(chatId) {
      inner?.clearAckReaction(chatId);
    },

    isConnected() {
      return inner?.isConnected() ?? false;
    },

    async createStreamingSession(chatId, onCardCreated?) {
      if (!streamingEnabled) return undefined;
      if (!inner?.createStreamingSession) return undefined;
      return inner.createStreamingSession(chatId, onCardCreated);
    },

    async getDiscordHistory(chatId, historyOpts?) {
      if (!inner) {
        throw new Error('Discord channel not connected');
      }
      return inner.getChannelHistory(chatId, historyOpts);
    },

    async getDiscordChannelInfo(chatId) {
      if (!inner) {
        throw new Error('Discord channel not connected');
      }
      return inner.getChannelInfo(chatId);
    },

    async getDiscordGuildInfo(chatId) {
      if (!inner) {
        throw new Error('Discord channel not connected');
      }
      return inner.getGuildInfo(chatId);
    },
  };
  return channel;
}

// ─── WhatsApp Adapter ───────────────────────────────────────────

export function createWhatsAppChannel(
  config: WhatsAppConnectionConfig,
  onConnectionUpdate?: (state: WhatsAppConnectionState) => void,
): IMChannel & { getWhatsAppState?: () => WhatsAppConnectionState } {
  let inner: WhatsAppConnection | null = null;

  const channel: IMChannel & {
    getWhatsAppState?: () => WhatsAppConnectionState;
  } = {
    channelType: 'whatsapp',

    async connect(opts: IMChannelConnectOpts): Promise<boolean> {
      inner = createWhatsAppConnection(config);
      try {
        await inner.connect({
          onReady: opts.onReady,
          onNewChat: opts.onNewChat,
          onCommand: opts.onCommand,
          ignoreMessagesBefore: opts.ignoreMessagesBefore,
          resolveGroupFolder: opts.resolveGroupFolder,
          resolveEffectiveChatJid: opts.resolveEffectiveChatJid,
          onAgentMessage: opts.onAgentMessage,
          onBotAddedToGroup: opts.onBotAddedToGroup,
          onBotRemovedFromGroup: opts.onBotRemovedFromGroup,
          shouldProcessGroupMessage: opts.shouldProcessGroupMessage,
          isGroupOwnerMessage: opts.isGroupOwnerMessage,
          isSenderAllowedInGroup: opts.isSenderAllowedInGroup,
          onConnectionUpdate,
        });
        // Baileys connect 是 async fire-and-forget：socket 建好后立刻返回，
        // 真实的 connected 状态要等 connection.update -> 'open' 才到。
        // 这里我们返回 true 表示 socket 启动成功，连接状态由 onConnectionUpdate 推送。
        return true;
      } catch (err) {
        logger.warn({ err }, 'WhatsApp channel connect failed');
        inner = null;
        return false;
      }
    },

    async disconnect(): Promise<void> {
      if (inner) {
        await inner.disconnect();
        inner = null;
      }
    },

    async sendMessage(
      chatId: string,
      text: string,
      localImagePaths?: string[],
    ): Promise<void> {
      if (!inner) {
        logger.warn(
          { chatId },
          'WhatsApp channel not connected, skip sending message',
        );
        return;
      }
      await inner.sendMessage(chatId, text, localImagePaths);
    },

    async sendImage(
      chatId: string,
      imageBuffer: Buffer,
      mimeType: string,
      caption?: string,
      fileName?: string,
    ): Promise<void> {
      if (!inner) {
        logger.warn(
          { chatId },
          'WhatsApp channel not connected, skip sending image',
        );
        return;
      }
      await inner.sendImage(chatId, imageBuffer, mimeType, caption, fileName);
    },

    async sendFile(
      chatId: string,
      filePath: string,
      fileName: string,
    ): Promise<void> {
      if (!inner) {
        logger.warn(
          { chatId },
          'WhatsApp channel not connected, skip sending file',
        );
        return;
      }
      await inner.sendFile(chatId, filePath, fileName);
    },

    async setTyping(chatId: string, isTyping: boolean): Promise<void> {
      if (!inner) return;
      await inner.sendTyping(chatId, isTyping);
    },

    isConnected(): boolean {
      return inner?.isConnected() ?? false;
    },

    getWhatsAppState(): WhatsAppConnectionState {
      return inner?.getState() ?? { status: 'disconnected' };
    },
  };

  return channel;
}
