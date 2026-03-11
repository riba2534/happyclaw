import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { api } from '../../api/client';
import type { SettingsNotification } from './types';
import { getErrorMessage } from './types';

interface UserFeishuConfig {
  appId: string;
  hasAppSecret: boolean;
  appSecretMasked: string | null;
  enabled: boolean;
  connected: boolean;
  updatedAt: string | null;
}

interface FeishuChannelCardProps extends SettingsNotification {}

export function FeishuChannelCard({ setNotice, setError }: FeishuChannelCardProps) {
  const [config, setConfig] = useState<UserFeishuConfig | null>(null);
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);

  const enabled = config?.enabled ?? false;

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<UserFeishuConfig>('/api/config/user-im/feishu');
      setConfig(data);
      setAppId(data.appId || '');
      setAppSecret('');
    } catch {
      setConfig(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  const handleToggle = async (newEnabled: boolean) => {
    setToggling(true);
    setNotice(null);
    setError(null);
    try {
      const data = await api.put<UserFeishuConfig>('/api/config/user-im/feishu', { enabled: newEnabled });
      setConfig(data);
      setNotice(`飞书渠道已${newEnabled ? '启用' : '停用'}`);
    } catch (err) {
      setError(getErrorMessage(err, '切换飞书渠道状态失败'));
    } finally {
      setToggling(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const id = appId.trim();
      const secret = appSecret.trim();

      if (id && !secret && !config?.hasAppSecret) {
        setError('首次配置飞书需要同时提供 App ID 和 App Secret');
        setSaving(false);
        return;
      }

      if (!id && !secret) {
        if (config?.appId || config?.hasAppSecret) {
          setNotice('飞书配置未变更');
        } else {
          setError('请填写飞书 App ID 和 App Secret');
        }
        setSaving(false);
        return;
      }

      const payload: Record<string, string | boolean> = { enabled: true };
      if (id) payload.appId = id;
      if (secret) payload.appSecret = secret;
      const data = await api.put<UserFeishuConfig>('/api/config/user-im/feishu', payload);
      setConfig(data);
      setAppSecret('');
      setNotice('飞书配置已保存');
    } catch (err) {
      setError(getErrorMessage(err, '保存飞书配置失败'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 bg-slate-50/50">
        <div className="flex items-center gap-2">
          <span className={`inline-block w-2 h-2 rounded-full ${config?.connected ? 'bg-emerald-500' : 'bg-slate-300'}`} />
          <div>
            <h3 className="text-sm font-semibold text-slate-800">飞书 Feishu</h3>
            <p className="text-xs text-slate-500 mt-0.5">接收飞书群消息并通过 Agent 自动回复</p>
          </div>
        </div>
        <ToggleSwitch checked={enabled} disabled={loading || toggling} onChange={handleToggle} />
      </div>

      <div className={`px-5 py-4 space-y-4 transition-opacity ${!enabled ? 'opacity-50 pointer-events-none' : ''}`}>
        {loading ? (
          <div className="text-sm text-slate-500">加载中...</div>
        ) : (
          <>
            {config?.hasAppSecret && (
              <div className="text-xs text-slate-500">
                当前 Secret: {config.appSecretMasked || '已配置'}
              </div>
            )}
            <div className="grid md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-500 mb-1">App ID</label>
                <Input
                  type="text"
                  value={appId}
                  onChange={(e) => setAppId(e.target.value)}
                  placeholder="输入飞书 App ID"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">App Secret</label>
                <Input
                  type="password"
                  value={appSecret}
                  onChange={(e) => setAppSecret(e.target.value)}
                  placeholder={config?.hasAppSecret ? '留空不修改' : '输入飞书 App Secret'}
                />
              </div>
            </div>
            <div>
              <Button onClick={handleSave} disabled={saving}>
                {saving && <Loader2 className="size-4 animate-spin" />}
                保存飞书配置
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
