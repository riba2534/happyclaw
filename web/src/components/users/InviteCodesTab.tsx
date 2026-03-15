import { useEffect, useMemo, useState } from 'react';
import { Copy, Key, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { Permission, UserPublic } from '../../stores/auth';
import { useUsersStore, type PermissionTemplateKey } from '../../stores/users';
import { getErrorMessage, PERMISSION_LABELS, type TabNotification } from './utils';

interface InviteCodesTabProps extends TabNotification {
  currentUser: UserPublic | null;
}

export function InviteCodesTab({ currentUser, setNotice, setError }: InviteCodesTabProps) {
  const {
    invites,
    loading,
    permissions,
    templates,
    fetchPermissionMeta,
    fetchInvites,
    createInvite,
    deleteInvite,
  } = useUsersStore();

  const [showCreate, setShowCreate] = useState(false);
  const [inviteRole, setInviteRole] = useState<'member' | 'admin'>('member');
  const [inviteTemplate, setInviteTemplate] = useState<PermissionTemplateKey | ''>('member_basic');
  const [invitePermissions, setInvitePermissions] = useState<Permission[]>([]);
  const [inviteMaxUses, setInviteMaxUses] = useState(1);
  const [inviteExpiresHours, setInviteExpiresHours] = useState(0);
  const [creating, setCreating] = useState(false);
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);
  const isAdmin = currentUser?.role === 'admin';
  const ownPermissions = currentUser?.permissions || [];
  const assignablePermissions = useMemo(() => {
    if (isAdmin) return permissions;
    const ownSet = new Set(ownPermissions);
    return permissions.filter((perm) => ownSet.has(perm));
  }, [isAdmin, ownPermissions, permissions]);
  const availableTemplates = useMemo(
    () =>
      templates.filter((item) => {
        if (item.role === 'admin' && !isAdmin) return false;
        if (isAdmin) return true;
        return item.permissions.every((perm) => ownPermissions.includes(perm));
      }),
    [isAdmin, ownPermissions, templates],
  );

  useEffect(() => {
    void fetchPermissionMeta();
    void fetchInvites();
  }, [fetchInvites, fetchPermissionMeta]);

  useEffect(() => {
    if (!inviteTemplate) return;
    const allowed = availableTemplates.some((item) => item.key === inviteTemplate);
    if (!allowed) setInviteTemplate('');
  }, [availableTemplates, inviteTemplate]);

  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    try {
      const roleForCreate: 'member' | 'admin' = isAdmin ? inviteRole : 'member';
      const permissionsForCreate = isAdmin
        ? invitePermissions
        : invitePermissions.filter((perm) => ownPermissions.includes(perm));
      const templateForCreate = inviteTemplate
        ? availableTemplates.find((item) => item.key === inviteTemplate)?.key
        : undefined;
      const payload = {
        role: roleForCreate,
        permission_template: templateForCreate,
        permissions: permissionsForCreate,
        max_uses: inviteMaxUses,
        expires_in_hours: inviteExpiresHours > 0 ? inviteExpiresHours : undefined,
      };
      const code = await createInvite(payload);
      setGeneratedCode(code);
      setNotice('邀请码已创建');
      await fetchInvites();
    } catch (err) {
      setError(getErrorMessage(err, '创建邀请码失败'));
    } finally {
      setCreating(false);
    }
  };

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(() => setNotice('已复制到剪贴板'));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Button onClick={() => { setShowCreate((v) => !v); setGeneratedCode(null); }}>
          <Key className="w-4 h-4" />
          创建邀请码
        </Button>
        <Button variant="outline" onClick={() => fetchInvites()} disabled={loading}>
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          刷新
        </Button>
      </div>

      {showCreate && (
        <div className="bg-card rounded-xl border border-border p-6 space-y-4">
          <h3 className="text-sm font-medium text-foreground">创建邀请码</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <Select
              value={inviteTemplate}
              onValueChange={(value) => {
                const v = value === 'none' ? '' : value as PermissionTemplateKey;
                setInviteTemplate(v as PermissionTemplateKey | '');
                if (!v) return;
                const template = availableTemplates.find((item) => item.key === v);
                if (!template) return;
                setInviteRole(template.role);
                setInvitePermissions(template.permissions);
              }}
            >
              <SelectTrigger className="text-sm">
                <SelectValue placeholder="不使用模板" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">不使用模板</SelectItem>
                {availableTemplates.map((item) => (
                  <SelectItem key={item.key} value={item.key}>{item.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={inviteRole} onValueChange={(value) => setInviteRole(value as 'member' | 'admin')}>
              <SelectTrigger className="text-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">member</SelectItem>
                {isAdmin && <SelectItem value="admin">admin</SelectItem>}
              </SelectContent>
            </Select>
            <Input
              type="number"
              value={inviteMaxUses}
              onChange={(e) => setInviteMaxUses(parseInt(e.target.value, 10) || 0)}
              min={0}
              max={1000}
              className="text-sm"
              placeholder="最大使用次数"
            />
            <Input
              type="number"
              value={inviteExpiresHours}
              onChange={(e) => setInviteExpiresHours(parseInt(e.target.value, 10) || 0)}
              min={0}
              className="text-sm md:col-span-3"
              placeholder="过期小时（0=永不过期）"
            />
          </div>

          {assignablePermissions.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {assignablePermissions.map((perm) => (
                <label key={perm} className="inline-flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={invitePermissions.includes(perm)}
                    onChange={() => {
                      if (invitePermissions.includes(perm)) {
                        setInvitePermissions(invitePermissions.filter((item) => item !== perm));
                      } else {
                        setInvitePermissions([...invitePermissions, perm]);
                      }
                    }}
                  />
                  {PERMISSION_LABELS[perm] || perm}
                </label>
              ))}
            </div>
          )}

          <div className="flex gap-2">
            <Button onClick={handleCreate} disabled={creating}>
              {creating && <Loader2 className="w-4 h-4 animate-spin" />}
              生成
            </Button>
            <Button variant="outline" onClick={() => setShowCreate(false)}>取消</Button>
          </div>

          {generatedCode && (
            <div className="mt-3 p-3 bg-green-50 border border-green-200 rounded-lg">
              <div className="text-xs text-green-700 mb-1">邀请码已生成（请立即复制）：</div>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-sm font-mono bg-card px-2 py-1 rounded border border-green-200 select-all">
                  {generatedCode}
                </code>
                <button
                  onClick={() => copyToClipboard(generatedCode)}
                  className="p-1.5 hover:bg-green-100 rounded cursor-pointer"
                >
                  <Copy className="w-4 h-4 text-green-700" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="bg-card rounded-xl border border-border divide-y divide-border overflow-hidden">
        {invites.length === 0 ? (
          <div className="p-6 text-center text-sm text-muted-foreground">暂无邀请码</div>
        ) : (
          invites.map((invite) => {
            const isExpired = invite.expires_at && new Date(invite.expires_at).getTime() < Date.now();
            const isUsedUp = invite.max_uses > 0 && invite.used_count >= invite.max_uses;
            return (
              <div key={invite.code} className="flex items-center justify-between px-6 py-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <code className="text-sm font-mono text-foreground">{invite.code.slice(0, 12)}...</code>
                    <button
                      onClick={() => copyToClipboard(invite.code)}
                      className="p-1 hover:bg-muted rounded cursor-pointer"
                    >
                      <Copy className="w-3.5 h-3.5 text-muted-foreground/60" />
                    </button>
                    <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-foreground">
                      {invite.role}
                    </span>
                    {invite.permission_template && (
                      <span className="text-xs px-1.5 py-0.5 rounded bg-primary/10 text-primary">
                        {invite.permission_template}
                      </span>
                    )}
                    {isExpired && <span className="text-xs px-1.5 py-0.5 bg-red-100 text-red-600 rounded">已过期</span>}
                    {isUsedUp && <span className="text-xs px-1.5 py-0.5 bg-orange-100 text-orange-600 rounded">已用完</span>}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    创建者: {invite.creator_username} · 使用: {invite.used_count}/{invite.max_uses || '∞'}
                    {invite.expires_at && ` · 过期: ${new Date(invite.expires_at).toLocaleString('zh-CN')}`}
                  </div>
                  {invite.permissions.length > 0 && (
                    <div className="text-xs text-muted-foreground mt-1">权限: {invite.permissions.join(', ')}</div>
                  )}
                </div>
                <button
                  onClick={async () => {
                    if (!confirm('确定要作废这个邀请码吗？')) return;
                    try {
                      await deleteInvite(invite.code);
                      setNotice('邀请码已删除');
                      await fetchInvites();
                    } catch (err) {
                      setError(getErrorMessage(err, '删除失败'));
                    }
                  }}
                  className="p-2 hover:bg-muted rounded-lg text-muted-foreground hover:text-red-600 cursor-pointer"
                  title="删除邀请码"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
