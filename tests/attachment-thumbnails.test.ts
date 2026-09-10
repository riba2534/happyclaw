import fs from 'fs';
import path from 'path';

import sharp from 'sharp';
import { afterAll, describe, expect, test } from 'vitest';

import { DATA_DIR } from '../src/config.js';
import {
  buildPresentedAttachments,
  invalidateThumbnails,
  presentMessagesForWeb,
  readOriginalAttachment,
} from '../src/attachment-thumbnails.js';

// The module caches under DATA_DIR/thumbnails keyed by message id. Use ids
// unique to this file so a run never collides with real cached history, and
// drop them afterwards.
const ID_PREFIX = 'test-attachment-thumbnails-';
const usedIds: string[] = [];

function messageId(name: string): string {
  const id = `${ID_PREFIX}${name}`;
  usedIds.push(id);
  return id;
}

afterAll(() => {
  for (const id of usedIds) invalidateThumbnails(id);
});

/**
 * A photo-sized JPEG. Noise defeats JPEG's smooth-gradient compression, which
 * is what makes a solid-colour fixture collapse to a few KB and silently skip
 * the size threshold the code under test cares about.
 */
async function bigJpegBase64(): Promise<string> {
  const width = 1400;
  const height = 1400;
  const pixels = Buffer.alloc(width * height * 3);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 7919) % 256;
  const buf = await sharp(pixels, { raw: { width, height, channels: 3 } })
    .jpeg({ quality: 100 })
    .toBuffer();
  return buf.toString('base64');
}

async function smallPngBase64(): Promise<string> {
  const buf = await sharp({
    create: {
      width: 8,
      height: 8,
      channels: 3,
      background: { r: 10, g: 20, b: 30 },
    },
  })
    .png()
    .toBuffer();
  return buf.toString('base64');
}

describe('web chat attachment thumbnails', () => {
  test('a photo-sized image is replaced by a much smaller thumbnail', async () => {
    const original = await bigJpegBase64();
    const stored = JSON.stringify([
      { type: 'image', data: original, mimeType: 'image/jpeg' },
    ]);

    const presented = await buildPresentedAttachments(messageId('big'), stored);
    const [att] = JSON.parse(presented as string);

    expect(att.hasOriginal).toBe(true);
    expect(att.data.length).toBeLessThan(original.length / 4);
    expect(att.originalBytes).toBe(Buffer.from(original, 'base64').length);
    // The viewer needs the stored payload untouched to serve full resolution.
    expect(JSON.parse(stored)[0].data).toBe(original);
  });

  test('a small image is passed through so the viewer does not round-trip for nothing', async () => {
    const stored = JSON.stringify([
      { type: 'image', data: await smallPngBase64(), mimeType: 'image/png' },
    ]);

    const presented = await buildPresentedAttachments(
      messageId('small'),
      stored,
    );

    // Unchanged JSON, and crucially no hasOriginal — the client must keep
    // rendering the inline data rather than requesting an original.
    expect(presented).toBe(stored);
    expect(JSON.parse(presented as string)[0].hasOriginal).toBeUndefined();
  });

  test('the original endpoint indexes the stored array, not the filtered images', async () => {
    // A non-image in front is exactly the case where filtering to images first
    // would hand the viewer the wrong index and serve an unrelated attachment.
    const original = await bigJpegBase64();
    const stored = JSON.stringify([
      { type: 'file', name: 'notes.txt' },
      { type: 'image', data: original, mimeType: 'image/jpeg' },
    ]);

    const presented = JSON.parse(
      (await buildPresentedAttachments(messageId('mixed'), stored)) as string,
    );

    expect(presented[0]).toEqual({ type: 'file', name: 'notes.txt' });
    expect(presented[1].hasOriginal).toBe(true);

    // Index 1 is the image; index 0 must not resolve to one.
    expect(readOriginalAttachment(stored, 0)).toBeNull();
    const fetched = readOriginalAttachment(stored, 1);
    expect(fetched?.mimeType).toBe('image/jpeg');
    expect(fetched?.buffer.equals(Buffer.from(original, 'base64'))).toBe(true);
  });

  test('malformed or absent attachments degrade to the stored value', async () => {
    const id = messageId('malformed');
    expect(await buildPresentedAttachments(id, null)).toBeNull();
    expect(await buildPresentedAttachments(id, undefined)).toBeUndefined();
    expect(await buildPresentedAttachments(id, 'not json')).toBe('not json');
    expect(await buildPresentedAttachments(id, '{"a":1}')).toBe('{"a":1}');
    expect(readOriginalAttachment('not json', 0)).toBeNull();
    expect(readOriginalAttachment(null, 0)).toBeNull();
  });

  test('a page of messages shrinks while non-image rows keep their identity', async () => {
    const original = await bigJpegBase64();
    const rows = [
      { id: messageId('page-text'), attachments: null },
      {
        id: messageId('page-image'),
        attachments: JSON.stringify([
          { type: 'image', data: original, mimeType: 'image/jpeg' },
        ]),
      },
    ];

    const before = Buffer.byteLength(JSON.stringify(rows), 'utf8');
    const presented = await presentMessagesForWeb(rows);
    const after = Buffer.byteLength(JSON.stringify(presented), 'utf8');

    expect(after).toBeLessThan(before / 4);
    // Untouched rows are returned as-is, so callers can rely on referential
    // equality for the common text-only page.
    expect(presented[0]).toBe(rows[0]);
    expect(presented[1].id).toBe(rows[1].id);
  });

  test('a cached thumbnail is reused instead of re-encoding', async () => {
    const id = messageId('cached');
    const stored = JSON.stringify([
      { type: 'image', data: await bigJpegBase64(), mimeType: 'image/jpeg' },
    ]);

    const first = await buildPresentedAttachments(id, stored);
    const cachePath = path.join(DATA_DIR, 'thumbnails', `${id}_0.jpg`);
    expect(fs.existsSync(cachePath)).toBe(true);

    const second = await buildPresentedAttachments(id, stored);
    expect(second).toBe(first);

    invalidateThumbnails(id);
    expect(fs.existsSync(cachePath)).toBe(false);
  });

  test('invalidateThumbnails removes every cached index, not just the first eight', async () => {
    const id = messageId('ten-slots');
    const original = await bigJpegBase64();
    const stored = JSON.stringify(
      Array.from({ length: 10 }, () => ({
        type: 'image',
        data: original,
        mimeType: 'image/jpeg',
      })),
    );

    await buildPresentedAttachments(id, stored);
    const lastPath = path.join(DATA_DIR, 'thumbnails', `${id}_9.jpg`);
    expect(fs.existsSync(lastPath)).toBe(true);

    invalidateThumbnails(id);
    expect(fs.existsSync(lastPath)).toBe(false);
    expect(
      fs
        .readdirSync(path.join(DATA_DIR, 'thumbnails'))
        .some((name) => name.startsWith(`${id}_`)),
    ).toBe(false);
  });
});
