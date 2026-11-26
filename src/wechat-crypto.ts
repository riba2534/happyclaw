import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import {
  fetch as undiciFetch,
  type Dispatcher,
  type Response as UndiciResponse,
} from 'undici';

import { logger } from './logger.js';

// CDN Base URL
const DEFAULT_CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c';

// iLink-App identity headers (mirrors openclaw-weixin 2.1.1 upstream).
// Server-side file upload (media_type=3) validates these headers; without them
// getuploadurl returns {"ret":-1}. Image uploads (media_type=1) don't require
// them, but it's harmless to send for all calls.
const ILINK_APP_ID = 'bot';
// uint32 encoded as 0x00MMNNPP — "2.1.1" → (2<<16)|(1<<8)|1 = 131329
const ILINK_APP_CLIENT_VERSION = '131329';

/** AES-128-ECB 加密（PKCS7 padding） */
export function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

/** AES-128-ECB 解密（PKCS7 padding） */
export function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** AES-128-ECB 密文大小（PKCS7 padding 到 16 字节边界） */
export function aesEcbPaddedSize(plaintextSize: number): number {
  // PKCS7 always adds at least 1 byte, up to block size (16)
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

/** 入站 CDN 媒体超过字节上限（在解密前、读取过程中即中止） */
export class WeChatMediaTooLargeError extends Error {
  readonly size: number;
  readonly maxBytes: number;
  constructor(size: number, maxBytes: number) {
    super(`WeChat media too large: ${size} bytes (max ${maxBytes} bytes)`);
    this.name = 'WeChatMediaTooLargeError';
    this.size = size;
    this.maxBytes = maxBytes;
  }
}

/** 构造 CDN 下载 URL */
export function buildCdnDownloadUrl(
  encryptedQueryParam: string,
  cdnBaseUrl?: string,
): string {
  const base = cdnBaseUrl || DEFAULT_CDN_BASE;
  return `${base}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

/** 构造 CDN 上传 URL */
export function buildCdnUploadUrl(params: {
  cdnBaseUrl?: string;
  uploadParam: string;
  filekey: string;
}): string {
  const base = params.cdnBaseUrl || DEFAULT_CDN_BASE;
  return `${base}/upload?encrypted_query_param=${encodeURIComponent(params.uploadParam)}&filekey=${encodeURIComponent(params.filekey)}`;
}

/**
 * Parse aes_key (base64) to 16-byte Buffer.
 * Canonical encoding for both inbound and outbound is base64(hex-string ASCII
 * bytes): raw 16 bytes → 32-char hex → ASCII bytes → base64 (~44 chars).
 * Legacy raw 16-byte decode path is kept as a fallback for any inbound
 * messages that may not follow the convention.
 */
function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, 'base64');
  // Canonical path: decoded is a 32-char hex string
  if (decoded.length === 32) {
    const hexStr = decoded.toString('utf-8');
    const keyBuf = Buffer.from(hexStr, 'hex');
    if (keyBuf.length === 16) return keyBuf;
  }
  // Fallback: raw 16 bytes
  if (decoded.length === 16) return decoded;
  throw new Error(
    `Invalid AES key: decoded length ${decoded.length}, expected 16 or 32`,
  );
}

/**
 * Read a CDN response body, giving up as soon as it exceeds `maxCiphertext`
 * bytes: an oversized Content-Length is rejected before reading, and a body
 * without one (chunked) is cancelled mid-stream once the count passes the cap.
 */
async function readCappedCiphertext(
  resp: UndiciResponse,
  maxCiphertext: number,
  maxBytes: number,
): Promise<Buffer> {
  const declared = Number(resp.headers.get('content-length'));
  if (declared > maxCiphertext) {
    await resp.body?.cancel().catch(() => {});
    throw new WeChatMediaTooLargeError(declared, maxBytes);
  }
  if (!resp.body) return Buffer.from(await resp.arrayBuffer());

  const reader = resp.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxCiphertext) {
      await reader.cancel().catch(() => {});
      throw new WeChatMediaTooLargeError(received, maxBytes);
    }
    chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
  }
  return Buffer.concat(chunks, received);
}

/**
 * 从 CDN 下载并 AES-128-ECB 解密。
 * 传入 `maxBytes`（明文上限）时，密文超过 aesEcbPaddedSize(maxBytes) 即在解密前
 * 抛出 WeChatMediaTooLargeError，不会把整个对象读入内存。
 */
export async function downloadAndDecryptMedia(
  encryptQueryParam: string,
  aesKeyBase64: string,
  cdnBaseUrl?: string,
  dispatcher?: Dispatcher,
  maxBytes?: number,
): Promise<Buffer> {
  const url = buildCdnDownloadUrl(encryptQueryParam, cdnBaseUrl);
  const key = parseAesKey(aesKeyBase64);

  logger.debug(
    { url: url.slice(0, 120) },
    'Downloading encrypted media from CDN',
  );

  const resp = await undiciFetch(url, {
    signal: AbortSignal.timeout(60_000),
    dispatcher,
  });
  if (!resp.ok) {
    throw new Error(`CDN download failed: ${resp.status} ${resp.statusText}`);
  }

  const ciphertext =
    maxBytes === undefined
      ? Buffer.from(await resp.arrayBuffer())
      : await readCappedCiphertext(resp, aesEcbPaddedSize(maxBytes), maxBytes);
  return decryptAesEcb(ciphertext, key);
}

/** 上传 Buffer 到 CDN（加密后上传） */
export async function uploadBufferToCdn(params: {
  buf: Buffer;
  uploadParam: string;
  filekey: string;
  cdnBaseUrl?: string;
  aeskey: Buffer;
  dispatcher?: Dispatcher;
}): Promise<{ downloadParam: string }> {
  const encrypted = encryptAesEcb(params.buf, params.aeskey);
  const url = buildCdnUploadUrl({
    cdnBaseUrl: params.cdnBaseUrl,
    uploadParam: params.uploadParam,
    filekey: params.filekey,
  });

  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await undiciFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(encrypted),
        signal: AbortSignal.timeout(120_000),
        dispatcher: params.dispatcher,
      });

      if (!resp.ok) {
        throw new Error(`CDN upload failed: ${resp.status} ${resp.statusText}`);
      }

      const downloadParam = resp.headers.get('x-encrypted-param');
      if (!downloadParam) {
        throw new Error('CDN upload response missing x-encrypted-param header');
      }

      return { downloadParam };
    } catch (err) {
      lastError = err as Error;
      if (attempt < 2) {
        logger.warn(
          { err, attempt: attempt + 1 },
          'CDN upload attempt failed, retrying',
        );
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      } else {
        logger.error(
          { err, attempt: attempt + 1 },
          'CDN upload failed after all retries',
        );
      }
    }
  }

  throw lastError ?? new Error('CDN upload failed after 3 retries');
}

/** 获取上传预签名 URL */
export async function getUploadUrl(params: {
  baseUrl: string;
  token: string;
  filekey: string;
  mediaType: number; // 1=IMAGE, 2=VIDEO, 3=FILE
  toUserId: string;
  rawsize: number;
  rawfilemd5: string;
  filesize: number;
  aeskey: string;
  dispatcher?: Dispatcher;
}): Promise<{ uploadParam: string }> {
  const url = `${params.baseUrl}/ilink/bot/getuploadurl`;
  const body = {
    filekey: params.filekey,
    media_type: params.mediaType,
    to_user_id: params.toUserId,
    rawsize: params.rawsize,
    rawfilemd5: params.rawfilemd5,
    filesize: params.filesize,
    no_need_thumb: true,
    aeskey: params.aeskey,
    base_info: { channel_version: '1.0.0' },
  };

  const xWechatUin = crypto.randomBytes(16).toString('base64');
  const resp = await undiciFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${params.token}`,
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': xWechatUin,
      'iLink-App-Id': ILINK_APP_ID,
      'iLink-App-ClientVersion': ILINK_APP_CLIENT_VERSION,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
    dispatcher: params.dispatcher,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(
      `getUploadUrl failed: ${resp.status} ${resp.statusText} - ${text}`,
    );
  }

  const data = (await resp.json()) as Record<string, unknown>;
  const uploadParam = data.upload_param as string | undefined;
  if (!uploadParam) {
    throw new Error(
      `getUploadUrl response missing upload_param: ${JSON.stringify(data)}`,
    );
  }

  return { uploadParam };
}

export interface UploadMediaResult {
  filekey: string;
  downloadEncryptedQueryParam: string;
  /** AES key as base64(hex-string ASCII bytes) — ~44 chars, same for all media types. */
  aeskey: string;
  fileSize: number;
  fileSizeCiphertext: number;
}

/** 上传 Buffer：生成 AES key → 获取预签名 URL → 加密并上传到 CDN */
export async function uploadMediaBuffer(params: {
  buf: Buffer;
  fileName: string;
  toUserId: string;
  baseUrl: string;
  token: string;
  cdnBaseUrl?: string;
  mediaType: number;
  dispatcher?: Dispatcher;
}): Promise<UploadMediaResult> {
  const { buf } = params;
  const rawsize = buf.length;
  const rawfilemd5 = crypto.createHash('md5').update(buf).digest('hex');

  const aeskeyBuf = crypto.randomBytes(16);
  const aeskeyHex = aeskeyBuf.toString('hex');
  const filesize = aesEcbPaddedSize(rawsize);
  // filekey is a 32-char hex string — the server rejects non-ASCII chars
  // (e.g. Chinese filenames) with {"ret":-1}. Mirrors openclaw-weixin upstream.
  const filekey = crypto.randomBytes(16).toString('hex');

  const { uploadParam } = await getUploadUrl({
    baseUrl: params.baseUrl,
    token: params.token,
    filekey,
    mediaType: params.mediaType,
    toUserId: params.toUserId,
    rawsize,
    rawfilemd5,
    filesize,
    aeskey: aeskeyHex,
    dispatcher: params.dispatcher,
  });

  const { downloadParam } = await uploadBufferToCdn({
    buf,
    uploadParam,
    filekey,
    cdnBaseUrl: params.cdnBaseUrl,
    aeskey: aeskeyBuf,
    dispatcher: params.dispatcher,
  });

  // All media types (image/file/voice/video) use base64(hex-string ASCII
  // bytes) — matches nightsailer/wechat-clawbot reference implementation.
  const aeskeyEncoded = Buffer.from(aeskeyHex, 'utf-8').toString('base64');

  return {
    filekey,
    downloadEncryptedQueryParam: downloadParam,
    aeskey: aeskeyEncoded,
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  };
}

/** 完整的媒体上传流程：读文件 → 哈希 → 加密 → 获取URL → 上传 */
export async function uploadMediaFile(params: {
  filePath: string;
  toUserId: string;
  baseUrl: string;
  token: string;
  cdnBaseUrl?: string;
  mediaType: number;
  dispatcher?: Dispatcher;
}): Promise<UploadMediaResult> {
  const buf = await fs.promises.readFile(params.filePath);
  return uploadMediaBuffer({
    buf,
    fileName: path.basename(params.filePath),
    toUserId: params.toUserId,
    baseUrl: params.baseUrl,
    token: params.token,
    cdnBaseUrl: params.cdnBaseUrl,
    mediaType: params.mediaType,
    dispatcher: params.dispatcher,
  });
}
