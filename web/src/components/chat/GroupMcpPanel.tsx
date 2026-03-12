import { useEffect, useState } from 'react';
import { Loader2, Save, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api } from '../../api/client';
import { useMcpServersStore } from '../../stores/mcp-servers';

interface GroupMcpPanelProps {
  groupJid: string;
}

export function GroupMcpPanel({ groupJid }: GroupMcpPanelProps) {
  const [mcpMode, setMcpMode] = useState<'inherit' | 'custom'>('inherit');
  const [selectedMcps, setSelectedMcps] = useState<Set<string> | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mcpServers = useMcpServersStore(s => s.servers);
  const loadMcpServers = useMcpServersStore(s => s.loadServers);
  const enabledMcpServers = mcpServers.filter(s => s.enabled);

  // 加载 MCP servers 和 group MCP 配置
  useEffect(() => {
    setLoading(true);
    Promise.all([
      loadMcpServers(),
      api.get<{ mcp_mode: 'inherit' | 'custom'; selected_mcps: string[] | null }>(
        `/api/groups/${encodeURIComponent(groupJid)}/mcp`,
      ).catch(() => ({ mcp_mode: 'inherit' as const, selected_mcps: null })),
    ]).then(([, mcpConfig]) => {
      setMcpMode(mcpConfig.mcp_mode);
      setSelectedMcps(mcpConfig.selected_mcps ? new Set(mcpConfig.selected_mcps) : null);
    }).finally(() => setLoading(false));
  }, [groupJid]);

  const handleModeChange = (mode: 'inherit' | 'custom') => {
    setMcpMode(mode);
    setDirty(true);
    if (mode === 'inherit') {
      setSelectedMcps(null);
    } else {
      setSelectedMcps(new Set(enabledMcpServers.map(s => s.id)));
    }
  };

  const toggleMcp = (id: string) => {
    setDirty(true);
    if (selectedMcps === null) {
      const newSet = new Set(enabledMcpServers.map(s => s.id));
      newSet.delete(id);
      setSelectedMcps(newSet);
    } else {
      const newSet = new Set(selectedMcps);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      if (newSet.size === enabledMcpServers.length && enabledMcpServers.every(s => newSet.has(s.id))) {
        setSelectedMcps(null);
      } else {
        setSelectedMcps(newSet);
      }
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    try {
      const payload = mcpMode === 'inherit' ? null : (selectedMcps === null ? null : Array.from(selectedMcps));
      await api.put(`/api/groups/${encodeURIComponent(groupJid)}/mcp`, {
        mcp_mode: mcpMode,
        selected_mcps: payload,
      });
      setDirty(false);
    } catch {
      setError('保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleStop = async () => {
    setStopping(true);
    setError(null);
    try {
      await api.post(`/api/groups/${encodeURIComponent(groupJid)}/stop`, {});
    } catch {
      setError('停止失败');
    } finally {
      setStopping(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-32">
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* 模式选择 */}
      <div className="px-4 py-3 border-b border-border">
        <div className="flex gap-2">
          <button
            onClick={() => handleModeChange('inherit')}
            className={`flex-1 text-xs px-2 py-1.5 rounded border transition-colors ${
              mcpMode === 'inherit'
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border bg-background text-muted-foreground hover:bg-accent'
            }`}
          >
            继承全局
          </button>
          <button
            onClick={() => handleModeChange('custom')}
            className={`flex-1 text-xs px-2 py-1.5 rounded border transition-colors ${
              mcpMode === 'custom'
                ? 'border-primary bg-primary/10 text-primary'
                : 'border-border bg-background text-muted-foreground hover:bg-accent'
            }`}
          >
            自定义
          </button>
        </div>
        {mcpMode === 'inherit' && (
          <p className="text-[11px] text-muted-foreground mt-2">
            使用全局 MCP 配置
          </p>
        )}
      </div>

      {/* MCP 列表（仅自定义模式） */}
      {mcpMode === 'custom' && (
        <div className="flex-1 overflow-y-auto">
          {enabledMcpServers.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              暂无已启用的 MCP 服务器
            </div>
          ) : (
            <div className="divide-y divide-border">
              {enabledMcpServers.map(mcp => (
                <label
                  key={mcp.id}
                  className="flex items-center gap-3 px-4 py-2.5 hover:bg-accent/50 cursor-pointer transition-colors"
                >
                  <input
                    type="checkbox"
                    checked={selectedMcps === null || selectedMcps.has(mcp.id)}
                    onChange={() => toggleMcp(mcp.id)}
                    className="rounded border-gray-300 text-primary focus:ring-primary"
                  />
                  <div className="flex-1 min-w-0">
                    <span className="text-sm font-medium truncate block">{mcp.id}</span>
                    {mcp.description && (
                      <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{mcp.description}</p>
                    )}
                  </div>
                </label>
              ))}
            </div>
          )}
        </div>
      )}

      {mcpMode === 'inherit' && <div className="flex-1" />}

      {/* 底部操作栏 */}
      <div className="px-4 py-2 border-t border-border space-y-2">
        {error && (
          <p className="text-[11px] text-destructive">{error}</p>
        )}
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!dirty || saving}
            onClick={handleSave}
            className="h-7 text-xs flex-1"
          >
            {saving ? <Loader2 className="w-3 h-3 animate-spin mr-1" /> : <Save className="w-3 h-3 mr-1" />}
            保存
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={stopping}
            onClick={handleStop}
            title="停止容器（下次发消息时自动重启）"
            className="h-7 text-xs"
          >
            {stopping ? <Loader2 className="w-3 h-3 animate-spin" /> : <Square className="w-3 h-3" />}
          </Button>
        </div>
        <p className="text-[11px] text-muted-foreground">
          更改将在下次容器启动时生效
        </p>
      </div>
    </div>
  );
}
