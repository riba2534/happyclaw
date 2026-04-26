import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { api } from '../../api/client';
import { getErrorMessage } from './types';

interface UserFeishuConfig {
  appId: string;
  hasAppSecret: boolean;
  appSecretMasked: string | null;
  enabled: boolean;
  connected: boolean;
  updatedAt: string | null;
  autoIsolateContext?: boolean;
}

export function FeishuChannelCard() {
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
    try {
      const data = await api.put<UserFeishuConfig>('/api/config/user-im/feishu', { enabled: newEnabled });
      setConfig(data);
      toast.success(`飞书渠道已${newEnabled ? '启用' : '停用'}`);
    } catch (err) {
      toast.error(getErrorMessage(err, '切换飞书渠道状态失败'));
    } finally {
      setToggling(false);
    }
  };

  const handleAutoIsolateToggle = async (newValue: boolean) => {
    setToggling(true);
    try {
      const data = await api.put<UserFeishuConfig>('/api/config/user-im/feishu', { autoIsolateContext: newValue });
      setConfig(data);
      toast.success(`自动隔离上下文已${newValue ? '开启' : '关闭'}`);
    } catch (err) {
      toast.error(getErrorMessage(err, '切换自动隔离上下文失败'));
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
        toast.error('首次配置飞书需要同时提供 App ID 和 App Secret');
        setSaving(false);
        return;
      }

      if (!id && !secret) {
        if (config?.appId || config?.hasAppSecret) {
          toast.success('飞书配置未变更');
        } else {
          toast.error('请填写飞书 App ID 和 App Secret');
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
      toast.success('飞书配置已保存');
    } catch (err) {
      toast.error(getErrorMessage(err, '保存飞书配置失败'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-border bg-muted/50">
        <div className="flex items-center gap-2">
          <span className={`inline-block w-2 h-2 rounded-full ${config?.connected ? 'bg-success' : 'bg-muted-foreground/40'}`} />
          <div>
            <h3 className="text-sm font-semibold text-foreground">飞书 Feishu</h3>
            <p className="text-xs text-muted-foreground mt-0.5">接收飞书消息并通过 Agent 自动回复</p>
            <p className="text-xs text-muted-foreground">私聊和群聊均可绑定到工作区</p>
          </div>
        </div>
        <Switch checked={enabled} disabled={loading || toggling} onCheckedChange={handleToggle} />
      </div>

      <div className={`px-5 py-4 space-y-4 transition-opacity ${!enabled ? 'opacity-50 pointer-events-none' : ''}`}>
        {loading ? (
          <div className="text-sm text-muted-foreground">加载中...</div>
        ) : (
          <>
            {config?.hasAppSecret && (
              <div className="text-xs text-muted-foreground">
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
                  placeholder="输入飞书 App ID"
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground mb-1">App Secret</Label>
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
            <div className="border-t border-border pt-3 flex items-center justify-between">
              <div>
                <p className="text-sm font-medium text-foreground">自动隔离上下文</p>
                <p className="text-xs text-muted-foreground">飞书不同私聊和群聊会自动绑定独立对话，上下文互不干扰</p>
              </div>
              <Switch
                checked={config?.autoIsolateContext ?? false}
                disabled={toggling}
                onCheckedChange={handleAutoIsolateToggle}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
