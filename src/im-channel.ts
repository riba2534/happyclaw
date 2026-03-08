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
import { logger } from './logger.js';

// ─── Unified Interface ──────────────────────────────────────────

export interface IMChannelConnectOpts {
  onReady: () => void;
  onNewChat: (chatJid: string, chatName: string) => void;
  onMessage?: (chatJid: string, text: string, senderName: string) => void;
  ignoreMessagesBefore?: number;
  isChatAuthorized?: (jid: string) => boolean;
  onPairAttempt?: (jid: string, chatName: string, code: string) => Promise<boolean>;
  /** Slash command callback (e.g. /clear). Returns reply text or null. */
  onCommand?: (chatJid: string, command: string) => Promise<string | null>;
  /** 根据 jid 解析群组 folder，用于下载文件/图片到工作区 */
  resolveGroupFolder?: (jid: string) => string | undefined;
  /** 将 IM chatJid 解析为绑定目标 JID（conversation agent 或工作区主对话） */
  resolveEffectiveChatJid?: (chatJid: string) => { effectiveJid: string; agentId: string | null } | null;
  /** 当 IM 消息被路由到 conversation agent 后调用，触发 agent 处理 */
  onAgentMessage?: (baseChatJid: string, agentId: string) => void;
  /** Bot 被添加到群聊时调用 */
  onBotAddedToGroup?: (chatJid: string, chatName: string) => void;
  /** Bot 被移出群聊或群被解散时调用 */
  onBotRemovedFromGroup?: (chatJid: string) => void;
  /** 群聊消息过滤：bot 未被 @mention 时调用，返回 true 则处理，false 则丢弃 */
  shouldProcessGroupMessage?: (chatJid: string) => boolean;
}

export interface IMChannel {
  readonly channelType: string;
  connect(opts: IMChannelConnectOpts): Promise<boolean>;
  disconnect(): Promise<void>;
  sendMessage(chatId: string, text: string, localImagePaths?: string[]): Promise<void>;
  /** Send file to chat (if supported) */
  sendFile?(chatId: string, filePath: string, fileName: string): Promise<void>;
  sendImage?(chatId: string, imageBuffer: Buffer, mimeType: string, caption?: string, fileName?: string): Promise<void>;
  setTyping(chatId: string, isTyping: boolean): Promise<void>;
  isConnected(): boolean;
  syncGroups?(): Promise<void>;
  getChatInfo?(chatId: string): Promise<{ avatar?: string; name?: string; user_count?: string; chat_type?: string; chat_mode?: string } | null>;
}

// ─── Channel Registry ───────────────────────────────────────────

export const CHANNEL_REGISTRY: Record<string, { prefix: string }> = {
  feishu: { prefix: 'feishu:' },
  telegram: { prefix: 'telegram:' },
};

/**
 * Determine the channel type from a JID string.
 * Returns the matching channelType key or null if no prefix matches.
 */
export function getChannelType(jid: string): string | null {
  for (const [type, { prefix }] of Object.entries(CHANNEL_REGISTRY)) {
    if (jid.startsWith(prefix)) return type;
  }
  return null;
}

/**
 * Strip the channel prefix from a JID, returning the raw chat ID.
 */
export function extractChatId(jid: string): string {
  for (const { prefix } of Object.values(CHANNEL_REGISTRY)) {
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

    async sendMessage(chatId: string, text: string, localImagePaths?: string[]): Promise<void> {
      if (!inner) {
        logger.warn({ chatId }, 'Feishu channel not connected, skip sending message');
        return;
      }
      await inner.sendMessage(chatId, text, localImagePaths);
    },

    async sendImage(chatId: string, imageBuffer: Buffer, mimeType: string, caption?: string, fileName?: string): Promise<void> {
      if (!inner) {
        logger.warn({ chatId }, 'Feishu channel not connected, skip sending image');
        return;
      }
      await inner.sendImage(chatId, imageBuffer, mimeType, caption, fileName);
    },

    async setTyping(chatId: string, isTyping: boolean): Promise<void> {
      if (!inner) return;
      await inner.sendReaction(chatId, isTyping);
    },

    isConnected(): boolean {
      return inner?.isConnected() ?? false;
    },

    async syncGroups(): Promise<void> {
      if (!inner) return;
      await inner.syncGroups();
    },

    async sendFile(chatId: string, filePath: string, fileName: string): Promise<void> {
      if (!inner) {
        logger.warn({ chatId }, 'Feishu channel not connected, skip sending file');
        return;
      }
      await inner.sendFile(chatId, filePath, fileName);
    },

    async getChatInfo(chatId: string) {
      if (!inner) return null;
      return inner.getChatInfo(chatId);
    },
  };

  return channel;
}

// ─── Telegram Adapter ───────────────────────────────────────────

export function createTelegramChannel(config: TelegramConnectionConfig): IMChannel {
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

    async sendMessage(chatId: string, text: string, localImagePaths?: string[]): Promise<void> {
      if (!inner) {
        logger.warn({ chatId }, 'Telegram channel not connected, skip sending message');
        return;
      }
      await inner.sendMessage(chatId, text, localImagePaths);
    },

    async sendImage(chatId: string, imageBuffer: Buffer, mimeType: string, caption?: string, fileName?: string): Promise<void> {
      if (!inner) {
        logger.warn({ chatId }, 'Telegram channel not connected, skip sending image');
        return;
      }
      await inner.sendImage(chatId, imageBuffer, mimeType, caption, fileName);
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
      typingTimer = setInterval(() => { void sendAction(); }, 4000);
    },

    isConnected(): boolean {
      return inner?.isConnected() ?? false;
    },
  };

  return channel;
}
