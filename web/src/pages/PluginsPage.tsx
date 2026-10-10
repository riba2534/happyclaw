import { useEffect, useState } from 'react';
import {
  RefreshCw,
  FolderSync,
  PowerOff,
  Puzzle,
  AlertTriangle,
} from 'lucide-react';
import { EmptyState } from '@/components/common/EmptyState';
import { IconButton } from '@/components/common/IconButton';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  SettingsGroup,
  SettingsSection,
} from '@/components/settings/SettingsLayout';
import {
  Callout,
  CapabilityListSkeleton,
  CapabilityNotice,
  CapabilitySectionActions,
  CapabilityToolbar,
} from '@/components/capabilities/capability-ui';
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
    <Badge
      variant="warning"
      title={
        warnings.note || `Missing binaries: ${warnings.missing.join(', ')}`
      }
    >
      <AlertTriangle />
      缺少 {warnings.missing.join(', ')}
    </Badge>
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
    deleteMarketplace,
  } = usePluginsStore();

  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');
  const [deleteTarget, setDeleteTarget] = useState<{
    name: string;
    enabledCount: number;
  } | null>(null);

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

  return (
    <div className="space-y-4">
      <CapabilitySectionActions>
        {isAdmin && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleScan}
            disabled={scanning}
            title="扫描宿主机 ~/.claude/plugins/marketplaces/ 并导入 catalog"
          >
            <FolderSync className={scanning ? 'animate-pulse' : ''} />
            <span className="max-sm:sr-only">扫描宿主机 Catalog</span>
          </Button>
        )}
        <IconButton
          label="刷新"
          icon={<RefreshCw className={loading ? 'animate-spin' : undefined} />}
          onClick={loadPlugins}
          disabled={loading}
        />
      </CapabilitySectionActions>

      <CapabilityNotice>
        Plugin Catalog
        由管理员从宿主机导入并全局共享；下方启用状态仅属于当前用户。
        更改会在新建会话时生效，已运行的智能体不会热加载。
      </CapabilityNotice>

      <CapabilityToolbar
        summary={`${marketplaces.length} 个 marketplace · ${totalPlugins} 个 plugin · 启用 ${enabledPlugins}`}
      />

      <div className="space-y-8">
        {loading && marketplaces.length === 0 ? (
          <CapabilityListSkeleton rows={3} />
        ) : error ? (
          <Callout tone="error" role="alert">
            {error}
          </Callout>
        ) : marketplaces.length === 0 ? (
          <EmptyState
            icon={Puzzle}
            title="还没有 plugin"
            description={`v3 升级用户首次访问看到 0 plugin 是预期。${
              isAdmin
                ? '尚未导入任何 marketplace。点击右上 "扫描宿主机" 触发 catalog 导入。'
                : 'admin 还未导入任何 marketplace，请稍后再来。'
            }`}
            className="border border-surface-border"
          />
        ) : (
          marketplaces.map((mp) => (
            <SettingsSection
              key={mp.name}
              title={
                <span className="flex items-baseline gap-2">
                  <span className="truncate">{mp.name}</span>
                  {mp.version && (
                    <span className="text-caption font-normal text-muted-foreground">
                      v{mp.version}
                    </span>
                  )}
                </span>
              }
              description={
                <>
                  {mp.hostSourcePath && (
                    <>
                      同步自{' '}
                      <code className="font-mono break-all">
                        {mp.hostSourcePath}
                      </code>{' '}
                      ·{' '}
                    </>
                  )}
                  {mp.plugins.length} 个 plugin
                </>
              }
              actions={
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    setDeleteTarget({
                      name: mp.name,
                      enabledCount: mp.plugins.filter((p) => p.enabled).length,
                    })
                  }
                  className="text-muted-foreground hover:bg-error/10 hover:text-error"
                >
                  <PowerOff />
                  <span className="max-sm:sr-only">清除我的启用项</span>
                </Button>
              }
            >
              <SettingsGroup>
                {mp.plugins.length === 0 ? (
                  <p className="px-4 py-3 text-caption text-muted-foreground">
                    该 marketplace 目录下没有有效的 plugin（缺少
                    .claude-plugin/plugin.json）
                  </p>
                ) : (
                  mp.plugins.map((plugin) => (
                    <div
                      key={plugin.fullId}
                      className="flex items-start gap-4 px-4 py-3"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <label
                            htmlFor={`plugin-${plugin.fullId}`}
                            className="text-body font-medium text-foreground"
                          >
                            {plugin.name}
                          </label>
                          {plugin.version && (
                            <span className="text-caption text-muted-foreground">
                              v{plugin.version}
                            </span>
                          )}
                          <WarningBadge warnings={plugin.warnings} />
                        </div>
                        {plugin.description && (
                          <p className="mt-0.5 line-clamp-2 text-caption leading-5 text-muted-foreground">
                            {plugin.description}
                          </p>
                        )}
                        <p className="mt-0.5 truncate font-mono text-micro text-faint-foreground">
                          {plugin.fullId}
                        </p>
                      </div>
                      <Switch
                        id={`plugin-${plugin.fullId}`}
                        checked={plugin.enabled}
                        onCheckedChange={() => handleToggle(plugin)}
                        className="mt-0.5"
                      />
                    </div>
                  ))
                )}
              </SettingsGroup>
            </SettingsSection>
          ))
        )}
      </div>

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
              取消
            </Button>
            <Button variant="destructive" onClick={handleDelete}>
              <PowerOff />
              全部停用
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
