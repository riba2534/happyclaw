import { useEffect, useState } from 'react';
import {
  Download,
  Globe,
  KeyRound,
  Pencil,
  Plus,
  Save,
  Server,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EmptyState } from '@/components/common/EmptyState';
import { IconButton } from '@/components/common/IconButton';
import {
  Callout,
  CapabilityMedia,
  ChoiceCard,
  DetailPanel,
} from '@/components/capabilities/capability-ui';
import { confirmDialog } from '@/stores/confirm';
import { toast } from 'sonner';
import type { McpServer } from '../../stores/mcp-servers';
import { useMcpServersStore } from '../../stores/mcp-servers';
import {
  buildMcpSecretClear,
  buildMcpSecretReplacement,
  type McpSecretRow,
} from '../../utils/mcp-secrets';

interface McpServerDetailProps {
  server: McpServer | null;
  onDeleted?: () => void;
}

export function McpServerDetail({ server, onDeleted }: McpServerDetailProps) {
  const updateServer = useMcpServersStore((state) => state.updateServer);
  const deleteServer = useMcpServersStore((state) => state.deleteServer);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [editCommand, setEditCommand] = useState('');
  const [editArgs, setEditArgs] = useState<string[]>([]);
  const [editUrl, setEditUrl] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editMemberAccess, setEditMemberAccess] = useState<
    'admin_only' | 'shared'
  >('admin_only');
  const [secretRows, setSecretRows] = useState<McpSecretRow[] | null>(null);

  useEffect(() => {
    setEditing(false);
    setSecretRows(null);
  }, [server?.sourceKey]);

  if (!server) {
    return (
      <DetailPanel>
        <EmptyState icon={Server} title="选择一个 MCP 服务器查看详情" />
      </DetailPanel>
    );
  }

  const isHttp = server.type === 'http' || server.type === 'sse';
  const isImported = server.importedFromHost || server.syncedFromHost;
  const hasConflict = server.conflictSources.length > 1;
  const secretKeys = isHttp
    ? (server.headerKeys ?? [])
    : (server.envKeys ?? []);
  const hasHiddenSystemSecretKeys =
    server.source === 'system' &&
    server.readonly &&
    (isHttp ? server.hasHeaderSecrets : server.hasEnvSecrets);
  const secretLabel = isHttp ? '请求 Headers' : '环境变量';

  const startEdit = () => {
    setEditCommand(server.command ?? '');
    setEditArgs(server.args ? [...server.args] : []);
    setEditUrl(server.url ?? '');
    setEditDescription(server.description ?? '');
    setEditMemberAccess(server.memberAccess ?? 'admin_only');
    setSecretRows(null);
    setEditing(true);
  };

  const saveEdit = async () => {
    setSaving(true);
    try {
      const secretPatch = buildMcpSecretReplacement(
        isHttp ? 'headers' : 'env',
        secretRows,
      );
      await updateServer(
        server.sourceKey,
        isHttp
          ? {
              url: editUrl.trim(),
              description: editDescription.trim(),
              ...(server.source === 'system'
                ? { memberAccess: editMemberAccess }
                : {}),
              ...secretPatch,
            }
          : {
              command: editCommand.trim(),
              args: editArgs,
              description: editDescription.trim(),
              ...(server.source === 'system'
                ? { memberAccess: editMemberAccess }
                : {}),
              ...secretPatch,
            },
      );
      setEditing(false);
      setSecretRows(null);
      toast.success('MCP 配置已保存');
    } catch (error) {
      toast.error(errorMessage(error, '保存 MCP 配置失败'));
    } finally {
      setSaving(false);
    }
  };

  const clearSecrets = async () => {
    const confirmed = await confirmDialog({
      title: `清空${secretLabel}`,
      message: `清空这个 MCP 的全部${secretLabel}？此操作不能撤销。`,
      confirmText: '清空',
      variant: 'danger',
    });
    if (!confirmed) return;
    setSaving(true);
    try {
      await updateServer(
        server.sourceKey,
        buildMcpSecretClear(isHttp ? 'headers' : 'env'),
      );
      setSecretRows(null);
      toast.success(`${secretLabel}已清空`);
    } catch (error) {
      toast.error(errorMessage(error, `清空${secretLabel}失败`));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    const confirmed = await confirmDialog({
      title: '删除 MCP 服务器',
      message: `确认删除 MCP 服务器「${server.id}」？`,
      confirmText: '删除',
      variant: 'danger',
    });
    if (!confirmed) return;
    setDeleting(true);
    try {
      await deleteServer(server.sourceKey);
      onDeleted?.();
      toast.success('MCP 服务器已删除');
    } catch (error) {
      toast.error(errorMessage(error, '删除 MCP 服务器失败'));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <DetailPanel>
      <div className="px-5 py-4">
        <div className="flex items-start gap-3">
          <CapabilityMedia
            icon={isHttp ? Globe : Terminal}
            className="size-9"
          />
          <div className="flex min-h-9 min-w-0 flex-1 flex-wrap items-center gap-1.5">
            <h2 className="min-w-0 truncate text-title text-foreground">
              {server.id}
            </h2>
            <Badge variant="neutral">
              {server.source === 'system' ? '系统 MCP' : '我的 MCP'}
            </Badge>
            {isImported && (
              <Badge variant="neutral">
                <Download /> 宿主机副本
              </Badge>
            )}
            <Badge variant="outline" dot={server.enabled ? 'success' : 'muted'}>
              {server.enabled ? '已启用' : '已禁用'}
            </Badge>
          </div>
          <div className="flex shrink-0 gap-1">
            {!editing && !server.readonly && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={startEdit}
              >
                <Pencil />
                编辑
              </Button>
            )}
            {!server.readonly && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-error hover:bg-error/10 hover:text-error"
                disabled={deleting}
                onClick={() => void handleDelete()}
              >
                <Trash2 />
                {deleting ? '删除中…' : '删除'}
              </Button>
            )}
          </div>
        </div>
        {server.description && (
          <p className="mt-3 text-caption leading-5 text-muted-foreground">
            {server.description}
          </p>
        )}
        {server.source === 'system' && (
          <p className="mt-1 text-caption text-muted-foreground">
            成员访问：
            {server.memberAccess === 'shared' ? '共享给成员' : '仅管理员'}
          </p>
        )}
        {server.unavailableReason === 'system_admin_only' && (
          <Callout tone="warning" className="mt-3">
            此系统 MCP 仅限管理员使用。普通成员的智能体
            无法运行它，完整运行配置也不会向普通成员公开。
          </Callout>
        )}
      </div>

      {editing ? (
        <div className="space-y-5 border-t border-surface-border px-5 py-5">
          {server.readonly && (
            <Callout>
              系统 MCP 由管理员统一管理，你可以查看并在智能体
              能力中引用，但不能修改。
            </Callout>
          )}
          {hasConflict && (
            <Callout tone="warning">
              存在同名的系统与用户配置。运行时按系统层、用户层顺序合并，
              {server.effective
                ? '当前这份配置生效。'
                : '当前由“我的 MCP”配置覆盖。'}
            </Callout>
          )}
          {server.source === 'system' && (
            <Field label="成员访问">
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    ['admin_only', '仅管理员', '普通成员的智能体不可使用'],
                    ['shared', '共享给成员', '允许普通成员的智能体使用'],
                  ] as const
                ).map(([value, title, description]) => (
                  <ChoiceCard
                    key={value}
                    disabled={saving}
                    selected={editMemberAccess === value}
                    onSelect={() => setEditMemberAccess(value)}
                    title={title}
                    description={description}
                  />
                ))}
              </div>
              {editMemberAccess === 'shared' && (
                <Callout tone="warning" className="mt-2">
                  共享会把完整 command、args、url、env 和 headers
                  配置交给普通成员的智能体
                  运行。请确认其中所有凭据都允许成员使用。
                </Callout>
              )}
            </Field>
          )}
          {isHttp ? (
            <Field label="URL">
              <Input
                value={editUrl}
                onChange={(event) => setEditUrl(event.target.value)}
                className="font-mono"
              />
            </Field>
          ) : (
            <>
              <Field label="命令">
                <Input
                  value={editCommand}
                  onChange={(event) => setEditCommand(event.target.value)}
                  className="font-mono"
                />
              </Field>
              <Field label="参数">
                <div className="space-y-2">
                  {editArgs.map((arg, index) => (
                    <div key={index} className="flex gap-2">
                      <Input
                        value={arg}
                        onChange={(event) =>
                          setEditArgs(
                            editArgs.map((item, i) =>
                              i === index ? event.target.value : item,
                            ),
                          )
                        }
                        className="font-mono"
                      />
                      <IconButton
                        label="移除参数"
                        icon={<X />}
                        size="icon"
                        onClick={() =>
                          setEditArgs(editArgs.filter((_, i) => i !== index))
                        }
                      />
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setEditArgs([...editArgs, ''])}
                  >
                    <Plus />
                    添加参数
                  </Button>
                </div>
              </Field>
            </>
          )}
          <Field label="描述">
            <Input
              value={editDescription}
              onChange={(event) => setEditDescription(event.target.value)}
            />
          </Field>

          <div className="rounded-lg p-4 ring-1 ring-surface-border">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <Label>{secretLabel}</Label>
                <p className="mt-1 text-caption leading-5 text-muted-foreground">
                  {secretRows === null
                    ? `保留当前 ${secretKeys.length} 项配置。密钥不会回填或显示。`
                    : '保存后会整组替换现有配置；请完整填写需要保留的项目。'}
                </p>
              </div>
              <div className="flex gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setSecretRows([{ key: '', value: '' }])}
                >
                  替换全部
                </Button>
                {secretKeys.length > 0 && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-error hover:bg-error/10 hover:text-error"
                    onClick={() => void clearSecrets()}
                  >
                    清空全部
                  </Button>
                )}
              </div>
            </div>
            {secretRows && (
              <div className="mt-3 space-y-2">
                {secretRows.map((row, index) => (
                  <div
                    key={index}
                    className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)_auto] gap-2"
                  >
                    <Input
                      value={row.key}
                      onChange={(event) =>
                        setSecretRows(
                          secretRows.map((item, i) =>
                            i === index
                              ? { ...item, key: event.target.value }
                              : item,
                          ),
                        )
                      }
                      placeholder={isHttp ? 'Authorization' : 'API_KEY'}
                      className="font-mono"
                    />
                    <Input
                      type="password"
                      value={row.value}
                      onChange={(event) =>
                        setSecretRows(
                          secretRows.map((item, i) =>
                            i === index
                              ? { ...item, value: event.target.value }
                              : item,
                          ),
                        )
                      }
                      placeholder="输入新值"
                      className="font-mono"
                    />
                    <IconButton
                      label="移除此项"
                      icon={<X />}
                      size="icon"
                      onClick={() =>
                        setSecretRows(secretRows.filter((_, i) => i !== index))
                      }
                    />
                  </div>
                ))}
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setSecretRows([...secretRows, { key: '', value: '' }])
                  }
                >
                  <Plus />
                  添加一项
                </Button>
              </div>
            )}
          </div>

          <div className="flex gap-2">
            <Button
              type="button"
              disabled={
                saving || (isHttp ? !editUrl.trim() : !editCommand.trim())
              }
              onClick={() => void saveEdit()}
            >
              <Save />
              {saving ? '保存中…' : '保存'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={saving}
              onClick={() => {
                setEditing(false);
                setSecretRows(null);
              }}
            >
              取消
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4 border-t border-surface-border px-5 py-4">
          {server.runtimeAvailable !== false && (
            <>
              <Field label={isHttp ? '连接地址' : '命令'}>
                <div className="break-all rounded-lg bg-muted/60 px-3 py-2 font-mono text-caption text-foreground">
                  {isHttp ? server.url : server.command}
                </div>
              </Field>
              {!isHttp && server.args && server.args.length > 0 && (
                <Field label="参数">
                  <div className="flex flex-wrap gap-1.5">
                    {server.args.map((arg, index) => (
                      <code
                        key={index}
                        className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-caption text-foreground"
                      >
                        {arg}
                      </code>
                    ))}
                  </div>
                </Field>
              )}
            </>
          )}
          <Field label={secretLabel}>
            {secretKeys.length > 0 ? (
              <ul className="divide-y divide-surface-border rounded-lg ring-1 ring-surface-border">
                {secretKeys.map((key) => (
                  <li
                    key={key}
                    className="flex items-center gap-2 px-3 py-2 text-caption"
                  >
                    <KeyRound className="size-3.5 text-faint-foreground" />
                    <code className="font-mono font-medium text-foreground">
                      {key}
                    </code>
                    <span className="ml-auto text-muted-foreground">
                      已安全配置
                    </span>
                  </li>
                ))}
              </ul>
            ) : hasHiddenSystemSecretKeys ? (
              <p className="text-caption text-muted-foreground">
                已由管理员配置（名称不可见）
              </p>
            ) : (
              <p className="text-caption text-muted-foreground">未配置</p>
            )}
          </Field>
          <p className="text-caption text-faint-foreground tabular-nums">
            添加时间：{new Date(server.addedAt).toLocaleString()}
          </p>
          <Callout>
            {isImported
              ? '这是从宿主机导入的独立副本，后续导入不会覆盖它。'
              : '修改会影响新启动的智能体运行环境。已有密钥不会通过 API 或界面再次显示。'}
          </Callout>
        </div>
      )}
    </DetailPanel>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <Label className="mb-1.5 block text-caption font-medium text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  );
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}
