import { useState, useRef, useEffect } from 'react';
import { useKeyboardHeight } from '@/hooks/useKeyboardHeight';
import {
  ArrowUp,
  Brush,
  FileUp,
  FolderUp,
  X,
  Paperclip,
  Image as ImageIcon,
  TerminalSquare,
} from 'lucide-react';
import { useFileStore } from '../../stores/files';

interface PendingFile {
  /** Display name: relative path for folder uploads, file name otherwise */
  label: string;
}

interface PendingImage {
  name: string;
  data: string; // base64 data
  mimeType: string;
  preview: string; // object URL for preview
}

/** 单张图片大小上限 5MB */
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024;

interface MessageInputProps {
  onSend: (content: string, attachments?: Array<{ data: string; mimeType: string }>) => void;
  groupJid?: string;
  disabled?: boolean;
  onResetSession?: () => void;
  onToggleTerminal?: () => void;
}

export function MessageInput({
  onSend,
  groupJid,
  disabled = false,
  onResetSession,
  onToggleTerminal,
}: MessageInputProps) {
  const [content, setContent] = useState('');
  const [showActions, setShowActions] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([]);
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);

  const { uploadFiles, uploading, uploadProgress } = useFileStore();

  // iOS keyboard adaptation
  useKeyboardHeight();

  // Auto-resize textarea (1-6 lines)
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    textarea.style.height = 'auto';
    const scrollHeight = textarea.scrollHeight;
    const lineHeight = 24;
    const maxHeight = lineHeight * 6;
    textarea.style.height = `${Math.min(scrollHeight, maxHeight)}px`;
  }, [content]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleSend = () => {
    const trimmed = content.trim();
    const hasPending = pendingFiles.length > 0;
    const hasImages = pendingImages.length > 0;

    if (!trimmed && !hasPending && !hasImages) return;
    if (disabled) return;

    let message = trimmed;

    if (hasPending) {
      const list = pendingFiles.map((f) => `- ${f.label}`).join('\n');
      const prefix = `[我上传了以下文件到工作区，请查看并使用]\n${list}`;
      message = message ? `${prefix}\n\n${message}` : prefix;
      setPendingFiles([]);
    }

    const attachments = hasImages
      ? pendingImages.map((img) => ({ data: img.data, mimeType: img.mimeType }))
      : undefined;

    onSend(message, attachments);
    setContent('');

    // Clean up image previews
    if (hasImages) {
      pendingImages.forEach((img) => URL.revokeObjectURL(img.preview));
      setPendingImages([]);
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!groupJid) return;
    const fileList = e.target.files;
    if (fileList && fileList.length > 0) {
      const files = Array.from(fileList);
      setShowActions(false);

      // Separate image files from regular files
      const imageFiles: File[] = [];
      const regularFiles: File[] = [];
      files.forEach((file) => {
        if (file.type.startsWith('image/')) {
          imageFiles.push(file);
        } else {
          regularFiles.push(file);
        }
      });

      // Process image files
      if (imageFiles.length > 0) {
        const newImages: PendingImage[] = [];
        for (const file of imageFiles) {
          try {
            const base64 = await readFileAsBase64(file);
            newImages.push({
              name: file.name,
              data: base64,
              mimeType: file.type,
              preview: URL.createObjectURL(file),
            });
          } catch {
            // Skip failed images
          }
        }
        setPendingImages((prev) => [...prev, ...newImages]);
      }

      // Upload regular files to workspace
      if (regularFiles.length > 0) {
        const ok = await uploadFiles(groupJid, regularFiles);
        if (ok) {
          const newPending = regularFiles.map((f) => ({
            label: f.webkitRelativePath || f.name,
          }));
          setPendingFiles((prev) => [...prev, ...newPending]);
        }
      }

      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleImageSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (fileList && fileList.length > 0) {
      const files = Array.from(fileList);
      setShowActions(false);

      const newImages: PendingImage[] = [];
      for (const file of files) {
        if (file.type.startsWith('image/')) {
          try {
            const base64 = await readFileAsBase64(file);
            newImages.push({
              name: file.name,
              data: base64,
              mimeType: file.type,
              preview: URL.createObjectURL(file),
            });
          } catch {
            // Skip failed images
          }
        }
      }
      setPendingImages((prev) => [...prev, ...newImages]);

      if (imageInputRef.current) imageInputRef.current.value = '';
    }
  };

  const readFileAsBase64 = (file: File): Promise<string> => {
    if (file.size > MAX_IMAGE_SIZE_BYTES) {
      return Promise.reject(new Error(`图片 ${file.name} 超过 5MB 限制 (${(file.size / 1024 / 1024).toFixed(1)}MB)`));
    }
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        // Remove data URL prefix (e.g., "data:image/png;base64,")
        const base64 = result.split(',')[1];
        resolve(base64);
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  const handlePaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const imageItems: DataTransferItem[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type.startsWith('image/')) {
        imageItems.push(items[i]);
      }
    }

    if (imageItems.length > 0) {
      e.preventDefault();
      const newImages: PendingImage[] = [];

      for (const item of imageItems) {
        const file = item.getAsFile();
        if (file) {
          try {
            const base64 = await readFileAsBase64(file);
            newImages.push({
              name: file.name || `pasted-${Date.now()}.png`,
              data: base64,
              mimeType: file.type,
              preview: URL.createObjectURL(file),
            });
          } catch {
            // Skip failed images
          }
        }
      }

      setPendingImages((prev) => [...prev, ...newImages]);
    }
  };

  const handleFolderSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!groupJid) return;
    const fileList = e.target.files;
    if (fileList && fileList.length > 0) {
      const files = Array.from(fileList);
      setShowActions(false);
      const ok = await uploadFiles(groupJid, files);
      if (ok) {
        const newPending = files.map((f) => ({
          label: f.webkitRelativePath || f.name,
        }));
        setPendingFiles((prev) => [...prev, ...newPending]);
      }
      if (folderInputRef.current) folderInputRef.current.value = '';
    }
  };

  const removePendingFile = (index: number) => {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const removePendingImage = (index: number) => {
    setPendingImages((prev) => {
      const img = prev[index];
      if (img) URL.revokeObjectURL(img.preview);
      return prev.filter((_, i) => i !== index);
    });
  };

  const clearPendingFiles = () => {
    setPendingFiles([]);
  };

  const clearPendingImages = () => {
    pendingImages.forEach((img) => URL.revokeObjectURL(img.preview));
    setPendingImages([]);
  };

  const hasContent = content.trim().length > 0;
  const canSend = hasContent || pendingFiles.length > 0 || pendingImages.length > 0;

  const progressPercent =
    uploadProgress && uploadProgress.totalBytes > 0
      ? Math.round((uploadProgress.uploadedBytes / uploadProgress.totalBytes) * 100)
      : 0;

  return (
    <div
      className="px-4 pt-2 pb-6 bg-background ios-pwa-bottom-safe max-lg:bg-white/60 max-lg:backdrop-blur-xl max-lg:saturate-[1.8] max-lg:border-t max-lg:border-white/20"
      style={{ paddingBottom: `max(1.5rem, var(--keyboard-height, 0px))` }}
    >
      <div className="max-w-3xl mx-auto">
        {/* Upload progress bar */}
        {uploading && uploadProgress && (
          <div className="mb-2 bg-white rounded-xl border border-slate-200 shadow-sm px-4 py-2.5">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs text-slate-600 truncate max-w-[65%]">
                {uploadProgress.currentFile || '完成'}
              </span>
              <span className="text-xs text-slate-400">
                {uploadProgress.completed}/{uploadProgress.total} · {progressPercent}%
              </span>
            </div>
            <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all duration-300 ease-out"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
          </div>
        )}

        {/* Main input card */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm">
          {/* Pending images preview */}
          {pendingImages.length > 0 && (
            <div className="px-3 pt-2.5 pb-1 border-b border-slate-100">
              <div className="flex items-center gap-1 mb-1.5">
                <ImageIcon className="w-3 h-3 text-slate-400" />
                <span className="text-[11px] text-slate-400">
                  已添加 {pendingImages.length} 张图片
                </span>
                <button
                  onClick={clearPendingImages}
                  className="ml-auto text-[11px] text-slate-400 hover:text-slate-600 cursor-pointer"
                >
                  清空
                </button>
              </div>
              <div className="flex flex-wrap gap-2 pb-1.5">
                {pendingImages.map((img, i) => (
                  <div key={i} className="relative group">
                    <img
                      src={img.preview}
                      alt={img.name}
                      className="w-16 h-16 object-cover rounded-lg border border-slate-200"
                    />
                    <button
                      onClick={() => removePendingImage(i)}
                      className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-slate-700 text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer hover:bg-slate-900"
                      aria-label="移除图片"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Pending files chips */}
          {pendingFiles.length > 0 && (
            <div className="px-3 pt-2.5 pb-1 border-b border-slate-100">
              <div className="flex items-center gap-1 mb-1">
                <Paperclip className="w-3 h-3 text-slate-400" />
                <span className="text-[11px] text-slate-400">
                  已上传 {pendingFiles.length} 个文件，发送时将告知 AI
                </span>
                <button
                  onClick={clearPendingFiles}
                  className="ml-auto text-[11px] text-slate-400 hover:text-slate-600 cursor-pointer"
                >
                  清空
                </button>
              </div>
              <div className="flex flex-wrap gap-1 pb-1">
                {pendingFiles.map((file, i) => (
                  <span
                    key={i}
                    className="inline-flex items-center gap-1 max-w-[200px] px-2 py-0.5 bg-brand-50 text-primary text-[11px] rounded-md"
                  >
                    <span className="truncate">{file.label}</span>
                    <button
                      onClick={() => removePendingFile(i)}
                      className="flex-shrink-0 hover:text-primary cursor-pointer p-1 min-w-[28px] min-h-[28px] flex items-center justify-center"
                      aria-label="移除文件"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Action row — shown when attach is toggled */}
          {showActions && groupJid && (
            <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5 border-b border-slate-100">
              <button
                onClick={() => imageInputRef.current?.click()}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-purple-700 bg-purple-50 hover:bg-purple-100 rounded-lg transition-colors cursor-pointer"
              >
                <ImageIcon className="w-3.5 h-3.5" />
                添加图片
              </button>
              <button
                onClick={() => fileInputRef.current?.click()}
                disabled={uploading}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-primary bg-brand-50 hover:bg-brand-100 rounded-lg transition-colors cursor-pointer disabled:opacity-40"
              >
                <FileUp className="w-3.5 h-3.5" />
                上传文件
              </button>
              <button
                onClick={() => folderInputRef.current?.click()}
                disabled={uploading}
                className="hidden lg:flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 rounded-lg transition-colors cursor-pointer disabled:opacity-40"
              >
                <FolderUp className="w-3.5 h-3.5" />
                上传文件夹
              </button>
            </div>
          )}

          {/* Textarea */}
          <div className="px-4 pt-3 pb-1">
            <textarea
              ref={textareaRef}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder="输入消息..."
              disabled={disabled}
              className="w-full text-[15px] leading-6 resize-none focus:outline-none placeholder:text-slate-400 disabled:opacity-50 disabled:cursor-not-allowed bg-transparent"
              rows={1}
              style={{ minHeight: '28px', maxHeight: '144px' }}
            />
          </div>

          {/* Bottom action bar */}
          <div className="flex items-center px-2 pb-2.5">
            {/* Left: action icons */}
            <div className="flex items-center gap-0.5">
              {groupJid && (
                <button
                  type="button"
                  onClick={() => setShowActions(!showActions)}
                  disabled={uploading}
                  className={`w-9 h-9 rounded-lg flex items-center justify-center transition-all cursor-pointer ${
                    showActions
                      ? 'bg-brand-50 text-primary'
                      : 'hover:bg-slate-100 text-slate-400 hover:text-slate-600'
                  } ${uploading ? 'opacity-40 pointer-events-none' : ''}`}
                  title="添加文件"
                  aria-label="添加文件"
                >
                  <Paperclip className="w-4 h-4" />
                </button>
              )}
              {onResetSession && (
                <button
                  type="button"
                  onClick={onResetSession}
                  className="w-9 h-9 rounded-lg flex items-center justify-center hover:bg-amber-50 text-slate-400 hover:text-amber-600 transition-all cursor-pointer"
                  title="清除上下文"
                >
                  <Brush className="w-4 h-4" />
                </button>
              )}
              {onToggleTerminal && (
                <button
                  type="button"
                  onClick={onToggleTerminal}
                  className="w-9 h-9 rounded-lg flex items-center justify-center hover:bg-brand-50 text-slate-400 hover:text-primary transition-all cursor-pointer"
                  title="终端"
                  aria-label="终端"
                >
                  <TerminalSquare className="w-4 h-4" />
                </button>
              )}
            </div>

            {/* Spacer */}
            <div className="flex-1" />

            {/* Right: send button */}
            <button
              onClick={handleSend}
              disabled={!canSend || disabled}
              className={`w-9 h-9 rounded-full flex items-center justify-center transition-all cursor-pointer active:scale-90 ${
                canSend && !disabled
                  ? 'bg-primary text-white hover:bg-primary/90 max-lg:shadow-[0_2px_8px_rgba(13,148,136,0.3)]'
                  : 'bg-slate-100 text-slate-400'
              }`}
            >
              <ArrowUp className="w-4.5 h-4.5" />
            </button>
          </div>
        </div>
      </div>

      {/* Hidden file inputs */}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        multiple
        onChange={handleImageSelect}
        className="hidden"
      />
      <input
        ref={fileInputRef}
        type="file"
        multiple
        onChange={handleFileSelect}
        className="hidden"
        disabled={uploading}
      />
      <input
        ref={folderInputRef}
        type="file"
        // @ts-expect-error webkitdirectory is non-standard but widely supported
        webkitdirectory=""
        onChange={handleFolderSelect}
        className="hidden"
        disabled={uploading}
      />
    </div>
  );
}
