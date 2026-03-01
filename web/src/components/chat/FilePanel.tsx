import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
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
} from 'lucide-react';
import { useFileStore, FileEntry, toBase64Url } from '../../stores/files';
import { useChatStore } from '../../stores/chat';
import { useAuthStore } from '../../stores/auth';
import { api } from '../../api/client';
import { withBasePath } from '../../utils/url';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '../shared/Badge';
import { FileUploadZone } from './FileUploadZone';

interface FilePanelProps {
  groupJid: string;
  onClose?: () => void;
}

// ─── File type constants ─────────────────────────────────────────

const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico',
]);

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'json', 'js', 'ts', 'jsx', 'tsx', 'css', 'html', 'xml',
  'py', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'sh', 'yaml', 'yml',
  'toml', 'ini', 'conf', 'log', 'csv', 'svg',
]);

const CODE_EXTENSIONS = new Set([
  'js', 'ts', 'jsx', 'tsx', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'h',
  'sh', 'css', 'html', 'xml', 'yaml', 'yml', 'toml',
]);

const ARCHIVE_EXTENSIONS = new Set([
  'zip', 'tar', 'gz', '7z', 'rar', 'bz2', 'xz',
]);

// ─── File icon component ────────────────────────────────────────

function FileIcon({ name }: { name: string }) {
  const ext = name.split('.').pop()?.toLowerCase() || '';

  if (IMAGE_EXTENSIONS.has(ext))
    return <Image className="w-4 h-4 text-pink-500" />;
  if (ARCHIVE_EXTENSIONS.has(ext))
    return <Package className="w-4 h-4 text-amber-500" />;
  if (ext === 'pdf')
    return <FileText className="w-4 h-4 text-red-500" />;
  if (ext === 'json')
    return <FileCode className="w-4 h-4 text-yellow-600" />;
  if (ext === 'md')
    return <FileText className="w-4 h-4 text-blue-500" />;
  if (CODE_EXTENSIONS.has(ext))
    return <FileCode className="w-4 h-4 text-emerald-500" />;
  if (TEXT_EXTENSIONS.has(ext))
    return <FileText className="w-4 h-4 text-slate-500" />;
  return <File className="w-4 h-4 text-slate-400" />;
}

function getFileExt(name: string): string {
  return name.split('.').pop()?.toLowerCase() || '';
}

function isClickableFile(name: string, isSystem: boolean): boolean {
  const ext = getFileExt(name);
  return IMAGE_EXTENSIONS.has(ext) || (TEXT_EXTENSIONS.has(ext) && !isSystem);
}

// ─── Helpers ─────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1);
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
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
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleEsc);
    return () => window.removeEventListener('keydown', handleEsc);
  }, [onClose]);

  const previewUrl = withBasePath(`/api/groups/${encodeURIComponent(groupJid)}/files/preview/${toBase64Url(file.path)}`);

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <button
        className="absolute top-4 right-4 text-white/70 hover:text-white transition-colors p-2 cursor-pointer z-10"
        onClick={onClose}
        aria-label="关闭预览"
      >
        <X className="w-8 h-8" />
      </button>
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 text-white/70 text-sm bg-black/50 px-3 py-1 rounded-full">
        {file.name}
      </div>
      <img
        src={previewUrl}
        alt={file.name}
        className="max-w-full max-h-full object-contain rounded-lg"
        onClick={(e) => e.stopPropagation()}
      />
    </div>,
    document.body,
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

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    const handleSave = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave_();
      }
    };
    window.addEventListener('keydown', handleEsc);
    window.addEventListener('keydown', handleSave);
    return () => {
      window.removeEventListener('keydown', handleEsc);
      window.removeEventListener('keydown', handleSave);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose, content, dirty]);

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
    return () => { cancelled = true; };
  }, [groupJid, file.path, getFileContent]);

  const handleSave_ = async () => {
    if (!dirty || saving) return;
    setSaving(true);
    const ok = await saveFileContent(groupJid, file.path, content);
    setSaving(false);
    if (ok) setDirty(false);
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-3 lg:p-6"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-4xl h-[85vh] supports-[height:100dvh]:h-[85dvh] flex flex-col animate-in zoom-in-95 duration-200"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <FileIcon name={file.name} />
            <span className="font-medium text-slate-900 text-sm truncate">{file.name}</span>
            {dirty && (
              <span className="text-xs text-amber-500 flex-shrink-0">未保存</span>
            )}
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <Button
              size="sm"
              onClick={handleSave_}
              disabled={!dirty || saving}
            >
              {saving && <Loader2 className="size-4 animate-spin" />}
              <Save className="w-3.5 h-3.5" />
              保存
            </Button>
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-slate-600 transition-colors p-2 rounded-md hover:bg-slate-100 cursor-pointer"
              aria-label="关闭编辑器"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Editor */}
        <div className="flex-1 p-3 overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center h-full">
              <p className="text-sm text-slate-500">加载中...</p>
            </div>
          ) : (
            <Textarea
              value={content}
              onChange={(e) => {
                setContent(e.target.value);
                setDirty(true);
              }}
              className="w-full h-full font-mono text-sm text-slate-800 resize-none bg-slate-50"
              spellCheck={false}
            />
          )}
        </div>

        {/* Footer hint */}
        <div className="px-4 py-2 border-t border-slate-100 text-xs text-slate-400 flex-shrink-0">
          Ctrl/Cmd+S 保存 · Esc 关闭
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ─── Main FilePanel ─────────────────────────────────────────────

export function FilePanel({ groupJid, onClose }: FilePanelProps) {
  const { files, currentPath, loading, loadFiles, deleteFile, createDirectory, navigateTo } =
    useFileStore();

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

  // Preview / Editor state
  const [previewFile, setPreviewFile] = useState<FileEntry | null>(null);
  const [editFile, setEditFile] = useState<FileEntry | null>(null);

  const isStreaming = useChatStore((s) => !!s.streaming[groupJid]);
  const canOpenLocalFolder = useAuthStore((s) => s.user?.role === 'admin');
  const prevStreamingRef = useRef(false);

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

  const handleItemClick = useCallback((item: FileEntry) => {
    if (item.type === 'directory') {
      navigateTo(groupJid, item.path);
      return;
    }

    const ext = getFileExt(item.name);

    // 图片 → 预览
    if (IMAGE_EXTENSIONS.has(ext)) {
      setPreviewFile(item);
      return;
    }

    // 文本文件（非系统） → 编辑
    if (TEXT_EXTENSIONS.has(ext) && !item.isSystem) {
      setEditFile(item);
      return;
    }
  }, [groupJid, navigateTo]);

  const handleDownload = (item: FileEntry) => {
    const encoded = toBase64Url(item.path);
    const url = withBasePath(`/api/groups/${encodeURIComponent(groupJid)}/files/download/${encoded}`);
    const a = document.createElement('a');
    a.href = url;
    a.download = item.name;
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  const handleDeleteClick = (item: FileEntry) => {
    setDeleteModal({ open: true, path: item.path, name: item.name, isDir: item.type === 'directory' });
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
      await api.post(`/api/groups/${encodeURIComponent(groupJid)}/files/open-directory`, {
        path: currentDir,
      });
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
    <div className="w-full h-full border-l border-slate-200 bg-white flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200">
        <h3 className="font-semibold text-slate-900 text-sm">工作区文件管理</h3>
        <div className="flex items-center gap-1">
          {canOpenLocalFolder && (
            <button
              onClick={handleOpenLocalFolder}
              disabled={openDirLoading}
              className="hidden md:inline-flex text-slate-400 hover:text-slate-600 transition-colors p-2 rounded-md hover:bg-slate-100 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              title="打开工作区文件夹"
              aria-label="打开工作区文件夹"
            >
              {openDirLoading ? <Loader2 className="size-3.5 animate-spin" /> : <FolderOpen className="size-3.5" />}
            </button>
          )}
          <button
            onClick={handleRefresh}
            className="text-slate-400 hover:text-slate-600 transition-colors p-2 rounded-md hover:bg-slate-100 cursor-pointer"
            title="刷新"
            aria-label="刷新文件列表"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          {onClose && (
            <button
              onClick={onClose}
              className="text-slate-400 hover:text-slate-600 transition-colors p-2 rounded-md hover:bg-slate-100 cursor-pointer"
              aria-label="关闭文件面板"
            >
              <X className="w-5 h-5" />
            </button>
          )}
        </div>
      </div>

      {/* Breadcrumb */}
      <div className="px-4 py-2 border-b border-slate-200 bg-slate-50">
        <div className="flex items-center gap-1 text-sm overflow-x-auto">
          <button
            onClick={() => handleNavigate(-1)}
            className="text-primary hover:underline whitespace-nowrap cursor-pointer"
          >
            根目录
          </button>
          {breadcrumbs.map((crumb, index) => (
            <div key={index} className="flex items-center gap-1">
              <ChevronRight className="w-4 h-4 text-slate-400 flex-shrink-0" />
              <button
                onClick={() => handleNavigate(index)}
                className="text-primary hover:underline whitespace-nowrap cursor-pointer"
              >
                {crumb}
              </button>
            </div>
          ))}
        </div>
      </div>

      {openDirError && (
        <div className="px-4 py-2 border-b border-red-100 bg-red-50 text-xs text-red-600">
          {openDirError}
        </div>
      )}

      {/* File List */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {loading && fileList.length === 0 ? (
          <div className="flex items-center justify-center h-32">
            <p className="text-sm text-slate-500">加载中...</p>
          </div>
        ) : sortedFiles.length === 0 ? (
          <div className="flex items-center justify-center h-32">
            <p className="text-sm text-slate-500">暂无文件</p>
          </div>
        ) : (
          <div className="space-y-0.5">
            {sortedFiles.map((item) => {
              const clickable = item.type === 'directory' || isClickableFile(item.name, !!item.isSystem);
              return (
                <div
                  key={item.path}
                  className={`flex items-center gap-2 px-2 py-1.5 rounded-lg transition-colors ${
                    clickable
                      ? 'hover:bg-slate-100 cursor-pointer'
                      : item.isSystem
                        ? 'bg-slate-50/60'
                        : 'hover:bg-slate-50'
                  }`}
                  onClick={() => handleItemClick(item)}
                >
                  {/* Icon */}
                  <div className="flex-shrink-0 w-5 flex items-center justify-center">
                    {item.type === 'directory' ? (
                      <Folder className="w-4.5 h-4.5 text-primary" />
                    ) : (
                      <FileIcon name={item.name} />
                    )}
                  </div>

                  {/* Name + meta */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`text-sm truncate ${
                          item.isSystem ? 'text-slate-400' : 'text-slate-700'
                        }`}
                      >
                        {item.name}
                      </span>
                      {item.isSystem && (
                        <Badge variant="neutral">系统</Badge>
                      )}
                    </div>
                    {item.type === 'file' && (
                      <p className="text-[11px] text-slate-400 leading-tight">{formatSize(item.size)}</p>
                    )}
                  </div>

                  {/* Actions */}
                  {!item.isSystem && (
                    <div className="flex-shrink-0 flex items-center gap-0.5">
                      {/* Edit button for text files */}
                      {item.type === 'file' && TEXT_EXTENSIONS.has(getFileExt(item.name)) && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditFile(item);
                          }}
                          className="p-2.5 rounded hover:bg-brand-100 text-slate-400 hover:text-primary transition-colors cursor-pointer"
                          title="编辑"
                          aria-label="编辑文件"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                      )}
                      {item.type === 'file' && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDownload(item);
                          }}
                          className="p-2.5 rounded hover:bg-slate-200 text-slate-400 hover:text-slate-600 transition-colors cursor-pointer"
                          title="下载"
                          aria-label="下载文件"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </button>
                      )}
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteClick(item);
                        }}
                        className="p-2.5 rounded hover:bg-red-100 text-slate-400 hover:text-red-600 transition-colors cursor-pointer"
                        title="删除"
                        aria-label="删除文件"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                  {/* System files: download only */}
                  {item.isSystem && item.type === 'file' && (
                    <div className="flex-shrink-0">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDownload(item);
                        }}
                        className="p-2.5 rounded hover:bg-slate-200 text-slate-400 hover:text-slate-600 transition-colors cursor-pointer"
                        title="下载"
                        aria-label="下载文件"
                      >
                        <Download className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="p-3 border-t border-slate-200 space-y-2">
        <Button variant="outline" size="sm" onClick={handleCreateDir} className="w-full">
          <FolderPlus className="w-4 h-4" />
          新建文件夹
        </Button>
        <FileUploadZone groupJid={groupJid} />
      </div>

      {/* Create Directory Dialog */}
      <Dialog open={createDirModal} onOpenChange={(v) => !v && setCreateDirModal(false)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>新建文件夹</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">文件夹名称</label>
              <Input
                type="text"
                value={newDirName}
                onChange={(e) => setNewDirName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleCreateDirConfirm(); }}
                placeholder="输入文件夹名称"
                autoFocus
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setCreateDirModal(false)} disabled={createDirLoading}>取消</Button>
              <Button onClick={handleCreateDirConfirm} disabled={createDirLoading}>
                {createDirLoading && <Loader2 className="size-4 animate-spin" />}
                创建
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirm */}
      <ConfirmDialog
        open={deleteModal.open}
        onClose={() => setDeleteModal({ open: false, path: '', name: '', isDir: false })}
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

      {/* Image Preview Overlay */}
      {previewFile && (
        <ImagePreview
          groupJid={groupJid}
          file={previewFile}
          onClose={() => setPreviewFile(null)}
        />
      )}

      {/* Text Editor Overlay */}
      {editFile && (
        <TextEditor
          groupJid={groupJid}
          file={editFile}
          onClose={() => setEditFile(null)}
        />
      )}
    </div>
  );
}
