import { useState } from 'react';
import { Loader2, Search, ExternalLink, Download, ChevronDown, ChevronUp } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useSkillsStore, type SearchResult } from '@/stores/skills';
import { MarkdownRenderer } from '../chat/MarkdownRenderer';

interface InstallSkillDialogProps {
  open: boolean;
  onClose: () => void;
  onInstall: (pkg: string) => Promise<void>;
  installing: boolean;
}

type Tab = 'search' | 'manual';

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
  const { searchDetails, searchDetailLoading, fetchSearchDetail } = useSkillsStore();

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
    <div className="rounded-lg border border-border hover:bg-muted/50 transition-colors overflow-hidden">
      <div className="flex items-center justify-between p-3">
        <button
          type="button"
          className="min-w-0 flex-1 text-left flex items-center gap-2"
          onClick={handleToggle}
        >
          {expanded
            ? <ChevronUp className="size-3.5 shrink-0 text-muted-foreground" />
            : <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />}
          <div className="min-w-0 flex-1">
            <span className="text-sm font-medium text-foreground truncate block">
              {result.package}
            </span>
            {installCount && (
              <span className="text-xs text-muted-foreground">
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
          className="ml-3 shrink-0"
        >
          {installingPkg === result.package ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Download className="size-3.5" />
          )}
          <span className="ml-1">安装</span>
        </Button>
      </div>

      {expanded && (
        <div className="px-3 pb-3 pt-0 border-t border-border/50">
          {loading && (
            <div className="flex items-center gap-2 py-3 text-muted-foreground text-xs">
              <Loader2 className="size-3 animate-spin" />
              加载详情...
            </div>
          )}

          {!loading && detail && (
            <div className="space-y-2 pt-2">
              {detail.description && (
                <p className="text-xs text-foreground/80 leading-relaxed">{detail.description}</p>
              )}

              {detail.readme && (
                <div className="mt-2 border border-border/50 rounded-md p-3 max-h-64 overflow-y-auto bg-muted/30">
                  <MarkdownRenderer content={detail.readme} variant="docs" />
                </div>
              )}

              {!detail.readme && detail.features && detail.features.length > 0 && (
                <ul className="space-y-0.5">
                  {detail.features.map((f, i) => (
                    <li key={i} className="text-xs text-muted-foreground flex gap-1.5">
                      <span className="text-primary/60 shrink-0">-</span>
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}

          {!loading && detail === null && (
            <p className="text-xs text-muted-foreground py-2">无法加载详情</p>
          )}

          {result.url && (
            <a
              href={result.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-muted-foreground hover:text-primary inline-flex items-center gap-1 mt-2"
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
  installing,
}: InstallSkillDialogProps) {
  const [tab, setTab] = useState<Tab>('search');
  const [pkg, setPkg] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [installingPkg, setInstallingPkg] = useState<string | null>(null);

  const { searching, searchResults, searchSkills } = useSkillsStore();

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = searchQuery.trim();
    if (!trimmed) return;
    setError(null);
    await searchSkills(trimmed);
  };

  const handleInstallFromSearch = async (result: SearchResult) => {
    try {
      setError(null);
      setInstallingPkg(result.package);
      await onInstall(result.package);
      setInstallingPkg(null);
      onClose();
    } catch (err) {
      setInstallingPkg(null);
      setError(err instanceof Error ? err.message : '安装失败');
    }
  };

  const handleManualSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = pkg.trim();
    if (!trimmed) {
      setError('请输入技能包名称');
      return;
    }

    try {
      setError(null);
      await onInstall(trimmed);
      setPkg('');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : '安装失败');
    }
  };

  const handleClose = () => {
    if (!installing) {
      setPkg('');
      setSearchQuery('');
      setError(null);
      setInstallingPkg(null);
      onClose();
    }
  };

  const isInstalling = installing || !!installingPkg;

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="sm:max-w-lg max-h-[80vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>安装技能</DialogTitle>
        </DialogHeader>

        {/* Tabs */}
        <div className="flex border-b border-border shrink-0">
          <button
            type="button"
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === 'search'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => { setTab('search'); setError(null); }}
            disabled={isInstalling}
          >
            <Search className="size-3.5 inline-block mr-1.5 -mt-0.5" />
            搜索市场
          </button>
          <button
            type="button"
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === 'manual'
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
            onClick={() => { setTab('manual'); setError(null); }}
            disabled={isInstalling}
          >
            手动安装
          </button>
        </div>

        {/* Search Tab */}
        {tab === 'search' && (
          <div className="space-y-3 min-h-0 flex flex-col overflow-hidden">
            <form onSubmit={handleSearch} className="flex gap-2 shrink-0">
              <Input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索关键词..."
                disabled={searching || isInstalling}
                className="flex-1"
              />
              <Button
                type="submit"
                variant="outline"
                disabled={searching || isInstalling || !searchQuery.trim()}
              >
                {searching ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
              </Button>
            </form>

            {/* Results */}
            <div className="overflow-y-auto space-y-2 min-h-0 flex-1">
              {searching && (
                <div className="flex items-center justify-center py-8 text-muted-foreground">
                  <Loader2 className="size-4 animate-spin mr-2" />
                  搜索中...
                </div>
              )}

              {!searching && searchResults.length === 0 && searchQuery.trim() && (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  未找到相关技能
                </div>
              )}

              {!searching && searchResults.map((result) => (
                <SearchResultItem
                  key={result.package}
                  result={result}
                  isInstalling={isInstalling}
                  installingPkg={installingPkg}
                  onInstall={handleInstallFromSearch}
                />
              ))}
            </div>

            {!searching && searchResults.length === 0 && !searchQuery.trim() && (
              <p className="text-xs text-muted-foreground text-center py-4">
                在 skills.sh 市场中搜索可用的技能包
              </p>
            )}
          </div>
        )}

        {/* Manual Tab */}
        {tab === 'manual' && (
          <form onSubmit={handleManualSubmit} className="space-y-4">
            <div>
              <label htmlFor="skill-pkg" className="block text-sm font-medium text-foreground mb-2">
                技能包名称
              </label>
              <Input
                id="skill-pkg"
                type="text"
                value={pkg}
                onChange={(e) => setPkg(e.target.value)}
                placeholder="owner/repo 或 owner/repo@skill"
                disabled={isInstalling}
              />
              <p className="mt-1 text-xs text-muted-foreground">
                支持格式：owner/repo 或 owner/repo@skill
              </p>
            </div>

            <div className="flex items-center justify-end gap-3 pt-2">
              <Button
                type="button"
                variant="ghost"
                onClick={handleClose}
                disabled={isInstalling}
              >
                取消
              </Button>
              <Button
                type="submit"
                disabled={isInstalling || !pkg.trim()}
              >
                {isInstalling && <Loader2 className="size-4 animate-spin" />}
                安装
              </Button>
            </div>
          </form>
        )}

        {/* Error display */}
        {error && (
          <div className="p-3 bg-error-bg border border-destructive/20 rounded-lg shrink-0">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
