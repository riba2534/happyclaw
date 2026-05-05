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
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import qrcode from 'qrcode';
import {
  makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  type WASocket,
  type WAMessage,
  type proto,
} from '@whiskeysockets/baileys';
import type { Boom } from '@hapi/boom';
import { logger } from './logger.js';
import { storeChatMetadata, storeMessageDirect, updateChatName } from './db.js';
import { notifyNewImMessage } from './message-notifier.js';
import { broadcastNewMessage } from './web.js';

const CHANNEL_PREFIX = 'whatsapp:';

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

const NOT_IMPLEMENTED_M3 =
  'WhatsApp send path not implemented yet (M3 scope: sendMessage/sendImage/sendFile)';

const RECONNECT_DELAY_MS = 3_000;

// ─── Factory ────────────────────────────────────────────────────

export function createWhatsAppConnection(
  config: WhatsAppConnectionConfig,
): WhatsAppConnection {
  let sock: WASocket | null = null;
  let currentState: WhatsAppConnectionState = { status: 'disconnected' };
  let opts: WhatsAppConnectOpts | null = null;
  let intentionalDisconnect = false;
  let reconnectTimer: NodeJS.Timeout | null = null;

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
    const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
    const { version, isLatest } = await fetchLatestBaileysVersion();
    logger.info(
      { feature: 'whatsapp', version, isLatest, authDir: config.authDir },
      'Initialising WhatsApp socket',
    );

    sock = makeWASocket({
      version,
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
    if (!text) {
      // M3 will handle media (image/audio/document/video). For now log and skip.
      logger.debug(
        { remoteJid, msgId: key.id, types: Object.keys(content) },
        'WhatsApp non-text message ignored (M3 scope)',
      );
      return;
    }

    const chatJid = `${CHANNEL_PREFIX}${remoteJid}`;
    const isGroup = remoteJid.endsWith('@g.us');
    const senderRaw = isGroup ? key.participant || remoteJid : remoteJid;
    const senderId = `${CHANNEL_PREFIX}${senderRaw}`;
    const senderName = pushName || (isGroup ? '群成员' : remoteJid);
    const chatName = isGroup ? remoteJid : senderName;
    const timestampISO = new Date(tsMs > 0 ? tsMs : Date.now()).toISOString();

    storeChatMetadata(chatJid, timestampISO);
    updateChatName(chatJid, chatName);
    opts.onNewChat(chatJid, chatName);

    // Slash command interception (matches Telegram pattern: `/cmd args`)
    const trimmed = text.trim();
    const slashMatch = trimmed.match(/^\/(\S+)(?:\s+(.*))?$/s);
    if (slashMatch && opts.onCommand) {
      const cmdBody = (
        slashMatch[1] + (slashMatch[2] ? ' ' + slashMatch[2] : '')
      ).trim();
      try {
        const reply = await opts.onCommand(chatJid, cmdBody);
        if (reply !== null && reply !== undefined) {
          // Known command handled — best-effort send back. Until M3 sendMessage
          // is implemented, fall back to logging.
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
      text,
      timestampISO,
      false,
      { sourceJid: chatJid },
    );

    broadcastNewMessage(
      targetJid,
      {
        id,
        chat_jid: targetJid,
        source_jid: chatJid,
        sender: senderId,
        sender_name: senderName,
        content: text,
        timestamp: timestampISO,
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
      // M2 minimal impl: plain text only, no Markdown stripping, no chunking,
      // no image attach. M3 will wrap with chunking + Markdown→plain + image.
      if (localImagePaths && localImagePaths.length > 0) {
        logger.warn(
          { feature: 'whatsapp', chatId, count: localImagePaths.length },
          'WhatsApp local image attach not implemented yet (M3)',
        );
      }
      if (!sock) {
        logger.warn(
          { feature: 'whatsapp', chatId },
          'WhatsApp sendMessage skipped: socket not connected',
        );
        return;
      }
      const jid = chatId.startsWith(CHANNEL_PREFIX)
        ? chatId.slice(CHANNEL_PREFIX.length)
        : chatId;
      try {
        await sock.sendMessage(jid, { text });
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
      _imageBuffer: Buffer,
      _mimeType: string,
      _caption?: string,
      _fileName?: string,
    ): Promise<void> {
      void _imageBuffer;
      void _mimeType;
      void _caption;
      void _fileName;
      logger.warn(
        { feature: 'whatsapp', chatId },
        'sendImage called — M3 not implemented yet',
      );
      throw new Error(NOT_IMPLEMENTED_M3);
    },

    async sendFile(
      chatId: string,
      _filePath: string,
      _fileName: string,
    ): Promise<void> {
      void _filePath;
      void _fileName;
      logger.warn(
        { feature: 'whatsapp', chatId },
        'sendFile called — M3 not implemented yet',
      );
      throw new Error(NOT_IMPLEMENTED_M3);
    },

    async sendTyping(_chatId: string, _isTyping: boolean): Promise<void> {
      void _chatId;
      void _isTyping;
      // M3 will use sock.sendPresenceUpdate('composing'|'paused', chatId)
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
function extractMessageText(content: proto.IMessage): string | null {
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
function normalizeTimestamp(
  ts: number | Long.Long | null | undefined,
): number {
  if (ts === null || ts === undefined) return 0;
  if (typeof ts === 'number') return ts * 1000;
  // Long.js-like object exposes toNumber()
  if (typeof (ts as { toNumber?: () => number }).toNumber === 'function') {
    return (ts as { toNumber: () => number }).toNumber() * 1000;
  }
  return 0;
}
