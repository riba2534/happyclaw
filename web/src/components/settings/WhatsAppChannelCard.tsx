import { useCallback, useEffect, useState } from 'react';
import { Loader2, LogOut, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { api } from '../../api/client';
import { wsManager } from '../../api/ws';
import { getErrorMessage } from './types';

type WhatsAppStatus =
  | 'connecting'
  | 'qr'
  | 'connected'
  | 'disconnected'
  | 'logged_out';

interface WhatsAppConnectionState {
  status: WhatsAppStatus;
  qr?: string;
  qrDataUrl?: string;
  error?: string;
  meJid?: string;
  meName?: string;
}

interface UserWhatsAppConfig {
  accountId: string;
  phoneNumber: string;
  enabled: boolean;
  paired: boolean;
  connected: boolean;
  updatedAt: string | null;
  state?: WhatsAppConnectionState;
}

interface WhatsAppStatusEvent extends WhatsAppConnectionState {
  type: 'whatsapp_status';
  userId: string;
}

const STATUS_LABEL: Record<WhatsAppStatus, string> = {
  connecting: '连接中...',
  qr: '等待扫码',
  connected: '已连接',
  disconnected: '已断开',
  logged_out: '已登出',
};

const STATUS_COLOR: Record<WhatsAppStatus, string> = {
  connecting: 'bg-amber-500',
  qr: 'bg-blue-500',
  connected: 'bg-success',
  disconnected: 'bg-muted-foreground/40',
  logged_out: 'bg-muted-foreground/40',
};

export function WhatsAppChannelCard() {
  const [config, setConfig] = useState<UserWhatsAppConfig | null>(null);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);
  const [state, setState] = useState<WhatsAppConnectionState>({
    status: 'disconnected',
  });

  const enabled = config?.enabled ?? false;

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<UserWhatsAppConfig>(
        '/api/config/user-im/whatsapp',
      );
      setConfig(data);
      setPhoneNumber('');
      if (data.state) setState(data.state);
    } catch {
      setConfig(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadConfig();
  }, [loadConfig]);

  // Subscribe to live whatsapp_status WS events for the current user
  useEffect(() => {
    const unsubscribe = wsManager.on(
      'whatsapp_status',
      (data: WhatsAppStatusEvent) => {
        setState({
          status: data.status,
          qr: data.qr,
          qrDataUrl: data.qrDataUrl,
          error: data.error,
          meJid: data.meJid,
          meName: data.meName,
        });
        // Refresh config card-level connected/paired flags when status changes
        if (data.status === 'connected' || data.status === 'logged_out') {
          loadConfig();
        }
      },
    );
    return () => {
      unsubscribe();
    };
  }, [loadConfig]);

  const handleToggle = async (newEnabled: boolean) => {
    setToggling(true);
    try {
      const data = await api.put<UserWhatsAppConfig>(
        '/api/config/user-im/whatsapp',
        { enabled: newEnabled },
      );
      setConfig(data);
      if (data.state) setState(data.state);
      toast.success(`WhatsApp 渠道已${newEnabled ? '启用' : '停用'}`);
    } catch (err) {
      toast.error(getErrorMessage(err, '切换 WhatsApp 渠道状态失败'));
    } finally {
      setToggling(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const trimmed = phoneNumber.trim();
      const payload: Record<string, string | boolean> = {};
      if (trimmed) payload.phoneNumber = trimmed;
      if (Object.keys(payload).length === 0) {
        toast.info('没有要保存的修改');
        setSaving(false);
        return;
      }
      const data = await api.put<UserWhatsAppConfig>(
        '/api/config/user-im/whatsapp',
        payload,
      );
      setConfig(data);
      setPhoneNumber('');
      toast.success('WhatsApp 配置已保存');
    } catch (err) {
      toast.error(getErrorMessage(err, '保存 WhatsApp 配置失败'));
    } finally {
      setSaving(false);
    }
  };

  const handleLogout = async () => {
    if (
      !window.confirm(
        '退出 WhatsApp 登录会清除本地凭据，下次启用需要重新扫码绑定。继续？',
      )
    ) {
      return;
    }
    setLoggingOut(true);
    try {
      const data = await api.post<UserWhatsAppConfig>(
        '/api/config/user-im/whatsapp/logout',
        {},
      );
      setConfig(data);
      if (data.state) setState(data.state);
      else setState({ status: 'logged_out' });
      toast.success('已退出 WhatsApp 登录，本地凭据已清除');
    } catch (err) {
      toast.error(getErrorMessage(err, '退出登录失败'));
    } finally {
      setLoggingOut(false);
    }
  };

  // Re-trigger connect by toggling enable off then on (forces fresh QR)
  const handleReconnect = async () => {
    if (!enabled) {
      await handleToggle(true);
      return;
    }
    setToggling(true);
    try {
      await api.put<UserWhatsAppConfig>('/api/config/user-im/whatsapp', {
        enabled: false,
      });
      const data = await api.put<UserWhatsAppConfig>(
        '/api/config/user-im/whatsapp',
        { enabled: true },
      );
      setConfig(data);
      if (data.state) setState(data.state);
      toast.success('已重新发起连接，请等待新二维码');
    } catch (err) {
      toast.error(getErrorMessage(err, '重连失败'));
    } finally {
      setToggling(false);
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-border bg-muted/50">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block w-2 h-2 rounded-full ${STATUS_COLOR[state.status]}`}
          />
          <div>
            <h3 className="text-sm font-semibold text-foreground">
              WhatsApp
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {STATUS_LABEL[state.status]}
              </span>
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              {state.status === 'connected' && state.meName
                ? `已登录：${state.meName}`
                : '基于 Baileys 通过 WhatsApp Web 协议扫码登录'}
            </p>
          </div>
        </div>
        <Switch
          checked={enabled}
          disabled={loading || toggling}
          onCheckedChange={handleToggle}
        />
      </div>

      <div
        className={`px-5 py-4 space-y-4 transition-opacity ${
          !enabled ? 'opacity-50 pointer-events-none' : ''
        }`}
      >
        {loading ? (
          <div className="text-sm text-muted-foreground">加载中...</div>
        ) : (
          <>
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              ⚠️ Baileys 是逆向 WhatsApp Web 协议的社区方案，
              Meta 在 2025-2026 收紧了对非官方客户端的封禁，存在封号风险。
              **商用场景建议使用 Meta 官方 Cloud API。**
            </div>

            {state.status === 'qr' && state.qrDataUrl && (
              <div className="rounded-lg border border-border p-4 flex flex-col items-center gap-3 bg-muted/20">
                <img
                  src={state.qrDataUrl}
                  alt="WhatsApp 登录二维码"
                  className="w-64 h-64 rounded bg-white p-2"
                />
                <div className="text-xs text-center text-muted-foreground">
                  打开手机 WhatsApp → 点右上角菜单 → 已关联设备 → 关联设备
                  <br />
                  扫描以上二维码完成登录（30 秒内有效，过期会自动刷新）
                </div>
              </div>
            )}

            {state.status === 'connecting' && (
              <div className="rounded-lg border border-border bg-muted/20 px-3 py-4 text-sm text-muted-foreground flex items-center justify-center gap-2">
                <Loader2 className="size-4 animate-spin" />
                正在连接 WhatsApp 服务器...
              </div>
            )}

            {state.status === 'connected' && (
              <div className="rounded-lg border border-success/20 bg-success/5 px-3 py-3 text-sm">
                <div className="font-medium text-success">已成功登录</div>
                {state.meName && (
                  <div className="text-xs text-muted-foreground mt-1">
                    账号：{state.meName}
                  </div>
                )}
                {state.meJid && (
                  <div className="text-xs text-muted-foreground">
                    JID：{state.meJid}
                  </div>
                )}
              </div>
            )}

            {(state.status === 'disconnected' ||
              state.status === 'logged_out') &&
              state.error && (
                <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  断线原因：{state.error}
                </div>
              )}

            {config?.phoneNumber && (
              <div className="text-xs text-muted-foreground">
                已记录手机号：{config.phoneNumber}
              </div>
            )}

            <div>
              <Label className="text-xs text-muted-foreground mb-1">
                手机号（可选，用于显示提示）
              </Label>
              <Input
                type="text"
                inputMode="tel"
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                placeholder={
                  config?.phoneNumber
                    ? '留空不修改'
                    : '+15551234567（E.164 格式）'
                }
              />
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={handleSave} disabled={saving}>
                {saving && <Loader2 className="size-4 animate-spin" />}
                保存配置
              </Button>
              <Button
                variant="outline"
                onClick={handleReconnect}
                disabled={toggling}
              >
                {toggling ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <RefreshCw className="size-4" />
                )}
                重新连接
              </Button>
              {state.status === 'connected' && (
                <Button
                  variant="outline"
                  onClick={() => handleToggle(false)}
                  disabled={toggling}
                >
                  <LogOut className="size-4" />
                  停用并断开
                </Button>
              )}
              {(state.status === 'connected' || config?.paired) && (
                <Button
                  variant="outline"
                  onClick={handleLogout}
                  disabled={loggingOut}
                  title="清除本地凭据，下次启用需重新扫码"
                >
                  {loggingOut ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <LogOut className="size-4" />
                  )}
                  退出登录
                </Button>
              )}
            </div>

            <div className="text-xs text-muted-foreground mt-2 space-y-1">
              <p>
                M1 阶段范围：QR 扫码登录、连接状态显示、自动重连。M2/M3 后续 PR 接入：
                收发消息、文件下载、群组、Reaction 等。
              </p>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
