import { useState, useRef, DragEvent } from 'react';
import { Upload, FolderUp, X } from 'lucide-react';
import { formatUploadRetryStatus, useFileStore } from '../../stores/files';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface FileUploadZoneProps {
  groupJid: string;
}

export function FileUploadZone({ groupJid }: FileUploadZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const { uploadFiles, cancelUpload, uploading, uploadProgress } =
    useFileStore();

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const fileList = e.dataTransfer.files;
    if (fileList.length > 0) {
      await uploadFiles(groupJid, Array.from(fileList));
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (fileList && fileList.length > 0) {
      await uploadFiles(groupJid, Array.from(fileList));
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleFolderSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (fileList && fileList.length > 0) {
      await uploadFiles(groupJid, Array.from(fileList));
      if (folderInputRef.current) folderInputRef.current.value = '';
    }
  };

  const progressPercent =
    uploadProgress && uploadProgress.totalBytes > 0
      ? Math.round(
          (uploadProgress.uploadedBytes / uploadProgress.totalBytes) * 100,
        )
      : 0;
  const retryStatus = uploadProgress
    ? formatUploadRetryStatus(uploadProgress)
    : null;

  return (
    <div
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={cn(
        'relative rounded-lg border border-dashed p-3 transition-colors',
        isDragging ? 'border-primary bg-primary/5' : 'border-surface-border',
      )}
    >
      {/* Hidden inputs */}
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

      {uploading && uploadProgress ? (
        /* Upload progress */
        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2 text-caption text-muted-foreground">
            <span className="max-w-[60%] truncate">
              {uploadProgress.currentFile || '完成'}
              {retryStatus ? (
                <span data-upload-retry-status>（{retryStatus}）</span>
              ) : null}
            </span>
            <span className="shrink-0 tabular-nums">
              {uploadProgress.completed}/{uploadProgress.total} 个文件
            </span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-selected">
            <div
              className="h-full rounded-full bg-primary transition-all duration-300 ease-out"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-micro text-muted-foreground tabular-nums">
              {progressPercent}%
            </span>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              data-upload-cancel
              onClick={cancelUpload}
              className="text-muted-foreground"
            >
              <X />
              取消
            </Button>
          </div>
        </div>
      ) : (
        /* Idle state */
        <div className="flex flex-col items-center gap-2 text-center">
          <p className="text-caption text-muted-foreground">
            {isDragging ? '释放以上传' : '拖拽文件到这里，或'}
          </p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload />
              上传文件
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => folderInputRef.current?.click()}
            >
              <FolderUp />
              上传文件夹
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
