import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { logger } from './logger.js';

// CDN Base URL
const DEFAULT_CDN_BASE = 'https://novac2c.cdn.weixin.qq.com/c2c';

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
 * 解析 aes_key（base64）为 16 字节 Buffer
 * 两种编码：
 *   - base64(raw 16 bytes) → 图片
 *   - base64(hex string of 16 bytes) → 文件/语音/视频
 */
function parseAesKey(aesKeyBase64: string): Buffer {
  const decoded = Buffer.from(aesKeyBase64, 'base64');
  if (decoded.length === 16) {
    // Raw 16 bytes — used for images
    return decoded;
  }
  // Decoded is a hex string (32 chars representing 16 bytes) — used for files/voice/video
  const hexStr = decoded.toString('utf-8');
  const keyBuf = Buffer.from(hexStr, 'hex');
  if (keyBuf.length !== 16) {
    throw new Error(
      `Invalid AES key: expected 16 bytes, got ${keyBuf.length} after hex decode`,
    );
  }
  return keyBuf;
}

/** 从 CDN 下载并 AES-128-ECB 解密 */
export async function downloadAndDecryptMedia(
  encryptQueryParam: string,
  aesKeyBase64: string,
  cdnBaseUrl?: string,
): Promise<Buffer> {
  const url = buildCdnDownloadUrl(encryptQueryParam, cdnBaseUrl);
  const key = parseAesKey(aesKeyBase64);

  logger.debug({ url: url.slice(0, 120) }, 'Downloading encrypted media from CDN');

  const resp = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!resp.ok) {
    throw new Error(
      `CDN download failed: ${resp.status} ${resp.statusText}`,
    );
  }

  const ciphertext = Buffer.from(await resp.arrayBuffer());
  return decryptAesEcb(ciphertext, key);
}

/** 上传 Buffer 到 CDN（加密后上传） */
export async function uploadBufferToCdn(params: {
  buf: Buffer;
  uploadParam: string;
  filekey: string;
  cdnBaseUrl?: string;
  aeskey: Buffer;
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
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/octet-stream' },
        body: new Uint8Array(encrypted),
        signal: AbortSignal.timeout(120_000),
      });

      if (!resp.ok) {
        throw new Error(
          `CDN upload failed: ${resp.status} ${resp.statusText}`,
        );
      }

      const downloadParam = resp.headers.get('x-encrypted-param');
      if (!downloadParam) {
        throw new Error(
          'CDN upload response missing x-encrypted-param header',
        );
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
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${params.token}`,
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': xWechatUin,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
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

/** 完整的媒体上传流程：读文件 → 哈希 → 加密 → 获取URL → 上传 */
export async function uploadMediaFile(params: {
  filePath: string;
  toUserId: string;
  baseUrl: string;
  token: string;
  cdnBaseUrl?: string;
  mediaType: number;
}): Promise<{
  filekey: string;
  downloadEncryptedQueryParam: string;
  aeskey: string;
  fileSize: number;
  fileSizeCiphertext: number;
}> {
  // Read file (async to avoid blocking event loop on large files)
  const buf = await fs.promises.readFile(params.filePath);
  const rawsize = buf.length;

  // Compute MD5 hash
  const rawfilemd5 = crypto.createHash('md5').update(buf).digest('hex');

  // Generate AES key (16 random bytes)
  const aeskey = crypto.randomBytes(16);
  const aeskeyHex = aeskey.toString('hex');

  // Compute ciphertext size
  const filesize = aesEcbPaddedSize(rawsize);

  // Generate filekey from filename + timestamp
  const basename = path.basename(params.filePath);
  const filekey = `${Date.now()}_${basename}`;

  // Get upload URL
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
  });

  // Encrypt and upload
  const { downloadParam } = await uploadBufferToCdn({
    buf,
    uploadParam,
    filekey,
    cdnBaseUrl: params.cdnBaseUrl,
    aeskey,
  });

  return {
    filekey,
    downloadEncryptedQueryParam: downloadParam,
    aeskey: aeskeyHex,
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  };
}
