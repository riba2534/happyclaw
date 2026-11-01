import { Bot, InputFile, type Context } from 'grammy';
import { createRejectCooldown } from './reject-cooldown.js';
import crypto from 'crypto';
import fsPromises from 'node:fs/promises';
import { readMp4VideoDimensions } from './mp4-video-dimensions.js';
import { downloadHttpsBuffer } from './im-media-download.js';
import { Agent as HttpsAgent } from 'node:https';
import { ProxyAgent } from 'proxy-agent';
import { storeChatMetadata, storeMessageDirect, updateChatName } from './db.js';
import { createDedupCache } from './im-utils.js';
import { logger } from './logger.js';
import {
  saveDownloadedFile,
  sanitizeImFilename,
  MAX_FILE_SIZE,
  FileTooLargeError,
} from './im-downloader.js';
import { detectImageMimeType } from './image-detector.js';
import {
  ProcessingLock,
  isStale as isGloballyStale,
} from './im-safety/index.js';
import {
  channelConversationJid,
  extractProviderTarget,
  parseChannelAddress,
} from './channel-address.js';
import { resolveAdmittedChannelRoute } from './channel-admission.js';
import {
  chunkTelegramMarkdown,
  classifyTelegramSendError,
  createTelegramRateLimitRetry,
  isTelegramHtmlParseError,
  telegramApiRejection,
  type TelegramMessageChunk,
} from './telegram-outbound.js';
import {
  TelegramStreamingController,
  type TelegramStreamingTransport,
} from './telegram-streaming.js';
import {
  groupSenderAdmission,
  type ChannelCommandMention,
  type GroupAudienceConnectOpts,
  type GroupSenderAdmission,
} from './im-group-audience.js';
import {
  existingControlTarget,
  parseConnectorRuntimeControl,
  projectChannelInbound,
  runSessionBreak,
  STEER_TARGET_MISSING_REPLY,
  type ChannelFollowUpConnectOpts,
  type ChannelFollowUpOutcome,
} from './im-connector-follow-up.js';
import { PhysicalDeliveryTracker } from './im-delivery-progress.js';
import { DefinitiveChannelDeliveryError } from './channel-outbox-delivery.js';
import type {
  ChannelMessageMeta,
  ChannelReferencedMessage,
  ChannelTurnContext,
  FollowUpMode,
  NewMessage,
} from './types.js';
import {
  ExactAsyncIndicatorRegistry,
  processingIndicatorKey,
} from './processing-indicator.js';
// ─── TelegramConnection Interface ──────────────────────────────

export interface TelegramConnectionConfig {
  botToken: string;
  proxyUrl?: string;
}

/** Group audience senders are bare Telegram user ids. */
export interface TelegramConnectOpts
  extends ChannelFollowUpConnectOpts, GroupAudienceConnectOpts {
  onReady?: () => void;
  /** 收到消息后调用，让调用方自动注册未知的 Telegram 聊天 */
  onNewChat: (jid: string, name: string) => void;
  /** 检查聊天是否已注册（已在 registered_groups 中） */
  isChatAuthorized: (jid: string) => boolean;
  /** 配对尝试回调：验证码并注册聊天，返回是否成功 */
  onPairAttempt?: (
    jid: string,
    chatName: string,
    code: string,
  ) => Promise<boolean>;
  /** 斜杠指令回调（如 /clear），返回回复文本或 null。
   *  senderImId 是发送者的裸 Telegram 用户 ID（不含 `tg:` 前缀），
   *  与飞书/钉钉 onCommand 传裸 open_id / senderId 的格式一致，
   *  用于在主进程做 owner-only 命令检查（owner_im_id 比对）。 */
  onCommand?: (
    chatJid: string,
    command: string,
    senderImId?: string,
    mentions?: ChannelCommandMention[],
  ) => Promise<string | null>;
  /** 热重连时设置：丢弃 date 早于此时间戳（epoch ms）的消息，避免处理渠道关闭期间的堆积消息 */
  ignoreMessagesBefore?: number;
  /** 根据 jid 解析群组 folder，用于下载文件/图片到工作区 */
  resolveGroupFolder?: (jid: string) => string | undefined;
  /** 将 IM chatJid 解析为绑定的会话（话题群为该话题的会话） */
  resolveEffectiveChatJid?: (
    chatJid: string,
    messageMeta?: ChannelMessageMeta,
  ) => {
    effectiveJid: string;
    agentId: string | null;
    sourceJid?: string;
  } | null;
  /** The route a chat or topic already has; never creates one. */
  lookupEffectiveChatJid?: TelegramConnectOpts['resolveEffectiveChatJid'];
  /** 当 IM 消息被路由到 conversation agent 后调用，触发 agent 处理 */
  onAgentMessage?: (baseChatJid: string, agentId: string) => void;
  /** Project a message that has already committed to the host-owned store. */
  onMessagePersisted?: (
    chatJid: string,
    message: NewMessage & { is_from_me?: boolean },
    agentId?: string,
  ) => void;
  /** Bot 被添加到群聊时调用（仅 group/supergroup） */
  onBotAddedToGroup?: (chatJid: string, chatName: string) => void;
  /** Bot 被移出群聊或群被解散时调用 */
  onBotRemovedFromGroup?: (chatJid: string) => void;
  /** Native topic capability discovered for the registered base chat. */
  onNativeContextDetected?: (
    chatJid: string,
    contextType: 'thread',
  ) => boolean | void | Promise<boolean | void>;
  normalizeIncomingJid?: (jid: string) => string | null;
}

/**
 * Telegram Forum topics are provider-native contexts of one base chat. The
 * base (account-scoped after normalization) remains the registered/bindable
 * channel; the fragment is only a reply route and thread_map context key.
 */
export function buildTelegramRouteJid(
  chatId: string,
  messageThreadId?: number,
): string {
  const base = `telegram:${chatId}`;
  return Number.isSafeInteger(messageThreadId) && messageThreadId! > 0
    ? `${base}#thread:${messageThreadId}`
    : base;
}

export type TelegramNativeMediaKind =
  | 'video'
  | 'voice'
  | 'audio'
  | 'animation'
  | 'sticker'
  | 'video_note';

export type TelegramNativeInboundKind =
  | TelegramNativeMediaKind
  | 'location'
  | 'contact';

export interface TelegramNativeFile {
  fileId: string;
  fileName: string;
  fileSize?: number;
  kind: TelegramNativeMediaKind;
}

/**
 * What one native Telegram update contributes to its durable message: text
 * that is already rendered, a provider file to download into the workspace,
 * or both. Every variant shares one admission/persistence flow.
 */
export interface TelegramNativeInbound {
  kind: TelegramNativeInboundKind;
  text?: string;
  file?: TelegramNativeFile;
}

interface TelegramNativeFileMessage {
  video?: { file_id: string; file_name?: string; file_size?: number };
  voice?: { file_id: string; file_size?: number };
  audio?: { file_id: string; file_name?: string; file_size?: number };
  animation?: { file_id: string; file_name?: string; file_size?: number };
  video_note?: { file_id: string; file_size?: number };
}

/**
 * Native Telegram media that is NOT message:photo / message:document.
 * Video-button MP4, voice notes, audio files, GIF/animation, and round
 * video notes never carry `document` unless the user picked "Send as file".
 */
export function telegramNativeFileFromMessage(
  message: TelegramNativeFileMessage,
): TelegramNativeFile | null {
  if (message.video) {
    return {
      fileId: message.video.file_id,
      fileName: message.video.file_name || 'video.mp4',
      fileSize: message.video.file_size,
      kind: 'video',
    };
  }
  if (message.voice) {
    return {
      fileId: message.voice.file_id,
      fileName: 'voice.ogg',
      fileSize: message.voice.file_size,
      kind: 'voice',
    };
  }
  if (message.audio) {
    return {
      fileId: message.audio.file_id,
      fileName: message.audio.file_name || 'audio.mp3',
      fileSize: message.audio.file_size,
      kind: 'audio',
    };
  }
  if (message.animation) {
    return {
      fileId: message.animation.file_id,
      fileName: message.animation.file_name || 'animation.mp4',
      fileSize: message.animation.file_size,
      kind: 'animation',
    };
  }
  if (message.video_note) {
    return {
      fileId: message.video_note.file_id,
      fileName: 'video_note.mp4',
      fileSize: message.video_note.file_size,
      kind: 'video_note',
    };
  }
  return null;
}

/**
 * Resolve every native update routed through the shared media flow.
 *
 * Stickers keep their emoji. Like WhatsApp stickers, a static (WebP) sticker
 * is saved as a workspace image; animated (TGS/Lottie) and video (WebM)
 * stickers are not images the agent can view, so they stay text-only.
 */
export function telegramNativeInboundFromMessage(
  message: TelegramNativeFileMessage & {
    sticker?: {
      file_id: string;
      file_size?: number;
      emoji?: string;
      is_animated?: boolean;
      is_video?: boolean;
    };
    location?: { latitude?: number; longitude?: number };
    venue?: { title?: string; address?: string };
    contact?: {
      first_name?: string;
      last_name?: string;
      phone_number?: string;
    };
  },
): TelegramNativeInbound | null {
  if (message.sticker) {
    const { sticker } = message;
    const emoji = boundedTelegramText(sticker.emoji);
    const text = emoji ? `[贴纸 ${emoji}]` : '[贴纸]';
    if (sticker.is_animated || sticker.is_video) {
      return { kind: 'sticker', text };
    }
    return {
      kind: 'sticker',
      text,
      file: {
        fileId: sticker.file_id,
        fileName: 'sticker.webp',
        fileSize: sticker.file_size,
        kind: 'sticker',
      },
    };
  }
  const file = telegramNativeFileFromMessage(message);
  if (file) return { kind: file.kind, file };
  if (message.location) {
    return {
      kind: 'location',
      text: telegramLocationMessageText(message.location, message.venue),
    };
  }
  if (message.contact) {
    return {
      kind: 'contact',
      text: telegramContactMessageText(message.contact),
    };
  }
  return null;
}

interface TelegramEntityLike {
  type: string;
  offset: number;
  length: number;
  user?: { id: number; is_bot?: boolean };
}

interface TelegramMessageLike {
  text?: string;
  caption?: string;
  message_thread_id?: number;
  is_topic_message?: boolean;
  entities?: TelegramEntityLike[];
  caption_entities?: TelegramEntityLike[];
  from?: { id: number; is_bot?: boolean };
  sender_chat?: unknown;
  reply_to_message?: TelegramRepliedMessage;
}

interface TelegramUserLike {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

interface TelegramRepliedMessage {
  message_id?: number;
  from?: TelegramUserLike;
  sender_chat?: unknown;
  forum_topic_created?: unknown;
  has_protected_content?: boolean;
  text?: string;
  caption?: string;
  photo?: unknown[];
  document?: { file_name?: string };
  voice?: unknown;
  audio?: { file_name?: string };
  video?: unknown;
  video_note?: unknown;
  animation?: unknown;
  sticker?: { emoji?: string };
}

/** Every forum-topic message implicitly replies to the topic's opening one. */
function isImplicitTopicReply(message: TelegramMessageLike): boolean {
  const replied = message.reply_to_message;
  // An ordinary supergroup reply carries message_thread_id too (the reply
  // chain's root), so only a forum topic message can reply implicitly.
  return (
    !!replied?.forum_topic_created ||
    (message.is_topic_message === true &&
      replied?.message_id === message.message_thread_id)
  );
}

function telegramUserLabel(user: TelegramUserLike | undefined): string {
  if (!user) return '';
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ');
  return fullName || (user.username ? `@${user.username}` : String(user.id));
}

/**
 * The message a Telegram message explicitly replies to, as prompt-only
 * reference context: its text (or a placeholder for media), its author, and
 * whether the author is this bot. Implicit topic replies, service messages
 * and protected content are not referenced.
 */
export function telegramReferencedMessage(
  message: TelegramMessageLike & { has_protected_content?: boolean },
  botUserId: number | undefined,
): ChannelReferencedMessage | null {
  const replied = message.reply_to_message;
  if (!replied || replied.message_id === undefined) return null;
  if (isImplicitTopicReply(message)) return null;
  // Forwarding-protected content is not copied into the Agent's context.
  if (replied.has_protected_content || message.has_protected_content) {
    return null;
  }
  const text =
    replied.text ||
    replied.caption ||
    (replied.photo?.length
      ? '[图片]'
      : replied.document
        ? `[文件: ${replied.document.file_name ?? 'document'}]`
        : replied.voice
          ? '[语音消息]'
          : replied.audio
            ? `[音频: ${replied.audio.file_name ?? 'audio'}]`
            : replied.video || replied.video_note || replied.animation
              ? '[视频]'
              : replied.sticker
                ? `[贴纸${replied.sticker.emoji ? ` ${replied.sticker.emoji}` : ''}]`
                : '');
  if (!text) return null;
  const author = telegramUserLabel(replied.from);
  const sender = !replied.from
    ? ''
    : botUserId !== undefined && replied.from.id === botUserId
      ? `${author}（本机器人）`
      : replied.from.is_bot
        ? `${author}（机器人）`
        : author;
  return {
    id: String(replied.message_id),
    ...(sender ? { sender } : {}),
    text,
  };
}

/** Public provider context of one Telegram inbound message. */
export function buildTelegramChannelTurnContext(input: {
  sourceJid: string;
  chat: { id: string | number; type: string; title?: string };
  message: TelegramMessageLike & {
    message_id: number;
    has_protected_content?: boolean;
  };
  from?: TelegramUserLike;
  botUserId?: number;
}): ChannelTurnContext {
  const reference = telegramReferencedMessage(input.message, input.botUserId);
  const threadId = input.message.message_thread_id;
  const senderImId = telegramSenderImId({
    from: input.from,
    sender_chat: input.message.sender_chat,
  });
  return {
    schemaVersion: 1,
    provider: 'telegram',
    channelAccountId:
      parseChannelAddress(input.sourceJid)?.channelAccountId ?? null,
    sourceJid: input.sourceJid,
    chat: {
      id: String(input.chat.id),
      type: input.chat.type === 'private' ? 'p2p' : 'group',
      ...(input.chat.title ? { name: input.chat.title } : {}),
    },
    message: {
      id: String(input.message.message_id),
      ...(threadId ? { threadId: String(threadId) } : {}),
      ...(reference
        ? { parentId: reference.id, referencedMessages: [reference] }
        : {}),
    },
    ...(senderImId
      ? {
          sender: {
            userId: senderImId,
            name: telegramUserLabel(input.from),
          },
        }
      : {}),
  };
}

/**
 * The sender's identity for owner and audience checks, or undefined when it
 * cannot be attributed to one person: anonymous group admins and messages
 * sent as a channel arrive through shared system accounts with
 * `sender_chat` set. Such a sender is never the owner, cannot claim it and
 * cannot be allowlisted.
 */
export function telegramSenderImId(
  message: Pick<TelegramMessageLike, 'from' | 'sender_chat'>,
): string | undefined {
  if (message.sender_chat || !message.from?.id) return undefined;
  return String(message.from.id);
}

/**
 * The text of a group message that structurally addresses this bot, with the
 * addressing removed; null when it does not. Telegram marks the proof itself:
 * a leading `@username` mention entity of this bot, a leading `text_mention`
 * of its user id, or a leading `/command@username`. A reply to the bot or a
 * hand-typed name is not proof.
 */
export function telegramAddressedText(
  message: TelegramMessageLike,
  bot: { username?: string; id?: number },
): string | null {
  const text = message.text ?? message.caption ?? '';
  const entities =
    message.text !== undefined ? message.entities : message.caption_entities;
  const first = entities?.find((entity) => entity.offset === 0);
  if (!first) return null;
  const token = text.slice(0, first.length);
  const rest = text.slice(first.length);
  const handle = bot.username ? `@${bot.username}`.toLowerCase() : null;
  if (first.type === 'mention' && handle && token.toLowerCase() === handle) {
    return rest.trim();
  }
  if (first.type === 'text_mention' && bot.id && first.user?.id === bot.id) {
    return rest.trim();
  }
  if (
    first.type === 'bot_command' &&
    handle &&
    token.toLowerCase().endsWith(handle)
  ) {
    return (token.slice(0, token.length - handle.length) + rest).trim();
  }
  return null;
}

/**
 * Members a Telegram command names, for `/allow` and `/disallow`. A plain
 * `@username` entity carries no user id and the Bot API cannot resolve one,
 * so only `text_mention` entities (members without a username) and the
 * author of the replied-to message are structural. Bots are never named.
 */
export function telegramCommandMentions(
  message: TelegramMessageLike,
): ChannelCommandMention[] {
  const ids = new Set<string>();
  for (const entity of [
    ...(message.entities ?? []),
    ...(message.caption_entities ?? []),
  ]) {
    if (entity.type === 'text_mention' && entity.user && !entity.user.is_bot) {
      ids.add(String(entity.user.id));
    }
  }
  // In a forum topic every message implicitly replies to the topic's opening
  // message; only an explicit reply names its author.
  const replied = message.reply_to_message;
  if (replied && !isImplicitTopicReply(message)) {
    const id = telegramSenderImId(replied);
    if (id && !replied.from?.is_bot) ids.add(id);
  }
  return [...ids].map((imId) => ({ imId }));
}

/**
 * Caption or text `/pair CODE` (optionally addressed to this bot).
 * Telegram puts media commands on `caption`, not `text`.
 */
export function matchTelegramPairCode(
  text: string | undefined,
  expectedBotUsername?: string,
): string | null {
  if (!text) return null;
  const match = text.trim().match(/^\/pair(?:@([A-Z0-9_]+))?\s+(\S+)/i);
  if (!match) return null;
  const addressedUsername = match[1];
  const normalizedExpected = expectedBotUsername?.replace(/^@/, '');
  if (
    addressedUsername &&
    (!normalizedExpected ||
      addressedUsername.toLowerCase() !== normalizedExpected.toLowerCase())
  ) {
    return null;
  }
  return match[2] ?? null;
}

export function telegramMediaMessageText(
  fileText: string,
  caption: string | undefined,
): string {
  const normalizedCaption = caption?.trim();
  return normalizedCaption ? `${fileText}\n${normalizedCaption}` : fileText;
}

/** User-controlled provider text, flattened to one bounded line. */
function boundedTelegramText(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 512);
}

/** Same shape as WhatsApp's location placeholder. */
export function telegramLocationMessageText(
  location?: { latitude?: number; longitude?: number },
  venue?: { title?: string; address?: string },
): string {
  const name = boundedTelegramText(venue?.title);
  const address = boundedTelegramText(venue?.address);
  const lat = location?.latitude;
  const lon = location?.longitude;
  const coords =
    Number.isFinite(lat) && Number.isFinite(lon) ? `${lat}, ${lon}` : '';
  const details: string[] = [];
  if (name) details.push(name);
  if (address && address !== name) details.push(`地址: ${address}`);
  if (coords) details.push(`坐标: ${coords}`);
  return details.length > 0 ? `[位置: ${details.join(' | ')}]` : '[位置]';
}

/** Same shape as WhatsApp's contact placeholder. */
export function telegramContactMessageText(contact?: {
  first_name?: string;
  last_name?: string;
  phone_number?: string;
}): string {
  const name = boundedTelegramText(
    [contact?.first_name, contact?.last_name].filter(Boolean).join(' '),
  );
  const phone = boundedTelegramText(contact?.phone_number);
  const lines = [name ? `[联系人: ${name}]` : '[联系人]'];
  if (phone) lines.push(`电话: ${phone}`);
  return lines.join('\n');
}

/**
 * Bot API animation updates also carry a compatibility `document` object.
 * grammY middleware stops unless `next()` is called, so the document handler
 * must explicitly yield or the later `message:animation` handler is unreachable.
 */
export async function yieldTelegramAnimationDocument(
  message: { animation?: unknown },
  next: () => Promise<unknown>,
): Promise<boolean> {
  if (!message.animation) return false;
  await next();
  return true;
}

export type TelegramOutboundFileKind = 'video' | 'audio' | 'voice' | 'document';

/** Telegram's native APIs accept a narrower set than generic MIME viewers. */
export function telegramOutboundFileKind(
  fileName: string,
): TelegramOutboundFileKind {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  if (ext === 'mp4') return 'video';
  if (ext === 'mp3' || ext === 'm4a') return 'audio';
  if (ext === 'ogg' || ext === 'opus') return 'voice';
  return 'document';
}

export interface TelegramProviderTarget {
  chatId: number;
  messageThreadId?: number;
}

export type TelegramForumPairingState =
  | 'flat'
  | 'thread_ready'
  | 'thread_unavailable';

interface TelegramChatDescriptor {
  id: string | number;
  type: string;
  is_forum?: boolean;
}

function isTelegramGroupChat(chat: { type: string }): boolean {
  return chat.type === 'group' || chat.type === 'supergroup';
}

/**
 * Telegram may omit `is_forum` from an incoming message chat. Resolve it from
 * getChat when necessary, then synchronously establish the workspace/thread
 * contract before telling the user that pairing is ready.
 */
export async function prepareTelegramForumPairing(
  jid: string,
  chat: TelegramChatDescriptor,
  fetchChat: (chatId: string | number) => Promise<{ is_forum?: boolean }>,
  onNativeContextDetected?: (
    chatJid: string,
    contextType: 'thread',
  ) => boolean | void | Promise<boolean | void>,
): Promise<TelegramForumPairingState> {
  if (chat.type !== 'supergroup') return 'flat';

  let isForum = chat.is_forum;
  if (typeof isForum !== 'boolean') {
    try {
      isForum = (await fetchChat(chat.id)).is_forum;
    } catch {
      return 'thread_unavailable';
    }
  }
  if (isForum === false) return 'flat';
  // An unresolved supergroup must not be advertised as flat: that would
  // reopen the window in which the UI allows an invalid fixed-session bind.
  if (isForum !== true || !onNativeContextDetected) return 'thread_unavailable';

  try {
    const result = await onNativeContextDetected(jid, 'thread');
    return result === false ? 'thread_unavailable' : 'thread_ready';
  } catch {
    return 'thread_unavailable';
  }
}

export function parseTelegramProviderTarget(
  target: string,
): TelegramProviderTarget | null {
  const [rawChatId, ...fragments] = target.split('#');
  if (!/^-?[1-9]\d*$/.test(rawChatId)) return null;
  const chatId = Number(rawChatId);
  if (!Number.isSafeInteger(chatId)) return null;
  if (
    fragments.length > 1 ||
    (fragments.length === 1 && !fragments[0].startsWith('thread:'))
  ) {
    return null;
  }
  const threadFragment = fragments[0];
  let rawThreadId: string | undefined;
  try {
    rawThreadId = threadFragment
      ? decodeURIComponent(threadFragment.slice('thread:'.length))
      : undefined;
  } catch {
    return null;
  }
  const messageThreadId = rawThreadId ? Number(rawThreadId) : undefined;
  if (
    messageThreadId !== undefined &&
    (!Number.isSafeInteger(messageThreadId) || messageThreadId <= 0)
  ) {
    return null;
  }
  return { chatId, ...(messageThreadId ? { messageThreadId } : {}) };
}

function telegramMessageMeta(message: {
  message_id: number;
  message_thread_id?: number;
  text?: string;
  caption?: string;
}): ChannelMessageMeta | undefined {
  if (!message.message_thread_id) return undefined;
  return {
    provider: 'telegram',
    nativeContextType: 'thread',
    contextId: String(message.message_thread_id),
    threadId: String(message.message_thread_id),
    rootId: String(message.message_thread_id),
    messageId: String(message.message_id),
    text: message.text ?? message.caption,
  };
}

export interface TelegramConnection {
  connect(opts: TelegramConnectOpts): Promise<boolean>;
  disconnect(): Promise<void>;
  sendMessage(
    chatId: string,
    text: string,
    localImagePaths?: string[],
  ): Promise<void>;
  sendImage(
    chatId: string,
    imageBuffer: Buffer,
    mimeType: string,
    caption?: string,
    fileName?: string,
  ): Promise<void>;
  sendFile(
    chatId: string,
    filePath: string,
    fileName: string,
    options?: { asDocument?: boolean },
  ): Promise<void>;
  sendChatAction(chatId: string, action: 'typing'): Promise<void>;
  clearAckReaction(chatId: string, inputMessageId: string): Promise<void>;
  /** Edit-based streaming of the main answer (final sent fresh). */
  createStreamingSession(
    chatId: string,
    onCardCreated?: (messageId: string) => void,
  ): TelegramStreamingController | undefined;
  isConnected(): boolean;
}

// ─── Factory Function ──────────────────────────────────────────

/**
 * Create an independent Telegram connection instance.
 * Each instance manages its own bot and deduplication state.
 */
export function createTelegramConnection(
  config: TelegramConnectionConfig,
): TelegramConnection {
  // LRU deduplication cache
  // LRU deduplication cache（共享 helper，避免 6 个 IM channel 各自写一份）
  const dedup = createDedupCache({ ttlMs: 30 * 60 * 1000, max: 1000 });
  const POLLING_RESTART_DELAY_MS = 5000;
  const POLLING_STALL_THRESHOLD_MS = 120_000;
  const POLLING_WATCHDOG_INTERVAL_MS = 30_000;

  const processingLock = new ProcessingLock();
  let bot: Bot | null = null;
  const ackReactions = new ExactAsyncIndicatorRegistry<{
    chatId: number;
    messageId: number;
  }>();
  let pollingPromise: Promise<void> | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let pollingWatchdogTimer: NodeJS.Timeout | null = null;
  let getUpdatesStartedAt: number | null = null;
  let getUpdatesFinishedAt = Date.now();
  let watchdogRestarting = false;
  let stopping = false;
  let readyFired = false;
  let connected = false;
  let botUsername: string | undefined;
  let botUserId: number | undefined;
  const telegramApiAgent =
    config.proxyUrl && config.proxyUrl.trim()
      ? new ProxyAgent({
          getProxyForUrl: () => config.proxyUrl!.trim(),
        })
      : new HttpsAgent({ keepAlive: true, family: 4 });

  /**
   * Outbound sends fail before any provider call when the bot is gone. That
   * is a definitive non-delivery: a bare Error would fence the whole Turn as
   * uncertain and block every later output in it.
   */
  function requireOutboundBot(): Bot {
    if (!bot) {
      throw new DefinitiveChannelDeliveryError(
        'Telegram bot is not initialized',
      );
    }
    return bot;
  }

  function clearPollingWatchdog(): void {
    if (pollingWatchdogTimer) {
      clearInterval(pollingWatchdogTimer);
      pollingWatchdogTimer = null;
    }
  }

  /**
   * Send one rendered chunk; a real HTML parse failure is resent as plain
   * text. Any other failure is rethrown so an attempted send is never
   * duplicated.
   */
  async function sendTelegramChunk(
    activeBot: Bot,
    chatId: number,
    chunk: TelegramMessageChunk,
    threadOptions: { message_thread_id?: number },
  ): Promise<number> {
    try {
      const sent = await activeBot.api.sendMessage(chatId, chunk.html, {
        parse_mode: 'HTML',
        ...threadOptions,
      });
      return sent.message_id;
    } catch (err) {
      if (!isTelegramHtmlParseError(err)) throw err;
      logger.debug({ err, chatId }, 'HTML parse failed, fallback to plain');
      const sent = await activeBot.api.sendMessage(
        chatId,
        chunk.markdown,
        threadOptions,
      );
      return sent.message_id;
    }
  }

  /** Telegram answered that the edit would not change the message. */
  function isTelegramNotModified(err: unknown): boolean {
    const rejection = telegramApiRejection(err);
    return (
      rejection?.code === 400 && /not modified/i.test(rejection.description)
    );
  }

  /** Bot API operations of one streaming answer, bound to its chat/thread. */
  function telegramStreamingTransport(
    target: TelegramProviderTarget,
  ): TelegramStreamingTransport {
    const threadOptions = target.messageThreadId
      ? { message_thread_id: target.messageThreadId }
      : {};
    return {
      async send(chunk) {
        try {
          return await sendTelegramChunk(
            requireOutboundBot(),
            target.chatId,
            chunk,
            threadOptions,
          );
        } catch (err) {
          throw classifyTelegramSendError(err);
        }
      },
      async edit(messageId, chunk) {
        const activeBot = requireOutboundBot();
        try {
          await activeBot.api.editMessageText(
            target.chatId,
            messageId,
            chunk.html,
            { parse_mode: 'HTML' },
          );
        } catch (err) {
          if (isTelegramNotModified(err)) return;
          if (!isTelegramHtmlParseError(err)) throw err;
          try {
            await activeBot.api.editMessageText(
              target.chatId,
              messageId,
              chunk.markdown,
            );
          } catch (plainErr) {
            if (!isTelegramNotModified(plainErr)) throw plainErr;
          }
        }
      },
      async delete(messageId) {
        await requireOutboundBot().api.deleteMessage(target.chatId, messageId);
      },
    };
  }

  /**
   * 通过 Telegram Bot API 下载文件到工作区磁盘。
   * 返回工作区相对路径，失败返回 null。
   */
  async function downloadTelegramFile(
    fileId: string,
    originalFilename: string,
    groupFolder: string,
    /** The admitted route; a session route picks that session's worktree. */
    routeJid: string,
    fileSizeHint?: number,
  ): Promise<string | null> {
    // Telegram Bot API 免费 tier 上限 20 MB，提前预检
    if (fileSizeHint !== undefined && fileSizeHint > MAX_FILE_SIZE) {
      logger.warn(
        { fileId, fileSizeHint },
        'Telegram file exceeds MAX_FILE_SIZE, skipping',
      );
      return null;
    }

    try {
      if (!bot) return null;
      const file = await bot.api.getFile(fileId);
      const filePath = file.file_path;
      if (!filePath) {
        logger.warn({ fileId }, 'Telegram getFile returned no file_path');
        return null;
      }

      const url = `https://api.telegram.org/file/bot${config.botToken}/${filePath}`;
      const buffer = await downloadHttpsBuffer(url, {
        agentForUrl: () => telegramApiAgent,
        followRedirects: true,
        oversizedMessage: 'File exceeds MAX_FILE_SIZE during download',
      });

      // 使用 file_path 中的最后一段作为文件名（若无则用 originalFilename）
      const pathBasename = filePath.split('/').pop() || '';
      const effectiveName =
        originalFilename || pathBasename || `file_${fileId}`;

      try {
        return await saveDownloadedFile(
          groupFolder,
          'telegram',
          effectiveName,
          buffer,
          routeJid,
        );
      } catch (err) {
        if (err instanceof FileTooLargeError) {
          logger.warn(
            { fileId, effectiveName },
            'Telegram file too large after download',
          );
          return null;
        }
        throw err;
      }
    } catch (err) {
      logger.warn({ err, fileId }, 'Failed to download Telegram file');
      return null;
    }
  }

  /**
   * 下载 Telegram 图片并返回 base64 字符串，用于 Vision 通道。
   * 失败返回 null。
   */
  async function downloadTelegramPhotoAsBase64(
    fileId: string,
    fileSizeHint?: number,
  ): Promise<{ base64: string; mimeType: string } | null> {
    if (fileSizeHint !== undefined && fileSizeHint > MAX_FILE_SIZE) {
      logger.warn(
        { fileId, fileSizeHint },
        'Telegram photo exceeds MAX_FILE_SIZE, skipping',
      );
      return null;
    }
    try {
      if (!bot) return null;
      const file = await bot.api.getFile(fileId);
      const filePath = file.file_path;
      if (!filePath) {
        logger.warn(
          { fileId },
          'Telegram getFile returned no file_path (photo)',
        );
        return null;
      }
      const url = `https://api.telegram.org/file/bot${config.botToken}/${filePath}`;
      const buffer = await downloadHttpsBuffer(url, {
        agentForUrl: () => telegramApiAgent,
        followRedirects: true,
        oversizedMessage: 'Photo exceeds MAX_FILE_SIZE during download',
      });
      if (buffer.length === 0) {
        logger.warn({ fileId }, 'Empty response from Telegram photo download');
        return null;
      }
      const mimeType = detectImageMimeType(buffer);
      return {
        base64: buffer.toString('base64'),
        mimeType,
      };
    } catch (err) {
      logger.warn(
        { err, fileId },
        'Failed to download Telegram photo as base64',
      );
      return null;
    }
  }

  // Rate-limit rejection messages: one per chat per 5 minutes
  const REJECT_COOLDOWN_MS = 5 * 60 * 1000;
  const rejectCooldown = createRejectCooldown(REJECT_COOLDOWN_MS);
  const nativeContextReported = new Set<string>();

  async function reportNativeContext(
    opts: TelegramConnectOpts,
    jid: string,
    messageThreadId?: number,
  ): Promise<boolean> {
    if (!messageThreadId || nativeContextReported.has(jid)) return true;
    if (!opts.onNativeContextDetected) return false;
    try {
      const result = await opts.onNativeContextDetected(jid, 'thread');
      if (result === false) return false;
      nativeContextReported.add(jid);
      return true;
    } catch (err) {
      logger.error(
        { err, jid },
        'Telegram native-context capability persistence failed',
      );
      return false;
    }
  }

  /**
   * `/steer` or `/break` in this message. Private chats are direct; a group
   * needs Telegram's structural proof that the bot is addressed.
   */
  function telegramRuntimeControl(
    message: TelegramMessageLike,
    chat: TelegramChatDescriptor,
    hasAttachments: boolean,
  ) {
    const commandText = isTelegramGroupChat(chat)
      ? telegramAddressedText(message, {
          username: botUsername,
          id: botUserId,
        })
      : (message.text ?? message.caption ?? '').trim();
    return parseConnectorRuntimeControl({
      commandText: commandText ?? '',
      eligible: commandText !== null,
      hasAttachments,
    });
  }

  /**
   * The Session a runtime control in this chat or topic acts on: the route
   * it already has. A topic seen for the first time gets none created.
   */
  function telegramControlTarget(
    opts: TelegramConnectOpts,
    jid: string,
    routeJid: string,
    messageMeta: ChannelMessageMeta | undefined,
  ): string | undefined {
    return existingControlTarget(
      routeJid,
      !!opts.resolveEffectiveChatJid,
      opts.lookupEffectiveChatJid &&
        (() => opts.lookupEffectiveChatJid!(jid, messageMeta)),
    );
  }

  /** Answer a `/steer` caption whose chat or topic has no Session yet. */
  async function steerHasNoTarget(
    opts: TelegramConnectOpts,
    message: TelegramMessageLike,
    chat: TelegramChatDescriptor,
    route: { jid: string; routeJid: string; messageMeta?: ChannelMessageMeta },
    reply: (text: string) => Promise<unknown>,
  ): Promise<boolean> {
    if (telegramRuntimeControl(message, chat, true)?.kind !== 'steer') {
      return false;
    }
    if (
      telegramControlTarget(opts, route.jid, route.routeJid, route.messageMeta)
    ) {
      return false;
    }
    await reply(STEER_TARGET_MISSING_REPLY);
    return true;
  }

  /** A media caption, or the guidance of a `/steer` caption. */
  function telegramMediaCaption(
    message: TelegramMessageLike,
    chat: TelegramChatDescriptor,
  ): { caption?: string; requestedMode?: FollowUpMode } {
    const control = telegramRuntimeControl(message, chat, true);
    return control?.kind === 'steer'
      ? { caption: control.text, requestedMode: 'steer' }
      : { caption: message.caption };
  }

  /**
   * Persist one admitted input, offer it to the durable follow-up queue, then
   * project it. A queued input is released by the host when the active run
   * ends, so it neither wakes the poller nor starts its agent here.
   */
  function persistTelegramInbound(
    opts: TelegramConnectOpts,
    input: {
      id: string;
      jid: string;
      targetJid: string;
      sourceJid: string;
      senderName: string;
      content: string;
      timestamp: string;
      attachmentsJson?: string;
      agentId?: string;
      requestedMode?: FollowUpMode;
      /** The provider message: its context and any replied-to reference. */
      provider: {
        message: Parameters<
          typeof buildTelegramChannelTurnContext
        >[0]['message'];
        chat: TelegramChatDescriptor & { title?: string };
        from?: TelegramUserLike;
      };
    },
  ): ChannelFollowUpOutcome {
    // An unattributable sender (anonymous admin, channel identity) is stored
    // as such, so no later check can mistake the shared system account for
    // a person.
    const senderImId = telegramSenderImId({
      from: input.provider.from,
      sender_chat: input.provider.message.sender_chat,
    });
    const senderId = senderImId ? `tg:${senderImId}` : 'tg:unknown';
    const channelContext = buildTelegramChannelTurnContext({
      sourceJid: input.sourceJid,
      chat: input.provider.chat,
      message: input.provider.message,
      from: input.provider.from,
      botUserId,
    });
    storeMessageDirect(
      input.id,
      input.targetJid,
      senderId,
      input.senderName,
      input.content,
      input.timestamp,
      false,
      {
        attachments: input.attachmentsJson,
        sourceJid: input.sourceJid,
        channelContext,
      },
    );
    const followUp = projectChannelInbound(
      opts,
      {
        id: input.id,
        chat_jid: input.targetJid,
        source_jid: input.sourceJid,
        sender: senderId,
        sender_name: input.senderName,
        content: input.content,
        timestamp: input.timestamp,
        attachments: input.attachmentsJson,
        channel_context: channelContext,
        is_from_me: false,
      },
      { agentId: input.agentId, requestedMode: input.requestedMode },
    );
    if (followUp.shouldStartTurn) {
      if (input.agentId) opts.onAgentMessage?.(input.jid, input.agentId);
    }
    return followUp;
  }

  /**
   * Response audience of an authorized chat. Runs before commands and before
   * any registration, routing or download side effect; private chats are not
   * gated.
   */
  function telegramGroupAdmission(
    opts: TelegramConnectOpts,
    jid: string,
    chat: TelegramChatDescriptor,
    senderImId: string | undefined,
    text: string | undefined,
  ): GroupSenderAdmission {
    return isTelegramGroupChat(chat)
      ? groupSenderAdmission(opts, jid, senderImId, text ?? '')
      : 'admitted';
  }

  /**
   * One admission path for every caption-capable Telegram media update.
   * Pairing is completed before any download/registration side effect, and the
   * asynchronous pair attempt itself lives inside this try/catch so failures
   * reliably produce user-visible feedback.
   */
  async function admitTelegramMedia(input: {
    opts: TelegramConnectOpts;
    jid: string;
    chatName: string;
    chat: TelegramChatDescriptor;
    caption?: string;
    kind: TelegramNativeInboundKind | 'photo' | 'document';
    senderImId?: string;
    reply: (text: string) => Promise<unknown>;
  }): Promise<boolean> {
    if (input.opts.isChatAuthorized(input.jid)) {
      // Media is never dispatched as a command, so an `/owner_mention`
      // caption from a rejected sender gets no bootstrap exception.
      return (
        telegramGroupAdmission(
          input.opts,
          input.jid,
          input.chat,
          input.senderImId,
          input.caption,
        ) === 'admitted'
      );
    }

    const pairCode = matchTelegramPairCode(input.caption, botUsername);
    if (pairCode && input.opts.onPairAttempt) {
      try {
        const success = await input.opts.onPairAttempt(
          input.jid,
          input.chatName,
          pairCode,
        );
        if (success) {
          const forumState = await prepareTelegramForumPairing(
            input.jid,
            input.chat,
            (id) => bot!.api.getChat(id),
            input.opts.onNativeContextDetected,
          );
          if (forumState === 'thread_ready') {
            nativeContextReported.add(input.jid);
          }
          await input.reply(
            forumState === 'thread_unavailable'
              ? 'Pairing succeeded, but Telegram Forum routing could not be initialized. In Web settings, bind this channel to a default workspace before sending topic messages; do not bind it to a fixed session.'
              : 'Pairing successful! This chat is now connected.',
          );
        } else {
          await input.reply(
            'Invalid or expired pairing code. Please generate a new code from the web settings page.',
          );
        }
      } catch (err) {
        logger.error(
          { err, jid: input.jid, kind: input.kind },
          'Error during Telegram media pair attempt',
        );
        try {
          await input.reply(
            'Pairing failed due to an internal error. Please try again.',
          );
        } catch (replyErr) {
          logger.debug(
            { err: replyErr, jid: input.jid },
            'Failed to send Telegram pairing error feedback',
          );
        }
      }
      return false;
    }

    if (rejectCooldown.shouldNotify(input.jid)) {
      try {
        await input.reply(
          'This chat is not yet paired. Please send /pair <code> to connect.\n' +
            'You can generate a pairing code from the web settings page.',
        );
      } catch (err) {
        logger.debug(
          { err, jid: input.jid },
          'Failed to send Telegram unauthorized feedback',
        );
      }
    }
    logger.debug(
      { jid: input.jid, kind: input.kind },
      'Unauthorized Telegram media ignored',
    );
    return false;
  }

  function isExpectedStopError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err ?? '');
    return msg.includes('Aborted delay') || msg.includes('AbortError');
  }

  /** Return true if this message was sent before the current connection window. */
  function isStaleMessage(
    msgDate: number,
    ignoreMessagesBefore: number | undefined,
  ): boolean {
    if (!ignoreMessagesBefore) return false;
    const msgTimeMs = msgDate * 1000;
    if (msgTimeMs < ignoreMessagesBefore) {
      logger.info(
        { msgTime: msgTimeMs, threshold: ignoreMessagesBefore },
        'Skipping stale Telegram message from before reconnection',
      );
      return true;
    }
    return false;
  }

  const connection: TelegramConnection = {
    async connect(opts: TelegramConnectOpts): Promise<boolean> {
      if (!config.botToken) {
        logger.info('Telegram bot token not configured, skipping');
        return false;
      }

      bot = new Bot(config.botToken, {
        client: {
          timeoutSeconds: 30,
          baseFetchConfig: {
            agent: telegramApiAgent,
          },
        },
      });
      // A send Telegram refused with 429 is retried after its retry_after.
      bot.api.config.use(
        createTelegramRateLimitRetry({ isLive: () => !stopping }),
      );
      // Track completed Bot API long polls, rather than inbound messages: a
      // quiet chat is healthy as long as getUpdates keeps completing.
      bot.api.config.use(async (prev, method, payload, signal) => {
        if (method !== 'getUpdates') {
          return prev(method, payload, signal);
        }
        getUpdatesStartedAt = Date.now();
        try {
          const result = await prev(method, payload, signal);
          getUpdatesFinishedAt = Date.now();
          return result;
        } finally {
          getUpdatesStartedAt = null;
        }
      });
      stopping = false;
      readyFired = false;
      connected = false;
      getUpdatesStartedAt = null;
      getUpdatesFinishedAt = Date.now();
      watchdogRestarting = false;
      clearPollingWatchdog();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      bot.on('message:text', async (ctx) => {
        try {
          // Construct deduplication key
          const msgId =
            String(ctx.message.message_id) + ':' + String(ctx.chat.id);
          if (isGloballyStale(ctx.message.date * 1000)) {
            logger.debug(
              { msgId, createTimeMs: ctx.message.date * 1000 },
              'Stale Telegram message (>30min), dropping',
            );
            return;
          }
          if (dedup.isDuplicate(msgId)) {
            logger.debug({ msgId }, 'Duplicate Telegram message, skipping');
            return;
          }
          if (!processingLock.acquire(msgId)) {
            logger.debug(
              { msgId },
              'Telegram message already in-flight, skipping',
            );
            return;
          }
          dedup.markSeen(msgId);
          try {
            if (isStaleMessage(ctx.message.date, opts.ignoreMessagesBefore))
              return;

            const chatId = String(ctx.chat.id);
            const routeJid =
              opts.normalizeIncomingJid?.(
                buildTelegramRouteJid(chatId, ctx.message.message_thread_id),
              ) ?? buildTelegramRouteJid(chatId, ctx.message.message_thread_id);
            const jid = channelConversationJid(routeJid);
            const messageMeta = telegramMessageMeta(ctx.message);
            const chatName =
              ctx.chat.title ||
              [ctx.chat.first_name, ctx.chat.last_name]
                .filter(Boolean)
                .join(' ') ||
              `Telegram ${chatId}`;
            const senderName =
              [ctx.from?.first_name, ctx.from?.last_name]
                .filter(Boolean)
                .join(' ') || 'Unknown';
            const text = ctx.message.text;

            // ── /pair <code> command ──
            const pairCode = matchTelegramPairCode(text, botUsername);
            if (pairCode && opts.onPairAttempt) {
              const code = pairCode;
              try {
                const success = await opts.onPairAttempt(jid, chatName, code);
                if (success) {
                  const forumState = await prepareTelegramForumPairing(
                    jid,
                    ctx.chat as TelegramChatDescriptor,
                    (id) => bot!.api.getChat(id),
                    opts.onNativeContextDetected,
                  );
                  if (forumState === 'thread_ready') {
                    nativeContextReported.add(jid);
                  }
                  await ctx.reply(
                    forumState === 'thread_unavailable'
                      ? 'Pairing succeeded, but Telegram Forum routing could not be initialized. In Web settings, bind this channel to a default workspace before sending topic messages; do not bind it to a fixed session.'
                      : 'Pairing successful! This chat is now connected.',
                  );
                } else {
                  await ctx.reply(
                    'Invalid or expired pairing code. Please generate a new code from the web settings page.',
                  );
                }
              } catch (err) {
                logger.error({ err, jid }, 'Error during pair attempt');
                await ctx.reply(
                  'Pairing failed due to an internal error. Please try again.',
                );
              }
              return;
            }

            // ── /start command ──
            if (text.trim() === '/start') {
              if (opts.isChatAuthorized(jid)) {
                await ctx.reply(
                  'This chat is already connected. You can send messages normally.',
                );
              } else {
                await ctx.reply(
                  'Welcome! To connect this chat, please:\n' +
                    '1. Go to the web settings page\n' +
                    '2. Generate a pairing code\n' +
                    '3. Send /pair <code> here',
                );
              }
              return;
            }

            // ── Authorization check ──
            if (!opts.isChatAuthorized(jid)) {
              if (rejectCooldown.shouldNotify(jid)) {
                await ctx.reply(
                  'This chat is not yet paired. Please send /pair <code> to connect.\n' +
                    'You can generate a pairing code from the web settings page.',
                );
              }
              logger.debug(
                { jid, chatName },
                'Unauthorized Telegram chat, message ignored',
              );
              return;
            }
            const senderImId = telegramSenderImId({
              from: ctx.from,
              sender_chat: ctx.message.sender_chat,
            });
            const admission = telegramGroupAdmission(
              opts,
              jid,
              ctx.chat as TelegramChatDescriptor,
              senderImId,
              text,
            );
            if (admission === 'rejected') return;

            const resolveRoute = () =>
              resolveAdmittedChannelRoute(
                routeJid,
                opts.resolveEffectiveChatJid
                  ? () => opts.resolveEffectiveChatJid!(jid, messageMeta)
                  : undefined,
              );
            const runtimeControl = telegramRuntimeControl(
              ctx.message,
              ctx.chat as TelegramChatDescriptor,
              false,
            );
            const controlTarget = () =>
              telegramControlTarget(opts, jid, routeJid, messageMeta);
            if (runtimeControl?.kind === 'break') {
              const reply = await runSessionBreak(opts.onSessionBreak, {
                sourceJid: jid,
                targetJid: controlTarget(),
                senderImId: senderImId ?? '',
                chatType: isTelegramGroupChat(ctx.chat) ? 'group' : 'p2p',
              });
              await ctx.reply(reply);
              return;
            }
            if (runtimeControl?.kind === 'steer' && !controlTarget()) {
              await ctx.reply(STEER_TARGET_MISSING_REPLY);
              return;
            }
            const requestedFollowUpMode: FollowUpMode | undefined =
              runtimeControl?.kind === 'steer' ? 'steer' : undefined;
            const content =
              runtimeControl?.kind === 'steer' ? runtimeControl.text : text;

            // ── 斜杠指令：拦截已知 /xxx 命令，不进入消息流 ──
            // Telegram 群聊中会追加 @BotUsername，需要去掉
            //
            // Must run BEFORE resolveAdmittedChannelRoute: that resolver
            // (opts.resolveEffectiveChatJid, when native-thread routing is
            // in play) has side effects — it can create a conversation
            // agent/chat/workspace-mount row for a not-yet-seen thread.
            // A command like /status in a brand-new topic must not spend
            // that side effect before it's even known to be a command,
            // the same way Feishu intercepts slash commands ahead of its
            // own route resolution (see feishu.ts).
            const tgSlashMatch = text
              .trim()
              .match(/^\/(\S+?)(?:@\S+)?(?:\s+(.*))?$/i);
            if (tgSlashMatch && opts.onCommand && !requestedFollowUpMode) {
              const cmdBody = (
                tgSlashMatch[1] + (tgSlashMatch[2] ? ' ' + tgSlashMatch[2] : '')
              ).trim();
              logger.info(
                { jid, cmd: tgSlashMatch[1], cmdBody },
                'Telegram slash command detected',
              );
              try {
                const reply = await opts.onCommand(
                  jid,
                  cmdBody,
                  senderImId,
                  telegramCommandMentions(ctx.message),
                );
                if (reply) {
                  await ctx.reply(reply);
                  return; // 已知命令，拦截
                }
                // reply 为 null 表示未知命令，继续作为普通消息处理
              } catch (err) {
                logger.error(
                  { jid, cmd: tgSlashMatch[1], err },
                  'Telegram slash command failed',
                );
                try {
                  await ctx.reply('⚠️ 命令执行失败，请稍后重试');
                } catch (sendErr) {
                  logger.error(
                    { jid, sendErr },
                    'Failed to send slash command error feedback',
                  );
                }
                return;
              }
            }
            // Admitted only as `/owner_mention`, and not consumed as it.
            if (admission === 'bootstrap') return;

            const resolvedRoute = resolveRoute();
            if (!resolvedRoute) {
              logger.warn(
                { jid, routeJid },
                'Telegram message dropped: binding resolver rejected route',
              );
              return;
            }
            const { targetJid, routing: agentRouting } = resolvedRoute;
            const sourceJid = agentRouting?.sourceJid ?? routeJid;

            // ── Authorized chat: normal flow ──
            await reportNativeContext(opts, jid, ctx.message.message_thread_id);
            // 自动注册（确保 metadata 和名称同步）
            storeChatMetadata(jid, new Date().toISOString());
            updateChatName(jid, chatName);
            opts.onNewChat(jid, chatName);

            // 存储消息
            const id = crypto.randomUUID();
            ackReactions
              .attach(
                processingIndicatorKey(extractProviderTarget(sourceJid), id),
                async () => {
                  try {
                    await ctx.react('👀');
                    return {
                      chatId: ctx.chat.id,
                      messageId: ctx.message.message_id,
                    };
                  } catch (err) {
                    logger.debug(
                      { err, msgId },
                      'Failed to add Telegram reaction',
                    );
                    return null;
                  }
                },
                async (handle) => {
                  if (!bot) throw new Error('Telegram bot is not initialized');
                  await bot.api.setMessageReaction(
                    handle.chatId,
                    handle.messageId,
                    [],
                  );
                },
              )
              .catch(() => {});
            const timestamp = new Date(ctx.message.date * 1000).toISOString();
            storeChatMetadata(targetJid, timestamp);
            // The connector owns persistence; the host decides how to project it.
            const followUp = persistTelegramInbound(opts, {
              id,
              jid,
              targetJid,
              sourceJid,
              senderName,
              content,
              timestamp,
              agentId: agentRouting?.agentId ?? undefined,
              requestedMode: requestedFollowUpMode,
              provider: {
                message: ctx.message,
                chat: ctx.chat as TelegramChatDescriptor,
                from: ctx.from,
              },
            });
            logger.info(
              {
                jid,
                effectiveJid: targetJid,
                agentId: agentRouting?.agentId,
                sender: senderName,
                msgId,
                disposition: followUp.disposition,
              },
              'Telegram message stored',
            );
          } finally {
            processingLock.release(msgId);
          }
        } catch (err) {
          logger.error({ err }, 'Error handling Telegram message');
        }
      });

      // ── message:photo 处理器（Vision 通道，与飞书独立图片逻辑一致）──
      bot.on('message:photo', async (ctx) => {
        try {
          const msgId =
            String(ctx.message.message_id) + ':' + String(ctx.chat.id);
          if (isGloballyStale(ctx.message.date * 1000)) return;
          if (dedup.isDuplicate(msgId)) return;
          if (!processingLock.acquire(msgId)) return;
          dedup.markSeen(msgId);
          try {
            if (isStaleMessage(ctx.message.date, opts.ignoreMessagesBefore))
              return;

            const chatId = String(ctx.chat.id);
            const routeJid =
              opts.normalizeIncomingJid?.(
                buildTelegramRouteJid(chatId, ctx.message.message_thread_id),
              ) ?? buildTelegramRouteJid(chatId, ctx.message.message_thread_id);
            const jid = channelConversationJid(routeJid);
            const messageMeta = telegramMessageMeta(ctx.message);
            const chatName =
              ctx.chat.title ||
              [ctx.chat.first_name, ctx.chat.last_name]
                .filter(Boolean)
                .join(' ') ||
              `Telegram ${chatId}`;
            const senderName =
              [ctx.from?.first_name, ctx.from?.last_name]
                .filter(Boolean)
                .join(' ') || 'Unknown';

            if (
              !(await admitTelegramMedia({
                opts,
                jid,
                chatName,
                chat: ctx.chat as TelegramChatDescriptor,
                caption: ctx.message.caption,
                kind: 'photo',
                senderImId: telegramSenderImId({
                  from: ctx.from,
                  sender_chat: ctx.message.sender_chat,
                }),
                reply: (text) => ctx.reply(text),
              }))
            ) {
              return;
            }
            if (
              await steerHasNoTarget(
                opts,
                ctx.message,
                ctx.chat as TelegramChatDescriptor,
                { jid, routeJid, messageMeta },
                (text) => ctx.reply(text),
              )
            ) {
              return;
            }

            const resolvedRoute = resolveAdmittedChannelRoute(
              routeJid,
              opts.resolveEffectiveChatJid
                ? () => opts.resolveEffectiveChatJid!(jid, messageMeta)
                : undefined,
            );
            if (!resolvedRoute) {
              logger.warn(
                { jid, routeJid },
                'Telegram photo dropped: binding resolver rejected route',
              );
              return;
            }
            const { targetJid, routing: agentRouting } = resolvedRoute;
            const sourceJid = agentRouting?.sourceJid ?? routeJid;

            await reportNativeContext(opts, jid, ctx.message.message_thread_id);
            storeChatMetadata(jid, new Date().toISOString());
            updateChatName(jid, chatName);
            opts.onNewChat(jid, chatName);

            // 取最高分辨率，下载为 base64 供 Vision
            const photo = ctx.message.photo.at(-1);
            if (!photo) return;

            const imageData = await downloadTelegramPhotoAsBase64(
              photo.file_id,
              photo.file_size,
            );

            let attachmentsJson: string | undefined;
            let imgMarker = '[图片]';

            if (imageData) {
              attachmentsJson = JSON.stringify([
                {
                  type: 'image',
                  data: imageData.base64,
                  mimeType: imageData.mimeType,
                },
              ]);

              // 存盘：与飞书图片处理逻辑对齐，agent 可通过路径直接操作文件
              const groupFolder = opts.resolveGroupFolder?.(jid);
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
                const fileName = `telegram_img_${photo.file_id.slice(-8)}${ext}`;
                try {
                  const relPath = await saveDownloadedFile(
                    groupFolder,
                    'telegram',
                    fileName,
                    Buffer.from(imageData.base64, 'base64'),
                    targetJid,
                  );
                  if (relPath) imgMarker = `[图片: ${relPath}]`;
                } catch (err) {
                  logger.warn(
                    { err, fileId: photo.file_id },
                    'Failed to save Telegram photo to disk',
                  );
                }
              }
            }

            const { caption, requestedMode } = telegramMediaCaption(
              ctx.message,
              ctx.chat as TelegramChatDescriptor,
            );
            const text = telegramMediaMessageText(imgMarker, caption);

            const id = crypto.randomUUID();
            ackReactions
              .attach(
                processingIndicatorKey(extractProviderTarget(sourceJid), id),
                async () => {
                  try {
                    await ctx.react('👀');
                    return {
                      chatId: ctx.chat.id,
                      messageId: ctx.message.message_id,
                    };
                  } catch (err) {
                    logger.debug(
                      { err, msgId },
                      'Failed to add Telegram reaction',
                    );
                    return null;
                  }
                },
                async (handle) => {
                  if (!bot) throw new Error('Telegram bot is not initialized');
                  await bot.api.setMessageReaction(
                    handle.chatId,
                    handle.messageId,
                    [],
                  );
                },
              )
              .catch(() => {});
            const timestamp = new Date(ctx.message.date * 1000).toISOString();
            storeChatMetadata(targetJid, timestamp);
            persistTelegramInbound(opts, {
              id,
              jid,
              targetJid,
              sourceJid,
              senderName,
              content: text,
              timestamp,
              attachmentsJson,
              agentId: agentRouting?.agentId ?? undefined,
              requestedMode,
              provider: {
                message: ctx.message,
                chat: ctx.chat as TelegramChatDescriptor,
                from: ctx.from,
              },
            });

            logger.info(
              { jid, sender: senderName, msgId, routed: !!agentRouting },
              'Telegram photo stored',
            );
          } finally {
            processingLock.release(msgId);
          }
        } catch (err) {
          logger.error({ err }, 'Error handling Telegram photo');
        }
      });

      // ── message:document 处理器 ──
      bot.on('message:document', async (ctx, next) => {
        try {
          // Telegram exposes animations through both `animation` and the
          // backwards-compatible `document` field. Let the native animation
          // handler own it so one update cannot race two persistence paths.
          if (await yieldTelegramAnimationDocument(ctx.message, next)) return;
          const msgId =
            String(ctx.message.message_id) + ':' + String(ctx.chat.id);
          if (isGloballyStale(ctx.message.date * 1000)) return;
          if (dedup.isDuplicate(msgId)) return;
          if (!processingLock.acquire(msgId)) return;
          dedup.markSeen(msgId);
          try {
            if (isStaleMessage(ctx.message.date, opts.ignoreMessagesBefore))
              return;

            const chatId = String(ctx.chat.id);
            const routeJid =
              opts.normalizeIncomingJid?.(
                buildTelegramRouteJid(chatId, ctx.message.message_thread_id),
              ) ?? buildTelegramRouteJid(chatId, ctx.message.message_thread_id);
            const jid = channelConversationJid(routeJid);
            const messageMeta = telegramMessageMeta(ctx.message);
            const chatName =
              ctx.chat.title ||
              [ctx.chat.first_name, ctx.chat.last_name]
                .filter(Boolean)
                .join(' ') ||
              `Telegram ${chatId}`;
            const senderName =
              [ctx.from?.first_name, ctx.from?.last_name]
                .filter(Boolean)
                .join(' ') || 'Unknown';

            if (
              !(await admitTelegramMedia({
                opts,
                jid,
                chatName,
                chat: ctx.chat as TelegramChatDescriptor,
                caption: ctx.message.caption,
                kind: 'document',
                senderImId: telegramSenderImId({
                  from: ctx.from,
                  sender_chat: ctx.message.sender_chat,
                }),
                reply: (text) => ctx.reply(text),
              }))
            ) {
              return;
            }
            if (
              await steerHasNoTarget(
                opts,
                ctx.message,
                ctx.chat as TelegramChatDescriptor,
                { jid, routeJid, messageMeta },
                (text) => ctx.reply(text),
              )
            ) {
              return;
            }

            const resolvedRoute = resolveAdmittedChannelRoute(
              routeJid,
              opts.resolveEffectiveChatJid
                ? () => opts.resolveEffectiveChatJid!(jid, messageMeta)
                : undefined,
            );
            if (!resolvedRoute) {
              logger.warn(
                { jid, routeJid },
                'Telegram document dropped: binding resolver rejected route',
              );
              return;
            }
            const { targetJid, routing: agentRouting } = resolvedRoute;
            const sourceJid = agentRouting?.sourceJid ?? routeJid;

            await reportNativeContext(opts, jid, ctx.message.message_thread_id);
            storeChatMetadata(jid, new Date().toISOString());
            updateChatName(jid, chatName);
            opts.onNewChat(jid, chatName);

            const doc = ctx.message.document;
            const originalFilename = doc.file_name || 'file';
            const safeFilename = sanitizeImFilename(originalFilename);

            // file_size 超过上限时跳过下载
            const { caption, requestedMode } = telegramMediaCaption(
              ctx.message,
              ctx.chat as TelegramChatDescriptor,
            );
            if (doc.file_size !== undefined && doc.file_size > MAX_FILE_SIZE) {
              persistTelegramInbound(opts, {
                id: crypto.randomUUID(),
                jid,
                targetJid,
                sourceJid,
                senderName,
                content: telegramMediaMessageText(
                  `[文件过大，未下载: ${safeFilename}]`,
                  caption,
                ),
                timestamp: new Date(ctx.message.date * 1000).toISOString(),
                agentId: agentRouting?.agentId ?? undefined,
                requestedMode,
                provider: {
                  message: ctx.message,
                  chat: ctx.chat as TelegramChatDescriptor,
                  from: ctx.from,
                },
              });
              return;
            }

            const groupFolder = opts.resolveGroupFolder?.(jid);
            let fileText: string;

            if (!groupFolder) {
              fileText = `[文件下载失败: 无法确定工作目录]`;
            } else {
              const relPath = await downloadTelegramFile(
                doc.file_id,
                originalFilename,
                groupFolder,
                targetJid,
                doc.file_size,
              );
              fileText = relPath
                ? `[文件: ${relPath}]`
                : `[文件下载失败: ${safeFilename}]`;
            }

            const text = telegramMediaMessageText(fileText, caption);

            const id = crypto.randomUUID();
            ackReactions
              .attach(
                processingIndicatorKey(extractProviderTarget(sourceJid), id),
                async () => {
                  try {
                    await ctx.react('👀');
                    return {
                      chatId: ctx.chat.id,
                      messageId: ctx.message.message_id,
                    };
                  } catch (err) {
                    logger.debug(
                      { err, msgId },
                      'Failed to add Telegram reaction',
                    );
                    return null;
                  }
                },
                async (handle) => {
                  if (!bot) throw new Error('Telegram bot is not initialized');
                  await bot.api.setMessageReaction(
                    handle.chatId,
                    handle.messageId,
                    [],
                  );
                },
              )
              .catch(() => {});
            const timestamp = new Date(ctx.message.date * 1000).toISOString();
            storeChatMetadata(targetJid, timestamp);
            persistTelegramInbound(opts, {
              id,
              jid,
              targetJid,
              sourceJid,
              senderName,
              content: text,
              timestamp,
              agentId: agentRouting?.agentId ?? undefined,
              requestedMode,
              provider: {
                message: ctx.message,
                chat: ctx.chat as TelegramChatDescriptor,
                from: ctx.from,
              },
            });

            logger.info(
              { jid, sender: senderName, msgId, routed: !!agentRouting },
              'Telegram document stored',
            );
          } finally {
            processingLock.release(msgId);
          }
        } catch (err) {
          logger.error({ err }, 'Error handling Telegram document');
        }
      });

      // ── 原生媒体（不是 "Send as file"）、贴纸、位置与联系人 ──
      const handleNativeTelegramMedia = async (ctx: Context): Promise<void> => {
        try {
          const tgMessage = ctx.message;
          const tgChat = ctx.chat;
          if (!tgMessage || !tgChat) return;
          const inbound = telegramNativeInboundFromMessage(tgMessage);
          if (!inbound) return;
          const msgId = String(tgMessage.message_id) + ':' + String(tgChat.id);
          if (isGloballyStale(tgMessage.date * 1000)) return;
          if (dedup.isDuplicate(msgId)) return;
          if (!processingLock.acquire(msgId)) return;
          dedup.markSeen(msgId);
          try {
            if (isStaleMessage(tgMessage.date, opts.ignoreMessagesBefore))
              return;

            const chatId = String(tgChat.id);
            const routeJid =
              opts.normalizeIncomingJid?.(
                buildTelegramRouteJid(chatId, tgMessage.message_thread_id),
              ) ?? buildTelegramRouteJid(chatId, tgMessage.message_thread_id);
            const jid = channelConversationJid(routeJid);
            const messageMeta = telegramMessageMeta(tgMessage);
            const chatName =
              tgChat.title ||
              [tgChat.first_name, tgChat.last_name].filter(Boolean).join(' ') ||
              `Telegram ${chatId}`;
            const senderName =
              [ctx.from?.first_name, ctx.from?.last_name]
                .filter(Boolean)
                .join(' ') || 'Unknown';

            if (
              !(await admitTelegramMedia({
                opts,
                jid,
                chatName,
                chat: tgChat as TelegramChatDescriptor,
                caption: tgMessage.caption,
                kind: inbound.kind,
                senderImId: telegramSenderImId({
                  from: ctx.from,
                  sender_chat: tgMessage.sender_chat,
                }),
                reply: (text) => ctx.reply(text),
              }))
            ) {
              return;
            }
            if (
              await steerHasNoTarget(
                opts,
                tgMessage,
                tgChat as TelegramChatDescriptor,
                { jid, routeJid, messageMeta },
                (text) => ctx.reply(text),
              )
            ) {
              return;
            }

            const resolvedRoute = resolveAdmittedChannelRoute(
              routeJid,
              opts.resolveEffectiveChatJid
                ? () => opts.resolveEffectiveChatJid!(jid, messageMeta)
                : undefined,
            );
            if (!resolvedRoute) {
              logger.warn(
                { jid, routeJid, kind: inbound.kind },
                'Telegram native media dropped: binding resolver rejected route',
              );
              return;
            }
            const { targetJid, routing: agentRouting } = resolvedRoute;
            const sourceJid = agentRouting?.sourceJid ?? routeJid;

            await reportNativeContext(opts, jid, tgMessage.message_thread_id);
            storeChatMetadata(jid, new Date().toISOString());
            updateChatName(jid, chatName);
            opts.onNewChat(jid, chatName);

            let fileText: string | undefined;
            const file = inbound.file;
            if (file) {
              const originalFilename = file.fileName;
              const safeFilename = sanitizeImFilename(originalFilename);
              const groupFolder = opts.resolveGroupFolder?.(jid);
              if (
                file.fileSize !== undefined &&
                file.fileSize > MAX_FILE_SIZE
              ) {
                fileText = `[文件过大，未下载: ${safeFilename}]`;
              } else if (!groupFolder) {
                fileText = `[文件下载失败: 无法确定工作目录]`;
              } else {
                const relPath = await downloadTelegramFile(
                  file.fileId,
                  originalFilename,
                  groupFolder,
                  targetJid,
                  file.fileSize,
                );
                fileText = relPath
                  ? `[文件: ${relPath}]`
                  : `[文件下载失败: ${safeFilename}]`;
              }
            }

            // One UUID owns both the exact-input reaction and the durable row.
            // Passing the already-final marker avoids rebuilding a fake path in
            // a second helper and preserves download/oversize failure details.
            const id = crypto.randomUUID();
            ackReactions
              .attach(
                processingIndicatorKey(extractProviderTarget(sourceJid), id),
                async () => {
                  try {
                    await ctx.react('👀');
                    return {
                      chatId: tgChat.id,
                      messageId: tgMessage.message_id,
                    };
                  } catch (err) {
                    logger.debug(
                      { err, msgId },
                      'Failed to add Telegram reaction',
                    );
                    return null;
                  }
                },
                async (handle) => {
                  if (!bot) throw new Error('Telegram bot is not initialized');
                  await bot.api.setMessageReaction(
                    handle.chatId,
                    handle.messageId,
                    [],
                  );
                },
              )
              .catch(() => {});
            const timestamp = new Date(tgMessage.date * 1000).toISOString();
            const { caption, requestedMode } = telegramMediaCaption(
              tgMessage,
              tgChat as TelegramChatDescriptor,
            );
            const text = telegramMediaMessageText(
              [inbound.text, fileText].filter(Boolean).join('\n'),
              caption,
            );
            storeChatMetadata(targetJid, timestamp);
            persistTelegramInbound(opts, {
              id,
              jid,
              targetJid,
              sourceJid,
              senderName,
              content: text,
              timestamp,
              agentId: agentRouting?.agentId ?? undefined,
              requestedMode,
              provider: {
                message: tgMessage,
                chat: tgChat as TelegramChatDescriptor,
                from: ctx.from,
              },
            });

            logger.info(
              {
                jid,
                sender: senderName,
                msgId,
                kind: inbound.kind,
                routed: !!agentRouting,
              },
              'Telegram native media stored',
            );
          } finally {
            processingLock.release(msgId);
          }
        } catch (err) {
          logger.error({ err }, 'Error handling Telegram native media');
        }
      };
      bot.on('message:video', handleNativeTelegramMedia);
      bot.on('message:voice', handleNativeTelegramMedia);
      bot.on('message:audio', handleNativeTelegramMedia);
      bot.on('message:animation', handleNativeTelegramMedia);
      bot.on('message:sticker', handleNativeTelegramMedia);
      bot.on('message:video_note', handleNativeTelegramMedia);
      bot.on('message:location', handleNativeTelegramMedia);
      bot.on('message:contact', handleNativeTelegramMedia);

      // ── my_chat_member: Bot 加入/离开群聊检测 ──
      bot.on('my_chat_member', async (ctx) => {
        try {
          const update = ctx.myChatMember;
          const chatType = update.chat.type;
          // 仅处理群聊；私聊走 /start + /pair 流程
          if (chatType !== 'group' && chatType !== 'supergroup') return;

          const chatId = String(update.chat.id);
          const jid =
            opts.normalizeIncomingJid?.(`telegram:${chatId}`) ??
            `telegram:${chatId}`;
          const chatName = update.chat.title || `Telegram ${chatId}`;
          const newStatus = update.new_chat_member.status;
          const oldStatus = update.old_chat_member.status;
          const authorized = opts.isChatAuthorized(jid);
          if (
            authorized &&
            (update.chat as typeof update.chat & { is_forum?: boolean })
              .is_forum
          ) {
            await reportNativeContext(opts, jid, 1);
          }

          if (
            (oldStatus === 'left' || oldStatus === 'kicked') &&
            (newStatus === 'member' || newStatus === 'administrator')
          ) {
            logger.info(
              { jid, chatName, newStatus },
              'Telegram bot added to group',
            );
            if (authorized) {
              opts.onBotAddedToGroup?.(jid, chatName);
            } else {
              logger.info(
                { jid, chatName },
                'Telegram bot joined an unpaired group; awaiting /pair',
              );
            }
          }

          if (
            (oldStatus === 'member' || oldStatus === 'administrator') &&
            (newStatus === 'left' || newStatus === 'kicked')
          ) {
            logger.info(
              { jid, chatName, newStatus },
              'Telegram bot removed from group',
            );
            opts.onBotRemovedFromGroup?.(jid);
          }
        } catch (err) {
          logger.error(
            { err },
            'Error handling Telegram my_chat_member update',
          );
        }
      });

      // Validate credentials/network before reporting transport readiness.
      const me = await bot.api.getMe();
      botUsername = me.username;
      botUserId = me.id;

      let settleInitialReady: ((ready: boolean) => void) | null = null;
      const initialReady = new Promise<boolean>((resolve) => {
        settleInitialReady = resolve;
      });
      const startPolling = (): void => {
        if (!bot || stopping) return;
        pollingPromise = bot
          .start({
            allowed_updates: ['message', 'edited_message', 'my_chat_member'],
            onStart: () => {
              connected = true;
              logger.info('Telegram bot started');
              if (!readyFired) {
                readyFired = true;
                opts.onReady?.();
              }
              settleInitialReady?.(true);
              settleInitialReady = null;
            },
          })
          .catch((err) => {
            connected = false;
            settleInitialReady?.(false);
            settleInitialReady = null;
            // bot.stop() during hot-reload will abort long polling; this is expected.
            if (stopping && isExpectedStopError(err)) return;
            if (watchdogRestarting && isExpectedStopError(err)) return;

            logger.error({ err }, 'Telegram bot polling crashed');
            if (stopping || !bot) return;

            reconnectTimer = setTimeout(() => {
              reconnectTimer = null;
              if (!stopping && bot) {
                logger.info('Restarting Telegram bot polling');
                startPolling();
              }
            }, POLLING_RESTART_DELAY_MS);
          });
      };

      startPolling();
      pollingWatchdogTimer = setInterval(() => {
        if (stopping || !bot || !connected || watchdogRestarting) return;
        const lastActivity = getUpdatesStartedAt ?? getUpdatesFinishedAt;
        if (Date.now() - lastActivity <= POLLING_STALL_THRESHOLD_MS) return;

        watchdogRestarting = true;
        connected = false;
        logger.warn(
          {
            getUpdatesStartedAt,
            getUpdatesFinishedAt,
            thresholdMs: POLLING_STALL_THRESHOLD_MS,
          },
          'Telegram polling stalled; restarting long poll',
        );
        const stalledPolling = pollingPromise;
        try {
          bot.stop();
        } catch (err) {
          logger.debug({ err }, 'Failed to stop stalled Telegram polling');
        }
        void Promise.resolve(stalledPolling)
          .catch(() => undefined)
          .then(() => {
            watchdogRestarting = false;
            getUpdatesStartedAt = null;
            getUpdatesFinishedAt = Date.now();
            if (!stopping && bot) startPolling();
          });
      }, POLLING_WATCHDOG_INTERVAL_MS);
      const timeout = setTimeout(() => {
        settleInitialReady?.(false);
        settleInitialReady = null;
      }, 15_000);
      const ready = await initialReady;
      clearTimeout(timeout);
      if (!ready) {
        await connection.disconnect();
      }
      return ready;
    },

    async disconnect(): Promise<void> {
      stopping = true;
      connected = false;
      watchdogRestarting = false;
      clearPollingWatchdog();
      await ackReactions.clearAll();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (bot) {
        try {
          bot.stop();
          logger.info('Telegram bot stopped');
        } catch (err) {
          logger.error({ err }, 'Error stopping Telegram bot');
        } finally {
          try {
            await pollingPromise;
          } catch (err) {
            if (!isExpectedStopError(err)) {
              logger.debug(
                { err },
                'Telegram polling promise rejected on disconnect',
              );
            }
          }
          pollingPromise = null;
          bot = null;
          telegramApiAgent.destroy();
        }
      }
      processingLock.dispose();
      nativeContextReported.clear();
      botUsername = undefined;
      botUserId = undefined;
    },

    async sendMessage(
      chatId: string,
      text: string,
      localImagePaths?: string[],
    ): Promise<void> {
      const activeBot = requireOutboundBot();

      const target = parseTelegramProviderTarget(chatId);
      if (!target) {
        throw new Error(`Invalid Telegram chat ID: ${chatId || '<empty>'}`);
      }
      const threadOptions = target.messageThreadId
        ? { message_thread_id: target.messageThreadId }
        : {};

      try {
        const chunks = chunkTelegramMarkdown(text);
        const tracker = new PhysicalDeliveryTracker(
          chunks.length + (localImagePaths?.length ?? 0),
        );

        for (const chunk of chunks) {
          await tracker.send(async () => {
            await sendTelegramChunk(
              activeBot,
              target.chatId,
              chunk,
              threadOptions,
            );
          });
        }

        for (const localImagePath of localImagePaths || []) {
          try {
            await tracker.send(() =>
              activeBot.api
                .sendPhoto(
                  target.chatId,
                  new InputFile(localImagePath),
                  threadOptions,
                )
                .then(() => undefined),
            );
          } catch (imageErr) {
            logger.error(
              { chatId, localImagePath, err: imageErr },
              'Failed to send Telegram image attachment',
            );
            throw imageErr;
          }
        }

        logger.info({ chatId }, 'Telegram message sent');
      } catch (err) {
        logger.error({ err, chatId }, 'Failed to send Telegram message');
        throw classifyTelegramSendError(err);
      }
    },

    clearAckReaction(chatId: string, inputMessageId: string): Promise<void> {
      return ackReactions.clear(processingIndicatorKey(chatId, inputMessageId));
    },

    createStreamingSession(
      chatId: string,
      onCardCreated?: (messageId: string) => void,
    ): TelegramStreamingController | undefined {
      const target = parseTelegramProviderTarget(chatId);
      if (!target || !bot) return undefined;
      return new TelegramStreamingController(
        telegramStreamingTransport(target),
        { onCardCreated },
      );
    },

    async sendImage(
      chatId: string,
      imageBuffer: Buffer,
      mimeType: string,
      caption?: string,
      fileName?: string,
    ): Promise<void> {
      const activeBot = requireOutboundBot();

      const target = parseTelegramProviderTarget(chatId);
      if (!target) {
        throw new Error(
          `Invalid Telegram chat ID for image: ${chatId || '<empty>'}`,
        );
      }
      const threadOptions = target.messageThreadId
        ? { message_thread_id: target.messageThreadId }
        : {};

      try {
        // Determine file extension from MIME type
        const extMap: Record<string, string> = {
          'image/png': '.png',
          'image/jpeg': '.jpg',
          'image/gif': '.gif',
          'image/webp': '.webp',
          'image/bmp': '.bmp',
          'image/tiff': '.tiff',
        };
        const ext = extMap[mimeType] || '.png';
        const effectiveFileName = fileName || `image${ext}`;

        const inputFile = new InputFile(imageBuffer, effectiveFileName);

        // Telegram caption limit is 1024 characters; truncate to avoid API errors
        const CAPTION_MAX = 1024;
        const safeCaption =
          caption && caption.length > CAPTION_MAX
            ? caption.slice(0, CAPTION_MAX - 3) + '...'
            : caption || undefined;

        // GIF → sendAnimation (preserves animation); JPEG/PNG/WebP → sendPhoto; others → sendDocument
        const isGif = mimeType === 'image/gif';
        const isPhoto = ['image/png', 'image/jpeg', 'image/webp'].includes(
          mimeType,
        );

        if (isGif) {
          await activeBot.api.sendAnimation(target.chatId, inputFile, {
            caption: safeCaption,
            ...threadOptions,
          });
        } else if (isPhoto) {
          await activeBot.api.sendPhoto(target.chatId, inputFile, {
            caption: safeCaption,
            ...threadOptions,
          });
        } else {
          await activeBot.api.sendDocument(target.chatId, inputFile, {
            caption: safeCaption,
            ...threadOptions,
          });
        }

        logger.info(
          {
            chatId,
            mimeType,
            size: imageBuffer.length,
            fileName: effectiveFileName,
          },
          'Telegram image sent',
        );
      } catch (err) {
        logger.error(
          { err, chatId, mimeType },
          'Failed to send Telegram image',
        );
        throw classifyTelegramSendError(err);
      }
    },

    async sendFile(
      chatId: string,
      filePath: string,
      fileName: string,
      options?: { asDocument?: boolean },
    ): Promise<void> {
      const activeBot = requireOutboundBot();

      const target = parseTelegramProviderTarget(chatId);
      if (!target) {
        throw new Error(
          `Invalid Telegram chat ID for file: ${chatId || '<empty>'}`,
        );
      }

      try {
        // Local preflight (readable file, 30MB limit same as the MCP tool)
        // provably produced no provider mutation, so it must be a definitive
        // rejection — a bare Error here would fence the whole turn as
        // `uncertain` and silently swallow every later send in it.
        const stat = await fsPromises.stat(filePath).catch((statErr) => {
          throw new DefinitiveChannelDeliveryError(
            `文件无法读取: ${statErr instanceof Error ? statErr.message : String(statErr)}`,
            { cause: statErr },
          );
        });
        const MAX_SEND_FILE_SIZE = 30 * 1024 * 1024;
        if (stat.size > MAX_SEND_FILE_SIZE) {
          throw new DefinitiveChannelDeliveryError(
            `文件大小超过 30MB 限制 (${(stat.size / 1024 / 1024).toFixed(2)}MB)`,
          );
        }

        const inputFile = new InputFile(filePath, fileName);
        const threadOptions = target.messageThreadId
          ? { message_thread_id: target.messageThreadId }
          : {};
        const fileKind = options?.asDocument
          ? 'document'
          : telegramOutboundFileKind(fileName);
        if (fileKind === 'video') {
          const dimensions = await readMp4VideoDimensions(filePath).catch(
            (err) => {
              logger.warn({ err, fileName }, 'Failed to read MP4 dimensions');
              return undefined;
            },
          );
          if (dimensions) {
            await activeBot.api.sendVideo(target.chatId, inputFile, {
              ...dimensions,
              ...threadOptions,
            });
          } else {
            // Choose a single presentation before the provider call. A failed
            // sendVideo must never trigger a second, potentially duplicate send.
            logger.warn(
              { fileName },
              'MP4 dimensions unavailable; sending original file as document',
            );
            await activeBot.api.sendDocument(
              target.chatId,
              inputFile,
              threadOptions,
            );
          }
        } else if (fileKind === 'audio') {
          await activeBot.api.sendAudio(
            target.chatId,
            inputFile,
            threadOptions,
          );
        } else if (fileKind === 'voice') {
          await activeBot.api.sendVoice(
            target.chatId,
            inputFile,
            threadOptions,
          );
        } else {
          await activeBot.api.sendDocument(
            target.chatId,
            inputFile,
            threadOptions,
          );
        }

        logger.info(
          { chatId, filePath, fileName, size: stat.size },
          'Telegram file sent',
        );
      } catch (err) {
        logger.error(
          { err, chatId, filePath, fileName },
          'Failed to send Telegram file',
        );
        throw classifyTelegramSendError(err);
      }
    },

    async sendChatAction(chatId: string, action: 'typing'): Promise<void> {
      if (!bot) return;
      const target = parseTelegramProviderTarget(chatId);
      if (!target) return;
      try {
        await bot.api.sendChatAction(target.chatId, action, {
          ...(target.messageThreadId
            ? { message_thread_id: target.messageThreadId }
            : {}),
        });
      } catch (err) {
        logger.debug({ err, chatId }, 'Failed to send Telegram chat action');
      }
    },

    isConnected(): boolean {
      return connected;
    },
  };

  return connection;
}
