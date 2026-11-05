import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  Edit3,
  HardDrive,
  Loader2,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import { Switch } from '@/components/ui/switch';
import { EmptyState } from '@/components/common/EmptyState';
import { IconButton } from '@/components/common/IconButton';
import { ListGroup, ListRow } from '@/components/common/ListRow';
import { ResponsiveMenu } from '@/components/common/ResponsiveMenu';
import { SegmentedControl } from '@/components/common/SegmentedControl';
import { cn } from '@/lib/utils';
import { confirmDialog } from '../../stores/confirm';
import {
  createStorageSource,
  deleteStorageSource,
  listStorageSources,
  STORAGE_SOURCE_ID_RE,
  storageSourceLocation,
  updateStorageSource,
  type StorageSource,
  type StorageSourceList,
  type StorageSourceSave,
} from '../../lib/storage-sources';
import { SettingsField, SettingsSection } from './SettingsLayout';
import { getErrorMessage } from './types';

type SourceType = StorageSource['type'];

interface Draft {
  id: string;
  type: SourceType;
  server: string;
  exportPath: string;
  nfsVersion: string;
  share: string;
  username: string;
  domain: string;
  smbVersion: string;
  allowReadWrite: boolean;
  description: string;
  /** Only sent when passwordAction is 'set' and the field is filled. */
  password: string;
  passwordAction: 'keep' | 'set' | 'clear';
}

function draftFrom(source: StorageSource | null): Draft {
  return {
    id: source?.id ?? '',
    type: source?.type ?? 'nfs',
    server: source?.server ?? '',
    exportPath: source?.exportPath ?? '',
    nfsVersion: source?.nfsVersion ?? '3',
    share: source?.share ?? '',
    username: source?.username ?? '',
    domain: source?.domain ?? '',
    smbVersion: source?.smbVersion ?? '3.0',
    allowReadWrite: source?.allowReadWrite ?? false,
    description: source?.description ?? '',
    password: '',
    passwordAction: source?.hasPassword ? 'keep' : 'set',
  };
}

/** Client-side checks; the server repeats them with the runtime parser. */
function validateDraft(draft: Draft, creating: boolean): string | null {
  if (creating && !STORAGE_SOURCE_ID_RE.test(draft.id)) {
    return '标识只能用小写字母、数字和连字符，以字母或数字开头，最长 63 个字符';
  }
  if (!draft.server.trim()) return '请填写服务器地址';
  if (draft.type === 'nfs') {
    if (!draft.exportPath.trim().startsWith('/')) {
      return 'NFS 导出路径必须以 / 开头';
    }
    return null;
  }
  if (!draft.share.trim()) return '请填写共享名';
  if (/[\\/]/.test(draft.share)) return '共享名不能包含斜杠';
  if (draft.passwordAction === 'set' && draft.password) {
    if (!draft.username.trim()) return '设置密码时必须填写用户名';
    if (/[,\r\n]/.test(draft.password)) return 'SMB 密码不能包含逗号或换行';
  }
  return null;
}

function toPayload(draft: Draft, hadPassword: boolean): StorageSourceSave {
  const base = {
    type: draft.type,
    server: draft.server.trim(),
    allowReadWrite: draft.allowReadWrite,
    ...(draft.description.trim()
      ? { description: draft.description.trim() }
      : {}),
  };
  if (draft.type === 'nfs') {
    return {
      ...base,
      exportPath: draft.exportPath.trim(),
      nfsVersion: draft.nfsVersion,
    };
  }
  const username = draft.username.trim();
  let password: string | undefined;
  if (draft.passwordAction === 'clear' || !username) {
    password = hadPassword ? '' : undefined;
  } else if (draft.passwordAction === 'set') {
    // An empty field keeps whatever is stored.
    password = draft.password || undefined;
  }
  return {
    ...base,
    share: draft.share.trim(),
    ...(username ? { username } : {}),
    ...(draft.domain.trim() ? { domain: draft.domain.trim() } : {}),
    smbVersion: draft.smbVersion,
    ...(password !== undefined ? { password } : {}),
  };
}

function StorageSourceDialog({
  open,
  source,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  /** null creates a new source. */
  source: StorageSource | null;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const creating = source === null;
  const [draft, setDraft] = useState<Draft>(() => draftFrom(source));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(draftFrom(source));
    setError(null);
  }, [open, source]);

  const update = (patch: Partial<Draft>) =>
    setDraft((current) => ({ ...current, ...patch }));

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const invalid = validateDraft(draft, creating);
    if (invalid) {
      setError(invalid);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const payload = toPayload(draft, !!source?.hasPassword);
      if (creating) await createStorageSource(draft.id, payload);
      else await updateStorageSource(source.id, payload);
      toast.success(creating ? `已添加存储源 ${draft.id}` : '存储源已保存');
      onOpenChange(false);
      onSaved();
    } catch (err) {
      setError(getErrorMessage(err, '保存存储源失败'));
    } finally {
      setSaving(false);
    }
  };

  const isSmb = draft.type === 'cifs';
  const hadPassword = !!source?.hasPassword;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{creating ? '添加存储源' : '编辑存储源'}</DialogTitle>
            <DialogDescription>
              由 Docker 在容器启动时直接挂载，不经过宿主机目录，宿主机重新挂载
              NAS 不会影响运行中的容器。
            </DialogDescription>
          </DialogHeader>

          {error && (
            <div
              role="alert"
              className="rounded-lg bg-error/10 px-3 py-2 text-body text-error"
            >
              {error}
            </div>
          )}

          {creating && (
            <SegmentedControl
              label="存储类型"
              value={draft.type}
              onChange={(type) => update({ type })}
              options={[
                { value: 'nfs', label: 'NFS' },
                { value: 'cifs', label: 'SMB' },
              ]}
            />
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <SettingsField
              label="标识"
              htmlFor="storage-source-id"
              description={
                creating ? '工作区按它引用，创建后不能修改' : undefined
              }
            >
              <Input
                id="storage-source-id"
                value={draft.id}
                onChange={(e) => update({ id: e.target.value })}
                placeholder="nas-shared"
                variant="code"
                disabled={!creating}
                autoComplete="off"
              />
            </SettingsField>
            <SettingsField label="服务器" htmlFor="storage-source-server">
              <Input
                id="storage-source-server"
                value={draft.server}
                onChange={(e) => update({ server: e.target.value })}
                placeholder="nas.lan"
                variant="code"
                autoComplete="off"
              />
            </SettingsField>

            {isSmb ? (
              <>
                <SettingsField label="共享名" htmlFor="storage-source-share">
                  <Input
                    id="storage-source-share"
                    value={draft.share}
                    onChange={(e) => update({ share: e.target.value })}
                    placeholder="team"
                    variant="code"
                    autoComplete="off"
                  />
                </SettingsField>
                <SettingsField label="SMB 版本" htmlFor="storage-source-smb">
                  <NativeSelect
                    id="storage-source-smb"
                    value={draft.smbVersion}
                    onChange={(e) => update({ smbVersion: e.target.value })}
                    className="w-full"
                  >
                    {['3.1.1', '3.0', '2.1'].map((version) => (
                      <NativeSelectOption key={version} value={version}>
                        {version}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </SettingsField>
                <SettingsField
                  label="用户名"
                  htmlFor="storage-source-username"
                  description="留空则以访客身份连接"
                >
                  <Input
                    id="storage-source-username"
                    value={draft.username}
                    onChange={(e) => update({ username: e.target.value })}
                    variant="code"
                    autoComplete="off"
                  />
                </SettingsField>
                <SettingsField
                  label="域（可选）"
                  htmlFor="storage-source-domain"
                >
                  <Input
                    id="storage-source-domain"
                    value={draft.domain}
                    onChange={(e) => update({ domain: e.target.value })}
                    variant="code"
                    autoComplete="off"
                  />
                </SettingsField>
                {draft.username.trim() && (
                  <SettingsField
                    label="密码"
                    htmlFor="storage-source-password"
                    className="sm:col-span-2"
                    description="只写不读：保存后存进服务器上仅服务账户可读的文件，界面不会再显示。不能包含逗号。"
                  >
                    {hadPassword && draft.passwordAction !== 'set' ? (
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge variant="neutral">
                          {draft.passwordAction === 'clear'
                            ? '保存后清除密码'
                            : '已设置'}
                        </Badge>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() =>
                            update({ passwordAction: 'set', password: '' })
                          }
                        >
                          更换密码
                        </Button>
                        {draft.passwordAction === 'keep' && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() => update({ passwordAction: 'clear' })}
                          >
                            清除
                          </Button>
                        )}
                      </div>
                    ) : (
                      <Input
                        id="storage-source-password"
                        type="password"
                        value={draft.password}
                        onChange={(e) => update({ password: e.target.value })}
                        autoComplete="new-password"
                      />
                    )}
                  </SettingsField>
                )}
              </>
            ) : (
              <>
                <SettingsField
                  label="导出路径"
                  htmlFor="storage-source-export"
                  className="sm:col-span-1"
                >
                  <Input
                    id="storage-source-export"
                    value={draft.exportPath}
                    onChange={(e) => update({ exportPath: e.target.value })}
                    placeholder="/volume1/shared"
                    variant="code"
                    autoComplete="off"
                  />
                </SettingsField>
                <SettingsField label="NFS 版本" htmlFor="storage-source-nfs">
                  <NativeSelect
                    id="storage-source-nfs"
                    value={draft.nfsVersion}
                    onChange={(e) => update({ nfsVersion: e.target.value })}
                    className="w-full"
                  >
                    {['3', '4', '4.1', '4.2'].map((version) => (
                      <NativeSelectOption key={version} value={version}>
                        NFSv{version}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </SettingsField>
              </>
            )}

            <SettingsField
              label="说明（可选）"
              htmlFor="storage-source-description"
              className="sm:col-span-2"
            >
              <Input
                id="storage-source-description"
                value={draft.description}
                onChange={(e) => update({ description: e.target.value })}
                placeholder="团队共享盘"
              />
            </SettingsField>
          </div>

          <label
            htmlFor="storage-source-rw"
            className="flex items-center justify-between gap-4 rounded-lg px-3 py-2.5 ring-1 ring-surface-border"
          >
            <span className="min-w-0">
              <span className="block text-body font-medium text-foreground">
                允许读写挂载
              </span>
              <span className="block text-caption text-muted-foreground">
                关闭时所有工作区只能只读挂载这个存储源。
              </span>
            </span>
            <Switch
              id="storage-source-rw"
              checked={draft.allowReadWrite}
              onCheckedChange={(allowReadWrite) => update({ allowReadWrite })}
            />
          </label>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="animate-spin" />}
              {creating ? '添加' : '保存'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function StorageSourceRow({
  source,
  onEdit,
  onDeleted,
}: {
  source: StorageSource;
  onEdit: (source: StorageSource) => void;
  onDeleted: () => void;
}) {
  const remove = async () => {
    const confirmed = await confirmDialog({
      title: '删除存储源',
      message:
        source.usedBy > 0
          ? `有 ${source.usedBy} 个工作区挂载了 ${source.id}，删除后它们在下次启动时会因找不到存储源而失败。确定删除吗？`
          : `确定删除存储源 ${source.id} 吗？NAS 上的文件不受影响。`,
      confirmText: '删除',
      variant: 'danger',
    });
    if (!confirmed) return;
    try {
      await deleteStorageSource(source.id);
      toast.success(`已删除存储源 ${source.id}`);
      onDeleted();
    } catch (err) {
      toast.error(getErrorMessage(err, '删除存储源失败'));
    }
  };

  return (
    <ListRow
      title={source.description || source.id}
      badges={
        <>
          <Badge variant="outline">
            {source.type === 'nfs' ? 'NFS' : 'SMB'}
          </Badge>
          <Badge variant="neutral">
            {source.allowReadWrite ? '可读写' : '只读'}
          </Badge>
        </>
      }
      description={
        <>
          <span className="font-mono break-all">
            {storageSourceLocation(source)}
          </span>
          <span className="text-faint-foreground"> · </span>
          <span>{source.id}</span>
          {source.type === 'cifs' && (
            <>
              <span className="text-faint-foreground"> · </span>
              <span>
                {source.username
                  ? `${source.username}${source.hasPassword ? '' : '（未设密码）'}`
                  : '访客'}
              </span>
            </>
          )}
          <span className="text-faint-foreground"> · </span>
          <span className={cn(source.usedBy === 0 && 'text-faint-foreground')}>
            {source.usedBy > 0 ? `${source.usedBy} 个工作区在用` : '未使用'}
          </span>
        </>
      }
      actions={
        <ResponsiveMenu
          title={source.id}
          align="end"
          trigger={
            <IconButton
              label={`${source.id} 的操作`}
              icon={<MoreHorizontal />}
              hideTooltip
            />
          }
          groups={[
            [{ label: '编辑', icon: Edit3, onSelect: () => onEdit(source) }],
            [
              {
                label: '删除',
                icon: Trash2,
                destructive: true,
                onSelect: () => void remove(),
              },
            ],
          ]}
        />
      }
    />
  );
}

/** Settings → 存储源: NFS exports and SMB shares workspaces can mount. */
export function StorageSourcesSection() {
  const [data, setData] = useState<StorageSourceList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<StorageSource | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await listStorageSources());
    } catch (err) {
      setError(getErrorMessage(err, '无法读取存储源'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const openEdit = (source: StorageSource) => {
    setEditing(source);
    setDialogOpen(true);
  };

  const sources = data?.sources ?? [];
  const blocked = !!data?.allowlistError;

  return (
    <div className="space-y-8">
      <SettingsSection
        title="网络存储"
        description={`工作区按标识引用，配置写在 ${data?.allowlistPath ?? 'config/mount-allowlist.json'}。`}
        actions={
          <>
            <IconButton
              label="刷新"
              variant="outline"
              size="icon"
              icon={<RefreshCw className={cn(loading && 'animate-spin')} />}
              onClick={() => void load()}
              disabled={loading}
            />
            {data && !blocked && (
              <Button onClick={openCreate}>
                <Plus />
                添加存储源
              </Button>
            )}
          </>
        }
      >
        {(error || data?.allowlistError) && (
          <div
            role="alert"
            className="rounded-lg bg-error/10 px-3 py-2.5 text-body text-error"
          >
            {error ??
              `挂载白名单无法解析，修好文件后再管理存储源（${data?.allowlistError}）`}
          </div>
        )}
        {data?.nonMainReadOnly && sources.some((s) => s.allowReadWrite) && (
          <p className="rounded-lg bg-muted/50 px-3 py-2.5 text-body text-muted-foreground">
            白名单开启了
            nonMainReadOnly，新建的工作区只能只读挂载，即使存储源允许读写。
          </p>
        )}
        {!data && loading ? (
          <div className="flex items-center justify-center gap-2 rounded-xl py-12 text-body text-muted-foreground ring-1 ring-surface-border">
            <Loader2 className="size-4 animate-spin" />
            正在加载存储源
          </div>
        ) : sources.length === 0 ? (
          data &&
          !blocked && (
            <EmptyState
              icon={HardDrive}
              title="还没有存储源"
              description="添加 NAS 上的 NFS 导出或 SMB 共享，工作区就能直接挂载它。"
              className="rounded-xl bg-surface-raised ring-1 ring-surface-border"
              action={
                <Button variant="outline" onClick={openCreate}>
                  <Plus />
                  添加存储源
                </Button>
              }
            />
          )
        ) : (
          <ListGroup>
            {sources.map((source) => (
              <StorageSourceRow
                key={source.id}
                source={source}
                onEdit={openEdit}
                onDeleted={() => void load()}
              />
            ))}
          </ListGroup>
        )}
      </SettingsSection>

      <StorageSourceDialog
        open={dialogOpen}
        source={editing}
        onOpenChange={setDialogOpen}
        onSaved={() => void load()}
      />
    </div>
  );
}
