import { useEffect, useState, type FormEvent } from 'react';
import { Loader2 } from 'lucide-react';
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { SettingsField } from '@/components/settings/SettingsLayout';
import type { Permission, UserPublic } from '../../stores/auth';
import { useUsersStore, type PermissionTemplate } from '../../stores/users';
import { getErrorMessage, PERMISSION_LABELS, samePermissions } from './utils';

type Role = 'admin' | 'member';

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

function PermissionChecklist({
  idPrefix,
  permissions,
  value,
  onChange,
}: {
  idPrefix: string;
  permissions: Permission[];
  value: Permission[];
  onChange: (next: Permission[]) => void;
}) {
  const toggle = (permission: Permission) => {
    if (value.includes(permission)) {
      onChange(value.filter((item) => item !== permission));
    } else {
      onChange([...value, permission]);
    }
  };

  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-2 rounded-lg p-3 ring-1 ring-surface-border sm:grid-cols-2">
      {permissions.map((perm) => {
        const id = `${idPrefix}-${perm}`;
        return (
          <div key={perm} className="flex items-center gap-2">
            <Checkbox
              id={id}
              checked={value.includes(perm)}
              onCheckedChange={() => toggle(perm)}
            />
            <Label htmlFor={id} className="text-label font-normal">
              {PERMISSION_LABELS[perm] || perm}
            </Label>
          </div>
        );
      })}
    </div>
  );
}

interface CreateUserDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isAdmin: boolean;
  ownPermissions: Permission[];
  templates: PermissionTemplate[];
  assignablePermissions: Permission[];
  onCreated: () => Promise<void>;
}

export function CreateUserDialog({
  open,
  onOpenChange,
  isAdmin,
  ownPermissions,
  templates,
  assignablePermissions,
  onCreated,
}: CreateUserDialogProps) {
  const createUser = useUsersStore((s) => s.createUser);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newRole, setNewRole] = useState<Role>('member');
  const [newMustChange, setNewMustChange] = useState(true);
  const [newNotes, setNewNotes] = useState('');
  const [newPermissions, setNewPermissions] = useState<Permission[]>([]);

  useEffect(() => {
    if (open) setError(null);
  }, [open]);

  const handleCreate = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!newUsername.trim() || !newPassword) {
      setError('请填写用户名和密码');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const roleForCreate: Role = isAdmin ? newRole : 'member';
      const permissionsForCreate = isAdmin
        ? newPermissions
        : newPermissions.filter((perm) => ownPermissions.includes(perm));
      await createUser({
        username: newUsername.trim(),
        password: newPassword,
        display_name: newDisplayName.trim() || undefined,
        role: roleForCreate,
        permissions: permissionsForCreate,
        must_change_password: newMustChange,
        notes: newNotes.trim() || undefined,
      });
      setNewUsername('');
      setNewPassword('');
      setNewDisplayName('');
      setNewRole('member');
      setNewMustChange(true);
      setNewNotes('');
      setNewPermissions([]);
      onOpenChange(false);
      await onCreated();
    } catch (err) {
      setError(getErrorMessage(err, '创建用户失败'));
    } finally {
      setCreating(false);
    }
  };

  const visibleTemplates = templates.filter(
    (item) => isAdmin || item.role !== 'admin',
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <form onSubmit={handleCreate} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>创建新用户</DialogTitle>
            <DialogDescription>填写账户信息并按需分配权限。</DialogDescription>
          </DialogHeader>

          <FormError message={error} />

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <SettingsField label="用户名" htmlFor="create-user-username">
              <Input
                id="create-user-username"
                value={newUsername}
                onChange={(e) => setNewUsername(e.target.value)}
                placeholder="用户名"
                autoComplete="off"
              />
            </SettingsField>
            <SettingsField label="密码" htmlFor="create-user-password">
              <Input
                id="create-user-password"
                type="password"
                value={newPassword}
                onChange={(e) => setNewPassword(e.target.value)}
                placeholder="密码（至少8位）"
                autoComplete="new-password"
              />
            </SettingsField>
            <SettingsField label="显示名称" htmlFor="create-user-display">
              <Input
                id="create-user-display"
                value={newDisplayName}
                onChange={(e) => setNewDisplayName(e.target.value)}
                placeholder="显示名称（可选）"
              />
            </SettingsField>
            <SettingsField label="角色" htmlFor="create-user-role">
              <Select
                value={newRole}
                onValueChange={(value) => setNewRole(value as Role)}
              >
                <SelectTrigger id="create-user-role" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">成员</SelectItem>
                  {isAdmin && <SelectItem value="admin">管理员</SelectItem>}
                </SelectContent>
              </Select>
            </SettingsField>
            <SettingsField
              label="备注"
              htmlFor="create-user-notes"
              className="sm:col-span-2"
            >
              <Input
                id="create-user-notes"
                value={newNotes}
                onChange={(e) => setNewNotes(e.target.value)}
                placeholder="备注（可选）"
              />
            </SettingsField>
            <div className="flex items-center gap-2 sm:col-span-2">
              <Checkbox
                id="create-user-must-change"
                checked={newMustChange}
                onCheckedChange={(checked) =>
                  setNewMustChange(checked === true)
                }
              />
              <Label
                htmlFor="create-user-must-change"
                className="text-label font-normal"
              >
                下次登录强制改密
              </Label>
            </div>
          </div>

          {visibleTemplates.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-label text-foreground">快捷权限模板</div>
              <div className="flex flex-wrap gap-1.5">
                {visibleTemplates.map((item) => (
                  <Button
                    key={item.key}
                    type="button"
                    variant="outline"
                    size="xs"
                    onClick={() => {
                      setNewRole(item.role);
                      setNewPermissions(item.permissions);
                    }}
                  >
                    {item.label}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {assignablePermissions.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-label text-foreground">权限明细</div>
              <PermissionChecklist
                idPrefix="create-user-perm"
                permissions={assignablePermissions}
                value={newPermissions}
                onChange={setNewPermissions}
              />
            </div>
          )}

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={creating}>
              {creating && <Loader2 className="animate-spin" />}
              创建
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

interface EditUserDialogProps {
  user: UserPublic | null;
  onOpenChange: (open: boolean) => void;
  isAdmin: boolean;
  ownPermissions: Permission[];
  assignablePermissions: Permission[];
  onDone: (message: string, refresh: boolean) => Promise<void>;
}

/** Keeps the last target while a dialog animates closed. */
function useLastUser(user: UserPublic | null) {
  const [shown, setShown] = useState(user);
  useEffect(() => {
    if (user) setShown(user);
  }, [user]);
  return user ?? shown;
}

export function EditUserDialog({
  user: target,
  onOpenChange,
  isAdmin,
  ownPermissions,
  assignablePermissions,
  onDone,
}: EditUserDialogProps) {
  const updateUser = useUsersStore((s) => s.updateUser);
  const user = useLastUser(target);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editRole, setEditRole] = useState<Role>('member');
  const [editDisplayName, setEditDisplayName] = useState('');
  const [editPassword, setEditPassword] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editPermissions, setEditPermissions] = useState<Permission[]>([]);
  const [editDisableReason, setEditDisableReason] = useState('');

  useEffect(() => {
    if (!target) return;
    setError(null);
    setEditRole(target.role);
    setEditDisplayName(target.display_name || '');
    setEditPassword('');
    setEditNotes(target.notes || '');
    setEditPermissions(target.permissions || []);
    setEditDisableReason(target.disable_reason || '');
  }, [target]);

  const submitEdit = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!user) return;
    setError(null);
    try {
      const payload: Parameters<typeof updateUser>[1] = {};
      if (isAdmin && editRole !== user.role) {
        payload.role = editRole;
      }
      if (editDisplayName !== (user.display_name || '')) {
        payload.display_name = editDisplayName;
      }
      if (editPassword.trim()) {
        payload.password = editPassword;
      }
      const nextNotes = editNotes.trim();
      const currentNotes = user.notes || '';
      if (nextNotes !== currentNotes) {
        payload.notes = nextNotes || null;
      }
      if (!samePermissions(editPermissions, user.permissions || [])) {
        payload.permissions = isAdmin
          ? editPermissions
          : editPermissions.filter((perm) => ownPermissions.includes(perm));
      }
      const nextDisableReason = editDisableReason.trim();
      const currentDisableReason = user.disable_reason || '';
      if (nextDisableReason !== currentDisableReason) {
        payload.disable_reason = nextDisableReason || null;
      }
      if (Object.keys(payload).length === 0) {
        onOpenChange(false);
        await onDone('没有需要保存的变更', false);
        return;
      }

      setSaving(true);
      await updateUser(user.id, payload);
      onOpenChange(false);
      await onDone(`用户 ${user.username} 已更新`, true);
    } catch (err) {
      setError(getErrorMessage(err, '更新用户失败'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <form onSubmit={submitEdit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>编辑用户</DialogTitle>
            <DialogDescription>
              {user
                ? `${user.display_name || user.username} · @${user.username}`
                : ''}
            </DialogDescription>
          </DialogHeader>

          <FormError message={error} />

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <SettingsField label="显示名称" htmlFor="edit-user-display">
              <Input
                id="edit-user-display"
                value={editDisplayName}
                onChange={(e) => setEditDisplayName(e.target.value)}
                placeholder="显示名称"
              />
            </SettingsField>
            <SettingsField label="角色" htmlFor="edit-user-role">
              {isAdmin ? (
                <Select
                  value={editRole}
                  onValueChange={(value) => setEditRole(value as Role)}
                >
                  <SelectTrigger id="edit-user-role" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="member">成员</SelectItem>
                    <SelectItem value="admin">管理员</SelectItem>
                  </SelectContent>
                </Select>
              ) : (
                <Input
                  id="edit-user-role"
                  value={
                    user?.role === 'admin'
                      ? '管理员'
                      : user?.role === 'member'
                        ? '成员'
                        : ''
                  }
                  disabled
                />
              )}
            </SettingsField>
            <SettingsField label="重置密码" htmlFor="edit-user-password">
              <Input
                id="edit-user-password"
                type="password"
                value={editPassword}
                onChange={(e) => setEditPassword(e.target.value)}
                placeholder="重置密码（可选）"
                autoComplete="new-password"
              />
            </SettingsField>
            <SettingsField label="禁用原因" htmlFor="edit-user-disable-reason">
              <Input
                id="edit-user-disable-reason"
                value={editDisableReason}
                onChange={(e) => setEditDisableReason(e.target.value)}
                placeholder="禁用原因（可选）"
              />
            </SettingsField>
            <SettingsField
              label="备注"
              htmlFor="edit-user-notes"
              className="sm:col-span-2"
            >
              <Input
                id="edit-user-notes"
                value={editNotes}
                onChange={(e) => setEditNotes(e.target.value)}
                placeholder="备注（可选）"
              />
            </SettingsField>
          </div>

          {assignablePermissions.length > 0 && (
            <div className="space-y-1.5">
              <div className="text-label text-foreground">权限明细</div>
              <PermissionChecklist
                idPrefix="edit-user-perm"
                permissions={assignablePermissions}
                value={editPermissions}
                onChange={setEditPermissions}
              />
            </div>
          )}

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

interface ResetPasswordDialogProps {
  user: UserPublic | null;
  onOpenChange: (open: boolean) => void;
  onSaved: (message: string) => Promise<void>;
}

export function ResetPasswordDialog({
  user: target,
  onOpenChange,
  onSaved,
}: ResetPasswordDialogProps) {
  const updateUser = useUsersStore((s) => s.updateUser);
  const user = useLastUser(target);
  const [value, setValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    setValue('');
    setError(null);
  }, [target]);

  const handleChangePassword = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!user) return;
    if (!value.trim()) {
      setError('请输入新密码');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await updateUser(user.id, { password: value });
      setValue('');
      onOpenChange(false);
      await onSaved(`已重置 ${user.display_name || user.username} 的密码`);
    } catch (err) {
      setError(getErrorMessage(err, '密码修改失败'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Dialog open={!!target} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleChangePassword} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>修改密码</DialogTitle>
            <DialogDescription>
              {user
                ? `${user.display_name || user.username} · @${user.username}`
                : ''}
            </DialogDescription>
          </DialogHeader>

          <FormError message={error} />

          <Input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="输入新密码"
            aria-label="新密码"
            autoComplete="new-password"
            autoFocus
          />

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={loading}>
              {loading && <Loader2 className="animate-spin" />}
              确认
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
