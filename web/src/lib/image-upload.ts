/**
 * Prepare a chat image for sending. Phone photos are 3–12 MB; sent as base64
 * JSON they time out on mobile uplinks and get re-broadcast to every open tab.
 * Claude downsizes anything with a long edge above ~1568px anyway, so large
 * images are re-encoded at a 2048px long edge before upload. Small images
 * (screenshots, diagrams) pass through untouched to stay lossless.
 */

/** Long edge after downscaling; above Claude's own ~1568px resize. */
export const UPLOAD_IMAGE_MAX_EDGE = 2048;
/** Images at or below this size and edge are sent as-is. */
const PASS_THROUGH_BYTES = 1.5 * 1024 * 1024;
/** Largest source we try to decode; bigger files are rejected up front. */
export const MAX_SOURCE_IMAGE_BYTES = 40 * 1024 * 1024;
/** Matches the server's per-image limit (src/schemas.ts). */
export const MAX_UPLOAD_IMAGE_BYTES = 5 * 1024 * 1024;

export interface PreparedImage {
  data: string; // base64, no data: prefix
  mimeType: string;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality: number,
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

async function downscale(file: File): Promise<Blob | null> {
  let bitmap: ImageBitmap;
  try {
    // EXIF orientation is applied by default (the spec default is
    // 'from-image'). Passing the option explicitly throws a TypeError in
    // engines that predate the enum value (Safari < 16, Chrome < 112), which
    // would silently skip downscaling there.
    bitmap = await createImageBitmap(file);
  } catch {
    return null; // Unsupported format (e.g. HEIC on some browsers).
  }
  try {
    const longEdge = Math.max(bitmap.width, bitmap.height);
    if (longEdge <= UPLOAD_IMAGE_MAX_EDGE && file.size <= PASS_THROUGH_BYTES) {
      return null;
    }
    const scale = Math.min(1, UPLOAD_IMAGE_MAX_EDGE / longEdge);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    // JPEG for photos; WebP keeps transparency for everything else. Browsers
    // that cannot encode WebP fall back to PNG, which is rarely smaller.
    const blob =
      file.type === 'image/jpeg'
        ? await canvasToBlob(canvas, 'image/jpeg', 0.85)
        : await canvasToBlob(canvas, 'image/webp', 0.9);
    if (!blob || blob.type === 'image/png' || blob.size >= file.size) {
      return null;
    }
    return blob;
  } finally {
    bitmap.close();
  }
}

/**
 * Returns the image to send, or throws an Error with a user-facing message.
 * GIF and SVG are never re-encoded (animation, vectors).
 */
export async function prepareImageForUpload(
  file: File,
): Promise<PreparedImage> {
  if (file.size > MAX_SOURCE_IMAGE_BYTES) {
    throw new Error(
      `图片 ${file.name} 过大（${(file.size / 1024 / 1024).toFixed(1)}MB）`,
    );
  }
  const reencodable = !/^image\/(gif|svg\+xml)$/.test(file.type);
  const resized = reencodable ? await downscale(file) : null;
  const blob = resized ?? file;
  if (blob.size > MAX_UPLOAD_IMAGE_BYTES) {
    throw new Error(
      `图片 ${file.name} 超过 5MB 限制 (${(blob.size / 1024 / 1024).toFixed(1)}MB)`,
    );
  }
  return {
    data: await blobToBase64(blob),
    mimeType: resized ? resized.type : file.type,
  };
}
