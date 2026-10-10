import { useEffect, useState, type FormEvent } from 'react';
import {
  Copy,
  Key,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Ticket,
  Trash2,
} from 'lucide-react';
import {
  DataTable,
  EmptyState,
  IconButton,
  type DataTableColumn,
} from '@/components/common';
import { SettingsField } from '@/components/settings/SettingsLayout';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
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
import {
  useUsersStore,
  type InviteCode,
  type PermissionTemplateKey,
} from '../../stores/users';
import {
  formatDateTime,
  getErrorMessage,
  ROLE_LABELS,
  type TabNotification,
} from './utils';
import { RoleBadge } from './UserListTab';

interface InviteCodesTabProps extends TabNotification {
  currentUser: UserPublic | null;
}

function InviteStatusBadge({ invite }: { invite: InviteCode }) {
  const isExpired =
    invite.expires_at && new Date(invite.expires_at).getTime() < Date.now();
  const isUsedUp = invite.max_uses > 0 && invite.used_count >= invite.max_uses;
  if (isExpired) {
    return (
      <Badge variant="outline" dot="error">
        已过期
      </Badge>
    );
  }
  if (isUsedUp) {
    return (
      <Badge variant="outline" dot="warning">
        已用完
      </Badge>
    );
  }
  return (
    <Badge variant="outline" dot="success">
      有效
    </Badge>
  );
}

export function InviteCodesTab({
  currentUser,
  setNotice,
  setError,
}: InviteCodesTabProps) {
  const {
    invites,
    loading,
    fetchPermissionMeta,
    fetchInvites,
    createInvite,
    deleteInvite,
  } = useUsersStore();

  const [showCreate, setShowCreate] = useState(false);
  const [inviteRole, setInviteRole] = useState<'member' | 'admin'>('member');
  const [inviteMaxUses, setInviteMaxUses] = useState(1);
  const [inviteExpiresHours, setInviteExpiresHours] = useState(0);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);
  const isAdmin = currentUser?.role === 'admin';

  useEffect(() => {
    void fetchPermissionMeta();
    void fetchInvites();
  }, [fetchInvites, fetchPermissionMeta]);

  const openCreate = () => {
    setGeneratedCode(null);
    setCreateError(null);
    setShowCreate(true);
  };

  const handleCreate = async (event?: FormEvent) => {
    event?.preventDefault();
    setCreating(true);
    setError(null);
    setCreateError(null);
    try {
      const roleForCreate: 'member' | 'admin' = isAdmin ? inviteRole : 'member';
      const templateKey: PermissionTemplateKey =
        roleForCreate === 'admin' ? 'admin_full' : 'member_basic';
      const payload = {
        role: roleForCreate,
        permission_template: templateKey,
        permissions: [],
        max_uses: inviteMaxUses,
        expires_in_hours:
          inviteExpiresHours > 0 ? inviteExpiresHours : undefined,
      };
      const code = await createInvite(payload);
      setGeneratedCode(code);
      setNotice('邀请码已创建');
      await fetchInvites();
    } catch (err) {
      setCreateError(getErrorMessage(err, '创建邀请码失败'));
    } finally {
      setCreating(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(() => setNotice('已复制到剪贴板'));
  };

  const handleDelete = async (invite: InviteCode) => {
    const confirmed = await confirmDialog({
      title: '作废邀请码',
      message: '确定要作废这个邀请码吗？',
      confirmText: '作废',
      variant: 'danger',
    });
    if (!confirmed) return;
    try {
      await deleteInvite(invite.code);
      setNotice('邀请码已删除');
      await fetchInvites();
    } catch (err) {
      setError(getErrorMessage(err, '删除失败'));
    }
  };

  const columns: DataTableColumn<InviteCode>[] = [
    {
      key: 'code',
      header: '邀请码',
      cell: (invite) => (
        <div>
          <code className="font-mono text-caption text-foreground">
            {invite.code.slice(0, 12)}...
          </code>
          <div className="mt-1 flex items-center gap-1.5 text-caption text-muted-foreground tabular-nums sm:hidden">
            <RoleBadge role={invite.role} />
            {invite.used_count}/{invite.max_uses || '∞'}
          </div>
        </div>
      ),
    },
    {
      key: 'role',
      header: '角色',
      cell: (invite) => <RoleBadge role={invite.role} />,
      className: 'hidden sm:table-cell',
      headerClassName: 'hidden sm:table-cell',
    },
    {
      key: 'status',
      header: '状态',
      cell: (invite) => <InviteStatusBadge invite={invite} />,
    },
    {
      key: 'uses',
      header: '使用',
      cell: (invite) => `${invite.used_count}/${invite.max_uses || '∞'}`,
      className: 'hidden tabular-nums text-muted-foreground sm:table-cell',
      headerClassName: 'hidden sm:table-cell',
    },
    {
      key: 'creator',
      header: '创建者',
      cell: (invite) => invite.creator_username,
      className: 'hidden text-muted-foreground sm:table-cell',
      headerClassName: 'hidden sm:table-cell',
    },
    {
      key: 'expires',
      header: '过期',
      cell: (invite) => formatDateTime(invite.expires_at),
      className:
        'hidden text-caption text-muted-foreground tabular-nums md:table-cell',
      headerClassName: 'hidden md:table-cell',
    },
    {
      key: 'actions',
      header: <span className="sr-only">操作</span>,
      align: 'right',
      className: 'w-12',
      cell: (invite) => (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton
              label="邀请码操作"
              icon={<MoreHorizontal />}
              hideTooltip
            />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-36">
            <DropdownMenuItem onSelect={() => copyToClipboard(invite.code)}>
              <Copy />
              复制邀请码
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => void handleDelete(invite)}
            >
              <Trash2 />
              删除邀请码
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end gap-2">
        <IconButton
          label="刷新"
          variant="outline"
          size="icon"
          icon={<RefreshCw className={cn(loading && 'animate-spin')} />}
          onClick={() => fetchInvites()}
          disabled={loading}
        />
        <Button onClick={openCreate}>
          <Key />
          创建邀请码
        </Button>
      </div>

      <DataTable
        columns={columns}
        rows={invites}
        rowKey={(invite) => invite.code}
        loading={loading}
        empty={<EmptyState icon={Ticket} title="暂无邀请码" />}
      />

      <Dialog open={showCreate} onOpenChange={setShowCreate}>
        <DialogContent className="sm:max-w-lg">
          <form onSubmit={handleCreate} className="grid gap-4">
            <DialogHeader>
              <DialogTitle>创建邀请码</DialogTitle>
              <DialogDescription>
                邀请码按角色套用默认权限模板。
              </DialogDescription>
            </DialogHeader>

            {createError && (
              <div
                role="alert"
                className="rounded-lg bg-error/10 px-3 py-2 text-body text-error"
              >
                {createError}
              </div>
            )}

            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <SettingsField label="角色" htmlFor="invite-role">
                <Select
                  value={inviteRole}
                  onValueChange={(value) =>
                    setInviteRole(value as 'member' | 'admin')
                  }
                >
                  <SelectTrigger id="invite-role" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="member">{ROLE_LABELS.member}</SelectItem>
                    {isAdmin && (
                      <SelectItem value="admin">{ROLE_LABELS.admin}</SelectItem>
                    )}
                  </SelectContent>
                </Select>
              </SettingsField>
              <SettingsField
                label="最大使用次数"
                htmlFor="invite-max-uses"
                description="0 = 不限次数"
              >
                <Input
                  id="invite-max-uses"
                  type="number"
                  value={inviteMaxUses}
                  onChange={(e) =>
                    setInviteMaxUses(parseInt(e.target.value, 10) || 0)
                  }
                  min={0}
                  max={1000}
                />
              </SettingsField>
              <SettingsField label="过期时间（小时）" htmlFor="invite-expires">
                <Input
                  id="invite-expires"
                  type="number"
                  value={inviteExpiresHours || ''}
                  onChange={(e) =>
                    setInviteExpiresHours(parseInt(e.target.value, 10) || 0)
                  }
                  min={0}
                  placeholder="留空 = 永不过期"
                />
              </SettingsField>
            </div>

            {generatedCode && (
              <div className="rounded-lg bg-success/10 p-3">
                <div className="mb-1.5 text-caption text-success">
                  邀请码已生成（请立即复制）：
                </div>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded-md bg-surface-raised px-2 py-1 font-mono text-body ring-1 ring-surface-border select-all">
                    {generatedCode}
                  </code>
                  <IconButton
                    label="复制邀请码"
                    icon={<Copy />}
                    onClick={() => copyToClipboard(generatedCode)}
                  />
                </div>
              </div>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowCreate(false)}
              >
                {generatedCode ? '关闭' : '取消'}
              </Button>
              <Button type="submit" disabled={creating}>
                {creating && <Loader2 className="animate-spin" />}
                生成
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
