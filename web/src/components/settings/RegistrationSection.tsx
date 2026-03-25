import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

import { api } from '../../api/client';
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
      const data = await api.get<{ allowRegistration: boolean; requireInviteCode: boolean; updatedAt: string | null }>('/api/config/registration');
      setAllowRegistration(data.allowRegistration);
      setRequireInviteCode(data.requireInviteCode);
      setUpdatedAt(data.updatedAt);
    } catch {
      // ignore — keep defaults
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadConfig(); }, [loadConfig]);

  const saveConfig = useCallback(async (allow: boolean, invite: boolean) => {
    setSaving(true);
    try {
      const data = await api.put<{ allowRegistration: boolean; requireInviteCode: boolean; updatedAt: string | null }>('/api/config/registration', {
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
    return <div className="text-sm text-muted-foreground">加载中...</div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-foreground">允许注册</div>
          <div className="text-xs text-muted-foreground mt-0.5">关闭后注册入口不可用</div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={allowRegistration}
          disabled={saving}
          onClick={() => saveConfig(!allowRegistration, requireInviteCode)}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:opacity-50 ${
            allowRegistration ? 'bg-primary' : 'bg-muted-foreground/40'
          }`}
        >
          <span
            className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white dark:bg-foreground shadow ring-0 transition duration-200 ease-in-out ${
              allowRegistration ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </button>
      </div>

      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-foreground">需要邀请码</div>
          <div className="text-xs text-muted-foreground mt-0.5">关闭后任何人可直接注册</div>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={requireInviteCode}
          disabled={saving}
          onClick={() => saveConfig(allowRegistration, !requireInviteCode)}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:opacity-50 ${
            requireInviteCode ? 'bg-primary' : 'bg-muted-foreground/40'
          }`}
        >
          <span
            className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white dark:bg-foreground shadow ring-0 transition duration-200 ease-in-out ${
              requireInviteCode ? 'translate-x-5' : 'translate-x-0'
            }`}
          />
        </button>
      </div>

      <div className="text-xs text-muted-foreground">
        最近保存：{updatedAt ? new Date(updatedAt).toLocaleString('zh-CN') : '未记录'}
      </div>
    </div>
  );
}
