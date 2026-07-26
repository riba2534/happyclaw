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
  type ChannelMessageDeliveryOptions,
  getChannelType,
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
import { type FeishuConnectionConfig } from './feishu.js';
import type { FeishuConversationPlan } from './feishu-conversation-policy.js';
import type { TelegramConnectionConfig } from './telegram.js';
import type { QQConnectionConfig } from './qq.js';
import type {
  WeChatConnectionConfig,
  WeChatConnectionState,
} from './wechat.js';
import type { DingTalkConnectionConfig } from './dingtalk.js';
import type { DiscordConnectionConfig } from './discord.js';
import {
  getWhatsAppAuthDir,
  type WhatsAppConnectionConfig,
  type WhatsAppConnectionState,
} from './whatsapp.js';
import { rm } from 'fs/promises';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';
import type { StreamingSession } from './im-channel.js';
import type { StreamingCardLifecycle } from './feishu-streaming-card.js';
import type { StreamingCardRecord } from './channel-reliability-store.js';
import {
  getRegisteredGroup,
  getDefaultChannelAccount,
  getLegacyChannelAccount,
  getChannelAccount,
  getUserById,
  isDatabaseInitialized,
} from './db.js';
import { getUserDingTalkConfig } from './runtime-config.js';
import { logger } from './logger.js';
import type {
  ChannelMessageMeta,
  ChannelTurnContext,
  FollowUpAction,
  FollowUpActionResult,
  FollowUpDisposition,
  FollowUpMode,
} from './types.js';
import type {
  FeishuCapabilityRequest,
  FeishuCapabilityResult,
} from './feishu-capability.js';
import {
  channelConversationJid,
  extractProviderTarget,
  parseChannelAddress,
  scopeChannelJid,
} from './channel-address.js';
import { ChannelRouteRejectedError } from './channel-admission.js';

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
  bypassProxy?: boolean;
  enabled?: boolean;
}

export interface DingTalkConnectConfig {
  clientId: string;
  clientSecret: string;
  enabled?: boolean;
  streamingMode?: 'card' | 'text';
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
  accountId?: string;
  scopeIncomingJids?: boolean;
  ignoreMessagesBefore?: number;
  onCommand?: (
    chatJid: string,
    command: string,
    senderImId?: string,
    mentions?: Array<{
      key?: string;
      name?: string;
      id?: { open_id?: string };
    }>,
  ) => Promise<string | null>;
  resolveGroupFolder?: (chatJid: string) => string | undefined;
  resolveEffectiveChatJid?: (
    chatJid: string,
    messageMeta?: ChannelMessageMeta,
  ) => {
    effectiveJid: string;
    agentId: string | null;
    sourceJid?: string;
  } | null;
  onAgentMessage?: (baseChatJid: string, agentId: string) => void;
  onFollowUpMessage?: (input: {
    targetJid: string;
    sourceJid: string;
    messageId: string;
    senderImId: string;
    requestedMode?: FollowUpMode;
    repliedToActiveCard: boolean;
  }) => FollowUpDisposition;
  onFollowUpCardAction?: (input: {
    sourceJid: string;
    targetJid: string;
    messageId: string;
    action: FollowUpAction;
    expectedRunId: string;
    operatorImId: string;
  }) => Promise<FollowUpActionResult> | FollowUpActionResult;
  onBotAddedToGroup?: (chatJid: string, chatName: string) => void;
  onBotRemovedFromGroup?: (chatJid: string) => void;
  shouldProcessGroupMessage?: (chatJid: string, senderImId?: string) => boolean;
  resolveFeishuConversationPlan?: (
    chatJid: string,
    messageMeta: ChannelMessageMeta,
  ) => FeishuConversationPlan;
  isGroupOwnerMessage?: (chatJid: string, senderImId?: string) => boolean;
  isSenderAllowedInGroup?: (chatJid: string, senderImId?: string) => boolean;
  onCardInterrupt?: (
    chatJid: string,
    operatorImId: string,
  ) => FollowUpActionResult;
  onP2pSender?: (senderOpenId: string) => void;
}

export class IMConnectionManager {
  private connections = new Map<string, UserIMConnection>();
  private adminUserIds = new Set<string>();
  private lastWhatsAppState = new Map<
    string,
    WhatsAppConnectionStateSnapshot
  >();
  private dingtalkStreamingModes = new Map<string, 'card' | 'text'>();
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
  // A provider credential must own at most one live connector. Duplicate
  // Feishu/DingTalk/Telegram/QQ/Discord accounts otherwise compete for the
  // same event stream (409 polling conflicts or duplicate replies).
  private credentialClaims = new Map<string, string>();
  private connectionCredentialClaims = new Map<string, string>();
  private feishuGroupSyncs = new Map<string, Promise<number>>();
  private channelReadyListeners = new Set<
    (event: {
      userId: string;
      channelType: string;
      accountId: string | null;
    }) => void
  >();
  /**
   * Process-wide inbound admission gate used by graceful shutdown. It stops
   * every account-scoped callback without disconnecting the underlying IM
   * clients, so active runs can still use those clients to terminalize cards
   * and flush outbound acknowledgements before transport teardown.
   */
  private inboundPaused = false;
  private inboundDeferred = false;

  pauseInbound(): void {
    this.inboundPaused = true;
    logger.info('IM inbound callbacks paused');
  }

  resumeInbound(): void {
    this.inboundPaused = false;
    logger.info('IM inbound callbacks resumed');
  }

  deferInbound(): void {
    this.inboundDeferred = true;
    logger.info('Durable IM inbound execution deferred for recovery');
  }

  resumeDeferredInbound(): void {
    this.inboundDeferred = false;
    logger.info('Durable IM inbound execution resumed after recovery');
  }

  onChannelReady(
    listener: (event: {
      userId: string;
      channelType: string;
      accountId: string | null;
    }) => void,
  ): () => void {
    this.channelReadyListeners.add(listener);
    return () => this.channelReadyListeners.delete(listener);
  }

  private channelKey(channelType: string, accountId?: string | null): string {
    return accountId ? `${channelType}\u0000${accountId}` : channelType;
  }

  private whatsAppStateKey(userId: string, accountId?: string | null): string {
    return `${userId}\u0000${accountId || 'legacy'}`;
  }

  private claimCredential(
    provider: string,
    credentialIdentity: string,
    userId: string,
    accountId?: string | null,
  ): void {
    const fingerprint = crypto
      .createHash('sha256')
      .update(`${provider}\0${credentialIdentity}`)
      .digest('hex');
    const credentialKey = `${provider}\0${fingerprint}`;
    const channelKey = this.channelKey(provider, accountId);
    const ownerKey = `${userId}\0${channelKey}`;
    const claimedBy = this.credentialClaims.get(credentialKey);
    if (claimedBy && claimedBy !== ownerKey) {
      throw new Error(
        `The same ${provider} credential is already connected by another channel account`,
      );
    }
    const previousCredential = this.connectionCredentialClaims.get(ownerKey);
    if (previousCredential && previousCredential !== credentialKey) {
      this.credentialClaims.delete(previousCredential);
    }
    this.credentialClaims.set(credentialKey, ownerKey);
    this.connectionCredentialClaims.set(ownerKey, credentialKey);
  }

  private releaseCredentialClaim(userId: string, channelKey: string): void {
    const ownerKey = `${userId}\0${channelKey}`;
    const credentialKey = this.connectionCredentialClaims.get(ownerKey);
    if (!credentialKey) return;
    if (this.credentialClaims.get(credentialKey) === ownerKey) {
      this.credentialClaims.delete(credentialKey);
    }
    this.connectionCredentialClaims.delete(ownerKey);
  }

  private scopeConnectOpts(
    opts: IMChannelConnectOpts,
    accountId?: string | null,
    userId?: string,
  ): IMChannelConnectOpts {
    const scope = (jid: string) =>
      accountId ? scopeChannelJid(jid, accountId) : jid;
    const inboundAllowed = (): boolean => {
      if (this.inboundPaused) return false;
      if (userId && this.sealedUsers.has(userId)) return false;
      // Most lifecycle unit tests intentionally use the manager without a DB.
      // The production process always initializes SQLite before connecting IM.
      if (!userId || !isDatabaseInitialized()) return true;
      try {
        const user = getUserById(userId);
        if (!user || user.status !== 'active') return false;
        if (accountId) {
          const account = getChannelAccount(accountId);
          if (
            !account ||
            !account.enabled ||
            account.owner_user_id !== userId
          ) {
            return false;
          }
        }
        return true;
      } catch (error) {
        logger.error(
          { error, userId, accountId },
          'Failed to verify inbound IM principal; rejecting message',
        );
        return false;
      }
    };
    return {
      ...opts,
      shouldDeferInbound: () =>
        this.inboundDeferred ||
        this.inboundPaused ||
        opts.shouldDeferInbound?.() === true,
      normalizeIncomingJid: scope,
      onNewChat: (jid, name) => {
        if (inboundAllowed()) opts.onNewChat(scope(jid), name);
      },
      ...(opts.onMessage
        ? {
            onMessage: (jid: string, text: string, sender: string) => {
              if (inboundAllowed()) {
                opts.onMessage!(scope(jid), text, sender);
              }
            },
          }
        : {}),
      ...(opts.isChatAuthorized
        ? {
            isChatAuthorized: (jid: string) =>
              inboundAllowed() && opts.isChatAuthorized!(scope(jid)),
          }
        : {}),
      ...(opts.onPairAttempt
        ? {
            onPairAttempt: (jid: string, name: string, code: string) =>
              inboundAllowed()
                ? opts.onPairAttempt!(scope(jid), name, code)
                : Promise.resolve(false),
          }
        : {}),
      ...(opts.onNativeContextDetected
        ? {
            onNativeContextDetected: (jid: string, contextType: 'thread') =>
              inboundAllowed()
                ? opts.onNativeContextDetected!(scope(jid), contextType)
                : false,
          }
        : {}),
      ...(opts.onCommand
        ? {
            onCommand: (jid: string, command: string, sender?: string) =>
              inboundAllowed()
                ? opts.onCommand!(scope(jid), command, sender)
                : Promise.resolve(null),
          }
        : {}),
      ...(opts.resolveGroupFolder
        ? {
            resolveGroupFolder: (jid: string) =>
              inboundAllowed()
                ? opts.resolveGroupFolder!(scope(jid))
                : undefined,
          }
        : {}),
      ...(opts.resolveEffectiveChatJid
        ? {
            resolveEffectiveChatJid: (
              jid: string,
              meta?: ChannelMessageMeta,
            ) => {
              if (!inboundAllowed()) {
                throw new ChannelRouteRejectedError(scope(jid));
              }
              const resolved = opts.resolveEffectiveChatJid!(scope(jid), meta);
              if (!resolved) {
                throw new ChannelRouteRejectedError(scope(jid));
              }
              return {
                ...resolved,
                ...(resolved.sourceJid
                  ? { sourceJid: scope(resolved.sourceJid) }
                  : {}),
              };
            },
          }
        : {}),
      ...(opts.onAgentMessage
        ? {
            onAgentMessage: (jid: string, agentId: string) => {
              if (inboundAllowed()) {
                opts.onAgentMessage!(scope(jid), agentId);
              }
            },
          }
        : {}),
      ...(opts.onFollowUpMessage
        ? {
            onFollowUpMessage: (
              input: Parameters<
                NonNullable<IMChannelConnectOpts['onFollowUpMessage']>
              >[0],
            ) =>
              inboundAllowed()
                ? opts.onFollowUpMessage!(input)
                : { disposition: 'queued' as const },
          }
        : {}),
      ...(opts.onFollowUpCardAction
        ? {
            onFollowUpCardAction: (
              input: Parameters<
                NonNullable<IMChannelConnectOpts['onFollowUpCardAction']>
              >[0],
            ) =>
              inboundAllowed()
                ? opts.onFollowUpCardAction!(input)
                : {
                    ok: false,
                    message: '当前连接已停用，无法执行操作。',
                  },
          }
        : {}),
      ...(opts.onBotAddedToGroup
        ? {
            onBotAddedToGroup: (jid: string, name: string) => {
              if (inboundAllowed()) {
                opts.onBotAddedToGroup!(scope(jid), name);
              }
            },
          }
        : {}),
      ...(opts.onBotRemovedFromGroup
        ? {
            onBotRemovedFromGroup: (jid: string) => {
              if (inboundAllowed()) opts.onBotRemovedFromGroup!(scope(jid));
            },
          }
        : {}),
      ...(opts.shouldProcessGroupMessage
        ? {
            shouldProcessGroupMessage: (jid: string, sender?: string) =>
              inboundAllowed() &&
              opts.shouldProcessGroupMessage!(scope(jid), sender),
          }
        : {}),
      ...(opts.resolveFeishuConversationPlan
        ? {
            resolveFeishuConversationPlan: (
              jid: string,
              meta: ChannelMessageMeta,
            ) => {
              if (!inboundAllowed()) {
                throw new ChannelRouteRejectedError(scope(jid));
              }
              return opts.resolveFeishuConversationPlan!(scope(jid), meta);
            },
          }
        : {}),
      ...(opts.isGroupOwnerMessage
        ? {
            isGroupOwnerMessage: (jid: string, sender?: string) =>
              inboundAllowed() && opts.isGroupOwnerMessage!(scope(jid), sender),
          }
        : {}),
      ...(opts.isSenderAllowedInGroup
        ? {
            isSenderAllowedInGroup: (jid: string, sender?: string) =>
              inboundAllowed() &&
              opts.isSenderAllowedInGroup!(scope(jid), sender),
          }
        : {}),
      ...(opts.resolveRegisteredGroup
        ? {
            resolveRegisteredGroup: (jid: string) =>
              inboundAllowed()
                ? opts.resolveRegisteredGroup!(scope(jid))
                : undefined,
          }
        : {}),
      ...(opts.onCardInterrupt
        ? {
            onCardInterrupt: (jid: string, operatorImId: string) =>
              inboundAllowed()
                ? opts.onCardInterrupt!(scope(jid), operatorImId)
                : { ok: false, message: '当前连接已停用，无法执行操作。' },
          }
        : {}),
      ...(opts.onP2pSender
        ? {
            onP2pSender: (senderOpenId: string) => {
              if (inboundAllowed()) opts.onP2pSender!(senderOpenId);
            },
          }
        : {}),
    };
  }

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
    accountId?: string | null,
    scopeIncomingJids = true,
    credentialIdentity?: string,
  ): Promise<boolean> {
    const channelKey = this.channelKey(channelType, accountId);
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
      return this.withChannelLock(userId, channelKey, async () => {
        // Disconnect existing channel of same type
        await this.disconnectChannelLocked(userId, channelKey);

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
        if (credentialIdentity) {
          this.claimCredential(
            channelType,
            credentialIdentity,
            userId,
            accountId,
          );
        }
        const conn = this.getOrCreate(userId);
        const cleanupRejectedChannel = async (): Promise<boolean> => {
          try {
            await channel.disconnect();
            return true;
          } catch (cleanupError) {
            // A failed cleanup may leave provider timers/listeners alive. Keep
            // both the connector and credential claim tracked so shutdown or
            // a later disconnect retry can finish cleanup without allowing a
            // duplicate connector to claim the same Bot identity.
            conn.channels.set(channelKey, channel);
            logger.error(
              { cleanupError, userId, channelType, accountId },
              'Failed IM connector cleanup remains tracked for retry',
            );
            return false;
          }
        };
        let connected: boolean;
        try {
          connected = await channel.connect(
            this.scopeConnectOpts(
              opts,
              scopeIncomingJids ? accountId : null,
              userId,
            ),
          );
        } catch (error) {
          if (await cleanupRejectedChannel()) {
            this.releaseCredentialClaim(userId, channelKey);
          }
          throw error;
        }
        if (connected) {
          // 第三次也是最后一次 sealed 检查：channel.connect 期间网络耗时，
          // disconnectAllUserChannels 可能已经把所有 channel 都断完并 seal。
          if (this.sealedUsers.has(userId)) {
            try {
              await channel.disconnect();
            } catch {
              /* ignore */
            }
            this.releaseCredentialClaim(userId, channelKey);
            return false;
          }
          conn.channels.set(channelKey, channel);
          for (const listener of this.channelReadyListeners) {
            try {
              listener({ userId, channelType, accountId: accountId ?? null });
            } catch (error) {
              logger.warn(
                { error, userId, channelType, accountId },
                'IM channel-ready listener failed',
              );
            }
          }
          logger.info(
            { userId, channelType, accountId },
            'IM channel connected',
          );
        } else {
          if (await cleanupRejectedChannel()) {
            this.releaseCredentialClaim(userId, channelKey);
          }
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

  async disconnectChannelAccount(
    userId: string,
    channelType: string,
    accountId: string,
  ): Promise<void> {
    const key = this.channelKey(channelType, accountId);
    return this.withChannelLock(userId, key, async () => {
      await this.disconnectChannelLocked(userId, key);
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
    this.releaseCredentialClaim(userId, channelType);
  }

  /**
   * Send a message to an IM chat, auto-routing via JID prefix.
   * Resolves the user by looking up chatJid -> registered_groups.created_by.
   * Routing is fail-closed against the persisted user/account state.
   */
  async sendMessage(
    jid: string,
    text: string,
    localImagePaths?: string[],
    options?: ChannelMessageDeliveryOptions,
  ): Promise<void> {
    const channelType = getChannelType(jid);
    if (!channelType) {
      logger.debug({ jid }, 'Unknown channel type for JID, skip sending');
      throw new Error(`Unknown channel type for JID: ${jid}`);
    }

    const chatId = extractProviderTarget(jid);
    const channel = this.findChannelForJid(jid, channelType);
    if (!channel) {
      throw new Error(`No IM channel available for ${jid} (${channelType})`);
    }
    if (options) {
      await channel.sendMessage(chatId, text, localImagePaths, options);
    } else {
      // Preserve the historical three-argument connector call shape.
      await channel.sendMessage(chatId, text, localImagePaths);
    }
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
      throw new Error(`Unknown channel type for image JID: ${jid}`);
    }

    const chatId = extractProviderTarget(jid);
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
    throw new Error(`No IM channel available for ${jid} (${channelType})`);
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

    const chatId = extractProviderTarget(jid);
    const channel = this.findChannelForJid(jid, channelType);
    if (channel?.sendFile) {
      await channel.sendFile(chatId, filePath, fileName);
    } else {
      throw new Error(`通道 ${channelType} 不支持发送文件`);
    }
  }

  /**
   * Execute a Feishu operation through the exact account-scoped connection
   * selected by the trusted current-turn JID. This deliberately reuses the
   * same persisted owner/account/enabled gates as ordinary outbound sends.
   */
  async executeFeishuCapability(
    jid: string,
    context: ChannelTurnContext,
    request: FeishuCapabilityRequest,
  ): Promise<FeishuCapabilityResult> {
    if (getChannelType(jid) !== 'feishu') {
      throw new Error('Feishu capability requires a Feishu JID');
    }
    const channel = this.findChannelForJid(jid, 'feishu');
    if (!channel?.executeFeishuCapability) {
      throw new Error(`No connected Feishu Bot is available for ${jid}`);
    }
    return channel.executeFeishuCapability(context, request);
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
    return ch.getDiscordHistory(extractProviderTarget(jid), opts);
  }

  /**
   * Get Discord channel/DM metadata.
   */
  async getDiscordChannelInfo(jid: string): Promise<DiscordChannelInfo> {
    const ch = this.requireDiscordChannel(jid, 'getDiscordChannelInfo');
    return ch.getDiscordChannelInfo(extractProviderTarget(jid));
  }

  /**
   * Get Discord guild (server) metadata for the channel's parent guild.
   * Returns null if the JID points to a DM (no guild).
   */
  async getDiscordGuildInfo(jid: string): Promise<DiscordGuildInfo | null> {
    const ch = this.requireDiscordChannel(jid, 'getDiscordGuildInfo');
    return ch.getDiscordGuildInfo(extractProviderTarget(jid));
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
  async setTyping(
    jid: string,
    isTyping: boolean,
    leaseId?: string,
  ): Promise<void> {
    const channelType = getChannelType(jid);
    if (!channelType) return;

    const chatId = extractProviderTarget(jid);
    const channel = this.findChannelForJid(jid, channelType);
    if (channel) {
      await channel.setTyping(chatId, isTyping, leaseId);
    }
    // No fallback for typing — silently ignore if owner's connection is unavailable
  }

  /**
   * Clear the ack reaction for a chat (e.g. when streaming card handled the reply).
   */
  async clearAckReaction(jid: string, inputMessageId: string): Promise<void> {
    const channelType = getChannelType(jid);
    if (!channelType) return;

    const chatId = extractProviderTarget(jid);
    const channel = this.findChannelForJid(jid, channelType);
    if (channel?.clearAckReaction) {
      await channel.clearAckReaction(chatId, inputMessageId);
    }
  }

  /**
   * Create a streaming card session for an IM chat (Feishu or DingTalk).
   * Returns undefined for unsupported channels.
   */
  async createStreamingSession(
    jid: string,
    onCardCreated?: (messageId: string) => void,
    lifecycle?: StreamingCardLifecycle,
  ): Promise<StreamingSession | undefined> {
    const channelType = getChannelType(jid);
    if (
      channelType !== 'feishu' &&
      channelType !== 'dingtalk' &&
      channelType !== 'discord' &&
      channelType !== 'qq'
    )
      return undefined;

    // Check DingTalk streaming mode: if text mode, skip streaming session creation
    if (channelType === 'dingtalk') {
      const group = getRegisteredGroup(jid);
      if (group?.created_by) {
        const accountId =
          parseChannelAddress(jid)?.channelAccountId ??
          group.channel_account_id ??
          getDefaultChannelAccount(group.created_by, 'dingtalk')?.id;
        const accountMode = accountId
          ? this.dingtalkStreamingModes.get(
              `${group.created_by}\u0000${accountId}`,
            )
          : undefined;
        const legacyMode = getUserDingTalkConfig(
          group.created_by,
        )?.streamingMode;
        if ((accountMode ?? legacyMode) === 'text') {
          logger.debug({ jid }, 'DingTalk streaming disabled (text mode)');
          return undefined;
        }
      }
    }

    const chatId = extractProviderTarget(jid);
    const channel = this.findChannelForJid(jid, channelType);
    if (channel?.createStreamingSession) {
      return channel.createStreamingSession(chatId, onCardCreated, lifecycle);
    }
    return undefined;
  }

  /**
   * Reconcile a persisted Feishu card only through its recorded Bot account.
   * A different connected Bot must never update a card it did not create.
   */
  async reconcileStreamingCard(record: StreamingCardRecord): Promise<{
    version: number;
    method: 'cardkit' | 'message_patch';
  }> {
    if (record.provider !== 'feishu') {
      throw new Error(
        `Unsupported streaming card provider: ${record.provider}`,
      );
    }
    const scopedAccountId = parseChannelAddress(
      record.sourceJid,
    )?.channelAccountId;
    if (scopedAccountId && scopedAccountId !== record.accountId) {
      throw new ChannelRouteRejectedError(
        `Streaming card account mismatch: ${scopedAccountId} != ${record.accountId}`,
      );
    }
    const group = getRegisteredGroup(channelConversationJid(record.sourceJid));
    const ownerId = group?.created_by;
    const channel = ownerId
      ? this.connections
          .get(ownerId)
          ?.channels.get(this.channelKey('feishu', record.accountId))
      : undefined;
    if (
      !ownerId ||
      !this.isOutboundConnectionAllowed(ownerId, 'feishu', record.accountId)
    ) {
      throw new ChannelRouteRejectedError(
        `Recorded Feishu Bot is not authorized: account=${record.accountId}`,
      );
    }
    if (!channel?.isConnected() || !channel.reconcileStreamingCard) {
      throw new Error(
        `Recorded Feishu Bot is not ready: account=${record.accountId}`,
      );
    }
    return channel.reconcileStreamingCard({
      messageId: record.messageId,
      cardId: record.cardId,
      version: record.version,
      snapshot: record.snapshot,
      reason: '上次服务中断，本次任务未完成',
    });
  }

  /**
   * Find the appropriate IMChannel for a given JID. The registered group fixes
   * both the owning user and channel account; another Bot in the same workspace
   * must never be used as an outbound fallback.
   */
  private findChannelForJid(
    jid: string,
    channelType: string,
  ): IMChannel | undefined {
    const baseJid = channelConversationJid(jid);
    const scopedAccountId = parseChannelAddress(jid)?.channelAccountId;
    const group = getRegisteredGroup(baseJid);
    if (group?.created_by) {
      const conn = this.connections.get(group.created_by);
      const accountId =
        scopedAccountId ??
        group.channel_account_id ??
        getLegacyChannelAccount(
          group.created_by,
          channelType as Parameters<typeof getLegacyChannelAccount>[1],
        )?.id;
      if (
        !this.isOutboundConnectionAllowed(
          group.created_by,
          channelType,
          accountId,
        )
      ) {
        return undefined;
      }
      const ch = conn?.channels.get(this.channelKey(channelType, accountId));
      if (ch?.isConnected()) return ch;
    }
    return undefined;
  }

  /**
   * A tracked socket is not sufficient authority to send. Disconnect can fail,
   * leaving a live connector behind after an account/user is disabled. Persisted
   * ownership and enabled state therefore gate every outbound lookup as well.
   */
  private isOutboundConnectionAllowed(
    userId: string,
    channelType: string,
    accountId?: string | null,
  ): boolean {
    if (!isDatabaseInitialized()) return true;
    try {
      const user = getUserById(userId);
      if (!user || user.status !== 'active') return false;
      if (!accountId) return true;
      const account = getChannelAccount(accountId);
      return Boolean(
        account &&
        account.enabled &&
        account.owner_user_id === userId &&
        account.provider === channelType,
      );
    } catch (error) {
      logger.error(
        { error, userId, channelType, accountId },
        'Failed to verify outbound IM route; rejecting send',
      );
      return false;
    }
  }

  /**
   * Get all connected channel types for a user.
   * Used by scheduled task IM broadcast to discover available channels.
   */
  getConnectedChannelTypes(userId: string): string[] {
    const conn = this.connections.get(userId);
    if (!conn) return [];
    const types: string[] = [];
    for (const [key, ch] of conn.channels.entries()) {
      const [type, accountId] = key.split('\u0000');
      if (
        ch.isConnected() &&
        this.isOutboundConnectionAllowed(userId, type, accountId) &&
        !types.includes(type)
      ) {
        types.push(type);
      }
    }
    return types;
  }

  getConnectedChannelAccountIds(
    userId: string,
    channelType?: string,
  ): string[] {
    const conn = this.connections.get(userId);
    if (!conn) return [];
    const ids: string[] = [];
    for (const [key, ch] of conn.channels.entries()) {
      const [type, accountId] = key.split('\u0000');
      if (
        accountId &&
        ch.isConnected() &&
        this.isOutboundConnectionAllowed(userId, type, accountId) &&
        (!channelType || type === channelType)
      ) {
        ids.push(accountId);
      }
    }
    return ids;
  }

  isChannelAccountConnected(
    userId: string,
    channelType: string,
    accountId: string,
  ): boolean {
    if (!this.isOutboundConnectionAllowed(userId, channelType, accountId)) {
      return false;
    }
    return (
      this.connections
        .get(userId)
        ?.channels.get(this.channelKey(channelType, accountId))
        ?.isConnected() ?? false
    );
  }

  /**
   * Check if a specific JID has a connected channel available.
   * Uses the same persisted owner/account routing as sendMessage.
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
      channelAccountId: options?.accountId,
    });

    return this.connectChannel(
      userId,
      'feishu',
      channel,
      {
        onReady: () => {
          logger.info({ userId }, 'User Feishu WebSocket connected');
        },
        onNewChat,
        ignoreMessagesBefore: options?.ignoreMessagesBefore,
        onCommand: options?.onCommand,
        resolveGroupFolder: options?.resolveGroupFolder,
        resolveEffectiveChatJid: options?.resolveEffectiveChatJid,
        onAgentMessage: options?.onAgentMessage,
        onFollowUpMessage: options?.onFollowUpMessage,
        onFollowUpCardAction: options?.onFollowUpCardAction,
        onBotAddedToGroup: options?.onBotAddedToGroup,
        onBotRemovedFromGroup: options?.onBotRemovedFromGroup,
        shouldProcessGroupMessage: options?.shouldProcessGroupMessage,
        resolveFeishuConversationPlan: options?.resolveFeishuConversationPlan,
        isGroupOwnerMessage: options?.isGroupOwnerMessage,
        isSenderAllowedInGroup: options?.isSenderAllowedInGroup,
        onCardInterrupt: options?.onCardInterrupt,
        onP2pSender: options?.onP2pSender,
      },
      options?.accountId,
      options?.scopeIncomingJids,
      config.appId,
    );
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
      accountId?: string;
      scopeIncomingJids?: boolean;
      onCommand?: (chatJid: string, command: string) => Promise<string | null>;
      ignoreMessagesBefore?: number;
      resolveGroupFolder?: (jid: string) => string | undefined;
      resolveEffectiveChatJid?: (chatJid: string) => {
        effectiveJid: string;
        agentId: string | null;
        sourceJid?: string;
      } | null;
      onAgentMessage?: (baseChatJid: string, agentId: string) => void;
      onBotAddedToGroup?: (chatJid: string, chatName: string) => void;
      onBotRemovedFromGroup?: (chatJid: string) => void;
      onNativeContextDetected?: (
        chatJid: string,
        contextType: 'thread',
      ) => boolean | void | Promise<boolean | void>;
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

    return this.connectChannel(
      userId,
      'telegram',
      channel,
      {
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
        onNativeContextDetected: options?.onNativeContextDetected,
      },
      options?.accountId,
      options?.scopeIncomingJids,
      config.botToken,
    );
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
      accountId?: string;
      scopeIncomingJids?: boolean;
      onCommand?: (chatJid: string, command: string) => Promise<string | null>;
      resolveGroupFolder?: (jid: string) => string | undefined;
      resolveEffectiveChatJid?: (chatJid: string) => {
        effectiveJid: string;
        agentId: string | null;
        sourceJid?: string;
      } | null;
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

    return this.connectChannel(
      userId,
      'qq',
      channel,
      {
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
      },
      options?.accountId,
      options?.scopeIncomingJids,
      config.appId,
    );
  }

  async disconnectUserFeishu(userId: string): Promise<void> {
    await this.disconnectChannel(userId, 'feishu');
  }

  async disconnectUserTelegram(userId: string): Promise<void> {
    await this.disconnectChannel(userId, 'telegram');
  }

  async disconnectUserChannelAccount(
    userId: string,
    channelType: string,
    accountId: string,
  ): Promise<void> {
    await this.disconnectChannelAccount(userId, channelType, accountId);
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
      accountId?: string;
      scopeIncomingJids?: boolean;
      ignoreMessagesBefore?: number;
      onCommand?: (chatJid: string, command: string) => Promise<string | null>;
      resolveGroupFolder?: (jid: string) => string | undefined;
      resolveEffectiveChatJid?: (chatJid: string) => {
        effectiveJid: string;
        agentId: string | null;
        sourceJid?: string;
      } | null;
      onAgentMessage?: (baseChatJid: string, agentId: string) => void;
      isChatAuthorized?: (jid: string) => boolean;
      onPairAttempt?: (
        jid: string,
        chatName: string,
        code: string,
      ) => Promise<boolean>;
      onConnectionStateChange?: (state: WeChatConnectionState) => void;
      onUpdatesBuf?: (cursor: string) => void | Promise<void>;
    },
  ): Promise<boolean> {
    if (!config.botToken || !config.ilinkBotId) {
      logger.info({ userId }, 'WeChat config empty, skipping connection');
      return false;
    }

    const channel = createWeChatChannel(
      {
        botToken: config.botToken,
        ilinkBotId: config.ilinkBotId,
        baseUrl: config.baseUrl,
        cdnBaseUrl: config.cdnBaseUrl,
        getUpdatesBuf: config.getUpdatesBuf,
        bypassProxy: config.bypassProxy,
        logContext: {
          userId,
          accountId: options?.accountId,
        },
      },
      options?.onUpdatesBuf,
    );

    return this.connectChannel(
      userId,
      'wechat',
      channel,
      {
        onReady: () => {
          logger.info(
            { userId, accountId: options?.accountId },
            'User WeChat poller started',
          );
        },
        onNewChat,
        ignoreMessagesBefore: options?.ignoreMessagesBefore,
        onCommand: options?.onCommand,
        resolveGroupFolder: options?.resolveGroupFolder,
        resolveEffectiveChatJid: options?.resolveEffectiveChatJid,
        onAgentMessage: options?.onAgentMessage,
        isChatAuthorized: options?.isChatAuthorized,
        onPairAttempt: options?.onPairAttempt,
        onWeChatConnectionStateChange: options?.onConnectionStateChange,
      },
      options?.accountId,
      options?.scopeIncomingJids,
      config.ilinkBotId,
    );
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
      accountId?: string;
      scopeIncomingJids?: boolean;
      ignoreMessagesBefore?: number;
      isChatAuthorized?: (jid: string) => boolean;
      onPairAttempt?: (
        jid: string,
        chatName: string,
        code: string,
      ) => Promise<boolean>;
      onCommand?: (chatJid: string, command: string) => Promise<string | null>;
      resolveGroupFolder?: (jid: string) => string | undefined;
      resolveEffectiveChatJid?: (chatJid: string) => {
        effectiveJid: string;
        agentId: string | null;
        sourceJid?: string;
      } | null;
      onAgentMessage?: (baseChatJid: string, agentId: string) => void;
      onBotAddedToGroup?: (chatJid: string, chatName: string) => void;
      onBotRemovedFromGroup?: (chatJid: string) => void;
      shouldProcessGroupMessage?: (
        chatJid: string,
        senderImId?: string,
      ) => boolean;
      isGroupOwnerMessage?: (chatJid: string, senderImId?: string) => boolean;
      isSenderAllowedInGroup?: (
        chatJid: string,
        senderImId?: string,
      ) => boolean;
      onConnectionUpdate?: (
        userId: string,
        accountId: string,
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
        const accountId = options?.accountId || config.accountId || 'legacy';
        this.lastWhatsAppState.set(
          this.whatsAppStateKey(userId, accountId),
          state,
        );
        options?.onConnectionUpdate?.(userId, accountId, state);
      },
    );

    return this.connectChannel(
      userId,
      'whatsapp',
      channel,
      {
        onReady: () => {
          logger.info({ userId }, 'User WhatsApp channel ready');
        },
        onNewChat,
        isChatAuthorized: options?.isChatAuthorized,
        onPairAttempt: options?.onPairAttempt,
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
      },
      options?.accountId,
      options?.scopeIncomingJids,
    );
  }

  getUserWhatsAppState(
    userId: string,
    accountId?: string,
  ): WhatsAppConnectionStateSnapshot {
    if (accountId) {
      return (
        this.lastWhatsAppState.get(
          this.whatsAppStateKey(userId, accountId),
        ) ?? { status: 'disconnected' as const }
      );
    }
    // Compatibility for the legacy user-level endpoint: prefer the provider
    // default account, otherwise return the first state owned by this user.
    const defaultId = getDefaultChannelAccount(userId, 'whatsapp')?.id;
    if (defaultId) {
      const current = this.lastWhatsAppState.get(
        this.whatsAppStateKey(userId, defaultId),
      );
      if (current) return current;
    }
    const prefix = `${userId}\u0000`;
    for (const [key, state] of this.lastWhatsAppState) {
      if (key.startsWith(prefix)) return state;
    }
    return { status: 'disconnected' as const };
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
    const channelKey = this.channelKey('whatsapp', accountId);
    const channel = conn?.channels.get(channelKey);
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
    if (accountId) {
      await this.disconnectChannelAccount(userId, 'whatsapp', accountId);
    } else {
      await this.disconnectChannel(userId, 'whatsapp');
    }
    this.lastWhatsAppState.delete(this.whatsAppStateKey(userId, accountId));

    const authDir = getWhatsAppAuthDir(
      DATA_DIR,
      userId,
      accountId || 'default',
    );
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
      accountId?: string;
      scopeIncomingJids?: boolean;
      ignoreMessagesBefore?: number;
      isChatAuthorized?: (jid: string) => boolean;
      onPairAttempt?: (
        jid: string,
        chatName: string,
        code: string,
      ) => Promise<boolean>;
      onCommand?: (chatJid: string, command: string) => Promise<string | null>;
      resolveGroupFolder?: (jid: string) => string | undefined;
      resolveEffectiveChatJid?: (chatJid: string) => {
        effectiveJid: string;
        agentId: string | null;
        sourceJid?: string;
      } | null;
      onAgentMessage?: (baseChatJid: string, agentId: string) => void;
      onBotAddedToGroup?: (chatJid: string, chatName: string) => void;
      onBotRemovedFromGroup?: (chatJid: string) => void;
      shouldProcessGroupMessage?: (
        chatJid: string,
        senderImId?: string,
      ) => boolean;
      isGroupOwnerMessage?: (chatJid: string, senderImId?: string) => boolean;
      resolveRegisteredGroup?: (
        jid: string,
      ) => { activation_mode?: string } | undefined;
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

    if (options?.accountId) {
      this.dingtalkStreamingModes.set(
        `${userId}\u0000${options.accountId}`,
        config.streamingMode === 'text' ? 'text' : 'card',
      );
    }

    return this.connectChannel(
      userId,
      'dingtalk',
      channel,
      {
        onReady: () => {
          logger.info({ userId }, 'User DingTalk bot connected');
        },
        onNewChat,
        isChatAuthorized: options?.isChatAuthorized,
        onPairAttempt: options?.onPairAttempt,
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
      },
      options?.accountId,
      options?.scopeIncomingJids,
      config.clientId,
    );
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
      accountId?: string;
      scopeIncomingJids?: boolean;
      ignoreMessagesBefore?: number;
      isChatAuthorized?: (jid: string) => boolean;
      onPairAttempt?: (
        jid: string,
        chatName: string,
        code: string,
      ) => Promise<boolean>;
      onCommand?: (chatJid: string, command: string) => Promise<string | null>;
      resolveGroupFolder?: (jid: string) => string | undefined;
      resolveEffectiveChatJid?: (chatJid: string) => {
        effectiveJid: string;
        agentId: string | null;
        sourceJid?: string;
      } | null;
      onAgentMessage?: (baseChatJid: string, agentId: string) => void;
      onBotAddedToGroup?: (chatJid: string, chatName: string) => void;
      onBotRemovedFromGroup?: (chatJid: string) => void;
      shouldProcessGroupMessage?: (
        chatJid: string,
        senderImId?: string,
      ) => boolean;
      isGroupOwnerMessage?: (chatJid: string, senderImId?: string) => boolean;
    },
  ): Promise<boolean> {
    if (!config.botToken) return false;
    const channel = createDiscordChannel(
      { botToken: config.botToken },
      { streamingMode: config.streamingMode ?? 'off' },
    );
    return this.connectChannel(
      userId,
      'discord',
      channel,
      {
        onReady: () => logger.info({ userId }, 'User Discord bot connected'),
        onNewChat,
        ignoreMessagesBefore: options?.ignoreMessagesBefore,
        isChatAuthorized: options?.isChatAuthorized,
        onPairAttempt: options?.onPairAttempt,
        onCommand: options?.onCommand,
        resolveGroupFolder: options?.resolveGroupFolder,
        resolveEffectiveChatJid: options?.resolveEffectiveChatJid,
        onAgentMessage: options?.onAgentMessage,
        onBotAddedToGroup: options?.onBotAddedToGroup,
        onBotRemovedFromGroup: options?.onBotRemovedFromGroup,
        shouldProcessGroupMessage: options?.shouldProcessGroupMessage,
        isGroupOwnerMessage: options?.isGroupOwnerMessage,
      },
      options?.accountId,
      options?.scopeIncomingJids,
      config.botToken,
    );
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
    const chatId = extractProviderTarget(chatJid);
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
    const chatId = extractProviderTarget(chatJid);
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
   * Set Telegram typing chat action for a chat.
   * @deprecated Use setTyping(jid, isTyping) which auto-routes.
   */
  async setTelegramTyping(chatJid: string, isTyping: boolean): Promise<void> {
    const chatId = extractProviderTarget(chatJid);
    const channel = this.findChannelForJid(chatJid, 'telegram');
    if (channel) {
      await channel.setTyping(chatId, isTyping);
    }
  }

  /**
   * Sync Feishu groups via a specific user's connection.
   */
  async syncFeishuGroups(userId: string, accountId?: string): Promise<void> {
    const conn = this.connections.get(userId);
    const effectiveId =
      accountId ?? getDefaultChannelAccount(userId, 'feishu')?.id ?? null;
    const channel =
      conn?.channels.get(this.channelKey('feishu', accountId)) ??
      (effectiveId
        ? conn?.channels.get(this.channelKey('feishu', effectiveId))
        : undefined);
    if (channel?.isConnected() && channel.syncGroups) {
      await channel.syncGroups();
    }
  }

  /**
   * Sync every connected Feishu bot owned by one HappyClaw user.
   *
   * The binding UI uses this instead of guessing a default account: every bot
   * has a different chat membership inventory, and legacy/default connectors
   * may not have an account id encoded in their connection key.
   */
  async syncAllFeishuGroups(userId: string): Promise<number> {
    const inFlight = this.feishuGroupSyncs.get(userId);
    if (inFlight) return inFlight;

    const task = (async () => {
      const conn = this.connections.get(userId);
      if (!conn) return 0;

      const targets: Array<{
        accountId: string | null;
        sync: () => Promise<void>;
      }> = [];
      for (const [key, channel] of conn.channels.entries()) {
        const [type, accountId] = key.split('\u0000');
        if (
          type !== 'feishu' ||
          !channel.isConnected() ||
          !channel.syncGroups ||
          !this.isOutboundConnectionAllowed(userId, type, accountId)
        ) {
          continue;
        }
        targets.push({
          accountId: accountId || null,
          sync: () => channel.syncGroups!(),
        });
      }

      const results = await Promise.allSettled(
        targets.map((target) => target.sync()),
      );
      const failures: unknown[] = [];
      let synced = 0;
      results.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          synced += 1;
        } else {
          failures.push(result.reason);
          logger.warn(
            {
              error: result.reason,
              userId,
              accountId: targets[index]?.accountId ?? null,
            },
            'Feishu account group sync failed',
          );
        }
      });

      if (failures.length > 0 && synced === 0) {
        throw failures[0];
      }
      return synced;
    })();
    this.feishuGroupSyncs.set(userId, task);
    try {
      return await task;
    } finally {
      if (this.feishuGroupSyncs.get(userId) === task) {
        this.feishuGroupSyncs.delete(userId);
      }
    }
  }

  isFeishuConnected(userId: string): boolean {
    const conn = this.connections.get(userId);
    return this.hasConnectedType(conn, 'feishu');
  }

  isTelegramConnected(userId: string): boolean {
    const conn = this.connections.get(userId);
    return this.hasConnectedType(conn, 'telegram');
  }

  isQQConnected(userId: string): boolean {
    const conn = this.connections.get(userId);
    return this.hasConnectedType(conn, 'qq');
  }

  /** Check if any user has an active Feishu connection */
  isAnyFeishuConnected(): boolean {
    for (const conn of this.connections.values()) {
      if (this.hasConnectedType(conn, 'feishu')) return true;
    }
    return false;
  }

  /** Check if any user has an active Telegram connection */
  isAnyTelegramConnected(): boolean {
    for (const conn of this.connections.values()) {
      if (this.hasConnectedType(conn, 'telegram')) return true;
    }
    return false;
  }

  isWeChatConnected(userId: string): boolean {
    const conn = this.connections.get(userId);
    return this.hasConnectedType(conn, 'wechat');
  }

  isDingTalkConnected(userId: string): boolean {
    const conn = this.connections.get(userId);
    return this.hasConnectedType(conn, 'dingtalk');
  }

  isDiscordConnected(userId: string): boolean {
    const conn = this.connections.get(userId);
    return this.hasConnectedType(conn, 'discord');
  }

  isWhatsAppConnected(userId: string): boolean {
    const conn = this.connections.get(userId);
    return this.hasConnectedType(conn, 'whatsapp');
  }

  private hasConnectedType(
    conn: UserIMConnection | undefined,
    channelType: string,
  ): boolean {
    if (!conn) return false;
    for (const [key, channel] of conn.channels) {
      if (key.split('\u0000')[0] === channelType && channel.isConnected()) {
        return true;
      }
    }
    return false;
  }

  /** Get the Feishu channel for a user (for direct access like syncGroups) */
  getFeishuConnection(userId: string): IMChannel | undefined {
    const conn = this.connections.get(userId);
    return (
      conn?.channels.get('feishu') ??
      (getDefaultChannelAccount(userId, 'feishu')
        ? conn?.channels.get(
            this.channelKey(
              'feishu',
              getDefaultChannelAccount(userId, 'feishu')!.id,
            ),
          )
        : undefined)
    );
  }

  /** Get the Telegram channel for a user */
  getTelegramConnection(userId: string): IMChannel | undefined {
    const conn = this.connections.get(userId);
    const account = getDefaultChannelAccount(userId, 'telegram');
    return (
      conn?.channels.get('telegram') ??
      (account
        ? conn?.channels.get(this.channelKey('telegram', account.id))
        : undefined)
    );
  }

  /** Get the QQ channel for a user */
  getQQConnection(userId: string): IMChannel | undefined {
    const conn = this.connections.get(userId);
    const account = getDefaultChannelAccount(userId, 'qq');
    return (
      conn?.channels.get('qq') ??
      (account
        ? conn?.channels.get(this.channelKey('qq', account.id))
        : undefined)
    );
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

    const chatId = extractProviderTarget(jid);
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
          channel
            .disconnect()
            .then(() => {
              this.releaseCredentialClaim(userId, channelType);
              conn.channels.delete(channelType);
            })
            .catch((err) => {
              logger.warn(
                { userId, channelType, err },
                'Error stopping IM channel',
              );
            }),
        );
      }
    }

    await Promise.allSettled(promises);
    for (const [userId, conn] of this.connections.entries()) {
      if (conn.channels.size === 0) this.connections.delete(userId);
    }
    const failedChannels = Array.from(this.connections.values()).reduce(
      (count, conn) => count + conn.channels.size,
      0,
    );
    if (failedChannels > 0) {
      logger.warn(
        { failedChannels },
        'Some IM channels failed to disconnect and remain tracked for retry',
      );
    } else {
      logger.info('All IM connections disconnected');
    }
  }
}

export const imManager = new IMConnectionManager();
