/**
 * WhatsApp Channel — Baileys integration
 *
 * 基于 OpenClaw 同版本的 baileys 7.0.0-rc13 接入 WhatsApp Web 协议。
 *
 * Supported behavior:
 *  - useMultiFileAuthState 持久化登录态（多文件 auth state，存在 authDir 下）
 *  - makeWASocket 建立 WebSocket 长连接到 Meta
 *  - 监听 connection.update：将 status / QR 串通过 onConnectionUpdate 推到上层
 *  - QR 串经 qrcode 库 render 成 PNG data URL，前端可直接 <img src=> 展示
 *  - disconnect 优雅关闭、isConnected 反映真实状态
 *  - 自动重连：被 Meta 主动断开（非 logged out）时延迟 3s 重连
 *
 * 风险：Baileys 是逆向 WhatsApp Web 协议的社区方案，封号率随 Meta 风控收紧上升。
 * 商用场景应使用官方 Cloud API。
 */
import { createRejectCooldown } from './reject-cooldown.js';
import { mkdir, chmod } from 'node:fs/promises';
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
} from 'baileys';
import type { Boom } from '@hapi/boom';
import { ProxyAgent } from 'proxy-agent';
import { readFile } from 'node:fs/promises';
import { logger } from './logger.js';
import { storeChatMetadata, storeMessageDirect, updateChatName } from './db.js';
import { notifyNewImMessage } from './message-notifier.js';
import { markdownToPlainText, splitTextChunks } from './im-utils.js';
import { saveDownloadedFile, FileTooLargeError } from './im-downloader.js';
import { ProcessingLock, isStale } from './im-safety/index.js';
import {
  evaluateChannelAdmission,
  resolveAdmittedChannelRoute,
} from './channel-admission.js';
import { canonicalizeWhatsAppProviderConversationJid } from './whatsapp-jid.js';
import { PhysicalDeliveryTracker } from './im-delivery-progress.js';
import {
  ChannelInboundLifecycle,
  type ChannelInboundLease,
} from './channel-inbound-lifecycle.js';
import {
  WhatsAppProviderAckTracker,
  WHATSAPP_PROVIDER_ACK_TIMEOUT_MS,
} from './whatsapp-provider-ack.js';
export { WHATSAPP_PROVIDER_ACK_TIMEOUT_MS } from './whatsapp-provider-ack.js';
export {
  getWhatsAppAuthDir,
  migrateLegacyWhatsAppAuthDir,
} from './whatsapp-auth.js';

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
  isChatAuthorized?: (jid: string) => boolean;
  onPairAttempt?: (
    jid: string,
    chatName: string,
    code: string,
  ) => Promise<boolean>;
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
  onMessagePersisted?: import('./channel-contracts.js').OnChannelMessagePersisted;
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
  normalizeIncomingJid?: (jid: string) => string | null;
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
  sendFile(chatId: string, filePath: string, fileName: string): Promise<void>;
  sendTyping(chatId: string, isTyping: boolean): Promise<void>;
  isConnected(): boolean;
  /** Current connection state snapshot (latest seen) */
  getState(): WhatsAppConnectionState;
}

export function assertWhatsAppSocketConnected(
  socket: WASocket | null,
  state: WhatsAppConnectionState,
): asserts socket is WASocket {
  if (!socket || state.status !== 'connected') {
    throw new Error('WhatsApp socket is not connected');
  }
}

const RECONNECT_BASE_DELAY_MS = 3_000;
const RECONNECT_MAX_DELAY_MS = 60_000;
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

type ClosableWhatsAppSocket = Pick<WASocket, 'end'> & {
  ws?: {
    isConnecting?: boolean;
    close?: () => Promise<void> | void;
    on?: (event: string, listener: (error: Error) => void) => void;
  };
};

/**
 * Baileys 6.17.x declares `sock.end()` as synchronous, but its WebSocket
 * client implements `close()` as an async method. While the websocket is
 * still CONNECTING, `ws.close()` rejects and `sock.end()` does not observe
 * that promise, which becomes an unhandled rejection and can terminate the
 * whole HappyClaw process.
 *
 * OpenClaw treats socket shutdown as best-effort and contains every failure.
 * We keep that contract while explicitly awaiting the CONNECTING close path
 * required by the Baileys version used here.
 */
export async function closeWhatsAppSocketSafely(
  socket: ClosableWhatsAppSocket | null | undefined,
  reason = 'HappyClaw WhatsApp socket close',
): Promise<void> {
  if (!socket) return;
  if (socket.ws?.isConnecting && typeof socket.ws.close === 'function') {
    try {
      await socket.ws.close();
    } catch (error) {
      logger.debug(
        { error, feature: 'whatsapp' },
        'Ignored WhatsApp CONNECTING socket close failure',
      );
    }
    return;
  }
  try {
    await Promise.resolve(socket.end(new Error(reason)));
  } catch (error) {
    logger.debug(
      { error, feature: 'whatsapp' },
      'Ignored WhatsApp socket shutdown failure',
    );
  }
}

// ─── Factory ────────────────────────────────────────────────────

export function createWhatsAppConnection(
  config: WhatsAppConnectionConfig,
): WhatsAppConnection {
  let sock: WASocket | null = null;
  let currentState: WhatsAppConnectionState = { status: 'disconnected' };
  let opts: WhatsAppConnectOpts | null = null;
  let intentionalDisconnect = false;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let reconnectAttempt = 0;
  let socketGeneration = 0;
  let activeInboundLease: ChannelInboundLease | null = null;
  const inboundLifecycle = new ChannelInboundLifecycle();
  const providerAcks = new WhatsAppProviderAckTracker(
    WHATSAPP_PROVIDER_ACK_TIMEOUT_MS,
  );
  // Cache real group display names (jid → name); fetched lazily per group on
  // first message arrival to avoid blowing up reconnect.
  const groupNameCache = new Map<string, string>();
  // LRU dedup cache: key = `${remoteJid}|${msgId}`, value = insertion timestamp.
  // Baileys can re-emit the same key.id at reconnect boundaries or when
  // history/notify streams overlap; without this cache the Agent responds twice.
  const msgCache = new Map<string, number>();
  const processingLock = new ProcessingLock();
  const rejectCooldown = createRejectCooldown(60_000);
  const hasAmbientProxy = [
    'https_proxy',
    'HTTPS_PROXY',
    'http_proxy',
    'HTTP_PROXY',
    'all_proxy',
    'ALL_PROXY',
  ].some((name) => !!process.env[name]);
  const ambientProxyAgent = hasAmbientProxy ? new ProxyAgent() : undefined;
  let saveCredsQueue: Promise<void> = Promise.resolve();

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
          const rawJid = `${CHANNEL_PREFIX}${remoteJid}`;
          const normalizedJid = opts?.normalizeIncomingJid
            ? opts.normalizeIncomingJid(rawJid)
            : rawJid;
          if (normalizedJid) updateChatName(normalizedJid, subject);
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
    const generation = ++socketGeneration;
    const lease = inboundLifecycle.begin();
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

    const nextSock = makeWASocket({
      // Skip version when unavailable so Baileys uses its bundled default
      ...(version ? { version } : {}),
      auth: state,
      printQRInTerminal: false,
      // 用 pino 兼容的 logger（baileys 期望 pino 接口）
      logger: logger.child({ feature: 'whatsapp-baileys' }) as never,
      browser: ['HappyClaw', 'Desktop', '1.0.0'],
      markOnlineOnConnect: false,
      // proxy-agent follows HTTP(S)_PROXY / ALL_PROXY and NO_PROXY. This is
      // the WebSocket transport path; Baileys' media fetch dispatcher is a
      // different (undici) type and intentionally remains untouched here.
      ...(ambientProxyAgent ? { agent: ambientProxyAgent } : {}),
    });
    if (
      generation !== socketGeneration ||
      intentionalDisconnect ||
      !inboundLifecycle.isCurrent(lease)
    ) {
      await closeWhatsAppSocketSafely(
        nextSock,
        'WhatsApp socket superseded during startup',
      );
      return;
    }
    sock = nextSock;
    activeInboundLease = lease;
    providerAcks.activate(lease.generation);

    // OpenClaw also observes the WebSocket error surface directly. Baileys
    // normally translates these to connection.update, but keeping an explicit
    // listener prevents a transport error from becoming process-fatal when a
    // socket is being replaced at exactly the same time.
    nextSock.ws?.on?.('error', (error: Error) => {
      logger.warn({ error, feature: 'whatsapp' }, 'WhatsApp WebSocket error');
    });
    // Baileys rc13 resolves sendMessage after socket write. The successful
    // Meta message-class stanza ACK is exposed on this locked transport event.
    nextSock.ws?.on?.('CB:ack,class:message', (node: any) => {
      if (!inboundLifecycle.isCurrent(lease)) return;
      providerAcks.recordServerAck(
        lease.generation,
        node?.attrs?.id,
        node?.attrs?.error ? String(node.attrs.error) : undefined,
      );
    });

    setState({ status: 'connecting' });

    // Serialize credential writes. Baileys can emit overlapping updates while
    // pairing; parallel multi-file writes are a common source of corrupt auth
    // state after a process crash or reconnect boundary.
    nextSock.ev.on('creds.update', () => {
      saveCredsQueue = saveCredsQueue
        .then(() => saveCreds())
        .catch((error) => {
          logger.error(
            { error, authDir: config.authDir },
            'WhatsApp credential persistence failed',
          );
        });
    });

    nextSock.ev.on('connection.update', (update) => {
      void handleConnectionUpdate(update).catch((error) => {
        logger.error(
          { error, feature: 'whatsapp' },
          'WhatsApp connection.update handler failed',
        );
      });
    });

    async function handleConnectionUpdate(
      update: Parameters<
        Parameters<typeof nextSock.ev.on<'connection.update'>>[1]
      >[0],
    ): Promise<void> {
      if (
        generation !== socketGeneration ||
        sock !== nextSock ||
        !inboundLifecycle.isCurrent(lease)
      )
        return;
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        try {
          const qrDataUrl = await qrcode.toDataURL(qr, {
            errorCorrectionLevel: 'M',
            margin: 2,
            scale: 6,
          });
          if (generation !== socketGeneration || sock !== nextSock) return;
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
        reconnectAttempt = 0;
        const meJid = nextSock.user?.id;
        const meName = nextSock.user?.name ?? undefined;
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
        inboundLifecycle.invalidate();
        if (activeInboundLease === lease) activeInboundLease = null;
        providerAcks.deactivate(
          lease.generation,
          'WhatsApp connection closed before provider ACK',
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
        if (sock === nextSock) sock = null;

        if (!intentionalDisconnect) {
          const delayMs = Math.min(
            RECONNECT_BASE_DELAY_MS * 2 ** reconnectAttempt,
            RECONNECT_MAX_DELAY_MS,
          );
          reconnectAttempt += 1;
          logger.info(
            { feature: 'whatsapp', delayMs, reconnectAttempt },
            'Scheduling WhatsApp reconnect',
          );
          reconnectTimer = setTimeout(() => {
            if (generation !== socketGeneration || intentionalDisconnect)
              return;
            startSocket().catch((err) =>
              logger.error({ err }, 'WhatsApp reconnect failed'),
            );
          }, delayMs);
        }
      }
    }

    nextSock.ev.on('messages.update', (updates) => {
      if (!inboundLifecycle.isCurrent(lease)) return;
      providerAcks.observeMessageUpdates(lease.generation, updates);
    });

    nextSock.ev.on('messages.upsert', ({ messages, type }) => {
      if (
        generation !== socketGeneration ||
        sock !== nextSock ||
        !inboundLifecycle.isCurrent(lease)
      )
        return;
      // 'notify' = real-time incoming, 'append' = history sync (skip)
      if (type !== 'notify') return;
      const task = (async (): Promise<void> => {
        for (const msg of messages) {
          const remoteJid = msg.key?.remoteJid;
          const logicalJid = remoteJid
            ? canonicalizeWhatsAppProviderConversationJid(remoteJid)
            : '';
          const messageKey = msg.key?.id
            ? `${logicalJid}|${msg.key.id}`
            : undefined;
          try {
            await inboundLifecycle.runMessage(
              lease,
              messageKey,
              isDuplicate,
              markSeen,
              () => handleIncomingMessage(msg, lease, nextSock),
            );
          } catch (err) {
            if (inboundLifecycle.isCancellation(err, lease)) {
              logger.debug(
                { msgId: msg.key?.id },
                'WhatsApp inbound callback cancelled',
              );
            } else {
              logger.error(
                { err, msgId: msg.key?.id },
                'WhatsApp message handler threw',
              );
            }
          }
        }
      })();
      return inboundLifecycle.track(task);
    });

    // Group membership events: bot added/removed from groups
    nextSock.ev.on('group-participants.update', async (update) => {
      if (
        generation !== socketGeneration ||
        sock !== nextSock ||
        !inboundLifecycle.isCurrent(lease)
      )
        return;
      try {
        const involvesSelf = update.participants.some((participant) =>
          isWhatsAppSelfParticipant(participant, sock?.user),
        );
        if (!involvesSelf) return;

        const rawJid = `${CHANNEL_PREFIX}${update.id}`;
        const chatJid = opts?.normalizeIncomingJid
          ? opts.normalizeIncomingJid(rawJid)
          : rawJid;
        if (!chatJid) return;
        if (update.action === 'add') {
          let chatName = update.id;
          try {
            const meta = await sock?.groupMetadata(update.id);
            if (meta?.subject) {
              chatName = meta.subject;
              groupNameCache.set(update.id, meta.subject);
            }
          } catch (err) {
            logger.debug(
              { err, jid: update.id },
              'group meta fetch failed on add',
            );
          }
          // Account-backed WhatsApp groups must pair explicitly. Merely adding
          // the bot must not silently create/authorize a HappyClaw chat.
          if (!opts?.isChatAuthorized || opts.isChatAuthorized(chatJid)) {
            opts?.onBotAddedToGroup?.(chatJid, chatName);
          } else {
            logger.info(
              { chatJid, chatName },
              'WhatsApp bot added to unpaired group; awaiting /pair',
            );
          }
          logger.info({ chatJid, chatName }, 'WhatsApp bot added to group');
        } else if (update.action === 'remove') {
          opts?.onBotRemovedFromGroup?.(chatJid);
          groupNameCache.delete(update.id);
          logger.info({ chatJid }, 'WhatsApp bot removed from group');
        }
      } catch (err) {
        logger.warn(
          { err },
          'WhatsApp group-participants.update handler threw',
        );
      }
    });
  }

  /**
   * Detect and download a media message (image/video/audio/document/sticker).
   * Returns null if `content` has no supported media node.
   * Returns { content, attachmentsJson } shaped like dingtalk's normalize result.
   */
  async function tryHandleMediaMessage(
    msg: WAMessage,
    content: proto.IMessage,
    groupFolder: string | undefined,
    lease: ChannelInboundLease,
    activeSock: WASocket,
  ): Promise<{ content: string; attachmentsJson?: string } | null> {
    inboundLifecycle.assertCurrent(lease);
    const detected = detectMedia(content);
    if (!detected) return null;
    const { kind, label, node, defaultExt } = detected;

    // Baileys unwraps its known FutureProofMessage variants internally, but
    // rc13 does not yet recognize proto-74 lottieStickerMessage. Keep the
    // provider key/envelope metadata while giving the downloader the same
    // normalized content used by detection. This also remains valid for the
    // wrappers Baileys already understands and lets media re-upload use the
    // exact inner media key.
    const downloadEnvelope: WAMessage =
      msg.message === content ? msg : { ...msg, message: content };

    let buffer: Buffer;
    try {
      buffer = await downloadMediaMessage(
        downloadEnvelope,
        'buffer',
        { options: { signal: lease.signal } },
        {
          logger: logger.child({ feature: 'whatsapp-media' }) as never,
          reuploadRequest: activeSock.updateMediaMessage as never,
        },
      );
      inboundLifecycle.assertCurrent(lease);
    } catch (err) {
      inboundLifecycle.assertCurrent(lease);
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
      inboundLifecycle.assertCurrent(lease);
      savedPath = await saveDownloadedFile(
        groupFolder,
        'whatsapp',
        fileName,
        buffer,
      );
      inboundLifecycle.assertCurrent(lease);
    } catch (err) {
      inboundLifecycle.assertCurrent(lease);
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
  async function handleIncomingMessage(
    msg: WAMessage,
    lease: ChannelInboundLease,
    activeSock: WASocket,
  ): Promise<void> {
    inboundLifecycle.assertCurrent(lease);
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

    // Baileys normally normalizes legacy PN JIDs before `messages.upsert`, but
    // placeholder-resend and other synthetic notify paths can retain raw
    // `user:device@c.us`. Keep `remoteJid` untouched for provider acks/replies,
    // while every HappyClaw identity uses one stable canonical conversation.
    const logicalRemoteJid =
      canonicalizeWhatsAppProviderConversationJid(remoteJid);

    // Global stale-message drop (>30min). Independent of reconnect filter
    // below; handles edge cases like webhook retries delivering an hour late.
    const tsMs = normalizeTimestamp(messageTimestamp);
    if (isStale(tsMs)) {
      logger.debug(
        { msgId: key.id, remoteJid, tsMs },
        'Stale WhatsApp message (>30min), dropping',
      );
      return;
    }

    const processingKey = key.id ? `${logicalRemoteJid}|${key.id}` : '';
    if (processingKey && !processingLock.acquire(processingKey)) return;
    try {
      // Filter old messages (heat-up after reconnect, history sync stragglers)
      if (
        tsMs > 0 &&
        opts.ignoreMessagesBefore &&
        tsMs < opts.ignoreMessagesBefore
      ) {
        return;
      }

      // Unwrap ephemeral / view-once envelopes once so text, media, and mention
      // detection all see the real inner message (they otherwise diverge).
      const inner = unwrapMessageContent(content);
      let text = extractMessageText(inner);
      const rawChatJid = `${CHANNEL_PREFIX}${logicalRemoteJid}`;
      const chatJid = opts.normalizeIncomingJid
        ? opts.normalizeIncomingJid(rawChatJid)
        : rawChatJid;
      if (!chatJid) {
        logger.warn(
          { remoteJid, msgId: key.id },
          'WhatsApp inbound identity rejected before admission',
        );
        return;
      }
      const isGroup = remoteJid.endsWith('@g.us');
      const senderRaw = isGroup ? key.participant || remoteJid : remoteJid;
      const senderImId = jidNormalizedUser(senderRaw);
      const senderId = `${CHANNEL_PREFIX}${senderImId || senderRaw}`;
      const senderName = pushName || (isGroup ? '群成员' : remoteJid);
      const chatName =
        groupNameCache.get(remoteJid) || (isGroup ? remoteJid : senderName);
      const timestampISO = new Date(tsMs > 0 ? tsMs : Date.now()).toISOString();

      // Pairing/authorization is the first stateful gate. Unpaired traffic must
      // not create a chat, write metadata, resolve a workspace, or download
      // media. Pairing itself registers the chat against the account's default
      // workspace through buildOnPairAttempt.
      const admission = await evaluateChannelAdmission({
        jid: chatJid,
        chatName,
        text: text ?? '',
        isChatAuthorized: opts.isChatAuthorized,
        onPairAttempt: opts.onPairAttempt,
      });
      inboundLifecycle.assertCurrent(lease);
      if (admission.kind === 'paired') {
        await activeSock.sendMessage(remoteJid, {
          text: '配对成功！此聊天已连接到你的工作区。',
        });
        return;
      }
      if (admission.kind === 'pair_rejected') {
        await activeSock.sendMessage(remoteJid, {
          text: '配对码无效或已过期，请在 Web 设置页重新生成。',
        });
        return;
      }
      if (admission.kind === 'deny') {
        if (rejectCooldown.shouldNotify(chatJid)) {
          await activeSock.sendMessage(remoteJid, {
            text: '此聊天尚未配对。请在 Web 设置页生成配对码，然后发送 /pair <code>。',
          });
        }
        logger.debug({ chatJid }, 'WhatsApp chat not authorized');
        return;
      }

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

        const isBotMentioned = isMentioningBot(inner, activeSock.user);
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
        if (isBotMentioned && text) {
          text = stripLeadingWhatsAppBotMention(text, inner, activeSock.user);
        }
      }

      // Control commands may repair/change a binding. Consume them before
      // route validation; media must not be downloaded for a stale route.
      const commandText = text?.trim() ?? '';
      const slashMatch = commandText.match(/^\/(\S+)(?:\s+(.*))?$/s);
      if (slashMatch && opts.onCommand) {
        const cmdBody = (
          slashMatch[1] + (slashMatch[2] ? ' ' + slashMatch[2] : '')
        ).trim();
        try {
          const reply = await opts.onCommand(chatJid, cmdBody, senderImId);
          if (reply !== null && reply !== undefined) {
            if (sock) {
              try {
                await sock.sendMessage(remoteJid, { text: reply });
              } catch (err) {
                logger.warn(
                  { err, chatJid },
                  'WhatsApp slash reply send failed',
                );
              }
            }
            return;
          }
        } catch (err) {
          logger.error(
            { err, chatJid, cmd: slashMatch[1] },
            'WhatsApp slash command failed',
          );
        }
      }

      const resolvedRoute = resolveAdmittedChannelRoute(
        chatJid,
        opts.resolveEffectiveChatJid,
      );
      if (!resolvedRoute) {
        logger.warn(
          { chatJid },
          'WhatsApp message dropped: binding resolver rejected route',
        );
        return;
      }
      const { targetJid, routing } = resolvedRoute;

      // Handle media (image/video/audio/document) whenever the message carries
      // it — NOT only when there's no text. A captioned image/video has non-empty
      // `text` (extractMessageText reads the caption), so gating on `!finalContent`
      // would skip the download entirely (media lost + no Vision inlining).
      // tryHandleMediaMessage already folds the caption into its returned content.
      // tryHandleMediaMessage returns null only when `inner` carries no supported
      // media (its first step is detectMedia), so calling it unconditionally folds
      // the media probe + download into one pass — no second detectMedia, no
      // duplicated "neither text nor media" branch.
      let finalContent = text;
      let attachmentsJson: string | undefined;
      const media = await tryHandleMediaMessage(
        msg,
        inner,
        opts.resolveGroupFolder?.(chatJid),
        lease,
        activeSock,
      );
      inboundLifecycle.assertCurrent(lease);
      if (media) {
        finalContent = media.content;
        attachmentsJson = media.attachmentsJson;
      }
      if (!finalContent) {
        logger.debug(
          { remoteJid, msgId: key.id, types: Object.keys(inner) },
          'WhatsApp message has neither text nor supported media',
        );
        return;
      }

      inboundLifecycle.assertCurrent(lease);
      storeChatMetadata(chatJid, timestampISO);
      updateChatName(chatJid, chatName);
      opts.onNewChat(chatJid, chatName);
      if (isGroup && !groupNameCache.has(remoteJid)) {
        groupNameCache.set(remoteJid, remoteJid);
        void resolveGroupName(remoteJid);
      }

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

      opts.onMessagePersisted?.(
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
    } finally {
      if (processingKey) processingLock.release(processingKey);
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
      socketGeneration += 1;
      const lease = activeInboundLease;
      activeInboundLease = null;
      inboundLifecycle.invalidate();
      if (lease) {
        providerAcks.deactivate(
          lease.generation,
          'WhatsApp disconnected before provider ACK',
        );
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const currentSock = sock;
      await closeWhatsAppSocketSafely(currentSock);
      await inboundLifecycle.settle();
      if (sock === currentSock) sock = null;
      await saveCredsQueue;
      ambientProxyAgent?.destroy();
      processingLock.dispose();
      setState({ status: 'disconnected' });
    },

    async logout(): Promise<void> {
      intentionalDisconnect = true;
      socketGeneration += 1;
      const lease = activeInboundLease;
      activeInboundLease = null;
      inboundLifecycle.invalidate();
      if (lease) {
        providerAcks.deactivate(
          lease.generation,
          'WhatsApp logged out before provider ACK',
        );
      }
      const currentSock = sock;
      if (currentSock) {
        try {
          await currentSock.logout();
        } catch (err) {
          logger.warn({ err }, 'WhatsApp logout threw');
        }
        await closeWhatsAppSocketSafely(currentSock);
      }
      await inboundLifecycle.settle();
      if (sock === currentSock) sock = null;
      await saveCredsQueue;
      ambientProxyAgent?.destroy();
      // Note: auth files on disk remain; caller (im-manager) wipes authDir if needed
      setState({ status: 'logged_out' });
    },

    async sendMessage(
      chatId: string,
      text: string,
      localImagePaths?: string[],
    ): Promise<void> {
      assertWhatsAppSocketConnected(sock, currentState);
      const activeSock = sock;
      const lease = activeInboundLease;
      if (!lease) throw new Error('WhatsApp socket is not connected');
      const jid = stripChannelPrefix(chatId);

      // Strip markdown to WhatsApp plain text (matches dingtalk/wechat/qq pattern).
      // WhatsApp DOES support its own markdown subset (*bold*/_italic_/~strike~)
      // but Claude output uses standard markdown — converting in-place is fragile,
      // so we pick the safe option: drop formatting, send plain text.
      const plain = markdownToPlainText(text);
      const chunks = splitTextChunks(plain, TEXT_CHUNK_LIMIT);
      const tracker = new PhysicalDeliveryTracker(
        chunks.length + (localImagePaths?.length ?? 0),
      );

      try {
        for (let i = 0; i < chunks.length; i++) {
          const chunk =
            chunks.length > 1
              ? `${chunks[i]}\n\n(${i + 1}/${chunks.length})`
              : chunks[i];
          await tracker.send(() =>
            providerAcks.send(activeSock, lease.generation, jid, {
              text: chunk,
            }),
          );
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
              await tracker.send(async () => {
                const buf = await readFile(imgPath);
                const mime = guessMimeType(imgPath) || 'image/jpeg';
                await providerAcks.send(activeSock, lease.generation, jid, {
                  image: buf,
                  mimetype: mime,
                });
              });
            } catch (err) {
              logger.error(
                { err, imgPath, chatId },
                'WhatsApp local image attach failed',
              );
              throw err;
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
      assertWhatsAppSocketConnected(sock, currentState);
      const activeSock = sock;
      const lease = activeInboundLease;
      if (!lease) throw new Error('WhatsApp socket is not connected');
      const jid = stripChannelPrefix(chatId);
      try {
        await providerAcks.send(activeSock, lease.generation, jid, {
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
      assertWhatsAppSocketConnected(sock, currentState);
      const activeSock = sock;
      const lease = activeInboundLease;
      if (!lease) throw new Error('WhatsApp socket is not connected');
      const jid = stripChannelPrefix(chatId);
      try {
        const buf = await readFile(filePath);
        await providerAcks.send(
          activeSock,
          lease.generation,
          jid,
          buildWhatsAppSendFileContent(buf, fileName),
        );
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

/**
 * Strip ephemeral / view-once / future-proof envelopes so the real inner
 * message is exposed.
 * extractMessageText recurses through these on its own, but detectMedia and
 * isMentioningBot only inspect top-level nodes — so a disappearing-message photo
 * (`ephemeralMessage.message.imageMessage`, increasingly the Meta default) would
 * never be downloaded and @mentions inside a wrapper would be missed. Unwrap once
 * up front and feed the inner content to all of them. Bounded to avoid a
 * pathological/cyclic payload spinning forever.
 */
export function unwrapMessageContent(content: proto.IMessage): proto.IMessage {
  let inner = content;
  for (let i = 0; i < 5; i++) {
    // Mirror baileys' getFutureProofMessage (Utils/messages.js): a captioned
    // document arrives as documentWithCaptionMessage; edits/view-once-extension
    // wrap too. Missing any of these drops the message — e.g. a PDF WITH a
    // caption (documentWithCaptionMessage) would extract no text and detect no
    // media, while the same PDF without a caption (bare documentMessage) works.
    const next =
      inner.ephemeralMessage?.message ||
      inner.viewOnceMessage?.message ||
      inner.viewOnceMessageV2?.message ||
      inner.viewOnceMessageV2Extension?.message ||
      inner.documentWithCaptionMessage?.message ||
      inner.editedMessage?.message ||
      inner.lottieStickerMessage?.message;
    if (!next) break;
    inner = next;
  }
  return inner;
}

/**
 * Extract human-readable text from a baileys IMessage payload.
 * Returns null only when there is no supported human-readable payload.
 */
export function extractMessageText(content: proto.IMessage): string | null {
  if (content.conversation) return content.conversation;
  if (content.extendedTextMessage?.text)
    return content.extendedTextMessage.text;
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
  if (content.ptvMessage?.caption) return content.ptvMessage.caption;
  if (content.documentMessage?.caption) return content.documentMessage.caption;
  if (content.eventMessage) {
    const name = boundedWhatsAppText(content.eventMessage.name);
    return name ? `[活动: ${name}]` : '[活动]';
  }
  if (content.groupInviteMessage) {
    const name =
      boundedWhatsAppText(content.groupInviteMessage.groupName) ||
      boundedWhatsAppText(content.groupInviteMessage.caption);
    return name ? `[群邀请: ${name}]` : '[群邀请]';
  }
  if (content.locationMessage) {
    return formatWhatsAppLocation(content.locationMessage);
  }
  if (content.liveLocationMessage) {
    return formatWhatsAppLocation(content.liveLocationMessage);
  }
  if (content.contactMessage) {
    return formatWhatsAppContact(content.contactMessage);
  }
  if (content.contactsArrayMessage) {
    const contacts = content.contactsArrayMessage.contacts ?? [];
    return formatWhatsAppContacts(contacts);
  }
  return null;
}

function boundedWhatsAppText(value: string | null | undefined): string {
  return (value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 512);
}

export function formatWhatsAppLocation(loc: {
  degreesLatitude?: number | null;
  degreesLongitude?: number | null;
  name?: string | null;
  address?: string | null;
}): string {
  const name = boundedWhatsAppText(loc.name);
  const address = boundedWhatsAppText(loc.address);
  const lat = loc.degreesLatitude;
  const lon = loc.degreesLongitude;
  const coords =
    Number.isFinite(lat) && Number.isFinite(lon) ? `${lat}, ${lon}` : '';
  const details: string[] = [];
  if (name) details.push(name);
  if (address && address !== name) details.push(`地址: ${address}`);
  if (coords) details.push(`坐标: ${coords}`);
  if (details.length > 0) return `[位置: ${details.join(' | ')}]`;
  return '[位置]';
}

interface ParsedWhatsAppVCard {
  name?: string;
  phones: string[];
  emails: string[];
  organizations: string[];
}

function decodeVCardValue(value: string): string {
  return boundedWhatsAppText(
    value.replace(/\\n/gi, ' ').replace(/\\([,;\\])/g, '$1'),
  );
}

function pushUniqueBounded(values: string[], value: string): void {
  if (value && values.length < 5 && !values.includes(value)) values.push(value);
}

/** Parse only the human-facing, non-executable vCard fields we persist. */
export function parseWhatsAppVCard(
  vcard: string | null | undefined,
): ParsedWhatsAppVCard {
  const parsed: ParsedWhatsAppVCard = {
    phones: [],
    emails: [],
    organizations: [],
  };
  if (!vcard) return parsed;

  // RFC 6350 folded lines begin with SP/HTAB. Bound input before parsing so a
  // hostile contact card cannot grow a durable message without limit.
  const unfolded = vcard.slice(0, 32 * 1024).replace(/\r?\n[ \t]/g, '');
  let structuredName: string | undefined;
  for (const line of unfolded.split(/\r?\n/)) {
    const separator = line.indexOf(':');
    if (separator <= 0) continue;
    const rawKey = line.slice(0, separator).split(';', 1)[0] ?? '';
    const key = (rawKey.split('.').pop() ?? '').toUpperCase();
    const rawValue = line.slice(separator + 1);
    if (key === 'FN') {
      parsed.name ||= decodeVCardValue(rawValue);
    } else if (key === 'N') {
      const fields = rawValue.split(';').map(decodeVCardValue);
      structuredName ||= [fields[3], fields[1], fields[2], fields[0], fields[4]]
        .filter(Boolean)
        .join(' ');
    } else if (key === 'TEL') {
      pushUniqueBounded(
        parsed.phones,
        decodeVCardValue(rawValue).replace(/^tel:/i, ''),
      );
    } else if (key === 'EMAIL') {
      pushUniqueBounded(
        parsed.emails,
        decodeVCardValue(rawValue).replace(/^mailto:/i, ''),
      );
    } else if (key === 'ORG') {
      pushUniqueBounded(
        parsed.organizations,
        rawValue.split(';').map(decodeVCardValue).filter(Boolean).join(' / '),
      );
    }
  }
  parsed.name ||= structuredName;
  return parsed;
}

export function formatWhatsAppContact(contact: {
  displayName?: string | null;
  vcard?: string | null;
}): string {
  const vcard = parseWhatsAppVCard(contact.vcard);
  const name = boundedWhatsAppText(contact.displayName) || vcard.name;
  const lines = [name ? `[联系人: ${name}]` : '[联系人]'];
  if (vcard.phones.length > 0) lines.push(`电话: ${vcard.phones.join(', ')}`);
  if (vcard.emails.length > 0) lines.push(`邮箱: ${vcard.emails.join(', ')}`);
  if (vcard.organizations.length > 0) {
    lines.push(`组织: ${vcard.organizations.join(', ')}`);
  }
  return lines.join('\n').slice(0, 4096);
}

export const WHATSAPP_MAX_CONTACTS_PER_MESSAGE = 20;
export const WHATSAPP_MAX_CONTACT_TEXT_LENGTH = 8192;

export function formatWhatsAppContacts(
  contacts: Array<{ displayName?: string | null; vcard?: string | null }>,
): string {
  if (contacts.length === 0) return '[联系人]';
  const rendered: string[] = [];
  const scanCount = Math.min(
    contacts.length,
    WHATSAPP_MAX_CONTACTS_PER_MESSAGE,
  );
  // Reserve enough room for the omission marker so the bound never truncates
  // into a phone number or email address.
  const markerReserve = 96;
  let length = 0;
  for (let index = 0; index < scanCount; index++) {
    const entry = formatWhatsAppContact(contacts[index]!);
    const separatorLength = rendered.length > 0 ? 1 : 0;
    if (
      length + separatorLength + entry.length >
      WHATSAPP_MAX_CONTACT_TEXT_LENGTH - markerReserve
    ) {
      break;
    }
    rendered.push(entry);
    length += separatorLength + entry.length;
  }

  const omitted = contacts.length - rendered.length;
  if (omitted > 0) rendered.push(`[另有 ${omitted} 个联系人未显示]`);
  return rendered.join('\n').slice(0, WHATSAPP_MAX_CONTACT_TEXT_LENGTH);
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
  kind: 'image' | 'video' | 'audio' | 'document' | 'sticker';
  label: string;
  defaultExt: string;
  node: {
    mimetype?: string | null;
    caption?: string | null;
    fileName?: string | null;
  };
}

export function detectMedia(content: proto.IMessage): DetectedMedia | null {
  if (content.imageMessage) {
    return {
      kind: 'image',
      label: '图片',
      defaultExt: '.jpg',
      node: content.imageMessage as DetectedMedia['node'],
    };
  }
  const video = content.videoMessage ?? content.ptvMessage;
  if (video) {
    return {
      kind: 'video',
      label: '视频',
      defaultExt: '.mp4',
      node: video as DetectedMedia['node'],
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
  if (content.stickerMessage) {
    return {
      kind: 'sticker',
      label: '贴纸',
      defaultExt: '.webp',
      node: content.stickerMessage as DetectedMedia['node'],
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
 * Baileys `sock.user` after the LID migration may expose both a phone-number
 * JID (`id`) and a LID (`lid`). Group mentions and participant rows can use
 * either form, plus hosted aliases (`@hosted` / `@hosted.lid`).
 */
export interface WhatsAppSelfIdentity {
  id?: string | null;
  lid?: string | null;
}

export type WhatsAppSelfRef = string | WhatsAppSelfIdentity | null | undefined;

/**
 * Collapse hosted aliases onto the corresponding PN/LID identity.
 * Do not equate LID with PN: those user numbers are different ID spaces.
 */
export function canonicalizeWhatsAppUserJid(jid: string): string {
  const norm = jidNormalizedUser(jid);
  if (!norm) return '';
  if (norm.endsWith('@hosted.lid')) {
    return `${norm.slice(0, -'@hosted.lid'.length)}@lid`;
  }
  if (norm.endsWith('@hosted')) {
    return `${norm.slice(0, -'@hosted'.length)}@s.whatsapp.net`;
  }
  return norm;
}

export function collectWhatsAppSelfJids(self: WhatsAppSelfRef): string[] {
  const raws: Array<string | null | undefined> =
    self && typeof self === 'object' ? [self.id, self.lid] : [self];
  const identities = new Set<string>();
  for (const raw of raws) {
    if (!raw) continue;
    const key = canonicalizeWhatsAppUserJid(raw);
    if (key) identities.add(key);
  }
  return [...identities];
}

/** Membership events expose LID on `id` and PN on `phoneNumber` independently. */
export function isWhatsAppSelfParticipant(
  participant: { id?: string | null; phoneNumber?: string | null },
  self: WhatsAppSelfRef,
): boolean {
  const identities = new Set(collectWhatsAppSelfJids(self));
  if (identities.size === 0) return false;
  for (const raw of [participant.id, participant.phoneNumber]) {
    if (!raw) continue;
    const key = canonicalizeWhatsAppUserJid(raw);
    if (key && identities.has(key)) return true;
  }
  return false;
}

/**
 * Check if a baileys message @mentions the bot itself.
 *
 * Mentioning lives in `extendedTextMessage.contextInfo.mentionedJid` (string[]).
 * Self jid format from sock.user.id includes a device suffix
 * (e.g. `15551234567:42@s.whatsapp.net`). Compare every known self identity
 * after normalizing device suffixes and hosted aliases.
 */
export function isMentioningBot(
  content: proto.IMessage,
  self: WhatsAppSelfRef,
): boolean {
  // Fail closed: 当 self 暂时不可用（reconnect 间隙、auth 状态未就绪），
  // 从前的 fail-open 让 require_mention 模式短暂被绕过——攻击者可在 socket
  // 启动毫秒级窗口中把所有群消息都被处理。一致性优先：没法确认时按"未被
  // mention"处理，主消息处理流会丢弃。和 feishu 实现的语义对齐。
  const identities = new Set(collectWhatsAppSelfJids(self));
  if (identities.size === 0) return false;
  const ctx =
    content.extendedTextMessage?.contextInfo ||
    content.imageMessage?.contextInfo ||
    content.videoMessage?.contextInfo ||
    content.ptvMessage?.contextInfo ||
    content.documentMessage?.contextInfo ||
    content.audioMessage?.contextInfo ||
    content.stickerMessage?.contextInfo ||
    content.eventMessage?.contextInfo ||
    content.groupInviteMessage?.contextInfo;
  const mentioned = ctx?.mentionedJid;
  if (!mentioned || mentioned.length === 0) return false;
  return mentioned.some((m) => identities.has(canonicalizeWhatsAppUserJid(m)));
}

/** Remove a leading WhatsApp display token only when trusted message metadata
 * says the same account was mentioned. Mention-only messages retain their
 * original text instead of becoming an empty durable message. */
export function stripLeadingWhatsAppBotMention(
  text: string,
  content: proto.IMessage,
  self: WhatsAppSelfRef,
): string {
  if (!isMentioningBot(content, self)) return text;
  const subjects = [
    ...new Set(
      collectWhatsAppSelfJids(self)
        .map((jid) => jid.split('@', 1)[0])
        .filter(Boolean),
    ),
  ].sort((left, right) => right.length - left.length);
  const normalized = text.trimStart();
  for (const subject of subjects) {
    const displayToken = `@${subject}`;
    if (!normalized.startsWith(displayToken)) continue;
    const next = normalized.charAt(displayToken.length);
    if (next && !/\s/.test(next)) continue;
    const remainder = normalized.slice(displayToken.length).trimStart();
    return remainder || text;
  }
  return text;
}

/**
 * Tiny mime type lookup based on file extension.
 * Covers WhatsApp-relevant types: image/video/audio/document.
 * Returns null when unknown so caller can fall back to a sensible default.
 */

export type WhatsAppSendFileContent =
  | { video: Buffer; mimetype: string }
  | { audio: Buffer; mimetype: string }
  | { document: Buffer; mimetype: string; fileName: string };

const WHATSAPP_NATIVE_VIDEO_MIME = new Map([['mp4', 'video/mp4']]);
const WHATSAPP_NATIVE_AUDIO_MIME = new Map([
  ['mp3', 'audio/mpeg'],
  ['m4a', 'audio/mp4'],
  ['ogg', 'audio/ogg'],
  ['opus', 'audio/ogg'],
]);

/**
 * Only formats verified against WhatsApp's native media envelopes are routed
 * as video/audio. A browser-playable MOV/WebM/WAV is not necessarily accepted
 * by WhatsApp's upload contract, so every non-allowlisted file stays a document.
 */
export function buildWhatsAppSendFileContent(
  buf: Buffer,
  fileName: string,
): WhatsAppSendFileContent {
  const ext = fileName.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';
  const videoMime = WHATSAPP_NATIVE_VIDEO_MIME.get(ext);
  if (videoMime) return { video: buf, mimetype: videoMime };
  const audioMime = WHATSAPP_NATIVE_AUDIO_MIME.get(ext);
  if (audioMime) return { audio: buf, mimetype: audioMime };
  const mime = guessMimeType(fileName) || 'application/octet-stream';
  return { document: buf, mimetype: mime, fileName };
}

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
  if (ext === 'm4a') return 'audio/mp4';
  if (ext === 'aac') return 'audio/aac';
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
