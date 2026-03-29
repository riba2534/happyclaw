import { useCallback, useEffect, useState } from 'react';
import { Loader2, LogOut, QrCode, Shield, Smartphone } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { api } from '../../api/client';
import { getErrorMessage } from './types';
import { WeChatQRDialog } from './WeChatQRDialog';

interface UserWeChatConfig {
  ilinkBotId: string;
  hasBotToken: boolean;
  botTokenMasked: string | null;
  bypassProxy: boolean;
  enabled: boolean;
  connected: boolean;
  updatedAt: string | null;
}

export function WeChatChannelCard() {
  const [config, setConfig] = useState<UserWeChatConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [togglingProxy, setTogglingProxy] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [qrDialogOpen, setQrDialogOpen] = useState(false);

  const enabled = config?.enabled ?? false;

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<UserWeChatConfig>('/api/config/user-im/wechat');
      setConfig(data);
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
      const data = await api.put<UserWeChatConfig>('/api/config/user-im/wechat', { enabled: newEnabled });
      setConfig(data);
      toast.success(`微信渠道已${newEnabled ? '启用' : '停用'}`);
    } catch (err) {
      toast.error(getErrorMessage(err, '切换微信渠道状态失败'));
    } finally {
      setToggling(false);
    }
  };

  const handleBypassProxyToggle = async (newBypass: boolean) => {
    setTogglingProxy(true);
    try {
      const data = await api.put<UserWeChatConfig>('/api/config/user-im/wechat', { bypassProxy: newBypass });
      setConfig(data);
      toast.success(newBypass ? '已切换为直连模式（绕过代理）' : '已切换为代理模式');
    } catch (err) {
      toast.error(getErrorMessage(err, '切换直连模式失败'));
    } finally {
      setTogglingProxy(false);
    }
  };

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await api.post('/api/config/user-im/wechat/disconnect');
      await loadConfig();
      toast.success('已退出微信登录');
    } catch (err) {
      toast.error(getErrorMessage(err, '退出微信登录失败'));
    } finally {
      setDisconnecting(false);
    }
  };

  const handleQRSuccess = async () => {
    setQrDialogOpen(false);
    toast.success('微信登录成功');
    await loadConfig();
  };

  const bypassProxy = config?.bypassProxy ?? true;

  return (
    <>
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border bg-muted/50">
          <div className="flex items-center gap-2">
            <span className={`inline-block w-2 h-2 rounded-full ${config?.connected ? 'bg-emerald-500' : 'bg-muted-foreground/30'}`} />
            <div>
              <h3 className="text-sm font-semibold text-foreground">微信</h3>
              <p className="text-xs text-muted-foreground mt-0.5">通过微信 iLink Bot 接收和回复消息</p>
            </div>
          </div>
          <Switch checked={enabled} disabled={loading || toggling} onCheckedChange={handleToggle} />
        </div>

        <div className={`px-5 py-4 space-y-4 transition-opacity ${!enabled ? 'opacity-50 pointer-events-none' : ''}`}>
          {loading ? (
            <div className="text-sm text-muted-foreground">加载中...</div>
          ) : (
            <>
              {/* Connected state */}
              {config?.connected ? (
                <div className="space-y-3">
                  <div className="rounded-lg bg-emerald-50 dark:bg-emerald-950/30 px-4 py-3 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Smartphone className="size-4 text-emerald-600 dark:text-emerald-400" />
                        <span className="text-sm font-medium text-emerald-700 dark:text-emerald-300">已连接</span>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={handleDisconnect}
                        disabled={disconnecting}
                        className="text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-950/40 border-red-200 dark:border-red-800"
                      >
                        {disconnecting ? <Loader2 className="size-3.5 animate-spin" /> : <LogOut className="size-3.5" />}
                        退出登录
                      </Button>
                    </div>
                    {config.ilinkBotId && (
                      <div className="text-xs text-emerald-600 dark:text-emerald-400">
                        Bot ID: <span className="font-mono">{config.ilinkBotId}</span>
                      </div>
                    )}
                    {config.botTokenMasked && (
                      <div className="text-xs text-emerald-600 dark:text-emerald-400">
                        Token: <span className="font-mono">{config.botTokenMasked}</span>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="space-y-3">
                  {/* Expired session hint */}
                  {config?.hasBotToken && (
                    <div className="flex items-center justify-between rounded-lg bg-amber-50 dark:bg-amber-950/30 px-4 py-3">
                      <div className="text-sm text-amber-700 dark:text-amber-300">Session 已过期，请重新扫码登录</div>
                    </div>
                  )}

                  {/* QR login button */}
                  <div className="flex flex-col items-center gap-3 py-4 rounded-lg border border-dashed border-border bg-muted/50">
                    <QrCode className="size-10 text-muted-foreground" />
                    <div className="text-center">
                      <p className="text-sm text-foreground font-medium">扫码绑定微信</p>
                      <p className="text-xs text-muted-foreground mt-1">点击下方按钮获取二维码，使用微信扫码完成绑定</p>
                    </div>
                    <Button onClick={() => setQrDialogOpen(true)} className="mt-1">
                      <QrCode className="size-4" />
                      扫码登录
                    </Button>
                  </div>
                </div>
              )}

              {/* Direct connection toggle */}
              <div className="flex items-center justify-between rounded-lg bg-muted/50 px-4 py-3">
                <div className="flex items-start gap-2">
                  <Shield className="size-4 text-blue-500 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm text-foreground">直连模式</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {bypassProxy
                        ? '绕过 HTTP 代理直连微信服务，适合国内网络环境'
                        : '通过系统代理访问微信服务'}
                    </p>
                  </div>
                </div>
                <Switch
                  checked={bypassProxy}
                  disabled={togglingProxy}
                  onCheckedChange={handleBypassProxyToggle}
                />
              </div>
            </>
          )}
        </div>
      </div>

      <WeChatQRDialog
        isOpen={qrDialogOpen}
        onClose={() => setQrDialogOpen(false)}
        onSuccess={handleQRSuccess}
      />
    </>
  );
}
