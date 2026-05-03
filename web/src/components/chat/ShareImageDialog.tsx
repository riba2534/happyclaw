import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, Download, RefreshCw, Copy, Check } from 'lucide-react';
import { toCanvas } from 'html-to-image';
import { Message } from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';
import { downloadFromDataUrl } from '../../utils/download';
import { showToast } from '../../utils/toast';
import {
  ShareCardRenderer,
  SHARE_CARD_DEFAULT_WIDTH,
  SHARE_CARD_MAX_WIDTH,
  SHARE_CARD_PADDING,
} from './ShareCardRenderer';

interface ShareImageDialogProps {
  onClose: () => void;
  message: Message;
}

type GenerateState = 'generating' | 'preview' | 'error';

interface ImageOverlay {
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const DEFAULT_EXPORT_PIXEL_RATIO = 2;
const DESKTOP_CANVAS_MAX_PIXELS = 48_000_000;
const IOS_CANVAS_MAX_PIXELS = 14_000_000;
const IOS_CANVAS_MAX_SIDE = 14_000;
const MIN_EXPORT_PIXEL_RATIO = 0.6;

function isIOSLike(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const iOSDevice = /iPad|iPhone|iPod/.test(ua);
  const iPadDesktopMode =
    navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return iOSDevice || iPadDesktopMode;
}

function computeExportPixelRatio(el: HTMLElement): number {
  const rect = el.getBoundingClientRect();
  const width = Math.ceil(rect.width || el.scrollWidth || SHARE_CARD_DEFAULT_WIDTH);
  const height = Math.ceil(rect.height || el.scrollHeight || 1);
  const ios = isIOSLike();
  const maxPixels = ios ? IOS_CANVAS_MAX_PIXELS : DESKTOP_CANVAS_MAX_PIXELS;
  let ratio = DEFAULT_EXPORT_PIXEL_RATIO;

  const areaAtDefault = width * height * ratio * ratio;
  if (areaAtDefault > maxPixels) {
    ratio = Math.sqrt(maxPixels / Math.max(width * height, 1));
  }

  if (ios) {
    ratio = Math.min(ratio, IOS_CANVAS_MAX_SIDE / Math.max(width, height, 1));
  }

  return Math.max(MIN_EXPORT_PIXEL_RATIO, Math.min(DEFAULT_EXPORT_PIXEL_RATIO, ratio));
}

/**
 * Wait for Mermaid diagrams and images inside the container to finish rendering.
 * Uses MutationObserver for DOM-based loaders (Mermaid placeholders) and explicit
 * load/error event listeners for images (since image loading does not produce DOM mutations).
 */
function waitForRenderComplete(container: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    let resolved = false;
    const finish = () => {
      if (resolved) return;
      resolved = true;
      observer.disconnect();
      clearTimeout(timeout);
      // Small extra delay to let SVG painting settle
      setTimeout(resolve, 300);
    };

    const observer = new MutationObserver(check);
    const timeout = setTimeout(finish, 5000);
    const watched = new WeakSet<HTMLImageElement>();

    function watchImage(img: HTMLImageElement) {
      if (watched.has(img) || img.complete) return;
      watched.add(img);
      const handler = () => check();
      img.addEventListener('load', handler, { once: true });
      img.addEventListener('error', handler, { once: true });
    }

    function check() {
      // Mermaid loading placeholders use animate-pulse
      const loading = container.querySelectorAll('.animate-pulse');
      const images = container.querySelectorAll('img');
      images.forEach(watchImage);
      // `complete` is true once the image has either successfully loaded OR
      // errored out (settled state). Don't gate on `naturalWidth > 0` here —
      // a 404 image would otherwise stall the export until the 5s timeout
      // even though its load already finished.
      const allImagesLoaded = Array.from(images).every((img) => img.complete);
      if (loading.length === 0 && allImagesLoaded) {
        finish();
      }
    }

    observer.observe(container, { childList: true, subtree: true });
    check();
  });
}

function decodeBase64Url(value: string): string | null {
  try {
    const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return decodeURIComponent(
      Array.from(atob(padded))
        .map((char) => `%${char.charCodeAt(0).toString(16).padStart(2, '0')}`)
        .join(''),
    );
  } catch {
    return null;
  }
}

function inferImageMimeType(src: string, fallback?: string): string {
  if (fallback?.startsWith('image/')) return fallback;

  const pathSegment = (() => {
    try {
      const url = new URL(src, window.location.href);
      const last = url.pathname.split('/').filter(Boolean).pop();
      return last ? decodeBase64Url(last) || last : '';
    } catch {
      const last = src.split('?')[0].split('/').filter(Boolean).pop();
      return last ? decodeBase64Url(last) || last : '';
    }
  })().toLowerCase();

  if (pathSegment.endsWith('.jpg') || pathSegment.endsWith('.jpeg')) return 'image/jpeg';
  if (pathSegment.endsWith('.webp')) return 'image/webp';
  if (pathSegment.endsWith('.gif')) return 'image/gif';
  if (pathSegment.endsWith('.svg')) return 'image/svg+xml';
  if (pathSegment.endsWith('.png')) return 'image/png';
  return 'image/png';
}

function blobToDataUrl(blob: Blob, src: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onloadend = () => resolve(String(reader.result || ''));
    const imageBlob = blob.type.startsWith('image/')
      ? blob
      : new Blob([blob], { type: inferImageMimeType(src, blob.type) });
    reader.readAsDataURL(imageBlob);
  });
}

const IMAGE_READY_TIMEOUT_MS = 4000;

async function waitForImageReady(img: HTMLImageElement): Promise<void> {
  if (img.complete && img.naturalWidth > 0) return;
  // Settled-but-broken (e.g. malformed data URL): don't block the dialog
  // waiting for events that will never come.
  if (img.complete) return;
  if (img.decode) {
    try {
      await img.decode();
      return;
    } catch {
      // Fall through to load/error listeners. Safari can reject decode() while
      // still completing the image normally.
    }
  }
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', done, { once: true });
    // Safety net: a corrupt data URL can leave the image in a state where
    // neither `load` nor `error` ever fires. Cap the wait so the share
    // dialog doesn't stall on a single bad inline.
    setTimeout(done, IMAGE_READY_TIMEOUT_MS);
  });
}

async function setImageSrcAndWait(img: HTMLImageElement, src: string): Promise<void> {
  await new Promise<void>((resolve) => {
    const done = () => resolve();
    img.addEventListener('load', done, { once: true });
    img.addEventListener('error', done, { once: true });
    img.src = src;
    if (img.complete) resolve();
  });
  await waitForImageReady(img);
}

/**
 * html-to-image re-fetches <img> resources while cloning the card. In iOS PWA,
 * authenticated same-origin image URLs can render fine in the page but turn
 * into white boxes during that second pass. Inline them explicitly first.
 * Download endpoints return application/octet-stream, so force an image MIME
 * from the original filename before assigning data URLs.
 */
async function inlineImagesAsDataUrls(container: HTMLElement): Promise<void> {
  const images = Array.from(container.querySelectorAll('img'));
  await Promise.all(
    images.map(async (img) => {
      const src = img.currentSrc || img.src;
      if (!src || src.startsWith('data:') || src.startsWith('blob:')) return;

      try {
        const res = await fetch(src, { credentials: 'include' });
        if (!res.ok) return;
        const blob = await res.blob();
        img.srcset = '';
        await setImageSrcAndWait(img, await blobToDataUrl(blob, src));
      } catch {
        // Best effort: keep the original src so html-to-image can still try.
      }
    }),
  );
}

function getImageContentRect(img: HTMLImageElement, rootRect: DOMRect): ImageOverlay | null {
  const rect = img.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;

  const style = getComputedStyle(img);
  const borderLeft = parseFloat(style.borderLeftWidth || '0') || 0;
  const borderTop = parseFloat(style.borderTopWidth || '0') || 0;
  const borderRight = parseFloat(style.borderRightWidth || '0') || 0;
  const borderBottom = parseFloat(style.borderBottomWidth || '0') || 0;
  const width = Math.max(0, rect.width - borderLeft - borderRight);
  const height = Math.max(0, rect.height - borderTop - borderBottom);
  const src = img.currentSrc || img.src;
  if (!src || width <= 0 || height <= 0) return null;

  return {
    src,
    x: rect.left - rootRect.left + borderLeft,
    y: rect.top - rootRect.top + borderTop,
    width,
    height,
  };
}

function isSafeOverlayImageSrc(src: string): boolean {
  if (src.startsWith('data:') || src.startsWith('blob:')) return true;
  try {
    return new URL(src, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}

function isSafeImageOverlay(overlay: ImageOverlay | null): overlay is ImageOverlay {
  return overlay !== null && isSafeOverlayImageSrc(overlay.src);
}

function collectImageOverlays(container: HTMLElement): ImageOverlay[] {
  const rootRect = container.getBoundingClientRect();
  return Array.from(container.querySelectorAll('img'))
    .map((img) => getImageContentRect(img, rootRect))
    .filter(isSafeImageOverlay);
}

function loadOverlayImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Failed to load overlay image'));
    img.src = src;
  });
}

async function paintImageOverlays(canvas: HTMLCanvasElement, root: HTMLElement, overlays: ImageOverlay[]): Promise<void> {
  if (overlays.length === 0) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const rootRect = root.getBoundingClientRect();
  const scaleX = canvas.width / Math.max(rootRect.width, 1);
  const scaleY = canvas.height / Math.max(rootRect.height, 1);

  // Load concurrently for speed, but draw sequentially in overlays order so
  // that any future case with positionally-overlapping images preserves DOM
  // paint order (later in the list = drawn last = visually on top). Today's
  // chat markdown is block flow with no overlaps; this is defence in depth.
  const loaded = await Promise.all(
    overlays.map((overlay) =>
      loadOverlayImage(overlay.src).then(
        (img) => ({ overlay, img }) as const,
        () => null,
      ),
    ),
  );
  for (const entry of loaded) {
    if (!entry) continue; // load failed — leave the html-to-image render in place
    const { overlay, img } = entry;
    ctx.drawImage(
      img,
      overlay.x * scaleX,
      overlay.y * scaleY,
      overlay.width * scaleX,
      overlay.height * scaleY,
    );
  }
}

export function ShareImageDialog({ onClose, message }: ShareImageDialogProps) {
  const [state, setState] = useState<GenerateState>('generating');
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const cardRef = useRef<HTMLDivElement>(null);
  const currentUser = useAuthStore((s) => s.user);
  const appearance = useAuthStore((s) => s.appearance);

  const senderName = currentUser?.ai_name || appearance?.aiName || message.sender_name || 'AI';
  const aiEmoji = currentUser?.ai_avatar_emoji || appearance?.aiAvatarEmoji;
  const aiColor = currentUser?.ai_avatar_color || appearance?.aiAvatarColor;
  const aiImageUrl = currentUser?.ai_avatar_url;

  const timestamp = new Date(message.timestamp)
    .toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    })
    .replace(/\//g, '-');

  const generate = useCallback(async () => {
    setState('generating');
    setDataUrl(null);
    setErrorMsg('');

    // Wait a tick for offscreen card to mount
    await new Promise((r) => setTimeout(r, 100));

    const el = cardRef.current;
    if (!el) {
      setState('error');
      setErrorMsg('渲染容器未就绪');
      return;
    }

    try {
      // Phase 1: Expand card to measure natural table widths (no wrapping constraint)
      el.style.width = `${SHARE_CARD_MAX_WIDTH}px`;
      await new Promise((r) => requestAnimationFrame(r));

      await waitForRenderComplete(el);
      await inlineImagesAsDataUrls(el);
      await waitForRenderComplete(el);

      // Measure widest table to determine optimal card width
      const tables = el.querySelectorAll('table');
      let maxTableWidth = 0;
      tables.forEach((table) => {
        maxTableWidth = Math.max(maxTableWidth, table.scrollWidth);
      });

      // Phase 2: Set card to optimal width — fits tables while capping at max
      const cardWidth = Math.max(
        SHARE_CARD_DEFAULT_WIDTH,
        Math.min(maxTableWidth + SHARE_CARD_PADDING, SHARE_CARD_MAX_WIDTH),
      );
      el.style.width = `${cardWidth}px`;
      await new Promise((r) => requestAnimationFrame(r));

      await waitForRenderComplete(el);
      const imageOverlays = collectImageOverlays(el);
      const canvas = await toCanvas(el, {
        pixelRatio: computeExportPixelRatio(el),
        cacheBust: true,
        includeQueryParams: true,
        fetchRequestInit: { credentials: 'include' },
        backgroundColor: '#ffffff',
      });
      await paintImageOverlays(canvas, el, imageOverlays);
      const url = canvas.toDataURL('image/png');
      setDataUrl(url);
      setState('preview');
    } catch (err) {
      setState('error');
      setErrorMsg(err instanceof Error ? err.message : '生成图片失败');
    }
  }, []);

  useEffect(() => {
    generate();
  }, [generate]);

  const [copied, setCopied] = useState(false);

  const handleDownload = () => {
    if (!dataUrl) return;
    downloadFromDataUrl(dataUrl, `share-${Date.now()}.png`).catch((err) => {
      console.error('Share image download failed:', err);
      showToast('保存失败', err instanceof Error ? err.message : '图片保存出错，请重试');
    });
  };

  const handleCopy = async () => {
    if (!dataUrl) return;
    try {
      const res = await fetch(dataUrl);
      const blob = await res.blob();
      await navigator.clipboard.write([
        new ClipboardItem({ [blob.type]: blob }),
      ]);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Share image copy failed:', err);
      showToast('复制失败', '浏览器不支持复制图片到剪切板，请使用下载');
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      {/* Dialog card */}
      <div
        className="relative bg-card rounded-2xl shadow-2xl border border-border w-[90vw] max-w-2xl max-h-[85vh] flex flex-col animate-in zoom-in-95 fade-in duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-base font-semibold text-foreground">生成分享图片</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-foreground/10 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto p-5">
          {state === 'generating' && (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <RefreshCw className="w-6 h-6 text-primary animate-spin" />
              <span className="text-sm text-muted-foreground">正在渲染图片...</span>
            </div>
          )}

          {state === 'error' && (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <span className="text-sm text-destructive">{errorMsg}</span>
              <button
                onClick={generate}
                className="px-4 py-2 text-sm bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-opacity cursor-pointer"
              >
                重试
              </button>
            </div>
          )}

          {state === 'preview' && dataUrl && (
            <img
              src={dataUrl}
              alt="分享预览"
              className="w-full rounded-lg border border-border"
            />
          )}
        </div>

        {/* Footer */}
        {state === 'preview' && (
          <div className="flex gap-3 px-5 py-4 border-t border-border">
            <button
              onClick={handleCopy}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium border border-border rounded-lg hover:bg-accent transition-colors cursor-pointer"
            >
              {copied ? <Check className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
              {copied ? '已复制' : '复制图片'}
            </button>
            <button
              onClick={handleDownload}
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:opacity-90 transition-opacity cursor-pointer"
            >
              <Download className="w-4 h-4" />
              保存图片
            </button>
          </div>
        )}
      </div>

      {/* Hidden render area — keep it paintable for iOS PWA image rasterization. */}
      <div style={{ position: 'fixed', left: 0, top: 0, zIndex: -1, pointerEvents: 'none' }}>
        <ShareCardRenderer
          ref={cardRef}
          content={message.content}
          senderName={senderName}
          timestamp={timestamp}
          groupJid={message.chat_jid}
          aiEmoji={aiEmoji}
          aiColor={aiColor}
          aiImageUrl={aiImageUrl}
        />
      </div>
    </div>,
    document.body,
  );
}
