import { randomUUID } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import * as lark from '@larksuiteoapi/node-sdk';
import { fenceFeishuWebSocketLifecycle } from './feishu-ws-lifecycle.js';
import {
  cancelAwaitingForwardBundleRoot,
  findForwardBundleCommentTail,
  findForwardBundleCoveringComment,
  getForwardBundleRootMaterial,
  getMessage,
  getRegisteredGroup,
  releaseAwaitingForwardBundleRoot,
  sequenceInboundTimestampAfterChatTail,
  storeChatMetadata,
  storeMessageDirect,
  updateChatName,
  updateRegisteredGroupAvatar,
} from './db.js';
import { logger } from './logger.js';
import {
  saveDownloadedFile,
  sanitizeImFilename,
  MAX_FILE_SIZE,
  FileTooLargeError,
} from './im-downloader.js';
import { notifyNewImMessage } from './message-notifier.js';
import { detectImageMimeType } from './image-detector.js';
import { resolveJidByMessageId } from './feishu-streaming-card.js';
import { buildPostMdFallback } from './feishu-message-format.js';
export {
  buildPostMdFallback,
  FEISHU_POST_MD_NODE_MAX_BYTES,
  splitFeishuPostMarkdown,
} from './feishu-message-format.js';
import {
  FEISHU_POST_MAX_BYTES,
  FEISHU_TEXT_MAX_BYTES,
  prepareFeishuPostTextPages,
  prepareFeishuPlainTextPages,
} from './feishu-message-capacity.js';
import {
  buildAgentReplyCard,
  buildFollowUpActionResultCard,
} from './feishu-cards/builder.js';
import {
  evaluateMentionGate,
  isBotMentioned,
  stripLeadingBotMention,
  type MentionGateMention,
} from './feishu-mention-gate.js';
import {
  resolveAdmittedChannelRoute,
  ChannelRouteRejectedError,
} from './channel-admission.js';
import {
  extractProviderTarget,
  parseChannelAddress,
  scopeChannelJid,
} from './channel-address.js';
import { neutralizeFeishuMentions } from './feishu-errors.js';
import {
  classifyFeishuCardError,
  feishuMessageUuid,
  withFeishuRateLimitRetry,
} from './feishu-card-delivery.js';
import {
  feishuChatTypeFromMode,
  feishuInboundRetryDelayMs,
  FEISHU_INBOUND_MAX_FAILURES,
  normalizeFeishuMentions,
  normalizeListApiMessage,
  readFeishuIntakeState,
  withFeishuIntakeState,
  type FeishuIntakeState,
  type FeishuMentionLike,
  type IncomingMessagePayload,
} from './feishu-intake-message.js';
import type { FeishuConversationPlan } from './feishu-conversation-policy.js';
import {
  isRuntimeControlLike,
  parseRuntimeControl,
} from './follow-up-policy.js';
import {
  definitiveFeishuHttpRejection,
  executeFeishuCapability,
  withFeishuPreAcceptanceRetry,
  type FeishuCapabilityRequest,
  type FeishuCapabilityResult,
} from './feishu-capability.js';
import { DefinitiveChannelDeliveryError } from './channel-outbox-delivery.js';
import {
  PartialChannelDeliveryError,
  PhysicalDeliveryTracker,
} from './im-delivery-progress.js';
import { preAcceptImDeliveryError } from './im-send-retry-policy.js';
import { enrichFeishuInboundContent } from './feishu-rich-content.js';
import {
  FeishuForwardBundleResolver,
  type FeishuForwardCandidate,
} from './feishu-forward-bundle.js';
import {
  advanceChannelCursor,
  claimChannelInboxById,
  claimNextChannelInbox,
  completeChannelInbox,
  deleteChannelCursor,
  failChannelInbox,
  getChannelCursor,
  getChannelInboxItem,
  ignoreDeferredChannelInbox,
  ignoreChannelInbox,
  listChannelCursors,
  recordChannelInbox,
  renewChannelInboxClaim,
  transitionChannelInbox,
  updateClaimedChannelInbox,
  type ChannelCursor,
  type ClaimedChannelInboxItem,
} from './channel-reliability-store.js';
import {
  ExactAsyncIndicatorRegistry,
  processingIndicatorKey,
} from './processing-indicator.js';
import type {
  ChannelContentLink,
  ChannelReferencedMessage,
  ChannelTurnContext,
  FeishuMessageMeta,
  FollowUpAction,
  FollowUpActionResult,
  FollowUpDisposition,
  FollowUpMode,
} from './types.js';

// All live/recovery connections in this process share the same per-account,
// per-chat intake lane (per topic in topic groups). This closes the common
// HA/reconnect race where one connection handles the root while another
// handles its authored note — both always share one topic.
const feishuInboundTailByRoute = new Map<string, Promise<void>>();

// ─── FeishuConnection Interface ────────────────────────────────

export interface FeishuConnectionConfig {
  appId: string;
  appSecret: string;
  /** Optional HappyClaw account id. The scoped source JID remains authoritative. */
  channelAccountId?: string;
}

/** 飞书文件信息（用于下载到工作区） */
interface FeishuFileInfo {
  fileKey: string;
  filename: string;
}

export interface ConnectOptions {
  /** Explicit binding guard, checked before commands, reactions or downloads. */
  isChatBound?: (chatJid: string) => boolean;
  onReady: () => void;
  /** 收到消息后调用，让调用方自动注册未知的飞书聊天 */
  onNewChat?: (chatJid: string, chatName: string) => void;
  /**
   * @deprecated Durable Inbox + per-chat cursor recovery supersedes this
   * volatile cutoff. It is retained only for caller compatibility and is not
   * allowed to discard messages that may have arrived during downtime.
   */
  ignoreMessagesBefore?: number;
  /** 斜杠指令回调（如 /clear），返回回复文本或 null；mentions 仅飞书渠道传入，用于 /allow 等命令 */
  onCommand?: (
    chatJid: string,
    command: string,
    senderImId?: string,
    mentions?: FeishuMentionLike[],
    /** Routed topic/thread metadata, so /recall can pick the topic Session. */
    messageMeta?: FeishuMessageMeta,
  ) => Promise<string | null>;
  /** 根据 chatJid 解析群组 folder，用于下载文件/图片到工作区 */
  resolveGroupFolder?: (chatJid: string) => string | undefined;
  /** 将 IM chatJid 解析为绑定目标 JID（conversation agent 或工作区主对话） */
  resolveEffectiveChatJid?: (
    chatJid: string,
    messageMeta?: FeishuMessageMeta,
  ) => {
    effectiveJid: string;
    agentId: string | null;
    sourceJid?: string;
  } | null;
  /** 当 IM 消息被路由到 conversation agent 后调用 */
  onAgentMessage?: (baseChatJid: string, agentId: string) => void;
  onMessagePersisted?: import('./channel-contracts.js').OnChannelMessagePersisted;
  onFollowUpsChanged?: import('./channel-contracts.js').OnChannelFollowUpsChanged;
  /** Decide whether an inbound message starts now, queues, or steers. */
  onFollowUpMessage?: (input: {
    targetJid: string;
    sourceJid: string;
    messageId: string;
    senderImId: string;
    requestedMode?: FollowUpMode;
    coalesceBundleId?: string;
  }) => FollowUpDisposition;
  /** Execute an exact, structurally authorized Feishu `/break` command. */
  onSessionBreak?: (input: {
    sourceJid: string;
    targetJid?: string;
    senderImId: string;
    /** Native chat type of the command message, when known. */
    chatType?: 'p2p' | 'group';
  }) => Promise<string>;
  onSessionClear?: (input: {
    sourceJid: string;
    targetJid?: string;
    senderImId: string;
    /** Native chat type of the command message, when known. */
    chatType?: 'p2p' | 'group';
  }) => Promise<string>;
  onSessionFresh?: (input: {
    sourceJid: string;
    targetJid?: string;
    senderImId: string;
    notes: string;
    /** Native chat type of the command message, when known. */
    chatType?: 'p2p' | 'group';
  }) => Promise<string>;
  /** Handle buttons from legacy queued-message cards sent by older versions. */
  onFollowUpCardAction?: (input: {
    sourceJid: string;
    targetJid: string;
    messageId: string;
    action: FollowUpAction;
    expectedRunId: string;
    operatorImId: string;
  }) => Promise<FollowUpActionResult> | FollowUpActionResult;
  /** Bot 被添加到群聊时调用（自动注册群组） */
  onBotAddedToGroup?: (chatJid: string, chatName: string) => void;
  /** Bot 被移出群聊或群被解散时调用（自动解绑 IM 绑定） */
  onBotRemovedFromGroup?: (chatJid: string) => void;
  /** 群聊消息过滤：bot 未被 @mention 时调用，返回 true 则处理，false 则丢弃 */
  shouldProcessGroupMessage?: (chatJid: string, senderImId?: string) => boolean;
  /** Resolve durable Feishu topic presence and the session-routing plan. */
  resolveFeishuConversationPlan?: (
    chatJid: string,
    messageMeta: FeishuMessageMeta,
  ) => FeishuConversationPlan;
  /** owner_mentioned 模式下检查发送者是否为 owner */
  isGroupOwnerMessage?: (chatJid: string, senderImId?: string) => boolean;
  /** 发言者白名单：命令处理之后、mention 门控之前调用；返回 false 则丢弃 */
  isSenderAllowedInGroup?: (chatJid: string, senderImId?: string) => boolean;
  /** 飞书流式卡片按钮中断回调 */
  onCardInterrupt?: (
    chatJid: string,
    operatorImId: string,
  ) => FollowUpActionResult;
  /** P2P（私聊）消息到达时调用，用于自动检测 bot owner 的 open_id */
  onP2pSender?: (senderOpenId: string) => void;
  normalizeIncomingJid?: (jid: string) => string | null;
  /** Recovery gate: durable Inbox remains replayable instead of ignored. */
  shouldDeferInbound?: () => boolean;
  /**
   * Subscribe to the host's inbound gate opening (startup recovery finished,
   * shutdown pause lifted). Deferred Inbox rows resume on this event instead
   * of being re-claimed in a polling loop. Returns an unsubscribe function.
   */
  onInboundGateOpen?: (listener: () => void) => () => void;
  /** A user (or group admin) recalled a message in a bound chat. */
  onMessageRecalled?: (
    chatJid: string,
    messageId: string,
  ) => void | Promise<void>;
}

export interface FeishuChatInfo {
  avatar?: string;
  name?: string;
  user_count?: string;
  chat_type?: string;
  chat_mode?: string; // 'p2p' | 'group' | 'topic'
  group_message_type?: string; // 'chat' | 'thread'
}

export interface FeishuConnection {
  connect(opts: ConnectOptions): Promise<boolean>;
  stop(): Promise<void>;
  sendMessage(
    chatId: string,
    text: string,
    localImagePaths?: string[],
    options?: FeishuSendOptions,
  ): Promise<void>;
  sendImage(
    chatId: string,
    imageBuffer: Buffer,
    mimeType: string,
    caption?: string,
    fileName?: string,
    options?: FeishuSendOptions,
  ): Promise<void>;
  sendFile(
    chatId: string,
    filePath: string,
    fileName: string,
    options?: FeishuSendOptions,
  ): Promise<void>;
  /** Add the "OnIt" reaction for the one message that owns an active batch. */
  beginAckReaction(chatId: string, inputMessageId: string): Promise<void>;
  /** Clear the "OnIt" ack reaction owned by one exact inbound input. */
  clearAckReaction(chatId: string, inputMessageId: string): Promise<void>;
  isConnected(): boolean;
  syncGroups(): Promise<void>;
  getChatInfo(chatId: string): Promise<FeishuChatInfo | null>;
  executeCapability(
    context: ChannelTurnContext,
    request: FeishuCapabilityRequest,
  ): Promise<FeishuCapabilityResult>;
  /** Get the underlying Lark SDK client (for streaming cards) */
  getLarkClient(): lark.Client | null;
  /**
   * Reply anchor for a route. An explicit root always wins; in a private chat
   * the current turn's input message is used when it is a Feishu message of
   * this chat. Without an input id the legacy latest-inbound guess applies.
   */
  getLastMessageId(chatId: string, inputMessageId?: string): string | undefined;
}

export interface FeishuSendOptions {
  presentation?: 'default' | 'native';
  physicalOutput?: boolean;
  /** Durable outbox row (or call-scoped) identity; derives Feishu's `uuid`. */
  deliveryId?: string;
  /** Physical chunk ordinal within `deliveryId`. */
  chunkIndex?: number;
  /** The input message of the turn this output answers (P2P reply anchor). */
  inputMessageId?: string;
}

// ─── Shared Helpers (pure functions, no instance state) ────────

// Feishu card allows at most 5 markdown tables; beyond this, skip card and use post+md directly
const CARD_TABLE_LIMIT = 5;
const FEISHU_WS_READY_STATE_OPEN = 1;
const WS_HEALTH_CHECK_INTERVAL_MS = 15_000;
const WS_RECONNECT_CHECK_THRESHOLD = 4;
const WS_RECONNECT_MIN_INTERVAL_MS = 30_000;
// Enable the lark SDK's ping/pong liveness watchdog. After the SDK sends a
// keepalive ping it waits this many seconds for a pong (or any inbound frame);
// if none arrives the socket is terminated so the normal reconnect flow runs.
// Without it, a silently half-dead connection keeps readyState === OPEN forever
// and the readyState-based health check never reconnects — the bot goes quiet
// with no error until the process is restarted. Any inbound frame clears the
// watchdog, so healthy idle connections are never terminated.
const FEISHU_WS_PING_TIMEOUT_SEC = 10;
const BACKFILL_LOOKBACK_MS = 5 * 60 * 1000;
const BACKFILL_PAGE_SIZE = 50;
// Pages are fetched newest-first back to the cursor window. The cap only
// bounds a pathological backlog; hitting it is logged and reported to the
// chat instead of silently moving the cursor past unfetched messages.
const BACKFILL_MAX_PAGES_PER_CHAT = 20;
// Feishu's chat container returns only topic roots; replies live in thread
// containers (which take no time filter, so they are cut client-side).
const BACKFILL_MAX_THREADS_PER_CHAT = 30;
const BACKFILL_MAX_PAGES_PER_THREAD = 4;
const BACKFILL_THREAD_ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const BACKFILL_THREAD_CURSOR_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
// Upper bound of Feishu read calls (list pages, chat.get) one backfill round
// may spend across all chats. App-level rate limits are shared with replies;
// chats left over are covered by the next round, their cursors untouched.
const BACKFILL_MAX_CALLS_PER_ROUND = 400;
// Terminal Inbox rows are pruned after 30 days. An item at/before the chat
// cursor that is older than this horizon can no longer be proven unseen by
// the Inbox, so backfill treats it as already handled instead of replaying a
// month-old message (production 2026-10-07).
const BACKFILL_REPLAY_HORIZON_MS = 7 * 24 * 60 * 60 * 1000;
// Backfill runs after onReady with a few chats in flight; a sequential pass
// over every chat ever seen held all Feishu inbound for its whole duration.
// Every known chat is still covered: a long-silent chat or DM can receive
// the message sent during downtime.
const BACKFILL_CONCURRENCY = 4;
const FEISHU_INBOX_LEASE_MS = 5 * 60 * 1000;
const FEISHU_INBOX_HEARTBEAT_MS = 60 * 1000;
const FEISHU_INBOX_RETRY_DELAY_MS = 5_000;
const FEISHU_FORWARD_COMPANION_GRACE_MS = 3_000;
const FEISHU_FORWARD_CONTENT_REQUEST_TIMEOUT_MS = 3_000;
const FEISHU_FORWARD_CONTENT_TOTAL_TIMEOUT_MS = 5_000;
const FEISHU_FORWARD_MATERIAL_RETRY_DELAY_MS = 2_000;
const FEISHU_FORWARD_MATERIAL_MAX_ATTEMPTS = 4;
// While the host gate is closed nothing is claimed; this only re-reads the
// gate predicate as a fallback to the gate-open event.
const FEISHU_INBOX_GATE_POLL_MS = 1_000;
const FEISHU_INBOX_ORDERING_DELAY_MS = 250;
// A failing message holds its chat/topic lane only for its first retries
// (5s, 10s). A message that keeps failing must not stall the whole chat for
// the full 5s → 10min backoff; later messages then run ahead of it.
const FEISHU_INBOX_ORDERING_HOLD_MAX_FAILURES = 2;
const FEISHU_INBOX_ORDERING_HOLD_MAX_MS = 60_000;
// An overdue hold (its retry was claimed elsewhere or never ran) is dropped.
const FEISHU_INBOX_ORDERING_STALE_MS = 30_000;
const FEISHU_INBOX_RECOVERY_LIMIT = 500;
const FEISHU_RESOURCE_REQUEST_TIMEOUT_MS = 15_000;
const FEISHU_RESOURCE_STREAM_TIMEOUT_MS = 30_000;
// `lark.Client` requests (token fetch + all OpenAPI calls, including
// send_card/add_reaction/api_request mutations) run on the SDK's shared
// `defaultHttpInstance`, an axios instance created with no timeout. A stalled
// TCP/TLS handshake to Feishu therefore hangs the underlying promise forever;
// the only thing that ever fires is the runner's own 120s IPC poll timeout,
// which surfaces as an opaque "Timeout waiting for IPC result" with no
// indication that the stall was network-level. Bounding it here lets
// `deliverChannelOutboxItem` observe a real error and fence the mutation as
// `uncertain`/`failed` well inside that 120s budget instead of leaving both
// the promise and the outbox claim hanging past it.
const FEISHU_CLIENT_HTTP_TIMEOUT_MS = 60_000;
let feishuClientHttpTimeoutApplied = false;
const FEISHU_ACK_REACTION_TIMEOUT_MS = 10_000;
const FEISHU_CURSOR_SCOPE = 'chat_messages';
const FEISHU_THREAD_CURSOR_SCOPE = 'thread_messages';
const FEISHU_INBOUND_MESSAGE_CHAT_CACHE = 5_000;
// Recalls seen by this connection, so a message recalled while its intake is
// in flight (downloads, lookups) is not handed off afterwards.
const FEISHU_RECALLED_MESSAGE_CACHE = 2_000;
// 启动期 bot info 拉取的最大重试次数（指数退避 1s/2s/4s）
const BOT_INFO_FETCH_MAX_ATTEMPTS = 4;
// botOpenId 缺失时 lazy refetch 的最小间隔，避免对 OAPI 高频骚扰
const BOT_INFO_REFETCH_MIN_INTERVAL_MS = 60_000;
// "因 botOpenId 缺失而丢消息" 的 warn 节流间隔，避免日志刷屏
const BOT_INFO_MISSING_WARN_INTERVAL_MS = 5 * 60 * 1000;

interface FeishuResourceStream extends AsyncIterable<unknown> {
  destroy?: (error?: Error) => void;
}

class FeishuTextDeliveryError extends Error {
  readonly outcome: 'rejected' | 'uncertain';

  constructor(
    message: string,
    outcome: 'rejected' | 'uncertain',
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'FeishuTextDeliveryError';
    this.outcome = outcome;
  }
}

class FeishuApiRejectedError extends Error {
  /** Feishu business code, readable by `classifyFeishuError`/Card helpers. */
  readonly code?: number;

  constructor(message: string, code?: number) {
    super(message);
    this.name = 'FeishuApiRejectedError';
    if (code !== undefined) this.code = code;
  }
}

/**
 * Convert an authoritative Feishu rejection into the durable Outbox's
 * definitive-failure signal. The Lark SDK rejects HTTP 4xx responses as
 * Axios errors before the normal response-envelope assertion can inspect
 * their code/message, so both shapes must be recognized here.
 */
function definitiveFeishuChannelDeliveryError(
  error: unknown,
): DefinitiveChannelDeliveryError | null {
  if (error instanceof DefinitiveChannelDeliveryError) return error;
  const rejection =
    error instanceof FeishuApiRejectedError
      ? error
      : definitiveFeishuHttpRejection(error);
  if (!rejection) return null;

  // `cause` stays the raw Feishu error so the host can word its notice from
  // `classifyFeishuError(cause).reason` (DLP, recalled anchor, rate limit).
  // No `retryAt`: production has no worker that reclaims a `retry_wait`
  // Outbox row, so a refused send is terminal (rate limits are retried
  // inside the send call instead).
  return new DefinitiveChannelDeliveryError(rejection.message, {
    cause: error,
  });
}

/**
 * Format/backend fallbacks (card → post) only help when the content shape was
 * refused. A gone target, a rate limit or a DLP audit refuses every format,
 * and each extra attempt is another request against the same chat.
 */
function allowsFeishuFormatFallback(error: unknown): boolean {
  const classified = classifyFeishuCardError(error);
  if (
    classified.kind === 'target_unavailable' ||
    classified.kind === 'rate_limited'
  ) {
    return false;
  }
  return !(
    classified.kind === 'content_rejected' && classified.code === 230028
  );
}

/** Per-request options for one physical Feishu message. */
interface FeishuPhysicalSend {
  /** Feishu request-dedup key (≤ 50 chars, honoured for one hour). */
  uuid?: string;
  /** The turn's input message (P2P reply anchor). */
  inputMessageId?: string;
  /** Wall clock for this one request (never for backoff waits). */
  requestTimeoutMs?: number;
  requestLabel?: string;
}

/** Stable identity of one logical send call, expanded per physical page. */
interface FeishuSendIdentity {
  uuidBase?: Array<string | number>;
  inputMessageId?: string;
}

/**
 * Feishu `uuid` for one physical message. The seed is the outbox identity
 * (deliveryId, chunkIndex) plus the msg_type and the page/attachment slot:
 * replaying a row reproduces every uuid, while different content — a card
 * and its post fallback, two pages — never shares one (Feishu requires a
 * new uuid for new content). Shares the card transport's uuid format.
 */
function physicalUuid(
  base: Array<string | number> | undefined,
  msgType: string,
  ...slot: Array<string | number>
): string | undefined {
  return base
    ? feishuMessageUuid([...base, msgType, ...slot].map(String).join(':'))
    : undefined;
}

/** A distinct uuid for a fallback request carrying the same content. */
function variantUuid(
  uuid: string | undefined,
  variant: string,
): string | undefined {
  return uuid ? feishuMessageUuid(`${uuid}:${variant}`) : undefined;
}

/** Outbox identity of one send call; expanded per physical message. */
function sendIdentityFromOptions(
  options: FeishuSendOptions | undefined,
): FeishuSendIdentity {
  return {
    ...(options?.deliveryId
      ? { uuidBase: [options.deliveryId, options.chunkIndex ?? 0] }
      : {}),
    ...(options?.inputMessageId
      ? { inputMessageId: options.inputMessageId }
      : {}),
  };
}

/**
 * Neutralize `<at …>` in every text-bearing field (`content`, `text`) of a
 * model-emitted interactive card. The JSON is left byte-identical when it
 * contains no `<at` at all.
 */
function neutralizeCardJsonMentions(raw: string, parsed: unknown): string {
  if (!/<at\b/i.test(raw)) return raw;
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (!node || typeof node !== 'object') return node;
    return Object.fromEntries(
      Object.entries(node as Record<string, unknown>).map(([key, value]) => [
        key,
        typeof value === 'string' && (key === 'content' || key === 'text')
          ? neutralizeFeishuMentions(value, 'card')
          : visit(value),
      ]),
    );
  };
  return JSON.stringify(visit(parsed));
}

/** A local failure before any Feishu request was made: nothing was sent. */
function localFeishuPreflightError(
  operation: string,
  error?: unknown,
): DefinitiveChannelDeliveryError {
  const detail =
    error === undefined
      ? ''
      : `: ${error instanceof Error ? error.message : String(error)}`;
  return new DefinitiveChannelDeliveryError(
    `${operation} failed before any Feishu request was sent${detail}`,
    error === undefined ? {} : { cause: error },
  );
}

type FeishuSlashCommandCheckpoint =
  | {
      version: 1;
      kind: 'feishu_slash_command';
      state: 'executing';
      command: string;
      replyTarget: string;
    }
  | {
      version: 1;
      kind: 'feishu_slash_command';
      state: 'pending_reply' | 'sending_reply' | 'reply_acknowledged';
      command: string;
      replyTarget: string;
      replyText: string;
    };

function parseFeishuSlashCommandCheckpoint(
  value: unknown,
): FeishuSlashCommandCheckpoint | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const checkpoint = value as Record<string, unknown>;
  if (
    checkpoint.version !== 1 ||
    checkpoint.kind !== 'feishu_slash_command' ||
    typeof checkpoint.command !== 'string' ||
    !checkpoint.command ||
    typeof checkpoint.replyTarget !== 'string' ||
    !checkpoint.replyTarget ||
    (checkpoint.state !== 'executing' &&
      checkpoint.state !== 'pending_reply' &&
      checkpoint.state !== 'sending_reply' &&
      checkpoint.state !== 'reply_acknowledged')
  ) {
    return undefined;
  }
  if (checkpoint.state === 'executing') {
    return checkpoint as FeishuSlashCommandCheckpoint;
  }
  return typeof checkpoint.replyText === 'string'
    ? (checkpoint as FeishuSlashCommandCheckpoint)
    : undefined;
}

function withFeishuHardTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(`${label} timed out after ${timeoutMs}ms`);
      try {
        onTimeout?.();
      } finally {
        reject(error);
      }
    }, timeoutMs);
    timer.unref?.();
    operation.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Read one SDK resource stream under a hard wall-clock and byte budget. */
export async function readFeishuResourceBuffer(
  stream: FeishuResourceStream,
  options: {
    timeoutMs?: number;
    maxBytes?: number;
    resourceLabel?: string;
  } = {},
): Promise<Buffer> {
  const label = options.resourceLabel ?? 'Feishu resource stream';
  const reading = (async () => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk as Uint8Array);
      totalSize += buffer.length;
      if (options.maxBytes !== undefined && totalSize > options.maxBytes) {
        throw new FileTooLargeError(label, totalSize);
      }
      chunks.push(buffer);
    }
    return Buffer.concat(chunks);
  })();
  return withFeishuHardTimeout(
    reading,
    options.timeoutMs ?? FEISHU_RESOURCE_STREAM_TIMEOUT_MS,
    label,
    () => stream.destroy?.(new Error(`${label} timed out`)),
  );
}

interface FeishuBotPublicInfo {
  openId?: string;
  name?: string;
  avatarUrl?: string;
}

interface CachedFeishuChatInfo {
  name?: string;
  chatType?: string;
  chatMode?: string;
  groupMessageType?: string;
}

/**
 * One OnIt reaction. `pending` is set when the add request outlived its
 * timeout: the reaction may still land later and must then be removed.
 */
interface AckReactionHandle {
  messageId: string;
  reactionId?: string;
  pending?: Promise<string | null>;
  client: lark.Client;
}

interface InboundLaneEntry {
  position: number;
  messageId: string;
  retryAtMs: number;
}

/** Processing result: `deferred` rows stay queued and are not "recovered". */
type InboundOutcome = 'done' | 'deferred';

class FeishuAckReactionTimeoutError extends Error {
  constructor(operation: 'add' | 'remove') {
    super(`Feishu ${operation} reaction timed out`);
    this.name = 'FeishuAckReactionTimeoutError';
  }
}

/** Thrown when stop()/pause retires the connection mid-intake. */
class FeishuIntakeRetiredError extends Error {
  constructor() {
    super('Feishu connection was retired while the message was being admitted');
    this.name = 'FeishuIntakeRetiredError';
  }
}

export const FEISHU_CHANNEL_CAPABILITIES = [
  'get_channel_context',
  'send_message',
  'send_image',
  'send_file',
  'feishu_get_chat',
  'feishu_list_members',
  'feishu_get_user',
  'feishu_get_history',
  'feishu_send_card',
  'feishu_add_reaction',
  'feishu_remove_reaction',
  'feishu_edit_message',
  'feishu_recall_message',
  'feishu_api_request',
] as const;

export function buildFeishuChannelTurnContext(input: {
  appId: string;
  configuredChannelAccountId?: string;
  bot?: FeishuBotPublicInfo;
  chat: {
    id: string;
    type?: string;
    name?: string;
    mode?: string;
    groupMessageType?: string;
  };
  message: {
    id: string;
    rootId?: string;
    parentId?: string;
    threadId?: string;
    type?: string;
    contentLink?: ChannelContentLink;
    referencedMessages?: ChannelReferencedMessage[];
  };
  sender?: {
    openId?: string;
    userId?: string;
    unionId?: string;
    name?: string;
    tenantKey?: string;
    type?: string;
  };
  mentions?: FeishuMentionLike[];
  sourceJid: string;
  targetJid?: string;
  sessionAgentId?: string | null;
}): ChannelTurnContext {
  const parsedSource = parseChannelAddress(input.sourceJid);
  const chatType =
    input.chat.type === 'p2p' || input.chat.type === 'group'
      ? input.chat.type
      : undefined;
  const isTopicStyle =
    input.chat.mode === 'topic' || input.chat.groupMessageType === 'thread';
  return {
    schemaVersion: 1,
    provider: 'feishu',
    channelAccountId:
      parsedSource?.channelAccountId ??
      input.configuredChannelAccountId ??
      null,
    sourceJid: input.sourceJid,
    ...(input.targetJid ? { targetJid: input.targetJid } : {}),
    ...(input.sessionAgentId !== undefined
      ? { sessionAgentId: input.sessionAgentId }
      : {}),
    bot: {
      ...(input.appId ? { appId: input.appId } : {}),
      ...(input.bot?.openId ? { openId: input.bot.openId } : {}),
      ...(input.bot?.name ? { name: input.bot.name } : {}),
      ...(input.bot?.avatarUrl ? { avatarUrl: input.bot.avatarUrl } : {}),
    },
    chat: {
      id: input.chat.id,
      ...(chatType ? { type: chatType } : {}),
      ...(input.chat.name ? { name: input.chat.name } : {}),
      ...(input.chat.mode ? { mode: input.chat.mode } : {}),
      ...(input.chat.groupMessageType
        ? { groupMessageType: input.chat.groupMessageType }
        : {}),
      ...(input.chat.mode || input.chat.groupMessageType
        ? { isTopicStyle }
        : {}),
    },
    message: {
      id: input.message.id,
      ...(input.message.rootId ? { rootId: input.message.rootId } : {}),
      ...(input.message.parentId ? { parentId: input.message.parentId } : {}),
      ...(input.message.threadId ? { threadId: input.message.threadId } : {}),
      ...(input.message.type ? { type: input.message.type } : {}),
      ...(input.message.contentLink
        ? { contentLink: input.message.contentLink }
        : {}),
      ...(input.message.referencedMessages?.length
        ? { referencedMessages: input.message.referencedMessages }
        : {}),
    },
    sender: input.sender
      ? {
          ...(input.sender.openId ? { openId: input.sender.openId } : {}),
          ...(input.sender.userId ? { userId: input.sender.userId } : {}),
          ...(input.sender.unionId ? { unionId: input.sender.unionId } : {}),
          ...(input.sender.name ? { name: input.sender.name } : {}),
          ...(input.sender.tenantKey
            ? { tenantKey: input.sender.tenantKey }
            : {}),
          ...(input.sender.type ? { type: input.sender.type } : {}),
        }
      : undefined,
    mentions: input.mentions?.map((mention) => ({
      ...(mention.key ? { key: mention.key } : {}),
      ...(mention.name ? { name: mention.name } : {}),
      ...(mention.id?.open_id ? { openId: mention.id.open_id } : {}),
      ...(mention.id?.user_id ? { userId: mention.id.user_id } : {}),
      ...(mention.id?.union_id ? { unionId: mention.id.union_id } : {}),
    })),
    capabilities: [...FEISHU_CHANNEL_CAPABILITIES],
  };
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

/** Real Feishu message ids are `om_…`; synthetic host ids are not. */
function isFeishuMessageId(value: string): boolean {
  return /^om_[A-Za-z0-9_-]+$/.test(value);
}

function feishuEpochMsOf(item: unknown): number {
  return item && typeof item === 'object'
    ? toEpochMs((item as { create_time?: string | number }).create_time)
    : 0;
}

export interface FeishuRouteTarget {
  raw: string;
  chatId: string;
  threadId?: string;
  rootMessageId?: string;
  replyInThread: boolean;
}

export function parseFeishuRouteTarget(raw: string): FeishuRouteTarget {
  const [chatId, ...parts] = raw.split('#');
  let threadId: string | undefined;
  let rootMessageId: string | undefined;
  for (const part of parts) {
    if (part.startsWith('thread:')) {
      threadId = part.slice('thread:'.length);
    } else if (part.startsWith('root:')) {
      rootMessageId = part.slice('root:'.length);
    }
  }
  return {
    raw,
    chatId,
    threadId,
    rootMessageId,
    replyInThread: !!rootMessageId,
  };
}

export function resolveFeishuMessageAnchor(input: {
  target: FeishuRouteTarget;
  chatType?: string;
  lastMessageId?: string;
  /**
   * The turn's own input. `null` means the caller named an input that is not
   * a Feishu message of this chat (e.g. a Web or scheduled-task input): never
   * guess an anchor then. `undefined` keeps the legacy latest-inbound guess
   * for callers that do not know their input.
   */
  inputMessageId?: string | null;
}): string | undefined {
  if (input.target.rootMessageId) return input.target.rootMessageId;
  // A group's latest inbound message may belong to any concurrently active
  // topic. Never infer an output or reaction target from that mutable value.
  if (input.chatType !== 'p2p') return undefined;
  if (input.inputMessageId !== undefined) {
    return input.inputMessageId ?? undefined;
  }
  return input.lastMessageId;
}

function requireFeishuRouteTarget(raw: string): FeishuRouteTarget {
  const target = parseFeishuRouteTarget(raw);
  const fragments = raw.split('#').slice(1);
  const seen = new Set<string>();
  const valid =
    target.chatId.length > 0 &&
    target.chatId.trim() === target.chatId &&
    !/\s/.test(target.chatId) &&
    fragments.every((fragment) => {
      const separator = fragment.indexOf(':');
      if (separator <= 0 || separator === fragment.length - 1) return false;
      const kind = fragment.slice(0, separator);
      const value = fragment.slice(separator + 1);
      if ((kind !== 'thread' && kind !== 'root') || seen.has(kind)) {
        return false;
      }
      seen.add(kind);
      return value.trim() === value && !/\s/.test(value);
    }) &&
    (!target.threadId || !!target.rootMessageId);
  if (!valid) {
    throw new Error(`Invalid Feishu route target: ${raw || '<empty>'}`);
  }
  return target;
}

function assertFeishuApiSuccess(operation: string, response: unknown): void {
  if (!response || typeof response !== 'object') {
    throw new Error(`${operation} returned no acknowledgement`);
  }
  const result = response as { code?: number; msg?: string };
  // Message create/reply use the regular Feishu response envelope. Require an
  // explicit success code so malformed or partial acknowledgements can never
  // make the durable outbox believe an unsent message was delivered. Upload
  // endpoints have a separate unwrapped-payload contract below.
  if (typeof result.code !== 'number') {
    throw new Error(
      `${operation} acknowledgement is missing an explicit success code (code=${String(result.code)})`,
    );
  }
  if (result.code !== 0) {
    logger.error(
      { operation, response },
      'Feishu API acknowledgement did not contain an explicit success code',
    );
    throw new FeishuApiRejectedError(
      `${operation} failed (code=${result.code}, msg=${result.msg || 'unknown'})`,
      result.code,
    );
  }
}

const FEISHU_THREAD_REPLY_UNSUPPORTED_CODES = new Set([230071, 230072]);

function feishuApiErrorCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') {
    const match = String(error).match(/code[=:]\s*(\d+)/i);
    return match ? Number(match[1]) : undefined;
  }
  const value = error as {
    code?: number;
    message?: string;
    response?: { code?: number; data?: { code?: number } };
  };
  if (typeof value.code === 'number') return value.code;
  if (typeof value.response?.data?.code === 'number') {
    return value.response.data.code;
  }
  if (typeof value.response?.code === 'number') return value.response.code;
  const match = value.message?.match(/code[=:]\s*(\d+)/i);
  return match ? Number(match[1]) : undefined;
}

/**
 * Upload endpoints in the official Lark SDK unwrap successful responses to
 * `{ image_key }` / `{ file_key }` and therefore do not include `code: 0`.
 * Error-shaped responses can still carry `code`/`msg` (and mocked clients do
 * so in tests), so preserve those details while accepting the SDK's real
 * success contract.
 */
function requireFeishuUploadKey(
  operation: string,
  response: unknown,
  key: 'image_key' | 'file_key',
): string {
  if (!response || typeof response !== 'object') {
    throw new Error(`${operation} returned no acknowledgement`);
  }
  const result = response as {
    code?: number;
    msg?: string;
    image_key?: string;
    file_key?: string;
    data?: { image_key?: string; file_key?: string };
  };
  if (typeof result.code === 'number' && result.code !== 0) {
    throw new FeishuApiRejectedError(
      `${operation} failed (code=${result.code}, msg=${result.msg || 'unknown'})`,
      result.code,
    );
  }
  const uploadKey = result[key] ?? result.data?.[key];
  if (!uploadKey) {
    throw new Error(`${operation} returned no ${key}`);
  }
  return uploadKey;
}

/**
 * Uploads and local file reads happen before their corresponding visible
 * message mutation. A lost upload ACK can waste an upload when retried, but it
 * cannot duplicate a user-visible message. Preserve authoritative provider
 * rejections; classify every other failure at this stage as pre-acceptance.
 */
function preVisibleFeishuDeliveryError(
  operation: string,
  error: unknown,
): Error {
  const detail = error instanceof Error ? `: ${error.message}` : '';
  return (
    definitiveFeishuChannelDeliveryError(error) ??
    preAcceptImDeliveryError(
      `${operation} failed before a visible Feishu message was sent${detail}`,
      error,
    )
  );
}

export function buildFeishuRouteTarget(
  chatId: string,
  threadId?: string,
  rootMessageId?: string,
): FeishuRouteTarget {
  const parts = [chatId];
  if (threadId) parts.push(`thread:${threadId}`);
  if (rootMessageId) parts.push(`root:${rootMessageId}`);
  return parseFeishuRouteTarget(parts.join('#'));
}

/**
 * Build a route JID for a thread/root target.
 *
 * `target.raw` is assembled from the raw provider `chat_id`, so it carries no
 * account scope. Emitting it directly produced a JID that `getRegisteredGroup`
 * could not match once inbound JIDs were account-scoped, which made the whole
 * turn fail closed: no outbound route, no warm-session admission, not even the
 * tail interruption notice. Re-apply the scope from the already-normalized base
 * JID — `scopeChannelJid` preserves provider-native thread/root fragments.
 *
 * The native-topic branch keeps its own builder (`buildNativeThreadRouteJid`),
 * which appends onto the normalized JID for the same reason.
 */
function feishuRouteToJid(
  target: FeishuRouteTarget,
  accountScopedBaseJid?: string,
): string {
  const jid = `feishu:${target.raw}`;
  const accountId = accountScopedBaseJid
    ? parseChannelAddress(accountScopedBaseJid)?.channelAccountId
    : undefined;
  return accountId ? scopeChannelJid(jid, accountId) : jid;
}

/**
 * Extract message content from Feishu message.
 * Returns text content, optional image keys, and optional file infos for download.
 */
function unwrapFeishuParagraphText(text: string): string {
  const trimmed = text.trim();
  if (!/^<p>[\s\S]*<\/p>$/i.test(trimmed)) return text;
  return trimmed
    .replace(/^<p>/i, '')
    .replace(/<\/p>\s*<p>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>$/i, '');
}

function extractMessageContent(
  messageType: string,
  content: string,
): { text: string; imageKeys?: string[]; fileInfos?: FeishuFileInfo[] } {
  // merge_forward: WebSocket 推送的内容是纯字符串 "Merged and Forwarded Message"（非 JSON），
  // 必须在 JSON.parse 之前单独处理，否则 parse 失败导致消息被丢弃
  if (messageType === 'merge_forward') {
    let parsed: any;
    try {
      parsed = JSON.parse(content);
    } catch {
      return { text: '[合并转发消息]' };
    }
    const items = parsed.message_list || parsed.items || [];
    if (!Array.isArray(items) || items.length === 0) {
      return { text: '[合并转发消息]' };
    }
    const lines: string[] = ['[合并转发消息]:'];
    for (const item of items.slice(0, 20)) {
      const sender = item.sender_name || item.sender || '未知';
      const body = item.body?.content || item.content || '';
      let text = '';
      try {
        const subType = item.msg_type || item.message_type || 'text';
        const sub = extractMessageContent(subType, body);
        text = sub.text || '';
      } catch {
        text = typeof body === 'string' ? body : '';
      }
      if (text) {
        lines.push(`> ${sender}: ${text.split('\n')[0].slice(0, 200)}`);
      }
    }
    if (items.length > 20) {
      lines.push(`> ... 共 ${items.length} 条消息`);
    }
    return { text: lines.join('\n') };
  }

  try {
    const parsed = JSON.parse(content);

    if (messageType === 'text') {
      return { text: parsed.text || '' };
    }

    if (messageType === 'post') {
      // Extract text and inline images from rich post content.
      const lines: string[] = [];
      const imageKeys: string[] = [];
      // 飞书 post 消息有三种已知格式：
      // 1. 带 post + 语言包裹：{"post": {"zh_cn": {"title": "...", "content": [[...]]}}}
      // 2. 仅语言包裹：{"zh_cn": {"title": "...", "content": [[...]]}}
      // 3. 无包裹（直接 title+content）：{"title": "...", "content": [[...]]}
      const post = parsed.post || parsed;
      if (!post || typeof post !== 'object') {
        logger.warn(
          { keys: Object.keys(parsed) },
          'Empty post object in post message',
        );
        return { text: '' };
      }

      // 判断 contentData：如果 post 本身就有 content 数组，直接用；否则查找语言层
      let contentData: any;
      if (Array.isArray(post.content)) {
        // 格式 3：无包裹，post 本身就是 {title, content}
        contentData = post;
        logger.debug('Post message using flat format (no locale wrapper)');
      } else {
        // 格式 1/2：有语言层包裹
        contentData = post.zh_cn || post.en_us || Object.values(post)[0];
      }
      if (!contentData || !Array.isArray(contentData.content)) {
        logger.warn(
          { keys: Object.keys(post) },
          'Missing content array in post message',
        );
        return { text: '' };
      }

      // Include post title if present
      if (contentData.title && typeof contentData.title === 'string') {
        lines.push(contentData.title);
      }

      for (const paragraph of contentData.content) {
        // Handle both array paragraphs and flat object segments
        const segments = Array.isArray(paragraph)
          ? paragraph
          : paragraph && typeof paragraph === 'object'
            ? [paragraph]
            : null;
        if (!segments) continue;
        const parts: string[] = [];
        for (const segment of segments) {
          if (!segment || typeof segment !== 'object') continue;
          if (segment.tag === 'text' && typeof segment.text === 'string') {
            parts.push(segment.text);
          } else if (segment.tag === 'a' && typeof segment.text === 'string') {
            parts.push(segment.text);
          } else if (segment.tag === 'at') {
            const mentionName =
              typeof segment.user_name === 'string'
                ? segment.user_name
                : typeof segment.text === 'string'
                  ? segment.text
                  : typeof segment.name === 'string'
                    ? segment.name
                    : '用户';
            parts.push(`@${mentionName}`);
          } else if (
            segment.tag === 'img' &&
            typeof segment.image_key === 'string'
          ) {
            imageKeys.push(segment.image_key);
            parts.push('[图片]');
          } else if (segment.tag === 'media') {
            parts.push('[视频]');
          } else if (
            segment.tag === 'emotion' &&
            typeof segment.emoji_type === 'string'
          ) {
            parts.push(`:${segment.emoji_type}:`);
          } else if (typeof segment.text === 'string') {
            parts.push(segment.text);
          }
        }
        if (parts.length > 0) lines.push(parts.join(''));
      }

      return {
        text: lines.join('\n'),
        imageKeys: imageKeys.length > 0 ? imageKeys : undefined,
      };
    }

    if (messageType === 'image') {
      const imageKey = parsed.image_key;
      if (imageKey) {
        return { text: '', imageKeys: [imageKey] };
      }
    }

    if (messageType === 'file') {
      const fileKey = parsed.file_key;
      const filename = parsed.file_name || '';
      if (fileKey) {
        // 使用清洗后的文件名构造占位符，下方 replace 也用同一份清洗结果，
        // 任何上下文（成功/失败/解析失败）都不会让原始 filename 进入 prompt。
        const safeFilename = sanitizeImFilename(filename || fileKey);
        return {
          text: `[文件: ${safeFilename}]`,
          fileInfos: [{ fileKey, filename }],
        };
      }
    }

    if (messageType === 'sticker') {
      const stickerDesc = parsed.description || parsed.sticker_id || '表情包';
      return { text: `[表情包: ${stickerDesc}]` };
    }

    if (messageType === 'audio') {
      const duration = parsed.duration
        ? `${Math.round(parsed.duration / 1000)}s`
        : '';
      return { text: `[语音消息${duration ? ': ' + duration : ''}]` };
    }

    if (messageType === 'share_chat') {
      const chatName = parsed.chat_name || parsed.chat_id || '未知群聊';
      return { text: `[分享群聊: ${chatName}]` };
    }

    if (messageType === 'share_user') {
      const userName = parsed.user_name || parsed.user_id || '未知用户';
      return { text: `[分享用户: ${userName}]` };
    }

    if (messageType === 'system') {
      const body = parsed.body || parsed.content || '';
      const systemText = typeof body === 'string' ? body : JSON.stringify(body);
      return { text: `[系统消息: ${systemText.slice(0, 200)}]` };
    }

    if (messageType === 'interactive') {
      // Extract title and text elements from interactive card messages
      const parts: string[] = [];
      if (parsed.title) {
        parts.push(parsed.title);
      }
      if (Array.isArray(parsed.elements)) {
        for (const row of parsed.elements) {
          if (!Array.isArray(row)) continue;
          for (const el of row) {
            if (!el || typeof el !== 'object') continue;
            if (el.tag === 'text' && typeof el.text === 'string') {
              parts.push(el.text);
            } else if (el.tag === 'a' && typeof el.text === 'string') {
              parts.push(`[${el.text}](${el.href || ''})`);
            } else if (el.tag === 'note' && Array.isArray(el.elements)) {
              const noteText = el.elements
                .filter(
                  (n: any) => n.tag === 'text' && typeof n.text === 'string',
                )
                .map((n: any) => n.text)
                .join('');
              if (noteText) parts.push(noteText);
            }
            // Skip buttons, hr, select_static, img — not useful as text
          }
        }
      }
      const cardText = parts.filter(Boolean).join('\n');
      return { text: cardText || '[飞书卡片消息]' };
    }

    if (messageType === 'media') {
      return { text: '[视频消息]' };
    }

    if (messageType === 'location') {
      return {
        text: `[位置: ${parsed.name || parsed.address || '未知位置'}]`,
      };
    }

    if (messageType === 'share_calendar_event') {
      return {
        text: `[日程分享: ${parsed.summary || parsed.event_id || ''}]`,
      };
    }

    if (messageType === 'video_chat') {
      return { text: `[视频会议: ${parsed.topic || ''}]` };
    }

    if (messageType === 'todo') {
      return {
        text: `[待办: ${parsed.task_id || parsed.summary || ''}]`,
      };
    }

    if (messageType === 'hongbao') {
      return { text: '[红包消息]' };
    }

    // 未知消息类型：返回类型占位符，避免静默丢弃
    return { text: `[${messageType}]` };
  } catch (err) {
    logger.warn(
      { err, messageType, content },
      'Failed to parse message content',
    );
    return { text: `[${messageType}]` };
  }
}

/**
 * Map file extension to Feishu file type.
 */
function getFileType(
  ext: string,
): 'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream' {
  const map: Record<
    string,
    'opus' | 'mp4' | 'pdf' | 'doc' | 'xls' | 'ppt' | 'stream'
  > = {
    '.pdf': 'pdf',
    '.doc': 'doc',
    '.docx': 'doc',
    '.xls': 'xls',
    '.xlsx': 'xls',
    '.ppt': 'ppt',
    '.pptx': 'ppt',
    '.mp4': 'mp4',
    '.opus': 'opus',
  };
  return map[ext.toLowerCase()] || 'stream';
}

/**
 * Build a Feishu interactive card (Schema 2.0) from markdown text.
 * Applies optimizeMarkdownStyle() for proper rendering in Feishu cards:
 * - Heading demotion (H1→H4, H2~H6→H5)
 * - Code block / table spacing with <br>
 * - Invalid image cleanup
 */
function buildInteractiveCard(text: string): object {
  return buildAgentReplyCard({ status: 'done', text });
}

// ─── Factory Function ──────────────────────────────────────────

/**
 * Create an independent Feishu connection instance.
 * Each instance manages its own client, WebSocket, and state maps.
 */
export function createFeishuConnection(
  config: FeishuConnectionConfig,
): FeishuConnection {
  // Per-instance state
  const reliabilityAccountId =
    config.channelAccountId?.trim() || `app:${config.appId}`;
  const inboxOwner = `feishu:${reliabilityAccountId}:${randomUUID()}`;
  const senderNameCache = new Map<string, string>();
  const lastMessageIdByChat = new Map<string, string>();
  // Inbound message → chat, so a reply anchor named by the host is only used
  // when it really is a message of the target chat. Bounded insertion order.
  const inboundChatByMessageId = new Map<string, string>();
  const recalledMessageIds = new Set<string>();
  const ackReactions = new ExactAsyncIndicatorRegistry<AckReactionHandle>();
  const inboxHeartbeatByClaim = new Map<string, NodeJS.Timeout>();
  const knownChatIds = new Set<string>();
  const chatTypeById = new Map<string, 'group' | 'p2p'>();
  const chatInfoById = new Map<string, CachedFeishuChatInfo>();
  // Head-of-line ordering: Inbox rows of one chat/topic that failed and wait
  // for their retry. Later rows of the same lane wait behind them.
  const retryingByLane = new Map<string, Map<string, InboundLaneEntry>>();
  // Chats already told that some offline messages could not be backfilled.
  const backfillGapNotified = new Set<string>();

  let client: lark.Client | null = null;
  let wsClient: lark.WSClient | null = null;
  let wsConnectionGeneration = 0;

  // WSClient.start() resolves before the endpoint pull and WS handshake
  // finish, and close() does not cancel that in-flight start attempt. A
  // stop() or reconnect that retires the client inside the handshake window
  // would otherwise leave a live, auto-reconnecting long connection that no
  // stop()/disconnect path references any more. Close any client that
  // reaches ready after it stopped being the current one.
  function createWsClient(): lark.WSClient {
    const created: lark.WSClient = new lark.WSClient({
      appId: config.appId,
      appSecret: config.appSecret,
      loggerLevel: lark.LoggerLevel.info,
      // Detect silently-dead long connections instead of hanging on a
      // stale-but-OPEN socket (see FEISHU_WS_PING_TIMEOUT_SEC).
      wsConfig: { pingTimeout: FEISHU_WS_PING_TIMEOUT_SEC },
      onReady: () => {
        if (wsClient === created) return;
        logger.warn(
          'Closing Feishu WS client that finished connecting after it was retired',
        );
        created.close({ force: true });
      },
    });
    return fenceFeishuWebSocketLifecycle(created);
  }
  let eventDispatcher: lark.EventDispatcher | null = null;
  let connectOptions: ConnectOptions | null = null;
  let botOpenId: string = '';
  let botPublicInfo: FeishuBotPublicInfo = {};
  let reconnecting = false;
  let backfillRunning = false;
  let reconnectRequestedAt = 0;
  let lastWsStateConnected = false;
  let disconnectedChecks = 0;
  let healthTimer: NodeJS.Timeout | null = null;
  let inboxRecoveryTimer: NodeJS.Timeout | null = null;
  let inboxRecoveryDueAt = 0;
  let inboundGateTimer: NodeJS.Timeout | null = null;
  let unsubscribeInboundGate: (() => void) | null = null;
  const forwardBundles = new FeishuForwardBundleResolver(async (messageId) => {
    if (!client) return undefined;
    return client.im.v1.message.get({
      path: { message_id: messageId },
      params: { card_msg_content_type: 'user_card_content' },
    });
  });
  // botOpenId 自愈状态：lastBotInfoFetchAt 防止 lazy refetch 高频骚扰 OAPI；
  // botInfoRefetchInFlight 防止并发拉取
  let lastBotInfoFetchAt = 0;
  let botInfoRefetchInFlight: Promise<void> | null = null;
  // mention gate fail-closed 的 warn 节流：避免 botOpenId 长时间缺失时日志洪水
  let lastBotInfoMissingWarnAt = 0;
  let botInfoMissingDroppedSinceLastWarn = 0;

  async function serializeInboundForChat(
    chatId: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    const routeKey = `${reliabilityAccountId}\u0000${chatId}`;
    const previous =
      feishuInboundTailByRoute.get(routeKey) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    feishuInboundTailByRoute.set(routeKey, current);
    try {
      await current;
    } finally {
      if (feishuInboundTailByRoute.get(routeKey) === current) {
        feishuInboundTailByRoute.delete(routeKey);
      }
    }
  }

  /**
   * Intake lane. Every topic of a topic group is its own Runtime Session, so
   * topics are admitted concurrently (a slow download in one topic no longer
   * holds every other topic) while order within a topic is kept. Ordinary
   * groups and private chats share one session per chat and keep one lane;
   * an unknown chat mode also falls back to the chat lane. Only the persisted
   * chat mode is used: a lazily filled cache could flip between two adjacent
   * messages of one topic and split them across lanes.
   */
  function inboundLaneKey(payload: IncomingMessagePayload): string {
    const topicChat =
      payload.threadId !== undefined &&
      feishuTopicChatState(payload.chatId, true) === 'topic';
    return topicChat && payload.threadId
      ? `${payload.chatId}\u0000${payload.threadId}`
      : payload.chatId;
  }

  async function processClaimedInboundSerialized(
    payload: IncomingMessagePayload,
    source: 'ws' | 'backfill',
    claim: ClaimedChannelInboxItem,
  ): Promise<InboundOutcome> {
    // Claims may wait behind rich-content work from an earlier physical event.
    // Begin renewal before entering that shared lane so the DB lease remains
    // fenced for the whole wait.
    startInboxHeartbeat(claim);
    let outcome: InboundOutcome = 'done';
    await serializeInboundForChat(inboundLaneKey(payload), async () => {
      outcome = await processClaimedIncomingMessage(payload, source, claim);
    });
    return outcome;
  }

  function rememberChatProgress(
    chatId: string,
    createTimeMs: number,
    chatType?: string,
  ): void {
    knownChatIds.add(chatId);
    // Only trusted p2p/group values; chat.get's chat_type is private/public.
    if (chatType === 'p2p' || chatType === 'group') {
      chatTypeById.set(chatId, chatType);
    }
    void createTimeMs;
  }

  function rememberInboundMessageChat(messageId: string, chatId: string): void {
    inboundChatByMessageId.delete(messageId);
    inboundChatByMessageId.set(messageId, chatId);
    while (inboundChatByMessageId.size > FEISHU_INBOUND_MESSAGE_CHAT_CACHE) {
      const oldest = inboundChatByMessageId.keys().next().value as
        | string
        | undefined;
      if (oldest === undefined) break;
      inboundChatByMessageId.delete(oldest);
    }
  }

  function inboundPosition(
    payload: IncomingMessagePayload,
    claim?: Pick<ClaimedChannelInboxItem, 'createdAt'>,
  ): number {
    if (
      Number.isSafeInteger(payload.createTimeMs) &&
      payload.createTimeMs > 0
    ) {
      return payload.createTimeMs;
    }
    const recordedAt = claim ? Date.parse(claim.createdAt) : Number.NaN;
    return Number.isSafeInteger(recordedAt) && recordedAt > 0
      ? recordedAt
      : Date.now();
  }

  function threadCursorChatId(chatId: string, threadId: string): string {
    return `${chatId}#thread:${threadId}`;
  }

  /**
   * A terminal Inbox row and its cursor intentionally form a recoverable pair:
   * if the process dies between the two writes, a duplicate WS/backfill event
   * sees the terminal row and calls this again, repairing the cursor without
   * re-running user code.
   */
  function rememberTerminalProgress(
    payload: IncomingMessagePayload,
    claim?: Pick<ClaimedChannelInboxItem, 'createdAt'>,
    topicActivity = false,
  ): void {
    const position = inboundPosition(payload, claim);
    try {
      advanceChannelCursor({
        provider: 'feishu',
        accountId: reliabilityAccountId,
        scope: FEISHU_CURSOR_SCOPE,
        chatId: payload.chatId,
        cursor: payload.messageId,
        position,
        tieBreaker: payload.messageId,
      });
      // Topic replies are not returned by the chat container; a per-thread
      // cursor lets backfill find topics that were active before downtime.
      // Only processed messages count: ignored/unbound chatter does not make
      // a topic worth scanning.
      if (topicActivity && payload.threadId) {
        advanceChannelCursor({
          provider: 'feishu',
          accountId: reliabilityAccountId,
          scope: FEISHU_THREAD_CURSOR_SCOPE,
          chatId: threadCursorChatId(payload.chatId, payload.threadId),
          cursor: payload.messageId,
          position,
          tieBreaker: payload.messageId,
        });
      }
      rememberChatProgress(payload.chatId, position, payload.chatType);
    } catch (err) {
      logger.error(
        { err, chatId: payload.chatId, messageId: payload.messageId },
        'Failed to advance durable Feishu cursor; a duplicate/backfill will repair it',
      );
    }
  }

  /** One chat (or one topic of it): the unit whose input order is kept. */
  function orderingLaneKey(payload: IncomingMessagePayload): string {
    return `${payload.chatId}\u0000${payload.threadId ?? ''}`;
  }

  function holdOrderingLane(
    claim: ClaimedChannelInboxItem,
    payload: IncomingMessagePayload,
    retryAtMs: number,
  ): void {
    const key = orderingLaneKey(payload);
    let lane = retryingByLane.get(key);
    if (!lane) {
      lane = new Map();
      retryingByLane.set(key, lane);
    }
    lane.set(claim.id, {
      position: inboundPosition(payload, claim),
      messageId: payload.messageId,
      retryAtMs,
    });
  }

  function releaseOrderingLane(
    inboxId: string,
    payload: IncomingMessagePayload,
    wakeWaiters = true,
  ): void {
    const key = orderingLaneKey(payload);
    const lane = retryingByLane.get(key);
    if (!lane?.delete(inboxId)) return;
    if (lane.size === 0) retryingByLane.delete(key);
    // Rows deferred behind this one may run now.
    if (wakeWaiters) scheduleInboxRecovery(0);
  }

  /**
   * An earlier row of the same chat/topic is still waiting for its retry.
   * Running this row first would let a transient failure reorder the
   * conversation (A fails, B runs, A runs after B).
   */
  function orderingLaneBlocker(
    claim: ClaimedChannelInboxItem,
    payload: IncomingMessagePayload,
  ): InboundLaneEntry | undefined {
    const key = orderingLaneKey(payload);
    const lane = retryingByLane.get(key);
    if (!lane) return undefined;
    const position = inboundPosition(payload, claim);
    let blocker: InboundLaneEntry | undefined;
    for (const [inboxId, entry] of [...lane]) {
      if (inboxId === claim.id) continue;
      const earlier =
        entry.position < position ||
        (entry.position === position && entry.messageId < payload.messageId);
      if (!earlier) continue;
      if (entry.retryAtMs + FEISHU_INBOX_ORDERING_STALE_MS < Date.now()) {
        lane.delete(inboxId);
        continue;
      }
      // Another instance or a companion may have finished that row.
      const row = getChannelInboxItem(inboxId);
      if (!row || (row.status !== 'queued' && row.status !== 'processing')) {
        lane.delete(inboxId);
        continue;
      }
      if (!blocker || entry.retryAtMs > blocker.retryAtMs) blocker = entry;
    }
    if (lane.size === 0) retryingByLane.delete(key);
    return blocker;
  }

  function completeClaimedInbound(
    claim: ClaimedChannelInboxItem,
    payload: IncomingMessagePayload,
  ): void {
    stopInboxHeartbeat(claim);
    releaseOrderingLane(claim.id, payload);
    if (!completeChannelInbox(claim)) {
      logger.warn(
        { inboxId: claim.id, messageId: payload.messageId },
        'Lost Feishu Inbox lease before completion',
      );
      return;
    }
    rememberTerminalProgress(payload, claim, true);
  }

  function ignoreClaimedInbound(
    claim: ClaimedChannelInboxItem,
    payload: IncomingMessagePayload,
    reason: string,
  ): void {
    stopInboxHeartbeat(claim);
    releaseOrderingLane(claim.id, payload);
    if (!ignoreChannelInbox(claim, reason)) {
      logger.warn(
        { inboxId: claim.id, messageId: payload.messageId, reason },
        'Lost Feishu Inbox lease before ignore transition',
      );
      return;
    }
    rememberTerminalProgress(payload, claim);
  }

  /**
   * Put a claimed row back without counting a failure: a closed gate, a
   * retired connection, an ordering wait or a forward-material wait. The row
   * keeps its payload and is claimed again after `delayMs`.
   */
  function requeueClaimedInbound(
    claim: ClaimedChannelInboxItem,
    payload: IncomingMessagePayload,
    reason: string,
    delayMs: number,
  ): boolean {
    stopInboxHeartbeat(claim);
    const changed = failChannelInbox(claim, {
      error: reason,
      retryAt: new Date(Date.now() + delayMs).toISOString(),
    });
    if (!changed) {
      logger.warn(
        { inboxId: claim.id, messageId: payload.messageId, reason },
        'Lost Feishu Inbox lease before requeue',
      );
      return false;
    }
    scheduleInboxRecovery(delayMs);
    return true;
  }

  function failClaimedInbound(
    claim: ClaimedChannelInboxItem,
    payload: IncomingMessagePayload,
    error: unknown,
    retry: boolean,
    retryDelayMs = FEISHU_INBOX_RETRY_DELAY_MS,
  ): void {
    const message = error instanceof Error ? error.message : String(error);
    if (retry) {
      requeueClaimedInbound(claim, payload, message, retryDelayMs);
      return;
    }
    stopInboxHeartbeat(claim);
    releaseOrderingLane(claim.id, payload);
    const changed = failChannelInbox(claim, { error: message });
    if (!changed) {
      logger.warn(
        { inboxId: claim.id, messageId: payload.messageId, retry },
        'Lost Feishu Inbox lease before failure transition',
      );
      return;
    }
    rememberTerminalProgress(payload, claim);
  }

  function claimHeartbeatKey(
    claim: Pick<ClaimedChannelInboxItem, 'id' | 'leaseToken'>,
  ): string {
    return `${claim.id}:${claim.leaseToken}`;
  }

  function stopInboxHeartbeat(
    claim: Pick<ClaimedChannelInboxItem, 'id' | 'leaseToken'>,
  ): void {
    const key = claimHeartbeatKey(claim);
    const timer = inboxHeartbeatByClaim.get(key);
    if (!timer) return;
    clearInterval(timer);
    inboxHeartbeatByClaim.delete(key);
  }

  function startInboxHeartbeat(claim: ClaimedChannelInboxItem): void {
    const key = claimHeartbeatKey(claim);
    stopInboxHeartbeat(claim);
    const timer = setInterval(() => {
      try {
        if (!renewChannelInboxClaim(claim, FEISHU_INBOX_LEASE_MS)) {
          stopInboxHeartbeat(claim);
          logger.warn(
            { inboxId: claim.id, leaseToken: claim.leaseToken },
            'Lost Feishu Inbox lease during heartbeat renewal',
          );
        }
      } catch (err) {
        // A transient SQLite error must not permanently disable renewal. The
        // next tick retries while the current lease remains fenced.
        logger.warn(
          { err, inboxId: claim.id, leaseToken: claim.leaseToken },
          'Feishu Inbox heartbeat renewal failed',
        );
      }
    }, FEISHU_INBOX_HEARTBEAT_MS);
    timer.unref?.();
    inboxHeartbeatByClaim.set(key, timer);
  }

  // Every requeue registers its due time; one timer fires at the earliest
  // and re-arms for the rest, so a long backoff never hides a short one.
  const recoveryDeadlines = new Set<number>();

  function scheduleInboxRecovery(delayMs = FEISHU_INBOX_RETRY_DELAY_MS): void {
    if (!connectOptions) return;
    recoveryDeadlines.add(Date.now() + Math.max(25, delayMs) + 50);
    armInboxRecoveryTimer();
  }

  function armInboxRecoveryTimer(): void {
    if (!connectOptions || recoveryDeadlines.size === 0) return;
    const next = Math.min(...recoveryDeadlines);
    if (inboxRecoveryTimer && inboxRecoveryDueAt <= next) return;
    if (inboxRecoveryTimer) clearTimeout(inboxRecoveryTimer);
    inboxRecoveryDueAt = next;
    inboxRecoveryTimer = setTimeout(
      () => {
        inboxRecoveryTimer = null;
        inboxRecoveryDueAt = 0;
        const now = Date.now();
        for (const due of recoveryDeadlines) {
          if (due <= now) recoveryDeadlines.delete(due);
        }
        void recoverQueuedInbox('retry-timer')
          .catch((err) => {
            logger.error({ err }, 'Scheduled Feishu Inbox recovery failed');
          })
          .finally(() => armInboxRecoveryTimer());
      },
      Math.max(0, next - Date.now()),
    );
    inboxRecoveryTimer.unref?.();
  }

  function isInboundDeferred(): boolean {
    return connectOptions?.shouldDeferInbound?.() === true;
  }

  function stopInboundGateWait(): void {
    if (inboundGateTimer) {
      clearInterval(inboundGateTimer);
      inboundGateTimer = null;
    }
  }

  /**
   * Rows recorded while the host gate is closed stay queued and unclaimed (no
   * attempt is spent). They resume on the gate-open event; this cheap
   * predicate check is only the fallback when no event arrives.
   */
  function waitForInboundGate(): void {
    if (!connectOptions) return;
    // Re-arm on every deferral. Deferrals only happen while the gate is
    // closed, so the last armed check always runs shortly after it opens.
    stopInboundGateWait();
    inboundGateTimer = setInterval(() => {
      if (!connectOptions) {
        stopInboundGateWait();
        return;
      }
      if (isInboundDeferred()) return;
      stopInboundGateWait();
      void recoverQueuedInbox('gate-open').catch((err) => {
        logger.error({ err }, 'Feishu Inbox recovery after gate open failed');
      });
    }, FEISHU_INBOX_GATE_POLL_MS);
    inboundGateTimer.unref?.();
  }

  /**
   * Workspace folder for downloaded attachments, derived from the admitted
   * route target. A session target (`…#agent:<id>`) shares its workspace's
   * folder; legacy self-targeted chats fall back to the chat's own folder.
   */
  function resolveAttachmentFolder(
    targetJid: string,
    chatJid: string,
  ): string | undefined {
    const resolve = connectOptions?.resolveGroupFolder;
    if (!resolve) return undefined;
    const agentFragment = targetJid.indexOf('#agent:');
    const workspaceJid =
      agentFragment >= 0 ? targetJid.slice(0, agentFragment) : targetJid;
    return resolve(workspaceJid) ?? resolve(chatJid);
  }

  /** Normalize through the host; a null result is a rejection, not raw. */
  function admitIncomingJid(rawJid: string): string | null {
    const normalize = connectOptions?.normalizeIncomingJid;
    return normalize ? normalize(rawJid) : rawJid;
  }

  function restoreDurableChatProgress(): void {
    try {
      for (const cursor of listChannelCursors({
        provider: 'feishu',
        accountId: reliabilityAccountId,
        limit: 10_000,
      })) {
        if (
          cursor.scope === FEISHU_THREAD_CURSOR_SCOPE &&
          cursor.chatId &&
          cursor.position < Date.now() - BACKFILL_THREAD_CURSOR_RETENTION_MS
        ) {
          // Long-quiet topics are no longer backfill candidates.
          deleteChannelCursor({
            provider: 'feishu',
            accountId: reliabilityAccountId,
            scope: FEISHU_THREAD_CURSOR_SCOPE,
            chatId: cursor.chatId,
            expectedPosition: cursor.position,
            expectedTieBreaker: cursor.tieBreaker,
          });
          continue;
        }
        if (cursor.scope !== FEISHU_CURSOR_SCOPE || !cursor.chatId) continue;
        rememberChatProgress(cursor.chatId, cursor.position);
      }
    } catch (err) {
      // Some isolated transport tests intentionally instantiate Feishu without
      // initializing the application DB. Production startup always binds it.
      logger.warn(
        { err, accountId: reliabilityAccountId },
        'Unable to restore durable Feishu cursors',
      );
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
      // 兜底：botOpenId 缺失时让健康检查顺手 lazy refetch；
      // 启动期 retry 失败 / 飞书短暂抖动后能在几分钟内自动恢复 mention 守卫。
      if (!botOpenId) {
        void ensureBotOpenIdFresh('health-check');
      }
    }, WS_HEALTH_CHECK_INTERVAL_MS);
    healthTimer.unref?.();
  }

  /**
   * 拉取可公开给 Agent 的 bot 信息（open_id、名称、头像）。
   * 失败时返回空对象，由调用方决定是否重试。
   */
  async function fetchBotOpenIdOnce(): Promise<FeishuBotPublicInfo> {
    if (!client) return {};
    try {
      const botInfoRes = await client.request({
        method: 'GET',
        url: '/open-apis/bot/v3/info/',
      });
      const info = botInfoRes as {
        bot?: {
          open_id?: string;
          app_name?: string;
          avatar_url?: string;
        };
        data?: {
          bot?: {
            open_id?: string;
            app_name?: string;
            avatar_url?: string;
          };
        };
      };
      const bot = info?.bot ?? info?.data?.bot;
      return {
        ...(bot?.open_id ? { openId: bot.open_id } : {}),
        ...(bot?.app_name ? { name: bot.app_name } : {}),
        ...(bot?.avatar_url ? { avatarUrl: bot.avatar_url } : {}),
      };
    } catch (err) {
      logger.debug({ err }, 'fetchBotOpenIdOnce failed');
      return {};
    }
  }

  /**
   * 启动期带指数退避的 bot open_id 拉取。最多 4 次（间隔 0/1s/2s/4s）。
   * 即使全部失败也不阻塞 connect()，由 ensureBotOpenIdFresh() 后续兜底。
   */
  async function fetchBotOpenIdWithRetry(): Promise<void> {
    for (let attempt = 0; attempt < BOT_INFO_FETCH_MAX_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** (attempt - 1)));
      }
      const info = await fetchBotOpenIdOnce();
      lastBotInfoFetchAt = Date.now();
      if (info.openId) {
        botPublicInfo = info;
        botOpenId = info.openId;
        logger.info(
          { botOpenId, attempt: attempt + 1 },
          'Fetched bot open_id for mention detection',
        );
        return;
      }
    }
    logger.warn(
      { attempts: BOT_INFO_FETCH_MAX_ATTEMPTS },
      'Could not fetch bot open_id after retries; mention gating will fail-closed until recovered',
    );
  }

  /**
   * 后台 lazy refetch：消息进入 mention 门控前若发现 botOpenId 仍空，触发一次。
   * 用 lastBotInfoFetchAt 节流，避免每条消息都打 OAPI；并发安全（in-flight Promise 复用）。
   */
  function ensureBotOpenIdFresh(reason: string): Promise<void> {
    if (botOpenId) return Promise.resolve();
    if (botInfoRefetchInFlight) return botInfoRefetchInFlight;
    const now = Date.now();
    if (now - lastBotInfoFetchAt < BOT_INFO_REFETCH_MIN_INTERVAL_MS) {
      return Promise.resolve();
    }
    botInfoRefetchInFlight = (async () => {
      const info = await fetchBotOpenIdOnce();
      lastBotInfoFetchAt = Date.now();
      if (info.openId) {
        botPublicInfo = info;
        botOpenId = info.openId;
        logger.info(
          { botOpenId, reason },
          'Recovered bot open_id (lazy refetch)',
        );
      } else {
        logger.debug({ reason }, 'Lazy refetch of bot open_id still failed');
      }
    })().finally(() => {
      botInfoRefetchInFlight = null;
    });
    return botInfoRefetchInFlight;
  }

  async function downloadFeishuImage(
    messageId: string,
    fileKey: string,
  ): Promise<{ base64: string; mimeType: string } | null> {
    // stop() clears `client` while a download may be in flight; the caller
    // notices the retired connection and re-queues instead of completing.
    const activeClient = client;
    if (!activeClient) return null;
    try {
      const res = await withFeishuHardTimeout(
        activeClient.im.messageResource.get({
          path: {
            message_id: messageId,
            file_key: fileKey,
          },
          params: {
            type: 'image',
          },
        }),
        FEISHU_RESOURCE_REQUEST_TIMEOUT_MS,
        'Feishu image resource request',
      );

      const stream = res.getReadableStream() as FeishuResourceStream;
      const buffer = await readFeishuResourceBuffer(stream, {
        maxBytes: MAX_FILE_SIZE,
        resourceLabel: `Feishu image ${fileKey}`,
      });
      if (buffer.length === 0) {
        logger.warn(
          { messageId, fileKey },
          'Empty response from image download',
        );
        return null;
      }

      const mimeType = detectImageMimeType(buffer);
      return {
        base64: buffer.toString('base64'),
        mimeType,
      };
    } catch (err) {
      logger.warn(
        { err, messageId, fileKey },
        'Failed to download Feishu image',
      );
      return null;
    }
  }

  /**
   * 下载飞书文件（type='file'）到工作区磁盘。
   * 返回工作区相对路径（如 downloads/feishu/2026-03-01/report.pdf），失败返回 null。
   */
  async function downloadFeishuFileToDisk(
    messageId: string,
    fileKey: string,
    filename: string,
    groupFolder: string,
  ): Promise<string | null> {
    const activeClient = client;
    if (!activeClient) return null;
    try {
      const res = await withFeishuHardTimeout(
        activeClient.im.messageResource.get({
          path: {
            message_id: messageId,
            file_key: fileKey,
          },
          params: {
            type: 'file',
          },
        }),
        FEISHU_RESOURCE_REQUEST_TIMEOUT_MS,
        'Feishu file resource request',
      );

      const stream = res.getReadableStream() as FeishuResourceStream;
      const buffer = await readFeishuResourceBuffer(stream, {
        maxBytes: MAX_FILE_SIZE,
        resourceLabel: filename || `Feishu file ${fileKey}`,
      });
      if (buffer.length === 0) {
        logger.warn(
          { messageId, fileKey },
          'Empty response from file download',
        );
        return null;
      }

      const effectiveName = filename || `file_${fileKey}`;
      try {
        const relPath = await saveDownloadedFile(
          groupFolder,
          'feishu',
          effectiveName,
          buffer,
        );
        return relPath;
      } catch (err) {
        if (err instanceof FileTooLargeError) {
          logger.warn({ fileKey, filename }, 'Feishu file too large, skipping');
          return null;
        }
        throw err;
      }
    } catch (err) {
      logger.warn(
        { err, messageId, fileKey },
        'Failed to download Feishu file to disk',
      );
      return null;
    }
  }

  function getSenderName(openId: string): string {
    return senderNameCache.get(openId) || openId;
  }

  function withAckReactionTimeout<T>(
    operation: 'add' | 'remove',
    request: Promise<T>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new FeishuAckReactionTimeoutError(operation)),
        FEISHU_ACK_REACTION_TIMEOUT_MS,
      );
      timer.unref();
      request.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  async function addReaction(
    messageId: string,
    emojiType: string,
  ): Promise<string | null> {
    try {
      const request = client!.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      });
      const res = (await withAckReactionTimeout('add', request)) as {
        data?: { reaction_id?: string };
      };
      return res.data?.reaction_id || null;
    } catch (err) {
      logger.debug({ err, messageId, emojiType }, 'Failed to add reaction');
      return null;
    }
  }

  /**
   * Add OnIt without blocking the batch for longer than the timeout. A timed
   * out add keeps its original request: if it still lands, the handle owns
   * the late reaction, so clearing the batch removes it instead of leaking an
   * OnIt that nobody tracks.
   */
  async function acquireAckReaction(
    messageId: string,
  ): Promise<AckReactionHandle | null> {
    const activeClient = client;
    if (!activeClient) return null;
    const request = Promise.resolve(
      activeClient.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: 'OnIt' } },
      }),
    ).then(
      (res) =>
        (res as { data?: { reaction_id?: string } } | undefined)?.data
          ?.reaction_id || null,
    );
    try {
      const reactionId = await withAckReactionTimeout('add', request);
      return reactionId
        ? { messageId, reactionId, client: activeClient }
        : null;
    } catch (err) {
      if (!(err instanceof FeishuAckReactionTimeoutError)) {
        logger.debug({ err, messageId }, 'Failed to add OnIt reaction');
        return null;
      }
      const pending = request.catch(() => null);
      return { messageId, pending, client: activeClient };
    }
  }

  async function releaseAckReaction(handle: AckReactionHandle): Promise<void> {
    const { messageId, reactionId } = handle;
    if (reactionId) {
      // Failures propagate so the registry keeps ownership for a retry.
      await removeReactionStrict(messageId, reactionId);
      return;
    }
    // The add is still in flight; never block a batch handoff on it. Delete
    // the reaction as soon as (and if) it lands.
    void handle.pending
      ?.then((reactionId) =>
        reactionId
          ? removeReactionStrict(handle.messageId, reactionId, handle.client)
          : undefined,
      )
      .catch((err) =>
        logger.debug(
          { err, messageId: handle.messageId },
          'Failed to remove a late OnIt reaction',
        ),
      );
  }

  async function removeReactionStrict(
    messageId: string,
    reactionId: string,
    activeClient: lark.Client | null = client,
  ): Promise<void> {
    if (!activeClient) throw new Error('Feishu client is not initialized');
    const request = activeClient.im.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    });
    await withAckReactionTimeout('remove', request);
  }

  function clearAckForInput(
    rawTarget: string,
    inputMessageId: string,
  ): Promise<void> {
    const target = parseFeishuRouteTarget(rawTarget);
    return ackReactions.clear(
      processingIndicatorKey(target.raw, inputMessageId),
    );
  }

  function beginAckForInput(
    rawTarget: string,
    inputMessageId: string,
  ): Promise<void> {
    // Never trust the caller: a synthetic input (`scheduled-task-prompt:…`,
    // a Web uuid) is not a Feishu message and the API would only reject it.
    if (!isFeishuMessageId(inputMessageId)) {
      logger.debug(
        { inputMessageId },
        'Skipped OnIt reaction: input is not a Feishu message id',
      );
      return Promise.resolve();
    }
    const target = parseFeishuRouteTarget(rawTarget);
    return ackReactions.attach(
      processingIndicatorKey(target.raw, inputMessageId),
      () => acquireAckReaction(inputMessageId),
      releaseAckReaction,
    );
  }

  /**
   * The input id the host named for this output, when it is a Feishu message
   * of the target chat. A Web/scheduled input or another chat's message is
   * reported as `null` (do not anchor); an unknown `om_` id after a restart
   * is trusted because the host admitted it for this route.
   */
  function inputAnchorFor(
    target: FeishuRouteTarget,
    inputMessageId: string | undefined,
  ): string | null | undefined {
    if (inputMessageId === undefined) return undefined;
    if (!isFeishuMessageId(inputMessageId)) return null;
    const knownChat = inboundChatByMessageId.get(inputMessageId);
    if (knownChat && knownChat !== target.chatId) return null;
    return inputMessageId;
  }

  function p2pLastMessageId(
    target: FeishuRouteTarget,
    inputMessageId?: string,
  ): string | undefined {
    return resolveFeishuMessageAnchor({
      target,
      chatType: chatTypeById.get(target.chatId),
      lastMessageId: lastMessageIdByChat.get(target.chatId),
      inputMessageId: inputAnchorFor(target, inputMessageId),
    });
  }

  async function replyToFeishuMessage(
    messageId: string,
    msgType: string,
    content: string,
    replyInThread: boolean,
    physical: FeishuPhysicalSend = {},
  ): Promise<void> {
    const activeClient = client;
    if (!activeClient) {
      throw new DefinitiveChannelDeliveryError(
        'Feishu client is not initialized',
      );
    }
    const reply = async (threaded: boolean) => {
      const request = activeClient.im.message.reply({
        path: { message_id: messageId },
        data: {
          content,
          msg_type: msgType,
          ...(threaded ? { reply_in_thread: true } : {}),
          // One uuid for every variant of this physical message: only one
          // variant can ever be accepted, and a replay is deduplicated.
          ...(physical.uuid ? { uuid: physical.uuid } : {}),
        },
      });
      const response = physical.requestTimeoutMs
        ? await withFeishuHardTimeout(
            request,
            physical.requestTimeoutMs,
            physical.requestLabel ?? 'Feishu message.reply',
          )
        : await request;
      assertFeishuApiSuccess('Feishu message.reply', response);
    };
    try {
      await reply(replyInThread);
    } catch (error) {
      const code = feishuApiErrorCode(error);
      if (
        !replyInThread ||
        !code ||
        !FEISHU_THREAD_REPLY_UNSUPPORTED_CODES.has(code)
      ) {
        throw error;
      }
      logger.info(
        { messageId, msgType, code },
        'Feishu reply_in_thread unsupported; retrying this message as a plain reply',
      );
      // Retry exactly this physical send step. Uploads and any already-sent
      // sibling attachments remain untouched.
      await reply(false);
    }
  }

  /**
   * Feishu refused the request for rate (230020 per chat, 99991400 per app):
   * nothing was delivered, so the very same request is resent after the
   * shared bounded backoff (the card transport uses the same helper). No
   * format fallback — every format hits the same limit. When the limit
   * persists the send is a definitive non-delivery, never `retry_wait`.
   */
  async function withSendRateLimitRetry(
    operation: () => Promise<void>,
    context: { chatId: string; msgType: string },
  ): Promise<void> {
    try {
      await withFeishuRateLimitRetry(operation);
    } catch (error) {
      const classified = classifyFeishuCardError(error);
      if (classified.kind !== 'rate_limited') throw error;
      logger.warn(
        { ...context, code: classified.code },
        'Feishu kept rate-limiting the send; giving up on this message',
      );
      throw new DefinitiveChannelDeliveryError(
        `Feishu kept rate-limiting the send (code=${classified.code ?? 'unknown'}): ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error },
      );
    }
  }

  /**
   * Group chat mode persisted by metadata sync (registered_groups), which is
   * stable for the chat. Every registration of one Feishu chat shares it, so
   * the unscoped row is an acceptable fallback while inbound is paused.
   */
  function persistedFeishuChatMode(
    chatId: string,
  ): { chatMode?: string; groupMessageType?: string } | undefined {
    const raw = `feishu:${chatId}`;
    const candidates = [
      admitIncomingJid(raw),
      config.channelAccountId
        ? scopeChannelJid(raw, config.channelAccountId)
        : null,
      raw,
    ];
    try {
      for (const jid of new Set(candidates)) {
        if (!jid) continue;
        const group = getRegisteredGroup(jid);
        if (group?.feishu_chat_mode || group?.feishu_group_message_type) {
          return {
            chatMode: group.feishu_chat_mode,
            groupMessageType: group.feishu_group_message_type,
          };
        }
      }
    } catch {
      // Isolated transport tests may run without the application DB.
    }
    return undefined;
  }

  /**
   * Topic group (every topic its own Runtime Session)? `persistedOnly`
   * ignores the lazily fetched chat info, for decisions that must not flip
   * between two adjacent messages (intake lanes).
   */
  function feishuTopicChatState(
    chatId: string,
    persistedOnly = false,
  ): 'topic' | 'not_topic' | 'unknown' {
    if (chatTypeById.get(chatId) === 'p2p') return 'not_topic';
    const sources = [
      persistedFeishuChatMode(chatId),
      persistedOnly ? undefined : chatInfoById.get(chatId),
    ];
    for (const info of sources) {
      if (!info) continue;
      if (info.chatMode === 'topic' || info.groupMessageType === 'thread') {
        return 'topic';
      }
      if (info.chatMode === 'group' || info.chatMode === 'p2p') {
        return 'not_topic';
      }
    }
    return 'unknown';
  }

  /**
   * The quoted anchor was recalled/deleted (230011/231003). In a private chat
   * or an ordinary group the anchor only shapes presentation, so the answer
   * is posted into the chat once instead of being lost. A topic group (or an
   * unknown chat on a topic route) keeps failing definitively: a top-level
   * message there would open an unrelated new topic.
   */
  function replyAnchorFallbackAllowed(
    target: FeishuRouteTarget,
    error: unknown,
  ): boolean {
    const classified = classifyFeishuCardError(error);
    if (
      classified.kind !== 'target_unavailable' ||
      (classified.code !== 230011 && classified.code !== 231003)
    ) {
      return false;
    }
    const topic = feishuTopicChatState(target.chatId);
    return topic === 'not_topic' || (topic === 'unknown' && !target.threadId);
  }

  /**
   * Low-level send: explicit roots use reply_in_thread; P2P chats reply to
   * this turn's input when the caller names it (else the legacy latest
   * inbound message). A bare group target always creates a top-level message
   * and can never inherit the group's most recent topic.
   */
  async function sendToFeishu(
    chatId: string,
    msgType: string,
    content: string,
    physical: FeishuPhysicalSend = {},
  ): Promise<void> {
    if (!client) {
      throw new DefinitiveChannelDeliveryError(
        'Feishu client is not initialized',
      );
    }
    let target: FeishuRouteTarget;
    try {
      target = requireFeishuRouteTarget(chatId);
    } catch (error) {
      throw localFeishuPreflightError('Feishu route validation', error);
    }
    const replyMsgId =
      target.rootMessageId || p2pLastMessageId(target, physical.inputMessageId);
    const receiveIdType = target.chatId.startsWith('oc_')
      ? 'chat_id'
      : 'open_id';
    const create = async (
      activeClient: lark.Client,
      uuid: string | undefined,
    ): Promise<void> => {
      const request = activeClient.im.v1.message.create({
        params: { receive_id_type: receiveIdType },
        data: {
          receive_id: target.chatId,
          msg_type: msgType,
          content,
          ...(uuid ? { uuid } : {}),
        },
      });
      const response = physical.requestTimeoutMs
        ? await withFeishuHardTimeout(
            request,
            physical.requestTimeoutMs,
            physical.requestLabel ?? 'Feishu message.create',
          )
        : await request;
      assertFeishuApiSuccess('Feishu message.create', response);
    };
    const send = async (): Promise<void> => {
      const activeClient = client;
      if (!activeClient) {
        throw new DefinitiveChannelDeliveryError(
          'Feishu client is not initialized',
        );
      }
      if (!replyMsgId) {
        await create(activeClient, physical.uuid);
        return;
      }
      try {
        await replyToFeishuMessage(
          replyMsgId,
          msgType,
          content,
          target.replyInThread,
          physical,
        );
      } catch (error) {
        if (!replyAnchorFallbackAllowed(target, error)) throw error;
        logger.warn(
          { chatId, msgType, anchor: replyMsgId },
          'Feishu reply anchor was recalled; posting the answer into the chat',
        );
        // The refused reply was not delivered; the create is a new request.
        await create(activeClient, variantUuid(physical.uuid, 'anchor-gone'));
      }
    };
    await withSendRateLimitRetry(
      () =>
        withFeishuPreAcceptanceRetry(send, {
          onRetry: ({ attempt, nextAttempt, delayMs, error }) => {
            logger.warn(
              { chatId, msgType, attempt, nextAttempt, delayMs, err: error },
              'Feishu request failed before send; retrying safely',
            );
          },
        }),
      { chatId, msgType },
    );
  }

  /** Send each accepted page once; only explicit size rejections reflow it. */
  async function sendOrdinaryPages(
    chatId: string,
    text: string,
    kind: 'post' | 'text',
    tracker: PhysicalDeliveryTracker,
    physicalOutput = false,
    identity: FeishuSendIdentity = {},
  ): Promise<void> {
    const prepare =
      kind === 'post'
        ? prepareFeishuPostTextPages
        : prepareFeishuPlainTextPages;
    const initialBudget =
      kind === 'post' ? FEISHU_POST_MAX_BYTES : FEISHU_TEXT_MAX_BYTES;
    // Free text (model output, tool results, quoted web pages) must not be
    // able to @ everyone or name arbitrary users.
    const safeText = neutralizeFeishuMentions(text, 'text');
    const pages = (physicalOutput ? [safeText] : prepare(safeText)).map(
      (page, index) => ({
        text: page,
        budget: initialBudget,
        slot: String(index),
      }),
    );
    tracker.addOutputs(pages.length - 1);
    while (pages.length) {
      const page = pages[0];
      const content =
        kind === 'post'
          ? buildPostMdFallback(page.text)
          : JSON.stringify({ text: page.text });
      try {
        await tracker.send(() =>
          sendToFeishu(chatId, kind, content, {
            uuid: physicalUuid(identity.uuidBase, kind, 'page', page.slot),
            inputMessageId: identity.inputMessageId,
            requestTimeoutMs: FEISHU_RESOURCE_REQUEST_TIMEOUT_MS,
            requestLabel: 'Feishu ordinary reply page',
          }),
        );
      } catch (error) {
        const rejection =
          error instanceof PartialChannelDeliveryError ? error.cause : error;
        // Scoped physical pages belong to the durable outbox planner. Let it
        // assign separate stable identities before sending smaller pages.
        if (
          !physicalOutput &&
          feishuApiErrorCode(rejection) === 230025 &&
          definitiveFeishuChannelDeliveryError(rejection) &&
          page.budget > 4096
        ) {
          const budget = Math.floor(page.budget * 0.8);
          const smaller = prepare(page.text, { maxBytes: budget });
          tracker.addOutputs(smaller.length - 1);
          pages.splice(
            0,
            1,
            ...smaller.map((part, index) => ({
              text: part,
              budget,
              slot: `${page.slot}.${index}`,
            })),
          );
          continue;
        }
        throw error;
      }
      pages.shift();
    }
  }

  async function sendTextToChat(
    chatId: string,
    text: string,
    identity: FeishuSendIdentity = {},
  ): Promise<void> {
    if (!client) {
      throw new FeishuTextDeliveryError(
        'Feishu client is not initialized',
        'rejected',
      );
    }
    try {
      await sendOrdinaryPages(
        chatId,
        text,
        'text',
        new PhysicalDeliveryTracker(1),
        false,
        identity,
      );
    } catch (err) {
      logger.error({ chatId, err }, 'Failed to send Feishu text reply');
      const rejected = definitiveFeishuChannelDeliveryError(err);
      throw new FeishuTextDeliveryError(
        `Feishu text reply was not acknowledged: ${
          err instanceof Error ? err.message : String(err)
        }`,
        rejected ? 'rejected' : 'uncertain',
        rejected ?? err,
      );
    }
  }

  /**
   * A backfill pass judged this row before its mention shape was understood
   * (or before the Bot open_id was known). The live event is authoritative:
   * let it be judged again instead of being swallowed as a duplicate.
   */
  function reopensBackfillMentionIgnore(
    item: { status: string; error: string | null; rawPayload: unknown },
    source: 'ws' | 'backfill',
  ): boolean {
    return (
      source === 'ws' &&
      item.status === 'ignored' &&
      typeof item.error === 'string' &&
      item.error.startsWith('mention_gate:') &&
      (item.rawPayload as { source?: unknown } | null)?.source === 'backfill'
    );
  }

  async function handleIncomingMessage(
    payload: IncomingMessagePayload,
    source: 'ws' | 'backfill',
  ): Promise<void> {
    const { chatId, messageId } = payload;
    if (!chatId || !messageId) return;
    const rawChatJid = `feishu:${chatId}`;
    const deferring = isInboundDeferred();
    const admittedJid = admitIncomingJid(rawChatJid);
    if (admittedJid === null && !deferring) {
      // The owning user/account is not admitted (disabled, deleted). Never
      // fall back to the unscoped JID.
      logger.debug(
        { messageId, chatId, source },
        'Rejected Feishu message: inbound principal is not admitted',
      );
      return;
    }
    // While paused/deferred the host normalizer refuses every JID; the Inbox
    // route snapshot then uses this connection's own account scope.
    const sourceJid =
      admittedJid ??
      (config.channelAccountId
        ? scopeChannelJid(rawChatJid, config.channelAccountId)
        : rawChatJid);
    rememberInboundMessageChat(messageId, chatId);
    let recorded: ReturnType<typeof recordChannelInbox>;
    try {
      recorded = recordChannelInbox({
        provider: 'feishu',
        accountId: reliabilityAccountId,
        externalMessageId: messageId,
        sourceJid,
        chatId,
        rootId: payload.rootId,
        threadId: payload.threadId,
        rawPayload: { version: 1, source, payload },
        status: 'queued',
      });
    } catch (err) {
      // Never fall back to volatile execution: without the Inbox uniqueness
      // fence, two WS clients or a reconnect can launch the same Agent turn.
      logger.error(
        { err, messageId, chatId, source },
        'Failed to durably record Feishu message; refusing unfenced execution',
      );
      throw err;
    }

    if (
      reopensBackfillMentionIgnore(recorded.item, source) &&
      transitionChannelInbox(recorded.item.id, 'ignored', 'queued', {
        error: null,
      })
    ) {
      logger.info(
        { messageId, chatId, previous: recorded.item.error },
        'Re-evaluating a live Feishu event that backfill had ignored',
      );
    } else if (
      recorded.item.status === 'processed' ||
      recorded.item.status === 'ignored' ||
      recorded.item.status === 'failed'
    ) {
      rememberTerminalProgress(payload);
      logger.debug(
        { messageId, inboxStatus: recorded.item.status, source },
        'Duplicate terminal Feishu message, skipping execution',
      );
      return;
    }

    if (deferring) {
      // Leave the row queued and unclaimed: claiming would spend an attempt
      // just to put it back. It resumes when the gate opens.
      waitForInboundGate();
      logger.debug(
        { inboxId: recorded.item.id, messageId, source },
        'Deferred durable Feishu Inbox until recovery gate opens',
      );
      return;
    }

    const claim = claimChannelInboxById(
      recorded.item.id,
      inboxOwner,
      FEISHU_INBOX_LEASE_MS,
    );
    if (!claim) {
      logger.debug(
        { messageId, inboxStatus: recorded.item.status, source },
        'Feishu message already claimed or awaiting retry',
      );
      return;
    }
    await processClaimedInboundSerialized(payload, source, claim);
  }

  async function processClaimedIncomingMessage(
    payload: IncomingMessagePayload,
    source: 'ws' | 'backfill',
    claim: ClaimedChannelInboxItem,
  ): Promise<InboundOutcome> {
    if (!connectOptions) {
      // stop() cleared the admission callbacks (owner_only, @ activation,
      // allowlists). Processing now would fail open; keep the message queued
      // for the next connection instead.
      requeueClaimedInbound(
        claim,
        payload,
        'Feishu connection stopped before the message was admitted',
        FEISHU_INBOX_RETRY_DELAY_MS,
      );
      logger.debug(
        { inboxId: claim.id, messageId: payload.messageId, source },
        'Kept Feishu Inbox item queued: connection is stopped',
      );
      return 'deferred';
    }
    if (isInboundDeferred()) {
      // The gate closed between claim and processing (shutdown pause). Put
      // the row back without counting a failure and resume on gate open.
      requeueClaimedInbound(
        claim,
        payload,
        'Channel recovery is still reconciling previous turns',
        FEISHU_INBOX_GATE_POLL_MS,
      );
      waitForInboundGate();
      logger.debug(
        { inboxId: claim.id, messageId: payload.messageId },
        'Deferred durable Feishu Inbox until recovery gate opens',
      );
      return 'deferred';
    }
    // This attempt now runs; it no longer blocks its own lane.
    releaseOrderingLane(claim.id, payload, false);
    const laneBlocker = orderingLaneBlocker(claim, payload);
    if (laneBlocker) {
      // Keep chat/topic order: an earlier message is waiting for its retry.
      // Become available just after it so recovery claims it first.
      const delayMs = Math.max(
        FEISHU_INBOX_ORDERING_DELAY_MS,
        laneBlocker.retryAtMs - Date.now() + FEISHU_INBOX_ORDERING_DELAY_MS,
      );
      requeueClaimedInbound(
        claim,
        payload,
        `Waiting behind earlier message ${laneBlocker.messageId}`,
        delayMs,
      );
      logger.debug(
        {
          inboxId: claim.id,
          messageId: payload.messageId,
          blockedBy: laneBlocker.messageId,
          delayMs,
        },
        'Deferred Feishu message behind an earlier retrying message',
      );
      return 'deferred';
    }
    const generation = wsConnectionGeneration;
    // stop() or a shutdown pause retired this connection mid-intake: the
    // message must be replayed by the next connection, never completed with
    // degraded "[下载失败]" placeholders.
    const assertIntakeLive = (): void => {
      if (
        generation !== wsConnectionGeneration ||
        !connectOptions ||
        isInboundDeferred()
      ) {
        throw new FeishuIntakeRetiredError();
      }
    };
    const intake: FeishuIntakeState = readFeishuIntakeState(
      claim.normalizedPayload,
    );
    let normalizedSnapshot: unknown = (() => {
      const value = claim.normalizedPayload;
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return value;
      }
      const { intake: _intake, ...rest } = value as Record<string, unknown>;
      return Object.keys(rest).length > 0 ? rest : null;
    })();
    /** Persist the normalized payload together with intake bookkeeping. */
    const writeNormalized = (normalizedPayload: unknown): boolean => {
      normalizedSnapshot = normalizedPayload;
      return updateClaimedChannelInbox(claim, {
        normalizedPayload: withFeishuIntakeState(normalizedPayload, intake),
      });
    };
    const persistIntake = (): boolean => writeNormalized(normalizedSnapshot);
    /**
     * Count one intake failure and retry with exponential backoff (5s →
     * 10min). After FEISHU_INBOUND_MAX_FAILURES the row is terminal `failed`.
     */
    const scheduleIntakeRetry = (error: unknown): 'retry' | 'terminal' => {
      intake.failures += 1;
      persistIntake();
      const message = error instanceof Error ? error.message : String(error);
      if (intake.failures >= FEISHU_INBOUND_MAX_FAILURES) {
        failClaimedInbound(
          claim,
          payload,
          new Error(`${message} (gave up after ${intake.failures} attempts)`),
          false,
        );
        return 'terminal';
      }
      const delayMs = feishuInboundRetryDelayMs(intake.failures);
      if (
        requeueClaimedInbound(claim, payload, message, delayMs) &&
        intake.failures <= FEISHU_INBOX_ORDERING_HOLD_MAX_FAILURES &&
        delayMs <= FEISHU_INBOX_ORDERING_HOLD_MAX_MS
      ) {
        holdOrderingLane(claim, payload, Date.now() + delayMs);
      }
      return 'retry';
    };
    const {
      onNewChat,
      onCommand,
      resolveEffectiveChatJid,
      onAgentMessage,
      onMessagePersisted,
      onFollowUpsChanged,
      onFollowUpMessage,
      onSessionBreak,
      onSessionClear,
      onSessionFresh,
      shouldProcessGroupMessage,
      resolveFeishuConversationPlan,
      isGroupOwnerMessage,
      isSenderAllowedInGroup,
      onP2pSender,
    } = connectOptions || {};
    const {
      chatId,
      messageId,
      rootId,
      parentId,
      threadId,
      createTimeMs,
      messageType,
      content: rawContent,
      chatType,
      senderOpenId = '',
      senderUserId,
      senderUnionId,
      senderName,
      senderTenantKey,
      senderType,
    } = payload;
    // Rows recorded before the REST shape was normalized (string mention ids)
    // are fixed here as well.
    const mentions = normalizeFeishuMentions(payload.mentions);
    const forwardCandidate: FeishuForwardCandidate = {
      messageId,
      messageType,
      content: rawContent,
      rootId,
      parentId,
      threadId,
      senderOpenId,
      createTimeMs,
      chatType:
        chatType === 'p2p' || chatType === 'group' ? chatType : undefined,
    };
    // Register roots before any rich-content lookup. A concurrently delivered
    // note may otherwise finish normalization first and miss the structural
    // fact even though both provider events are already in this process.
    let contentLink = forwardBundles.observeRoot(forwardCandidate);
    if (!chatId || !messageId) {
      failClaimedInbound(
        claim,
        payload,
        new Error('Claimed Feishu Inbox payload is missing chat/message id'),
        false,
      );
      return 'done';
    }
    const normalizedChatType =
      chatType === 'p2p' || chatType === 'group' ? chatType : undefined;
    const rawChatJid = `feishu:${chatId}`;
    const chatJid = admitIncomingJid(rawChatJid);
    if (chatJid === null) {
      // The owning user/account is no longer admitted. Never fall back to
      // the unscoped JID: every later callback would run outside its scope.
      ignoreClaimedInbound(claim, payload, 'inbound_principal_rejected');
      return 'done';
    }
    logger.info(
      { messageId, messageType, chatId, source, inboxId: claim.id },
      'Feishu message received',
    );
    // A recall that arrived while this row waited or was in flight. Held
    // merged-forward roots are closed after routing, where their persisted
    // "awaiting companion" row can be cancelled too.
    if (recalledMessageIds.has(messageId) && messageType !== 'merge_forward') {
      ignoreClaimedInbound(claim, payload, 'recalled');
      return 'done';
    }
    // Retry/terminal notices go to the message's own topic-aware route, and
    // only once the message passed audience and binding admission.
    let failureNoticeTarget: string | undefined;
    // Merged-forward waits (companion grace, material retries) are counted
    // separately from claim attempts, which gate and ordering waits also bump.
    const forwardAttempt = intake.forwardMaterialAttempt + 1;

    try {
      let extracted = extractMessageContent(messageType, rawContent);
      let text = extracted.text;
      if (
        !text?.trim() &&
        !extracted.imageKeys &&
        !extracted.fileInfos?.length
      ) {
        logger.info(
          { messageId, messageType },
          'No text or image content, skipping',
        );
        ignoreClaimedInbound(claim, payload, 'empty_content');
        return 'done';
      }

      if (mentions && Array.isArray(mentions)) {
        for (const mention of mentions) {
          if (mention.key) {
            text = text.replace(mention.key, `@${mention.name || ''}`);
          }
        }
      }

      const mentionedBot = isBotMentioned(
        botOpenId,
        mentions as MentionGateMention[] | undefined,
      );
      const rawMessageMeta: FeishuMessageMeta = {
        provider: 'feishu',
        chatType: normalizedChatType,
        mentionedBot,
        threadId,
        rootId,
        parentId,
        messageId,
        text,
      };
      const conversationPlan = resolveFeishuConversationPlan?.(
        chatJid,
        rawMessageMeta,
      );
      const routedMessageMeta: FeishuMessageMeta = {
        ...rawMessageMeta,
        nativeContextType:
          conversationPlan?.independentContext ||
          (!conversationPlan && !!threadId)
            ? 'thread'
            : undefined,
        contextId: conversationPlan?.contextId || threadId,
        rootId: conversationPlan?.rootMessageId || rootId,
      };
      const rootMessageId =
        conversationPlan?.rootMessageId || rootId || messageId;
      const deliveryRootMessageId = conversationPlan?.independentContext
        ? conversationPlan.rootMessageId
        : threadId
          ? rootMessageId
          : rootId;
      // A quote-reply in an ordinary (non-topic) group or a private chat has
      // root_id = parent_id but no thread_id. It still yields a root target,
      // so the answer is posted with reply_in_thread under the quoted message
      // (Feishu falls back to a plain reply where threads are unsupported).
      // This is the current product behaviour, kept deliberately.
      const messageRouteTarget = buildFeishuRouteTarget(
        chatId,
        threadId,
        deliveryRootMessageId,
      );
      const resolvedSenderName = senderName || getSenderName(senderOpenId);
      const cachedChatInfo = chatInfoById.get(chatId);
      // A placeholder name is only for first registration. Passing it for an
      // already registered chat would rename it (e.g. every P2P chat back to
      // "飞书私聊" after a restart, since P2P chats are not in chat.list).
      const knownChatName = cachedChatInfo?.name?.trim() || '';
      const resolvedChatName =
        knownChatName || (chatType === 'p2p' ? '飞书私聊' : '飞书群聊');

      // Audience is an identity boundary, independent from @/topic activation,
      // and therefore runs before commands and before the mention gate. This
      // also applies to p2p chats and already-active topics.
      if (
        isSenderAllowedInGroup &&
        !isSenderAllowedInGroup(chatJid, senderOpenId)
      ) {
        if (
          chatType === 'group' &&
          mentionedBot &&
          (!connectOptions?.isChatBound || connectOptions.isChatBound(chatJid))
        ) {
          addReaction(messageId, 'SILENT').catch(() => {});
        }
        logger.debug(
          { chatJid, messageId, senderOpenId, chatType },
          'Dropped Feishu message: sender rejected by audience policy',
        );
        ignoreClaimedInbound(claim, payload, 'audience_rejected');
        return 'done';
      }

      // Discovery makes a chat available in the binding UI; it does not
      // authorize a reply. Apply this before all command/reaction side effects.
      if (connectOptions?.isChatBound && !connectOptions.isChatBound(chatJid)) {
        if (chatType === 'p2p') {
          onNewChat?.(chatJid, resolvedChatName);
          if (senderOpenId && onP2pSender) onP2pSender(senderOpenId);
        }
        if (!connectOptions.isChatBound(chatJid)) {
          ignoreClaimedInbound(claim, payload, 'unbound_channel');
          return 'done';
        }
      }
      failureNoticeTarget = messageRouteTarget.raw;

      // ── 斜杠指令：拦截已知 /xxx 命令，不进入消息流 ──
      // 只有飞书结构化 mentions 证明了真实 Bot 点名，才移除开头的展示名。
      // 用户手写的同名字面 `@Bot` 不能获得 /steer 或 /break 控制能力。
      let textForSlash =
        chatType === 'group'
          ? stripLeadingBotMention(
              text ?? '',
              botOpenId,
              mentions as MentionGateMention[] | undefined,
            ).trim()
          : (text?.trim() ?? '');
      let requestedFollowUpMode: FollowUpMode | undefined;
      const runtimeControlGate = evaluateMentionGate({
        chatType: normalizedChatType,
        botOpenId,
        mentions: mentions as MentionGateMention[] | undefined,
        chatJid,
        senderOpenId,
        shouldProcessGroupMessage,
        isGroupOwnerMessage,
        conversationPlan,
      });
      // Group slash commands of every kind need a structurally proven @Bot
      // (the audience check already ran above): a bare "/recall" in a group
      // is ordinary text. Generic commands deliberately skip the activation
      // gate so a disabled or unclaimed chat can recover itself
      // (`@Bot /require_mention`, `@Bot /owner_mention`); runtime controls
      // (/steer /break /clear /fresh) also need the activation gate. Private
      // chats keep direct commands, but a disabled one ignores runtime
      // controls too.
      const commandEligible = chatType !== 'group' || mentionedBot;
      const runtimeControl = parseRuntimeControl({
        commandText: textForSlash,
        eligible: commandEligible && runtimeControlGate.allow,
        hasAttachments:
          Boolean(extracted.imageKeys?.length) ||
          Boolean(extracted.fileInfos?.length) ||
          (messageType !== 'text' && messageType !== 'post'),
      });
      if (runtimeControl?.kind === 'steer') {
        requestedFollowUpMode = 'steer';
        text = runtimeControl.text;
        textForSlash = runtimeControl.text;
      }
      const slashMatch = textForSlash.match(/^\/(\S+)(.*)$/);
      const runtimeControlLike = isRuntimeControlLike(textForSlash);
      const persistedCommand = parseFeishuSlashCommandCheckpoint(
        claim.normalizedPayload,
      );
      if (
        slashMatch &&
        !requestedFollowUpMode &&
        (runtimeControl?.kind === 'break' ||
          runtimeControl?.kind === 'clear' ||
          runtimeControl?.kind === 'fresh' ||
          (onCommand && !runtimeControlLike && commandEligible) ||
          // A command admitted before a restart keeps its durable checkpoint
          // semantics (never re-execute, never resend) whatever the gate says.
          persistedCommand !== undefined)
      ) {
        const cmdBody = (slashMatch[1] + slashMatch[2]).trim();
        logger.info(
          {
            chatJid,
            cmd: slashMatch[1],
            cmdBody,
            checkpointState: persistedCommand?.state,
          },
          'Feishu slash command detected',
        );
        if (persistedCommand && persistedCommand.command !== cmdBody) {
          failClaimedInbound(
            claim,
            payload,
            new Error(
              'Durable Feishu slash-command checkpoint does not match the recovered input',
            ),
            false,
          );
          return 'done';
        }
        if (
          persistedCommand?.state === 'executing' ||
          persistedCommand?.state === 'sending_reply'
        ) {
          // The prior process may have executed arbitrary command side
          // effects or reached the provider before it died. Re-running either
          // step is unsafe, so stop for manual reconciliation instead.
          const interruptedWhileSending =
            persistedCommand.state === 'sending_reply';
          failClaimedInbound(
            claim,
            payload,
            new Error(
              interruptedWhileSending
                ? 'Feishu slash command reply delivery was interrupted after send began; manual reconciliation required'
                : 'Feishu slash command execution was interrupted before its result was persisted; manual reconciliation required',
            ),
            false,
          );
          try {
            await sendTextToChat(
              persistedCommand.replyTarget,
              interruptedWhileSending
                ? '⚠️ 上一次命令回复可能已经送达，但系统未能确认，请核对后再决定是否重试。'
                : '⚠️ 上一次命令执行在结果落盘前中断，为避免重复执行，系统已停止自动重试，请人工核对。',
            );
          } catch (sendErr) {
            logger.error(
              { chatJid, messageId, sendErr },
              'Failed to send interrupted slash-command reconciliation notice',
            );
          }
          return 'done';
        }
        if (persistedCommand?.state === 'reply_acknowledged') {
          completeClaimedInbound(claim, payload);
          return 'done';
        }
        let retryableReply: FeishuSlashCommandCheckpoint | undefined;
        try {
          let reply: string | null;
          let replyTarget: string;
          if (persistedCommand?.state === 'pending_reply') {
            reply = persistedCommand.replyText;
            replyTarget = persistedCommand.replyTarget;
            retryableReply = persistedCommand;
          } else {
            const executingCheckpoint: FeishuSlashCommandCheckpoint = {
              version: 1,
              kind: 'feishu_slash_command',
              state: 'executing',
              command: cmdBody,
              replyTarget: messageRouteTarget.raw,
            };
            if (!writeNormalized(executingCheckpoint)) {
              stopInboxHeartbeat(claim);
              logger.warn(
                { inboxId: claim.id, messageId, cmd: slashMatch[1] },
                'Lost Feishu Inbox lease before command execution checkpoint',
              );
              return 'done';
            }
            if (
              runtimeControl?.kind === 'break' ||
              runtimeControl?.kind === 'clear' ||
              runtimeControl?.kind === 'fresh'
            ) {
              let targetJid: string | undefined;
              // Group routes are already registered and may carry a native
              // thread/topic target. A first-contact P2P route is deliberately
              // left for the host fallback so command handling never bypasses
              // the normal P2P bootstrap below.
              if (chatType === 'group' && resolveEffectiveChatJid) {
                try {
                  targetJid = resolveEffectiveChatJid(
                    chatJid,
                    routedMessageMeta,
                  )?.effectiveJid;
                } catch (error) {
                  if (!(error instanceof ChannelRouteRejectedError))
                    throw error;
                }
              }
              if (runtimeControl?.kind === 'break') {
                reply = onSessionBreak
                  ? await onSessionBreak({
                      sourceJid: chatJid,
                      targetJid,
                      senderImId: senderOpenId,
                      // Lets the host resolve a private chat's own Session
                      // and never fall back to the main session for groups.
                      ...(normalizedChatType
                        ? { chatType: normalizedChatType }
                        : {}),
                    })
                  : '当前运行环境不支持 /break。';
              } else if (runtimeControl?.kind === 'fresh') {
                reply = onSessionFresh
                  ? await onSessionFresh({
                      sourceJid: chatJid,
                      targetJid,
                      senderImId: senderOpenId,
                      notes: runtimeControl.notes,
                      // Lets the host resolve a private chat's own Session
                      // and never fall back to the main session for groups.
                      ...(normalizedChatType
                        ? { chatType: normalizedChatType }
                        : {}),
                    })
                  : '当前运行环境不支持 /fresh。';
              } else {
                reply = onSessionClear
                  ? await onSessionClear({
                      sourceJid: chatJid,
                      targetJid,
                      senderImId: senderOpenId,
                      // Lets the host resolve a private chat's own Session
                      // and never fall back to the main session for groups.
                      ...(normalizedChatType
                        ? { chatType: normalizedChatType }
                        : {}),
                    })
                  : '当前运行环境不支持 /clear。';
              }
            } else {
              reply = await onCommand!(
                chatJid,
                cmdBody,
                senderOpenId,
                mentions,
                routedMessageMeta,
              );
            }
            replyTarget = messageRouteTarget.raw;
            if (reply) {
              const pendingReply: FeishuSlashCommandCheckpoint = {
                ...executingCheckpoint,
                state: 'pending_reply',
                replyText: reply,
              };
              if (!writeNormalized(pendingReply)) {
                stopInboxHeartbeat(claim);
                logger.error(
                  { inboxId: claim.id, messageId, cmd: slashMatch[1] },
                  'Lost Feishu Inbox lease before command result checkpoint; refusing reply delivery',
                );
                return 'done';
              }
              retryableReply = pendingReply;
            } else if (!writeNormalized(null)) {
              stopInboxHeartbeat(claim);
              logger.warn(
                { inboxId: claim.id, messageId, cmd: slashMatch[1] },
                'Lost Feishu Inbox lease while clearing an unknown command checkpoint',
              );
              return 'done';
            }
          }
          logger.info(
            {
              chatJid,
              cmd: slashMatch[1],
              hasReply: !!reply,
              replyLen: reply?.length,
            },
            'Feishu slash command processed',
          );
          if (reply) {
            const sendingReply: FeishuSlashCommandCheckpoint = {
              version: 1,
              kind: 'feishu_slash_command',
              state: 'sending_reply',
              command: cmdBody,
              replyTarget,
              replyText: reply,
            };
            if (!writeNormalized(sendingReply)) {
              stopInboxHeartbeat(claim);
              logger.error(
                { inboxId: claim.id, messageId, cmd: slashMatch[1] },
                'Lost Feishu Inbox lease before command reply send checkpoint',
              );
              return 'done';
            }
            await sendTextToChat(replyTarget, reply, {
              uuidBase: ['feishu-slash-reply', claim.id],
            });
            const acknowledged: FeishuSlashCommandCheckpoint = {
              version: 1,
              kind: 'feishu_slash_command',
              state: 'reply_acknowledged',
              command: cmdBody,
              replyTarget,
              replyText: reply,
            };
            if (!writeNormalized(acknowledged)) {
              stopInboxHeartbeat(claim);
              logger.error(
                { inboxId: claim.id, messageId, cmd: slashMatch[1] },
                'Lost Feishu Inbox lease after command reply ACK; refusing an unfenced completion',
              );
              return 'done';
            }
            completeClaimedInbound(claim, payload);
            return 'done'; // 已知命令，拦截
          }
          // reply 为 null 表示未知命令，继续作为普通消息处理
        } catch (err) {
          const deliveryFailure = err instanceof FeishuTextDeliveryError;
          const rejectedBeforeAcceptance =
            deliveryFailure && err.outcome === 'rejected';
          logger.error(
            {
              chatJid,
              cmd: slashMatch[1],
              err,
              deliveryFailure,
              rejectedBeforeAcceptance,
            },
            'Feishu slash command failed',
          );
          if (!deliveryFailure) {
            try {
              await sendTextToChat(
                messageRouteTarget.raw,
                '⚠️ 命令执行失败，请稍后重试',
              );
            } catch (sendErr) {
              logger.error(
                { chatJid, sendErr },
                'Failed to send slash command error feedback',
              );
            }
          }
          if (rejectedBeforeAcceptance && retryableReply) {
            const safelyRequeued = writeNormalized(retryableReply);
            if (!safelyRequeued) {
              stopInboxHeartbeat(claim);
              logger.error(
                { inboxId: claim.id, messageId, cmd: slashMatch[1] },
                'Could not restore rejected slash-command reply checkpoint',
              );
              return 'done';
            }
            // The reply was refused before acceptance: resend it later, with
            // the same bounded backoff as any other intake failure.
            if (scheduleIntakeRetry(err) === 'terminal') {
              logger.error(
                { inboxId: claim.id, messageId, cmd: slashMatch[1] },
                'Feishu slash command reply kept being refused; giving up',
              );
            }
          } else if (deliveryFailure) {
            failClaimedInbound(
              claim,
              payload,
              new Error(
                `${err.message}; delivery outcome is uncertain and requires manual reconciliation`,
              ),
              false,
            );
            try {
              await sendTextToChat(
                messageRouteTarget.raw,
                '⚠️ 命令回复的投递结果未知，为避免重复发送，系统已停止自动重试，请人工核对。',
              );
            } catch (sendErr) {
              logger.error(
                { chatJid, messageId, sendErr },
                'Failed to send uncertain slash-command delivery notice',
              );
            }
          } else {
            // Command execution failures stay terminal because replaying
            // arbitrary command side effects is not safe.
            failClaimedInbound(claim, payload, err, false);
          }
          return 'done';
        }
      }

      // ── 群聊 Mention 过滤：require_mention / owner_mentioned 模式下过滤 ──
      // 决策由 evaluateMentionGate（src/feishu-mention-gate.ts）以纯函数形式给出，
      // 历史上这里曾因 botOpenId 缺失而 fail-open 静默失效；新版 fail-closed，
      // 并通过 ensureBotOpenIdFresh() 触发后台 lazy refetch 自愈。
      {
        const decision = evaluateMentionGate({
          chatType: normalizedChatType,
          botOpenId,
          mentions: mentions as MentionGateMention[] | undefined,
          chatJid,
          senderOpenId,
          shouldProcessGroupMessage,
          isGroupOwnerMessage,
          conversationPlan,
        });
        if (!decision.allow) {
          if (decision.reason === 'bot_open_id_missing') {
            // 触发后台 lazy refetch（节流由函数内部保证），不阻塞当前消息
            void ensureBotOpenIdFresh('mention-gate-fallback');
            // warn 日志按 5 分钟节流，避免 botOpenId 长时间缺失时刷屏
            const now = Date.now();
            botInfoMissingDroppedSinceLastWarn++;
            if (
              now - lastBotInfoMissingWarnAt >=
              BOT_INFO_MISSING_WARN_INTERVAL_MS
            ) {
              logger.warn(
                {
                  chatJid,
                  messageId,
                  droppedSinceLastWarn: botInfoMissingDroppedSinceLastWarn,
                },
                'Dropping group messages: bot open_id unknown (fail-closed). Triggered lazy refetch.',
              );
              lastBotInfoMissingWarnAt = now;
              botInfoMissingDroppedSinceLastWarn = 0;
            } else {
              logger.debug(
                { chatJid, messageId },
                'Dropped group message: bot open_id missing (warn throttled)',
              );
            }
          } else if (decision.reason === 'not_mentioned') {
            logger.debug(
              { chatJid, messageId },
              'Dropped group message: mention required but bot not mentioned',
            );
          } else if (decision.reason === 'not_owner') {
            logger.debug(
              { chatJid, messageId, senderOpenId },
              'Dropped group message: owner_mentioned mode, sender is not owner',
            );
          } else {
            logger.debug(
              { chatJid, messageId },
              'Dropped Feishu message: activation mode is disabled',
            );
          }
          ignoreClaimedInbound(
            claim,
            payload,
            `mention_gate:${decision.reason}`,
          );
          return 'done';
        }
      }

      // Feishu requires @bot in mention-gated groups, but the durable human
      // text should contain the actual request. Strip only the leading bot
      // token proven by Feishu mention metadata; other @mentions remain.
      if (chatType === 'group') {
        text = stripLeadingBotMention(
          text,
          botOpenId,
          mentions as MentionGateMention[] | undefined,
        );
      }

      // Validate the binding before registration, owner learning, metadata or
      // attachment downloads. The title/context metadata available here is
      // sufficient for native-thread routing; downloaded paths are payload.
      //
      // Group chats get an external ownership signal before their first
      // message can ever arrive here (im.chat.member.bot.added_v1 →
      // onBotAddedToGroup, wired to the same onNewChat below), so the route
      // check below can safely fail-closed on an unregistered group chat —
      // it should never actually be unregistered by the time a message
      // shows up. P2P chats have no equivalent bootstrap event: the first
      // DM IS the "bot added" signal (mirrors the "/pair establishes
      // ownership before routing" contract other channels use — see
      // channel-admission.ts). Without this, resolveAdmittedChannelRoute
      // would fail-closed on every message from a brand-new P2P chat
      // forever, since registration (below) never gets a chance to run.
      // onNewChat/onP2pSender are idempotent no-ops once already
      // registered, so calling them again in their normal position below
      // is safe and keeps this bootstrap narrowly scoped to P2P.
      //
      // resolveEffectiveChatJid is wrapped per-account by im-manager, which
      // throws ChannelRouteRejectedError instead of returning null for an
      // unbound chat (see im-manager.ts). A bare `!resolveEffectiveChatJid(...)`
      // check never observes that falsy case — the throw unwinds straight to
      // the outer catch below, onNewChat never runs, and the chat can never
      // register. Treat that specific rejection the same as a null return.
      if (chatType === 'p2p' && resolveEffectiveChatJid) {
        let alreadyBound = false;
        try {
          alreadyBound = !!resolveEffectiveChatJid(chatJid);
        } catch (err) {
          if (!(err instanceof ChannelRouteRejectedError)) throw err;
        }
        if (!alreadyBound) {
          onNewChat?.(chatJid, resolvedChatName);
          if (senderOpenId && onP2pSender) {
            onP2pSender(senderOpenId);
          }
        }
      }

      const admittedRoute = (() => {
        try {
          return resolveAdmittedChannelRoute<FeishuMessageMeta>(
            chatJid,
            resolveEffectiveChatJid,
            { ...routedMessageMeta, text },
          );
        } catch (err) {
          if (err instanceof ChannelRouteRejectedError) return null;
          throw err;
        }
      })();
      if (!admittedRoute) {
        logger.warn(
          { chatJid, messageId, source },
          'Feishu binding resolver rejected route; ignoring without retry',
        );
        ignoreClaimedInbound(claim, payload, 'binding_rejected');
        return 'done';
      }
      const agentRouting = admittedRoute.routing;
      // Backfill re-created an Inbox row for a message at/before the cursor:
      // its old row may have been pruned after it already ran. The permanent
      // message table is the proof, keyed by the admitted target.
      if (
        payload.backfilledBeforeCursor &&
        getMessage(admittedRoute.targetJid, messageId)
      ) {
        logger.info(
          { chatJid, messageId, targetJid: admittedRoute.targetJid },
          'Skipped backfilled Feishu message that was already ingested',
        );
        ignoreClaimedInbound(claim, payload, 'already_ingested');
        return 'done';
      }

      // Known commands and rejected messages returned above. Only an admitted
      // textual direct child may spend a message.get lookup to prove that its
      // root is a merge_forward from the same sender.
      if (!contentLink) {
        contentLink = await forwardBundles.resolveCompanion(forwardCandidate);
      }

      const cachedForwardRootMaterial =
        contentLink?.kind === 'forward_bundle'
          ? getForwardBundleRootMaterial(
              admittedRoute.targetJid,
              contentLink.bundleId,
              senderOpenId,
            )
          : null;
      const reuseCurrentForwardRoot =
        contentLink?.role === 'forwarded_content' &&
        forwardAttempt > 1 &&
        cachedForwardRootMaterial !== null;
      if (cachedForwardRootMaterial) {
        logger.info(
          {
            messageId,
            bundleId: contentLink?.bundleId,
            role: contentLink?.role,
            source: 'database',
          },
          'Reused durable merged-forward material',
        );
      }

      // Event payloads intentionally contain only a lossy placeholder for
      // cards and merged forwards. Resolve their complete user-facing content
      // and bounded quoted context only after audience, mention and binding
      // admission, so rejected messages cannot consume tenant API quota.
      let enriched: Awaited<ReturnType<typeof enrichFeishuInboundContent>>;
      if (reuseCurrentForwardRoot) {
        enriched = {
          text: cachedForwardRootMaterial.content,
          richMessageResolved: true,
          referencedMessages: 0,
          currentMaterialResolved: true,
        };
      } else {
        enriched = await enrichFeishuInboundContent({
          client: client as unknown as Parameters<
            typeof enrichFeishuInboundContent
          >[0]['client'],
          messageId,
          messageType,
          fallbackText: text,
          fallbackImageKeys: extracted.imageKeys,
          parentId,
          nativeRootId: rootId,
          threadId,
          // A cached root is already a complete durable reference. Avoid a
          // second provider read whose timeout used to split one forward.
          limits: {
            ...(contentLink?.role === 'forwarder_comment' &&
            cachedForwardRootMaterial
              ? { maxReferenceDepth: 0 }
              : threadId
                ? { maxReferenceDepth: 1 }
                : {}),
            ...(messageType === 'merge_forward' ||
            (contentLink?.kind === 'forward_bundle' &&
              contentLink.role === 'forwarder_comment' &&
              !cachedForwardRootMaterial)
              ? {
                  requestTimeoutMs: FEISHU_FORWARD_CONTENT_REQUEST_TIMEOUT_MS,
                  totalTimeoutMs: FEISHU_FORWARD_CONTENT_TOTAL_TIMEOUT_MS,
                }
              : {}),
          },
          parseContent: (type, content) => extractMessageContent(type, content),
        });
      }
      if (
        contentLink?.role === 'forwarder_comment' &&
        cachedForwardRootMaterial &&
        !enriched.references?.some(
          (reference) => reference.id === contentLink!.bundleId,
        )
      ) {
        enriched = {
          ...enriched,
          references: [
            ...(enriched.references ?? []),
            {
              id: cachedForwardRootMaterial.id,
              sender: cachedForwardRootMaterial.senderName,
              text: cachedForwardRootMaterial.content,
              materialResolved: true,
            },
          ],
          referencedMessages: enriched.referencedMessages + 1,
        };
      }
      text = enriched.text;
      if (contentLink?.kind === 'rapid_topic_bundle') {
        // This Feishu composer shape wraps its plain-text companion in a
        // literal <p>...</p>. Keep that transport artifact out of Agent prompts
        // and queue cards without changing ordinary text-message semantics.
        text = unwrapFeishuParagraphText(text);
      }
      extracted = {
        ...extracted,
        text,
        imageKeys: enriched.imageKeys,
      };
      if (enriched.richMessageResolved || enriched.referencedMessages > 0) {
        logger.debug(
          {
            messageId,
            messageType,
            richMessageResolved: enriched.richMessageResolved,
            referencedMessages: enriched.referencedMessages,
          },
          'Enriched admitted Feishu message content',
        );
      }

      // The chat is registered by now (binding admission passed). Only a
      // real name may update it; an empty name keeps the stored one.
      onNewChat?.(chatJid, knownChatName);
      if (chatType === 'p2p' && senderOpenId && onP2pSender) {
        onP2pSender(senderOpenId);
      }
      lastMessageIdByChat.set(chatId, messageId);
      const resolvedCreateTimeMs = createTimeMs > 0 ? createTimeMs : Date.now();
      let timestamp = new Date(resolvedCreateTimeMs).toISOString();

      let attachmentsJson: string | undefined =
        cachedForwardRootMaterial &&
        (reuseCurrentForwardRoot || contentLink?.role === 'forwarder_comment')
          ? (cachedForwardRootMaterial.attachments ?? undefined)
          : undefined;
      let currentForwardMaterialResolved =
        contentLink?.role === 'forwarded_content' &&
        enriched.currentMaterialResolved === true;

      // ── 附件下载（已通过白名单 + mention 门控后才执行）──
      // 安全：未授权发送者 / 未 @bot 的群消息已在上面 return，绝不会触发图片/
      // 文件下载落盘或对飞书 API 的拉取（防止未授权资源消耗 / SSRF 式拉取）。
      const currentImageKeys = extracted.imageKeys ?? [];
      const currentImageRefs =
        enriched.currentImageRefs ??
        currentImageKeys.map((imageKey) => ({ messageId, imageKey }));
      const referencedImageRefs = enriched.referencedImageRefs ?? [];
      const referencedMessages: ChannelReferencedMessage[] = (
        enriched.references ?? []
      ).map((reference) => ({
        ...reference,
        ...(contentLink?.role === 'forwarder_comment' &&
        reference.id === contentLink.bundleId
          ? {
              contentLink: {
                kind: contentLink.kind,
                bundleId: contentLink.bundleId,
                role: 'forwarded_content' as const,
                relatedMessageId: messageId,
              },
            }
          : {}),
      }));
      const replaceReferenceMarker = (
        referenceMessageId: string,
        marker: string,
        replacement: string,
        attachmentIndex?: number,
      ): void => {
        const reference = referencedMessages.find(
          (item) =>
            item.id === referenceMessageId && item.text.includes(marker),
        );
        if (!reference) return;
        reference.text = reference.text.replace(marker, replacement);
        reference.attachmentHints = [
          ...(reference.attachmentHints ?? []),
          replacement,
        ];
        if (attachmentIndex !== undefined) {
          reference.attachmentIndexes = [
            ...(reference.attachmentIndexes ?? []),
            attachmentIndex,
          ];
        }
      };
      // Attachments land in the workspace that admitted this message. The
      // folder comes from the admitted route (the same mount the message is
      // delivered to), resolved once, never re-read from legacy fields after
      // the slow lookups above.
      const needsAttachmentFolder =
        currentImageRefs.length > 0 ||
        referencedImageRefs.length > 0 ||
        Boolean(extracted.fileInfos?.length);
      const attachmentFolder = needsAttachmentFolder
        ? resolveAttachmentFolder(admittedRoute.targetJid, chatJid)
        : undefined;
      if (currentImageRefs.length > 0 || referencedImageRefs.length > 0) {
        // 图片消息：下载后双轨处理
        // 1. Vision 通道：base64 附件供模型看图
        // 2. 存盘通道：写入工作区文件，agent 可直接操作（压缩、发送等）
        const attachments = [];
        const groupFolder = attachmentFolder;
        const savedPaths: string[] = [];
        let downloadedCurrentImages = 0;

        for (const imageRef of currentImageRefs) {
          const { imageKey } = imageRef;
          const imageData = await downloadFeishuImage(
            imageRef.messageId,
            imageKey,
          );
          if (!imageData) continue;
          downloadedCurrentImages++;

          // Vision 附件
          attachments.push({
            type: 'image',
            data: imageData.base64,
            mimeType: imageData.mimeType,
          });

          // 存盘：扩展名从 mimeType 推断，对齐文件消息处理逻辑
          if (groupFolder) {
            const extMap: Record<string, string> = {
              'image/jpeg': '.jpg',
              'image/png': '.png',
              'image/gif': '.gif',
              'image/webp': '.webp',
              'image/bmp': '.bmp',
              'image/tiff': '.tiff',
            };
            const ext = extMap[imageData.mimeType] ?? '.jpg';
            const fileName = `feishu_img_${imageKey.slice(-8)}${ext}`;
            try {
              const relPath = await saveDownloadedFile(
                groupFolder,
                'feishu',
                fileName,
                Buffer.from(imageData.base64, 'base64'),
              );
              if (relPath) savedPaths.push(relPath);
            } catch (err) {
              logger.warn(
                { err, imageKey },
                'Failed to save Feishu image to disk',
              );
            }
          }
        }

        // Referenced images must be downloaded against the message that owns
        // the image key, not the current event. The normalized text carries a
        // stable marker so the saved path stays associated with the correct
        // quoted message while the same bytes are also supplied to vision.
        for (const ref of referencedImageRefs) {
          const imageData = await downloadFeishuImage(
            ref.messageId,
            ref.imageKey,
          );
          if (!imageData) {
            const failedReference = referencedMessages.find(
              (item) => item.id === ref.referenceMessageId,
            );
            if (failedReference) failedReference.materialResolved = false;
            replaceReferenceMarker(
              ref.referenceMessageId,
              ref.marker,
              '[引用图片下载失败]',
            );
            continue;
          }
          const attachmentIndex = attachments.length;
          attachments.push({
            type: 'image',
            data: imageData.base64,
            mimeType: imageData.mimeType,
          });
          let replacement = '[引用图片]';
          if (groupFolder) {
            const extMap: Record<string, string> = {
              'image/jpeg': '.jpg',
              'image/png': '.png',
              'image/gif': '.gif',
              'image/webp': '.webp',
              'image/bmp': '.bmp',
              'image/tiff': '.tiff',
            };
            const ext = extMap[imageData.mimeType] ?? '.jpg';
            const fileName = `feishu_ref_${ref.imageKey.slice(-8)}${ext}`;
            try {
              const relPath = await saveDownloadedFile(
                groupFolder,
                'feishu',
                fileName,
                Buffer.from(imageData.base64, 'base64'),
              );
              if (relPath) replacement = `[引用图片: ${relPath}]`;
            } catch (err) {
              logger.warn(
                { err, messageId: ref.messageId, imageKey: ref.imageKey },
                'Failed to save referenced Feishu image to disk',
              );
            }
          }
          replaceReferenceMarker(
            ref.referenceMessageId,
            ref.marker,
            replacement,
            attachmentIndex,
          );
        }

        // 拼接图片标记：成功下载的用路径，失败的用占位符，确保 text 不为空。
        // 否则长图/超大图片下载失败时会落入 agent 的空消息分支，回复"消息是空的"。
        const failedCount = currentImageRefs.length - downloadedCurrentImages;
        if (
          messageType === 'image' &&
          contentLink?.role === 'forwarded_content' &&
          currentImageRefs.length > 0 &&
          failedCount === 0
        ) {
          currentForwardMaterialResolved = true;
        }
        if (failedCount > 0) currentForwardMaterialResolved = false;
        const markers: string[] = [];
        if (attachments.length > 0) {
          attachmentsJson = JSON.stringify(attachments);
        }
        if (downloadedCurrentImages > 0) {
          if (savedPaths.length > 0) {
            markers.push(...savedPaths.map((p) => `[图片: ${p}]`));
          } else {
            markers.push('[图片]');
          }
        }
        if (failedCount > 0) {
          markers.push(
            `[图片下载失败: ${failedCount} 张，可能超过飞书接口限制或网络异常]`,
          );
          logger.warn(
            {
              chatJid,
              messageId,
              failedCount,
              totalKeys: currentImageRefs.length,
            },
            'Feishu image download failed for some or all images',
          );
        }
        const imgMarker = markers.join('\n');
        if (imgMarker) {
          text = text ? `${imgMarker}\n${text}` : imgMarker;
        }
      }
      if (extracted.fileInfos && extracted.fileInfos.length > 0) {
        // 文件消息：下载到磁盘，路径内联替换
        logger.info(
          {
            chatJid,
            messageId,
            messageType,
            fileCount: extracted.fileInfos.length,
          },
          'Processing Feishu file download',
        );
        const groupFolder = attachmentFolder;
        if (!groupFolder) {
          assertIntakeLive();
          logger.warn(
            { chatJid },
            'Cannot resolve group folder for file download',
          );
          for (const fi of extracted.fileInfos) {
            const safeFilename = sanitizeImFilename(fi.filename || fi.fileKey);
            const placeholder = `[文件: ${safeFilename}]`;
            text = text.replace(placeholder, `[文件下载失败: ${safeFilename}]`);
          }
        } else {
          for (const fi of extracted.fileInfos) {
            const safeFilename = sanitizeImFilename(fi.filename || fi.fileKey);
            const relPath = await downloadFeishuFileToDisk(
              messageId,
              fi.fileKey,
              fi.filename,
              groupFolder,
            );
            const placeholder = `[文件: ${safeFilename}]`;
            text = text.replace(
              placeholder,
              relPath
                ? `[文件: ${relPath}]`
                : `[文件下载失败: ${safeFilename}]`,
            );
          }
        }
      }

      // Downloads may have raced stop()/pause: replay instead of persisting a
      // message whose attachments silently degraded to "[下载失败]".
      assertIntakeLive();
      // Recalled during the lookups/downloads above: never hand it off.
      if (recalledMessageIds.has(messageId)) {
        if (contentLink?.role === 'forwarded_content') {
          cancelAwaitingForwardBundleRoot({
            chatJid: admittedRoute.targetJid,
            bundleId: contentLink.bundleId,
            sender: senderOpenId,
          });
        }
        logger.info(
          { chatJid, messageId },
          'Dropped a Feishu message recalled during intake',
        );
        ignoreClaimedInbound(claim, payload, 'recalled');
        return 'done';
      }

      const routeSourceJid =
        agentRouting?.sourceJid ??
        (messageRouteTarget.threadId || messageRouteTarget.rootMessageId
          ? feishuRouteToJid(messageRouteTarget, chatJid)
          : chatJid);

      // Store message and broadcast to WebSocket clients
      const targetJid = admittedRoute.targetJid;

      const targetAgentId = agentRouting?.agentId;
      if (
        contentLink?.kind === 'forward_bundle' &&
        contentLink.role === 'forwarded_content' &&
        !currentForwardMaterialResolved
      ) {
        logger.warn(
          {
            messageId,
            bundleId: contentLink.bundleId,
            forwardAttempt,
          },
          'Merged-forward material remained incomplete after enrichment',
        );
      }
      if (contentLink?.role === 'forwarded_content') {
        contentLink = {
          ...contentLink,
          ...(currentForwardMaterialResolved ? { materialResolved: true } : {}),
          ...(forwardAttempt > 1
            ? { defaultAction: 'summarize' as const }
            : {}),
        };
      }
      const channelContext = buildFeishuChannelTurnContext({
        appId: config.appId,
        configuredChannelAccountId: config.channelAccountId,
        bot: botPublicInfo,
        chat: {
          id: chatId,
          type: chatType,
          name: cachedChatInfo?.name || resolvedChatName,
          mode: cachedChatInfo?.chatMode,
          groupMessageType: cachedChatInfo?.groupMessageType,
        },
        message: {
          id: messageId,
          rootId: deliveryRootMessageId,
          parentId,
          threadId,
          type: messageType,
          contentLink,
          referencedMessages,
        },
        sender: {
          openId: senderOpenId,
          userId: senderUserId,
          unionId: senderUnionId,
          name: resolvedSenderName,
          tenantKey: senderTenantKey,
          type: senderType,
        },
        mentions,
        sourceJid: routeSourceJid,
        targetJid,
        sessionAgentId: targetAgentId,
      });
      const bundleCommentCarriesCompleteMaterial =
        contentLink?.role === 'forwarder_comment' &&
        referencedMessages.some(
          (reference) =>
            reference.id === contentLink!.bundleId &&
            (contentLink!.kind === 'rapid_topic_bundle'
              ? Boolean(reference.text.trim())
              : reference.materialResolved === true) &&
            reference.contentLink?.kind === contentLink!.kind &&
            reference.contentLink.bundleId === contentLink!.bundleId &&
            reference.contentLink.role === 'forwarded_content',
        );
      writeNormalized({
        version: 1,
        source,
        payload: { ...payload, content: text },
        route: { sourceJid: routeSourceJid, targetJid },
        channelContext,
      });
      const incompleteForwardLink =
        contentLink?.kind === 'forward_bundle' ? contentLink : null;
      const incompleteForwardMaterial =
        incompleteForwardLink !== null &&
        ((incompleteForwardLink.role === 'forwarded_content' &&
          !currentForwardMaterialResolved &&
          forwardAttempt > 1) ||
          (incompleteForwardLink.role === 'forwarder_comment' &&
            !bundleCommentCarriesCompleteMaterial));
      if (incompleteForwardMaterial) {
        if (forwardAttempt < FEISHU_FORWARD_MATERIAL_MAX_ATTEMPTS) {
          intake.forwardMaterialAttempt = forwardAttempt;
          persistIntake();
          requeueClaimedInbound(
            claim,
            payload,
            'Waiting for complete forwarded material',
            FEISHU_FORWARD_MATERIAL_RETRY_DELAY_MS,
          );
          logger.warn(
            {
              messageId,
              bundleId: incompleteForwardLink.bundleId,
              role: incompleteForwardLink.role,
              forwardAttempt,
            },
            'Deferred Agent execution until forwarded material is complete',
          );
          return 'deferred';
        }
        if (incompleteForwardLink.role === 'forwarder_comment') {
          // The user's own note always runs; it carries whatever material
          // could be read rather than being dropped with the forward.
          logger.warn(
            {
              messageId,
              bundleId: incompleteForwardLink.bundleId,
              forwardAttempt,
            },
            'Running merged-forward note with partial material',
          );
        } else {
          cancelAwaitingForwardBundleRoot({
            chatJid: targetJid,
            bundleId: incompleteForwardLink.bundleId,
            sender: senderOpenId,
          });
          ignoreClaimedInbound(claim, payload, 'forward_material_unavailable');
          try {
            await replyToFeishuMessage(
              messageId,
              'text',
              JSON.stringify({
                text: '⚠️ 暂时无法读取这条转发的完整内容，请稍后重新转发一次。',
              }),
              true,
              {
                uuid: physicalUuid(
                  ['feishu-forward-unavailable', claim.id],
                  'text',
                ),
              },
            );
          } catch (feedbackError) {
            logger.warn(
              {
                feedbackError,
                messageId,
                bundleId: incompleteForwardLink.bundleId,
              },
              'Failed to send terminal forwarded-material feedback',
            );
          }
          return 'done';
        }
      }

      const earlierBundleComment =
        contentLink?.role === 'forwarded_content'
          ? findForwardBundleCommentTail(
              targetJid,
              contentLink.bundleId,
              senderOpenId,
              timestamp,
            )
          : null;
      const coveringCommentMessageId =
        contentLink?.role === 'forwarded_content'
          ? findForwardBundleCoveringComment(
              targetJid,
              contentLink.bundleId,
              senderOpenId,
            )
          : null;
      const subsumedByMessageId =
        coveringCommentMessageId ??
        (forwardAttempt > 1 ? (earlierBundleComment?.id ?? null) : null);
      const awaitingForwardCompanion =
        contentLink?.kind === 'forward_bundle' &&
        contentLink.role === 'forwarded_content' &&
        forwardAttempt === 1 &&
        !earlierBundleComment &&
        !subsumedByMessageId;
      if (earlierBundleComment && !subsumedByMessageId) {
        // The note was admitted first but could not carry a complete copy of
        // the root. Keep the late root independently runnable by placing it
        // after the durable chat tail; its original provider time remains in
        // the rendered forwarded material/context rather than cursor order.
        timestamp = sequenceInboundTimestampAfterChatTail(targetJid, timestamp);
      }
      storeChatMetadata(targetJid, timestamp);
      storeMessageDirect(
        messageId,
        targetJid,
        senderOpenId,
        resolvedSenderName,
        text,
        timestamp,
        false,
        {
          attachments: attachmentsJson,
          sourceJid: routeSourceJid,
          channelContext,
          ...(awaitingForwardCompanion
            ? {
                meta: {
                  deliveryStatus: 'awaiting_companion' as const,
                  deliveryUpdatedAt: new Date().toISOString(),
                },
              }
            : subsumedByMessageId
              ? {
                  meta: {
                    deliveryStatus: 'subsumed' as const,
                    deliveryRunId: subsumedByMessageId,
                    deliveryUpdatedAt: new Date().toISOString(),
                  },
                }
              : {}),
        },
      );
      if (awaitingForwardCompanion) {
        onMessagePersisted?.(
          targetJid,
          {
            id: messageId,
            chat_jid: targetJid,
            source_jid: routeSourceJid,
            sender: senderOpenId,
            sender_name: resolvedSenderName,
            content: text,
            timestamp,
            attachments: attachmentsJson,
            channel_context: channelContext,
            delivery_status: 'awaiting_companion',
            delivery_updated_at: new Date().toISOString(),
          },
          targetAgentId ?? undefined,
        );
        intake.forwardMaterialAttempt = forwardAttempt;
        persistIntake();
        requeueClaimedInbound(
          claim,
          payload,
          'Waiting briefly for a merged-forward companion note',
          FEISHU_FORWARD_COMPANION_GRACE_MS,
        );
        logger.info(
          {
            chatJid,
            targetJid,
            messageId,
            waitMs: FEISHU_FORWARD_COMPANION_GRACE_MS,
          },
          'Merged-forward root held for an authored companion',
        );
        return 'deferred';
      }
      const followUp = subsumedByMessageId
        ? ({ disposition: 'started' } as const)
        : (onFollowUpMessage?.({
            targetJid,
            sourceJid: routeSourceJid,
            messageId,
            senderImId: senderOpenId,
            // Explicit composer commands remain authoritative. Structural
            // coalescing is decided by the scheduler, which can prove whether
            // the active query actually owns this bundle root before
            // interrupting it.
            requestedMode: requestedFollowUpMode,
            coalesceBundleId:
              !requestedFollowUpMode &&
              !slashMatch &&
              bundleCommentCarriesCompleteMaterial &&
              contentLink
                ? contentLink.bundleId
                : undefined,
          }) ?? { disposition: 'started' as const });
      if (
        contentLink?.kind === 'forward_bundle' &&
        contentLink.role === 'forwarder_comment'
      ) {
        const rootReleased = releaseAwaitingForwardBundleRoot({
          chatJid: targetJid,
          bundleId: contentLink.bundleId,
          sender: senderOpenId,
          queuedRunId:
            followUp.disposition === 'queued' ? followUp.runId : null,
          subsumedByMessageId:
            followUp.disposition === 'steered' ? messageId : null,
        });
        const rootInboxIgnored = ignoreDeferredChannelInbox({
          provider: 'feishu',
          accountId: reliabilityAccountId,
          externalMessageId: contentLink.bundleId,
          reason: `covered_by_forwarder_comment:${messageId}`,
        });
        logger.info(
          {
            chatJid,
            targetJid,
            messageId,
            bundleId: contentLink.bundleId,
            rootReleased,
            rootInboxIgnored,
            disposition: followUp.disposition,
          },
          'Merged-forward companion activated its durable root material',
        );
      }
      const deliveryFields = subsumedByMessageId
        ? {
            delivery_status: 'subsumed' as const,
            delivery_run_id: subsumedByMessageId,
            delivery_updated_at: new Date().toISOString(),
          }
        : followUp.disposition === 'queued'
          ? {
              delivery_mode: 'queue' as const,
              delivery_status: 'queued' as const,
              delivery_run_id: followUp.runId ?? null,
              delivery_updated_at: timestamp,
            }
          : followUp.disposition === 'steered'
            ? {
                delivery_mode: 'steer' as const,
                // Steering is a durable hand-off: the row stays queued until
                // the interrupted SDK query reports idle, then starts as the
                // next turn in the same session.
                delivery_status: 'queued' as const,
                delivery_run_id: followUp.runId ?? null,
                delivery_updated_at: timestamp,
              }
            : {};
      onMessagePersisted?.(
        targetJid,
        {
          id: messageId,
          chat_jid: targetJid,
          source_jid: routeSourceJid,
          sender: senderOpenId,
          sender_name: resolvedSenderName,
          content: text,
          timestamp,
          attachments: attachmentsJson,
          channel_context: channelContext,
          ...deliveryFields,
        },
        targetAgentId ?? undefined,
      );
      if (subsumedByMessageId) {
        // The indicator registry is keyed by the provider target the host
        // used (`oc_…#thread:…#root:…`), not by the scoped `feishu:` JID.
        await clearAckForInput(
          extractProviderTarget(routeSourceJid),
          messageId,
        ).catch((err) =>
          logger.debug(
            { err, messageId, subsumedByMessageId },
            'Failed to clear acknowledgement for covered forward root',
          ),
        );
        logger.info(
          { chatJid, targetJid, messageId, subsumedByMessageId },
          'Late merged-forward root preserved without redundant Agent turn',
        );
        completeClaimedInbound(claim, payload);
        return 'done';
      }
      if (followUp.disposition === 'queued') {
        onFollowUpsChanged?.(targetJid);
        logger.info(
          {
            chatJid,
            targetJid,
            messageId,
            position: followUp.position ?? 1,
          },
          'Feishu message queued behind active query',
        );
        renotifyRecallAfterHandOff(chatJid, messageId);
        completeClaimedInbound(claim, payload);
        return 'done';
      }
      notifyNewImMessage();

      if (agentRouting && agentRouting.agentId) {
        onAgentMessage?.(chatJid, agentRouting.agentId);
        logger.info(
          {
            chatJid,
            effectiveJid: targetJid,
            agentId: targetAgentId,
            sender: resolvedSenderName,
            messageId,
            source,
          },
          'Feishu message routed to conversation agent',
        );
      } else if (agentRouting) {
        // Routed to workspace main conversation (no agentId)
        logger.info(
          {
            chatJid,
            effectiveJid: targetJid,
            sender: resolvedSenderName,
            messageId,
            source,
          },
          'Feishu message routed to workspace main conversation',
        );
      } else {
        logger.info(
          { chatJid, sender: resolvedSenderName, messageId, source },
          'Feishu message stored',
        );
      }
      renotifyRecallAfterHandOff(chatJid, messageId);
      completeClaimedInbound(claim, payload);
      return 'done';
    } catch (err) {
      if (err instanceof FeishuIntakeRetiredError) {
        requeueClaimedInbound(
          claim,
          payload,
          err.message,
          FEISHU_INBOX_RETRY_DELAY_MS,
        );
        logger.info(
          { messageId, chatId, source, inboxId: claim.id },
          'Re-queued Feishu message: connection retired during intake',
        );
        return 'deferred';
      }
      const outcome = scheduleIntakeRetry(err);
      logger.error(
        {
          err,
          messageId,
          chatId,
          source,
          inboxId: claim.id,
          failures: intake.failures,
          outcome,
        },
        outcome === 'retry'
          ? 'Feishu message intake failed; durable Inbox scheduled a retry'
          : 'Feishu message intake kept failing; gave up',
      );
      // One notice when retrying starts (live messages only; backfilled old
      // messages do not interrupt the chat) and one when it ends for good.
      // Both go to the message's own topic, never a new top-level message.
      const notice =
        outcome === 'terminal'
          ? '⚠️ 这条消息多次处理失败，系统已停止自动重试，请稍后重新发送。'
          : intake.failures === 1 && source === 'ws'
            ? '⚠️ 消息处理暂时失败，系统将自动重试'
            : undefined;
      if (notice && failureNoticeTarget) {
        try {
          await sendTextToChat(failureNoticeTarget, notice, {
            uuidBase: ['feishu-intake-notice', claim.id, outcome],
          });
        } catch (sendErr) {
          logger.error(
            { chatId, messageId, sendErr },
            'Failed to send Feishu durable Inbox retry feedback',
          );
        }
      }
      return outcome === 'retry' ? 'deferred' : 'done';
    }
  }

  function rememberRecalledMessage(messageId: string): void {
    recalledMessageIds.delete(messageId);
    recalledMessageIds.add(messageId);
    while (recalledMessageIds.size > FEISHU_RECALLED_MESSAGE_CACHE) {
      const oldest = recalledMessageIds.values().next().value as
        | string
        | undefined;
      if (oldest === undefined) break;
      recalledMessageIds.delete(oldest);
    }
  }

  /**
   * The recall raced the hand-off: the host's earlier recall callback found
   * nothing to cancel because the input did not exist yet. Tell it again now
   * that the input is queued or running.
   */
  function renotifyRecallAfterHandOff(
    chatJid: string,
    messageId: string,
  ): void {
    if (!recalledMessageIds.has(messageId)) return;
    logger.info(
      { chatJid, messageId },
      'Feishu message was recalled during hand-off; notifying the host again',
    );
    void Promise.resolve(
      connectOptions?.onMessageRecalled?.(chatJid, messageId),
    ).catch((err) =>
      logger.warn(
        { err, chatJid, messageId },
        'Host recall handling failed after hand-off',
      ),
    );
  }

  /**
   * A user (or a group admin) recalled a message. A row that has not run yet
   * is closed here; a row that does not exist yet becomes a tombstone so a
   * late WS redelivery or backfill never runs it; a row in flight is caught
   * by the per-connection recall set before hand-off. The tombstone is
   * written even while inbound is paused/gated (under this connection's own
   * account scope). The host is told when the principal is admitted, so it
   * can cancel the queued input or break a batch that only contains it.
   */
  async function handleMessageRecalled(
    chatId: string | undefined,
    messageId: string | undefined,
  ): Promise<void> {
    if (!chatId || !messageId) return;
    rememberRecalledMessage(messageId);
    const rawJid = `feishu:${chatId}`;
    const chatJid = admitIncomingJid(rawJid);
    const deferring = isInboundDeferred();
    if (!chatJid && !deferring) return;
    const sourceJid =
      chatJid ??
      (config.channelAccountId
        ? scopeChannelJid(rawJid, config.channelAccountId)
        : rawJid);
    try {
      const closed = ignoreDeferredChannelInbox({
        provider: 'feishu',
        accountId: reliabilityAccountId,
        externalMessageId: messageId,
        reason: 'recalled',
      });
      if (!closed) {
        const recorded = recordChannelInbox({
          provider: 'feishu',
          accountId: reliabilityAccountId,
          externalMessageId: messageId,
          sourceJid,
          chatId,
          status: 'received',
        });
        if (recorded.created) {
          transitionChannelInbox(recorded.item.id, 'received', 'ignored', {
            error: 'recalled',
          });
        }
      }
    } catch (err) {
      logger.warn(
        { err, chatId, messageId },
        'Failed to close the durable Inbox row of a recalled Feishu message',
      );
    }
    logger.info({ chatJid: sourceJid, messageId }, 'Feishu message recalled');
    if (chatJid) await connectOptions?.onMessageRecalled?.(chatJid, messageId);
  }

  /**
   * The chat type decides mention and runtime-control eligibility, and the
   * REST list API does not return it. Never guess `group`: use what this
   * process saw, the persisted chat mode, or ask Feishu (cached).
   */
  async function resolveBackfillChatType(
    chatId: string,
    budget: BackfillBudget,
  ): Promise<'p2p' | 'group' | undefined> {
    const cached = chatTypeById.get(chatId);
    if (cached) return cached;
    const info = chatInfoById.get(chatId);
    let resolved = feishuChatTypeFromMode(info?.chatMode, info?.chatType);
    if (!resolved) {
      const jid = admitIncomingJid(`feishu:${chatId}`);
      if (jid) {
        try {
          resolved = feishuChatTypeFromMode(
            getRegisteredGroup(jid)?.feishu_chat_mode,
          );
        } catch {
          // Isolated transport tests may run without the application DB.
        }
      }
    }
    if (!resolved && spendBackfillCall(budget)) {
      const live = await connection.getChatInfo(chatId);
      resolved = feishuChatTypeFromMode(live?.chat_mode, live?.chat_type);
    }
    if (resolved) chatTypeById.set(chatId, resolved);
    return resolved;
  }

  interface BackfillBudget {
    remaining: number;
    exhausted: boolean;
  }

  function spendBackfillCall(budget: BackfillBudget): boolean {
    if (budget.remaining <= 0) {
      budget.exhausted = true;
      return false;
    }
    budget.remaining--;
    return true;
  }

  interface BackfillListing {
    items: IncomingMessagePayload[];
    /** Older in-window messages were left unfetched (page cap reached). */
    truncated: boolean;
    /** Lower bound of the unfetched in-window messages when truncated. */
    missed: number;
    missedMore: boolean;
  }

  /**
   * Page one container newest-first back to `sinceMs`. Chat containers are
   * time-filtered by Feishu; thread containers are not, so their pages are
   * cut client-side. Stops at the page cap and reports what was left.
   */
  async function listBackfillContainer(input: {
    containerType: 'chat' | 'thread';
    containerId: string;
    chatId: string;
    chatType: 'p2p' | 'group' | undefined;
    sinceMs: number;
    maxPages: number;
    generation: number;
    budget: BackfillBudget;
  }): Promise<BackfillListing | undefined> {
    const nowSec = Math.floor(Date.now() / 1000);
    const baseParams = {
      container_id_type: input.containerType,
      container_id: input.containerId,
      sort_type: 'ByCreateTimeDesc' as const,
      page_size: BACKFILL_PAGE_SIZE,
      ...(input.containerType === 'chat'
        ? {
            start_time: String(Math.max(0, Math.floor(input.sinceMs / 1000))),
            end_time: String(nowSec),
          }
        : {}),
    };
    const items: IncomingMessagePayload[] = [];
    let pageToken: string | undefined;
    const fetchPage = async () => {
      const activeClient = client;
      if (!activeClient || input.generation !== wsConnectionGeneration) {
        return undefined;
      }
      if (!spendBackfillCall(input.budget)) return undefined;
      const params = {
        ...baseParams,
        ...(pageToken ? { page_token: pageToken } : {}),
      };
      // Rate limits are waited out with the shared bounded backoff; a limit
      // that persists fails this chat's pass (retried next round) instead of
      // being swallowed as "no messages".
      const response = (await withFeishuRateLimitRetry(() =>
        activeClient.im.v1.message.list({ params }),
      )) as {
        data?: { items?: unknown[]; has_more?: boolean; page_token?: string };
      };
      const raw = Array.isArray(response?.data?.items)
        ? response.data.items
        : [];
      let reachedWindowStart = false;
      const inWindow: IncomingMessagePayload[] = [];
      for (const item of raw) {
        const createdAt = feishuEpochMsOf(item);
        if (createdAt > 0 && createdAt < input.sinceMs) {
          reachedWindowStart = true;
          continue;
        }
        const normalized = normalizeListApiMessage(item, {
          chatId: input.chatId,
          chatType: input.chatType,
          ...(input.containerType === 'thread'
            ? { threadId: input.containerId }
            : {}),
        });
        if (normalized) inWindow.push(normalized);
      }
      const nextToken =
        response?.data?.has_more && response.data.page_token
          ? response.data.page_token
          : undefined;
      return { inWindow, reachedWindowStart, nextToken };
    };
    for (let page = 0; ; page++) {
      const result = await fetchPage();
      if (!result) return undefined;
      items.push(...result.inWindow);
      if (!result.nextToken || result.reachedWindowStart) {
        return { items, truncated: false, missed: 0, missedMore: false };
      }
      pageToken = result.nextToken;
      if (page + 1 >= input.maxPages) {
        // One count-only page gives the chat notice a real lower bound. If
        // it already reaches the window start, its messages are simply kept.
        const extra = await fetchPage();
        if (!extra) return undefined;
        if (!extra.nextToken || extra.reachedWindowStart) {
          items.push(...extra.inWindow);
          return { items, truncated: false, missed: 0, missedMore: false };
        }
        return {
          items,
          truncated: true,
          missed: extra.inWindow.length,
          missedMore: Boolean(extra.nextToken) && !extra.reachedWindowStart,
        };
      }
    }
  }

  /** Recently active topics of each chat, from durable per-thread cursors. */
  function loadActiveThreadCursors(): Map<string, ChannelCursor[]> {
    const byChat = new Map<string, ChannelCursor[]>();
    let cursors: ChannelCursor[] = [];
    try {
      cursors = listChannelCursors({
        provider: 'feishu',
        accountId: reliabilityAccountId,
        limit: 10_000,
      });
    } catch {
      return byChat;
    }
    const activeSince = Date.now() - BACKFILL_THREAD_ACTIVE_WINDOW_MS;
    for (const cursor of cursors) {
      if (cursor.scope !== FEISHU_THREAD_CURSOR_SCOPE || !cursor.chatId) {
        continue;
      }
      if (cursor.position < activeSince) continue;
      const separator = cursor.chatId.indexOf('#thread:');
      if (separator <= 0) continue;
      const chatId = cursor.chatId.slice(0, separator);
      const list = byChat.get(chatId) ?? [];
      list.push(cursor);
      byChat.set(chatId, list);
    }
    return byChat;
  }

  async function notifyBackfillGap(
    chatId: string,
    missed: number,
    missedMore: boolean,
    gapKey: string,
  ): Promise<void> {
    if (backfillGapNotified.has(gapKey)) return;
    backfillGapNotified.add(gapKey);
    const chatJid = admitIncomingJid(`feishu:${chatId}`);
    if (!chatJid || connectOptions?.isChatBound?.(chatJid) === false) return;
    const count = missed > 0 ? `${missed}${missedMore ? '+' : ''} 条` : '部分';
    try {
      await sendTextToChat(
        chatId,
        `⚠️ 离线期间本会话消息较多，有 ${count}较早的离线消息未补回，如需处理请重新发送。`,
        { uuidBase: ['feishu-backfill-gap', gapKey] },
      );
    } catch (err) {
      logger.warn(
        { err, chatId },
        'Failed to notify the chat about unrecovered offline messages',
      );
    }
  }

  async function backfillChatMessages(
    chatId: string,
    chatCursor: ChannelCursor | undefined,
    threadCursors: ChannelCursor[],
    generation: number,
    budget: BackfillBudget,
  ): Promise<void> {
    if (!client) return;
    const chatType = await resolveBackfillChatType(chatId, budget);
    const sinceMs = chatCursor
      ? Math.max(0, chatCursor.position - BACKFILL_LOOKBACK_MS)
      : Math.max(0, Date.now() - BACKFILL_LOOKBACK_MS);
    const chatListing = await listBackfillContainer({
      containerType: 'chat',
      containerId: chatId,
      chatId,
      chatType,
      sinceMs,
      maxPages: BACKFILL_MAX_PAGES_PER_CHAT,
      generation,
      budget,
    });
    if (!chatListing) return;
    if (!chatType && chatListing.items.some((item) => !item.chatType)) {
      // Without a trusted type, mention and runtime-control gates would be
      // judged wrongly (a private chat read as a group, or the reverse).
      // Leave the cursor alone; a later pass retries.
      logger.warn({ chatId }, 'Skipping Feishu backfill: chat type is unknown');
      return;
    }
    const listedChatType =
      chatType ??
      chatListing.items.find(
        (
          item,
        ): item is IncomingMessagePayload & { chatType: 'p2p' | 'group' } =>
          item.chatType === 'p2p' || item.chatType === 'group',
      )?.chatType;
    let missed = chatListing.truncated ? chatListing.missed : 0;
    let missedMore = chatListing.truncated && chatListing.missedMore;

    // Topic replies are only listed by their thread container: topics whose
    // root appeared in this window, plus topics active shortly before it.
    const threadSince = new Map<string, number>();
    for (const item of chatListing.items) {
      if (!item.threadId) continue;
      const previous = threadSince.get(item.threadId);
      threadSince.set(
        item.threadId,
        Math.min(previous ?? Number.POSITIVE_INFINITY, item.createTimeMs),
      );
    }
    for (const cursor of [...threadCursors].sort(
      (a, b) => b.position - a.position,
    )) {
      const threadId = cursor.chatId!.slice(
        cursor.chatId!.indexOf('#thread:') + '#thread:'.length,
      );
      if (!threadId) continue;
      const since = Math.max(0, cursor.position - BACKFILL_LOOKBACK_MS);
      const previous = threadSince.get(threadId);
      threadSince.set(
        threadId,
        Math.min(previous ?? Number.POSITIVE_INFINITY, since),
      );
    }
    // Topic containers are scanned only for bound topic groups: elsewhere
    // threads share the chat's session (or the chat is not ours to answer),
    // and every topic costs at least one list call.
    const chatJid = admitIncomingJid(`feishu:${chatId}`);
    const scanTopics =
      Boolean(listedChatType) &&
      chatJid !== null &&
      connectOptions?.isChatBound?.(chatJid) !== false &&
      feishuTopicChatState(chatId) === 'topic';
    const threads = scanTopics
      ? [...threadSince.entries()].slice(0, BACKFILL_MAX_THREADS_PER_CHAT)
      : [];
    if (scanTopics && threadSince.size > threads.length) {
      logger.warn(
        { chatId, threads: threadSince.size, limit: threads.length },
        'Feishu backfill limited the number of topics scanned',
      );
    }
    const pending = new Map<string, IncomingMessagePayload>();
    for (const item of chatListing.items) pending.set(item.messageId, item);
    for (const [threadId, since] of threads) {
      let listing: BackfillListing | undefined;
      try {
        listing = await listBackfillContainer({
          containerType: 'thread',
          containerId: threadId,
          chatId,
          chatType: listedChatType,
          sinceMs: since,
          maxPages: BACKFILL_MAX_PAGES_PER_THREAD,
          generation,
          budget,
        });
      } catch (err) {
        const kind = classifyFeishuCardError(err).kind;
        if (kind === 'rate_limited' || kind === 'transient') {
          // Do not process the chat with a hole in it: the whole pass is
          // retried next round, cursors untouched.
          throw err;
        }
        logger.warn(
          { err, chatId, threadId },
          'Feishu refused a topic backfill; skipping that topic',
        );
        continue;
      }
      // Budget exhausted or the connection retired: retry the chat later.
      if (!listing) return;
      for (const item of listing.items) {
        if (!pending.has(item.messageId)) pending.set(item.messageId, item);
      }
      if (listing.truncated) {
        missed += listing.missed;
        missedMore = missedMore || listing.missedMore;
      }
    }

    // The provider paginates newest-first. Execute oldest-first so per-chat
    // ordering holds across pages and containers.
    const ordered = [...pending.values()].sort((a, b) => {
      const byTime = a.createTimeMs - b.createTimeMs;
      return byTime || a.messageId.localeCompare(b.messageId);
    });
    if (missed > 0 || missedMore) {
      const oldestFetched = ordered[0]?.messageId ?? 'none';
      logger.warn(
        { chatId, fetched: ordered.length, missed, missedMore },
        'Feishu backfill hit its page cap; older offline messages were not recovered',
      );
      await notifyBackfillGap(
        chatId,
        missed,
        missedMore,
        `${chatId}:${oldestFetched}`,
      );
    }
    const replayHorizon = Date.now() - BACKFILL_REPLAY_HORIZON_MS;
    let skippedBeyondHorizon = 0;
    for (const message of ordered) {
      // stop() or a reconnect retired this pass while pages were in flight;
      // the next connection's backfill covers these messages again.
      if (generation !== wsConnectionGeneration || !connectOptions) return;
      const atOrBeforeCursor =
        chatCursor !== undefined &&
        message.createTimeMs > 0 &&
        message.createTimeMs <= chatCursor.position;
      if (atOrBeforeCursor && message.createTimeMs < replayHorizon) {
        // Its Inbox row may be pruned already: never replay it.
        skippedBeyondHorizon++;
        continue;
      }
      await handleIncomingMessage(
        atOrBeforeCursor
          ? { ...message, backfilledBeforeCursor: true }
          : message,
        'backfill',
      );
    }
    if (skippedBeyondHorizon > 0) {
      logger.info(
        { chatId, skipped: skippedBeyondHorizon },
        'Feishu backfill skipped old messages at/before the durable cursor',
      );
    }
  }

  function parseRecoveredInbox(
    claim: ClaimedChannelInboxItem,
  ):
    | { source: 'ws' | 'backfill'; payload: IncomingMessagePayload }
    | undefined {
    const raw = claim.rawPayload;
    if (!raw || typeof raw !== 'object') return undefined;
    const envelope = raw as {
      source?: unknown;
      payload?: Partial<IncomingMessagePayload>;
    };
    if (
      (envelope.source !== 'ws' && envelope.source !== 'backfill') ||
      !envelope.payload ||
      typeof envelope.payload.chatId !== 'string' ||
      !envelope.payload.chatId.trim() ||
      typeof envelope.payload.messageId !== 'string' ||
      !envelope.payload.messageId.trim() ||
      typeof envelope.payload.createTimeMs !== 'number' ||
      typeof envelope.payload.messageType !== 'string' ||
      !envelope.payload.messageType.trim() ||
      typeof envelope.payload.content !== 'string'
    ) {
      return undefined;
    }
    return {
      source: envelope.source,
      payload: envelope.payload as IncomingMessagePayload,
    };
  }

  async function recoverQueuedInbox(reason: string): Promise<void> {
    let recovered = 0;
    let deferred = 0;
    for (
      let iteration = 0;
      iteration < FEISHU_INBOX_RECOVERY_LIMIT;
      iteration++
    ) {
      if (!connectOptions) return;
      if (isInboundDeferred()) {
        // Nothing is claimed while the gate is closed.
        waitForInboundGate();
        break;
      }
      let claim: ClaimedChannelInboxItem | undefined;
      try {
        claim = claimNextChannelInbox(inboxOwner, FEISHU_INBOX_LEASE_MS, {
          provider: 'feishu',
          accountId: reliabilityAccountId,
        });
      } catch (err) {
        logger.warn(
          { err, reason, accountId: reliabilityAccountId },
          'Unable to recover durable Feishu Inbox',
        );
        return;
      }
      if (!claim) break;
      const envelope = parseRecoveredInbox(claim);
      if (!envelope) {
        failClaimedInbound(
          claim,
          {
            chatId: claim.chatId || '',
            messageId: claim.externalMessageId,
            createTimeMs: Date.parse(claim.createdAt),
            messageType: '',
            content: '',
          },
          new Error('Invalid durable Feishu Inbox payload'),
          false,
        );
        continue;
      }
      const outcome = await processClaimedInboundSerialized(
        envelope.payload,
        envelope.source,
        claim,
      );
      if (outcome === 'done') recovered++;
      else deferred++;
    }
    if (recovered > 0) {
      logger.info(
        { reason, recovered, deferred, accountId: reliabilityAccountId },
        'Recovered queued Feishu Inbox messages',
      );
    } else if (deferred > 0) {
      logger.debug(
        { reason, deferred, accountId: reliabilityAccountId },
        'Feishu Inbox messages are still waiting',
      );
    }
  }

  async function runBackfill(reason: string): Promise<void> {
    if (!client || backfillRunning) return;
    const chatIds = Array.from(knownChatIds);
    if (chatIds.length === 0) return;

    const generation = wsConnectionGeneration;
    const startedAt = Date.now();
    backfillRunning = true;
    const budget: BackfillBudget = {
      remaining: BACKFILL_MAX_CALLS_PER_ROUND,
      exhausted: false,
    };
    try {
      const threadCursorsByChat = loadActiveThreadCursors();
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < chatIds.length) {
          // stop()/reconnect retires this pass; the next one starts over.
          if (generation !== wsConnectionGeneration || !client) return;
          if (budget.exhausted) return;
          const chatId = chatIds[next++];
          try {
            const cursor = getChannelCursor({
              provider: 'feishu',
              accountId: reliabilityAccountId,
              scope: FEISHU_CURSOR_SCOPE,
              chatId,
            });
            await backfillChatMessages(
              chatId,
              cursor,
              threadCursorsByChat.get(chatId) ?? [],
              generation,
              budget,
            );
          } catch (err) {
            logger.warn({ err, chatId, reason }, 'Feishu chat backfill failed');
          }
        }
      };
      await Promise.all(
        Array.from(
          { length: Math.min(BACKFILL_CONCURRENCY, chatIds.length) },
          worker,
        ),
      );
      if (budget.exhausted) {
        logger.warn(
          {
            reason,
            chatCount: chatIds.length,
            calls: BACKFILL_MAX_CALLS_PER_ROUND,
          },
          'Feishu backfill reached its per-round call budget; remaining chats wait for the next round',
        );
      }
      logger.info(
        {
          reason,
          chatCount: chatIds.length,
          durationMs: Date.now() - startedAt,
          callsUsed: BACKFILL_MAX_CALLS_PER_ROUND - budget.remaining,
        },
        'Feishu backfill finished',
      );
    } finally {
      backfillRunning = false;
    }
  }

  /**
   * Catch up on messages missed while disconnected without holding inbound
   * delivery. Live events and backfilled ones meet in the same durable inbox
   * and are deduplicated by message id there.
   */
  function startBackfill(reason: string): void {
    void runBackfill(reason).catch((err) => {
      logger.warn({ err, reason }, 'Feishu backfill pass failed');
    });
  }

  async function reconnectWebSocket(reason: string): Promise<void> {
    if (reconnecting || !connectOptions) return;
    const generation = wsConnectionGeneration;
    const options = connectOptions;
    reconnecting = true;
    reconnectRequestedAt = Date.now();
    disconnectedChecks = 0;

    try {
      if (!eventDispatcher) {
        logger.warn(
          { reason },
          'Skip Feishu reconnect: event dispatcher is missing',
        );
        return;
      }
      if (wsClient) {
        try {
          await wsClient.close({ force: true });
        } catch (err) {
          logger.debug(
            { err },
            'Error closing stale Feishu WS client before reconnect',
          );
        }
      }

      if (generation !== wsConnectionGeneration || !eventDispatcher) return;
      const nextWsClient = createWsClient();
      wsClient = nextWsClient;
      await nextWsClient.start({ eventDispatcher });
      if (generation !== wsConnectionGeneration || wsClient !== nextWsClient) {
        nextWsClient.close({ force: true });
        return;
      }

      lastWsStateConnected = true;
      logger.info({ reason }, 'Feishu WebSocket reconnected');
      await recoverQueuedInbox('reconnect');
      if (generation === wsConnectionGeneration) {
        options.onReady();
        startBackfill('reconnect');
      }
    } catch (err) {
      logger.error({ err, reason }, 'Feishu WebSocket reconnect failed');
    } finally {
      if (generation === wsConnectionGeneration) reconnecting = false;
    }
  }

  async function checkConnectionHealth(): Promise<void> {
    if (!wsClient || reconnecting) return;

    // Inbox retry is independent from WS state. A provider connection can be
    // healthy while one local admission/download attempt needs replay.
    await recoverQueuedInbox('health-check');

    const state = getWsConnectionState();
    if (!state) return;

    if (state.connected) {
      disconnectedChecks = 0;
      if (!lastWsStateConnected) {
        logger.info('Feishu WebSocket is back online');
        await recoverQueuedInbox('recovered');
        startBackfill('recovered');
      }
      lastWsStateConnected = true;
      return;
    }

    if (lastWsStateConnected) {
      logger.warn(
        { isConnecting: state.isConnecting },
        'Feishu WebSocket appears offline',
      );
    }
    lastWsStateConnected = false;

    const now = Date.now();
    const reconnectWindowReady =
      state.nextConnectTime <= 0 || state.nextConnectTime <= now;
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
        logger.warn('Feishu config is empty, running in Web-only mode');
        return false;
      }
      const generation = ++wsConnectionGeneration;
      connectOptions = opts;
      disconnectedChecks = 0;
      reconnectRequestedAt = Date.now();
      reconnecting = false;
      backfillRunning = false;
      restoreDurableChatProgress();
      unsubscribeInboundGate?.();
      unsubscribeInboundGate =
        opts.onInboundGateOpen?.(() => {
          if (connectOptions !== opts) return;
          stopInboundGateWait();
          void recoverQueuedInbox('gate-open').catch((err) => {
            logger.error(
              { err },
              'Feishu Inbox recovery after gate open failed',
            );
          });
        }) ?? null;

      // Initialize client
      if (!feishuClientHttpTimeoutApplied) {
        // Set once: `defaultHttpInstance` is a module-level singleton shared
        // by every `lark.Client` in this process, so re-applying per connect
        // would be redundant, not incorrect.
        lark.defaultHttpInstance.defaults.timeout =
          FEISHU_CLIENT_HTTP_TIMEOUT_MS;
        feishuClientHttpTimeoutApplied = true;
      }
      client = new lark.Client({
        appId: config.appId,
        appSecret: config.appSecret,
        appType: lark.AppType.SelfBuild,
      });

      // Fetch bot open_id for mention detection — 带 retry 的 best-effort 拉取。
      // 启动期失败后，健康检查 + 进入 mention 门控前的 lazy refetch 会兜底自愈，
      // 期间 mention 守卫维持 fail-closed（拒绝群消息），不会回退到默认放行。
      botOpenId = '';
      botPublicInfo = {};
      lastBotInfoFetchAt = 0;
      await fetchBotOpenIdWithRetry();

      // Register the bot's current chat inventory before opening the WS. This
      // prevents the first event after restart from racing a missing binding,
      // while restored P2P cursors cover chats absent from chat.list.
      try {
        await connection.syncGroups();
      } catch (err) {
        logger.warn(
          { err, accountId: reliabilityAccountId },
          'Feishu startup chat inventory sync failed; cursor recovery will continue',
        );
      }

      // Create event dispatcher
      eventDispatcher = new lark.EventDispatcher({}).register({
        'im.message.receive_v1': async (data) => {
          try {
            const message = data.message;
            const sender = data.sender as typeof data.sender & {
              sender_type?: string;
              tenant_key?: string;
              sender_name?: string;
              sender_id?: {
                open_id?: string;
                user_id?: string;
                union_id?: string;
              };
            };
            await handleIncomingMessage(
              {
                chatId: message.chat_id,
                messageId: message.message_id,
                rootId: message.root_id,
                parentId: message.parent_id,
                threadId: message.thread_id,
                createTimeMs: toEpochMs(message.create_time),
                messageType: message.message_type,
                content: message.content,
                chatType: message.chat_type,
                mentions: message.mentions as FeishuMentionLike[] | undefined,
                senderOpenId: sender.sender_id?.open_id || '',
                senderUserId: sender.sender_id?.user_id,
                senderUnionId: sender.sender_id?.union_id,
                senderName: sender.sender_name,
                senderTenantKey: sender.tenant_key,
                senderType: sender.sender_type,
              },
              'ws',
            );
          } catch (err) {
            logger.error({ err }, 'Error handling Feishu message');
          }
        },
        // The Bot's own create/delete calls are echoed as events. Registering
        // no-op handlers prevents the Lark SDK from logging one warning per
        // processing indicator mutation. The same applies to subscribed
        // events HappyClaw does not act on (read receipts, doc link status,
        // a user merely opening the P2P chat — which must never claim an
        // owner).
        'im.message.reaction.created_v1': () => undefined,
        'im.message.reaction.deleted_v1': () => undefined,
        'im.message.message_read_v1': () => undefined,
        'im.chat.access_event.bot_p2p_chat_entered_v1': () => undefined,
        docs_link_status_changed: () => undefined,
        'im.message.recalled_v1': async (data) => {
          try {
            await handleMessageRecalled(data.chat_id, data.message_id);
          } catch (err) {
            logger.error({ err }, 'Error handling Feishu message recall');
          }
        },
        'im.chat.member.bot.added_v1': async (data) => {
          try {
            const chatId = data.chat_id;
            if (!chatId) return;
            const chatJid = admitIncomingJid(`feishu:${chatId}`);
            if (!chatJid) return;
            const chatName = data.name || '飞书群聊';
            logger.info({ chatJid, chatName }, 'Bot added to Feishu group');
            connectOptions?.onBotAddedToGroup?.(chatJid, chatName);
          } catch (err) {
            logger.error({ err }, 'Error handling bot added to group event');
          }
        },
        'im.chat.member.bot.deleted_v1': async (data) => {
          try {
            const chatId = data.chat_id;
            if (!chatId) return;
            const chatJid = admitIncomingJid(`feishu:${chatId}`);
            if (!chatJid) return;
            logger.info({ chatJid }, 'Bot removed from Feishu group');
            connectOptions?.onBotRemovedFromGroup?.(chatJid);
          } catch (err) {
            logger.error(
              { err },
              'Error handling bot removed from group event',
            );
          }
        },
        'im.chat.disbanded_v1': async (data) => {
          try {
            const chatId = data.chat_id;
            if (!chatId) return;
            const chatJid = admitIncomingJid(`feishu:${chatId}`);
            if (!chatJid) return;
            logger.info({ chatJid }, 'Feishu group disbanded');
            connectOptions?.onBotRemovedFromGroup?.(chatJid);
          } catch (err) {
            logger.error({ err }, 'Error handling group disbanded event');
          }
        },
        'card.action.trigger': async (data: any) => {
          try {
            const value = data?.action?.value ?? {};
            const action = value.action;
            const cardMessageId = data?.context?.open_message_id;
            const operatorImId =
              data?.operator?.open_id ?? data?.operator?.openId ?? '';
            if (!cardMessageId || !action) return;

            let result: FollowUpActionResult | undefined;
            if (action === 'interrupt_stream') {
              const chatJid = resolveJidByMessageId(cardMessageId);
              if (!chatJid) {
                logger.debug(
                  { cardMessageId },
                  'Card action: no mapping for messageId',
                );
                return;
              }
              result = connectOptions?.onCardInterrupt?.(chatJid, operatorImId);
              // The active streaming session owns its terminal card update.
              // Replacing this card with a follow-up receipt would erase the
              // generated answer and race the session's CardKit finalization.
              // Return promptly so Feishu can release the interaction lock.
              if (!result) return;
              return {
                toast: {
                  type: result.ok ? 'success' : 'warning',
                  content: result.message,
                },
              };
            } else if (
              action === 'steer_queued' ||
              action === 'cancel_queued' ||
              action === 'interrupt_and_run'
            ) {
              const mappedAction: FollowUpAction =
                action === 'steer_queued'
                  ? 'steer'
                  : action === 'cancel_queued'
                    ? 'cancel'
                    : 'interrupt_and_run';
              if (
                typeof value.sourceJid !== 'string' ||
                typeof value.targetJid !== 'string' ||
                typeof value.messageId !== 'string' ||
                typeof value.expectedRunId !== 'string'
              ) {
                return;
              }
              result = await connectOptions?.onFollowUpCardAction?.({
                sourceJid: value.sourceJid,
                targetJid: value.targetJid,
                messageId: value.messageId,
                action: mappedAction,
                expectedRunId: value.expectedRunId,
                operatorImId,
              });
            }

            if (!result) return;
            if (!result.ok) {
              return {
                toast: {
                  type: 'warning',
                  content: result.message,
                },
              };
            }
            if (!client) return;
            await client.im.v1.message.patch({
              path: { message_id: cardMessageId },
              data: {
                content: JSON.stringify(
                  buildFollowUpActionResultCard(result.message, result.ok),
                ),
              },
            });
          } catch (err) {
            logger.error({ err }, 'Error handling card action trigger');
          }
        },
      });

      // stop() can retire this connect while REST inventory is still loading.
      if (generation !== wsConnectionGeneration) return false;
      const nextWsClient = createWsClient();
      wsClient = nextWsClient;

      try {
        await nextWsClient.start({ eventDispatcher });
        if (
          generation !== wsConnectionGeneration ||
          wsClient !== nextWsClient
        ) {
          nextWsClient.close({ force: true });
          return false;
        }
        logger.info('Feishu WebSocket client started');
        lastWsStateConnected = true;
        startHealthMonitor();
        await recoverQueuedInbox('startup');
        if (generation !== wsConnectionGeneration) return false;
        onReady();
        startBackfill('startup');
        return true;
      } catch (err) {
        logger.error(
          { err },
          'Failed to start Feishu client, running in Web-only mode',
        );
        nextWsClient.close({ force: true });
        if (generation !== wsConnectionGeneration) return false;
        // Clean up partially initialized state
        stopHealthMonitor();
        stopInboundGateWait();
        unsubscribeInboundGate?.();
        unsubscribeInboundGate = null;
        connectOptions = null;
        eventDispatcher = null;
        client = null;
        wsClient = null;
        return false;
      }
    },

    async stop(): Promise<void> {
      wsConnectionGeneration += 1;
      const retiredWsClient = wsClient;
      wsClient = null;
      // Retire the transport before any asynchronous indicator cleanup.
      if (retiredWsClient) {
        try {
          retiredWsClient.close({ force: true });
        } catch (err) {
          logger.warn({ err }, 'Error stopping Feishu client');
        }
      }
      stopHealthMonitor();
      if (inboxRecoveryTimer) {
        clearTimeout(inboxRecoveryTimer);
        inboxRecoveryTimer = null;
      }
      inboxRecoveryDueAt = 0;
      recoveryDeadlines.clear();
      stopInboundGateWait();
      unsubscribeInboundGate?.();
      unsubscribeInboundGate = null;
      for (const timer of inboxHeartbeatByClaim.values()) {
        clearInterval(timer);
      }
      inboxHeartbeatByClaim.clear();
      connectOptions = null;
      eventDispatcher = null;
      reconnecting = false;
      disconnectedChecks = 0;
      await ackReactions.clearAll();
      client = null;
      lastWsStateConnected = false;
    },

    async sendMessage(
      chatId: string,
      text: string,
      localImagePaths?: string[],
      options?: FeishuSendOptions,
    ): Promise<void> {
      // Local preflight failures provably sent nothing: they are definitive,
      // never `uncertain` (which would fence the whole turn for manual
      // reconciliation). This includes `#agent:` and other invalid targets.
      if (!client) {
        throw new DefinitiveChannelDeliveryError(
          'Feishu client is not initialized',
        );
      }

      try {
        requireFeishuRouteTarget(chatId);
      } catch (error) {
        throw localFeishuPreflightError('Feishu route validation', error);
      }
      const imagePaths = localImagePaths ?? [];
      const tracker = new PhysicalDeliveryTracker(1 + imagePaths.length);
      const identity = sendIdentityFromOptions(options);

      try {
        const sendPost = () =>
          sendOrdinaryPages(
            chatId,
            text,
            'post',
            tracker,
            options?.physicalOutput,
            identity,
          );
        // Same 15s wall clock as ordinary pages, so the host can size the
        // outbox lease above it and a replay can still settle the row.
        const primarySend: FeishuPhysicalSend = {
          uuid: physicalUuid(identity.uuidBase, 'interactive'),
          inputMessageId: identity.inputMessageId,
          requestTimeoutMs: FEISHU_RESOURCE_REQUEST_TIMEOUT_MS,
          requestLabel: 'Feishu interactive reply',
        };
        if (options?.presentation === 'native') {
          await sendPost();
        } else {
          let prebuiltCard: string | undefined;
          if (text.startsWith('{"type":"interactive"')) {
            try {
              const parsed = JSON.parse(text);
              if (parsed.type === 'interactive' && parsed.card) {
                // Model-emitted card JSON: its markdown must not @ everyone
                // either (real mentions go through send_card).
                prebuiltCard = neutralizeCardJsonMentions(text, parsed);
              }
            } catch {
              // Ordinary text that happens to start with a JSON prefix.
            }
          }
          if (prebuiltCard) {
            await tracker.send(() =>
              sendToFeishu(chatId, 'interactive', prebuiltCard!, primarySend),
            );
          } else {
            const tableCount = (text.match(/^\|[\s:-]+\|/gm) || []).length;
            const content = JSON.stringify(buildInteractiveCard(text));
            // Inline IM cards have their own 30KB limit, unlike CardKit entities.
            if (
              tableCount > CARD_TABLE_LIMIT ||
              Buffer.byteLength(content) > 30_000
            ) {
              await sendPost();
            } else {
              try {
                await tracker.send(() =>
                  sendToFeishu(chatId, 'interactive', content, primarySend),
                );
              } catch (error) {
                // Only a refused card shape falls back to post. A gone
                // target, a rate limit or a DLP audit would refuse the post
                // as well, so stop the chain right here.
                if (
                  !definitiveFeishuChannelDeliveryError(error) ||
                  !allowsFeishuFormatFallback(error)
                ) {
                  throw error;
                }
                logger.warn(
                  { err: error, chatId },
                  'Feishu interactive send was rejected, fallback to post+md',
                );
                await sendPost();
              }
            }
          }
        }
        logger.debug(
          { chatId, presentation: options?.presentation ?? 'default' },
          'Sent Feishu message',
        );

        for (const [index, localImagePath] of imagePaths.entries()) {
          try {
            await tracker.send(async () => {
              let image: Buffer;
              try {
                image = await fsPromises.readFile(localImagePath);
              } catch (error) {
                throw localFeishuPreflightError(
                  'Feishu image attachment read',
                  error,
                );
              }
              let imageKey: string;
              try {
                const uploadRes = (await client!.im.v1.image.create({
                  data: {
                    image_type: 'message',
                    image,
                  },
                })) as
                  | { image_key?: string; data?: { image_key?: string } }
                  | null
                  | undefined;
                imageKey = requireFeishuUploadKey(
                  'Feishu image.create',
                  uploadRes,
                  'image_key',
                );
              } catch (error) {
                throw preVisibleFeishuDeliveryError(
                  'Feishu image attachment upload',
                  error,
                );
              }
              await sendToFeishu(
                chatId,
                'image',
                JSON.stringify({ image_key: imageKey }),
                {
                  uuid: physicalUuid(identity.uuidBase, 'image', index),
                  inputMessageId: identity.inputMessageId,
                  requestTimeoutMs: FEISHU_RESOURCE_REQUEST_TIMEOUT_MS,
                  requestLabel: 'Feishu image attachment',
                },
              );
            });
          } catch (imageErr) {
            logger.error(
              { chatId, localImagePath, err: imageErr },
              'Failed to send Feishu image attachment',
            );
            throw imageErr;
          }
        }
      } catch (err) {
        logger.error({ err, chatId }, 'Failed to send Feishu message');
        if (err instanceof PartialChannelDeliveryError) throw err;
        throw definitiveFeishuChannelDeliveryError(err) ?? err;
      }
    },

    async sendImage(
      chatId: string,
      imageBuffer: Buffer,
      mimeType: string,
      caption?: string,
      _fileName?: string /* Feishu image API has no filename field, intentionally unused */,
      options?: FeishuSendOptions,
    ): Promise<void> {
      if (!client) {
        throw new DefinitiveChannelDeliveryError(
          'Feishu client is not initialized',
        );
      }

      try {
        requireFeishuRouteTarget(chatId);
      } catch (error) {
        throw localFeishuPreflightError('Feishu route validation', error);
      }
      const identity = sendIdentityFromOptions(options);

      try {
        const tracker = new PhysicalDeliveryTracker(caption ? 2 : 1);
        let imageKey: string | undefined;

        // Uploading is pre-visible. Keep it inside the first tracked operation
        // so only the subsequent message ACK advances physical progress.
        await tracker.send(async () => {
          try {
            const uploadResult = (await client!.im.v1.image.create({
              data: {
                image_type: 'message',
                image: imageBuffer,
              },
            })) as
              | { image_key?: string; data?: { image_key?: string } }
              | null
              | undefined;
            imageKey = requireFeishuUploadKey(
              'Feishu image.create',
              uploadResult,
              'image_key',
            );
          } catch (error) {
            throw preVisibleFeishuDeliveryError('Feishu image upload', error);
          }
          await sendToFeishu(
            chatId,
            'image',
            JSON.stringify({ image_key: imageKey }),
            {
              uuid: physicalUuid(identity.uuidBase, 'image'),
              inputMessageId: identity.inputMessageId,
              requestTimeoutMs: FEISHU_RESOURCE_REQUEST_TIMEOUT_MS,
              requestLabel: 'Feishu image message',
            },
          );
        });

        // Step 3: If caption provided, send it as a follow-up text message
        if (caption) {
          await sendOrdinaryPages(chatId, caption, 'text', tracker, false, {
            ...identity,
            ...(identity.uuidBase
              ? { uuidBase: [...identity.uuidBase, 'caption'] }
              : {}),
          });
        }
        logger.info(
          { chatId, imageKey, mimeType, size: imageBuffer.length },
          'Feishu image sent',
        );
      } catch (err) {
        logger.error({ err, chatId, mimeType }, 'Failed to send Feishu image');
        if (err instanceof PartialChannelDeliveryError) throw err;
        throw definitiveFeishuChannelDeliveryError(err) ?? err;
      }
    },

    async sendFile(
      chatId: string,
      filePath: string,
      fileName: string,
      options?: FeishuSendOptions,
    ): Promise<void> {
      if (!client) {
        throw new DefinitiveChannelDeliveryError(
          'Feishu client is not initialized',
        );
      }

      try {
        requireFeishuRouteTarget(chatId);
      } catch (error) {
        throw localFeishuPreflightError('Feishu route validation', error);
      }
      const identity = sendIdentityFromOptions(options);

      try {
        let buffer: Buffer;
        try {
          buffer = await fsPromises.readFile(filePath);
        } catch (error) {
          throw localFeishuPreflightError('Feishu file read', error);
        }

        // Check file size limit (30MB)
        const MAX_FILE_SIZE = 30 * 1024 * 1024;
        if (buffer.length > MAX_FILE_SIZE) {
          throw localFeishuPreflightError(
            `Feishu file exceeds the 30MB limit (${(buffer.length / 1024 / 1024).toFixed(2)}MB); upload`,
          );
        }

        const ext = path.extname(fileName);
        const fileType = getFileType(ext);

        // Upload file
        let fileKey: string;
        try {
          const uploadResult = (await client.im.v1.file.create({
            data: {
              file_type: fileType,
              file_name: fileName,
              file: buffer,
            },
          })) as
            | { file_key?: string; data?: { file_key?: string } }
            | null
            | undefined;

          fileKey = requireFeishuUploadKey(
            'Feishu file.create',
            uploadResult,
            'file_key',
          );
        } catch (error) {
          throw preVisibleFeishuDeliveryError('Feishu file upload', error);
        }

        // Determine msg_type: Feishu requires upload file_type and send msg_type to match.
        // mp4 → media (video message), opus → audio (audio message), others → file.
        const msgType =
          fileType === 'mp4' ? 'media' : fileType === 'opus' ? 'audio' : 'file';

        // Send file message
        const tracker = new PhysicalDeliveryTracker(1);
        await tracker.send(() =>
          sendToFeishu(chatId, msgType, JSON.stringify({ file_key: fileKey }), {
            uuid: physicalUuid(identity.uuidBase, msgType),
            inputMessageId: identity.inputMessageId,
            requestTimeoutMs: FEISHU_RESOURCE_REQUEST_TIMEOUT_MS,
            requestLabel: 'Feishu file message',
          }),
        );
        logger.info(
          { chatId, fileName, fileSize: buffer.length },
          'File sent to Feishu',
        );
      } catch (err) {
        logger.error(
          { err, chatId, filePath },
          'Failed to send file to Feishu',
        );
        if (err instanceof PartialChannelDeliveryError) throw err;
        throw definitiveFeishuChannelDeliveryError(err) ?? err;
      }
    },

    beginAckReaction(chatId: string, inputMessageId: string): Promise<void> {
      return beginAckForInput(chatId, inputMessageId);
    },

    clearAckReaction(chatId: string, inputMessageId: string): Promise<void> {
      return clearAckForInput(chatId, inputMessageId);
    },

    isConnected(): boolean {
      return wsClient != null;
    },

    async getChatInfo(chatId: string): Promise<FeishuChatInfo | null> {
      if (!client) return null;
      try {
        const target = parseFeishuRouteTarget(chatId);
        const res = await client.im.v1.chat.get({
          path: { chat_id: target.chatId },
        });
        if (!res.data) return null;
        const info = {
          avatar: res.data.avatar,
          name: res.data.name,
          user_count: res.data.user_count,
          chat_type: res.data.chat_type,
          chat_mode: res.data.chat_mode,
          group_message_type: (res.data as { group_message_type?: string })
            .group_message_type,
        };
        chatInfoById.set(target.chatId, {
          name: info.name,
          chatType: info.chat_type,
          chatMode: info.chat_mode,
          groupMessageType: info.group_message_type,
        });
        return info;
      } catch (err) {
        logger.warn({ err, chatId }, 'Failed to get Feishu chat info');
        return null;
      }
    },

    async executeCapability(context, request) {
      if (!client) throw new Error('Feishu client is not connected');
      return executeFeishuCapability(client, context, request);
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
            if (!chat.chat_id) continue;

            const rawJid = `feishu:${chat.chat_id}`;
            const scopedJid = admitIncomingJid(rawJid);
            const chatName = chat.name?.trim() || '飞书聊天';
            const extendedChat = chat as typeof chat & {
              chat_type?: string;
              chat_mode?: string;
              group_message_type?: string;
            };
            chatInfoById.set(chat.chat_id, {
              name: chatName,
              chatType: extendedChat.chat_type,
              chatMode: extendedChat.chat_mode,
              groupMessageType: extendedChat.group_message_type,
            });

            // chat.list is the authoritative membership inventory for the bot.
            // Register every visible chat, even when the membership event was
            // missed or the chat has never sent a message to HappyClaw. The
            // account-scoping wrapper makes the JID unique for multi-bot users.
            connectOptions?.onNewChat?.(rawJid, chatName);
            // A rejected principal must not write metadata onto whatever
            // unscoped row shares the raw JID.
            if (scopedJid) {
              if (chat.avatar) {
                updateRegisteredGroupAvatar(scopedJid, chat.avatar);
              }
              updateChatName(scopedJid, chatName);
            }
            // chat.list only returns group chats the Bot is a member of.
            rememberChatProgress(
              chat.chat_id,
              0,
              feishuChatTypeFromMode(
                extendedChat.chat_mode,
                extendedChat.chat_type,
              ) ?? 'group',
            );
          }

          hasMore = res.data?.has_more || false;
          pageToken = res.data?.page_token;
        }

        logger.info('Feishu group sync completed');
      } catch (err) {
        logger.error({ err }, 'Failed to sync Feishu groups');
        throw err;
      }
    },

    getLarkClient(): lark.Client | null {
      return client;
    },

    getLastMessageId(
      chatId: string,
      inputMessageId?: string,
    ): string | undefined {
      const target = requireFeishuRouteTarget(chatId);
      return target.rootMessageId || p2pLastMessageId(target, inputMessageId);
    },
  };

  return connection;
}
