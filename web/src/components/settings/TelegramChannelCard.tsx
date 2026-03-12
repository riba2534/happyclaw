import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { api } from '../../api/client';
import type { SettingsNotification } from './types';
import { getErrorMessage } from './types';
import { usePairingCode } from './hooks/usePairingCode';
import { usePairedChats } from './hooks/usePairedChats';
import { PairingSection } from './PairingSection';

interface UserTelegramConfig {
  hasBotToken: boolean;
  botTokenMasked: string | null;
  enabled: boolean;
  connected: boolean;
  updatedAt: string | null;
  proxyUrl: string;
  effectiveProxyUrl: string;
  proxySource: 'user' | 'system' | 'none';
}

interface TelegramTestResult {
  success: boolean;
  bot_username?: string;
  bot_name?: string;
  error?: string;
}

interface TelegramChannelCardProps extends SettingsNotification {}

export function TelegramChannelCard({ setNotice, setError }: TelegramChannelCardProps) {
  const [config, setConfig] = useState<UserTelegramConfig | null>(null);
  const [botToken, setBotToken] = useState('');
  const [proxyUrl, setProxyUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [toggling, setToggling] = useState(false);

  const enabled = config?.enabled ?? false;

  const pairing = usePairingCode({
    endpoint: '/api/config/user-im/telegram/pairing-code',
    setNotice,
    setError,
  });
  const paired = usePairedChats({
    endpoint: '/api/config/user-im/telegram/paired-chats',
    setNotice,
    setError,
  });

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<UserTelegramConfig>('/api/config/user-im/telegram');
      setConfig(data);
      setBotToken('');
      setProxyUrl(data.proxyUrl || '');
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
    setNotice(null);
    setError(null);
    try {
      const data = await api.put<UserTelegramConfig>('/api/config/user-im/telegram', { enabled: newEnabled });
      setConfig(data);
      setNotice(`Telegram 渠道已${newEnabled ? '启用' : '停用'}`);
    } catch (err) {
      setError(getErrorMessage(err, '切换 Telegram 渠道状态失败'));
    } finally {
      setToggling(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const token = botToken.trim();
      if (!token && !config?.hasBotToken) {
        setError('请输入 Telegram Bot Token');
        setSaving(false);
        return;
      }

      const payload: Record<string, string | boolean> = { enabled: true };
      if (token) payload.botToken = token;
      const proxy = proxyUrl.trim();
      if (proxy) payload.proxyUrl = proxy;
      else if (!proxy && config?.proxyUrl) payload.clearProxyUrl = true;

      const data = await api.put<UserTelegramConfig>('/api/config/user-im/telegram', payload);
      setConfig(data);
      setBotToken('');
      setProxyUrl(data.proxyUrl || '');
      setNotice('Telegram 配置已保存');
    } catch (err) {
      setError(getErrorMessage(err, '保存 Telegram 配置失败'));
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setNotice(null);
    setError(null);
    try {
      const result = await api.post<TelegramTestResult>('/api/config/user-im/telegram/test');
      if (result.success) {
        setNotice(`Telegram 连接成功！Bot: @${result.bot_username} (${result.bot_name})`);
      } else {
        setError(result.error || 'Telegram 连接失败');
      }
    } catch (err) {
      setError(getErrorMessage(err, 'Telegram 连接测试失败'));
    } finally {
      setTesting(false);
    }
  };

  const proxyHint =
    config?.proxySource === 'system'
      ? `当前使用系统代理: ${config.effectiveProxyUrl}`
      : config?.proxySource === 'user'
        ? '使用自定义代理'
        : '';

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 bg-slate-50/50">
        <div className="flex items-center gap-2">
          <span className={`inline-block w-2 h-2 rounded-full ${config?.connected ? 'bg-emerald-500' : 'bg-slate-300'}`} />
          <div>
            <h3 className="text-sm font-semibold text-slate-800">Telegram</h3>
            <p className="text-xs text-slate-500 mt-0.5">通过 Telegram Bot 接收和回复消息</p>
          </div>
        </div>
        <ToggleSwitch checked={enabled} disabled={loading || toggling} onChange={handleToggle} />
      </div>

      <div className={`px-5 py-4 space-y-4 transition-opacity ${!enabled ? 'opacity-50 pointer-events-none' : ''}`}>
        {loading ? (
          <div className="text-sm text-slate-500">加载中...</div>
        ) : (
          <>
            {config?.hasBotToken && (
              <div className="text-xs text-slate-500">
                当前 Token: {config.botTokenMasked || '已配置'}
              </div>
            )}
            <div>
              <label className="block text-xs text-slate-500 mb-1">Bot Token</label>
              <Input
                type="password"
                value={botToken}
                onChange={(e) => setBotToken(e.target.value)}
                placeholder={config?.hasBotToken ? '留空不修改' : '输入 Telegram Bot Token'}
              />
            </div>
            <div>
              <label className="block text-xs text-slate-500 mb-1">代理 URL（可选）</label>
              <Input
                type="text"
                value={proxyUrl}
                onChange={(e) => setProxyUrl(e.target.value)}
                placeholder="例如 http://127.0.0.1:7897 或 socks5://127.0.0.1:7897"
              />
              {proxyHint && (
                <p className="mt-1 text-xs text-slate-400">{proxyHint}</p>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={handleSave} disabled={saving}>
                {saving && <Loader2 className="size-4 animate-spin" />}
                保存 Telegram 配置
              </Button>
              {config?.hasBotToken && (
                <Button variant="outline" onClick={handleTest} disabled={testing}>
                  {testing && <Loader2 className="size-4 animate-spin" />}
                  测试连接
                </Button>
              )}
            </div>

            {config?.hasBotToken && (
              <PairingSection
                channelName="Telegram"
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
