import { useEffect, useMemo, useState } from 'react';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { PageHeader } from '@/components/common/PageHeader';
import { useAuthStore } from '../stores/auth';
import { UserListTab } from '../components/users/UserListTab';
import { InviteCodesTab } from '../components/users/InviteCodesTab';
import { AuditLogTab } from '../components/users/AuditLogTab';

type Tab = 'users' | 'invites' | 'audit';

export function UsersPage() {
  const [tab, setTab] = useState<Tab>('users');
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const currentUser = useAuthStore((s) => s.user);

  const canManageUsers =
    currentUser?.role === 'admin' || !!currentUser?.permissions.includes('manage_users');
  const canManageInvites =
    currentUser?.role === 'admin' || !!currentUser?.permissions.includes('manage_invites');
  const canViewAudit =
    currentUser?.role === 'admin' || !!currentUser?.permissions.includes('view_audit_log');

  const tabs = useMemo(() => {
    const list: Array<{ key: Tab; label: string; visible: boolean }> = [
      { key: 'users', label: '用户列表', visible: canManageUsers },
      { key: 'invites', label: '邀请码', visible: canManageInvites },
      { key: 'audit', label: '审计日志', visible: canViewAudit },
    ];
    return list.filter((item) => item.visible);
  }, [canManageInvites, canManageUsers, canViewAudit]);

  useEffect(() => {
    if (tabs.length === 0) return;
    if (!tabs.some((item) => item.key === tab)) {
      setTab(tabs[0].key);
    }
  }, [tab, tabs]);

  if (tabs.length === 0) {
    return (
      <div className="min-h-full bg-background p-4 lg:p-8">
        <div className="max-w-3xl mx-auto bg-card rounded-xl border border-border p-8 text-sm text-muted-foreground">
          当前账户无用户管理权限。
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full bg-background p-4 lg:p-8">
      <div className="max-w-5xl mx-auto space-y-6">
        <PageHeader
          title="用户管理"
          subtitle="账户、邀请码与审计日志"
        />

        {(notice || error) && (
          <div className="bg-card rounded-xl border border-border p-4 space-y-1">
            {notice && <div className="text-sm text-green-600">{notice}</div>}
            {error && <div className="text-sm text-red-600">{error}</div>}
          </div>
        )}

        <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
          <TabsList>
            {tabs.map((item) => (
              <TabsTrigger key={item.key} value={item.key}>
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>

        {tab === 'users' && canManageUsers && (
          <UserListTab currentUser={currentUser} setNotice={setNotice} setError={setError} />
        )}
        {tab === 'invites' && canManageInvites && (
          <InviteCodesTab currentUser={currentUser} setNotice={setNotice} setError={setError} />
        )}
        {tab === 'audit' && canViewAudit && <AuditLogTab setError={setError} />}
      </div>
    </div>
  );
}
