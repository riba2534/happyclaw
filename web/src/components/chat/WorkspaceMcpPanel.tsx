import { useEffect, useState } from 'react';
import { Loader2, Plus, Server, ToggleLeft, ToggleRight, Trash2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { EmptyState } from '@/components/common/EmptyState';
import { useWorkspaceConfigStore, type WorkspaceMcpServer } from '../../stores/workspace-config';
import { ConfirmDialog } from '@/components/common/ConfirmDialog';

interface WorkspaceMcpPanelProps {
  groupJid: string;
  onClose?: () => void;
}

export function WorkspaceMcpPanel({ groupJid, onClose: _onClose }: WorkspaceMcpPanelProps) {
  const {
    mcpServers,
    mcpLoading,
    mcpError,
    loadWorkspaceMcp,
    addWorkspaceMcp,
    toggleWorkspaceMcp,
    deleteWorkspaceMcp,
  } = useWorkspaceConfigStore();

  const [showAdd, setShowAdd] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  // Add form state
  const [newId, setNewId] = useState('');
  const [newType, setNewType] = useState<'stdio' | 'http'>('stdio');
  const [newCommand, setNewCommand] = useState('');
  const [newArgs, setNewArgs] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [adding, setAdding] = useState(false);

  useEffect(() => {
    loadWorkspaceMcp(groupJid);
  }, [groupJid, loadWorkspaceMcp]);

  const resetForm = () => {
    setNewId('');
    setNewCommand('');
    setNewArgs('');
    setNewUrl('');
    setNewDesc('');
    setNewType('stdio');
  };

  const handleAdd = async () => {
    if (!newId.trim()) return;
    setAdding(true);
    try {
      if (newType === 'http') {
        await addWorkspaceMcp(groupJid, {
          id: newId.trim(),
          type: 'sse',
          url: newUrl.trim(),
          description: newDesc.trim() || undefined,
        });
      } else {
        await addWorkspaceMcp(groupJid, {
          id: newId.trim(),
          command: newCommand.trim(),
          args: newArgs.trim() ? newArgs.trim().split(/\s+/) : undefined,
          description: newDesc.trim() || undefined,
        });
      }
      resetForm();
      setShowAdd(false);
    } catch {
      // error in store
    } finally {
      setAdding(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteWorkspaceMcp(groupJid, deleteTarget);
    } catch {
      // error in store
    }
    setDeleteTarget(null);
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-border flex-shrink-0">
        <h3 className="text-sm font-medium text-foreground">工作区 MCP</h3>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => loadWorkspaceMcp(groupJid)}
            disabled={mcpLoading}
            className="h-7 w-7 p-0"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${mcpLoading ? 'animate-spin' : ''}`} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setShowAdd(!showAdd)}
            className="h-7 w-7 p-0"
          >
            <Plus className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {/* Add form */}
      {showAdd && (
        <div className="px-4 py-2 border-b border-border space-y-2 flex-shrink-0">
          <Input
            value={newId}
            onChange={(e) => setNewId(e.target.value)}
            placeholder="Server ID（如 my-server）"
            className="h-8 text-sm"
          />
          <div className="flex gap-2">
            <button
              onClick={() => setNewType('stdio')}
              className={`text-xs px-2 py-1 rounded cursor-pointer ${newType === 'stdio' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}
            >
              stdio
            </button>
            <button
              onClick={() => setNewType('http')}
              className={`text-xs px-2 py-1 rounded cursor-pointer ${newType === 'http' ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground'}`}
            >
              http/sse
            </button>
          </div>
          {newType === 'stdio' ? (
            <>
              <Input
                value={newCommand}
                onChange={(e) => setNewCommand(e.target.value)}
                placeholder="command（如 npx）"
                className="h-8 text-sm"
              />
              <Input
                value={newArgs}
                onChange={(e) => setNewArgs(e.target.value)}
                placeholder="args（空格分隔）"
                className="h-8 text-sm"
              />
            </>
          ) : (
            <Input
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              placeholder="URL（如 http://localhost:3001/sse）"
              className="h-8 text-sm"
            />
          )}
          <Input
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            placeholder="描述（可选）"
            className="h-8 text-sm"
          />
          <Button
            size="sm"
            onClick={handleAdd}
            disabled={adding || !newId.trim() || (newType === 'stdio' ? !newCommand.trim() : !newUrl.trim())}
            className="w-full h-8"
          >
            {adding ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : '添加'}
          </Button>
        </div>
      )}

      {/* Error */}
      {mcpError && (
        <div className="px-4 py-2 bg-destructive/10 text-destructive text-xs flex-shrink-0">
          {mcpError}
        </div>
      )}

      {/* List */}
      <div className="flex-1 overflow-y-auto">
        {mcpLoading && mcpServers.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        ) : mcpServers.length === 0 ? (
          <EmptyState
            icon={Server}
            title="无工作区 MCP Servers"
            description="当前工作区 .claude/settings.json 中没有 MCP 配置"
            action={
              <Button variant="outline" size="sm" onClick={() => setShowAdd(true)}>
                <Plus className="w-3.5 h-3.5 mr-1" />
                添加 MCP Server
              </Button>
            }
          />
        ) : (
          <div className="divide-y divide-border">
            {mcpServers.map((server) => (
              <McpRow
                key={server.id}
                server={server}
                onToggle={(enabled) => toggleWorkspaceMcp(groupJid, server.id, enabled)}
                onDelete={() => setDeleteTarget(server.id)}
              />
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="删除 MCP Server"
        message={`确定要从工作区删除 MCP Server "${deleteTarget}" 吗？`}
        confirmText="删除"
        confirmVariant="danger"
      />
    </div>
  );
}

function McpRow({
  server,
  onToggle,
  onDelete,
}: {
  server: WorkspaceMcpServer;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
}) {
  const isHttp = server.type === 'http' || server.type === 'sse';
  const subtitle = isHttp
    ? server.url || ''
    : server.command
      ? `${server.command}${server.args?.length ? ' ' + server.args.join(' ') : ''}`
      : '';

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 hover:bg-accent/50 transition-colors">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium text-foreground truncate">
            {server.id}
          </span>
          <span className="text-[10px] text-muted-foreground bg-muted px-1 py-px rounded">
            {isHttp ? server.type || 'http' : 'stdio'}
          </span>
          {!server.enabled && (
            <span className="text-[10px] text-muted-foreground bg-muted px-1 py-px rounded">
              已禁用
            </span>
          )}
        </div>
        {(server.description || subtitle) && (
          <p className="text-xs text-muted-foreground truncate mt-0.5">
            {server.description || subtitle}
          </p>
        )}
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        <button
          onClick={() => onToggle(!server.enabled)}
          className="p-1 rounded hover:bg-accent transition-colors cursor-pointer"
          title={server.enabled ? '禁用' : '启用'}
        >
          {server.enabled ? (
            <ToggleRight className="w-4 h-4 text-emerald-500" />
          ) : (
            <ToggleLeft className="w-4 h-4 text-muted-foreground" />
          )}
        </button>
        <button
          onClick={onDelete}
          className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-destructive transition-colors cursor-pointer"
          title="删除"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
