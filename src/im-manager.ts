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
  createQQChannel,
  createWeChatChannel,
  createDingTalkChannel,
  createDiscordChannel,
} from './im-channel.js';
import { parseFeishuRouteTarget, type FeishuConnectionConfig } from './feishu.js';
import type { TelegramConnectionConfig } from './telegram.js';
import type { QQConnectionConfig } from './qq.js';
import type { WeChatConnectionConfig } from './wechat.js';
import type { DingTalkConnectionConfig } from './dingtalk.js';
import type { DiscordConnectionConfig } from './discord.js';
import type { StreamingSession } from './im-channel.js';
import { getRegisteredGroup, getJidsByFolder } from './db.js';
import { getUserDingTalkConfig } from './runtime-config.js';
import { logger } from './logger.js';
import type { FeishuMessageMeta } from './types.js';

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

export interface QQConnectConfig {
  appId: string;
  appSecret: string;
  enabled?: boolean;
}

export interface WeChatConnectConfig {
  botToken: string;
  ilinkBotId: string;
  baseUrl?: string;
  cdnBaseUrl?: string;
  getUpdatesBuf?: string;
  enabled?: boolean;
}

export interface DingTalkConnectConfig {
  clientId: string;
  clientSecret: string;
  enabled?: boolean;
}

export interface DiscordConnectConfig {
  botToken: string;
  enabled?: boolean;
  streamingMode?: 'edit' | 'off';
}

export interface ConnectFeishuOptions {
  ignoreMessagesBefore?: number;
  onCommand?: (chatJid: string, command: string) => Promise<string | null>;
  resolveGroupFolder?: (chatJid: string) => string | undefined;
  resolveEffectiveChatJid?: (
    chatJid: string,
    messageMeta?: FeishuMessageMeta,
  ) => { effectiveJid: string; agentId: string | null } | null;
  onAgentMessage?: (baseChatJid: string, agentId: string) => void;
  onBotAddedToGroup?: (chatJid: string, chatName: string) => void;
  onBotRemovedFromGroup?: (chatJid: string) => void;
  shouldProcessGroupMessage?: (chatJid: string, senderImId?: string) => boolean;
  isGroupOwnerMessage?: (chatJid: string, senderImId?: string) => boolean;
  onCardInterrupt?: (chatJid: string) => void;
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
  async sendMessage(
    jid: string,
    text: string,
    localImagePaths?: string[],
  ): Promise<void> {
    const channelType = getChannelType(jid);
    if (!channelType) {
      logger.debug({ jid }, 'Unknown channel type for JID, skip sending');
      return;
    }

    const chatId = extractChatId(jid);
    const channel = this.findChannelForJid(jid, channelType);
    if (!channel) {
      throw new Error(`No IM channel available for ${jid} (${channelType})`);
    }
    await channel.sendMessage(chatId, text, localImagePaths);
  }

  /**
   * Send an image to an IM chat, auto-routing via JID prefix.
   */
  async sendImage(
    jid: string,
    imageBuffer: Buffer,
    mimeType: string,
    caption?: string,
    fileName?: string,
  ): Promise<void> {
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
  async sendFile(
    jid: string,
    filePath: string,
    fileName: string,
  ): Promise<void> {
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
   * Clear the ack reaction for a chat (e.g. when streaming card handled the reply).
   */
  clearAckReaction(jid: string): void {
    const channelType = getChannelType(jid);
    if (!channelType) return;

    const chatId = extractChatId(jid);
    const channel = this.findChannelForJid(jid, channelType);
    if (channel?.clearAckReaction) {
      channel.clearAckReaction(chatId);
    }
  }

  /**
   * Create a streaming card session for an IM chat (Feishu or DingTalk).
   * Returns undefined for unsupported channels.
   */
  async createStreamingSession(
    jid: string,
    onCardCreated?: (messageId: string) => void,
  ): Promise<StreamingSession | undefined> {
    const channelType = getChannelType(jid);
    if (channelType !== 'feishu' && channelType !== 'dingtalk' && channelType !== 'discord')
      return undefined;

    // Check DingTalk streaming mode: if text mode, skip streaming session creation
    if (channelType === 'dingtalk') {
      const group = getRegisteredGroup(jid);
      if (group?.created_by) {
        const dtConfig = getUserDingTalkConfig(group.created_by);
        if (dtConfig && dtConfig.streamingMode === 'text') {
          logger.debug({ jid }, 'DingTalk streaming disabled (text mode)');
          return undefined;
        }
      }
    }

    const chatId = extractChatId(jid);
    const channel = this.findChannelForJid(jid, channelType);
    if (channel?.createStreamingSession) {
      return channel.createStreamingSession(chatId, onCardCreated);
    }
    return undefined;
  }

  /**
   * Find the appropriate IMChannel for a given JID, using group ownership lookup
   * and sibling fallback.
   */
  private findChannelForJid(
    jid: string,
    channelType: string,
  ): IMChannel | undefined {
    const baseJid = parseFeishuRouteTarget(jid).chatId;
    // Direct lookup via group ownership
    const group = getRegisteredGroup(baseJid);
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

  /**
   * Get all connected channel types for a user.
   * Used by scheduled task IM broadcast to discover available channels.
   */
  getConnectedChannelTypes(userId: string): string[] {
    const conn = this.connections.get(userId);
    if (!conn) return [];
    const types: string[] = [];
    for (const [type, ch] of conn.channels.entries()) {
      if (ch.isConnected()) types.push(type);
    }
    return types;
  }

  /**
   * Check if a specific JID has a connected channel available.
   * Uses the same routing logic as sendMessage (group ownership + sibling fallback).
   */
  isChannelAvailableForJid(jid: string): boolean {
    const channelType = getChannelType(jid);
    if (!channelType) return false;
    return !!this.findChannelForJid(jid, channelType);
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
      isGroupOwnerMessage: options?.isGroupOwnerMessage,
      onCardInterrupt: options?.onCardInterrupt,
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
    onPairAttempt?: (
      jid: string,
      chatName: string,
      code: string,
    ) => Promise<boolean>,
    options?: {
      onCommand?: (chatJid: string, command: string) => Promise<string | null>;
      ignoreMessagesBefore?: number;
      resolveGroupFolder?: (jid: string) => string | undefined;
      resolveEffectiveChatJid?: (
        chatJid: string,
      ) => { effectiveJid: string; agentId: string | null } | null;
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
      ignoreMessagesBefore: options?.ignoreMessagesBefore,
      resolveGroupFolder: options?.resolveGroupFolder,
      resolveEffectiveChatJid: options?.resolveEffectiveChatJid,
      onAgentMessage: options?.onAgentMessage,
      onBotAddedToGroup: options?.onBotAddedToGroup,
      onBotRemovedFromGroup: options?.onBotRemovedFromGroup,
    });
  }

  /**
   * Connect a QQ instance for a specific user.
   */
  async connectUserQQ(
    userId: string,
    config: QQConnectConfig,
    onNewChat: (chatJid: string, chatName: string) => void,
    isChatAuthorized?: (jid: string) => boolean,
    onPairAttempt?: (
      jid: string,
      chatName: string,
      code: string,
    ) => Promise<boolean>,
    options?: {
      onCommand?: (chatJid: string, command: string) => Promise<string | null>;
      resolveGroupFolder?: (jid: string) => string | undefined;
      resolveEffectiveChatJid?: (
        chatJid: string,
      ) => { effectiveJid: string; agentId: string | null } | null;
      onAgentMessage?: (baseChatJid: string, agentId: string) => void;
    },
  ): Promise<boolean> {
    if (!config.appId || !config.appSecret) {
      logger.info({ userId }, 'QQ config empty, skipping connection');
      return false;
    }

    const channel = createQQChannel({
      appId: config.appId,
      appSecret: config.appSecret,
    });

    return this.connectChannel(userId, 'qq', channel, {
      onReady: () => {
        logger.info({ userId }, 'User QQ bot connected');
      },
      onNewChat,
      isChatAuthorized,
      onPairAttempt,
      onCommand: options?.onCommand,
      resolveGroupFolder: options?.resolveGroupFolder,
      resolveEffectiveChatJid: options?.resolveEffectiveChatJid,
      onAgentMessage: options?.onAgentMessage,
    });
  }

  async disconnectUserFeishu(userId: string): Promise<void> {
    await this.disconnectChannel(userId, 'feishu');
  }

  async disconnectUserTelegram(userId: string): Promise<void> {
    await this.disconnectChannel(userId, 'telegram');
  }

  async disconnectUserQQ(userId: string): Promise<void> {
    await this.disconnectChannel(userId, 'qq');
  }

  /**
   * Connect a WeChat iLink instance for a specific user.
   */
  async connectUserWeChat(
    userId: string,
    config: WeChatConnectConfig,
    onNewChat: (chatJid: string, chatName: string) => void,
    options?: {
      ignoreMessagesBefore?: number;
      onCommand?: (chatJid: string, command: string) => Promise<string | null>;
      resolveGroupFolder?: (jid: string) => string | undefined;
      resolveEffectiveChatJid?: (
        chatJid: string,
      ) => { effectiveJid: string; agentId: string | null } | null;
      onAgentMessage?: (baseChatJid: string, agentId: string) => void;
    },
  ): Promise<boolean> {
    if (!config.botToken || !config.ilinkBotId) {
      logger.info({ userId }, 'WeChat config empty, skipping connection');
      return false;
    }

    const channel = createWeChatChannel({
      botToken: config.botToken,
      ilinkBotId: config.ilinkBotId,
      baseUrl: config.baseUrl,
      cdnBaseUrl: config.cdnBaseUrl,
      getUpdatesBuf: config.getUpdatesBuf,
    });

    return this.connectChannel(userId, 'wechat', channel, {
      onReady: () => {
        logger.info({ userId }, 'User WeChat bot connected');
      },
      onNewChat,
      ignoreMessagesBefore: options?.ignoreMessagesBefore,
      onCommand: options?.onCommand,
      resolveGroupFolder: options?.resolveGroupFolder,
      resolveEffectiveChatJid: options?.resolveEffectiveChatJid,
      onAgentMessage: options?.onAgentMessage,
    });
  }

  async disconnectUserWeChat(userId: string): Promise<void> {
    await this.disconnectChannel(userId, 'wechat');
  }

  /**
   * Connect a DingTalk Stream instance for a specific user.
   */
  async connectUserDingTalk(
    userId: string,
    config: DingTalkConnectConfig,
    onNewChat: (chatJid: string, chatName: string) => void,
    options?: {
      ignoreMessagesBefore?: number;
      onCommand?: (chatJid: string, command: string) => Promise<string | null>;
      resolveGroupFolder?: (jid: string) => string | undefined;
      resolveEffectiveChatJid?: (
        chatJid: string,
      ) => { effectiveJid: string; agentId: string | null } | null;
      onAgentMessage?: (baseChatJid: string, agentId: string) => void;
      onBotAddedToGroup?: (chatJid: string, chatName: string) => void;
      onBotRemovedFromGroup?: (chatJid: string) => void;
      shouldProcessGroupMessage?: (chatJid: string, senderImId?: string) => boolean;
      isGroupOwnerMessage?: (chatJid: string, senderImId?: string) => boolean;
    },
  ): Promise<boolean> {
    if (!config.clientId || !config.clientSecret) {
      logger.info({ userId }, 'DingTalk config empty, skipping connection');
      return false;
    }

    const channel = createDingTalkChannel({
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    });

    return this.connectChannel(userId, 'dingtalk', channel, {
      onReady: () => {
        logger.info({ userId }, 'User DingTalk bot connected');
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
      isGroupOwnerMessage: options?.isGroupOwnerMessage,
    });
  }

  async disconnectUserDingTalk(userId: string): Promise<void> {
    await this.disconnectChannel(userId, 'dingtalk');
  }

  /**
   * Connect a Discord instance for a specific user.
   */
  async connectUserDiscord(
    userId: string,
    config: DiscordConnectConfig,
    onNewChat: (chatJid: string, chatName: string) => void,
    options?: {
      ignoreMessagesBefore?: number;
      isChatAuthorized?: (jid: string) => boolean;
      onCommand?: (chatJid: string, command: string) => Promise<string | null>;
      resolveGroupFolder?: (jid: string) => string | undefined;
      resolveEffectiveChatJid?: (chatJid: string) => { effectiveJid: string; agentId: string | null } | null;
      onAgentMessage?: (baseChatJid: string, agentId: string) => void;
      onBotAddedToGroup?: (chatJid: string, chatName: string) => void;
      onBotRemovedFromGroup?: (chatJid: string) => void;
      shouldProcessGroupMessage?: (chatJid: string, senderImId?: string) => boolean;
      isGroupOwnerMessage?: (chatJid: string, senderImId?: string) => boolean;
    },
  ): Promise<boolean> {
    if (!config.botToken) return false;
    const channel = createDiscordChannel(
      { botToken: config.botToken },
      { streamingMode: config.streamingMode ?? 'off' },
    );
    return this.connectChannel(userId, 'discord', channel, {
      onReady: () => logger.info({ userId }, 'User Discord bot connected'),
      onNewChat,
      ignoreMessagesBefore: options?.ignoreMessagesBefore,
      isChatAuthorized: options?.isChatAuthorized,
      onCommand: options?.onCommand,
      resolveGroupFolder: options?.resolveGroupFolder,
      resolveEffectiveChatJid: options?.resolveEffectiveChatJid,
      onAgentMessage: options?.onAgentMessage,
      onBotAddedToGroup: options?.onBotAddedToGroup,
      onBotRemovedFromGroup: options?.onBotRemovedFromGroup,
      shouldProcessGroupMessage: options?.shouldProcessGroupMessage,
      isGroupOwnerMessage: options?.isGroupOwnerMessage,
    });
  }

  async disconnectUserDiscord(userId: string): Promise<void> {
    await this.disconnectChannel(userId, 'discord');
  }

  /**
   * Send a message to a Feishu chat.
   * @deprecated Use sendMessage(jid, text) which auto-routes.
   */
  async sendFeishuMessage(
    chatJid: string,
    text: string,
    localImagePaths?: string[],
  ): Promise<void> {
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
  async sendTelegramMessage(
    chatJid: string,
    text: string,
    localImagePaths?: string[],
  ): Promise<void> {
    const chatId = extractChatId(chatJid);
    const channel = this.findChannelForJid(chatJid, 'telegram');
    if (channel) {
      await channel.sendMessage(chatId, text, localImagePaths);
      return;
    }
    logger.warn(
      { chatJid },
      'No Telegram connection available to send message',
    );
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

  isQQConnected(userId: string): boolean {
    const conn = this.connections.get(userId);
    return conn?.channels.get('qq')?.isConnected() ?? false;
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

  isWeChatConnected(userId: string): boolean {
    const conn = this.connections.get(userId);
    return conn?.channels.get('wechat')?.isConnected() ?? false;
  }

  isDingTalkConnected(userId: string): boolean {
    const conn = this.connections.get(userId);
    return conn?.channels.get('dingtalk')?.isConnected() ?? false;
  }

  isDiscordConnected(userId: string): boolean {
    const conn = this.connections.get(userId);
    return conn?.channels.get('discord')?.isConnected() ?? false;
  }

  /** Get the Feishu channel for a user (for direct access like syncGroups) */
  getFeishuConnection(userId: string): IMChannel | undefined {
    return this.connections.get(userId)?.channels.get('feishu');
  }

  /** Get the Telegram channel for a user */
  getTelegramConnection(userId: string): IMChannel | undefined {
    return this.connections.get(userId)?.channels.get('telegram');
  }

  /** Get the QQ channel for a user */
  getQQConnection(userId: string): IMChannel | undefined {
    return this.connections.get(userId)?.channels.get('qq');
  }

  /** Get chat info from the Feishu API for a specific user's connection */
  async getFeishuChatInfo(
    userId: string,
    chatId: string,
  ): Promise<{
    avatar?: string;
    name?: string;
    user_count?: string;
    chat_type?: string;
    chat_mode?: string;
  } | null> {
    const channel = this.getFeishuConnection(userId);
    if (!channel?.getChatInfo) return null;
    return channel.getChatInfo(chatId);
  }

  /**
   * Get chat info for an IM group by JID, auto-routing to the correct connection.
   * Used for health checks to detect disbanded groups.
   *
   * Returns:
   * - object: chat info (reachable)
   * - null: channel supports getChatInfo but chat is not reachable
   * - undefined: channel does not support getChatInfo (e.g. Telegram, QQ)
   */
  async getChatInfo(jid: string): Promise<
    | {
        avatar?: string;
        name?: string;
        user_count?: string;
        chat_type?: string;
        chat_mode?: string;
      }
    | null
    | undefined
  > {
    const channelType = getChannelType(jid);
    if (!channelType) return null;

    const chatId = extractChatId(jid);
    const channel = this.findChannelForJid(jid, channelType);
    if (channel?.getChatInfo) {
      return channel.getChatInfo(chatId);
    }
    // Channel doesn't implement getChatInfo — not a reachability failure
    return undefined;
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
            logger.warn(
              { userId, channelType, err },
              'Error stopping IM channel',
            );
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
