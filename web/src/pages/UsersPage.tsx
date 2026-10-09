import { useEffect, useMemo, useState } from 'react';
import { ShieldOff } from 'lucide-react';
import { EmptyState, PageContainer, PageHeader } from '@/components/common';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
    currentUser?.role === 'admin' ||
    !!currentUser?.permissions.includes('manage_users');
  const canManageInvites =
    currentUser?.role === 'admin' ||
    !!currentUser?.permissions.includes('manage_invites');
  const canViewAudit =
    currentUser?.role === 'admin' ||
    !!currentUser?.permissions.includes('view_audit_log');

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
      <PageContainer size="narrow">
        <div className="rounded-xl bg-surface-raised ring-1 ring-surface-border">
          <EmptyState icon={ShieldOff} title="当前账户无用户管理权限。" />
        </div>
      </PageContainer>
    );
  }

  return (
    <PageContainer className="space-y-5">
      <PageHeader title="用户管理" subtitle="账户、邀请码与审计日志" />

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <div className="border-b border-surface-border">
          <TabsList variant="line" className="-mb-px">
            {tabs.map((item) => (
              <TabsTrigger key={item.key} value={item.key}>
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
      </Tabs>

      {(notice || error) && (
        <div className="space-y-2">
          {notice && (
            <div
              role="status"
              className="rounded-lg bg-success/10 px-3 py-2 text-body text-success"
            >
              {notice}
            </div>
          )}
          {error && (
            <div
              role="alert"
              className="rounded-lg bg-error/10 px-3 py-2 text-body text-error"
            >
              {error}
            </div>
          )}
        </div>
      )}

      {tab === 'users' && canManageUsers && (
        <UserListTab
          currentUser={currentUser}
          setNotice={setNotice}
          setError={setError}
        />
      )}
      {tab === 'invites' && canManageInvites && (
        <InviteCodesTab
          currentUser={currentUser}
          setNotice={setNotice}
          setError={setError}
        />
      )}
      {tab === 'audit' && canViewAudit && <AuditLogTab setError={setError} />}
    </PageContainer>
  );
}
