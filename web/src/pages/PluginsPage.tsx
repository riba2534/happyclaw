import { useEffect, useState } from 'react';
import {
  Download,
  RefreshCw,
  Trash2,
  Puzzle,
  AlertTriangle,
  Info,
  X,
} from 'lucide-react';
import { PageHeader } from '@/components/common/PageHeader';
import { SkeletonCardList } from '@/components/common/Skeletons';
import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { toast } from 'sonner';
import {
  usePluginsStore,
  type HostMarketplaceInfo,
  type PluginEntry,
} from '../stores/plugins';
import { useAuthStore } from '../stores/auth';

function WarningBadge({
  warnings,
}: {
  warnings: PluginEntry['warnings'];
}) {
  if (!warnings.missing || warnings.missing.length === 0) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md border border-warning/30 bg-warning-bg px-2 py-0.5 text-xs text-warning"
      title={
        warnings.note ||
        `Missing binaries: ${warnings.missing.join(', ')}`
      }
    >
      <AlertTriangle size={12} />
      缺少 {warnings.missing.join(', ')}
    </span>
  );
}

function SyncHostDialog({
  open,
  onClose,
  onSynced,
}: {
  open: boolean;
  onClose: () => void;
  onSynced: () => void;
}) {
  const { fetchAvailableOnHost, syncMarketplace, syncing } = usePluginsStore();
  const [available, setAvailable] = useState<HostMarketplaceInfo[] | null>(null);
  const [hostRoot, setHostRoot] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [working, setWorking] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    fetchAvailableOnHost()
      .then((data) => {
        if (cancelled) return;
        setAvailable(data.marketplaces);
        setHostRoot(data.hostRoot);
      })
      .catch((err) => {
        if (cancelled) return;
        toast.error(`扫描宿主机失败：${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, fetchAvailableOnHost]);

  const handleSync = async (mp: HostMarketplaceInfo) => {
    setWorking(mp.name);
    try {
      const result = await syncMarketplace(mp.name);
      toast.success(
        `同步 ${mp.name}：复制 ${result.copied.length} 个插件${
          result.warnings.length > 0 ? `（${result.warnings.length} 条警告）` : ''
        }`,
      );
      onSynced();
    } catch (err) {
      toast.error(`同步失败：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setWorking(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>从宿主机同步 plugin marketplace</DialogTitle>
          <DialogDescription>
            扫描本机 <code className="text-xs">{hostRoot || '~/.claude/plugins/marketplaces/'}</code>{' '}
            下已安装的 marketplace。选中后会把该 marketplace 下所有 plugin 复制到你专属的 cache 目录（只读挂载到容器），**不自动启用**——同步后再去列表里逐个启用。
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto space-y-3">
          {loading && <SkeletonCardList count={2} />}
          {!loading && available && available.length === 0 && (
            <EmptyState
              icon={Puzzle}
              title="宿主机上没有可同步的 marketplace"
              description={`请先在本机安装 Claude Code plugins（放到 ${hostRoot}）`}
            />
          )}
          {available?.map((mp) => (
            <Card key={mp.name}>
              <CardContent className="p-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{mp.name}</span>
                      {mp.synced && (
                        <span className="text-xs text-muted-foreground">（已同步）</span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {mp.plugins.length} 个 plugin ·{' '}
                      {mp.plugins.map((p) => p.name).join(', ')}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => handleSync(mp)}
                    disabled={syncing || working !== null}
                  >
                    {working === mp.name ? '同步中...' : mp.synced ? '重新同步' : '同步'}
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={working !== null}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function PluginsPage() {
  const {
    marketplaces,
    loading,
    error,
    loadPlugins,
    toggleEnabled,
    deleteMarketplace,
  } = usePluginsStore();

  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const [showSyncDialog, setShowSyncDialog] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ name: string; enabledCount: number } | null>(
    null,
  );

  useEffect(() => {
    loadPlugins();
  }, [loadPlugins]);

  const totalPlugins = marketplaces.reduce((acc, mp) => acc + mp.plugins.length, 0);
  const enabledPlugins = marketplaces.reduce(
    (acc, mp) => acc + mp.plugins.filter((p) => p.enabled).length,
    0,
  );

  const handleToggle = async (plugin: PluginEntry) => {
    const newEnabled = !plugin.enabled;
    try {
      await toggleEnabled(plugin.fullId, newEnabled);
      if (newEnabled) {
        toast.success(
          `已启用 ${plugin.fullId}。变更在下次新建会话时生效；已运行的 agent 进程不会自动加载。`,
        );
      } else {
        toast.success(`已禁用 ${plugin.fullId}。下次新会话生效。`);
      }
    } catch (err) {
      toast.error(`切换失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      const result = await deleteMarketplace(deleteTarget.name);
      toast.success(
        `已删除 ${deleteTarget.name}。清理了 ${result.removedEnabled.length} 条启用项。`,
      );
      setDeleteTarget(null);
    } catch (err) {
      toast.error(`删除失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return (
    <div className="min-h-full bg-background">
      <div className="max-w-7xl mx-auto">
        <div className="bg-background border-b border-border px-6 py-4">
          <PageHeader
            title="Claude Code 插件"
            subtitle={`${marketplaces.length} 个 marketplace · ${totalPlugins} 个 plugin · 启用 ${enabledPlugins}`}
            actions={
              <div className="flex items-center gap-3">
                {isAdmin && (
                  <Button variant="outline" onClick={() => setShowSyncDialog(true)}>
                    <Download size={18} />
                    从宿主机同步
                  </Button>
                )}
                <Button variant="outline" onClick={loadPlugins} disabled={loading}>
                  <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
                  刷新
                </Button>
              </div>
            }
          />
        </div>

        <div className="mx-6 mt-4 p-3 bg-info-bg border border-info/20 rounded-lg text-xs text-info flex gap-2">
          <Info size={16} className="flex-shrink-0 mt-0.5" />
          <div>
            Plugin 通过 SDK <code>options.plugins</code> 注入（session-local 加载）。
            启用/禁用后需要新建会话才生效；已运行的 agent 进程不会热加载插件变化。
          </div>
        </div>

        <div className="p-6 space-y-6">
          {loading && marketplaces.length === 0 ? (
            <SkeletonCardList count={3} />
          ) : error ? (
            <Card className="border-error/20">
              <CardContent className="text-center">
                <p className="text-error">{error}</p>
              </CardContent>
            </Card>
          ) : marketplaces.length === 0 ? (
            <EmptyState
              icon={Puzzle}
              title="还没有 plugin"
              description='点击"从宿主机同步"从本机 ~/.claude/plugins/marketplaces/ 导入 marketplace'
            />
          ) : (
            marketplaces.map((mp) => (
              <Card key={mp.name}>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between mb-3 pb-3 border-b border-border">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-base">{mp.name}</span>
                        {mp.version && (
                          <span className="text-xs text-muted-foreground">v{mp.version}</span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {mp.hostSourcePath && (
                          <>同步自 <code>{mp.hostSourcePath}</code> · </>
                        )}
                        {mp.plugins.length} 个 plugin
                      </div>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setDeleteTarget({
                          name: mp.name,
                          enabledCount: mp.plugins.filter((p) => p.enabled).length,
                        })
                      }
                      className="text-destructive hover:bg-destructive/10"
                    >
                      <Trash2 size={14} />
                      删除
                    </Button>
                  </div>

                  {mp.plugins.length === 0 ? (
                    <div className="text-sm text-muted-foreground py-3">
                      该 marketplace 目录下没有有效的 plugin（缺少 .claude-plugin/plugin.json）
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {mp.plugins.map((plugin) => (
                        <div
                          key={plugin.fullId}
                          className="flex items-center justify-between gap-3 py-2"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 flex-wrap">
                              <span className="font-medium">{plugin.name}</span>
                              {plugin.version && (
                                <span className="text-xs text-muted-foreground">
                                  v{plugin.version}
                                </span>
                              )}
                              <WarningBadge warnings={plugin.warnings} />
                            </div>
                            {plugin.description && (
                              <div className="text-xs text-muted-foreground mt-0.5 truncate">
                                {plugin.description}
                              </div>
                            )}
                            <div className="text-xs text-muted-foreground mt-0.5 font-mono">
                              {plugin.fullId}
                            </div>
                          </div>
                          <Switch
                            checked={plugin.enabled}
                            onCheckedChange={() => handleToggle(plugin)}
                          />
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))
          )}
        </div>
      </div>

      <SyncHostDialog
        open={showSyncDialog}
        onClose={() => setShowSyncDialog(false)}
        onSynced={() => {
          /* store auto-refreshed via syncMarketplace */
        }}
      />

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>删除 marketplace 本地副本</DialogTitle>
            <DialogDescription>
              将删除 <strong>{deleteTarget?.name}</strong> 的本地 cache 目录和相关配置。
              {deleteTarget && deleteTarget.enabledCount > 0 && (
                <>
                  {' '}会同时清除 <strong>{deleteTarget.enabledCount}</strong> 个已启用的 plugin。
                </>
              )}
              宿主机原始 marketplace 目录不受影响。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              <X size={14} />
              取消
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              <Trash2 size={14} />
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
