import { useRef, useState } from 'react';
import {
  Loader2,
  Search,
  ExternalLink,
  Download,
  ChevronDown,
  ChevronUp,
  GitBranch,
  FileArchive,
  Package,
  Upload,
} from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ListGroup } from '@/components/common/ListRow';
import { cn } from '@/lib/utils';
import { useSkillsStore, type SearchResult } from '@/stores/skills';
import { MarkdownRenderer } from '../chat/MarkdownRenderer';

interface InstallSkillDialogProps {
  open: boolean;
  onClose: () => void;
  onInstall: (pkg: string) => Promise<void>;
  onImportGit: (options: {
    url: string;
    ref?: string;
    subdirectory?: string;
    replace?: boolean;
  }) => Promise<string[]>;
  onImportArchive: (file: File, replace?: boolean) => Promise<string[]>;
  installing: boolean;
}

type Tab = 'search' | 'manual' | 'git' | 'zip';

function formatInstalls(n?: number): string {
  if (n === undefined || n === null) return '';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function SearchResultItem({
  result,
  isInstalling,
  installingPkg,
  onInstall,
}: {
  result: SearchResult;
  isInstalling: boolean;
  installingPkg: string | null;
  onInstall: (result: SearchResult) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const { searchDetails, searchDetailLoading, fetchSearchDetail } =
    useSkillsStore();

  const key = result.package;
  const detail = searchDetails[key];
  const loading = searchDetailLoading[key];

  const handleToggle = () => {
    if (!expanded && !(key in searchDetails)) {
      fetchSearchDetail(result);
    }
    setExpanded(!expanded);
  };

  const installCount = formatInstalls(result.installs);

  return (
    <div role="listitem" className="transition-colors hover:bg-surface-hover">
      <div className="flex items-center justify-between gap-3 px-3 py-2.5">
        <button
          type="button"
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          onClick={handleToggle}
        >
          {expanded ? (
            <ChevronUp className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <div className="min-w-0 flex-1">
            <span className="block truncate text-body font-medium text-foreground">
              {result.package}
            </span>
            {installCount && (
              <span className="text-caption text-muted-foreground tabular-nums">
                {installCount} 次安装
              </span>
            )}
          </div>
        </button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => onInstall(result)}
          disabled={isInstalling}
          className="shrink-0"
        >
          {installingPkg === result.package ? (
            <Loader2 className="animate-spin" />
          ) : (
            <Download />
          )}
          安装
        </Button>
      </div>

      {expanded && (
        <div className="px-3 pb-3 pl-8">
          {loading && (
            <div className="flex items-center gap-2 py-2 text-caption text-muted-foreground">
              <Loader2 className="size-3 animate-spin" />
              加载详情...
            </div>
          )}

          {!loading && detail && (
            <div className="space-y-2">
              {detail.description && (
                <p className="text-caption leading-5 text-muted-foreground">
                  {detail.description}
                </p>
              )}

              {detail.readme && (
                <div className="mt-2 max-h-64 overflow-y-auto rounded-lg bg-surface-hover p-3 ring-1 ring-surface-border">
                  <MarkdownRenderer content={detail.readme} variant="docs" />
                </div>
              )}

              {!detail.readme &&
                detail.features &&
                detail.features.length > 0 && (
                  <ul className="space-y-0.5">
                    {detail.features.map((f, i) => (
                      <li
                        key={i}
                        className="flex gap-1.5 text-caption text-muted-foreground"
                      >
                        <span className="shrink-0 text-faint-foreground">
                          -
                        </span>
                        <span>{f}</span>
                      </li>
                    ))}
                  </ul>
                )}
            </div>
          )}

          {!loading && detail === null && (
            <p className="py-2 text-caption text-muted-foreground">
              无法加载详情
            </p>
          )}

          {result.url && (
            <a
              href={result.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 inline-flex items-center gap-1 text-caption text-muted-foreground hover:text-foreground"
            >
              在 skills.sh 查看
              <ExternalLink className="size-3" />
            </a>
          )}
        </div>
      )}
    </div>
  );
}

export function InstallSkillDialog({
  open,
  onClose,
  onInstall,
  onImportGit,
  onImportArchive,
  installing,
}: InstallSkillDialogProps) {
  const [tab, setTab] = useState<Tab>('search');
  const [pkg, setPkg] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [installingPkg, setInstallingPkg] = useState<string | null>(null);
  const [gitUrl, setGitUrl] = useState('');
  const [gitRef, setGitRef] = useState('');
  const [gitSubdirectory, setGitSubdirectory] = useState('');
  const [archive, setArchive] = useState<File | null>(null);
  const [replaceExisting, setReplaceExisting] = useState(false);
  const archiveInputRef = useRef<HTMLInputElement>(null);

  const { searching, searchResults, searchSkills } = useSkillsStore();

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = searchQuery.trim();
    if (!trimmed) return;
    await searchSkills(trimmed);
  };

  const handleInstallFromSearch = async (result: SearchResult) => {
    try {
      setInstallingPkg(result.package);
      await onInstall(result.package);
      setInstallingPkg(null);
      onClose();
    } catch (err) {
      setInstallingPkg(null);
      toast.error(err instanceof Error ? err.message : '安装失败');
    }
  };

  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = pkg.trim();
    if (!trimmed) {
      toast.error('请输入技能包名称');
      return;
    }

    try {
      await onInstall(trimmed);
      setPkg('');
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '安装失败');
    }
  };

  const handleGitSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!gitUrl.trim()) return;
    try {
      const installed = await onImportGit({
        url: gitUrl.trim(),
        ref: gitRef.trim() || undefined,
        subdirectory: gitSubdirectory.trim() || undefined,
        replace: replaceExisting,
      });
      toast.success(`已导入 ${installed.length} 个技能`);
      handleClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Git 导入失败');
    }
  };

  const handleArchiveSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!archive) return;
    try {
      const installed = await onImportArchive(archive, replaceExisting);
      toast.success(`已导入 ${installed.length} 个技能`);
      handleClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'ZIP 导入失败');
    }
  };

  const handleClose = () => {
    if (!installing) {
      setPkg('');
      setSearchQuery('');
      setInstallingPkg(null);
      setGitUrl('');
      setGitRef('');
      setGitSubdirectory('');
      setArchive(null);
      setReplaceExisting(false);
      onClose();
    }
  };

  const isInstalling = installing || !!installingPkg;

  // The footer submit button targets the active tab's form.
  const submit =
    tab === 'manual'
      ? {
          form: 'skill-install-manual',
          label: '安装',
          disabled: isInstalling || !pkg.trim(),
        }
      : tab === 'git'
        ? {
            form: 'skill-install-git',
            label: '从 Git 导入',
            disabled: isInstalling || !gitUrl.trim(),
          }
        : tab === 'zip'
          ? {
              form: 'skill-install-zip',
              label: '导入 ZIP',
              disabled: isInstalling || !archive,
            }
          : null;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      {/* Fixed height so switching tabs never resizes or re-centers it. */}
      <DialogContent className="flex h-[min(30rem,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg">
        <DialogHeader className="shrink-0 px-4 pt-4 pb-2">
          <DialogTitle>安装技能</DialogTitle>
        </DialogHeader>

        <Tabs
          value={tab}
          onValueChange={(next) => setTab(next as Tab)}
          className="min-h-0 flex-1 gap-0"
        >
          <TabsList
            variant="line"
            aria-label="技能导入方式"
            className="w-full shrink-0 justify-start border-b border-surface-border px-2.5"
          >
            <TabsTrigger
              value="search"
              disabled={isInstalling}
              className="flex-none px-2"
            >
              <Search className="size-3.5" />
              搜索市场
            </TabsTrigger>
            <TabsTrigger
              value="manual"
              disabled={isInstalling}
              className="flex-none px-2"
            >
              <Package className="size-3.5" />
              手动安装
            </TabsTrigger>
            <TabsTrigger
              value="git"
              disabled={isInstalling}
              className="flex-none px-2"
            >
              <GitBranch className="size-3.5" />
              Git
            </TabsTrigger>
            <TabsTrigger
              value="zip"
              disabled={isInstalling}
              className="flex-none px-2"
            >
              <FileArchive className="size-3.5" />
              ZIP
            </TabsTrigger>
          </TabsList>

          {/* Search Tab */}
          <TabsContent
            value="search"
            className="flex min-h-0 flex-col gap-3 p-4"
          >
            <form onSubmit={handleSearch} className="flex shrink-0 gap-2">
              <Input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索关键词..."
                aria-label="搜索技能市场"
                disabled={searching || isInstalling}
                className="flex-1"
              />
              <Button
                type="submit"
                variant="outline"
                aria-label="搜索"
                disabled={searching || isInstalling || !searchQuery.trim()}
              >
                {searching ? <Loader2 className="animate-spin" /> : <Search />}
              </Button>
            </form>

            {/* Results */}
            <div className="min-h-0 flex-1 overflow-y-auto">
              {searching && (
                <div className="flex h-full items-center justify-center gap-2 text-body text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  搜索中...
                </div>
              )}

              {!searching &&
                searchResults.length === 0 &&
                searchQuery.trim() && (
                  <div className="flex h-full items-center justify-center text-body text-muted-foreground">
                    未找到相关技能
                  </div>
                )}

              {!searching && searchResults.length > 0 && (
                <ListGroup>
                  {searchResults.map((result) => (
                    <SearchResultItem
                      key={result.package}
                      result={result}
                      isInstalling={isInstalling}
                      installingPkg={installingPkg}
                      onInstall={handleInstallFromSearch}
                    />
                  ))}
                </ListGroup>
              )}

              {!searching &&
                searchResults.length === 0 &&
                !searchQuery.trim() && (
                  <p className="flex h-full items-center justify-center text-caption text-muted-foreground">
                    在 skills.sh 市场中搜索可用的技能包
                  </p>
                )}
            </div>
          </TabsContent>

          {/* Manual Tab */}
          <TabsContent value="manual" className="overflow-y-auto p-4">
            <form
              id="skill-install-manual"
              onSubmit={handleManualSubmit}
              className="space-y-4"
            >
              <div>
                <label
                  htmlFor="skill-pkg"
                  className="mb-1.5 block text-label text-foreground"
                >
                  技能包名称
                </label>
                <Input
                  id="skill-pkg"
                  type="text"
                  value={pkg}
                  onChange={(e) => setPkg(e.target.value)}
                  placeholder="owner/repo、owner/repo@skill 或 GitHub URL"
                  disabled={isInstalling}
                />
                <p className="mt-1.5 text-caption text-muted-foreground">
                  支持格式：owner/repo、owner/repo@skill 或 GitHub URL
                </p>
              </div>
            </form>
          </TabsContent>

          <TabsContent value="git" className="overflow-y-auto p-4">
            <form
              id="skill-install-git"
              onSubmit={handleGitSubmit}
              className="space-y-4"
            >
              <div>
                <label
                  htmlFor="skill-git-url"
                  className="mb-1.5 block text-label text-foreground"
                >
                  HTTPS Git 仓库地址
                </label>
                <Input
                  id="skill-git-url"
                  type="url"
                  value={gitUrl}
                  onChange={(e) => setGitUrl(e.target.value)}
                  placeholder="https://github.com/owner/repo.git"
                  disabled={isInstalling}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="skill-git-ref"
                    className="mb-1.5 block text-caption font-medium text-muted-foreground"
                  >
                    分支或 Tag（可选）
                  </label>
                  <Input
                    id="skill-git-ref"
                    value={gitRef}
                    onChange={(e) => setGitRef(e.target.value)}
                    placeholder="main"
                    disabled={isInstalling}
                  />
                </div>
                <div>
                  <label
                    htmlFor="skill-git-subdirectory"
                    className="mb-1.5 block text-caption font-medium text-muted-foreground"
                  >
                    子目录（可选）
                  </label>
                  <Input
                    id="skill-git-subdirectory"
                    value={gitSubdirectory}
                    onChange={(e) => setGitSubdirectory(e.target.value)}
                    placeholder="skills/review"
                    disabled={isInstalling}
                  />
                </div>
              </div>
              <ReplaceExistingCheckbox
                checked={replaceExisting}
                onChange={setReplaceExisting}
                disabled={isInstalling}
              />
            </form>
          </TabsContent>

          <TabsContent value="zip" className="overflow-y-auto p-4">
            <form
              id="skill-install-zip"
              onSubmit={handleArchiveSubmit}
              className="space-y-4"
            >
              <div>
                <label
                  htmlFor="skill-archive"
                  className="mb-1.5 block text-label text-foreground"
                >
                  技能 ZIP 文件
                </label>
                <input
                  ref={archiveInputRef}
                  id="skill-archive"
                  type="file"
                  accept=".zip,application/zip"
                  onChange={(e) => setArchive(e.target.files?.[0] ?? null)}
                  disabled={isInstalling}
                  className="sr-only"
                  tabIndex={-1}
                />
                <div
                  className={cn(
                    'flex items-center gap-3 rounded-lg border border-dashed px-3 py-2.5',
                    archive ? 'border-surface-border' : 'border-input',
                  )}
                >
                  <FileArchive
                    aria-hidden="true"
                    className="size-4 shrink-0 text-muted-foreground"
                  />
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate text-body',
                      archive ? 'text-foreground' : 'text-muted-foreground',
                    )}
                    aria-live="polite"
                  >
                    {archive ? archive.name : '未选择文件'}
                  </span>
                  {archive && (
                    <span className="shrink-0 text-caption text-muted-foreground tabular-nums">
                      {formatFileSize(archive.size)}
                    </span>
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={isInstalling}
                    onClick={() => archiveInputRef.current?.click()}
                    className="shrink-0"
                  >
                    <Upload />
                    {archive ? '重新选择' : '选择文件'}
                  </Button>
                </div>
                <p className="mt-1.5 text-caption text-muted-foreground">
                  最大 10 MB，可包含一个或多个带 SKILL.md 的技能目录。
                </p>
              </div>
              <ReplaceExistingCheckbox
                checked={replaceExisting}
                onChange={setReplaceExisting}
                disabled={isInstalling}
              />
            </form>
          </TabsContent>
        </Tabs>

        <DialogFooter className="m-0 shrink-0">
          <Button
            type="button"
            variant="outline"
            onClick={handleClose}
            disabled={isInstalling}
          >
            取消
          </Button>
          {submit && (
            <Button type="submit" form={submit.form} disabled={submit.disabled}>
              {isInstalling && <Loader2 className="animate-spin" />}
              {submit.label}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function ReplaceExistingCheckbox({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled: boolean;
}) {
  return (
    <label className="flex items-start gap-2 text-caption leading-5 text-muted-foreground">
      <Checkbox
        checked={checked}
        onCheckedChange={(next) => onChange(next === true)}
        disabled={disabled}
        className="mt-0.5"
      />
      <span>覆盖同名用户级技能（默认遇到冲突时停止，不修改现有技能）</span>
    </label>
  );
}
