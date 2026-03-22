import { useEffect, useMemo, useState } from 'react';
import {
  Edit3,
  KeyRound,
  Loader2,
  LogOut,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  Trash2,
  Undo2,
  UserPlus,
} from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Card } from '@/components/ui/card';
import type { Permission, UserPublic } from '../../stores/auth';
import { useUsersStore, type UserQuery } from '../../stores/users';
import { getErrorMessage, samePermissions, PERMISSION_LABELS, type TabNotification } from './utils';

interface UserListTabProps extends TabNotification {
  currentUser: UserPublic | null;
}

export function UserListTab({ currentUser, setNotice, setError }: UserListTabProps) {
  const {
    users,
    totalUsers,
    page,
    pageSize,
    loading,
    permissions,
    templates,
    fetchPermissionMeta,
    fetchUsers,
    createUser,
    updateUser,
    deleteUser,
    restoreUser,
    revokeUserSessions,
  } = useUsersStore();

  const [query, setQuery] = useState<UserQuery>({ q: '', role: 'all', status: 'all', page: 1, pageSize: 20 });
  const [showCreate, setShowCreate] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [newRole, setNewRole] = useState<'admin' | 'member'>('member');
  const [newMustChange, setNewMustChange] = useState(true);
  const [newNotes, setNewNotes] = useState('');
  const [newPermissions, setNewPermissions] = useState<Permission[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRole, setEditRole] = useState<'admin' | 'member'>('member');
  const [editDisplayName, setEditDisplayName] = useState('');
  const [editPassword, setEditPassword] = useState('');
  const [editNotes, setEditNotes] = useState('');
  const [editPermissions, setEditPermissions] = useState<Permission[]>([]);
  const [editDisableReason, setEditDisableReason] = useState('');
  const [changingPasswordId, setChangingPasswordId] = useState<string | null>(null);
  const [changePasswordValue, setChangePasswordValue] = useState('');
  const [changingPasswordLoading, setChangingPasswordLoading] = useState(false);
  const isAdmin = currentUser?.role === 'admin';
  const ownPermissions = currentUser?.permissions || [];
  const canOperateTargetUser = (user: UserPublic) => isAdmin || user.role !== 'admin';
  const assignablePermissions = useMemo(() => {
    if (isAdmin) return permissions;
    const ownSet = new Set(ownPermissions);
    return permissions.filter((perm) => ownSet.has(perm));
  }, [isAdmin, ownPermissions, permissions]);

  useEffect(() => {
    void fetchPermissionMeta();
  }, [fetchPermissionMeta]);

  useEffect(() => {
    void fetchUsers(query);
  }, [fetchUsers, query]);

  const applyQuery = (next: Partial<UserQuery>) => {
    setQuery((prev) => ({ ...prev, ...next }));
  };

  const togglePermission = (
    list: Permission[],
    setList: (value: Permission[]) => void,
    permission: Permission,
  ) => {
    if (list.includes(permission)) {
      setList(list.filter((item) => item !== permission));
    } else {
      setList([...list, permission]);
    }
  };

  const handleChangePassword = async (user: UserPublic) => {
    if (!changePasswordValue.trim()) {
      setError('请输入新密码');
      return;
    }
    setChangingPasswordLoading(true);
    setError(null);
    try {
      await updateUser(user.id, { password: changePasswordValue });
      setNotice(`已重置 ${user.display_name || user.username} 的密码`);
      setChangingPasswordId(null);
      setChangePasswordValue('');
      void fetchUsers(query);
    } catch (err) {
      setError(getErrorMessage(err, '密码修改失败'));
    } finally {
      setChangingPasswordLoading(false);
    }
  };

  const startEdit = (user: UserPublic) => {
    if (!canOperateTargetUser(user)) {
      setError('当前账户不能编辑管理员用户');
      return;
    }
    setChangingPasswordId(null);
    setChangePasswordValue('');
    setEditingId(user.id);
    setEditRole(user.role);
    setEditDisplayName(user.display_name || '');
    setEditPassword('');
    setEditNotes(user.notes || '');
    setEditPermissions(user.permissions || []);
    setEditDisableReason(user.disable_reason || '');
  };

  const submitEdit = async (user: UserPublic) => {
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
        setNotice('没有需要保存的变更');
        setEditingId(null);
        return;
      }

      await updateUser(user.id, payload);
      setNotice(`用户 ${user.username} 已更新`);
      setEditingId(null);
      await fetchUsers(query);
    } catch (err) {
      setError(getErrorMessage(err, '更新用户失败'));
    }
  };

  const handleCreate = async () => {
    if (!newUsername.trim() || !newPassword) {
      setError('请填写用户名和密码');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const roleForCreate: 'admin' | 'member' = isAdmin ? newRole : 'member';
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
      setShowCreate(false);
      setNotice('用户创建成功');
      await fetchUsers(query);
    } catch (err) {
      setError(getErrorMessage(err, '创建用户失败'));
    } finally {
      setCreating(false);
    }
  };

  const changeStatus = async (user: UserPublic, status: 'active' | 'disabled' | 'deleted') => {
    try {
      await updateUser(user.id, {
        status,
        disable_reason: status === 'disabled' ? user.disable_reason || 'disabled_by_admin' : null,
      });
      setNotice(`用户 ${user.username} 状态已更新`);
      await fetchUsers(query);
    } catch (err) {
      setError(getErrorMessage(err, '更新状态失败'));
    }
  };

  const handleDelete = async (user: UserPublic) => {
    if (!confirm(`确定要删除用户 ${user.username} 吗？`)) return;
    try {
      await deleteUser(user.id);
      setNotice(`用户 ${user.username} 已删除`);
      await fetchUsers(query);
    } catch (err) {
      setError(getErrorMessage(err, '删除失败'));
    }
  };

  const handleRestore = async (user: UserPublic) => {
    try {
      await restoreUser(user.id);
      setNotice(`用户 ${user.username} 已恢复为禁用状态`);
      await fetchUsers(query);
    } catch (err) {
      setError(getErrorMessage(err, '恢复失败'));
    }
  };

  const handleRevokeAll = async (user: UserPublic) => {
    if (!confirm(`确定要强制下线用户 ${user.username} 吗？`)) return;
    try {
      await revokeUserSessions(user.id);
      setNotice(`已撤销 ${user.username} 的全部会话`);
    } catch (err) {
      setError(getErrorMessage(err, '操作失败'));
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="text"
          value={query.q || ''}
          onChange={(e) => applyQuery({ q: e.target.value, page: 1 })}
          placeholder="搜索用户名/显示名/备注"
          className="w-full sm:w-64"
        />
        <Select value={query.role || 'all'} onValueChange={(value) => applyQuery({ role: value as UserQuery['role'], page: 1 })}>
          <SelectTrigger className="w-auto"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部角色</SelectItem>
            <SelectItem value="admin">管理员</SelectItem>
            <SelectItem value="member">成员</SelectItem>
          </SelectContent>
        </Select>
        <Select value={query.status || 'all'} onValueChange={(value) => applyQuery({ status: value as UserQuery['status'], page: 1 })}>
          <SelectTrigger className="w-auto"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            <SelectItem value="active">启用</SelectItem>
            <SelectItem value="disabled">禁用</SelectItem>
            <SelectItem value="deleted">已删除</SelectItem>
          </SelectContent>
        </Select>
        <Button onClick={() => setShowCreate((v) => !v)}>
          <UserPlus className="w-4 h-4" />
          创建用户
        </Button>
        <Button variant="outline" onClick={() => fetchUsers(query)} disabled={loading}>
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </Button>
      </div>

      {showCreate && (
        <Card className="p-6 space-y-4">
          <h3 className="text-sm font-medium text-foreground">创建新用户</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <Input
              type="text"
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              placeholder="用户名"
              className="text-sm"
            />
            <Input
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="密码（至少8位）"
              className="text-sm"
            />
            <Input
              type="text"
              value={newDisplayName}
              onChange={(e) => setNewDisplayName(e.target.value)}
              placeholder="显示名称（可选）"
              className="text-sm"
            />
            <Select value={newRole} onValueChange={(value) => setNewRole(value as 'admin' | 'member')}>
              <SelectTrigger className="text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">成员</SelectItem>
                {isAdmin && <SelectItem value="admin">管理员</SelectItem>}
              </SelectContent>
            </Select>
            <label className="inline-flex items-center gap-2 text-xs text-slate-600">
              <input
                type="checkbox"
                checked={newMustChange}
                onChange={(e) => setNewMustChange(e.target.checked)}
              />
              下次登录强制改密
            </label>
            <Input
              type="text"
              value={newNotes}
              onChange={(e) => setNewNotes(e.target.value)}
              placeholder="备注（可选）"
              className="text-sm"
            />
          </div>

          {templates.length > 0 && (
            <div>
              <div className="text-xs text-slate-500 mb-1">快捷权限模板</div>
              <div className="flex flex-wrap gap-2">
                {templates
                  .filter((item) => isAdmin || item.role !== 'admin')
                  .map((item) => (
                  <button
                    key={item.key}
                    type="button"
                    onClick={() => {
                      setNewRole(item.role);
                      setNewPermissions(item.permissions);
                    }}
                    className="px-2.5 py-1.5 rounded-md border border-slate-300 text-xs hover:bg-slate-50 cursor-pointer"
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {assignablePermissions.length > 0 && (
            <div>
              <div className="text-xs text-slate-500 mb-1">权限明细</div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {assignablePermissions.map((perm) => (
                  <label key={perm} className="inline-flex items-center gap-2 text-xs text-foreground">
                    <input
                      type="checkbox"
                      checked={newPermissions.includes(perm)}
                      onChange={() => togglePermission(newPermissions, setNewPermissions, perm)}
                    />
                    {PERMISSION_LABELS[perm] || perm}
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <Button onClick={handleCreate} disabled={creating}>
              {creating && <Loader2 className="w-4 h-4 animate-spin" />}
              创建
            </Button>
            <Button variant="outline" onClick={() => setShowCreate(false)}>取消</Button>
          </div>
        </Card>
      )}

      <Card className="divide-y divide-border overflow-hidden">
        {users.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">暂无用户</div>
        ) : (
          users.map((user) => (
            <div key={user.id} className="px-5 py-4 space-y-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-foreground">{user.display_name || user.username}</span>
                    <span className="text-xs text-muted-foreground">@{user.username}</span>
                    <span className={`text-xs px-1.5 py-0.5 rounded ${
                      user.role === 'admin' ? 'bg-brand-100 text-primary' : 'bg-muted text-foreground'
                    }`}>
                      {user.role}
                    </span>
                    {user.status !== 'active' && (
                      <span className={`text-xs px-1.5 py-0.5 rounded ${
                        user.status === 'deleted' ? 'bg-error-bg text-error' : 'bg-warning-bg text-warning'
                      }`}>
                        {user.status}
                      </span>
                    )}
                    {user.must_change_password && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700">
                        需改密
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    最近登录: {user.last_login_at ? new Date(user.last_login_at).toLocaleString('zh-CN') : '-'} · 最后活跃: {user.last_active_at ? new Date(user.last_active_at).toLocaleString('zh-CN') : '-'}
                  </div>
                  {user.notes && <div className="text-xs text-muted-foreground mt-1">备注: {user.notes}</div>}
                  {user.disable_reason && <div className="text-xs text-warning mt-1">禁用原因: {user.disable_reason}</div>}
                </div>

                {canOperateTargetUser(user) && (
                  <div className="flex items-center gap-1">
                    {isAdmin && (
                      <button
                        onClick={() => {
                          const opening = changingPasswordId !== user.id;
                          setChangingPasswordId(opening ? user.id : null);
                          setChangePasswordValue('');
                          if (opening) setEditingId(null);
                        }}
                        className="p-2 hover:bg-muted rounded-lg text-muted-foreground hover:text-indigo-700 cursor-pointer"
                        title="修改密码"
                      >
                        <KeyRound className="w-4 h-4" />
                      </button>
                    )}
                    {user.id !== currentUser?.id && (
                      <>
                        <button
                          onClick={() => startEdit(user)}
                          className="p-2 hover:bg-muted rounded-lg text-muted-foreground hover:text-foreground cursor-pointer"
                          title="编辑"
                        >
                          <Edit3 className="w-4 h-4" />
                        </button>
                        {user.status === 'active' ? (
                          <button
                            onClick={() => changeStatus(user, 'disabled')}
                            className="p-2 hover:bg-muted rounded-lg text-muted-foreground hover:text-warning cursor-pointer"
                            title="禁用"
                          >
                            <ShieldOff className="w-4 h-4" />
                          </button>
                        ) : user.status === 'disabled' ? (
                          <button
                            onClick={() => changeStatus(user, 'active')}
                            className="p-2 hover:bg-muted rounded-lg text-muted-foreground hover:text-primary cursor-pointer"
                            title="启用"
                          >
                            <ShieldCheck className="w-4 h-4" />
                          </button>
                        ) : (
                          <button
                            onClick={() => handleRestore(user)}
                            className="p-2 hover:bg-muted rounded-lg text-muted-foreground hover:text-primary cursor-pointer"
                            title="恢复"
                          >
                            <Undo2 className="w-4 h-4" />
                          </button>
                        )}
                        <button
                          onClick={() => handleRevokeAll(user)}
                          className="p-2 hover:bg-muted rounded-lg text-muted-foreground hover:text-orange-600 cursor-pointer"
                          title="撤销全部会话"
                        >
                          <LogOut className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDelete(user)}
                          className="p-2 hover:bg-muted rounded-lg text-muted-foreground hover:text-error cursor-pointer"
                          title="删除"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>

              {changingPasswordId === user.id && (
                <div className="rounded-lg border border-indigo-200 p-3 bg-indigo-50 flex items-center gap-2">
                  <KeyRound className="w-4 h-4 text-indigo-500 shrink-0" />
                  <Input
                    type="password"
                    value={changePasswordValue}
                    onChange={(e) => setChangePasswordValue(e.target.value)}
                    placeholder="输入新密码"
                    className="flex-1 text-sm h-auto px-2.5 py-1.5"
                    onKeyDown={(e) => e.key === 'Enter' && handleChangePassword(user)}
                  />
                  <Button
                    size="sm"
                    onClick={() => handleChangePassword(user)}
                    disabled={changingPasswordLoading}
                  >
                    {changingPasswordLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                    确认
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => { setChangingPasswordId(null); setChangePasswordValue(''); }}
                  >
                    取消
                  </Button>
                </div>
              )}

              {editingId === user.id && (
                <div className="rounded-lg border border-border p-3 space-y-3 bg-muted/30">
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                    <Input
                      type="text"
                      value={editDisplayName}
                      onChange={(e) => setEditDisplayName(e.target.value)}
                      placeholder="显示名称"
                      className="text-sm h-auto px-2.5 py-1.5"
                    />
                    {isAdmin ? (
                      <Select value={editRole} onValueChange={(value) => setEditRole(value as 'admin' | 'member')}>
                        <SelectTrigger className="text-sm h-auto px-2.5 py-1.5">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="member">member</SelectItem>
                          <SelectItem value="admin">admin</SelectItem>
                        </SelectContent>
                      </Select>
                    ) : (
                      <Input
                        type="text"
                        value={user.role}
                        disabled
                        className="bg-muted px-2.5 py-1.5 text-sm text-slate-500 h-auto"
                      />
                    )}
                    <Input
                      type="password"
                      value={editPassword}
                      onChange={(e) => setEditPassword(e.target.value)}
                      placeholder="重置密码（可选）"
                      className="text-sm h-auto px-2.5 py-1.5"
                    />
                    <Input
                      type="text"
                      value={editDisableReason}
                      onChange={(e) => setEditDisableReason(e.target.value)}
                      placeholder="禁用原因（可选）"
                      className="text-sm h-auto px-2.5 py-1.5"
                    />
                    <Input
                      type="text"
                      value={editNotes}
                      onChange={(e) => setEditNotes(e.target.value)}
                      placeholder="备注（可选）"
                      className="text-sm h-auto px-2.5 py-1.5 md:col-span-2"
                    />
                  </div>
                  {assignablePermissions.length > 0 && (
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                      {assignablePermissions.map((perm) => (
                        <label key={perm} className="inline-flex items-center gap-2 text-xs">
                          <input
                            type="checkbox"
                            checked={editPermissions.includes(perm)}
                            onChange={() => togglePermission(editPermissions, setEditPermissions, perm)}
                          />
                          {PERMISSION_LABELS[perm] || perm}
                        </label>
                      ))}
                    </div>
                  )}
                  <div className="flex gap-2">
                    <Button onClick={() => submitEdit(user)}>保存</Button>
                    <Button variant="outline" onClick={() => setEditingId(null)}>取消</Button>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </Card>

      <div className="flex items-center justify-between text-sm text-slate-600">
        <div>共 {totalUsers} 条</div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => applyQuery({ page: Math.max(1, (query.page || 1) - 1) })}
            disabled={(query.page || 1) <= 1}
          >
            上一页
          </Button>
          <span>第 {page} 页</span>
          <Button
            variant="outline"
            onClick={() => applyQuery({ page: (query.page || 1) + 1 })}
            disabled={page * pageSize >= totalUsers}
          >
            下一页
          </Button>
        </div>
      </div>
    </div>
  );
}
