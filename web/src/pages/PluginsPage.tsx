import { useEffect, useState } from 'react';
import {
  RefreshCw,
  PowerOff,
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
import { usePluginsStore, type PluginEntry } from '../stores/plugins';
import { useAuthStore } from '../stores/auth';

function WarningBadge({ warnings }: { warnings: PluginEntry['warnings'] }) {
  if (!warnings.missing || warnings.missing.length === 0) return null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-md border border-warning/30 bg-warning-bg px-2 py-0.5 text-xs text-warning"
      title={
        warnings.note || `Missing binaries: ${warnings.missing.join(', ')}`
      }
    >
      <AlertTriangle size={12} />
      缺少 {warnings.missing.join(', ')}
    </span>
  );
}

export function PluginsPage() {
  const {
    marketplaces,
    loading,
    scanning,
    error,
    loadPlugins,
    scanCatalog,
    toggleEnabled,
    deactivateImmediately,
    deleteMarketplace,
  } = usePluginsStore();

  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const [deleteTarget, setDeleteTarget] = useState<{
    name: string;
    enabledCount: number;
  } | null>(null);
  const [deactivateTarget, setDeactivateTarget] = useState<PluginEntry | null>(
    null,
  );
  const [deactivating, setDeactivating] = useState(false);

  useEffect(() => {
    loadPlugins();
  }, [loadPlugins]);

  const totalPlugins = marketplaces.reduce(
    (acc, mp) => acc + mp.plugins.length,
    0,
  );
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
          `已启用 ${plugin.fullId}。变更在下次新建会话时生效；已运行的智能体进程不会自动加载。`,
        );
      } else {
        toast.success(`已禁用 ${plugin.fullId}。下次新会话生效。`);
      }
    } catch (err) {
      toast.error(
        `切换失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const handleScan = async () => {
    try {
      const report = await scanCatalog();
      toast.success(
        `Scanned: marketplaces=${report.marketplacesScanned}, plugins=${report.pluginsScanned}, created=${report.snapshotsCreated}, skipped=${report.snapshotsSkipped}`,
      );
      if (report.warnings.length > 0) {
        toast.warning(`扫描告警:\n${report.warnings.join('\n')}`);
      }
    } catch (err) {
      toast.error(
        `扫描失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      const result = await deleteMarketplace(deleteTarget.name);
      toast.success(
        `已清除 ${deleteTarget.name} 下 ${result.removedEnabled.length} 个个人启用项。`,
      );
      setDeleteTarget(null);
    } catch (err) {
      toast.error(
        `删除失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const handleDeactivateImmediately = async () => {
    if (!deactivateTarget) return;
    setDeactivating(true);
    try {
      const res = await deactivateImmediately(deactivateTarget.fullId);
      toast.success(
        `已立即停用 ${deactivateTarget.fullId}，已重启 ${res.stoppedSessionsCount} 个受影响会话。`,
      );
      setDeactivateTarget(null);
    } catch (err) {
      toast.error(
        `立即停用失败：${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setDeactivating(false);
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
                  <Button
                    variant="outline"
                    onClick={handleScan}
                    disabled={scanning}
                    title="扫描宿主机 ~/.claude/plugins/marketplaces/ 并导入 catalog"
                  >
                    <RefreshCw
                      size={18}
                      className={scanning ? 'animate-spin' : ''}
                    />
                    扫描宿主机 Catalog
                  </Button>
                )}
                <Button
                  variant="outline"
                  onClick={loadPlugins}
                  disabled={loading}
                >
                  <RefreshCw
                    size={18}
                    className={loading ? 'animate-spin' : ''}
                  />
                  刷新
                </Button>
              </div>
            }
          />
        </div>

        <div className="mx-6 mt-4 p-3 bg-info-bg border border-info/20 rounded-lg text-xs text-info flex gap-2">
          <Info size={16} className="flex-shrink-0 mt-0.5" />
          <div>
            Plugin Catalog
            由管理员从宿主机导入并全局共享；下方启用状态仅属于当前用户。
            更改会在新建会话时生效，已运行的智能体不会热加载。
          </div>
        </div>

        {!loading && !error && marketplaces.length === 0 && (
          <div className="mx-6 mt-4 p-3 bg-info-bg border border-info/20 rounded-lg text-xs text-info flex gap-2">
            <Info size={16} className="flex-shrink-0 mt-0.5" />
            <div>
              v3 升级用户首次访问看到 0 plugin 是预期。
              {isAdmin
                ? '请点击右上 "扫描宿主机" 触发 catalog 导入；'
                : '等 admin 完成导入后即可启用。'}
            </div>
          </div>
        )}

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
              description={
                isAdmin
                  ? '尚未导入任何 marketplace。点击右上 "扫描宿主机" 触发 catalog 导入。'
                  : 'admin 还未导入任何 marketplace，请稍后再来。'
              }
            />
          ) : (
            marketplaces.map((mp) => (
              <Card key={mp.name}>
                <CardContent className="p-4">
                  <div className="flex items-center justify-between mb-3 pb-3 border-b border-border">
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-base">
                          {mp.name}
                        </span>
                        {mp.version && (
                          <span className="text-xs text-muted-foreground">
                            v{mp.version}
                          </span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {mp.hostSourcePath && (
                          <>
                            同步自 <code>{mp.hostSourcePath}</code> ·{' '}
                          </>
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
                          enabledCount: mp.plugins.filter((p) => p.enabled)
                            .length,
                        })
                      }
                      className="text-destructive hover:bg-destructive/10"
                    >
                      <PowerOff size={14} />
                      清除我的启用项
                    </Button>
                  </div>

                  {mp.plugins.length === 0 ? (
                    <div className="text-sm text-muted-foreground py-3">
                      该 marketplace 目录下没有有效的 plugin（缺少
                      .claude-plugin/plugin.json）
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
                          <div className="flex items-center gap-3">
                            {plugin.enabled && (
                              <Button
                                variant="outline"
                                size="sm"
                                className="text-destructive hover:bg-destructive/10 text-xs h-8"
                                onClick={() => setDeactivateTarget(plugin)}
                                title="立即停止当前用户正在运行且加载了该插件的会话，并在更新配置后重启"
                              >
                                <PowerOff size={13} className="mr-1" />
                                立即停用
                              </Button>
                            )}
                            <Switch
                              checked={plugin.enabled}
                              onCheckedChange={() => handleToggle(plugin)}
                            />
                          </div>
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

      <Dialog
        open={deactivateTarget !== null}
        onOpenChange={(o) => !o && setDeactivateTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>立即停用并重启受影响会话</DialogTitle>
            <DialogDescription>
              将立即停用 <strong>{deactivateTarget?.fullId}</strong>
              ，并安全停止当前用户所有加载了该插件的活跃运行中会话，随后以新配置重启。其他用户不受影响。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeactivateTarget(null)}
              disabled={deactivating}
            >
              <X size={14} />
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={handleDeactivateImmediately}
              disabled={deactivating}
            >
              <PowerOff size={14} />
              {deactivating ? '停用中...' : '确认立即停用'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>清除我的启用项</DialogTitle>
            <DialogDescription>
              将停用你账户下所有属于 <strong>{deleteTarget?.name}</strong> 的
              Plugin。
              {deleteTarget && deleteTarget.enabledCount > 0 && (
                <>
                  {' '}
                  会一次性禁用 <strong>{deleteTarget.enabledCount}</strong> 个
                  plugin。
                </>
              )}
              不会删除共享 Catalog、宿主机 marketplace 或其他用户的启用状态。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              <X size={14} />
              取消
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              <PowerOff size={14} />
              全部停用
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
