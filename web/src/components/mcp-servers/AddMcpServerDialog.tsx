import { useState } from 'react';
import { Loader2, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface AddMcpServerDialogProps {
  open: boolean;
  onClose: () => void;
  onAdd: (server: {
    id: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    type?: 'http' | 'sse';
    url?: string;
    headers?: Record<string, string>;
    description?: string;
  }) => Promise<void>;
}

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

type ServerType = 'stdio' | 'http' | 'sse';

export function AddMcpServerDialog({ open, onClose, onAdd }: AddMcpServerDialogProps) {
  const [id, setId] = useState('');
  const [serverType, setServerType] = useState<ServerType>('stdio');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState<string[]>([]);
  const [env, setEnv] = useState<Array<{ key: string; value: string }>>([]);
  const [url, setUrl] = useState('');
  const [headers, setHeaders] = useState<Array<{ key: string; value: string }>>([]);
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setId('');
    setServerType('stdio');
    setCommand('');
    setArgs([]);
    setEnv([]);
    setUrl('');
    setHeaders([]);
    setDescription('');
  };

  const handleClose = () => {
    if (!submitting) {
      reset();
      onClose();
    }
  };

  const isHttpType = serverType === 'http' || serverType === 'sse';

  const validate = (): string | null => {
    if (!id.trim()) return 'ID 不能为空';
    if (!ID_PATTERN.test(id.trim())) return 'ID 只能包含字母、数字、短横线和下划线，且不能以符号开头';
    if (id.trim().toLowerCase() === 'happyclaw') return 'ID 不能为 happyclaw（系统保留）';
    if (isHttpType) {
      if (!url.trim()) return 'URL 不能为空';
    } else {
      if (!command.trim()) return '命令不能为空';
    }
    return null;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const validationError = validate();
    if (validationError) {
      toast.error(validationError);
      return;
    }

    setSubmitting(true);

    try {
      if (isHttpType) {
        const headersObj: Record<string, string> = {};
        for (const row of headers) {
          const k = row.key.trim();
          if (k) headersObj[k] = row.value;
        }
        await onAdd({
          id: id.trim(),
          type: serverType as 'http' | 'sse',
          url: url.trim(),
          headers: Object.keys(headersObj).length > 0 ? headersObj : undefined,
          description: description.trim() || undefined,
        });
      } else {
        const envObj: Record<string, string> = {};
        for (const row of env) {
          const k = row.key.trim();
          if (k) envObj[k] = row.value;
        }
        await onAdd({
          id: id.trim(),
          command: command.trim(),
          args: args.length > 0 ? args : undefined,
          env: Object.keys(envObj).length > 0 ? envObj : undefined,
          description: description.trim() || undefined,
        });
      }
      reset();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '添加失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && handleClose()}>
      <DialogContent className="sm:max-w-lg max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>添加 MCP 服务器</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {/* ID */}
          <div>
            <Label htmlFor="mcp-id" className="mb-1">
              服务器 ID <span className="text-error">*</span>
            </Label>
            <Input
              id="mcp-id"
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="my-mcp-server"
              disabled={submitting}
            />
            <p className="mt-1 text-xs text-muted-foreground">
              唯一标识符，只能包含字母、数字、短横线和下划线
            </p>
          </div>

          {/* Type selector */}
          <div>
            <Label className="mb-1">类型</Label>
            <div className="flex gap-2">
              {(['stdio', 'http', 'sse'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  disabled={submitting}
                  onClick={() => setServerType(t)}
                  className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                    serverType === t
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground hover:bg-muted/80'
                  } disabled:opacity-50`}
                >
                  {t.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          {isHttpType ? (
            <>
              {/* URL */}
              <div>
                <Label htmlFor="mcp-url" className="mb-1">
                  URL <span className="text-error">*</span>
                </Label>
                <Input
                  id="mcp-url"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="https://mcp.example.com"
                  disabled={submitting}
                  className="font-mono"
                />
              </div>

              {/* Headers */}
              <div>
                <Label className="mb-1">Headers</Label>
                <div className="space-y-2">
                  {headers.map((row, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Input
                        value={row.key}
                        onChange={(e) => {
                          const next = [...headers];
                          next[i] = { ...next[i], key: e.target.value };
                          setHeaders(next);
                        }}
                        placeholder="Authorization"
                        disabled={submitting}
                        className="w-2/5 font-mono text-sm"
                      />
                      <Input
                        value={row.value}
                        onChange={(e) => {
                          const next = [...headers];
                          next[i] = { ...next[i], value: e.target.value };
                          setHeaders(next);
                        }}
                        placeholder="Bearer token..."
                        disabled={submitting}
                        className="flex-1 font-mono text-sm"
                      />
                      <button
                        type="button"
                        onClick={() => setHeaders(headers.filter((_, j) => j !== i))}
                        disabled={submitting}
                        className="p-1.5 text-muted-foreground hover:text-error transition-colors disabled:opacity-50"
                      >
                        <X size={16} />
                      </button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setHeaders([...headers, { key: '', value: '' }])}
                    disabled={submitting}
                  >
                    <Plus size={14} />
                    添加 Header
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <>
              {/* Command */}
              <div>
                <Label htmlFor="mcp-command" className="mb-1">
                  命令 <span className="text-error">*</span>
                </Label>
                <Input
                  id="mcp-command"
                  value={command}
                  onChange={(e) => setCommand(e.target.value)}
                  placeholder="npx, uvx, node..."
                  disabled={submitting}
                  className="font-mono"
                />
              </div>

              {/* Args */}
              <div>
                <Label className="mb-1">参数</Label>
                <div className="space-y-2">
                  {args.map((arg, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Input
                        value={arg}
                        onChange={(e) => {
                          const next = [...args];
                          next[i] = e.target.value;
                          setArgs(next);
                        }}
                        placeholder={`参数 ${i + 1}`}
                        disabled={submitting}
                        className="flex-1 font-mono text-sm"
                      />
                      <button
                        type="button"
                        onClick={() => setArgs(args.filter((_, j) => j !== i))}
                        disabled={submitting}
                        className="p-1.5 text-muted-foreground hover:text-error transition-colors disabled:opacity-50"
                      >
                        <X size={16} />
                      </button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setArgs([...args, ''])}
                    disabled={submitting}
                  >
                    <Plus size={14} />
                    添加参数
                  </Button>
                </div>
              </div>

              {/* Env */}
              <div>
                <Label className="mb-1">环境变量</Label>
                <div className="space-y-2">
                  {env.map((row, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <Input
                        value={row.key}
                        onChange={(e) => {
                          const next = [...env];
                          next[i] = { ...next[i], key: e.target.value };
                          setEnv(next);
                        }}
                        placeholder="KEY"
                        disabled={submitting}
                        className="w-2/5 font-mono text-sm"
                      />
                      <Input
                        value={row.value}
                        onChange={(e) => {
                          const next = [...env];
                          next[i] = { ...next[i], value: e.target.value };
                          setEnv(next);
                        }}
                        placeholder="value"
                        disabled={submitting}
                        className="flex-1 font-mono text-sm"
                      />
                      <button
                        type="button"
                        onClick={() => setEnv(env.filter((_, j) => j !== i))}
                        disabled={submitting}
                        className="p-1.5 text-muted-foreground hover:text-error transition-colors disabled:opacity-50"
                      >
                        <X size={16} />
                      </button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setEnv([...env, { key: '', value: '' }])}
                    disabled={submitting}
                  >
                    <Plus size={14} />
                    添加环境变量
                  </Button>
                </div>
              </div>
            </>
          )}

          {/* Description */}
          <div>
            <Label htmlFor="mcp-desc" className="mb-1">
              描述
            </Label>
            <Input
              id="mcp-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="可选的描述信息"
              disabled={submitting}
            />
          </div>

          {/* Actions */}
          <div className="flex items-center justify-end gap-3 pt-2">
            <Button type="button" variant="ghost" onClick={handleClose} disabled={submitting}>
              取消
            </Button>
            <Button type="submit" disabled={submitting || !id.trim() || (isHttpType ? !url.trim() : !command.trim())}>
              {submitting && <Loader2 className="size-4 animate-spin" />}
              添加
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
