import { useEffect, useState, useMemo } from 'react';
import { Plus, RefreshCw, Server, Download } from 'lucide-react';
import { SearchInput } from '@/components/common';
import { PageHeader } from '@/components/common/PageHeader';
import { SkeletonCardList } from '@/components/common/Skeletons';
import { EmptyState } from '@/components/common/EmptyState';
import { Button } from '@/components/ui/button';
import { useMcpServersStore } from '../stores/mcp-servers';
import { useAuthStore } from '../stores/auth';
import { McpServerCard } from '../components/mcp-servers/McpServerCard';
import { McpServerDetail } from '../components/mcp-servers/McpServerDetail';
import { AddMcpServerDialog } from '../components/mcp-servers/AddMcpServerDialog';

export function McpServersPage() {
  const {
    servers,
    loading,
    error,
    syncing,
    loadServers,
    addServer,
    syncHostServers,
  } = useMcpServersStore();

  const isAdmin = useAuthStore((s) => s.user?.role === 'admin');

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);

  useEffect(() => {
    loadServers();
  }, [loadServers]);

  const filtered = useMemo(() => {
    const q = searchQuery.toLowerCase();
    return servers.filter(
      (s) =>
        !q ||
        s.id.toLowerCase().includes(q) ||
        s.command.toLowerCase().includes(q) ||
        (s.description && s.description.toLowerCase().includes(q)),
    );
  }, [servers, searchQuery]);

  const manualServers = filtered.filter((s) => !s.syncedFromHost);
  const syncedServers = filtered.filter((s) => s.syncedFromHost);

  const enabledCount = servers.filter((s) => s.enabled).length;
  const selectedServer = servers.find((s) => s.id === selectedId) || null;

  const handleSync = async () => {
    setSyncMessage(null);
    try {
      const result = await syncHostServers();
      const { added, updated, deleted, skipped } = result;
      setSyncMessage(
        `同步完成：新增 ${added}，更新 ${updated}，删除 ${deleted}，跳过 ${skipped}`,
      );
      setTimeout(() => setSyncMessage(null), 5000);
    } catch {
      // error handled by store
    }
  };

  const handleAdd = async (server: {
    id: string;
    command: string;
    args?: string[];
    env?: Record<string, string>;
    description?: string;
  }) => {
    await addServer(server);
  };

  return (
    <div className="min-h-full bg-slate-50">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="bg-white border-b border-slate-200 px-6 py-4">
          <PageHeader
            title="MCP 服务器"
            subtitle={`共 ${servers.length} 个${syncedServers.length > 0 ? `（含同步 ${syncedServers.length}）` : ''} · 启用 ${enabledCount}`}
            actions={
              <div className="flex items-center gap-3">
                {isAdmin && (
                  <Button variant="outline" onClick={handleSync} disabled={syncing}>
                    <Download size={18} className={syncing ? 'animate-pulse' : ''} />
                    {syncing ? '同步中...' : '同步宿主机'}
                  </Button>
                )}
                <Button variant="outline" onClick={loadServers} disabled={loading}>
                  <RefreshCw size={18} className={loading ? 'animate-spin' : ''} />
                  刷新
                </Button>
                <Button onClick={() => setShowAddDialog(true)}>
                  <Plus size={18} />
                  添加
                </Button>
              </div>
            }
          />
        </div>

        {/* Sync message toast */}
        {syncMessage && (
          <div className="mx-6 mt-4 p-3 bg-green-50 border border-green-200 rounded-lg text-sm text-green-700">
            {syncMessage}
          </div>
        )}

        {/* Content */}
        <div className="flex gap-6 p-4">
          {/* Left list */}
          <div className="w-full lg:w-1/2 xl:w-2/5">
            <div className="mb-4">
              <SearchInput
                value={searchQuery}
                onChange={setSearchQuery}
                placeholder="搜索 ID 或命令"
              />
            </div>

            <div className="space-y-6">
              {loading && servers.length === 0 ? (
                <SkeletonCardList count={3} />
              ) : error ? (
                <div className="bg-white rounded-xl border border-red-200 p-6 text-center">
                  <p className="text-red-600">{error}</p>
                </div>
              ) : filtered.length === 0 ? (
                <EmptyState
                  icon={Server}
                  title={searchQuery ? '没有找到匹配的 MCP 服务器' : '暂无 MCP 服务器'}
                  description={searchQuery ? undefined : '点击"添加"按钮添加第一个 MCP 服务器'}
                />
              ) : (
                <>
                  {manualServers.length > 0 && (
                    <div>
                      <h2 className="text-sm font-semibold text-slate-700 mb-3">
                        手动添加 ({manualServers.length})
                      </h2>
                      <div className="space-y-2">
                        {manualServers.map((server) => (
                          <McpServerCard
                            key={server.id}
                            server={server}
                            selected={selectedId === server.id}
                            onSelect={() => setSelectedId(server.id)}
                          />
                        ))}
                      </div>
                    </div>
                  )}

                  {syncedServers.length > 0 && (
                    <div>
                      <h2 className="text-sm font-semibold text-slate-700 mb-3">
                        宿主机同步 ({syncedServers.length})
                      </h2>
                      <div className="space-y-2">
                        {syncedServers.map((server) => (
                          <McpServerCard
                            key={server.id}
                            server={server}
                            selected={selectedId === server.id}
                            onSelect={() => setSelectedId(server.id)}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>

          {/* Right detail (desktop) */}
          <div className="hidden lg:block lg:w-1/2 xl:w-3/5">
            <McpServerDetail server={selectedServer} onDeleted={() => setSelectedId(null)} />
          </div>
        </div>

        {/* Mobile detail */}
        {selectedId && selectedServer && (
          <div className="lg:hidden p-4">
            <McpServerDetail server={selectedServer} onDeleted={() => setSelectedId(null)} />
          </div>
        )}
      </div>

      <AddMcpServerDialog
        open={showAddDialog}
        onClose={() => setShowAddDialog(false)}
        onAdd={handleAdd}
      />
    </div>
  );
}
