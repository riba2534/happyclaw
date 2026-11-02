/**
 * Reliable file download utilities using fetch + blob.
 *
 * The old pattern `<a href="url" download="name">.click()` breaks on:
 *   - iOS Safari / PWA standalone mode (download attr ignored for server URLs)
 *   - Large data URLs (browser size limits)
 *   - Some mobile browsers (programmatic click not honoured)
 *
 * This module always goes through fetch → Blob → ObjectURL which works
 * consistently across all modern browsers and PWA modes.
 */

import { isIOSDevice, withBasePath } from './url';

export class DownloadError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'DownloadError';
  }
}

async function readDownloadErrorMessage(response: Response): Promise<string> {
  const fallback = `下载失败 (${response.status})`;
  const contentType = response.headers.get('content-type') || '';

  try {
    if (contentType.includes('application/json')) {
      const body = (await response.json()) as {
        error?: unknown;
        message?: unknown;
      };
      const message =
        typeof body.error === 'string'
          ? body.error
          : typeof body.message === 'string'
            ? body.message
            : null;
      return message?.trim() || fallback;
    }

    if (contentType.startsWith('text/plain')) {
      return (await response.text()).trim() || fallback;
    }
  } catch {
    // Keep a safe status-based message when the response body is malformed.
  }

  return fallback;
}

/**
 * Trigger a browser download from a Blob.
 */
function triggerBlobDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after a short delay so the browser has time to start the download.
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

/** Download UTF-8 text generated in the browser (for example a CSV export). */
export function downloadTextFile(
  content: string,
  filename: string,
  mimeType = 'text/plain;charset=utf-8',
): void {
  triggerBlobDownload(new Blob([content], { type: mimeType }), filename);
}

/**
 * Download a file from an API endpoint (or any same-origin URL).
 * Uses fetch with credentials so auth cookies are always included.
 */
export async function downloadFromUrl(
  url: string,
  filename: string,
): Promise<void> {
  const fullUrl = url.startsWith('http') ? url : withBasePath(url);
  const res = await fetch(fullUrl, { credentials: 'include' });
  if (!res.ok) {
    throw new DownloadError(res.status, await readDownloadErrorMessage(res));
  }
  const blob = await res.blob();
  triggerBlobDownload(blob, filename);
}

/**
 * Download a data-URL (e.g. from html-to-image / canvas) as a file.
 * Converts to Blob first to avoid browser data-URL size limits.
 */
export async function downloadFromDataUrl(
  dataUrl: string,
  filename: string,
): Promise<void> {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  triggerBlobDownload(blob, filename);
}

const IMAGE_EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
};

/** The image type a file name's extension stands for. */
function typeForExtension(name: string): string | undefined {
  const ext = /\.([a-z0-9]+)$/i.exec(name)?.[1].toLowerCase();
  const normalized = ext === 'jpeg' ? 'jpg' : ext;
  return Object.keys(IMAGE_EXTENSIONS).find(
    (type) => IMAGE_EXTENSIONS[type] === normalized,
  );
}

/** PNG, JPEG, GIF or WebP by the file's first bytes. */
async function sniffImageType(blob: Blob): Promise<string | undefined> {
  const head = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const ascii = (from: number, to: number) =>
    String.fromCharCode(...head.subarray(from, to));
  if (head[0] === 0x89 && ascii(1, 4) === 'PNG') return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    return 'image/jpeg';
  }
  if (ascii(0, 4) === 'GIF8') return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return undefined;
}

/** `name` with the extension `type` takes, or `image-<time>` for none. */
function imageFileName(name: string | undefined, type: string): string {
  const base = name?.trim() || `image-${Date.now()}`;
  const ext = IMAGE_EXTENSIONS[type];
  const named = typeForExtension(base);
  if (!ext || named === type) return base;
  return `${named ? base.replace(/\.[^.]+$/, '') : base}.${ext}`;
}

/** An image from another site that shows on the page but may not be read. */
export class CrossOriginImageError extends Error {
  constructor() {
    super('Cross-origin image cannot be read');
    this.name = 'CrossOriginImageError';
  }
}

/**
 * Fetch an image the page shows as a file to save. `src` resolves the way
 * the `<img>` resolves it, so the bytes are the ones on screen. Cookies go
 * to this origin only; another site that does not allow the read fails with
 * `CrossOriginImageError`. A body not labelled as an image (the workspace
 * file route sends octet-stream) is typed by its first bytes, then by the
 * extension of `name` or of the URL.
 */
export async function fetchImageFile(
  src: string,
  name?: string,
  signal?: AbortSignal,
): Promise<File> {
  const url = new URL(src, document.baseURI);
  const crossOrigin =
    /^https?:$/.test(url.protocol) && url.origin !== window.location.origin;
  const res = await fetch(url.href, {
    credentials: crossOrigin ? 'omit' : 'same-origin',
    signal,
  }).catch((err: unknown) => {
    throw crossOrigin && err instanceof TypeError
      ? new CrossOriginImageError()
      : err;
  });
  if (!res.ok) {
    throw new DownloadError(res.status, await readDownloadErrorMessage(res));
  }
  const blob = await res.blob();
  const declared = blob.type.split(';')[0].trim();
  const type = declared.startsWith('image/')
    ? declared
    : ((await sniffImageType(blob)) ??
      typeForExtension(name ?? '') ??
      typeForExtension(url.pathname) ??
      declared);
  return new File([blob], imageFileName(name, type), { type });
}

/**
 * Whether an image is saved through the share sheet. iOS puts it in Photos
 * from there ("Save Image"); its downloads go to Files. Android's sheet has
 * no general "save to gallery", and a download works there, installed app
 * included, as it does on a desktop.
 */
export function prefersShareSheet(): boolean {
  return isIOSDevice() && typeof navigator.share === 'function';
}

const errorName = (err: unknown) => (err as { name?: unknown } | null)?.name;

/** A fetch or share sheet cancelled on purpose (by code or by the user). */
export const isAbortError = (err: unknown) => errorName(err) === 'AbortError';

/**
 * Save a fetched image: the share sheet where that is the way to Photos,
 * a download otherwise. WebKit opens the sheet only within a tap's user
 * activation, so call this in the tap's handler before any `await`. A sheet
 * refused for want of one falls back to the download; one the user
 * dismisses ends quietly.
 */
export async function saveImageFile(file: File): Promise<void> {
  if (prefersShareSheet() && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (err) {
      if (isAbortError(err)) return;
      if (errorName(err) !== 'NotAllowedError') throw err;
    }
  }
  triggerBlobDownload(file, file.name);
}
