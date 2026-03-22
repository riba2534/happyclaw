import { useCallback, useEffect, useState } from 'react';
import { Loader2, LogOut, QrCode } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { api } from '../../api/client';
import { getErrorMessage } from './types';
import { WeChatQRDialog } from './WeChatQRDialog';

interface UserWeChatConfig {
  ilinkBotId: string;
  hasBotToken: boolean;
  botTokenMasked: string | null;
  enabled: boolean;
  connected: boolean;
  updatedAt: string | null;
}

export function WeChatChannelCard() {
  const [config, setConfig] = useState<UserWeChatConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
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

  return (
    <>
      <div className="rounded-xl border border-border bg-card overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border bg-muted/50">
          <div className="flex items-center gap-2">
            <span className={`inline-block w-2 h-2 rounded-full ${config?.connected ? 'bg-emerald-500' : 'bg-muted-foreground/30'}`} />
            <div>
              <h3 className="text-sm font-semibold text-foreground">微信</h3>
              <p className="text-xs text-muted-foreground mt-0.5">通过微信接收和回复消息</p>
            </div>
          </div>
          <ToggleSwitch checked={enabled} disabled={loading || toggling} onChange={handleToggle} />
        </div>

        <div className={`px-5 py-4 space-y-4 transition-opacity ${!enabled ? 'opacity-50 pointer-events-none' : ''}`}>
          {loading ? (
            <div className="text-sm text-muted-foreground">加载中...</div>
          ) : (
            <>
              {/* Connection status */}
              {config?.connected ? (
                <div className="flex items-center justify-between rounded-lg bg-emerald-50 dark:bg-emerald-950/30 px-4 py-3">
                  <div>
                    <div className="text-sm font-medium text-emerald-700 dark:text-emerald-300">已连接</div>
                    {config.ilinkBotId && (
                      <div className="text-xs text-emerald-600 dark:text-emerald-400 mt-0.5">Bot ID: {config.ilinkBotId}</div>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleDisconnect}
                    disabled={disconnecting}
                    className="text-red-600 hover:text-red-700 hover:bg-red-50 border-red-200"
                  >
                    {disconnecting ? <Loader2 className="size-3.5 animate-spin" /> : <LogOut className="size-3.5" />}
                    退出登录
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  {config?.hasBotToken && (
                    <div className="flex items-center justify-between rounded-lg bg-amber-50 dark:bg-amber-950/30 px-4 py-3">
                      <div className="text-sm text-amber-700 dark:text-amber-300">Session 已过期，请重新扫码登录</div>
                    </div>
                  )}
                  <Button onClick={() => setQrDialogOpen(true)}>
                    <QrCode className="size-4" />
                    扫码登录
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    点击扫码登录，使用微信扫描二维码完成绑定
                  </p>
                </div>
              )}
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
