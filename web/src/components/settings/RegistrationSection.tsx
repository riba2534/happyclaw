import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Switch } from '@/components/ui/switch';
import { api } from '../../api/client';
import { SettingsGroup, SettingsRow, SettingsSection } from './SettingsLayout';
import { getErrorMessage } from './types';

export function RegistrationSection() {
  const [allowRegistration, setAllowRegistration] = useState(true);
  const [requireInviteCode, setRequireInviteCode] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<{
        allowRegistration: boolean;
        requireInviteCode: boolean;
        updatedAt: string | null;
      }>('/api/config/registration');
      setAllowRegistration(data.allowRegistration);
      setRequireInviteCode(data.requireInviteCode);
      setUpdatedAt(data.updatedAt);
    } catch {
      // ignore — keep defaults
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const saveConfig = useCallback(async (allow: boolean, invite: boolean) => {
    setSaving(true);
    try {
      const data = await api.put<{
        allowRegistration: boolean;
        requireInviteCode: boolean;
        updatedAt: string | null;
      }>('/api/config/registration', {
        allowRegistration: allow,
        requireInviteCode: invite,
      });
      setAllowRegistration(data.allowRegistration);
      setRequireInviteCode(data.requireInviteCode);
      setUpdatedAt(data.updatedAt);
      toast.success('注册配置已保存');
    } catch (err) {
      toast.error(getErrorMessage(err, '保存注册配置失败'));
    } finally {
      setSaving(false);
    }
  }, []);

  if (loading) {
    return (
      <SettingsGroup>
        <div className="flex items-center justify-center gap-2 py-8 text-body text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          加载中...
        </div>
      </SettingsGroup>
    );
  }

  return (
    <SettingsSection
      title="用户注册"
      description={
        <>
          最近保存：
          {updatedAt ? new Date(updatedAt).toLocaleString('zh-CN') : '未记录'}
        </>
      }
    >
      <SettingsGroup>
        <SettingsRow
          label="允许注册"
          htmlFor="registration-allow"
          description="关闭后注册入口不可用"
          control={
            <Switch
              id="registration-allow"
              checked={allowRegistration}
              disabled={saving}
              onCheckedChange={(checked) =>
                saveConfig(checked, requireInviteCode)
              }
            />
          }
        />
        <SettingsRow
          label="需要邀请码"
          htmlFor="registration-invite"
          description={
            allowRegistration
              ? '关闭后任何人都可以直接注册'
              : '注册已关闭；该规则会在重新开放注册后继续生效'
          }
          control={
            <Switch
              id="registration-invite"
              checked={requireInviteCode}
              disabled={saving || !allowRegistration}
              onCheckedChange={(checked) =>
                saveConfig(allowRegistration, checked)
              }
            />
          }
        />
      </SettingsGroup>
    </SettingsSection>
  );
}
