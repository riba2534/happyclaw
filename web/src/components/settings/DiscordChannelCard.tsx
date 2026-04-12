import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { api } from '../../api/client';
import { getErrorMessage } from './types';

interface UserDiscordConfig {
  hasBotToken: boolean;
  botTokenMasked: string | null;
  enabled: boolean;
  streamingMode: 'edit' | 'off';
  connected: boolean;
  updatedAt: string | null;
}

interface DiscordTestResult {
  success: boolean;
  bot_username?: string;
  bot_name?: string;
  error?: string;
}

export function DiscordChannelCard() {
  const [config, setConfig] = useState<UserDiscordConfig | null>(null);
  const [botToken, setBotToken] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [toggling, setToggling] = useState(false);

  const enabled = config?.enabled ?? false;

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<UserDiscordConfig>('/api/config/user-im/discord');
      setConfig(data);
      setBotToken('');
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
      const data = await api.put<UserDiscordConfig>('/api/config/user-im/discord', { enabled: newEnabled });
      setConfig(data);
      toast.success(`Discord 渠道已${newEnabled ? '启用' : '停用'}`);
    } catch (err) {
      toast.error(getErrorMessage(err, '切换 Discord 渠道状态失败'));
    } finally {
      setToggling(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const token = botToken.trim();
      if (!token && !config?.hasBotToken) {
        toast.error('请输入 Discord Bot Token');
        setSaving(false);
        return;
      }

      const payload: Record<string, string | boolean> = { enabled: true };
      if (token) payload.botToken = token;

      const data = await api.put<UserDiscordConfig>('/api/config/user-im/discord', payload);
      setConfig(data);
      setBotToken('');
      toast.success('Discord 配置已保存');
    } catch (err) {
      toast.error(getErrorMessage(err, '保存 Discord 配置失败'));
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      const result = await api.post<DiscordTestResult>('/api/config/user-im/discord/test');
      if (result.success) {
        toast.success(`Discord 连接成功！Bot: ${result.bot_name} (@${result.bot_username})`);
      } else {
        toast.error(result.error || 'Discord 连接失败');
      }
    } catch (err) {
      toast.error(getErrorMessage(err, 'Discord 连接测试失败'));
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
            <h3 className="text-sm font-semibold text-foreground">Discord</h3>
            <p className="text-xs text-muted-foreground mt-0.5">通过 Discord Bot 接收和回复消息</p>
          </div>
        </div>
        <Switch checked={enabled} disabled={loading || toggling} onCheckedChange={handleToggle} />
      </div>

      <div className={`px-5 py-4 space-y-4 transition-opacity ${!enabled ? 'opacity-50 pointer-events-none' : ''}`}>
        {loading ? (
          <div className="text-sm text-muted-foreground">加载中...</div>
        ) : (
          <>
            {config?.hasBotToken && (
              <div className="text-xs text-muted-foreground">
                当前 Token: {config.botTokenMasked || '已配置'}
              </div>
            )}
            <div>
              <Label className="text-xs text-muted-foreground mb-1">Bot Token</Label>
              <Input
                type="password"
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                placeholder={config?.hasBotToken ? '留空不修改' : '输入 Discord Bot Token'}
              />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={handleSave} disabled={saving}>
                {saving && <Loader2 className="size-4 animate-spin" />}
                保存 Discord 配置
              </Button>
              {config?.hasBotToken && (
                <>
                  <Button variant="outline" onClick={handleTest} disabled={testing}>
                    {testing && <Loader2 className="size-4 animate-spin" />}
                    测试连接
                  </Button>
                  <Button
                    variant="outline"
                    className="text-destructive hover:text-destructive"
                    disabled={saving}
                    onClick={async () => {
                      try {
                        setSaving(true);
                        await api.put('/api/config/user-im/discord', { clearBotToken: true, enabled: false });
                        setBotToken('');
                        setConfig((prev) => prev ? { ...prev, hasBotToken: false, botTokenMasked: null, enabled: false, connected: false } : prev);
                        toast.success('Bot Token 已清除');
                      } catch { toast.error('清除失败'); }
                      finally { setSaving(false); }
                    }}
                  >
                    清除 Token
                  </Button>
                </>
              )}
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-border">
              <div>
                <p className="text-xs font-medium text-foreground">流式编辑</p>
                <p className="text-xs text-muted-foreground">回复时实时编辑消息（打字机效果），默认关闭</p>
              </div>
              <Switch
                checked={config?.streamingMode === 'edit'}
                disabled={loading || saving}
                onCheckedChange={async (checked) => {
                  try {
                    await api.put('/api/config/user-im/discord', {
                      streamingMode: checked ? 'edit' : 'off',
                    });
                    setConfig((prev) => prev ? { ...prev, streamingMode: checked ? 'edit' : 'off' } : prev);
                    toast.success(checked ? '已开启流式编辑' : '已关闭流式编辑');
                  } catch {
                    toast.error('更新失败');
                  }
                }}
              />
            </div>

            <div className="text-xs text-muted-foreground mt-2 space-y-1">
              <p>获取 Bot Token：Discord Developer Portal → Applications → Bot → Token</p>
              <p>
                斜杠命令首次注册后通过 Discord Global Commands 通道分发，
                Discord 官方说明可能需要 5-60 分钟才在所有服务器生效。期间可以用纯文本命令兜底，
                例如直接发送 <code>/clear</code>、<code>/list</code>、<code>/status</code>。
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
