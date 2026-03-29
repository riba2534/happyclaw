import { useEffect, useState } from 'react';
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
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import type { UserPublic } from '../../stores/auth';
import { useUsersStore, type PermissionTemplateKey } from '../../stores/users';
import { getErrorMessage, ROLE_LABELS, type TabNotification } from './utils';

interface InviteCodesTabProps extends TabNotification {
  currentUser: UserPublic | null;
}

export function InviteCodesTab({ currentUser, setNotice, setError }: InviteCodesTabProps) {
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
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);
  const isAdmin = currentUser?.role === 'admin';

  useEffect(() => {
    void fetchPermissionMeta();
    void fetchInvites();
  }, [fetchInvites, fetchPermissionMeta]);

  const handleCreate = async () => {
    setCreating(true);
    setError(null);
    try {
      const roleForCreate: 'member' | 'admin' = isAdmin ? inviteRole : 'member';
      const templateKey: PermissionTemplateKey = roleForCreate === 'admin' ? 'admin_full' : 'member_basic';
      const payload = {
        role: roleForCreate,
        permission_template: templateKey,
        permissions: [],
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
        <Card>
          <CardContent className="space-y-4">
          <h3 className="text-sm font-medium text-foreground">创建邀请码</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <Label className="text-xs text-muted-foreground mb-1">角色</Label>
              <Select value={inviteRole} onValueChange={(value) => setInviteRole(value as 'member' | 'admin')}>
                <SelectTrigger className="text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="member">{ROLE_LABELS.member}</SelectItem>
                  {isAdmin && <SelectItem value="admin">{ROLE_LABELS.admin}</SelectItem>}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1">最大使用次数</Label>
              <Input
                type="number"
                value={inviteMaxUses}
                onChange={(e) => setInviteMaxUses(parseInt(e.target.value, 10) || 0)}
                min={0}
                max={1000}
                className="text-sm"
              />
              <p className="text-xs text-muted-foreground mt-1">0 = 不限次数</p>
            </div>
            <div>
              <Label className="text-xs text-muted-foreground mb-1">过期时间（小时）</Label>
              <Input
                type="number"
                value={inviteExpiresHours || ''}
                onChange={(e) => setInviteExpiresHours(parseInt(e.target.value, 10) || 0)}
                min={0}
                className="text-sm"
                placeholder="留空 = 永不过期"
              />
            </div>
          </div>

          <div className="flex gap-2">
            <Button onClick={handleCreate} disabled={creating}>
              {creating && <Loader2 className="w-4 h-4 animate-spin" />}
              生成
            </Button>
            <Button variant="outline" onClick={() => setShowCreate(false)}>取消</Button>
          </div>

          {generatedCode && (
            <div className="mt-3 p-3 bg-success-bg border border-success/20 rounded-lg">
              <div className="text-xs text-success mb-1">邀请码已生成（请立即复制）：</div>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-sm font-mono bg-card px-2 py-1 rounded border border-success/20 select-all">
                  {generatedCode}
                </code>
                <button
                  onClick={() => copyToClipboard(generatedCode)}
                  className="p-1.5 hover:bg-success-bg rounded cursor-pointer"
                >
                  <Copy className="w-4 h-4 text-success" />
                </button>
              </div>
            </div>
          )}
          </CardContent>
        </Card>
      )}

      <Card className="divide-y divide-border overflow-hidden">
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
                      <Copy className="w-3.5 h-3.5 text-muted-foreground" />
                    </button>
                    <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-foreground">
                      {ROLE_LABELS[invite.role] || invite.role}
                    </span>
                    {isExpired && <span className="text-xs px-1.5 py-0.5 bg-error-bg text-error rounded">已过期</span>}
                    {isUsedUp && <span className="text-xs px-1.5 py-0.5 bg-orange-100 dark:bg-orange-900/40 text-orange-600 dark:text-orange-400 rounded">已用完</span>}
                  </div>
                  <div className="text-xs text-muted-foreground mt-1">
                    创建者: {invite.creator_username} · 使用: {invite.used_count}/{invite.max_uses || '∞'}
                    {invite.expires_at && ` · 过期: ${new Date(invite.expires_at).toLocaleString('zh-CN')}`}
                  </div>
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
                  className="p-2 hover:bg-muted rounded-lg text-muted-foreground hover:text-error cursor-pointer"
                  title="删除邀请码"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            );
          })
        )}
      </Card>
    </div>
  );
}
