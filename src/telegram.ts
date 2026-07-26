import { Bot, InputFile } from 'grammy';
import crypto from 'crypto';
import fsPromises from 'node:fs/promises';
import https from 'node:https';
import { Agent as HttpsAgent } from 'node:https';
import { ProxyAgent } from 'proxy-agent';
import { storeChatMetadata, storeMessageDirect, updateChatName } from './db.js';
import { createDedupCache } from './im-utils.js';
import { notifyNewImMessage } from './message-notifier.js';
import { broadcastNewMessage } from './web.js';
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
} from './channel-address.js';
import { resolveAdmittedChannelRoute } from './channel-admission.js';
import type { ChannelMessageMeta } from './types.js';
import {
  ExactAsyncIndicatorRegistry,
  processingIndicatorKey,
} from './processing-indicator.js';
// ─── TelegramConnection Interface ──────────────────────────────

export interface TelegramConnectionConfig {
  botToken: string;
  proxyUrl?: string;
}

export interface TelegramConnectOpts {
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
  ) => Promise<string | null>;
  /** 热重连时设置：丢弃 date 早于此时间戳（epoch ms）的消息，避免处理渠道关闭期间的堆积消息 */
  ignoreMessagesBefore?: number;
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
  /** Bot 被添加到群聊时调用（仅 group/supergroup） */
  onBotAddedToGroup?: (chatJid: string, chatName: string) => void;
  /** Bot 被移出群聊或群被解散时调用 */
  onBotRemovedFromGroup?: (chatJid: string) => void;
  /** Native topic capability discovered for the registered base chat. */
  onNativeContextDetected?: (
    chatJid: string,
    contextType: 'thread',
  ) => boolean | void | Promise<boolean | void>;
  normalizeIncomingJid?: (jid: string) => string;
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
  sendFile(chatId: string, filePath: string, fileName: string): Promise<void>;
  sendChatAction(chatId: string, action: 'typing'): Promise<void>;
  clearAckReaction(chatId: string, inputMessageId: string): Promise<void>;
  isConnected(): boolean;
}

// ─── Shared Helpers (pure functions, no instance state) ────────

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Convert Markdown to Telegram-compatible HTML.
 * Handles: code blocks, inline code, bold, italic, strikethrough, links, headings.
 */
function markdownToTelegramHtml(md: string): string {
  // Step 1: Extract code blocks to protect them from further processing
  const codeBlocks: string[] = [];
  let text = md.replace(/```[\s\S]*?```/g, (match) => {
    const code = match.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
    codeBlocks.push(`<pre><code>${escapeHtml(code)}</code></pre>`);
    return `\x00CB${codeBlocks.length - 1}\x00`;
  });

  // Step 2: Extract inline code
  const inlineCodes: string[] = [];
  text = text.replace(/`([^`]+)`/g, (_, code: string) => {
    inlineCodes.push(`<code>${escapeHtml(code)}</code>`);
    return `\x00IC${inlineCodes.length - 1}\x00`;
  });

  // Step 3: Escape HTML in remaining text
  text = escapeHtml(text);

  // Step 4: Convert Markdown formatting
  // Links: [text](url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  // Bold: **text** or __text__
  text = text.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  text = text.replace(/__(.+?)__/g, '<b>$1</b>');
  // Strikethrough: ~~text~~ (before italic to avoid conflicts)
  text = text.replace(/~~(.+?)~~/g, '<s>$1</s>');
  // Italic: *text* (not preceded/followed by word chars to avoid false matches)
  text = text.replace(/(?<!\w)\*(?!\s)(.+?)(?<!\s)\*(?!\w)/g, '<i>$1</i>');
  // Headings: # text → bold
  text = text.replace(/^#{1,6}\s+(.+)$/gm, '<b>$1</b>');

  // Step 5: Restore code blocks and inline code
  text = text.replace(/\x00CB(\d+)\x00/g, (_, i) => codeBlocks[Number(i)]);
  text = text.replace(/\x00IC(\d+)\x00/g, (_, i) => inlineCodes[Number(i)]);

  return text;
}

/**
 * Split markdown text into chunks at safe boundaries (paragraphs, lines, words).
 */
function splitMarkdownChunks(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    // Try to split at paragraph boundary
    let splitIdx = remaining.lastIndexOf('\n\n', limit);
    if (splitIdx < limit * 0.3) {
      // Try single newline
      splitIdx = remaining.lastIndexOf('\n', limit);
    }
    if (splitIdx < limit * 0.3) {
      // Try space
      splitIdx = remaining.lastIndexOf(' ', limit);
    }
    if (splitIdx < limit * 0.3) {
      // Hard split
      splitIdx = limit;
    }

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  return chunks;
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
  const telegramApiAgent =
    config.proxyUrl && config.proxyUrl.trim()
      ? new ProxyAgent({
          getProxyForUrl: () => config.proxyUrl!.trim(),
        })
      : new HttpsAgent({ keepAlive: true, family: 4 });

  function clearPollingWatchdog(): void {
    if (pollingWatchdogTimer) {
      clearInterval(pollingWatchdogTimer);
      pollingWatchdogTimer = null;
    }
  }

  /**
   * 通过 Telegram Bot API 下载文件到工作区磁盘。
   * 返回工作区相对路径，失败返回 null。
   */
  async function downloadTelegramFile(
    fileId: string,
    originalFilename: string,
    groupFolder: string,
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
      const buffer = await new Promise<Buffer>((resolve, reject) => {
        https
          .get(url, { agent: telegramApiAgent }, (res) => {
            const chunks: Buffer[] = [];
            let total = 0;
            res.on('data', (chunk: Buffer) => {
              total += chunk.length;
              if (total > MAX_FILE_SIZE) {
                res.destroy(
                  new Error('File exceeds MAX_FILE_SIZE during download'),
                );
                return;
              }
              chunks.push(chunk);
            });
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
          })
          .on('error', reject);
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
      const buffer = await new Promise<Buffer>((resolve, reject) => {
        https
          .get(url, { agent: telegramApiAgent }, (res) => {
            const chunks: Buffer[] = [];
            let total = 0;
            res.on('data', (chunk: Buffer) => {
              total += chunk.length;
              if (total > MAX_FILE_SIZE) {
                res.destroy(
                  new Error('Photo exceeds MAX_FILE_SIZE during download'),
                );
                return;
              }
              chunks.push(chunk);
            });
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
          })
          .on('error', reject);
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
  const rejectTimestamps = new Map<string, number>();
  const REJECT_COOLDOWN_MS = 5 * 60 * 1000;
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
            const pairMatch = text.match(/^\/pair\s+(\S+)/i);
            if (pairMatch && opts.onPairAttempt) {
              const code = pairMatch[1];
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
              const now = Date.now();
              const lastReject = rejectTimestamps.get(jid) ?? 0;
              if (now - lastReject >= REJECT_COOLDOWN_MS) {
                rejectTimestamps.set(jid, now);
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
            if (tgSlashMatch && opts.onCommand) {
              const cmdBody = (
                tgSlashMatch[1] + (tgSlashMatch[2] ? ' ' + tgSlashMatch[2] : '')
              ).trim();
              logger.info(
                { jid, cmd: tgSlashMatch[1], cmdBody },
                'Telegram slash command detected',
              );
              try {
                const senderImId = ctx.from?.id
                  ? String(ctx.from.id)
                  : undefined;
                const reply = await opts.onCommand(jid, cmdBody, senderImId);
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

            const resolvedRoute = resolveAdmittedChannelRoute(
              routeJid,
              opts.resolveEffectiveChatJid
                ? () => opts.resolveEffectiveChatJid!(jid, messageMeta)
                : undefined,
            );
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
            const senderId = ctx.from?.id ? `tg:${ctx.from.id}` : 'tg:unknown';
            storeChatMetadata(targetJid, timestamp);
            storeMessageDirect(
              id,
              targetJid,
              senderId,
              senderName,
              text,
              timestamp,
              false,
              { sourceJid },
            );

            // 广播到 Web 客户端
            broadcastNewMessage(
              targetJid,
              {
                id,
                chat_jid: targetJid,
                source_jid: sourceJid,
                sender: senderId,
                sender_name: senderName,
                content: text,
                timestamp,
                is_from_me: false,
              },
              agentRouting?.agentId ?? undefined,
            );
            notifyNewImMessage();

            // 触发 agent 处理
            if (agentRouting?.agentId) {
              opts.onAgentMessage?.(jid, agentRouting.agentId);
              logger.info(
                {
                  jid,
                  effectiveJid: targetJid,
                  agentId: agentRouting.agentId,
                  sender: senderName,
                  msgId,
                },
                'Telegram message routed to conversation agent',
              );
            } else {
              logger.info(
                { jid, sender: senderName, msgId, routed: !!agentRouting },
                'Telegram message stored',
              );
            }
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

            if (!opts.isChatAuthorized(jid)) {
              logger.debug(
                { jid },
                'Unauthorized Telegram chat (photo), ignoring',
              );
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

            const caption = ctx.message.caption;
            const text = caption ? `${imgMarker}\n${caption}` : imgMarker;

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
            const senderId = ctx.from?.id ? `tg:${ctx.from.id}` : 'tg:unknown';
            storeChatMetadata(targetJid, timestamp);
            storeMessageDirect(
              id,
              targetJid,
              senderId,
              senderName,
              text,
              timestamp,
              false,
              { attachments: attachmentsJson, sourceJid },
            );

            broadcastNewMessage(
              targetJid,
              {
                id,
                chat_jid: targetJid,
                source_jid: sourceJid,
                sender: senderId,
                sender_name: senderName,
                content: text,
                timestamp,
                attachments: attachmentsJson,
                is_from_me: false,
              },
              agentRouting?.agentId ?? undefined,
            );
            notifyNewImMessage();

            if (agentRouting?.agentId) {
              opts.onAgentMessage?.(jid, agentRouting.agentId);
            }

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
      bot.on('message:document', async (ctx) => {
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

            if (!opts.isChatAuthorized(jid)) {
              logger.debug(
                { jid },
                'Unauthorized Telegram chat (document), ignoring',
              );
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
            if (doc.file_size !== undefined && doc.file_size > MAX_FILE_SIZE) {
              const text = `[文件过大，未下载: ${safeFilename}]`;
              const id = crypto.randomUUID();
              const timestamp = new Date(ctx.message.date * 1000).toISOString();
              const senderId = ctx.from?.id
                ? `tg:${ctx.from.id}`
                : 'tg:unknown';
              storeMessageDirect(
                id,
                targetJid,
                senderId,
                senderName,
                text,
                timestamp,
                false,
                { sourceJid },
              );
              broadcastNewMessage(
                targetJid,
                {
                  id,
                  chat_jid: targetJid,
                  source_jid: sourceJid,
                  sender: senderId,
                  sender_name: senderName,
                  content: text,
                  timestamp,
                  is_from_me: false,
                },
                agentRouting?.agentId ?? undefined,
              );
              notifyNewImMessage();
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
                doc.file_size,
              );
              fileText = relPath
                ? `[文件: ${relPath}]`
                : `[文件下载失败: ${safeFilename}]`;
            }

            const caption = ctx.message.caption;
            const text = caption ? `${fileText}\n${caption}` : fileText;

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
            const senderId = ctx.from?.id ? `tg:${ctx.from.id}` : 'tg:unknown';
            storeChatMetadata(targetJid, timestamp);
            storeMessageDirect(
              id,
              targetJid,
              senderId,
              senderName,
              text,
              timestamp,
              false,
              { sourceJid },
            );

            broadcastNewMessage(
              targetJid,
              {
                id,
                chat_jid: targetJid,
                source_jid: sourceJid,
                sender: senderId,
                sender_name: senderName,
                content: text,
                timestamp,
                is_from_me: false,
              },
              agentRouting?.agentId ?? undefined,
            );
            notifyNewImMessage();

            if (agentRouting?.agentId) {
              opts.onAgentMessage?.(jid, agentRouting.agentId);
            }

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
      await bot.api.getMe();

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
    },

    async sendMessage(
      chatId: string,
      text: string,
      localImagePaths?: string[],
    ): Promise<void> {
      if (!bot) {
        throw new Error('Telegram bot is not initialized');
      }

      const target = parseTelegramProviderTarget(chatId);
      if (!target) {
        throw new Error(`Invalid Telegram chat ID: ${chatId || '<empty>'}`);
      }
      const threadOptions = target.messageThreadId
        ? { message_thread_id: target.messageThreadId }
        : {};

      try {
        // Split original markdown into chunks (leave room for HTML tag overhead)
        const mdChunks = splitMarkdownChunks(text, 3800);

        for (const mdChunk of mdChunks) {
          const html = markdownToTelegramHtml(mdChunk);
          try {
            await bot.api.sendMessage(target.chatId, html, {
              parse_mode: 'HTML',
              ...threadOptions,
            });
          } catch (err) {
            // HTML parse failed (e.g. unclosed tags), fallback to plain text
            logger.debug(
              { err, chatId },
              'HTML parse failed, fallback to plain',
            );
            await bot.api.sendMessage(target.chatId, mdChunk, threadOptions);
          }
        }

        for (const localImagePath of localImagePaths || []) {
          try {
            await bot.api.sendPhoto(
              target.chatId,
              new InputFile(localImagePath),
              threadOptions,
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
        throw err;
      }
    },

    clearAckReaction(chatId: string, inputMessageId: string): Promise<void> {
      return ackReactions.clear(processingIndicatorKey(chatId, inputMessageId));
    },

    async sendImage(
      chatId: string,
      imageBuffer: Buffer,
      mimeType: string,
      caption?: string,
      fileName?: string,
    ): Promise<void> {
      if (!bot) {
        throw new Error('Telegram bot is not initialized');
      }

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
          await bot.api.sendAnimation(target.chatId, inputFile, {
            caption: safeCaption,
            ...threadOptions,
          });
        } else if (isPhoto) {
          await bot.api.sendPhoto(target.chatId, inputFile, {
            caption: safeCaption,
            ...threadOptions,
          });
        } else {
          await bot.api.sendDocument(target.chatId, inputFile, {
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
        throw err;
      }
    },

    async sendFile(
      chatId: string,
      filePath: string,
      fileName: string,
    ): Promise<void> {
      if (!bot) {
        throw new Error('Telegram bot is not initialized');
      }

      const target = parseTelegramProviderTarget(chatId);
      if (!target) {
        throw new Error(
          `Invalid Telegram chat ID for file: ${chatId || '<empty>'}`,
        );
      }

      try {
        // Check file size (30MB limit, same as MCP tool)
        const stat = await fsPromises.stat(filePath);
        const MAX_SEND_FILE_SIZE = 30 * 1024 * 1024;
        if (stat.size > MAX_SEND_FILE_SIZE) {
          throw new Error(
            `文件大小超过 30MB 限制 (${(stat.size / 1024 / 1024).toFixed(2)}MB)`,
          );
        }

        await bot.api.sendDocument(
          target.chatId,
          new InputFile(filePath, fileName),
          target.messageThreadId
            ? { message_thread_id: target.messageThreadId }
            : {},
        );

        logger.info(
          { chatId, filePath, fileName, size: stat.size },
          'Telegram file sent',
        );
      } catch (err) {
        logger.error(
          { err, chatId, filePath, fileName },
          'Failed to send Telegram file',
        );
        throw err;
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

// ─── Backward-compatible global singleton ──────────────────────
// @deprecated — 旧的顶层导出函数，内部使用一个默认全局实例。
// 后续由 imManager 替代。

let _defaultInstance: TelegramConnection | null = null;

/**
 * @deprecated Use createTelegramConnection() factory instead. Will be replaced by imManager.
 */
export async function connectTelegram(
  opts: TelegramConnectOpts,
): Promise<void> {
  const { getTelegramProviderConfig } = await import('./runtime-config.js');
  const config = getTelegramProviderConfig();
  if (!config.botToken) {
    logger.info('Telegram bot token not configured, skipping');
    return;
  }

  _defaultInstance = createTelegramConnection({
    botToken: config.botToken,
    proxyUrl: config.proxyUrl,
  });

  await _defaultInstance.connect(opts);
}

/**
 * @deprecated Use TelegramConnection.sendMessage() instead.
 */
export async function sendTelegramMessage(
  chatId: string,
  text: string,
  localImagePaths?: string[],
): Promise<void> {
  if (!_defaultInstance) {
    logger.warn(
      { chatId },
      'Telegram bot not initialized, skip sending message',
    );
    return;
  }
  return _defaultInstance.sendMessage(chatId, text, localImagePaths);
}

/**
 * @deprecated Use TelegramConnection.disconnect() instead.
 */
export async function disconnectTelegram(): Promise<void> {
  if (_defaultInstance) {
    await _defaultInstance.disconnect();
    _defaultInstance = null;
  }
}

/**
 * @deprecated Use TelegramConnection.isConnected() instead.
 */
export function isTelegramConnected(): boolean {
  return _defaultInstance?.isConnected() ?? false;
}
