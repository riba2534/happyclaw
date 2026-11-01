// Enterprise WeCom intelligent-bot channel (WebSocket long connection).
//
// Security invariants:
// - pairing/admission and route resolution run before chat registration,
//   persistence, frame caching, broadcasts, or Agent notification;
// - every account supplies account-scoped authorization callbacks;
// - a streaming reply is bound to the exact durable inbound message id, so a
//   later message in the same chat cannot steal its req_id;
// - outbound promises resolve only after the SDK receives a successful ACK.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import {
  WSClient,
  decryptFile as decryptWeComFile,
  generateReqId,
} from '@wecom/aibot-node-sdk';
import type { BaseMessage, WsFrame } from '@wecom/aibot-node-sdk';
import {
  getMessage,
  getMessagePayload,
  sequenceInboundTimestampAfterChatTail,
  storeMessageDirect,
} from './db.js';
import { logger } from './logger.js';
import {
  evaluateChannelAdmission,
  resolveAdmittedChannelRoute,
} from './channel-admission.js';
import { createDedupCache } from './im-utils.js';
import { ProcessingLock } from './im-safety/processing-lock.js';
import {
  MAX_FILE_SIZE,
  sanitizeImFilename,
  saveDownloadedFile,
} from './im-downloader.js';
import { detectImageMimeTypeStrict } from './image-detector.js';
import { PhysicalDeliveryTracker } from './im-delivery-progress.js';
import { DefinitiveChannelDeliveryError } from './channel-outbox-delivery.js';
import {
  ImDeliveryPhaseError,
  preAcceptImDeliveryError,
} from './im-send-retry-policy.js';
import {
  WECOM_MARKDOWN_MAX_BYTES,
  WeComStreamingController,
} from './wecom-streaming.js';
import {
  groupSenderAdmission,
  isOwnerBootstrapCommand,
} from './im-group-audience.js';
import {
  offerChannelFollowUp,
  parseConnectorRuntimeControl,
  runSessionBreak,
  type ChannelFollowUpConnectOpts,
  type ChannelFollowUpOutcome,
} from './im-connector-follow-up.js';

const AUTH_TIMEOUT_MS = 15_000;
const MESSAGE_DEDUP_TTL_MS = 30 * 60_000;
const MESSAGE_DEDUP_MAX = 1000;
const FRAME_TTL_MS = 30 * 60_000;
const FRAME_CACHE_MAX = 1000;
const REJECT_COOLDOWN_MS = 60_000;
const PAGE_HEADER_RESERVE_BYTES = 64;
const IMAGE_MAX_BASE64_SIZE = 5 * 1024 * 1024;
const WECOM_MEDIA_MAX_PLAINTEXT_BYTES = Math.min(
  MAX_FILE_SIZE,
  20 * 1024 * 1024,
);
const WECOM_MEDIA_DOWNLOAD_TIMEOUT_MS = 15_000;
const WECOM_MIXED_MAX_IMAGES = 8;
const WECOM_MIXED_MAX_PLAINTEXT_BYTES = WECOM_MEDIA_MAX_PLAINTEXT_BYTES;
const WECOM_MIXED_MAX_BASE64_BYTES = 8 * 1024 * 1024;
const WECOM_PROGRESS_TTL_MS = 10 * 60_000;
const WECOM_PROGRESS_MAX_STAGED_BYTES = 32 * 1024 * 1024;
const WECOM_MEDIA_ACTIVE_LIMIT = 2;
const WECOM_MEDIA_QUEUE_LIMIT = 8;
const WECOM_GLOBAL_MEDIA_ACTIVE_LIMIT = 4;
const WECOM_GLOBAL_MEDIA_QUEUE_LIMIT = 32;
const WECOM_OUTBOUND_MEDIA_MAX_BYTES = Math.min(
  MAX_FILE_SIZE,
  50 * 1024 * 1024,
);

function assertWeComProviderAck(frame: unknown, operation: string): void {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) {
    throw new ImDeliveryPhaseError(
      'uncertain',
      `WeCom ${operation} returned no structured provider ACK`,
    );
  }
  const errcode = (frame as { errcode?: unknown }).errcode;
  if (errcode === 0) return;
  if (typeof errcode === 'number') {
    throw new DefinitiveChannelDeliveryError(
      `WeCom ${operation} was rejected with errcode ${errcode}`,
      { cause: frame },
    );
  }
  throw new ImDeliveryPhaseError(
    'uncertain',
    `WeCom ${operation} response omitted errcode`,
    { cause: frame },
  );
}

async function awaitWeComProviderAck(
  operation: string,
  send: () => Promise<unknown>,
): Promise<void> {
  let ack: unknown;
  try {
    ack = await send();
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      typeof (error as { errcode?: unknown }).errcode === 'number'
    ) {
      throw new DefinitiveChannelDeliveryError(
        `WeCom ${operation} was rejected with errcode ${String(
          (error as { errcode: number }).errcode,
        )}`,
        { cause: error },
      );
    }
    throw error;
  }
  assertWeComProviderAck(ack, operation);
}

function normalizeWeComOutboundFileName(
  fileName: string | undefined,
  fallback: string,
): string {
  return sanitizeImFilename(fileName || fallback);
}

class WeComMediaBusyError extends Error {
  readonly code = 'WECOM_MEDIA_BUSY';

  constructor(message = 'WeCom media downloader is busy') {
    super(message);
    this.name = 'WeComMediaBusyError';
  }
}

class WeComMediaCancelledError extends Error {
  readonly code = 'WECOM_MEDIA_CANCELLED';

  constructor(message = 'WeCom media operation was cancelled') {
    super(message);
    this.name = 'WeComMediaCancelledError';
  }
}

function throwIfWeComMediaCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new WeComMediaCancelledError();
}

interface WeComMediaWaiter {
  deadline: number;
  resolve: () => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  signal?: AbortSignal;
  onAbort?: () => void;
}

class WeComMediaSemaphore {
  private active = 0;
  private readonly queued: WeComMediaWaiter[] = [];
  private closed = false;

  constructor(
    private readonly activeLimit: number,
    private readonly queueLimit: number,
  ) {}

  async run<T>(
    totalDeadlineMs: number,
    task: (remainingMs: number) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const deadline = Date.now() + Math.max(1, totalDeadlineMs);
    await this.acquire(deadline, signal);
    try {
      if (signal?.aborted) throw new WeComMediaCancelledError();
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new WeComMediaBusyError(
          'WeCom media queue exceeded its total deadline',
        );
      }
      return await task(remainingMs);
    } finally {
      this.release();
    }
  }

  close(): void {
    this.closed = true;
    for (const entry of this.queued.splice(0)) {
      clearTimeout(entry.timer);
      if (entry.signal && entry.onAbort) {
        entry.signal.removeEventListener('abort', entry.onAbort);
      }
      entry.reject(new WeComMediaCancelledError('WeCom media queue closed'));
    }
  }

  private acquire(deadline: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.reject(new WeComMediaCancelledError());
    }
    if (this.closed) {
      return Promise.reject(
        new WeComMediaCancelledError('WeCom media queue closed'),
      );
    }
    if (this.active < this.activeLimit) {
      this.active += 1;
      return Promise.resolve();
    }
    if (this.queued.length >= this.queueLimit) {
      return Promise.reject(
        new WeComMediaBusyError('WeCom media queue capacity exceeded'),
      );
    }

    return new Promise<void>((resolve, reject) => {
      const remainingMs = Math.max(1, deadline - Date.now());
      let entry: WeComMediaWaiter;
      const onAbort = () => {
        const index = this.queued.indexOf(entry);
        if (index >= 0) this.queued.splice(index, 1);
        clearTimeout(entry.timer);
        reject(new WeComMediaCancelledError());
      };
      entry = {
        deadline,
        resolve,
        reject,
        signal,
        onAbort,
        timer: setTimeout(() => {
          const index = this.queued.indexOf(entry);
          if (index >= 0) this.queued.splice(index, 1);
          signal?.removeEventListener('abort', onAbort);
          reject(
            new WeComMediaBusyError(
              'WeCom media queue exceeded its total deadline',
            ),
          );
        }, remainingMs),
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.queued.push(entry);
    });
  }

  private release(): void {
    this.active = Math.max(0, this.active - 1);
    while (this.queued.length > 0) {
      const entry = this.queued.shift()!;
      clearTimeout(entry.timer);
      if (entry.signal && entry.onAbort) {
        entry.signal.removeEventListener('abort', entry.onAbort);
      }
      if (entry.signal?.aborted) {
        entry.reject(new WeComMediaCancelledError());
        continue;
      }
      if (entry.deadline <= Date.now()) {
        entry.reject(
          new WeComMediaBusyError(
            'WeCom media queue exceeded its total deadline',
          ),
        );
        continue;
      }
      this.active += 1;
      entry.resolve();
      break;
    }
  }
}

const globalWeComMediaSemaphore = new WeComMediaSemaphore(
  WECOM_GLOBAL_MEDIA_ACTIVE_LIMIT,
  WECOM_GLOBAL_MEDIA_QUEUE_LIMIT,
);

export interface WeComDownloadedMedia {
  buffer: Buffer;
  filename?: string;
}

function contentDispositionFilename(
  value: string | undefined,
): string | undefined {
  if (!value) return undefined;
  const utf8 = value.match(/filename\*=UTF-8''([^;\s]+)/i)?.[1];
  const plain = value.match(/filename="?([^";\s]+)"?/i)?.[1];
  const encoded = utf8 ?? plain;
  if (!encoded) return undefined;
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

export async function downloadAndDecryptWeComMedia(
  url: string,
  aesKey: string | undefined,
  maxPlaintextBytes = WECOM_MEDIA_MAX_PLAINTEXT_BYTES,
  timeoutMs = WECOM_MEDIA_DOWNLOAD_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<WeComDownloadedMedia> {
  throwIfWeComMediaCancelled(signal);
  const encryptedLimit = maxPlaintextBytes + (aesKey ? 32 : 0);
  const downloaded = await new Promise<WeComDownloadedMedia>(
    (resolve, reject) => {
      const deadline = Date.now() + Math.max(1, timeoutMs);
      let activeRequest: http.ClientRequest | null = null;
      let settled = false;
      let deadlineTimer: NodeJS.Timeout;
      let onAbort: (() => void) | undefined;
      const finishResolve = (value: WeComDownloadedMedia): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadlineTimer);
        if (onAbort) signal?.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const finishReject = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadlineTimer);
        if (onAbort) signal?.removeEventListener('abort', onAbort);
        reject(error);
      };
      deadlineTimer = setTimeout(
        () => {
          const request = activeRequest;
          finishReject(
            new Error(`WeCom media request timed out after ${timeoutMs}ms`),
          );
          request?.destroy();
        },
        Math.max(1, timeoutMs),
      );
      onAbort = () => {
        const request = activeRequest;
        finishReject(new WeComMediaCancelledError());
        request?.destroy();
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      const requestUrl = (current: URL, redirects: number): void => {
        if (!['http:', 'https:'].includes(current.protocol)) {
          finishReject(
            new Error(`Unsupported WeCom media protocol: ${current.protocol}`),
          );
          return;
        }
        if (redirects > 5) {
          finishReject(new Error('Too many WeCom media redirects'));
          return;
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          finishReject(
            new Error(`WeCom media request timed out after ${timeoutMs}ms`),
          );
          return;
        }
        const transport = current.protocol === 'https:' ? https : http;
        const req = transport.request(current, (res) => {
          const status = res.statusCode ?? 0;
          if (status >= 300 && status < 400) {
            const location = res.headers.location;
            res.destroy();
            if (!location) {
              finishReject(
                new Error(`WeCom media redirect ${status} has no Location`),
              );
              return;
            }
            let next: URL;
            try {
              next = new URL(location, current);
            } catch (error) {
              finishReject(
                new Error('Invalid WeCom media redirect URL', { cause: error }),
              );
              return;
            }
            if (current.protocol === 'https:' && next.protocol !== 'https:') {
              finishReject(
                new Error(
                  `Refusing WeCom media HTTPS downgrade redirect to ${next.protocol}`,
                ),
              );
              return;
            }
            requestUrl(next, redirects + 1);
            return;
          }
          if (status < 200 || status >= 300) {
            res.destroy();
            finishReject(new Error(`WeCom media GET HTTP failed (${status})`));
            return;
          }
          const declared = Number(res.headers['content-length']);
          if (Number.isFinite(declared) && declared > encryptedLimit) {
            res.destroy();
            finishReject(
              new Error('WeCom encrypted media exceeds the byte limit'),
            );
            return;
          }
          const chunks: Buffer[] = [];
          let total = 0;
          let exceeded = false;
          res.on('data', (chunk: Buffer) => {
            if (exceeded) return;
            total += chunk.length;
            if (total > encryptedLimit) {
              exceeded = true;
              res.destroy(
                new Error('WeCom encrypted media exceeds the byte limit'),
              );
              return;
            }
            chunks.push(chunk);
          });
          res.on('end', () => {
            if (exceeded) return;
            finishResolve({
              buffer: Buffer.concat(chunks, total),
              filename: contentDispositionFilename(
                typeof res.headers['content-disposition'] === 'string'
                  ? res.headers['content-disposition']
                  : undefined,
              ),
            });
          });
          res.on('error', (error) => {
            if (activeRequest === req) finishReject(error);
          });
        });
        activeRequest = req;
        req.on('error', (error) => {
          if (activeRequest === req) finishReject(error);
        });
        req.setTimeout(remainingMs, () => {
          req.destroy(
            new Error(`WeCom media request timed out after ${remainingMs}ms`),
          );
        });
        req.end();
      };

      let initial: URL;
      try {
        initial = new URL(url);
      } catch (error) {
        finishReject(new Error('Invalid WeCom media URL', { cause: error }));
        return;
      }
      requestUrl(initial, 0);
    },
  );

  throwIfWeComMediaCancelled(signal);
  const buffer = aesKey
    ? decryptWeComFile(downloaded.buffer, aesKey)
    : downloaded.buffer;
  if (buffer.length > maxPlaintextBytes) {
    throw new Error('WeCom decrypted media exceeds the plaintext byte limit');
  }
  return { buffer, filename: downloaded.filename };
}

export type WeComConnectionState =
  | { status: 'connecting' }
  | { status: 'connected' }
  | { status: 'reconnecting'; attempt: number }
  | { status: 'disconnected'; error?: string }
  | { status: 'error'; error: string };

export interface WeComConnectionConfig {
  botId: string;
  secret: string;
  corpId?: string;
  channelAccountId?: string;
  /** Test-only override; production uses a bounded 15-second authentication wait. */
  authTimeoutMs?: number;
  /** Test-only bounded media downloader override. */
  mediaDownloader?: (
    url: string,
    aesKey: string | undefined,
    maxPlaintextBytes?: number,
    timeoutMs?: number,
    signal?: AbortSignal,
  ) => Promise<WeComDownloadedMedia>;
  /** Test-only total media queue + download deadline. */
  mediaDownloadTimeoutMs?: number;
}

export interface WeComConnectOpts extends ChannelFollowUpConnectOpts {
  onReady?: () => void;
  onNewChat: (jid: string, name: string) => void;
  ignoreMessagesBefore?: number;
  isChatAuthorized?: (jid: string) => boolean;
  onPairAttempt?: (
    jid: string,
    chatName: string,
    code: string,
  ) => Promise<boolean>;
  onConnectionStateChange?: (state: WeComConnectionState) => void;
  onCommand?: (
    chatJid: string,
    command: string,
    senderImId?: string,
  ) => Promise<string | null>;
  resolveGroupFolder?: (jid: string) => string | undefined;
  resolveEffectiveChatJid?: (chatJid: string) => {
    effectiveJid: string;
    agentId: string | null;
    sourceJid?: string;
  } | null;
  onAgentMessage?: (baseChatJid: string, agentId: string) => void;
  onMessagePersisted?: import('./channel-contracts.js').OnChannelMessagePersisted;
  normalizeIncomingJid?: (jid: string) => string | null;
  shouldProcessGroupMessage?: (chatJid: string, senderImId?: string) => boolean;
  isGroupOwnerMessage?: (chatJid: string, senderImId?: string) => boolean;
  isSenderAllowedInGroup?: (chatJid: string, senderImId?: string) => boolean;
  resolveRegisteredGroup?: (jid: string) =>
    | {
        activation_mode?: string;
        owner_im_id?: string;
        owner_claim_source?: string;
      }
    | undefined;
}

export interface WeComConnection {
  connect(opts: WeComConnectOpts): Promise<void>;
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
  createStreamingSession(
    chatId: string,
    inputMessageId?: string,
  ): Promise<WeComStreamingController | undefined>;
  isConnected(): boolean;
}

interface CachedInboundFrame {
  frame: WsFrame<BaseMessage>;
  chatId: string;
  expiresAt: number;
}

type WeComGroupMentionState = 'provider_mentioned' | 'not_group';

interface WeComInboundProgress {
  expiresAt: number;
  stagedBytes: number;
  sourceJid: string;
  targetJid: string;
  agentId: string | null;
  timestamp?: string;
  content?: string;
  attachmentsJson?: string;
  normalized?: boolean;
  registered?: boolean;
  stored?: boolean;
  frameCached?: boolean;
  /** Host follow-up decision, taken once per stored input. */
  followUp?: ChannelFollowUpOutcome;
  broadcast?: boolean;
  notified?: boolean;
  agentNotified?: boolean;
}

/**
 * WeCom's intelligent-bot API emits a group message callback only after the
 * user @mentions the bot. The official TextMessage payload consequently has no
 * separate mention boolean (and may retain the display mention in text). Treat
 * the provider callback itself as structured mention evidence; never guess by
 * parsing a user-controlled "@name" prefix.
 */
function weComGroupMentionState(body: BaseMessage): WeComGroupMentionState {
  return body.chattype === 'group' ? 'provider_mentioned' : 'not_group';
}

function stableWeComInboundId(input: {
  accountId?: string;
  botId: string;
  providerChatId: string;
  eventId: string;
}): string {
  const digest = crypto
    .createHash('sha256')
    .update(
      [
        'wecom',
        input.accountId || input.botId,
        input.providerChatId,
        input.eventId,
      ].join('\u0000'),
    )
    .digest('hex');
  return `wecom_${digest}`;
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** Split without cutting a Unicode code point. Prefer a recent line/space boundary. */
export function splitWeComMarkdown(
  text: string,
  maxBytes = WECOM_MARKDOWN_MAX_BYTES,
): string[] {
  if (maxBytes <= 0) throw new Error('maxBytes must be positive');
  const value = text.trim();
  if (!value) return [];
  if (utf8Bytes(value) <= maxBytes) return [value];

  const chunks: string[] = [];
  let remaining = value;
  while (utf8Bytes(remaining) > maxBytes) {
    let bytes = 0;
    let end = 0;
    let preferredEnd = 0;
    for (const char of remaining) {
      const charBytes = utf8Bytes(char);
      if (bytes + charBytes > maxBytes) break;
      bytes += charBytes;
      end += char.length;
      if (/\s/u.test(char) && bytes >= maxBytes * 0.65) preferredEnd = end;
    }
    const splitAt = preferredEnd || end;
    if (splitAt <= 0) throw new Error('Unable to paginate WeCom message');
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function sdkChatId(chatId: string): string {
  if (chatId.startsWith('c2c:')) return chatId.slice('c2c:'.length);
  if (chatId.startsWith('group:')) return chatId.slice('group:'.length);
  return chatId;
}

export function createWeComConnection(
  config: WeComConnectionConfig,
): WeComConnection {
  let ws: WSClient | null = null;
  let authenticated = false;
  let opts: WeComConnectOpts | null = null;
  let intentionalDisconnect = false;
  let connectionGeneration = 0;
  const mediaAbortController = new AbortController();
  const logCtx = { accountId: config.channelAccountId, botId: config.botId };
  const rawDownloadMedia =
    config.mediaDownloader ?? downloadAndDecryptWeComMedia;
  const mediaSemaphore = new WeComMediaSemaphore(
    WECOM_MEDIA_ACTIVE_LIMIT,
    WECOM_MEDIA_QUEUE_LIMIT,
  );
  const downloadMedia = (
    url: string,
    aesKey: string | undefined,
    maxPlaintextBytes: number,
    generation: number,
    signal: AbortSignal,
  ) =>
    mediaSemaphore
      .run(
        config.mediaDownloadTimeoutMs ?? WECOM_MEDIA_DOWNLOAD_TIMEOUT_MS,
        (remainingMs) =>
          globalWeComMediaSemaphore.run(
            remainingMs,
            (globalRemainingMs) =>
              rawDownloadMedia(
                url,
                aesKey,
                maxPlaintextBytes,
                globalRemainingMs,
                signal,
              ),
            signal,
          ),
        signal,
      )
      .then((downloaded) => {
        assertConnectionGeneration(generation, signal);
        return downloaded;
      });
  const dedup = createDedupCache({
    ttlMs: MESSAGE_DEDUP_TTL_MS,
    max: MESSAGE_DEDUP_MAX,
  });
  const processingLock = new ProcessingLock();
  const rejectTimestamps = new Map<string, number>();
  // A provider retry in the same process resumes after the last completed
  // effect instead of repeating registration, persistence, Web projection, or
  // Agent notification. The durable stable message id covers reconnect/restart
  // replays after persistence has already committed.
  const inboundProgress = new Map<string, WeComInboundProgress>();
  let inboundProgressBytes = 0;
  // Once a command handler resolves, retain only its reply across a provider
  // retry. This lets a failed transport ACK retry sendReply without executing
  // a potentially mutating command twice.
  const commandReplies = new Map<string, string | null>();

  /**
   * Run a command once per provider event. The handler may commit state and
   * then throw, so a failure caches a terminal reply: a transport retry of
   * the same event never replays an uncertain mutation.
   */
  async function settleCommandReply(
    dedupKey: string,
    jid: string,
    command: string | undefined,
    run: () => Promise<string | null>,
  ): Promise<string | null> {
    if (!commandReplies.has(dedupKey)) {
      while (commandReplies.size >= MESSAGE_DEDUP_MAX) {
        const oldest = commandReplies.keys().next().value;
        if (oldest === undefined) break;
        commandReplies.delete(oldest);
      }
      try {
        commandReplies.set(dedupKey, (await run()) ?? null);
      } catch (error) {
        logger.error(
          { ...logCtx, jid, command, error },
          'WeCom slash command failed',
        );
        commandReplies.set(dedupKey, '命令执行失败，请稍后重试。');
      }
    }
    return commandReplies.get(dedupKey) ?? null;
  }
  // Exact durable input id -> original callback frame. Map insertion order is
  // the LRU order; a session removes its entry and retains the frozen frame.
  const inboundFrames = new Map<string, CachedInboundFrame>();

  function assertConnectionGeneration(
    generation: number,
    signal: AbortSignal,
  ): void {
    if (
      generation !== connectionGeneration ||
      signal !== mediaAbortController.signal ||
      signal.aborted
    ) {
      throw new WeComMediaCancelledError();
    }
  }

  function assertOutboundConnection(
    client: WSClient,
    generation: number,
    signal: AbortSignal,
  ): void {
    assertConnectionGeneration(generation, signal);
    if (ws !== client || !authenticated) {
      throw new WeComMediaCancelledError(
        'WeCom outbound operation lost its authenticated connection',
      );
    }
  }

  async function sendOutboundMedia(
    client: WSClient,
    generation: number,
    signal: AbortSignal,
    chatId: string,
    mediaType: 'image' | 'file',
    buffer: Buffer,
    fileName: string,
  ): Promise<void> {
    assertOutboundConnection(client, generation, signal);
    if (buffer.length === 0 || buffer.length > WECOM_OUTBOUND_MEDIA_MAX_BYTES) {
      throw preAcceptImDeliveryError(
        `WeCom outbound ${mediaType} has invalid size ${buffer.length}`,
      );
    }
    if (mediaType === 'image' && !detectImageMimeTypeStrict(buffer)) {
      throw preAcceptImDeliveryError(
        `WeCom outbound image is not a supported image: ${fileName}`,
      );
    }

    let mediaId: string;
    try {
      const uploaded = await client.uploadMedia(buffer, {
        type: mediaType,
        filename: normalizeWeComOutboundFileName(
          fileName,
          mediaType === 'image' ? 'image.png' : 'file.bin',
        ),
      });
      mediaId = uploaded?.media_id?.trim() ?? '';
    } catch (error) {
      throw preAcceptImDeliveryError(
        `WeCom ${mediaType} upload failed before visible send`,
        error,
      );
    }
    if (!mediaId) {
      throw preAcceptImDeliveryError(
        `WeCom ${mediaType} upload returned no media_id`,
      );
    }

    assertOutboundConnection(client, generation, signal);
    await awaitWeComProviderAck(`${mediaType} send`, () =>
      client.sendMediaMessage(sdkChatId(chatId), mediaType, mediaId),
    );
  }

  function clearProgressPayload(progress: WeComInboundProgress): void {
    inboundProgressBytes = Math.max(
      0,
      inboundProgressBytes - progress.stagedBytes,
    );
    progress.stagedBytes = 0;
    progress.content = undefined;
    progress.attachmentsJson = undefined;
  }

  function deleteProgress(key: string): void {
    const progress = inboundProgress.get(key);
    if (progress) clearProgressPayload(progress);
    inboundProgress.delete(key);
  }

  function pruneProgress(now = Date.now(), preserveKey?: string): void {
    for (const [key, progress] of inboundProgress) {
      if (key !== preserveKey && progress.expiresAt <= now) deleteProgress(key);
    }
    while (inboundProgress.size >= MESSAGE_DEDUP_MAX) {
      const oldest = [...inboundProgress.keys()].find(
        (key) => key !== preserveKey,
      );
      if (!oldest) break;
      deleteProgress(oldest);
    }
  }

  function stageProgressPayload(
    key: string,
    progress: WeComInboundProgress,
    content: string,
    attachmentsJson: string | undefined,
    generation: number,
    signal: AbortSignal,
  ): void {
    assertConnectionGeneration(generation, signal);
    clearProgressPayload(progress);
    const stagedBytes =
      Buffer.byteLength(content, 'utf8') +
      Buffer.byteLength(attachmentsJson ?? '', 'utf8');
    for (const candidate of [...inboundProgress.keys()]) {
      if (
        inboundProgressBytes + stagedBytes <=
        WECOM_PROGRESS_MAX_STAGED_BYTES
      ) {
        break;
      }
      if (candidate !== key) deleteProgress(candidate);
    }
    if (stagedBytes > WECOM_PROGRESS_MAX_STAGED_BYTES) {
      throw new Error('WeCom staged inbound payload exceeds memory budget');
    }
    progress.content = content;
    progress.attachmentsJson = attachmentsJson;
    progress.stagedBytes = stagedBytes;
    progress.expiresAt = Date.now() + WECOM_PROGRESS_TTL_MS;
    inboundProgressBytes += stagedBytes;
  }

  function emitState(state: WeComConnectionState): void {
    try {
      opts?.onConnectionStateChange?.(state);
    } catch (error) {
      logger.warn({ ...logCtx, error }, 'WeCom state listener failed');
    }
  }

  function pruneFrames(now = Date.now()): void {
    for (const [inputId, cached] of inboundFrames) {
      if (cached.expiresAt > now) break;
      inboundFrames.delete(inputId);
    }
    while (inboundFrames.size > FRAME_CACHE_MAX) {
      const oldest = inboundFrames.keys().next().value;
      if (oldest === undefined) break;
      inboundFrames.delete(oldest);
    }
  }

  function cacheFrame(
    inputMessageId: string,
    chatId: string,
    frame: WsFrame<BaseMessage>,
  ): void {
    pruneFrames();
    inboundFrames.delete(inputMessageId);
    inboundFrames.set(inputMessageId, {
      frame,
      chatId,
      expiresAt: Date.now() + FRAME_TTL_MS,
    });
    pruneFrames();
  }

  async function sendReply(
    client: WSClient,
    frame: WsFrame<BaseMessage>,
    text: string,
  ): Promise<void> {
    await client.replyStream(frame, generateReqId('reply'), text, true);
  }

  async function sendMarkdownPages(
    client: WSClient,
    chatId: string,
    text: string,
  ): Promise<void> {
    const pageLimit = WECOM_MARKDOWN_MAX_BYTES - PAGE_HEADER_RESERVE_BYTES;
    const pages = splitWeComMarkdown(text, pageLimit);
    const tracker = new PhysicalDeliveryTracker(pages.length);
    for (let index = 0; index < pages.length; index += 1) {
      const header =
        pages.length > 1 ? `（${index + 1}/${pages.length}）\n` : '';
      const content = `${header}${pages[index]}`;
      if (utf8Bytes(content) > WECOM_MARKDOWN_MAX_BYTES) {
        throw new Error('WeCom pagination exceeded the provider byte limit');
      }
      // The SDK rejects on a timeout or non-zero errcode; awaiting each page
      // makes a resolved delivery promise a strict provider ACK.
      await tracker.send(() =>
        awaitWeComProviderAck('markdown send', () =>
          client.sendMessage(sdkChatId(chatId), {
            msgtype: 'markdown',
            markdown: { content },
          }),
        ),
      );
    }
  }

  function rawConversationJid(body: BaseMessage): {
    jid: string;
    providerChatId: string;
    isGroup: boolean;
  } | null {
    if (body.chattype === 'group') {
      if (!body.chatid) return null;
      return {
        jid: `wecom:group:${body.chatid}`,
        providerChatId: body.chatid,
        isGroup: true,
      };
    }
    const userId = body.from?.userid;
    if (!userId) return null;
    return {
      jid: `wecom:c2c:${userId}`,
      providerChatId: userId,
      isGroup: false,
    };
  }

  function extractInboundAdmissionText(body: BaseMessage): string {
    const msgtype = body.msgtype;
    if (msgtype === 'text') {
      return typeof body.text?.content === 'string'
        ? body.text.content.trim()
        : '';
    }
    if (msgtype === 'voice') {
      const transcript =
        typeof body.voice?.content === 'string'
          ? body.voice.content.trim()
          : '';
      return transcript || '[语音消息]';
    }
    if (msgtype === 'mixed') {
      const items = Array.isArray(body.mixed?.msg_item)
        ? body.mixed.msg_item
        : [];
      const texts = items
        .filter((item: { msgtype?: string }) => item?.msgtype === 'text')
        .map((item: { text?: { content?: string } }) =>
          typeof item.text?.content === 'string'
            ? item.text.content.trim()
            : '',
        )
        .filter(Boolean);
      return texts.length > 0 ? texts.join('\n') : '[图文消息]';
    }
    if (msgtype === 'image') return '[图片]';
    if (msgtype === 'file') return '[文件]';
    if (msgtype === 'video') return '[视频消息]';
    return '';
  }

  interface WeComImageAttachment {
    type: 'image';
    data: string;
    mimeType: string;
  }

  interface NormalizedWeComInbound {
    content: string;
    attachments: WeComImageAttachment[];
    plaintextBytes?: number;
    base64Bytes?: number;
  }

  function workspaceFolder(sourceJid: string, targetJid: string) {
    return (
      opts?.resolveGroupFolder?.(targetJid) ??
      opts?.resolveGroupFolder?.(sourceJid)
    );
  }

  async function downloadInboundImage(
    image: { url?: string; aeskey?: string } | undefined,
    sourceJid: string,
    targetJid: string,
    fallbackName: string,
    generation: number,
    signal: AbortSignal,
    limits: { plaintextBytes?: number; base64Bytes?: number } = {},
  ): Promise<NormalizedWeComInbound> {
    if (!image?.url) {
      logger.warn({ ...logCtx, sourceJid }, 'WeCom image missing download URL');
      return { content: '[图片]', attachments: [] };
    }
    try {
      const plaintextLimit = Math.min(
        WECOM_MEDIA_MAX_PLAINTEXT_BYTES,
        limits.plaintextBytes ?? WECOM_MEDIA_MAX_PLAINTEXT_BYTES,
      );
      const downloaded = await downloadMedia(
        image.url,
        image.aeskey,
        plaintextLimit,
        generation,
        signal,
      );
      assertConnectionGeneration(generation, signal);
      const buffer = downloaded.buffer;
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        logger.warn({ ...logCtx, sourceJid }, 'WeCom image download was empty');
        return { content: '[图片]', attachments: [] };
      }
      if (buffer.length > plaintextLimit) {
        logger.warn(
          { ...logCtx, sourceJid, size: buffer.length },
          'WeCom image exceeds inbound file limit',
        );
        return { content: '[图片（文件过大）]', attachments: [] };
      }

      assertConnectionGeneration(generation, signal);
      const mimeType = detectImageMimeTypeStrict(buffer);
      const base64Limit = limits.base64Bytes ?? Number.POSITIVE_INFINITY;
      const encodedBytes = Math.ceil(buffer.length / 3) * 4;
      const base64 =
        mimeType &&
        buffer.length <= IMAGE_MAX_BASE64_SIZE &&
        encodedBytes <= base64Limit
          ? buffer.toString('base64')
          : undefined;
      const attachments: WeComImageAttachment[] = [];
      if (
        base64 &&
        mimeType &&
        Buffer.byteLength(base64, 'ascii') <= base64Limit
      ) {
        attachments.push({ type: 'image', data: base64, mimeType });
      }
      const usage = {
        plaintextBytes: buffer.length,
        base64Bytes: attachments.length > 0 ? base64!.length : 0,
      };
      const fileName = sanitizeImFilename(downloaded.filename || fallbackName);
      const folder = workspaceFolder(sourceJid, targetJid);
      if (!folder) {
        logger.debug(
          { ...logCtx, sourceJid, targetJid },
          'WeCom image has no workspace folder; retaining inline attachment only',
        );
        return { content: '[图片]', attachments, ...usage };
      }
      try {
        assertConnectionGeneration(generation, signal);
        const savedPath = await saveDownloadedFile(
          folder,
          'wecom',
          fileName,
          buffer,
          targetJid,
        );
        assertConnectionGeneration(generation, signal);
        return { content: `[图片: ${savedPath}]`, attachments, ...usage };
      } catch (error) {
        if (error instanceof WeComMediaCancelledError) throw error;
        assertConnectionGeneration(generation, signal);
        logger.warn(
          { ...logCtx, sourceJid, targetJid, error },
          'Failed to save WeCom image to workspace',
        );
        return { content: '[图片（保存失败）]', attachments, ...usage };
      }
    } catch (error) {
      if (error instanceof WeComMediaCancelledError) throw error;
      assertConnectionGeneration(generation, signal);
      if (error instanceof WeComMediaBusyError) {
        logger.warn(
          { ...logCtx, sourceJid, error },
          'WeCom image skipped because the media queue is busy',
        );
        return {
          content: '[图片（系统繁忙未下载）]',
          attachments: [],
        };
      }
      logger.warn(
        { ...logCtx, sourceJid, error },
        'Failed to download WeCom image',
      );
      return { content: '[图片]', attachments: [] };
    }
  }

  async function downloadInboundFile(
    media: { url?: string; aeskey?: string } | undefined,
    sourceJid: string,
    targetJid: string,
    kind: 'file' | 'video',
    generation: number,
    signal: AbortSignal,
  ): Promise<NormalizedWeComInbound> {
    const label = kind === 'video' ? '视频' : '文件';
    if (!media?.url) {
      logger.warn(
        { ...logCtx, sourceJid, kind },
        `WeCom ${kind} missing download URL`,
      );
      return { content: `[${label}]`, attachments: [] };
    }
    try {
      const downloaded = await downloadMedia(
        media.url,
        media.aeskey,
        WECOM_MEDIA_MAX_PLAINTEXT_BYTES,
        generation,
        signal,
      );
      assertConnectionGeneration(generation, signal);
      const buffer = downloaded.buffer;
      if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
        logger.warn(
          { ...logCtx, sourceJid, kind },
          `WeCom ${kind} download was empty`,
        );
        return { content: `[${label}]`, attachments: [] };
      }
      if (buffer.length > MAX_FILE_SIZE) {
        logger.warn(
          { ...logCtx, sourceJid, kind, size: buffer.length },
          `WeCom ${kind} exceeds inbound file limit`,
        );
        return { content: `[${label}（文件过大）]`, attachments: [] };
      }
      const fallbackName =
        kind === 'video' ? `video_${Date.now()}.mp4` : `file_${Date.now()}`;
      const fileName = sanitizeImFilename(downloaded.filename || fallbackName);
      const folder = workspaceFolder(sourceJid, targetJid);
      if (!folder) {
        logger.warn(
          { ...logCtx, sourceJid, targetJid, kind },
          `WeCom ${kind} has no workspace folder`,
        );
        return {
          content: `[${label}: ${fileName}（未注册群组）]`,
          attachments: [],
        };
      }
      try {
        assertConnectionGeneration(generation, signal);
        const savedPath = await saveDownloadedFile(
          folder,
          'wecom',
          fileName,
          buffer,
          targetJid,
        );
        assertConnectionGeneration(generation, signal);
        return { content: `[${label}: ${savedPath}]`, attachments: [] };
      } catch (error) {
        if (error instanceof WeComMediaCancelledError) throw error;
        assertConnectionGeneration(generation, signal);
        logger.warn(
          { ...logCtx, sourceJid, targetJid, kind, error },
          `Failed to save WeCom ${kind} to workspace`,
        );
        return {
          content: `[${label}: ${fileName}（保存失败）]`,
          attachments: [],
        };
      }
    } catch (error) {
      if (error instanceof WeComMediaCancelledError) throw error;
      assertConnectionGeneration(generation, signal);
      if (error instanceof WeComMediaBusyError) {
        logger.warn(
          { ...logCtx, sourceJid, kind, error },
          `WeCom ${kind} skipped because the media queue is busy`,
        );
        return {
          content: `[${label}（系统繁忙未下载）]`,
          attachments: [],
        };
      }
      logger.warn(
        { ...logCtx, sourceJid, kind, error },
        `Failed to download WeCom ${kind}`,
      );
      return { content: `[${label}（下载失败）]`, attachments: [] };
    }
  }

  async function normalizeInbound(
    body: BaseMessage,
    sourceJid: string,
    targetJid: string,
    generation: number,
    signal: AbortSignal,
  ): Promise<NormalizedWeComInbound> {
    // Group and single-chat media share one path: the same download limits,
    // the same workspace folder and the same failure markers.
    const msgtype = body.msgtype;
    if (msgtype === 'text' || msgtype === 'voice') {
      return { content: extractInboundAdmissionText(body), attachments: [] };
    }
    if (msgtype === 'image') {
      return downloadInboundImage(
        body.image,
        sourceJid,
        targetJid,
        `image_${Date.now()}.jpg`,
        generation,
        signal,
      );
    }
    if (msgtype === 'file' || msgtype === 'video') {
      return downloadInboundFile(
        msgtype === 'video' ? body.video : body.file,
        sourceJid,
        targetJid,
        msgtype,
        generation,
        signal,
      );
    }
    if (msgtype === 'mixed') {
      const items = Array.isArray(body.mixed?.msg_item)
        ? body.mixed.msg_item
        : [];
      const parts: string[] = [];
      const attachments: WeComImageAttachment[] = [];
      let imageIndex = 0;
      let plaintextBytes = 0;
      let base64Bytes = 0;
      let limitMarkerAdded = false;
      for (const item of items) {
        assertConnectionGeneration(generation, signal);
        if (item?.msgtype === 'text') {
          const text = item.text?.content?.trim();
          if (text) parts.push(text);
        } else if (item?.msgtype === 'image') {
          if (
            imageIndex >= WECOM_MIXED_MAX_IMAGES ||
            plaintextBytes >= WECOM_MIXED_MAX_PLAINTEXT_BYTES
          ) {
            if (!limitMarkerAdded) {
              parts.push('[其余图片因数量或总大小限制已跳过]');
              limitMarkerAdded = true;
            }
            logger.warn(
              { ...logCtx, sourceJid, imageIndex, plaintextBytes },
              'WeCom mixed image limits reached',
            );
            continue;
          }
          imageIndex += 1;
          const normalized = await downloadInboundImage(
            item.image,
            sourceJid,
            targetJid,
            `mixed_image_${Date.now()}_${imageIndex}.jpg`,
            generation,
            signal,
            {
              plaintextBytes: WECOM_MIXED_MAX_PLAINTEXT_BYTES - plaintextBytes,
              base64Bytes: WECOM_MIXED_MAX_BASE64_BYTES - base64Bytes,
            },
          );
          plaintextBytes += normalized.plaintextBytes ?? 0;
          base64Bytes += normalized.base64Bytes ?? 0;
          if (normalized.content) parts.push(normalized.content);
          attachments.push(...normalized.attachments);
        }
      }
      return {
        content: parts.join('\n') || '[图文消息]',
        attachments,
        plaintextBytes,
        base64Bytes,
      };
    }
    return { content: '', attachments: [] };
  }

  async function handleInbound(frame: WsFrame<BaseMessage>): Promise<void> {
    const generation = connectionGeneration;
    const signal = mediaAbortController.signal;
    if (signal.aborted) return;
    const body = frame.body;
    if (!body) return;
    const conversation = rawConversationJid(body);
    if (!conversation) return;
    const eventId = body.msgid || frame.headers?.req_id;
    if (!eventId) return;
    const dedupKey = `${conversation.providerChatId}\u0000${eventId}`;
    if (dedup.isDuplicate(dedupKey)) return;
    if (!processingLock.acquire(dedupKey)) return;
    dedup.markSeen(dedupKey);

    try {
      assertConnectionGeneration(generation, signal);
      const createdAt = body.create_time ? body.create_time * 1000 : 0;
      if (
        opts?.ignoreMessagesBefore &&
        (!createdAt || createdAt < opts.ignoreMessagesBefore)
      ) {
        return;
      }

      let jid = conversation.jid;
      if (opts?.normalizeIncomingJid) {
        jid = opts.normalizeIncomingJid(jid) ?? jid;
      }
      const fromUserId = body.from?.userid;
      if (!fromUserId) return;
      const senderName = fromUserId;
      const admissionText = extractInboundAdmissionText(body);
      if (!admissionText) return;

      // WeCom accounts must never inherit evaluateChannelAdmission's legacy
      // open-channel behavior: absent account-scoped auth is a deny.
      const admission = await evaluateChannelAdmission({
        jid,
        chatName: senderName,
        text: admissionText,
        isChatAuthorized: opts?.isChatAuthorized ?? (() => false),
        onPairAttempt: opts?.onPairAttempt,
      });
      assertConnectionGeneration(generation, signal);
      if (admission.kind === 'paired') {
        if (ws)
          await sendReply(ws, frame, '配对成功！此聊天已连接到你的工作区。');
        return;
      }
      if (admission.kind === 'pair_rejected') {
        if (ws) {
          await sendReply(
            ws,
            frame,
            '配对码无效或已过期，请在 Web 设置页重新生成。',
          );
        }
        return;
      }
      if (admission.kind === 'deny') {
        const now = Date.now();
        const lastReject = rejectTimestamps.get(jid) ?? 0;
        if (ws && now - lastReject >= REJECT_COOLDOWN_MS) {
          rejectTimestamps.set(jid, now);
          await sendReply(
            ws,
            frame,
            '此聊天尚未配对。请在 Web 设置页生成配对码，然后发送 /pair <code>。',
          );
        }
        logger.debug({ ...logCtx, jid }, 'Unauthorized WeCom chat ignored');
        return;
      }

      const resolvedRoute = resolveAdmittedChannelRoute(
        jid,
        opts?.resolveEffectiveChatJid,
      );
      if (!resolvedRoute) {
        logger.warn(
          { ...logCtx, jid },
          'WeCom message dropped: binding resolver rejected route',
        );
        return;
      }
      let targetJid = resolvedRoute.targetJid;
      let routeAgentId = resolvedRoute.routing?.agentId ?? null;

      const slashMatch = admissionText.match(/^\/(\S+)(?:\s+(.*))?$/u);
      const commandName = slashMatch?.[1]?.toLowerCase();
      const registeredGroup = conversation.isGroup
        ? opts?.resolveRegisteredGroup?.(jid)
        : undefined;
      // /owner_mention is the sole audience bootstrap exception, and only
      // while the group is genuinely unowned and not credential-quarantined.
      const ownerBootstrap =
        conversation.isGroup &&
        isOwnerBootstrapCommand(admissionText, registeredGroup);
      // The message passed a gate only as `/owner_mention`: it must be
      // consumed as that command, never stored as ordinary input.
      let bootstrapOnly = false;

      if (conversation.isGroup) {
        const audience = groupSenderAdmission(
          opts ?? {},
          jid,
          fromUserId,
          admissionText,
        );
        if (audience === 'rejected') return;
        bootstrapOnly = audience === 'bootstrap';

        const mode = registeredGroup?.activation_mode;
        if (mode === 'disabled') return;

        const mentionState = weComGroupMentionState(body);
        if (
          mentionState !== 'provider_mentioned' &&
          opts?.shouldProcessGroupMessage &&
          !opts.shouldProcessGroupMessage(jid, fromUserId)
        ) {
          return;
        }
        if (
          mode === 'owner_mentioned' &&
          !opts?.isGroupOwnerMessage?.(jid, fromUserId)
        ) {
          if (!ownerBootstrap) return;
          bootstrapOnly = true;
        }
      }

      // Group callbacks exist only for an @mention of the bot and a single
      // chat is addressed to it, so the callback itself is the proof.
      const runtimeControl = parseConnectorRuntimeControl({
        commandText: admissionText,
        eligible: true,
        hasAttachments: body.msgtype !== 'text',
      });
      const steerText =
        runtimeControl?.kind === 'steer' ? runtimeControl.text : undefined;
      const onCommand = opts?.onCommand;
      let commandReply: string | null = null;
      if (runtimeControl?.kind === 'break') {
        const onSessionBreak = opts?.onSessionBreak;
        commandReply = await settleCommandReply(dedupKey, jid, 'break', () =>
          runSessionBreak(onSessionBreak, {
            sourceJid: jid,
            targetJid,
            senderImId: fromUserId,
            chatType: conversation.isGroup ? 'group' : 'p2p',
          }),
        );
      } else if (slashMatch && onCommand && steerText === undefined) {
        const command = `${slashMatch[1]}${slashMatch[2] ? ` ${slashMatch[2]}` : ''}`;
        commandReply = await settleCommandReply(
          dedupKey,
          jid,
          commandName,
          () => onCommand(jid, command, fromUserId),
        );
      }
      if (commandReply) {
        if (!ws) throw new Error('WeCom connection is unavailable');
        // A failed send keeps the cached reply for the provider retry.
        await sendReply(ws, frame, commandReply);
        commandReplies.delete(dedupKey);
        return;
      }
      // An unknown command (no reply) is ordinary input for the Agent, as on
      // Feishu.
      commandReplies.delete(dedupKey);
      if (bootstrapOnly) return;

      // All registration and business side effects are after admission,
      // routing, command handling, and group policy filters.
      pruneProgress();
      let progress = inboundProgress.get(dedupKey);
      if (progress) {
        if (
          progress.sourceJid !== jid ||
          progress.targetJid !== targetJid ||
          progress.agentId !== routeAgentId
        ) {
          logger.warn(
            {
              ...logCtx,
              dedupKey,
              stagedSourceJid: progress.sourceJid,
              stagedTargetJid: progress.targetJid,
              stagedAgentId: progress.agentId,
              currentSourceJid: jid,
              currentTargetJid: targetJid,
              currentAgentId: routeAgentId,
            },
            'WeCom retry route changed; reusing staged route snapshot',
          );
        }
        jid = progress.sourceJid;
        targetJid = progress.targetJid;
        routeAgentId = progress.agentId;
        progress.expiresAt = Date.now() + WECOM_PROGRESS_TTL_MS;
      }
      if (!progress) {
        pruneProgress();
        progress = {
          expiresAt: Date.now() + WECOM_PROGRESS_TTL_MS,
          stagedBytes: 0,
          sourceJid: jid,
          targetJid,
          agentId: routeAgentId,
        };
        inboundProgress.set(dedupKey, progress);
      }
      const id = stableWeComInboundId({
        accountId: config.channelAccountId,
        botId: config.botId,
        providerChatId: conversation.providerChatId,
        eventId,
      });
      const proposedTimestamp = new Date(createdAt || Date.now()).toISOString();
      const senderId = `wecom:${fromUserId}`;

      if (!progress.stored && getMessage(targetJid, id)) {
        // A process/reconnect replay found the provider event already durable.
        // Refresh only the callback frame needed for a still-pending reply; the
        // DB poller owns recovery, so repeating projections would duplicate it.
        cacheFrame(id, conversation.providerChatId, frame);
        deleteProgress(dedupKey);
        return;
      }
      if (!progress.normalized) {
        const normalized = await normalizeInbound(
          body,
          jid,
          targetJid,
          generation,
          signal,
        );
        const attachmentsJson =
          normalized.attachments.length > 0
            ? JSON.stringify(normalized.attachments)
            : undefined;
        // `/steer` keeps only its guidance; media markers that follow the
        // command text in a mixed message stay in place.
        const normalizedContent =
          steerText !== undefined &&
          normalized.content.startsWith(admissionText)
            ? steerText + normalized.content.slice(admissionText.length)
            : normalized.content;
        stageProgressPayload(
          dedupKey,
          progress,
          normalizedContent,
          attachmentsJson,
          generation,
          signal,
        );
        progress.normalized = true;
      }
      let content = progress.content ?? '';
      let attachmentsJson = progress.attachmentsJson;
      if (progress.stored) {
        const durable = getMessagePayload(targetJid, id);
        if (!durable) {
          throw new Error('WeCom staged progress lost its durable message');
        }
        content = durable.content;
        attachmentsJson = durable.attachments ?? undefined;
      }
      if (!content && !attachmentsJson) {
        deleteProgress(dedupKey);
        return;
      }
      // WeCom create_time has only second precision. Cursor polling is ordered
      // by (timestamp,id), so sequence concurrent events after the durable chat
      // tail. Keep the assigned value in staged progress: if persistence
      // succeeds but a later projection fails, the retry must broadcast the
      // exact timestamp that was committed.
      progress.timestamp ??= sequenceInboundTimestampAfterChatTail(
        targetJid,
        proposedTimestamp,
      );
      const timestamp = progress.timestamp;
      assertConnectionGeneration(generation, signal);
      if (!progress.registered) {
        opts?.onNewChat(jid, senderName);
        progress.registered = true;
      }
      if (!progress.stored) {
        assertConnectionGeneration(generation, signal);
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
        progress.stored = true;
        // The database now owns the potentially large content/base64 payload.
        // Retries rehydrate it by stable id instead of retaining duplicate RAM.
        clearProgressPayload(progress);
      }
      if (!progress.frameCached) {
        cacheFrame(id, conversation.providerChatId, frame);
        progress.frameCached = true;
      }
      progress.followUp ??= offerChannelFollowUp(opts?.onFollowUpMessage, {
        targetJid,
        sourceJid: jid,
        messageId: id,
        senderImId: senderId,
        requestedMode: steerText === undefined ? undefined : 'steer',
      });
      const followUp = progress.followUp;
      if (!progress.broadcast) {
        opts?.onMessagePersisted?.(
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
          routeAgentId ?? undefined,
        );
        progress.broadcast = true;
      }
      if (!followUp.shouldStartTurn) {
        // Released by the host when the active run ends.
        if (!progress.notified) {
          opts?.onFollowUpsChanged?.(targetJid);
          progress.notified = true;
        }
        deleteProgress(dedupKey);
        logger.info(
          {
            ...logCtx,
            jid,
            effectiveJid: targetJid,
            disposition: followUp.disposition,
          },
          'WeCom message queued behind the active run',
        );
        return;
      }
      if (routeAgentId && !progress.agentNotified) {
        opts?.onAgentMessage?.(jid, routeAgentId);
        progress.agentNotified = true;
      }
      deleteProgress(dedupKey);
      logger.info(
        {
          ...logCtx,
          jid,
          effectiveJid: targetJid,
          agentId: routeAgentId,
          msgid: body.msgid,
        },
        'WeCom message admitted and stored',
      );
    } catch (error) {
      // The mark is provisional until every required effect completes. A
      // provider retry with the same msgid resumes from inboundProgress.
      dedup.forget(dedupKey);
      if (error instanceof WeComMediaCancelledError) {
        deleteProgress(dedupKey);
        logger.debug({ ...logCtx }, 'WeCom inbound handling cancelled');
      } else {
        logger.error({ ...logCtx, error }, 'WeCom inbound handling failed');
      }
    } finally {
      processingLock.release(dedupKey);
    }
  }

  return {
    async connect(connectOpts: WeComConnectOpts): Promise<void> {
      if (ws) throw new Error('WeCom connection is already started');
      opts = connectOpts;
      intentionalDisconnect = false;
      authenticated = false;
      emitState({ status: 'connecting' });

      const client = new WSClient({
        botId: config.botId,
        secret: config.secret,
        maxReconnectAttempts: -1,
        logger: {
          debug: () => undefined,
          info: (message: string) =>
            logger.debug({ ...logCtx }, `WeCom SDK: ${message}`),
          warn: (message: string) =>
            logger.warn({ ...logCtx }, `WeCom SDK: ${message}`),
          error: (message: string, error?: unknown) =>
            logger.error({ ...logCtx, error }, `WeCom SDK: ${message}`),
        },
      });
      ws = client;

      let settleInitial: ((error?: Error) => void) | null = null;
      const authenticatedPromise = new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          if (error) reject(error);
          else resolve();
        };
        settleInitial = finish;
      });
      const timeout = setTimeout(
        () => settleInitial?.(new Error('WeCom authentication timed out')),
        config.authTimeoutMs ?? AUTH_TIMEOUT_MS,
      );
      timeout.unref?.();

      client.on('message.text', (data) => {
        void handleInbound(data);
      });
      client.on('message.image', (data) => {
        void handleInbound(data);
      });
      client.on('message.voice', (data) => {
        void handleInbound(data);
      });
      client.on('message.file', (data) => {
        void handleInbound(data);
      });
      client.on('message.video', (data) => {
        void handleInbound(data);
      });
      client.on('message.mixed', (data) => {
        void handleInbound(data);
      });
      client.on('authenticated', () => {
        authenticated = true;
        emitState({ status: 'connected' });
        logger.info({ ...logCtx }, 'WeCom WebSocket authenticated');
        connectOpts.onReady?.();
        settleInitial?.();
      });
      client.on('connected', () => {
        logger.info({ ...logCtx }, 'WeCom WebSocket connected');
      });
      client.on('disconnected', (reason: string) => {
        authenticated = false;
        const error = reason || 'WebSocket disconnected';
        emitState({ status: 'disconnected', error });
        logger.warn({ ...logCtx, reason }, 'WeCom WebSocket disconnected');
        if (!intentionalDisconnect) settleInitial?.(new Error(error));
      });
      client.on('reconnecting', (attempt: number) => {
        authenticated = false;
        emitState({ status: 'reconnecting', attempt });
        logger.info({ ...logCtx, attempt }, 'WeCom WebSocket reconnecting');
      });
      client.on('error', (error: Error) => {
        authenticated = false;
        emitState({ status: 'error', error: error.message });
        logger.error({ ...logCtx, error }, 'WeCom WebSocket error');
        settleInitial?.(error);
      });

      try {
        client.connect();
        await authenticatedPromise;
      } catch (error) {
        authenticated = false;
        intentionalDisconnect = true;
        try {
          client.disconnect();
        } finally {
          if (ws === client) ws = null;
          opts = null;
        }
        throw error;
      } finally {
        clearTimeout(timeout);
        settleInitial = null;
      }
    },

    async disconnect(): Promise<void> {
      connectionGeneration += 1;
      mediaAbortController.abort();
      intentionalDisconnect = true;
      authenticated = false;
      mediaSemaphore.close();
      const client = ws;
      ws = null;
      opts = null;
      inboundFrames.clear();
      for (const key of [...inboundProgress.keys()]) deleteProgress(key);
      inboundProgressBytes = 0;
      commandReplies.clear();
      rejectTimestamps.clear();
      dedup.clear();
      processingLock.dispose();
      client?.disconnect();
    },

    async sendMessage(
      chatId: string,
      text: string,
      localImagePaths?: string[],
    ): Promise<void> {
      const client = ws;
      if (!client || !authenticated) {
        throw preAcceptImDeliveryError('WeCom channel is not authenticated');
      }
      const generation = connectionGeneration;
      const signal = mediaAbortController.signal;
      const images = await Promise.all(
        (localImagePaths ?? []).map(async (imagePath) => {
          let buffer: Buffer;
          try {
            buffer = await fs.promises.readFile(imagePath);
          } catch (error) {
            throw preAcceptImDeliveryError(
              `WeCom local image is unavailable: ${imagePath}`,
              error,
            );
          }
          if (
            buffer.length === 0 ||
            buffer.length > WECOM_OUTBOUND_MEDIA_MAX_BYTES ||
            !detectImageMimeTypeStrict(buffer)
          ) {
            throw preAcceptImDeliveryError(
              `WeCom local image failed preflight: ${imagePath}`,
            );
          }
          return { buffer, fileName: path.basename(imagePath) };
        }),
      );
      const sendsText = text.length > 0 || images.length === 0;
      const tracker = new PhysicalDeliveryTracker(
        (sendsText ? 1 : 0) + images.length,
      );
      if (sendsText) {
        await tracker.send(() => sendMarkdownPages(client, chatId, text));
      }
      for (const image of images) {
        await tracker.send(() =>
          sendOutboundMedia(
            client,
            generation,
            signal,
            chatId,
            'image',
            image.buffer,
            image.fileName,
          ),
        );
      }
    },

    async sendImage(
      chatId: string,
      imageBuffer: Buffer,
      mimeType: string,
      caption?: string,
      fileName?: string,
    ): Promise<void> {
      const client = ws;
      if (!client || !authenticated) {
        throw preAcceptImDeliveryError('WeCom channel is not authenticated');
      }
      if (!mimeType.startsWith('image/')) {
        throw preAcceptImDeliveryError(
          `WeCom sendImage received non-image MIME type ${mimeType}`,
        );
      }
      if (
        imageBuffer.length === 0 ||
        imageBuffer.length > WECOM_OUTBOUND_MEDIA_MAX_BYTES ||
        !detectImageMimeTypeStrict(imageBuffer)
      ) {
        throw preAcceptImDeliveryError(
          `WeCom outbound image failed preflight: ${fileName ?? 'image'}`,
        );
      }
      const generation = connectionGeneration;
      const signal = mediaAbortController.signal;
      const tracker = new PhysicalDeliveryTracker(caption ? 2 : 1);
      if (caption) {
        await tracker.send(() => sendMarkdownPages(client, chatId, caption));
      }
      await tracker.send(() =>
        sendOutboundMedia(
          client,
          generation,
          signal,
          chatId,
          'image',
          imageBuffer,
          normalizeWeComOutboundFileName(fileName, 'image.png'),
        ),
      );
    },

    async sendFile(
      chatId: string,
      filePath: string,
      fileName: string,
    ): Promise<void> {
      const client = ws;
      if (!client || !authenticated) {
        throw preAcceptImDeliveryError('WeCom channel is not authenticated');
      }
      let buffer: Buffer;
      try {
        buffer = await fs.promises.readFile(filePath);
      } catch (error) {
        throw preAcceptImDeliveryError(
          `WeCom outbound file is unavailable: ${filePath}`,
          error,
        );
      }
      await sendOutboundMedia(
        client,
        connectionGeneration,
        mediaAbortController.signal,
        chatId,
        'file',
        buffer,
        normalizeWeComOutboundFileName(fileName, path.basename(filePath)),
      );
    },

    async createStreamingSession(
      chatId: string,
      inputMessageId?: string,
    ): Promise<WeComStreamingController | undefined> {
      const client = ws;
      if (!client || !authenticated) {
        throw new Error('WeCom channel is not authenticated');
      }
      pruneFrames();
      if (!inputMessageId) return undefined;
      const cached = inboundFrames.get(inputMessageId);
      if (!cached || cached.chatId !== sdkChatId(chatId)) return undefined;
      inboundFrames.delete(inputMessageId);
      const frame = cached.frame;
      const streamId = generateReqId('stream');
      return new WeComStreamingController({
        chatId,
        sendStream: async (streamContent: string, finish: boolean) => {
          // `frame` is deliberately closed over. Never re-read a per-chat map:
          // concurrent messages in one chat retain their own req_id.
          await client.replyStream(frame, streamId, streamContent, finish);
        },
        fallbackSend: async (fallbackText: string) => {
          await sendMarkdownPages(client, chatId, fallbackText);
        },
      });
    },

    isConnected(): boolean {
      return authenticated && ws !== null;
    },
  };
}
