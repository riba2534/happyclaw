/**
 * IM Connection Pool Manager
 *
 * Manages per-user IM connections using the unified IMChannel interface.
 * Each user can have independent IM connections that route messages
 * to their home container.
 */
import {
  type IMChannel,
  type IMChannelConnectOpts,
  getChannelType,
  extractChatId,
  createFeishuChannel,
  createTelegramChannel,
} from './im-channel.js';
import type { FeishuConnectionConfig } from './feishu.js';
import type { TelegramConnectionConfig } from './telegram.js';
import { getRegisteredGroup, getJidsByFolder } from './db.js';
import { logger } from './logger.js';

export interface UserIMConnection {
  userId: string;
  channels: Map<string, IMChannel>;
}

export interface FeishuConnectConfig {
  appId: string;
  appSecret: string;
  enabled?: boolean;
}

export interface TelegramConnectConfig {
  botToken: string;
  proxyUrl?: string;
  enabled?: boolean;
}

export interface ConnectFeishuOptions {
  ignoreMessagesBefore?: number;
  onCommand?: (chatJid: string, command: string) => Promise<string | null>;
  resolveGroupFolder?: (chatJid: string) => string | undefined;
  resolveEffectiveChatJid?: (chatJid: string) => { effectiveJid: string; agentId: string | null } | null;
  onAgentMessage?: (baseChatJid: string, agentId: string) => void;
  onBotAddedToGroup?: (chatJid: string, chatName: string) => void;
  onBotRemovedFromGroup?: (chatJid: string) => void;
  shouldProcessGroupMessage?: (chatJid: string) => boolean;
}

class IMConnectionManager {
  private connections = new Map<string, UserIMConnection>();
  private adminUserIds = new Set<string>();

  /** Register a user ID as admin (for fallback routing) */
  registerAdminUser(userId: string): void {
    this.adminUserIds.add(userId);
  }

  private getOrCreate(userId: string): UserIMConnection {
    let conn = this.connections.get(userId);
    if (!conn) {
      conn = { userId, channels: new Map() };
      this.connections.set(userId, conn);
    }
    return conn;
  }

  // ─── Generic Channel Methods ────────────────────────────────

  /**
   * Connect any IMChannel for a user.
   */
  async connectChannel(
    userId: string,
    channelType: string,
    channel: IMChannel,
    opts: IMChannelConnectOpts,
  ): Promise<boolean> {
    // Disconnect existing channel of same type
    await this.disconnectChannel(userId, channelType);

    const conn = this.getOrCreate(userId);
    const connected = await channel.connect(opts);
    if (connected) {
      conn.channels.set(channelType, channel);
      logger.info({ userId, channelType }, 'IM channel connected');
    }
    return connected;
  }

  /**
   * Disconnect a specific channel type for a user.
   */
  async disconnectChannel(userId: string, channelType: string): Promise<void> {
    const conn = this.connections.get(userId);
    const channel = conn?.channels.get(channelType);
    if (channel) {
      await channel.disconnect();
      conn!.channels.delete(channelType);
      logger.info({ userId, channelType }, 'IM channel disconnected');
    }
  }

  /**
   * Send a message to an IM chat, auto-routing via JID prefix.
   * Resolves the user by looking up chatJid -> registered_groups.created_by.
   * Falls back to iterating sibling groups if no created_by is set.
   */
  async sendMessage(jid: string, text: string, localImagePaths?: string[]): Promise<void> {
    const channelType = getChannelType(jid);
    if (!channelType) {
      logger.debug({ jid }, 'Unknown channel type for JID, skip sending');
      return;
    }

    const chatId = extractChatId(jid);
    const channel = this.findChannelForJid(jid, channelType);
    if (channel) {
      await channel.sendMessage(chatId, text, localImagePaths);
      return;
    }

    logger.warn({ jid, channelType }, 'No IM channel available to send message');
  }

  /**
   * Send an image to an IM chat, auto-routing via JID prefix.
   */
  async sendImage(jid: string, imageBuffer: Buffer, mimeType: string, caption?: string, fileName?: string): Promise<void> {
    const channelType = getChannelType(jid);
    if (!channelType) {
      logger.debug({ jid }, 'Unknown channel type for JID, skip sending image');
      return;
    }

    const chatId = extractChatId(jid);
    const channel = this.findChannelForJid(jid, channelType);
    if (channel?.sendImage) {
      await channel.sendImage(chatId, imageBuffer, mimeType, caption, fileName);
      return;
    }

    // Fallback: if channel doesn't support sendImage, send caption as text
    if (caption && channel) {
      await channel.sendMessage(chatId, `📷 ${caption}`);
      return;
    }

    logger.warn({ jid, channelType }, 'No IM channel available to send image');
  }

  /**
   * Send a file to an IM chat, auto-routing via JID prefix.
   * @throws Error if the channel doesn't support file sending
   */
  async sendFile(jid: string, filePath: string, fileName: string): Promise<void> {
    const channelType = getChannelType(jid);
    if (!channelType) {
      throw new Error(`无法识别 JID 的通道类型: ${jid}`);
    }

    const chatId = extractChatId(jid);
    const channel = this.findChannelForJid(jid, channelType);
    if (channel?.sendFile) {
      await channel.sendFile(chatId, filePath, fileName);
    } else {
      throw new Error(`通道 ${channelType} 不支持发送文件`);
    }
  }

  /**
   * Set typing indicator on an IM chat, auto-routing via JID prefix.
   */
  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const channelType = getChannelType(jid);
    if (!channelType) return;

    const chatId = extractChatId(jid);
    const channel = this.findChannelForJid(jid, channelType);
    if (channel) {
      await channel.setTyping(chatId, isTyping);
    }
    // No fallback for typing — silently ignore if owner's connection is unavailable
  }

  /**
   * Find the appropriate IMChannel for a given JID, using group ownership lookup
   * and sibling fallback.
   */
  private findChannelForJid(jid: string, channelType: string): IMChannel | undefined {
    // Direct lookup via group ownership
    const group = getRegisteredGroup(jid);
    if (group?.created_by) {
      const conn = this.connections.get(group.created_by);
      const ch = conn?.channels.get(channelType);
      if (ch?.isConnected()) return ch;
    }

    // Fallback: find owner via sibling groups sharing the same folder
    if (group) {
      const siblingJids = getJidsByFolder(group.folder);
      for (const sibJid of siblingJids) {
        if (sibJid === jid) continue;
        const sibling = getRegisteredGroup(sibJid);
        if (sibling?.created_by) {
          const conn = this.connections.get(sibling.created_by);
          const ch = conn?.channels.get(channelType);
          if (ch?.isConnected()) {
            logger.warn(
              { jid, fallbackUserId: sibling.created_by, folder: group.folder },
              'IM message routed via sibling group owner connection',
            );
            return ch;
          }
        }
      }
    }

    return undefined;
  }

  // ─── Convenience Methods (API-compatible wrappers) ──────────

  /**
   * Connect a Feishu instance for a specific user.
   */
  async connectUserFeishu(
    userId: string,
    config: FeishuConnectConfig,
    onNewChat: (chatJid: string, chatName: string) => void,
    options?: ConnectFeishuOptions,
  ): Promise<boolean> {
    if (!config.appId || !config.appSecret) {
      logger.info({ userId }, 'Feishu config empty, skipping connection');
      return false;
    }

    const channel = createFeishuChannel({
      appId: config.appId,
      appSecret: config.appSecret,
    });

    return this.connectChannel(userId, 'feishu', channel, {
      onReady: () => {
        logger.info({ userId }, 'User Feishu WebSocket connected');
      },
      onNewChat,
      ignoreMessagesBefore: options?.ignoreMessagesBefore,
      onCommand: options?.onCommand,
      resolveGroupFolder: options?.resolveGroupFolder,
      resolveEffectiveChatJid: options?.resolveEffectiveChatJid,
      onAgentMessage: options?.onAgentMessage,
      onBotAddedToGroup: options?.onBotAddedToGroup,
      onBotRemovedFromGroup: options?.onBotRemovedFromGroup,
      shouldProcessGroupMessage: options?.shouldProcessGroupMessage,
    });
  }

  /**
   * Connect a Telegram instance for a specific user.
   */
  async connectUserTelegram(
    userId: string,
    config: TelegramConnectConfig,
    onNewChat: (chatJid: string, chatName: string) => void,
    isChatAuthorized?: (jid: string) => boolean,
    onPairAttempt?: (jid: string, chatName: string, code: string) => Promise<boolean>,
    options?: {
      onCommand?: (chatJid: string, command: string) => Promise<string | null>;
      resolveGroupFolder?: (jid: string) => string | undefined;
      resolveEffectiveChatJid?: (chatJid: string) => { effectiveJid: string; agentId: string | null } | null;
      onAgentMessage?: (baseChatJid: string, agentId: string) => void;
      onBotAddedToGroup?: (chatJid: string, chatName: string) => void;
      onBotRemovedFromGroup?: (chatJid: string) => void;
    },
  ): Promise<boolean> {
    if (!config.botToken) {
      logger.info({ userId }, 'Telegram config empty, skipping connection');
      return false;
    }

    const channel = createTelegramChannel({
      botToken: config.botToken,
      proxyUrl: config.proxyUrl,
    });

    return this.connectChannel(userId, 'telegram', channel, {
      onReady: () => {
        logger.info({ userId }, 'User Telegram bot connected');
      },
      onNewChat,
      isChatAuthorized,
      onPairAttempt,
      onCommand: options?.onCommand,
      resolveGroupFolder: options?.resolveGroupFolder,
      resolveEffectiveChatJid: options?.resolveEffectiveChatJid,
      onAgentMessage: options?.onAgentMessage,
      onBotAddedToGroup: options?.onBotAddedToGroup,
      onBotRemovedFromGroup: options?.onBotRemovedFromGroup,
    });
  }

  async disconnectUserFeishu(userId: string): Promise<void> {
    await this.disconnectChannel(userId, 'feishu');
  }

  async disconnectUserTelegram(userId: string): Promise<void> {
    await this.disconnectChannel(userId, 'telegram');
  }

  /**
   * Send a message to a Feishu chat.
   * @deprecated Use sendMessage(jid, text) which auto-routes.
   */
  async sendFeishuMessage(chatJid: string, text: string, localImagePaths?: string[]): Promise<void> {
    const chatId = extractChatId(chatJid);
    const channel = this.findChannelForJid(chatJid, 'feishu');
    if (channel) {
      await channel.sendMessage(chatId, text, localImagePaths);
      return;
    }
    logger.warn({ chatJid }, 'No Feishu connection available to send message');
  }

  /**
   * Send a message to a Telegram chat.
   * @deprecated Use sendMessage(jid, text) which auto-routes.
   */
  async sendTelegramMessage(chatJid: string, text: string, localImagePaths?: string[]): Promise<void> {
    const chatId = extractChatId(chatJid);
    const channel = this.findChannelForJid(chatJid, 'telegram');
    if (channel) {
      await channel.sendMessage(chatId, text, localImagePaths);
      return;
    }
    logger.warn({ chatJid }, 'No Telegram connection available to send message');
  }

  /**
   * Set typing reaction on a Feishu chat.
   * @deprecated Use setTyping(jid, isTyping) which auto-routes.
   */
  async setFeishuTyping(chatJid: string, isTyping: boolean): Promise<void> {
    const chatId = extractChatId(chatJid);
    const channel = this.findChannelForJid(chatJid, 'feishu');
    if (channel) {
      await channel.setTyping(chatId, isTyping);
    }
  }

  /**
   * Set Telegram typing chat action for a chat.
   * @deprecated Use setTyping(jid, isTyping) which auto-routes.
   */
  async setTelegramTyping(chatJid: string, isTyping: boolean): Promise<void> {
    const chatId = extractChatId(chatJid);
    const channel = this.findChannelForJid(chatJid, 'telegram');
    if (channel) {
      await channel.setTyping(chatId, isTyping);
    }
  }

  /**
   * Sync Feishu groups via a specific user's connection.
   */
  async syncFeishuGroups(userId: string): Promise<void> {
    const conn = this.connections.get(userId);
    const channel = conn?.channels.get('feishu');
    if (channel?.isConnected() && channel.syncGroups) {
      await channel.syncGroups();
    }
  }

  isFeishuConnected(userId: string): boolean {
    const conn = this.connections.get(userId);
    return conn?.channels.get('feishu')?.isConnected() ?? false;
  }

  isTelegramConnected(userId: string): boolean {
    const conn = this.connections.get(userId);
    return conn?.channels.get('telegram')?.isConnected() ?? false;
  }

  /** Check if any user has an active Feishu connection */
  isAnyFeishuConnected(): boolean {
    for (const conn of this.connections.values()) {
      if (conn.channels.get('feishu')?.isConnected()) return true;
    }
    return false;
  }

  /** Check if any user has an active Telegram connection */
  isAnyTelegramConnected(): boolean {
    for (const conn of this.connections.values()) {
      if (conn.channels.get('telegram')?.isConnected()) return true;
    }
    return false;
  }

  /** Get the Feishu channel for a user (for direct access like syncGroups) */
  getFeishuConnection(userId: string): IMChannel | undefined {
    return this.connections.get(userId)?.channels.get('feishu');
  }

  /** Get the Telegram channel for a user */
  getTelegramConnection(userId: string): IMChannel | undefined {
    return this.connections.get(userId)?.channels.get('telegram');
  }

  /** Get chat info from the Feishu API for a specific user's connection */
  async getFeishuChatInfo(userId: string, chatId: string): Promise<{ avatar?: string; name?: string; user_count?: string; chat_type?: string; chat_mode?: string } | null> {
    const channel = this.getFeishuConnection(userId);
    if (!channel?.getChatInfo) return null;
    return channel.getChatInfo(chatId);
  }

  /**
   * Get chat info for an IM group by JID, auto-routing to the correct connection.
   * Used for health checks to detect disbanded groups.
   */
  async getChatInfo(jid: string): Promise<{ avatar?: string; name?: string; user_count?: string; chat_type?: string; chat_mode?: string } | null> {
    const channelType = getChannelType(jid);
    if (!channelType) return null;

    const chatId = extractChatId(jid);
    const channel = this.findChannelForJid(jid, channelType);
    if (channel?.getChatInfo) {
      return channel.getChatInfo(chatId);
    }
    return null;
  }

  /** Get all user IDs with active connections */
  getConnectedUserIds(): string[] {
    const ids: string[] = [];
    for (const [userId, conn] of this.connections.entries()) {
      for (const ch of conn.channels.values()) {
        if (ch.isConnected()) {
          ids.push(userId);
          break;
        }
      }
    }
    return ids;
  }

  /**
   * Disconnect all IM connections for all users.
   * Called during graceful shutdown.
   */
  async disconnectAll(): Promise<void> {
    const promises: Promise<void>[] = [];

    for (const [userId, conn] of this.connections.entries()) {
      for (const [channelType, channel] of conn.channels.entries()) {
        promises.push(
          channel.disconnect().catch((err) => {
            logger.warn({ userId, channelType, err }, 'Error stopping IM channel');
          }),
        );
      }
    }

    await Promise.allSettled(promises);
    this.connections.clear();
    logger.info('All IM connections disconnected');
  }
}

export const imManager = new IMConnectionManager();
