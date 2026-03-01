import { Bot } from 'grammy';
import crypto from 'crypto';
import https from 'node:https';
import { Agent as HttpsAgent } from 'node:https';
import {
  storeChatMetadata,
  storeMessageDirect,
  updateChatName,
} from './db.js';
import { broadcastNewMessage } from './web.js';
import { logger } from './logger.js';
import {
  saveDownloadedFile,
  MAX_FILE_SIZE,
  FileTooLargeError,
} from './im-downloader.js';
import { detectImageMimeType } from './image-detector.js';

// ─── TelegramConnection Interface ──────────────────────────────

export interface TelegramConnectionConfig {
  botToken: string;
}

export interface TelegramConnectOpts {
  onReady?: () => void;
  /** 收到消息后调用，让调用方自动注册未知的 Telegram 聊天 */
  onNewChat: (jid: string, name: string) => void;
  /** 检查聊天是否已注册（已在 registered_groups 中） */
  isChatAuthorized: (jid: string) => boolean;
  /** 配对尝试回调：验证码并注册聊天，返回是否成功 */
  onPairAttempt?: (jid: string, chatName: string, code: string) => Promise<boolean>;
  /** 斜杠指令回调（如 /clear），返回回复文本或 null */
  onCommand?: (chatJid: string, command: string) => Promise<string | null>;
  /** 根据 jid 解析群组 folder，用于下载文件/图片到工作区 */
  resolveGroupFolder?: (jid: string) => string | undefined;
}

export interface TelegramConnection {
  connect(opts: TelegramConnectOpts): Promise<void>;
  disconnect(): Promise<void>;
  sendMessage(chatId: string, text: string): Promise<void>;
  sendChatAction(chatId: string, action: 'typing'): Promise<void>;
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
export function createTelegramConnection(config: TelegramConnectionConfig): TelegramConnection {
  // LRU deduplication cache
  const MSG_DEDUP_MAX = 1000;
  const MSG_DEDUP_TTL = 30 * 60 * 1000; // 30min
  const POLLING_RESTART_DELAY_MS = 5000;

  const msgCache = new Map<string, number>();
  let bot: Bot | null = null;
  let pollingPromise: Promise<void> | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let stopping = false;
  let readyFired = false;
  const telegramApiAgent = new HttpsAgent({ keepAlive: true, family: 4 });

  function isDuplicate(msgId: string): boolean {
    const now = Date.now();
    for (const [id, ts] of msgCache.entries()) {
      if (now - ts > MSG_DEDUP_TTL) {
        msgCache.delete(id);
      }
    }
    if (msgCache.size >= MSG_DEDUP_MAX) {
      const firstKey = msgCache.keys().next().value;
      if (firstKey) msgCache.delete(firstKey);
    }
    return msgCache.has(msgId);
  }

  function markSeen(msgId: string): void {
    msgCache.set(msgId, Date.now());
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
      logger.warn({ fileId, fileSizeHint }, 'Telegram file exceeds MAX_FILE_SIZE, skipping');
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
        https.get(url, { agent: telegramApiAgent }, (res) => {
          const chunks: Buffer[] = [];
          let total = 0;
          res.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > MAX_FILE_SIZE) {
              res.destroy(new Error('File exceeds MAX_FILE_SIZE during download'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        }).on('error', reject);
      });

      // 使用 file_path 中的最后一段作为文件名（若无则用 originalFilename）
      const pathBasename = filePath.split('/').pop() || '';
      const effectiveName = originalFilename || pathBasename || `file_${fileId}`;

      try {
        return await saveDownloadedFile(groupFolder, 'telegram', effectiveName, buffer);
      } catch (err) {
        if (err instanceof FileTooLargeError) {
          logger.warn({ fileId, effectiveName }, 'Telegram file too large after download');
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
      logger.warn({ fileId, fileSizeHint }, 'Telegram photo exceeds MAX_FILE_SIZE, skipping');
      return null;
    }
    try {
      if (!bot) return null;
      const file = await bot.api.getFile(fileId);
      const filePath = file.file_path;
      if (!filePath) {
        logger.warn({ fileId }, 'Telegram getFile returned no file_path (photo)');
        return null;
      }
      const url = `https://api.telegram.org/file/bot${config.botToken}/${filePath}`;
      const buffer = await new Promise<Buffer>((resolve, reject) => {
        https.get(url, { agent: telegramApiAgent }, (res) => {
          const chunks: Buffer[] = [];
          let total = 0;
          res.on('data', (chunk: Buffer) => {
            total += chunk.length;
            if (total > MAX_FILE_SIZE) {
              res.destroy(new Error('Photo exceeds MAX_FILE_SIZE during download'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        }).on('error', reject);
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
      logger.warn({ err, fileId }, 'Failed to download Telegram photo as base64');
      return null;
    }
  }

  // Rate-limit rejection messages: one per chat per 5 minutes
  const rejectTimestamps = new Map<string, number>();
  const REJECT_COOLDOWN_MS = 5 * 60 * 1000;

  function isExpectedStopError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err ?? '');
    return msg.includes('Aborted delay') || msg.includes('AbortError');
  }

  const connection: TelegramConnection = {
    async connect(opts: TelegramConnectOpts): Promise<void> {
      if (!config.botToken) {
        logger.info('Telegram bot token not configured, skipping');
        return;
      }

      bot = new Bot(config.botToken, {
        client: {
          timeoutSeconds: 30,
          baseFetchConfig: {
            agent: telegramApiAgent,
          },
        },
      });
      stopping = false;
      readyFired = false;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      bot.on('message:text', async (ctx) => {
        try {
          // Construct deduplication key
          const msgId = String(ctx.message.message_id) + ':' + String(ctx.chat.id);
          if (isDuplicate(msgId)) {
            logger.debug({ msgId }, 'Duplicate Telegram message, skipping');
            return;
          }
          markSeen(msgId);

          const chatId = String(ctx.chat.id);
          const jid = `telegram:${chatId}`;
          const chatName =
            ctx.chat.title ||
            [ctx.chat.first_name, ctx.chat.last_name].filter(Boolean).join(' ') ||
            `Telegram ${chatId}`;
          const senderName =
            [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') ||
            'Unknown';
          const text = ctx.message.text;

          // ── /pair <code> command ──
          const pairMatch = text.match(/^\/pair\s+(\S+)/i);
          if (pairMatch && opts.onPairAttempt) {
            const code = pairMatch[1];
            try {
              const success = await opts.onPairAttempt(jid, chatName, code);
              if (success) {
                await ctx.reply('Pairing successful! This chat is now connected.');
              } else {
                await ctx.reply('Invalid or expired pairing code. Please generate a new code from the web settings page.');
              }
            } catch (err) {
              logger.error({ err, jid }, 'Error during pair attempt');
              await ctx.reply('Pairing failed due to an internal error. Please try again.');
            }
            return;
          }

          // ── /start command ──
          if (text.trim() === '/start') {
            if (opts.isChatAuthorized(jid)) {
              await ctx.reply('This chat is already connected. You can send messages normally.');
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
            logger.debug({ jid, chatName }, 'Unauthorized Telegram chat, message ignored');
            return;
          }

          // ── Authorized chat: normal flow ──
          // 自动注册（确保 metadata 和名称同步）
          storeChatMetadata(jid, new Date().toISOString());
          updateChatName(jid, chatName);
          opts.onNewChat(jid, chatName);

          // ── /clear 指令：重置上下文，不进入消息流 ──
          // Match /clear and /clear@BotUsername (Telegram appends @bot in group chats)
          if (/^\/clear(?:@\S+)?$/i.test(text.trim()) && opts.onCommand) {
            try {
              const reply = await opts.onCommand(jid, 'clear');
              if (reply) await ctx.reply(reply);
            } catch (err) {
              logger.error({ jid, err }, 'Telegram /clear command failed');
            }
            return;
          }

          // Reaction 确认
          try {
            await ctx.react('👀');
          } catch (err) {
            logger.debug({ err, msgId }, 'Failed to add Telegram reaction');
          }

          // 存储消息
          const id = crypto.randomUUID();
          const timestamp = new Date(ctx.message.date * 1000).toISOString();
          const senderId = ctx.from?.id ? `tg:${ctx.from.id}` : 'tg:unknown';
          storeMessageDirect(id, jid, senderId, senderName, text, timestamp, false);

          // 广播到 Web 客户端
          broadcastNewMessage(jid, {
            id,
            chat_jid: jid,
            sender: senderId,
            sender_name: senderName,
            content: text,
            timestamp,
            is_from_me: false,
          });

          logger.info(
            { jid, sender: senderName, msgId },
            'Telegram message stored',
          );
        } catch (err) {
          logger.error({ err }, 'Error handling Telegram message');
        }
      });

      // ── message:photo 处理器（Vision 通道，与飞书独立图片逻辑一致）──
      bot.on('message:photo', async (ctx) => {
        try {
          const msgId = String(ctx.message.message_id) + ':' + String(ctx.chat.id);
          if (isDuplicate(msgId)) return;
          markSeen(msgId);

          const chatId = String(ctx.chat.id);
          const jid = `telegram:${chatId}`;
          const chatName =
            ctx.chat.title ||
            [ctx.chat.first_name, ctx.chat.last_name].filter(Boolean).join(' ') ||
            `Telegram ${chatId}`;
          const senderName =
            [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || 'Unknown';

          if (!opts.isChatAuthorized(jid)) {
            logger.debug({ jid }, 'Unauthorized Telegram chat (photo), ignoring');
            return;
          }

          storeChatMetadata(jid, new Date().toISOString());
          updateChatName(jid, chatName);
          opts.onNewChat(jid, chatName);

          // 取最高分辨率，下载为 base64 供 Vision
          const photo = ctx.message.photo.at(-1);
          if (!photo) return;

          const imageData = await downloadTelegramPhotoAsBase64(photo.file_id, photo.file_size);

          let attachmentsJson: string | undefined;
          if (imageData) {
            attachmentsJson = JSON.stringify([{ type: 'image', data: imageData.base64, mimeType: imageData.mimeType }]);
          }

          const caption = ctx.message.caption;
          const text = caption ? `[图片]\n${caption}` : '[图片]';

          try {
            await ctx.react('👀');
          } catch (err) {
            logger.debug({ err, msgId }, 'Failed to add Telegram reaction');
          }

          const id = crypto.randomUUID();
          const timestamp = new Date(ctx.message.date * 1000).toISOString();
          const senderId = ctx.from?.id ? `tg:${ctx.from.id}` : 'tg:unknown';
          storeMessageDirect(id, jid, senderId, senderName, text, timestamp, false, attachmentsJson);

          broadcastNewMessage(jid, {
            id,
            chat_jid: jid,
            sender: senderId,
            sender_name: senderName,
            content: text,
            timestamp,
            attachments: attachmentsJson,
            is_from_me: false,
          });

          logger.info({ jid, sender: senderName, msgId }, 'Telegram photo stored');
        } catch (err) {
          logger.error({ err }, 'Error handling Telegram photo');
        }
      });

      // ── message:document 处理器 ──
      bot.on('message:document', async (ctx) => {
        try {
          const msgId = String(ctx.message.message_id) + ':' + String(ctx.chat.id);
          if (isDuplicate(msgId)) return;
          markSeen(msgId);

          const chatId = String(ctx.chat.id);
          const jid = `telegram:${chatId}`;
          const chatName =
            ctx.chat.title ||
            [ctx.chat.first_name, ctx.chat.last_name].filter(Boolean).join(' ') ||
            `Telegram ${chatId}`;
          const senderName =
            [ctx.from?.first_name, ctx.from?.last_name].filter(Boolean).join(' ') || 'Unknown';

          if (!opts.isChatAuthorized(jid)) {
            logger.debug({ jid }, 'Unauthorized Telegram chat (document), ignoring');
            return;
          }

          storeChatMetadata(jid, new Date().toISOString());
          updateChatName(jid, chatName);
          opts.onNewChat(jid, chatName);

          const doc = ctx.message.document;
          const originalFilename = doc.file_name || 'file';

          // file_size 超过上限时跳过下载
          if (doc.file_size !== undefined && doc.file_size > MAX_FILE_SIZE) {
            const text = `[文件过大，未下载: ${originalFilename}]`;
            const id = crypto.randomUUID();
            const timestamp = new Date(ctx.message.date * 1000).toISOString();
            const senderId = ctx.from?.id ? `tg:${ctx.from.id}` : 'tg:unknown';
            storeMessageDirect(id, jid, senderId, senderName, text, timestamp, false);
            broadcastNewMessage(jid, {
              id, chat_jid: jid, sender: senderId, sender_name: senderName,
              content: text, timestamp, is_from_me: false,
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
              doc.file_size,
            );
            fileText = relPath ? `[文件: ${relPath}]` : `[文件下载失败: ${originalFilename}]`;
          }

          const caption = ctx.message.caption;
          const text = caption ? `${fileText}\n${caption}` : fileText;

          try {
            await ctx.react('👀');
          } catch (err) {
            logger.debug({ err, msgId }, 'Failed to add Telegram reaction');
          }

          const id = crypto.randomUUID();
          const timestamp = new Date(ctx.message.date * 1000).toISOString();
          const senderId = ctx.from?.id ? `tg:${ctx.from.id}` : 'tg:unknown';
          storeMessageDirect(id, jid, senderId, senderName, text, timestamp, false);

          broadcastNewMessage(jid, {
            id,
            chat_jid: jid,
            sender: senderId,
            sender_name: senderName,
            content: text,
            timestamp,
            is_from_me: false,
          });

          logger.info({ jid, sender: senderName, msgId }, 'Telegram document stored');
        } catch (err) {
          logger.error({ err }, 'Error handling Telegram document');
        }
      });

      const startPolling = (): void => {
        if (!bot || stopping) return;
        pollingPromise = bot
          .start({
            onStart: () => {
              logger.info('Telegram bot started');
              if (!readyFired) {
                readyFired = true;
                opts.onReady?.();
              }
            },
          })
          .catch((err) => {
            // bot.stop() during hot-reload will abort long polling; this is expected.
            if (stopping && isExpectedStopError(err)) return;

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
    },

    async disconnect(): Promise<void> {
      stopping = true;
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
              logger.debug({ err }, 'Telegram polling promise rejected on disconnect');
            }
          }
          pollingPromise = null;
          bot = null;
          telegramApiAgent.destroy();
        }
      }
    },

    async sendMessage(chatId: string, text: string): Promise<void> {
      if (!bot) {
        logger.warn(
          { chatId },
          'Telegram bot not initialized, skip sending message',
        );
        return;
      }

      const chatIdNum = Number(chatId);
      if (isNaN(chatIdNum)) {
        logger.error({ chatId }, 'Invalid Telegram chat ID');
        return;
      }

      try {
        // Split original markdown into chunks (leave room for HTML tag overhead)
        const mdChunks = splitMarkdownChunks(text, 3800);

        for (const mdChunk of mdChunks) {
          const html = markdownToTelegramHtml(mdChunk);
          try {
            await bot.api.sendMessage(chatIdNum, html, { parse_mode: 'HTML' });
          } catch (err) {
            // HTML parse failed (e.g. unclosed tags), fallback to plain text
            logger.debug({ err, chatId }, 'HTML parse failed, fallback to plain');
            await bot.api.sendMessage(chatIdNum, mdChunk);
          }
        }

        logger.info({ chatId }, 'Telegram message sent');
      } catch (err) {
        logger.error({ err, chatId }, 'Failed to send Telegram message');
        throw err;
      }
    },

    async sendChatAction(chatId: string, action: 'typing'): Promise<void> {
      if (!bot) return;
      const chatIdNum = Number(chatId);
      if (isNaN(chatIdNum)) return;
      try {
        await bot.api.sendChatAction(chatIdNum, action);
      } catch (err) {
        logger.debug({ err, chatId }, 'Failed to send Telegram chat action');
      }
    },

    isConnected(): boolean {
      return bot !== null;
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
  });

  return _defaultInstance.connect(opts);
}

/**
 * @deprecated Use TelegramConnection.sendMessage() instead.
 */
export async function sendTelegramMessage(
  chatId: string,
  text: string,
): Promise<void> {
  if (!_defaultInstance) {
    logger.warn(
      { chatId },
      'Telegram bot not initialized, skip sending message',
    );
    return;
  }
  return _defaultInstance.sendMessage(chatId, text);
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
