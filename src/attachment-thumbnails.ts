import fs from 'fs';
import path from 'path';

import sharp from 'sharp';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

/**
 * Chat history used to ship every image attachment as its full base64 payload
 * inside the message list response. A single phone photo is 3–4 MB of base64,
 * so one page of 50 messages covering a burst of images reached ~22 MB and the
 * browser simply failed to load it — the whole history silently stopped
 * rendering.
 *
 * The list now carries a small thumbnail and the viewer fetches the original on
 * demand. Stored attachments are deliberately left untouched: the agent still
 * receives the full-resolution image, and this module only shapes what the Web
 * client is handed.
 */

const THUMBNAIL_ROOT = path.join(DATA_DIR, 'thumbnails');

/** Long edge, in pixels. Comfortably above the 192px CSS box on 2x displays. */
const THUMBNAIL_MAX_EDGE = 480;
const THUMBNAIL_QUALITY = 72;

/**
 * Below this the base64 already costs less than a thumbnail round-trip would,
 * so the original is passed straight through and no `hasOriginal` marker is
 * emitted.
 */
const THUMBNAIL_MIN_SOURCE_BYTES = 64 * 1024;

/** Cap decode size so a decompression bomb cannot pin the list endpoint. */
const THUMBNAIL_MAX_INPUT_PIXELS = 40_000_000;

/** Bound libvips work across a page of photo-sized attachments. */
const THUMBNAIL_RENDER_CONCURRENCY = 3;

export type StoredAttachment = {
  type?: string;
  data?: string;
  mimeType?: string;
  name?: string;
  [key: string]: unknown;
};

export type PresentedAttachment = StoredAttachment & {
  /** Set when `data` was replaced by a thumbnail and the original is fetchable. */
  hasOriginal?: boolean;
  /** Byte size of the decoded original, for the viewer's loading affordance. */
  originalBytes?: number;
};

function isImageAttachment(att: StoredAttachment): boolean {
  return att.type === 'image' && typeof att.data === 'string' && !!att.data;
}

/**
 * base64 has no separators, so decoded length is derivable without allocating
 * the buffer — worth avoiding when the caller is sizing up 50 messages.
 */
function decodedByteLength(base64: string): number {
  const len = base64.length;
  if (len === 0) return 0;
  let padding = 0;
  if (base64.endsWith('==')) padding = 2;
  else if (base64.endsWith('=')) padding = 1;
  return Math.floor((len * 3) / 4) - padding;
}

function sanitizeMessageId(messageId: string): string {
  // message ids are uuids, but they reach us from request params elsewhere, so
  // keep the filename derivation total rather than trusting the shape.
  return messageId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function thumbnailPath(messageId: string, index: number): string {
  return path.join(
    THUMBNAIL_ROOT,
    `${sanitizeMessageId(messageId)}_${index}.jpg`,
  );
}

let activeRenders = 0;
const renderWaiters: Array<() => void> = [];

function acquireRenderSlot(): Promise<void> {
  if (activeRenders < THUMBNAIL_RENDER_CONCURRENCY) {
    activeRenders += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    renderWaiters.push(() => {
      activeRenders += 1;
      resolve();
    });
  });
}

function releaseRenderSlot(): void {
  activeRenders = Math.max(0, activeRenders - 1);
  const next = renderWaiters.shift();
  if (next) next();
}

async function renderThumbnail(
  base64: string,
  cachePath: string,
): Promise<string | null> {
  await acquireRenderSlot();
  try {
    const input = Buffer.from(base64, 'base64');
    const output = await sharp(input, {
      limitInputPixels: THUMBNAIL_MAX_INPUT_PIXELS,
      failOn: 'error',
    })
      .rotate() // honour EXIF orientation; phone photos are frequently rotated
      .resize(THUMBNAIL_MAX_EDGE, THUMBNAIL_MAX_EDGE, {
        fit: 'inside',
        withoutEnlargement: true,
      })
      .jpeg({ quality: THUMBNAIL_QUALITY })
      .toBuffer();

    fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    // Write via a temp file so a concurrent reader never observes a partial
    // JPEG: two requests for the same page can race on the same cache entry.
    const tmpPath = `${cachePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmpPath, output);
    fs.renameSync(tmpPath, cachePath);
    return output.toString('base64');
  } catch (err) {
    logger.warn({ err, cachePath }, 'Failed to render attachment thumbnail');
    return null;
  } finally {
    releaseRenderSlot();
  }
}

/**
 * Replace image payloads with cached thumbnails for one message.
 *
 * Returns the attachments JSON unchanged whenever anything is off-script
 * (unparseable JSON, non-image attachments, sharp failure). Degrading to the
 * original payload keeps a broken thumbnail from hiding a real image.
 */
export async function buildPresentedAttachments(
  messageId: string,
  attachmentsJson: string | null | undefined,
): Promise<string | null | undefined> {
  if (!attachmentsJson) return attachmentsJson;

  let parsed: unknown;
  try {
    parsed = JSON.parse(attachmentsJson);
  } catch (err) {
    logger.warn(
      { err, messageId },
      'Failed to parse attachments JSON for thumbnails',
    );
    return attachmentsJson;
  }
  if (!Array.isArray(parsed)) return attachmentsJson;

  const attachments = parsed as StoredAttachment[];
  if (!attachments.some(isImageAttachment)) return attachmentsJson;

  let replacedAny = false;
  const presented: PresentedAttachment[] = await Promise.all(
    attachments.map(async (att, index) => {
      if (!isImageAttachment(att)) return att;
      const base64 = att.data as string;
      const originalBytes = decodedByteLength(base64);
      if (originalBytes < THUMBNAIL_MIN_SOURCE_BYTES) return att;

      const cachePath = thumbnailPath(messageId, index);
      let thumb: string | null = null;
      try {
        thumb = fs.readFileSync(cachePath).toString('base64');
      } catch {
        thumb = await renderThumbnail(base64, cachePath);
      }
      if (!thumb) return att;

      replacedAny = true;
      return {
        ...att,
        data: thumb,
        mimeType: 'image/jpeg',
        hasOriginal: true,
        originalBytes,
      };
    }),
  );

  if (!replacedAny) return attachmentsJson;
  return JSON.stringify(presented);
}

/**
 * Apply thumbnails across a page of messages. Mutating a shallow copy keeps the
 * caller's row shape (and any fields already attached to it) intact.
 */
export async function presentMessagesForWeb<
  T extends { id: string; attachments?: string | null },
>(messages: T[]): Promise<T[]> {
  return Promise.all(
    messages.map(async (message) => {
      const attachments = await buildPresentedAttachments(
        message.id,
        message.attachments,
      );
      if (attachments === message.attachments) return message;
      return { ...message, attachments };
    }),
  );
}

/** Read one stored attachment back at full resolution. */
export function readOriginalAttachment(
  attachmentsJson: string | null | undefined,
  index: number,
): { buffer: Buffer; mimeType: string } | null {
  if (!attachmentsJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(attachmentsJson);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const att = (parsed as StoredAttachment[])[index];
  if (!att || !isImageAttachment(att)) return null;
  return {
    buffer: Buffer.from(att.data as string, 'base64'),
    mimeType: typeof att.mimeType === 'string' ? att.mimeType : 'image/png',
  };
}

/** Drop cached thumbnails for a message whose attachments no longer exist. */
export function invalidateThumbnails(messageId: string): void {
  const prefix = `${sanitizeMessageId(messageId)}_`;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(THUMBNAIL_ROOT);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.startsWith(prefix) || !name.endsWith('.jpg')) continue;
    try {
      fs.unlinkSync(path.join(THUMBNAIL_ROOT, name));
    } catch {
      // Absent cache entry is the normal case; nothing to undo.
    }
  }
}
