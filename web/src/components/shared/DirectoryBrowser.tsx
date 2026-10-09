import { useCallback, useId, useState } from 'react';
import {
  ArrowLeft,
  ChevronRight,
  Folder,
  FolderCheck,
  FolderPlus,
  Loader2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { api } from '../../api/client';
import { extractErrorMessage } from '../../utils/error';

interface DirectoryEntry {
  name: string;
  path: string;
  hasChildren: boolean;
  selectable?: boolean;
}

interface BrowseResponse {
  currentPath: string | null;
  parentPath: string | null;
  directories: DirectoryEntry[];
  hasAllowlist: boolean;
  mountingEnabled?: boolean;
  currentSelectable?: boolean;
}

interface DirectoryBrowserProps {
  value: string;
  onChange: (path: string, source?: 'input' | 'browser' | 'created') => void;
  placeholder?: string;
  label?: string;
  description?: string;
  inputId?: string;
  purpose?: 'mount';
  allowCreateFolder?: boolean;
  disabled?: boolean;
}

export function DirectoryBrowser({
  value,
  onChange,
  placeholder,
  label = '工作目录（可选）',
  description,
  inputId,
  purpose,
  allowCreateFolder = true,
  disabled = false,
}: DirectoryBrowserProps) {
  const generatedId = useId();
  const resolvedInputId = inputId ?? `directory-${generatedId}`;
  const descriptionId = description
    ? `${resolvedInputId}-description`
    : undefined;
  const errorId = `${resolvedInputId}-error`;
  const [browsing, setBrowsing] = useState(false);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [currentSelectable, setCurrentSelectable] = useState(true);
  const [parentPath, setParentPath] = useState<string | null>(null);
  const [directories, setDirectories] = useState<DirectoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [createLoading, setCreateLoading] = useState(false);

  const fetchDirectories = useCallback(
    async (targetPath?: string) => {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (targetPath) params.set('path', targetPath);
        if (purpose) params.set('purpose', purpose);
        const query = params.toString();
        const data = await api.get<BrowseResponse>(
          `/api/browse/directories${query ? `?${query}` : ''}`,
        );
        setCurrentPath(data.currentPath);
        setCurrentSelectable(data.currentSelectable !== false);
        setParentPath(data.parentPath);
        if (
          purpose === 'mount' &&
          (data.mountingEnabled === false || data.hasAllowlist === false)
        ) {
          setDirectories([]);
          setError(
            '宿主机目录挂载尚未配置。请先配置挂载目录白名单并重启 HappyClaw。',
          );
          return;
        }
        setDirectories(data.directories);
      } catch (err) {
        setError(extractErrorMessage(err) || '无法读取服务器目录');
      } finally {
        setLoading(false);
      }
    },
    [purpose],
  );

  const handleToggleBrowse = () => {
    if (browsing) {
      setBrowsing(false);
      return;
    }
    setBrowsing(true);
    setCreating(false);
    setNewFolderName('');
    if (value && value.startsWith('/')) {
      void fetchDirectories(value);
    } else {
      void fetchDirectories();
    }
  };

  const handleNavigate = (dirPath: string) => {
    void fetchDirectories(dirPath);
    setCreating(false);
    setNewFolderName('');
  };

  const handleGoUp = () => {
    if (parentPath) {
      void fetchDirectories(parentPath);
    } else {
      void fetchDirectories();
    }
    setCreating(false);
    setNewFolderName('');
  };

  const handleSelect = (dirPath: string) => {
    onChange(dirPath, 'browser');
    setBrowsing(false);
  };

  const canSelectCurrent = purpose !== 'mount' || currentSelectable !== false;

  const handleCreateFolder = async () => {
    const name = newFolderName.trim();
    if (!allowCreateFolder || !name || !currentPath) return;

    setCreateLoading(true);
    setError(null);
    try {
      const created = await api.post<DirectoryEntry>(
        '/api/browse/directories',
        {
          parentPath: currentPath,
          name,
        },
      );
      onChange(created.path, 'created');
      setBrowsing(false);
      setCreating(false);
      setNewFolderName('');
    } catch (err) {
      setError(extractErrorMessage(err) || '无法创建文件夹');
    } finally {
      setCreateLoading(false);
    }
  };

  const breadcrumbs = currentPath
    ? currentPath
        .split('/')
        .filter(Boolean)
        .map((part, index, parts) => ({
          name: part,
          path: `/${parts.slice(0, index + 1).join('/')}`,
        }))
    : [];

  const describedBy = [descriptionId, error ? errorId : null]
    .filter(Boolean)
    .join(' ');

  return (
    <div>
      <Label htmlFor={resolvedInputId} className="mb-1.5">
        {label}
      </Label>
      {description && (
        <p
          id={descriptionId}
          className="mb-2 text-xs leading-5 text-muted-foreground"
        >
          {description}
        </p>
      )}
      <div className="flex items-stretch gap-2">
        <Input
          id={resolvedInputId}
          type="text"
          value={value}
          onChange={(event) => onChange(event.target.value, 'input')}
          placeholder={placeholder || '默认: data/groups/{folder}/'}
          className="h-10 flex-1 text-sm"
          aria-describedby={describedBy || undefined}
          aria-invalid={!!error}
          autoComplete="off"
          disabled={disabled}
        />
        <Button
          type="button"
          variant="outline"
          onClick={handleToggleBrowse}
          className="h-10 flex-shrink-0 whitespace-nowrap"
          aria-expanded={browsing}
          aria-controls={`${resolvedInputId}-browser`}
          disabled={disabled}
        >
          {browsing ? '收起' : purpose === 'mount' ? '浏览服务器' : '浏览'}
        </Button>
      </div>

      {browsing && (
        <div
          id={`${resolvedInputId}-browser`}
          className="mt-2 overflow-hidden rounded-lg border border-border bg-card"
          aria-busy={loading}
        >
          {currentPath && (
            <div className="flex items-center justify-between gap-2 border-b border-border bg-muted px-3 py-2">
              <div className="flex min-w-0 items-center gap-1 overflow-x-auto text-xs text-muted-foreground">
                <button
                  type="button"
                  onClick={() => void fetchDirectories()}
                  className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-md transition-colors hover:bg-accent hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label="返回允许的目录根列表"
                >
                  <Folder className="h-4 w-4" />
                </button>
                {breadcrumbs.map((breadcrumb, index) => {
                  const isCurrent = index === breadcrumbs.length - 1;
                  return (
                    <span
                      key={breadcrumb.path}
                      className="flex flex-shrink-0 items-center gap-1"
                    >
                      <ChevronRight className="h-3 w-3 text-muted-foreground/50" />
                      <button
                        type="button"
                        onClick={() =>
                          isCurrent
                            ? undefined
                            : handleNavigate(breadcrumb.path)
                        }
                        className={`min-h-9 rounded px-1.5 transition-colors hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                          isCurrent
                            ? 'font-medium text-foreground'
                            : 'cursor-pointer'
                        }`}
                        disabled={isCurrent}
                      >
                        {breadcrumb.name}
                      </button>
                    </span>
                  );
                })}
              </div>
              <Button
                type="button"
                size="sm"
                onClick={() => handleSelect(currentPath)}
                className="h-9 flex-shrink-0"
                disabled={!canSelectCurrent}
              >
                <FolderCheck className="h-4 w-4" />
                {canSelectCurrent ? '选择此目录' : '不可挂载'}
              </Button>
            </div>
          )}
          {currentPath && !canSelectCurrent && (
            <p className="border-b border-border bg-warning/10 px-3 py-2 text-xs leading-5 text-warning">
              此目录仅可用于导航，不能直接挂载。请进入允许挂载的子目录后再选择。
            </p>
          )}

          <div className="max-h-64 overflow-y-auto" aria-live="polite">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                <Loader2 className="h-5 w-5 animate-spin" />
                正在读取服务器目录…
              </div>
            ) : error ? (
              <div
                id={errorId}
                className="px-3 py-4 text-center text-sm text-error"
                role="alert"
              >
                {error}
              </div>
            ) : (
              <>
                {(parentPath !== null || currentPath !== null) && (
                  <button
                    type="button"
                    onClick={handleGoUp}
                    className="flex min-h-11 w-full items-center gap-2 border-b border-border px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                  >
                    <ArrowLeft className="h-4 w-4" />
                    返回上级
                  </button>
                )}

                {directories.length === 0 && (
                  <div className="px-3 py-4 text-center text-sm text-muted-foreground">
                    此目录下没有子目录
                  </div>
                )}

                {directories.map((directory) => {
                  const canSelectDirectory =
                    purpose !== 'mount' || directory.selectable !== false;
                  return (
                    <div
                      key={directory.path}
                      className="flex min-h-11 items-center justify-between gap-2 px-3 py-1.5 transition-colors hover:bg-muted/50"
                    >
                      <button
                        type="button"
                        onClick={() => handleNavigate(directory.path)}
                        className="flex min-h-9 min-w-0 flex-1 items-center gap-2 rounded text-left text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <Folder className="h-4 w-4 flex-shrink-0 text-primary" />
                        <span className="truncate">{directory.name}</span>
                        {directory.hasChildren && (
                          <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/50" />
                        )}
                      </button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => handleSelect(directory.path)}
                        className="h-9 flex-shrink-0 text-primary"
                        disabled={!canSelectDirectory}
                        aria-label={
                          canSelectDirectory
                            ? `选择 ${directory.name}`
                            : `${directory.name} 仅可浏览，不可挂载`
                        }
                      >
                        {canSelectDirectory ? '选择' : '不可挂载'}
                      </Button>
                    </div>
                  );
                })}
              </>
            )}
          </div>

          {allowCreateFolder && currentPath && (
            <div className="border-t border-border px-3 py-2">
              {creating ? (
                <div className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
                  <Input
                    type="text"
                    value={newFolderName}
                    onChange={(event) => setNewFolderName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void handleCreateFolder();
                      if (event.key === 'Escape') {
                        setCreating(false);
                        setNewFolderName('');
                      }
                    }}
                    placeholder="文件夹名称"
                    className="h-10 min-w-40 flex-1 text-sm"
                    aria-label="新文件夹名称"
                    autoFocus
                  />
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => void handleCreateFolder()}
                    disabled={!newFolderName.trim() || createLoading}
                    className="h-10"
                  >
                    {createLoading ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      '创建'
                    )}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setCreating(false);
                      setNewFolderName('');
                    }}
                    className="h-10"
                  >
                    取消
                  </Button>
                </div>
              ) : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setCreating(true)}
                  className="h-10 text-primary"
                >
                  <FolderPlus className="h-4 w-4" />
                  新建文件夹
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
