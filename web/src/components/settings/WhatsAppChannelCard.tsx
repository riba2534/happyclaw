import { useCallback, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { api } from '../../api/client';
import { getErrorMessage } from './types';

interface UserWhatsAppConfig {
  accountId: string;
  phoneNumber: string;
  enabled: boolean;
  paired: boolean;
  connected: boolean;
  updatedAt: string | null;
  /** Server-side flag: backend is in skeleton phase, connect always fails */
  skeleton?: boolean;
}

export function WhatsAppChannelCard() {
  const [config, setConfig] = useState<UserWhatsAppConfig | null>(null);
  const [phoneNumber, setPhoneNumber] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toggling, setToggling] = useState(false);

  const enabled = config?.enabled ?? false;
  const isSkeleton = config?.skeleton ?? true;

  const loadConfig = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<UserWhatsAppConfig>(
        '/api/config/user-im/whatsapp',
      );
      setConfig(data);
      setPhoneNumber('');
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
      const data = await api.put<UserWhatsAppConfig>(
        '/api/config/user-im/whatsapp',
        { enabled: newEnabled },
      );
      setConfig(data);
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

  return (
    <div className="rounded-xl border border-border bg-card overflow-hidden">
      <div className="flex items-center justify-between px-5 py-4 border-b border-border bg-muted/50">
        <div className="flex items-center gap-2">
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              config?.connected
                ? 'bg-success'
                : 'bg-muted-foreground/40'
            }`}
          />
          <div>
            <h3 className="text-sm font-semibold text-foreground">
              WhatsApp
              <span className="ml-2 px-1.5 py-0.5 text-[10px] rounded bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20 align-middle">
                骨架开发中
              </span>
            </h3>
            <p className="text-xs text-muted-foreground mt-0.5">
              基于 Baileys 通过 WhatsApp Web 协议扫码登录（待接入）
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
              此渠道为多步骤 PR 的第 1 步——仅完成配置层和路由骨架。
              QR 码扫码登录、消息收发、媒体处理将在后续 PR 接入 Baileys
              （<code>@whiskeysockets/baileys</code>）后启用。
              当前启用状态下后端会保存配置但不会建立真正的连接。
            </div>

            {config?.phoneNumber && (
              <div className="text-xs text-muted-foreground">
                当前手机号: {config.phoneNumber}
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
                保存 WhatsApp 配置
              </Button>
              <Button variant="outline" disabled title="待接入 Baileys 后启用">
                扫码登录（敬请期待）
              </Button>
            </div>

            <div className="text-xs text-muted-foreground mt-2 space-y-1">
              <p>
                注意：WhatsApp Web 协议（Baileys）属于第三方逆向方案，
                Meta 在 2025-2026 收紧了对非官方客户端的封禁，
                同 OpenClaw 等其他基于 Baileys 的项目共享相同的封号风险。
                商用场景建议使用 Meta 官方 Cloud API。
              </p>
              {isSkeleton && (
                <p className="text-amber-600 dark:text-amber-400">
                  当前为骨架占位实现（PR 1/N），后续 PR 才会接入 Baileys。
                </p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
