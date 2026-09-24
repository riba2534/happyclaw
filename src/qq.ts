/**
 * QQ Bot API v2 Connection Factory
 *
 * Implements QQ Bot connection using official API v2 protocol:
 * - OAuth Token management with auto-refresh
 * - WebSocket connection for receiving events
 * - REST API for sending messages
 * - Message deduplication (LRU 1000 / 30min TTL)
 *
 * Reference: https://github.com/sliverp/qqbot (QQ Bot API v2)
 */
import crypto from 'crypto';
import fs from 'node:fs';
import https from 'node:https';
import WebSocket from 'ws';
import {
  getRegisteredGroup,
  storeChatMetadata,
  storeMessageDirect,
  updateChatName,
} from './db.js';
import { notifyNewImMessage } from './message-notifier.js';
import { logger } from './logger.js';
import { saveDownloadedFile } from './im-downloader.js';
import { downloadHttpsBuffer } from './im-media-download.js';
import { detectImageMimeTypeStrict } from './image-detector.js';
import path from 'node:path';
import {
  markdownToPlainText,
  splitTextChunks,
  createDedupCache,
} from './im-utils.js';
import { ProcessingLock, isStale } from './im-safety/index.js';
import {
  isTransientError,
  getReconnectDelay,
  classifyCloseCode,
} from './qq-reconnect.js';
import {
  createPassiveReplyStore,
  type PassiveReplyClaim,
} from './qq-passive-reply.js';
import { resolveAdmittedChannelRoute } from './channel-admission.js';
import { PhysicalDeliveryTracker } from './im-delivery-progress.js';
import {
  isRuntimeControlLike,
  parseRuntimeControl,
} from './follow-up-policy.js';
import type { FollowUpDisposition, FollowUpMode } from './types.js';
import {
  ChannelInboundLifecycle,
  type ChannelInboundLease,
} from './channel-inbound-lifecycle.js';
// ─── Constants ──────────────────────────────────────────────────

const QQ_TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const QQ_API_BASE = 'https://api.sgroup.qq.com';
const TOKEN_REFRESH_BUFFER_MS = 300_000; // refresh 5min before expiry
const MSG_SPLIT_LIMIT = 5000;
const MAX_RECONNECT_ATTEMPTS = 100;
const RATE_LIMIT_DELAY_MS = 60_000;
const QUICK_DISCONNECT_THRESHOLD_MS = 5_000;
const MAX_QUICK_DISCONNECT_COUNT = 3;
// After exhausting MAX_RECONNECT_ATTEMPTS we don't give up; we fall back to a
// long-tail keepalive so a multi-hour outage eventually self-recovers.
const KEEPALIVE_INTERVAL_MS = 5 * 60 * 1000;
// Safety net: if we ever end up disconnected with no reconnect pending,
// the watchdog kicks a fresh attempt instead of leaving the bot dead.
const WATCHDOG_INTERVAL_MS = 60_000;
const QQ_TOKEN_REQUEST_TIMEOUT_MS = 15_000;
const QQ_API_REQUEST_TIMEOUT_MS = 30_000;
const QQ_MAX_JSON_RESPONSE_BYTES = 2 * 1024 * 1024;

/**
 * How long the platform shows the typing state for one notification.
 *
 * The refresh cadence in the channel adapter is derived from this, so the two
 * cannot drift apart.
 */
export const TYPING_NOTIFY_SECONDS = 60;

/**
 * Passive-reply uses the typing indicator refuses to touch.
 *
 * A long turn refreshes the indicator repeatedly, so without a floor it would
 * drain the per-msg_id budget and force the actual answer into an active push.
 */
const TYPING_PASSIVE_RESERVE = 2;

const IMAGE_EXT_MAP: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

// ─── QQ File Upload Types & Constants ──────────────────────────

export class QQApiError extends Error {
  readonly deliveryPhase: 'rejected' | 'uncertain';

  constructor(
    message: string,
    public readonly bizCode?: number,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'QQApiError';
    this.deliveryPhase =
      httpStatus === 400
        ? 'uncertain'
        : httpStatus !== undefined &&
            httpStatus >= 400 &&
            httpStatus < 500 &&
            httpStatus !== 408
          ? 'rejected'
          : 'uncertain';
  }
}

/**
 * QQ has not published a stable business-code contract that distinguishes an
 * expired reply reference from duplicate/already-accepted delivery. Until a
 * code is verified against the production API, every HTTP 400 stays uncertain
 * and must not trigger an active-push replay.
 */
export function isDefinitiveQQPassiveReplyRejection(
  _error: unknown,
): _error is QQApiError {
  return false;
}

export function shouldRetireQQPassiveReplyReference(error: unknown): boolean {
  return isDefinitiveQQPassiveReplyRejection(error);
}

export enum QQMediaFileType {
  IMAGE = 1,
  VIDEO = 2,
  VOICE = 3,
  FILE = 4,
}

interface UploadPrepareHashes {
  md5: string;
  sha1: string;
  md5_10m: string;
}

interface QQUploadPart {
  index: number;
  presigned_url: string;
}

interface QQUploadPrepareResponse {
  upload_id: string;
  block_size: number;
  parts: QQUploadPart[];
  concurrency?: number;
  retry_timeout?: number;
}

interface QQMediaUploadResponse {
  file_uuid: string;
  file_info: string;
  ttl: number;
}

/**
 * Per-media-type upload ceilings for the QQ Open Platform.
 *
 * Mirrors `MEDIA_FILE_TYPE_INFO` in `@tencent-connect/qqbot-nodejs` 1.0.4
 * (`protocol/utils/file-utils.ts`), i.e. what a maintained first-party client
 * enforces. That package's own README quotes lower numbers for image (20MB)
 * and video (30MB); if the platform rejects an upload that passed this check,
 * trust the rejection and lower the entry here.
 *
 * These bound outbound uploads only. Inbound attachments and Web uploads stay
 * under the global `MAX_FILE_SIZE`.
 */
export const QQ_MEDIA_MAX_SIZE: Record<QQMediaFileType, number> = {
  [QQMediaFileType.IMAGE]: 30 * 1024 * 1024,
  [QQMediaFileType.VIDEO]: 100 * 1024 * 1024,
  [QQMediaFileType.VOICE]: 20 * 1024 * 1024,
  [QQMediaFileType.FILE]: 100 * 1024 * 1024,
};

const QQ_MEDIA_TYPE_NAME: Record<QQMediaFileType, string> = {
  [QQMediaFileType.IMAGE]: 'image',
  [QQMediaFileType.VIDEO]: 'video',
  [QQMediaFileType.VOICE]: 'voice',
  [QQMediaFileType.FILE]: 'file',
};

/**
 * Ceiling for the one-shot base64 upload API backing `uploadMedia`.
 *
 * Lower than the image entry above on purpose: that path posts the whole
 * payload in a single request rather than going through chunked upload, and
 * 20MB is the documented limit of the one-shot endpoint itself.
 */
export const QQ_ONESHOT_UPLOAD_MAX_SIZE = 20 * 1024 * 1024;
const MD5_10M_SIZE = 10_002_432;
const PART_UPLOAD_TIMEOUT = 300_000; // 5 min
const PART_UPLOAD_MAX_RETRIES = 2;
const PART_FINISH_MAX_RETRIES = 2;
const PART_FINISH_BASE_DELAY_MS = 1000;
const PART_FINISH_RETRYABLE_CODES = new Set([40093001]);
const PART_FINISH_RETRYABLE_DEFAULT_TIMEOUT_MS = 2 * 60 * 1000;
const PART_FINISH_RETRYABLE_INTERVAL_MS = 1000;
const MAX_PART_FINISH_RETRY_TIMEOUT_MS = 10 * 60 * 1000;
const COMPLETE_UPLOAD_MAX_RETRIES = 2;
const COMPLETE_UPLOAD_BASE_DELAY_MS = 1000;
const DEFAULT_CONCURRENT_PARTS = 1;
const MAX_CONCURRENT_PARTS = 10;

export function getQQMediaFileType(fileName: string): QQMediaFileType {
  const ext = path.extname(fileName).toLowerCase();
  if (['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(ext))
    return QQMediaFileType.IMAGE;
  if (['.mp4', '.mov', '.avi', '.mkv', '.webm'].includes(ext))
    return QQMediaFileType.VIDEO;
  if (['.mp3', '.wav', '.silk', '.ogg'].includes(ext))
    return QQMediaFileType.VOICE;
  return QQMediaFileType.FILE;
}

// ─── Chunked Upload Utilities ──────────────────────────────────

async function computeFileHashes(
  filePath: string,
  fileSize: number,
): Promise<UploadPrepareHashes> {
  return new Promise((resolve, reject) => {
    const md5Hash = crypto.createHash('md5');
    const sha1Hash = crypto.createHash('sha1');
    const md5_10mHash = crypto.createHash('md5');

    let bytesRead = 0;
    const need10m = fileSize > MD5_10M_SIZE;

    const stream = fs.createReadStream(filePath);

    stream.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      md5Hash.update(buf);
      sha1Hash.update(buf);

      if (need10m) {
        const remaining = MD5_10M_SIZE - bytesRead;
        if (remaining > 0) {
          md5_10mHash.update(
            remaining >= buf.length ? buf : buf.subarray(0, remaining),
          );
        }
      }
      bytesRead += buf.length;
    });

    stream.on('end', () => {
      const md5 = md5Hash.digest('hex');
      const sha1 = sha1Hash.digest('hex');
      const md5_10m = need10m ? md5_10mHash.digest('hex') : md5;
      resolve({ md5, sha1, md5_10m });
    });

    stream.on('error', reject);
  });
}

async function readFileChunk(
  filePath: string,
  offset: number,
  length: number,
): Promise<Buffer> {
  const fd = await fs.promises.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await fd.read(buffer, 0, length, offset);
    return bytesRead < length ? buffer.subarray(0, bytesRead) : buffer;
  } finally {
    await fd.close();
  }
}

async function putToPresignedUrl(
  presignedUrl: string,
  data: Buffer,
  partIndex: number,
  totalParts: number,
): Promise<void> {
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= PART_UPLOAD_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), PART_UPLOAD_TIMEOUT);

    try {
      const response = await fetch(presignedUrl, {
        method: 'PUT',
        body: data,
        headers: { 'Content-Length': String(data.length) },
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(
          `COS PUT failed: ${response.status} ${response.statusText} - ${body}`,
        );
      }
      return;
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      if (lastError.name === 'AbortError') {
        lastError = new Error(
          `Part ${partIndex}/${totalParts} upload timeout after ${PART_UPLOAD_TIMEOUT}ms`,
        );
      }
      if (attempt < PART_UPLOAD_MAX_RETRIES) {
        const delay = 1000 * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  throw lastError!;
}

async function runWithConcurrency(
  tasks: Array<() => Promise<void>>,
  maxConcurrent: number,
): Promise<void> {
  for (let i = 0; i < tasks.length; i += maxConcurrent) {
    const batch = tasks.slice(i, i + maxConcurrent);
    await Promise.all(batch.map((task) => task()));
  }
}

// Intents: PUBLIC_MESSAGES (C2C + group @bot)
const INTENTS = 1 << 25;

// WebSocket opcodes
const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RESUME = 6;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

// ─── Types ──────────────────────────────────────────────────────

export interface QQConnectionConfig {
  appId: string;
  appSecret: string;
}

export interface QQConnectOpts {
  onReady?: () => void;
  onNewChat: (jid: string, name: string) => void;
  isChatAuthorized: (jid: string) => boolean;
  ignoreMessagesBefore?: number;
  onPairAttempt?: (
    jid: string,
    chatName: string,
    code: string,
  ) => Promise<boolean>;
  /** 斜杠指令回调。senderImId 是发送者的裸 QQ open_id（不含 `qq:` 前缀），
   *  与飞书/钉钉 onCommand 传裸 ID 的格式一致，用于主进程 owner-only 检查。 */
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
  /**
   * Offer a persisted inbound message to the durable follow-up queue. Returns
   * whether it starts a turn now or waits behind the active one.
   */
  onFollowUpMessage?: (input: {
    targetJid: string;
    sourceJid: string;
    messageId: string;
    senderImId: string;
    requestedMode?: FollowUpMode;
  }) => FollowUpDisposition;
  /** Notify host projections after the durable follow-up queue changes. */
  onFollowUpsChanged?: import('./channel-contracts.js').OnChannelFollowUpsChanged;
  /** `/break` — cancel the pending queue and interrupt the active query. */
  onSessionBreak?: (input: {
    sourceJid: string;
    targetJid?: string;
    senderImId: string;
  }) => Promise<string>;
  normalizeIncomingJid?: (jid: string) => string | null;
}

export interface QQConnection {
  connect(opts: QQConnectOpts): Promise<void>;
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
  isConnected(): boolean;
  /** Send a C2C stream message chunk. Returns { id } on first chunk. */
  sendStreamMessage(
    openid: string,
    params: {
      input_mode: string;
      input_state: number;
      content_type: string;
      content_raw: string;
      msg_seq: number;
      index: number;
      stream_msg_id?: string;
      msg_id?: string;
      event_id?: string;
    },
  ): Promise<{ id?: string }>;
  /** Reserve the shared per-msg_id sequence used by every passive surface. */
  claimPassiveReply(
    chatId: string,
    options?: { reserve?: number },
  ): PassiveReplyClaim | undefined;
  /** Retire a provider-rejected passive reference and expose the evidence. */
  rejectPassiveReply(chatId: string, msgId: string, error: unknown): boolean;
  /**
   * Show the "bot is typing" state to a C2C user for `TYPING_NOTIFY_SECONDS`.
   *
   * Resolves to whether the platform was actually told. A `false` is normal
   * rather than an error: the indicator is a courtesy and is skipped when it
   * would eat into the passive-reply budget a real message needs.
   */
  sendTypingIndicator(openid: string): Promise<boolean>;
}

interface TokenInfo {
  accessToken: string;
  expiresAt: number;
}

interface QQWsPayload {
  op: number;
  d?: any;
  s?: number;
  t?: string;
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Parse JID to determine chat type and extract openid.
 * qq:c2c:{user_openid} → { type: 'c2c', openid }
 * qq:group:{group_openid} → { type: 'group', openid }
 */
function parseQQChatId(
  chatId: string,
): { type: 'c2c' | 'group'; openid: string } | null {
  if (chatId.startsWith('c2c:')) {
    return { type: 'c2c', openid: chatId.slice(4) };
  }
  if (chatId.startsWith('group:')) {
    return { type: 'group', openid: chatId.slice(6) };
  }
  return null;
}

export interface QQFollowUpOutcome {
  /**
   * Whether the caller should start a turn now. A queued or steered message is
   * released later by the scheduler, so starting one here would run it twice.
   */
  shouldStartTurn: boolean;
  disposition: FollowUpDisposition['disposition'];
  /** Projection fields describing the outcome to `onMessagePersisted`. */
  deliveryFields: Record<string, unknown>;
  position?: number;
}

/**
 * Translate the host's follow-up decision into projection fields.
 *
 * Split out from the connector so the mapping can be pinned by tests: the
 * steer case is easy to get wrong because it reports as `steered` but must be
 * persisted as `queued`.
 */
export function describeFollowUpOutcome(
  followUp: FollowUpDisposition,
  now: string = new Date().toISOString(),
): QQFollowUpOutcome {
  if (followUp.disposition === 'started') {
    return {
      shouldStartTurn: true,
      disposition: 'started',
      deliveryFields: {},
    };
  }

  return {
    shouldStartTurn: false,
    disposition: followUp.disposition,
    position: followUp.position,
    deliveryFields: {
      delivery_mode: followUp.disposition === 'steered' ? 'steer' : 'queue',
      // Steering stays `queued`: it is a durable hand-off, and the row is only
      // released once the interrupted query reports idle. Marking it anything
      // else would hide it from the queue readers that must eventually run it.
      delivery_status: 'queued',
      delivery_run_id: followUp.runId ?? null,
      delivery_updated_at: now,
    },
  };
}

export function validateQQGatewayUrl(value: string): string {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== 'wss:' ||
    url.username ||
    url.password ||
    (hostname !== 'qq.com' && !hostname.endsWith('.qq.com'))
  ) {
    throw new Error('QQ gateway returned an untrusted WebSocket URL');
  }
  return url.toString();
}

/**
 * A 2xx transport response is not delivery evidence by itself. QQ's official
 * v2 C2C/group send contract returns a JSON object with a non-empty string
 * message id; empty/HTML/malformed bodies are therefore an uncertain ACK, not
 * permission to commit the channel Outbox row.
 */
export class QQOfficialSendAckError extends Error {
  readonly code = 'QQ_SEND_ACK_UNCERTAIN';
  readonly deliveryPhase = 'uncertain' as const;

  constructor(message: string) {
    super(message);
    this.name = 'QQOfficialSendAckError';
  }
}

export function requireQQOfficialSendId(data: unknown): { id: string } {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new QQOfficialSendAckError(
      'QQ send response is not a JSON object with an official id',
    );
  }
  const id = (data as { id?: unknown }).id;
  if (typeof id !== 'string' || id.trim() === '') {
    throw new QQOfficialSendAckError(
      'QQ send response is missing a non-empty official id',
    );
  }
  return { id: id.trim() };
}

/**
 * QQ error bodies carry a numeric business `code` (newer endpoints mirror it
 * as `err_code`) and a `message`/`msg`, the fields apiRequest reads for HTTP
 * >= 400. A 2xx body in that shape with a non-zero code is an explicit
 * provider rejection; a body that merely lacks fields is not.
 */
export function readQQBusinessError(
  data: unknown,
): { code: number; message: string } | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const body = data as Record<string, unknown>;
  const code = [body.code, body.err_code].find(
    (value): value is number => typeof value === 'number' && value !== 0,
  );
  if (code === undefined) return null;
  const message = [body.message, body.msg].find(
    (value): value is string => typeof value === 'string' && value !== '',
  );
  return { code, message: message ?? 'unknown error' };
}

// ─── Factory Function ───────────────────────────────────────────

export function createQQConnection(config: QQConnectionConfig): QQConnection {
  // Token state
  let tokenInfo: TokenInfo | null = null;
  let tokenRefreshPromise: Promise<string> | null = null;

  // WebSocket state
  let ws: WebSocket | null = null;
  let heartbeatTimer: NodeJS.Timeout | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let watchdogTimer: NodeJS.Timeout | null = null;
  let reconnectAttempts = 0;
  let lastSequence: number | null = null;
  let sessionId: string | null = null;
  let resumeGatewayUrl: string | null = null;
  let stopping = false;
  let readyFired = false;
  const inboundLifecycle = new ChannelInboundLifecycle();

  // Reconnect control state. Mutated by ws lifecycle handlers and the
  // reconnect timer; read by scheduleReconnect to pick the next strategy.
  let quickDisconnectCount = 0;
  let lastConnectTime = 0;
  let keepaliveMode = false;
  let lastErrorIsTransient = false;

  // Message deduplication
  // LRU deduplication cache（共享 helper）
  const dedup = createDedupCache({ ttlMs: 30 * 60 * 1000, max: 1000 });
  const processingLock = new ProcessingLock();

  // Per-chat msg_seq counter for active messages
  const msgSeqCounters = new Map<string, number>();

  // Passive-reply budget per chat. Replying with an inbound msg_id is free;
  // once the budget is spent we fall back to a (quota-billed) active push.
  const passiveReplies = createPassiveReplyStore();

  // Rate-limit rejection messages
  const rejectTimestamps = new Map<string, number>();
  const REJECT_COOLDOWN_MS = 5 * 60 * 1000;

  // Upload cache: avoid re-uploading identical files within TTL
  const UPLOAD_CACHE_MAX = 500;
  const UPLOAD_CACHE_TTL_MARGIN_S = 60; // expire 60s early for safety
  interface UploadCacheEntry {
    fileInfo: string;
    expiresAt: number; // ms
  }
  const uploadCache = new Map<string, UploadCacheEntry>();

  function getUploadCacheKey(
    md5: string,
    chatType: 'c2c' | 'group',
    openid: string,
    fileType: number,
  ): string {
    return `${md5}:${chatType}:${openid}:${fileType}`;
  }

  function getCachedFileInfo(
    md5: string,
    chatType: 'c2c' | 'group',
    openid: string,
    fileType: number,
  ): string | null {
    const key = getUploadCacheKey(md5, chatType, openid, fileType);
    const entry = uploadCache.get(key);
    if (!entry) return null;
    if (Date.now() >= entry.expiresAt) {
      uploadCache.delete(key);
      return null;
    }
    logger.info({ key: key.slice(0, 40) }, 'QQ upload cache HIT');
    return entry.fileInfo;
  }

  function setCachedFileInfo(
    md5: string,
    chatType: 'c2c' | 'group',
    openid: string,
    fileType: number,
    fileInfo: string,
    ttlSeconds: number,
  ): void {
    // Lazy eviction of expired entries when at capacity
    if (uploadCache.size >= UPLOAD_CACHE_MAX) {
      const now = Date.now();
      for (const [k, v] of uploadCache) {
        if (now >= v.expiresAt) uploadCache.delete(k);
      }
      // Still full → drop oldest half
      if (uploadCache.size >= UPLOAD_CACHE_MAX) {
        const keys = Array.from(uploadCache.keys());
        for (let i = 0; i < keys.length / 2; i++) {
          uploadCache.delete(keys[i]!);
        }
      }
    }

    const effectiveTtl = Math.max(ttlSeconds - UPLOAD_CACHE_TTL_MARGIN_S, 10);
    const key = getUploadCacheKey(md5, chatType, openid, fileType);
    uploadCache.set(key, {
      fileInfo,
      expiresAt: Date.now() + effectiveTtl * 1000,
    });
    logger.info(
      { key: key.slice(0, 40), ttl: effectiveTtl },
      'QQ upload cache SET',
    );
  }

  function getNextMsgSeq(chatId: string): number {
    const current = msgSeqCounters.get(chatId) ?? 0;
    const next = current + 1;
    msgSeqCounters.set(chatId, next);
    return next;
  }

  /**
   * Offer a just-persisted inbound message to the durable follow-up queue.
   *
   * Order matters and mirrors the Feishu intake: the host applies its decision
   * with an UPDATE keyed on the message row, so the row has to exist before
   * this runs. Returns the projection fields describing the outcome plus
   * whether the caller should start a turn now — a queued or steered message
   * is released later by the scheduler, so starting one here would run it
   * twice.
   */
  function offerFollowUp(
    opts: QQConnectOpts,
    input: {
      targetJid: string;
      sourceJid: string;
      messageId: string;
      senderImId: string;
      requestedMode?: FollowUpMode;
    },
  ): QQFollowUpOutcome {
    const followUp: FollowUpDisposition = opts.onFollowUpMessage?.(input) ?? {
      disposition: 'started',
    };
    return describeFollowUpOutcome(followUp);
  }

  /**
   * Pick the addressing fields for one outbound message.
   *
   * Prefers a passive reply (echo an inbound `msg_id`) because QQ does not
   * bill those against the active-push quota. When no inbound reference is
   * still within its window or budget, falls back to an active push, which is
   * what this channel did unconditionally before.
   *
   * `msg_seq` comes from the claim for passive replies because QQ dedupes on
   * `(msg_id, msg_seq)`; active pushes keep the per-chat counter.
   *
   * The outcome is logged because it is the only signal that this channel is
   * spending the bot's limited active-push quota: the request body is
   * otherwise identical and QQ does not report which class a send was billed
   * as. The inbound `msg_id` itself is deliberately left out of the log.
   */
  function resolveSendRef(
    chatKey: string,
    kind: 'text' | 'image' | 'file',
  ): {
    msg_id?: string;
    msg_seq: number;
  } {
    const chatType = chatKey.split(':')[0];
    const claim = passiveReplies.claim(chatKey);
    if (claim) {
      logger.info(
        { chatType, kind, mode: 'passive', msgSeq: claim.msgSeq },
        'QQ outbound addressing',
      );
      return { msg_id: claim.msgId, msg_seq: claim.msgSeq };
    }
    logger.info(
      { chatType, kind, mode: 'active-push' },
      'QQ outbound addressing',
    );
    return { msg_seq: getNextMsgSeq(chatKey) };
  }

  function rejectPassiveReply(
    chatKey: string,
    _msgId: string,
    error: unknown,
  ): boolean {
    const retireReference = shouldRetireQQPassiveReplyReference(error);
    if (retireReference) passiveReplies.discard(chatKey, _msgId);
    if (error instanceof QQApiError && error.httpStatus === 400) {
      logger.warn(
        {
          chatType: chatKey.split(':')[0],
          httpStatus: error.httpStatus,
          bizCode: error.bizCode,
          outcome: 'uncertain',
          passiveReferenceRetained: !retireReference,
        },
        'QQ passive reply returned an unclassified HTTP 400; preserving reference and refusing replay',
      );
    }
    return retireReference;
  }

  async function sendWithQQAddressing(
    chatKey: string,
    kind: 'text' | 'image' | 'file',
    send: (ref: { msg_id?: string; msg_seq: number }) => Promise<void>,
  ): Promise<void> {
    const ref = resolveSendRef(chatKey, kind);
    try {
      await send(ref);
    } catch (error) {
      if (ref.msg_id) rejectPassiveReply(chatKey, ref.msg_id, error);
      throw error;
    }
  }

  // ─── Token Management ──────────────────────────────────────

  async function getAccessToken(): Promise<string> {
    // Check cached token
    if (
      tokenInfo &&
      Date.now() < tokenInfo.expiresAt - TOKEN_REFRESH_BUFFER_MS
    ) {
      return tokenInfo.accessToken;
    }

    // Singleflight: reuse in-flight refresh
    if (tokenRefreshPromise) {
      return tokenRefreshPromise;
    }

    tokenRefreshPromise = refreshToken();
    try {
      return await tokenRefreshPromise;
    } finally {
      tokenRefreshPromise = null;
    }
  }

  async function refreshToken(): Promise<string> {
    const body = JSON.stringify({
      appId: config.appId,
      clientSecret: config.appSecret,
    });

    return new Promise<string>((resolve, reject) => {
      const url = new URL(QQ_TOKEN_URL);
      const req = https.request(
        {
          hostname: url.hostname,
          path: url.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let responseBytes = 0;
          res.on('data', (chunk: Buffer) => {
            responseBytes += chunk.length;
            if (responseBytes > QQ_MAX_JSON_RESPONSE_BYTES) {
              res.destroy(new Error('QQ token response is too large'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            try {
              const text = Buffer.concat(chunks).toString('utf-8');
              const data = JSON.parse(text);
              if (res.statusCode && res.statusCode >= 400) {
                reject(
                  new Error(
                    `QQ token request failed (${res.statusCode}): ${String(data.message || data.msg || 'unknown error').slice(0, 500)}`,
                  ),
                );
                return;
              }
              if (!data.access_token) {
                reject(
                  new Error(
                    `QQ token response missing access_token: ${JSON.stringify(data).slice(0, 500)}`,
                  ),
                );
                return;
              }
              const expiresIn = Number(data.expires_in) || 7200;
              tokenInfo = {
                accessToken: data.access_token,
                expiresAt: Date.now() + expiresIn * 1000,
              };
              logger.info({ expiresIn }, 'QQ access token refreshed');
              resolve(data.access_token);
            } catch (err) {
              reject(err);
            }
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.setTimeout(QQ_TOKEN_REQUEST_TIMEOUT_MS, () => {
        req.destroy(new Error('QQ token request timed out'));
      });
      req.write(body);
      req.end();
    });
  }

  // ─── REST API ──────────────────────────────────────────────

  async function apiRequest<T = any>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const token = await getAccessToken();
    const url = new URL(path, QQ_API_BASE);
    const bodyStr = body ? JSON.stringify(body) : undefined;

    return new Promise<T>((resolve, reject) => {
      const req = https.request(
        {
          hostname: url.hostname,
          path: url.pathname + url.search,
          method,
          headers: {
            Authorization: `QQBot ${token}`,
            'Content-Type': 'application/json',
            ...(bodyStr
              ? { 'Content-Length': String(Buffer.byteLength(bodyStr)) }
              : {}),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          let responseBytes = 0;
          res.on('data', (chunk: Buffer) => {
            responseBytes += chunk.length;
            if (responseBytes > QQ_MAX_JSON_RESPONSE_BYTES) {
              res.destroy(new Error('QQ API response is too large'));
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf-8');
            try {
              const data = JSON.parse(text);
              if (res.statusCode && res.statusCode >= 400) {
                const errMsg = data.message || data.msg || text;
                const bizCode =
                  typeof data.code === 'number' ? data.code : undefined;
                reject(
                  new QQApiError(
                    `QQ API ${method} ${path} failed (${res.statusCode}): ${errMsg}`,
                    bizCode,
                    res.statusCode,
                  ),
                );
                return;
              }
              resolve(data as T);
            } catch {
              if (res.statusCode && res.statusCode >= 400) {
                reject(
                  new QQApiError(
                    `QQ API ${method} ${path} failed (${res.statusCode}): ${text}`,
                    undefined,
                    res.statusCode,
                  ),
                );
              } else {
                // Some endpoints return empty body on success
                resolve({} as T);
              }
            }
          });
          res.on('error', reject);
        },
      );
      req.on('error', reject);
      req.setTimeout(QQ_API_REQUEST_TIMEOUT_MS, () => {
        req.destroy(new Error(`QQ API ${method} ${path} timed out`));
      });
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  async function postQQMessageWithOfficialAck(
    endpoint: string,
    body: Record<string, unknown>,
  ): Promise<void> {
    const sent = await apiRequest<{ id?: unknown; timestamp?: unknown }>(
      'POST',
      endpoint,
      body,
    );
    requireQQOfficialSendId(sent);
  }

  async function getGatewayUrl(): Promise<string> {
    const data = await apiRequest<{ url: string }>('GET', '/gateway/bot');
    if (!data.url) throw new Error('QQ gateway response did not include url');
    return validateQQGatewayUrl(data.url);
  }

  // ─── Message Sending ──────────────────────────────────────

  async function sendQQMessage(
    chatType: 'c2c' | 'group',
    openid: string,
    content: string,
  ): Promise<void> {
    const chatKey = `${chatType}:${openid}`;

    const endpoint =
      chatType === 'c2c'
        ? `/v2/users/${openid}/messages`
        : `/v2/groups/${openid}/messages`;

    await sendWithQQAddressing(chatKey, 'text', (ref) =>
      postQQMessageWithOfficialAck(endpoint, {
        markdown: { content },
        msg_type: 2, // markdown
        ...ref,
      }),
    );
  }

  // ─── Image Sending ───────────────────────────────────────

  async function uploadMedia(
    chatType: 'c2c' | 'group',
    openid: string,
    imageBuffer: Buffer,
  ): Promise<string> {
    if (imageBuffer.length > QQ_ONESHOT_UPLOAD_MAX_SIZE) {
      throw new Error(
        `Image too large for QQ upload: ${(imageBuffer.length / 1024 / 1024).toFixed(1)}MB ` +
          `(max ${QQ_ONESHOT_UPLOAD_MAX_SIZE / 1024 / 1024}MB)`,
      );
    }

    // Check upload cache
    const md5 = crypto.createHash('md5').update(imageBuffer).digest('hex');
    const cached = getCachedFileInfo(
      md5,
      chatType,
      openid,
      QQMediaFileType.IMAGE,
    );
    if (cached) return cached;

    const endpoint =
      chatType === 'c2c'
        ? `/v2/users/${openid}/files`
        : `/v2/groups/${openid}/files`;

    const res = await apiRequest<{
      file_info: string;
      file_uuid?: string;
      ttl?: number;
    }>('POST', endpoint, {
      file_type: 1, // 1 = image
      file_data: imageBuffer.toString('base64'),
      srv_send_msg: false,
    });
    if (!res.file_info) {
      throw new Error('QQ uploadMedia: no file_info in response');
    }

    // Cache the result
    if (res.ttl && res.ttl > 0) {
      setCachedFileInfo(
        md5,
        chatType,
        openid,
        QQMediaFileType.IMAGE,
        res.file_info,
        res.ttl,
      );
    }

    return res.file_info;
  }

  async function sendQQImageMessage(
    chatType: 'c2c' | 'group',
    openid: string,
    imageBuffer: Buffer,
    caption?: string,
  ): Promise<void> {
    const fileInfo = await uploadMedia(chatType, openid, imageBuffer);
    const chatKey = `${chatType}:${openid}`;

    const endpoint =
      chatType === 'c2c'
        ? `/v2/users/${openid}/messages`
        : `/v2/groups/${openid}/messages`;

    await sendWithQQAddressing(chatKey, 'image', (ref) =>
      postQQMessageWithOfficialAck(endpoint, {
        msg_type: 7, // rich media
        media: { file_info: fileInfo },
        content: caption || '',
        ...ref,
      }),
    );
  }

  // ─── Chunked File Upload ─────────────────────────────────────

  async function qqUploadPrepare(
    chatType: 'c2c' | 'group',
    openid: string,
    fileType: QQMediaFileType,
    fileName: string,
    fileSize: number,
    hashes: UploadPrepareHashes,
  ): Promise<QQUploadPrepareResponse> {
    const endpoint =
      chatType === 'c2c'
        ? `/v2/users/${openid}/upload_prepare`
        : `/v2/groups/${openid}/upload_prepare`;

    return apiRequest<QQUploadPrepareResponse>('POST', endpoint, {
      file_type: fileType,
      file_name: fileName,
      file_size: fileSize,
      md5: hashes.md5,
      sha1: hashes.sha1,
      md5_10m: hashes.md5_10m,
    });
  }

  async function qqUploadPartFinish(
    chatType: 'c2c' | 'group',
    openid: string,
    uploadId: string,
    partIndex: number,
    blockSize: number,
    md5: string,
    retryTimeoutMs?: number,
  ): Promise<void> {
    const endpoint =
      chatType === 'c2c'
        ? `/v2/users/${openid}/upload_part_finish`
        : `/v2/groups/${openid}/upload_part_finish`;

    const body = {
      upload_id: uploadId,
      part_index: partIndex,
      block_size: blockSize,
      md5,
    };

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= PART_FINISH_MAX_RETRIES; attempt++) {
      try {
        await apiRequest('POST', endpoint, body);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Retryable biz code → persistent retry
        if (
          err instanceof QQApiError &&
          err.bizCode !== undefined &&
          PART_FINISH_RETRYABLE_CODES.has(err.bizCode)
        ) {
          const timeoutMs =
            retryTimeoutMs ?? PART_FINISH_RETRYABLE_DEFAULT_TIMEOUT_MS;
          logger.warn(
            { bizCode: err.bizCode, timeoutMs },
            'QQ partFinish hit retryable bizCode, entering persistent retry',
          );
          await qqPartFinishPersistentRetry(endpoint, body, timeoutMs);
          return;
        }

        if (attempt < PART_FINISH_MAX_RETRIES) {
          const delay = PART_FINISH_BASE_DELAY_MS * Math.pow(2, attempt);
          logger.warn(
            { attempt: attempt + 1, err: lastError.message },
            'QQ partFinish failed, retrying',
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError!;
  }

  async function qqPartFinishPersistentRetry(
    endpoint: string,
    body: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;

    while (Date.now() < deadline) {
      try {
        await apiRequest('POST', endpoint, body);
        logger.info({ attempt }, 'QQ partFinish persistent retry succeeded');
        return;
      } catch (err) {
        if (
          !(err instanceof QQApiError) ||
          err.bizCode === undefined ||
          !PART_FINISH_RETRYABLE_CODES.has(err.bizCode)
        ) {
          throw err;
        }
        attempt++;
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.min(PART_FINISH_RETRYABLE_INTERVAL_MS, remaining),
          ),
        );
      }
    }

    throw new Error(
      `QQ upload_part_finish persistent retry timed out (${timeoutMs / 1000}s, ${attempt} attempts)`,
    );
  }

  async function qqCompleteUpload(
    chatType: 'c2c' | 'group',
    openid: string,
    uploadId: string,
  ): Promise<QQMediaUploadResponse> {
    const endpoint =
      chatType === 'c2c'
        ? `/v2/users/${openid}/files`
        : `/v2/groups/${openid}/files`;

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= COMPLETE_UPLOAD_MAX_RETRIES; attempt++) {
      try {
        return await apiRequest<QQMediaUploadResponse>('POST', endpoint, {
          upload_id: uploadId,
        });
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < COMPLETE_UPLOAD_MAX_RETRIES) {
          const delay = COMPLETE_UPLOAD_BASE_DELAY_MS * Math.pow(2, attempt);
          logger.warn(
            { attempt: attempt + 1, err: lastError.message },
            'QQ completeUpload failed, retrying',
          );
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError!;
  }

  async function chunkedUpload(
    chatType: 'c2c' | 'group',
    openid: string,
    filePath: string,
    fileType: QQMediaFileType,
  ): Promise<string> {
    const stat = await fs.promises.stat(filePath);
    const fileSize = stat.size;
    const fileName = path.basename(filePath);

    logger.info({ fileName, fileSize, fileType }, 'QQ chunked upload starting');

    const hashes = await computeFileHashes(filePath, fileSize);

    // Check upload cache
    const cached = getCachedFileInfo(hashes.md5, chatType, openid, fileType);
    if (cached) return cached;

    const prepareResp = await qqUploadPrepare(
      chatType,
      openid,
      fileType,
      fileName,
      fileSize,
      hashes,
    );

    const { upload_id, parts } = prepareResp;
    const block_size = Number(prepareResp.block_size);

    const maxConcurrent = Math.min(
      prepareResp.concurrency
        ? Number(prepareResp.concurrency)
        : DEFAULT_CONCURRENT_PARTS,
      MAX_CONCURRENT_PARTS,
    );

    const retryTimeoutMs = prepareResp.retry_timeout
      ? Math.min(
          Number(prepareResp.retry_timeout) * 1000,
          MAX_PART_FINISH_RETRY_TIMEOUT_MS,
        )
      : undefined;

    logger.info(
      { upload_id, block_size, parts: parts.length, maxConcurrent },
      'QQ upload prepared',
    );

    const uploadPart = async (part: QQUploadPart): Promise<void> => {
      const offset = (part.index - 1) * block_size;
      const length = Math.min(block_size, fileSize - offset);

      const partBuffer = await readFileChunk(filePath, offset, length);
      const md5Hex = crypto.createHash('md5').update(partBuffer).digest('hex');

      await putToPresignedUrl(
        part.presigned_url,
        partBuffer,
        part.index,
        parts.length,
      );

      await qqUploadPartFinish(
        chatType,
        openid,
        upload_id,
        part.index,
        length,
        md5Hex,
        retryTimeoutMs,
      );
    };

    await runWithConcurrency(
      parts.map((part) => () => uploadPart(part)),
      maxConcurrent,
    );

    const result = await qqCompleteUpload(chatType, openid, upload_id);
    logger.info(
      { file_uuid: result.file_uuid, ttl: result.ttl },
      'QQ chunked upload completed',
    );

    // Cache the result
    if (result.ttl > 0) {
      setCachedFileInfo(
        hashes.md5,
        chatType,
        openid,
        fileType,
        result.file_info,
        result.ttl,
      );
    }

    return result.file_info;
  }

  async function sendQQFileMessage(
    chatType: 'c2c' | 'group',
    openid: string,
    filePath: string,
    fileName: string,
  ): Promise<void> {
    const fileType = getQQMediaFileType(fileName);
    const maxSize = QQ_MEDIA_MAX_SIZE[fileType];
    const stat = await fs.promises.stat(filePath);
    if (stat.size > maxSize) {
      throw new Error(
        `File too large for QQ upload: ${(stat.size / 1024 / 1024).toFixed(1)}MB ` +
          `(max ${maxSize / 1024 / 1024}MB for ${QQ_MEDIA_TYPE_NAME[fileType]})`,
      );
    }

    const fileInfo = await chunkedUpload(chatType, openid, filePath, fileType);

    const chatKey = `${chatType}:${openid}`;

    const endpoint =
      chatType === 'c2c'
        ? `/v2/users/${openid}/messages`
        : `/v2/groups/${openid}/messages`;

    await sendWithQQAddressing(chatKey, 'file', (ref) =>
      postQQMessageWithOfficialAck(endpoint, {
        msg_type: 7,
        media: { file_info: fileInfo },
        content: '',
        ...ref,
      }),
    );
  }

  // ─── File Download ─────────────────────────────────────────

  async function downloadQQAttachment(
    url: string,
    lease: ChannelInboundLease,
  ): Promise<Buffer | null> {
    try {
      const buffer = await downloadHttpsBuffer(url, {
        followRedirects: true,
        signal: lease.signal,
      });
      inboundLifecycle.assertCurrent(lease);

      if (buffer.length === 0) return null;
      return buffer;
    } catch (err) {
      inboundLifecycle.assertCurrent(lease);
      logger.warn({ err }, 'Failed to download QQ attachment');
      return null;
    }
  }

  /**
   * Process a QQ attachment (image or file): download, detect type, save to disk.
   * Returns updated content string and optional attachmentsJson for vision.
   */
  async function processQQAttachment(
    attachment: { url?: string; filename?: string },
    msgId: string,
    jid: string,
    content: string,
    opts: QQConnectOpts,
    logContext: string,
    lease: ChannelInboundLease,
  ): Promise<{ content: string; attachmentsJson?: string }> {
    if (!attachment.url) return { content };

    const attachUrl = attachment.url.startsWith('http')
      ? attachment.url
      : `https://${attachment.url}`;
    const buffer = await downloadQQAttachment(attachUrl, lease);
    inboundLifecycle.assertCurrent(lease);
    if (!buffer) return { content };

    const imageMime = detectImageMimeTypeStrict(buffer);
    const groupFolder = opts.resolveGroupFolder?.(jid);

    if (imageMime) {
      const attachmentsJson = JSON.stringify([
        { type: 'image', data: buffer.toString('base64'), mimeType: imageMime },
      ]);

      if (groupFolder) {
        const ext = IMAGE_EXT_MAP[imageMime] ?? '.jpg';
        const fileName = `qq_img_${msgId.slice(-8)}${ext}`;
        try {
          inboundLifecycle.assertCurrent(lease);
          const relPath = await saveDownloadedFile(
            groupFolder,
            'qq',
            fileName,
            buffer,
          );
          inboundLifecycle.assertCurrent(lease);
          if (relPath) content = `[图片: ${relPath}]\n${content}`.trim();
        } catch (err) {
          inboundLifecycle.assertCurrent(lease);
          logger.warn({ err }, `Failed to save QQ ${logContext} image`);
        }
      }

      if (!content) content = '[图片]';
      return { content, attachmentsJson };
    }

    // Non-image file
    const urlFilename =
      attachment.filename ||
      attachUrl.split('/').pop()?.split('?')[0] ||
      `qq_file_${msgId.slice(-8)}`;
    const fileName = urlFilename.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fff]/g, '_');

    if (groupFolder) {
      try {
        inboundLifecycle.assertCurrent(lease);
        const relPath = await saveDownloadedFile(
          groupFolder,
          'qq',
          fileName,
          buffer,
        );
        inboundLifecycle.assertCurrent(lease);
        if (relPath) content = `[文件: ${relPath}]\n${content}`.trim();
      } catch (err) {
        inboundLifecycle.assertCurrent(lease);
        logger.warn({ err }, `Failed to save QQ ${logContext} file`);
      }
    }

    if (!content) content = '[文件]';
    return { content };
  }

  // ─── WebSocket Connection ─────────────────────────────────

  function clearTimers(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function stopWatchdog(): void {
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
  }

  function startWatchdog(opts: QQConnectOpts): void {
    stopWatchdog();
    watchdogTimer = setInterval(() => {
      if (stopping) return;
      if (connection.isConnected()) return;
      // A reconnect is already in flight (including keepalive ticks).
      if (reconnectTimer) return;
      // Invariant violation: disconnected, not stopping, no retry pending.
      // Reset the budget and kick a fresh attempt — this is the safety net
      // that prevents the bot from staying permanently dead.
      logger.warn(
        { reconnectAttempts, keepaliveMode },
        'QQ watchdog detected stale disconnected state, kicking fresh reconnect',
      );
      reconnectAttempts = 0;
      keepaliveMode = false;
      lastErrorIsTransient = false;
      scheduleReconnect(opts);
    }, WATCHDOG_INTERVAL_MS);
  }

  function sendWs(payload: QQWsPayload): void {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  function startHeartbeat(intervalMs: number): void {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      sendWs({ op: OP_HEARTBEAT, d: lastSequence });
    }, intervalMs);
  }

  async function connectWs(
    opts: QQConnectOpts,
    gatewayUrl: string,
    isResume: boolean = false,
  ): Promise<void> {
    if (stopping) return;
    const lease = inboundLifecycle.begin();

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      // True only once READY/RESUMED dispatched. Distinguishes a real
      // mid-session disconnect from a connect-time error so the close handler
      // doesn't double-schedule a reconnect that the rejection's catch path
      // is already handling.
      let connectionEstablished = false;

      ws = new WebSocket(gatewayUrl);

      const onSessionReady = (): void => {
        connectionEstablished = true;
        lastConnectTime = Date.now();
        reconnectAttempts = 0;
        keepaliveMode = false;
        if (!settled) {
          settled = true;
          resolve();
        }
      };

      ws.on('open', () => {
        logger.info(
          { gatewayUrl: gatewayUrl.slice(0, 50) },
          'QQ WebSocket connected',
        );
        // Don't reset reconnectAttempts here — wait until READY/RESUMED
      });

      ws.on('message', (data) => {
        if (!inboundLifecycle.isCurrent(lease)) return;
        const task = (async (): Promise<void> => {
          try {
            const payload: QQWsPayload = JSON.parse(data.toString());
            await handleWsMessage(
              payload,
              opts,
              gatewayUrl,
              lease,
              onSessionReady,
            );
          } catch (err) {
            if (inboundLifecycle.isCancellation(err, lease)) {
              logger.debug('QQ inbound callback cancelled');
            } else {
              logger.error({ err }, 'Error handling QQ WebSocket message');
            }
          }
        })();
        return inboundLifecycle.track(task);
      });

      ws.on('close', (code, reason) => {
        logger.info({ code, reason: reason.toString() }, 'QQ WebSocket closed');
        clearTimers();
        if (inboundLifecycle.isCurrent(lease)) inboundLifecycle.invalidate();

        if (!settled) {
          settled = true;
          reject(new Error(`QQ WebSocket closed before ready: ${code}`));
          return;
        }
        // settled but not established → ws.on('error') already rejected;
        // let the rejection's catch path handle the reconnect (avoids the
        // double-increment that drained the old budget in ~3 minutes).
        if (!connectionEstablished) return;
        if (stopping) return;

        // Quick-disconnect detection: server flapping us right after READY
        // usually signals a permission / auth issue. Back off harder.
        if (
          lastConnectTime > 0 &&
          Date.now() - lastConnectTime < QUICK_DISCONNECT_THRESHOLD_MS
        ) {
          quickDisconnectCount++;
          if (quickDisconnectCount >= MAX_QUICK_DISCONNECT_COUNT) {
            logger.error(
              { quickDisconnectCount, code },
              'QQ too many quick disconnects, backing off (check appId/secret/permissions)',
            );
            quickDisconnectCount = 0;
            scheduleReconnect(opts, RATE_LIMIT_DELAY_MS);
            return;
          }
        } else {
          quickDisconnectCount = 0;
        }

        const action = classifyCloseCode(code);
        switch (action.kind) {
          case 'refresh-token':
            logger.info(
              { code },
              'QQ invalid token close, forcing token refresh',
            );
            tokenInfo = null;
            sessionId = null;
            lastSequence = null;
            scheduleReconnect(opts);
            break;
          case 'rate-limit':
            logger.warn({ code }, 'QQ rate limited, applying long delay');
            scheduleReconnect(opts, RATE_LIMIT_DELAY_MS);
            break;
          case 'reset-session':
            logger.info({ code }, 'QQ server internal error, dropping session');
            sessionId = null;
            lastSequence = null;
            scheduleReconnect(opts);
            break;
          case 'intents-rejected':
            // A RESUME would replay the same rejected IDENTIFY, so drop the
            // session, and back off rather than retrying immediately: nothing
            // about the request changes between attempts, so a fast retry is
            // pure load on a gateway that already said no.
            sessionId = null;
            lastSequence = null;
            logger.error(
              { code, intents: INTENTS },
              'QQ gateway refused the requested intents; check the bot permissions ' +
                'on the QQ Open Platform',
            );
            scheduleReconnect(opts, RATE_LIMIT_DELAY_MS);
            break;
          default:
            scheduleReconnect(opts);
        }
      });

      ws.on('error', (err) => {
        logger.error({ err }, 'QQ WebSocket error');
        lastErrorIsTransient = isTransientError(err);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
    });
  }

  async function handleWsMessage(
    payload: QQWsPayload,
    opts: QQConnectOpts,
    gatewayUrl: string,
    lease: ChannelInboundLease,
    onSessionReady?: () => void,
  ): Promise<void> {
    inboundLifecycle.assertCurrent(lease);
    switch (payload.op) {
      case OP_HELLO: {
        const heartbeatInterval = payload.d?.heartbeat_interval || 41250;
        startHeartbeat(heartbeatInterval);

        const token = await getAccessToken();
        if (sessionId) {
          // Resume existing session (after reconnect)
          sendWs({
            op: OP_RESUME,
            d: {
              token: `QQBot ${token}`,
              session_id: sessionId,
              seq: lastSequence,
            },
          });
        } else {
          // Fresh identify
          sendWs({
            op: OP_IDENTIFY,
            d: {
              token: `QQBot ${token}`,
              intents: INTENTS,
              shard: [0, 1],
            },
          });
        }
        break;
      }

      case OP_DISPATCH: {
        if (payload.s !== undefined) {
          lastSequence = payload.s;
        }

        const eventType = payload.t;
        const eventData = payload.d;

        if (eventType === 'READY') {
          sessionId = eventData.session_id;
          resumeGatewayUrl = gatewayUrl;
          logger.info({ sessionId }, 'QQ bot session ready');
          onSessionReady?.();
          if (!readyFired) {
            readyFired = true;
            opts.onReady?.();
          }
        } else if (eventType === 'RESUMED') {
          logger.info('QQ bot session resumed');
          onSessionReady?.();
        } else if (eventType === 'C2C_MESSAGE_CREATE') {
          await inboundLifecycle.runMessage(
            lease,
            eventData?.id,
            (id) => dedup.isDuplicate(id),
            (id) => dedup.markSeen(id),
            () => handleC2CMessage(eventData, opts, lease),
          );
        } else if (eventType === 'GROUP_AT_MESSAGE_CREATE') {
          await inboundLifecycle.runMessage(
            lease,
            eventData?.id,
            (id) => dedup.isDuplicate(id),
            (id) => dedup.markSeen(id),
            () => handleGroupMessage(eventData, opts, lease),
          );
        }
        break;
      }

      case OP_HEARTBEAT_ACK:
        // Heartbeat acknowledged, all good
        break;

      case OP_RECONNECT:
        logger.info('QQ server requested reconnect');
        ws?.close();
        break;

      case OP_INVALID_SESSION: {
        const canResume = payload.d === true;
        logger.warn({ canResume }, 'QQ invalid session');
        if (!canResume) {
          sessionId = null;
          lastSequence = null;
        }
        ws?.close();
        break;
      }

      default:
        logger.debug({ op: payload.op }, 'QQ unknown WebSocket opcode');
    }
  }

  function scheduleReconnect(opts: QQConnectOpts, customDelay?: number): void {
    if (stopping) return;
    // Idempotent: if a reconnect is already pending, don't double-schedule
    // (the close handler and the connect-failure catch can both fire for the
    // same disconnect event).
    if (reconnectTimer) return;

    // Transition to keepalive mode once we exhaust the regular budget.
    // We never hard-stop trying — a long network outage should self-recover.
    if (
      !keepaliveMode &&
      !lastErrorIsTransient &&
      reconnectAttempts >= MAX_RECONNECT_ATTEMPTS
    ) {
      keepaliveMode = true;
      logger.error(
        { attempts: reconnectAttempts },
        'QQ max reconnect attempts reached, falling back to keepalive mode',
      );
    }

    let delay: number;
    if (customDelay !== undefined) {
      delay = customDelay;
    } else if (keepaliveMode) {
      delay = KEEPALIVE_INTERVAL_MS;
    } else {
      delay = getReconnectDelay(reconnectAttempts);
      // Transient errors (DNS hiccups, brief TCP resets) shouldn't burn our
      // attempt budget — otherwise a 3-minute network blip kills the bot.
      if (!lastErrorIsTransient) {
        reconnectAttempts++;
      }
    }
    const wasTransient = lastErrorIsTransient;
    lastErrorIsTransient = false;

    logger.info(
      { delay, attempt: reconnectAttempts, keepaliveMode, wasTransient },
      'QQ scheduling reconnect',
    );
    reconnectTimer = setTimeout(async () => {
      reconnectTimer = null;
      if (stopping) return;

      try {
        if (sessionId && resumeGatewayUrl) {
          // Try to resume
          await connectWs(opts, resumeGatewayUrl, true);
        } else {
          // Fresh connection
          const url = await getGatewayUrl();
          await connectWs(opts, url, false);
        }
      } catch (err) {
        logger.error({ err }, 'QQ reconnect failed');
        lastErrorIsTransient = isTransientError(err);
        scheduleReconnect(opts);
      }
    }, delay);
  }

  // ─── Event Handlers ───────────────────────────────────────

  async function handleC2CMessage(
    data: any,
    opts: QQConnectOpts,
    lease: ChannelInboundLease,
  ): Promise<void> {
    try {
      inboundLifecycle.assertCurrent(lease);
      const msgId = data.id;
      if (!msgId) return;
      const msgTimeMs = data.timestamp ? new Date(data.timestamp).getTime() : 0;
      if (isStale(msgTimeMs)) {
        logger.debug(
          { msgId, msgTimeMs },
          'Stale QQ C2C message (>30min), dropping',
        );
        return;
      }
      if (!processingLock.acquire(msgId)) return;
      try {
        // Skip stale messages from before connection (hot-reload scenario)
        if (opts.ignoreMessagesBefore && data.timestamp) {
          const msgTime = new Date(data.timestamp).getTime();
          if (!isNaN(msgTime) && msgTime < opts.ignoreMessagesBefore) return;
        }

        const userOpenId = data.author?.id || data.author?.user_openid;
        if (!userOpenId) return;

        const jid =
          opts.normalizeIncomingJid?.(`qq:c2c:${userOpenId}`) ??
          `qq:c2c:${userOpenId}`;
        const realName = (data.author?.username || '').trim();
        const senderName = realName || `QQ用户`;
        const chatName = senderName;

        // Strip bot mention from content
        let content = (data.content || '').trim();

        // ── /pair <code> command ──
        const pairMatch = content.match(/^\/pair\s+(\S+)/i);
        if (pairMatch && opts.onPairAttempt) {
          const code = pairMatch[1];
          try {
            const success = await opts.onPairAttempt(jid, chatName, code);
            const reply = success
              ? '配对成功！此聊天已连接到你的账号。'
              : '配对码无效或已过期，请在 Web 设置页重新生成。';
            await sendQQMessage('c2c', userOpenId, reply);
          } catch (err) {
            logger.error({ err, jid }, 'QQ pair attempt error');
            await sendQQMessage('c2c', userOpenId, '配对失败，请稍后重试。');
          }
          return;
        }

        // ── Authorization check ──
        if (!opts.isChatAuthorized(jid)) {
          const now = Date.now();
          const lastReject = rejectTimestamps.get(jid) ?? 0;
          if (now - lastReject >= REJECT_COOLDOWN_MS) {
            rejectTimestamps.set(jid, now);
            await sendQQMessage(
              'c2c',
              userOpenId,
              '此聊天尚未配对。请发送 /pair <code> 进行配对。\n' +
                '你可以在 Web 设置页生成配对码。',
            );
          }
          return;
        }

        const resolvedRoute = resolveAdmittedChannelRoute(
          jid,
          opts.resolveEffectiveChatJid,
        );
        if (!resolvedRoute) {
          logger.warn(
            { jid },
            'QQ message dropped: binding resolver rejected route',
          );
          return;
        }
        const { targetJid, routing: agentRouting } = resolvedRoute;

        // Runtime controls are parsed before the generic slash handler so
        // `/steer` and `/break` cannot be swallowed as unknown commands.
        // A C2C message is always eligible: it is addressed to the bot by
        // construction.
        const runtimeControl = parseRuntimeControl({
          commandText: content,
          eligible: true,
          hasAttachments: Boolean(data.attachments?.length),
        });
        let requestedFollowUpMode: FollowUpMode | undefined;
        if (runtimeControl?.kind === 'steer') {
          requestedFollowUpMode = 'steer';
          content = runtimeControl.text;
        } else if (runtimeControl?.kind === 'break') {
          const reply = opts.onSessionBreak
            ? await opts.onSessionBreak({
                sourceJid: jid,
                targetJid,
                senderImId: `c2c:${userOpenId}`,
              })
            : '当前运行环境不支持 /break。';
          await sendQQMessage('c2c', userOpenId, markdownToPlainText(reply));
          return;
        }

        // Handle slash commands
        const slashMatch = content.match(/^\/(\S+)(?:\s+(.*))?$/i);
        if (
          slashMatch &&
          !requestedFollowUpMode &&
          opts.onCommand &&
          // Control lookalikes (`/queue ...`, a bare `/steer`, `/break` with
          // arguments) are deliberately not commands: they fall through to the
          // Agent as ordinary input rather than becoming "unknown command".
          // `/clear` is the exception -- it is a real command here.
          (runtimeControl?.kind === 'clear' ||
            runtimeControl?.kind === 'fresh' ||
            !isRuntimeControlLike(content))
        ) {
          const cmdBody = (
            slashMatch[1] + (slashMatch[2] ? ' ' + slashMatch[2] : '')
          ).trim();
          try {
            // Namespace senderImId with `c2c:` prefix so owner_im_id 比对在
            // DM 与群聊上下文中独立——QQ Bot API v2 的 author.user_openid (C2C) 与
            // author.member_openid (Group) 是两个不同的 ID namespace，protocol
            // 层面不互通；前缀化让 DM 认领的 owner 与群里认领的 owner 各自落入
            // 独立记录，互不干扰。
            const reply = await opts.onCommand(
              jid,
              cmdBody,
              `c2c:${userOpenId}`,
            );
            if (reply) {
              await sendQQMessage(
                'c2c',
                userOpenId,
                markdownToPlainText(reply),
              );
              return;
            }
          } catch (err) {
            logger.error({ jid, err }, 'QQ slash command failed');
            await sendQQMessage('c2c', userOpenId, '命令执行失败，请稍后重试');
            return;
          }
        }

        // Handle attachments (images / files)
        let attachmentsJson: string | undefined;
        if (data.attachments?.length) {
          const result = await processQQAttachment(
            data.attachments[0],
            msgId,
            jid,
            content,
            opts,
            'c2c',
            lease,
          );
          inboundLifecycle.assertCurrent(lease);
          content = result.content;
          attachmentsJson = result.attachmentsJson;
        }

        inboundLifecycle.assertCurrent(lease);
        passiveReplies.record(`c2c:${userOpenId}`, msgId);
        storeChatMetadata(jid, new Date().toISOString());
        if (realName) {
          updateChatName(jid, realName);
          opts.onNewChat(jid, realName);
        } else {
          const existing = getRegisteredGroup(jid);
          opts.onNewChat(jid, existing?.name ?? chatName);
        }

        // Store the already-resolved route. A configured resolver is
        // authoritative and was evaluated before registration/downloads.
        const id = crypto.randomUUID();
        let timestamp: string;
        try {
          timestamp = data.timestamp
            ? new Date(data.timestamp).toISOString()
            : new Date().toISOString();
        } catch {
          timestamp = new Date().toISOString();
        }
        const senderId = `qq:${userOpenId}`;
        inboundLifecycle.assertCurrent(lease);
        storeChatMetadata(targetJid, timestamp);
        storeMessageDirect(
          id,
          targetJid,
          senderId,
          senderName,
          content,
          timestamp,
          false,
          { attachments: attachmentsJson, sourceJid: jid },
        );

        const followUp = offerFollowUp(opts, {
          targetJid,
          sourceJid: jid,
          messageId: id,
          senderImId: senderId,
          requestedMode: requestedFollowUpMode,
        });

        opts.onMessagePersisted?.(
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
            ...followUp.deliveryFields,
          },
          agentRouting?.agentId ?? undefined,
        );

        if (!followUp.shouldStartTurn) {
          opts.onFollowUpsChanged?.(targetJid);
          logger.info(
            {
              jid,
              effectiveJid: targetJid,
              msgId,
              disposition: followUp.disposition,
              position: followUp.position ?? 1,
            },
            'QQ C2C message queued behind active query',
          );
          return;
        }

        notifyNewImMessage();

        if (agentRouting?.agentId) {
          opts.onAgentMessage?.(jid, agentRouting.agentId);
          logger.info(
            { jid, effectiveJid: targetJid, agentId: agentRouting.agentId },
            'QQ C2C message routed to agent',
          );
        } else {
          logger.info(
            { jid, sender: senderName, msgId },
            'QQ C2C message stored',
          );
        }
      } finally {
        processingLock.release(msgId);
      }
    } catch (err) {
      if (inboundLifecycle.isCancellation(err, lease)) throw err;
      logger.error({ err }, 'Error handling QQ C2C message');
    }
  }

  async function handleGroupMessage(
    data: any,
    opts: QQConnectOpts,
    lease: ChannelInboundLease,
  ): Promise<void> {
    try {
      inboundLifecycle.assertCurrent(lease);
      const msgId = data.id;
      if (!msgId) return;
      const msgTimeMs = data.timestamp ? new Date(data.timestamp).getTime() : 0;
      if (isStale(msgTimeMs)) {
        logger.debug(
          { msgId, msgTimeMs },
          'Stale QQ group message (>30min), dropping',
        );
        return;
      }
      if (!processingLock.acquire(msgId)) return;
      try {
        // Skip stale messages from before connection (hot-reload scenario)
        if (opts.ignoreMessagesBefore && data.timestamp) {
          const msgTime = new Date(data.timestamp).getTime();
          if (!isNaN(msgTime) && msgTime < opts.ignoreMessagesBefore) return;
        }

        const groupOpenId = data.group_openid;
        if (!groupOpenId) return;

        const jid =
          opts.normalizeIncomingJid?.(`qq:group:${groupOpenId}`) ??
          `qq:group:${groupOpenId}`;
        const memberOpenId = data.author?.member_openid;
        const senderName = data.author?.username || `QQ群成员`;
        const chatName = `QQ群 ${groupOpenId.slice(0, 8)}`;

        // Strip bot mention text (e.g. <@!bot_id>)
        let content = (data.content || '').replace(/<@!\w+>/g, '').trim();

        // ── /pair <code> command ──
        const pairMatch = content.match(/^\/pair\s+(\S+)/i);
        if (pairMatch && opts.onPairAttempt) {
          const code = pairMatch[1];
          try {
            const success = await opts.onPairAttempt(jid, chatName, code);
            const reply = success
              ? '配对成功！此群聊已连接。'
              : '配对码无效或已过期，请在 Web 设置页重新生成。';
            await sendQQMessage('group', groupOpenId, reply);
          } catch (err) {
            logger.error({ err, jid }, 'QQ group pair attempt error');
            await sendQQMessage('group', groupOpenId, '配对失败，请稍后重试。');
          }
          return;
        }

        // ── Authorization check ──
        if (!opts.isChatAuthorized(jid)) {
          const now = Date.now();
          const lastReject = rejectTimestamps.get(jid) ?? 0;
          if (now - lastReject >= REJECT_COOLDOWN_MS) {
            rejectTimestamps.set(jid, now);
            await sendQQMessage(
              'group',
              groupOpenId,
              '此群聊尚未配对。请发送 /pair <code> 进行配对。',
            );
          }
          return;
        }

        const resolvedRoute = resolveAdmittedChannelRoute(
          jid,
          opts.resolveEffectiveChatJid,
        );
        if (!resolvedRoute) {
          logger.warn(
            { jid },
            'QQ group message dropped: binding resolver rejected route',
          );
          return;
        }
        const { targetJid, routing: agentRouting } = resolvedRoute;

        // Runtime controls are parsed before the generic slash handler so
        // `/steer` and `/break` cannot be swallowed as unknown commands.
        // Eligibility is structural here: the gateway only delivers
        // GROUP_AT_MESSAGE_CREATE for messages that actually @-mention the
        // bot, so reaching this point is the proof Feishu has to compute.
        const runtimeControl = parseRuntimeControl({
          commandText: content,
          eligible: true,
          hasAttachments: Boolean(data.attachments?.length),
        });
        let requestedFollowUpMode: FollowUpMode | undefined;
        if (runtimeControl?.kind === 'steer') {
          requestedFollowUpMode = 'steer';
          content = runtimeControl.text;
        } else if (runtimeControl?.kind === 'break') {
          // An unidentifiable sender is refused rather than passed through
          // under a placeholder id: the host ignores senderImId today, but a
          // synthetic one would silently defeat any check added later.
          const reply = !memberOpenId
            ? '无法确认发送者身份，未执行 /break。'
            : opts.onSessionBreak
              ? await opts.onSessionBreak({
                  sourceJid: jid,
                  targetJid,
                  senderImId: `group:${memberOpenId}`,
                })
              : '当前运行环境不支持 /break。';
          await sendQQMessage('group', groupOpenId, markdownToPlainText(reply));
          return;
        }

        // Handle slash commands
        const slashMatch = content.match(/^\/(\S+)(?:\s+(.*))?$/i);
        if (
          slashMatch &&
          !requestedFollowUpMode &&
          opts.onCommand &&
          // Control lookalikes (`/queue ...`, a bare `/steer`, `/break` with
          // arguments) are deliberately not commands: they fall through to the
          // Agent as ordinary input rather than becoming "unknown command".
          // `/clear` is the exception -- it is a real command here.
          (runtimeControl?.kind === 'clear' ||
            runtimeControl?.kind === 'fresh' ||
            !isRuntimeControlLike(content))
        ) {
          const cmdBody = (
            slashMatch[1] + (slashMatch[2] ? ' ' + slashMatch[2] : '')
          ).trim();
          try {
            // Namespace senderImId with `group:` prefix——见 C2C 分支的注释。
            // member_openid 仅在群聊上下文有意义，与 C2C 的 user_openid 不互通。
            const reply = await opts.onCommand(
              jid,
              cmdBody,
              memberOpenId ? `group:${memberOpenId}` : undefined,
            );
            if (reply) {
              await sendQQMessage(
                'group',
                groupOpenId,
                markdownToPlainText(reply),
              );
              return;
            }
          } catch (err) {
            logger.error({ jid, err }, 'QQ group slash command failed');
            await sendQQMessage(
              'group',
              groupOpenId,
              '命令执行失败，请稍后重试',
            );
            return;
          }
        }

        // Handle attachments (images / files)
        let attachmentsJson: string | undefined;
        if (data.attachments?.length) {
          const result = await processQQAttachment(
            data.attachments[0],
            msgId,
            jid,
            content,
            opts,
            'group',
            lease,
          );
          inboundLifecycle.assertCurrent(lease);
          content = result.content;
          attachmentsJson = result.attachmentsJson;
        }

        inboundLifecycle.assertCurrent(lease);
        passiveReplies.record(`group:${groupOpenId}`, msgId);
        storeChatMetadata(jid, new Date().toISOString());
        const existing = getRegisteredGroup(jid);
        if (!existing) {
          updateChatName(jid, chatName);
          opts.onNewChat(jid, chatName);
        } else {
          opts.onNewChat(jid, existing.name ?? chatName);
        }

        // Store the already-resolved route.
        const id = crypto.randomUUID();
        let timestamp: string;
        try {
          timestamp = data.timestamp
            ? new Date(data.timestamp).toISOString()
            : new Date().toISOString();
        } catch {
          timestamp = new Date().toISOString();
        }
        const senderId = memberOpenId ? `qq:${memberOpenId}` : 'qq:unknown';
        inboundLifecycle.assertCurrent(lease);
        storeChatMetadata(targetJid, timestamp);
        storeMessageDirect(
          id,
          targetJid,
          senderId,
          senderName,
          content,
          timestamp,
          false,
          { attachments: attachmentsJson, sourceJid: jid },
        );

        const followUp = offerFollowUp(opts, {
          targetJid,
          sourceJid: jid,
          messageId: id,
          senderImId: senderId,
          requestedMode: requestedFollowUpMode,
        });

        opts.onMessagePersisted?.(
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
            ...followUp.deliveryFields,
          },
          agentRouting?.agentId ?? undefined,
        );

        if (!followUp.shouldStartTurn) {
          opts.onFollowUpsChanged?.(targetJid);
          logger.info(
            {
              jid,
              effectiveJid: targetJid,
              msgId,
              disposition: followUp.disposition,
              position: followUp.position ?? 1,
            },
            'QQ group message queued behind active query',
          );
          return;
        }

        notifyNewImMessage();

        if (agentRouting?.agentId) {
          opts.onAgentMessage?.(jid, agentRouting.agentId);
        }

        logger.info(
          { jid, sender: senderName, msgId },
          'QQ group message stored',
        );
      } finally {
        processingLock.release(msgId);
      }
    } catch (err) {
      if (inboundLifecycle.isCancellation(err, lease)) throw err;
      logger.error({ err }, 'Error handling QQ group message');
    }
  }

  // ─── Connection Interface ─────────────────────────────────

  const connection: QQConnection = {
    async connect(opts: QQConnectOpts): Promise<void> {
      if (!config.appId || !config.appSecret) {
        logger.info('QQ appId/appSecret not configured, skipping');
        return;
      }

      stopping = false;
      readyFired = false;
      reconnectAttempts = 0;
      sessionId = null;
      lastSequence = null;
      quickDisconnectCount = 0;
      lastConnectTime = 0;
      keepaliveMode = false;
      lastErrorIsTransient = false;

      startWatchdog(opts);

      try {
        // Validate token first
        await getAccessToken();

        // Get gateway and connect WebSocket
        const gatewayUrl = await getGatewayUrl();
        await connectWs(opts, gatewayUrl, false);
      } catch (err) {
        logger.error({ err }, 'QQ initial connection failed');
        lastErrorIsTransient = isTransientError(err);
        // The manager has not accepted/tracked this connector yet. Starting a
        // watchdog reconnect here would create a background "ghost" Bot after
        // the adapter returns false and its credential claim is released.
        // The outer adapter immediately calls disconnect() for deterministic
        // timer/socket cleanup; a later explicit reload performs the retry.
      }
    },

    async disconnect(): Promise<void> {
      stopping = true;
      inboundLifecycle.invalidate();
      stopWatchdog();
      clearTimers();

      const currentWs = ws;
      if (currentWs) {
        try {
          currentWs.close(1000, 'Disconnecting');
        } catch (err) {
          logger.debug({ err }, 'Error closing QQ WebSocket');
        }
      }
      await inboundLifecycle.settle();
      if (ws === currentWs) ws = null;

      tokenInfo = null;
      sessionId = null;
      lastSequence = null;
      resumeGatewayUrl = null;
      reconnectAttempts = 0;
      quickDisconnectCount = 0;
      lastConnectTime = 0;
      keepaliveMode = false;
      lastErrorIsTransient = false;
      dedup.clear();
      msgSeqCounters.clear();
      passiveReplies.clear();
      rejectTimestamps.clear();
      processingLock.dispose();
      logger.info('QQ bot disconnected');
    },

    async sendMessage(
      chatId: string,
      text: string,
      localImagePaths?: string[],
    ): Promise<void> {
      const parsed = parseQQChatId(chatId);
      if (!parsed) {
        logger.error({ chatId }, 'Invalid QQ chat ID format');
        throw new Error(`Invalid QQ chat ID format: ${chatId}`);
      }

      try {
        const chunks = splitTextChunks(text, MSG_SPLIT_LIMIT);
        const tracker = new PhysicalDeliveryTracker(
          chunks.length + (localImagePaths?.length ?? 0),
        );

        for (const chunk of chunks) {
          await tracker.send(() =>
            sendQQMessage(parsed.type, parsed.openid, chunk),
          );
        }

        // Send local images after text (same pattern as Feishu)
        for (const imgPath of localImagePaths || []) {
          try {
            await tracker.send(async () => {
              const buf = fs.readFileSync(imgPath);
              await sendQQImageMessage(parsed.type, parsed.openid, buf);
            });
            logger.info({ chatId, imgPath }, 'QQ local image sent');
          } catch (imgErr) {
            logger.error(
              { err: imgErr, chatId, imgPath },
              'Failed to send local image via QQ',
            );
            throw imgErr;
          }
        }

        logger.info({ chatId }, 'QQ message sent');
      } catch (err) {
        logger.error({ err, chatId }, 'Failed to send QQ message');
        throw err;
      }
    },

    async sendImage(
      chatId: string,
      imageBuffer: Buffer,
      _mimeType: string,
      caption?: string,
      _fileName?: string,
    ): Promise<void> {
      const parsed = parseQQChatId(chatId);
      if (!parsed) {
        logger.error({ chatId }, 'Invalid QQ chat ID format for image');
        throw new Error(`Invalid QQ chat ID format for image: ${chatId}`);
      }

      try {
        await sendQQImageMessage(
          parsed.type,
          parsed.openid,
          imageBuffer,
          caption,
        );
        logger.info({ chatId }, 'QQ image sent');
      } catch (err) {
        logger.error({ err, chatId }, 'Failed to send QQ image');
        throw err;
      }
    },

    async sendFile(
      chatId: string,
      filePath: string,
      fileName: string,
    ): Promise<void> {
      const parsed = parseQQChatId(chatId);
      if (!parsed) {
        logger.error({ chatId }, 'Invalid QQ chat ID format for file');
        throw new Error(`Invalid QQ chat ID format for file: ${chatId}`);
      }

      try {
        await sendQQFileMessage(parsed.type, parsed.openid, filePath, fileName);
        logger.info({ chatId, fileName }, 'QQ file sent');
      } catch (err) {
        logger.error({ err, chatId, fileName }, 'Failed to send QQ file');
        throw err;
      }
    },

    async sendChatAction(_chatId: string, _action: 'typing'): Promise<void> {
      // Deliberately inert. QQ does support a typing state, but it is not a
      // fire-and-forget action: it is addressed to one C2C user and spends
      // passive-reply budget, so it goes through sendTypingIndicator() and the
      // lease tracking in createQQChannel instead.
    },

    isConnected(): boolean {
      return ws !== null && ws.readyState === WebSocket.OPEN;
    },

    async sendStreamMessage(
      openid: string,
      params: {
        input_mode: string;
        input_state: number;
        content_type: string;
        content_raw: string;
        msg_seq: number;
        index: number;
        stream_msg_id?: string;
        msg_id?: string;
        event_id?: string;
      },
    ): Promise<{ id?: string }> {
      const endpoint = `/v2/users/${openid}/stream_messages`;
      const body: Record<string, unknown> = {
        input_mode: params.input_mode,
        input_state: params.input_state,
        content_type: params.content_type,
        content_raw: params.content_raw,
        msg_seq: params.msg_seq,
        index: params.index,
      };
      if (params.stream_msg_id) {
        body.stream_msg_id = params.stream_msg_id;
      }
      if (params.msg_id) {
        body.msg_id = params.msg_id;
      }
      if (params.event_id) {
        body.event_id = params.event_id;
      }
      const resp = await apiRequest<{ id?: string }>('POST', endpoint, body);
      // apiRequest only rejects HTTP >= 400. A 2xx business error means QQ
      // refused this chunk, which callers must not confuse with an ACK that
      // simply omits the id.
      const businessError = readQQBusinessError(resp);
      if (businessError) {
        throw new QQApiError(
          `QQ API POST ${endpoint} returned business error ${businessError.code}: ${businessError.message}`,
          businessError.code,
        );
      }
      return resp;
    },

    claimPassiveReply(
      chatId: string,
      options?: { reserve?: number },
    ): PassiveReplyClaim | undefined {
      return passiveReplies.claim(chatId, Date.now(), options);
    },

    rejectPassiveReply(chatId: string, msgId: string, error: unknown): boolean {
      return rejectPassiveReply(chatId, msgId, error);
    },

    async sendTypingIndicator(openid: string): Promise<boolean> {
      // Reserve the rest of the budget for real messages. The indicator is a
      // courtesy: dropping it costs nothing, while spending the last passive
      // reply on it would push an actual reply onto the active-push quota.
      // For the same reason it never falls back to an active push.
      const chatKey = `c2c:${openid}`;
      const claim = passiveReplies.claim(chatKey, Date.now(), {
        reserve: TYPING_PASSIVE_RESERVE,
      });
      if (!claim) return false;
      try {
        await apiRequest('POST', `/v2/users/${openid}/messages`, {
          msg_type: 6, // input notification
          input_notify: {
            input_type: 1, // "typing"
            input_second: TYPING_NOTIFY_SECONDS,
          },
          msg_id: claim.msgId,
          msg_seq: claim.msgSeq,
        });
        return true;
      } catch (error) {
        if (rejectPassiveReply(chatKey, claim.msgId, error)) return false;
        throw error;
      }
    },
  };

  return connection;
}
