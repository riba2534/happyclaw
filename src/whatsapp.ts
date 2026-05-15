/**
 * WhatsApp Channel — Baileys integration (M1: QR login + connection state)
 *
 * 基于 @whiskeysockets/baileys 6.17.16 接入 WhatsApp Web 协议。
 *
 * M1 范围（本提交）：
 *  - useMultiFileAuthState 持久化登录态（多文件 auth state，存在 authDir 下）
 *  - makeWASocket 建立 WebSocket 长连接到 Meta
 *  - 监听 connection.update：将 status / QR 串通过 onConnectionUpdate 推到上层
 *  - QR 串经 qrcode 库 render 成 PNG data URL，前端可直接 <img src=> 展示
 *  - disconnect 优雅关闭、isConnected 反映真实状态
 *  - 自动重连：被 Meta 主动断开（非 logged out）时延迟 3s 重连
 *
 * M2/M3 待补：messages.upsert 转发到 onMessage、sendMessage / sendImage / sendFile
 * 实际投递（目前仍 throw NOT_IMPLEMENTED 占位）。
 *
 * 风险：Baileys 是逆向 WhatsApp Web 协议的社区方案，封号率随 Meta 风控收紧上升。
 * 商用场景应使用官方 Cloud API。
 */
import { mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import qrcode from 'qrcode';
import {
  makeWASocket,
  DisconnectReason,
  downloadMediaMessage,
  jidNormalizedUser,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  type WASocket,
  type WAMessage,
  type proto,
} from '@whiskeysockets/baileys';
import type { Boom } from '@hapi/boom';
import { readFile } from 'node:fs/promises';
import { logger } from './logger.js';
import { storeChatMetadata, storeMessageDirect, updateChatName } from './db.js';
import { notifyNewImMessage } from './message-notifier.js';
import { broadcastNewMessage } from './web.js';
import { markdownToPlainText, splitTextChunks } from './im-utils.js';
import { saveDownloadedFile, FileTooLargeError } from './im-downloader.js';

const CHANNEL_PREFIX = 'whatsapp:';
/** WhatsApp text message safe limit. Baileys allows up to 64KB but UX clamps far below. */
const TEXT_CHUNK_LIMIT = 4096;
/** Inline image as base64 attachment (for Vision API) only when ≤ 5MB. */
const IMAGE_MAX_BASE64_SIZE = 5 * 1024 * 1024;

// ─── Types ──────────────────────────────────────────────────────

export interface WhatsAppConnectionConfig {
  /** Account identifier — currently 固定 'default'，未来扩展 multi-account 用 */
  accountId?: string;
  /** Optional phone number hint for display purposes (E.164 format, e.g. +15551234567) */
  phoneNumber?: string;
  /** Auth state directory; required for production use to persist login between restarts */
  authDir: string;
}

export type WhatsAppConnectionStatus =
  | 'connecting'
  | 'qr'
  | 'connected'
  | 'disconnected'
  | 'logged_out';

export interface WhatsAppConnectionState {
  status: WhatsAppConnectionStatus;
  /** Raw QR string (only when status='qr') */
  qr?: string;
  /** Pre-rendered PNG data URL of the QR (only when status='qr'), ready for <img src=> */
  qrDataUrl?: string;
  /** Human-readable error reason when status='disconnected' or 'logged_out' */
  error?: string;
  /** Self-bot WhatsApp JID once logged in (e.g. 15551234567@s.whatsapp.net) */
  meJid?: string;
  /** Display name of the logged-in account */
  meName?: string;
}

export interface WhatsAppConnectOpts {
  onReady?: () => void;
  onNewChat: (jid: string, name: string) => void;
  ignoreMessagesBefore?: number;
  onCommand?: (chatJid: string, command: string) => Promise<string | null>;
  resolveGroupFolder?: (jid: string) => string | undefined;
  resolveEffectiveChatJid?: (
    chatJid: string,
  ) => { effectiveJid: string; agentId: string | null } | null;
  onAgentMessage?: (baseChatJid: string, agentId: string) => void;
  /** Bot added to a new group */
  onBotAddedToGroup?: (chatJid: string, chatName: string) => void;
  /** Bot removed from a group / group dissolved */
  onBotRemovedFromGroup?: (chatJid: string) => void;
  /** Group msg gate: bot not mentioned + this returns false → drop */
  shouldProcessGroupMessage?: (chatJid: string, senderImId?: string) => boolean;
  /** owner_mentioned mode: bot @mentioned but sender not group owner → drop */
  isGroupOwnerMessage?: (chatJid: string, senderImId?: string) => boolean;
  /** Sender allowlist: false → drop before any further processing */
  isSenderAllowedInGroup?: (chatJid: string, senderImId?: string) => boolean;
  /** WhatsApp 专属：连接状态变化回调（QR 出现、connected、断线等） */
  onConnectionUpdate?: (state: WhatsAppConnectionState) => void;
}

export interface WhatsAppConnection {
  connect(opts: WhatsAppConnectOpts): Promise<void>;
  disconnect(): Promise<void>;
  /** Force log out and clear local auth state (user clicks "退出登录") */
  logout(): Promise<void>;
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
  sendTyping(chatId: string, isTyping: boolean): Promise<void>;
  isConnected(): boolean;
  /** Current connection state snapshot (latest seen) */
  getState(): WhatsAppConnectionState;
}

const RECONNECT_DELAY_MS = 3_000;
/** Message dedup cache: matches feishu/qq/dingtalk (1000 entries, 30min TTL). */
const MSG_DEDUP_MAX = 1000;
const MSG_DEDUP_TTL_MS = 30 * 60 * 1000;
/**
 * Delay between WhatsApp text chunks. WhatsApp Web's anti-spam will rate-limit
 * (and at the high end, contribute to bans) bursts of messages from the same
 * sender. 300ms keeps small replies fast while throttling long chunked replies.
 */
const CHUNK_SEND_DELAY_MS = 300;

/**
 * Cached Baileys protocol version. fetchLatestBaileysVersion() hits the network
 * on every reconnect — if the box is offline it blocks the socket. We hit the
 * network the first time we successfully connect, then reuse across reconnects.
 */
let cachedBaileysVersion: [number, number, number] | null = null;

// ─── Factory ────────────────────────────────────────────────────

export function createWhatsAppConnection(
  config: WhatsAppConnectionConfig,
): WhatsAppConnection {
  let sock: WASocket | null = null;
  let currentState: WhatsAppConnectionState = { status: 'disconnected' };
  let opts: WhatsAppConnectOpts | null = null;
  let intentionalDisconnect = false;
  let reconnectTimer: NodeJS.Timeout | null = null;
  // Cache real group display names (jid → name); fetched lazily per group on
  // first message arrival to avoid blowing up reconnect.
  const groupNameCache = new Map<string, string>();
  // LRU dedup cache: key = `${remoteJid}|${msgId}`, value = insertion timestamp.
  // Baileys can re-emit the same key.id at reconnect boundaries or when
  // history/notify streams overlap; without this cache the Agent responds twice.
  const msgCache = new Map<string, number>();

  function isDuplicate(msgKey: string): boolean {
    const now = Date.now();
    // Map preserves insertion order; expire from the head until first fresh entry.
    for (const [k, ts] of msgCache.entries()) {
      if (now - ts > MSG_DEDUP_TTL_MS) {
        msgCache.delete(k);
      } else {
        break;
      }
    }
    return msgCache.has(msgKey);
  }

  function markSeen(msgKey: string): void {
    if (msgCache.size >= MSG_DEDUP_MAX) {
      const firstKey = msgCache.keys().next().value;
      if (firstKey) msgCache.delete(firstKey);
    }
    msgCache.delete(msgKey);
    msgCache.set(msgKey, Date.now());
  }

  async function resolveGroupName(remoteJid: string): Promise<void> {
    if (!sock) return;
    try {
      const meta = await sock.groupMetadata(remoteJid);
      const subject = meta?.subject;
      if (subject) {
        groupNameCache.set(remoteJid, subject);
        try {
          updateChatName(`${CHANNEL_PREFIX}${remoteJid}`, subject);
        } catch (err) {
          logger.debug({ err, remoteJid }, 'Failed to persist group name');
        }
      }
    } catch (err) {
      logger.debug({ err, remoteJid }, 'WhatsApp groupMetadata failed');
    }
  }

  function setState(next: WhatsAppConnectionState): void {
    currentState = next;
    try {
      opts?.onConnectionUpdate?.(next);
    } catch (err) {
      logger.warn({ err }, 'WhatsApp onConnectionUpdate callback threw');
    }
  }

  async function startSocket(): Promise<void> {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    await mkdir(config.authDir, { recursive: true });
    // Baileys MultiFileAuthState holds the full WhatsApp login session
    // (noise keys, Signal pre-keys, etc.) — equivalent to a permanent
    // login credential. Tighten perms to 0700 to match session-secret.key's
    // 0600 posture on multi-user machines.
    try {
      await chmod(config.authDir, 0o700);
    } catch (err) {
      logger.warn(
        { err, authDir: config.authDir },
        'Failed to chmod WhatsApp auth dir to 0700 — proceeding with umask default',
      );
    }
    const { state, saveCreds } = await useMultiFileAuthState(config.authDir);

    // Reuse cached version across reconnects to avoid blocking the socket
    // when the network is flaky. First connect still hits the network so
    // we pick up Baileys protocol bumps within the same process lifetime.
    let version: [number, number, number] | null = cachedBaileysVersion;
    let isLatest = true;
    if (!version) {
      try {
        const fetched = await fetchLatestBaileysVersion();
        version = fetched.version;
        isLatest = fetched.isLatest;
        cachedBaileysVersion = version;
      } catch (err) {
        logger.warn(
          { err },
          'fetchLatestBaileysVersion failed; Baileys will use its bundled default version',
        );
      }
    }
    logger.info(
      { feature: 'whatsapp', version, isLatest, authDir: config.authDir },
      'Initialising WhatsApp socket',
    );

    sock = makeWASocket({
      // Skip version when unavailable so Baileys uses its bundled default
      ...(version ? { version } : {}),
      auth: state,
      printQRInTerminal: false,
      // 用 pino 兼容的 logger（baileys 期望 pino 接口）
      logger: logger.child({ feature: 'whatsapp-baileys' }) as never,
      browser: ['HappyClaw', 'Desktop', '1.0.0'],
      markOnlineOnConnect: false,
    });

    setState({ status: 'connecting' });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          const qrDataUrl = await qrcode.toDataURL(qr, {
            errorCorrectionLevel: 'M',
            margin: 2,
            scale: 6,
          });
          setState({ status: 'qr', qr, qrDataUrl });
          logger.info(
            { feature: 'whatsapp' },
            'WhatsApp QR ready, awaiting scan',
          );
        } catch (err) {
          logger.warn({ err }, 'Failed to render WhatsApp QR data URL');
          setState({ status: 'qr', qr });
        }
      }

      if (connection === 'open') {
        const meJid = sock?.user?.id;
        const meName = sock?.user?.name ?? undefined;
        setState({ status: 'connected', meJid, meName });
        logger.info(
          { feature: 'whatsapp', meJid, meName },
          'WhatsApp connected',
        );
        try {
          opts?.onReady?.();
        } catch (err) {
          logger.warn({ err }, 'WhatsApp onReady callback threw');
        }
      }

      if (connection === 'close') {
        const boomErr = lastDisconnect?.error as Boom | undefined;
        const statusCode = boomErr?.output?.statusCode;
        const isLoggedOut = statusCode === DisconnectReason.loggedOut;
        const reason = boomErr?.message || `closed (code ${statusCode})`;

        logger.warn(
          { feature: 'whatsapp', statusCode, reason, intentionalDisconnect },
          'WhatsApp connection closed',
        );

        if (isLoggedOut) {
          setState({ status: 'logged_out', error: reason });
          // Auth state on disk is now invalid; user must re-scan QR
          // We do NOT auto-reconnect on logged_out — it would just yield a new QR
          // immediately and surprise the user. They re-enable from UI.
          sock = null;
          return;
        }

        setState({ status: 'disconnected', error: reason });
        sock = null;

        if (!intentionalDisconnect) {
          logger.info(
            { feature: 'whatsapp', delayMs: RECONNECT_DELAY_MS },
            'Scheduling WhatsApp reconnect',
          );
          reconnectTimer = setTimeout(() => {
            startSocket().catch((err) =>
              logger.error({ err }, 'WhatsApp reconnect failed'),
            );
          }, RECONNECT_DELAY_MS);
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      // 'notify' = real-time incoming, 'append' = history sync (skip)
      if (type !== 'notify') return;
      for (const msg of messages) {
        try {
          await handleIncomingMessage(msg);
        } catch (err) {
          logger.error(
            { err, msgId: msg.key?.id },
            'WhatsApp message handler threw',
          );
        }
      }
    });

    // Group membership events: bot added/removed from groups
    sock.ev.on('group-participants.update', async (update) => {
      try {
        const selfJid = sock?.user?.id ? jidNormalizedUser(sock.user.id) : null;
        if (!selfJid) return;
        const involvesSelf = update.participants.some(
          (p) => jidNormalizedUser(p) === selfJid,
        );
        if (!involvesSelf) return;

        const chatJid = `${CHANNEL_PREFIX}${update.id}`;
        if (update.action === 'add') {
          let chatName = update.id;
          try {
            const meta = await sock?.groupMetadata(update.id);
            if (meta?.subject) {
              chatName = meta.subject;
              groupNameCache.set(update.id, meta.subject);
            }
          } catch (err) {
            logger.debug({ err, jid: update.id }, 'group meta fetch failed on add');
          }
          opts?.onBotAddedToGroup?.(chatJid, chatName);
          logger.info({ chatJid, chatName }, 'WhatsApp bot added to group');
        } else if (update.action === 'remove') {
          opts?.onBotRemovedFromGroup?.(chatJid);
          groupNameCache.delete(update.id);
          logger.info({ chatJid }, 'WhatsApp bot removed from group');
        }
      } catch (err) {
        logger.warn({ err }, 'WhatsApp group-participants.update handler threw');
      }
    });
  }

  /**
   * Detect and download a media message (image/video/audio/document).
   * Returns null if `content` has no supported media node.
   * Returns { content, attachmentsJson } shaped like dingtalk's normalize result.
   */
  async function tryHandleMediaMessage(
    msg: WAMessage,
    content: proto.IMessage,
    groupFolder: string | undefined,
  ): Promise<{ content: string; attachmentsJson?: string } | null> {
    const detected = detectMedia(content);
    if (!detected) return null;
    const { kind, label, node, defaultExt } = detected;

    let buffer: Buffer;
    try {
      buffer = await downloadMediaMessage(
        msg,
        'buffer',
        {},
        {
          logger: logger.child({ feature: 'whatsapp-media' }) as never,
          reuploadRequest: sock?.updateMediaMessage as never,
        },
      );
    } catch (err) {
      logger.warn(
        { err, kind, msgId: msg.key?.id },
        'WhatsApp media download failed',
      );
      const cap = node.caption ? `: ${node.caption}` : '';
      return { content: `[${label} 下载失败${cap}]` };
    }

    const captionLine = node.caption ? `\n${node.caption}` : '';

    if (!groupFolder) {
      // No workspace mapping for this chat — skip disk save, just signal what arrived
      return { content: `[${label}（未关联工作区）${captionLine}]` };
    }

    const fileName =
      (node as { fileName?: string }).fileName ||
      `wa_${kind}_${Date.now()}${extFromMime(node.mimetype) || defaultExt}`;

    let savedPath: string;
    try {
      savedPath = await saveDownloadedFile(
        groupFolder,
        'whatsapp',
        fileName,
        buffer,
      );
    } catch (err) {
      if (err instanceof FileTooLargeError) {
        return {
          content: `[${label}: 文件过大未保存 ${(buffer.length / 1024 / 1024).toFixed(1)}MB${captionLine}]`,
        };
      }
      logger.warn({ err, kind, fileName }, 'WhatsApp media save failed');
      return { content: `[${label} 保存失败${captionLine}]` };
    }

    // Inline base64 for Vision when image fits
    let attachmentsJson: string | undefined;
    if (kind === 'image' && buffer.length <= IMAGE_MAX_BASE64_SIZE) {
      attachmentsJson = JSON.stringify([
        {
          type: 'image',
          data: buffer.toString('base64'),
          mimeType: node.mimetype || 'image/jpeg',
        },
      ]);
    }

    return {
      content: `[${label}: ${savedPath}]${captionLine}`,
      attachmentsJson,
    };
  }

  /** Convert one baileys WAMessage into our IM pipeline (storeMessageDirect + broadcast). */
  async function handleIncomingMessage(msg: WAMessage): Promise<void> {
    if (!opts) return;
    const { key, message: content, pushName, messageTimestamp } = msg;
    if (!key || !content) return;
    if (key.fromMe) return; // 自己发的消息不回流

    const remoteJid = key.remoteJid;
    if (!remoteJid) return;

    // newsletter / status broadcasts and unrelated system jids — skip
    if (remoteJid === 'status@broadcast' || remoteJid.endsWith('@newsletter')) {
      return;
    }

    // LRU dedup: skip duplicates that re-arrive at reconnect / stream-switch
    // boundaries. Keyed by (remoteJid, key.id) because Baileys reuses key.id
    // across chats. fromMe is already filtered above, so left out of the key.
    if (key.id) {
      const dedupKey = `${remoteJid}|${key.id}`;
      if (isDuplicate(dedupKey)) {
        logger.debug({ msgId: key.id, remoteJid }, 'WhatsApp duplicate dropped');
        return;
      }
      markSeen(dedupKey);
    }

    // Filter old messages (heat-up after reconnect, history sync stragglers)
    const tsMs = normalizeTimestamp(messageTimestamp);
    if (
      tsMs > 0 &&
      opts.ignoreMessagesBefore &&
      tsMs < opts.ignoreMessagesBefore
    ) {
      return;
    }

    const text = extractMessageText(content);
    const chatJid = `${CHANNEL_PREFIX}${remoteJid}`;
    const isGroup = remoteJid.endsWith('@g.us');
    const senderRaw = isGroup ? key.participant || remoteJid : remoteJid;
    const senderImId = jidNormalizedUser(senderRaw);
    const senderId = `${CHANNEL_PREFIX}${senderRaw}`;
    const senderName = pushName || (isGroup ? '群成员' : remoteJid);
    const chatName = groupNameCache.get(remoteJid) || (isGroup ? remoteJid : senderName);
    const timestampISO = new Date(tsMs > 0 ? tsMs : Date.now()).toISOString();

    // ── Group gates: sender allowlist → mention required → owner check ──
    if (isGroup) {
      if (
        opts.isSenderAllowedInGroup &&
        !opts.isSenderAllowedInGroup(chatJid, senderImId)
      ) {
        logger.debug(
          { chatJid, senderImId },
          'WhatsApp dropped: sender not allowlisted',
        );
        return;
      }

      const isBotMentioned = isMentioningBot(content, sock?.user?.id);
      if (
        opts.shouldProcessGroupMessage &&
        !isBotMentioned &&
        !opts.shouldProcessGroupMessage(chatJid, senderImId)
      ) {
        logger.debug(
          { chatJid, senderImId },
          'WhatsApp dropped: mention required but bot not @mentioned',
        );
        return;
      }
      if (
        isBotMentioned &&
        opts.isGroupOwnerMessage &&
        !opts.isGroupOwnerMessage(chatJid, senderImId)
      ) {
        logger.debug(
          { chatJid, senderImId },
          'WhatsApp dropped: owner_mentioned mode, sender is not group owner',
        );
        return;
      }

      // Lazy-fetch real group name and update DB out-of-band
      if (!groupNameCache.has(remoteJid)) {
        groupNameCache.set(remoteJid, remoteJid); // tentative, prevents repeat fetches
        void resolveGroupName(remoteJid);
      }
    }

    // If no text, try to handle media (image/video/audio/document)
    let finalContent = text;
    let attachmentsJson: string | undefined;
    if (!finalContent) {
      const groupFolder = opts.resolveGroupFolder?.(chatJid);
      const media = await tryHandleMediaMessage(
        msg,
        content,
        groupFolder,
      );
      if (!media) {
        logger.debug(
          { remoteJid, msgId: key.id, types: Object.keys(content) },
          'WhatsApp message has neither text nor supported media',
        );
        return;
      }
      finalContent = media.content;
      attachmentsJson = media.attachmentsJson;
    }

    storeChatMetadata(chatJid, timestampISO);
    updateChatName(chatJid, chatName);
    opts.onNewChat(chatJid, chatName);

    // Slash command interception (matches Telegram pattern: `/cmd args`)
    const trimmed = finalContent.trim();
    const slashMatch = trimmed.match(/^\/(\S+)(?:\s+(.*))?$/s);
    if (slashMatch && opts.onCommand) {
      const cmdBody = (
        slashMatch[1] + (slashMatch[2] ? ' ' + slashMatch[2] : '')
      ).trim();
      try {
        const reply = await opts.onCommand(chatJid, cmdBody);
        if (reply !== null && reply !== undefined) {
          if (sock) {
            try {
              await sock.sendMessage(remoteJid, { text: reply });
            } catch (err) {
              logger.warn({ err, chatJid }, 'WhatsApp slash reply send failed');
            }
          }
          return;
        }
      } catch (err) {
        logger.error({ err, chatJid, cmd: slashMatch[1] }, 'WhatsApp slash command failed');
      }
    }

    // Resolve agent routing (binding to a sub-agent inside a workspace)
    const routing = opts.resolveEffectiveChatJid?.(chatJid);
    const targetJid = routing?.effectiveJid ?? chatJid;
    const id = crypto.randomUUID();

    storeChatMetadata(targetJid, timestampISO);
    storeMessageDirect(
      id,
      targetJid,
      senderId,
      senderName,
      finalContent,
      timestampISO,
      false,
      { attachments: attachmentsJson, sourceJid: chatJid },
    );

    broadcastNewMessage(
      targetJid,
      {
        id,
        chat_jid: targetJid,
        source_jid: chatJid,
        sender: senderId,
        sender_name: senderName,
        content: finalContent,
        timestamp: timestampISO,
        attachments: attachmentsJson,
        is_from_me: false,
      },
      routing?.agentId ?? undefined,
    );
    notifyNewImMessage();

    if (routing?.agentId) {
      opts.onAgentMessage?.(chatJid, routing.agentId);
      logger.info(
        { chatJid, effectiveJid: targetJid, agentId: routing.agentId },
        'WhatsApp message routed to conversation agent',
      );
    } else {
      logger.info(
        { chatJid, sender: senderName, msgId: key.id, isGroup },
        'WhatsApp message stored',
      );
    }
  }

  return {
    async connect(connectOpts: WhatsAppConnectOpts): Promise<void> {
      opts = connectOpts;
      intentionalDisconnect = false;
      await startSocket();
    },

    async disconnect(): Promise<void> {
      intentionalDisconnect = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (sock) {
        try {
          sock.end(undefined);
        } catch (err) {
          logger.warn({ err }, 'WhatsApp socket.end threw');
        }
        sock = null;
      }
      setState({ status: 'disconnected' });
    },

    async logout(): Promise<void> {
      intentionalDisconnect = true;
      if (sock) {
        try {
          await sock.logout();
        } catch (err) {
          logger.warn({ err }, 'WhatsApp logout threw');
        }
        try {
          sock.end(undefined);
        } catch {
          /* ignore */
        }
        sock = null;
      }
      // Note: auth files on disk remain; caller (im-manager) wipes authDir if needed
      setState({ status: 'logged_out' });
    },

    async sendMessage(
      chatId: string,
      text: string,
      localImagePaths?: string[],
    ): Promise<void> {
      if (!sock) {
        logger.warn(
          { feature: 'whatsapp', chatId },
          'WhatsApp sendMessage skipped: socket not connected',
        );
        return;
      }
      const jid = stripChannelPrefix(chatId);

      // Strip markdown to WhatsApp plain text (matches dingtalk/wechat/qq pattern).
      // WhatsApp DOES support its own markdown subset (*bold*/_italic_/~strike~)
      // but Claude output uses standard markdown — converting in-place is fragile,
      // so we pick the safe option: drop formatting, send plain text.
      const plain = markdownToPlainText(text);
      const chunks = splitTextChunks(plain, TEXT_CHUNK_LIMIT);

      try {
        for (let i = 0; i < chunks.length; i++) {
          const chunk =
            chunks.length > 1
              ? `${chunks[i]}\n\n(${i + 1}/${chunks.length})`
              : chunks[i];
          await sock.sendMessage(jid, { text: chunk });
          // Throttle between chunks to stay under WhatsApp Web's anti-spam
          // burst threshold; same reason qq/dingtalk soft-throttle bulk sends.
          if (i < chunks.length - 1) {
            await new Promise((resolve) =>
              setTimeout(resolve, CHUNK_SEND_DELAY_MS),
            );
          }
        }

        if (localImagePaths && localImagePaths.length > 0) {
          for (const imgPath of localImagePaths) {
            try {
              const buf = await readFile(imgPath);
              const mime = guessMimeType(imgPath) || 'image/jpeg';
              await sock.sendMessage(jid, { image: buf, mimetype: mime });
            } catch (err) {
              logger.warn(
                { err, imgPath, chatId },
                'WhatsApp local image attach failed',
              );
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, feature: 'whatsapp', chatId },
          'WhatsApp sendMessage failed',
        );
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
      if (!sock) {
        logger.warn(
          { feature: 'whatsapp', chatId },
          'WhatsApp sendImage skipped: socket not connected',
        );
        return;
      }
      const jid = stripChannelPrefix(chatId);
      try {
        await sock.sendMessage(jid, {
          image: imageBuffer,
          mimetype: mimeType,
          caption: caption ? markdownToPlainText(caption) : undefined,
          fileName,
        });
      } catch (err) {
        logger.error(
          { err, feature: 'whatsapp', chatId },
          'WhatsApp sendImage failed',
        );
        throw err;
      }
    },

    async sendFile(
      chatId: string,
      filePath: string,
      fileName: string,
    ): Promise<void> {
      if (!sock) {
        logger.warn(
          { feature: 'whatsapp', chatId },
          'WhatsApp sendFile skipped: socket not connected',
        );
        return;
      }
      const jid = stripChannelPrefix(chatId);
      try {
        const buf = await readFile(filePath);
        const mime = guessMimeType(fileName) || 'application/octet-stream';
        await sock.sendMessage(jid, {
          document: buf,
          mimetype: mime,
          fileName,
        });
      } catch (err) {
        logger.error(
          { err, feature: 'whatsapp', chatId, filePath },
          'WhatsApp sendFile failed',
        );
        throw err;
      }
    },

    async sendTyping(chatId: string, isTyping: boolean): Promise<void> {
      if (!sock) return;
      const jid = stripChannelPrefix(chatId);
      try {
        await sock.sendPresenceUpdate(isTyping ? 'composing' : 'paused', jid);
      } catch (err) {
        logger.debug({ err, chatId }, 'WhatsApp sendPresenceUpdate failed');
      }
    },

    isConnected(): boolean {
      return currentState.status === 'connected' && sock !== null;
    },

    getState(): WhatsAppConnectionState {
      return currentState;
    },
  };
}

/** Compute the auth state directory for a given user / account. */
export function getWhatsAppAuthDir(
  dataDir: string,
  userId: string,
  accountId = 'default',
): string {
  return path.join(dataDir, 'config', 'user-im', userId, 'whatsapp-auth', accountId);
}

/**
 * Extract human-readable text from a baileys IMessage payload.
 * Returns null for unsupported message types (image/audio/video/document — M3 scope).
 */
export function extractMessageText(content: proto.IMessage): string | null {
  if (content.conversation) return content.conversation;
  if (content.extendedTextMessage?.text) return content.extendedTextMessage.text;
  // Sometimes ephemeral / view-once wrap the inner content
  if (content.ephemeralMessage?.message) {
    return extractMessageText(content.ephemeralMessage.message);
  }
  if (content.viewOnceMessage?.message) {
    return extractMessageText(content.viewOnceMessage.message);
  }
  if (content.viewOnceMessageV2?.message) {
    return extractMessageText(content.viewOnceMessageV2.message);
  }
  // Image / video / document with caption — treat caption as the message text
  // so the user at least sees what was sent. Media binary download is M3.
  if (content.imageMessage?.caption) return content.imageMessage.caption;
  if (content.videoMessage?.caption) return content.videoMessage.caption;
  if (content.documentMessage?.caption) return content.documentMessage.caption;
  return null;
}

/**
 * Baileys `messageTimestamp` may be number, Long, or undefined. Convert to ms.
 * Returns 0 if not a usable value (caller falls back to Date.now()).
 */
export function normalizeTimestamp(
  ts: number | { toNumber(): number } | null | undefined,
): number {
  if (ts === null || ts === undefined) return 0;
  if (typeof ts === 'number') return ts * 1000;
  // Long.js-like object exposes toNumber()
  if (typeof (ts as { toNumber?: () => number }).toNumber === 'function') {
    return (ts as { toNumber: () => number }).toNumber() * 1000;
  }
  return 0;
}

interface DetectedMedia {
  kind: 'image' | 'video' | 'audio' | 'document';
  label: string;
  defaultExt: string;
  node: {
    mimetype?: string | null;
    caption?: string | null;
    fileName?: string | null;
  };
}

function detectMedia(content: proto.IMessage): DetectedMedia | null {
  if (content.imageMessage) {
    return {
      kind: 'image',
      label: '图片',
      defaultExt: '.jpg',
      node: content.imageMessage as DetectedMedia['node'],
    };
  }
  if (content.videoMessage) {
    return {
      kind: 'video',
      label: '视频',
      defaultExt: '.mp4',
      node: content.videoMessage as DetectedMedia['node'],
    };
  }
  if (content.audioMessage) {
    const isPtt = (content.audioMessage as { ptt?: boolean | null }).ptt;
    return {
      kind: 'audio',
      label: isPtt ? '语音' : '音频',
      defaultExt: '.ogg',
      node: content.audioMessage as DetectedMedia['node'],
    };
  }
  if (content.documentMessage) {
    return {
      kind: 'document',
      label: '文档',
      defaultExt: '',
      node: content.documentMessage as DetectedMedia['node'],
    };
  }
  return null;
}

export function extFromMime(mime: string | null | undefined): string | null {
  if (!mime) return null;
  const m = mime.toLowerCase();
  if (m.includes('jpeg')) return '.jpg';
  if (m.includes('png')) return '.png';
  if (m.includes('gif')) return '.gif';
  if (m.includes('webp')) return '.webp';
  if (m.includes('mp4')) return '.mp4';
  if (m.includes('quicktime')) return '.mov';
  if (m.includes('webm')) return '.webm';
  if (m.includes('mpeg') && m.startsWith('audio')) return '.mp3';
  if (m.includes('ogg')) return '.ogg';
  if (m.includes('aac')) return '.aac';
  if (m.includes('wav')) return '.wav';
  if (m.includes('pdf')) return '.pdf';
  return null;
}

export function stripChannelPrefix(chatId: string): string {
  return chatId.startsWith(CHANNEL_PREFIX)
    ? chatId.slice(CHANNEL_PREFIX.length)
    : chatId;
}

/**
 * Check if a baileys message @mentions the bot itself.
 *
 * Mentioning lives in `extendedTextMessage.contextInfo.mentionedJid` (string[]).
 * Self jid format from sock.user.id includes a device suffix
 * (e.g. `15551234567:42@s.whatsapp.net`) — normalize both sides before compare.
 */
export function isMentioningBot(
  content: proto.IMessage,
  selfJid: string | null | undefined,
): boolean {
  if (!selfJid) return true; // Safety degrade: no self-id known → don't gate
  const selfNorm = jidNormalizedUser(selfJid);
  const ctx =
    content.extendedTextMessage?.contextInfo ||
    content.imageMessage?.contextInfo ||
    content.videoMessage?.contextInfo ||
    content.documentMessage?.contextInfo ||
    content.audioMessage?.contextInfo;
  const mentioned = ctx?.mentionedJid;
  if (!mentioned || mentioned.length === 0) return false;
  return mentioned.some((m) => jidNormalizedUser(m) === selfNorm);
}

/**
 * Tiny mime type lookup based on file extension.
 * Covers WhatsApp-relevant types: image/video/audio/document.
 * Returns null when unknown so caller can fall back to a sensible default.
 */
export function guessMimeType(fileName: string): string | null {
  const m = fileName.toLowerCase().match(/\.([a-z0-9]+)$/);
  if (!m) return null;
  const ext = m[1];
  // Image
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'png') return 'image/png';
  if (ext === 'gif') return 'image/gif';
  if (ext === 'webp') return 'image/webp';
  // Video
  if (ext === 'mp4') return 'video/mp4';
  if (ext === 'mov') return 'video/quicktime';
  if (ext === 'webm') return 'video/webm';
  // Audio
  if (ext === 'mp3') return 'audio/mpeg';
  if (ext === 'ogg' || ext === 'opus') return 'audio/ogg';
  if (ext === 'm4a' || ext === 'aac') return 'audio/aac';
  if (ext === 'wav') return 'audio/wav';
  // Document
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'doc') return 'application/msword';
  if (ext === 'docx')
    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (ext === 'xls') return 'application/vnd.ms-excel';
  if (ext === 'xlsx')
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  if (ext === 'ppt') return 'application/vnd.ms-powerpoint';
  if (ext === 'pptx')
    return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  if (ext === 'zip') return 'application/zip';
  if (ext === 'txt') return 'text/plain';
  if (ext === 'json') return 'application/json';
  if (ext === 'csv') return 'text/csv';
  return null;
}
