import sharp from 'sharp';

/**
 * Avatars render at 24–48 CSS px (×2–3 on HiDPI screens), but uploads used to
 * be stored byte-for-byte, so a 2000 px PNG (~500 KB in production) was what
 * every chat row and member list downloaded. Uploads are now normalised once:
 * bounded edge, EXIF orientation applied, metadata stripped, WebP output.
 *
 * Animated GIF/WebP keep their animation (each frame resized) as long as the
 * result stays under AVATAR_MAX_ANIMATED_BYTES; larger animations, and ones
 * that exceed the pixel budget across all frames, are flattened to their first
 * frame rather than rejected.
 */

/** Long edge bound, in pixels. Never enlarged. */
export const AVATAR_MAX_EDGE = 256;
const AVATAR_WEBP_QUALITY = 82;
/** Decompression-bomb guard. For animated input it covers all frames. */
export const AVATAR_MAX_INPUT_PIXELS = 40_000_000;
/** Animated output above this is replaced by its first frame. */
export const AVATAR_MAX_ANIMATED_BYTES = 512 * 1024;

export type AvatarSourceFormat = 'jpeg' | 'png' | 'gif' | 'webp';

export type AvatarImageErrorCode = 'unsupported' | 'too_large';

export class AvatarImageError extends Error {
  constructor(
    readonly code: AvatarImageErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AvatarImageError';
  }
}

export interface NormalizedAvatar {
  data: Buffer;
  ext: '.webp';
  contentType: 'image/webp';
  width: number;
  height: number;
  animated: boolean;
  sourceFormat: AvatarSourceFormat;
}

const INVALID_IMAGE_MESSAGE =
  'Invalid image file. Use a valid jpg, png, gif or webp image';

/**
 * Identify the container by its magic bytes. The declared MIME type comes from
 * the client (usually the file extension), so it only gates the request; the
 * bytes decide what libvips is allowed to decode. Anything else (SVG, HEIF,
 * TIFF, …) never reaches sharp.
 */
export function sniffAvatarFormat(buf: Uint8Array): AvatarSourceFormat | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
    return 'jpeg';
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  )
    return 'png';
  if (buf.length >= 6) {
    const head = Buffer.from(buf.subarray(0, 6)).toString('latin1');
    if (head === 'GIF87a' || head === 'GIF89a') return 'gif';
  }
  if (
    buf.length >= 12 &&
    Buffer.from(buf.subarray(0, 4)).toString('latin1') === 'RIFF' &&
    Buffer.from(buf.subarray(8, 12)).toString('latin1') === 'WEBP'
  )
    return 'webp';
  return null;
}

function toAvatarError(err: unknown): AvatarImageError {
  const message = err instanceof Error ? err.message : String(err);
  if (/pixel limit/i.test(message)) {
    return new AvatarImageError(
      'too_large',
      'Image dimensions too large (max 40 megapixels)',
    );
  }
  return new AvatarImageError('unsupported', INVALID_IMAGE_MESSAGE);
}

async function render(
  input: Buffer,
  animated: boolean,
): Promise<{ data: Buffer; width: number; height: number }> {
  // sharp strips EXIF/XMP/ICC by default (converting to sRGB), so nothing such
  // as GPS tags from a phone photo survives into the public avatar URL.
  const { data, info } = await sharp(input, {
    animated,
    autoOrient: true,
    failOn: 'error',
    limitInputPixels: AVATAR_MAX_INPUT_PIXELS,
  })
    .resize(AVATAR_MAX_EDGE, AVATAR_MAX_EDGE, {
      fit: 'inside',
      withoutEnlargement: true,
    })
    .webp({ quality: AVATAR_WEBP_QUALITY })
    .toBuffer({ resolveWithObject: true });
  return {
    data,
    width: info.width,
    height: info.pageHeight ?? info.height,
  };
}

/**
 * Decode, bound and re-encode an uploaded avatar. Throws AvatarImageError for
 * input that is not a decodable jpg/png/gif/webp or exceeds the pixel budget.
 */
export async function normalizeAvatarImage(
  input: Buffer,
): Promise<NormalizedAvatar> {
  const sourceFormat = sniffAvatarFormat(input);
  if (!sourceFormat) {
    throw new AvatarImageError('unsupported', INVALID_IMAGE_MESSAGE);
  }

  let pages = 1;
  try {
    const meta = await sharp(input, { failOn: 'error' }).metadata();
    if (meta.format !== sourceFormat) {
      throw new AvatarImageError('unsupported', INVALID_IMAGE_MESSAGE);
    }
    pages = meta.pages ?? 1;
  } catch (err) {
    if (err instanceof AvatarImageError) throw err;
    throw toAvatarError(err);
  }

  const base = {
    ext: '.webp' as const,
    contentType: 'image/webp' as const,
    sourceFormat,
  };

  if (pages > 1) {
    try {
      const out = await render(input, true);
      if (out.data.length <= AVATAR_MAX_ANIMATED_BYTES) {
        return { ...base, ...out, animated: true };
      }
    } catch {
      // Too many pixels across frames, or a broken later frame: fall back to
      // the first frame below instead of rejecting the upload.
    }
  }

  try {
    const out = await render(input, false);
    return { ...base, ...out, animated: false };
  } catch (err) {
    throw toAvatarError(err);
  }
}
