import { Bot, InputFile } from 'grammy';
import crypto from 'crypto';
import fsPromises from 'node:fs/promises';
import https from 'node:https';
import { Agent as HttpsAgent } from 'node:https';
import { ProxyAgent } from 'proxy-agent';
import { storeChatMetadata, storeMessageDirect, updateChatName } from './db.js';
import { broadcastNewMessage } from './web.js';
import { logger } from './logger.js';
import {
  saveDownloadedFile,
  MAX_FILE_SIZE,
  FileTooLargeError,
} from './im-downloader.js';
import { detectImageMimeType } from './image-detector.js';
import { analyzeIntent } from './intent-analyzer.js';

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
  /** 斜杠指令回调（如 /clear），返回回复文本或 null */
  onCommand?: (chatJid: string, command: string) => Promise<string | null>;
  /** 根据 jid 解析群组 folder，用于下载文件/图片到工作区 */
  resolveGroupFolder?: (jid: string) => string | undefined;
  /** 将 IM chatJid 解析为绑定目标 JID（conversation agent 或工作区主对话） */
  resolveEffectiveChatJid?: (
    chatJid: string,
  ) => { effectiveJid: string; agentId: string | null } | null;
  /** 当 IM 消息被路由到 conversation agent 后调用，触发 agent 处理 */
  onAgentMessage?: (baseChatJid: string, agentId: string) => void;
  /** Bot 被添加到群聊时调用（仅 group/supergroup） */
  onBotAddedToGroup?: (chatJid: string, chatName: string) => void;
  /** Bot 被移出群聊或群被解散时调用 */
  onBotRemovedFromGroup?: (chatJid: string) => void;
  /** 中断 fast-path：消息到达时立即检测中断意图，绕过轮询延迟直接触发中断 */
  onInterruptRequest?: (
    chatJid: string,
    intent: 'stop' | 'correction',
  ) => void;
}

export interface TelegramConnection {
  connect(opts: TelegramConnectOpts): Promise<void>;
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
  ): Promise<void>;
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
export function createTelegramConnection(
  config: TelegramConnectionConfig,
): TelegramConnection {
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
  const telegramApiAgent =
    config.proxyUrl && config.proxyUrl.trim()
      ? new ProxyAgent({
          getProxyForUrl: () => config.proxyUrl!.trim(),
        })
      : new HttpsAgent({ keepAlive: true, family: 4 });

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
          const msgId =
            String(ctx.message.message_id) + ':' + String(ctx.chat.id);
          if (isDuplicate(msgId)) {
            logger.debug({ msgId }, 'Duplicate Telegram message, skipping');
            return;
          }
          markSeen(msgId);

          const chatId = String(ctx.chat.id);
          const jid = `telegram:${chatId}`;
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
                await ctx.reply(
                  'Pairing successful! This chat is now connected.',
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

          // ── Authorized chat: normal flow ──
          // 自动注册（确保 metadata 和名称同步）
          storeChatMetadata(jid, new Date().toISOString());
          updateChatName(jid, chatName);
          opts.onNewChat(jid, chatName);

          // ── 斜杠指令：拦截已知 /xxx 命令，不进入消息流 ──
          // Telegram 群聊中会追加 @BotUsername，需要去掉
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
              const reply = await opts.onCommand(jid, cmdBody);
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

          // Reaction 确认
          try {
            await ctx.react('👀');
          } catch (err) {
            logger.debug({ err, msgId }, 'Failed to add Telegram reaction');
          }

          // 解析绑定路由
          const agentRouting = opts.resolveEffectiveChatJid?.(jid);
          const targetJid = agentRouting?.effectiveJid ?? jid;

          // ── 中断 fast-path（使用路由后的 targetJid） ──
          if (opts.onInterruptRequest && text.length <= 50) {
            const intent = analyzeIntent(text);
            if (intent !== 'continue') {
              opts.onInterruptRequest(targetJid, intent);
              logger.info(
                { jid, targetJid, intent },
                'Interrupt fast-path triggered from Telegram',
              );
            }
          }

          // 存储消息
          const id = crypto.randomUUID();
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
            { sourceJid: jid },
          );

          // 广播到 Web 客户端
          broadcastNewMessage(
            targetJid,
            {
              id,
              chat_jid: targetJid,
              source_jid: jid,
              sender: senderId,
              sender_name: senderName,
              content: text,
              timestamp,
              is_from_me: false,
            },
            agentRouting?.agentId ?? undefined,
          );

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
        } catch (err) {
          logger.error({ err }, 'Error handling Telegram message');
        }
      });

      // ── message:photo 处理器（Vision 通道，与飞书独立图片逻辑一致）──
      bot.on('message:photo', async (ctx) => {
        try {
          const msgId =
            String(ctx.message.message_id) + ':' + String(ctx.chat.id);
          if (isDuplicate(msgId)) return;
          markSeen(msgId);

          const chatId = String(ctx.chat.id);
          const jid = `telegram:${chatId}`;
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

          try {
            await ctx.react('👀');
          } catch (err) {
            logger.debug({ err, msgId }, 'Failed to add Telegram reaction');
          }

          // 解析绑定路由
          const agentRouting = opts.resolveEffectiveChatJid?.(jid);
          const targetJid = agentRouting?.effectiveJid ?? jid;

          const id = crypto.randomUUID();
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
            { attachments: attachmentsJson, sourceJid: jid },
          );

          broadcastNewMessage(
            targetJid,
            {
              id,
              chat_jid: targetJid,
              source_jid: jid,
              sender: senderId,
              sender_name: senderName,
              content: text,
              timestamp,
              attachments: attachmentsJson,
              is_from_me: false,
            },
            agentRouting?.agentId ?? undefined,
          );

          if (agentRouting?.agentId) {
            opts.onAgentMessage?.(jid, agentRouting.agentId);
          }

          logger.info(
            { jid, sender: senderName, msgId, routed: !!agentRouting },
            'Telegram photo stored',
          );
        } catch (err) {
          logger.error({ err }, 'Error handling Telegram photo');
        }
      });

      // ── message:document 处理器 ──
      bot.on('message:document', async (ctx) => {
        try {
          const msgId =
            String(ctx.message.message_id) + ':' + String(ctx.chat.id);
          if (isDuplicate(msgId)) return;
          markSeen(msgId);

          const chatId = String(ctx.chat.id);
          const jid = `telegram:${chatId}`;
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

          storeChatMetadata(jid, new Date().toISOString());
          updateChatName(jid, chatName);
          opts.onNewChat(jid, chatName);

          const doc = ctx.message.document;
          const originalFilename = doc.file_name || 'file';

          // file_size 超过上限时跳过下载
          if (doc.file_size !== undefined && doc.file_size > MAX_FILE_SIZE) {
            const earlyRouting = opts.resolveEffectiveChatJid?.(jid);
            const earlyTargetJid = earlyRouting?.effectiveJid ?? jid;
            const text = `[文件过大，未下载: ${originalFilename}]`;
            const id = crypto.randomUUID();
            const timestamp = new Date(ctx.message.date * 1000).toISOString();
            const senderId = ctx.from?.id ? `tg:${ctx.from.id}` : 'tg:unknown';
            storeMessageDirect(
              id,
              earlyTargetJid,
              senderId,
              senderName,
              text,
              timestamp,
              false,
              { sourceJid: jid },
            );
            broadcastNewMessage(
              earlyTargetJid,
              {
                id,
                chat_jid: earlyTargetJid,
                source_jid: jid,
                sender: senderId,
                sender_name: senderName,
                content: text,
                timestamp,
                is_from_me: false,
              },
              earlyRouting?.agentId ?? undefined,
            );
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
              : `[文件下载失败: ${originalFilename}]`;
          }

          const caption = ctx.message.caption;
          const text = caption ? `${fileText}\n${caption}` : fileText;

          try {
            await ctx.react('👀');
          } catch (err) {
            logger.debug({ err, msgId }, 'Failed to add Telegram reaction');
          }

          // 解析绑定路由
          const agentRouting = opts.resolveEffectiveChatJid?.(jid);
          const targetJid = agentRouting?.effectiveJid ?? jid;

          const id = crypto.randomUUID();
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
            { sourceJid: jid },
          );

          broadcastNewMessage(
            targetJid,
            {
              id,
              chat_jid: targetJid,
              source_jid: jid,
              sender: senderId,
              sender_name: senderName,
              content: text,
              timestamp,
              is_from_me: false,
            },
            agentRouting?.agentId ?? undefined,
          );

          if (agentRouting?.agentId) {
            opts.onAgentMessage?.(jid, agentRouting.agentId);
          }

          logger.info(
            { jid, sender: senderName, msgId, routed: !!agentRouting },
            'Telegram document stored',
          );
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
          const jid = `telegram:${chatId}`;
          const chatName = update.chat.title || `Telegram ${chatId}`;
          const newStatus = update.new_chat_member.status;
          const oldStatus = update.old_chat_member.status;

          if (
            (oldStatus === 'left' || oldStatus === 'kicked') &&
            (newStatus === 'member' || newStatus === 'administrator')
          ) {
            logger.info(
              { jid, chatName, newStatus },
              'Telegram bot added to group',
            );
            opts.onBotAddedToGroup?.(jid, chatName);
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

      const startPolling = (): void => {
        if (!bot || stopping) return;
        pollingPromise = bot
          .start({
            allowed_updates: ['message', 'edited_message', 'my_chat_member'],
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
    },

    async sendMessage(
      chatId: string,
      text: string,
      localImagePaths?: string[],
    ): Promise<void> {
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
            logger.debug(
              { err, chatId },
              'HTML parse failed, fallback to plain',
            );
            await bot.api.sendMessage(chatIdNum, mdChunk);
          }
        }

        for (const localImagePath of localImagePaths || []) {
          try {
            await bot.api.sendPhoto(chatIdNum, new InputFile(localImagePath));
          } catch (imageErr) {
            logger.warn(
              { chatId, localImagePath, err: imageErr },
              'Failed to send Telegram image attachment',
            );
          }
        }

        logger.info({ chatId }, 'Telegram message sent');
      } catch (err) {
        logger.error({ err, chatId }, 'Failed to send Telegram message');
        throw err;
      }
    },

    async sendImage(
      chatId: string,
      imageBuffer: Buffer,
      mimeType: string,
      caption?: string,
      fileName?: string,
    ): Promise<void> {
      if (!bot) {
        logger.warn(
          { chatId },
          'Telegram bot not initialized, skip sending image',
        );
        return;
      }

      const chatIdNum = Number(chatId);
      if (isNaN(chatIdNum)) {
        logger.error({ chatId }, 'Invalid Telegram chat ID for image');
        return;
      }

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
          await bot.api.sendAnimation(chatIdNum, inputFile, {
            caption: safeCaption,
          });
        } else if (isPhoto) {
          await bot.api.sendPhoto(chatIdNum, inputFile, {
            caption: safeCaption,
          });
        } else {
          await bot.api.sendDocument(chatIdNum, inputFile, {
            caption: safeCaption,
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
        logger.warn(
          { chatId },
          'Telegram bot not initialized, skip sending file',
        );
        return;
      }

      const chatIdNum = Number(chatId);
      if (isNaN(chatIdNum)) {
        logger.error({ chatId }, 'Invalid Telegram chat ID for file');
        return;
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
          chatIdNum,
          new InputFile(filePath, fileName),
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
    proxyUrl: config.proxyUrl,
  });

  return _defaultInstance.connect(opts);
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
