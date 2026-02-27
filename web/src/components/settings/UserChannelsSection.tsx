import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Copy, Check, Link, X } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { api } from '../../api/client';
import type { SettingsNotification } from './types';
import { getErrorMessage } from './types';

interface UserFeishuConfig {
  appId: string;
  hasAppSecret: boolean;
  appSecretMasked: string | null;
}

interface UserTelegramConfig {
  hasBotToken: boolean;
  botTokenMasked: string | null;
}

interface PairingCodeResult {
  code: string;
  expiresAt: number;
  ttlSeconds: number;
}

interface PairedChat {
  jid: string;
  name: string;
  addedAt: string;
}

/** Clipboard write with fallback for non-HTTPS contexts */
function copyToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  // Fallback: temporary textarea
  return new Promise((resolve, reject) => {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      resolve();
    } catch {
      reject(new Error('execCommand copy failed'));
    } finally {
      document.body.removeChild(ta);
    }
  });
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
  const [telegramLoading, setTelegramLoading] = useState(true);
  const [telegramSaving, setTelegramSaving] = useState(false);

  // Pairing state
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [pairingCountdown, setPairingCountdown] = useState(0);
  const [pairingGenerating, setPairingGenerating] = useState(false);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Paired chats state
  const [pairedChats, setPairedChats] = useState<PairedChat[]>([]);
  const [pairedChatsLoading, setPairedChatsLoading] = useState(false);
  const [removingJid, setRemovingJid] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
    } catch {
      setTelegramConfig(null);
    } finally {
      setTelegramLoading(false);
    }
  }, []);

  const loadPairedChats = useCallback(async () => {
    setPairedChatsLoading(true);
    try {
      const data = await api.get<{ chats: PairedChat[] }>('/api/config/user-im/telegram/paired-chats');
      setPairedChats(data.chats);
    } catch {
      setPairedChats([]);
    } finally {
      setPairedChatsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFeishu();
    loadTelegram();
    loadPairedChats();
  }, [loadFeishu, loadTelegram, loadPairedChats]);

  // Timer cleanup
  useEffect(() => {
    return () => {
      if (countdownRef.current) clearInterval(countdownRef.current);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    };
  }, []);

  const startCountdown = useCallback((expiresAt: number) => {
    if (countdownRef.current) clearInterval(countdownRef.current);
    const update = () => {
      const remaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
      setPairingCountdown(remaining);
      if (remaining <= 0) {
        setPairingCode(null);
        if (countdownRef.current) clearInterval(countdownRef.current);
      }
    };
    update();
    countdownRef.current = setInterval(update, 1000);
  }, []);

  const handleGeneratePairingCode = async () => {
    setPairingGenerating(true);
    setNotice(null);
    setError(null);
    try {
      const result = await api.post<PairingCodeResult>('/api/config/user-im/telegram/pairing-code');
      setPairingCode(result.code);
      startCountdown(Date.now() + result.ttlSeconds * 1000);
    } catch (err) {
      setError(getErrorMessage(err, '生成配对码失败'));
    } finally {
      setPairingGenerating(false);
    }
  };

  const handleCopyPairCommand = () => {
    if (!pairingCode) return;
    copyToClipboard(`/pair ${pairingCode}`).then(() => {
      setCopied(true);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      setError('复制失败，请手动复制');
    });
  };

  const handleRemovePairedChat = async (jid: string) => {
    setRemovingJid(jid);
    setNotice(null);
    setError(null);
    try {
      await api.delete(`/api/config/user-im/telegram/paired-chats/${encodeURIComponent(jid)}`);
      setPairedChats((prev) => prev.filter((c) => c.jid !== jid));
      setNotice('已移除配对聊天');
    } catch (err) {
      setError(getErrorMessage(err, '移除配对聊天失败'));
    } finally {
      setRemovingJid(null);
    }
  };

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

  const handleSaveTelegram = async () => {
    setTelegramSaving(true);
    setError(null);
    setNotice(null);
    try {
      const token = telegramBotToken.trim();
      if (!token) {
        if (telegramConfig?.hasBotToken) {
          setNotice('Telegram 配置未变更');
        } else {
          setError('请输入 Telegram Bot Token');
        }
        setTelegramSaving(false);
        return;
      }

      await api.put('/api/config/user-im/telegram', {
        botToken: token,
        enabled: true,
      });
      setNotice('Telegram 配置已保存');
      await loadTelegram();
    } catch (err) {
      setError(getErrorMessage(err, '保存 Telegram 配置失败'));
    } finally {
      setTelegramSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <p className="text-sm text-slate-500 bg-slate-50 rounded-lg px-4 py-3">
        绑定你个人的飞书或 Telegram 账号，消息将发送到你的主工作区。
      </p>
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
      <div>
        <h3 className="text-base font-semibold text-slate-900 mb-3">Telegram</h3>
        {telegramLoading ? (
          <div className="text-sm text-slate-500">加载中...</div>
        ) : (
          <>
            {telegramConfig?.hasBotToken && (
              <div className="text-xs text-slate-500 mb-2">
                当前 Token: {telegramConfig.botTokenMasked || '已配置'}
              </div>
            )}
            <div>
              <label className="block text-xs text-slate-500 mb-1">Bot Token</label>
              <Input
                type="password"
                value={telegramBotToken}
                onChange={(e) => setTelegramBotToken(e.target.value)}
                placeholder={telegramConfig?.hasBotToken ? '留空不修改' : '输入 Telegram Bot Token'}
              />
            </div>
            <div className="mt-3">
              <Button onClick={handleSaveTelegram} disabled={telegramSaving}>
                {telegramSaving && <Loader2 className="size-4 animate-spin" />}
                保存 Telegram 配置
              </Button>
            </div>

            {/* Chat Pairing */}
            {telegramConfig?.hasBotToken && (
              <div className="border-t border-slate-100 mt-4 pt-4">
                <div className="flex items-center gap-2 mb-3">
                  <Link className="w-4 h-4 text-slate-500" />
                  <h4 className="text-sm font-medium text-slate-700">聊天配对</h4>
                </div>

                {pairingCode && pairingCountdown > 0 ? (
                  <div className="space-y-3">
                    <div className="flex items-center gap-3">
                      <code className="text-2xl font-mono font-bold tracking-widest text-primary bg-primary/5 px-4 py-2 rounded-lg select-all">
                        {pairingCode}
                      </code>
                      <div className="text-sm text-slate-500">
                        {Math.floor(pairingCountdown / 60)}:{String(pairingCountdown % 60).padStart(2, '0')} 后过期
                      </div>
                    </div>
                    <div className="flex items-center gap-3">
                      <Button variant="outline" size="sm" className="cursor-pointer" onClick={handleCopyPairCommand}>
                        {copied ? <Check className="w-3.5 h-3.5 text-emerald-500" /> : <Copy className="w-3.5 h-3.5" />}
                        {copied ? '已复制' : '复制配对命令'}
                      </Button>
                      <Button variant="outline" size="sm" onClick={handleGeneratePairingCode} disabled={pairingGenerating}>
                        {pairingGenerating && <Loader2 className="size-3.5 animate-spin" />}
                        重新生成
                      </Button>
                    </div>
                    <p className="text-xs text-slate-400">
                      在 Telegram 中向 Bot 发送 <code className="bg-slate-100 px-1 rounded">/pair {pairingCode}</code> 完成配对
                    </p>
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Button variant="outline" onClick={handleGeneratePairingCode} disabled={pairingGenerating}>
                      {pairingGenerating && <Loader2 className="size-4 animate-spin" />}
                      生成配对码
                    </Button>
                    <p className="text-xs text-slate-400">
                      生成一次性配对码，在 Telegram 聊天中发送 <code className="bg-slate-100 px-1 rounded">/pair &lt;code&gt;</code> 将聊天绑定到此账号
                    </p>
                  </div>
                )}

                {/* Paired chats list */}
                <div className="mt-4">
                  <div className="flex items-center justify-between mb-2">
                    <h5 className="text-xs font-medium text-slate-600">已配对的聊天</h5>
                    <button
                      onClick={loadPairedChats}
                      disabled={pairedChatsLoading}
                      className="text-xs text-slate-400 hover:text-slate-600 disabled:opacity-50"
                    >
                      刷新
                    </button>
                  </div>
                  {pairedChatsLoading ? (
                    <div className="text-xs text-slate-400">加载中...</div>
                  ) : pairedChats.length === 0 ? (
                    <div className="text-xs text-slate-400">暂无已配对的聊天</div>
                  ) : (
                    <div className="space-y-1.5">
                      {pairedChats.map((chat) => (
                        <div key={chat.jid} className="flex items-center justify-between px-3 py-2 rounded-lg bg-slate-50 group">
                          <div className="min-w-0">
                            <div className="text-sm text-slate-700 truncate">{chat.name}</div>
                            <div className="text-xs text-slate-400">{new Date(chat.addedAt).toLocaleString('zh-CN')}</div>
                          </div>
                          <button
                            onClick={() => handleRemovePairedChat(chat.jid)}
                            disabled={removingJid === chat.jid}
                            className="ml-2 p-1 rounded text-slate-400 hover:text-red-500 hover:bg-red-50 opacity-0 group-hover:opacity-100 transition-all disabled:opacity-50"
                            title="移除配对"
                          >
                            {removingJid === chat.jid ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <X className="w-3.5 h-3.5" />
                            )}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
