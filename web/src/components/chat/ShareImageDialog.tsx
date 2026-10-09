import { useState, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Download, Copy, Check } from 'lucide-react';
import { toCanvas } from 'html-to-image';
import { Message } from '../../stores/chat';
import { downloadFromDataUrl } from '../../utils/download';
import { showToast } from '../../utils/toast';
import { isIOSDevice } from '../../utils/url';
import {
  ShareCardRenderer,
  SHARE_CARD_DEFAULT_WIDTH,
  SHARE_CARD_MAX_WIDTH,
  SHARE_CARD_PADDING,
} from './ShareCardRenderer';
import { resolveAgentDisplayIdentity } from '../../utils/agent-identity';
import { useAuthStore } from '../../stores/auth';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

interface ShareImageDialogProps {
  onClose: () => void;
  message: Message;
  agentName?: string;
  agentAvatarUrl?: string | null;
  agentAvatarEmoji?: string | null;
  agentAvatarColor?: string | null;
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

function computeExportPixelRatio(el: HTMLElement): number {
  const rect = el.getBoundingClientRect();
  const width = Math.ceil(
    rect.width || el.scrollWidth || SHARE_CARD_DEFAULT_WIDTH,
  );
  const height = Math.ceil(rect.height || el.scrollHeight || 1);
  const ios = isIOSDevice();
  const maxPixels = ios ? IOS_CANVAS_MAX_PIXELS : DESKTOP_CANVAS_MAX_PIXELS;
  let ratio = DEFAULT_EXPORT_PIXEL_RATIO;

  const areaAtDefault = width * height * ratio * ratio;
  if (areaAtDefault > maxPixels) {
    ratio = Math.sqrt(maxPixels / Math.max(width * height, 1));
  }

  if (ios) {
    ratio = Math.min(ratio, IOS_CANVAS_MAX_SIDE / Math.max(width, height, 1));
  }

  return Math.max(
    MIN_EXPORT_PIXEL_RATIO,
    Math.min(DEFAULT_EXPORT_PIXEL_RATIO, ratio),
  );
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
      const loading = container.querySelectorAll(
        '.animate-pulse, [data-markdown-pending="true"]',
      );
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

  if (pathSegment.endsWith('.jpg') || pathSegment.endsWith('.jpeg'))
    return 'image/jpeg';
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

async function setImageSrcAndWait(
  img: HTMLImageElement,
  src: string,
): Promise<void> {
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

function getImageContentRect(
  img: HTMLImageElement,
  rootRect: DOMRect,
): ImageOverlay | null {
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

function isSafeImageOverlay(
  overlay: ImageOverlay | null,
): overlay is ImageOverlay {
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

async function paintImageOverlays(
  canvas: HTMLCanvasElement,
  root: HTMLElement,
  overlays: ImageOverlay[],
): Promise<void> {
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

export function ShareImageDialog({
  onClose,
  message,
  agentName,
  agentAvatarUrl,
  agentAvatarEmoji,
  agentAvatarColor,
}: ShareImageDialogProps) {
  const [state, setState] = useState<GenerateState>('generating');
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [previewWidth, setPreviewWidth] = useState<number | null>(null);
  const [errorMsg, setErrorMsg] = useState('');
  const cardRef = useRef<HTMLDivElement>(null);
  const appearance = useAuthStore((state) => state.appearance);
  const agentIdentity = resolveAgentDisplayIdentity({
    agentName,
    messageSenderName: message.sender_name,
    avatarUrl: agentAvatarUrl,
    avatarEmoji: agentAvatarEmoji,
    avatarColor: agentAvatarColor,
    mainAvatarUrl: appearance?.aiAvatarUrl,
    mainAvatarEmoji:
      appearance?.aiAvatarMode === 'emoji'
        ? appearance.aiAvatarEmoji
        : undefined,
    mainAvatarColor:
      appearance?.aiAvatarMode === 'emoji'
        ? appearance.aiAvatarColor
        : undefined,
  });
  const senderName = agentIdentity.name;

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
    setPreviewWidth(null);
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
      const previewRect = el.getBoundingClientRect();
      setPreviewWidth(Math.ceil(previewRect.width || cardWidth));
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
      showToast(
        '保存失败',
        err instanceof Error ? err.message : '图片保存出错，请重试',
      );
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

  return (
    <>
      <Dialog open onOpenChange={(open) => !open && onClose()}>
        {/* Hug the card: its width plus the body padding (2 × 16px) and the
            preview ring, capped to the viewport. */}
        <DialogContent
          className="flex max-h-[88vh] max-w-none flex-col gap-0 p-0 sm:max-w-none"
          style={{
            width: `min(calc(100vw - 2rem), ${(previewWidth ?? SHARE_CARD_DEFAULT_WIDTH) + 34}px)`,
          }}
        >
          {/* Header */}
          <DialogHeader className="border-b border-surface-border px-4 py-3 pr-12">
            <DialogTitle>生成分享图片</DialogTitle>
            <DialogDescription className="sr-only">
              将这条回复渲染为长图，可复制或保存
            </DialogDescription>
          </DialogHeader>

          {/* Body */}
          <div className="min-h-0 flex-1 overflow-auto p-4">
            {state === 'generating' && (
              <div className="flex flex-col items-center justify-center gap-3 py-16">
                <Spinner className="size-5 text-muted-foreground" />
                <span className="text-body text-muted-foreground">
                  正在渲染图片...
                </span>
              </div>
            )}

            {state === 'error' && (
              <div className="flex flex-col items-center justify-center gap-3 py-16">
                <span className="text-body text-error">{errorMsg}</span>
                <Button variant="outline" onClick={generate}>
                  重试
                </Button>
              </div>
            )}

            {state === 'preview' && dataUrl && (
              <div className="flex justify-center">
                <img
                  src={dataUrl}
                  alt="分享预览"
                  className="block rounded-lg ring-1 ring-surface-border"
                  style={{
                    width: previewWidth ? `${previewWidth}px` : undefined,
                    maxWidth: '100%',
                    height: 'auto',
                  }}
                />
              </div>
            )}
          </div>

          {/* Footer */}
          {state === 'preview' && (
            <DialogFooter className="m-0 rounded-b-xl border-surface-border">
              <Button variant="outline" onClick={handleCopy}>
                {copied ? <Check className="text-success" /> : <Copy />}
                {copied ? '已复制' : '复制图片'}
              </Button>
              <Button onClick={handleDownload}>
                <Download />
                保存图片
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>

      {/* Hidden render area — offscreen but still layouted/paintable for iOS
          PWA rasterization. Portaled outside the dialog so its open animation
          (a transform) never scales the card while it is being measured. */}
      {createPortal(
        <div
          aria-hidden="true"
          style={{
            position: 'fixed',
            left: -10000,
            top: 0,
            pointerEvents: 'none',
          }}
        >
          <ShareCardRenderer
            ref={cardRef}
            content={message.content}
            senderName={senderName}
            timestamp={timestamp}
            groupJid={message.chat_jid}
            aiImageUrl={agentIdentity.imageUrl}
            aiEmoji={agentIdentity.emoji}
            aiColor={agentIdentity.color}
          />
        </div>,
        document.body,
      )}
    </>
  );
}
