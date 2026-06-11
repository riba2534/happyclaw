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
  isDiscordChannel,
  createWhatsAppChannel,
} from './im-channel.js';
import type {
  DiscordHistoryMessage,
  DiscordHistoryOpts,
  DiscordChannelInfo,
  DiscordGuildInfo,
} from './discord.js';
import { parseFeishuRouteTarget, type FeishuConnectionConfig } from './feishu.js';
import type { TelegramConnectionConfig } from './telegram.js';
import type { QQConnectionConfig } from './qq.js';
import type { WeChatConnectionConfig } from './wechat.js';
import type { DingTalkConnectionConfig } from './dingtalk.js';
import type { DiscordConnectionConfig } from './discord.js';
import {
  getWhatsAppAuthDir,
  type WhatsAppConnectionConfig,
  type WhatsAppConnectionState,
} from './whatsapp.js';
import { rm } from 'fs/promises';
import { DATA_DIR } from './config.js';
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

export interface WhatsAppConnectConfig {
  accountId?: string;
  phoneNumber?: string;
  authDir?: string;
  enabled?: boolean;
}

/**
 * Re-export from src/whatsapp.ts as the canonical state shape.
 * Kept as a type alias so existing imports from im-manager continue to work.
 */
export type WhatsAppConnectionStateSnapshot = WhatsAppConnectionState;

export interface ConnectFeishuOptions {
  ignoreMessagesBefore?: number;
  onCommand?: (chatJid: string, command: string, senderImId?: string, mentions?: Array<{ key?: string; name?: string; id?: { open_id?: string } }>) => Promise<string | null>;
  resolveGroupFolder?: (chatJid: string) => string | undefined;
  resolveEffectiveChatJid?: (
    chatJid: string,
    messageMeta?: FeishuMessageMeta,
  ) => { effectiveJid: string; agentId: string | null; sourceJid?: string } | null;
  onAgentMessage?: (baseChatJid: string, agentId: string) => void;
  onBotAddedToGroup?: (chatJid: string, chatName: string) => void;
  onBotRemovedFromGroup?: (chatJid: string) => void;
  shouldProcessGroupMessage?: (chatJid: string, senderImId?: string) => boolean;
  isGroupOwnerMessage?: (chatJid: string, senderImId?: string) => boolean;
  isSenderAllowedInGroup?: (chatJid: string, senderImId?: string) => boolean;
  onCardInterrupt?: (chatJid: string) => void;
  onP2pSender?: (senderOpenId: string) => void;
}

class IMConnectionManager {
  private connections = new Map<string, UserIMConnection>();
  private adminUserIds = new Set<string>();
  private lastWhatsAppState = new Map<string, WhatsAppConnectionStateSnapshot>();
  // Per-(userId, channelType) 串行化锁。connectChannel / disconnectChannel
  // 必须按顺序排队，否则两次重叠的 reconnect 会让旧 disconnect 的清理跨过新
  // connect 的 channels.set，留下一条悬挂的 live channel（双发消息）。
  private channelLocks = new Map<string, Promise<unknown>>();
  // Per-user 串行化锁：disconnectAllUserChannels 必须独占整个 user 范围，
  // 否则只锁 channelType 时与 in-flight connectChannel('其他 channelType')
  // 的 channels.set 仍会 race，让 connections.delete 之后 channel 复活。
  // 同时记录 'sealed' 状态：disconnectAll 完成后的窗口里禁止 connectChannel
  // 重新创建该 userId 的 connections 入口，直到外层逻辑显式调用
  // markUserConnectableAgain（loadState 重建路径）。
  private userLocks = new Map<string, Promise<unknown>>();
  private sealedUsers = new Set<string>();

  private async withUserLock<T>(
    userId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const prev = this.userLocks.get(userId) ?? Promise.resolve();
    let release: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = prev.catch(() => undefined).then(() => next);
    this.userLocks.set(userId, chain);
    await prev.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release!();
      // Drop tail entry once nothing else queued behind us, prevent unbounded
      // growth of the lock map for short-lived users.
      if (this.userLocks.get(userId) === chain) {
        this.userLocks.delete(userId);
      }
    }
  }

  private async withChannelLock<T>(
    userId: string,
    channelType: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const key = `${userId}:${channelType}`;
    const prev = this.channelLocks.get(key) ?? Promise.resolve();
    let release: () => void;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Chain `next` after the previous holder finishes (success or failure).
    const chain = prev.catch(() => undefined).then(() => next);
    this.channelLocks.set(key, chain);
    await prev.catch(() => undefined);
    try {
      return await fn();
    } finally {
      release!();
      // 长跑回收：若没人在我之后排队，移除 Map 项；否则后人继续持有。
      if (this.channelLocks.get(key) === chain) {
        this.channelLocks.delete(key);
      }
    }
  }

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
    // user 维度锁 + sealed 检查：避免与 disconnectAllUserChannels race。
    // disconnect-all 期间任何 connect 都被排到锁队列后面；disconnect-all
    // 完成时把 user 标 sealed，新 connect 直接拒绝。运维流程：禁用/删除
    // 用户后调用 markUserReconnectable 重新允许（loadState / 用户重新启用）。
    return this.withUserLock(userId, async () => {
      if (this.sealedUsers.has(userId)) {
        logger.warn(
          { userId, channelType },
          'connectChannel rejected: user sealed (disabled/deleted)',
        );
        // 谨慎：仍然 disconnect 任何已构造的 channel 释放底层资源
        try {
          await channel.disconnect();
        } catch {
          /* ignore */
        }
        return false;
      }
      return this.withChannelLock(userId, channelType, async () => {
        // Disconnect existing channel of same type
        await this.disconnectChannelLocked(userId, channelType);

        // Re-check sealed inside the channel-lock — disconnectAllUserChannels
        // may have flipped it while we were waiting; in that case bail.
        if (this.sealedUsers.has(userId)) {
          try {
            await channel.disconnect();
          } catch {
            /* ignore */
          }
          return false;
        }
        const conn = this.getOrCreate(userId);
        const connected = await channel.connect(opts);
        if (connected) {
          // 第三次也是最后一次 sealed 检查：channel.connect 期间网络耗时，
          // disconnectAllUserChannels 可能已经把所有 channel 都断完并 seal。
          if (this.sealedUsers.has(userId)) {
            try {
              await channel.disconnect();
            } catch {
              /* ignore */
            }
            return false;
          }
          conn.channels.set(channelType, channel);
          logger.info({ userId, channelType }, 'IM channel connected');
        }
        return connected;
      });
    });
  }

  /**
   * Disconnect a specific channel type for a user.
   */
  async disconnectChannel(userId: string, channelType: string): Promise<void> {
    return this.withChannelLock(userId, channelType, async () => {
      await this.disconnectChannelLocked(userId, channelType);
    });
  }

  /** Caller must already hold the per-(userId, channelType) lock. */
  private async disconnectChannelLocked(
    userId: string,
    channelType: string,
  ): Promise<void> {
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
  ): Promise<string[] | void> {
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
    return channel.sendMessage(chatId, text, localImagePaths);
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
   * Fetch recent messages from a Discord channel/DM, auto-routing via JID prefix.
   * Throws if the JID is not a Discord channel or no Discord connection is available.
   */
  async getDiscordHistory(
    jid: string,
    opts?: DiscordHistoryOpts,
  ): Promise<DiscordHistoryMessage[]> {
    const ch = this.requireDiscordChannel(jid, 'getDiscordHistory');
    return ch.getDiscordHistory(extractChatId(jid), opts);
  }

  /**
   * Get Discord channel/DM metadata.
   */
  async getDiscordChannelInfo(jid: string): Promise<DiscordChannelInfo> {
    const ch = this.requireDiscordChannel(jid, 'getDiscordChannelInfo');
    return ch.getDiscordChannelInfo(extractChatId(jid));
  }

  /**
   * Get Discord guild (server) metadata for the channel's parent guild.
   * Returns null if the JID points to a DM (no guild).
   */
  async getDiscordGuildInfo(jid: string): Promise<DiscordGuildInfo | null> {
    const ch = this.requireDiscordChannel(jid, 'getDiscordGuildInfo');
    return ch.getDiscordGuildInfo(extractChatId(jid));
  }

  /**
   * Resolve the Discord channel adapter for a given JID, asserting type and connectivity.
   */
  private requireDiscordChannel(jid: string, op: string) {
    const channelType = getChannelType(jid);
    if (channelType !== 'discord') {
      throw new Error(`${op}: JID is not a Discord channel: ${jid}`);
    }
    const ch = this.findChannelForJid(jid, 'discord');
    if (!ch || !isDiscordChannel(ch)) {
      throw new Error(`${op}: no connected Discord channel for ${jid}`);
    }
    return ch;
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
    if (channelType !== 'feishu' && channelType !== 'dingtalk' && channelType !== 'discord' && channelType !== 'qq')
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
      isSenderAllowedInGroup: options?.isSenderAllowedInGroup,
      onCardInterrupt: options?.onCardInterrupt,
      onP2pSender: options?.onP2pSender,
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
      ) => { effectiveJid: string; agentId: string | null; sourceJid?: string } | null;
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
      ) => { effectiveJid: string; agentId: string | null; sourceJid?: string } | null;
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
      ) => { effectiveJid: string; agentId: string | null; sourceJid?: string } | null;
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
   * Connect a WhatsApp instance for a specific user.
   *
   * M1：接入 Baileys，QR 状态通过 onConnectionUpdate 推到上层（最终经 WS 推前端）。
   * 缓存最近一次 state 到 lastWhatsAppState，前端刷新页面时通过 GET 接口拿到。
   */
  async connectUserWhatsApp(
    userId: string,
    config: WhatsAppConnectConfig,
    onNewChat: (chatJid: string, chatName: string) => void,
    options?: {
      ignoreMessagesBefore?: number;
      onCommand?: (chatJid: string, command: string) => Promise<string | null>;
      resolveGroupFolder?: (jid: string) => string | undefined;
      resolveEffectiveChatJid?: (
        chatJid: string,
      ) => { effectiveJid: string; agentId: string | null; sourceJid?: string } | null;
      onAgentMessage?: (baseChatJid: string, agentId: string) => void;
      onBotAddedToGroup?: (chatJid: string, chatName: string) => void;
      onBotRemovedFromGroup?: (chatJid: string) => void;
      shouldProcessGroupMessage?: (
        chatJid: string,
        senderImId?: string,
      ) => boolean;
      isGroupOwnerMessage?: (
        chatJid: string,
        senderImId?: string,
      ) => boolean;
      isSenderAllowedInGroup?: (
        chatJid: string,
        senderImId?: string,
      ) => boolean;
      onConnectionUpdate?: (
        userId: string,
        state: WhatsAppConnectionStateSnapshot,
      ) => void;
    },
  ): Promise<boolean> {
    const channel = createWhatsAppChannel(
      {
        accountId: config.accountId,
        phoneNumber: config.phoneNumber,
        authDir:
          config.authDir ??
          getWhatsAppAuthDir(DATA_DIR, userId, config.accountId),
      },
      (state) => {
        this.lastWhatsAppState.set(userId, state);
        options?.onConnectionUpdate?.(userId, state);
      },
    );

    return this.connectChannel(userId, 'whatsapp', channel, {
      onReady: () => {
        logger.info({ userId }, 'User WhatsApp channel ready');
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
      isSenderAllowedInGroup: options?.isSenderAllowedInGroup,
    });
  }

  getUserWhatsAppState(userId: string): WhatsAppConnectionStateSnapshot {
    return (
      this.lastWhatsAppState.get(userId) ?? { status: 'disconnected' as const }
    );
  }

  async disconnectUserWhatsApp(userId: string): Promise<void> {
    await this.disconnectChannel(userId, 'whatsapp');
  }

  /**
   * Full logout for WhatsApp: send logout to WhatsApp servers, drop the socket,
   * and wipe the local auth state directory so the next enable starts fresh
   * (forces a new QR scan, possibly a different account).
   *
   * Distinct from disconnectUserWhatsApp, which only closes the socket but
   * keeps the noise/Signal pre-keys on disk for silent reconnect.
   */
  async logoutUserWhatsApp(userId: string, accountId?: string): Promise<void> {
    const conn = this.connections.get(userId);
    const channel = conn?.channels.get('whatsapp');
    // Best-effort: ask Baileys to send the logout to WhatsApp servers before
    // we tear the socket down. If we already disconnected, the disk wipe below
    // still clears the persisted credentials, so the user can rescan.
    const maybeLogout = (
      channel as unknown as { logout?: () => Promise<void> } | undefined
    )?.logout;
    if (typeof maybeLogout === 'function') {
      try {
        await maybeLogout.call(channel);
      } catch (err) {
        logger.warn(
          { err, userId },
          'WhatsApp channel.logout() threw, continuing with auth wipe',
        );
      }
    }
    await this.disconnectChannel(userId, 'whatsapp');
    this.lastWhatsAppState.delete(userId);

    const authDir = getWhatsAppAuthDir(DATA_DIR, userId, accountId || 'default');
    try {
      await rm(authDir, { recursive: true, force: true });
      logger.info({ userId, authDir }, 'WhatsApp auth state wiped');
    } catch (err) {
      logger.warn(
        { err, userId, authDir },
        'WhatsApp authDir wipe failed (state already gone or perms)',
      );
    }
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
      ) => { effectiveJid: string; agentId: string | null; sourceJid?: string } | null;
      onAgentMessage?: (baseChatJid: string, agentId: string) => void;
      onBotAddedToGroup?: (chatJid: string, chatName: string) => void;
      onBotRemovedFromGroup?: (chatJid: string) => void;
      shouldProcessGroupMessage?: (chatJid: string, senderImId?: string) => boolean;
      isGroupOwnerMessage?: (chatJid: string, senderImId?: string) => boolean;
      resolveRegisteredGroup?: (jid: string) => { activation_mode?: string } | undefined;
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
      resolveRegisteredGroup: options?.resolveRegisteredGroup,
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
      resolveEffectiveChatJid?: (chatJid: string) => { effectiveJid: string; agentId: string | null; sourceJid?: string } | null;
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

  isWhatsAppConnected(userId: string): boolean {
    const conn = this.connections.get(userId);
    return conn?.channels.get('whatsapp')?.isConnected() ?? false;
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
   * Disconnect all IM channels owned by a single user (feishu / telegram /
   * qq / wechat / dingtalk / discord / whatsapp). Used when admin disables
   * or deletes a user — without this, an active feishu bot would keep
   * responding to that user's group messages until the next service restart
   * (loadState filters out non-active users at startup).
   */
  async disconnectAllUserChannels(userId: string): Promise<void> {
    // 必须用 user-scope 锁串行 + 设 sealed 标记：仅 channelType 锁锁不住与
    // 同一 user 的其他 channelType 的 connectChannel 并发，会让被禁用用户的
    // connections 在 connections.delete 之后又被 connectChannel.getOrCreate
    // 复活，bot 持续响应消息。sealed 标记让后续 connectChannel 直接拒绝
    // 直到 markUserReconnectable 调用（恢复用户启用时由 reconnectUserIMChannels 触发）。
    await this.withUserLock(userId, async () => {
      this.sealedUsers.add(userId);
      const conn = this.connections.get(userId);
      if (!conn) {
        logger.info({ userId }, 'No IM connections for user, marked sealed');
        return;
      }
      const channelTypes = Array.from(conn.channels.keys());
      for (const ct of channelTypes) {
        try {
          await this.disconnectChannelLocked(userId, ct);
        } catch (err) {
          logger.warn(
            { userId, channelType: ct, err },
            'Error disconnecting user IM channel',
          );
        }
      }
      const remaining = this.connections.get(userId);
      if (remaining && remaining.channels.size === 0) {
        this.connections.delete(userId);
      }
      logger.info(
        { userId, sealedDuringDisconnect: true },
        'All IM channels for user disconnected',
      );
    });
  }

  /**
   * Allow connectChannel for this userId again. Used by reconnectUserIMChannels
   * when an admin re-enables a previously disabled/deleted user — without this
   * the sealed flag would block all reconnection until process restart.
   */
  markUserReconnectable(userId: string): void {
    this.sealedUsers.delete(userId);
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
