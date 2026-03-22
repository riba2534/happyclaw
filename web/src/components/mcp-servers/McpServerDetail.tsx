import { useState } from 'react';
import { Download, Eye, EyeOff, Pencil, Save, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
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
  const [editUrl, setEditUrl] = useState('');
  const [editHeaders, setEditHeaders] = useState<Array<{ key: string; value: string }>>([]);
  const [editDescription, setEditDescription] = useState('');
  const [saving, setSaving] = useState(false);

  if (!server) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <p className="text-muted-foreground text-center">选择一个 MCP 服务器查看详情</p>
        </CardContent>
      </Card>
    );
  }

  const isHttpType = server.type === 'http' || server.type === 'sse';

  const startEdit = () => {
    setEditCommand(server.command || '');
    setEditArgs(server.args ? [...server.args] : []);
    setEditEnv(
      server.env
        ? Object.entries(server.env).map(([key, value]) => ({ key, value }))
        : [],
    );
    setEditUrl(server.url || '');
    setEditHeaders(
      server.headers
        ? Object.entries(server.headers).map(([key, value]) => ({ key, value }))
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
      if (isHttpType) {
        const headersObj: Record<string, string> = {};
        for (const row of editHeaders) {
          const k = row.key.trim();
          if (k) headersObj[k] = row.value;
        }
        await updateServer(server.id, {
          url: editUrl,
          headers: Object.keys(headersObj).length > 0 ? headersObj : undefined,
          description: editDescription || undefined,
        });
      } else {
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
      }
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
  const headerEntries = server.headers ? Object.entries(server.headers) : [];

  return (
    <Card className="overflow-hidden">
      {/* Header */}
      <div className="p-6 border-b border-border">
        <div className="flex items-start justify-between gap-4 mb-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-2">
              <h2 className="text-xl font-bold text-foreground">{server.id}</h2>
              {server.syncedFromHost && (
                <span className="px-2 py-0.5 rounded text-xs font-medium bg-warning-bg text-warning inline-flex items-center gap-1">
                  <Download size={10} />
                  已同步
                </span>
              )}
              <span
                className={`px-2 py-0.5 rounded text-xs font-medium ${
                  server.enabled
                    ? 'bg-success-bg text-success'
                    : 'bg-muted text-muted-foreground'
                }`}
              >
                {server.enabled ? '已启用' : '已禁用'}
              </span>
            </div>
            {server.description && (
              <p className="text-sm text-muted-foreground">{server.description}</p>
            )}
          </div>

          <div className="flex items-center gap-2">
            {!editing && (
              <button
                onClick={startEdit}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-muted-foreground hover:bg-muted transition-colors"
              >
                <Pencil size={16} />
                编辑
              </button>
            )}
            <button
              disabled={deleting}
              onClick={handleDelete}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-error hover:bg-error-bg transition-colors disabled:opacity-50"
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
          {isHttpType ? (
            <>
              {/* URL */}
              <div>
                <Label className="mb-1">URL</Label>
                <Input
                  value={editUrl}
                  onChange={(e) => setEditUrl(e.target.value)}
                  placeholder="https://..."
                  className="font-mono"
                />
              </div>

              {/* Headers */}
              <div>
                <Label className="mb-1">Headers</Label>
                <div className="space-y-2">
                  {editHeaders.map((row, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Input
                        value={row.key}
                        onChange={(e) => {
                          const next = [...editHeaders];
                          next[i] = { ...next[i], key: e.target.value };
                          setEditHeaders(next);
                        }}
                        placeholder="Header-Name"
                        className="w-1/3 font-mono text-sm"
                      />
                      <Input
                        value={row.value}
                        onChange={(e) => {
                          const next = [...editHeaders];
                          next[i] = { ...next[i], value: e.target.value };
                          setEditHeaders(next);
                        }}
                        placeholder="value"
                        className="flex-1 font-mono text-sm"
                      />
                      <button
                        type="button"
                        onClick={() => setEditHeaders(editHeaders.filter((_, j) => j !== i))}
                        className="p-1.5 text-muted-foreground hover:text-error transition-colors"
                      >
                        <X size={16} />
                      </button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setEditHeaders([...editHeaders, { key: '', value: '' }])}
                  >
                    添加 Header
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <>
              {/* Command */}
              <div>
                <Label className="mb-1">命令</Label>
                <Input
                  value={editCommand}
                  onChange={(e) => setEditCommand(e.target.value)}
                  placeholder="npx, uvx, node..."
                />
              </div>

              {/* Args */}
              <div>
                <Label className="mb-1">参数</Label>
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
                        className="p-1.5 text-muted-foreground hover:text-error transition-colors"
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
                <Label className="mb-1">环境变量</Label>
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
                        className="p-1.5 text-muted-foreground hover:text-error transition-colors"
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
            </>
          )}

          {/* Description */}
          <div>
            <Label className="mb-1">描述</Label>
            <Input
              value={editDescription}
              onChange={(e) => setEditDescription(e.target.value)}
              placeholder="可选的描述信息"
            />
          </div>

          {/* Actions */}
          <div className="flex items-center gap-3 pt-2">
            <Button onClick={saveEdit} disabled={saving || (isHttpType ? !editUrl.trim() : !editCommand.trim())}>
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
          <div className="p-6 border-b border-border space-y-4">
            {isHttpType ? (
              <>
                {/* Type */}
                <div>
                  <span className="text-sm text-muted-foreground">类型</span>
                  <p className="font-mono text-sm text-foreground mt-1 bg-blue-50 dark:bg-blue-950 rounded px-3 py-2">
                    {server.type?.toUpperCase()}
                  </p>
                </div>

                {/* URL */}
                <div>
                  <span className="text-sm text-muted-foreground">URL</span>
                  <p className="font-mono text-sm text-foreground mt-1 bg-muted rounded px-3 py-2 break-all">
                    {server.url}
                  </p>
                </div>

                {/* Headers */}
                {headerEntries.length > 0 && (
                  <div>
                    <span className="text-sm text-muted-foreground">Headers</span>
                    <div className="space-y-1.5 mt-1">
                      {headerEntries.map(([key, value]) => (
                        <div
                          key={key}
                          className="flex items-center gap-2 bg-muted rounded px-3 py-2"
                        >
                          <span className="font-mono text-xs text-foreground font-medium">{key}</span>
                          <span className="text-muted-foreground/50">:</span>
                          <span className="font-mono text-xs text-muted-foreground flex-1 truncate">
                            {showEnvValues[key] ? value : '••••••••'}
                          </span>
                          <button
                            type="button"
                            onClick={() => toggleEnvVisibility(key)}
                            className="p-1 text-muted-foreground hover:text-foreground transition-colors"
                          >
                            {showEnvValues[key] ? <EyeOff size={14} /> : <Eye size={14} />}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <>
                {/* Command */}
                <div>
                  <span className="text-sm text-muted-foreground">命令</span>
                  <p className="font-mono text-sm text-foreground mt-1 bg-muted rounded px-3 py-2">
                    {server.command}
                  </p>
                </div>

                {/* Args */}
                {server.args && server.args.length > 0 && (
                  <div>
                    <span className="text-sm text-muted-foreground">参数</span>
                    <div className="flex flex-wrap gap-1.5 mt-1">
                      {server.args.map((arg, i) => (
                        <span
                          key={i}
                          className="px-2 py-1 bg-muted text-foreground rounded text-xs font-mono"
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
                    <span className="text-sm text-muted-foreground">环境变量</span>
                    <div className="space-y-1.5 mt-1">
                      {envEntries.map(([key, value]) => (
                        <div
                          key={key}
                          className="flex items-center gap-2 bg-muted rounded px-3 py-2"
                        >
                          <span className="font-mono text-xs text-foreground font-medium">{key}</span>
                          <span className="text-muted-foreground/50">=</span>
                          <span className="font-mono text-xs text-muted-foreground flex-1 truncate">
                            {showEnvValues[key] ? value : '••••••••'}
                          </span>
                          <button
                            type="button"
                            onClick={() => toggleEnvVisibility(key)}
                            className="p-1 text-muted-foreground hover:text-foreground transition-colors"
                          >
                            {showEnvValues[key] ? <EyeOff size={14} /> : <Eye size={14} />}
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}

            {/* Added at */}
            <div className="text-xs text-muted-foreground">
              添加时间：{new Date(server.addedAt).toLocaleString()}
            </div>
          </div>

          {/* Footer */}
          <div className="p-6 bg-muted">
            <p className="text-sm text-muted-foreground">
              {server.syncedFromHost
                ? '从宿主机同步的 MCP 服务器，可编辑、启停和删除。重新同步时会恢复'
                : 'MCP 服务器配置会在容器启动时注入，修改后新启动的容器将使用新配置'}
            </p>
          </div>
        </>
      )}
    </Card>
  );
}
