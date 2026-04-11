/**
 * Discord Bot Connection Factory
 *
 * Implements Discord bot connection using discord.js:
 * - Gateway WebSocket for receiving events
 * - Message deduplication (LRU 1000 / 30min TTL)
 * - Guild channel and DM support
 * - Attachment handling (images as base64, files saved to disk)
 * - Long message splitting (2000 char limit, code fence preservation)
 * - Ack reaction (eyes emoji on user messages)
 *
 * Reference: https://discord.js.org/
 */
import crypto from 'crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  Client,
  GatewayIntentBits,
  Events,
  Partials,
  AttachmentBuilder,
  ChannelType,
} from 'discord.js';
import type {
  Message,
  TextChannel,
  DMChannel,
  NewsChannel,
  TextBasedChannel,
} from 'discord.js';
import {
  storeChatMetadata,
  storeMessageDirect,
  updateChatName,
} from './db.js';
import { notifyNewImMessage } from './message-notifier.js';
import { broadcastNewMessage } from './web.js';
import { logger } from './logger.js';
import { saveDownloadedFile, MAX_FILE_SIZE } from './im-downloader.js';
import { detectImageMimeType } from './image-detector.js';
import { splitTextChunks } from './im-utils.js';

// ─── Constants ──────────────────────────────────────────────────

const MSG_DEDUP_MAX = 1000;
const MSG_DEDUP_TTL = 30 * 60 * 1000; // 30min
const DISCORD_MSG_LIMIT = 2000; // Discord message character limit
// Same 5MB threshold as other channels — only inline base64 for small images
const IMAGE_MAX_BASE64_SIZE = 5 * 1024 * 1024;

// ─── Types ──────────────────────────────────────────────────────

export interface DiscordConnectionConfig {
  botToken: string;
}

export interface DiscordConnectOpts {
  onReady?: () => void;
  onNewChat: (jid: string, name: string) => void;
  isChatAuthorized?: (jid: string) => boolean;
  ignoreMessagesBefore?: number;
  onCommand?: (
    chatJid: string,
    command: string,
    senderImId?: string,
  ) => Promise<string | null>;
  resolveGroupFolder?: (jid: string) => string | undefined;
  resolveEffectiveChatJid?: (
    chatJid: string,
  ) => { effectiveJid: string; agentId: string | null } | null;
  onAgentMessage?: (baseChatJid: string, agentId: string) => void;
  onBotAddedToGroup?: (chatJid: string, chatName: string) => void;
  onBotRemovedFromGroup?: (chatJid: string) => void;
  shouldProcessGroupMessage?: (
    chatJid: string,
    senderImId?: string,
  ) => boolean;
  isGroupOwnerMessage?: (chatJid: string, senderImId?: string) => boolean;
}

export interface DiscordConnection {
  connect(opts: DiscordConnectOpts): Promise<boolean>;
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
  setTyping(chatId: string, isTyping: boolean): Promise<void>;
  clearAckReaction(chatId: string): void;
  isConnected(): boolean;
  getLastMessageId?(chatId: string): string | undefined;
  createStreamingSession?(
    chatId: string,
    onCardCreated?: (messageId: string) => void,
  ): Promise<
    | import('./discord-streaming-edit.js').DiscordStreamingEditController
    | undefined
  >;
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Parse a Discord chat ID (JID) to determine the type and extract the snowflake ID.
 * discord:{channelId} → guild channel
 * discord:dm:{userId} → DM channel
 */
function parseChatId(
  chatId: string,
): { type: 'guild' | 'dm'; id: string } | null {
  // Full JID form: discord:dm:{userId} or discord:{channelId}
  if (chatId.startsWith('discord:dm:'))
    return { type: 'dm', id: chatId.slice(11) };
  if (chatId.startsWith('discord:'))
    return { type: 'guild', id: chatId.slice(8) };
  // Bare ID form (after extractChatId strips prefix): dm:{userId} or raw snowflake
  if (chatId.startsWith('dm:'))
    return { type: 'dm', id: chatId.slice(3) };
  // Bare snowflake — assume guild channel
  if (/^\d+$/.test(chatId))
    return { type: 'guild', id: chatId };
  return null;
}

/**
 * Split text into chunks respecting Discord's 2000-character limit.
 * Preserves code fence integrity: if a split happens inside a fenced code block,
 * close it before the split and reopen after.
 */
function splitDiscordChunks(text: string): string[] {
  // Reserve space for fence open/close markers that may be added:
  // opening: ```lang\n (up to ~15 chars), closing: \n``` (4 chars)
  const FENCE_OVERHEAD = 20;
  const raw = splitTextChunks(text, DISCORD_MSG_LIMIT - FENCE_OVERHEAD);
  if (raw.length <= 1) return raw;

  const result: string[] = [];
  let insideCodeBlock = false;
  let currentLang = '';

  for (let i = 0; i < raw.length; i++) {
    let chunk = raw[i];

    // If previous chunk ended inside a code block, reopen at the start
    if (insideCodeBlock) {
      chunk = '```' + currentLang + '\n' + chunk;
    }

    // Count code fences in this chunk to track open/close state
    const fenceMatches = chunk.match(/^```(\w*)/gm) || [];
    let localFenceCount = 0;
    let lastLang = currentLang;
    for (const fence of fenceMatches) {
      localFenceCount++;
      // Extract language from opening fences
      const langMatch = fence.match(/^```(\w+)/);
      if (langMatch && localFenceCount % 2 === 1) {
        lastLang = langMatch[1];
      }
    }

    // An odd total fence count means the chunk ends with an unclosed block
    const totalFences = (insideCodeBlock ? 1 : 0) + localFenceCount;
    const endsOpen = totalFences % 2 === 1;

    if (endsOpen && i < raw.length - 1) {
      // Close the code block at the end of this chunk
      chunk = chunk + '\n```';
      insideCodeBlock = true;
      currentLang = lastLang;
    } else {
      insideCodeBlock = false;
      currentLang = '';
    }

    result.push(chunk);
  }

  return result;
}

/**
 * Download an attachment from a URL and return a Buffer.
 * Returns null on failure or if the file exceeds MAX_FILE_SIZE.
 */
async function downloadAttachment(url: string): Promise<Buffer | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length > MAX_FILE_SIZE) return null;
    return buffer;
  } catch {
    return null;
  }
}

// ─── Factory Function ───────────────────────────────────────────

export function createDiscordConnection(
  config: DiscordConnectionConfig,
): DiscordConnection {
  let discordClient: Client | null = null;
  let stopping = false;
  let readyFired = false;

  // Message deduplication — LRU Map, 1000 entries, 30min TTL
  const msgCache = new Map<string, number>();

  // Last message ID per chat (for reply context)
  const lastMessageIds = new Map<string, string>();

  // Ack reaction per chat: { messageId, channelId }
  const ackReactionByChat = new Map<
    string,
    { messageId: string; channelId: string }
  >();

  function isDuplicate(msgId: string): boolean {
    const now = Date.now();
    // Map preserves insertion order; stop at first non-expired entry
    for (const [id, ts] of msgCache.entries()) {
      if (now - ts > MSG_DEDUP_TTL) {
        msgCache.delete(id);
      } else {
        break;
      }
    }
    if (msgCache.size >= MSG_DEDUP_MAX) {
      const firstKey = msgCache.keys().next().value;
      if (firstKey) msgCache.delete(firstKey);
    }
    return msgCache.has(msgId);
  }

  function markSeen(msgId: string): void {
    // delete + set to refresh insertion order (move to end)
    msgCache.delete(msgId);
    msgCache.set(msgId, Date.now());
  }

  // ─── Channel Resolution ──────────────────────────────────

  /**
   * Resolve a Discord TextBasedChannel from a chatId string.
   * Handles both guild channels and DMs.
   */
  async function resolveChannel(
    chatId: string,
  ): Promise<TextChannel | DMChannel | NewsChannel | null> {
    const parsed = parseChatId(chatId);
    if (!parsed || !discordClient) return null;
    try {
      if (parsed.type === 'dm') {
        const user = await discordClient.users.fetch(parsed.id);
        return await user.createDM();
      }
      const channel = await discordClient.channels.fetch(parsed.id);
      if (channel?.isTextBased()) {
        return channel as TextChannel | NewsChannel;
      }
      return null;
    } catch (err) {
      logger.warn({ err, chatId }, 'Discord: failed to resolve channel');
      return null;
    }
  }

  // ─── Ack Reaction ─────────────────────────────────────────

  /**
   * Add an eyes emoji reaction to a user's message as ack confirmation.
   */
  async function attachAckReaction(
    msg: Message,
    jid: string,
  ): Promise<void> {
    try {
      await msg.react('\u{1F440}'); // eyes emoji
      ackReactionByChat.set(jid, {
        messageId: msg.id,
        channelId: msg.channelId,
      });
      logger.debug({ msgId: msg.id, jid }, 'Discord ack reaction attached');
    } catch (err) {
      logger.debug(
        { err, msgId: msg.id, jid },
        'Discord ack reaction attach failed',
      );
    }
  }

  /**
   * Remove the eyes emoji reaction from the stored message for a chat.
   * Silent on failure — the emoji is non-critical.
   */
  async function recallAckReaction(chatId: string): Promise<void> {
    const stored = ackReactionByChat.get(chatId);
    if (!stored) return;
    ackReactionByChat.delete(chatId);
    try {
      if (!discordClient?.user) return;
      const channel = await discordClient.channels.fetch(stored.channelId);
      if (channel?.isTextBased()) {
        const textChannel = channel as TextBasedChannel;
        const msg = await textChannel.messages.fetch(stored.messageId);
        const reaction = msg.reactions.cache.find(
          (r) => r.emoji.name === '\u{1F440}',
        );
        if (reaction) {
          await reaction.users.remove(discordClient.user.id);
        }
      }
    } catch {
      // Non-critical: emoji will remain but won't break anything
    }
  }

  // ─── Message Handling ─────────────────────────────────────

  async function handleMessage(
    msg: Message,
    opts: DiscordConnectOpts,
  ): Promise<void> {
    try {
      // Skip bot messages
      if (msg.author.bot) return;

      const msgId = msg.id;

      // Dedup check
      if (isDuplicate(msgId)) {
        logger.debug({ msgId }, 'Discord dropped: duplicate');
        return;
      }
      markSeen(msgId);

      // Skip stale messages from before connection (hot-reload scenario)
      if (opts.ignoreMessagesBefore && msg.createdTimestamp) {
        if (msg.createdTimestamp < opts.ignoreMessagesBefore) {
          logger.debug(
            {
              msgId,
              msgTime: msg.createdTimestamp,
              ignoreBefore: opts.ignoreMessagesBefore,
            },
            'Discord dropped: stale message',
          );
          return;
        }
      }

      // Determine channel type and construct JID
      const isDM =
        msg.channel.type === ChannelType.DM ||
        msg.channel.type === ChannelType.GroupDM;
      const jid = isDM
        ? `discord:dm:${msg.author.id}`
        : `discord:${msg.channelId}`;

      const senderName = msg.member?.displayName || msg.author.displayName || msg.author.username;
      const chatName = isDM
        ? senderName
        : (msg.channel as TextChannel).name || `Discord #${msg.channelId}`;
      const senderImId = msg.author.id;

      // Store last message ID for reply context
      lastMessageIds.set(jid, msgId);

      // Register chat early (before mention gate) so that
      // shouldProcessGroupMessage can find the group in registeredGroups.
      // Without this, first-time guild channel messages are always dropped
      // because shouldProcessGroupMessage returns false for unknown groups.
      storeChatMetadata(jid, new Date().toISOString());
      updateChatName(jid, chatName);
      opts.onNewChat(jid, chatName);

      // Guild channel: check group filtering (must check actual @mention first)
      if (!isDM) {
        const isBotMentioned = discordClient?.user
          ? msg.mentions.has(discordClient.user)
          : false;

        // Gate 1: require_mention mode — only process if bot was @mentioned
        if (opts.shouldProcessGroupMessage) {
          const shouldProcess = opts.shouldProcessGroupMessage(jid, senderImId);
          if (!shouldProcess && !isBotMentioned) {
            logger.debug(
              { jid },
              'Discord group message dropped (mention required but bot not @mentioned)',
            );
            return;
          }
        }
        // Gate 2: owner_mentioned mode — only process if sender is owner or bot was @mentioned
        if (opts.isGroupOwnerMessage) {
          const isOwner = opts.isGroupOwnerMessage(jid, senderImId);
          if (!isOwner && !isBotMentioned) {
            logger.debug(
              { jid, senderImId },
              'Discord group message dropped (owner_mentioned mode)',
            );
            return;
          }
        }
      }

      // Authorization check — before downloading any attachments to avoid
      // resource consumption from unauthorized channels
      if (opts.isChatAuthorized && !opts.isChatAuthorized(jid)) {
        logger.debug({ jid }, 'Discord chat not authorized');
        return;
      }

      // Extract content, stripping bot mentions
      let content = msg.content;
      if (!isDM && discordClient?.user) {
        // Remove bot mention patterns: <@123456> or <@!123456>
        content = content.replace(/<@!?\d+>/g, '').trim();
      }

      // Process attachments
      let attachmentsJson: string | undefined;
      const imageAttachments: { type: 'image'; data: string; mimeType: string }[] = [];

      for (const attachment of msg.attachments.values()) {
        const contentType = attachment.contentType || '';
        const isImage = contentType.startsWith('image/');
        const attachUrl = attachment.url;
        const attachName = attachment.name || `file_${Date.now()}`;

        if (isImage) {
          // Download image for base64 and disk save
          const buffer = await downloadAttachment(attachUrl);
          if (buffer) {
            const mimeType = detectImageMimeType(buffer) || contentType;

            // Inline as base64 if under threshold
            if (buffer.length <= IMAGE_MAX_BASE64_SIZE) {
              imageAttachments.push({
                type: 'image',
                data: buffer.toString('base64'),
                mimeType,
              });
            }

            // Save to disk
            const groupFolder = opts.resolveGroupFolder?.(jid);
            if (groupFolder) {
              try {
                const ext = mimeType.split('/')[1] || 'jpg';
                const filename = `img_${Date.now()}.${ext}`;
                const savedPath = await saveDownloadedFile(
                  groupFolder,
                  'discord',
                  filename,
                  buffer,
                );
                if (!content) {
                  content = `[图片: ${savedPath}]`;
                } else {
                  content += `\n[图片: ${savedPath}]`;
                }
              } catch (err) {
                logger.warn({ err }, 'Failed to save Discord image to disk');
                if (!content) content = '[图片]';
              }
            } else {
              if (!content) content = '[图片]';
            }
          }
        } else {
          // Non-image file: download and save to workspace
          const buffer = await downloadAttachment(attachUrl);
          if (buffer) {
            const groupFolder = opts.resolveGroupFolder?.(jid);
            if (groupFolder) {
              try {
                const savedPath = await saveDownloadedFile(
                  groupFolder,
                  'discord',
                  attachName,
                  buffer,
                );
                if (!content) {
                  content = `[文件: ${savedPath}]`;
                } else {
                  content += `\n[文件: ${savedPath}]`;
                }
              } catch (err) {
                logger.warn({ err }, 'Failed to save Discord file to disk');
                if (!content) content = `[文件: ${attachName}]`;
              }
            } else {
              if (!content) content = `[文件: ${attachName}]`;
            }
          }
        }
      }

      if (imageAttachments.length > 0) {
        attachmentsJson = JSON.stringify(imageAttachments);
      }

      // Skip empty messages
      if (!content && !attachmentsJson) {
        return;
      }

      // Handle slash commands
      const slashMatch = content.match(/^\/(\S+)(?:\s+(.*))?$/i);
      if (slashMatch && opts.onCommand) {
        const cmdBody = (
          slashMatch[1] + (slashMatch[2] ? ' ' + slashMatch[2] : '')
        ).trim();
        try {
          const reply = await opts.onCommand(jid, cmdBody, senderImId);
          if (reply) {
            const channel = await resolveChannel(jid);
            if (channel) {
              const chunks = splitDiscordChunks(reply);
              for (const chunk of chunks) {
                await channel.send(chunk);
              }
            }
            return;
          }
        } catch (err) {
          logger.error({ jid, err }, 'Discord slash command failed');
          return;
        }
      }

      // Route and store message
      const agentRouting = opts.resolveEffectiveChatJid?.(jid);
      const targetJid = agentRouting?.effectiveJid ?? jid;

      const id = crypto.randomUUID();
      const timestamp = new Date(msg.createdTimestamp).toISOString();
      const senderId = `discord:${msg.author.id}`;
      storeChatMetadata(targetJid, timestamp);
      storeMessageDirect(id, targetJid, senderId, senderName, content, timestamp, false, {
        attachments: attachmentsJson,
        sourceJid: jid,
      });

      broadcastNewMessage(
        targetJid,
        {
          id,
          chat_jid: targetJid,
          source_jid: jid,
          sender: senderId,
          sender_name: senderName,
          content,
          timestamp,
          attachments: attachmentsJson,
          is_from_me: false,
        },
        agentRouting?.agentId ?? undefined,
      );

      // Ack reaction: confirm receipt with eyes emoji
      attachAckReaction(msg, jid).catch(() => {});

      notifyNewImMessage();

      if (agentRouting?.agentId) {
        opts.onAgentMessage?.(jid, agentRouting.agentId);
        logger.info(
          { jid, effectiveJid: targetJid, agentId: agentRouting.agentId },
          'Discord message routed to agent',
        );
      } else {
        logger.info(
          { jid, sender: senderName, msgId },
          'Discord message stored',
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error handling Discord message');
    }
  }

  // ─── Connection Interface ─────────────────────────────────

  async function sendMessage(
    chatId: string,
    text: string,
    localImagePaths?: string[],
  ): Promise<void> {
    const channel = await resolveChannel(chatId);
    if (!channel) {
      logger.error({ chatId }, 'Discord sendMessage: failed to resolve channel');
      return;
    }

    const chunks = splitDiscordChunks(text);

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      // Attach images to the first chunk only
      if (i === 0 && localImagePaths && localImagePaths.length > 0) {
        const files: AttachmentBuilder[] = [];
        for (const imgPath of localImagePaths) {
          try {
            const buffer = await fs.readFile(imgPath);
            const name = path.basename(imgPath);
            files.push(new AttachmentBuilder(buffer, { name }));
          } catch (err) {
            logger.warn(
              { err, imgPath },
              'Discord sendMessage: failed to read local image',
            );
          }
        }
        if (files.length > 0) {
          await channel.send({ content: chunk, files });
        } else {
          await channel.send(chunk);
        }
      } else {
        await channel.send(chunk);
      }
    }
  }

  const connection: DiscordConnection = {
    async connect(opts: DiscordConnectOpts): Promise<boolean> {
      if (!config.botToken) {
        logger.info('Discord botToken not configured, skipping');
        return false;
      }

      stopping = false;
      readyFired = false;

      try {
        discordClient = new Client({
          intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.DirectMessages,
            GatewayIntentBits.MessageContent,
            GatewayIntentBits.GuildMessageReactions,
          ],
          partials: [Partials.Channel, Partials.Message],
        });

        // Ready event
        discordClient.once(Events.ClientReady, async (readyClient) => {
          logger.info(
            { botTag: readyClient.user.tag },
            'Discord bot connected',
          );
          readyFired = true;
          opts.onReady?.();

          // Register HappyClaw slash commands as Discord Application Commands
          try {
            await readyClient.application.commands.set([
              { name: 'clear', description: '清除当前对话的会话上下文' },
              { name: 'list', description: '查看所有工作区和对话列表' },
              { name: 'status', description: '查看当前工作区/对话状态' },
              { name: 'recall', description: '总结最近的对话内容' },
              {
                name: 'require_mention',
                description: '切换群聊响应模式（需要 @Bot 才响应）',
                options: [{
                  name: 'enabled',
                  description: 'true 或 false',
                  type: 3, // STRING
                  required: true,
                  choices: [
                    { name: 'true - 需要 @Bot', value: 'true' },
                    { name: 'false - 全量响应', value: 'false' },
                  ],
                }],
              },
            ]);
            // Clear guild-level commands (remove any stale ones from other apps)
            for (const guild of readyClient.guilds.cache.values()) {
              try { await guild.commands.set([]); } catch {}
            }
            logger.info('Discord application commands registered');
          } catch (err: any) {
            logger.warn({ err: err.message }, 'Failed to register application commands');
          }
        });

        // Slash command interactions (Discord Application Commands)
        discordClient.on(Events.InteractionCreate, async (interaction) => {
          if (!interaction.isChatInputCommand()) return;
          if (stopping) return;

          const isDM = !interaction.guildId;
          const jid = isDM
            ? `discord:dm:${interaction.user.id}`
            : `discord:${interaction.channelId}`;

          // Build command string matching HappyClaw's text command format
          let cmdBody = interaction.commandName;
          const enabledOpt = interaction.options.getString('enabled');
          if (enabledOpt) cmdBody += ' ' + enabledOpt;

          try {
            await interaction.deferReply();
            const reply = await opts.onCommand?.(jid, cmdBody, interaction.user.id);
            if (reply) {
              // Discord interaction replies have 2000 char limit
              const truncated = reply.length > 2000 ? reply.slice(0, 1997) + '...' : reply;
              await interaction.editReply(truncated);
            } else {
              await interaction.editReply('命令已执行');
            }
          } catch (err: any) {
            logger.error({ jid, cmd: cmdBody, err: err.message }, 'Discord slash command failed');
            try {
              await interaction.editReply('命令执行失败');
            } catch {}
          }
        });

        // Message create event — use Events.MessageCreate which delivers a fully
        // resolved Message object directly. With Partials.Channel + Partials.Message
        // configured (line 658), DMs are also delivered without needing raw fallback.
        // This avoids the 2x REST fetch (channels.fetch + messages.fetch) per message
        // that the previous raw-event handler incurred.
        discordClient.on(Events.MessageCreate, async (msg) => {
          if (stopping) return;
          if (msg.author?.bot) return;
          try {
            await handleMessage(msg, opts);
          } catch (err) {
            logger.error({ err }, 'Error in Discord message handler');
          }
        });

        // Guild create (bot added to a new server) — log only, don't register
        // phantom JID since our JIDs are channel-level (discord:{channelId}),
        // not guild-level. Channels will auto-register on first message.
        discordClient.on(Events.GuildCreate, (guild) => {
          logger.info(
            { guildId: guild.id, guildName: guild.name },
            'Discord bot added to guild (channels auto-register on first message)',
          );
        });

        // Guild delete (bot removed from a server) — log only
        discordClient.on(Events.GuildDelete, (guild) => {
          logger.info(
            { guildId: guild.id },
            'Discord bot removed from guild',
          );
        });

        // Login and wait for ClientReady before returning
        // (login() resolves before ClientReady fires, so isConnected()
        // would return false if we returned immediately after login)
        const readyPromise = new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            reject(new Error('Discord ClientReady timeout (15s)'));
          }, 15000);
          discordClient!.once(Events.ClientReady, () => {
            clearTimeout(timeout);
            resolve();
          });
        });
        await discordClient.login(config.botToken);
        await readyPromise;
        return true;
      } catch (err) {
        logger.error({ err }, 'Discord initial connection failed');
        discordClient = null;
        return false;
      }
    },

    async disconnect(): Promise<void> {
      stopping = true;
      if (discordClient) {
        try {
          discordClient.destroy();
        } catch (err) {
          logger.debug({ err }, 'Error disconnecting Discord client');
        }
        discordClient = null;
      }
      readyFired = false;
      msgCache.clear();
      lastMessageIds.clear();
      ackReactionByChat.clear();
      logger.info('Discord bot disconnected');
    },

    sendMessage,

    async sendImage(
      chatId: string,
      imageBuffer: Buffer,
      mimeType: string,
      caption?: string,
      fileName?: string,
    ): Promise<void> {
      const channel = await resolveChannel(chatId);
      if (!channel) {
        logger.error({ chatId }, 'Discord sendImage: failed to resolve channel');
        throw new Error(`Discord sendImage: unknown chat ${chatId}`);
      }

      const fname = fileName || `image.${mimeType.split('/')[1] || 'png'}`;
      const attachment = new AttachmentBuilder(imageBuffer, { name: fname });

      if (caption) {
        await channel.send({ content: caption, files: [attachment] });
      } else {
        await channel.send({ files: [attachment] });
      }
      logger.info({ chatId, fileName: fname }, 'Discord image sent');
    },

    async sendFile(
      chatId: string,
      filePath: string,
      fileName: string,
    ): Promise<void> {
      const channel = await resolveChannel(chatId);
      if (!channel) {
        logger.error({ chatId }, 'Discord sendFile: failed to resolve channel');
        throw new Error(`Discord sendFile: unknown chat ${chatId}`);
      }

      let fileBuffer: Buffer;
      try {
        fileBuffer = await fs.readFile(filePath);
      } catch (err) {
        logger.error(
          { err, filePath },
          'Discord sendFile: failed to read file',
        );
        throw new Error(`Discord sendFile: failed to read file ${filePath}`);
      }

      if (fileBuffer.length === 0) {
        throw new Error('Discord sendFile: empty file');
      }

      const attachment = new AttachmentBuilder(fileBuffer, { name: fileName });
      await channel.send({ files: [attachment] });
      logger.info({ chatId, fileName }, 'Discord file sent');
    },

    async setTyping(chatId: string, isTyping: boolean): Promise<void> {
      if (!isTyping) return;
      try {
        const channel = await resolveChannel(chatId);
        if (channel) {
          await channel.sendTyping();
        }
      } catch (err) {
        logger.debug({ err, chatId }, 'Discord setTyping failed');
      }
    },

    clearAckReaction(chatId: string): void {
      recallAckReaction(chatId).catch(() => {});
    },

    isConnected(): boolean {
      return discordClient !== null && !stopping && readyFired;
    },

    getLastMessageId(chatId: string): string | undefined {
      return lastMessageIds.get(chatId);
    },

    async createStreamingSession(
      chatId: string,
      onCardCreated?: (messageId: string) => void,
    ): Promise<
      | import('./discord-streaming-edit.js').DiscordStreamingEditController
      | undefined
    > {
      const channel = await resolveChannel(chatId);
      if (!channel) return undefined;

      const { DiscordStreamingEditController } = await import(
        './discord-streaming-edit.js'
      );
      return new DiscordStreamingEditController(
        channel as TextChannel | DMChannel,
        {
          onCardCreated,
          fallbackSend: (text: string) => sendMessage(chatId, text),
        },
      );
    },
  };

  return connection;
}
