import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import {
  Edit3,
  KeyRound,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  Trash2,
  UserPlus,
  Users,
} from 'lucide-react';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ResponsiveMenu } from '@/components/common/ResponsiveMenu';
import { Input } from '@/components/ui/input';
import { PasswordInput } from '@/components/common/PasswordInput';
import { Label } from '@/components/ui/label';
import { EmptyState } from '@/components/common/EmptyState';
import { IconButton } from '@/components/common/IconButton';
import { ListGroup, ListRow } from '@/components/common/ListRow';
import { cn } from '@/lib/utils';
import { confirmDialog } from '../../stores/confirm';
import {
  useGuestsStore,
  type GuestAccount,
  type GuestWorkspaceRef,
} from '../../stores/guests';
import {
  GUEST_GRANT_DESCRIPTION,
  GUEST_SCOPE_DESCRIPTION,
  validateGuestPassword,
  validateGuestUsername,
} from '../../lib/guest';
import { SettingsField, SettingsSection } from './SettingsLayout';
import { getErrorMessage } from './types';
import { formatDateTime } from '../users/utils';

function formatLastLogin(value: string | null | undefined): string {
  return value ? formatDateTime(value) : '从未登录';
}

function workspaceLabel(workspace: GuestWorkspaceRef): string {
  return workspace.name || workspace.jid;
}

function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="rounded-lg bg-error/10 px-3 py-2 text-body text-error"
    >
      {message}
    </div>
  );
}

/** Multi-select of the workspaces a guest may read. */
function WorkspaceGrantList({
  workspaces,
  value,
  onChange,
}: {
  workspaces: GuestWorkspaceRef[];
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const idPrefix = useId();
  if (workspaces.length === 0) {
    return (
      <p className="rounded-lg px-3 py-3 text-caption text-muted-foreground ring-1 ring-surface-border">
        暂无可授权的工作区
      </p>
    );
  }
  const toggle = (jid: string) =>
    onChange(
      value.includes(jid)
        ? value.filter((item) => item !== jid)
        : [...value, jid],
    );
  return (
    <div className="max-h-60 space-y-2 overflow-y-auto rounded-lg p-3 ring-1 ring-surface-border">
      {workspaces.map((workspace) => {
        const id = `${idPrefix}-${workspace.jid}`;
        return (
          <div key={workspace.jid} className="flex items-center gap-2">
            <Checkbox
              id={id}
              checked={value.includes(workspace.jid)}
              onCheckedChange={() => toggle(workspace.jid)}
            />
            <Label
              htmlFor={id}
              className="min-w-0 truncate text-label font-normal"
            >
              {workspaceLabel(workspace)}
            </Label>
            {workspace.is_home && <Badge variant="neutral">Home</Badge>}
          </div>
        );
      })}
    </div>
  );
}

/** Grantable workspaces plus any already granted that are no longer listed. */
function useWorkspaceOptions(guest: GuestAccount | null) {
  const grantable = useGuestsStore((s) => s.grantableWorkspaces);
  return useMemo(() => {
    const seen = new Set(grantable.map((workspace) => workspace.jid));
    const extra = (guest?.workspaces ?? []).filter(
      (workspace) => !seen.has(workspace.jid),
    );
    return [...grantable, ...extra].sort((a, b) =>
      a.is_home === b.is_home
        ? workspaceLabel(a).localeCompare(workspaceLabel(b))
        : a.is_home
          ? -1
          : 1,
    );
  }, [grantable, guest]);
}

function CreateGuestDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const createGuest = useGuestsStore((s) => s.createGuest);
  const workspaces = useWorkspaceOptions(null);
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [workspaceJids, setWorkspaceJids] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setUsername('');
    setDisplayName('');
    setPassword('');
    setWorkspaceJids([]);
    setError(null);
  }, [open]);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const name = username.trim();
    const invalid =
      validateGuestUsername(name) || validateGuestPassword(password);
    if (invalid) {
      setError(invalid);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await createGuest({
        username: name,
        password,
        display_name: displayName.trim() || undefined,
        workspace_jids: workspaceJids,
      });
      onOpenChange(false);
      toast.success(`访客 ${name} 已创建`);
    } catch (err) {
      setError(getErrorMessage(err, '创建访客失败'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>新建访客</DialogTitle>
            <DialogDescription>{GUEST_SCOPE_DESCRIPTION}</DialogDescription>
          </DialogHeader>

          <FormError message={error} />

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <SettingsField label="用户名" htmlFor="create-guest-username">
              <Input
                id="create-guest-username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="3-32 位字母、数字或下划线"
                autoComplete="off"
              />
            </SettingsField>
            <SettingsField label="显示名称" htmlFor="create-guest-display">
              <Input
                id="create-guest-display"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="显示名称（可选）"
              />
            </SettingsField>
            <SettingsField
              label="密码"
              htmlFor="create-guest-password"
              className="sm:col-span-2"
            >
              <PasswordInput
                id="create-guest-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="密码（至少 8 位）"
                autoComplete="new-password"
              />
            </SettingsField>
          </div>

          <SettingsField
            label="授权工作区"
            description={GUEST_GRANT_DESCRIPTION}
          >
            <WorkspaceGrantList
              workspaces={workspaces}
              value={workspaceJids}
              onChange={setWorkspaceJids}
            />
          </SettingsField>

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
              创建
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EditGuestDialog({
  guest,
  onOpenChange,
}: {
  guest: GuestAccount | null;
  onOpenChange: (open: boolean) => void;
}) {
  const updateGuest = useGuestsStore((s) => s.updateGuest);
  const workspaces = useWorkspaceOptions(guest);
  const [displayName, setDisplayName] = useState('');
  const [workspaceJids, setWorkspaceJids] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Keep the last guest shown while the dialog animates closed.
  const [shown, setShown] = useState<GuestAccount | null>(guest);

  useEffect(() => {
    if (!guest) return;
    setShown(guest);
    setDisplayName(guest.display_name || '');
    setWorkspaceJids(guest.workspaces.map((workspace) => workspace.jid));
    setError(null);
  }, [guest]);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!guest) return;
    const payload: { display_name?: string; workspace_jids?: string[] } = {};
    const nextName = displayName.trim();
    if (nextName !== (guest.display_name || '')) {
      payload.display_name = nextName;
    }
    const current = guest.workspaces.map((workspace) => workspace.jid);
    const changed =
      current.length !== workspaceJids.length ||
      current.some((jid) => !workspaceJids.includes(jid));
    if (changed) payload.workspace_jids = workspaceJids;
    if (Object.keys(payload).length === 0) {
      onOpenChange(false);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateGuest(guest.id, payload);
      onOpenChange(false);
      toast.success(`访客 ${guest.username} 已更新`);
    } catch (err) {
      setError(getErrorMessage(err, '更新访客失败'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!guest} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>编辑访客</DialogTitle>
            <DialogDescription>
              {shown
                ? `${shown.display_name || shown.username} · @${shown.username}`
                : ''}
            </DialogDescription>
          </DialogHeader>

          <FormError message={error} />

          <SettingsField label="显示名称" htmlFor="edit-guest-display">
            <Input
              id="edit-guest-display"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="显示名称（可选）"
            />
          </SettingsField>

          <SettingsField
            label="授权工作区"
            description={`${GUEST_GRANT_DESCRIPTION}取消勾选后，访客立即失去该工作区的查看权限。`}
          >
            <WorkspaceGrantList
              workspaces={workspaces}
              value={workspaceJids}
              onChange={setWorkspaceJids}
            />
          </SettingsField>

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
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ResetGuestPasswordDialog({
  guest,
  onOpenChange,
}: {
  guest: GuestAccount | null;
  onOpenChange: (open: boolean) => void;
}) {
  const updateGuest = useGuestsStore((s) => s.updateGuest);
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<GuestAccount | null>(guest);

  useEffect(() => {
    if (!guest) return;
    setShown(guest);
    setPassword('');
    setError(null);
  }, [guest]);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!guest) return;
    const invalid = validateGuestPassword(password);
    if (invalid) {
      setError(invalid);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateGuest(guest.id, { password });
      onOpenChange(false);
      toast.success(`已重置 ${guest.username} 的密码`);
    } catch (err) {
      setError(getErrorMessage(err, '重置密码失败'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!guest} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>重置密码</DialogTitle>
            <DialogDescription>
              {shown ? `为 @${shown.username} 设置新密码。` : ''}
            </DialogDescription>
          </DialogHeader>
          <FormError message={error} />
          <SettingsField label="新密码" htmlFor="reset-guest-password">
            <PasswordInput
              id="reset-guest-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="新密码（至少 8 位）"
              autoComplete="new-password"
              autoFocus
            />
          </SettingsField>
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
              重置
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function GuestRow({
  guest,
  onEdit,
  onResetPassword,
}: {
  guest: GuestAccount;
  onEdit: (guest: GuestAccount) => void;
  onResetPassword: (guest: GuestAccount) => void;
}) {
  const updateGuest = useGuestsStore((s) => s.updateGuest);
  const deleteGuest = useGuestsStore((s) => s.deleteGuest);
  const active = guest.status === 'active';
  const lockedByAdmin = guest.disabled_by_admin;
  const granted = guest.workspaces.map(workspaceLabel).join('、');

  const toggleStatus = async () => {
    try {
      await updateGuest(guest.id, { status: active ? 'disabled' : 'active' });
      toast.success(
        active
          ? `已禁用访客 ${guest.username}`
          : `已启用访客 ${guest.username}`,
      );
    } catch (err) {
      toast.error(getErrorMessage(err, '更新状态失败'));
    }
  };

  const remove = async () => {
    const confirmed = await confirmDialog({
      title: '删除访客',
      message: `确定要删除访客 ${guest.username} 吗？该账户将立即无法登录，此操作不可恢复。`,
      confirmText: '删除',
      variant: 'danger',
    });
    if (!confirmed) return;
    try {
      await deleteGuest(guest.id);
      toast.success(`访客 ${guest.username} 已删除`);
    } catch (err) {
      toast.error(getErrorMessage(err, '删除访客失败'));
    }
  };

  return (
    <ListRow
      title={guest.display_name || guest.username}
      badges={
        <Badge variant="outline" dot={active ? 'success' : 'warning'}>
          {active ? '启用' : lockedByAdmin ? '已被管理员停用' : '禁用'}
        </Badge>
      }
      description={
        <>
          <span>@{guest.username}</span>
          <span className="text-faint-foreground"> · </span>
          <span className={cn(!granted && 'text-warning')}>
            {granted ? `可查看：${granted}` : '尚未授权任何工作区'}
          </span>
          <span className="sm:hidden">
            <span className="text-faint-foreground"> · </span>
            最近登录 {formatLastLogin(guest.last_login_at)}
          </span>
        </>
      }
      meta={
        <span className="hidden sm:inline">
          {formatLastLogin(guest.last_login_at)}
        </span>
      }
      actions={
        <ResponsiveMenu
          title={guest.display_name || guest.username}
          align="end"
          trigger={
            <IconButton
              label={`${guest.display_name || guest.username} 的操作`}
              icon={<MoreHorizontal />}
              hideTooltip
            />
          }
          groups={[
            // Disabled by an administrator: only deleting is left to the owner.
            lockedByAdmin
              ? []
              : [
                  {
                    label: '编辑授权',
                    icon: Edit3,
                    onSelect: () => onEdit(guest),
                  },
                  {
                    label: '重置密码',
                    icon: KeyRound,
                    onSelect: () => onResetPassword(guest),
                  },
                  {
                    label: active ? '禁用' : '启用',
                    icon: active ? ShieldOff : ShieldCheck,
                    onSelect: () => void toggleStatus(),
                  },
                ],
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

/** Settings → 访客: read-only guest accounts owned by the signed-in user. */
export function GuestsSection() {
  const guests = useGuestsStore((s) => s.guests);
  const loading = useGuestsStore((s) => s.loading);
  const loaded = useGuestsStore((s) => s.loaded);
  const error = useGuestsStore((s) => s.error);
  const loadGuests = useGuestsStore((s) => s.loadGuests);
  const canCreate = useGuestsStore((s) => s.canCreate);
  const maxGuests = useGuestsStore((s) => s.maxGuests);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<GuestAccount | null>(null);
  const [resetting, setResetting] = useState<GuestAccount | null>(null);

  useEffect(() => {
    void loadGuests();
  }, [loadGuests]);

  const sorted = useMemo(
    () =>
      [...guests].sort((a, b) =>
        (b.created_at || '').localeCompare(a.created_at || ''),
      ),
    [guests],
  );
  const atLimit = guests.length >= maxGuests;
  // Why 新建 is missing, when it is.
  const createNotice = !loaded
    ? null
    : !canCreate
      ? '管理员尚未开放普通成员创建访客。已有的访客仍可在这里编辑或删除，但暂时无法登录。'
      : atLimit
        ? `每个账户最多 ${maxGuests} 个访客，删除不用的访客后才能新建。`
        : null;
  const showCreate = loaded && canCreate && !atLimit;

  return (
    <div className="space-y-8">
      <SettingsSection
        title="我的访客"
        description="访客使用自己的用户名和密码登录，只能查看你授权的工作区。"
        actions={
          <>
            <IconButton
              label="刷新"
              variant="outline"
              size="icon"
              icon={<RefreshCw className={cn(loading && 'animate-spin')} />}
              onClick={() => void loadGuests()}
              disabled={loading}
            />
            {showCreate && (
              <Button onClick={() => setCreateOpen(true)}>
                <UserPlus />
                新建访客
              </Button>
            )}
          </>
        }
      >
        {createNotice && (
          <p className="rounded-lg bg-muted/50 px-3 py-2.5 text-body text-muted-foreground">
            {createNotice}
          </p>
        )}
        {error && (
          <div
            role="alert"
            className="rounded-lg bg-error/10 px-3 py-2.5 text-body text-error"
          >
            {error}
          </div>
        )}
        {!loaded && loading ? (
          <div className="flex items-center justify-center gap-2 rounded-xl py-12 text-body text-muted-foreground ring-1 ring-surface-border">
            <Loader2 className="size-4 animate-spin" />
            正在加载访客
          </div>
        ) : sorted.length === 0 ? (
          <EmptyState
            icon={Users}
            title="还没有访客"
            description="创建访客账户，与他人分享工作区的只读视图。"
            className="rounded-xl bg-surface-raised ring-1 ring-surface-border"
            action={
              showCreate && (
                <Button variant="outline" onClick={() => setCreateOpen(true)}>
                  <UserPlus />
                  新建访客
                </Button>
              )
            }
          />
        ) : (
          <ListGroup>
            {sorted.map((guest) => (
              <GuestRow
                key={guest.id}
                guest={guest}
                onEdit={setEditing}
                onResetPassword={setResetting}
              />
            ))}
          </ListGroup>
        )}
      </SettingsSection>

      <CreateGuestDialog open={createOpen} onOpenChange={setCreateOpen} />
      <EditGuestDialog
        guest={editing}
        onOpenChange={(open) => !open && setEditing(null)}
      />
      <ResetGuestPasswordDialog
        guest={resetting}
        onOpenChange={(open) => !open && setResetting(null)}
      />
    </div>
  );
}
