import { useEffect, useMemo, useState } from 'react';
import {
  Edit3,
  KeyRound,
  LogOut,
  MoreHorizontal,
  RefreshCw,
  ShieldCheck,
  ShieldOff,
  Trash2,
  Undo2,
  UserPlus,
  Users,
} from 'lucide-react';
import {
  DataTable,
  EmptyState,
  IconButton,
  SearchInput,
  type DataTableColumn,
} from '@/components/common';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirm';
import type { UserPublic } from '../../stores/auth';
import { useUsersStore, type UserQuery } from '../../stores/users';
import {
  CreateUserDialog,
  EditUserDialog,
  ResetPasswordDialog,
} from './UserDialogs';
import {
  formatDateTime,
  getErrorMessage,
  ROLE_LABELS,
  type TabNotification,
} from './utils';

interface UserListTabProps extends TabNotification {
  currentUser: UserPublic | null;
}

function RoleBadge({ role }: { role: UserPublic['role'] }) {
  return (
    <Badge variant="outline" dot={role === 'admin' ? 'primary' : 'muted'}>
      {ROLE_LABELS[role] || role}
    </Badge>
  );
}

function StatusBadges({ user }: { user: UserPublic }) {
  const status = STATUS_BADGES[user.status];
  return (
    <>
      <Badge variant="outline" dot={status?.dot ?? 'muted'}>
        {status?.label ?? user.status}
      </Badge>
      {user.must_change_password && <Badge variant="warning">需改密</Badge>}
    </>
  );
}

const STATUS_BADGES: Record<
  UserPublic['status'],
  { label: string; dot: 'success' | 'warning' | 'error' }
> = {
  active: { label: '启用', dot: 'success' },
  disabled: { label: '禁用', dot: 'warning' },
  deleted: { label: '已删除', dot: 'error' },
};

export function UserListTab({
  currentUser,
  setNotice,
  setError,
}: UserListTabProps) {
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
    updateUser,
    deleteUser,
    restoreUser,
    revokeUserSessions,
  } = useUsersStore();

  const [query, setQuery] = useState<UserQuery>({
    q: '',
    role: 'all',
    status: 'all',
    page: 1,
    pageSize: 20,
  });
  const [showCreate, setShowCreate] = useState(false);
  const [editingUser, setEditingUser] = useState<UserPublic | null>(null);
  const [passwordUser, setPasswordUser] = useState<UserPublic | null>(null);
  const isAdmin = currentUser?.role === 'admin';
  const ownPermissions = useMemo(
    () => currentUser?.permissions || [],
    [currentUser?.permissions],
  );
  const canOperateTargetUser = (user: UserPublic) =>
    isAdmin || user.role !== 'admin';
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

  const startEdit = (user: UserPublic) => {
    if (!canOperateTargetUser(user)) {
      setError('当前账户不能编辑管理员用户');
      return;
    }
    setPasswordUser(null);
    setEditingUser(user);
  };

  const changeStatus = async (
    user: UserPublic,
    status: 'active' | 'disabled' | 'deleted',
  ) => {
    try {
      await updateUser(user.id, {
        status,
        disable_reason:
          status === 'disabled'
            ? user.disable_reason || 'disabled_by_admin'
            : null,
      });
      setNotice(`用户 ${user.username} 状态已更新`);
      await fetchUsers(query);
    } catch (err) {
      setError(getErrorMessage(err, '更新状态失败'));
    }
  };

  const handleDelete = async (user: UserPublic) => {
    const confirmed = await confirmDialog({
      title: '删除用户',
      message: `确定要删除用户 ${user.username} 吗？`,
      confirmText: '删除',
      variant: 'danger',
    });
    if (!confirmed) return;
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
    const confirmed = await confirmDialog({
      title: '撤销全部会话',
      message: `确定要强制下线用户 ${user.username} 吗？`,
      confirmText: '强制下线',
      variant: 'danger',
    });
    if (!confirmed) return;
    try {
      await revokeUserSessions(user.id);
      setNotice(`已撤销 ${user.username} 的全部会话`);
    } catch (err) {
      setError(getErrorMessage(err, '操作失败'));
    }
  };

  const renderActions = (user: UserPublic) => {
    if (!canOperateTargetUser(user)) return null;
    const isSelf = user.id === currentUser?.id;
    if (!isAdmin && isSelf) return null;
    return (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton
            label={`${user.display_name || user.username} 的操作`}
            icon={<MoreHorizontal />}
            hideTooltip
          />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          {isAdmin && (
            <DropdownMenuItem
              onSelect={() => {
                setEditingUser(null);
                setPasswordUser(user);
              }}
            >
              <KeyRound />
              修改密码
            </DropdownMenuItem>
          )}
          {!isSelf && (
            <>
              <DropdownMenuItem onSelect={() => startEdit(user)}>
                <Edit3 />
                编辑
              </DropdownMenuItem>
              {user.status === 'active' ? (
                <DropdownMenuItem
                  onSelect={() => void changeStatus(user, 'disabled')}
                >
                  <ShieldOff />
                  禁用
                </DropdownMenuItem>
              ) : user.status === 'disabled' ? (
                <DropdownMenuItem
                  onSelect={() => void changeStatus(user, 'active')}
                >
                  <ShieldCheck />
                  启用
                </DropdownMenuItem>
              ) : (
                <DropdownMenuItem onSelect={() => void handleRestore(user)}>
                  <Undo2 />
                  恢复
                </DropdownMenuItem>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => void handleRevokeAll(user)}>
                <LogOut />
                撤销全部会话
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => void handleDelete(user)}
              >
                <Trash2 />
                删除
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    );
  };

  const columns: DataTableColumn<UserPublic>[] = [
    {
      key: 'user',
      header: '用户',
      cell: (user) => (
        <div className="max-w-60 min-w-0 whitespace-normal sm:max-w-72">
          <div className="flex min-w-0 items-baseline gap-1.5">
            <span className="truncate font-medium text-foreground">
              {user.display_name || user.username}
            </span>
            <span className="shrink-0 text-caption text-muted-foreground">
              @{user.username}
            </span>
          </div>
          {user.notes && (
            <div className="mt-0.5 truncate text-caption text-muted-foreground">
              备注: {user.notes}
            </div>
          )}
          {user.disable_reason && (
            <div className="mt-0.5 truncate text-caption text-warning">
              禁用原因: {user.disable_reason}
            </div>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-1 sm:hidden">
            <RoleBadge role={user.role} />
            <StatusBadges user={user} />
          </div>
        </div>
      ),
    },
    {
      key: 'role',
      header: '角色',
      cell: (user) => <RoleBadge role={user.role} />,
      className: 'hidden sm:table-cell',
      headerClassName: 'hidden sm:table-cell',
    },
    {
      key: 'status',
      header: '状态',
      cell: (user) => (
        <div className="flex flex-wrap items-center gap-1">
          <StatusBadges user={user} />
        </div>
      ),
      className: 'hidden sm:table-cell',
      headerClassName: 'hidden sm:table-cell',
    },
    {
      key: 'last-login',
      header: '最近登录',
      cell: (user) => formatDateTime(user.last_login_at),
      className:
        'hidden text-caption text-muted-foreground tabular-nums md:table-cell',
      headerClassName: 'hidden md:table-cell',
    },
    {
      key: 'last-active',
      header: '最后活跃',
      cell: (user) => formatDateTime(user.last_active_at),
      className:
        'hidden text-caption text-muted-foreground tabular-nums lg:table-cell',
      headerClassName: 'hidden lg:table-cell',
    },
    {
      key: 'actions',
      header: <span className="sr-only">操作</span>,
      cell: renderActions,
      align: 'right',
      className: 'w-12',
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SearchInput
          value={query.q || ''}
          onChange={(value) => applyQuery({ q: value, page: 1 })}
          placeholder="搜索用户名/显示名/备注"
          className="w-full sm:w-64"
        />
        <Select
          value={query.role || 'all'}
          onValueChange={(value) =>
            applyQuery({ role: value as UserQuery['role'], page: 1 })
          }
        >
          <SelectTrigger className="w-auto" aria-label="角色筛选">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部角色</SelectItem>
            <SelectItem value="admin">管理员</SelectItem>
            <SelectItem value="member">成员</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={query.status || 'all'}
          onValueChange={(value) =>
            applyQuery({ status: value as UserQuery['status'], page: 1 })
          }
        >
          <SelectTrigger className="w-auto" aria-label="状态筛选">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">全部状态</SelectItem>
            <SelectItem value="active">启用</SelectItem>
            <SelectItem value="disabled">禁用</SelectItem>
            <SelectItem value="deleted">已删除</SelectItem>
          </SelectContent>
        </Select>
        <div className="ml-auto flex items-center gap-2">
          <IconButton
            label="刷新"
            variant="outline"
            size="icon"
            icon={<RefreshCw className={cn(loading && 'animate-spin')} />}
            onClick={() => fetchUsers(query)}
            disabled={loading}
          />
          <Button onClick={() => setShowCreate(true)}>
            <UserPlus />
            创建用户
          </Button>
        </div>
      </div>

      <DataTable
        columns={columns}
        rows={users}
        rowKey={(user) => user.id}
        loading={loading}
        empty={<EmptyState icon={Users} title="暂无用户" />}
      />

      <div className="flex items-center justify-between gap-2 text-caption text-muted-foreground">
        <div className="tabular-nums">共 {totalUsers} 条</div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              applyQuery({ page: Math.max(1, (query.page || 1) - 1) })
            }
            disabled={(query.page || 1) <= 1}
          >
            上一页
          </Button>
          <span className="tabular-nums">第 {page} 页</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => applyQuery({ page: (query.page || 1) + 1 })}
            disabled={page * pageSize >= totalUsers}
          >
            下一页
          </Button>
        </div>
      </div>

      <CreateUserDialog
        open={showCreate}
        onOpenChange={setShowCreate}
        isAdmin={isAdmin}
        ownPermissions={ownPermissions}
        templates={templates}
        assignablePermissions={assignablePermissions}
        onCreated={async () => {
          setError(null);
          setNotice('用户创建成功');
          await fetchUsers(query);
        }}
      />
      <EditUserDialog
        user={editingUser}
        onOpenChange={(open) => {
          if (!open) setEditingUser(null);
        }}
        isAdmin={isAdmin}
        ownPermissions={ownPermissions}
        assignablePermissions={assignablePermissions}
        onDone={async (message, refresh) => {
          setError(null);
          setNotice(message);
          if (refresh) await fetchUsers(query);
        }}
      />
      <ResetPasswordDialog
        user={passwordUser}
        onOpenChange={(open) => {
          if (!open) setPasswordUser(null);
        }}
        onSaved={async (message) => {
          setError(null);
          setNotice(message);
          void fetchUsers(query);
        }}
      />
    </div>
  );
}
