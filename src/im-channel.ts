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
}

export interface IMChannel {
  readonly channelType: string;
  connect(opts: IMChannelConnectOpts): Promise<boolean>;
  disconnect(): Promise<void>;
  sendMessage(chatId: string, text: string): Promise<void>;
  setTyping(chatId: string, isTyping: boolean): Promise<void>;
  isConnected(): boolean;
  syncGroups?(): Promise<void>;
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

    async sendMessage(chatId: string, text: string): Promise<void> {
      if (!inner) {
        logger.warn({ chatId }, 'Feishu channel not connected, skip sending message');
        return;
      }
      await inner.sendMessage(chatId, text);
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

    async sendMessage(chatId: string, text: string): Promise<void> {
      if (!inner) {
        logger.warn({ chatId }, 'Telegram channel not connected, skip sending message');
        return;
      }
      await inner.sendMessage(chatId, text);
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
