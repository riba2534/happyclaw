import { useEffect, useState, useMemo } from 'react';
import { Plus, RefreshCw, Server, Download } from 'lucide-react';
import { SearchInput } from '@/components/common';
import { EmptyState } from '@/components/common/EmptyState';
import { IconButton } from '@/components/common/IconButton';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@/components/ui/sheet';
import { Spinner } from '@/components/ui/spinner';
import {
  Callout,
  CapabilityListSection,
  CapabilityListSkeleton,
  CapabilitySectionActions,
  DetailPanel,
} from '@/components/capabilities/capability-ui';
import { useMediaQuery } from '@/hooks/useMediaQuery';
import { useMcpServersStore } from '../stores/mcp-servers';
import { useAuthStore } from '../stores/auth';
import { McpServerCard } from '../components/mcp-servers/McpServerCard';
import { McpServerDetail } from '../components/mcp-servers/McpServerDetail';
import { AddMcpServerDialog } from '../components/mcp-servers/AddMcpServerDialog';
import type { McpServer } from '../stores/mcp-servers';

export function McpServersPage() {
  const {
    servers,
    loading,
    error,
    syncing,
    loadServers,
    addServer,
    getServer,
    syncHostServers,
  } = useMcpServersStore();

  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');

  const [selectedSourceKey, setSelectedSourceKey] = useState<string | null>(
    null,
  );
  const [selectedServer, setSelectedServer] = useState<McpServer | null>(null);
  const [selectedLoading, setSelectedLoading] = useState(false);
  const [selectedError, setSelectedError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const isDesktop = useMediaQuery('(min-width: 1024px)');

  useEffect(() => {
    loadServers();
  }, [loadServers]);

  const filtered = useMemo(() => {
    const q = searchQuery.toLowerCase();
    return servers.filter(
      (s) =>
        !q ||
        s.id.toLowerCase().includes(q) ||
        (s.command && s.command.toLowerCase().includes(q)) ||
        (s.url && s.url.toLowerCase().includes(q)) ||
        (s.description && s.description.toLowerCase().includes(q)),
    );
  }, [servers, searchQuery]);

  const userServers = filtered.filter((server) => server.source === 'user');
  const systemServers = filtered.filter((server) => server.source === 'system');
  const importedCount = servers.filter(
    (server) => server.importedFromHost || server.syncedFromHost,
  ).length;

  const enabledCount = servers.filter((s) => s.enabled).length;
  const hasRows = !error && filtered.length > 0;
  const selectedSummary =
    servers.find((server) => server.sourceKey === selectedSourceKey) || null;

  useEffect(() => {
    if (!selectedSourceKey || !selectedSummary) {
      setSelectedServer(null);
      setSelectedError(null);
      return;
    }

    let cancelled = false;
    setSelectedLoading(true);
    setSelectedError(null);
    getServer(selectedSourceKey)
      .then((server) => {
        if (!cancelled) {
          setSelectedServer({
            ...server,
            conflictSources: selectedSummary.conflictSources,
            effective: selectedSummary.effective,
          });
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setSelectedServer(null);
          setSelectedError(
            error instanceof Error ? error.message : '读取 MCP 详情失败',
          );
        }
      })
      .finally(() => {
        if (!cancelled) setSelectedLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [getServer, selectedSourceKey, selectedSummary]);

  const handleSync = async () => {
    setSyncMessage(null);
    try {
      const result = await syncHostServers();
      const { added, skipped } = result;
      setSyncMessage(
        `导入完成：新增 ${added}，跳过 ${skipped}。已导入的是独立副本，不会覆盖现有配置。`,
      );
      setTimeout(() => setSyncMessage(null), 5000);
    } catch {
      // error handled by store
    }
  };

  const handleAdd = async (server: Parameters<typeof addServer>[0]) => {
    await addServer(server);
  };

  const detail = selectedLoading ? (
    <DetailPanel className="flex min-h-40 items-center justify-center">
      <Spinner className="size-5 text-muted-foreground" />
    </DetailPanel>
  ) : selectedError ? (
    <Callout tone="error" role="alert" className="text-body">
      {selectedError}
    </Callout>
  ) : (
    <McpServerDetail
      server={selectedServer}
      onDeleted={() => setSelectedSourceKey(null)}
    />
  );

  const renderRows = (items: McpServer[]) =>
    items.map((server) => (
      <McpServerCard
        key={server.sourceKey}
        server={server}
        selected={selectedSourceKey === server.sourceKey}
        onSelect={() => setSelectedSourceKey(server.sourceKey)}
      />
    ));

  return (
    <div className="space-y-4">
      <CapabilitySectionActions>
        {isAdmin && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleSync}
            disabled={syncing}
            title="导入宿主机副本"
          >
            <Download className={syncing ? 'animate-pulse' : ''} />
            <span className="max-sm:sr-only">
              {syncing ? '导入中...' : '导入宿主机副本'}
            </span>
          </Button>
        )}
        <IconButton
          label="刷新"
          icon={<RefreshCw className={loading ? 'animate-spin' : undefined} />}
          onClick={loadServers}
          disabled={loading}
        />
        <Button size="sm" onClick={() => setShowAddDialog(true)}>
          <Plus />
          <span className="max-sm:sr-only">添加</span>
        </Button>
      </CapabilitySectionActions>

      <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:gap-3">
        <SearchInput
          value={searchQuery}
          onChange={setSearchQuery}
          placeholder="搜索 ID、命令或 URL"
          className="w-full lg:w-72"
        />
        <p className="text-caption text-muted-foreground tabular-nums lg:ml-auto">
          {`我的 ${servers.filter((server) => server.source === 'user').length} · 系统 ${servers.filter((server) => server.source === 'system').length} · 启用 ${enabledCount}${importedCount > 0 ? ` · 宿主机副本 ${importedCount}` : ''}`}
        </p>
      </div>

      <Callout>
        这里管理 HappyClaw 额外提供的 MCP，再由各智能体决定是否允许使用。
        继承宿主机 ~/.claude 的智能体会自动获得宿主机全部 MCP，无需导入或勾选。
        密钥写入后不会再次显示；STDIO 命令会在智能体 的实际运行环境中执行。
      </Callout>

      {/* Sync message toast */}
      {syncMessage && (
        <Callout tone="success" role="status">
          {syncMessage}
        </Callout>
      )}

      <div
        className={
          hasRows
            ? 'grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]'
            : undefined
        }
      >
        <div className="min-w-0 space-y-6">
          {loading && servers.length === 0 ? (
            <CapabilityListSkeleton rows={3} />
          ) : error ? (
            <Callout tone="error" role="alert">
              {error}
            </Callout>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon={Server}
              title={
                searchQuery ? '没有找到匹配的 MCP 服务器' : '暂无 MCP 服务器'
              }
              description={
                searchQuery ? undefined : '点击"添加"按钮添加第一个 MCP 服务器'
              }
              className="border"
            />
          ) : (
            <>
              {userServers.length > 0 && (
                <CapabilityListSection
                  title={`我的 MCP (${userServers.length})`}
                >
                  {renderRows(userServers)}
                </CapabilityListSection>
              )}

              {systemServers.length > 0 && (
                <CapabilityListSection
                  title={`系统 MCP (${systemServers.length})`}
                  description="系统列表对所有用户可见，仅管理员可修改；是否允许成员的智能体使用由每项配置决定。系统与个人存在同名配置时，个人配置优先。"
                >
                  {renderRows(systemServers)}
                </CapabilityListSection>
              )}
            </>
          )}
        </div>

        {/* Right detail (desktop) */}
        <div className={hasRows ? 'hidden min-w-0 lg:block' : 'hidden'}>
          <div className="sticky top-16 max-h-[calc(var(--app-canvas-h)-5rem)] overflow-y-auto p-px">
            {isDesktop && detail}
          </div>
        </div>
      </div>

      {/* Mobile detail */}
      <Sheet
        open={!isDesktop && !!selectedSourceKey}
        onOpenChange={(open) => !open && setSelectedSourceKey(null)}
      >
        <SheetContent
          side="bottom"
          className="max-h-[88dvh] gap-0 overflow-y-auto rounded-t-xl p-0 pt-8 *:data-[slot=detail-panel]:rounded-none *:data-[slot=detail-panel]:ring-0"
        >
          <SheetTitle className="sr-only">MCP 服务器详情</SheetTitle>
          <SheetDescription className="sr-only">
            查看所选 MCP 服务器的连接方式与密钥配置
          </SheetDescription>
          {!isDesktop && detail}
        </SheetContent>
      </Sheet>

      <AddMcpServerDialog
        open={showAddDialog}
        isAdmin={isAdmin}
        onClose={() => setShowAddDialog(false)}
        onAdd={handleAdd}
      />
    </div>
  );
}
