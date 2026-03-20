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

import { withBasePath } from './url';

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

/**
 * Download a file from an API endpoint (or any same-origin URL).
 * Uses fetch with credentials so auth cookies are always included.
 */
export async function downloadFromUrl(url: string, filename: string): Promise<void> {
  const fullUrl = url.startsWith('http') ? url : withBasePath(url);
  const res = await fetch(fullUrl, { credentials: 'include' });
  if (!res.ok) {
    throw new Error(`下载失败: ${res.status}`);
  }
  const blob = await res.blob();
  triggerBlobDownload(blob, filename);
}

/**
 * Download a data-URL (e.g. from html-to-image / canvas) as a file.
 * Converts to Blob first to avoid browser data-URL size limits.
 */
export async function downloadFromDataUrl(dataUrl: string, filename: string): Promise<void> {
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  triggerBlobDownload(blob, filename);
}
