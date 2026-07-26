/**
 * Unified IM Channel Interface
 *
 * Defines a standard interface for all IM integrations (Feishu, Telegram, etc.)
 * and provides adapter factories that wrap existing connection implementations.
 */
import {
  createFeishuConnection,
  parseFeishuRouteTarget,
  type FeishuConnection,
  type FeishuConnectionConfig,
} from './feishu.js';
import type { FeishuConversationPlan } from './feishu-conversation-policy.js';
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
  type WeChatConnectionState,
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
  StreamingCardController,
  reconcileInterruptedStreamingCard,
  type InterruptedStreamingCardInput,
  type StreamingCardLifecycle,
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
  onNativeContextDetected?: (
    chatJid: string,
    contextType: 'thread',
  ) => boolean | void | Promise<boolean | void>;
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
    messageMeta?: ChannelMessageMeta,
  ) => {
    effectiveJid: string;
    agentId: string | null;
    sourceJid?: string;
  } | null;
  /** 当 IM 消息被路由到 conversation agent 后调用，触发 agent 处理 */
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
  /** Bot 被添加到群聊时调用 */
  onBotAddedToGroup?: (chatJid: string, chatName: string) => void;
  /** Bot 被移出群聊或群被解散时调用 */
  onBotRemovedFromGroup?: (chatJid: string) => void;
  /** 群聊消息过滤：bot 未被 @mention 时调用，返回 true 则处理，false 则丢弃 */
  shouldProcessGroupMessage?: (chatJid: string, senderImId?: string) => boolean;
  /** Feishu-only durable activation/session plan for the current message. */
  resolveFeishuConversationPlan?: (
    chatJid: string,
    messageMeta: ChannelMessageMeta,
  ) => FeishuConversationPlan;
  /** owner_mentioned 模式下检查发送者是否为 owner */
  isGroupOwnerMessage?: (chatJid: string, senderImId?: string) => boolean;
  /** 发言者白名单：返回 false 则丢弃（命令处理后、mention 门控前调用） */
  isSenderAllowedInGroup?: (chatJid: string, senderImId?: string) => boolean;
  /** Resolve registered group for a jid */
  resolveRegisteredGroup?: (
    jid: string,
  ) => { activation_mode?: string } | undefined;
  /** 飞书流式卡片按钮中断回调 */
  onCardInterrupt?: (
    chatJid: string,
    operatorImId: string,
  ) => FollowUpActionResult;
  /** P2P（私聊）消息到达时调用，用于自动检测 owner open_id（仅飞书） */
  onP2pSender?: (senderOpenId: string) => void;
  /** Canonicalize an inbound provider JID before persistence/callbacks. */
  normalizeIncomingJid?: (jid: string) => string;
  /** Persist the provider event but postpone policy/routing execution. */
  shouldDeferInbound?: () => boolean;
  /** WeChat iLink authorization/transport lifecycle. */
  onWeChatConnectionStateChange?: (state: WeChatConnectionState) => void;
}

export interface IMChannel {
  readonly channelType: string;
  connect(opts: IMChannelConnectOpts): Promise<boolean>;
  disconnect(): Promise<void>;
  /** Provider-level authorization revoke (supported by QR/session channels). */
  logout?(): Promise<void>;
  sendMessage(
    chatId: string,
    text: string,
    localImagePaths?: string[],
    options?: ChannelMessageDeliveryOptions,
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
  setTyping(chatId: string, isTyping: boolean, leaseId?: string): Promise<void>;
  /** Clear the ack reaction owned by one exact inbound input. */
  clearAckReaction?(chatId: string, inputMessageId: string): Promise<void>;
  isConnected(): boolean;
  syncGroups?(): Promise<void>;
  /** Create a streaming card session for real-time card updates (Feishu or DingTalk) */
  createStreamingSession?(
    chatId: string,
    onCardCreated?: (messageId: string) => void,
    lifecycle?: StreamingCardLifecycle,
  ): Promise<StreamingSession | undefined>;
  /** Reconcile a non-terminal card through this exact connected Bot. */
  reconcileStreamingCard?(
    input: InterruptedStreamingCardInput,
  ): Promise<{ version: number; method: 'cardkit' | 'message_patch' }>;
  getChatInfo?(chatId: string): Promise<{
    avatar?: string;
    name?: string;
    user_count?: string;
    chat_type?: string;
    chat_mode?: string;
    group_message_type?: string;
  } | null>;
  /** Execute a credential-free operation through this exact Feishu Bot. */
  executeFeishuCapability?(
    context: ChannelTurnContext,
    request: FeishuCapabilityRequest,
  ): Promise<FeishuCapabilityResult>;
}

export interface ChannelMessageDeliveryOptions {
  /** `native` avoids bot/card presentation for Proactive-mode workspace Agents. */
  presentation?: 'default' | 'native';
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
        onFollowUpMessage: opts.onFollowUpMessage,
        onFollowUpCardAction: opts.onFollowUpCardAction,
        onBotAddedToGroup: opts.onBotAddedToGroup,
        onBotRemovedFromGroup: opts.onBotRemovedFromGroup,
        shouldProcessGroupMessage: opts.shouldProcessGroupMessage,
        resolveFeishuConversationPlan: opts.resolveFeishuConversationPlan,
        isGroupOwnerMessage: opts.isGroupOwnerMessage,
        isSenderAllowedInGroup: opts.isSenderAllowedInGroup,
        onCardInterrupt: opts.onCardInterrupt,
        onP2pSender: opts.onP2pSender,
        normalizeIncomingJid: opts.normalizeIncomingJid,
        shouldDeferInbound: opts.shouldDeferInbound,
      });
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
      options?: ChannelMessageDeliveryOptions,
    ): Promise<void> {
      if (!inner) {
        logger.warn(
          { chatId },
          'Feishu channel not connected, skip sending message',
        );
        return;
      }
      await inner.sendMessage(chatId, text, localImagePaths, options);
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

    async setTyping(_chatId: string, _isTyping: boolean): Promise<void> {
      // Feishu's inbound exact-input OnIt reaction is the sole processing
      // indicator owner. The former chat-level reaction was keyed only by
      // route, so turn A could remove turn B's reaction and leak A's handle.
    },

    async clearAckReaction(
      chatId: string,
      inputMessageId: string,
    ): Promise<void> {
      if (!inner) return;
      await inner.clearAckReaction(chatId, inputMessageId);
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

    async executeFeishuCapability(context, request) {
      if (!inner) throw new Error('Feishu channel is not connected');
      return inner.executeCapability(context, request);
    },

    async createStreamingSession(
      chatId: string,
      onCardCreated?: (messageId: string) => void,
      lifecycle?: StreamingCardLifecycle,
    ): Promise<StreamingSession | undefined> {
      if (!inner) return undefined;
      const larkClient = inner.getLarkClient();
      if (!larkClient) return undefined;
      const target = parseFeishuRouteTarget(chatId);
      const opts: StreamingCardOptions = {
        client: larkClient,
        chatId: target.chatId,
        replyToMsgId: inner.getLastMessageId(chatId),
        replyInThread: target.replyInThread,
        onCardCreated,
        lifecycle,
        // 降级可观测性：卡片连续更新失败进入 error 态时记一条 warn。
        // 终态收口与静态消息兜底分别由 schedulePatch 的 best-effort patch
        // 和 index.ts 的 result 路径负责，这里只补日志。
        onFallback: () =>
          logger.warn(
            { chatId: target.chatId },
            'Feishu streaming card degraded to static fallback',
          ),
      };
      return new StreamingCardController(opts);
    },

    async reconcileStreamingCard(input) {
      if (!inner) throw new Error('Feishu channel is not connected');
      const larkClient = inner.getLarkClient();
      if (!larkClient) throw new Error('Feishu Bot client is not ready');
      return reconcileInterruptedStreamingCard(larkClient, input);
    },
  };

  return channel;
}

// ─── Telegram Adapter ───────────────────────────────────────────

/**
 * Upper bound on how long one typing lease may stay held.
 *
 * A typing pulse stops only once its last lease is released, so any path that
 * loses a lease — a runner crash, an exception between acquiring it and the
 * turn terminal — pins the indicator, and with it the provider polling
 * interval, for the process lifetime. Nothing else bounds that.
 *
 * Deliberately far longer than any healthy turn: this must never cut a slow
 * run short, only reclaim a lease whose owner is gone.
 */
const TYPING_LEASE_MAX_MS = 60 * 60 * 1000;

class TypingLeaseExpiry {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly onExpire: (chatId: string, leaseId: string) => void,
  ) {}

  private key(chatId: string, leaseId: string): string {
    return `${chatId}\u0000${leaseId}`;
  }

  arm(chatId: string, leaseId: string): void {
    const key = this.key(chatId, leaseId);
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      this.onExpire(chatId, leaseId);
    }, TYPING_LEASE_MAX_MS);
    timer.unref?.();
    this.timers.set(key, timer);
  }

  disarm(chatId: string, leaseId: string): void {
    const key = this.key(chatId, leaseId);
    const timer = this.timers.get(key);
    if (!timer) return;
    clearTimeout(timer);
    this.timers.delete(key);
  }

  disarmChat(chatId: string): void {
    const prefix = `${chatId}\u0000`;
    for (const [key, timer] of [...this.timers]) {
      if (!key.startsWith(prefix)) continue;
      clearTimeout(timer);
      this.timers.delete(key);
    }
  }

  disarmAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

export function createTelegramChannel(
  config: TelegramConnectionConfig,
): IMChannel {
  let inner: TelegramConnection | null = null;
  // A chat may have overlapping warm inputs. Each input owns a lease; the
  // provider pulse stops only after the final lease is released.
  const typingLeases = new Map<string, Set<string>>();
  const typingTimers = new Map<string, NodeJS.Timeout>();
  const typingExpiry = new TypingLeaseExpiry((chatId, leaseId) => {
    const leases = typingLeases.get(chatId);
    if (!leases?.delete(leaseId)) return;
    logger.warn(
      { chatId, leaseId },
      'Telegram typing lease expired; releasing abandoned indicator',
    );
    if (leases.size === 0) clearTyping(chatId);
  });

  function clearTyping(chatId: string): void {
    const timer = typingTimers.get(chatId);
    if (timer) clearInterval(timer);
    typingTimers.delete(chatId);
    typingLeases.delete(chatId);
    typingExpiry.disarmChat(chatId);
  }

  function clearAllTyping(): void {
    for (const chatId of typingTimers.keys()) clearTyping(chatId);
    typingExpiry.disarmAll();
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
          onNativeContextDetected: opts.onNativeContextDetected,
          onCommand: opts.onCommand,
          ignoreMessagesBefore: opts.ignoreMessagesBefore,
          resolveGroupFolder: opts.resolveGroupFolder,
          resolveEffectiveChatJid: opts.resolveEffectiveChatJid,
          onAgentMessage: opts.onAgentMessage,
          onBotAddedToGroup: opts.onBotAddedToGroup,
          onBotRemovedFromGroup: opts.onBotRemovedFromGroup,
          normalizeIncomingJid: opts.normalizeIncomingJid,
        });
        return inner.isConnected();
      } catch (err) {
        logger.error({ err }, 'Telegram channel connect failed');
        return false;
      }
    },

    async disconnect(): Promise<void> {
      clearAllTyping();
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

    async setTyping(
      chatId: string,
      isTyping: boolean,
      leaseId = '__legacy__',
    ): Promise<void> {
      if (!inner) return;
      let leases = typingLeases.get(chatId);
      if (!leases) {
        leases = new Set<string>();
        typingLeases.set(chatId, leases);
      }
      if (!isTyping) {
        leases.delete(leaseId);
        typingExpiry.disarm(chatId, leaseId);
        if (leases.size === 0) clearTyping(chatId);
        return;
      }
      if (leases.has(leaseId)) return;
      leases.add(leaseId);
      typingExpiry.arm(chatId, leaseId);
      if (typingTimers.has(chatId)) return;

      const sendAction = async (): Promise<void> => {
        if (!inner) return;
        await inner.sendChatAction(chatId, 'typing');
      };

      // Send immediately, then repeat every 4s to keep indicator alive
      void sendAction();
      typingTimers.set(
        chatId,
        setInterval(() => {
          void sendAction();
        }, 4000),
      );
    },

    async clearAckReaction(chatId, inputMessageId) {
      await inner?.clearAckReaction(chatId, inputMessageId);
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
          normalizeIncomingJid: opts.normalizeIncomingJid,
        });
        return inner.isConnected();
      } catch (err) {
        logger.error({ err }, 'QQ channel connect failed');
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
        logger.warn({ chatId }, 'QQ channel not connected, skip sending image');
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
        logger.warn({ chatId }, 'QQ channel not connected, skip sending file');
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

export function createWeChatChannel(
  config: WeChatConnectionConfig,
  onUpdatesBuf?: (cursor: string) => void | Promise<void>,
): IMChannel {
  let inner: WeChatConnection | null = null;
  const typingLeases = new Map<string, Set<string>>();
  const typingExpiry = new TypingLeaseExpiry((chatId, leaseId) => {
    const leases = typingLeases.get(chatId);
    if (!leases?.delete(leaseId)) return;
    logger.warn(
      { chatId, leaseId },
      'WeChat typing lease expired; releasing abandoned indicator',
    );
    if (leases.size > 0) return;
    typingLeases.delete(chatId);
    void inner?.sendTyping(chatId, false).catch(() => undefined);
  });

  const channel: IMChannel = {
    channelType: 'wechat',

    async connect(opts: IMChannelConnectOpts): Promise<boolean> {
      inner ??= createWeChatConnection(config);
      try {
        await inner.connect({
          onReady: opts.onReady,
          onNewChat: opts.onNewChat,
          onCommand: opts.onCommand,
          ignoreMessagesBefore: opts.ignoreMessagesBefore,
          resolveGroupFolder: opts.resolveGroupFolder,
          resolveEffectiveChatJid: opts.resolveEffectiveChatJid,
          onAgentMessage: opts.onAgentMessage,
          normalizeIncomingJid: opts.normalizeIncomingJid,
          isChatAuthorized: opts.isChatAuthorized,
          onPairAttempt: opts.onPairAttempt,
          onConnectionStateChange: opts.onWeChatConnectionStateChange,
          onUpdatesBuf,
        });
        // A healthy getUpdates response may take one long-poll interval. The
        // manager must retain the running connector while transport health is
        // reported asynchronously through onConnectionStateChange.
        return inner.isRunning();
      } catch (err) {
        logger.error({ err }, 'WeChat channel connect failed');
        return false;
      }
    },

    async disconnect(): Promise<void> {
      typingLeases.clear();
      typingExpiry.disarmAll();
      if (inner) {
        const cursor = inner.getUpdatesBuf();
        await inner.disconnect();
        inner = null;
        await onUpdatesBuf?.(cursor);
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

    async setTyping(
      chatId: string,
      isTyping: boolean,
      leaseId = '__legacy__',
    ): Promise<void> {
      if (!inner) return;
      let leases = typingLeases.get(chatId);
      if (!leases) {
        leases = new Set<string>();
        typingLeases.set(chatId, leases);
      }
      if (isTyping) {
        const wasIdle = leases.size === 0;
        leases.add(leaseId);
        typingExpiry.arm(chatId, leaseId);
        if (wasIdle) await inner.sendTyping(chatId, true);
        return;
      }
      leases.delete(leaseId);
      typingExpiry.disarm(chatId, leaseId);
      if (leases.size > 0) return;
      typingLeases.delete(chatId);
      typingExpiry.disarmChat(chatId);
      await inner.sendTyping(chatId, false);
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
          normalizeIncomingJid: opts.normalizeIncomingJid,
        });
        return inner.isConnected();
      } catch (err) {
        logger.error({ err }, 'DingTalk channel connect failed');
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

    async clearAckReaction(
      chatId: string,
      inputMessageId: string,
    ): Promise<void> {
      if (!inner) return;
      await inner.clearAckReaction(chatId, inputMessageId);
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
  const typingIntervals = new Map<string, ReturnType<typeof setInterval>>();
  const typingLeases = new Map<string, Set<string>>();
  const typingExpiry = new TypingLeaseExpiry((chatId, leaseId) => {
    const leases = typingLeases.get(chatId);
    if (!leases?.delete(leaseId)) return;
    logger.warn(
      { chatId, leaseId },
      'Discord typing lease expired; releasing abandoned indicator',
    );
    if (leases.size > 0) return;
    typingLeases.delete(chatId);
    const interval = typingIntervals.get(chatId);
    if (interval) {
      clearInterval(interval);
      typingIntervals.delete(chatId);
    }
  });

  const channel: IMChannel & DiscordChannelExtensions = {
    channelType: 'discord',

    async connect(opts: IMChannelConnectOpts): Promise<boolean> {
      inner = createDiscordConnection(config);
      try {
        const ok = await inner.connect({
          onReady: opts.onReady,
          onNewChat: opts.onNewChat,
          isChatAuthorized: opts.isChatAuthorized,
          onPairAttempt: opts.onPairAttempt,
          ignoreMessagesBefore: opts.ignoreMessagesBefore,
          onCommand: opts.onCommand,
          resolveGroupFolder: opts.resolveGroupFolder,
          resolveEffectiveChatJid: opts.resolveEffectiveChatJid,
          onAgentMessage: opts.onAgentMessage,
          onBotAddedToGroup: opts.onBotAddedToGroup,
          onBotRemovedFromGroup: opts.onBotRemovedFromGroup,
          shouldProcessGroupMessage: opts.shouldProcessGroupMessage,
          isGroupOwnerMessage: opts.isGroupOwnerMessage,
          normalizeIncomingJid: opts.normalizeIncomingJid,
        });
        return ok;
      } catch (err) {
        logger.warn({ err }, 'Discord channel connect failed');
        return false;
      }
    },

    async disconnect(): Promise<void> {
      // Clear all typing intervals
      for (const [, interval] of typingIntervals) clearInterval(interval);
      typingIntervals.clear();
      typingLeases.clear();
      typingExpiry.disarmAll();
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

    async setTyping(chatId, isTyping, leaseId = '__legacy__') {
      if (!inner) return;
      if (isTyping) {
        let leases = typingLeases.get(chatId);
        if (!leases) {
          leases = new Set<string>();
          typingLeases.set(chatId, leases);
        }
        if (leases.has(leaseId)) return;
        leases.add(leaseId);
        typingExpiry.arm(chatId, leaseId);
        // Discord typing indicator lasts 10s, repeat every 9s
        if (!typingIntervals.has(chatId)) {
          await inner.setTyping(chatId, true);
          const interval = setInterval(async () => {
            try {
              if (inner) await inner.setTyping(chatId, true);
            } catch {}
          }, 9000);
          typingIntervals.set(chatId, interval);
        }
      } else {
        const leases = typingLeases.get(chatId);
        leases?.delete(leaseId);
        typingExpiry.disarm(chatId, leaseId);
        if (leases && leases.size > 0) return;
        typingLeases.delete(chatId);
        typingExpiry.disarmChat(chatId);
        const interval = typingIntervals.get(chatId);
        if (interval) {
          clearInterval(interval);
          typingIntervals.delete(chatId);
        }
      }
    },

    async clearAckReaction(chatId, inputMessageId) {
      await inner?.clearAckReaction(chatId, inputMessageId);
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
  const typingLeases = new Map<string, Set<string>>();
  const typingExpiry = new TypingLeaseExpiry((chatId, leaseId) => {
    const leases = typingLeases.get(chatId);
    if (!leases?.delete(leaseId)) return;
    logger.warn(
      { chatId, leaseId },
      'WhatsApp typing lease expired; releasing abandoned indicator',
    );
    if (leases.size > 0) return;
    typingLeases.delete(chatId);
    void inner?.sendTyping(chatId, false).catch(() => undefined);
  });

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
          isChatAuthorized: opts.isChatAuthorized,
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
          isSenderAllowedInGroup: opts.isSenderAllowedInGroup,
          onConnectionUpdate,
          normalizeIncomingJid: opts.normalizeIncomingJid,
        });
        // Baileys connect 是 async fire-and-forget：socket 建好后立刻返回，
        // 真实的 connected 状态要等 connection.update -> 'open' 才到。
        // 这里我们返回 true 表示 socket 启动成功，连接状态由 onConnectionUpdate 推送。
        return true;
      } catch (err) {
        logger.warn({ err }, 'WhatsApp channel connect failed');
        return false;
      }
    },

    async disconnect(): Promise<void> {
      typingLeases.clear();
      typingExpiry.disarmAll();
      if (inner) {
        await inner.disconnect();
        inner = null;
      }
    },

    async logout(): Promise<void> {
      typingLeases.clear();
      typingExpiry.disarmAll();
      if (inner) {
        await inner.logout();
        inner = null;
      }
    },

    async sendMessage(
      chatId: string,
      text: string,
      localImagePaths?: string[],
    ): Promise<void> {
      if (!inner) {
        throw new Error('WhatsApp channel not connected');
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
        throw new Error('WhatsApp channel not connected');
      }
      await inner.sendImage(chatId, imageBuffer, mimeType, caption, fileName);
    },

    async sendFile(
      chatId: string,
      filePath: string,
      fileName: string,
    ): Promise<void> {
      if (!inner) {
        throw new Error('WhatsApp channel not connected');
      }
      await inner.sendFile(chatId, filePath, fileName);
    },

    async setTyping(
      chatId: string,
      isTyping: boolean,
      leaseId = '__legacy__',
    ): Promise<void> {
      if (!inner) return;
      let leases = typingLeases.get(chatId);
      if (!leases) {
        leases = new Set<string>();
        typingLeases.set(chatId, leases);
      }
      if (isTyping) {
        const wasIdle = leases.size === 0;
        leases.add(leaseId);
        typingExpiry.arm(chatId, leaseId);
        if (wasIdle) await inner.sendTyping(chatId, true);
        return;
      }
      leases.delete(leaseId);
      typingExpiry.disarm(chatId, leaseId);
      if (leases.size > 0) return;
      typingLeases.delete(chatId);
      typingExpiry.disarmChat(chatId);
      await inner.sendTyping(chatId, false);
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
