import { useState } from 'react';
import { Loader2, Plus, X } from 'lucide-react';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { IconButton } from '@/components/common/IconButton';
import { SegmentedControl } from '@/components/common/SegmentedControl';
import { Callout, ChoiceCard } from '@/components/capabilities/capability-ui';
import type { McpServerCreate } from '../../stores/mcp-servers';
import type { McpServerSource } from '../../utils/mcp-servers';

interface AddMcpServerDialogProps {
  open: boolean;
  isAdmin: boolean;
  onClose: () => void;
  onAdd: (server: McpServerCreate) => Promise<void>;
}

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

type ServerType = 'stdio' | 'http' | 'sse';

export function AddMcpServerDialog({
  open,
  isAdmin,
  onClose,
  onAdd,
}: AddMcpServerDialogProps) {
  const [id, setId] = useState('');
  const [scope, setScope] = useState<McpServerSource>('user');
  const [memberAccess, setMemberAccess] = useState<'admin_only' | 'shared'>(
    'admin_only',
  );
  const [serverType, setServerType] = useState<ServerType>('stdio');
  const [command, setCommand] = useState('');
  const [args, setArgs] = useState<string[]>([]);
  const [env, setEnv] = useState<Array<{ key: string; value: string }>>([]);
  const [url, setUrl] = useState('');
  const [headers, setHeaders] = useState<Array<{ key: string; value: string }>>(
    [],
  );
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const reset = () => {
    setId('');
    setScope('user');
    setMemberAccess('admin_only');
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
    if (!ID_PATTERN.test(id.trim()))
      return 'ID 只能包含字母、数字、短横线和下划线，且不能以符号开头';
    if (id.trim().toLowerCase() === 'happyclaw')
      return 'ID 不能为 happyclaw（系统保留）';
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
          scope,
          ...(scope === 'system' ? { memberAccess } : {}),
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
          scope,
          ...(scope === 'system' ? { memberAccess } : {}),
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
      <DialogContent className="max-h-[80vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>添加 MCP 服务器</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {isAdmin && (
            <div>
              <Label className="mb-1.5">归属范围</Label>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    ['user', '我的 MCP', '仅你和你的智能体可用'],
                    ['system', '系统 MCP', '所有用户可见，管理员维护'],
                  ] as const
                ).map(([value, title, description]) => (
                  <ChoiceCard
                    key={value}
                    disabled={submitting}
                    selected={scope === value}
                    onSelect={() => setScope(value)}
                    title={title}
                    description={description}
                  />
                ))}
              </div>
            </div>
          )}

          {isAdmin && scope === 'system' && (
            <div>
              <Label className="mb-1.5">成员访问</Label>
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    ['admin_only', '仅管理员', '普通成员的智能体不可使用'],
                    ['shared', '共享给成员', '允许普通成员的智能体使用'],
                  ] as const
                ).map(([value, title, description]) => (
                  <ChoiceCard
                    key={value}
                    disabled={submitting}
                    selected={memberAccess === value}
                    onSelect={() => setMemberAccess(value)}
                    title={title}
                    description={description}
                  />
                ))}
              </div>
              {memberAccess === 'shared' && (
                <Callout tone="warning" className="mt-2">
                  共享会把完整 command、args、url、env 和 headers
                  配置交给普通成员的智能体
                  运行。请确认其中所有凭据都允许成员使用。
                </Callout>
              )}
            </div>
          )}

          {/* ID */}
          <div>
            <Label htmlFor="mcp-id" className="mb-1.5">
              服务器 ID <span className="text-error">*</span>
            </Label>
            <Input
              id="mcp-id"
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="my-mcp-server"
              disabled={submitting}
            />
            <p className="mt-1.5 text-caption text-muted-foreground">
              唯一标识符，只能包含字母、数字、短横线和下划线
            </p>
          </div>

          {/* Type selector */}
          <div>
            <Label className="mb-1.5">类型</Label>
            <SegmentedControl
              label="类型"
              value={serverType}
              onChange={(next) => {
                if (!submitting) setServerType(next);
              }}
              options={(['stdio', 'http', 'sse'] as const).map((t) => ({
                value: t,
                label: t.toUpperCase(),
              }))}
            />
          </div>

          {isHttpType ? (
            <>
              {/* URL */}
              <div>
                <Label htmlFor="mcp-url" className="mb-1.5">
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
                <Label className="mb-1.5">Headers</Label>
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
                        className="w-2/5 font-mono"
                      />
                      <Input
                        type="password"
                        value={row.value}
                        onChange={(e) => {
                          const next = [...headers];
                          next[i] = { ...next[i], value: e.target.value };
                          setHeaders(next);
                        }}
                        placeholder="Bearer token..."
                        disabled={submitting}
                        className="flex-1 font-mono"
                      />
                      <IconButton
                        label="移除 Header"
                        icon={<X />}
                        onClick={() =>
                          setHeaders(headers.filter((_, j) => j !== i))
                        }
                        disabled={submitting}
                        className="text-muted-foreground hover:text-error"
                      />
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setHeaders([...headers, { key: '', value: '' }])
                    }
                    disabled={submitting}
                  >
                    <Plus />
                    添加 Header
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <>
              {/* Command */}
              <div>
                <Label htmlFor="mcp-command" className="mb-1.5">
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
                <Label className="mb-1.5">参数</Label>
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
                        className="flex-1 font-mono"
                      />
                      <IconButton
                        label="移除参数"
                        icon={<X />}
                        onClick={() => setArgs(args.filter((_, j) => j !== i))}
                        disabled={submitting}
                        className="text-muted-foreground hover:text-error"
                      />
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setArgs([...args, ''])}
                    disabled={submitting}
                  >
                    <Plus />
                    添加参数
                  </Button>
                </div>
              </div>

              {/* Env */}
              <div>
                <Label className="mb-1.5">环境变量</Label>
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
                        className="w-2/5 font-mono"
                      />
                      <Input
                        type="password"
                        value={row.value}
                        onChange={(e) => {
                          const next = [...env];
                          next[i] = { ...next[i], value: e.target.value };
                          setEnv(next);
                        }}
                        placeholder="value"
                        disabled={submitting}
                        className="flex-1 font-mono"
                      />
                      <IconButton
                        label="移除环境变量"
                        icon={<X />}
                        onClick={() => setEnv(env.filter((_, j) => j !== i))}
                        disabled={submitting}
                        className="text-muted-foreground hover:text-error"
                      />
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setEnv([...env, { key: '', value: '' }])}
                    disabled={submitting}
                  >
                    <Plus />
                    添加环境变量
                  </Button>
                </div>
              </div>
            </>
          )}

          {/* Description */}
          <div>
            <Label htmlFor="mcp-desc" className="mb-1.5">
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
            <Button
              type="button"
              variant="ghost"
              onClick={handleClose}
              disabled={submitting}
            >
              取消
            </Button>
            <Button
              type="submit"
              disabled={
                submitting ||
                !id.trim() ||
                (isHttpType ? !url.trim() : !command.trim())
              }
            >
              {submitting && <Loader2 className="size-4 animate-spin" />}
              添加
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
