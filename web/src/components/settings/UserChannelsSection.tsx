import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { api } from '../../api/client';
import type { TelegramTestResult, SettingsNotification } from './types';
import { getErrorMessage, sourceLabel } from './types';

interface UserFeishuConfig {
  appId: string;
  hasAppSecret: boolean;
  appSecretMasked: string | null;
}

interface UserTelegramConfig {
  hasBotToken: boolean;
  botTokenMasked: string | null;
  enabled: boolean;
  connected: boolean;
  updatedAt: string | null;
  source: 'runtime' | 'env' | 'none';
}

interface UserChannelsSectionProps extends SettingsNotification {}

export function UserChannelsSection({ setNotice, setError }: UserChannelsSectionProps) {
  // Feishu state
  const [feishuConfig, setFeishuConfig] = useState<UserFeishuConfig | null>(null);
  const [feishuAppId, setFeishuAppId] = useState('');
  const [feishuAppSecret, setFeishuAppSecret] = useState('');
  const [feishuLoading, setFeishuLoading] = useState(true);
  const [feishuSaving, setFeishuSaving] = useState(false);

  // Telegram state
  const [telegramConfig, setTelegramConfig] = useState<UserTelegramConfig | null>(null);
  const [telegramBotToken, setTelegramBotToken] = useState('');
  const [telegramClearToken, setTelegramClearToken] = useState(false);
  const [telegramEnabled, setTelegramEnabled] = useState(true);
  const [telegramLoading, setTelegramLoading] = useState(true);
  const [telegramSaving, setTelegramSaving] = useState(false);
  const [telegramTesting, setTelegramTesting] = useState(false);
  const [telegramToggling, setTelegramToggling] = useState(false);

  const loadFeishu = useCallback(async () => {
    setFeishuLoading(true);
    try {
      const data = await api.get<UserFeishuConfig>('/api/config/user-im/feishu');
      setFeishuConfig(data);
      setFeishuAppId(data.appId || '');
      setFeishuAppSecret('');
    } catch {
      // API may not exist yet; treat as unconfigured
      setFeishuConfig(null);
    } finally {
      setFeishuLoading(false);
    }
  }, []);

  const loadTelegram = useCallback(async () => {
    setTelegramLoading(true);
    try {
      const data = await api.get<UserTelegramConfig>('/api/config/user-im/telegram');
      setTelegramConfig(data);
      setTelegramBotToken('');
      setTelegramClearToken(false);
      setTelegramEnabled(data.enabled);
    } catch {
      setTelegramConfig(null);
    } finally {
      setTelegramLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFeishu();
    loadTelegram();
  }, [loadFeishu, loadTelegram]);

  const handleSaveFeishu = async () => {
    setFeishuSaving(true);
    setError(null);
    setNotice(null);
    try {
      const appId = feishuAppId.trim();
      const appSecret = feishuAppSecret.trim();

      // Validate: if App ID is provided, Secret must also be provided (for first-time setup)
      if (appId && !appSecret && !feishuConfig?.hasAppSecret) {
        setError('首次配置飞书需要同时提供 App ID 和 App Secret');
        setFeishuSaving(false);
        return;
      }

      // No-op when user leaves fields empty while existing config is present.
      if (!appId && !appSecret) {
        if (feishuConfig?.appId || feishuConfig?.hasAppSecret) {
          setNotice('飞书配置未变更');
        } else {
          setError('请填写飞书 App ID 和 App Secret');
        }
        setFeishuSaving(false);
        return;
      }

      const payload: Record<string, string | boolean> = { enabled: true };
      if (appId) payload.appId = appId;
      if (appSecret) payload.appSecret = appSecret;
      await api.put('/api/config/user-im/feishu', payload);
      setNotice('飞书配置已保存');
      await loadFeishu();
    } catch (err) {
      setError(getErrorMessage(err, '保存飞书配置失败'));
    } finally {
      setFeishuSaving(false);
    }
  };

  const handleTelegramToggle = async (newEnabled: boolean) => {
    setTelegramToggling(true);
    setNotice(null);
    setError(null);
    try {
      await api.put('/api/config/user-im/telegram', { enabled: newEnabled });
      setNotice(`Telegram 渠道已${newEnabled ? '启用' : '停用'}`);
      await loadTelegram();
    } catch (err) {
      setError(getErrorMessage(err, '切换 Telegram 渠道状态失败'));
    } finally {
      setTelegramToggling(false);
    }
  };

  const handleSaveTelegram = async () => {
    setTelegramSaving(true);
    setError(null);
    setNotice(null);
    try {
      const token = telegramBotToken.trim();
      const payload: Record<string, unknown> = { enabled: telegramEnabled };
      if (token) {
        payload.botToken = token;
      } else if (telegramClearToken) {
        payload.clearBotToken = true;
      } else if (!telegramConfig?.hasBotToken) {
        setError('请输入 Telegram Bot Token');
        setTelegramSaving(false);
        return;
      }

      const saved = await api.put<UserTelegramConfig>('/api/config/user-im/telegram', payload);
      setTelegramConfig(saved);
      setTelegramBotToken('');
      setTelegramClearToken(false);
      setTelegramEnabled(saved.enabled);
      setNotice(`Telegram 配置已保存${saved.connected ? '，已连接' : ''}`);
    } catch (err) {
      setError(getErrorMessage(err, '保存 Telegram 配置失败'));
    } finally {
      setTelegramSaving(false);
    }
  };

  const handleTelegramTest = async () => {
    setTelegramTesting(true);
    setNotice(null);
    setError(null);
    try {
      const result = await api.post<TelegramTestResult>('/api/config/user-im/telegram/test');
      if (result.success) {
        setNotice(`Telegram 连接成功! Bot: @${result.bot_username} (${result.bot_name})`);
      } else {
        setError(result.error || 'Telegram 连接失败');
      }
    } catch (err) {
      setError(getErrorMessage(err, 'Telegram 连接测试失败'));
    } finally {
      setTelegramTesting(false);
    }
  };

  const telegramFormDisabled = !telegramEnabled;

  return (
    <div className="space-y-6">
      {/* Feishu */}
      <div>
        <h3 className="text-base font-semibold text-slate-900 mb-3">飞书</h3>
        {feishuLoading ? (
          <div className="text-sm text-slate-500">加载中...</div>
        ) : (
          <>
            {feishuConfig?.hasAppSecret && (
              <div className="text-xs text-slate-500 mb-2">
                当前 Secret: {feishuConfig.appSecretMasked || '已配置'}
              </div>
            )}
            <div className="grid md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-slate-500 mb-1">App ID</label>
                <Input
                  type="text"
                  value={feishuAppId}
                  onChange={(e) => setFeishuAppId(e.target.value)}
                  placeholder="输入飞书 App ID"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-500 mb-1">App Secret</label>
                <Input
                  type="password"
                  value={feishuAppSecret}
                  onChange={(e) => setFeishuAppSecret(e.target.value)}
                  placeholder={feishuConfig?.hasAppSecret ? '留空不修改' : '输入飞书 App Secret'}
                />
              </div>
            </div>
            <div className="mt-3">
              <Button onClick={handleSaveFeishu} disabled={feishuSaving}>
                {feishuSaving && <Loader2 className="size-4 animate-spin" />}
                保存飞书配置
              </Button>
            </div>
          </>
        )}
      </div>

      {/* Divider */}
      <div className="border-t border-slate-200" />

      {/* Telegram */}
      <div className="rounded-xl border border-slate-200 bg-white overflow-hidden">
        {/* Card header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 bg-slate-50/50">
          <div className="flex items-center gap-2">
            <span className={`inline-block w-2 h-2 rounded-full ${telegramConfig?.connected ? 'bg-emerald-500' : 'bg-slate-300'}`} />
            <div>
              <h3 className="text-sm font-semibold text-slate-800">Telegram</h3>
              <p className="text-xs text-slate-500 mt-0.5">通过 Telegram Bot 接收和回复消息</p>
            </div>
          </div>
          <button
            role="switch"
            aria-checked={telegramEnabled}
            disabled={telegramLoading || telegramToggling}
            onClick={() => handleTelegramToggle(!telegramEnabled)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors cursor-pointer disabled:opacity-50 ${
              telegramEnabled ? 'bg-primary' : 'bg-slate-200'
            }`}
          >
            <span className={`inline-block h-4 w-4 rounded-full bg-white shadow transition-transform ${
              telegramEnabled ? 'translate-x-6' : 'translate-x-1'
            }`} />
          </button>
        </div>

        {/* Card content */}
        <div className={`px-5 py-4 space-y-4 transition-opacity ${telegramFormDisabled ? 'opacity-50 pointer-events-none' : ''}`}>
          {telegramLoading ? (
            <div className="text-sm text-slate-500">加载中...</div>
          ) : (
            <>
              <div>
                <label className="block text-xs text-slate-600 mb-1">
                  Bot Token {telegramConfig?.hasBotToken ? `(${telegramConfig.botTokenMasked})` : ''}
                </label>
                <Input
                  type="password"
                  value={telegramBotToken}
                  onChange={(e) => setTelegramBotToken(e.target.value)}
                  disabled={telegramLoading || telegramSaving}
                  placeholder={telegramConfig?.hasBotToken ? '留空保持不变，输入新值覆盖' : '输入 Telegram Bot Token'}
                />
                <p className="mt-1 text-xs text-slate-400">在 Telegram 中搜索 @BotFather，发送 /newbot 创建机器人后获得</p>
                {telegramConfig?.hasBotToken && (
                  <label className="mt-2 flex items-center gap-2 text-xs text-slate-600">
                    <input
                      type="checkbox"
                      checked={telegramClearToken}
                      onChange={(e) => setTelegramClearToken(e.target.checked)}
                      disabled={telegramSaving}
                    />
                    清空现有 Token
                  </label>
                )}
              </div>

              <div className="flex flex-wrap items-center gap-3">
                <Button variant="outline" onClick={loadTelegram} disabled={telegramLoading || telegramSaving}>
                  <RefreshCw className="w-4 h-4" />
                  刷新
                </Button>
                <Button onClick={handleSaveTelegram} disabled={telegramLoading || telegramSaving}>
                  {telegramSaving && <Loader2 className="size-4 animate-spin" />}
                  保存 Telegram 配置
                </Button>
                <Button variant="outline" onClick={handleTelegramTest} disabled={telegramLoading || telegramTesting || !telegramConfig?.hasBotToken}>
                  {telegramTesting && <Loader2 className="size-4 animate-spin" />}
                  测试连接
                </Button>
              </div>

              <div className="text-xs text-slate-500 space-y-1">
                <div>当前来源：{sourceLabel(telegramConfig?.source || 'none')}</div>
                <div>最近保存：{telegramConfig?.updatedAt ? new Date(telegramConfig.updatedAt).toLocaleString('zh-CN') : '未记录'}</div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
