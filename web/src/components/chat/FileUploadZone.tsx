import { useState, useRef, DragEvent } from 'react';
import { Upload, FolderUp, X } from 'lucide-react';
import { formatUploadRetryStatus, useFileStore } from '../../stores/files';

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
    <div className="space-y-2">
      {/* Drop zone */}
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`relative border-2 border-dashed rounded-lg p-3 transition-all ${
          isDragging ? 'border-primary bg-primary/10' : 'border-border'
        }`}
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
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span className="truncate max-w-[60%]">
                {uploadProgress.currentFile || '完成'}
                {retryStatus ? (
                  <span data-upload-retry-status>（{retryStatus}）</span>
                ) : null}
              </span>
              <span>
                {uploadProgress.completed}/{uploadProgress.total} 个文件
              </span>
            </div>
            <div className="w-full h-2 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all duration-300 ease-out"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <div className="flex items-center justify-center gap-2">
              <p className="text-[11px] text-muted-foreground">
                {progressPercent}%
              </p>
              <button
                type="button"
                data-upload-cancel
                onClick={cancelUpload}
                className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
              >
                <X className="w-3 h-3" />
                取消
              </button>
            </div>
          </div>
        ) : (
          /* Idle state */
          <div className="flex flex-col items-center gap-2 text-center py-1">
            <p className="text-xs text-muted-foreground">
              {isDragging ? '释放以上传' : '拖拽文件到这里，或'}
            </p>
            <div className="flex items-center gap-2">
              <button
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-primary bg-primary/10 hover:bg-primary/15 rounded-md transition-colors cursor-pointer"
              >
                <Upload className="w-3.5 h-3.5" />
                上传文件
              </button>
              <button
                onClick={() => folderInputRef.current?.click()}
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-foreground bg-muted hover:bg-muted/80 rounded-md transition-colors cursor-pointer"
              >
                <FolderUp className="w-3.5 h-3.5" />
                上传文件夹
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
