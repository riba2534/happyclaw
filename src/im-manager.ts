/**
 * IM Connection Pool Manager
 *
 * Manages per-user IM connections (Feishu, Telegram).
 * Each user can have independent IM connections that route messages
 * to their home container.
 */
import { createFeishuConnection, FeishuConnection } from './feishu.js';
import { createTelegramConnection, TelegramConnection } from './telegram.js';
import { getRegisteredGroup, getJidsByFolder } from './db.js';
import { logger } from './logger.js';

export interface UserIMConnection {
  userId: string;
  feishu?: FeishuConnection;
  telegram?: TelegramConnection;
}

export interface FeishuConnectConfig {
  appId: string;
  appSecret: string;
  enabled?: boolean;
}

export interface TelegramConnectConfig {
  botToken: string;
  enabled?: boolean;
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
      conn = { userId };
      this.connections.set(userId, conn);
    }
    return conn;
  }

  /**
   * Connect a Feishu instance for a specific user.
   * @param userId - The user ID to associate the connection with
   * @param config - Feishu app credentials
   * @param onNewChat - Callback when a new chat is discovered
   * @param ignoreMessagesBefore - Optional timestamp to ignore stale messages
   */
  async connectUserFeishu(
    userId: string,
    config: FeishuConnectConfig,
    onNewChat: (chatJid: string, chatName: string) => void,
    ignoreMessagesBefore?: number,
  ): Promise<boolean> {
    if (!config.appId || !config.appSecret) {
      logger.info({ userId }, 'Feishu config empty, skipping connection');
      return false;
    }

    // Stop existing connection if any
    await this.disconnectUserFeishu(userId);

    const conn = this.getOrCreate(userId);
    const feishu = createFeishuConnection({
      appId: config.appId,
      appSecret: config.appSecret,
    });

    const connected = await feishu.connect({
      onReady: () => {
        logger.info({ userId }, 'User Feishu WebSocket connected');
      },
      onNewChat,
      ignoreMessagesBefore,
    });

    if (connected) {
      conn.feishu = feishu;
      logger.info({ userId }, 'User Feishu connection established');
    }

    return connected;
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
  ): Promise<boolean> {
    if (!config.botToken) {
      logger.info({ userId }, 'Telegram config empty, skipping connection');
      return false;
    }

    // Stop existing connection if any
    await this.disconnectUserTelegram(userId);

    const conn = this.getOrCreate(userId);
    const telegram = createTelegramConnection({
      botToken: config.botToken,
    });

    try {
      await telegram.connect({
        onReady: () => {
          logger.info({ userId }, 'User Telegram bot connected');
        },
        onNewChat,
        isChatAuthorized: isChatAuthorized ?? (() => true),
        onPairAttempt,
      });

      if (telegram.isConnected()) {
        conn.telegram = telegram;
        logger.info({ userId }, 'User Telegram connection established');
        return true;
      }
      return false;
    } catch (err) {
      logger.error({ userId, err }, 'Failed to connect user Telegram');
      return false;
    }
  }

  async disconnectUserFeishu(userId: string): Promise<void> {
    const conn = this.connections.get(userId);
    if (conn?.feishu) {
      await conn.feishu.stop();
      conn.feishu = undefined;
      logger.info({ userId }, 'User Feishu connection disconnected');
    }
  }

  async disconnectUserTelegram(userId: string): Promise<void> {
    const conn = this.connections.get(userId);
    if (conn?.telegram) {
      await conn.telegram.disconnect();
      conn.telegram = undefined;
      logger.info({ userId }, 'User Telegram connection disconnected');
    }
  }

  /**
   * Send a message to a Feishu chat, routing through the correct user's connection.
   * Resolves the user by looking up chatJid → registered_groups.created_by.
   * Falls back to iterating all connections if no created_by is set.
   */
  async sendFeishuMessage(chatJid: string, text: string): Promise<void> {
    const chatId = chatJid.replace(/^feishu:/, '');

    // Find the appropriate connection by group ownership
    const group = getRegisteredGroup(chatJid);
    if (group?.created_by) {
      const conn = this.connections.get(group.created_by);
      if (conn?.feishu?.isConnected()) {
        await conn.feishu.sendMessage(chatId, text);
        return;
      }
    }

    // Fallback: find owner via sibling groups sharing the same folder
    if (group) {
      const siblingJids = getJidsByFolder(group.folder);
      for (const sibJid of siblingJids) {
        if (sibJid === chatJid) continue;
        const sibling = getRegisteredGroup(sibJid);
        if (sibling?.created_by) {
          const conn = this.connections.get(sibling.created_by);
          if (conn?.feishu?.isConnected()) {
            logger.warn(
              { chatJid, fallbackUserId: sibling.created_by, folder: group.folder },
              'Feishu message routed via sibling group owner connection',
            );
            await conn.feishu.sendMessage(chatId, text);
            return;
          }
        }
      }
    }

    logger.warn({ chatJid }, 'No Feishu connection available to send message');
  }

  /**
   * Send a message to a Telegram chat, routing through the correct user's connection.
   */
  async sendTelegramMessage(chatJid: string, text: string): Promise<void> {
    const chatId = chatJid.replace(/^telegram:/, '');

    // Find the appropriate connection by group ownership
    const group = getRegisteredGroup(chatJid);
    if (group?.created_by) {
      const conn = this.connections.get(group.created_by);
      if (conn?.telegram?.isConnected()) {
        await conn.telegram.sendMessage(chatId, text);
        return;
      }
    }

    // Fallback: find owner via sibling groups sharing the same folder
    if (group) {
      const siblingJids = getJidsByFolder(group.folder);
      for (const sibJid of siblingJids) {
        if (sibJid === chatJid) continue;
        const sibling = getRegisteredGroup(sibJid);
        if (sibling?.created_by) {
          const conn = this.connections.get(sibling.created_by);
          if (conn?.telegram?.isConnected()) {
            logger.warn(
              { chatJid, fallbackUserId: sibling.created_by, folder: group.folder },
              'Telegram message routed via sibling group owner connection',
            );
            await conn.telegram.sendMessage(chatId, text);
            return;
          }
        }
      }
    }

    logger.warn({ chatJid }, 'No Telegram connection available to send message');
  }

  /**
   * Set typing reaction on a Feishu chat.
   */
  async setFeishuTyping(chatJid: string, isTyping: boolean): Promise<void> {
    const chatId = chatJid.replace(/^feishu:/, '');

    const group = getRegisteredGroup(chatJid);
    if (group?.created_by) {
      const conn = this.connections.get(group.created_by);
      if (conn?.feishu?.isConnected()) {
        await conn.feishu.sendReaction(chatId, isTyping);
        return;
      }
    }

    // No fallback for typing — silently ignore if owner's connection is unavailable
  }

  /**
   * Sync Feishu groups via a specific user's connection.
   */
  async syncFeishuGroups(userId: string): Promise<void> {
    const conn = this.connections.get(userId);
    if (conn?.feishu?.isConnected()) {
      await conn.feishu.syncGroups();
    }
  }

  isFeishuConnected(userId: string): boolean {
    const conn = this.connections.get(userId);
    return conn?.feishu?.isConnected() ?? false;
  }

  isTelegramConnected(userId: string): boolean {
    const conn = this.connections.get(userId);
    return conn?.telegram?.isConnected() ?? false;
  }

  /** Check if any user has an active Feishu connection */
  isAnyFeishuConnected(): boolean {
    for (const conn of this.connections.values()) {
      if (conn.feishu?.isConnected()) return true;
    }
    return false;
  }

  /** Check if any user has an active Telegram connection */
  isAnyTelegramConnected(): boolean {
    for (const conn of this.connections.values()) {
      if (conn.telegram?.isConnected()) return true;
    }
    return false;
  }

  /** Get the Feishu connection for a user (for direct access like syncGroups) */
  getFeishuConnection(userId: string): FeishuConnection | undefined {
    return this.connections.get(userId)?.feishu;
  }

  /** Get the Telegram connection for a user */
  getTelegramConnection(userId: string): TelegramConnection | undefined {
    return this.connections.get(userId)?.telegram;
  }

  /** Get all user IDs with active connections */
  getConnectedUserIds(): string[] {
    const ids: string[] = [];
    for (const [userId, conn] of this.connections.entries()) {
      if (conn.feishu?.isConnected() || conn.telegram?.isConnected()) {
        ids.push(userId);
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
      if (conn.feishu) {
        promises.push(
          conn.feishu.stop().catch((err) => {
            logger.warn({ userId, err }, 'Error stopping Feishu connection');
          }),
        );
      }
      if (conn.telegram) {
        promises.push(
          conn.telegram.disconnect().catch((err) => {
            logger.warn({ userId, err }, 'Error stopping Telegram connection');
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
