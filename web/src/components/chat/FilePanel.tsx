import {
  useEffect,
  useId,
  useRef,
  useState,
  useMemo,
  useCallback,
} from 'react';
import {
  Folder,
  FolderOpen,
  ChevronRight,
  Download,
  Trash2,
  FolderPlus,
  RefreshCw,
  X,
  FileText,
  FileCode,
  Image,
  Package,
  File,
  Pencil,
  Save,
  Loader2,
  Eye,
  FileEdit,
  Film,
  Music,
  AlertCircle,
  Copy,
} from 'lucide-react';
import { useFileStore, FileEntry, toBase64Url } from '../../stores/files';
import { useChatStore } from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';
import { useScrollIsolation } from '../../hooks/useScrollIsolation';
import { api } from '../../api/client';
import { withBasePath } from '../../utils/url';
import { downloadFromUrl } from '../../utils/download';
import { showToast } from '../../utils/toast';
import { copyToClipboard } from '../../utils/clipboard';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { IconButton } from '@/components/common/IconButton';
import {
  SegmentedControl,
  type SegmentedOption,
} from '@/components/common/SegmentedControl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { FileUploadZone } from './FileUploadZone';
import { MarkdownRenderer } from './MarkdownRenderer';
import { PreviewDialog } from './PreviewDialog';
import { ScrollEdgeAffordance } from '../common/ScrollEdgeAffordance';

interface FilePanelProps {
  groupJid: string;
  onClose?: () => void;
}

// ─── File type constants ─────────────────────────────────────────

const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'bmp',
  'ico',
]);

const TEXT_EXTENSIONS = new Set([
  'txt',
  'md',
  'json',
  'js',
  'ts',
  'jsx',
  'tsx',
  'css',
  'html',
  'xml',
  'py',
  'go',
  'rs',
  'java',
  'c',
  'cpp',
  'h',
  'sh',
  'yaml',
  'yml',
  'toml',
  'ini',
  'conf',
  'log',
  'csv',
  'svg',
]);

const CODE_EXTENSIONS = new Set([
  'js',
  'ts',
  'jsx',
  'tsx',
  'py',
  'go',
  'rs',
  'java',
  'c',
  'cpp',
  'h',
  'sh',
  'css',
  'html',
  'xml',
  'yaml',
  'yml',
  'toml',
]);

const ARCHIVE_EXTENSIONS = new Set([
  'zip',
  'tar',
  'gz',
  '7z',
  'rar',
  'bz2',
  'xz',
]);

const PDF_EXTENSIONS = new Set(['pdf']);

const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'avi', 'mkv']);

const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'aac', 'm4a', 'flac']);

// ─── File icon component ────────────────────────────────────────

function FileIcon({ name }: { name: string }) {
  const ext = name.split('.').pop()?.toLowerCase() || '';

  if (IMAGE_EXTENSIONS.has(ext))
    return <Image className="size-4 text-pink-500" />;
  if (VIDEO_EXTENSIONS.has(ext))
    return <Film className="size-4 text-purple-500" />;
  if (AUDIO_EXTENSIONS.has(ext))
    return <Music className="size-4 text-cyan-500" />;
  if (ARCHIVE_EXTENSIONS.has(ext))
    return <Package className="size-4 text-amber-500" />;
  if (ext === 'pdf') return <FileText className="size-4 text-red-500" />;
  if (ext === 'json') return <FileCode className="size-4 text-yellow-600" />;
  if (ext === 'md') return <FileText className="size-4 text-blue-500" />;
  if (CODE_EXTENSIONS.has(ext))
    return <FileCode className="size-4 text-emerald-500" />;
  if (TEXT_EXTENSIONS.has(ext))
    return <FileText className="size-4 text-muted-foreground" />;
  return <File className="size-4 text-muted-foreground" />;
}

function getFileExt(name: string): string {
  return name.split('.').pop()?.toLowerCase() || '';
}

/** 黑名单扩展名/文件名模式：不显示预览/编辑按钮 */
const PREVIEW_BLACKLIST_EXTENSIONS = new Set([
  'tmp',
  'swp',
  'swo',
  'temp',
  'cache',
]);

/**
 * 后端是否允许编辑该文件内容。
 * 旧后端不返回 editable 字段时回退到原有的「非系统文件」判断。
 */
function isEntryEditable(item: FileEntry): boolean {
  return item.type === 'file' && (item.editable ?? !item.isSystem);
}

/** 判断文件是否可点击预览（排除临时文件；系统文件仅在可编辑例外时开放） */
function isPreviewableFile(item: FileEntry): boolean {
  if (item.isSystem && !isEntryEditable(item)) return false;
  const ext = getFileExt(item.name);
  if (PREVIEW_BLACKLIST_EXTENSIONS.has(ext)) return false;
  return true;
}

// Preview state: only one overlay can be open at a time
type PreviewState =
  | null
  | { kind: 'image'; file: FileEntry }
  | { kind: 'edit'; file: FileEntry }
  | { kind: 'markdown'; file: FileEntry }
  | { kind: 'pdf'; file: FileEntry }
  | { kind: 'video'; file: FileEntry }
  | { kind: 'audio'; file: FileEntry }
  | { kind: 'text'; file: FileEntry };

// One frame for the text preview, Markdown viewer and editor, so switching
// between them never moves or resizes the window. Full screen on phones.
const PREVIEW_FRAME_CLASS =
  'inset-0 h-[100dvh] w-screen sm:left-1/2 sm:top-1/2 sm:h-[90vh] sm:w-[calc(100vw-2rem)] sm:max-w-4xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:supports-[height:100dvh]:h-[90dvh]';
const PREVIEW_SHELL_CLASS =
  'flex h-full w-full flex-col bg-surface-raised sm:animate-in sm:rounded-xl sm:shadow-floating sm:ring-1 sm:ring-foreground/10 sm:duration-200 sm:zoom-in-95';
const PREVIEW_HEADER_CLASS =
  'flex h-12 shrink-0 items-center justify-between gap-2 border-b border-surface-border pr-2 pl-3 sm:pl-4';
const PREVIEW_FOOTER_CLASS =
  'shrink-0 border-t border-surface-border px-3 py-2 text-caption text-muted-foreground sm:px-4';
const PREVIEW_TEXTAREA_CLASS =
  'h-full w-full resize-none font-mono text-body text-foreground md:text-body';

const MARKDOWN_MODE_OPTIONS: SegmentedOption<'preview' | 'edit'>[] = [
  { value: 'preview', label: '预览', icon: Eye },
  { value: 'edit', label: '编辑', icon: FileEdit },
];

const BREADCRUMB_BUTTON_CLASS =
  'shrink-0 px-1.5 text-caption font-normal pointer-coarse:h-8';
const FILE_ACTION_CLASS = 'text-muted-foreground pointer-coarse:size-9';

// ─── Helpers ─────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(
    Math.floor(Math.log(bytes) / Math.log(k)),
    sizes.length - 1,
  );
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

function buildPreviewUrl(groupJid: string, filePath: string): string {
  return withBasePath(
    `/api/groups/${encodeURIComponent(groupJid)}/files/preview/${toBase64Url(filePath)}`,
  );
}

// ─── Media Overlay (shared shell for image/pdf/video) ──────────

function MediaOverlay({
  onClose,
  children,
  fileName,
  bgOpacity = '80',
}: {
  onClose: () => void;
  children: React.ReactNode;
  fileName: string;
  bgOpacity?: string;
}) {
  return (
    <PreviewDialog
      title={fileName}
      onClose={onClose}
      overlayClassName={bgOpacity === '90' ? 'bg-black/90' : 'bg-black/80'}
      className="left-1/2 top-1/2 max-h-[calc(100dvh-2rem)] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2"
    >
      <IconButton
        label="关闭预览"
        hideTooltip
        icon={<X className="size-6" />}
        size="icon-lg"
        onClick={onClose}
        className="fixed top-4 right-4 z-10 text-white/70 hover:bg-white/10 hover:text-white"
      />
      <div className="fixed bottom-4 left-1/2 max-w-[calc(100vw-2rem)] -translate-x-1/2 truncate rounded-full bg-black/50 px-3 py-1 text-caption text-white/80">
        {fileName}
      </div>
      {children}
    </PreviewDialog>
  );
}

// ─── Image Preview Overlay ──────────────────────────────────────

function ImagePreview({
  groupJid,
  file,
  onClose,
}: {
  groupJid: string;
  file: FileEntry;
  onClose: () => void;
}) {
  return (
    <MediaOverlay onClose={onClose} fileName={file.name}>
      <img
        src={buildPreviewUrl(groupJid, file.path)}
        alt={file.name}
        className="max-h-[calc(100dvh-2rem)] max-w-[calc(100vw-2rem)] object-contain rounded-lg"
        onClick={(e) => e.stopPropagation()}
      />
    </MediaOverlay>
  );
}

// ─── Text Editor Overlay ────────────────────────────────────────

function TextEditor({
  groupJid,
  file,
  onClose,
}: {
  groupJid: string;
  file: FileEntry;
  onClose: () => void;
}) {
  const { getFileContent, saveFileContent } = useFileStore();
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);

  useScrollIsolation(overlayRef);
  useEffect(() => {
    const handleSave = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave_();
      }
    };
    window.addEventListener('keydown', handleSave);
    return () => window.removeEventListener('keydown', handleSave);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, dirty]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const text = await getFileContent(groupJid, file.path);
      if (!cancelled && text !== null) {
        setContent(text);
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [groupJid, file.path, getFileContent]);

  const handleSave_ = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    const ok = await saveFileContent(groupJid, file.path, content);
    setSaving(false);
    if (ok) setDirty(false);
  };

  return (
    <PreviewDialog
      ref={overlayRef}
      title={`编辑 ${file.name}`}
      onClose={onClose}
      overlayClassName="bg-black/50"
      className={PREVIEW_FRAME_CLASS}
    >
      <div className={PREVIEW_SHELL_CLASS}>
        {/* Header */}
        <div className={PREVIEW_HEADER_CLASS}>
          <div className="flex min-w-0 items-center gap-2">
            <FileIcon name={file.name} />
            <span className="truncate text-title-sm text-foreground">
              {file.name}
            </span>
            {dirty && (
              <Badge variant="warning" className="shrink-0">
                未保存
              </Badge>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button onClick={handleSave_} disabled={!dirty || saving}>
              {saving ? <Loader2 className="animate-spin" /> : <Save />}
              保存
            </Button>
            <IconButton
              label="关闭编辑器"
              hideTooltip
              icon={<X />}
              size="icon"
              onClick={onClose}
              className="text-muted-foreground"
            />
          </div>
        </div>

        {/* Editor */}
        <div className="min-h-0 flex-1 overflow-hidden p-2 sm:p-3">
          {loading ? (
            <div className="flex h-full items-center justify-center">
              <p className="text-body text-muted-foreground">加载中...</p>
            </div>
          ) : (
            <Textarea
              value={content}
              onChange={(e) => {
                setContent(e.target.value);
                setDirty(true);
              }}
              className={PREVIEW_TEXTAREA_CLASS}
              spellCheck={false}
            />
          )}
        </div>

        {/* Footer hint */}
        <div className={PREVIEW_FOOTER_CLASS}>Ctrl/Cmd+S 保存 · Esc 关闭</div>
      </div>
    </PreviewDialog>
  );
}

// ─── Markdown File Viewer (Preview + Edit) ─────────────────────

function MarkdownFileViewer({
  groupJid,
  file,
  onClose,
}: {
  groupJid: string;
  file: FileEntry;
  onClose: () => void;
}) {
  const { getFileContent, saveFileContent } = useFileStore();
  const [content, setContent] = useState('');
  const [editContent, setEditContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [mode, setMode] = useState<'preview' | 'edit'>('preview');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const previewScrollRef = useRef<HTMLDivElement>(null);

  useScrollIsolation(overlayRef);

  useEffect(() => {
    const handleSaveKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        doSave();
      }
    };
    window.addEventListener('keydown', handleSaveKey);
    return () => window.removeEventListener('keydown', handleSaveKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editContent, dirty, mode]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const text = await getFileContent(groupJid, file.path);
      if (!cancelled && text !== null) {
        setContent(text);
        setEditContent(text);
      }
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [groupJid, file.path, getFileContent]);

  const doSave = async () => {
    if (!dirty || saving || mode !== 'edit') return;
    setSaving(true);
    const ok = await saveFileContent(groupJid, file.path, editContent);
    setSaving(false);
    if (ok) {
      setContent(editContent);
      setDirty(false);
    }
  };

  const switchToEdit = () => {
    setEditContent(content);
    setMode('edit');
    requestAnimationFrame(() => textareaRef.current?.focus());
  };

  const switchToPreview = () => {
    if (dirty) {
      setContent(editContent);
    }
    setMode('preview');
  };

  return (
    <PreviewDialog
      ref={overlayRef}
      title={`预览 ${file.name}`}
      onClose={onClose}
      overlayClassName="bg-black/50"
      className={PREVIEW_FRAME_CLASS}
    >
      <div className={PREVIEW_SHELL_CLASS}>
        {/* Header */}
        <div className={PREVIEW_HEADER_CLASS}>
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <FileIcon name={file.name} />
            <span className="truncate text-title-sm text-foreground">
              {file.name}
            </span>
            {dirty && (
              <Badge variant="warning" className="shrink-0">
                未保存
              </Badge>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <SegmentedControl
              label="查看方式"
              value={mode}
              options={MARKDOWN_MODE_OPTIONS}
              onChange={(next) => {
                if (next === 'edit') {
                  if (mode !== 'edit') switchToEdit();
                } else {
                  switchToPreview();
                }
              }}
            />
            {mode === 'edit' && (
              <Button
                onClick={doSave}
                disabled={!dirty || saving}
                aria-label="保存"
                className="touch-manipulation"
              >
                {saving ? <Loader2 className="animate-spin" /> : <Save />}
                <span className="hidden sm:inline">保存</span>
              </Button>
            )}
            <IconButton
              label="关闭"
              hideTooltip
              icon={<X />}
              size="icon"
              onClick={onClose}
              className="text-muted-foreground touch-manipulation"
            />
          </div>
        </div>

        {/* Content — explicit overflow container with touch-action for iOS */}
        <div className="flex-1 min-h-0 relative">
          {loading ? (
            <div className="absolute inset-0 flex items-center justify-center">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : mode === 'preview' ? (
            <div
              ref={previewScrollRef}
              className="hc-scroll-pane absolute inset-0 overflow-y-auto overscroll-y-contain px-4 sm:px-6 py-4 [&_table_td]:!whitespace-normal [&_table_th]:!whitespace-normal"
              data-testid="markdown-preview-scroll"
              style={{ WebkitOverflowScrolling: 'touch', touchAction: 'pan-y' }}
            >
              <div data-preview-select-root>
                <MarkdownRenderer
                  content={content}
                  groupJid={groupJid}
                  variant="docs"
                />
              </div>
            </div>
          ) : (
            <div className="absolute inset-0 p-2 sm:p-3">
              <Textarea
                ref={textareaRef}
                value={editContent}
                onChange={(e) => {
                  setEditContent(e.target.value);
                  setDirty(true);
                }}
                className={PREVIEW_TEXTAREA_CLASS}
                style={{
                  WebkitOverflowScrolling: 'touch',
                  touchAction: 'pan-y',
                }}
                spellCheck={false}
              />
            </div>
          )}
          {!loading && mode === 'preview' && (
            <ScrollEdgeAffordance scrollRef={previewScrollRef} />
          )}
        </div>

        {/* Footer */}
        <div className={PREVIEW_FOOTER_CLASS}>
          {mode === 'edit'
            ? 'Ctrl/Cmd+S 保存 · Esc 关闭'
            : '点击「编辑」修改内容 · Esc 关闭'}
        </div>
      </div>
    </PreviewDialog>
  );
}

// ─── PDF Preview Overlay ────────────────────────────────────────

function PdfPreview({
  groupJid,
  file,
  onClose,
}: {
  groupJid: string;
  file: FileEntry;
  onClose: () => void;
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
    <MediaOverlay onClose={onClose} fileName={file.name}>
      <iframe
        ref={iframeRef}
        src={buildPreviewUrl(groupJid, file.path)}
        title={file.name}
        className="h-[90dvh] w-[90vw] rounded-lg bg-white"
        tabIndex={0}
        onLoad={() => setViewerLoadVersion((version) => version + 1)}
      />
    </MediaOverlay>
  );
}

// ─── Video Preview Overlay ─────────────────────────────────────

function VideoPreview({
  groupJid,
  file,
  onClose,
}: {
  groupJid: string;
  file: FileEntry;
  onClose: () => void;
}) {
  return (
    <MediaOverlay onClose={onClose} fileName={file.name} bgOpacity="90">
      <video
        src={buildPreviewUrl(groupJid, file.path)}
        controls
        autoPlay
        className="max-w-[90vw] max-h-[90vh] rounded-lg"
        tabIndex={0}
      />
    </MediaOverlay>
  );
}

// ─── Audio Preview Overlay ─────────────────────────────────────

function AudioPreview({
  groupJid,
  file,
  onClose,
}: {
  groupJid: string;
  file: FileEntry;
  onClose: () => void;
}) {
  return (
    <PreviewDialog
      title={`播放 ${file.name}`}
      onClose={onClose}
      className="left-1/2 top-1/2 w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl bg-surface-raised p-4 shadow-floating ring-1 ring-foreground/10"
    >
      <div className="flex flex-col items-center gap-4">
        <div className="flex w-full items-center gap-3">
          <Music className="size-8 shrink-0 text-cyan-500" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-title-sm text-foreground">
              {file.name}
            </p>
            <p className="text-caption text-muted-foreground tabular-nums">
              {formatSize(file.size)}
            </p>
          </div>
          <IconButton
            label="关闭"
            hideTooltip
            icon={<X />}
            size="icon"
            onClick={onClose}
            className="text-muted-foreground"
          />
        </div>
        <audio
          src={buildPreviewUrl(groupJid, file.path)}
          controls
          autoPlay
          className="w-full"
          tabIndex={0}
        />
      </div>
    </PreviewDialog>
  );
}

// ─── Generic File Preview (for hidden files like .gitignore) ──

function GenericTextPreview({
  groupJid,
  file,
  onClose,
}: {
  groupJid: string;
  file: FileEntry;
  onClose: () => void;
}) {
  const { getFileContent } = useFileStore();
  const [content, setContent] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const contentScrollRef = useRef<HTMLDivElement>(null);

  useScrollIsolation(overlayRef);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setLoadError(false);
      const text = await getFileContent(groupJid, file.path);
      if (!cancelled) {
        if (text !== null) {
          setContent(text);
        } else {
          setLoadError(true);
        }
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [groupJid, file.path, getFileContent]);

  return (
    <PreviewDialog
      ref={overlayRef}
      title={`预览 ${file.name}`}
      onClose={onClose}
      overlayClassName="bg-black/50"
      className={PREVIEW_FRAME_CLASS}
    >
      <div className={PREVIEW_SHELL_CLASS}>
        {/* Header */}
        <div className={PREVIEW_HEADER_CLASS}>
          <div className="flex min-w-0 items-center gap-2">
            <FileIcon name={file.name} />
            <span className="truncate text-title-sm text-foreground">
              {file.name}
            </span>
          </div>
          <IconButton
            label="关闭预览"
            hideTooltip
            icon={<X />}
            size="icon"
            onClick={onClose}
            className="text-muted-foreground"
          />
        </div>

        {/* Content */}
        <div className="relative min-h-0 flex-1">
          <div
            ref={contentScrollRef}
            className="hc-scroll-pane h-full overflow-auto p-4"
            data-testid="text-preview-scroll"
          >
            {loading ? (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </div>
            ) : loadError ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
                <AlertCircle className="size-8 text-faint-foreground" />
                <p className="text-body">此文件类型不支持预览</p>
              </div>
            ) : (
              <pre
                data-preview-select-root
                className="font-mono text-body break-all whitespace-pre-wrap text-foreground"
              >
                {content}
              </pre>
            )}
          </div>
          <ScrollEdgeAffordance scrollRef={contentScrollRef} />
        </div>

        {/* Footer hint */}
        <div className={PREVIEW_FOOTER_CLASS}>Esc 关闭</div>
      </div>
    </PreviewDialog>
  );
}

// ─── Main FilePanel ─────────────────────────────────────────────

export function FilePanel({ groupJid, onClose }: FilePanelProps) {
  const {
    files,
    currentPath,
    loading,
    loadFiles,
    deleteFile,
    createDirectory,
    navigateTo,
  } = useFileStore();

  const newDirInputId = useId();
  const [createDirModal, setCreateDirModal] = useState(false);
  const [newDirName, setNewDirName] = useState('');
  const [createDirLoading, setCreateDirLoading] = useState(false);
  const [openDirLoading, setOpenDirLoading] = useState(false);
  const [openDirError, setOpenDirError] = useState<string | null>(null);

  const [deleteModal, setDeleteModal] = useState<{
    open: boolean;
    path: string;
    name: string;
    isDir: boolean;
  }>({ open: false, path: '', name: '', isDir: false });
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Preview / Editor state — only one overlay can be open at a time
  const [preview, setPreview] = useState<PreviewState>(null);

  const isStreaming = useChatStore((s) => !!s.streaming[groupJid]);
  const canOpenLocalFolder = useAuthStore((s) => s.user?.role === 'admin');
  const prevStreamingRef = useRef(false);
  const fileListScrollRef = useRef<HTMLDivElement>(null);

  const fileList = files[groupJid] || [];
  const currentDir = currentPath[groupJid] || '';

  useEffect(() => {
    if (groupJid) {
      loadFiles(groupJid);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groupJid]);

  // Agent 运行期间定时刷新文件列表；结束时做最终刷新
  useEffect(() => {
    if (isStreaming) {
      prevStreamingRef.current = true;
      const timer = setInterval(() => {
        loadFiles(groupJid, currentDir);
      }, 5000);
      return () => clearInterval(timer);
    }
    // streaming 刚结束 → 最终刷新
    if (prevStreamingRef.current) {
      prevStreamingRef.current = false;
      loadFiles(groupJid, currentDir);
    }
  }, [isStreaming, groupJid, currentDir, loadFiles]);

  const sortedFiles = useMemo(() => {
    return [...fileList].sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [fileList]);

  const breadcrumbs = useMemo(() => {
    if (!currentDir) return [];
    return currentDir.split('/').filter(Boolean);
  }, [currentDir]);

  const handleNavigate = (index: number) => {
    if (index === -1) {
      navigateTo(groupJid, '');
    } else {
      navigateTo(groupJid, breadcrumbs.slice(0, index + 1).join('/'));
    }
  };

  const handleItemClick = useCallback(
    (item: FileEntry) => {
      if (item.type === 'directory') {
        navigateTo(groupJid, item.path);
        return;
      }

      const ext = getFileExt(item.name);

      if (IMAGE_EXTENSIONS.has(ext)) {
        setPreview({ kind: 'image', file: item });
      } else if (PDF_EXTENSIONS.has(ext)) {
        setPreview({ kind: 'pdf', file: item });
      } else if (VIDEO_EXTENSIONS.has(ext)) {
        setPreview({ kind: 'video', file: item });
      } else if (AUDIO_EXTENSIONS.has(ext)) {
        setPreview({ kind: 'audio', file: item });
      } else if (ext === 'md' && isEntryEditable(item)) {
        setPreview({ kind: 'markdown', file: item });
      } else {
        setPreview({ kind: 'text', file: item });
      }
    },
    [groupJid, navigateTo],
  );

  const handleDownload = (item: FileEntry) => {
    const encoded = toBase64Url(item.path);
    const url = `/api/groups/${encodeURIComponent(groupJid)}/files/download/${encoded}`;
    downloadFromUrl(url, item.name).catch((err) => {
      console.error('Download failed:', err);
      showToast(
        '下载失败',
        err instanceof Error ? err.message : '文件下载出错，请重试',
      );
    });
  };

  const handleCopyPath = (item: FileEntry) => {
    const target = item.absolutePath || item.path;
    copyToClipboard(target)
      .then(() => showToast('已复制', target))
      .catch((err) => {
        console.error('Copy failed:', err);
        showToast(
          '复制失败',
          err instanceof Error ? err.message : '无法写入剪贴板',
        );
      });
  };

  const handleDeleteClick = (item: FileEntry) => {
    setDeleteModal({
      open: true,
      path: item.path,
      name: item.name,
      isDir: item.type === 'directory',
    });
  };

  const handleDeleteConfirm = async () => {
    setDeleteLoading(true);
    try {
      const ok = await deleteFile(groupJid, deleteModal.path);
      if (ok) {
        setDeleteModal({ open: false, path: '', name: '', isDir: false });
      }
    } finally {
      setDeleteLoading(false);
    }
  };

  const handleRefresh = () => {
    loadFiles(groupJid, currentDir);
  };

  const handleOpenLocalFolder = async () => {
    setOpenDirLoading(true);
    setOpenDirError(null);
    try {
      await api.post(
        `/api/groups/${encodeURIComponent(groupJid)}/files/open-directory`,
        {
          path: currentDir,
        },
      );
    } catch (err) {
      if (err instanceof Error) {
        setOpenDirError(err.message);
      } else if (typeof err === 'object' && err !== null && 'message' in err) {
        setOpenDirError(String((err as { message: unknown }).message));
      } else {
        setOpenDirError('打开本地文件夹失败');
      }
    } finally {
      setOpenDirLoading(false);
    }
  };

  const handleCreateDir = () => {
    setNewDirName('');
    setCreateDirModal(true);
  };

  const handleCreateDirConfirm = async () => {
    const name = newDirName.trim();
    if (!name) return;
    setCreateDirLoading(true);
    try {
      await createDirectory(groupJid, currentDir, name);
      setCreateDirModal(false);
    } finally {
      setCreateDirLoading(false);
    }
  };

  return (
    <div className="flex h-full w-full flex-col bg-background">
      {/* Header */}
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-surface-border pr-2 pl-4">
        <h3 className="truncate text-title-sm text-foreground">
          当前上下文文件
        </h3>
        <div className="flex shrink-0 items-center gap-0.5">
          {canOpenLocalFolder && (
            <IconButton
              label="打开工作区文件夹"
              icon={
                openDirLoading ? (
                  <Loader2 className="animate-spin" />
                ) : (
                  <FolderOpen />
                )
              }
              onClick={handleOpenLocalFolder}
              disabled={openDirLoading}
              className="text-muted-foreground max-md:hidden"
            />
          )}
          <IconButton
            label="刷新文件列表"
            icon={<RefreshCw className={cn(loading && 'animate-spin')} />}
            onClick={handleRefresh}
            className="text-muted-foreground pointer-coarse:size-9"
          />
          {onClose && (
            <IconButton
              label="关闭文件面板"
              icon={<X />}
              onClick={onClose}
              className="text-muted-foreground pointer-coarse:size-9"
            />
          )}
        </div>
      </div>

      {/* Breadcrumb */}
      <nav
        aria-label="文件路径"
        className="flex h-9 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-surface-border px-2.5"
      >
        <Button
          variant="ghost"
          size="xs"
          onClick={() => handleNavigate(-1)}
          className={cn(
            BREADCRUMB_BUTTON_CLASS,
            breadcrumbs.length > 0
              ? 'text-muted-foreground'
              : 'text-foreground',
          )}
        >
          根目录
        </Button>
        {breadcrumbs.map((crumb, index) => (
          <div key={index} className="flex shrink-0 items-center gap-0.5">
            <ChevronRight className="size-3 shrink-0 text-faint-foreground" />
            <Button
              variant="ghost"
              size="xs"
              onClick={() => handleNavigate(index)}
              className={cn(
                BREADCRUMB_BUTTON_CLASS,
                index === breadcrumbs.length - 1
                  ? 'text-foreground'
                  : 'text-muted-foreground',
              )}
            >
              {crumb}
            </Button>
          </div>
        ))}
      </nav>

      {openDirError && (
        <div className="border-b border-surface-border bg-error/10 px-4 py-2 text-caption text-error">
          {openDirError}
        </div>
      )}

      {/* File List */}
      <div className="relative min-h-0 flex-1">
        <div
          ref={fileListScrollRef}
          className="hc-scroll-pane h-full overflow-y-auto p-1.5"
          data-testid="file-list-scroll"
        >
          {loading && fileList.length === 0 ? (
            <div className="flex h-32 items-center justify-center">
              <p className="text-caption text-muted-foreground">加载中...</p>
            </div>
          ) : sortedFiles.length === 0 ? (
            <div className="flex h-32 items-center justify-center">
              <p className="text-caption text-muted-foreground">暂无文件</p>
            </div>
          ) : (
            <div role="list" className="flex flex-col gap-px">
              {sortedFiles.map((item) => {
                const clickable =
                  item.type === 'directory' || isPreviewableFile(item);
                const summary = (
                  <>
                    <span className="flex size-4 shrink-0 items-center justify-center">
                      {item.type === 'directory' ? (
                        <Folder className="size-4 text-muted-foreground" />
                      ) : (
                        <FileIcon name={item.name} />
                      )}
                    </span>
                    <span
                      className={cn(
                        'truncate text-body',
                        item.isSystem && !isEntryEditable(item)
                          ? 'text-muted-foreground'
                          : 'text-foreground',
                      )}
                    >
                      {item.name}
                    </span>
                    {item.isSystem && (
                      <Badge variant="neutral" className="shrink-0">
                        系统
                      </Badge>
                    )}
                  </>
                );
                return (
                  <div
                    key={item.path}
                    role="listitem"
                    className="group/file flex h-8 items-center gap-1 rounded-md pr-1 transition-colors hover:bg-surface-hover pointer-coarse:h-11"
                  >
                    {clickable ? (
                      <button
                        type="button"
                        onClick={() => handleItemClick(item)}
                        className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md pl-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-inset"
                      >
                        {summary}
                      </button>
                    ) : (
                      <div className="flex h-full min-w-0 flex-1 items-center gap-2 pl-2">
                        {summary}
                      </div>
                    )}

                    {/* Size gives way to the actions on hover / focus. */}
                    {item.type === 'file' && (
                      <span className="shrink-0 px-1 text-micro text-faint-foreground tabular-nums pointer-fine:group-focus-within/file:hidden pointer-fine:group-hover/file:hidden">
                        {formatSize(item.size)}
                      </span>
                    )}

                    {/* Actions stay focusable while collapsed so keyboard
                        users can still Tab into them. */}
                    <div className="flex shrink-0 items-center pointer-fine:w-0 pointer-fine:overflow-hidden pointer-fine:group-focus-within/file:w-auto pointer-fine:group-focus-within/file:overflow-visible pointer-fine:group-hover/file:w-auto pointer-fine:group-hover/file:overflow-visible">
                      {/* Copy absolute path (always available) */}
                      <IconButton
                        label="复制绝对路径"
                        icon={<Copy />}
                        onClick={() => handleCopyPath(item)}
                        className={FILE_ACTION_CLASS}
                      />
                      {/* Edit button for editable text files (系统文件里的
                          CLAUDE.md 例外也可编辑，但仍然没有删除按钮) */}
                      {isEntryEditable(item) &&
                        TEXT_EXTENSIONS.has(getFileExt(item.name)) && (
                          <IconButton
                            label="编辑文件"
                            icon={<Pencil />}
                            onClick={() =>
                              setPreview({ kind: 'edit', file: item })
                            }
                            className={FILE_ACTION_CLASS}
                          />
                        )}
                      {item.type === 'file' && (
                        <IconButton
                          label="下载文件"
                          icon={<Download />}
                          onClick={() => handleDownload(item)}
                          className={FILE_ACTION_CLASS}
                        />
                      )}
                      {!item.isSystem && (
                        <IconButton
                          label="删除文件"
                          icon={<Trash2 />}
                          onClick={() => handleDeleteClick(item)}
                          className={cn(
                            FILE_ACTION_CLASS,
                            'hover:bg-destructive/10 hover:text-destructive',
                          )}
                        />
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <ScrollEdgeAffordance scrollRef={fileListScrollRef} />
      </div>

      {/* Footer */}
      <div className="shrink-0 space-y-2 border-t border-surface-border p-3">
        <Button variant="outline" onClick={handleCreateDir} className="w-full">
          <FolderPlus />
          新建文件夹
        </Button>
        <FileUploadZone groupJid={groupJid} />
      </div>

      {/* Create Directory Dialog */}
      <Dialog
        open={createDirModal}
        onOpenChange={(v) => !v && setCreateDirModal(false)}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>新建文件夹</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Label htmlFor={newDirInputId}>文件夹名称</Label>
            <Input
              id={newDirInputId}
              type="text"
              value={newDirName}
              onChange={(e) => setNewDirName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreateDirConfirm();
              }}
              placeholder="输入文件夹名称"
              autoFocus
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setCreateDirModal(false)}
              disabled={createDirLoading}
            >
              取消
            </Button>
            <Button
              onClick={handleCreateDirConfirm}
              disabled={createDirLoading}
            >
              {createDirLoading && <Loader2 className="animate-spin" />}
              创建
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm */}
      <ConfirmDialog
        open={deleteModal.open}
        onClose={() =>
          setDeleteModal({ open: false, path: '', name: '', isDir: false })
        }
        onConfirm={handleDeleteConfirm}
        title={deleteModal.isDir ? '删除文件夹' : '删除文件'}
        message={
          deleteModal.isDir
            ? `确认删除文件夹「${deleteModal.name}」及其所有内容吗？此操作不可恢复。`
            : `确认删除文件「${deleteModal.name}」吗？此操作不可恢复。`
        }
        confirmText="删除"
        cancelText="取消"
        confirmVariant="danger"
        loading={deleteLoading}
      />

      {/* Preview / Editor Overlays */}
      {preview?.kind === 'image' && (
        <ImagePreview
          groupJid={groupJid}
          file={preview.file}
          onClose={() => setPreview(null)}
        />
      )}
      {preview?.kind === 'edit' && (
        <TextEditor
          groupJid={groupJid}
          file={preview.file}
          onClose={() => setPreview(null)}
        />
      )}
      {preview?.kind === 'markdown' && (
        <MarkdownFileViewer
          groupJid={groupJid}
          file={preview.file}
          onClose={() => setPreview(null)}
        />
      )}
      {preview?.kind === 'pdf' && (
        <PdfPreview
          groupJid={groupJid}
          file={preview.file}
          onClose={() => setPreview(null)}
        />
      )}
      {preview?.kind === 'video' && (
        <VideoPreview
          groupJid={groupJid}
          file={preview.file}
          onClose={() => setPreview(null)}
        />
      )}
      {preview?.kind === 'audio' && (
        <AudioPreview
          groupJid={groupJid}
          file={preview.file}
          onClose={() => setPreview(null)}
        />
      )}
      {preview?.kind === 'text' && (
        <GenericTextPreview
          groupJid={groupJid}
          file={preview.file}
          onClose={() => setPreview(null)}
        />
      )}
    </div>
  );
}
