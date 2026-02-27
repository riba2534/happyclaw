import { useState } from 'react';
import { Download, Eye, EyeOff, Pencil, Save, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { McpServer } from '../../stores/mcp-servers';
import { useMcpServersStore } from '../../stores/mcp-servers';

interface McpServerDetailProps {
  server: McpServer | null;
  onDeleted?: () => void;
}

export function McpServerDetail({ server, onDeleted }: McpServerDetailProps) {
  const updateServer = useMcpServersStore((s) => s.updateServer);
  const deleteServer = useMcpServersStore((s) => s.deleteServer);

  const [deleting, setDeleting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [showEnvValues, setShowEnvValues] = useState<Record<string, boolean>>({});

  // Edit form state
  const [editCommand, setEditCommand] = useState('');
  const [editArgs, setEditArgs] = useState<string[]>([]);
  const [editEnv, setEditEnv] = useState<Array<{ key: string; value: string }>>([]);
  const [editDescription, setEditDescription] = useState('');
  const [saving, setSaving] = useState(false);

  if (!server) {
    return (
      <div className="bg-white rounded-xl border border-slate-200 p-12 flex items-center justify-center">
        <p className="text-slate-400 text-center">选择一个 MCP 服务器查看详情</p>
      </div>
    );
  }

  const startEdit = () => {
    setEditCommand(server.command);
    setEditArgs(server.args ? [...server.args] : []);
    setEditEnv(
      server.env
        ? Object.entries(server.env).map(([key, value]) => ({ key, value }))
        : [],
    );
    setEditDescription(server.description || '');
    setEditing(true);
  };

  const cancelEdit = () => {
    setEditing(false);
  };

  const saveEdit = async () => {
    setSaving(true);
    try {
      const envObj: Record<string, string> = {};
      for (const row of editEnv) {
        const k = row.key.trim();
        if (k) envObj[k] = row.value;
      }
      await updateServer(server.id, {
        command: editCommand,
        args: editArgs.length > 0 ? editArgs : undefined,
        env: Object.keys(envObj).length > 0 ? envObj : undefined,
        description: editDescription || undefined,
      });
      setEditing(false);
    } catch {
      // error handled by store
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!confirm(`确认删除 MCP 服务器「${server.id}」？`)) return;
    setDeleting(true);
    try {
      await deleteServer(server.id);
      onDeleted?.();
    } catch {
      // error handled by store
    } finally {
      setDeleting(false);
    }
  };

  const toggleEnvVisibility = (key: string) => {
    setShowEnvValues((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const envEntries = server.env ? Object.entries(server.env) : [];

  return (
    <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
      {/* Header */}
      <div className="p-6 border-b border-slate-200">
        <div className="flex items-start justify-between gap-4 mb-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2">
              <h2 className="text-xl font-bold text-slate-900">{server.id}</h2>
              {server.syncedFromHost && (
                <span className="px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-700 inline-flex items-center gap-1">
                  <Download size={10} />
                  已同步
                </span>
              )}
              <span
                className={`px-2 py-0.5 rounded text-xs font-medium ${
                  server.enabled
                    ? 'bg-green-100 text-green-700'
                    : 'bg-slate-100 text-slate-500'
                }`}
              >
                {server.enabled ? '已启用' : '已禁用'}
              </span>
            </div>
            {server.description && (
              <p className="text-sm text-slate-600">{server.description}</p>
            )}
          </div>

          <div className="flex items-center gap-2">
            {!editing && (
              <button
                onClick={startEdit}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-slate-600 hover:bg-slate-50 transition-colors"
              >
                <Pencil size={16} />
                编辑
              </button>
            )}
            <button
              disabled={deleting}
              onClick={handleDelete}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-red-600 hover:bg-red-50 transition-colors disabled:opacity-50"
            >
              <Trash2 size={16} />
              {deleting ? '删除中...' : '删除'}
            </button>
          </div>
        </div>
      </div>

      {editing ? (
        /* Edit Form */
        <div className="p-6 space-y-4">
          {/* Command */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">命令</label>
            <Input
              value={editCommand}
              onChange={(e) => setEditCommand(e.target.value)}
              placeholder="npx, uvx, node..."
            />
          </div>

          {/* Args */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">参数</label>
            <div className="space-y-2">
              {editArgs.map((arg, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    value={arg}
                    onChange={(e) => {
                      const next = [...editArgs];
                      next[i] = e.target.value;
                      setEditArgs(next);
                    }}
                    className="flex-1 font-mono text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => setEditArgs(editArgs.filter((_, j) => j !== i))}
                    className="p-1.5 text-slate-400 hover:text-red-500 transition-colors"
                  >
                    <X size={16} />
                  </button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setEditArgs([...editArgs, ''])}
              >
                添加参数
              </Button>
            </div>
          </div>

          {/* Env */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">环境变量</label>
            <div className="space-y-2">
              {editEnv.map((row, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    value={row.key}
                    onChange={(e) => {
                      const next = [...editEnv];
                      next[i] = { ...next[i], key: e.target.value };
                      setEditEnv(next);
                    }}
                    placeholder="KEY"
                    className="w-1/3 font-mono text-sm"
                  />
                  <Input
                    value={row.value}
                    onChange={(e) => {
                      const next = [...editEnv];
                      next[i] = { ...next[i], value: e.target.value };
                      setEditEnv(next);
                    }}
                    placeholder="value"
                    className="flex-1 font-mono text-sm"
                  />
                  <button
                    type="button"
                    onClick={() => setEditEnv(editEnv.filter((_, j) => j !== i))}
                    className="p-1.5 text-slate-400 hover:text-red-500 transition-colors"
                  >
                    <X size={16} />
                  </button>
                </div>
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setEditEnv([...editEnv, { key: '', value: '' }])}
              >
                添加环境变量
              </Button>
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">描述</label>
            <Input
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              placeholder="可选的描述信息"
            />
          </div>

          {/* Actions */}
          <div className="flex items-center gap-3 pt-2">
            <Button onClick={saveEdit} disabled={saving || !editCommand.trim()}>
              <Save size={16} />
              {saving ? '保存中...' : '保存'}
            </Button>
            <Button variant="ghost" onClick={cancelEdit} disabled={saving}>
              取消
            </Button>
          </div>
        </div>
      ) : (
        /* Read-only View */
        <>
          <div className="p-6 border-b border-slate-200 space-y-4">
            {/* Command */}
            <div>
              <span className="text-sm text-slate-500">命令</span>
              <p className="font-mono text-sm text-slate-900 mt-1 bg-slate-50 rounded px-3 py-2">
                {server.command}
              </p>
            </div>

            {/* Args */}
            {server.args && server.args.length > 0 && (
              <div>
                <span className="text-sm text-slate-500">参数</span>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {server.args.map((arg, i) => (
                    <span
                      key={i}
                      className="px-2 py-1 bg-slate-100 text-slate-700 rounded text-xs font-mono"
                    >
                      {arg}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {/* Env */}
            {envEntries.length > 0 && (
              <div>
                <span className="text-sm text-slate-500">环境变量</span>
                <div className="space-y-1.5 mt-1">
                  {envEntries.map(([key, value]) => (
                    <div
                      key={key}
                      className="flex items-center gap-2 bg-slate-50 rounded px-3 py-2"
                    >
                      <span className="font-mono text-xs text-slate-700 font-medium">{key}</span>
                      <span className="text-slate-300">=</span>
                      <span className="font-mono text-xs text-slate-600 flex-1 truncate">
                        {showEnvValues[key] ? value : '••••••••'}
                      </span>
                      <button
                        type="button"
                        onClick={() => toggleEnvVisibility(key)}
                        className="p-1 text-slate-400 hover:text-slate-600 transition-colors"
                      >
                        {showEnvValues[key] ? <EyeOff size={14} /> : <Eye size={14} />}
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Added at */}
            <div className="text-xs text-slate-400">
              添加时间：{new Date(server.addedAt).toLocaleString()}
            </div>
          </div>

          {/* Footer */}
          <div className="p-6 bg-slate-50">
            <p className="text-sm text-slate-500">
              {server.syncedFromHost
                ? '从宿主机同步的 MCP 服务器，可编辑、启停和删除。重新同步时会恢复'
                : 'MCP 服务器配置会在容器启动时注入，修改后新启动的容器将使用新配置'}
            </p>
          </div>
        </>
      )}
    </div>
  );
}
