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
import http from 'node:http';
import https from 'node:https';
import WebSocket from 'ws';
import {
  getRegisteredGroup,
  storeChatMetadata,
  storeMessageDirect,
  updateChatName,
} from './db.js';
import { notifyNewImMessage } from './message-notifier.js';
import { broadcastNewMessage } from './web.js';
import { logger } from './logger.js';
import { saveDownloadedFile, MAX_FILE_SIZE } from './im-downloader.js';
import { detectImageMimeTypeStrict } from './image-detector.js';
import path from 'node:path';
import { markdownToPlainText, splitTextChunks, createDedupCache } from './im-utils.js';
import { ProcessingLock, isStale } from './im-safety/index.js';
import {
  isTransientError,
  getReconnectDelay,
  classifyCloseCode,
} from './qq-reconnect.js';
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

const IMAGE_EXT_MAP: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

// ─── QQ File Upload Types & Constants ──────────────────────────

class QQApiError extends Error {
  constructor(
    message: string,
    public readonly bizCode?: number,
  ) {
    super(message);
    this.name = 'QQApiError';
  }
}

enum QQMediaFileType {
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

const QQ_FILE_MAX_SIZE = 30 * 1024 * 1024; // 30MB (consistent with other channels)
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

function getQQMediaFileType(fileName: string): QQMediaFileType {
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
            remaining >= buf.length
              ? buf
              : buf.subarray(0, remaining),
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
  /** Get next msg_seq for a chat (for stream session). */
  getNextMsgSeq(chatId: string): number;
  /** Latest msg_id received from a C2C openid, for passive reply. */
  getLastIncomingMsgId(openid: string): string | undefined;
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

  // Latest incoming msg_id per C2C openid, used as passive-reply reference
  // for stream_messages (QQ API rejects the endpoint without msg_id).
  const lastIncomingMsgId = new Map<string, string>();

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
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            try {
              const data = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
              if (!data.access_token) {
                reject(
                  new Error(
                    `QQ token response missing access_token: ${JSON.stringify(data)}`,
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
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
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
      if (bodyStr) req.write(bodyStr);
      req.end();
    });
  }

  async function getGatewayUrl(): Promise<string> {
    const data = await apiRequest<{ url: string }>('GET', '/gateway/bot');
    return data.url;
  }

  // ─── Message Sending ──────────────────────────────────────

  async function sendQQMessage(
    chatType: 'c2c' | 'group',
    openid: string,
    content: string,
  ): Promise<void> {
    const chatKey = `${chatType}:${openid}`;
    const msgSeq = getNextMsgSeq(chatKey);

    const endpoint =
      chatType === 'c2c'
        ? `/v2/users/${openid}/messages`
        : `/v2/groups/${openid}/messages`;

    await apiRequest('POST', endpoint, {
      markdown: { content },
      msg_type: 2, // markdown
      msg_seq: msgSeq,
    });
  }

  // ─── Image Sending ───────────────────────────────────────

  const QQ_UPLOAD_MAX_SIZE = 10 * 1024 * 1024; // 10MB

  async function uploadMedia(
    chatType: 'c2c' | 'group',
    openid: string,
    imageBuffer: Buffer,
  ): Promise<string> {
    if (imageBuffer.length > QQ_UPLOAD_MAX_SIZE) {
      throw new Error(
        `Image too large for QQ upload: ${(imageBuffer.length / 1024 / 1024).toFixed(1)}MB (max 10MB)`,
      );
    }

    // Check upload cache
    const md5 = crypto.createHash('md5').update(imageBuffer).digest('hex');
    const cached = getCachedFileInfo(md5, chatType, openid, QQMediaFileType.IMAGE);
    if (cached) return cached;

    const endpoint =
      chatType === 'c2c'
        ? `/v2/users/${openid}/files`
        : `/v2/groups/${openid}/files`;

    const res = await apiRequest<{ file_info: string; file_uuid?: string; ttl?: number }>(
      'POST',
      endpoint,
      {
        file_type: 1, // 1 = image
        file_data: imageBuffer.toString('base64'),
        srv_send_msg: false,
      },
    );
    if (!res.file_info) {
      throw new Error('QQ uploadMedia: no file_info in response');
    }

    // Cache the result
    if (res.ttl && res.ttl > 0) {
      setCachedFileInfo(md5, chatType, openid, QQMediaFileType.IMAGE, res.file_info, res.ttl);
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
    const msgSeq = getNextMsgSeq(chatKey);

    const endpoint =
      chatType === 'c2c'
        ? `/v2/users/${openid}/messages`
        : `/v2/groups/${openid}/messages`;

    await apiRequest('POST', endpoint, {
      msg_type: 7, // rich media
      media: { file_info: fileInfo },
      content: caption || '',
      msg_seq: msgSeq,
    });
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

    for (
      let attempt = 0;
      attempt <= COMPLETE_UPLOAD_MAX_RETRIES;
      attempt++
    ) {
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

    logger.info(
      { fileName, fileSize, fileType },
      'QQ chunked upload starting',
    );

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
      const md5Hex = crypto
        .createHash('md5')
        .update(partBuffer)
        .digest('hex');

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
      setCachedFileInfo(hashes.md5, chatType, openid, fileType, result.file_info, result.ttl);
    }

    return result.file_info;
  }

  async function sendQQFileMessage(
    chatType: 'c2c' | 'group',
    openid: string,
    filePath: string,
    fileName: string,
  ): Promise<void> {
    const stat = await fs.promises.stat(filePath);
    if (stat.size > QQ_FILE_MAX_SIZE) {
      throw new Error(
        `File too large for QQ upload: ${(stat.size / 1024 / 1024).toFixed(1)}MB (max ${QQ_FILE_MAX_SIZE / 1024 / 1024}MB)`,
      );
    }

    const fileType = getQQMediaFileType(fileName);
    const fileInfo = await chunkedUpload(
      chatType,
      openid,
      filePath,
      fileType,
    );

    const chatKey = `${chatType}:${openid}`;
    const msgSeq = getNextMsgSeq(chatKey);

    const endpoint =
      chatType === 'c2c'
        ? `/v2/users/${openid}/messages`
        : `/v2/groups/${openid}/messages`;

    await apiRequest('POST', endpoint, {
      msg_type: 7,
      media: { file_info: fileInfo },
      content: '',
      msg_seq: msgSeq,
    });
  }

  // ─── File Download ─────────────────────────────────────────

  async function downloadQQAttachment(
    url: string,
  ): Promise<Buffer | null> {
    try {
      const buffer = await new Promise<Buffer>((resolve, reject) => {
        const doRequest = (reqUrl: string, redirectCount: number = 0) => {
          if (redirectCount > 5) {
            reject(new Error('Too many redirects'));
            return;
          }
          const parsedUrl = new URL(reqUrl);
          const protocol = parsedUrl.protocol === 'https:' ? https : http;
          protocol
            .get(reqUrl, (res) => {
              if (
                res.statusCode &&
                res.statusCode >= 300 &&
                res.statusCode < 400 &&
                res.headers.location
              ) {
                doRequest(res.headers.location, redirectCount + 1);
                return;
              }
              const chunks: Buffer[] = [];
              let total = 0;
              res.on('data', (chunk: Buffer) => {
                total += chunk.length;
                if (total > MAX_FILE_SIZE) {
                  res.destroy(new Error('File exceeds MAX_FILE_SIZE'));
                  return;
                }
                chunks.push(chunk);
              });
              res.on('end', () => resolve(Buffer.concat(chunks)));
              res.on('error', reject);
            })
            .on('error', reject);
        };
        doRequest(url);
      });

      if (buffer.length === 0) return null;
      return buffer;
    } catch (err) {
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
  ): Promise<{ content: string; attachmentsJson?: string }> {
    if (!attachment.url) return { content };

    const attachUrl = attachment.url.startsWith('http')
      ? attachment.url
      : `https://${attachment.url}`;
    const buffer = await downloadQQAttachment(attachUrl);
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
          const relPath = await saveDownloadedFile(groupFolder, 'qq', fileName, buffer);
          if (relPath) content = `[图片: ${relPath}]\n${content}`.trim();
        } catch (err) {
          logger.warn({ err }, `Failed to save QQ ${logContext} image`);
        }
      }

      if (!content) content = '[图片]';
      return { content, attachmentsJson };
    }

    // Non-image file
    const urlFilename = attachment.filename
      || attachUrl.split('/').pop()?.split('?')[0]
      || `qq_file_${msgId.slice(-8)}`;
    const fileName = urlFilename.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fff]/g, '_');

    if (groupFolder) {
      try {
        const relPath = await saveDownloadedFile(groupFolder, 'qq', fileName, buffer);
        if (relPath) content = `[文件: ${relPath}]\n${content}`.trim();
      } catch (err) {
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

      ws.on('message', async (data) => {
        try {
          const payload: QQWsPayload = JSON.parse(data.toString());
          await handleWsMessage(payload, opts, gatewayUrl, onSessionReady);
        } catch (err) {
          logger.error({ err }, 'Error parsing QQ WebSocket message');
        }
      });

      ws.on('close', (code, reason) => {
        logger.info({ code, reason: reason.toString() }, 'QQ WebSocket closed');
        clearTimers();

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
            logger.info({ code }, 'QQ invalid token close, forcing token refresh');
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
    onSessionReady?: () => void,
  ): Promise<void> {
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
          await handleC2CMessage(eventData, opts);
        } else if (eventType === 'GROUP_AT_MESSAGE_CREATE') {
          await handleGroupMessage(eventData, opts);
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
  ): Promise<void> {
    try {
      const msgId = data.id;
      if (!msgId) return;
      const msgTimeMs = data.timestamp ? new Date(data.timestamp).getTime() : 0;
      if (isStale(msgTimeMs)) {
        logger.debug({ msgId, msgTimeMs }, 'Stale QQ C2C message (>30min), dropping');
        return;
      }
      if (dedup.isDuplicate(msgId)) return;
      if (!processingLock.acquire(msgId)) {
        logger.debug({ msgId }, 'QQ C2C message already in-flight, skipping');
        return;
      }
      dedup.markSeen(msgId);
      try {
      // Skip stale messages from before connection (hot-reload scenario)
      if (opts.ignoreMessagesBefore && data.timestamp) {
        const msgTime = new Date(data.timestamp).getTime();
        if (!isNaN(msgTime) && msgTime < opts.ignoreMessagesBefore) return;
      }

      const userOpenId = data.author?.id || data.author?.user_openid;
      if (!userOpenId) return;

      // Remember the latest incoming msg_id so stream_messages can use it as
      // the passive-reply reference (the endpoint rejects requests without one).
      lastIncomingMsgId.set(userOpenId, msgId);

      const jid = `qq:c2c:${userOpenId}`;
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

      // ── Authorized: process message ──
      storeChatMetadata(jid, new Date().toISOString());

      // QQ C2C payloads usually omit author.username, so naively writing
      // chatName here would clobber user-set names (the rename API writes
      // to both chats.name and registered_groups.name).  Only persist when
      // the platform gave us a real username; otherwise pass the existing
      // registered name through so buildOnNewChat's diff guard leaves it
      // untouched, and fall back to the placeholder only for first-time
      // registration.
      if (realName) {
        updateChatName(jid, realName);
        opts.onNewChat(jid, realName);
      } else {
        const existing = getRegisteredGroup(jid);
        opts.onNewChat(jid, existing?.name ?? chatName);
      }

      // Handle slash commands
      const slashMatch = content.match(/^\/(\S+)(?:\s+(.*))?$/i);
      if (slashMatch && opts.onCommand) {
        const cmdBody = (
          slashMatch[1] + (slashMatch[2] ? ' ' + slashMatch[2] : '')
        ).trim();
        try {
          // Namespace senderImId with `c2c:` prefix so owner_im_id 比对在
          // DM 与群聊上下文中独立——QQ Bot API v2 的 author.user_openid (C2C) 与
          // author.member_openid (Group) 是两个不同的 ID namespace，protocol
          // 层面不互通；前缀化让 DM 认领的 owner 与群里认领的 owner 各自落入
          // 独立记录，互不干扰。
          const reply = await opts.onCommand(jid, cmdBody, `c2c:${userOpenId}`);
          if (reply) {
            await sendQQMessage('c2c', userOpenId, markdownToPlainText(reply));
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
          data.attachments[0], msgId, jid, content, opts, 'c2c',
        );
        content = result.content;
        attachmentsJson = result.attachmentsJson;
      }

      // Route and store message
      const agentRouting = opts.resolveEffectiveChatJid?.(jid);
      const targetJid = agentRouting?.effectiveJid ?? jid;

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
      logger.error({ err }, 'Error handling QQ C2C message');
    }
  }

  async function handleGroupMessage(
    data: any,
    opts: QQConnectOpts,
  ): Promise<void> {
    try {
      const msgId = data.id;
      if (!msgId) return;
      const msgTimeMs = data.timestamp ? new Date(data.timestamp).getTime() : 0;
      if (isStale(msgTimeMs)) {
        logger.debug({ msgId, msgTimeMs }, 'Stale QQ group message (>30min), dropping');
        return;
      }
      if (dedup.isDuplicate(msgId)) return;
      if (!processingLock.acquire(msgId)) {
        logger.debug({ msgId }, 'QQ group message already in-flight, skipping');
        return;
      }
      dedup.markSeen(msgId);
      try {
      // Skip stale messages from before connection (hot-reload scenario)
      if (opts.ignoreMessagesBefore && data.timestamp) {
        const msgTime = new Date(data.timestamp).getTime();
        if (!isNaN(msgTime) && msgTime < opts.ignoreMessagesBefore) return;
      }

      const groupOpenId = data.group_openid;
      if (!groupOpenId) return;

      const jid = `qq:group:${groupOpenId}`;
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

      // ── Authorized: process message ──
      storeChatMetadata(jid, new Date().toISOString());

      // QQ group payloads don't carry a group name; chatName is always a
      // placeholder derived from groupOpenId.  Only write it on first-time
      // registration — otherwise we'd clobber user-set names (rename API).
      const existing = getRegisteredGroup(jid);
      if (!existing) {
        updateChatName(jid, chatName);
        opts.onNewChat(jid, chatName);
      } else {
        opts.onNewChat(jid, existing.name ?? chatName);
      }

      // Handle slash commands
      const slashMatch = content.match(/^\/(\S+)(?:\s+(.*))?$/i);
      if (slashMatch && opts.onCommand) {
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
          await sendQQMessage('group', groupOpenId, '命令执行失败，请稍后重试');
          return;
        }
      }

      // Handle attachments (images / files)
      let attachmentsJson: string | undefined;
      if (data.attachments?.length) {
        const result = await processQQAttachment(
          data.attachments[0], msgId, jid, content, opts, 'group',
        );
        content = result.content;
        attachmentsJson = result.attachmentsJson;
      }

      // Route and store
      const agentRouting = opts.resolveEffectiveChatJid?.(jid);
      const targetJid = agentRouting?.effectiveJid ?? jid;

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
        scheduleReconnect(opts);
      }
    },

    async disconnect(): Promise<void> {
      stopping = true;
      stopWatchdog();
      clearTimers();

      if (ws) {
        try {
          ws.close(1000, 'Disconnecting');
        } catch (err) {
          logger.debug({ err }, 'Error closing QQ WebSocket');
        }
        ws = null;
      }

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
      rejectTimestamps.clear();
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
        return;
      }

      try {
        const chunks = splitTextChunks(text, MSG_SPLIT_LIMIT);

        for (const chunk of chunks) {
          await sendQQMessage(parsed.type, parsed.openid, chunk);
        }

        // Send local images after text (same pattern as Feishu)
        for (const imgPath of localImagePaths || []) {
          try {
            const buf = fs.readFileSync(imgPath);
            await sendQQImageMessage(parsed.type, parsed.openid, buf);
            logger.info({ chatId, imgPath }, 'QQ local image sent');
          } catch (imgErr) {
            logger.warn(
              { err: imgErr, chatId, imgPath },
              'Failed to send local image via QQ',
            );
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
        return;
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
        return;
      }

      try {
        await sendQQFileMessage(
          parsed.type,
          parsed.openid,
          filePath,
          fileName,
        );
        logger.info({ chatId, fileName }, 'QQ file sent');
      } catch (err) {
        logger.error({ err, chatId, fileName }, 'Failed to send QQ file');
        throw err;
      }
    },

    async sendChatAction(_chatId: string, _action: 'typing'): Promise<void> {
      // QQ Bot API v2 does not support typing indicators
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
      return apiRequest<{ id?: string }>('POST', endpoint, body);
    },

    getNextMsgSeq(chatId: string): number {
      return getNextMsgSeq(chatId);
    },

    getLastIncomingMsgId(openid: string): string | undefined {
      return lastIncomingMsgId.get(openid);
    },
  };

  return connection;
}
