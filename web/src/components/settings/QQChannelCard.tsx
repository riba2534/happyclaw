import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { api } from '../../api/client';
import { getErrorMessage } from './types';
import { usePairingCode } from './hooks/usePairingCode';
import { usePairedChats } from './hooks/usePairedChats';
import { PairingSection } from './PairingSection';

interface UserQQConfig {
  appId: string;
  hasAppSecret: boolean;
  appSecretMasked: string | null;
  enabled: boolean;
  connected: boolean;
  updatedAt: string | null;
}

export function QQChannelCard() {
  const [config, setConfig] = useState<UserQQConfig | null>(null);
  const [appId, setAppId] = useState('');
  const [appSecret, setAppSecret] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [toggling, setToggling] = useState(false);

  const enabled = config?.enabled ?? false;

  const pairing = usePairingCode({
    endpoint: '/api/config/user-im/qq/pairing-code',
  });
  const paired = usePairedChats({
    endpoint: '/api/config/user-im/qq/paired-chats',
  });

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<UserQQConfig>('/api/config/user-im/qq');
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
    paired.load();
  }, [loadConfig, paired.load]);

  const handleToggle = async (newEnabled: boolean) => {
    setToggling(true);
    try {
      const data = await api.put<UserQQConfig>('/api/config/user-im/qq', { enabled: newEnabled });
      setConfig(data);
      toast.success(`QQ 渠道已${newEnabled ? '启用' : '停用'}`);
    } catch (err) {
      toast.error(getErrorMessage(err, '切换 QQ 渠道状态失败'));
    } finally {
      setToggling(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const id = appId.trim();
      const secret = appSecret.trim();

      if (id && !secret && !config?.hasAppSecret) {
        toast.error('首次配置 QQ 需要同时提供 App ID 和 App Secret');
        setSaving(false);
        return;
      }

      if (!id && !secret) {
        if (config?.appId || config?.hasAppSecret) {
          toast.success('QQ 配置未变更');
        } else {
          toast.error('请填写 QQ Bot App ID 和 App Secret');
        }
        setSaving(false);
        return;
      }

      const payload: Record<string, string | boolean> = { enabled: true };
      if (id) payload.appId = id;
      if (secret) payload.appSecret = secret;
      const data = await api.put<UserQQConfig>('/api/config/user-im/qq', payload);
      setConfig(data);
      setAppSecret('');
      toast.success('QQ 配置已保存');
    } catch (err) {
      toast.error(getErrorMessage(err, '保存 QQ 配置失败'));
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      await api.post('/api/config/user-im/qq/test');
      toast.success('QQ 连接测试成功');
    } catch (err) {
      toast.error(getErrorMessage(err, 'QQ 连接测试失败'));
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-border bg-muted/50">
        <div className="flex items-center gap-2">
          <span className={`inline-block w-2 h-2 rounded-full ${config?.connected ? 'bg-success' : 'bg-muted-foreground/40'}`} />
          <div>
            <h3 className="text-sm font-semibold text-foreground">QQ</h3>
            <p className="text-xs text-slate-500 mt-0.5">通过 QQ Bot 接收和回复消息</p>
          </div>
        </div>
        <Switch checked={enabled} disabled={loading || toggling} onCheckedChange={handleToggle} />
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
                <Label className="text-xs text-muted-foreground mb-1">App ID</Label>
                <Input
                  type="text"
                  value={appId}
                  onChange={(e) => setAppId(e.target.value)}
                  placeholder="输入 QQ Bot App ID"
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground mb-1">App Secret</Label>
                <Input
                  type="password"
                  value={appSecret}
                  onChange={(e) => setAppSecret(e.target.value)}
                  placeholder={config?.hasAppSecret ? '留空不修改' : '输入 QQ Bot App Secret'}
                />
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={handleSave} disabled={saving}>
                {saving && <Loader2 className="size-4 animate-spin" />}
                保存 QQ 配置
              </Button>
              {config?.hasAppSecret && (
                <Button variant="outline" onClick={handleTest} disabled={testing}>
                  {testing && <Loader2 className="size-4 animate-spin" />}
                  测试连接
                </Button>
              )}
            </div>

            {config?.hasAppSecret && (
              <PairingSection
                channelName="QQ"
                pairing={pairing}
                paired={paired}
              />
            )}
          </>
        )}
      </div>
    </div>
  );
}
