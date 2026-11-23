import { useEffect, useRef, useState } from 'react';
import { Download, Loader2, X } from 'lucide-react';
import {
  FileEntry,
  toBase64Url,
  workspaceFilesUrl,
} from '../../stores/files';
import { withBasePath } from '../../utils/url';
import { Button } from '@/components/ui/button';
import { IconButton } from '@/components/common/IconButton';
import { PreviewDialog } from './PreviewDialog';

// 与后端 office-preview.ts 的 OFFICE_PREVIEW_EXTENSIONS 保持一致
export const OFFICE_EXTENSIONS = new Set([
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'odt',
  'ods',
  'odp',
]);

export function isOfficeFile(name: string): boolean {
  const dot = name.lastIndexOf('.');
  if (dot < 0) return false;
  return OFFICE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase());
}

export function buildPreviewUrl(
  groupJid: string,
  filePath: string,
  route: 'preview' | 'office-preview' = 'preview',
): string {
  return withBasePath(
    workspaceFilesUrl(groupJid, `files/${route}/${toBase64Url(filePath)}`),
  );
}

// ─── Media Overlay (shared shell for image/pdf/video) ──────────

export function MediaOverlay({
  onClose,
  children,
  fileName,
  bgOpacity = '80',
  action,
}: {
  onClose: () => void;
  children: React.ReactNode;
  fileName: string;
  bgOpacity?: string;
  action?: React.ReactNode;
}) {
  return (
    <PreviewDialog
      title={fileName}
      onClose={onClose}
      overlayClassName={bgOpacity === '90' ? 'bg-black/90' : 'bg-black/80'}
      className="left-1/2 top-1/2 max-h-[calc(100dvh-2rem)] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2"
    >
      <div className="fixed top-4 right-4 z-10 flex items-center gap-1">
        {action}
        <IconButton
          label="关闭预览"
          hideTooltip
          icon={<X className="size-6" />}
          size="icon-lg"
          onClick={onClose}
          className="text-white/70 hover:bg-white/10 hover:text-white"
        />
      </div>
      <div className="fixed bottom-4 left-1/2 max-w-[calc(100vw-2rem)] -translate-x-1/2 truncate rounded-full bg-black/50 px-3 py-1 text-caption text-white/80">
        {fileName}
      </div>
      {children}
    </PreviewDialog>
  );
}

// ─── PDF Preview Overlay ────────────────────────────────────────

export function PdfPreview({
  src,
  file,
  onClose,
  onDownload,
}: {
  src: string;
  file: FileEntry;
  onClose: () => void;
  onDownload?: (file: FileEntry) => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [viewerLoadVersion, setViewerLoadVersion] = useState(0);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || viewerLoadVersion === 0) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    const embeddedWindow = iframe.contentWindow;

    try {
      embeddedWindow?.addEventListener('keydown', handleKeyDown);
      iframe.dataset.escapeBridge = 'ready';
    } catch {
      // Some browser PDF viewers move their controls into an extension
      // process. The dialog close control remains available in that case.
    }
    return () => {
      try {
        embeddedWindow?.removeEventListener('keydown', handleKeyDown);
      } catch {
        // The embedded viewer may have navigated across origins while closing.
      }
    };
  }, [onClose, viewerLoadVersion]);

  return (
    <MediaOverlay
      onClose={onClose}
      fileName={file.name}
      action={
        onDownload ? (
          <IconButton
            label="下载原文件"
            hideTooltip
            icon={<Download className="size-5" />}
            size="icon-lg"
            onClick={() => onDownload(file)}
            className="text-white/70 hover:bg-white/10 hover:text-white"
          />
        ) : undefined
      }
    >
      <iframe
        ref={iframeRef}
        src={src}
        title={file.name}
        className="h-[90dvh] w-[90vw] rounded-lg bg-white"
        tabIndex={0}
        onLoad={() => setViewerLoadVersion((version) => version + 1)}
      />
    </MediaOverlay>
  );
}

// ─── Office Preview Overlay (server-side convert to PDF) ────────

type OfficePreviewLoad =
  | { status: 'loading' }
  | { status: 'ready' }
  | { status: 'error'; message: string };

/** A HEAD response has no body, so the status (one per error code) speaks. */
const OFFICE_PREVIEW_ERRORS: Record<number, string> = {
  400: '不支持预览这种文件',
  401: '登录已过期，请重新登录',
  403: '没有权限预览这个文件',
  404: '文件不存在',
  413: '文件太大，无法预览',
  501: '未配置 Office 预览转换器',
  502: '转换失败',
  503: '正在转换的文件较多，请稍后再试',
  504: '转换超时',
};

export function OfficePreview({
  groupJid,
  file,
  onClose,
  onDownload,
}: {
  groupJid: string;
  file: FileEntry;
  onClose: () => void;
  onDownload: (file: FileEntry) => void;
}) {
  const [state, setState] = useState<OfficePreviewLoad>({ status: 'loading' });
  const url = buildPreviewUrl(groupJid, file.path, 'office-preview');

  useEffect(() => {
    // HEAD runs the conversion and reports how it went without sending the
    // PDF; the iframe then loads the same URL from the server's cache, so
    // the PDF keeps the response's CSP sandbox (a blob: URL would not).
    const controller = new AbortController();
    setState({ status: 'loading' });
    fetch(url, {
      method: 'HEAD',
      credentials: 'include',
      signal: controller.signal,
    })
      .then(
        (res): OfficePreviewLoad =>
          res.ok
            ? { status: 'ready' }
            : {
                status: 'error',
                message:
                  OFFICE_PREVIEW_ERRORS[res.status] ??
                  `Office 预览失败 (${res.status})`,
              },
        (): OfficePreviewLoad => ({
          status: 'error',
          message: '网络连接失败，请稍后重试',
        }),
      )
      .then((next) => {
        if (!controller.signal.aborted) setState(next);
      });
    return () => controller.abort();
  }, [url]);

  if (state.status === 'ready') {
    return (
      <PdfPreview
        src={url}
        file={file}
        onClose={onClose}
        onDownload={onDownload}
      />
    );
  }

  return (
    <MediaOverlay onClose={onClose} fileName={file.name}>
      <div
        className="flex w-[min(90vw,24rem)] flex-col items-center gap-3 rounded-xl bg-surface-raised p-6 text-center"
        onClick={(e) => e.stopPropagation()}
      >
        {state.status === 'loading' ? (
          <>
            <Loader2 className="size-6 animate-spin text-muted-foreground" />
            <p className="text-body text-foreground">正在转换为 PDF 预览...</p>
            <p className="text-caption text-muted-foreground">
              首次打开较大文件可能需要几十秒，之后会使用缓存。
            </p>
          </>
        ) : (
          <>
            <p className="text-body text-foreground">无法预览此文件</p>
            <p className="text-caption text-muted-foreground">
              {state.message}
            </p>
            <Button onClick={() => onDownload(file)}>
              <Download />
              下载原文件
            </Button>
          </>
        )}
      </div>
    </MediaOverlay>
  );
}
